/**
 * The slice of Cloudflare D1 the board uses. Declared here (the project has no workers-types package) so the
 * Worker and the tests' SQLite adapter (tests/support/d1-sqlite.ts) implement the same contract.
 */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number; last_row_id?: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** Runs the statements in one transaction: all of them apply, or none. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
