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
  it('keeps the saved pool, unsaved, when GitHub rate-limits every lookup', async () => {
    const fresh = await freshPool(names, github({ ok: () => false }), noWait);
    expect(fresh.repos).toHaveLength(0);
    const c = choosePool(names, fresh, saved);
    expect(c.pool).toBe(saved);
    expect(c.save).toBe(false);
    expect(c.warning).toMatch(/12 of 12 rising repos couldn't be looked up .*HTTP 403.*keeping the saved pool \(3 repos\)/);
  });
  it('keeps the saved pool when fewer than half come back', async () => {
    const fresh = await freshPool(names, github({ ok: (n) => Number(n.slice(3)) < 5 }), noWait);
    expect(choosePool(names, fresh, saved)).toMatchObject({ pool: saved, save: false });
  });
  it('shows a mostly complete pool but never saves one with gaps', async () => {
    const fresh = await freshPool(names, github({ ok: (n) => n !== 'o/r3' }), noWait);
    const c = choosePool(names, fresh, saved);
    expect(c.save).toBe(false);
    expect(c.pool!.repos).toHaveLength(11);
    expect(c.warning).toMatch(/o\/r3 \(HTTP 403\)/);
  });
  it('fills failed lookups from the saved pool (a rate limit that resets halfway through)', async () => {
    const lastWeek: Pool = { id: 'rising', title: 'Rising this week', repos: names.map((n) => repo(n, 1)) };
    const fresh = await freshPool(names, github({ ok: (n) => Number(n.slice(3)) >= 5 }), noWait); // 7 of 12 come back
    const c = choosePool(names, fresh, lastWeek);
    expect(c).toMatchObject({ save: false });
    expect(c.pool!.repos.map((r) => r.name).sort()).toEqual([...names].sort());
    expect(c.warning).toMatch(/5 filled in from the saved pool, showing 12/);
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
    expect(choosePool(names, fresh, saved)).toMatchObject({ save: true, warning: null });
  });
  it('keeps the saved pool when the rising table is empty', async () => {
    expect(choosePool([], await freshPool([], github(), noWait), saved)).toMatchObject({ pool: saved, save: false, warning: expect.stringMatching(/rising table is empty/) });
  });
  it('without a saved pool, shows whatever came back but saves nothing', async () => {
    const fresh = await freshPool(names, github({ ok: (n) => n === 'o/r1' }), noWait);
    expect(choosePool(names, fresh, null)).toMatchObject({ save: false, pool: { repos: [{ name: 'o/r1' }] } });
    expect(choosePool(names, { repos: [], failed: [] }, null).pool).toBeNull();
  });
});
