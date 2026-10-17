// Idea board browser checks (Chromium and mobile WebKit) against the real local Worker + D1, the stand-in GitHub and
// Anthropic, synthetic fixtures and a page built with the board on. No network, no paid calls.
//
//   node worker/test/board-browser.mjs [screenshot-dir]      (run from the repo root; serves pages from _site on :8765)
//
// It builds _site/board-e2e (board on) and _site/board-off (board off), starts a fresh Worker on :8789, and starts the
// stand-in services on :8790 and a static server on :8765 if they aren't running.
import { chromium, webkit, devices } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';

const SHOTS = process.argv[2] ?? null;
const ROOT = new URL('../..', import.meta.url).pathname, WORKER = `${ROOT}worker/`;
const W = 'http://127.0.0.1:8789', FAKE = 'http://127.0.0.1:8790', SITE = 'http://127.0.0.1:8765';
const PAGE = `${SITE}/board-e2e/index.html`, OFF = `${SITE}/board-off/index.html`;
const STATE = 'dev/.state-e2e';
const results = [], errors = [];
const check = (name, ok, extra = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { process.kill(-p.pid); } catch {} }));
const isUp = async (u) => { try { await fetch(u); return true; } catch { return false; } };
const waitUp = async (u) => { for (let i = 0; i < 90; i++) { if (await isUp(u)) return; await new Promise((r) => setTimeout(r, 1000)); } throw new Error(`${u} didn't start`); };
const bg = (cmd, args, cwd) => { const p = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true }); procs.push(p); return p; };

// ---------- setup: services, a fresh seeded Worker, two pages ----------
if (!(await isUp(`${FAKE}/fake/model-calls`))) { bg('node', ['worker/dev/fake-services.mjs', '8790'], ROOT); await waitUp(`${FAKE}/fake/model-calls`); }
await fetch(`${FAKE}/fake/rename`, { method: 'POST', body: JSON.stringify({ id: 1002, login: 'bob' }) }); // the stand-in keeps state between runs
if (!(await isUp(`${SITE}/`))) bg('python3', ['-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', '_site'], ROOT);
rmSync(`${WORKER}${STATE}`, { recursive: true, force: true }); mkdirSync(`${WORKER}${STATE}`, { recursive: true });
const wr = (args) => execFileSync('npx', ['wrangler', ...args, '--config', 'dev/wrangler.preview.toml', '--persist-to', STATE], { cwd: WORKER, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
wr(['d1', 'migrations', 'apply', 'repo-safari-board-preview', '--local']);
execFileSync('node', ['dev/seed.mjs', 'sql', `${STATE}/seed.sql`], { cwd: WORKER });
wr(['d1', 'execute', 'repo-safari-board-preview', '--local', '--file', `${STATE}/seed.sql`]);
// one idea whose text is HTML: it must show as text
wr(['d1', 'execute', 'repo-safari-board-preview', '--local', '--command', `INSERT INTO ideas (id, content_hash, kind, name, pitch, concept, inspiration, repos_json, publisher_id, publisher_login, model, published_at) VALUES ('markuptst2', 'seed-markup', 'useful', '<img src=x onerror="window.__xss=1">Markup', '<b>bold?</b> <script>window.__xss=2</script>', 'c', 'i', '[{"name":"axios/axios","url":"javascript:alert(1)","desc":"<i>x</i>"}]', 1005, 'eve', 'fixture', ${Date.parse('2026-10-21T14:00:00Z')})`]);
bg('npx', ['wrangler', 'dev', '--config', 'dev/wrangler.preview.toml', '--persist-to', STATE, '--port', '8789', '--inspector-port', '9789', '--ip', '127.0.0.1'], WORKER);
await waitUp(`${W}/ideas`);
execFileSync('node', ['dev/seed.mjs', 'finish', W], { cwd: WORKER });
const build = (dir, env) => execFileSync('npm', ['run', '-s', 'build-safari', '--', 'https://w20labs.github.io/repo-safari/', '--site', `_site/${dir}`], { cwd: ROOT, env: { ...process.env, DB_PATH: '/nonexistent', ...env }, stdio: 'ignore' });
build('board-e2e', { IDEAS_URL: W, BOARD_ENABLED: '1' });
build('board-off', { IDEAS_URL: W, BOARD_ENABLED: '0' });
const api = async (path, init = {}) => { const r = await fetch(`${W}${path}`, { ...init, headers: { Origin: SITE, 'Content-Type': 'application/json', ...(init.headers ?? {}) } }); return r.json(); };

// ---------- helpers ----------
const browsers = { chromium: await chromium.launch(), webkit: await webkit.launch() };
async function context(engine = 'chromium', { w = 1280, h = 800, reduced = false, phone = false } = {}) {
  const opts = phone && engine === 'webkit' ? { ...devices['iPhone 13'] } : { viewport: { width: w, height: h }, hasTouch: phone || w < 700, isMobile: (phone || w < 700) && engine === 'chromium' };
  const ctx = await browsers[engine].newContext({ ...opts, reducedMotion: reduced ? 'reduce' : 'no-preference', ...(engine === 'chromium' ? { permissions: ['clipboard-read', 'clipboard-write'] } : {}) });
  await ctx.route('**/gc.zgo.at/**', (r) => r.abort());
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(`${engine}: ${e.message}`)));
  return ctx;
}
const page = async (ctx, url = PAGE) => { const p = await ctx.newPage(); await p.goto(url); await p.evaluate(() => document.fonts.ready); return p; };
/** On the stand-in GitHub page: pick an account (or cancel), then wait to be back on the page. */
async function github(p, login) {
  await p.waitForURL(/127\.0\.0\.1:8790\/login\/oauth\/authorize/);
  if (login) await p.click(`a.as[data-login="${login}"]`); else await p.click('#deny');
  await p.waitForURL(/127\.0\.0\.1:8765/);
  await p.waitForLoadState('load');
}
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const signInApi = async (login) => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const s = await fetch(`${W}/auth/github/start?return=${encodeURIComponent(PAGE)}&challenge=${challenge}`, { redirect: 'manual' });
  const gh = new URL(s.headers.get('location')); gh.searchParams.set('as', login);
  const cb = await fetch((await fetch(gh, { redirect: 'manual' })).headers.get('location'), { redirect: 'manual' });
  const code = new URLSearchParams(new URL(cb.headers.get('location')).hash.slice(1)).get('login');
  return (await api('/auth/exchange', { method: 'POST', body: JSON.stringify({ code, verifier }) })).token;
};

