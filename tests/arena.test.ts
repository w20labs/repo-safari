import { describe, expect, it } from 'vitest';
import { ARENA, arenaEndsAt, arenaPhase, bellAt, crumblePlan, makeRoomCode, platformStates } from '../shared/arena.ts';
import { mulberry32 } from '../shared/rng.ts';

const t0 = 1_000_000;

describe('arena timing', () => {
  it('rings bell k at t0 + 9 s + k * 20 s', () => {
    expect(bellAt(t0, 0)).toBe(t0 + 9000);
    expect(bellAt(t0, 5)).toBe(t0 + 109000);
    expect(arenaEndsAt(t0)).toBe(t0 + 119000);
  });

  it('walks through the phases', () => {
    expect(arenaPhase(t0, t0 - 4000)).toEqual({ kind: 'countdown', msLeft: 4000 });
    expect(arenaPhase(t0, t0 + 1000)).toEqual({ kind: 'roam', bell: 0, msLeft: 8000 });
    expect(arenaPhase(t0, t0 + 9000)).toEqual({ kind: 'question', bell: 0, msLeft: 10000 });
    expect(arenaPhase(t0, t0 + 19000)).toEqual({ kind: 'roam', bell: 1, msLeft: 10000 });
    expect(arenaPhase(t0, t0 + 118999)).toMatchObject({ kind: 'question', bell: 5 });
    expect(arenaPhase(t0, t0 + 119000)).toEqual({ kind: 'over' });
  });

  it('crumbles two distinct standing platforms per round, deterministically', () => {
    const plan = crumblePlan(77);
    expect(plan).toEqual(crumblePlan(77));
    expect(plan).toHaveLength(ARENA.bells - 1);
    const all = plan.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(plan.every((r) => r.length === 2)).toBe(true);
  });

  it('reports crumbling then gone', () => {
    const [first] = crumblePlan(77);
    const crumbling = platformStates(77, t0, t0 + 19500);
    expect([...crumbling.crumbling].sort()).toEqual(first);
    expect(crumbling.gone.size).toBe(0);
    const gone = platformStates(77, t0, t0 + 21500);
    expect([...gone.gone].sort()).toEqual(first);
  });

  it('makes 4-character codes from the safe alphabet', () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 200; i++) expect(makeRoomCode(rng)).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
  });
});
