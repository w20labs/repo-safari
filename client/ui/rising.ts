import { formatScore } from '../../shared/scoring.ts';
import type { Repo, RisingPool } from '../../shared/types.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

const ghUrl = (name: string) => `https://github.com/${name}`;

function repoItem(name: string, about: string, lang: string | null, stars: number, asOf: string) {
  return h('li', { class: 'rise' },
    h('a', { href: ghUrl(name), target: '_blank', rel: 'noopener' }, name, icon('link', 14)),
    h('p', null, about),
    h('div', { class: 'rise-meta' }, lang ? h('span', null, lang) : null, h('span', null, `${formatScore(stars)} stars as of ${asOf}`)),
  );
}

/** Post-game panel: the rising repos you just met, plus the rest of this week's pool. */
export function risingReveal(courseRepos: Repo[], pool: RisingPool | null): HTMLElement | null {
  const onCourse = courseRepos.filter((r) => r.rising);
  if (!onCourse.length && !pool?.repos.length) return null;
  const rest = (pool?.repos ?? []).filter((p) => !onCourse.some((r) => r.name === p.name));
  return h('div', { class: 'card reveal', style: { marginTop: '16px', textAlign: 'left' } },
    h('h2', null, icon('bolt', 18), onCourse.length ? 'Rising repos on today’s course' : 'Rising this week'),
    onCourse.length
      ? h('ul', { class: 'rise-list' }, onCourse.map((r) => repoItem(r.name, r.about ?? r.rising!.desc, r.lang || null, r.rising!.stars, r.rising!.asOf)))
      : null,
    rest.length && pool
      ? h('details', { class: 'rise-more' },
          h('summary', null, `All ${pool.repos.length} rising repos this week`),
          h('ul', { class: 'rise-list' }, rest.map((p) => repoItem(p.name, p.about ?? p.desc, p.lang, p.stars, pool.asOf))))
      : null,
    h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, 'New repos with the most stars from the last 60 days, refreshed weekly.'),
  );
}
