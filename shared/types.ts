export type Region = 'ai' | 'web' | 'dev' | 'infra' | 'lang' | 'rising';
export type Band = '200k+' | '100k+' | '50k+' | '20k+' | '<20k' | 'rising';

export interface Trivia {
  q: string;
  a: string;
  w: [string, string, string];
}

export interface Repo {
  id: string;
  region: Region;
  short: string;
  /** owner/repo */
  name: string;
  lang: string;
  /** false when GitHub's language label is ambiguous */
  langQ?: boolean;
  band: Band;
  clues: [string, string];
  what: string;
  /** identify choices, includes `short` (classic repos only) */
  choices?: [string, string, string, string];
  trivia?: Trivia;
  /** present on rising repos only */
  rising?: { desc: string; stars: number; asOf: string };
  /** catalog repos: facts fetched from the GitHub API (see scripts/build-catalog.ts) */
  facts?: RepoFacts;
  /** catalog repos: the repo's own GitHub description, shown after the question */
  about?: string;
  /** catalog repos: three other repos' "what" lines, chosen at build time */
  whatWrong?: [string, string, string];
}

export interface RepoFacts {
  /** year the GitHub repository was created */
  created: number;
  /** SPDX id, or null when GitHub reports none/other */
  license: string | null;
  stars: number;
  /** YYYY-MM-DD the facts were fetched */
  asOf: string;
  /** share of code bytes in the primary language, 0..1 */
  langShare: number;
}

/** A rising repo as served by GET /api/rising. */
export interface RisingRepo {
  name: string;
  /** name-free clue */
  desc: string;
  lang: string | null;
  stars: number;
  /** the repo's own GitHub description, shown after playing */
  about?: string | null;
}

export interface RisingPool {
  asOf: string;
  repos: RisingRepo[];
}

export type QuestionKind = 'identify' | 'what' | 'lang' | 'trivia' | 'stars' | 'year' | 'license';

export interface Question {
  kind: QuestionKind;
  prompt: string;
  clue?: string;
  options: string[];
  answer: number;
  layout: 'grid' | 'column';
}

/** One answered platform in a solo run, as reported to the server. */
export interface RunResult {
  /** platform index on the course */
  i: number;
  ok: boolean;
  /** ceil(seconds left) when answered; 0 on timeout */
  s: number;
}
