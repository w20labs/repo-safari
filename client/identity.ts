import { TOTAL_PLAYERS, padPlayerNumber } from '../shared/constants.ts';
import { save, store } from './prefs.ts';

export interface Me {
  id: string | null;
  num: number;
  name: string;
  team: string;
}

/** Local identity; replaced by the server's when it's reachable. */
const stored = store<Partial<Me>>('lcs-me', {});
export const me: Me = { id: stored.id ?? null, num: stored.num ?? 1 + Math.floor(Math.random() * TOTAL_PLAYERS), name: stored.name ?? '', team: stored.team ?? '' };
save('lcs-me', me);

export function setMe(next: Partial<Me>) {
  Object.assign(me, next);
  save('lcs-me', me);
  renderWho();
}

export const displayName = () => me.name || `Player ${padPlayerNumber(me.num)}`;

export function renderWho() {
  const el = document.getElementById('who');
  if (!el) return;
  el.innerHTML = '';
  const b = document.createElement('b');
  b.textContent = `#${padPlayerNumber(me.num)}`;
  el.append(b);
  if (me.name) {
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = me.name;
    el.append(n);
  }
}
