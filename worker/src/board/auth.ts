/**
 * "Sign in with GitHub" for the idea board, built for a page and a Worker on different sites (GitHub Pages and
 * workers.dev), so it never relies on third-party cookies:
 *
 *   1. The page makes a random verifier, keeps it in its own storage, and opens
 *      /auth/github/start?return=<page>&challenge=<SHA-256 of the verifier, base64url>.
 *   2. The Worker saves a single-use OAuth state (10 minutes) with that challenge and sends the browser to GitHub
 *      with no scopes: public profile only, nothing on repositories, organizations or private email.
 *   3. /auth/github/callback consumes the state, swaps GitHub's code for a token, reads the numeric account id and
 *      handle, drops the token, and returns to the page with a one-time login code in the URL fragment (2 minutes;
 *      fragments aren't sent to servers).
 *   4. The page POSTs the code with its verifier to /auth/exchange and gets a session token (30 days), which it sends
 *      as `Authorization: Bearer`. Only SHA-256 hashes of states, codes and tokens are stored.
 *
 * A login code is useless without the verifier, which never leaves the browser that started the sign-in.
 */
import type { D1Database } from './d1';
import { DAY } from './contest';
import type { Account } from './store';
import { isSecret, newSecret, sameSecret, sha256B64url, sha256Hex } from './util';

export const STATE_TTL = 10 * 60_000;
export const CODE_TTL = 2 * 60_000;
export const SESSION_TTL = 30 * DAY;

export type AuthEnv = {
  BOARD_DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ALLOWED_ORIGINS: string;
  /** Local preview only (with BOARD_DEV=1 and a localhost address): a stand-in for github.com and api.github.com. */
  GITHUB_OAUTH_URL?: string;
  GITHUB_API_URL?: string;
  BOARD_DEV?: string;
};

const allowedOrigins = (env: AuthEnv) => env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
const isLocal = (u: string) => { try { return ['127.0.0.1', 'localhost'].includes(new URL(u).hostname); } catch { return false; } };
/** GitHub's addresses, or a local stand-in when (and only when) the preview runs on this machine. */
function github(env: AuthEnv) {
  const dev = env.BOARD_DEV === '1';
  const oauth = dev && env.GITHUB_OAUTH_URL && isLocal(env.GITHUB_OAUTH_URL) ? env.GITHUB_OAUTH_URL : 'https://github.com';
  const api = dev && env.GITHUB_API_URL && isLocal(env.GITHUB_API_URL) ? env.GITHUB_API_URL : 'https://api.github.com';
  return { oauth: oauth.replace(/\/+$/, ''), api: api.replace(/\/+$/, '') };
}

/** A return address on one of our own pages (exact origin match), without its fragment; anything else is refused. */
export function safeReturn(raw: string | null, env: AuthEnv): string | null {
  if (!raw || raw.length > 500) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!allowedOrigins(env).includes(u.origin) || u.username || u.password) return null;
  u.hash = '';
  return u.href;
}

const page = (status: number, text: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Repo Safari sign-in</title><body style="font:16px system-ui;background:#0A0C14;color:#ECEFF7;padding:24px"><p>${text}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });

