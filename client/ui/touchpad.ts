import { input, type VirtualKey } from '../game/input.ts';
import { $ } from './dom.ts';
import { iconSvg } from './icons.ts';

const ICONS: Record<VirtualKey, string> = { left: 'left', right: 'right', drop: 'down', jump: 'up' };

/** On-screen pad under the stage (shown by CSS on coarse pointers or narrow screens). */
export function initTouchpad() {
  for (const btn of $('#touchpad').querySelectorAll<HTMLButtonElement>('.pad-btn')) {
    const key = btn.dataset.key as VirtualKey;
    btn.innerHTML = iconSvg(ICONS[key], 28);
    const up = (e: PointerEvent) => {
      if (btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      btn.classList.remove('on');
      input.release(key);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('on');
      input.press(key);
    });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', () => {
      btn.classList.remove('on');
      input.release(key);
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
