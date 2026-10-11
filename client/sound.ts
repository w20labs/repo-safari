import { save, store } from './prefs.ts';

/**
 * Tiny synthesized sound effects (Web Audio, no files). The context starts on the first user
 * gesture, as browsers require.
 */
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = store<boolean>('lcs-muted', false);
const listeners = new Set<(m: boolean) => void>();

function audio(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.32;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

for (const ev of ['pointerdown', 'keydown'] as const) window.addEventListener(ev, () => audio(), { capture: true, passive: true });

interface ToneOpts {
  type?: OscillatorType;
  vol?: number;
  slideTo?: number;
  delay?: number;
  attack?: number;
}

function tone(freq: number, dur: number, o: ToneOpts = {}) {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + (o.delay ?? 0);
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = o.type ?? 'square';
  osc.frequency.setValueAtTime(freq, t);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.2, t + (o.attack ?? 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function noise(dur: number, vol = 0.1, cutoff = 1200, delay = 0) {
  const a = audio();
  if (!a || !master) return;
  const t = a.currentTime + delay;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = a.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  jump: () => tone(392, 0.1, { slideTo: 587, vol: 0.09 }),
  doubleJump: () => tone(523, 0.1, { slideTo: 880, vol: 0.09 }),
  land: () => noise(0.05, 0.07, 700),
  question: () => {
    tone(330, 0.08, { type: 'triangle', vol: 0.18 });
    tone(494, 0.12, { type: 'triangle', vol: 0.18, delay: 0.08 });
  },
  tick: (urgent: boolean) => tone(urgent ? 1568 : 1175, 0.035, { vol: urgent ? 0.07 : 0.04 }),
  correct: () => [659, 880, 1319].forEach((f, i) => tone(f, 0.16, { type: 'triangle', vol: 0.2, delay: i * 0.07 })),
  wrong: () => {
    tone(233, 0.32, { type: 'sawtooth', slideTo: 110, vol: 0.16 });
    tone(220, 0.32, { type: 'square', slideTo: 104, vol: 0.08 });
  },
  eliminated: () => {
    tone(440, 0.55, { type: 'sawtooth', slideTo: 55, vol: 0.18 });
    noise(0.4, 0.12, 500, 0.1);
  },
  otherOut: () => noise(0.18, 0.06, 900),
  fall: () => tone(600, 0.7, { type: 'sawtooth', slideTo: 50, vol: 0.14 }),
  gateOpen: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.16, delay: i * 0.09 })),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.18, delay: i * 0.1 })),
  bell: () => {
    for (const [f, v] of [[880, 0.22], [1320, 0.1], [2210, 0.05]] as const) tone(f, 1.4, { type: 'sine', vol: v, attack: 0.003 });
  },
  crumble: () => noise(0.5, 0.08, 400),
};

export const isMuted = () => muted;

export function setMuted(m: boolean) {
  muted = m;
  save('lcs-muted', m);
  if (m && ctx) void ctx.suspend();
  listeners.forEach((fn) => fn(m));
}

export const onMuteChange = (fn: (m: boolean) => void) => listeners.add(fn);