export async function startLogin(req: Request, env: AuthEnv, now: number): Promise<Response> {
  const url = new URL(req.url);
  const back = safeReturn(url.searchParams.get('return'), env);
  const challenge = url.searchParams.get('challenge');
  if (!back || !isSecret(challenge)) return page(400, 'This sign-in link isn’t valid. Go back to Repo Safari and try again.');
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return redirect(`${back}#login-error=unavailable`);
  const state = newSecret();
  await env.BOARD_DB.prepare('INSERT INTO oauth_states (state_hash, challenge, return_to, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(state), challenge, back, now + STATE_TTL).run();
  const q = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${url.origin}/auth/github/callback`, state, allow_signup: 'true' });
  return redirect(`${github(env).oauth}/login/oauth/authorize?${q}`);
}

export async function finishLogin(req: Request, env: AuthEnv, now: number): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  if (!isSecret(state)) return page(400, 'This sign-in has expired. Go back to Repo Safari and try again.');
  // single use: the row is gone whether this succeeds or not, so a replayed callback finds nothing
  const s = await env.BOARD_DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING challenge, return_to, expires_at')
    .bind(await sha256Hex(state)).first<{ challenge: string; return_to: string; expires_at: number }>();
  if (!s || s.expires_at <= now) return page(400, 'This sign-in has expired. Go back to Repo Safari and try again.');
  const fail = (why: string) => redirect(`${s.return_to}#login-error=${why}`);
  if (!code || code.length > 100 || url.searchParams.get('error')) return fail('denied');
  const gh = github(env);
  let who: Account;
  try {
    const tok = await fetch(`${gh.oauth}/login/oauth/access_token`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/github/callback` }),
    });
    const accessToken = ((await tok.json()) as { access_token?: unknown }).access_token;
    if (typeof accessToken !== 'string') return fail('failed');
    const u = await fetch(`${gh.api}/user`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'repo-safari-board' } });
    const user = (await u.json()) as { id?: unknown; login?: unknown };
    // the token is not kept: only the numeric id and the handle
    if (!u.ok || !Number.isSafeInteger(user.id) || (user.id as number) <= 0 || typeof user.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(user.login)) return fail('failed');
    who = { githubId: user.id as number, login: user.login };
  } catch {
    return fail('failed');
  }
  const loginCode = newSecret();
  await env.BOARD_DB.batch([
    env.BOARD_DB.prepare(`INSERT INTO accounts (github_id, login, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, updated_at = excluded.updated_at, deleted_at = NULL`).bind(who.githubId, who.login, now, now),
    env.BOARD_DB.prepare('INSERT INTO login_codes (code_hash, github_id, challenge, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256Hex(loginCode), who.githubId, s.challenge, now + CODE_TTL),
  ]);
  return redirect(`${s.return_to}#login=${loginCode}`);
}

/** POST {code, verifier} -> a session token. The code is consumed even if the verifier is wrong. */
export async function exchange(body: unknown, env: AuthEnv, now: number): Promise<{ token: string; account: Account; expiresAt: number } | null> {
  const { code, verifier } = (body ?? {}) as { code?: unknown; verifier?: unknown };
  if (!isSecret(code) || !isSecret(verifier)) return null;
  const c = await env.BOARD_DB.prepare('DELETE FROM login_codes WHERE code_hash = ? RETURNING github_id, challenge, expires_at')
    .bind(await sha256Hex(code)).first<{ github_id: number; challenge: string; expires_at: number }>();
  if (!c || c.expires_at <= now || !sameSecret(c.challenge, await sha256B64url(verifier))) return null;
  const acct = await env.BOARD_DB.prepare('SELECT github_id, login FROM accounts WHERE github_id = ? AND deleted_at IS NULL').bind(c.github_id).first<{ github_id: number; login: string }>();
  if (!acct) return null;
  const token = newSecret();
  await env.BOARD_DB.prepare('INSERT INTO sessions (token_hash, github_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256Hex(token), acct.github_id, now, now + SESSION_TTL).run();
  return { token, account: { githubId: acct.github_id, login: acct.login }, expiresAt: now + SESSION_TTL };
}

/** The signed-in account from `Authorization: Bearer <token>`, or null (missing, unknown, expired or deleted). */
export async function sessionAccount(req: Request, env: AuthEnv, now: number): Promise<Account | null> {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') ?? '');
  if (!m) return null;
  const row = await env.BOARD_DB.prepare(`SELECT a.github_id, a.login FROM sessions s JOIN accounts a ON a.github_id = s.github_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.deleted_at IS NULL`).bind(await sha256Hex(m[1]), now).first<{ github_id: number; login: string }>();
  return row ? { githubId: row.github_id, login: row.login } : null;
}

export async function logout(req: Request, env: AuthEnv): Promise<void> {
  const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') ?? '');
  if (m) await env.BOARD_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(m[1])).run();
}
