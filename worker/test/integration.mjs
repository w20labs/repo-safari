// Idea board integration tests against the real local runtime: `wrangler dev` (workerd) with a local D1 database,
// the stand-in GitHub/Anthropic services and the test clock. No network, no paid calls.
//
//   node worker/dev/fake-services.mjs 8790 &          (the preview script starts it too)
//   node worker/test/integration.mjs
//
// Starts its own Worker on :8789 with a fresh database (worker/dev/.state-it), and one with the board off on :8786.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';

const W = 'http://127.0.0.1:8789', OFF = 'http://127.0.0.1:8786', FAKE = 'http://127.0.0.1:8790', PAGE = 'http://127.0.0.1:8765';
const STATE = 'dev/.state-it';
const cwd = new URL('..', import.meta.url).pathname; // worker/
const T = (iso) => Date.parse(iso);
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`); };

// ---------- runtime ----------
for (const dir of [STATE, `${STATE}-off`]) rmSync(new URL(`../${dir}`, import.meta.url), { recursive: true, force: true }); // fresh databases and limiter counts each run
mkdirSync(new URL(`../${STATE}`, import.meta.url), { recursive: true });
const wr = (args) => execFileSync('npx', ['wrangler', ...args, '--config', 'dev/wrangler.preview.toml', '--persist-to', STATE], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
wr(['d1', 'migrations', 'apply', 'repo-safari-board-preview', '--local']);
const sql = (q) => JSON.parse(wr(['d1', 'execute', 'repo-safari-board-preview', '--local', '--json', '--command', q]))[0].results;
const procs = [];
const start = (port, persist, extra = []) => {
  const p = spawn('npx', ['wrangler', 'dev', '--config', 'dev/wrangler.preview.toml', '--persist-to', persist, '--port', String(port), '--inspector-port', String(port + 1000), '--ip', '127.0.0.1', ...extra], { cwd, stdio: 'ignore', detached: true });
  procs.push(p);
};
const up = async (url) => { for (let i = 0; i < 60; i++) { try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 1000)); } } throw new Error(`${url} did not start`); };
process.on('exit', () => procs.forEach((p) => { try { process.kill(-p.pid); } catch {} }));
start(8789, STATE);
await up(`${W}/ideas`); // not a board path: the launch is recorded later, under the test clock
start(8786, `${STATE}-off`, ['--var', 'BOARD_ENABLED:0']);
await up(`${OFF}/ideas`);

// ---------- helpers ----------
const api = async (path, { method = 'GET', body, token, origin = PAGE, base = W, ip } = {}) => {
  const headers = { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(ip ? { 'CF-Connecting-IP': ip } : {}) };
  const r = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const setClock = (at) => api('/dev/clock', { method: 'POST', body: { at }, origin: null });
const ADMIN = 'local-preview-admin-token-0123456789abcdef'; // the preview config's fake token
const admin = async (body) => { const r = await fetch(`${W}/board/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const close = () => api('/dev/close', { method: 'POST', origin: null });
let ipN = 0;
const generate = async (repos = ['n8n-io/n8n', 'axios/axios', 'logseq/logseq']) => (await api('/ideas', { method: 'POST', ip: `10.0.0.${++ipN}`, body: { repos } })).body;
/** The browser's sign-in, step by step: start -> fake GitHub -> callback -> page fragment -> exchange. */
async function signIn(login) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const s = await fetch(`${W}/auth/github/start?return=${encodeURIComponent(`${PAGE}/board/`)}&challenge=${challenge}`, { redirect: 'manual' });
  const gh = new URL(s.headers.get('location')); gh.searchParams.set('as', login);
  const a = await fetch(gh, { redirect: 'manual' });
  const cb = await fetch(a.headers.get('location'), { redirect: 'manual' });
  const landing = new URL(cb.headers.get('location'));
  const code = new URLSearchParams(landing.hash.slice(1)).get('login');
  const ex = await api('/auth/exchange', { method: 'POST', body: { code, verifier } });
  return ex.body.token;
}
const publish = async (token, gen, index) => api('/board/publish', { method: 'POST', token, body: { draftId: gen.draft.id, receipt: gen.draft.receipt, index } });
const idea = async (id) => (await api(`/board/ideas/${id}`)).body?.idea;

