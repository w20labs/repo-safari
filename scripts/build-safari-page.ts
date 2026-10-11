/**
 * Builds the standalone Repo Safari playtest page from the template, the automatic rooms
 * (shared/data/rooms.json) and this week's rising pool (data/lcs.db, filled by refresh-rising).
 *
 *   GITHUB_TOKEN=$(gh auth token) npm run build-safari -- [share-url]
 */
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';

const token = process.env.GITHUB_TOKEN;
const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'repo-safari-page', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
const shareUrl = process.argv[2] ?? '';

const rooms = JSON.parse(readFileSync('shared/data/rooms.json', 'utf8'));

let rising: { id: string; title: string; repos: unknown[] } | null = null;
try {
  const db = new Database(process.env.DB_PATH ?? 'data/lcs.db', { readonly: true });
  const names = (db.prepare('SELECT name FROM rising ORDER BY rank').all() as { name: string }[]).map((r) => r.name);
  const repos = [];
  for (const name of names) {
    const res = await fetch(`https://api.github.com/repos/${name}`, { headers });
    if (!res.ok) continue;
    const j = await res.json();
    repos.push({
      name: j.full_name, desc: j.description ?? '', lang: j.language, stars: j.stargazers_count, forks: j.forks_count, issues: j.open_issues_count,
      created: j.created_at.slice(0, 10), pushed: j.pushed_at.slice(0, 10), license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : null,
    });
  }
  repos.sort((a, b) => b.stars - a.stars);
  rising = { id: 'rising', title: 'Rising this week', repos };
} catch (e) {
  console.warn(`No rising pool (${(e as Error).message}); the page will skip the rising room. Run npm run refresh-rising first.`);
}

/** JSON that is safe inside <script>: no "</script>", "<!--" or line separators can break out. */
const scriptJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
// replacer functions, so "$&" or "$'" inside the data is never treated as a replacement pattern
const html = readFileSync('prototypes/repo-safari.template.html', 'utf8')
  .replace('__ROOMS__', () => scriptJson(rooms))
  .replace('__RISING__', () => scriptJson(rising))
  .replace('__SHARE_URL__', () => shareUrl.replace(/[^a-zA-Z0-9:/._-]/g, ''));
writeFileSync('prototypes/repo-safari.html', html);
console.log(`Wrote prototypes/repo-safari.html: ${rooms.rooms.length} rooms, ${rising?.repos.length ?? 0} rising repos, ${(html.length / 1024).toFixed(0)} KB`);
