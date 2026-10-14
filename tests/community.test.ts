import { describe, expect, it } from 'vitest';
import { countOutsidePrs, isOutside, usableData, type PrNode } from '../scripts/community.ts';

const pr = (authorAssociation: string, login = 'someone', type = 'User'): PrNode => ({ authorAssociation, author: { __typename: type, login } });

describe('outside contributions', () => {
  it('counts contributors and first-timers, not the core team', () => {
    expect(['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE'].every((a) => isOutside(pr(a)))).toBe(true);
    expect(['OWNER', 'MEMBER', 'COLLABORATOR'].some((a) => isOutside(pr(a)))).toBe(false);
  });
  it("doesn't count bots or deleted accounts", () => {
    expect(isOutside(pr('CONTRIBUTOR', 'dependabot', 'Bot'))).toBe(false);
    expect(isOutside(pr('CONTRIBUTOR', 'renovate[bot]'))).toBe(false);
    expect(isOutside(pr('NONE', 'my-release-bot'))).toBe(false);
    expect(isOutside({ authorAssociation: 'CONTRIBUTOR', author: null })).toBe(false);
  });

  // a fake GitHub: each repo has merged PRs (newest first), served 100 per page
  type Merged = PrNode & { mergedAt: string; updatedAt: string };
  const merged = (n: PrNode, day = '2026-10-01'): Merged => ({ ...n, mergedAt: `${day}T00:00:00Z`, updatedAt: `${day}T00:00:00Z` });
  function fakeGithub(prs: Record<string, Merged[]>, fail: string[] = []) {
    const calls: string[] = [];
    const query = async (q: string) => {
      calls.push(q);
      const out: Record<string, unknown> = {};
      for (const m of q.matchAll(/(r\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequests\(states: MERGED, first: 100, orderBy: \{ field: UPDATED_AT, direction: DESC \}(?:, after: "(\d+)")?\)/g)) {
        const [, alias, owner, name, after] = m, repo = `${owner}/${name}`;
        if (fail.includes(repo)) { out[alias] = null; continue; }
        const all = prs[repo] ?? [], start = Number(after ?? 0), page = all.slice(start, start + 100), next = start + 100 < all.length;
        out[alias] = { pullRequests: { pageInfo: { hasNextPage: next, endCursor: next ? String(start + 100) : null }, nodes: page } };
      }
      return { data: out } as never;
    };
    return { query, calls };
  }

  it('counts per repo, a few repos per request, over the last 90 days', async () => {
    const gh = fakeGithub({ 'a/one': [merged(pr('CONTRIBUTOR')), merged(pr('OWNER')), merged(pr('FIRST_TIMER')), merged(pr('CONTRIBUTOR'), '2026-06-01')], 'b/two': [merged(pr('MEMBER'))] });
    const m = await countOutsidePrs(['a/one', 'b/two', 'a/one'], new Date('2026-10-13T00:00:00Z'), gh.query);
    expect(m.get('a/one')).toEqual({ outsidePrs: 2, capped: false }); // the June PR is older than 90 days
    expect(m.get('b/two')).toEqual({ outsidePrs: 0, capped: false });
    expect(gh.calls).toHaveLength(1);
  });
  it('pages through busy repos, then says "N+" past the limit', async () => {
    const busy = Array.from({ length: 250 }, (_, i) => merged(pr(i % 2 ? 'CONTRIBUTOR' : 'MEMBER')));
    const huge = Array.from({ length: 450 }, () => merged(pr('CONTRIBUTOR')));
    const m = await countOutsidePrs(['x/busy', 'x/huge'], new Date('2026-10-13T00:00:00Z'), fakeGithub({ 'x/busy': busy, 'x/huge': huge }).query);
    expect(m.get('x/busy')).toEqual({ outsidePrs: 125, capped: false });
    expect(m.get('x/huge')).toEqual({ outsidePrs: 300, capped: true });
  });
  it('stops paging once PRs are older than the window', async () => {
    const recent = Array.from({ length: 100 }, () => merged(pr('CONTRIBUTOR')));
    const old = Array.from({ length: 300 }, () => merged(pr('CONTRIBUTOR'), '2026-01-01'));
    const gh = fakeGithub({ 'x/mixed': [...recent, ...old] });
    const m = await countOutsidePrs(['x/mixed'], new Date('2026-10-13T00:00:00Z'), gh.query);
    expect(m.get('x/mixed')).toEqual({ outsidePrs: 100, capped: false });
    expect(gh.calls).toHaveLength(2); // the second page is all old, so it stops there
  });
  it('leaves a repo out when its lookup fails, rather than showing a wrong number', async () => {
    const m = await countOutsidePrs(['ok/repo', 'gone/repo'], new Date(), fakeGithub({ 'ok/repo': [merged(pr('CONTRIBUTOR'))] }, ['gone/repo']).query);
    expect(m.get('ok/repo')?.outsidePrs).toBe(1);
    expect(m.has('gone/repo')).toBe(false);
  });
  it('drops a repo whose nested fields failed, even though it came back with data', async () => {
    const page = (nodes: PrNode[]) => ({ pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: nodes.map((n) => merged(n)) } });
    // GitHub couldn't resolve one author: that PR comes back with author null, and the error names the path
    const query = async () => ({
      data: { r0: page([{ authorAssociation: 'CONTRIBUTOR', author: null }]), r1: page([pr('CONTRIBUTOR')]) },
      errors: [{ message: 'Something went wrong while resolving author', path: ['r0', 'pullRequests', 'nodes', 0, 'author'] }],
    }) as never;
    const m = await countOutsidePrs(['a/broken', 'b/fine'], new Date('2026-10-13T00:00:00Z'), query);
    expect(m.has('a/broken')).toBe(false); // not { outsidePrs: 0 }
    expect(m.get('b/fine')).toEqual({ outsidePrs: 1, capped: false });
  });
  it('discards a whole response when an error names no repo', () => {
    expect(() => usableData({ data: { r0: null }, errors: [{ message: 'timeout' }] })).toThrow('timeout');
    expect(() => usableData({ data: { r0: null }, errors: [{ message: 'odd', path: ['r9'] }] })).toThrow('odd');
    expect(() => usableData({ data: null, errors: [{ message: 'bad query' }] })).toThrow('bad query');
  });
});
