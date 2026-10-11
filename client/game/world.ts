import { COURSE, PHYS } from '../../shared/constants.ts';
import { endPad, gateRect, platformOffset, type Course } from '../../shared/course.ts';

/** Runtime platform positions plus per-mode flags (cleared, crumbling, gone). */
export class World {
  readonly course: Course;
  /** world time in seconds; frozen while a solo question is open */
  t = 0;
  /** left x and top y of each platform this frame, and the delta from last frame */
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly dx: Float64Array;
  readonly dy: Float64Array;
  readonly cleared = new Set<number>();
  readonly crumbling = new Set<number>();
  readonly gone = new Set<number>();
  gateOpen = false;
  /** whether the course has an exit gate at all */
  readonly hasGate: boolean;

  constructor(course: Course) {
    this.course = course;
    const n = course.platforms.length;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.dx = new Float64Array(n);
    this.dy = new Float64Array(n);
    this.hasGate = course.unlock !== null;
    this.place(0, true);
  }

  get W() {
    return this.course.W;
  }

  /** Moves platforms to time t and records how far each moved since the last call. */
  place(t: number, reset = false) {
    this.t = t;
    for (const p of this.course.platforms) {
      const { dx, dy } = platformOffset(p, t);
      const x = p.cx - p.w / 2 + dx;
      const y = p.baseY + dy;
      this.dx[p.i] = reset ? 0 : x - this.px[p.i];
      this.dy[p.i] = reset ? 0 : y - this.py[p.i];
      this.px[p.i] = x;
      this.py[p.i] = y;
    }
  }

  advance(dt: number) {
    this.place(this.t + dt);
  }

  isSolid(i: number) {
    return !this.gone.has(i);
  }

  gate() {
    return gateRect(this.course);
  }

  /** Which ground pad (if any) covers [x0, x1]. */
  padUnder(x0: number, x1: number): boolean {
    const end = endPad(this.course);
    return (x1 > 0 && x0 < COURSE.startPadEnd) || (x1 > end.x0 && x0 < end.x1);
  }

  /** Horizontal limits while below the floor line, so you can't walk into the pads from the pit. */
  pitBounds(): [number, number] {
    const half = PHYS.bodyW / 2;
    return [COURSE.startPadEnd + half, this.W - COURSE.endPadWidth - half];
  }
}
