import { padPlayerNumber } from '../../shared/constants.ts';
import { prettyDate } from '../../shared/rng.ts';
import { formatScore } from '../../shared/scoring.ts';
import { api, type BoardResponse, type BoardRow } from '../net/api.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

const who = (r: BoardRow) => r.name || `Player ${padPlayerNumber(r.num)}`;

function row(r: BoardRow) {
  return h('tr', { class: r.me ? 'me' : '' },
    h('td', { class: 'rank' }, String(r.rank)),
    h('td', { class: 'who' }, who(r), r.me ? ' (you)' : ''),
    h('td', { class: 'n' }, `${r.cleared}/${r.total}`),
    h('td', { class: 'n' }, formatScore(r.score)),
  );
}

export function boardTable(b: BoardResponse): HTMLElement {
  const rows = b.rows.map(row);
  if (b.me && !b.rows.some((r) => r.me)) rows.push(h('tr', null, h('td', { colspan: 4, class: 'muted', style: { textAlign: 'center', padding: '2px' } }, '…')), row(b.me));
  return h('table', { class: 'lb' },
    h('caption', { class: 'sr-only' }, `Daily leaderboard for ${prettyDate(b.date)}`),
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Player'), h('th', { class: 'n' }, 'Cleared'), h('th', { class: 'n' }, 'Score'))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'No official runs yet today. Be the first.'))),
  );
}

/** The "Today's top 10" card shown under the stage. */
export async function leaderboardCard(date: string): Promise<HTMLElement> {
  const card = h('div', { class: 'card', id: 'leaderboard' },
    h('h2', null, icon('trophy', 18), `Today's top 10`, h('span', { class: 'mono muted', style: { marginLeft: 'auto', fontSize: '12px' } }, prettyDate(date))),
  );
  try {
    const b = await api.leaderboard(date);
    card.append(boardTable(b));
    if (b.players > 0) card.append(h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, `${b.players} official run${b.players === 1 ? '' : 's'} today. Scores reset at 00:00 UTC.`));
  } catch {
    card.append(h('p', { class: 'muted' }, 'The leaderboard is offline right now.'));
  }
  return card;
}
