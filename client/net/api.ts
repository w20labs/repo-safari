import type { Repo, RisingPool, RunResult } from '../../shared/types.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText);
  return data;
}

export interface DayEntry {
  date: string;
  score: number;
  cleared: number;
  total: number;
  won: boolean;
}

export interface PlayerStats {
  played: number;
  wins: number;
  bestScore: number;
  currentStreak: number;
  bestStreak: number;
  recent: (DayEntry | null)[];
}

export interface MeResponse {
  id: string;
  num: number;
  name: string;
  team: string;
  /** linked GitHub login, if signed in */
  github: string | null;
  authAvailable: boolean;
  today: string;
  playedToday: boolean;
  stats: PlayerStats;
}

export interface BoardRow {
  rank: number;
  runId: string;
  num: number;
  name: string;
  /** signed in with GitHub; `name` is then "@login" */
  verified?: boolean;
  team?: string;
  score: number;
  cleared: number;
  total: number;
  won: boolean;
  me?: boolean;
}

export interface TeamRow {
  rank: number;
  team: string;
  players: number;
  score: number;
  mine?: boolean;
}

export interface TeamsResponse {
  date: string;
  rows: TeamRow[];
  me: TeamRow | null;
  teams: number;
}

export interface BoardResponse {
  date: string;
  rows: BoardRow[];
  me: BoardRow | null;
  players: number;
}

export const api = {
  me: () => call<MeResponse>('GET', '/api/me'),
  updateMe: (patch: { name?: string; team?: string }) => call<{ name: string; team: string }>('POST', '/api/me', patch),
  dailyCourse: (date: string) => call<{ date: string; pool: RisingPool | null; repos: Repo[] }>('GET', `/api/daily/course?date=${date}`),
  dailyStart: () => call<{ runId: string | null; official: boolean; date: string; pool: RisingPool | null; repos: Repo[] }>('POST', '/api/daily/start'),
  dailyFinish: (body: { runId: string; results: RunResult[]; score: number; won: boolean; outLabel: string }) =>
    call<{ ok: true; score: number; rank: number; players: number; rankLine: string; stats: PlayerStats; url: string; outLabel: string }>('POST', '/api/daily/finish', body),
  leaderboard: (date: string) => call<BoardResponse>('GET', `/api/daily/leaderboard?date=${date}`),
  verifiedBoard: (date: string) => call<BoardResponse>('GET', `/api/daily/leaderboard?date=${date}&scope=verified`),
  logout: () => call<{ ok: true }>('POST', '/api/logout'),
  teamBoard: (date: string, team: string) => call<BoardResponse & { team: string }>('GET', `/api/daily/leaderboard?date=${date}&scope=team&team=${encodeURIComponent(team)}`),
  teams: (date: string) => call<TeamsResponse>('GET', `/api/daily/leaderboard?date=${date}&scope=teams`),
  rising: () => call<RisingPool & { asOf: string | null }>('GET', '/api/rising'),
};
