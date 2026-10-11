export type Region = 'ai' | 'web' | 'dev' | 'infra' | 'lang' | 'rising';
export type Band = '200k+' | '100k+' | '50k+' | '20k+' | 'rising';

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
}

/** A rising repo as served by GET /api/rising. */
export interface RisingRepo {
  name: string;
  desc: string;
  lang: string | null;
  stars: number;
}

export interface RisingPool {
  asOf: string;
  repos: RisingRepo[];
}

export type QuestionKind = 'identify' | 'what' | 'lang' | 'trivia' | 'stars';

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
