import type { IncomingMessage, ServerResponse } from 'node:http';
import { padPlayerNumber } from '../shared/constants.ts';
import { dateKey } from '../shared/rng.ts';
import { formatScore } from '../shared/scoring.ts';
import { cardPng } from './card.ts';
import { checkFinish, summaryFor, type FinishBody } from './daily.ts';
import { HttpError, escapeHtml, json, originOf, parseCookies, readJson, setCookie } from './http.ts';
import {
  cleanName,
  courseForDate,
  createPlayer,
  currentPool,
  finishRun,
  getPlayer,
  getRun,
  leaderboard,
  officialRun,
  rankOf,
  setPlayerName,
  startOfficialRun,
  type PlayerRow,
} from './store.ts';
import { getMeta } from './db.ts';
import { playerStats, rankLine, streakAt } from './stats.ts';

const PID_COOKIE = 'lcs_pid';
const YEAR = 60 * 60 * 24 * 365;

/** Finds the player from the cookie, creating one (and setting the cookie) if needed. */
export function ensurePlayer(req: IncomingMessage, res: ServerResponse): PlayerRow {
  const existing = getPlayer(parseCookies(req)[PID_COOKIE]);
  if (existing) return existing;
  const p = createPlayer();
  setCookie(res, PID_COOKIE, p.id, YEAR);
  return p;
}

export const playerFromCookie = (req: IncomingMessage) => getPlayer(parseCookies(req)[PID_COOKIE]);

const validDate = (d: unknown): d is string => typeof d === 'string' && /^\d{8}$/.test(d);

type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/me$/, (req, res) => {
    const p = ensurePlayer(req, res);
    const today = dateKey();
    json(res, 200, { id: p.id, num: p.num, name: p.name, today, playedToday: !!officialRun(p.id, today), stats: playerStats(p.id, today) });
  }],

  ['POST', /^\/api\/me$/, async (req, res) => {
    const p = ensurePlayer(req, res);
    const body = await readJson<{ name?: string }>(req);
    const name = cleanName(body.name);
    setPlayerName(p.id, name);
    json(res, 200, { id: p.id, num: p.num, name });
  }],

  ['GET', /^\/api\/daily\/course$/, (_req, res, _p, url) => {
    const date = url.searchParams.get('date') ?? dateKey();
    if (!validDate(date)) throw new HttpError(400, 'bad date');
    if (date > dateKey()) throw new HttpError(404, 'not yet');
    const { pool, repos } = courseForDate(date);
    json(res, 200, { date, pool, repos });
  }],

  ['POST', /^\/api\/daily\/start$/, (req, res) => {
    const p = ensurePlayer(req, res);
    const date = dateKey();
    const { pool, repos } = courseForDate(date);
    const run = startOfficialRun(p.id, date);
    json(res, 200, { runId: run?.id ?? null, official: !!run, date, pool, repos });
  }],

  ['POST', /^\/api\/daily\/finish$/, async (req, res) => {
    const p = playerFromCookie(req);
    if (!p) throw new HttpError(401, 'no player');
    const body = await readJson<FinishBody & { runId?: string }>(req);
    const run = getRun(String(body.runId ?? ''));
    if (!run || run.player_id !== p.id || !run.official) throw new HttpError(404, 'run not found');
    if (run.finished_at) throw new HttpError(409, 'run already finished');
    const { course, pool } = courseForDate(run.date);
    const check = checkFinish(course, pool, run.date, body, Date.now() - run.started_at);
    if (!check.ok) throw new HttpError(422, `rejected: ${check.error}`);
    finishRun(run.id, check);
    const done = getRun(run.id)!;
    const origin = originOf(req);
    const { rank } = rankOf(done);
    const { players } = leaderboard(run.date, p.id, 0);
    const stats = playerStats(p.id, run.date);
    json(res, 200, {
      ok: true,
      score: check.score,
      cleared: check.cleared,
      outLabel: check.outLabel,
      rank,
      players,
      rankLine: rankLine(rank, players, stats.currentStreak),
      stats,
      url: `${origin}/r/${run.id}`,
    });
  }],

  ['GET', /^\/api\/daily\/leaderboard$/, (req, res, _p, url) => {
    const date = url.searchParams.get('date') ?? dateKey();
    if (!validDate(date)) throw new HttpError(400, 'bad date');
    const p = playerFromCookie(req);
    json(res, 200, { date, ...leaderboard(date, p?.id) });
  }],

  ['GET', /^\/api\/rising$/, (_req, res) => {
    const pool = currentPool();
    json(res, 200, pool ?? { asOf: getMeta('rising_as_of'), repos: [] });
  }],

  ['GET', /^\/card\/(?<id>[\w-]+)\.png$/, (_req, res, params) => {
    const found = finishedRun(params.id);
    if (!found) throw new HttpError(404, 'no such run');
    const png = cardPng(params.id, found.summary);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=600', 'Content-Length': png.length });
    res.end(png);
  }],

  ['GET', /^\/r\/(?<id>[\w-]+)$/, (req, res, params) => {
    const found = finishedRun(params.id);
    if (!found) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Run not found · Last Commit Standing</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0A0C14;color:#ECEFF7;font-family:system-ui,sans-serif;text-align:center;padding:16px"><div><h1 style="font-size:22px">This run doesn't exist, or it isn't finished yet.</h1><p><a href="/?play=daily" style="color:#2EC4A6">Play today's course</a></p></div>`);
      return;
    }
    const html = sharePage(originOf(req), params.id, found.summary, found.rank);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(html);
  }],
];

