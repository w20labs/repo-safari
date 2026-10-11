import { describe, expect, it } from 'vitest';
import { dateKey, fnv1a, mulberry32, rngFrom, shuffle } from '../shared/rng.ts';

describe('rng', () => {
  it('fnv1a matches known vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('a')).toBe(0xe40c292c);
    expect(fnv1a('foobar')).toBe(0xbf9cf968);
  });

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('shuffle keeps every item and is seeded', () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const s1 = shuffle(rngFrom('x'), items);
    expect([...s1].sort((a, b) => a - b)).toEqual(items);
    expect(shuffle(rngFrom('x'), items)).toEqual(s1);
    expect(shuffle(rngFrom('y'), items)).not.toEqual(s1);
  });

  it('dateKey uses UTC', () => {
    expect(dateKey(new Date('2026-10-10T23:59:59Z'))).toBe('20261010');
    expect(dateKey(new Date('2026-10-11T00:00:00Z'))).toBe('20261011');
  });
});
