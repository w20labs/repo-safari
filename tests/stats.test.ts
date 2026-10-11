import { describe, expect, it } from 'vitest';
import { computeStats, rankLine } from '../server/stats.ts';

const run = (date: string, won = false) => ({ date, score: 100, cleared: 3, total: 12, won });

describe('player stats', () => {
  it('counts the current streak through today or yesterday', () => {
    const runs = [run('20261008'), run('20261009'), run('20261010')];
    expect(computeStats(runs, '20261010').currentStreak).toBe(3);
    expect(computeStats(runs, '20261011').currentStreak).toBe(3); // not played yet today
    expect(computeStats(runs, '20261012').currentStreak).toBe(0); // missed a day
  });

  it('tracks the best streak across gaps and month ends', () => {
    const runs = ['20260929', '20260930', '20261001', '20261002', '20261005', '20261006'].map((d) => run(d));
    const s = computeStats(runs, '20261006');
    expect(s.bestStreak).toBe(4);
    expect(s.currentStreak).toBe(2);
  });

  it('builds a 14-day window and win counts', () => {
    const s = computeStats([run('20261010', true), run('20260101')], '20261010');
    expect(s.recent).toHaveLength(14);
    expect(s.recent[13]?.won).toBe(true);
    expect(s.recent.filter(Boolean)).toHaveLength(1);
    expect(s).toMatchObject({ played: 2, wins: 1 });
  });

  it('formats the rank line', () => {
    expect(rankLine(212, 5310, 5)).toBe('#212 of 5,310 · top 4% · streak 5');
    expect(rankLine(1, 3, 1)).toBe('#1 of 3');
  });
});
