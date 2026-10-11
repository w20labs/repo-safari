import { randomBytes, randomInt } from 'node:crypto';
import { ARENA, arenaEndsAt, bellAt, platformStates, questionEndsAt } from '../../shared/arena.ts';
import { ARENA_PLATFORMS, arenaCourse, type Course } from '../../shared/course.ts';
import { SURVIVOR_BONUS, TOTAL_PLAYERS } from '../../shared/constants.ts';
import type { ClientMsg, Elimination, LobbyPlayer, PublicQuestion, ServerMsg } from '../../shared/protocol.ts';
import { defaultContext, makeQuestion } from '../../shared/questions.ts';
import { pick, rngFrom } from '../../shared/rng.ts';
import { answerScore } from '../../shared/scoring.ts';
import type { Question } from '../../shared/types.ts';

export interface Conn {
  send(msg: ServerMsg): void;
}

interface Member {
  /** public id shown to other players (never the identity cookie) */
  id: string;
  /** private identity, used to re-attach after a reconnect */
  key: string;
  num: number;
  name: string;
  state: 'alive' | 'out' | 'spectator';
  conn: Conn | null;
  disconnectedAt: number | null;
  pos: { x: number; y: number; f: number; g: number; at: number } | null;
  answers: Map<number, { choice: number; at: number }>;
  /** multiplier of the platform the player stood on at each bell */
  standMult: Map<number, number>;
  score: number;
  bellsSurvived: number;
}

interface BellState {
  question: Question;
  repoShort: string;
  judged: boolean;
}

export const MAX_PLAYERS = 40;

/** One Arena room. All timing decisions use `now()`, the server clock. */
export class Room {
  readonly code: string;
  hostId = '';
  phase: 'lobby' | 'running' | 'over' = 'lobby';
  seed = 0;
  t0 = 0;
  course: Course | null = null;
  /** secret seed for questions, so clients can't precompute answers from the public course seed */
  private qseed = '';
  private members = new Map<string, Member>();
  private bells = new Map<number, BellState>();
  private nextBell = 0;
  emptySince: number | null = null;

  constructor(code: string, private now: () => number = Date.now) {
    this.code = code;
  }

  // ---------- membership ----------

  get size() {
    return this.members.size;
  }

  private byKey(key: string) {
    for (const m of this.members.values()) if (m.key === key) return m;
    return null;
  }

  /** Adds (or re-attaches) a player. Returns their public id, or an error message. */
  join(key: string, num: number | null, name: string, conn: Conn): { id: string } | { error: string } {
    const existing = this.byKey(key);
    if (existing) {
      existing.conn = conn;
      existing.disconnectedAt = null;
      if (name) existing.name = name;
      this.emptySince = null;
      conn.send({ t: 'welcome', id: existing.id, num: existing.num });
      this.broadcastRoom();
      this.sendState(existing);
      return { id: existing.id };
    }
    if (this.members.size >= MAX_PLAYERS) return { error: 'This room is full.' };
    const taken = new Set([...this.members.values()].map((m) => m.num));
    let n = num ?? randomInt(1, TOTAL_PLAYERS + 1);
    while (taken.has(n)) n = randomInt(1, TOTAL_PLAYERS + 1);
    const lateJoin = this.phase === 'running' && this.now() >= bellAt(this.t0, 0);
    const m: Member = {
      id: randomBytes(6).toString('base64url'), key, num: n, name, conn,
      state: this.phase === 'lobby' ? 'alive' : lateJoin || this.phase === 'over' ? 'spectator' : 'alive',
      disconnectedAt: null, pos: null, answers: new Map(), standMult: new Map(), score: 0, bellsSurvived: 0,
    };
    this.members.set(m.id, m);
    if (!this.hostId) this.hostId = m.id;
    this.emptySince = null;
    conn.send({ t: 'welcome', id: m.id, num: m.num });
    this.broadcastRoom();
    this.sendState(m);
    return { id: m.id };
  }

  /** Brings a (re)joining member up to date with a running match. */
  private sendState(m: Member) {
    if (this.phase !== 'running' || !m.conn) return;
    m.conn.send({ t: 'start', seed: this.seed, t0: this.t0 });
    const open = this.bells.get(this.nextBell - 1);
    const k = this.nextBell - 1;
    if (open && !open.judged && m.state === 'alive') m.conn.send({ t: 'bell', bell: k, out: [], question: this.publicQuestion(k) });
  }

