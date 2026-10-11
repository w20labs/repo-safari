import { ANSWER_REVEAL_MS, REGION_COLORS, REGION_NAMES } from '../../shared/constants.ts';
import { KIND_LABELS } from '../../shared/questions.ts';
import type { Question, Region } from '../../shared/types.ts';
import { isTyping } from '../game/input.ts';
import { h } from './dom.ts';
import { announce, showOverlay } from './overlay.ts';
import { sfx } from '../sound.ts';

export interface QuestionOpts {
  question: Omit<Question, 'answer'>;
  region: Region;
  mult: number;
  gold?: boolean;
  /** platform number shown as "#8" */
  platformNo?: number;
  totalMs: number;
  /** ms remaining right now (solo: from local clock; arena: from server clock) */
  msLeft: () => number;
  /** called once with the chosen index, or null on timeout */
  onPick: (choice: number | null, secondsLeft: number) => void;
}

export interface QuestionHandle {
  /** highlight the right answer (and a wrong pick); resolves after the reveal pause */
  reveal(answer: number, note?: string): Promise<void>;
  setNote(text: string): void;
  close(): void;
}

export function openQuestion(o: QuestionOpts): QuestionHandle {
  const q = o.question;
  let picked: number | null = null;
  let done = false;
  let raf = 0;

  const bar = h('div', { class: 'timer-bar' });
  const timer = h('div', { class: 'timer', role: 'progressbar', 'aria-label': 'Time left', 'aria-valuemin': 0, 'aria-valuemax': Math.round(o.totalMs / 1000) }, bar);
  const secs = h('span', { class: 'secs' });
  const note = h('div', { class: 'q-note', 'aria-live': 'polite' });

  const buttons = q.options.map((text, i) =>
    h('button', { type: 'button', class: 'opt', 'data-i': i, onclick: () => pick(i) }, h('span', { class: 'k', 'aria-hidden': 'true' }, String(i + 1)), h('span', null, text)),
  );

  const panel = h(
    'div',
    { class: 'panel question', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'q-prompt' },
    h(
      'div',
      { class: 'q-head' },
      h(
        'div',
        { class: 'eyebrow' },
        h('span', { class: 'q-kind' }, KIND_LABELS[q.kind]),
        o.platformNo ? h('span', null, `#${o.platformNo}`) : null,
        h('span', { class: 'region' }, h('i', { style: { background: REGION_COLORS[o.region] } }), REGION_NAMES[o.region]),
      ),
      h('span', { class: `q-mult ${o.gold ? 'gold' : ''}` }, `${o.gold ? 'GOLD ' : ''}×${o.mult.toFixed(1)}`),
    ),
    h('h2', { class: 'q-prompt', id: 'q-prompt' }, q.prompt),
    q.clue ? h('p', { class: 'q-clue' }, q.clue) : null,
    timer,
    h('div', { class: 'timer-meta' }, h('span', null, 'Answer with 1–4 or tap'), secs),
    h('div', { class: `options ${q.layout === 'column' ? 'column' : ''}` }, buttons),
    note,
  );

  function pick(i: number | null) {
    if (picked !== null || done) return;
    picked = i ?? -1;
    for (const b of buttons) b.disabled = true;
    if (i !== null) buttons[i].classList.add('picked');
    o.onPick(i, Math.max(0, o.msLeft()) / 1000);
  }

  function onKey(e: KeyboardEvent) {
    if (isTyping() || done) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      pick(n - 1);
    }
  }
  window.addEventListener('keydown', onKey);

  let lastSecond = Math.ceil(o.msLeft() / 1000);
  function frame() {
    const left = Math.max(0, o.msLeft());
    const sec = Math.ceil(left / 1000);
    if (sec !== lastSecond && picked === null && sec > 0 && sec <= 4) sfx.tick(sec <= 2);
    lastSecond = sec;
    bar.style.transform = `scaleX(${left / o.totalMs})`;
    timer.classList.toggle('low', left < 4000);
    timer.setAttribute('aria-valuenow', String(Math.ceil(left / 1000)));
    secs.textContent = `${(left / 1000).toFixed(1)}s`;
    if (left <= 0 && picked === null) pick(null);
    if (!done) raf = requestAnimationFrame(frame);
  }

  showOverlay(panel);
  sfx.question();
  announce(`${KIND_LABELS[q.kind]} question. ${q.prompt} ${q.clue ?? ''}`);
  buttons[0].focus({ preventScroll: true });
  frame();

  return {
    reveal(answer, text) {
      cancelAnimationFrame(raf);
      buttons.forEach((b, i) => {
        b.disabled = true;
        if (i === answer) b.classList.add('correct');
        else if (i === picked) b.classList.add('wrong');
      });
      const ok = picked === answer;
      if (ok) sfx.correct();
      else sfx.wrong();
      const msg = text ?? (picked === -1 || picked === null ? 'Time is up.' : ok ? 'Correct.' : `Wrong. It was ${q.options[answer]}.`);
      note.textContent = msg;
      announce(msg);
      return new Promise((r) => setTimeout(r, ANSWER_REVEAL_MS));
    },
    setNote(text) {
      note.textContent = text;
    },
    close() {
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    },
  };
}
