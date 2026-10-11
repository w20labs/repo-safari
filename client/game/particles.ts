import { prefs } from '../prefs.ts';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  kind: 'square' | 'puff';
}

export class Particles {
  private list: Particle[] = [];

  burst(x: number, y: number, colors: string[], count: number, speed = 320) {
    const n = prefs.reducedMotion ? Math.ceil(count / 4) : count;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      this.list.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - speed * 0.4,
        life: 0, max: 0.6 + Math.random() * 0.5, size: 3 + Math.random() * 4,
        color: colors[i % colors.length], kind: 'square',
      });
    }
  }

  puff(x: number, y: number) {
    const n = prefs.reducedMotion ? 3 : 12;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.list.push({
        x, y, vx: Math.cos(a) * 90, vy: Math.sin(a) * 60 - 30,
        life: 0, max: 0.7, size: 10 + Math.random() * 8, color: i % 3 ? '#9AA3B8' : '#FF3E8A', kind: 'puff',
      });
    }
  }

  update(dt: number) {
    for (const p of this.list) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === 'square') p.vy += 900 * dt;
      else {
        p.vx *= 0.94;
        p.vy *= 0.94;
      }
    }
    this.list = this.list.filter((p) => p.life < p.max);
  }

  draw(ctx: CanvasRenderingContext2D) {
    for (const p of this.list) {
      const k = 1 - p.life / p.max;
      ctx.globalAlpha = Math.max(0, k);
      ctx.fillStyle = p.color;
      if (p.kind === 'square') ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1.6 - k * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
