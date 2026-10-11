import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// the store opens the database on import, so point it at a throwaway file first
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'lcs-board-')), 'test.db');
let store: typeof import('../server/store.ts');
beforeAll(async () => {
  store = await import('../server/store.ts');
});

describe('filtered leaderboards', () => {
  it('ranks your own row within the team, not across everyone', () => {
    const date = '20261011';
    const finish = (score: number, team: string) => {
      const p = store.createPlayer();
      if (team) store.setPlayerTeam(p.id, team);
      const run = store.startOfficialRun(p.id, date)!;
      store.finishRun(run.id, { score, cleared: 1, total: 12, won: false, diedAt: 1, outLabel: 'x', results: [] });
      return p;
    };
    finish(9000, ''); // two strangers above everyone on the team
    finish(8000, '');
    let me = null as ReturnType<typeof finish> | null;
    for (let i = 0; i < 11; i++) me = finish(5000 - i * 10, 'acme'); // 11 teammates; the last is lowest
    const board = store.leaderboard(date, me!.id, 10, 'acme');
    expect(board.players).toBe(11);
    expect(board.rows).toHaveLength(10);
    expect(board.me?.rank).toBe(11); // was 13: the global rank
    expect(store.leaderboard(date, me!.id).me?.rank).toBe(13); // the global board still ranks globally
  });
});
