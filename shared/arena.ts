import { ARENA_PLATFORMS } from './course.ts';
import { rngFrom, shuffle } from './rng.ts';

export const ARENA = {
  /** server sets t0 this far in the future when the host presses Start */
  leadMs: 5000,
  firstBellMs: 9000,
  bellEveryMs: 20000,
  bells: 6,
  questionMs: 10000,
  crumbleMs: 2500,
  crumblePerRound: 2,
  /** a position report must be this fresh at the bell */
  posFreshMs: 300,
  disconnectGraceMs: 10000,
  posHz: 15,
  codeAlphabet: 'abcdefghjkmnpqrstuvwxyz23456789',
  codeLength: 4,
} as const;

/** Bell k (0-based) rings at t0 + 9 s + k * 20 s. Shown to players as "Bell k+1". */
export const bellAt = (t0: number, k: number): number => t0 + ARENA.firstBellMs + k * ARENA.bellEveryMs;
export const questionEndsAt = (t0: number, k: number): number => bellAt(t0, k) + ARENA.questionMs;
export const crumbleEndsAt = (t0: number, k: number): number => questionEndsAt(t0, k) + ARENA.crumbleMs;
export const arenaEndsAt = (t0: number): number => questionEndsAt(t0, ARENA.bells - 1);

export type ArenaPhase =
  | { kind: 'countdown'; msLeft: number }
  | { kind: 'roam'; bell: number; msLeft: number }
  | { kind: 'question'; bell: number; msLeft: number }
  | { kind: 'over' };

/** Where the match is at server time `now`. `bell` is 0-based. */
export function arenaPhase(t0: number, now: number): ArenaPhase {
  if (now < t0) return { kind: 'countdown', msLeft: t0 - now };
  if (now >= arenaEndsAt(t0)) return { kind: 'over' };
  for (let k = 0; k < ARENA.bells; k++) {
    if (now < bellAt(t0, k)) return { kind: 'roam', bell: k, msLeft: bellAt(t0, k) - now };
    if (now < questionEndsAt(t0, k)) return { kind: 'question', bell: k, msLeft: questionEndsAt(t0, k) - now };
  }
  return { kind: 'over' };
}

/**
 * Which platforms crumble after each question window. Round k removes two platforms that are
 * still standing; no crumble after the last bell. Deterministic from the public course seed.
 */
export function crumblePlan(seed: number, platformCount = ARENA_PLATFORMS): number[][] {
  const remaining = Array.from({ length: platformCount }, (_, i) => i);
  const plan: number[][] = [];
  for (let k = 0; k < ARENA.bells - 1; k++) {
    const picks = shuffle(rngFrom(`${seed}-crumble-${k}`), remaining).slice(0, ARENA.crumblePerRound);
    for (const p of picks) remaining.splice(remaining.indexOf(p), 1);
    plan.push(picks.sort((a, b) => a - b));
  }
  return plan;
}

/** Platform states at server time `now`. */
export function platformStates(seed: number, t0: number, now: number, platformCount = ARENA_PLATFORMS) {
  const plan = crumblePlan(seed, platformCount);
  const gone = new Set<number>();
  const crumbling = new Set<number>();
  plan.forEach((picks, k) => {
    const start = questionEndsAt(t0, k);
    if (now >= start + ARENA.crumbleMs) picks.forEach((p) => gone.add(p));
    else if (now >= start) picks.forEach((p) => crumbling.add(p));
  });
  return { gone, crumbling };
}

export function makeRoomCode(rand: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ARENA.codeLength; i++) code += ARENA.codeAlphabet[Math.floor(rand() * ARENA.codeAlphabet.length)];
  return code;
}

