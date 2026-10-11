import { PHYS } from '../../shared/constants.ts';
import { prefs } from '../prefs.ts';
import { Camera } from './camera.ts';
import { Particles } from './particles.ts';
import { drawScene, fitCanvas, type Scene } from './render.ts';

export interface Mode {
  /** advance the simulation; dt is clamped */
  tick(dt: number, time: number): void;
  /** what to draw this frame */
  scene(): Omit<Scene, 'cam' | 'particles' | 'time'>;
  /** camera target (feet position) */
  focus(): { x: number; y: number };
}

/** Owns the canvas and the animation loop; one mode runs at a time. */
export class Stage {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly cam = new Camera();
  particles = new Particles();
  private mode: Mode | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private snapNext = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    new ResizeObserver(() => this.mode && this.frame(this.last, true)).observe(canvas);
  }

  run(mode: Mode) {
    this.stop();
    this.mode = mode;
    this.particles = new Particles();
    this.snapNext = true;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.mode = null;
  }

  private frame(now: number, redrawOnly = false) {
    const mode = this.mode;
    if (!mode) return;
    const dt = redrawOnly ? 0 : Math.min(PHYS.maxDt, Math.max(0, (now - this.last) / 1000));
    if (!redrawOnly) {
      this.last = now;
      this.time += dt;
      mode.tick(dt, this.time);
      this.particles.update(dt);
    }
    const scale = fitCanvas(this.canvas, this.cam);
    const sc = mode.scene();
    const f = mode.focus();
    if (this.snapNext) {
      this.cam.snap(f.x, f.y, sc.world.W);
      this.snapNext = false;
    } else this.cam.follow(f.x, f.y, sc.world.W, dt, prefs.reducedMotion);
    drawScene(this.ctx, scale, { ...sc, cam: this.cam, particles: this.particles, time: this.time });
    if (!redrawOnly && this.mode === mode) this.raf = requestAnimationFrame((t) => this.frame(t));
  }
}
