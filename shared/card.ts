import { COLORS, padPlayerNumber } from './constants.ts';
import { fnv1a } from './rng.ts';
import { formatScore, type Square } from './scoring.ts';
import type { ResultSummary } from './share.ts';

export const CARD_W = 1200;
export const CARD_H = 630;

const MONO = '"JetBrains Mono", monospace';
const UI = '"Bricolage Grotesque", sans-serif';
const DISPLAY = 'Bungee, sans-serif';

/** The subset of the 2D context API used here, so the server's skia canvas fits too. */
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'font' | 'textAlign' | 'textBaseline' | 'globalAlpha' | 'lineJoin'
  | 'fillRect' | 'strokeRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'closePath' | 'fill' | 'stroke'
  | 'fillText' | 'measureText' | 'save' | 'restore' | 'translate' | 'rotate' | 'roundRect' | 'bezierCurveTo'
>;

function fitFont(ctx: Ctx2D, text: string, family: string, weight: string, size: number, max: number): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 12 && ctx.measureText(text).width > max) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

function drawSquare(ctx: Ctx2D, kind: Square, x: number, y: number, s: number) {
  const pad = s * 0.12;
  const inner = s - pad * 2;
  ctx.lineWidth = Math.max(2, s * 0.08);
  switch (kind) {
    case 'cleared':
      ctx.fillStyle = COLORS.teal;
      ctx.beginPath();
      ctx.roundRect(x + pad, y + pad, inner, inner, s * 0.12);
      ctx.fill();
      break;
    case 'gold': {
      const c = s / 2;
      ctx.fillStyle = COLORS.amber;
      ctx.beginPath();
      ctx.moveTo(x + c, y + pad * 0.6);
      ctx.lineTo(x + s - pad * 0.6, y + c);
      ctx.lineTo(x + c, y + s - pad * 0.6);
      ctx.lineTo(x + pad * 0.6, y + c);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'died':
      ctx.strokeStyle = COLORS.pink;
      ctx.lineWidth = Math.max(3, s * 0.14);
      ctx.beginPath();
      ctx.moveTo(x + pad * 1.6, y + pad * 1.6);
      ctx.lineTo(x + s - pad * 1.6, y + s - pad * 1.6);
      ctx.moveTo(x + s - pad * 1.6, y + pad * 1.6);
      ctx.lineTo(x + pad * 1.6, y + s - pad * 1.6);
      ctx.stroke();
      break;
    case 'empty':
      ctx.strokeStyle = '#3A4364';
      ctx.beginPath();
      ctx.roundRect(x + pad + 1, y + pad + 1, inner - 2, inner - 2, s * 0.12);
      ctx.stroke();
      break;
  }
}

/** Draws the 1200x630 share card. Fonts must already be loaded/registered. */
export function drawCard(ctx: Ctx2D, r: ResultSummary) {
  const accent = r.standing ? COLORS.teal : COLORS.pink;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // commit-graph texture
  ctx.lineWidth = 2;
  for (let l = 0; l < 11; l++) {
    const x = 60 + l * 112;
    ctx.strokeStyle = 'rgba(38,44,66,0.5)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CARD_H);
    ctx.stroke();
    for (let row = 0; row < 8; row++) {
      const hsh = fnv1a(`card${l}:${row}`) / 4294967296;
      if (hsh > 0.35) continue;
      ctx.fillStyle = hsh < 0.05 ? 'rgba(46,196,166,0.3)' : 'rgba(58,66,96,0.6)';
      ctx.beginPath();
      ctx.arc(x, 40 + row * 80 + hsh * 30, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // frame
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(24, 24, CARD_W - 48, CARD_H - 48, 22);
  ctx.stroke();

  // title + mode/date
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `400 34px ${DISPLAY}`;
  ctx.fillStyle = COLORS.text;
  ctx.fillText('LAST COMMIT', 64, 98);
  const w1 = ctx.measureText('LAST COMMIT ').width;
  ctx.fillStyle = COLORS.pink;
  ctx.fillText('STANDING', 64 + w1, 98);
  ctx.textAlign = 'right';
  ctx.font = `600 24px ${MONO}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`${r.mode.toUpperCase()} · ${r.date}`, CARD_W - 64, 96);

  // player number
  ctx.textAlign = 'left';
  ctx.font = `700 22px ${MONO}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(r.name ? `PLAYER · ${r.name}`.slice(0, 40) : 'PLAYER', 64, 166);
  ctx.font = `400 168px ${DISPLAY}`;
  ctx.fillStyle = accent;
  ctx.fillText(padPlayerNumber(r.playerNum), 56, 320);

  // status stamp
  ctx.save();
  const stamp = r.standing ? 'STILL STANDING' : 'ELIMINATED';
  ctx.translate(880, 210);
  ctx.rotate(-0.08);
  const fs = fitFont(ctx, stamp, DISPLAY, '400', 50, 440);
  const sw = ctx.measureText(stamp).width + 44;
  const sh = fs + 34;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(-sw / 2, -sh / 2, sw, sh, 12);
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(stamp, 0, 4);
  ctx.restore();

  // score + stat line
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `700 64px ${MONO}`;
  ctx.fillStyle = COLORS.amber;
  const scoreText = formatScore(r.score);
  ctx.fillText(scoreText, CARD_W - 120, 340);
  ctx.font = `600 26px ${MONO}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText('pts', CARD_W - 64, 340);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(r.statLine, CARD_W - 64, 382);

  // squares row
  const n = Math.max(1, r.squares.length);
  const avail = CARD_W - 128;
  const size = Math.min(64, Math.floor(avail / n));
  const rowW = size * n;
  const sx = 64 + (avail - rowW) / 2;
  r.squares.forEach((sq, i) => drawSquare(ctx, sq, sx + i * size, 410, size));

  // footer band
  ctx.fillStyle = COLORS.panel;
  ctx.beginPath();
  ctx.roundRect(25, 510, CARD_W - 50, 95, [0, 0, 21, 21]);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillRect(25, 510, CARD_W - 50, 3);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const footer = r.standing ? 'Can you outlast me?' : r.outLine;
  fitFont(ctx, footer, UI, '700', 34, CARD_W - 360);
  ctx.fillStyle = COLORS.text;
  ctx.fillText(footer, 64, 560);
  ctx.textAlign = 'right';
  ctx.font = `600 20px ${MONO}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(r.standing ? 'Your turn.' : 'Can you outlast me?', CARD_W - 64, 560);
}