function finishedRun(id: string) {
  const run = getRun(id);
  if (!run?.finished_at || !run.official) return null;
  const player = getPlayer(run.player_id)!;
  const { course } = courseForDate(run.date);
  const { rank } = rankOf(run);
  const { players } = leaderboard(run.date, undefined, 0);
  const line = rankLine(rank, players, streakAt(player.id, run.date));
  return { run, summary: summaryFor(course, run, player, line), rank };
}

function sharePage(origin: string, id: string, s: ReturnType<typeof summaryFor>, rank: number): string {
  const who = s.name ? `${s.name} (Player ${padPlayerNumber(s.playerNum)})` : `Player ${padPlayerNumber(s.playerNum)}`;
  const status = s.standing ? 'STILL STANDING' : 'ELIMINATED';
  const title = `${who} · ${status} · Last Commit Standing`;
  const desc = `Daily ${s.date}: ${formatScore(s.score)} pts, ${s.statLine}, rank #${rank}. ${s.standing ? 'Can you outlast them?' : s.outLine}.`;
  const img = `${origin}/card/${id}.png`;
  const e = escapeHtml;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Last Commit Standing">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(desc)}">
<meta property="og:image" content="${e(img)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${e(`${origin}/r/${id}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(title)}">
<meta name="twitter:description" content="${e(desc)}">
<meta name="twitter:image" content="${e(img)}">
<meta name="theme-color" content="#0A0C14">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,700&family=Bungee&family=JetBrains+Mono:wght@600&display=swap">
<style>
  *{box-sizing:border-box} body{margin:0;background:#0A0C14;color:#ECEFF7;font-family:'Bricolage Grotesque',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 16px}
  main{width:min(880px,100%);display:flex;flex-direction:column;gap:18px;align-items:center;text-align:center}
  .brand{font-family:Bungee,sans-serif;font-size:20px;color:#ECEFF7;text-decoration:none} .brand span{color:#FF3E8A}
  img{width:100%;height:auto;aspect-ratio:1200/630;border-radius:14px;border:1px solid #262C42;background:#0B0E19}
  p{color:#9AA3B8;margin:0;font-size:17px} .stats{font-family:'JetBrains Mono',monospace;color:#ECEFF7}
  .cta{display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:12px 26px;border-radius:12px;background:#FF3E8A;color:#12040a;font-weight:700;font-size:18px;text-decoration:none}
  .cta:hover{background:#ff5c9d} .cta:focus-visible{outline:3px solid #2EC4A6;outline-offset:3px}
</style></head>
<body><main>
<a class="brand" href="/">LAST COMMIT <span>STANDING</span></a>
<img src="${e(img)}" alt="${e(`${who}: ${status}. ${formatScore(s.score)} points, ${s.statLine}.`)}" width="1200" height="630">
<p class="stats">Daily ${e(s.date)} · ${e(formatScore(s.score))} pts · ${e(s.statLine)} · rank #${rank}</p>
<p>${e(s.standing ? 'Made it through the gate.' : s.outLine)}</p>
<a class="cta" href="/?play=daily"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>Play today's course</a>
<p style="font-size:14px">One course a day, the same for everyone. Your first run is the one that counts.</p>
</main></body></html>`;
}

/** Dispatches API/card/share routes; returns false when nothing matched. */
export async function handleRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://x');
  for (const [method, re, handler] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    if (req.method !== method && !(method === 'GET' && req.method === 'HEAD')) continue;
    try {
      await handler(req, res, m.groups ?? {}, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : 'error' });
    }
    return true;
  }
  if (url.pathname.startsWith('/api/')) {
    json(res, 404, { error: 'not found' });
    return true;
  }
  return false;
}
