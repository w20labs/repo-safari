import type { Question } from './types.ts';

/** WebSocket messages for /arena. `t` is the message type. */

export type ClientMsg =
  | { t: 'hello'; pid: string; name: string }
  | { t: 'ping'; c: number }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'start' }
  | { t: 'leave' }
  /** g = index of the platform you're standing on, -1 otherwise */
  | { t: 'pos'; x: number; y: number; vx: number; vy: number; g: number; f: 1 | -1 }
  | { t: 'answer'; bell: number; choice: number };

export interface LobbyPlayer {
  id: string;
  num: number;
  name: string;
  state: 'alive' | 'out' | 'spectator';
  connected: boolean;
}

/** Question as sent to clients: no answer index. */
export type PublicQuestion = Omit<Question, 'answer'> & { bell: number; deadline: number; repoShort: string };

export type Elimination = { id: string; reason: string };

export type ServerMsg =
  | { t: 'welcome'; id: string; num: number }
  | { t: 'pong'; c: number; s: number }
  | { t: 'room'; code: string; hostId: string; phase: 'lobby' | 'running' | 'over'; players: LobbyPlayer[] }
  | { t: 'start'; seed: number; t0: number }
  /** relayed positions: [id, x, y, facing, grounded] */
  | { t: 'snap'; s: number; p: [string, number, number, number, number][] }
  | { t: 'bell'; bell: number; out: Elimination[]; question: PublicQuestion | null }
  | { t: 'verdict'; bell: number; answer: number; out: Elimination[]; you?: { choice: number | null; correct: boolean; points: number } }
  | { t: 'elim'; out: Elimination[] }
  | { t: 'over'; winners: string[]; scores: Record<string, number>; bellsSurvived: Record<string, number> }
  | { t: 'error'; msg: string };
