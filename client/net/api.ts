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

export interface MeResponse {
  id: string;
  num: number;
  name: string;
  today: string;
  playedToday: boolean;
}

export interface BoardRow {
  rank: number;
  runId: string;
  num: number;
  name: string;
  score: number;
  cleared: number;
  total: number;
  won: boolean;
  me?: boolean;
}

export interface BoardResponse {
  date: string;
  rows: BoardRow[];
  me: BoardRow | null;
  players: number;
}

export const api = {
  me: () => call<MeResponse>('GET', '/api/me'),
  setName: (name: string) => call<{ name: string }>('POST', '/api/me', { name }),
  dailyCourse: (date: string) => call<{ date: string; pool: RisingPool | null; repos: Repo[] }>('GET', `/api/daily/course?date=${date}`),
  dailyStart: () => call<{ runId: string | null; official: boolean; date: string; pool: RisingPool | null; repos: Repo[] }>('POST', '/api/daily/start'),
  dailyFinish: (body: { runId: string; results: RunResult[]; score: number; won: boolean; outLabel: string }) =>
    call<{ ok: true; score: number; rank: number; url: string; outLabel: string }>('POST', '/api/daily/finish', body),
  leaderboard: (date: string) => call<BoardResponse>('GET', `/api/daily/leaderboard?date=${date}`),
  rising: () => call<RisingPool & { asOf: string | null }>('GET', '/api/rising'),
};
