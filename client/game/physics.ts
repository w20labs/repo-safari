import { PHYS } from '../../shared/constants.ts';
import type { World } from './world.ts';

/** Ground ids: platform index >= 0, PAD = a ground pad, NONE = airborne. */
export const PAD = -2;
export const NONE = -1;

export interface Body {
  /** feet center */
  x: number;
  y: number;
  vx: number;
  vy: number;
  ground: number;
  coyote: number;
  buffer: number;
  jumps: number;
  dropT: number;
  facing: 1 | -1;
  /** seconds spent running, for the leg animation */
  runT: number;
}

export interface Controls {
  left: boolean;
  right: boolean;
  jumpPressed: boolean;
  jumpHeld: boolean;
  jumpReleased: boolean;
  drop: boolean;
}

export const NO_CONTROLS: Controls = { left: false, right: false, jumpPressed: false, jumpHeld: false, jumpReleased: false, drop: false };

export function makeBody(x: number, y: number): Body {
  return { x, y, vx: 0, vy: 0, ground: PAD, coyote: 0, buffer: 0, jumps: 0, dropT: 0, facing: 1, runT: 0 };
}

export interface StepResult {
  /** platform index landed on this step (only when it changed) */
  landed: number | null;
  fell: boolean;
  /** walked into the locked gate */
  blockedByGate: boolean;
  /** body overlaps the open gate */
  inGate: boolean;
  /** 1 = jumped from the ground, 2 = double jump */
  jumped: 0 | 1 | 2;
  /** touched down this step after being airborne */
  touchedDown: boolean;
}

const approach = (v: number, target: number, step: number) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));

export function stepBody(b: Body, c: Controls, dt: number, world: World): StepResult {
  const res: StepResult = { landed: null, fell: false, blockedByGate: false, inGate: false, jumped: 0, touchedDown: false };
  const half = PHYS.bodyW / 2;
  const grounded = b.ground !== NONE;

  // ride moving platforms
  if (b.ground >= 0) {
    b.x += world.dx[b.ground];
    b.y += world.dy[b.ground];
  }

  // horizontal
  const dir = (c.right ? 1 : 0) - (c.left ? 1 : 0);
  if (dir) b.facing = dir as 1 | -1;
  b.vx = approach(b.vx, dir * PHYS.maxRun, (grounded ? PHYS.groundAccel : PHYS.airAccel) * dt);
  b.runT = grounded && Math.abs(b.vx) > 20 ? b.runT + dt : 0;

  // timers
  b.coyote = grounded ? PHYS.coyote : b.coyote - dt;
  b.buffer = c.jumpPressed ? PHYS.jumpBuffer : b.buffer - dt;
  b.dropT -= dt;

  if (c.drop && b.ground >= 0) {
    b.dropT = PHYS.dropThrough;
    b.ground = NONE;
    b.coyote = 0;
  }

  // jumping
  if (b.buffer > 0) {
    if (b.ground !== NONE || b.coyote > 0) {
      b.vy = -PHYS.jumpV;
      b.jumps = 1;
      b.ground = NONE;
      b.coyote = 0;
      b.buffer = 0;
      res.jumped = 1;
    } else if (b.jumps < 2) {
      b.vy = -PHYS.jumpV * PHYS.doubleJumpMul;
      b.jumps = 2;
      b.buffer = 0;
      res.jumped = 2;
    }
  }
  if (c.jumpReleased && b.vy < PHYS.jumpCutVy) b.vy *= PHYS.jumpCutMul;

  b.vy = Math.min(b.vy + PHYS.gravity * dt, 1600);

  // move x, then keep inside the world, out of pad walls and out of a locked gate
  b.x += b.vx * dt;
  b.x = Math.max(half, Math.min(world.W - half, b.x));
  if (b.y > PHYS.floorY + 0.5) {
    const [lo, hi] = world.pitBounds();
    if (b.x < lo || b.x > hi) {
      b.x = Math.max(lo, Math.min(hi, b.x));
      b.vx = 0;
    }
  }
  if (world.hasGate) {
    const g = world.gate();
    const overlapsY = b.y > g.y && b.y - PHYS.bodyH < g.y + g.h;
    if (overlapsY && b.x + half > g.x && b.x - half < g.x + g.w) {
      if (world.gateOpen) res.inGate = true;
      else {
        b.x = g.x - half;
        if (b.vx > 0) b.vx = 0;
        res.blockedByGate = dir > 0;
      }
    }
  }

  // move y and resolve one-way landings
  const prevBottom = b.y;
  b.y += b.vy * dt;
  const prevGround = b.ground;
  b.ground = NONE;
  if (b.vy >= 0) {
    let bestTop = Infinity;
    let best = NONE;
    if (prevBottom <= PHYS.floorY + 0.01 && b.y >= PHYS.floorY && world.padUnder(b.x - half, b.x + half)) {
      bestTop = PHYS.floorY;
      best = PAD;
    }
    if (b.dropT <= 0) {
      for (const p of world.course.platforms) {
        if (!world.isSolid(p.i)) continue;
        const top = world.py[p.i];
        const tol = p.move ? PHYS.movingTolerance : 0;
        const left = world.px[p.i];
        if (b.x + half <= left || b.x - half >= left + p.w) continue;
        if (prevBottom <= top + tol + 0.01 && b.y >= top && top < bestTop) {
          bestTop = top;
          best = p.i;
        }
      }
    }
    if (best !== NONE) {
      b.y = bestTop;
      b.vy = 0;
      b.ground = best;
      b.jumps = 0;
      if (prevGround === NONE && !grounded) res.touchedDown = true;
      if (best !== prevGround && best >= 0) res.landed = best;
    }
  }

  if (b.y > PHYS.floorY + PHYS.pitFallDepth) res.fell = true;
  return res;
}
