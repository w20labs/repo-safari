import { COLORS, COURSE, PHYS, REGION_COLORS, padPlayerNumber } from '../../shared/constants.ts';
import { fnv1a } from '../../shared/rng.ts';
import { prefs } from '../prefs.ts';
import type { Camera } from './camera.ts';
import type { Particles } from './particles.ts';
import type { World } from './world.ts';

const MONO = '"JetBrains Mono", ui-monospace, monospace';
const UI = '"Bricolage Grotesque", system-ui, sans-serif';
const DISPLAY = 'Bungee, "Bricolage Grotesque", sans-serif';

export interface Actor {
  x: number;
  y: number;
  facing: 1 | -1;
  num: number;
  suit: string;
  runT: number;
  airborne: boolean;
  /** shown above the head (bots show their number, arena players their name) */
  tag?: string;
  alpha?: number;
  me?: boolean;
}

export interface Scene {
  world: World;
  cam: Camera;
  actors: Actor[];
  particles: Particles;
  /** real seconds, for animation only */
  time: number;
  /** label platforms with repo names once cleared */
  revealCleared: boolean;
  unlockLeft: number;
}

/** Sizes the canvas backing store to its CSS box and returns the world->pixel scale. */
export function fitCanvas(canvas: HTMLCanvasElement, cam: Camera): number {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const scale = h / PHYS.viewH;
  cam.viewW = w / scale;
  return scale * dpr;
}

export function drawScene(ctx: CanvasRenderingContext2D, scale: number, s: Scene) {
  const { cam, world } = s;
  const t = prefs.reducedMotion ? 0 : s.time;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawCommitGraph(ctx, cam);

  ctx.setTransform(scale, 0, 0, scale, -cam.x * scale, -cam.y * scale);
  drawPads(ctx, world);
  drawPit(ctx, world, cam, t);
  if (world.hasGate) drawGate(ctx, world, s.unlockLeft, t);
  for (const p of world.course.platforms) {
    if (world.gone.has(p.i)) continue;
    const left = world.px[p.i];
    if (left > cam.x + cam.viewW + 40 || left + p.w < cam.x - 40) continue;
    drawPlatform(ctx, world, p.i, s, t);
  }
  for (const a of s.actors) if (!a.me) drawRunner(ctx, a, t);
  for (const a of s.actors) if (a.me) drawRunner(ctx, a, t);
  s.particles.draw(ctx);
}

// ---------- background ----------