// ---------- 1. the whole journey ----------
await fetch(`${FAKE}/fake/rename`, { method: 'POST', body: JSON.stringify({ id: 1002, login: 'bob' }) }); // the stand-in keeps state between runs
const W1 = T('2026-11-04T10:00:00Z'); // a Wednesday: launch, so the first week is partial
await setClock(W1);
await api('/board/contest'); // the first enabled request records the launch
const gen = await generate();
check('generate anonymously: 3 ideas and a draft receipt', gen?.ideas?.length === 3 && /^[A-Za-z0-9_-]{43}$/.test(gen.draft?.receipt ?? ''));
const alice = await signIn('alice');
const pub = await publish(alice, gen, 2);
const id = pub.body?.id;
check('sign in with the stand-in GitHub and publish one idea', pub.status === 200 && pub.body.created === true && /^[a-z2-9]{10}$/.test(id ?? ''));
const bob = await signIn('bob');
const s1 = await api(`/board/ideas/${id}/star`, { method: 'PUT', token: bob });
const fromAlice = await idea(id), fromAnon = (await api(`/board/ideas/${id}`, { origin: null })).body.idea;
check('another account stars it; everyone sees the same count', s1.body?.total === 1 && fromAlice.totalStars === 1 && fromAnon.totalStars === 1 && fromAnon.weekStars === 1);
const carol = await signIn('carol');
check('a second account adds another star', (await api(`/board/ideas/${id}/star`, { method: 'PUT', token: carol })).body?.total === 2);
check('publishing again returns the same record', (await publish(alice, gen, 2)).body?.id === id && (await publish(bob, gen, 2)).body?.id === id);
check('a stolen draft id without its receipt can’t publish', (await api('/board/publish', { method: 'POST', token: bob, body: { draftId: gen.draft.id, receipt: randomBytes(32).toString('base64url'), index: 0 } })).status === 403);
check('public responses carry no secrets', !/receipt|draft|token|github_id|publisher_id|1001|1002/i.test(JSON.stringify(fromAnon)));

// ---------- 2. concurrency, retries, tabs ----------
const tabs = await Promise.all([signIn('dana'), signIn('dana'), signIn('dana')]);
const burst = await Promise.all(Array.from({ length: 24 }, (_, k) => api(`/board/ideas/${id}/star`, { method: 'PUT', token: tabs[k % 3] })));
check('24 simultaneous stars from one account in 3 tabs: one star', burst.every((r) => r.status === 200) && (await idea(id)).totalStars === 3);
const voters = await Promise.all(Array.from({ length: 12 }, (_, k) => signIn(`voter${k}`)));
await Promise.all(voters.flatMap((t) => [api(`/board/ideas/${id}/star`, { method: 'PUT', token: t }), api(`/board/ideas/${id}/star`, { method: 'DELETE', token: t }), api(`/board/ideas/${id}/star`, { method: 'PUT', token: t })]));
const mine = await Promise.all([alice, bob, carol, tabs[0], ...voters].map((t) => api(`/board/me?ids=${id}`, { token: t })));
const truth = sql(`SELECT stars_total AS total, (SELECT COUNT(*) FROM stars WHERE idea_id = '${id}' AND active = 1 AND invalidated_at IS NULL) AS active FROM ideas WHERE id = '${id}'`)[0];
check('star/unstar races: the count always equals the accounts whose star is on', truth.total === truth.active && truth.total === mine.filter((r) => r.body.starred.includes(id)).length && (await idea(id)).totalStars === truth.total, JSON.stringify(truth));
const firstBefore = sql(`SELECT first_starred_at AS f FROM stars WHERE idea_id = '${id}' AND github_id = 1002`)[0].f;
await setClock(W1 + 3600_000);
await api(`/board/ideas/${id}/star`, { method: 'DELETE', token: bob });
await api(`/board/ideas/${id}/star`, { method: 'PUT', token: bob });
await api(`/board/ideas/${id}/star`, { method: 'PUT', token: bob }); // the retry after a lost response
check('unstar, re-star and a retry keep the first star time', sql(`SELECT first_starred_at AS f FROM stars WHERE idea_id = '${id}' AND github_id = 1002`)[0].f === firstBefore);
await fetch(`${FAKE}/fake/rename`, { method: 'POST', body: JSON.stringify({ id: 1002, login: 'robert' }) });
const robert = await signIn('robert');
const me = await api(`/board/me?ids=${id}`, { token: robert });
check('a renamed GitHub account is the same voter', me.body.account.login === 'robert' && me.body.starred.includes(id) && sql('SELECT COUNT(*) AS n FROM accounts WHERE github_id = 1002')[0].n === 1);

