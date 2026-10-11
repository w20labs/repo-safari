import type { Repo, RisingPool, RisingRepo } from './types.ts';

export function risingToRepo(r: RisingRepo, asOf: string): Repo {
  const short = r.name.split('/')[1] ?? r.name;
  return {
    id: `rising:${r.name}`,
    region: 'rising',
    short,
    name: r.name,
    lang: r.lang ?? '',
    langQ: !!r.lang,
    band: 'rising',
    clues: [r.desc, r.desc],
    what: r.desc,
    about: r.about ?? r.desc,
    rising: { desc: r.desc, stars: r.stars, asOf },
  };
}

export const poolRepos = (pool: RisingPool | null): Repo[] =>
  pool ? pool.repos.map((r) => risingToRepo(r, pool.asOf)) : [];
