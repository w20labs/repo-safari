import { db } from './db.ts';

export interface DayEntry {
  date: string;
  score: number;
  cleared: number;
  total: number;
  won: boolean;
}

export interface PlayerStats {
  played: number;
  wins: number;
  bestScore: number;
  currentStreak: number;
  bestStreak: number;
  /** last 14 UTC days, oldest first; null = didn't play */
  recent: (DayEntry | null)[];
}

const DAY = 86_400_000;
const keyToMs = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8)));
const msToKey = (ms: number) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
export const prevDay = (k: string) => msToKey(keyToMs(k) - DAY);

/** Consecutive days with a finished official run, ending at `end`. */
export function streakEndingAt(dates: Set<string>, end: string): number {
  let n = 0;
  for (let d = end; dates.has(d); d = prevDay(d)) n++;
  return n;
}

/** Pure computation from a player's finished official runs (any order). */
export function computeStats(runs: DayEntry[], today: string): PlayerStats {
  const dates = new Set(runs.map((r) => r.date));
  const sorted = [...dates].sort();
  let best = 0;
  let cur = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    cur = prev && prevDay(d) === prev ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = d;
  }
  // a streak is still alive if you played today or yesterday
  const current = dates.has(today) ? streakEndingAt(dates, today) : streakEndingAt(dates, prevDay(today));
  const byDate = new Map(runs.map((r) => [r.date, r]));
  const recent: (DayEntry | null)[] = [];
  for (let i = 13; i >= 0; i--) recent.push(byDate.get(msToKey(keyToMs(today) - i * DAY)) ?? null);
  return {
    played: runs.length,
    wins: runs.filter((r) => r.won).length,
    bestScore: runs.reduce((m, r) => Math.max(m, r.score), 0),
    currentStreak: current,
    bestStreak: best,
    recent,
  };
}

export function finishedRuns(playerId: string): DayEntry[] {
  const rows = db
    .prepare('SELECT date, score, cleared, total, won FROM runs WHERE player_id = ? AND official = 1 AND finished_at IS NOT NULL')
    .all(playerId) as { date: string; score: number; cleared: number; total: number; won: number }[];
  return rows.map((r) => ({ ...r, won: !!r.won }));
}

export const playerStats = (playerId: string, today: string) => computeStats(finishedRuns(playerId), today);

export function streakAt(playerId: string, date: string): number {
  return streakEndingAt(new Set(finishedRuns(playerId).map((r) => r.date)), date);
}

/** "#212 of 5,310 · top 4% · streak 5" */
export function rankLine(rank: number, players: number, streak: number): string {
  const parts = [`#${rank.toLocaleString('en-US')} of ${players.toLocaleString('en-US')}`];
  if (players >= 10) parts.push(`top ${Math.max(1, Math.ceil((rank / players) * 100))}%`);
  if (streak >= 2) parts.push(`streak ${streak}`);
  return parts.join(' · ');
}
