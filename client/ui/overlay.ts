import { $ } from './dom.ts';

/** Replaces the stage overlay content. `clear` keeps the world visible and clickable around the panel. */
export function showOverlay(content: HTMLElement, opts: { clear?: boolean } = {}) {
  const o = $('#overlay');
  o.hidden = false;
  o.classList.toggle('clear', !!opts.clear);
  o.replaceChildren(content);
  o.scrollTop = 0;
}

export function hideOverlay() {
  const o = $('#overlay');
  o.hidden = true;
  o.replaceChildren();
}

/** Screen-reader announcement. */
export function announce(text: string) {
  const live = $('#live');
  live.textContent = '';
  requestAnimationFrame(() => (live.textContent = text));
}