// ---------- 1. board off: nothing of it on the page ----------
{ const ctx = await context(); const p = await page(ctx, OFF);
  const assets = [];
  p.on('request', (r) => { if (/board\.(js|css)/.test(r.url())) assets.push(r.url()); });
  await p.reload(); await p.waitForTimeout(400);
  check('board off: no Ideas entry, no board files, nothing published beside the page', await p.locator('#ideasBtn').isHidden() && assets.length === 0 && !existsSync(`${ROOT}_site/board-off/board.js`) && !(await p.evaluate(() => 'RepoSafari' in window)));
  await ctx.close(); }

// ---------- 1b. the landing-page section, below the game ----------
{ const ctx = await context(); const p = await page(ctx, OFF);
  check('board off: no board section on the landing page', (await p.locator('#ideaBoardSection').count()) === 0);
  await ctx.close(); }
for (const [w, h] of [[1280, 800], [390, 844], [320, 568]]) {
  const ctx = await context('chromium', { w, h }); const p = await page(ctx);
  await p.locator('.lb-row:not(.lb-skel)').first().waitFor();
  const m = await p.evaluate(() => {
    const sec = document.getElementById('ideaBoardSection'), stage = document.getElementById('stage').getBoundingClientRect();
    const rows = [...sec.querySelectorAll('.lb-row')];
    return {
      below: sec.getBoundingClientRect().top >= stage.bottom, after: sec.previousElementSibling?.className,
      over: document.documentElement.scrollWidth - innerWidth,
      names: rows.every((r) => { const n = r.querySelector('.lb-name'); return n.scrollWidth <= n.clientWidth + 1; }),
      pitches: rows.every((r) => { const t = r.querySelector('.lb-pitch'); return t.scrollHeight <= t.clientHeight + 1; }),
      stars: rows.every((r) => { const b = r.querySelector('.lb-star').getBoundingClientRect(); return b.height >= 44 && b.right <= r.getBoundingClientRect().right; }),
      pay: sec.querySelector('.lb-pay')?.textContent, acts: [...sec.querySelectorAll('.lb-acts .btn')].map((b) => b.textContent),
      card: sec.querySelector('.lb-pick')?.textContent, rows: rows.length,
    };
  });
  await shot(p, `home-${w}`); if (SHOTS) await p.locator('#ideaBoardSection').screenshot({ path: `${SHOTS}/home-section-${w}.png` });
  check(`landing ${w}px: the board section sits below the game; names and pitches are whole; stars ≥ 44px; payoff and actions`,
    m.below && m.over <= 0 && m.names && m.pitches && m.stars && m.rows === 4 && m.pay === 'Star the idea you want us to build next.'
    && JSON.stringify(m.acts) === JSON.stringify(['Browse and star ideas →', 'Create an idea ↑']), JSON.stringify({ ...m, card: undefined }));
  if (w === 1280) check('landing: the build card names last week’s pick with its real dates and status', /^Last week’s pick · 12 Oct – 19 Oct\s*Pancake Launcher\s*Queued/.test(m.card), m.card);
  await ctx.close();
}
{ const ctx = await context(); const p = await ctx.newPage();
  await p.route(`${W}/board/ideas?view=top*`, async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
  await p.goto(PAGE); await p.locator('#ideaBoardSection').waitFor();
  const loading = await p.evaluate(() => ({ skel: document.querySelectorAll('#ideaBoardSection .lb-skel').length, busy: document.querySelector('#ideaBoardSection .lb-list')?.getAttribute('aria-busy') }));
  await p.locator('.lb-row:not(.lb-skel)').first().waitFor();
  check('landing loading: three placeholder rows, then the ideas', loading.skel === 3 && loading.busy === 'true');
  await ctx.close(); }
{ const ctx = await context('chromium', { w: 390, h: 844 }); const p = await ctx.newPage();
  await p.route(`${W}/board/**`, (r) => r.abort());
  await p.goto(PAGE); await p.locator('#ideaBoardSection .lb-msg').waitFor();
  const hgt = await p.locator('#ideaBoardSection').evaluate((e) => e.getBoundingClientRect().height);
  check('landing error: one compact message with Try again, no empty block', (await p.locator('#ideaBoardSection .lb-msg').textContent()).includes('can’t load') && hgt < 320, `${Math.round(hgt)}px`);
  await p.unroute(`${W}/board/**`);
  await p.click('#ideaBoardSection .lb-msg button'); await p.locator('.lb-row:not(.lb-skel)').first().waitFor();
  check('…and Try again loads the ideas', (await p.locator('#ideaBoardSection .lb-row').count()) === 4);
  await ctx.close(); }
{ const ctx = await context(); const p = await page(ctx);
  await p.locator('.lb-row:not(.lb-skel)').first().waitFor();
  check('landing signed out: a note says how starring works', (await p.locator('#ideaBoardSection').textContent()).includes('Sign in with GitHub to star'));
  const bonsai = () => p.locator('#ideaBoardSection .lb-row', { hasText: 'Dependency Bonsai' });
  await bonsai().locator('.lb-star').click();
  await github(p, 'alice');
  await p.locator('.board-detail .board-star[aria-pressed="true"]').waitFor();
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await bonsai().locator('.lb-star[aria-pressed="true"]').waitFor();
  check('landing star while signed out: sign in, the star is applied, and the section shows it', (await bonsai().locator('.lb-week').textContent()).startsWith('⭐ 3'));
  await bonsai().locator('.lb-star').focus(); await p.keyboard.press('Enter');
  await bonsai().locator('.lb-star[aria-pressed="false"]').waitFor();
  check('landing vote while signed in: count updates in place, focus stays on the star', (await bonsai().locator('.lb-week').textContent()).startsWith('⭐ 2') && (await p.evaluate(() => document.activeElement.closest('.lb-row')?.textContent.includes('Dependency Bonsai'))));
  await p.click('#ideaBoardSection .lb-acts .btn:has-text("Create an idea")');
  await p.waitForTimeout(600);
  check('Create an idea ↑ takes you to the Idea Shower’s Mix button', (await p.evaluate(() => document.activeElement.id)) === 'mixGo' && (await p.evaluate(() => $('hero').getBoundingClientRect().top >= -1)));
  await p.click('#ideaBoardSection .lb-acts .btn:has-text("Browse and star ideas")');
  await p.locator('#tab-top[aria-selected="true"]').waitFor();
  check('Browse and star ideas → opens the board on Top this week', await p.locator('#board').isVisible());
  // a star in the full board that lifts an idea from outside the landing list to #1
  const helpers = await Promise.all(Array.from({ length: 5 }, (_, k) => signInApi(`voter${20 + k}`)));
  for (const t of helpers) await api('/board/ideas/changelogp/star', { method: 'PUT', headers: { Authorization: `Bearer ${t}` } });
  await p.click('#tab-new'); await p.locator('.board-card[data-id="changelogp"]').waitFor();
  await p.click('.board-card[data-id="changelogp"] .board-star');
  await p.locator('.board-card[data-id="changelogp"] .board-star[aria-pressed="true"]').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('#ideaBoardSection .lb-resort button').waitFor({ timeout: 5000 }).catch(() => {});
  check('landing: a new #1 from outside the list offers “Show the new order”', (await p.locator('#ideaBoardSection .lb-resort button').count()) === 1);
  await p.click('#ideaBoardSection .lb-resort button');
  await p.locator('#ideaBoardSection .lb-row[data-id="changelogp"]').waitFor();
  check('…and the new order starts with it, starred', (await p.locator('#ideaBoardSection .lb-row').first().getAttribute('data-id')) === 'changelogp'
    && (await p.locator('#ideaBoardSection .lb-row[data-id="changelogp"] .lb-star').getAttribute('aria-pressed')) === 'true');
  // signing out from the board clears every personal star state, in both views; the counts stay
  const kiteWeek = await p.locator('#ideaBoardSection .lb-row[data-id="kitephysic"] .lb-week').textContent();
  const starredBefore = await p.locator('#ideaBoardSection .lb-star[aria-pressed="true"]').count();
  await p.click('#ideaBoardSection .lb-acts .btn:has-text("Browse and star ideas")');
  await p.locator('#boardPanel .board-card').first().waitFor();
  await p.click('#boardAccount button:has-text("Sign out")');
  await p.locator('#boardAccount button:has-text("Sign in with GitHub")').waitFor();
  const boardStarred = await p.locator('#boardPanel .board-star[aria-pressed="true"]').count();
  await p.keyboard.press('Escape');
  check('signing out clears starred states on the board and the landing section, keeps counts, and shows the sign-in note',
    starredBefore >= 2 && boardStarred === 0 && (await p.locator('#ideaBoardSection .lb-star[aria-pressed="true"]').count()) === 0
    && (await p.locator('#ideaBoardSection .lb-row[data-id="kitephysic"] .lb-week').textContent()) === kiteWeek
    && (await p.locator('#ideaBoardSection').textContent()).includes('Sign in with GitHub to star'), `${starredBefore} ${boardStarred}`);
  // put the fixtures back for the later checks
  for (const t of [...helpers, await signInApi('alice')]) await api('/board/ideas/changelogp/star', { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } });
  await ctx.close(); }

