import { CLASSIC } from './data/classic.ts';
import { randInt, rngFrom, shuffle, type Rng } from './rng.ts';
import type { Question, QuestionKind, Repo } from './types.ts';

export const LANG_POOL = ['Python', 'Go', 'Rust', 'TypeScript', 'JavaScript', 'C++', 'Zig', 'Shell', 'C', 'Java', 'Swift'];
export const STAR_BUCKETS = ['Under 1k', '1k–5k', '5k–25k', '25k+'];
export const CATALOG_STAR_BUCKETS = ['Under 20k', '20k–50k', '50k–100k', '100k+'];

/** SPDX ids we ask about, with plain display names. */
export const LICENSE_NAMES: Record<string, string> = {
  MIT: 'MIT',
  'Apache-2.0': 'Apache 2.0',
  'GPL-3.0': 'GPL 3.0',
  'GPL-2.0': 'GPL 2.0',
  'AGPL-3.0': 'AGPL 3.0',
  'LGPL-2.1': 'LGPL 2.1',
  'LGPL-3.0': 'LGPL 3.0',
  'BSD-3-Clause': 'BSD 3-Clause',
  'BSD-2-Clause': 'BSD 2-Clause',
  'MPL-2.0': 'MPL 2.0',
  ISC: 'ISC',
  Unlicense: 'The Unlicense',
  'CC0-1.0': 'CC0 1.0',
  'EPL-2.0': 'Eclipse 2.0',
  'EPL-1.0': 'Eclipse 1.0',
  Zlib: 'zlib',
  'BSL-1.0': 'Boost 1.0',
  'CC-BY-4.0': 'CC BY 4.0',
  'CC-BY-SA-4.0': 'CC BY-SA 4.0',
  'Artistic-2.0': 'Artistic 2.0',
};
const LICENSE_DISTRACTORS = ['MIT', 'Apache 2.0', 'GPL 3.0', 'BSD 3-Clause', 'AGPL 3.0', 'MPL 2.0', 'GPL 2.0', 'LGPL 2.1'];

export const KIND_LABELS: Record<QuestionKind, string> = {
  identify: 'Identify',
  what: 'What it does',
  lang: 'Language',
  trivia: 'Trivia',
  stars: 'Stars',
  year: 'Year',
  license: 'License',
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

export function catalogStarsBucket(stars: number): number {
  if (stars < 20000) return 0;
  if (stars < 50000) return 1;
  if (stars < 100000) return 2;
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
  if (repo.facts) {
    // catalog repo: everything comes from GitHub API facts
    const kinds: QuestionKind[] = ['year', 'stars'];
    if (repo.choices && repo.clues[0]) kinds.push('identify', 'identify');
    if (repo.whatWrong && repo.what) kinds.push('what');
    if (repo.langQ !== false && repo.lang) kinds.push('lang');
    if (repo.facts.license && LICENSE_NAMES[repo.facts.license]) kinds.push('license');
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
      const wrong = repo.whatWrong
        ? [...repo.whatWrong]
        : shuffle(rng, ctx.classic.filter((r) => r.id !== repo.id && r.what !== repo.what).map((r) => r.what)).slice(0, 3);
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
      if (repo.rising) {
        const r = repo.rising;
        return {
          kind,
          prompt: `How many GitHub stars did ${repo.name} have as of ${r.asOf}?`,
          layout: 'grid',
          options: [...STAR_BUCKETS],
          answer: starsBucket(r.stars),
        };
      }
      const f = repo.facts!;
      return {
        kind,
        prompt: `How many GitHub stars did ${repo.name} have as of ${f.asOf}?`,
        layout: 'grid',
        options: [...CATALOG_STAR_BUCKETS],
        answer: catalogStarsBucket(f.stars),
      };
    }
    case 'year': {
      const f = repo.facts!;
      const latest = Number(f.asOf.slice(0, 4));
      const near = [-4, -3, -2, -1, 1, 2, 3, 4].map((d) => f.created + d).filter((y) => y >= 2008 && y <= latest);
      const wrong = shuffle(rng, near).slice(0, 3).map(String);
      const q = withAnswer(rng, String(f.created), wrong);
      // show years in order; it reads better than shuffled
      const options = [...q.options].sort();
      return { kind, prompt: `In which year was the GitHub repository ${repo.name} created?`, layout: 'grid', options, answer: options.indexOf(String(f.created)) };
    }
    case 'license': {
      const correct = LICENSE_NAMES[repo.facts!.license!];
      const wrong = shuffle(rng, LICENSE_DISTRACTORS.filter((l) => l !== correct)).slice(0, 3);
      return { kind, prompt: `Which license is ${repo.name} released under?`, layout: 'grid', ...withAnswer(rng, correct, wrong) };
    }
  }
}

/** Daily questions are keyed by platform number so they don't depend on landing order. */
export const dailyQuestionKey = (date: string, platformIndex: number): string => `${date}-q-${platformIndex + 1}`;

export const dailyQuestion = (date: string, platformIndex: number, repo: Repo, ctx: QuestionContext): Question =>
  makeQuestion(repo, rngFrom(dailyQuestionKey(date, platformIndex)), ctx);
