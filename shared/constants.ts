/** World and physics numbers. Units are world units and seconds. */
export const PHYS = {
  viewH: 720,
  worldH: 1400,
  floorY: 1320,
  pitFallDepth: 90,
  gravity: 2400,
  jumpV: 1000,
  doubleJumpMul: 0.9,
  jumpCutVy: -420,
  jumpCutMul: 0.55,
  maxRun: 330,
  groundAccel: 2800,
  airAccel: 1900,
  coyote: 0.1,
  jumpBuffer: 0.14,
  dropThrough: 0.25,
  maxDt: 1 / 30,
  bodyW: 26,
  bodyH: 40,
  movingTolerance: 6,
} as const;

export const COURSE = {
  startPadEnd: 340,
  endPadWidth: 440,
  firstX: 380,
  stepX: 220,
  tail: 520,
  platformH: 30,
  gateW: 92,
  gateH: 130,
  gateFromEnd: 300,
} as const;

export const COLORS = {
  bg: '#0A0C14',
  panel: '#121626',
  sunken: '#0B0E19',
  line: '#262C42',
  text: '#ECEFF7',
  muted: '#9AA3B8',
  teal: '#2EC4A6',
  pink: '#FF3E8A',
  amber: '#F2B544',
  lime: '#D4F25C',
  green: '#7BE08F',
  crimson: '#3A0B1C',
} as const;

export const REGION_COLORS: Record<string, string> = {
  ai: '#5CC8E8',
  web: '#F2B544',
  dev: '#9BE07A',
  infra: '#B79CFF',
  lang: '#FF8A65',
  rising: '#D4F25C',
};

export const REGION_NAMES: Record<string, string> = {
  ai: 'AI & ML',
  web: 'Web',
  dev: 'Dev tools',
  infra: 'Infra',
  lang: 'Languages & runtimes',
  rising: 'Rising',
};

export const TOTAL_PLAYERS = 456;
export const GATE_BONUS = 500;
export const SURVIVOR_BONUS = 500;
export const ANSWER_REVEAL_MS = 850;

export const padPlayerNumber = (n: number): string => String(n).padStart(3, '0');
