import { $, h } from './dom.ts';

export interface HudChip {
  text: string | Node;
  cls?: string;
  label?: string;
}

/** HUD chips are only rebuilt when their content changes, so per-frame calls are cheap. */
let lastLeft = '';
let lastRight = '';
let centerEl: HTMLElement | null = null;

function render(chips: HudChip[]): HTMLElement[] {
  return chips.map((c) => h('span', { class: `chip ${c.cls ?? ''}`, 'aria-label': c.label }, c.text));
}

const sig = (chips: HudChip[]) => chips.map((c) => `${c.cls}|${typeof c.text === 'string' ? c.text : (c.text as HTMLElement).textContent}`).join('/');

export function setHud(left: HudChip[], right: HudChip[]) {
  const hud = $('#hud');
  const l = sig(left);
  const r = sig(right);
  if (l === lastLeft && r === lastRight && hud.childElementCount) return;
  lastLeft = l;
  lastRight = r;
  centerEl = null;
  hud.replaceChildren(h('div', { class: 'hud-group' }, render(left)), h('div', { class: 'hud-group right' }, render(right)));
}

/** A centered pill (Arena bell countdown). Updated in place every frame. */
export function setHudCenter(text: string, urgent: boolean) {
  const hud = $('#hud');
  if (!centerEl || !hud.contains(centerEl)) {
    centerEl = h('div', { class: 'hud-center' }, h('span', { class: 'chip bell' }));
    hud.append(centerEl);
  }
  const chip = centerEl.firstElementChild as HTMLElement;
  if (chip.textContent !== text) chip.textContent = text;
  chip.classList.toggle('urgent', urgent);
}

export function clearHud() {
  lastLeft = lastRight = '';
  centerEl = null;
  $('#hud').replaceChildren();
}

/** "<b>value</b> label" content for a chip. */
export function kv(value: string | number, label: string): HTMLElement {
  return h('span', null, h('b', null, String(value)), ` ${label}`);
}
