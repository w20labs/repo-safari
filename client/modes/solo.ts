import { COLORS, GATE_BONUS, PHYS, TOTAL_PLAYERS, padPlayerNumber } from '../../shared/constants.ts';
import type { Course } from '../../shared/course.ts';
import { prettyDate } from '../../shared/rng.ts';
import {
  FELL_LABEL,
  STANDING_LABEL,
  answerScore,
  fallIndex,
  formatScore,
  outOnLabel,
  squaresFor,
  timerFor,
} from '../../shared/scoring.ts';
import type { ResultSummary } from '../../shared/share.ts';
import type { Question, RunResult } from '../../shared/types.ts';
import { Bots } from '../game/bots.ts';
import { input } from '../game/input.ts';
import { NONE, makeBody, stepBody, type Body } from '../game/physics.ts';
import type { Actor } from '../game/render.ts';
import type { Mode, Stage } from '../game/stage.ts';
import { World } from '../game/world.ts';
import { clearHud, kv, setHud } from '../ui/hud.ts';
import { announce, hideOverlay } from '../ui/overlay.ts';
import { openQuestion } from '../ui/question.ts';
import { toast } from '../ui/toast.ts';

export interface SoloConfig {
  kind: 'daily' | 'practice';
  /** "Daily", "Daily replay", "Practice" */
  modeLabel: string;
  /** YYYYMMDD */
  date: string;
  course: Course;
  questionFor(i: number): Question;
  playerNum: number;
  name?: string;
  official?: boolean;
  bots?: boolean;
  onEnd(o: SoloOutcome): void;
}

export interface SoloOutcome {
  won: boolean;
  reason: string;
  score: number;
  cleared: number[];
  results: RunResult[];
  diedAt: number | null;
  playersLeft: number | null;
  /** quickest correct answer in ms, or null */
  fastestMs: number | null;
  summary: ResultSummary;
}

export const fastestLabel = (ms: number | null) => (ms === null ? '' : `fastest ${(ms / 1000).toFixed(1)}s`);

/** Daily and Practice runs: land on a platform, answer, clear it, reach the gate. */
export class SoloRun implements Mode {
  readonly world: World;
  private body: Body;
  private state: 'playing' | 'question' | 'over' = 'playing';
  private score = 0;
  private results: RunResult[] = [];
  private asked = new Set<number>();
  private bots: Bots | null = null;
  private playersLeft: number | null = null;
  private won = false;
  private fastestMs: number | null = null;

  constructor(private stage: Stage, private cfg: SoloConfig) {
    this.world = new World(cfg.course);
    this.body = makeBody(150, PHYS.floorY);
    if (cfg.bots) {
      const nums = new Set<number>();
      while (nums.size < 8) {
        const n = 1 + Math.floor(Math.random() * TOTAL_PLAYERS);
        if (n !== cfg.playerNum) nums.add(n);
      }
      this.bots = new Bots([...nums], this.world);
      this.playersLeft = TOTAL_PLAYERS;
    }
    input.clear();
    input.enabled = true;
    this.updateHud();
  }

  /** official daily runs can't be abandoned with Escape */
  get official() {
    return !!this.cfg.official;
  }

  get unlockLeft() {
    return Math.max(0, (this.cfg.course.unlock ?? 0) - this.world.cleared.size);
  }

  tick(dt: number) {
    if (this.state !== 'playing') return;
    const c = input.sample();
    this.world.advance(dt);
    const r = stepBody(this.body, c, dt, this.world);
    this.bots?.update(dt);
    if (r.landed !== null && !this.world.cleared.has(r.landed) && !this.asked.has(r.landed)) this.ask(r.landed);
    else if (r.inGate) this.win();
    else if (r.fell) this.fell();
    else if (r.blockedByGate) {
      const n = this.unlockLeft;
      toast(`Gate locked. Clear ${n} more platform${n === 1 ? '' : 's'}.`, 'pink', { key: 'gate', throttleMs: 2500 });
    }
  }

  focus() {
    return { x: this.body.x, y: this.body.y };
  }

  scene() {
    const b = this.body;
    const me: Actor = {
      x: b.x, y: b.y, facing: b.facing, num: this.cfg.playerNum, suit: COLORS.teal,
      runT: b.runT, airborne: b.ground === NONE, me: true, tag: 'YOU', alpha: this.state === 'over' && !this.won ? 0 : 1,
    };
    return {
      world: this.world,
      actors: [...(this.bots?.actors() ?? []), me],
      revealCleared: true,
      unlockLeft: this.unlockLeft,
    };
  }

