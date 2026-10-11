import type { Repo } from '../types.ts';
import { CLASSIC } from './classic.ts';
import data from './catalog.json';

/** Extended catalog built from the GitHub API (see scripts/build-catalog.ts). */
export const CATALOG: Repo[] = (data as { asOf: string; repos: Repo[] }).repos;
export const CATALOG_AS_OF: string = (data as { asOf: string }).asOf;

/** Every non-rising repo the game can put on a platform. */
export const GAME_POOL: Repo[] = [...CLASSIC, ...CATALOG.filter((c) => !CLASSIC.some((k) => k.name.toLowerCase() === c.name.toLowerCase()))];
