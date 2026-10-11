import { ARENA, arenaPhase, platformStates } from '../../shared/arena.ts';
import { COLORS, PHYS, padPlayerNumber } from '../../shared/constants.ts';
import { arenaCourse } from '../../shared/course.ts';
import type { Elimination, LobbyPlayer, ServerMsg } from '../../shared/protocol.ts';
import { formatScore } from '../../shared/scoring.ts';
import { input } from '../game/input.ts';
import { NONE, NO_CONTROLS, makeBody, stepBody, type Body } from '../game/physics.ts';
import type { Actor } from '../game/render.ts';
import type { Mode, Stage } from '../game/stage.ts';
import { World } from '../game/world.ts';
import type { ArenaSocket } from '../net/arena-socket.ts';
import { prefs } from '../prefs.ts';
import { kv, setHud, setHudCenter } from '../ui/hud.ts';
import { announce, hideOverlay } from '../ui/overlay.ts';
import { openQuestion, type QuestionHandle } from '../ui/question.ts';
import { toast } from '../ui/toast.ts';
import { sfx } from '../sound.ts';

const INTERP_DELAY_MS = 110;
const SUITS = ['#E07A9B', '#E2B65A', '#8FC8E8', '#B79CFF', '#FF8A65', '#9BE07A'];

interface Remote {
  /** [serverTime, x, y, facing, grounded] */
  buf: [number, number, number, number, number][];
  lastX: number;
  runT: number;
}

export interface ArenaOutcome {
  standing: boolean;
  reason: string;
  score: number;
  bellsSurvived: number;
  outAtBell: number | null;
  survivors: number;
}

export interface ArenaRunOpts {
  seed: number;
  t0: number;
  myId: string;
  myNum: number;
  code: string;
  spectator: boolean;
  players: () => LobbyPlayer[];
  onOver(o: ArenaOutcome): void;
}

/** One Arena match on the client. The server decides bells, answers and eliminations. */
export class ArenaRun implements Mode {
  readonly world: World;
  private body: Body;
  private state: 'alive' | 'out' | 'spectator';
  private remotes = new Map<string, Remote>();
  private lastSent = 0;
  private question: QuestionHandle | null = null;
  private questionBell = -1;
  private score = 0;
  private bellsSurvived = 0;
  private outReason = '';
  private outAtBell: number | null = null;
  private off: () => void;
  private watch: string | null = null;

  constructor(private stage: Stage, private sock: ArenaSocket, private o: ArenaRunOpts) {
    this.world = new World(arenaCourse(o.seed));
    this.body = makeBody(50 + Math.random() * 240, PHYS.floorY);
    this.state = o.spectator ? 'spectator' : 'alive';
    this.off = sock.on((m) => this.onMsg(m));
    input.clear();
    if (o.spectator) toast('The match already started. You are watching this round.', 'amber', { ms: 4000 });
  }

  dispose() {
    this.off();
    this.question?.close();
    this.question = null;
  }

  get alive() {
    return this.state === 'alive';
  }

  private nameOf(id: string): string {
    const p = this.o.players().find((x) => x.id === id);
    return p ? p.name || `Player ${padPlayerNumber(p.num)}` : 'A player';
  }

  // ---------- network ----------

  private onMsg(m: ServerMsg) {
    switch (m.t) {
      case 'snap': {
        const seen = new Set<string>();
        for (const [id, x, y, f, g] of m.p) {
          if (id === this.o.myId) continue;
          seen.add(id);
          let r = this.remotes.get(id);
          if (!r) this.remotes.set(id, (r = { buf: [], lastX: x, runT: 0 }));
          r.buf.push([m.s, x, y, f, g]);
          if (r.buf.length > 30) r.buf.shift();
        }
        for (const id of this.remotes.keys()) if (!seen.has(id)) this.remotes.delete(id);
        break;
      }
      case 'bell':
        sfx.bell();
        this.eliminate(m.out);
        if (m.question && this.alive) this.ask(m.question);
        break;
      case 'verdict': {
        const you = m.you;
        if (this.question && this.questionBell === m.bell) {
          const q = this.question;
          this.question = null;
          const note = you?.correct ? `Correct. +${you.points} points.` : you?.choice == null ? 'Time is up.' : undefined;
          void q.reveal(m.answer, note).then(() => {
            q.close();
            // only clear the overlay if it still shows this question (results may have replaced it)
            if (!this.question && document.querySelector('#overlay .question')) hideOverlay();
            (document.activeElement as HTMLElement | null)?.blur?.();
          });
        }
        if (you?.correct) {
          this.score += you.points;
          this.bellsSurvived = m.bell + 1;
          this.stage.particles.burst(this.body.x, this.body.y - 20, [COLORS.green, COLORS.teal], 22);
        }
        this.eliminate(m.out);
        break;
      }
      case 'elim':
        this.eliminate(m.out);
        break;
    }
  }