  leave(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (this.phase === 'running' && m.state === 'alive') this.broadcast({ t: 'elim', out: [{ id, reason: 'Left the room' }] });
    if (this.hostId === id) this.hostId = [...this.members.values()].find((x) => x.conn)?.id ?? [...this.members.keys()][0] ?? '';
    if (!this.members.size) this.emptySince = this.now();
    this.broadcastRoom();
    this.checkOver();
  }

  disconnect(id: string) {
    const m = this.members.get(id);
    if (!m) return;
    m.conn = null;
    m.disconnectedAt = this.now();
    if (this.phase !== 'running') {
      this.leave(id);
      return;
    }
    if (this.hostId === id) {
      const next = [...this.members.values()].find((x) => x.conn);
      if (next) this.hostId = next.id;
    }
    if (![...this.members.values()].some((x) => x.conn)) this.emptySince = this.now();
    this.broadcastRoom();
  }

  // ---------- match ----------

  start(byId: string): string | null {
    if (byId !== this.hostId) return 'Only the host can start.';
    if (this.phase === 'running') return 'Already running.';
    const now = this.now();
    this.seed = randomInt(1, 2 ** 31);
    this.qseed = randomBytes(12).toString('hex');
    this.t0 = now + ARENA.leadMs;
    this.course = arenaCourse(this.seed);
    this.bells.clear();
    this.nextBell = 0;
    this.phase = 'running';
    for (const m of this.members.values()) {
      if (!m.conn) {
        this.members.delete(m.id);
        continue;
      }
      Object.assign(m, { state: 'alive', pos: null, score: 0, bellsSurvived: 0 });
      m.answers.clear();
      m.standMult.clear();
    }
    // room state first, so clients know who is alive when `start` arrives
    this.broadcastRoom();
    this.broadcast({ t: 'start', seed: this.seed, t0: this.t0 });
    return null;
  }

  pos(id: string, msg: Extract<ClientMsg, { t: 'pos' }>) {
    const m = this.members.get(id);
    if (!m || m.state !== 'alive' || this.phase !== 'running' || !this.course) return;
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
    const x = num(msg.x, 0, this.course.W);
    const y = num(msg.y, -500, 2000);
    const g = Number.isInteger(msg.g) && msg.g >= 0 && msg.g < ARENA_PLATFORMS ? msg.g : -1;
    if (x === null || y === null) return;
    m.pos = { x, y, f: msg.f === -1 ? -1 : 1, g, at: this.now() };
  }

  answer(id: string, bell: number, choice: number) {
    const m = this.members.get(id);
    const b = this.bells.get(bell);
    if (!m || !b || b.judged || m.state !== 'alive' || m.answers.has(bell)) return;
    if (!Number.isInteger(choice) || choice < 0 || choice > 3) return;
    const at = this.now();
    if (at > questionEndsAt(this.t0, bell)) return;
    m.answers.set(bell, { choice, at });
  }

  private publicQuestion(k: number): PublicQuestion | null {
    const b = this.bells.get(k);
    if (!b) return null;
    const { answer: _hidden, ...q } = b.question;
    void _hidden;
    return { ...q, bell: k, deadline: questionEndsAt(this.t0, k), repoShort: b.repoShort };
  }

  /** Advances bells, judging and disconnect eliminations. Call often (e.g. every 50 ms). */
  tick() {
    if (this.phase !== 'running' || !this.course) return;
    const now = this.now();
    const out: Elimination[] = [];
    for (const m of this.members.values()) {
      if (m.state === 'alive' && m.disconnectedAt !== null && now - m.disconnectedAt > ARENA.disconnectGraceMs) {
        m.state = 'out';
        out.push({ id: m.id, reason: 'Disconnected' });
      }
    }
    if (out.length) {
      this.broadcast({ t: 'elim', out });
      this.broadcastRoom();
    }

    const prev = this.bells.get(this.nextBell - 1);
    if (prev && !prev.judged && now >= questionEndsAt(this.t0, this.nextBell - 1)) this.judge(this.nextBell - 1);
    if (this.phase === 'running' && this.nextBell < ARENA.bells && now >= bellAt(this.t0, this.nextBell)) this.ring(this.nextBell++);
    this.checkOver();
  }

