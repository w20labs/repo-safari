import { CARD_H, CARD_W, drawCard } from '../../shared/card.ts';
import { shareText, type ResultSummary } from '../../shared/share.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { announce, showOverlay } from './overlay.ts';
import { toast } from './toast.ts';

export interface ResultAction {
  label: string;
  icon?: string;
  primary?: boolean;
  onClick: () => void;
}

export interface ResultsOpts {
  summary: ResultSummary;
  reason: string;
  stats: { label: string; value: string; cls?: string }[];
  /** last line of the share text */
  url: string;
  /** permanent link to this run's card page, when there is one */
  permalink?: string;
  note?: string;
  extra?: HTMLElement | null;
  actions: ResultAction[];
}

export async function ensureCardFonts() {
  if (!('fonts' in document)) return;
  await Promise.all(
    ['400 40px Bungee', '700 30px "Bricolage Grotesque"', '700 30px "JetBrains Mono"', '600 30px "JetBrains Mono"'].map((f) =>
      document.fonts.load(f).catch(() => undefined),
    ),
  );
}

export async function renderCard(summary: ResultSummary): Promise<HTMLCanvasElement> {
  await ensureCardFonts();
  const c = document.createElement('canvas');
  c.width = CARD_W;
  c.height = CARD_H;
  drawCard(c.getContext('2d')!, summary);
  return c;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied. Paste it anywhere.');
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }) as HTMLTextAreaElement;
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? 'Copied. Paste it anywhere.' : 'Copy failed. Select the text and copy it yourself.', ok ? 'teal' : 'pink');
  }
}

export function showResults(o: ResultsOpts) {
  const s = o.summary;
  const text = shareText(s, o.url);
  const preview = h('canvas', { class: 'card-preview', width: CARD_W, height: CARD_H, role: 'img', 'aria-label': 'Result card preview' });
  void renderCard(s).then((c) => preview.getContext('2d')!.drawImage(c, 0, 0));

  const download = async () => {
    const c = await renderCard(s);
    c.toBlob((blob) => {
      if (!blob) return;
      const a = h('a', { href: URL.createObjectURL(blob), download: `last-commit-standing-${s.date}.png` });
      document.body.append(a);
      a.click();
      setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 1000);
    }, 'image/png');
  };

  const actions = o.actions.map((a, i) =>
    h('button', { type: 'button', class: `btn ${a.primary ? 'primary' : ''}`, onclick: a.onClick, 'data-first': i === 0 ? '' : undefined }, a.icon ? icon(a.icon) : null, a.label),
  );

  const panel = h(
    'div',
    { class: 'panel wide results', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'res-stamp' },
    h('div', { class: 'eyebrow', style: { justifyContent: 'center' } }, `${s.mode} · ${s.date}`),
    h('div', { class: `stamp ${s.standing ? 'ok' : ''}`, id: 'res-stamp' }, s.standing ? 'STILL STANDING' : 'ELIMINATED'),
    h('p', { class: 'reason' }, o.reason),
    o.note ? h('p', { class: 'muted', style: { margin: '6px 0 0', fontSize: '14px' } }, o.note) : null,
    h(
      'div',
      { class: 'stats' },
      o.stats.map((st) => h('div', { class: `stat ${st.cls ?? ''}` }, h('div', { class: 'v' }, st.value), h('div', { class: 'l' }, st.label))),
    ),
    h(
      'div',
      { class: 'share' },
      h('pre', { class: 'share-text', 'aria-label': 'Result text to share' }, text),
      h(
        'div',
        { class: 'share-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => copy(text) }, icon('copy', 16), 'Copy result'),
        h('button', { type: 'button', class: 'btn small', onclick: download }, icon('download', 16), 'Download card'),
        o.permalink ? h('button', { type: 'button', class: 'btn small', onclick: () => copy(o.permalink!) }, icon('link', 16), 'Copy link') : null,
        typeof navigator.share === 'function'
          ? h('button', { type: 'button', class: 'btn small', onclick: () => navigator.share({ text: text.split('\n').slice(0, -1).join('\n'), url: o.permalink ?? o.url }).catch(() => undefined) }, 'Share…')
          : null,
      ),
      preview,
    ),
    o.extra ?? null,
    h('div', { class: 'result-actions' }, actions),
  );
  showOverlay(panel);
  announce(`${s.standing ? 'Still standing' : 'Eliminated'}. ${o.reason}. ${s.score} points.`);
  actions[0]?.focus({ preventScroll: true });
}