  private eliminate(out: Elimination[]) {
    const others: string[] = [];
    for (const e of out) {
      if (e.id === this.o.myId) {
        if (this.state !== 'alive') continue;
        this.state = 'out';
        this.outReason = e.reason;
        const ph = arenaPhase(this.o.t0, this.sock.serverNow());
        this.outAtBell = 'bell' in ph ? ph.bell : this.bellsSurvived;
        this.stage.particles.puff(this.body.x, this.body.y - 20);
        sfx.eliminated();
        toast(`You're out: ${e.reason.toLowerCase()}. Watching the rest.`, 'pink', { ms: 4000 });
        announce(`You are eliminated. ${e.reason}.`);
      } else {
        const p = this.sample(e.id);
        if (p) this.stage.particles.puff(p.x, p.y - 20);
        this.remotes.delete(e.id);
        others.push(e.id);
      }
    }
    if (others.length) sfx.otherOut();
    if (others.length === 1) toast(`${this.nameOf(others[0])} is out`, 'pink');
    else if (others.length > 1) toast(`${others.length} players are out`, 'pink');
  }

  private ask(q: NonNullable<Extract<ServerMsg, { t: 'bell' }>['question']>) {
    this.question?.close();
    const p = this.body.ground >= 0 ? this.world.course.platforms[this.body.ground] : null;
    this.questionBell = q.bell;
    input.clear();
    this.question = openQuestion({
      question: { ...q },
      region: p?.repo.region ?? 'web',
      mult: p?.mult ?? 1,
      totalMs: ARENA.questionMs,
      msLeft: () => q.deadline - this.sock.serverNow(),
      onPick: (choice) => {
        if (choice !== null) this.sock.send({ t: 'answer', bell: q.bell, choice });
        this.question?.setNote(choice === null ? 'Time is up. Waiting for the verdict…' : 'Locked in. Waiting for everyone else…');
      },
    });
  }

  // ---------- simulation ----------

  tick(dt: number) {
    const now = this.sock.serverNow();
    const ph = arenaPhase(this.o.t0, now);
    const { gone, crumbling } = platformStates(this.o.seed, this.o.t0, now);
    if (crumbling.size && !this.world.crumbling.size) sfx.crumble();
    this.world.gone.clear();
    gone.forEach((i) => this.world.gone.add(i));
    this.world.crumbling.clear();
    crumbling.forEach((i) => this.world.crumbling.add(i));
    this.world.advance(dt);

    if (this.alive) {
      const c = input.sample();
      const frozen = ph.kind === 'countdown' || ph.kind === 'question';
      const r = stepBody(this.body, frozen ? NO_CONTROLS : c, dt, this.world);
      if (r.jumped === 1) sfx.jump();
      else if (r.jumped === 2) sfx.doubleJump();
      if (r.touchedDown) sfx.land();
      if (r.fell) {
        sfx.fall();
        this.stage.particles.burst(this.body.x, PHYS.floorY + 20, [COLORS.pink], 18);
        this.body = makeBody(60 + Math.random() * 220, PHYS.floorY);
        toast('Into the merge conflict. Back to the start pad. Hurry.', 'pink', { key: 'fell', throttleMs: 1500 });
      }
      if (now - this.lastSent >= 1000 / ARENA.posHz) {
        this.lastSent = now;
        const b = this.body;
        this.sock.send({ t: 'pos', x: b.x, y: b.y, vx: b.vx, vy: b.vy, g: b.ground >= 0 ? b.ground : -1, f: b.facing });
      }
    } else input.sample();

    for (const r of this.remotes.values()) {
      const s = this.interp(r, now);
      if (s) {
        r.runT = Math.abs(s.x - r.lastX) > 0.5 ? r.runT + dt : 0;
        r.lastX = s.x;
      }
    }
    this.hud(ph);
  }

