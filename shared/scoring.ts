import { GATE_BONUS } from './constants.ts';
import type { Course } from './course.ts';
import type { QuestionKind, RunResult } from './types.ts';

export const SOLO_TIMER = 12;
export const GOLD_TIMER = 8;
export const ARENA_TIMER = 10;

export const timerFor = (gold: boolean): number => (gold ? GOLD_TIMER : SOLO_TIMER);

/** Points for a correct answer. `secondsLeft` may be fractional; it is rounded up. */
export const answerScore = (secondsLeft: number, mult: number): number =>
  Math.round((100 + Math.ceil(secondsLeft) * 10) * mult);

export type RunValidation =
  | { ok: true; score: number; cleared: number; won: boolean; failedAt: number | null }
  | { ok: false; error: string };

/**
 * Recomputes a solo run's score from the course and the claimed per-platform results.
 * Rejects anything that couldn't have happened: unknown or repeated platforms, more than one
 * wrong answer, answers after a wrong one, seconds beyond the timer, an early win.
 */
export function validateRun(course: Course, results: RunResult[], claimedScore: number, won: boolean): RunValidation {
  if (!Array.isArray(results) || results.length > course.platforms.length) return { ok: false, error: 'bad results' };
  const seen = new Set<number>();
  let score = 0;
  let cleared = 0;
  let failedAt: number | null = null;
  for (const [n, r] of results.entries()) {
    if (!r || !Number.isInteger(r.i) || r.i < 0 || r.i >= course.platforms.length) return { ok: false, error: 'unknown platform' };
    if (seen.has(r.i)) return { ok: false, error: 'platform answered twice' };
    seen.add(r.i);
    const p = course.platforms[r.i];
    const limit = timerFor(p.gold);
    if (!Number.isInteger(r.s) || r.s < 0 || r.s > limit) return { ok: false, error: 'impossible time' };
    if (r.ok) {
      if (r.s < 1) return { ok: false, error: 'impossible time' };
      score += answerScore(r.s, p.mult);
      cleared++;
    } else {
      if (n !== results.length - 1) return { ok: false, error: 'answers after elimination' };
      failedAt = r.i;
    }
  }
  if (won) {
    if (failedAt !== null || course.unlock === null || cleared < course.unlock) return { ok: false, error: 'gate was locked' };
    score += GATE_BONUS;
  }
  if (claimedScore !== score) return { ok: false, error: 'score mismatch' };
  return { ok: true, score, cleared, won, failedAt };
}

/** Upper bound on any run's score for a course: every platform cleared instantly, plus the gate. */
export function maxCourseScore(course: Course): number {
  return course.platforms.reduce((s, p) => s + answerScore(timerFor(p.gold), p.mult), 0) + GATE_BONUS;
}

// ---------- Result summary (shared by results screen, share text and the PNG card) ----------

export type Square = 'cleared' | 'gold' | 'died' | 'empty';

export const SQUARE_CHARS: Record<Square, string> = { cleared: '■', gold: '◆', died: '✕', empty: '□' };

/** `diedAt` is the platform index where the run ended (wrong answer, timeout or the gap you fell into). */
export function squaresFor(course: Course, clearedIdx: Iterable<number>, diedAt: number | null): Square[] {
  const cleared = new Set(clearedIdx);
  return course.platforms.map((p) => {
    if (cleared.has(p.i)) return p.gold ? 'gold' : 'cleared';
    if (p.i === diedAt) return 'died';
    return 'empty';
  });
}

/** Where a fall happened: the first uncleared platform past the furthest one cleared. */
export function fallIndex(course: Course, clearedIdx: Iterable<number>): number | null {
  const cleared = new Set(clearedIdx);
  const furthest = Math.max(-1, ...cleared);
  const next = course.platforms.find((p) => p.i > furthest && !cleared.has(p.i));
  return next ? next.i : null;
}

export const outOnLabel = (course: Course, i: number, kind: QuestionKind): string =>
  `Out on #${i + 1} ${course.platforms[i].repo.short} (${kind})`;

export const FELL_LABEL = 'Fell into the merge conflict';
export const STANDING_LABEL = 'Still standing';

export const formatScore = (n: number): string => n.toLocaleString('en-US');