// ---------- 3. weekly closing at the cutoff ----------
const MON9 = T('2026-11-09T00:00:00Z'), MON16 = T('2026-11-16T00:00:00Z');
const gen2 = await generate();
const [x, y] = [(await publish(alice, gen2, 0)).body.id, (await publish(alice, gen2, 1)).body.id];
const v = voters;
await setClock(MON9 - 1); // Sunday 23:59:59.999
await api(`/board/ideas/${x}/star`, { method: 'PUT', token: v[0] });
await setClock(MON9); // accepted at the stroke of midnight: next week
await Promise.all([api(`/board/ideas/${y}/star`, { method: 'PUT', token: v[1] }), api(`/board/ideas/${y}/star`, { method: 'PUT', token: v[2] })]);
const assigned = sql(`SELECT idea_id, first_starred_at AS f FROM stars WHERE idea_id IN ('${x}', '${y}') ORDER BY f`);
check('Sunday 23:59:59.999 counts for the old week; 00:00:00.000 for the new one', assigned[0].f === MON9 - 1 && assigned.slice(1).every((r) => r.f === MON9));
// the launch week closes late, five times at once
await setClock(MON9 + 6 * 3600_000);
const closers = await Promise.all([close(), close(), close(), close(), admin({ action: 'close' })]);
const weekRows = sql(`SELECT week_start, winner_id, partial FROM contests ORDER BY week_start`);
check('five simultaneous closes: one result, one queue entry', weekRows.length === 1 && sql('SELECT COUNT(*) AS n FROM build_queue')[0].n === 1 && closers.every((r) => r.status === 200));
check('the partial launch week went to the idea with the most new stars', weekRows[0].winner_id === id && weekRows[0].partial === 1, JSON.stringify(weekRows));
// after the cutoff: y collects; x loses a star; a delayed close of week 2 must use the state at its cutoff
const extra = await Promise.all([signIn('voter20'), signIn('voter21'), signIn('voter22')]);
await setClock(MON9 + 86_400_000);
await Promise.all(extra.map((t) => api(`/board/ideas/${x}/star`, { method: 'PUT', token: t }))); // x: 3 this week
await setClock(MON16 - 1000);
await api(`/board/ideas/${y}/star`, { method: 'DELETE', token: v[1] }); // y: 1 at the cutoff
await setClock(MON16 + 2 * 86_400_000); // the job is two days late; meanwhile:
await api(`/board/ideas/${x}/star`, { method: 'DELETE', token: extra[0] });
await api(`/board/ideas/${x}/star`, { method: 'DELETE', token: extra[1] });
for (const t of voters.slice(3, 8)) await api(`/board/ideas/${y}/star`, { method: 'PUT', token: t });
check('owner hide after the cutoff is accepted', (await admin({ action: 'hide', idea: x, reason: 'late report (test)' })).status === 200);
await close();
const w2 = sql(`SELECT winner_id, winner_score FROM contests WHERE week_start = ${MON9}`)[0];
check('a late close uses the cutoff, not later stars, unstars or moderation', w2.winner_id === x && w2.winner_score === 3, JSON.stringify(w2));
await api(`/board/ideas/${x}/star`, { method: 'DELETE', token: extra[2] });
check('removing a star after the close doesn’t rewrite the result', sql(`SELECT winner_score AS s FROM contests WHERE week_start = ${MON9}`)[0].s === 3);
// three missed weeks, closed in order, nobody selected twice
await setClock(MON16 + 3 * 7 * 86_400_000 + 1);
await close();
const all = sql('SELECT week_start, winner_id FROM contests ORDER BY week_start');
const winners = all.map((r) => r.winner_id).filter(Boolean);
check('catch-up closes the missed weeks oldest first, with no repeat winner', all.length === 5 && all.every((r, k) => k === 0 || r.week_start > all[k - 1].week_start) && new Set(winners).size === winners.length, JSON.stringify(all.map((r) => [new Date(r.week_start).toISOString().slice(0, 10), r.winner_id])));

