import { describe, expect, it } from 'vitest';
import { dailyCourse, practiceCourse } from '../shared/course.ts';
import { CLASSIC } from '../shared/data/classic.ts';
import { availableKinds, buildQuestion, dailyQuestion, defaultContext, makeQuestion, starsBucket } from '../shared/questions.ts';
import { poolRepos } from '../shared/rising.ts';
import { mulberry32, rngFrom } from '../shared/rng.ts';
import type { Question, RisingPool } from '../shared/types.ts';

const POOL: RisingPool = {
  asOf: '2026-10-05',
  repos: Array.from({ length: 10 }, (_, i) => ({ name: `owner${i}/proj${i}`, desc: `A tool number ${i}`, lang: i % 3 ? 'Kotlin' : null, stars: 300 + i * 4000 })),
};
const ctx = defaultContext(poolRepos(POOL));

function assertValid(q: Question) {
  expect(q.options).toHaveLength(4);
  expect(new Set(q.options).size).toBe(4);
  expect(q.options.every((o) => typeof o === 'string' && o.length > 0)).toBe(true);
  expect(Number.isInteger(q.answer)).toBe(true);
  expect(q.answer).toBeGreaterThanOrEqual(0);
  expect(q.answer).toBeLessThan(4);
}

describe('questions', () => {
  it('every kind for every repo has 4 unique options and a valid answer', () => {
    for (const repo of [...CLASSIC, ...ctx.rising]) {
      for (const kind of new Set(availableKinds(repo, ctx))) {
        for (let s = 0; s < 25; s++) assertValid(buildQuestion(kind, repo, mulberry32(s), ctx));
      }
    }
  });

  it('every generated question on many courses is valid', () => {
    for (let s = 0; s < 100; s++) {
      for (const p of practiceCourse(mulberry32(s), POOL).platforms) assertValid(makeQuestion(p.repo, mulberry32(s * 31 + p.i), ctx));
      const date = `2026${String((s % 12) + 1).padStart(2, '0')}${String((s % 28) + 1).padStart(2, '0')}`;
      for (const p of dailyCourse(date, POOL).platforms) assertValid(dailyQuestion(date, p.i, p.repo, ctx));
    }
  });

  it('the identify answer is the repo itself', () => {
    for (const repo of CLASSIC) {
      const q = buildQuestion('identify', repo, rngFrom(repo.id), ctx);
      expect(q.options[q.answer]).toBe(repo.short);
      expect(repo.clues).toContain(q.clue);
    }
  });

  it('skips language questions when the label is ambiguous', () => {
    for (const repo of CLASSIC.filter((r) => r.langQ === false)) expect(availableKinds(repo, ctx)).not.toContain('lang');
    const noLang = ctx.rising.find((r) => !r.lang)!;
    expect(availableKinds(noLang, ctx)).not.toContain('lang');
  });

  it('rising repos only get identify, lang and stars', () => {
    for (const r of ctx.rising) for (const k of availableKinds(r, ctx)) expect(['identify', 'lang', 'stars']).toContain(k);
    expect(availableKinds(ctx.rising[0], defaultContext([ctx.rising[0]]))).not.toContain('identify');
  });

  it('daily questions do not depend on landing order', () => {
    const c = dailyCourse('20261010', POOL);
    const q1 = dailyQuestion('20261010', 5, c.platforms[5].repo, ctx);
    dailyQuestion('20261010', 2, c.platforms[2].repo, ctx);
    expect(dailyQuestion('20261010', 5, c.platforms[5].repo, ctx)).toEqual(q1);
  });

  it('weights trivia double for classic repos', () => {
    const kinds = availableKinds(CLASSIC.find((r) => r.id === 'react')!, ctx);
    expect(kinds.filter((k) => k === 'trivia')).toHaveLength(2);
  });

  it('buckets stars', () => {
    expect([0, 999, 1000, 4999, 5000, 24999, 25000].map(starsBucket)).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });
});
