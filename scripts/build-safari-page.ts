/**
 * Builds the Repo Safari page from the template, the automatic rooms (shared/data/rooms.json)
 * and this week's rising pool (data/lcs.db, filled by `npm run refresh-rising`; saved to
 * shared/data/rising.json so builds without the database use the same pool).
 *
 *   GITHUB_TOKEN=$(gh auth token) npm run build-safari -- [share-url]
 *       -> prototypes/repo-safari.html (page body only, for publishing as a claude.ai artifact)
 *   GITHUB_TOKEN=... npm run build-safari -- https://w20labs.github.io/repo-safari/ --site _site
 *       -> _site/index.html (a complete document with link-preview tags, for GitHub Pages) and _site/repos.json
 *
 * Idea Shower: set IDEAS_URL to the Worker's address (e.g. https://repo-safari-ideas.<account>.workers.dev),
 * or to "mock" for canned ideas while developing. Unset, the page has no Idea Shower at all.
 * Idea board: BOARD_ENABLED=1 (with a Worker URL in IDEAS_URL and --site) adds board.js/board.css. Unset or "0", the
 * page has no board at all. Turn it on together with the Worker's own BOARD_ENABLED (docs/idea-board.md).
 */
import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countOutsidePrs, githubGraphql } from './community.ts';
import { choosePool, freshPool, githubLookup, type Pool } from './rising-pool.ts';

