import { padPlayerNumber } from '../../shared/constants.ts';
import { prettyDate } from '../../shared/rng.ts';
import { formatScore } from '../../shared/scoring.ts';
import { me } from '../identity.ts';
import { api, type BoardResponse, type BoardRow, type TeamsResponse } from '../net/api.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { toast } from './toast.ts';

const who = (r: BoardRow) => r.name || `Player ${padPlayerNumber(r.num)}`;

function row(r: BoardRow, showTeam: boolean) {
  return h('tr', { class: r.me ? 'me' : '' },
    h('td', { class: 'rank' }, String(r.rank)),
    h('td', { class: 'who' }, who(r), r.me ? ' (you)' : '', showTeam && r.team ? h('span', { class: 'teamtag' }, r.team) : null),
    h('td', { class: 'n' }, `${r.cleared}/${r.total}`),
    h('td', { class: 'n' }, formatScore(r.score)),
  );
}

export function boardTable(b: BoardResponse, opts: { showTeam?: boolean; empty?: string } = {}): HTMLElement {
  const rows = b.rows.map((r) => row(r, !!opts.showTeam));
  if (b.me && !b.rows.some((r) => r.me)) rows.push(h('tr', null, h('td', { colspan: 4, class: 'muted', style: { textAlign: 'center', padding: '2px' } }, '…')), row(b.me, !!opts.showTeam));
  return h('table', { class: 'lb' },
    h('caption', { class: 'sr-only' }, `Daily leaderboard for ${prettyDate(b.date)}`),
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Player'), h('th', { class: 'n' }, 'Cleared'), h('th', { class: 'n' }, 'Score'))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'empty' }, opts.empty ?? 'No official runs yet today. Be the first.'))),
  );
}

function teamsTable(t: TeamsResponse): HTMLElement {
  const tr = (r: TeamsResponse['rows'][number]) =>
    h('tr', { class: r.mine ? 'me' : '' },
      h('td', { class: 'rank' }, String(r.rank)),
      h('td', { class: 'who' }, r.team, r.mine ? ' (yours)' : ''),
      h('td', { class: 'n' }, String(r.players)),
      h('td', { class: 'n' }, formatScore(r.score)));
  const rows = t.rows.map(tr);
  if (t.me && !t.rows.some((r) => r.mine)) rows.push(tr(t.me));
  return h('table', { class: 'lb' },
    h('caption', { class: 'sr-only' }, 'Team leaderboard'),
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Team'), h('th', { class: 'n' }, 'Players'), h('th', { class: 'n' }, 'Best 3'))),
    h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'No teams on the board yet. Set a team in the menu and invite your coworkers.'))),
  );
}

export const teamInviteLink = (team: string) => `${location.origin}/?team=${encodeURIComponent(team)}`;

type Tab = 'all' | 'team' | 'teams';

/** The leaderboard card under the stage, with Everyone / My team / Teams tabs. */
export async function leaderboardCard(date: string, initial: Tab = 'all'): Promise<HTMLElement> {
  const body = h('div', { role: 'tabpanel', id: 'lb-panel' });
  const tabs: [Tab, string][] = [['all', 'Everyone'], ...(me.team ? ([['team', `Team ${me.team}`]] as [Tab, string][]) : []), ['teams', 'Teams']];
  const buttons = tabs.map(([id, label]) =>
    h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', 'aria-controls': 'lb-panel', 'data-tab': id, onclick: () => show(id) }, label));
  const card = h('div', { class: 'card', id: 'leaderboard' },
    h('h2', null, icon('trophy', 18), `Today's top 10`, h('span', { class: 'mono muted', style: { marginLeft: 'auto', fontSize: '12px' } }, prettyDate(date))),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Leaderboard' }, buttons),
    body,
  );

  async function show(tab: Tab) {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    try {
      if (tab === 'all') {
        const b = await api.leaderboard(date);
        body.replaceChildren(boardTable(b, { showTeam: true }), foot(`${b.players} official run${b.players === 1 ? '' : 's'} today. Scores reset at 00:00 UTC.`));
      } else if (tab === 'team') {
        const b = await api.teamBoard(date, me.team);
        const link = teamInviteLink(me.team);
        body.replaceChildren(
          boardTable(b, { empty: 'Nobody on your team has played today yet.' }),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            h('button', { type: 'button', class: 'btn small', onclick: () => navigator.clipboard.writeText(link).then(() => toast('Team invite link copied.')).catch(() => toast(link)) }, icon('link', 16), 'Copy team invite link')),
        );
      } else {
        const t = await api.teams(date);
        body.replaceChildren(teamsTable(t), foot(`${t.teams} team${t.teams === 1 ? '' : 's'} today. A team's score is its best 3 runs added up.`));
      }
    } catch {
      body.replaceChildren(h('p', { class: 'muted' }, 'The leaderboard is offline right now.'));
    }
  }
  await show(tabs.some(([id]) => id === initial) ? initial : 'all');
  return card;
}

const foot = (text: string) => h('p', { class: 'muted', style: { fontSize: '12px', margin: '10px 0 0' } }, text);
