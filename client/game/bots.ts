import { COURSE, PHYS } from '../../shared/constants.ts';
import type { Actor } from './render.ts';
import type { World } from './world.ts';

const PAD = -2;

interface Bot {
  num: number;
  /** platform index, or PAD for the start pad */
  on: number;
  /** offset from the platform's left edge (or absolute x on the pad) */
  local: number;
  wait: number;
  hop: { fromX: number; fromY: number; to: number; toLocal: number; t: number; dur: number; height: number } | null;
  facing: 1 | -1;
  walk: number;
  anim: number;
}

/** Wandering background players for Practice. They hop between neighbouring platforms. */
export class Bots {
  private bots: Bot[] = [];

  constructor(nums: number[], private world: World) {
    this.bots = nums.map((num, k) => {
      const onPlatform = k >= 4 && world.course.platforms.length > k - 3;
      const on = onPlatform ? k - 4 : PAD;
      const w = onPlatform ? world.course.platforms[on].w : COURSE.startPadEnd;
      return { num, on, local: onPlatform ? 20 + Math.random() * (w - 40) : 40 + k * 55, wait: Math.random() * 2, hop: null, facing: 1, walk: 0, anim: 0 };
    });
  }

  get alive() {
    return this.bots.length;
  }

  private pos(on: number, local: number) {
    if (on === PAD) return { x: local, y: PHYS.floorY };
    return { x: this.world.px[on] + local, y: this.world.py[on] };
  }

  update(dt: number) {
    const n = this.world.course.platforms.length;
    for (const b of this.bots) {
      if (b.hop) {
        b.hop.t += dt;
        if (b.hop.t >= b.hop.dur) {
          b.on = b.hop.to;
          b.local = b.hop.toLocal;
          b.hop = null;
          b.wait = 0.8 + Math.random() * 2.2;
        }
        continue;
      }
      b.wait -= dt;
      b.walk = 0;
      const width = b.on === PAD ? COURSE.startPadEnd : this.world.course.platforms[b.on].w;
      if (b.wait > 0.6 && Math.random() < 0.01) b.facing = b.facing === 1 ? -1 : 1;
      if (b.wait > 0.3 && b.wait < 1.2) {
        const next = b.local + b.facing * 40 * dt;
        if (next > 14 && next < width - 14) {
          b.local = next;
          b.walk = 1;
          b.anim += dt;
        }
      }
      if (b.wait <= 0) {
        const r = Math.random();
        const cur = b.on === PAD ? -1 : b.on;
        let to = r < 0.6 ? cur + 1 : r < 0.85 ? cur - 1 : cur;
        to = Math.max(-1, Math.min(n - 1, to));
        const target = to === -1 ? PAD : to;
        if (target === PAD && b.on === PAD) {
          b.wait = 1;
          continue;
        }
        const from = this.pos(b.on, b.local);
        const toW = target === PAD ? COURSE.startPadEnd : this.world.course.platforms[target].w;
        const toLocal = target === PAD ? 120 + Math.random() * 180 : 16 + Math.random() * (toW - 32);
        const toPos = this.pos(target, toLocal);
        b.facing = toPos.x >= from.x ? 1 : -1;
        b.hop = { fromX: from.x, fromY: from.y, to: target, toLocal, t: 0, dur: 0.75, height: 110 + Math.max(0, from.y - toPos.y) };
      }
    }
  }

  actors(): Actor[] {
    return this.bots.map((b) => {
      let x: number;
      let y: number;
      if (b.hop) {
        const u = b.hop.t / b.hop.dur;
        const to = this.pos(b.hop.to, b.hop.toLocal);
        x = b.hop.fromX + (to.x - b.hop.fromX) * u;
        y = b.hop.fromY + (to.y - b.hop.fromY) * u - 4 * b.hop.height * u * (1 - u);
      } else ({ x, y } = this.pos(b.on, b.local));
      return { x, y, facing: b.facing, num: b.num, suit: '#56707A', runT: b.walk ? b.anim : 0, airborne: !!b.hop, tag: String(b.num).padStart(3, '0'), alpha: 0.7 };
    });
  }

  /** Removes the bot closest to (x, y) and returns where it was. */
  eliminateNearest(x: number, y: number): { num: number; x: number; y: number } | null {
    let best = -1;
    let bestD = Infinity;
    this.actors().forEach((a, i) => {
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) return null;
    const a = this.actors()[best];
    const [b] = this.bots.splice(best, 1);
    return { num: b.num, x: a.x, y: a.y };
  }
}
