import { randomBytes, randomInt } from 'node:crypto';
import { ARENA, arenaEndsAt, bellAt, crumblePlan, platformStates, questionEndsAt } from '../../shared/arena.ts';
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
  bot?: BotBrain;
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

/** Server-side filler player: hops to a platform, answers with ~70% accuracy. */
interface BotBrain {
  /** where the current hop started and when */
  from: { x: number; y: number; at: number };
  target: number;
  targetX: number;
  wakeAt: number;
  answerAt: number | null;
  answerChoice: number;
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
  readonly isPublic: boolean;
  autoStartAt: number | null = null;

  constructor(code: string, private now: () => number = Date.now, opts: { isPublic?: boolean } = {}) {
    this.code = code;
    this.isPublic = !!opts.isPublic;
  }

  /** Connected humans. */
  get humans() {
    return [...this.members.values()].filter((m) => !m.bot && m.conn).length;
  }

  /** Public rooms accept quick-match players until a match starts. */
  get joinable() {
    return this.isPublic && this.phase !== 'running' && this.members.size < MAX_PLAYERS;
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
    if (this.hostId === id) this.hostId = [...this.members.values()].find((x) => x.conn)?.id ?? '';
    if (!this.humans) this.emptySince = this.now();
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
    if (!this.humans) this.emptySince = this.now();
    this.broadcastRoom();
  }

  // ---------- match ----------

  start(byId: string): string | null {
    if (this.isPublic) return 'Public matches start on their own.';
    if (byId !== this.hostId) return 'Only the host can start.';
    if (this.phase === 'running') return 'Already running.';
    this.startNow();
    return null;
  }

  private startNow() {
    const now = this.now();
    this.autoStartAt = null;
    this.seed = randomInt(1, 2 ** 31);
    this.qseed = randomBytes(12).toString('hex');
    this.t0 = now + ARENA.leadMs;
    this.course = arenaCourse(this.seed);
    this.bells.clear();
    this.nextBell = 0;
    this.phase = 'running';
    for (const m of this.members.values()) {
      if (!m.conn && !m.bot) {
        this.members.delete(m.id);
        continue;
      }
      Object.assign(m, { state: 'alive', pos: null, score: 0, bellsSurvived: 0 });
      m.answers.clear();
      m.standMult.clear();
      if (m.bot) this.resetBot(m);
    }
    // room state first, so clients know who is alive when `start` arrives
    this.broadcastRoom();
    this.broadcast({ t: 'start', seed: this.seed, t0: this.t0 });
  }

  // ---------- public rooms & bots ----------

  private addBot() {
    const taken = new Set([...this.members.values()].map((m) => m.num));
    let n = randomInt(1, TOTAL_PLAYERS + 1);
    while (taken.has(n)) n = randomInt(1, TOTAL_PLAYERS + 1);
    const m: Member = {
      id: `bot-${randomBytes(4).toString('base64url')}`, key: `bot:${n}`, num: n, name: `bot ${String(n).padStart(3, '0')}`, conn: null,
      state: 'alive', disconnectedAt: null, pos: null, answers: new Map(), standMult: new Map(), score: 0, bellsSurvived: 0,
    };
    m.bot = { from: { x: 0, y: 0, at: 0 }, target: -1, targetX: 0, wakeAt: 0, answerAt: null, answerChoice: 0 };
    this.members.set(m.id, m);
  }

  private resetBot(m: Member) {
    const x = 60 + Math.random() * 240;
    m.pos = { x, y: 1320, f: 1, g: -1, at: this.now() };
    m.bot = { from: { x, y: 1320, at: this.t0 }, target: -1, targetX: x, wakeAt: this.t0 + 400 + Math.random() * 2500, answerAt: null, answerChoice: 0 };
  }