// ---------- review fixes on the real runtime ----------
const sealed = Number(sql("SELECT value FROM board_settings WHERE key = 'sealed_through'")[0].value);
const resultsBefore = JSON.stringify(sql('SELECT * FROM contests ORDER BY week_start'));
await setClock(MON16 - 5000); // a request that read the clock on a Sunday long closed…
const gen3 = await generate(['rustls/rustls', 'excalidraw/excalidraw', 'n8n-io/n8n']); // new text: not a duplicate
const late = (await publish(alice, gen3, 0)).body.id;
await api(`/board/ideas/${late}/star`, { method: 'PUT', token: voters[9] });
const lateRow = sql(`SELECT first_starred_at AS f FROM stars WHERE idea_id = '${late}'`)[0];
const latePub = sql(`SELECT published_at AS p FROM ideas WHERE id = '${late}'`)[0];
check('a write that lands after its week was closed is dated after the seal; closed results don’t change', lateRow.f === sealed && latePub.p === sealed && JSON.stringify(sql('SELECT * FROM contests ORDER BY week_start')) === resultsBefore, JSON.stringify({ sealed, ...lateRow }));
// hold -> decline -> reinstate: it leads publicly, and it can win
await setClock(sealed + 3600_000);
const gen4 = await generate(['excalidraw/excalidraw', 'rustls/rustls', 'logseq/logseq']); // drafts last 24 hours on the (test) clock
const owner = await signIn('carol'); // sessions last 30 days; the test clock has moved on
const [duck, haiku] = [(await publish(owner, gen4, 1)).body.id, (await publish(owner, gen4, 2)).body.id];
const fresh = await Promise.all(Array.from({ length: 7 }, (_, k) => signIn(`voter${k}`)));
await Promise.all(fresh.map((t) => api(`/board/ideas/${duck}/star`, { method: 'PUT', token: t })));
await Promise.all(fresh.slice(0, 4).map((t) => api(`/board/ideas/${haiku}/star`, { method: 'PUT', token: t })));
const mods = [];
for (const action of ['hold', 'decline', 'reinstate']) mods.push((await admin({ action, idea: duck, reason: 'test' })).status);
const leader = (await api('/board/ideas?view=top')).body.items[0];
await setClock(sealed + 7 * 86_400_000 + 1000);
await close();
const won = sql(`SELECT winner_id, winner_score FROM contests WHERE week_start = ${sealed}`)[0];
check('hold, decline, reinstate: it leads with 7 and wins with 7', mods.every((x) => x === 200) && leader.id === duck && leader.weekStars === 7 && won.winner_id === duck && won.winner_score === 7, JSON.stringify(won));
// 12 publications at once from one account: 10 go through
const trio = ['logseq/logseq', 'axios/axios', 'rustls/rustls'];
const burstGen = await Promise.all([[0, 1, 2], [1, 2, 0], [2, 0, 1], [0, 2, 1]].map((o) => generate(o.map((k) => trio[k])))); // 12 different ideas
const frank = await signIn('voter39');
const pubs = await Promise.all(burstGen.flatMap((g) => [0, 1, 2].map((k) => publish(frank, g, k))));
check('12 simultaneous publications by one account: exactly 10 published', pubs.filter((r) => r.status === 200 && r.body.created).length === 10 && pubs.filter((r) => r.status === 429).length === 2, pubs.map((r) => r.status).join(','));

// ---------- 4. failures and the board switched off ----------
await fetch(`${FAKE}/fake/fail-model`, { method: 'POST', body: JSON.stringify({ n: 5 }) }); // more than the SDK's automatic retries
const failed = await api('/ideas', { method: 'POST', ip: '10.9.9.9', body: { repos: ['n8n-io/n8n', 'axios/axios', 'logseq/logseq'] } });
check('a failed generation saves no draft and says so', failed.status === 502 && !failed.body.draft);
const expired = await signIn('eve');
await setClock(MON16 + 60 * 86_400_000);
check('sessions expire', (await api('/board/me', { token: expired })).status === 401);
const off = await api('/ideas', { method: 'POST', base: OFF, ip: '10.8.8.8', body: { repos: ['n8n-io/n8n', 'axios/axios', 'logseq/logseq'] } });
const offPaths = await Promise.all(['/board/contest', '/board/ideas?view=top', '/auth/github/start', '/dev/clock'].map((p) => fetch(`${OFF}${p}`).then((r) => r.status)));
check('board off: generation works with no draft; board, sign-in and dev paths are 404', off.status === 200 && off.body.ideas.length === 3 && !('draft' in off.body) && offPaths.every((s) => s === 404), `${off.status} ${JSON.stringify(off.body).slice(0, 80)} ${offPaths.join(',')}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
