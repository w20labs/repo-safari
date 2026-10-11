import type { ClientMsg } from '../../shared/protocol.ts';

/**
 * Turns an untrusted WebSocket payload into a typed client message, or null if it isn't one.
 * Anyone can connect to /arena, so nothing about the shape of a message is assumed.
 */
export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const m = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const int = (x: unknown) => Number.isInteger(x);
  const str = (x: unknown, max: number) => typeof x === 'string' && x.length <= max;

  switch (m.t) {
    case 'hello':
      if (m.pid !== undefined && !str(m.pid, 40)) return null;
      if (m.name !== undefined && !str(m.name, 100)) return null;
      return { t: 'hello', pid: (m.pid as string) ?? '', name: (m.name as string) ?? '' };
    case 'ping':
      return num(m.c) ? { t: 'ping', c: m.c as number } : null;
    case 'create':
    case 'quick':
    case 'start':
    case 'leave':
      return { t: m.t };
    case 'join':
      return str(m.code, 16) ? { t: 'join', code: m.code as string } : null;
    case 'pos':
      if (![m.x, m.y, m.vx, m.vy].every(num) || !int(m.g) || (m.f !== 1 && m.f !== -1)) return null;
      return { t: 'pos', x: m.x as number, y: m.y as number, vx: m.vx as number, vy: m.vy as number, g: m.g as number, f: m.f as 1 | -1 };
    case 'answer':
      return int(m.bell) && int(m.choice) ? { t: 'answer', bell: m.bell as number, choice: m.choice as number } : null;
    default:
      return null;
  }
}
