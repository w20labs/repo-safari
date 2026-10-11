import type { Course } from '../shared/course.ts';
import { dailyQuestion, defaultContext } from '../shared/questions.ts';
import { poolRepos } from '../shared/rising.ts';
import { prettyDate } from '../shared/rng.ts';
import { FELL_LABEL, STANDING_LABEL, fallIndex, outOnLabel, squaresFor, timerFor, validateRun } from '../shared/scoring.ts';
import type { ResultSummary } from '../shared/share.ts';
import type { RisingPool, RunResult } from '../shared/types.ts';

export interface FinishBody {
  results: RunResult[];
  score: number;
  won: boolean;
}

export type FinishCheck =
  | { ok: true; score: number; cleared: number; total: number; won: boolean; diedAt: number | null; outLabel: string; results: RunResult[] }
  | { ok: false; error: string };

/**
 * Validates a claimed daily run against the seeded course. The score is recomputed from the
 * results, and the run must have lasted at least as long as the answers it claims.
 */
export function checkFinish(course: Course, pool: RisingPool | null, date: string, body: FinishBody, elapsedMs: number): FinishCheck {
  const results = Array.isArray(body?.results)
    ? body.results.map((r) => ({ i: Number(r?.i), ok: r?.ok === true, s: Number(r?.s) }))
    : null;
  if (!results) return { ok: false, error: 'results missing' };
  const v = validateRun(course, results, Number(body.score), body.won === true);
  if (!v.ok) return v;

  // each answer used at least (timer - secondsLeftCeil) seconds of real time
  const minMs = results.reduce((t, r) => t + Math.max(0, timerFor(course.platforms[r.i].gold) - r.s) * 1000, 0);
  if (elapsedMs + 1500 < minMs) return { ok: false, error: 'run finished too fast' };

  const cleared = results.filter((r) => r.ok).map((r) => r.i);
  let outLabel = STANDING_LABEL;
  let diedAt: number | null = null;
  if (v.failedAt !== null) {
    diedAt = v.failedAt;
    const q = dailyQuestion(date, diedAt, course.platforms[diedAt].repo, defaultContext(poolRepos(pool)));
    outLabel = outOnLabel(course, diedAt, q.kind);
  } else if (!v.won) {
    diedAt = fallIndex(course, cleared);
    outLabel = FELL_LABEL;
  }
  return { ok: true, score: v.score, cleared: v.cleared, total: course.platforms.length, won: v.won, diedAt, outLabel, results };
}

export function summaryFor(
  course: Course,
  run: { date: string; score: number | null; cleared: number | null; total: number | null; won: number | null; died_at: number | null; out_label: string | null; results: string | null },
  player: { num: number; name: string },
  rankLine?: string,
): ResultSummary {
  const results = (run.results ? JSON.parse(run.results) : []) as RunResult[];
  const cleared = results.filter((r) => r.ok).map((r) => r.i);
  return {
    mode: 'Daily',
    date: prettyDate(run.date),
    playerNum: player.num,
    name: player.name || undefined,
    score: run.score ?? 0,
    statLine: `${run.cleared ?? 0}/${run.total ?? course.platforms.length} cleared`,
    squares: squaresFor(course, cleared, run.won ? null : run.died_at),
    standing: !!run.won,
    outLine: run.out_label ?? '',
    rankLine,
  };
}
