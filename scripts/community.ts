/**
 * Community activity: how many pull requests from people outside a project's core team were merged recently.
 * "Outside" means the PR author's association with the repo is CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, FIRST_TIMER or
 * NONE: not the owner, an org member or a collaborator. Bots (Dependabot, Renovate…) don't count.
 *
 * A lone maintainer pushing commits keeps a repo "active"; merged outside PRs show a project other people
 * contribute to. Read with GitHub's GraphQL API: each repo's merged PRs, most recently updated first, a few repos per
 * request. (Not GitHub search, which throttles hard after ~30 searches a minute.)
 */
export const COMMUNITY_DAYS = 90;
/** Busy projects: count at most this many merged PRs per repo, then say "N+". */
const MAX_PAGES = 3;
const PER_REQUEST = 8;

const OUTSIDE = new Set(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE']);
const BOT = /\[bot\]$|-bot$|^(dependabot|renovate|greenkeeper|snyk|github-actions|allcontributors|imgbot|pre-commit-ci)\b/i;

export type PrNode = { authorAssociation?: string; author: { __typename?: string; login: string } | null };
/** A merged PR from someone outside the core team, and not a bot. */
export function isOutside(n: PrNode): boolean {
  return !!n.author && OUTSIDE.has(n.authorAssociation ?? '') && n.author.__typename !== 'Bot' && !BOT.test(n.author.login);
}

export type Community = { outsidePrs: number; capped: boolean };
type PrPage = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (PrNode & { mergedAt: string; updatedAt: string })[] };
type RepoResult = { pullRequests: PrPage } | null;
type GraphqlError = { message: string; path?: (string | number)[] };
/** A GraphQL response body. `data` and `errors` can both be present: a nested field can fail while its repo stays. */
export type GraphqlBody = { data?: Record<string, RepoResult> | null; errors?: GraphqlError[] };
type Fetch = (query: string) => Promise<GraphqlBody>;

/**
 * The repos in a response we can trust. A repo touched by any error (its alias is the error path's first segment)
 * is dropped, so a failed author lookup can't turn into an exact but wrong count. An error we can't tie to one repo
 * discards the whole response.
 */
export function usableData(body: GraphqlBody): Record<string, RepoResult> {
  const errors = body.errors ?? [];
  if (!body.data) throw new Error(`GitHub GraphQL: ${errors.map((e) => e.message).join('; ') || 'no data'}`);
  const data = { ...body.data };
  for (const e of errors) {
    const alias = e.path?.[0];
    if (typeof alias !== 'string' || !(alias in data)) throw new Error(`GitHub GraphQL: ${e.message}`);
    data[alias] = null;
  }
  return data;
}

const prsField = (alias: string, repo: string, after: string | null) => {
  const [owner, name] = repo.split('/');
  return `${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequests(states: MERGED, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }${after ? `, after: ${JSON.stringify(after)}` : ''}) { pageInfo { hasNextPage endCursor } nodes { mergedAt updatedAt authorAssociation author { __typename login } } } }`;
};
/** Outside PRs on one page merged since `since`, and whether older pages could still hold some. */
function tally(page: PrPage, since: string) {
  const count = page.nodes.filter((n) => n.mergedAt >= since && isOutside(n)).length;
  // pages are sorted by last update; once a page reaches PRs last touched before `since`, none further were merged after it
  const more = page.pageInfo.hasNextPage && !!page.pageInfo.endCursor && page.nodes.length > 0 && page.nodes[page.nodes.length - 1].updatedAt >= since;
  return { count, more };
}

/** GraphQL over fetch, with a short pause between calls and a retry when GitHub asks us to slow down. */
export function githubGraphql(token: string): Fetch {
  return async (query) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise((r) => setTimeout(r, attempt ? 2 ** attempt * 5000 : 300));
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'repo-safari-community' },
        body: JSON.stringify({ query: `{ ${query} }` }),
      });
      if (res.status === 403 || res.status === 429 || res.status >= 500) continue;
      const json = (await res.json()) as GraphqlBody;
      if (json.data) return json; // may carry errors too: usableData sorts them out
      throw new Error(`GitHub GraphQL: ${json.errors?.map((e) => e.message).join('; ') ?? res.status}`);
    }
    throw new Error('GitHub GraphQL: rate limited');
  };
}

/**
 * Outside PRs merged in the last COMMUNITY_DAYS, per repo. A repo whose lookup fails is left out of the map,
 * so the page shows nothing for it rather than a wrong number. `capped` means counting stopped early: the count is
 * a lower bound, and a capped 0 means none were found in what was scanned, not that there are none.
 */
export async function countOutsidePrs(repos: string[], asOf: Date, query: Fetch): Promise<Map<string, Community>> {
  const since = new Date(asOf.getTime() - COMMUNITY_DAYS * 864e5).toISOString();
  const out = new Map<string, Community>();
  const unique = [...new Set(repos)];
  const more: { repo: string; after: string; count: number; pages: number }[] = [];
  for (let i = 0; i < unique.length; i += PER_REQUEST) {
    const batch = unique.slice(i, i + PER_REQUEST);
    let data: Record<string, RepoResult>;
    try { data = usableData(await query(batch.map((r, j) => prsField(`r${j}`, r, null)).join('\n'))); } catch (e) { console.warn(`  community: ${(e as Error).message}`); continue; }
    batch.forEach((repo, j) => {
      const page = data[`r${j}`]?.pullRequests;
      if (!page) return;
      const t = tally(page, since);
      if (t.more) more.push({ repo, after: page.pageInfo.endCursor!, count: t.count, pages: 1 });
      else out.set(repo, { outsidePrs: t.count, capped: false });
    });
  }
  // busy projects: a few more pages each, then report what we counted as "N+"
  for (const m of more) {
    let { after, count, pages } = m, capped = true;
    try {
      while (pages < MAX_PAGES) {
        const page = usableData(await query(prsField('r0', m.repo, after)))['r0']?.pullRequests;
        if (!page) throw new Error('no result');
        const t = tally(page, since);
        count += t.count; pages++;
        if (!t.more) { capped = false; break; }
        after = page.pageInfo.endCursor!;
      }
      out.set(m.repo, { outsidePrs: count, capped });
    } catch (e) { console.warn(`  community: ${m.repo}: ${(e as Error).message}`); }
  }
  return out;
}
