import { describe, expect, it } from 'vitest';
import { dailyCourse } from '../shared/course.ts';
import { dailyQuestion, defaultContext } from '../shared/questions.ts';
import { answerScore, FELL_LABEL, STANDING_LABEL } from '../shared/scoring.ts';
import { checkFinish } from '../server/daily.ts';
import { cleanTeam } from '../server/names.ts';

const date = '20261010';
const course = dailyCourse(date, null);
const p0 = course.platforms[0];

describe('daily finish validation', () => {
  it('labels a wrong answer with the platform and question kind', () => {
    const kind = dailyQuestion(date, 1, course.platforms[1].repo, defaultContext()).kind;
    const r = checkFinish(course, null, date, { results: [{ i: 0, ok: true, s: 12 }, { i: 1, ok: false, s: 4 }], score: answerScore(12, p0.mult), won: false }, 60_000);
    expect(r).toMatchObject({ ok: true, cleared: 1, diedAt: 1, outLabel: `Out on #2 ${course.platforms[1].repo.short} (${kind})` });
  });

  it('labels a fall and marks the next platform', () => {
    const r = checkFinish(course, null, date, { results: [{ i: 0, ok: true, s: 12 }], score: answerScore(12, p0.mult), won: false }, 10_000);
    expect(r).toMatchObject({ ok: true, outLabel: FELL_LABEL, diedAt: 1 });
  });

  it('accepts a win only after the unlock count', () => {
    const results = course.platforms.slice(0, 8).map((p) => ({ i: p.i, ok: true, s: 5 }));
    const score = results.reduce((t, r) => t + answerScore(5, course.platforms[r.i].mult), 0) + 500;
    expect(checkFinish(course, null, date, { results, score, won: true }, 120_000)).toMatchObject({ ok: true, outLabel: STANDING_LABEL, won: true });
    expect(checkFinish(course, null, date, { results: results.slice(0, 7), score, won: true }, 120_000).ok).toBe(false);
  });

  it('rejects runs faster than the answers they claim', () => {
    const r = checkFinish(course, null, date, { results: [{ i: 0, ok: true, s: 1 }], score: answerScore(1, p0.mult), won: false }, 2_000);
    expect(r).toEqual({ ok: false, error: 'run finished too fast' });
  });

  it('rejects malformed bodies', () => {
    expect(checkFinish(course, null, date, { results: 'x' as never, score: 0, won: false }, 0).ok).toBe(false);
    expect(checkFinish(course, null, date, { results: [{ i: 0, ok: true, s: 1.5 }], score: 0, won: false }, 99_000).ok).toBe(false);
  });
});

describe('team slugs', () => {
  it('normalizes team names', () => {
    expect(cleanTeam('  Vercel Inc. ')).toBe('vercel-inc');
    expect(cleanTeam('A')).toBe('');
    expect(cleanTeam('<script>')).toBe('script');
    expect(cleanTeam('x'.repeat(40))).toHaveLength(24);
  });
});
