/**
 * A D1 stand-in on SQLite (better-sqlite3) for unit tests: the board's real migration, triggers, unique constraints
 * and transactions, without a Worker runtime. The integration tests (worker/test/integration.mjs) cover real D1.
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { D1Database, D1PreparedStatement, D1Result } from '../../worker/src/board/d1.ts';

export function sqliteD1(): D1Database & { raw: Database.Database; failNext(n?: number): void } {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync('worker/migrations/0001_idea_board.sql', 'utf8'));
  let failures = 0;
  const check = () => { if (failures > 0) { failures--; throw new Error('D1_ERROR: simulated outage'); } };
  const statement = (sql: string, args: unknown[] = []): D1PreparedStatement & { exec(): D1Result } => {
    const values = () => args.map((v) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v));
    const exec = (): D1Result => {
      const s = raw.prepare(sql);
      if (s.reader) return { results: s.all(...values()) as Record<string, unknown>[], meta: { changes: 0 } };
      const r = s.run(...values());
      return { results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    };
    return {
      bind: (...v: unknown[]) => statement(sql, v),
      exec,
      first: async <T>() => { check(); return (exec().results[0] as T) ?? null; },
      all: async <T>() => { check(); return exec() as unknown as D1Result<T>; },
      run: async () => { check(); return exec(); },
    };
  };
  return {
    raw,
    failNext: (n = 1) => { failures = n; },
    prepare: (sql: string) => statement(sql),
    batch: async (list: D1PreparedStatement[]) => { check(); return raw.transaction(() => list.map((s) => (s as ReturnType<typeof statement>).exec()))(); },
  };
}
