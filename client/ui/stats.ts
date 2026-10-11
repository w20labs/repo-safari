import { prettyDate } from '../../shared/rng.ts';
import { formatScore } from '../../shared/scoring.ts';
import type { PlayerStats } from '../net/api.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

/** "Your stats" card: totals, streaks and the last 14 days as squares. */
export function statsCard(s: PlayerStats | null): HTMLElement {
  const card = h('div', { class: 'card', id: 'stats' }, h('h2', null, icon('bolt', 18), 'Your stats'));
  if (!s || !s.played) {
    card.append(h('p', { class: 'muted', style: { margin: 0 } }, 'Play the Daily to start a streak. Your first run each day counts.'));
    return card;
  }
  const winPct = Math.round((s.wins / s.played) * 100);
  card.append(
    h('div', { class: 'stat-grid' },
      stat(String(s.played), 'Played'),
      stat(`${winPct}%`, 'Made the gate'),
      stat(String(s.currentStreak), 'Streak', s.currentStreak >= 2 ? 'hot' : ''),
      stat(String(s.bestStreak), 'Best streak'),
      stat(formatScore(s.bestScore), 'Best score'),
    ),
    h('div', { class: 'recent', role: 'img', 'aria-label': `Last 14 days: ${s.recent.filter(Boolean).length} played` },
      s.recent.map((d) =>
        h('span', {
          class: `day ${d ? (d.won ? 'won' : d.cleared >= 6 ? 'mid' : 'out') : ''}`,
          title: d ? `${prettyDate(d.date)}: ${formatScore(d.score)} pts, ${d.cleared}/${d.total}${d.won ? ', through the gate' : ''}` : '',
        })),
    ),
    h('div', { class: 'legend' },
      h('span', { class: 'region' }, h('i', { class: 'day won' }), 'Through the gate'),
      h('span', { class: 'region' }, h('i', { class: 'day mid' }), '6+ cleared'),
      h('span', { class: 'region' }, h('i', { class: 'day out' }), 'Out early'),
    ),
  );
  return card;
}

const stat = (v: string, l: string, cls = '') => h('div', { class: `stat ${cls}` }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
