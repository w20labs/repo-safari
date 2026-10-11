import { padPlayerNumber } from './constants.ts';
import { SQUARE_CHARS, formatScore, type Square } from './scoring.ts';

export interface ResultSummary {
  /** "Daily", "Daily replay", "Practice", "Arena" */
  mode: string;
  /** YYYY-MM-DD */
  date: string;
  playerNum: number;
  name?: string;
  score: number;
  /** "7/12 cleared" or "Survived 4/6 bells" */
  statLine: string;
  squares: Square[];
  standing: boolean;
  /** out reason, or "Still standing" */
  outLine: string;
}

export function shareText(r: ResultSummary, url: string): string {
  return [
    `Last Commit Standing · ${r.mode} ${r.date}`,
    `Player ${padPlayerNumber(r.playerNum)} · ${formatScore(r.score)} pts · ${r.statLine}`,
    r.squares.map((s) => SQUARE_CHARS[s]).join(''),
    r.outLine,
    url,
  ].join('\n');
}