// ---------- 2. generate, sign in, confirm, publish, share ----------
let ideaId = null;
{ const ctx = await context(); const p = await page(ctx);
  check('board on: the Ideas entry sits in the card’s title row', await p.locator('#ideasBtn').isVisible() && (await p.locator('#ideasBtn').evaluate((b) => b.closest('.hero-k') !== null)));
  await p.click('#mixGo'); await p.locator('.idea').first().waitFor();
  check('generated ideas each offer Publish to idea board; the privacy note covers 24-hour storage and publication', (await p.locator('.idea .btn.publish').count()) === 3 && /24 hours[\s\S]*GitHub handle public/.test(await p.locator('#mixPrivacy').textContent()));
  const chosen = await p.locator('.idea h3').nth(1).textContent();
  await p.locator('.idea .btn.publish').nth(1).click();
  await github(p, 'alice');
  await p.locator('.board-confirm').waitFor();
  const confirmText = await p.locator('.board-confirm').textContent();
  check('back from sign-in: the chosen idea waits for confirmation, explaining what becomes public', confirmText.includes(chosen) && confirmText.includes('@alice') && /idea, its 3 source repos and your GitHub handle/.test(confirmText) && !/login=|receipt/.test(p.url()));
  check('the generated ideas are still there behind it', (await p.locator('#mixGo').textContent()) === 'See the ideas →');
  await shot(p, 'b-publish-confirm-1280');
  await p.click('.board-confirm .btn.go');
  await p.locator('.board-confirm h2', { hasText: 'Published!' }).waitFor();
  await p.click('.board-confirm button:has-text("Copy share link")');
  const link = await p.evaluate(() => navigator.clipboard.readText());
  ideaId = /#idea=([a-z2-9]{10})$/.exec(link)?.[1] ?? null;
  check('published: a permanent link to copy', !!ideaId, link);
  await p.click('.board-confirm button:has-text("View idea")');
  await p.locator('#boardDetailTitle').waitFor();
  const detail = await p.locator('.board-detail').textContent();
  check('View idea: its page, with the full concept, 0 stars to start, and #idea= in the address', detail.includes(chosen) && detail.includes('0 total') && p.url().endsWith(`#idea=${ideaId}`));
  check('the session is in this site’s storage, never in the address or a cookie', (await p.evaluate(() => !!localStorage.getItem('repo-safari-board-session-v1') && document.cookie === '')) && (await ctx.cookies()).length === 0);
  await shot(p, 'b-detail-new-1280');
  // a retry of the same publication: same record
  const again = await p.evaluate(async () => { const r = JSON.parse(localStorage.getItem('repo-safari-board-session-v1')); return r.token; });
  const draft = await p.evaluate(() => result.draft);
  const retry = await api('/board/publish', { method: 'POST', headers: { Authorization: `Bearer ${again}` }, body: JSON.stringify({ draftId: draft.id, receipt: draft.receipt, index: 1 }) });
  check('publishing the same idea again returns the same record', retry.id === ideaId && retry.created === false);
  await ctx.close(); }