  private updateHud() {
    const c = this.cfg;
    const total = c.course.platforms.length;
    const left = [
      { text: c.kind === 'daily' ? `DAILY ${prettyDate(c.date)}` : 'PRACTICE', cls: 'mode' },
      c.kind === 'daily' ? { text: c.official ? 'OFFICIAL' : 'REPLAY', cls: c.official ? 'official' : '' } : null,
      { text: kv(formatScore(this.score), 'pts'), cls: 'score' },
    ].filter(Boolean) as { text: string | HTMLElement; cls: string }[];
    const right = [
      { text: kv(`${this.world.cleared.size}/${total}`, 'cleared'), cls: '' },
      this.world.hasGate
        ? { text: this.world.gateOpen ? 'Gate open' : `Gate in ${this.unlockLeft}`, cls: this.world.gateOpen ? 'official' : '' }
        : null,
      this.playersLeft !== null ? { text: kv(this.playersLeft, 'left'), cls: 'pink' } : null,
    ].filter(Boolean) as { text: string | HTMLElement; cls: string }[];
    setHud(left, right);
  }

  private ask(i: number) {
    const p = this.cfg.course.platforms[i];
    const q = this.cfg.questionFor(i);
    this.asked.add(i);
    this.state = 'question';
    this.body.vx = 0;
    input.clear();
    const total = timerFor(p.gold) * 1000;
    const start = performance.now();
    const handle = openQuestion({
      question: q,
      region: p.repo.region,
      mult: p.mult,
      gold: p.gold,
      platformNo: i + 1,
      totalMs: total,
      msLeft: () => total - (performance.now() - start),
      onPick: async (choice, secondsLeft) => {
        const ok = choice === q.answer;
        const limit = timerFor(p.gold);
        const s = choice === null ? 0 : Math.min(limit, Math.max(ok ? 1 : 0, Math.ceil(secondsLeft)));
        this.results.push({ i, ok, s });
        let note: string | undefined;
        if (ok) {
          const took = total - Math.max(0, secondsLeft * 1000);
          this.fastestMs = this.fastestMs === null ? took : Math.min(this.fastestMs, took);
          const pts = answerScore(s, p.mult);
          this.score += pts;
          this.world.cleared.add(i);
          note = `Correct. +${pts} points. This was ${p.repo.name}.`;
          this.stage.particles.burst(this.body.x, this.body.y - 20, [COLORS.green, COLORS.teal, COLORS.lime], 26);
          this.onCorrect();
        }
        this.updateHud();
        await handle.reveal(q.answer, note);
        handle.close();
        hideOverlay();
        (document.activeElement as HTMLElement | null)?.blur?.();
        input.clear();
        if (ok) {
          this.state = 'playing';
          if (this.world.hasGate && !this.world.gateOpen && this.unlockLeft === 0) {
            this.world.gateOpen = true;
            toast('Gate open. Head for the exit on the far right.', 'teal', { ms: 3200 });
            announce('The exit gate is open.');
            this.updateHud();
          }
        } else {
          this.stage.particles.puff(this.body.x, this.body.y - 20);
          const reason = choice === null ? `Time ran out on ${p.repo.short}.` : `Wrong answer on ${p.repo.short}.`;
          this.end(false, reason, outOnLabel(this.cfg.course, i, q.kind), i);
        }
      },
    });
  }

  private onCorrect() {
    if (this.playersLeft === null) return;
    const drop = 6 + Math.floor(Math.random() * 14);
    this.playersLeft = Math.max(1, this.playersLeft - drop);
    const gone = this.bots?.eliminateNearest(this.body.x, this.body.y);
    if (gone) {
      this.stage.particles.puff(gone.x, gone.y - 20);
      toast(`Player ${padPlayerNumber(gone.num)} eliminated, along with ${drop - 1} others`, 'pink');
    } else toast(`${drop} more players eliminated`, 'pink');
  }

  private fell() {
    this.state = 'over';
    this.stage.particles.burst(this.body.x, PHYS.floorY + 20, [COLORS.pink, '#7A1238'], 30, 420);
    const at = fallIndex(this.cfg.course, this.world.cleared);
    setTimeout(() => this.end(false, 'You fell into the merge conflict.', FELL_LABEL, at), 650);
  }

  private win() {
    this.won = true;
    this.score += GATE_BONUS;
    this.stage.particles.burst(this.body.x, this.body.y - 30, [COLORS.teal, COLORS.amber, COLORS.lime, COLORS.green], 60, 480);
    this.updateHud();
    this.end(true, `You made it through the gate. +${GATE_BONUS} bonus.`, STANDING_LABEL, null);
  }

  private end(won: boolean, reason: string, outLine: string, diedAt: number | null) {
    this.state = 'over';
    input.clear();
    const c = this.cfg;
    const cleared = [...this.world.cleared];
    const total = c.course.platforms.length;
    const summary: ResultSummary = {
      mode: c.modeLabel,
      date: prettyDate(c.date),
      playerNum: c.playerNum,
      name: c.name,
      score: this.score,
      statLine: `${cleared.length}/${total} cleared`,
      squares: squaresFor(c.course, cleared, won ? null : diedAt),
      standing: won,
      outLine,
      rankLine: fastestLabel(this.fastestMs) || undefined,
    };
    c.onEnd({ won, reason, score: this.score, cleared, results: this.results, diedAt, playersLeft: this.playersLeft, fastestMs: this.fastestMs, summary });
  }

  dispose() {
    clearHud();
  }
}
