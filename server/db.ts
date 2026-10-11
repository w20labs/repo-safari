import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DB_PATH = resolve(process.env.DB_PATH ?? 'data/lcs.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    num INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL REFERENCES players(id),
    date TEXT NOT NULL,
    official INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    score INTEGER,
    cleared INTEGER,
    total INTEGER,
    won INTEGER,
    died_at INTEGER,
    out_label TEXT,
    results TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runs_one_official ON runs(player_id, date) WHERE official = 1;
  CREATE INDEX IF NOT EXISTS runs_board ON runs(date, official, score DESC);
  -- the rising pool frozen for each daily date, so a mid-day refresh can't change a course
  CREATE TABLE IF NOT EXISTS daily_pool (
    date TEXT PRIMARY KEY,
    pool TEXT
  );
  CREATE TABLE IF NOT EXISTS rising (
    name TEXT PRIMARY KEY,
    rank INTEGER NOT NULL,
    desc TEXT NOT NULL,
    desc_auto INTEGER NOT NULL DEFAULT 0,
    orig_desc TEXT,
    lang TEXT,
    stars INTEGER NOT NULL,
    url TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`);

/** Adds a column if an older database doesn't have it yet. */
function addColumn(table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
addColumn('daily_pool', 'repos', 'TEXT');
addColumn('players', 'team', "TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS players_team ON players(team)');

export function getMeta(k: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined;
  return row?.v ?? null;
}

export function setMeta(k: string, v: string) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}
