import { PHYS } from '../../shared/constants.ts';

export class Camera {
  x = 0;
  y = 0;
  viewW = 1280;
  readonly viewH = PHYS.viewH;

  /** Eases toward the player, keeping the view inside the world. */
  follow(px: number, py: number, worldW: number, dt: number, instant: boolean) {
    const tx = Math.max(0, Math.min(worldW - this.viewW, px - this.viewW * 0.4));
    const ty = Math.max(0, Math.min(PHYS.worldH - this.viewH, py - this.viewH * 0.58));
    const k = instant ? 1 : Math.min(1, dt * 6);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
  }

  snap(px: number, py: number, worldW: number) {
    this.follow(px, py, worldW, 1, true);
  }
}
