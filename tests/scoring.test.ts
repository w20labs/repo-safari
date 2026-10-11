import { describe, expect, it } from 'vitest';
import { GATE_BONUS } from '../shared/constants.ts';
import { dailyCourse } from '../shared/course.ts';
import { answerScore, fallIndex, maxCourseScore, squaresFor, validateRun } from '../shared/scoring.ts';

const course = dailyCourse('20261010', null);
const normal = course.platforms.find((p) => !p.gold)!;
const gold = course.platforms.find((p) => p.gold)!;

describe('scoring', () => {
  it('uses round((100 + ceil(secondsLeft) * 10) * mult)', () => {
    expect(answerScore(11.2, 1.4)).toBe(Math.round((100 + 12 * 10) * 1.4));
    expect(answerScore(0.01, 1)).toBe(110);
    expect(answerScore(5, 2.0)).toBe(300);
  });

  it('accepts an honest run and rejects tampering', () => {
    const results = [
      { i: normal.i, ok: true, s: 10 },
      { i: gold.i, ok: true, s: 8 },
    ];
    const score = answerScore(10, normal.mult) + answerScore(8, gold.mult);
    expect(validateRun(course, results, score, false)).toMatchObject({ ok: true, score, cleared: 2 });
    expect(validateRun(course, results, score + 1, false).ok).toBe(false);
    expect(validateRun(course, [{ i: gold.i, ok: true, s: 9 }], answerScore(9, gold.mult), false).ok).toBe(false);
    expect(validateRun(course, [results[0], results[0]], score, false).ok).toBe(false);
    expect(validateRun(course, [{ i: 99, ok: true, s: 1 }], 0, false).ok).toBe(false);
    expect(validateRun(course, [{ i: normal.i, ok: false, s: 0 }, results[1]], answerScore(8, gold.mult), false).ok).toBe(false);
    expect(validateRun(course, results, score + GATE_BONUS, true).ok).toBe(false);
  });

  it('accepts a full winning run and caps it at the course maximum', () => {
    const results = course.platforms.map((p) => ({ i: p.i, ok: true, s: p.gold ? 8 : 12 }));
    const r = validateRun(course, results, maxCourseScore(course), true);
    expect(r).toMatchObject({ ok: true, won: true, cleared: 12 });
  });

  it('builds the squares row', () => {
    const sq = squaresFor(course, [0, 1, 2, gold.i], 7);
    expect(sq[gold.i]).toBe('gold');
    expect(sq[7]).toBe('died');
    expect(sq.filter((s) => s === 'empty')).toHaveLength(12 - 5);
    expect(fallIndex(course, [0, 1, 2])).toBe(3);
    expect(fallIndex(course, [])).toBe(0);
  });
});
