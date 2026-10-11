import { REGION_COLORS, REGION_NAMES } from '../../shared/constants.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

export interface MenuOpts {
  playerNum: string;
  name: string;
  team: string;
  dailyTag: string;
  onName(name: string): void;
  onTeam(team: string): void;
  onDaily(): void;
  onPractice(): void;
  onArena(): void;
}

export function menuPanel(o: MenuOpts): HTMLElement {
  const nameInput = h('input', {
    class: 'input', id: 'name', maxlength: 24, autocomplete: 'nickname', placeholder: `Player ${o.playerNum}`, value: o.name,
  }) as HTMLInputElement;
  nameInput.addEventListener('change', () => o.onName(nameInput.value.trim()));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
  });

  const card = (cls: string, ic: string, title: string, sub: string, tag: string, onClick: () => void) =>
    h('button', { type: 'button', class: `mode-card ${cls}`, onclick: onClick, 'data-mode': cls },
      h('span', { class: 'mc-title' }, icon(ic, 20), title),
      h('span', { class: 'mc-sub' }, sub),
      tag ? h('span', { class: 'mc-tag' }, tag) : null,
    );

  const teamInput = h('input', {
    class: 'input', id: 'team', maxlength: 24, autocomplete: 'organization', placeholder: 'e.g. vercel', value: o.team, spellcheck: 'false',
  }) as HTMLInputElement;
  teamInput.addEventListener('change', () => o.onTeam(teamInput.value.trim()));
  teamInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') teamInput.blur();
  });

  return h('div', { class: 'panel wide menu' },
    h('div', null,
      h('div', { class: 'eyebrow' }, `456 players · one wrong answer and you're out`),
      h('h1', { class: 'title', style: { marginTop: '10px' } }, 'Last Commit', h('span', { class: 't2' }, 'Standing')),
      h('p', { class: 'lede' }, 'Every platform is a GitHub repo. Land on one and answer a question about it. A wrong answer, running out of time or falling into the merge conflict knocks you out.'),
    ),
    h('div', { class: 'fields' },
      h('div', { class: 'field' },
        h('label', { for: 'name' }, 'Display name (optional)'),
        nameInput,
      ),
      h('div', { class: 'field' },
        h('label', { for: 'team' }, 'Team or company (optional)'),
        teamInput,
      ),
    ),
    h('p', { class: 'muted', style: { margin: '-8px 0 0', fontSize: '13px' } }, `Your name shows on the leaderboard. A team's score is its best 3 Daily runs added up.`),
    h('div', { class: 'modes' },
      card('daily', 'calendar', 'Daily', 'Same 12 platforms for everyone today. Your first run is the official one.', o.dailyTag, o.onDaily),
      card('practice', 'target', 'Practice', 'Every repo, random order, other players wandering around.', '', o.onPractice),
      card('arena', 'users', 'Arena', 'Live rooms with friends. Six bells. Be on a platform when each one rings.', '', o.onArena),
    ),
    h('div', { class: 'keys' },
      h('span', null, h('kbd', null, '←'), ' ', h('kbd', null, '→'), ' move'),
      h('span', null, h('kbd', null, '↑'), ' / ', h('kbd', null, 'Space'), ' jump, twice for a double jump'),
      h('span', null, h('kbd', null, '↓'), ' drop through'),
      h('span', null, h('kbd', null, '1'), '–', h('kbd', null, '4'), ' answer'),
    ),
  );
}

export function howToCard(): HTMLElement {
  return h('div', { class: 'card' },
    h('h2', null, 'How it works'),
    h('ol', { class: 'howto' },
      h('li', null, 'Run and jump across the platforms. Each one is a ', h('b', null, 'GitHub repo'), '.'),
      h('li', null, 'Land on a new platform and the world freezes for ', h('b', null, 'one question'), '. 12 seconds, 8 on gold.'),
      h('li', null, 'Right answer: the platform turns green and shows its name. Higher platforms pay more (', h('b', null, '×1.0 to ×2.0'), ').'),
      h('li', null, 'Wrong answer, timeout or a fall into the pit and you are ', h('b', null, 'eliminated'), '.'),
      h('li', null, 'Clear enough platforms to open the ', h('b', null, 'exit gate'), ' for a +500 bonus.'),
    ),
    h('div', { class: 'legend' },
      Object.entries(REGION_NAMES).map(([k, v]) =>
        h('span', { class: 'region' }, h('i', { style: { background: REGION_COLORS[k] } }), v)),
    ),
  );
}
