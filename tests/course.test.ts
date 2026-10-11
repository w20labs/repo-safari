import { describe, expect, it } from 'vitest';
import { COURSE, PHYS } from '../shared/constants.ts';
import {
  arenaCourse,
  buildCourse,
  dailyCourse,
  heightMult,
  platformBaseY,
  practiceCourse,
  worldWidth,
  type Course,
  type Platform,
} from '../shared/course.ts';
import { CLASSIC } from '../shared/data/classic.ts';
import { mulberry32, rngFrom } from '../shared/rng.ts';
import type { RisingPool } from '../shared/types.ts';

const POOL: RisingPool = {
  asOf: '2026-10-05',
  repos: Array.from({ length: 11 }, (_, i) => ({ name: `owner${i}/proj${i}`, desc: `A tool number ${i}`, lang: i % 3 ? 'Rust' : null, stars: 800 + i * 3000 })),
};

const { gravity: g, jumpV, doubleJumpMul, maxRun } = PHYS;
const SINGLE_HEIGHT = (jumpV * jumpV) / (2 * g);
const DOUBLE_HEIGHT = SINGLE_HEIGHT + (jumpV * doubleJumpMul) ** 2 / (2 * g);

/**
 * Farthest horizontal distance (at full run speed) at which a target `rise` units higher can be
 * landed on: the better of a single jump or a jump plus a second jump at the apex. Negative rise = drop.
 */
function reachAtRise(rise: number): number {
  if (rise > DOUBLE_HEIGHT) return -Infinity;
  const v2 = jumpV * doubleJumpMul;
  const r = rise - SINGLE_HEIGHT;
  const double = maxRun * (jumpV / g + (v2 + Math.sqrt(v2 * v2 - 2 * g * r)) / g);
  if (rise > SINGLE_HEIGHT) return double;
  const single = maxRun * ((jumpV + Math.sqrt(jumpV * jumpV - 2 * g * rise)) / g);
  return Math.max(single, double);
}

interface Span { left: number; right: number; top: number; }

/** Worst-case extents of a platform over its motion. */
function extents(p: Platform): { best: Span; worst: Span } {
  const ax = p.move?.axis === 'x' ? p.move.amp : 0;
  const ay = p.move?.axis === 'y' ? p.move.amp : 0;
  return {
    best: { left: p.cx - p.w / 2 - ax, right: p.cx + p.w / 2 + ax, top: p.baseY - ay },
    worst: { left: p.cx - p.w / 2 + ax, right: p.cx + p.w / 2 - ax, top: p.baseY + ay },
  };
}

/**
 * Every hop (start pad -> p0 -> ... -> pN -> end pad) must be reachable with a 20% margin, even when
 * the platform you stand on is at its lowest and farthest point and the next one at its highest and farthest.
 */
function assertReachable(c: Course) {
  const startPad: Span = { left: 0, right: COURSE.startPadEnd, top: PHYS.floorY };
  const endPad: Span = { left: c.W - COURSE.endPadWidth, right: c.W, top: PHYS.floorY };
  const spans: (Span | Platform)[] = [startPad, ...c.platforms, endPad];
  for (let k = 0; k < spans.length - 1; k++) {
    const a = spans[k];
    const b = spans[k + 1];
    const from = 'repo' in a ? extents(a).worst : a;
    const to = 'repo' in b ? { ...extents(b).worst, top: extents(b).best.top } : b;
    const rise = from.top - to.top;
    const gap = Math.max(0, to.left - from.right);
    expect(rise, `hop ${k} rise`).toBeLessThanOrEqual(DOUBLE_HEIGHT * 0.85);
    expect(gap, `hop ${k} gap`).toBeLessThanOrEqual(reachAtRise(rise) * 0.8);
  }
}

describe('course layout', () => {
  it('matches the spec formulas', () => {
    expect(worldWidth(12)).toBe(380 + 12 * 220 + 520);
    expect(platformBaseY(0)).toBe(1180);
    expect(heightMult(1180)).toBe(1);
    const c = buildCourse(CLASSIC.slice(0, 12), mulberry32(1), { solo: true, unlock: 8 });
    expect(c.platforms[3].gold).toBe(true);
    expect(c.platforms[3].w).toBe(100);
    expect(c.platforms[3].move).not.toBeNull();
    expect(c.platforms[1].move?.axis).toBe('y');
    expect(c.platforms[1].move?.amp).toBe(42);
    expect(c.platforms[8].move?.axis).toBe('x');
    for (const p of c.platforms) {
      expect(p.cx).toBe(380 + p.i * 220);
      if (p.move) {
        expect(p.move.period).toBeGreaterThanOrEqual(2.6);
        expect(p.move.period).toBeLessThanOrEqual(3.6);
      }
      expect(p.mult).toBe(p.gold ? Math.round(heightMult(p.baseY) * 20) / 10 : heightMult(p.baseY));
    }
  });

  it('max rise between consecutive platforms stays under a single jump', () => {
    let maxRise = 0;
    for (let i = 1; i < 60; i++) maxRise = Math.max(maxRise, platformBaseY(i - 1) - platformBaseY(i));
    expect(maxRise).toBeLessThanOrEqual(190);
    expect(Math.round(SINGLE_HEIGHT)).toBe(208);
    expect(Math.round(DOUBLE_HEIGHT)).toBe(377);
  });

  it('every daily course is reachable', () => {
    for (let d = 0; d < 400; d++) {
      const date = new Date(Date.UTC(2026, 0, 1) + d * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      assertReachable(dailyCourse(date, d % 2 ? POOL : null));
    }
  });

  it('every practice and arena course is reachable', () => {
    for (let s = 0; s < 200; s++) {
      assertReachable(practiceCourse(mulberry32(s), s % 2 ? POOL : null));
      assertReachable(arenaCourse(s * 7919));
    }
  });

  it('every course size up to 40 is reachable', () => {
    const many = [...CLASSIC, ...CLASSIC];
    for (let n = 1; n <= 40; n++) assertReachable(buildCourse(many.slice(0, n), rngFrom(`n${n}`), { solo: true, unlock: null }));
  });

  it('daily course is the same for everyone on a date and has 12 platforms', () => {
    const a = dailyCourse('20261010', POOL);
    const b = dailyCourse('20261010', POOL);
    expect(a.platforms.map((p) => p.repo.id)).toEqual(b.platforms.map((p) => p.repo.id));
    expect(a.platforms.map((p) => p.move?.phase)).toEqual(b.platforms.map((p) => p.move?.phase));
    expect(a.platforms).toHaveLength(12);
    expect(a.platforms.filter((p) => p.repo.rising)).toHaveLength(2);
    expect(dailyCourse('20261010', null).platforms.filter((p) => p.repo.rising)).toHaveLength(0);
    expect(dailyCourse('20261011', POOL).platforms.map((p) => p.repo.id)).not.toEqual(a.platforms.map((p) => p.repo.id));
  });

  it('arena courses are static with no gate', () => {
    const c = arenaCourse(123);
    expect(c.platforms).toHaveLength(14);
    expect(c.unlock).toBeNull();
    expect(c.platforms.every((p) => !p.move && !p.gold)).toBe(true);
  });
});
