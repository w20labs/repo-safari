import { randomBytes, randomInt } from 'node:crypto';
import { TOTAL_PLAYERS } from '../shared/constants.ts';
import { dailyCourse, type Course } from '../shared/course.ts';
import type { RisingPool, RunResult } from '../shared/types.ts';
import { db, getMeta } from './db.ts';

export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');

// ---------- players ----------

export interface PlayerRow {
  id: string;
  num: number;
  name: string;
}

export function getPlayer(id: string | undefined): PlayerRow | null {
  if (!id) return null;
  return (db.prepare('SELECT id, num, name FROM players WHERE id = ?').get(id) as PlayerRow | undefined) ?? null;
}

export function createPlayer(): PlayerRow {
  const p = { id: newId(12), num: randomInt(1, TOTAL_PLAYERS + 1), name: '' };
  db.prepare('INSERT INTO players (id, num, name, created_at) VALUES (?, ?, ?, ?)').run(p.id, p.num, p.name, Date.now());
  return p;
}

export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

export function setPlayerName(id: string, name: string) {
  db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
}

// ---------- rising pool ----------

export function currentPool(): RisingPool | null {
  const asOf = getMeta('rising_as_of');
  const rows = db.prepare('SELECT name, desc, lang, stars FROM rising ORDER BY rank').all() as RisingPool['repos'];
  if (!asOf || rows.length < 2) return null;
  return { asOf, repos: rows };
}

/** The pool used for a date's course; frozen the first time anyone asks for that date. */
export function poolForDate(date: string): RisingPool | null {
  const row = db.prepare('SELECT pool FROM daily_pool WHERE date = ?').get(date) as { pool: string | null } | undefined;
  if (row) return row.pool ? (JSON.parse(row.pool) as RisingPool) : null;
  const pool = currentPool();
  db.prepare('INSERT OR IGNORE INTO daily_pool (date, pool) VALUES (?, ?)').run(date, pool ? JSON.stringify(pool) : null);
  return poolForDate(date);
}

export function courseForDate(date: string): { course: Course; pool: RisingPool | null } {
  const pool = poolForDate(date);
  return { course: dailyCourse(date, pool), pool };
}

// ---------- runs ----------

export interface RunRow {
  id: string;
  player_id: string;
  date: string;
  official: number;
  started_at: number;
  finished_at: number | null;
  score: number | null;
  cleared: number | null;
  total: number | null;
  won: number | null;
  died_at: number | null;
  out_label: string | null;
  results: string | null;
}

export const getRun = (id: string): RunRow | null =>
  (db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined) ?? null;

export const officialRun = (playerId: string, date: string): RunRow | null =>
  (db.prepare('SELECT * FROM runs WHERE player_id = ? AND date = ? AND official = 1').get(playerId, date) as RunRow | undefined) ?? null;

/** Creates the official run for today, or returns null if the player already has one. */
export function startOfficialRun(playerId: string, date: string): RunRow | null {
  const id = newId();
  const res = db
    .prepare('INSERT OR IGNORE INTO runs (id, player_id, date, official, started_at) VALUES (?, ?, ?, 1, ?)')
    .run(id, playerId, date, Date.now());
  return res.changes ? getRun(id) : null;
}

export function finishRun(
  id: string,
  f: { score: number; cleared: number; total: number; won: boolean; diedAt: number | null; outLabel: string; results: RunResult[] },
) {
  db.prepare(
    `UPDATE runs SET finished_at = ?, score = ?, cleared = ?, total = ?, won = ?, died_at = ?, out_label = ?, results = ?
     WHERE id = ? AND finished_at IS NULL`,
  ).run(Date.now(), f.score, f.cleared, f.total, f.won ? 1 : 0, f.diedAt, f.outLabel, JSON.stringify(f.results), id);
}

// ---------- leaderboard ----------

export interface BoardRow {
  rank: number;
  runId: string;
  num: number;
  name: string;
  score: number;
  cleared: number;
  total: number;
  won: boolean;
  me?: boolean;
}

const ORDER = 'r.score DESC, r.cleared DESC, r.finished_at ASC';

export function leaderboard(date: string, playerId: string | undefined, limit = 10): { rows: BoardRow[]; me: BoardRow | null; players: number } {
  const rows = db
    .prepare(
      `SELECT r.id, r.player_id, p.num, p.name, r.score, r.cleared, r.total, r.won
       FROM runs r JOIN players p ON p.id = r.player_id
       WHERE r.date = ? AND r.official = 1 AND r.finished_at IS NOT NULL
       ORDER BY ${ORDER} LIMIT ?`,
    )
    .all(date, limit) as { id: string; player_id: string; num: number; name: string; score: number; cleared: number; total: number; won: number }[];
  const players = (db.prepare('SELECT COUNT(*) n FROM runs WHERE date = ? AND official = 1 AND finished_at IS NOT NULL').get(date) as { n: number }).n;
  const map = (r: (typeof rows)[number], rank: number): BoardRow => ({
    rank, runId: r.id, num: r.num, name: r.name, score: r.score, cleared: r.cleared, total: r.total, won: !!r.won, me: r.player_id === playerId,
  });
  const out = rows.map((r, i) => map(r, i + 1));
  let me = out.find((r) => r.me) ?? null;
  if (!me && playerId) {
    const mine = officialRun(playerId, date);
    if (mine?.finished_at) me = { ...rankOf(mine), me: true };
  }
  return { rows: out, me, players };
}

export function rankOf(run: RunRow): BoardRow {
  const better = db
    .prepare(
      `SELECT COUNT(*) n FROM runs r WHERE r.date = ? AND r.official = 1 AND r.finished_at IS NOT NULL AND (
         r.score > ? OR (r.score = ? AND r.cleared > ?) OR (r.score = ? AND r.cleared = ? AND r.finished_at < ?))`,
    )
    .get(run.date, run.score, run.score, run.cleared, run.score, run.cleared, run.finished_at) as { n: number };
  const p = getPlayer(run.player_id)!;
  return {
    rank: better.n + 1, runId: run.id, num: p.num, name: p.name, score: run.score ?? 0,
    cleared: run.cleared ?? 0, total: run.total ?? 0, won: !!run.won,
  };
}
