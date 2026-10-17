// Repo Safari idea board: browse published ideas, star them, publish a generated idea, follow the weekly build.
// Loaded by the page only when the board is on (BOARD_ENABLED=1 at build time); everything it needs from the page comes
// through window.RepoSafari. Counts and statuses always come from the Worker: on failure it says so, never shows 0.
(() => {
  'use strict';
  const S = window.RepoSafari;
  if (!S) return;
  const { h, toast, track, trackOnce, tagline } = S;
  const API = S.IDEAS_URL;
  const SESSION_KEY = 'repo-safari-board-session-v1', LOGIN_KEY = 'repo-safari-board-login-v1';
  const ID = /^[a-z2-9]{10}$/;
  const VIEWS = [['top', 'Top this week'], ['new', 'New'], ['building', 'Building'], ['built', 'Built']];
  const KIND = { useful: 'Useful', unexpected: 'Unexpected', ridiculous: 'Ridiculous' };
  const POLICY = 'Every week, we build and share an open-source prototype of the idea that earns the most new stars that week.';

  // ---------- small helpers ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: sign-in lasts this page only */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* fine */ } },
  };
  const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const utc = (t, withTime = true) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}), timeZone: 'UTC' }) + (withTime ? ' UTC' : '');
  const day = (t) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const span = (a, b) => `${new Date(a).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} – ${new Date(b).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
  function until(t, now) {
    const ms = Math.max(0, t - now), d = Math.floor(ms / 86_400_000), hr = Math.floor((ms % 86_400_000) / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000);
    return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`;
  }
  const ghUrl = (u) => (typeof u === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(u) ? u : null);
  const httpsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
  const ideaLink = (id) => `${S.SITE}#idea=${id}`;

  // ---------- the Worker ----------
  let session = store.get(SESSION_KEY);
  if (session && !(session.token && session.expiresAt > Date.now())) { session = null; store.del(SESSION_KEY); }
  async function api(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth && session) headers.Authorization = `Bearer ${session.token}`;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const r = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, cache: 'no-store' }); // counts change: never a stale copy after a star
      let data = null;
      try { data = await r.json(); } catch { /* not JSON */ }
      if (r.status === 401 && auth) signedOut();
      return { ok: r.ok, status: r.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally { clearTimeout(timer); }
  }
  function signedOut() { session = null; store.del(SESSION_KEY); state.starred.clear(); renderAccount(); }

  // ---------- sign-in: verifier kept here, one-time code back in the fragment, swapped for a session ----------
  async function signIn(intent) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    store.set(LOGIN_KEY, { verifier, intent, at: Date.now() });
    trackOnce('board/signin-start', 'Idea board: sign-in started');
    const back = location.href.split('#')[0];
    location.assign(`${API}/auth/github/start?return=${encodeURIComponent(back)}&challenge=${challenge}`);
  }
  async function finishSignIn() {
    const m = /^#(login|login-error)=([\w-]+)$/.exec(location.hash);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search); // the code never stays in the address bar
    const pending = store.get(LOGIN_KEY);
    store.del(LOGIN_KEY);
    if (m[1] === 'login-error' || !pending || Date.now() - pending.at > 15 * 60_000) {
      toast(m[2] === 'denied' ? 'Sign-in cancelled.' : 'Sign-in didn’t complete. Try again.');
      if (pending?.intent?.kind === 'publish') S.restoreResult(pending.intent.result);
      return true;
    }
    const r = await api('/auth/exchange', { method: 'POST', body: { code: m[2], verifier: pending.verifier } });
    if (!r.ok || !r.data?.token) { toast('Sign-in didn’t complete. Try again.'); return true; }
    session = { token: r.data.token, login: r.data.account.login, expiresAt: r.data.expiresAt };
    store.set(SESSION_KEY, session);
    trackOnce('board/signin-done', 'Idea board: signed in');
    toast(`Signed in as @${session.login}`);
    // carry on with what they were doing, once
    const intent = pending.intent;
    if (intent?.kind === 'publish') { S.restoreResult(intent.result); confirmPublish(intent.result, intent.index, null); }
    else if (intent?.kind === 'star' && ID.test(intent.id)) { await openIdea(intent.id); setStar(intent.id, true); }
    else if (intent?.kind === 'board') open(intent.view ?? 'top');
    return true;
  }
  async function signOut() {
    await api('/auth/logout', { method: 'POST', auth: true });
    signedOut();
    toast('Signed out.');
  }

  // ---------- state and the dialog ----------
  const state = { view: 'top', items: [], next: null, loading: false, error: false, contest: null, contestError: false, detail: null, starred: new Set(), pending: new Set(), opener: null };
  let root = null, countdown = 0;

  function build() {
    root = h('div', { class: 'board', id: 'board', hidden: true },
      h('div', { class: 'board-box', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'boardTitle' },
        h('div', { class: 'board-head' },
          h('h2', { id: 'boardTitle' }, '💡 Idea board'),
          h('div', { class: 'board-account', id: 'boardAccount' }),
          h('button', { type: 'button', class: 'btn board-close', 'aria-label': 'Close the idea board', onclick: close }, '×')),
        h('p', { class: 'board-policy' }, POLICY),
        h('section', { class: 'board-contest', id: 'boardContest', 'aria-label': 'This week’s contest' }),
        rules(),
        h('div', { class: 'board-tabs', role: 'tablist', 'aria-label': 'Board views', id: 'boardTabs' },
          ...VIEWS.map(([v, label]) => h('button', { type: 'button', role: 'tab', id: `tab-${v}`, 'aria-controls': 'boardPanel', 'aria-selected': 'false', tabindex: '-1', onclick: () => show(v) }, label))),
        h('div', { class: 'board-panel', id: 'boardPanel', role: 'tabpanel', 'aria-labelledby': 'tab-top' }),
        h('p', { class: 'board-live', id: 'boardLive', role: 'status' })));
    document.body.append(root);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.querySelector('#boardTabs').addEventListener('keydown', (e) => {
      const i = VIEWS.findIndex(([v]) => v === state.view);
      const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : null;
      if (next === null) return;
      e.preventDefault();
      const v = VIEWS[(next + VIEWS.length) % VIEWS.length][0];
      show(v);
      root.querySelector(`#tab-${v}`).focus();
    });
    // focus stays inside while the board is open
    root.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const all = [...root.querySelectorAll('button:not([disabled]), a[href], [tabindex="0"], summary')].filter((el) => el.offsetParent !== null && !el.closest('.board-confirm'));
      const inConfirm = document.querySelector('.board-confirm:not([hidden])');
      if (inConfirm) return;
      if (e.shiftKey && document.activeElement === all[0]) { e.preventDefault(); all.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0].focus(); }
    });
  }
  function rules() {
    const li = (t) => h('li', null, t);
    return h('details', { class: 'board-rules' }, h('summary', null, 'How the weekly pick works'),
      h('ul', null,
        li('Weeks run Monday 00:00 UTC to the next Monday 00:00 UTC. The first week started when the board launched.'),
        li('Only new stars count: stars first given this week to an idea that is still collecting. Lifetime stars are shown but don’t decide the week.'),
        li('Sign in with GitHub to star. One star per GitHub account per idea; you can star as many ideas as you like. Tap a star again to remove it. Removing it before Monday takes it out of this week; starring again later doesn’t move it into a new week.'),
        li('One star can win. If no eligible idea gets a star, nothing is picked that week.'),
        li('Ties go to the idea that reached its final score first, then to the one published earlier.'),
        li('Ideas already picked, hidden, on hold or declined can’t be picked. Picked ideas stay readable and shareable.'),
        li('The pick joins a public build queue: a small working open-source prototype with source code and run instructions, and a hosted demo where practical. It isn’t delivered instantly; you can follow its progress here.'),
        li('Stars here are for ideas on Repo Safari. They don’t star the repos on GitHub and aren’t GitHub star counts. Milestones like 10 or 100 stars are for fun; they don’t trigger a build.'),
        li('Publishing makes the idea, its 3 source repos and your GitHub handle public. Signing in stores your GitHub account number and handle; your stars are stored with your account. Generated ideas you don’t publish are deleted after 24 hours. To have your account data deleted, open an issue on GitHub.')));
  }

  function open(view = 'top', opener = null) {
    if (!root) build();
    state.opener = opener ?? document.activeElement;
    S.pauseGame?.(); // a key held down in the game must not keep walking behind the board
    if (root.hidden) {
      root.hidden = false;
      document.body.classList.add('board-open');
      trackOnce('board/open', 'Idea board: opened');
      loadContest();
      clearInterval(countdown);
      countdown = setInterval(renderContest, 30_000);
    }
    renderAccount();
    state.detail = null;
    show(view, true);
    root.querySelector(`#tab-${view}`)?.focus({ preventScroll: true });
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('board-open');
    clearInterval(countdown); clearTimeout(state.cutoffTimer);
    if (/^#idea=/.test(location.hash) || location.hash === '#ideas') history.replaceState(null, '', location.pathname + location.search);
    state.opener?.focus?.({ preventScroll: true });
  }

  // ---------- account ----------
  function renderAccount() {
    const box = root?.querySelector('#boardAccount');
    if (!box) return;
    box.replaceChildren(...(session
      ? [h('span', null, `@${session.login}`), h('button', { type: 'button', class: 'btn board-link', onclick: signOut }, 'Sign out')]
      : [h('button', { type: 'button', class: 'btn board-link', onclick: () => signIn({ kind: 'board', view: state.view }) }, 'Sign in with GitHub')]));
  }

  // ---------- the contest strip ----------
  async function loadContest() {
    const r = await api('/board/contest');
    state.contest = r.ok ? { ...r.data, fetchedAt: Date.now() } : null;
    state.contestError = !r.ok;
    renderContest();
  }
  function renderContest() {
    const box = root?.querySelector('#boardContest');
    if (!box) return;
    const c = state.contest;
    if (state.contestError) { box.replaceChildren(h('p', null, 'This week’s contest couldn’t load. ', h('button', { type: 'button', class: 'btn board-link', onclick: loadContest }, 'Try again'))); return; }
    if (!c) { box.replaceChildren(h('p', { class: 'board-muted' }, 'Loading this week…')); return; }
    const now = c.now + (Date.now() - c.fetchedAt); // the server's clock, moved on locally
    // Monday 00:00 UTC passed while the board was open: fetch the new week (and its ranking) instead of showing "in 0m"
    if (c.week && now >= c.week.end && !state.rolling) {
      state.rolling = true;
      loadContest().then(() => { state.rolling = false; if (state.view === 'top' && !state.detail) show('top', true); });
    }
    // and wake up exactly at the cutoff rather than up to 30 s later
    clearTimeout(state.cutoffTimer);
    if (c.week && now < c.week.end && c.week.end - now < 2 * 3_600_000) state.cutoffTimer = setTimeout(renderContest, c.week.end - now + 250);
    const parts = [];
    if (c.week) {
      parts.push(h('p', { class: 'board-week' },
        h('b', null, c.week.partial ? 'Launch week (partial): ' : 'This week: '),
        `${utc(c.week.start)} → ${utc(c.week.end)}`),
        h('p', null, `Voting closes ${utc(c.week.end)} · in ${until(c.week.end, now)}.`));
      parts.push(c.leader
        ? h('p', null, 'Leading for now: ', ideaButton(c.leader), ` · ⭐ ${c.leader.weekStars} this week. Provisional until the week closes.`)
        : h('p', null, 'No stars yet this week. One star could win it.'));
    }
    if (c.previous) {
      const p = c.previous;
      parts.push(p.noWinner || !p.winner
        ? h('p', { class: 'board-muted' }, `Last week (${span(p.start, p.end)}): no pick, ${p.noWinner ? 'no eligible idea got a new star' : 'the pick is no longer public'}.`)
        : h('p', null, `Last week’s pick (${span(p.start, p.end)}): `, ideaButton(p.winner), ` · ⭐ ${p.winnerScore} new stars.`));
    }
    box.replaceChildren(...parts);
  }
  const ideaButton = (i) => h('button', { type: 'button', class: 'board-name-link', onclick: () => openIdea(i.id) }, i.name);

  // ---------- views ----------
  async function show(view, force = false) {
    if (!force && view === state.view && !state.detail) return;
    state.view = view; state.detail = null; state.items = []; state.next = null; state.error = false;
    trackOnce(`board/view-${view}`, `Idea board: ${view} view`);
    for (const [v] of VIEWS) {
      const t = root.querySelector(`#tab-${v}`);
      t.setAttribute('aria-selected', String(v === view));
      t.tabIndex = v === view ? 0 : -1;
    }
    root.querySelector('#boardPanel').setAttribute('aria-labelledby', `tab-${view}`);
    if (location.hash.startsWith('#idea=')) history.replaceState(null, '', location.pathname + location.search);
    await loadMore();
  }
  async function loadMore() {
    state.loading = true; renderList();
    const view = state.view;
    const r = await api(`/board/ideas?view=${view}${state.next ? `&cursor=${encodeURIComponent(state.next)}` : ''}`);
    if (view !== state.view || state.detail) return;
    state.loading = false;
    if (!r.ok) { state.error = true; renderList(); return; }
    const fresh = r.data.items.filter((i) => !state.items.some((x) => x.id === i.id));
    state.items.push(...fresh);
    // in Top this week, say why equal scores are in this order (the published tie-break)
    if (view === 'top') state.items.forEach((i, k) => { const prev = state.items[k - 1]; i.tieAfter = prev && prev.weekStars === i.weekStars ? prev.name : null; });
    state.next = r.data.next;
    await loadMine(fresh.map((i) => i.id));
    renderList();
  }
  async function loadMine(ids) {
    if (!session || !ids.length) return;
    const r = await api(`/board/me?ids=${ids.join(',')}`, { auth: true });
    if (r.ok) for (const id of ids) { if (r.data.starred.includes(id)) state.starred.add(id); else state.starred.delete(id); }
  }
  const EMPTY = {
    top: 'No stars yet this week. Open New and star an idea you like: one star could win the week.',
    new: 'No ideas yet. Generate three with the Idea Shower and publish your favourite.',
    building: 'Nothing in the build queue right now.',
    built: 'Nothing built yet. The first weekly pick will show up here when its prototype is ready.',
  };
  function renderList() {
    const panel = root.querySelector('#boardPanel');
    if (state.detail) return;
    const kids = [];
    if (state.view === 'building' && state.items.length) kids.push(h('p', { class: 'board-muted' }, 'Weekly picks in build order. One prototype per week is the promise, not instant delivery.'));
    kids.push(...state.items.map(card));
    if (state.error) kids.push(h('p', { class: 'board-error' }, 'The board couldn’t load. ', h('button', { type: 'button', class: 'btn board-link', onclick: loadMore }, 'Try again')));
    else if (state.loading) kids.push(h('p', { class: 'board-muted', 'aria-busy': 'true' }, 'Loading ideas…'));
    else if (!state.items.length) kids.push(h('p', { class: 'board-muted' }, EMPTY[state.view]));
    else if (state.next) kids.push(h('button', { type: 'button', class: 'btn board-more', onclick: loadMore }, 'Show more'));
    panel.replaceChildren(...kids);
  }

  // ---------- one idea: card and full page ----------
  function stats(i, ranked) {
    const bits = [`⭐ ${i.weekStars} this week`, `${i.totalStars} total`];
    if (ranked && i.rank) bits.push(`#${i.rank} this week`);
    return h('p', { class: 'board-stats' }, bits.join(' · '),
      ranked && i.tieAfter ? h('span', { class: 'board-tie' }, `Tied with ${i.tieAfter}, which reached ${i.weekStars} first.`) : null);
  }
  function statusLine(i) {
    const b = i.build;
    if (i.status === 'collecting') return null;
    const queue = b?.queuePosition ? ` · #${b.queuePosition} in the build queue` : '';
    const text = {
      selected: `Picked for the week of ${b ? span(b.weekStart, b.weekEnd) : '…'} with ⭐ ${b?.weeklyStars ?? '?'} new stars · waiting to be built${queue}`,
      building: `Building now${queue}`,
      built: 'Built ✓',
      held: 'On hold',
      declined: 'Declined',
    }[i.status] ?? i.status;
    return h('p', { class: `board-status s-${i.status}` }, text, i.statusNote ? h('span', null, ` · ${i.statusNote}`) : null);
  }
  function links(i) {
    const demo = i.build?.demoUrl && httpsUrl(i.build.demoUrl);
    const source = i.build?.sourceUrl && httpsUrl(i.build.sourceUrl)?.startsWith('https://github.com/') ? i.build.sourceUrl : null;
    if (!demo && !source) return null;
    return h('p', { class: 'board-links' },
      demo ? h('a', { href: demo, target: '_blank', rel: 'noopener noreferrer' }, 'Try the demo ↗') : null,
      source ? h('a', { href: source, target: '_blank', rel: 'noopener noreferrer' }, 'Source code ↗') : null);
  }
  function repoChips(i, full) {
    return h(full ? 'ul' : 'p', { class: `board-repos${full ? ' full' : ''}` }, ...i.repos.map((r) => {
      const url = ghUrl(r.url);
      const name = url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, r.name) : h('span', null, r.name);
      return full ? h('li', null, name, r.desc ? h('span', null, ` · ${tagline(r.desc)}`) : null, r.room ? h('small', null, ` (${r.room})`) : null) : name;
    }));
  }
  function starButton(i) {
    const on = state.starred.has(i.id), busy = state.pending.has(i.id);
    return h('button', {
      type: 'button', class: `btn board-star${on ? ' on' : ''}`, 'data-star': i.id, 'aria-pressed': String(on), 'aria-label': `Star ${i.name}`,
      // while saving it stays focusable (a disabled button would drop keyboard focus); repeat presses are ignored
      'aria-busy': busy ? 'true' : null, 'aria-disabled': busy ? 'true' : null, onclick: () => setStar(i.id, !on),
    }, busy ? 'Saving…' : on ? '★ Starred' : '☆ Star');
  }
  const shareButton = (i) => h('button', { type: 'button', class: 'btn', onclick: (e) => share(i, e.currentTarget) }, 'Share');
  function card(i) {
    return h('article', { class: 'board-card', 'data-id': i.id },
      h('p', { class: 'board-kind' }, KIND[i.kind] ?? i.kind),
      h('h3', null, h('button', { type: 'button', class: 'board-name-link', onclick: () => openIdea(i.id) }, i.name)),
      h('p', { class: 'board-pitch' }, i.pitch),
      repoChips(i, false),
      h('p', { class: 'board-by' }, `by @${i.publisher} · ${day(i.publishedAt)}`),
      stats(i, state.view === 'top'),
      statusLine(i), links(i),
      h('div', { class: 'board-acts' }, starButton(i), shareButton(i), h('button', { type: 'button', class: 'btn', onclick: () => openIdea(i.id) }, 'View')));
  }
  async function openIdea(id) {
    if (!root || root.hidden) open('top');
    if (!ID.test(id)) { state.detail = { id: '', missing: true }; renderDetail(); return; } // a malformed link: say so
    state.detail = { id, loading: true };
    history.replaceState(null, '', `${location.pathname}${location.search}#idea=${id}`);
    renderDetail();
    const r = await api(`/board/ideas/${id}`);
    if (state.detail?.id !== id) return;
    state.detail = r.ok ? { id, idea: r.data.idea } : { id, missing: r.status === 404 || r.status === 400, error: !(r.status === 404 || r.status === 400) };
    if (r.ok) await loadMine([id]);
    renderDetail();
    // on a phone the idea starts below the contest strip: bring it into view with the focus
    root.querySelector('#boardDetailTitle')?.focus({ preventScroll: true });
    root.querySelector('.board-back')?.scrollIntoView({ block: 'start', behavior: S.isReduced() ? 'auto' : 'smooth' });
  }
  function renderDetail() {
    const d = state.detail, panel = root.querySelector('#boardPanel');
    const back = h('button', { type: 'button', class: 'btn board-link board-back', onclick: () => show(state.view, true) }, '← All ideas');
    if (d.loading) { panel.replaceChildren(back, h('p', { class: 'board-muted', 'aria-busy': 'true' }, 'Loading the idea…')); return; }
    if (d.missing) { panel.replaceChildren(back, h('p', { class: 'board-error', id: 'boardDetailTitle', tabindex: '-1' }, 'This idea isn’t on the board. It may have been removed, or the link is wrong.')); return; }
    if (d.error) { panel.replaceChildren(back, h('p', { class: 'board-error', id: 'boardDetailTitle', tabindex: '-1' }, 'The idea couldn’t load. ', h('button', { type: 'button', class: 'btn board-link', onclick: () => openIdea(d.id) }, 'Try again'))); return; }
    const i = d.idea, b = i.build;
    panel.replaceChildren(back, h('article', { class: 'board-card board-detail', 'data-id': i.id },
      h('p', { class: 'board-kind' }, KIND[i.kind] ?? i.kind),
      h('h3', { id: 'boardDetailTitle', tabindex: '-1' }, i.name),
      h('p', { class: 'board-pitch' }, i.pitch),
      h('p', null, i.concept),
      h('p', { class: 'board-muted' }, i.inspiration),
      h('h4', null, 'Made from'), repoChips(i, true),
      h('p', { class: 'board-by' }, `Published by @${i.publisher} on ${day(i.publishedAt)}. Source repos as they were on Repo Safari then.`),
      stats(i, true),
      b ? h('p', { class: 'board-muted' }, `Picked for ${span(b.weekStart, b.weekEnd)} with ⭐ ${b.weeklyStars} new stars (${b.lifetimeStars} total then). Today: ${i.totalStars} total.`) : null,
      statusLine(i), links(i),
      h('div', { class: 'board-acts' }, starButton(i), shareButton(i)),
      h('p', { class: 'board-muted board-fine' }, 'Stars here are for this idea on Repo Safari, not GitHub stars on its repos.')));
  }

  // ---------- stars: idempotent set/clear, counts only from the server ----------
  async function setStar(id, on) {
    if (!session) { signIn({ kind: 'star', id }); return; }
    if (state.pending.has(id)) return;
    state.pending.add(id);
    refreshIdea(id);
    const r = await api(`/board/ideas/${id}/star`, { method: on ? 'PUT' : 'DELETE', auth: true });
    state.pending.delete(id);
    if (!r.ok) {
      announce(r.status === 401 ? 'Your sign-in expired. Sign in again to star.' : r.status === 429 ? 'That’s a lot of stars at once. Wait a minute and try again.' : 'Your star wasn’t saved. Try again.');
      if (r.status === 401) signIn({ kind: 'star', id });
      refreshIdea(id);
      return;
    }
    const before = findIdea(id)?.totalStars ?? 0;
    if (r.data.starred) state.starred.add(id); else state.starred.delete(id);
    for (const it of [...state.items, state.detail?.idea].filter((x) => x?.id === id)) { it.totalStars = r.data.total; it.weekStars = r.data.week; }
    if (r.data.starred) trackOnce('board/star', 'Idea board: starred an idea');
    const name = findIdea(id)?.name ?? 'the idea';
    announce(r.data.starred ? `Starred ${name}. ${r.data.total} total.` : `Removed your star from ${name}.`);
    refreshIdea(id);
    for (const m of [10, 100]) if (before < m && r.data.total >= m) celebrate(id, m);
    // the vote may change the leader, ranks and ties: refresh them from the server, in place
    loadContest();
    refreshRanks(id);
  }
  /**
   * Re-reads the ranking after a vote and updates each card's numbers and tie note where it is: cards don't jump
   * under the pointer or lose focus. If the order is now wrong, a button offers to re-sort.
   */
  async function refreshRanks(id) {
    if (state.detail) {
      const r = await api(`/board/ideas/${id}`);
      if (r.ok && state.detail?.idea?.id === id) { Object.assign(state.detail.idea, { rank: r.data.idea.rank, weekStars: r.data.idea.weekStars, totalStars: r.data.idea.totalStars }); refreshIdea(id); }
      return;
    }
    if (state.view !== 'top') return;
    const r = await api(`/board/ideas?view=top&limit=${Math.min(30, Math.max(1, state.items.length))}`);
    if (!r.ok || state.view !== 'top' || state.detail) return;
    const fresh = r.data.items;
    const by = new Map(fresh.map((x, k) => [x.id, { ...x, tieAfter: k && fresh[k - 1].weekStars === x.weekStars ? fresh[k - 1].name : null }]));
    for (const it of state.items) {
      const f = by.get(it.id);
      Object.assign(it, f ? { rank: f.rank, weekStars: f.weekStars, totalStars: f.totalStars, tieAfter: f.tieAfter } : { rank: null, tieAfter: null });
      refreshIdea(it.id);
    }
    const sorted = state.items.every((it, k, all) => k === 0 || (all[k - 1].rank ?? Infinity) <= (it.rank ?? Infinity));
    const panel = root.querySelector('#boardPanel');
    panel.querySelector('.board-resort')?.remove();
    if (!sorted) panel.prepend(h('p', { class: 'board-muted board-resort' }, 'The ranking changed. ', h('button', { type: 'button', class: 'btn board-link', onclick: () => show('top', true) }, 'Show the new order')));
  }
  const findIdea = (id) => (state.detail?.idea?.id === id ? state.detail.idea : state.items.find((x) => x.id === id));
  /** Updates one card in place: no reordering, and focus stays on the same button. */
  function refreshIdea(id) {
    const i = findIdea(id);
    const el = root?.querySelector(`.board-card[data-id="${id}"]`);
    if (!i || !el) return;
    const hadFocus = el.contains(document.activeElement) && document.activeElement.matches('.board-star');
    el.querySelector('.board-star')?.replaceWith(starButton(i));
    el.querySelector('.board-stats')?.replaceWith(stats(i, state.detail ? true : state.view === 'top'));
    if (hadFocus) el.querySelector('.board-star')?.focus({ preventScroll: true });
  }
  function celebrate(id, m) {
    const el = root?.querySelector(`.board-card[data-id="${id}"]`);
    if (!el || el.querySelector('.board-party')) return;
    el.append(h('p', { class: `board-party${S.isReduced() ? '' : ' pop'}` }, `🎉 ${m} stars! A milestone for fun: the weekly pick still goes to new stars.`));
  }
  const announce = (text) => { const live = root?.querySelector('#boardLive'); if (live) live.textContent = text; };

  // ---------- sharing ----------
  async function share(i, btn) {
    const url = ideaLink(i.id);
    trackOnce('board/share', 'Idea board: shared an idea');
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: i.name, text: `${i.name}: ${i.pitch}`, url }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); btn.textContent = 'Link copied ✓'; setTimeout(() => (btn.textContent = 'Share'), 1600); }
    catch { announce(`Copy this link: ${url}`); toast('Copy failed. The link is shown on the board.'); }
  }

  // ---------- publishing: explicit, confirmed, exactly the saved output ----------
  function publish(result, index, btn) {
    if (!result?.draft) { toast('Publishing isn’t available for this mix.'); return; }
    if (!session) { signIn({ kind: 'publish', index, result: { repos: result.repos, ideas: result.ideas, draft: result.draft } }); return; }
    confirmPublish(result, index, btn);
  }
  function confirmPublish(result, index, opener) {
    const idea = result?.ideas?.[index];
    if (!idea || !result.draft) return;
    S.pauseGame?.();
    const box = h('div', { class: 'board-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pubTitle' });
    const shade = h('div', { class: 'board-shade' }, box);
    const done = () => { shade.remove(); document.removeEventListener('keydown', onKey, true); (opener && document.contains(opener) ? opener : document.querySelector('#showerBtn') ?? document.body).focus?.({ preventScroll: true }); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(); }
      if (e.key === 'Tab') {
        const all = [...box.querySelectorAll('button:not([disabled]), a[href]')];
        if (e.shiftKey && document.activeElement === all[0]) { e.preventDefault(); all.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === all.at(-1)) { e.preventDefault(); all[0].focus(); }
      }
    };
    const status = h('p', { class: 'board-live', role: 'status' });
    const go = h('button', { type: 'button', class: 'btn go' }, 'Publish');
    const ask = () => box.replaceChildren(
      h('h2', { id: 'pubTitle' }, 'Publish to the idea board?'),
      h('p', null, h('b', null, idea.name), ` · ${idea.pitch}`),
      h('p', { class: 'board-muted' }, `Made from ${result.repos.join(', ')}`),
      h('p', null, `This makes the idea, its 3 source repos and your GitHub handle (@${session.login}) public. Anyone can open it and star it. You can’t edit it after publishing; publishing doesn’t star it.`),
      status,
      h('div', { class: 'board-acts' }, go, h('button', { type: 'button', class: 'btn', onclick: done }, 'Cancel')));
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = 'Publishing…'; status.textContent = '';
      // safe to retry: the same draft and idea always give the same public record
      let r = await api('/board/publish', { method: 'POST', auth: true, body: { draftId: result.draft.id, receipt: result.draft.receipt, index } });
      if (r.status === 0) r = await api('/board/publish', { method: 'POST', auth: true, body: { draftId: result.draft.id, receipt: result.draft.receipt, index } });
      if (!r.ok) {
        go.disabled = false; go.textContent = 'Try again';
        status.textContent = r.status === 401 ? 'Your sign-in expired. Sign in again to publish.'
          : r.status === 403 ? 'This mix can’t be published any more (generated ideas are kept for 24 hours). Generate a fresh mix to publish.'
          : r.status === 410 ? 'This idea was removed from the board and can’t be published again.'
          : r.status === 429 ? 'You’ve published a lot today. Try again tomorrow.'
          : 'Publishing didn’t work. Your idea is still here; try again.';
        if (r.status === 401) { go.textContent = 'Sign in again'; go.onclick = () => signIn({ kind: 'publish', index, result: { repos: result.repos, ideas: result.ideas, draft: result.draft } }); }
        return;
      }
      trackOnce('board/publish', 'Idea board: published an idea');
      const id = r.data.id;
      const copyBtn = h('button', { type: 'button', class: 'btn' }, 'Copy share link');
      copyBtn.addEventListener('click', () => share({ id, name: idea.name, pitch: idea.pitch }, copyBtn));
      box.replaceChildren(
        h('h2', { id: 'pubTitle' }, r.data.created ? 'Published!' : 'Already on the board'),
        h('p', null, r.data.created ? `${idea.name} is on the board with 0 stars. Share it so people can star it.` : `${idea.name} was already published, so it keeps its stars. Here it is.`),
        h('div', { class: 'board-acts' },
          h('button', { type: 'button', class: 'btn go', onclick: () => { done(); S.closeMix(); openIdea(id); } }, 'View idea'),
          copyBtn,
          h('button', { type: 'button', class: 'btn', onclick: done }, 'Close')));
      box.querySelector('.btn.go').focus();
    });
    ask();
    document.body.append(shade);
    document.addEventListener('keydown', onKey, true);
    go.focus();
  }

  // ---------- Escape: the confirm handles its own; then the board, before the page or the game ----------
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !root || root.hidden || document.querySelector('.board-shade')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (state.detail) show(state.view, true); else close();
  }, true);

  // ---------- links: #idea=<id>, #ideas, and the sign-in return ----------
  async function route() {
    if (await finishSignIn()) return;
    const m = /^#idea=(.+)$/.exec(location.hash);
    if (m) { track('board/idea-open', 'Idea board: idea link opened'); openIdea(m[1]); }
    else if (location.hash === '#ideas') open('top');
  }
  addEventListener('hashchange', route);
  S.board = { open, openIdea, publish };
  route();
})();
