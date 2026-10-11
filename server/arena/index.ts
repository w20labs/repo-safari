import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ARENA, makeRoomCode } from '../../shared/arena.ts';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { parseCookies } from '../http.ts';
import { cleanName, displayNameOf, getPlayer } from '../store.ts';
import { Room } from './room.ts';

const rooms = new Map<string, Room>();
const ROOM_IDLE_MS = 60_000;
const MAX_MSGS_PER_SEC = 60;

function newRoom(isPublic = false): Room {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const room = new Room(code, Date.now, { isPublic });
  rooms.set(code, room);
  return room;
}

/** A public room that's waiting for players, or a fresh one. Prefers the fullest. */
function quickRoom(): Room {
  const open = [...rooms.values()].filter((r) => r.joinable).sort((a, b) => b.humans - a.humans);
  return open[0] ?? newRoom(true);
}

/** For invite-link previews. */
export function roomInfo(code: string): { code: string; players: number; phase: Room['phase']; isPublic: boolean } | null {
  const r = rooms.get(code.toLowerCase());
  return r ? { code: r.code, players: r.humans, phase: r.phase, isPublic: r.isPublic } : null;
}

function handleConnection(ws: WebSocket, req: IncomingMessage) {
  const cookiePid = parseCookies(req).lcs_pid;
  const player = getPlayer(cookiePid);
  // identity key for reconnects: the player cookie, or a per-socket key for cookieless clients
  let key = player?.id ?? `anon:${Math.random().toString(36).slice(2)}`;
  let name = player ? displayNameOf(player) : '';
  let room: Room | null = null;
  let memberId: string | null = null;
  let budget = MAX_MSGS_PER_SEC;
  const refill = setInterval(() => (budget = MAX_MSGS_PER_SEC), 1000);

  const conn = {
    send(msg: ServerMsg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
  const fail = (msg: string) => conn.send({ t: 'error', msg });

  const enter = (r: Room) => {
    if (room && memberId && room !== r) room.leave(memberId);
    const res = r.join(key, player?.num ?? null, name, conn);
    if ('error' in res) return fail(res.error);
    room = r;
    memberId = res.id;
  };

  ws.on('message', (raw) => {
    if (--budget < 0) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello':
        if (!player && typeof msg.pid === 'string' && msg.pid.length <= 40) key = `anon:${msg.pid}`;
        // verified accounts keep their @login; others may pick a name
        if (!player?.github_login) name = cleanName(msg.name) || name;
        break;
      case 'ping':
        conn.send({ t: 'pong', c: Number(msg.c) || 0, s: Date.now() });
        break;
      case 'create':
        enter(newRoom());
        break;
      case 'quick':
        enter(quickRoom());
        break;
      case 'join': {
        const r = rooms.get(String(msg.code ?? '').toLowerCase().trim());
        if (!r) fail('No room with that code. Check it and try again.');
        else enter(r);
        break;
      }
      case 'start':
        if (room && memberId) {
          const err = room.start(memberId);
          if (err) fail(err);
        }
        break;
      case 'leave':
        if (room && memberId) room.leave(memberId);
        room = null;
        memberId = null;
        break;
      case 'pos':
        if (room && memberId) room.pos(memberId, msg);
        break;
      case 'answer':
        if (room && memberId) room.answer(memberId, Number(msg.bell), Number(msg.choice));
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(refill);
    if (room && memberId) room.disconnect(memberId);
  });
}

/** Mounts the Arena WebSocket endpoint at /arena and starts the room clock. */
export function attachArena(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/arena') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req));
  });

  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      room.tick();
      if (room.emptySince !== null && now - room.emptySince > ROOM_IDLE_MS) rooms.delete(code);
    }
  }, 50).unref();

  setInterval(() => {
    for (const room of rooms.values()) {
      const snap = room.snapshot();
      if (snap) room.broadcast(snap);
    }
  }, Math.round(1000 / ARENA.posHz)).unref();
}

export const _rooms = rooms;