function drawCommitGraph(ctx: CanvasRenderingContext2D, cam: Camera) {
  const LANE = 120;
  const ROW = 90;
  const ox = cam.x * 0.35;
  const oy = cam.y * 0.35;
  const firstLane = Math.floor(ox / LANE) - 1;
  const lanes = Math.ceil(cam.viewW / LANE) + 2;
  const firstRow = Math.floor(oy / ROW) - 1;
  const rows = Math.ceil(PHYS.viewH / ROW) + 2;
  ctx.lineWidth = 2;
  for (let l = firstLane; l < firstLane + lanes; l++) {
    const x = l * LANE - ox + 30;
    ctx.strokeStyle = 'rgba(38,44,66,0.55)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, PHYS.viewH);
    ctx.stroke();
    for (let r = firstRow; r < firstRow + rows; r++) {
      const h = fnv1a(`${l}:${r}`) / 4294967296;
      if (h > 0.4) continue;
      const y = r * ROW - oy + (h * 1000) % 40;
      if (h < 0.07) {
        ctx.strokeStyle = 'rgba(38,44,66,0.55)';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x, y + ROW * 0.5, x + LANE, y + ROW * 0.5, x + LANE, y + ROW);
        ctx.stroke();
      }
      ctx.fillStyle = h < 0.04 ? 'rgba(46,196,166,0.35)' : h < 0.06 ? 'rgba(255,62,138,0.3)' : 'rgba(58,66,96,0.8)';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawPads(ctx: CanvasRenderingContext2D, world: World) {
  const pads: [number, number, string][] = [
    [0, COURSE.startPadEnd, 'START'],
    [world.W - COURSE.endPadWidth, world.W, world.hasGate ? 'EXIT' : ''],
  ];
  for (const [x0, x1, label] of pads) {
    ctx.fillStyle = COLORS.panel;
    ctx.fillRect(x0, PHYS.floorY, x1 - x0, PHYS.worldH - PHYS.floorY);
    ctx.fillStyle = COLORS.teal;
    ctx.fillRect(x0, PHYS.floorY, x1 - x0, 4);
    ctx.fillStyle = COLORS.line;
    for (let x = x0 + 12; x < x1 - 12; x += 28) ctx.fillRect(x, PHYS.floorY + 18, 14, 2);
    if (label) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `600 14px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillText(label, x0 + 16, PHYS.floorY + 46);
    }
  }
}

function drawPit(ctx: CanvasRenderingContext2D, world: World, cam: Camera, t: number) {
  const x0 = Math.max(COURSE.startPadEnd, cam.x - 20);
  const x1 = Math.min(world.W - COURSE.endPadWidth, cam.x + cam.viewW + 20);
  if (x1 <= x0) return;
  const top = PHYS.floorY + 14;
  const g = ctx.createLinearGradient(0, top, 0, PHYS.worldH);
  g.addColorStop(0, '#4A0D24');
  g.addColorStop(1, '#16040B');
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, x1 - x0, PHYS.worldH - top + 40);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, top - 20, x1 - x0, PHYS.worldH);
  ctx.clip();
  ctx.font = `600 15px ${MONO}`;
  ctx.fillStyle = 'rgba(255,62,138,0.32)';
  ctx.textAlign = 'left';
  const text = '<<<<<<< merge conflict';
  const step = 250;
  const drift = (t * 18) % step;
  for (let x = Math.floor(x0 / step) * step - step; x < x1 + step; x += step) {
    ctx.fillText(text, x - drift, top + 50);
    ctx.fillText(text, x + step / 2 + drift, top + 80);
  }
  ctx.strokeStyle = COLORS.pink;
  ctx.lineWidth = 3;
  ctx.shadowColor = COLORS.pink;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += 8) {
    const y = top + 8 + Math.sin(x * 0.035 + t * 3) * 5 + Math.sin(x * 0.011 - t * 1.3) * 3;
    if (x === x0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawGate(ctx: CanvasRenderingContext2D, world: World, unlockLeft: number, t: number) {
  const g = world.gate();
  const open = world.gateOpen;
  ctx.save();
  if (open) {
    ctx.shadowColor = COLORS.teal;
    ctx.shadowBlur = 24 + Math.sin(t * 4) * 6;
    ctx.fillStyle = 'rgba(46,196,166,0.22)';
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = COLORS.sunken;
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.strokeStyle = COLORS.pink;
    ctx.lineWidth = 4;
    for (let x = g.x + 14; x < g.x + g.w - 6; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, g.y + 6);
      ctx.lineTo(x, g.y + g.h);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = open ? COLORS.teal : COLORS.line;
  ctx.lineWidth = 6;
  ctx.strokeRect(g.x, g.y, g.w, g.h);
  ctx.fillStyle = open ? COLORS.teal : COLORS.pink;
  ctx.font = `14px ${DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.fillText(open ? 'EXIT' : 'LOCKED', g.x + g.w / 2, g.y - 12);
  if (!open) {
    ctx.font = `600 12px ${MONO}`;
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`${unlockLeft} to go`, g.x + g.w / 2, g.y - 30);
  }
  ctx.restore();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function drawPlatform(ctx: CanvasRenderingContext2D, world: World, i: number, s: Scene, t: number) {
  const p = world.course.platforms[i];
  const crumbling = world.crumbling.has(i);
  const cleared = world.cleared.has(i);
  let x = world.px[i];
  const y = world.py[i];
  if (crumbling) x += Math.sin(s.time * 55 + i) * 3;
  const { w, h } = p;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 5);
  ctx.fillStyle = cleared ? '#173A2A' : COLORS.panel;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = REGION_COLORS[p.repo.region];
  ctx.fillRect(x, y, w, 5);
  ctx.restore();
  ctx.lineWidth = p.gold || cleared || crumbling ? 2.5 : 1.5;
  ctx.strokeStyle = crumbling ? COLORS.pink : cleared ? COLORS.green : p.gold ? COLORS.amber : COLORS.line;
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (cleared && s.revealCleared) {
    ctx.font = `700 13px ${UI}`;
    ctx.fillStyle = COLORS.green;
    ctx.fillText(fitText(ctx, p.repo.short, w - 12), x + w / 2, y + h / 2 + 2);
  } else {
    ctx.font = `700 14px ${MONO}`;
    ctx.fillStyle = p.mult >= 1.8 ? COLORS.lime : COLORS.amber;
    ctx.fillText(`×${p.mult.toFixed(1)}`, x + w / 2, y + h / 2 + 2);
  }
  ctx.textBaseline = 'alphabetic';
  if (crumbling) {
    ctx.font = `12px ${DISPLAY}`;
    ctx.fillStyle = COLORS.pink;
    ctx.fillText('CRUMBLING', x + w / 2, y - 10);
  } else if (p.gold && !cleared) {
    ctx.font = `600 11px ${MONO}`;
    ctx.fillStyle = COLORS.amber;
    ctx.fillText('GOLD · 8s', x + w / 2, y - 8 + (prefs.reducedMotion ? 0 : Math.sin(t * 3 + i) * 1.5));
  } else if (p.repo.rising && !cleared) {
    ctx.font = `600 11px ${MONO}`;
    ctx.fillStyle = COLORS.lime;
    ctx.fillText('RISING', x + w / 2, y - 8);
  }
  ctx.restore();
}

// ---------- characters ----------

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

export function drawRunner(ctx: CanvasRenderingContext2D, a: Actor, t: number) {
  const { x, facing } = a;
  const bob = !a.airborne && a.runT === 0 ? Math.sin(t * 2.4 + a.num) * 1.2 : 0;
  const y = a.y + bob;
  const swing = a.airborne ? 0.5 : a.runT > 0 ? Math.sin(a.runT * 15) * 0.7 : 0;
  ctx.save();
  ctx.globalAlpha = a.alpha ?? 1;
  ctx.translate(x, y);
  ctx.scale(facing, 1);

  // legs
  const pants = shade(a.suit, 0.72);
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(side * 5, -14);
    ctx.rotate(swing * side);
    ctx.fillStyle = pants;
    ctx.fillRect(-3.5, 0, 7, 11);
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(-3.5, 10, 9, 4);
    ctx.restore();
  }
  // torso
  ctx.fillStyle = a.suit;
  ctx.beginPath();
  ctx.roundRect(-12, -31, 24, 19, 5);
  ctx.fill();
  ctx.fillStyle = 'rgba(236,239,247,0.85)';
  ctx.fillRect(-12, -30, 2, 17);
  ctx.fillRect(10, -30, 2, 17);
  // arm
  ctx.save();
  ctx.translate(2, -28);
  ctx.rotate(-swing * 0.8);
  ctx.fillStyle = shade(a.suit, 0.85);
  ctx.fillRect(-3, 0, 6, 12);
  ctx.restore();
  // number patch (text un-mirrored)
  ctx.fillStyle = COLORS.text;
  ctx.fillRect(-8, -27, 16, 9);
  ctx.save();
  ctx.scale(facing, 1);
  ctx.fillStyle = COLORS.bg;
  ctx.font = `700 7px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.fillText(padPlayerNumber(a.num), 0, -20);
  ctx.restore();
  // head
  ctx.fillStyle = '#E9C9AE';
  ctx.beginPath();
  ctx.arc(0, -38, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2A2233';
  ctx.beginPath();
  ctx.arc(0, -40, 7, Math.PI * 1.05, Math.PI * 1.95);
  ctx.fill();
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(3, -39, 2, 2);
  ctx.restore();

  if (a.tag) {
    ctx.save();
    ctx.globalAlpha = a.alpha ?? 1;
    ctx.font = `600 11px ${MONO}`;
    ctx.textAlign = 'center';
    const w = ctx.measureText(a.tag).width + 10;
    ctx.fillStyle = 'rgba(11,14,25,0.85)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 64, w, 16, 4);
    ctx.fill();
    ctx.fillStyle = a.me ? COLORS.teal : COLORS.muted;
    ctx.fillText(a.tag, x, y - 52);
    ctx.restore();
  }
}