  private hud(ph: ReturnType<typeof arenaPhase>) {
    const standing = this.o.players().filter((p) => p.state === 'alive').length;
    setHud(
      [
        { text: `ARENA ${this.o.code.toUpperCase()}`, cls: 'mode' },
        { text: kv(formatScore(this.score), 'pts'), cls: 'score' },
        this.state !== 'alive' ? { text: this.state === 'spectator' ? 'WATCHING' : 'OUT', cls: 'pink' } : null,
      ].filter(Boolean) as { text: string | HTMLElement; cls: string }[],
      [
        { text: kv(`${this.bellsSurvived}/${ARENA.bells}`, 'bells'), cls: '' },
        { text: kv(standing, 'standing'), cls: 'pink' },
      ],
    );
    if (ph.kind === 'countdown') setHudCenter(`Starts in ${(ph.msLeft / 1000).toFixed(1)}s`, ph.msLeft < 3000);
    else if (ph.kind === 'roam') setHudCenter(`Bell ${ph.bell + 1} in ${(ph.msLeft / 1000).toFixed(1)}s`, ph.msLeft < 3000);
    else if (ph.kind === 'question') setHudCenter(`Bell ${ph.bell + 1} · answer`, false);
    else setHudCenter('Final bell rung', false);
  }

  private interp(r: Remote, now: number) {
    const t = now - INTERP_DELAY_MS;
    const b = r.buf;
    if (!b.length) return null;
    if (t <= b[0][0]) return { x: b[0][1], y: b[0][2], f: b[0][3], g: b[0][4] };
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i][0] <= t) {
        const a = b[i];
        const n = b[i + 1];
        if (!n) return { x: a[1], y: a[2], f: a[3], g: a[4] };
        const u = (t - a[0]) / Math.max(1, n[0] - a[0]);
        return { x: a[1] + (n[1] - a[1]) * u, y: a[2] + (n[2] - a[2]) * u, f: n[3], g: n[4] };
      }
    }
    return null;
  }

  private sample(id: string) {
    const r = this.remotes.get(id);
    return r ? this.interp(r, this.sock.serverNow()) : null;
  }

  focus() {
    if (this.alive) return { x: this.body.x, y: this.body.y };
    if (!this.watch || !this.remotes.has(this.watch)) this.watch = this.remotes.keys().next().value ?? null;
    const s = this.watch ? this.sample(this.watch) : null;
    return s ? { x: s.x, y: s.y } : { x: this.world.W / 2, y: PHYS.floorY - 300 };
  }

  scene() {
    const actors: Actor[] = [];
    const now = this.sock.serverNow();
    let k = 0;
    for (const [id, r] of this.remotes) {
      const s = this.interp(r, now);
      if (!s) continue;
      const p = this.o.players().find((x) => x.id === id);
      actors.push({
        x: s.x, y: s.y, facing: s.f === -1 ? -1 : 1, num: p?.num ?? 0, suit: SUITS[k++ % SUITS.length],
        runT: prefs.reducedMotion ? 0 : r.runT, airborne: !s.g, tag: p ? (p.bot ? `BOT ${padPlayerNumber(p.num)}` : p.name || padPlayerNumber(p.num)) : '', alpha: p?.bot ? 0.75 : 0.95,
      });
    }
    if (this.alive) {
      const b = this.body;
      actors.push({ x: b.x, y: b.y, facing: b.facing, num: this.o.myNum, suit: COLORS.teal, runT: b.runT, airborne: b.ground === NONE, me: true, tag: 'YOU' });
    }
    return { world: this.world, actors, revealCleared: false, unlockLeft: 0 };
  }

  /** Called when the server sends `over`. */
  finish(m: Extract<ServerMsg, { t: 'over' }>) {
    this.question?.close();
    this.question = null;
    const standing = m.winners.includes(this.o.myId);
    const score = m.scores[this.o.myId] ?? this.score;
    this.o.onOver({
      standing,
      reason: standing ? `You survived all ${ARENA.bells} bells. +500 bonus.` : this.state === 'spectator' ? 'You watched this round.' : `${this.outReason || 'Eliminated'}.`,
      score,
      bellsSurvived: m.bellsSurvived[this.o.myId] ?? this.bellsSurvived,
      outAtBell: standing ? null : this.outAtBell,
      survivors: m.winners.length,
    });
  }
}
