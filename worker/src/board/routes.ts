/**
 * Idea board HTTP API. Only reachable when BOARD_ENABLED is "1" and the BOARD_DB (D1) binding exists; otherwise every
 * path here is a 404 and the scheduled job does nothing.
 *
 *   GET    /board/contest                 current week, provisional leader, last result
 *   GET    /board/ideas?view=top|new|building|built&cursor=
 *   GET    /board/ideas/<id>              one idea in full
 *   GET    /board/me?ids=a,b              signed in: account and which of these ideas it starred
 *   PUT    /board/ideas/<id>/star         signed in: star (idempotent)
 *   DELETE /board/ideas/<id>/star         signed in: unstar (idempotent)
 *   POST   /board/publish                 signed in: {draftId, receipt, index}
 *   GET    /auth/github/start | /auth/github/callback;  POST /auth/exchange | /auth/logout
 *   POST   /board/admin                   owner only (X-Admin-Token), see scripts/board-admin.ts
 *   /dev/* local preview only (BOARD_DEV=1 on 127.0.0.1/localhost): test clock and closing
 */
import { exchange, finishLogin, logout, sessionAccount, startLogin, type AuthEnv } from './auth';
import { weekAt } from './contest';
import { cleanup, closeDueWeeks, contestInfo, deleteAccount, getIdea, launchAt, listIdeas, moderate, moderateStars, publishDraft, report, setBuild, setStar, starredBy, type ModAction, type View } from './store';
import { cleanNote, isIdeaId, isSecret, sameSecret } from './util';

export type BoardEnv = AuthEnv & { BOARD_ENABLED?: string; ADMIN_TOKEN?: string };

export const boardOn = (env: Partial<BoardEnv>): env is BoardEnv => env.BOARD_ENABLED === '1' && !!env.BOARD_DB;

const isLocalHost = (req: Request) => ['127.0.0.1', 'localhost'].includes(new URL(req.url).hostname);

/** The server's clock. In the local preview (and only there) a test clock can stand in for it. */
export async function clock(env: BoardEnv): Promise<number> {
  if (env.BOARD_DEV === '1') {
    const row = await env.BOARD_DB.prepare('SELECT now_ms FROM dev_clock WHERE id = 1').first<{ now_ms: number }>();
    if (row) return row.now_ms;
  }
  return Date.now();
}

/** The scheduled job (hourly): records the launch, closes ended weeks oldest first, and deletes expired records. */
export async function runSchedule(env: BoardEnv): Promise<void> {
  const now = await clock(env);
  await launchAt(env.BOARD_DB, now);
  const closed = await closeDueWeeks(env.BOARD_DB, now);
  for (const c of closed) if (!c.already) console.log(`board: closed week ${new Date(c.start).toISOString()} winner=${c.winner ?? 'none'} score=${c.score}`);
  await cleanup(env.BOARD_DB, now);
}

type Json = (status: number, body: unknown, opts?: { cache?: 'public' | 'private' }) => Response;