  /** Public lobby clock: start after a wait, fill empty seats with bots, start early when busy. */
  private tickPublic(now: number) {
    if (!this.isPublic || this.phase === 'running') return;
    if (!this.humans) {
      if (this.autoStartAt !== null) {
        this.autoStartAt = null;
        this.broadcastRoom();
      }
      return;
    }
    if (this.autoStartAt === null) {
      this.autoStartAt = now + (this.phase === 'over' ? ARENA.publicNextMatchMs : ARENA.publicWaitMs);
      this.broadcastRoom();
    }
    if (this.humans >= ARENA.publicFullStart && this.autoStartAt - now > 3000) {
      this.autoStartAt = now + 3000;
      this.broadcastRoom();
    }
    if (now >= this.autoStartAt) {
      for (const m of [...this.members.values()]) if (m.bot) this.members.delete(m.id);
      while (this.members.size < ARENA.botFill) this.addBot();
      this.startNow();
    }
  }

  /** Moves bots between platforms and has them answer. */
  private tickBots(now: number) {
    const course = this.course!;
    const { gone } = platformStates(this.seed, this.t0, now);
    const k = this.nextBell - 1;
    const plan = crumblePlan(this.seed);
    const willCrumble = new Set(plan.slice(Math.max(0, k + (this.bells.get(k)?.judged ? 1 : 0))).flat());
    for (const m of this.members.values()) {
      const b = m.bot;
      if (!b || m.state !== 'alive' || now < b.wakeAt) continue;
      // pick a new platform when we have none or ours is going away
      if (b.target < 0 || gone.has(b.target) || (willCrumble.has(b.target) && Math.random() < 0.02)) {
        const standing = course.platforms.filter((p) => !gone.has(p.i));
        const safe = standing.filter((p) => !willCrumble.has(p.i));
        const pool = safe.length && Math.random() < 0.85 ? safe : standing;
        const p = pool[Math.floor(Math.random() * pool.length)];
        b.from = { x: m.pos?.x ?? 100, y: m.pos?.y ?? 1320, at: now };
        b.target = p.i;
        b.targetX = p.cx + (Math.random() - 0.5) * (p.w - 30);
      }
      const p = course.platforms[b.target];
      const dur = Math.min(2400, 500 + Math.abs(b.targetX - b.from.x) * 1.6);
      const u = Math.min(1, (now - b.from.at) / dur);
      const x = b.from.x + (b.targetX - b.from.x) * u;
      const y = b.from.y + (p.baseY - b.from.y) * u - Math.sin(u * Math.PI) * 140;
      m.pos = { x, y, f: b.targetX >= b.from.x ? 1 : -1, g: u >= 1 ? b.target : -1, at: now };
      if (b.answerAt !== null && now >= b.answerAt) {
        this.answer(m.id, k, b.answerChoice);
        b.answerAt = null;
      }
    }
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
    const now = this.now();
    this.tickPublic(now);
    if (this.phase !== 'running' || !this.course) return;
    this.tickBots(now);
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
    const q = this.bells.get(k)!.question;
    for (const m of this.members.values()) {
      if (m.bot && m.state === 'alive') {
        m.bot.answerAt = now + 1500 + Math.random() * 6000;
        m.bot.answerChoice = Math.random() < ARENA.botAccuracy ? q.answer : (q.answer + 1 + Math.floor(Math.random() * 3)) % 4;
      }
    }
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
    if (this.isPublic) for (const m of [...this.members.values()]) if (m.bot) this.members.delete(m.id);
    this.autoStartAt = null;
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
    return [...this.members.values()].map((m) => ({ id: m.id, num: m.num, name: m.name, state: m.state, connected: !!m.conn || !!m.bot, ...(m.bot ? { bot: true } : {}) }));
  }

  broadcastRoom() {
    this.broadcast({ t: 'room', code: this.code, hostId: this.hostId, phase: this.phase, players: this.lobby(), isPublic: this.isPublic, autoStartAt: this.autoStartAt });
  }

  broadcast(msg: ServerMsg) {
    for (const m of this.members.values()) m.conn?.send(msg);
  }

  memberState(id: string) {
    return this.members.get(id)?.state ?? null;
  }
}
