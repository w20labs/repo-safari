import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { originOf, parseCookies, setCookie } from './http.ts';
import { getPlayer, linkGithub } from './store.ts';

/**
 * "Sign in with GitHub" (OAuth web flow, no scopes: public profile only). The access token is used
 * once to read the user's id and login, then dropped. Enabled when GITHUB_CLIENT_ID and
 * GITHUB_CLIENT_SECRET are set; the OAuth app's callback URL must be <PUBLIC_URL>/auth/github/callback.
 */
export const PID_COOKIE = 'lcs_pid';
const STATE_COOKIE = 'lcs_oauth_state';
const RETURN_COOKIE = 'lcs_oauth_return';
const YEAR = 60 * 60 * 24 * 365;

export const authAvailable = () => !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);

/** Only same-site relative paths are allowed as return targets. */
export const safeReturn = (raw: string | null): string => (raw && /^\/(?!\/)[^\s\\]*$/.test(raw) ? raw : '/');

function redirect(res: ServerResponse, to: string) {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
  res.end();
}

export function startGithubLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (!authAvailable()) return redirect(res, '/?auth=unavailable');
  const state = randomBytes(16).toString('base64url');
  setCookie(res, STATE_COOKIE, state, 600);
  setCookie(res, RETURN_COOKIE, safeReturn(url.searchParams.get('return')), 600);
  const q = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID!,
    redirect_uri: `${originOf(req)}/auth/github/callback`,
    state,
    allow_signup: 'true',
  });
  redirect(res, `https://github.com/login/oauth/authorize?${q}`);
}

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function finishGithubLogin(req: IncomingMessage, res: ServerResponse, url: URL) {
  const cookies = parseCookies(req);
  const back = safeReturn(cookies[RETURN_COOKIE] ?? '/');
  setCookie(res, STATE_COOKIE, '', 0);
  setCookie(res, RETURN_COOKIE, '', 0);
  const fail = () => redirect(res, `${back}${back.includes('?') ? '&' : '?'}auth=failed`);
  const code = url.searchParams.get('code');
  if (!authAvailable() || !code || !sameState(cookies[STATE_COOKIE], url.searchParams.get('state'))) return fail();
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${originOf(req)}/auth/github/callback`,
      }),
    });
    const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
    if (!token) return fail();
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'last-commit-standing' },
    });
    if (!userRes.ok) return fail();
    const user = (await userRes.json()) as { id?: number; login?: string };
    if (!Number.isInteger(user.id) || typeof user.login !== 'string') return fail();
    const current = getPlayer(cookies[PID_COOKIE]);
    const { playerId } = linkGithub(current?.id ?? null, user.id!, user.login);
    setCookie(res, PID_COOKIE, playerId, YEAR);
    redirect(res, `${back}${back.includes('?') ? '&' : '?'}signedin=1`);
  } catch (err) {
    console.error('[auth] GitHub login failed', err);
    fail();
  }
}

export function logout(res: ServerResponse) {
  setCookie(res, PID_COOKIE, '', 0);
}
