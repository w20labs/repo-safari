/** 32-bit FNV-1a hash of a string. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32: small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rngFrom = (key: string): Rng => mulberry32(fnv1a(key));

/** A non-reproducible RNG for modes that don't need a shared seed. */
export const randomRng = (): Rng => mulberry32((Math.random() * 2 ** 32) >>> 0);

export const randInt = (rng: Rng, n: number): number => Math.floor(rng() * n);

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[randInt(rng, items.length)];
}

/** Fisher–Yates shuffle into a new array. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** UTC date key, e.g. "20261010". */
export function dateKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** "20261010" -> "2026-10-10" */
export const prettyDate = (key: string): string => `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