/** Handles a board or auth path, or returns null so the caller answers 404. */
export async function boardRoute(req: Request, env: BoardEnv, allowedOrigin: string | null): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname;
  if (!path.startsWith('/board/') && !path.startsWith('/auth/') && !path.startsWith('/dev/')) return null;
  const base: Record<string, string> = allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin, Authorization' } : {};
  const json: Json = (status, body, opts) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...base,
      // public reads may be cached briefly (a hidden idea disappears within 15 s); anything per-person never is
      'Cache-Control': opts?.cache === 'public' && status === 200 ? 'public, max-age=15' : 'no-store' },
  });
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...base, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
  }
  const now = await clock(env);

  // ---- local preview helpers (before anything records the launch, so a test can set the clock first) ----
  if (path.startsWith('/dev/')) {
    if (env.BOARD_DEV !== '1' || !isLocalHost(req)) return null;
    if (path === '/dev/clock' && req.method === 'POST') {
      const { at } = (await body(req)) as { at?: unknown };
      if (at === null) await env.BOARD_DB.prepare('DELETE FROM dev_clock').run();
      else if (typeof at === 'number' && Number.isFinite(at)) await env.BOARD_DB.prepare('INSERT INTO dev_clock (id, now_ms) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET now_ms = excluded.now_ms').bind(at).run();
      else return json(400, { error: 'at' });
      return json(200, { now: await clock(env) });
    }
    if (path === '/dev/clock' && req.method === 'GET') return json(200, { now });
    if (path === '/dev/close' && req.method === 'POST') return json(200, { closed: await closeDueWeeks(env.BOARD_DB, now) });
    return null;
  }

  // the first request while enabled records the launch: the first (partial) contest starts here
  const launch = await launchAt(env.BOARD_DB, now);
  const week = launch === null ? null : weekAt(now, launch);

  // ---- sign-in: top-level navigations, then same-origin-checked POSTs ----
  if (path === '/auth/github/start' && req.method === 'GET') return startLogin(req, env, now);
  if (path === '/auth/github/callback' && req.method === 'GET') return finishLogin(req, env, now);

  // ---- owner operations: a separate secret, never in the page; no CORS ----
  if (path === '/board/admin' && req.method === 'POST') return admin(req, env, now);

  // ---- writes from the page: an allowed Origin is required (CORS alone isn't authentication) ----
  const write = req.method !== 'GET';
  if (write && !allowedOrigin) return json(403, { error: 'origin' });

  if (path === '/auth/exchange' && req.method === 'POST') {
    const s = await exchange(await body(req), env, now);
    return s ? json(200, { token: s.token, account: { login: s.account.login }, expiresAt: s.expiresAt }) : json(401, { error: 'login' });
  }
  if (path === '/auth/logout' && req.method === 'POST') { await logout(req, env); return json(200, { ok: true }); }

  // ---- public reads ----
  if (path === '/board/contest' && req.method === 'GET') return json(200, await contestInfo(env.BOARD_DB, now, launch), { cache: 'public' });
  if (path === '/board/ideas' && req.method === 'GET') {
    const view = url.searchParams.get('view') as View;
    if (!['top', 'new', 'building', 'built'].includes(view)) return json(400, { error: 'view' });
    const cursor = url.searchParams.get('cursor');
    if (cursor && !/^[0-9a-z.]{1,40}$/.test(cursor)) return json(400, { error: 'cursor' });
    return json(200, { ...(await listIdeas(env.BOARD_DB, view, cursor, week)), week }, { cache: 'public' });
  }
  const one = /^\/board\/ideas\/([^/]+)(\/star)?$/.exec(path);
  if (one && !one[2] && req.method === 'GET') {
    if (!isIdeaId(one[1])) return json(400, { error: 'id' });
    const idea = await getIdea(env.BOARD_DB, one[1], week);
    return idea ? json(200, { idea, week }, { cache: 'public' }) : json(404, { error: 'not_found' });
  }

  // ---- signed in ----
  const who = await sessionAccount(req, env, now);
  if (path === '/board/me' && req.method === 'GET') {
    if (!who) return json(401, { error: 'signin' });
    const asked = (url.searchParams.get('ids') ?? '').split(',').filter(isIdeaId).slice(0, 60);
    return json(200, { account: { login: who.login }, starred: await starredBy(env.BOARD_DB, who.githubId, asked) });
  }
  if (one?.[2] && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (!isIdeaId(one[1])) return json(400, { error: 'id' });
    if (!who) return json(401, { error: 'signin' });
    const r = await setStar(env.BOARD_DB, one[1], who.githubId, req.method === 'PUT', now, week);
    if ('error' in r) return json(r.error === 'limit' ? 429 : 404, r);
    return json(200, r);
  }
  if (path === '/board/publish' && req.method === 'POST') {
    if (!who) return json(401, { error: 'signin' });
    const { draftId, receipt, index } = (await body(req)) as { draftId?: unknown; receipt?: unknown; index?: unknown };
    if (typeof draftId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(draftId) || !isSecret(receipt) || !Number.isInteger(index)) return json(400, { error: 'draft' });
    const r = await publishDraft(env.BOARD_DB, who, draftId, receipt as string, index as number, now);
    if ('error' in r) return json(r.error === 'limit' ? 429 : r.error === 'removed' ? 410 : 403, r);
    return json(200, r);
  }
  return null;
}

/** A small JSON body (at most 4 KB), or {} if it isn't one. */
async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 4096) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/** Owner operations. The token must be a long random secret (`wrangler secret put ADMIN_TOKEN`). */
async function admin(req: Request, env: BoardEnv, now: number): Promise<Response> {
  const out = (status: number, b: unknown) => new Response(JSON.stringify(b, null, 1), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const given = req.headers.get('X-Admin-Token') ?? '';
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !sameSecret(given, env.ADMIN_TOKEN)) return out(401, { error: 'admin' });
  const a = (await body(req)) as Record<string, unknown>;
  const reason = cleanNote(a.reason);
  const idea = isIdeaId(a.idea) ? a.idea : null;
  const account = Number.isSafeInteger(a.githubId) ? (a.githubId as number) : null;
  switch (a.action) {
    case 'hide': case 'unhide': case 'hold': case 'release': case 'decline': case 'reinstate':
      if (!idea || !reason) return out(400, { error: 'idea and reason required' });
      return out(200, await moderate(env.BOARD_DB, idea, a.action as ModAction, reason, a.note == null ? null : cleanNote(a.note), now));
    case 'exclude-stars': case 'restore-stars':
      if (!account || !reason) return out(400, { error: 'githubId and reason required' });
      return out(200, await moderateStars(env.BOARD_DB, account, idea, a.action === 'exclude-stars', reason, now));
    case 'building': case 'built': case 'selected':
      if (!idea) return out(400, { error: 'idea required' });
      return out(200, await setBuild(env.BOARD_DB, idea, a.action, { demoUrl: a.demoUrl, sourceUrl: a.sourceUrl, note: a.note }, now));
    case 'delete-account':
      if (!account || !reason) return out(400, { error: 'githubId and reason required' });
      return out(200, await deleteAccount(env.BOARD_DB, account, reason, now));
    case 'close':
      return out(200, { closed: await closeDueWeeks(env.BOARD_DB, now) });
    case 'report':
      return out(200, await report(env.BOARD_DB));
    default:
      return out(400, { error: 'unknown action' });
  }
}
