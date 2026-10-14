import { describe, expect, it } from 'vitest';
import { choosePool, freshPool, type Lookup, type Pool, type RisingRepo } from '../scripts/rising-pool.ts';

const repo = (name: string, stars = 100): RisingRepo => ({ name, desc: '', lang: null, stars, forks: 0, issues: 0, created: '2026-10-01', pushed: '2026-10-10', license: null });
const names = Array.from({ length: 12 }, (_, i) => `o/r${i}`);
const saved: Pool = { id: 'rising', title: 'Rising this week', repos: [repo('old/a', 9), repo('old/b', 8), repo('old/c', 7)] };
const noWait = async () => {};
/** GitHub that answers some names, says others are gone, and errors on the rest. */
const github = (opts: { ok?: (n: string) => boolean; gone?: string[]; flaky?: Map<string, number> } = {}): Lookup => async (name) => {
  const left = opts.flaky?.get(name);
  if (left) { opts.flaky!.set(name, left - 1); throw new Error('HTTP 502'); }
  if (opts.gone?.includes(name)) return null;
  if (opts.ok && !opts.ok(name)) throw new Error('HTTP 403');
  return repo(name, Number(name.slice(3)));
};

describe('rising pool', () => {
  it('uses and saves a fresh pool when lookups work', async () => {
    const fresh = await freshPool(names, github(), noWait);
    const c = choosePool(names, fresh, saved);
    expect(c).toMatchObject({ save: true, warning: null });
    expect(c.pool!.repos.map((r) => r.name)[0]).toBe('o/r11'); // most stars first
  });
  it('keeps the saved pool when GitHub rate-limits every lookup', async () => {
    const fresh = await freshPool(names, github({ ok: () => false }), noWait);
    expect(fresh.repos).toHaveLength(0);
    const c = choosePool(names, fresh, saved);
    expect(c.pool!.repos).toEqual(saved.repos); // saving it changes nothing
    expect(c.warning).toMatch(/12 of 12 rising repos couldn't be looked up .*HTTP 403.*using the saved pool \(3 repos\)/);
  });
  it('falls back to the saved pool, plus what was found, when fewer than half come back', async () => {
    const fresh = await freshPool(names, github({ ok: (n) => Number(n.slice(3)) < 5 }), noWait); // 5 of 12
    const c = choosePool(names, fresh, saved);
    expect(c.pool!.repos.map((r) => r.name).sort()).toEqual([...names.slice(0, 5), ...saved.repos.map((r) => r.name)].sort());
    expect(c.save).toBe(true);
  });
  it('shows (and saves) a mostly complete pool when the saved one has nothing to fill the gap with', async () => {
    const fresh = await freshPool(names, github({ ok: (n) => n !== 'o/r3' }), noWait);
    const c = choosePool(names, fresh, saved);
    expect(c.save).toBe(true);
    expect(c.pool!.repos).toHaveLength(11);
    expect(c.warning).toMatch(/o\/r3 \(HTTP 403\)/);
  });
  it('fills failed lookups from the saved pool (a rate limit that resets halfway through)', async () => {
    const lastWeek: Pool = { id: 'rising', title: 'Rising this week', repos: names.map((n) => repo(n, 1)) };
    const fresh = await freshPool(names, github({ ok: (n) => Number(n.slice(3)) >= 5 }), noWait); // 7 of 12 come back
    const c = choosePool(names, fresh, lastWeek);
    expect(c).toMatchObject({ save: true });
    expect(c.pool!.repos.map((r) => r.name).sort()).toEqual([...names].sort());
    expect(c.warning).toMatch(/5 kept from the saved pool, showing 12/);
  });
  it('retries a lookup that fails for a moment', async () => {
    const waits: number[] = [];
    const fresh = await freshPool(names, github({ flaky: new Map([['o/r1', 2]]) }), async (ms) => { waits.push(ms); });
    expect(fresh.repos).toHaveLength(12);
    expect(waits).toEqual([2000, 4000]);
  });
  it('leaves out a repo that is gone, without counting it as a failure', async () => {
    const fresh = await freshPool(names, github({ gone: ['o/r7'] }), noWait);
    expect(fresh).toMatchObject({ failed: [], gone: ['o/r7'] });
    expect(choosePool(names, fresh, saved)).toMatchObject({ save: true, warning: expect.stringMatching(/left out 1 rising repo\(s\) no longer on GitHub \(1 gone from GitHub: o\/r7\)/) });
  });
  it('keeps the saved pool when the rising table is empty', async () => {
    expect(choosePool([], await freshPool([], github(), noWait), saved)).toMatchObject({ pool: { repos: saved.repos }, warning: expect.stringMatching(/rising table is empty/) });
  });
  it('without a saved pool, shows and saves whatever came back; with nothing at all, changes nothing', async () => {
    const fresh = await freshPool(names, github({ ok: (n) => n === 'o/r1' }), noWait);
    expect(choosePool(names, fresh, null)).toMatchObject({ save: true, pool: { repos: [{ name: 'o/r1' }] } });
    expect(choosePool(names, { repos: [], failed: names.map((n) => `${n} (HTTP 403)`), gone: [] }, null)).toMatchObject({ pool: null, save: false });
  });
  const lastWeek: Pool = { id: 'rising', title: 'Rising this week', repos: names.map((n) => repo(n, 1)) };
  it('drops repos that are gone, even when most of the pool is gone', async () => {
    const gone = names.slice(0, 7); // seven deleted, five found
    const fresh = await freshPool(names, github({ gone }), noWait);
    const c = choosePool(names, fresh, lastWeek);
    expect(c.save).toBe(true); // every name was answered: this is the truth
    expect(c.pool!.repos.map((r) => r.name).sort()).toEqual(names.slice(7).sort());
    expect(c.warning).toMatch(/left out 7 rising repo\(s\) no longer on GitHub/);
  });
  it('never brings a gone repo back from the saved pool when other lookups fail', async () => {
    const gone = names.slice(0, 4), down = (n: string) => !names.slice(4, 10).includes(n); // 4 gone, 6 errors, 2 found
    const fresh = await freshPool(names, github({ gone, ok: down }), noWait);
    const c = choosePool(names, fresh, lastWeek);
    expect(c.save).toBe(true);
    const shown = c.pool!.repos.map((r) => r.name);
    expect(shown.some((n) => gone.includes(n))).toBe(false);
    expect(shown.sort()).toEqual(names.slice(4).sort()); // 2 found + 6 filled from the saved pool
  });
  it('falls back to the saved pool without the gone repos when too few come back', async () => {
    // last week's pool shares only the two repos that are now gone; every other lookup fails
    const older: Pool = { id: 'rising', title: 'Rising this week', repos: [repo('o/r0', 9), repo('o/r1', 8), repo('old/x', 7), repo('old/y', 6), repo('old/z', 5)] };
    const fresh = await freshPool(names, github({ gone: ['o/r0', 'o/r1'], ok: () => false }), noWait);
    const c = choosePool(names, fresh, older);
    expect(c.save).toBe(true);
    expect(c.pool!.repos.map((r) => r.name)).toEqual(['old/x', 'old/y', 'old/z']);
    expect(c.warning).toMatch(/using the saved pool without the ones that are gone \(3 repos\)/);
  });
  it('a cached build after a partial refresh shows the same pool, without the deleted repos', async () => {
    // build 1 (weekly, with the database): 4 deleted, 6 errors, 2 found
    const gone = names.slice(0, 4), down = (n: string) => !names.slice(4, 10).includes(n);
    const c = choosePool(names, await freshPool(names, github({ gone, ok: down }), noWait), lastWeek);
    const savedAfter = c.save ? c.pool! : lastWeek; // what build-safari-page.ts writes to rising.json
    // build 2 (push deploy, no database): it uses the saved file as is
    expect(savedAfter.repos.map((r) => r.name).sort()).toEqual(c.pool!.repos.map((r) => r.name).sort());
    expect(savedAfter.repos.some((r) => gone.includes(r.name))).toBe(false);
    expect(savedAfter.repos).toHaveLength(8);
  });
  /** A weekly build with the database, then a push deploy without it: returns what each one shows. */
  async function twoBuilds(weekNames: string[], lookup: Lookup, savedBefore: Pool | null) {
    const c = choosePool(weekNames, await freshPool(weekNames, lookup, noWait), savedBefore);
    const savedAfter = c.save ? c.pool : savedBefore; // what build-safari-page.ts leaves in rising.json
    return { first: c.pool?.repos.map((r) => r.name) ?? [], second: savedAfter?.repos.map((r) => r.name) ?? [] };
  }
  it('keeps a deletion when only one repo survives (A deleted, B fails)', async () => {
    const ab: Pool = { id: 'rising', title: 'Rising this week', repos: [repo('o/a', 2), repo('o/b', 1)] };
    const week = ['o/a', 'o/b', ...names];
    const r = await twoBuilds(week, github({ gone: ['o/a'], ok: () => false }), ab);
    expect(r.first).toEqual(['o/b']);
    expect(r.second).toEqual(['o/b']);
  });
  it('keeps the deletions when every saved repo is gone and the rest fail', async () => {
    const ab: Pool = { id: 'rising', title: 'Rising this week', repos: [repo('o/a', 2), repo('o/b', 1)] };
    const week = ['o/a', 'o/b', ...names];
    const r = await twoBuilds(week, github({ gone: ['o/a', 'o/b'], ok: () => false }), ab);
    expect(r.first).toEqual([]);
    expect(r.second).toEqual([]);
  });
  it('shows the same pool in the next cached build in every case above', async () => {
    const ab: Pool = { id: 'rising', title: 'Rising this week', repos: [repo('o/a', 2), repo('o/b', 1)] };
    const cases: [string[], Lookup, Pool | null][] = [
      [names, github(), lastWeek], [names, github({ ok: () => false }), lastWeek], [names, github({ gone: names.slice(0, 7) }), lastWeek],
      [names, github({ gone: names.slice(0, 4), ok: (n) => !names.slice(4, 10).includes(n) }), lastWeek], [['o/a', 'o/b'], github({ gone: ['o/a'], ok: () => false }), ab],
      [['o/a', 'o/b'], github({ gone: ['o/a', 'o/b'] }), ab], [names, github({ ok: (n) => n === 'o/r1' }), null],
    ];
    for (const [w, l, sv] of cases) { const r = await twoBuilds(w, l, sv); expect(r.second.sort()).toEqual(r.first.sort()); }
  });
});