// ---------- 3. someone else opens the link on a phone, signs in, stars ----------
{ const calls = async () => (await (await fetch(`${FAKE}/fake/model-calls`)).json()).calls;
  const before = await calls();
  const ctx = await context('chromium', { w: 390, h: 844 }); const p = await page(ctx, `${PAGE}#idea=${ideaId}`);
  await p.locator('#boardDetailTitle').waitFor();
  check('a shared idea link opens its page with no model call', (await p.locator('.board-detail').isVisible()) && (await calls()) === before);
  await p.click('.board-detail .board-star');
  await github(p, 'bob');
  await p.locator('.board-detail .board-star[aria-pressed="true"]').waitFor();
  check('star while signed out: sign in, come back, and the star is applied once', (await p.locator('.board-detail .board-stats').textContent()).includes('1 total'));
  await p.reload(); await p.locator('.board-detail .board-star').waitFor();
  check('after a reload: still starred, still 1', (await p.locator('.board-detail .board-star').getAttribute('aria-pressed')) === 'true' && (await p.locator('.board-detail .board-stats').textContent()).includes('1 total'));
  const other = await (await context()).newPage();
  await other.goto(`${PAGE}#idea=${ideaId}`); await other.locator('.board-detail .board-stats').waitFor();
  check('another visitor sees the same count', (await other.locator('.board-detail .board-stats').textContent()).includes('1 total'));
  await p.click('.board-detail .board-star');
  await p.locator('.board-detail .board-star[aria-pressed="false"]').waitFor();
  check('clicking an active star removes it', (await p.locator('.board-detail .board-stats').textContent()).includes('0 total') && (await p.locator('#boardLive').textContent()).startsWith('Removed your star'));
  await ctx.close(); }

