import { $, h } from './dom.ts';

let lastKey = '';
let lastAt = 0;

/** Shows a short message over the stage. Repeats of the same key within `throttleMs` are dropped. */
export function toast(text: string, tone: 'teal' | 'pink' | 'amber' = 'teal', opts: { key?: string; throttleMs?: number; ms?: number } = {}) {
  const now = performance.now();
  const key = opts.key ?? text;
  if (key === lastKey && now - lastAt < (opts.throttleMs ?? 0)) return;
  lastKey = key;
  lastAt = now;
  const box = $('#toasts');
  const el = h('div', { class: `toast ${tone}` }, text);
  box.append(el);
  while (box.children.length > 3) box.firstElementChild?.remove();
  setTimeout(() => el.remove(), opts.ms ?? 2600);
}

export function clearToasts() {
  $('#toasts').replaceChildren();
}
