import type { Controls } from './physics.ts';

const LEFT = ['ArrowLeft', 'KeyA'];
const RIGHT = ['ArrowRight', 'KeyD'];
const JUMP = ['ArrowUp', 'KeyW', 'Space'];
const DROP = ['ArrowDown', 'KeyS'];
const GAME_KEYS = new Set([...LEFT, ...RIGHT, ...JUMP, ...DROP]);

export const isTyping = (): boolean => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

export type VirtualKey = 'left' | 'right' | 'jump' | 'drop';

/** Keyboard + on-screen pad, sampled once per frame. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private virtual = new Set<VirtualKey>();
  private vPressed = new Set<VirtualKey>();
  private vReleased = new Set<VirtualKey>();
  enabled = true;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (isTyping() || !GAME_KEYS.has(e.code)) return;
      if (this.enabled) e.preventDefault();
      if (!e.repeat && !this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      if (!GAME_KEYS.has(e.code)) return;
      if (this.down.delete(e.code)) this.released.add(e.code);
    });
    window.addEventListener('blur', () => this.clear());
  }

  press(k: VirtualKey) {
    if (!this.virtual.has(k)) this.vPressed.add(k);
    this.virtual.add(k);
  }

  release(k: VirtualKey) {
    if (this.virtual.delete(k)) this.vReleased.add(k);
  }

  clear() {
    for (const k of this.down) this.released.add(k);
    this.down.clear();
    this.virtual.clear();
  }

  /** Current controls; edge flags are consumed. */
  sample(): Controls {
    const any = (codes: string[], set: Set<string>) => codes.some((c) => set.has(c));
    const c: Controls = {
      left: any(LEFT, this.down) || this.virtual.has('left'),
      right: any(RIGHT, this.down) || this.virtual.has('right'),
      jumpHeld: any(JUMP, this.down) || this.virtual.has('jump'),
      jumpPressed: any(JUMP, this.pressed) || this.vPressed.has('jump'),
      jumpReleased: any(JUMP, this.released) || this.vReleased.has('jump'),
      drop: any(DROP, this.pressed) || this.vPressed.has('drop'),
    };
    this.pressed.clear();
    this.released.clear();
    this.vPressed.clear();
    this.vReleased.clear();
    if (!this.enabled) return { left: false, right: false, jumpHeld: false, jumpPressed: false, jumpReleased: c.jumpReleased, drop: false };
    return c;
  }
}

export const input = new Input();