const token = process.env.GITHUB_TOKEN;
const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'repo-safari-page', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const args = process.argv.slice(2);
const siteDir = args.includes('--site') ? args[args.indexOf('--site') + 1] : null;
const shareUrl = (args.find((a) => /^https?:\/\//.test(a)) ?? '').replace(/[^a-zA-Z0-9:/._-]/g, '');
const ideasUrl = (process.env.IDEAS_URL ?? '').trim().replace(/\/+$/, '');
if (ideasUrl && ideasUrl !== 'mock' && !/^https?:\/\/[a-zA-Z0-9.:-]+$/.test(ideasUrl)) throw new Error(`IDEAS_URL must be an origin like https://name.workers.dev, or "mock" (got ${ideasUrl})`);
const board = (process.env.BOARD_ENABLED ?? '').trim() === '1';
if (board && (!/^https?:\/\//.test(ideasUrl) || !siteDir)) throw new Error('BOARD_ENABLED=1 needs IDEAS_URL set to the Worker (not "mock") and --site: the board talks to the Worker and ships board.js beside the page');

const rooms = JSON.parse(readFileSync('shared/data/rooms.json', 'utf8'));
const RISING_JSON = 'shared/data/rising.json';
/** Anonymous, cookie-free visit counts for the published site (dashboard: repo-safari.goatcounter.com). */
const GOATCOUNTER = 'https://repo-safari.goatcounter.com/count';

const saved: Pool | null = existsSync(RISING_JSON) ? JSON.parse(readFileSync(RISING_JSON, 'utf8')) : null;
let rising: Pool | null = null;
let names: string[] | null = null;
try {
  const db = new Database(process.env.DB_PATH ?? 'data/lcs.db', { readonly: true, fileMustExist: true });
  names = (db.prepare('SELECT name FROM rising ORDER BY rank').all() as { name: string }[]).map((r) => r.name);
} catch (e) {
  // no database (a push deploy, or a fresh checkout): the saved pool is the pool
  rising = saved;
  if (saved) console.log(`Using the saved rising pool from ${RISING_JSON}.`);
  else console.warn(`No rising pool (${(e as Error).message}); the page will skip the rising room. Run npm run refresh-rising first.`);
}
if (names) {
  const fresh = await freshPool(names, githubLookup(headers));
  if (token) {
    const community = await countOutsidePrs(fresh.repos.map((r) => r.name), new Date(), githubGraphql(token));
    for (const r of fresh.repos) { const c = community.get(r.name); if (c) Object.assign(r, { outsidePrs: c.outsidePrs, ...(c.capped ? { outsideCapped: true } : {}) }); }
  }
  const choice = choosePool(names, fresh, saved);
  rising = choice.pool;
  if (choice.warning) console.warn(process.env.GITHUB_ACTIONS ? `::warning title=Rising pool::${choice.warning}` : `Warning: ${choice.warning}`);
  // keep a copy in the repo so builds without the database (CI on push) use the same pool; never a pool we didn't trust
  if (choice.save && rising) writeFileSync(RISING_JSON, `${JSON.stringify(rising, null, 1)}\n`);
}

/** JSON that is safe inside <script>: no "</script>", "<!--" or line separators can break out. */
const scriptJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// replacer functions, so "$&" or "$'" inside the data is never treated as a replacement pattern
const page = readFileSync('prototypes/repo-safari.template.html', 'utf8')
  .replace('__ROOMS__', () => scriptJson(rooms))
  .replace('__RISING__', () => scriptJson(rising))
  .replace('__SHARE_URL__', () => shareUrl)
  .replace('__IDEAS_URL__', () => ideasUrl)
  .replace('__BOARD__', () => (board ? '1' : ''));

if (!siteDir) {
  writeFileSync('prototypes/repo-safari.html', page);
  console.log(`Wrote prototypes/repo-safari.html: ${rooms.rooms.length} rooms, ${rising?.repos.length ?? 0} rising repos, ${(page.length / 1024).toFixed(0)} KB`);
} else {
  // the template starts with <title>, font links and <style>; those belong in <head>
  const split = page.indexOf('<div class="wrap">');
  const head = page.slice(0, split);
  const body = page.slice(split);
  const desc = 'A new trail through open source every day. Drop into a category, compare its active repos as stickers, and collect the ones you like.';
  const ogImage = shareUrl ? new URL('og.png', shareUrl).href : '';
  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${desc}">
<meta name="theme-color" content="#0A0C14">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Repo Safari">
<meta property="og:title" content="Repo Safari: a new trail through open source every day">
<meta property="og:description" content="${desc}">
${shareUrl ? `<meta property="og:url" content="${shareUrl}">` : ''}
${ogImage ? `<meta property="og:image" content="${ogImage}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">` : ''}
<meta name="twitter:card" content="summary_large_image">
${shareUrl ? `<link rel="canonical" href="${shareUrl}">` : ''}
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
<script data-goatcounter="${GOATCOUNTER}" async src="https://gc.zgo.at/count.js"></script>
${head}
<style>html,body{margin:0}</style>
</head>
<body>
${body}
</body>
</html>
`;
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(siteDir, 'index.html'), doc);
  for (const f of ['favicon-32.png', 'apple-touch-icon.png']) copyFileSync(join('assets/branding', f), join(siteDir, f));
  if (existsSync('assets/og-safari.png')) copyFileSync('assets/og-safari.png', join(siteDir, 'og.png'));
  for (const f of ['board.js', 'board.css']) {
    if (board) copyFileSync(join('prototypes/board', f), join(siteDir, f));
    else if (existsSync(join(siteDir, f))) rmSync(join(siteDir, f)); // board off: nothing of it is published
  }
  // the Idea Shower Worker only accepts repos listed here, so it can't be used as a general AI proxy
  // room and stars let the idea board keep a snapshot of each source repo that outlives this week's trail
  type Listed = { name: string; desc: string; room: string; stars: number };
  const listed = new Map<string, Listed>();
  const add = (r: { name: string; desc?: string | null; stars: number }, room: string) => { if (!listed.has(r.name)) listed.set(r.name, { name: r.name, desc: r.desc ?? '', room, stars: r.stars }); };
  for (const room of rooms.rooms as { title: string; repos: { name: string; desc?: string; stars: number }[] }[]) for (const r of room.repos) add(r, room.title);
  for (const r of rising?.repos ?? []) add(r, 'Rising this week');
  writeFileSync(join(siteDir, 'repos.json'), JSON.stringify([...listed.values()]));
  console.log(`Wrote ${join(siteDir, 'index.html')}: ${rooms.rooms.length} rooms, ${rising?.repos.length ?? 0} rising repos, ${(doc.length / 1024).toFixed(0)} KB${ideasUrl ? `, Idea Shower: ${ideasUrl}` : ''}${board ? ', idea board: on' : ''}`);
}
