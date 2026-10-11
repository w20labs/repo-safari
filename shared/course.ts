import { GAME_POOL } from './data/catalog.ts';
import { COURSE, PHYS } from './constants.ts';
import { poolRepos } from './rising.ts';
import { mulberry32, rngFrom, shuffle, type Rng } from './rng.ts';
import type { Band, Repo, RisingPool } from './types.ts';

export interface Move {
  axis: 'x' | 'y';
  amp: number;
  period: number;
  phase: number;
}

export interface Platform {
  i: number;
  repo: Repo;
  /** center x at rest */
  cx: number;
  /** top y at rest */
  baseY: number;
  w: number;
  h: number;
  mult: number;
  gold: boolean;
  move: Move | null;
}

export interface Course {
  W: number;
  platforms: Platform[];
  /** platforms to clear before the gate opens; null = no gate */
  unlock: number | null;
}

const BAND_WIDTH: Record<Band, number> = { '200k+': 200, '100k+': 168, '50k+': 146, '20k+': 132, '<20k': 126, rising: 140 };
const GOLD_WIDTH = 100;

export const worldWidth = (n: number): number => COURSE.firstX + n * COURSE.stepX + COURSE.tail;

export const platformBaseY = (i: number): number =>
  Math.round(1180 - (Math.sin(i * 0.62 - Math.PI / 2) + 1) * 230 - (i % 3 === 2 ? 50 : 0));

export const heightMult = (baseY: number): number => Math.round((1 + (1180 - baseY) / 460) * 10) / 10;

export interface CourseOptions {
  /** solo modes get gold and moving platforms */
  solo: boolean;
  unlock: number | null;
}

/** Lays out one platform per repo. `rng` supplies moving-platform timing. */
export function buildCourse(repos: Repo[], rng: Rng, opts: CourseOptions): Course {
  const platforms = repos.map((repo, i): Platform => {
    const baseY = platformBaseY(i);
    const gold = opts.solo && i % 5 === 3;
    const moving = opts.solo && (gold || i % 4 === 1);
    const move: Move | null = moving
      ? {
          axis: i % 2 === 0 ? 'x' : 'y',
          amp: i % 2 === 0 ? 55 : 42,
          period: 2.6 + rng() * 1.0,
          phase: rng() * Math.PI * 2,
        }
      : null;
    const mult = heightMult(baseY);
    return {
      i,
      repo,
      cx: COURSE.firstX + i * COURSE.stepX,
      baseY,
      w: gold ? GOLD_WIDTH : BAND_WIDTH[repo.band],
      h: COURSE.platformH,
      mult: gold ? Math.round(mult * 2 * 10) / 10 : mult,
      gold,
      move,
    };
  });
  return { W: worldWidth(repos.length), platforms, unlock: opts.unlock };
}

/** Offset of a moving platform from its rest position at world time t. */
export function platformOffset(p: Platform, t: number): { dx: number; dy: number } {
  if (!p.move) return { dx: 0, dy: 0 };
  const d = p.move.amp * Math.sin((t / p.move.period) * Math.PI * 2 + p.move.phase);
  return p.move.axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d };
}

export const startPad = { x0: 0, x1: COURSE.startPadEnd };
export const endPad = (c: Course) => ({ x0: c.W - COURSE.endPadWidth, x1: c.W });
export const gateRect = (c: Course) => ({
  x: c.W - COURSE.gateFromEnd,
  y: PHYS.floorY - COURSE.gateH,
  w: COURSE.gateW,
  h: COURSE.gateH,
});

// ---------- Mode-specific courses ----------

export const DAILY_PLATFORMS = 12;
export const DAILY_UNLOCK = 8;
export const PRACTICE_UNLOCK = 12;
export const ARENA_PLATFORMS = 14;

export const dailySeedKey = (date: string): string => `lcs-${date}`;

export const PRACTICE_PLATFORMS = 28;
export const PRACTICE_RISING = 6;

/**
 * The 12 repos for a UTC date: 10 from the classic + catalog pool and 2 rising repos when the pool
 * has them, shuffled with the date seed. The server stores this list the first time a date is
 * requested, so later catalog edits can't change a past course.
 */
export function pickDailyRepos(date: string, pool: RisingPool | null): Repo[] {
  const rng = rngFrom(dailySeedKey(date));
  const rising = poolRepos(pool);
  const risingCount = rising.length >= 2 ? 2 : 0;
  const base = shuffle(rng, GAME_POOL).slice(0, DAILY_PLATFORMS - risingCount);
  const picked = risingCount ? shuffle(rng, rising).slice(0, risingCount) : [];
  return shuffle(rng, [...base, ...picked]);
}

/** Same 12 platforms for everyone on a date. Pass the stored `repos` when you have them. */
export function dailyCourse(date: string, pool: RisingPool | null, repos?: Repo[] | null): Course {
  const list = repos?.length ? repos : pickDailyRepos(date, pool);
  return buildCourse(list, rngFrom(`${dailySeedKey(date)}-layout`), { solo: true, unlock: DAILY_UNLOCK });
}

export function practiceCourse(rng: Rng, pool: RisingPool | null): Course {
  const base = shuffle(rng, GAME_POOL).slice(0, PRACTICE_PLATFORMS);
  const rising = shuffle(rng, poolRepos(pool)).slice(0, PRACTICE_RISING);
  return buildCourse(shuffle(rng, [...base, ...rising]), rng, { solo: true, unlock: PRACTICE_UNLOCK });
}

export function arenaCourse(seed: number): Course {
  const rng = mulberry32(seed);
  const repos = shuffle(rng, GAME_POOL).slice(0, ARENA_PLATFORMS);
  return buildCourse(repos, rng, { solo: false, unlock: null });
}