// ---------- 4. views, ties, states, safe text ----------
{ const ctx = await context(); const p = await page(ctx);
  await p.click('#ideasBtn'); await p.locator('.board-card').first().waitFor();
  await p.locator('#boardContest', { hasText: 'Voting closes' }).waitFor(); // it loads separately from the cards
  const contest = await p.locator('#boardContest').textContent();
  check('contest: exact dates, closing time, provisional leader, last pick', /This week: Mon 19 Oct, 00:00 UTC → Mon 26 Oct, 00:00 UTC/.test(contest) && /Voting closes Mon 26 Oct, 00:00 UTC · in 4d \d+h/.test(contest) && /Leading for now: Standup Haiku[\s\S]*Provisional/.test(contest) && /Last week’s pick[\s\S]*Pancake Launcher/.test(contest));
  const top = await p.locator('.board-card').evaluateAll((cs) => cs.map((c) => [c.querySelector('h3').textContent, c.querySelector('.board-stats').textContent]));
  check('Top this week: weekly stars decide, lifetime shown apart, and the tie is explained', top[0][0] === 'Standup Haiku' && top[1][1].includes('Tied with Standup Haiku, which reached 4 first') && top.some(([n, s]) => n === 'Dependency Bonsai' && s.startsWith('⭐ 2 this week · 14 total')), JSON.stringify(top.slice(0, 3)));
  await shot(p, 'b-top-1280');
  await p.click('#tab-new'); await p.locator('.board-card').first().waitFor();
  const markup = p.locator('.board-card', { hasText: 'Markup' });
  check('New: newest first; HTML in an idea shows as text and a bad link isn’t a link', (await markup.locator('img, b, script').count()) === 0 && (await markup.locator('h3').textContent()).startsWith('<img') && (await markup.locator('.board-repos a').count()) === 0 && !(await p.evaluate(() => window.__xss)));
  check('New: hidden ideas are left out', !(await p.locator('#boardPanel').textContent()).includes('Buy Followers'));
  await p.click('#tab-building'); await p.locator('.board-card').first().waitFor();
  const building = await p.locator('.board-card').evaluateAll((cs) => cs.map((c) => c.querySelector('.board-status')?.textContent));
  check('Building: queue order, real statuses and positions', /^Building now · #1 in the build queue/.test(building[0]) && /^Picked for the week of 12 Oct – 19 Oct with ⭐ 5 new stars · waiting to be built · #2/.test(building[1]), JSON.stringify(building));
  await shot(p, 'b-building-1280');
  await p.click('#tab-built'); await p.locator('.board-card').first().waitFor();
  const built = p.locator('.board-card').first();
  check('Built: demo and source links (https, opening safely)', (await built.locator('a:has-text("Try the demo")').getAttribute('href')) === 'https://w20labs.github.io/commit-weather/' && (await built.locator('a:has-text("Source code")').getAttribute('rel')) === 'noopener noreferrer');
  await shot(p, 'b-built-1280');
  await p.goto('about:blank'); await p.goto(`${PAGE}#idea=hiddenspam`); await p.locator('#boardDetailTitle').waitFor();
  const gone = await p.locator('#boardDetailTitle').textContent();
  await p.goto('about:blank'); await p.goto(`${PAGE}#idea=NOT-AN-ID`); await p.locator('#boardDetailTitle').waitFor();
  check('hidden or malformed idea links: a clear “not on the board”, nothing leaked', gone.includes('isn’t on the board') && (await p.locator('#boardDetailTitle').textContent()).includes('isn’t on the board') && !(await p.content()).includes('Buy Followers'));
  await ctx.close(); }

// ---------- 5. keyboard, focus, Escape ----------
{ const ctx = await context(); const p = await page(ctx);
  await p.focus('#ideasBtn'); await p.keyboard.press('Enter'); await p.locator('.board-card').first().waitFor();
  const t0 = await p.evaluate(() => document.activeElement.id);
  await p.keyboard.press('ArrowRight'); await p.locator('#tab-new[aria-selected="true"]').waitFor();
  await p.keyboard.press('End'); await p.locator('#tab-built[aria-selected="true"]').waitFor();
  check('tabs: arrow keys, Home/End move and select, with roving focus', t0 === 'tab-top' && (await p.evaluate(() => document.activeElement.id)) === 'tab-built');
  let inside = true;
  for (let k = 0; k < 40; k++) { await p.keyboard.press('Tab'); inside &&= await p.evaluate(() => document.getElementById('board').contains(document.activeElement)); }
  check('Tab stays inside the board', inside);
  await p.locator('.board-card .board-name-link').first().click(); await p.locator('#boardDetailTitle').waitFor();
  await p.keyboard.press('Escape');
  await p.locator('.board-card').first().waitFor();
  const backToList = !(await p.locator('#boardDetailTitle').count());
  await p.keyboard.press('Escape');
  check('Escape: idea page -> list -> closed, focus back on Ideas, the game untouched', backToList && (await p.locator('#board').isHidden()) && (await p.evaluate(() => document.activeElement.id)) === 'ideasBtn' && (await p.evaluate(() => state)) === 'walk');
  // stars announce their state to screen readers
  await p.click('#ideasBtn'); await p.locator('.board-card').first().waitFor();
  const star = p.locator('.board-card .board-star').first();
  check('star buttons: a name and aria-pressed', (await star.getAttribute('aria-label')).startsWith('Star ') && (await star.getAttribute('aria-pressed')) === 'false');
  // the game ignores keys while the board is open
  const x0 = await p.evaluate(() => body.x);
  await p.keyboard.down('ArrowRight'); await p.waitForTimeout(300); await p.keyboard.up('ArrowRight');
  check('the game pauses while the board is open', (await p.evaluate(() => body.x)) === x0);
  await ctx.close(); }

// ---------- 6. failures never break the game or fake a count ----------
{ const ctx = await context(); const p = await page(ctx);
  await p.route(`${W}/ideas`, async (r) => { const res = await r.fetch(); const j = await res.json(); j.draft = null; r.fulfill({ response: res, json: j }); });
  await p.click('#mixGo'); await p.locator('.idea').first().waitFor();
  check('draft not saved: the ideas still show, no Publish buttons, and it says publishing is unavailable', (await p.locator('.idea').count()) === 3 && (await p.locator('.btn.publish').count()) === 0 && (await p.locator('#mixAfter').textContent()).includes('isn’t available'));
  await p.keyboard.press('Escape');
  await p.route(`${W}/board/**`, (r) => r.abort());
  await p.click('#ideasBtn'); await p.locator('.board-error').waitFor();
  check('board unreachable: “couldn’t load” with Try again, and no counts at all', (await p.locator('.board-error button', { hasText: 'Try again' }).count()) === 1 && !(await p.locator('#boardPanel').textContent()).includes('0 total') && (await p.locator('#boardContest').textContent()).includes('couldn’t load'));
  await p.keyboard.press('Escape');
  const x0 = await p.evaluate(() => body.x);
  await p.keyboard.down('ArrowRight'); await p.waitForTimeout(400); await p.keyboard.up('ArrowRight');
  check('…and the game still plays', (await p.evaluate(() => body.x)) > x0);
  // an expired session: the star isn't faked, sign-in is offered again
  await p.unroute(`${W}/board/**`);
  await p.evaluate(() => localStorage.setItem('repo-safari-board-session-v1', JSON.stringify({ token: 'x'.repeat(43), login: 'ghost', expiresAt: Date.now() + 1e9 })));
  await p.goto('about:blank'); await p.goto(`${PAGE}#idea=kitephysic`); // a full load, not a same-page hash change racing a reload
  await p.locator('.board-detail .board-star').waitFor();
  await p.click('.board-detail .board-star');
  await p.waitForURL(/127\.0\.0\.1:8790/);
  check('expired session: no fake star; it asks to sign in again', true);
  await ctx.close(); }
// sign-in cancelled: nothing published, the ideas come back
{ const ctx = await context(); const p = await page(ctx);
  await p.click('#mixGo'); await p.locator('.idea').first().waitFor();
  await p.locator('.idea .btn.publish').first().click();
  await github(p, null);
  await p.locator('#toast', { hasText: 'Sign-in cancelled.' }).waitFor();
  check('sign-in cancelled: a message, nothing published, the generated ideas still there', (await p.locator('#mixGo').textContent()) === 'See the ideas →' && (await p.locator('.board-confirm').count()) === 0);
  await ctx.close(); }
// old mix links still work, and can't be published
{ const ctx = await context(); const p = await page(ctx);
  const link = await p.evaluate(() => { const repos = [...REPOS.keys()].slice(0, 3); return shareLink(repos, KINDS.map((kind) => ({ kind, name: `${kind} x`, pitch: 'p', concept: 'c', inspiration: 'i' }))); });
  await p.goto(link.replace('https://w20labs.github.io/repo-safari/', PAGE)); await p.reload(); await p.locator('#mixNote').waitFor({ state: 'visible' });
  check('legacy #mix= links: the shared view still opens, with nothing to publish', (await p.locator('.idea').count()) === 3 && (await p.locator('.btn.publish').count()) === 0);
  await ctx.close(); }

// ---------- review fixes: fresh ranks after a vote, held keys, the Monday rollover ----------
{ const ctx = await context(); const p = await page(ctx);
  await p.click('#ideasBtn'); await p.locator('.board-card').first().waitFor();
  await p.click('#boardAccount button'); await github(p, 'dana');
  await p.locator('.board-card').first().waitFor();
  const duck = p.locator('.board-card', { hasText: 'Rubber Duck Radio' });
  await duck.locator('.board-star').focus(); await p.keyboard.press('Enter');
  await duck.locator('.board-stats', { hasText: '#1 this week' }).waitFor();
  await p.locator('#boardContest', { hasText: 'Leading for now: Rubber Duck Radio' }).waitFor();
  const duckStats = await duck.locator('.board-stats').textContent(), haikuStats = await p.locator('.board-card', { hasText: 'Standup Haiku' }).locator('.board-stats').textContent();
  check('after a vote: rank, tie note and leader come fresh from the server; cards stay put and focus stays on the star',
    duckStats.startsWith('⭐ 5 this week') && !duckStats.includes('Tied') && haikuStats.includes('#2 this week') && !haikuStats.includes('Tied')
    && (await p.evaluate(() => document.activeElement.closest('.board-card')?.textContent.includes('Rubber Duck'))) && (await p.locator('.board-resort').isVisible()), `${duckStats} | ${haikuStats}`);
  await p.click('.board-resort button'); await p.locator('.board-card').first().waitFor();
  check('…and “Show the new order” re-sorts', (await p.locator('.board-card h3').first().textContent()) === 'Rubber Duck Radio');
  await ctx.close(); }
{ const ctx = await context(); const p = await page(ctx);
  await p.keyboard.down('ArrowRight'); await p.waitForTimeout(250);
  await p.click('#ideasBtn');
  const x0 = await p.evaluate(() => body.x); await p.waitForTimeout(600);
  const x1 = await p.evaluate(() => body.x);
  await p.keyboard.up('ArrowRight');
  check('a key held while opening the board doesn’t keep the walker going', x1 === x0, `${x0} -> ${x1}`);
  await ctx.close(); }

// ---------- 7. milestones, with and without motion ----------
{ const voters = await Promise.all(Array.from({ length: 8 }, (_, k) => signInApi(`voter${30 + k}`)));
  for (const t of voters) await api('/board/ideas/kitephysic/star', { method: 'PUT', headers: { Authorization: `Bearer ${t}` } }); // 1 + 8 = 9
  const calm = await context('chromium', { reduced: true }); const p = await page(calm, `${PAGE}#idea=kitephysic`);
  await p.locator('.board-detail .board-star').waitFor();
  await p.click('.board-detail .board-star'); await github(p, 'dana');
  await p.locator('.board-party').waitFor();
  check('10 stars: a celebration that says it doesn’t trigger a build; no animation with reduced motion', (await p.locator('.board-party').textContent()).includes('doesn’t') === false && (await p.locator('.board-party').textContent()).includes('weekly pick still goes to new stars') && !(await p.locator('.board-party').getAttribute('class')).includes('pop'));
  await p.click('.board-detail .board-star'); await p.locator('.board-detail .board-star[aria-pressed="false"]').waitFor(); // back to 9
  const lively = await context(); const q = await page(lively, `${PAGE}#idea=kitephysic`);
  await q.locator('.board-detail .board-star').waitFor();
  await q.click('.board-detail .board-star'); await github(q, 'carol');
  await q.locator('.board-party').waitFor();
  check('…and it pops when motion is welcome', (await q.locator('.board-party').getAttribute('class')).includes('pop'));
  await calm.close(); await lively.close(); }

// ---------- 8. layout at four sizes ----------
for (const [w, h] of [[1280, 800], [390, 844], [375, 667], [320, 568]]) {
  const ctx = await context('chromium', { w, h }); const p = await page(ctx);
  const landing = await p.evaluate(() => ({ stage: Math.round($('stage').getBoundingClientRect().top), over: document.documentElement.scrollWidth - innerWidth }));
  await shot(p, `b-landing-${w}`);
  await p.click('#ideasBtn'); await p.locator('.board-card').first().waitFor(); await p.waitForTimeout(200);
  const m = await p.evaluate(() => {
    const tabs = [...document.querySelectorAll('#boardTabs [role="tab"]')].map((t) => t.getBoundingClientRect());
    const small = [...document.querySelectorAll('#board button, #board a')].filter((b) => b.offsetParent && !b.classList.contains('board-name-link') && !b.closest('.board-repos, .board-links')).filter((b) => b.getBoundingClientRect().height < 40).length;
    return { over: document.documentElement.scrollWidth - innerWidth, boxOver: document.querySelector('.board-box').scrollWidth - document.querySelector('.board-box').clientWidth, tabRows: new Set(tabs.map((r) => Math.round(r.top))).size, small };
  });
  await shot(p, `b-board-${w}`);
  await p.locator('.board-card .board-name-link').first().click(); await p.locator('#boardDetailTitle').waitFor();
  await shot(p, `b-detail-${w}`);
  check(`layout ${w}x${h}: no sideways scroll on the page or the board; tabs on one row; buttons at least 40px tall; the game still starts on the first screen`, landing.over <= 0 && m.over <= 0 && m.boxOver <= 0 && m.tabRows === 1 && m.small === 0 && landing.stage < h - 60, JSON.stringify({ ...m, stage: landing.stage }));
  await ctx.close();
}

// ---------- 9. mobile WebKit: link, sign-in, star, no cookies ----------
{ const ctx = await context('webkit', { phone: true }); const p = await page(ctx, `${PAGE}#idea=${ideaId}`);
  await p.locator('.board-detail .board-star').waitFor();
  const before = await p.locator('.board-detail .board-stats').textContent();
  await p.locator('.board-detail .board-star').tap();
  await github(p, 'eve');
  await p.locator('.board-detail .board-star[aria-pressed="true"]').waitFor();
  const after = await p.locator('.board-detail .board-stats').textContent();
  await p.reload(); await p.locator('.board-detail .board-star[aria-pressed="true"]').waitFor();
  check('WebKit (iPhone): sign-in round trip and a star that survives a reload, with no cookies at all', before.includes('0 total') && after.includes('1 total') && (await ctx.cookies()).length === 0);
  await shot(p, 'b-webkit-detail');
  await p.click('.board-back'); await p.locator('.board-card').first().waitFor();
  check('WebKit: the board lists ideas with no sideways scroll', (await p.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
  await ctx.close(); }

// ---------- Monday 00:00 UTC while the board is open ----------
{ const MON26 = Date.parse('2026-10-26T00:00:00Z');
  const setClock = (at) => fetch(`${W}/dev/clock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at }) });
  await setClock(MON26 - 3000);
  const ctx = await context(); const p = await page(ctx);
  await p.click('#ideasBtn'); await p.locator('#boardContest', { hasText: 'Voting closes Mon 26 Oct' }).waitFor();
  await setClock(MON26 + 2000); // the server's clock passes the cutoff too
  await p.locator('#boardContest', { hasText: 'Mon 26 Oct, 00:00 UTC → Mon 2 Nov' }).waitFor({ timeout: 10_000 });
  check('an open board moves to the new week at the cutoff, not “in 0m”', !(await p.locator('#boardContest').textContent()).includes('in 0m'));
  await ctx.close();
  // two weeks on: 19–26 Oct is picked, 26 Oct–2 Nov has no stars, so the section features the build queue instead
  const NOV2 = Date.parse('2026-11-02T00:00:00Z');
  await setClock(NOV2 + 3600_000);
  await fetch(`${W}/dev/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const ctx2 = await context(); const q = await page(ctx2);
  await q.locator('#ideaBoardSection .lb-pick .lb-name').waitFor();
  const card = await q.locator('#ideaBoardSection .lb-pick').textContent();
  check('no pick last week: the card says so and features a project “From the build queue”', /Last week \(26 Oct – 2 Nov\): no pick\.\s*From the build queue\s*Error Karaoke\s*Building/.test(card) && !card.includes('Last week’s pick'), card);
  await ctx2.close(); }

for (const b of Object.values(browsers)) await b.close();
console.log(`\npage errors: ${JSON.stringify(errors)}`);
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) && !errors.length ? 0 : 1);
