import { CLASSIC } from './data/classic.ts';
import { randInt, rngFrom, shuffle, type Rng } from './rng.ts';
import type { Question, QuestionKind, Repo } from './types.ts';

export const LANG_POOL = ['Python', 'Go', 'Rust', 'TypeScript', 'JavaScript', 'C++', 'Zig', 'Shell', 'C', 'Java', 'Swift'];
export const STAR_BUCKETS = ['Under 1k', '1k–5k', '5k–25k', '25k+'];

export const KIND_LABELS: Record<QuestionKind, string> = {
  identify: 'Identify',
  what: 'What it does',
  lang: 'Language',
  trivia: 'Trivia',
  stars: 'Stars',
};

export interface QuestionContext {
  /** classic repos used for "what" distractors */
  classic: Repo[];
  /** rising repos used for rising identify distractors */
  rising: Repo[];
}

export const defaultContext = (rising: Repo[] = []): QuestionContext => ({ classic: CLASSIC, rising });

export function starsBucket(stars: number): number {
  if (stars < 1000) return 0;
  if (stars < 5000) return 1;
  if (stars < 25000) return 2;
  return 3;
}

/** Shuffles `correct` in among `wrong` and returns the options plus the answer index. */
function withAnswer(rng: Rng, correct: string, wrong: string[]): { options: string[]; answer: number } {
  const options = shuffle(rng, [correct, ...wrong]);
  return { options, answer: options.indexOf(correct) };
}

const otherRising = (repo: Repo, ctx: QuestionContext): string[] =>
  [...new Set(ctx.rising.filter((r) => r.name !== repo.name).map((r) => r.name))];

export function availableKinds(repo: Repo, ctx: QuestionContext): QuestionKind[] {
  if (repo.rising) {
    const kinds: QuestionKind[] = ['stars'];
    if (otherRising(repo, ctx).length >= 3) kinds.push('identify');
    if (repo.langQ !== false && repo.lang) kinds.push('lang');
    return kinds;
  }
  const kinds: QuestionKind[] = ['identify', 'what', 'trivia', 'trivia'];
  if (repo.langQ !== false) kinds.push('lang');
  return kinds;
}

export function makeQuestion(repo: Repo, rng: Rng, ctx: QuestionContext): Question {
  const kinds = availableKinds(repo, ctx);
  const kind = kinds[randInt(rng, kinds.length)];
  return buildQuestion(kind, repo, rng, ctx);
}

export function buildQuestion(kind: QuestionKind, repo: Repo, rng: Rng, ctx: QuestionContext): Question {
  switch (kind) {
    case 'identify': {
      if (repo.rising) {
        const wrong = shuffle(rng, otherRising(repo, ctx)).slice(0, 3);
        return { kind, prompt: 'Which rising repo is this?', clue: repo.rising.desc, layout: 'column', ...withAnswer(rng, repo.name, wrong) };
      }
      const clue = repo.clues[randInt(rng, 2)];
      const wrong = (repo.choices ?? []).filter((c) => c !== repo.short);
      return { kind, prompt: 'Which repo is this?', clue, layout: 'grid', ...withAnswer(rng, repo.short, wrong) };
    }
    case 'what': {
      const others = ctx.classic.filter((r) => r.id !== repo.id && r.what !== repo.what).map((r) => r.what);
      const wrong = shuffle(rng, others).slice(0, 3);
      return { kind, prompt: `What does ${repo.name} do?`, layout: 'column', ...withAnswer(rng, repo.what, wrong) };
    }
    case 'lang': {
      const wrong = shuffle(rng, LANG_POOL.filter((l) => l !== repo.lang)).slice(0, 3);
      return { kind, prompt: `Which language is most of ${repo.name} written in?`, layout: 'grid', ...withAnswer(rng, repo.lang, wrong) };
    }
    case 'trivia': {
      const t = repo.trivia!;
      return { kind, prompt: t.q, layout: 'grid', ...withAnswer(rng, t.a, [...t.w]) };
    }
    case 'stars': {
      const r = repo.rising!;
      return {
        kind,
        prompt: `How many GitHub stars did ${repo.name} have as of ${r.asOf}?`,
        layout: 'grid',
        options: [...STAR_BUCKETS],
        answer: starsBucket(r.stars),
      };
    }
  }
}

/** Daily questions are keyed by platform number so they don't depend on landing order. */
export const dailyQuestionKey = (date: string, platformIndex: number): string => `${date}-q-${platformIndex + 1}`;

export const dailyQuestion = (date: string, platformIndex: number, repo: Repo, ctx: QuestionContext): Question =>
  makeQuestion(repo, rngFrom(dailyQuestionKey(date, platformIndex)), ctx);
