/**
 * This week's rising pool for the page: each name from the rising table, looked up on GitHub.
 *
 * A lookup can fail for reasons that say nothing about the repo (rate limit, outage, network). Those are retried, and
 * if too few repos come back, the last saved pool is kept rather than replaced: a bad API day must not empty the
 * Rising room, or save an empty pool that later deploys would keep using. A repo that's gone (404) is just left out.
 */
export type RisingRepo = { name: string; desc: string; lang: string | null; stars: number; forks: number; issues: number; created: string; pushed: string; license: string | null };
export type Pool = { id: 'rising'; title: string; repos: RisingRepo[] };
/** A repo, null when GitHub says it's gone, or a thrown error for anything else. */
export type Lookup = (name: string) => Promise<RisingRepo | null>;

/** Below this share of the names, a fresh pool is not trusted. */
export const MIN_SHARE = 0.5;
const TRIES = 3;

export async function freshPool(names: string[], lookup: Lookup, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const repos: RisingRepo[] = [], failed: string[] = [], gone: string[] = [];
  for (const name of names) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await lookup(name);
        if (r) repos.push(r); else gone.push(name);
        break;
      } catch (e) {
        if (attempt >= TRIES) { failed.push(`${name} (${(e as Error).message})`); break; }
        await wait(2000 * attempt);
      }
    }
  }
  repos.sort((a, b) => b.stars - a.stars);
  return { repos, failed, gone };
}

/**
 * Which pool the page shows, and whether it replaces the saved copy. A complete lookup (every name found or confirmed
 * gone) is the truth: shown and saved. When some lookups fail, those repos come from the saved pool where it has them;
 * if that still leaves too few, the saved pool is used. Repos GitHub confirmed are gone never come back from it.
 */
export function choosePool(names: string[], fresh: { repos: RisingRepo[]; failed: string[]; gone: string[] }, saved: Pool | null): { pool: Pool | null; save: boolean; warning: string | null } {
  const pool = (repos: RisingRepo[]): Pool => ({ id: 'rising', title: 'Rising this week', repos: [...repos].sort((a, b) => b.stars - a.stars) });
  const gone = new Set(fresh.gone), live = names.filter((n) => !gone.has(n));
  const still = saved ? saved.repos.filter((r) => !gone.has(r.name)) : [];
  const goneNote = gone.size ? ` (${gone.size} gone from GitHub: ${[...gone].slice(0, 3).join(', ')}${gone.size > 3 ? ', …' : ''})` : '';
  if (names.length && !fresh.failed.length && fresh.repos.length + gone.size === names.length) return { pool: pool(fresh.repos), save: true, warning: gone.size ? `left out ${gone.size} rising repo(s) no longer on GitHub${goneNote}` : null };
  const enough = (n: number) => live.length > 0 && n >= Math.max(2, Math.ceil(live.length * MIN_SHARE));
  const failedNames = new Set(fresh.failed.map((f) => f.split(' ')[0]));
  const filled = still.filter((r) => failedNames.has(r.name));
  const merged = [...fresh.repos, ...filled];
  const why = !names.length ? 'the rising table is empty'
    : `${fresh.failed.length} of ${names.length} rising repos couldn't be looked up (${fresh.failed.slice(0, 3).join(', ')}${fresh.failed.length > 3 ? ', …' : ''})${goneNote}`;
  if (enough(merged.length)) return { pool: pool(merged), save: false, warning: `${why}; ${filled.length ? `${filled.length} filled in from the saved pool, ` : ''}showing ${merged.length} and keeping the saved copy as it is` };
  if (still.length >= 2) return { pool: pool(still), save: false, warning: `${why}; using the saved pool (${still.length} repos${still.length < (saved?.repos.length ?? 0) ? ', without the ones that are gone' : ''})` };
  return { pool: merged.length ? pool(merged) : null, save: false, warning: `${why}, and there's no saved pool to fall back on` };
}

/** GitHub's repo API as a Lookup. */
export function githubLookup(headers: Record<string, string>): Lookup {
  return async (name) => {
    const res = await fetch(`https://api.github.com/repos/${name}`, { headers });
    if (res.status === 404 || res.status === 451) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return {
      name: j.full_name, desc: j.description ?? '', lang: j.language, stars: j.stargazers_count, forks: j.forks_count, issues: j.open_issues_count,
      created: j.created_at.slice(0, 10), pushed: j.pushed_at.slice(0, 10), license: j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : null,
    };
  };
}