  private ring(k: number) {
    const course = this.course!;
    const now = this.now();
    const { gone } = platformStates(this.seed, this.t0, now);
    const out: Elimination[] = [];
    for (const m of this.members.values()) {
      if (m.state !== 'alive') continue;
      const p = m.pos;
      const fresh = p && now - p.at <= ARENA.posFreshMs;
      if (fresh && p.g >= 0 && !gone.has(p.g)) {
        m.standMult.set(k, course.platforms[p.g].mult);
      } else {
        m.state = 'out';
        out.push({ id: m.id, reason: fresh ? `Not on a platform at bell ${k + 1}` : `No position at bell ${k + 1}` });
      }
    }
    const standing = course.platforms.filter((p) => !gone.has(p.i));
    const rng = rngFrom(`${this.qseed}-q-${k}`);
    const repo = pick(rng, standing.length ? standing : course.platforms).repo;
    this.bells.set(k, { question: makeQuestion(repo, rng, defaultContext()), repoShort: repo.short, judged: false });
    const pq = this.publicQuestion(k);
    for (const m of this.members.values()) m.conn?.send({ t: 'bell', bell: k, out, question: m.state === 'alive' ? pq : null });
    this.broadcastRoom();
  }

  private judge(k: number) {
    const b = this.bells.get(k)!;
    b.judged = true;
    const deadline = questionEndsAt(this.t0, k);
    const out: Elimination[] = [];
    const yours = new Map<string, { choice: number | null; correct: boolean; points: number }>();
    for (const m of this.members.values()) {
      if (m.state !== 'alive') continue;
      const a = m.answers.get(k);
      if (a && a.choice === b.question.answer) {
        const points = answerScore((deadline - a.at) / 1000, m.standMult.get(k) ?? 1);
        m.score += points;
        m.bellsSurvived = k + 1;
        yours.set(m.id, { choice: a.choice, correct: true, points });
      } else {
        m.state = 'out';
        out.push({ id: m.id, reason: a ? `Wrong answer at bell ${k + 1}` : `Ran out of time at bell ${k + 1}` });
        yours.set(m.id, { choice: a?.choice ?? null, correct: false, points: 0 });
      }
    }
    for (const m of this.members.values()) m.conn?.send({ t: 'verdict', bell: k, answer: b.question.answer, out, you: yours.get(m.id) });
    if (k === ARENA.bells - 1) this.finish();
    else this.broadcastRoom();
  }

  private checkOver() {
    if (this.phase !== 'running') return;
    const alive = [...this.members.values()].filter((m) => m.state === 'alive');
    if (!alive.length && this.nextBell > 0) this.finish();
    else if (this.now() >= arenaEndsAt(this.t0) + 2000) this.finish();
  }

  private finish() {
    if (this.phase !== 'running') return;
    this.phase = 'over';
    const winners: string[] = [];
    const scores: Record<string, number> = {};
    const bellsSurvived: Record<string, number> = {};
    for (const m of this.members.values()) {
      if (m.state === 'alive') {
        m.score += SURVIVOR_BONUS;
        winners.push(m.id);
      }
      scores[m.id] = m.score;
      bellsSurvived[m.id] = m.bellsSurvived;
    }
    this.broadcast({ t: 'over', winners, scores, bellsSurvived });
    this.broadcastRoom();
  }

  // ---------- relay ----------

  /** Latest positions of alive players, sent ~15 times a second. */
  snapshot(): ServerMsg | null {
    if (this.phase !== 'running') return null;
    const p: [string, number, number, number, number][] = [];
    for (const m of this.members.values()) {
      if (m.state === 'alive' && m.pos) p.push([m.id, Math.round(m.pos.x), Math.round(m.pos.y), m.pos.f, m.pos.g >= 0 ? 1 : 0]);
    }
    return { t: 'snap', s: this.now(), p };
  }

  lobby(): LobbyPlayer[] {
    return [...this.members.values()].map((m) => ({ id: m.id, num: m.num, name: m.name, state: m.state, connected: !!m.conn }));
  }

  broadcastRoom() {
    this.broadcast({ t: 'room', code: this.code, hostId: this.hostId, phase: this.phase, players: this.lobby() });
  }

  broadcast(msg: ServerMsg) {
    for (const m of this.members.values()) m.conn?.send(msg);
  }

  memberState(id: string) {
    return this.members.get(id)?.state ?? null;
  }
}
