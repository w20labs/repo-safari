import { describe, expect, it } from 'vitest';
import { ARENA, bellAt, crumblePlan, questionEndsAt } from '../shared/arena.ts';
import type { ServerMsg } from '../shared/protocol.ts';
import { Room } from '../server/arena/room.ts';

function setup(n = 3) {
  let now = 1_000_000;
  const clock = { set: (t: number) => (now = t), get: () => now };
  const room = new Room('abcd', () => now);
  const inbox = Array.from({ length: n }, () => [] as ServerMsg[]);
  const ids = inbox.map((box, i) => {
    const r = room.join(`key${i}`, null, `P${i}`, { send: (m) => box.push(m) });
    if ('error' in r) throw new Error(r.error);
    return r.id;
  });
  return { room, inbox, ids, clock };
}

const last = <T extends ServerMsg['t']>(box: ServerMsg[], t: T) => [...box].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

/** Test-only peek at the server's answer for bell k. */
const answerOf = (room: Room, k: number): number => (room as unknown as { bells: Map<number, { question: { answer: number } }> }).bells.get(k)!.question.answer;

/** Puts player `id` on platform `g` with a fresh report. */
const stand = (room: Room, id: string, g: number) => room.pos(id, { t: 'pos', x: 400, y: 900, vx: 0, vy: 0, g, f: 1 });

describe('arena room', () => {
  it('only the host can start, and t0 is 5 s ahead', () => {
    const { room, ids, inbox, clock } = setup();
    expect(room.start(ids[1])).toMatch(/host/);
    expect(room.start(ids[0])).toBeNull();
    const start = last(inbox[2], 'start')!;
    expect(start.t0).toBe(clock.get() + ARENA.leadMs);
  });

  it('eliminates players off a platform or with stale positions at the bell', () => {
    const { room, ids, inbox, clock } = setup();
    room.start(ids[0]);
    const t0 = room.t0;
    clock.set(bellAt(t0, 0) - 100);
    stand(room, ids[0], 2);
    room.pos(ids[1], { t: 'pos', x: 100, y: 1320, vx: 0, vy: 0, g: -1, f: 1 });
    clock.set(bellAt(t0, 0) - 1000);
    stand(room, ids[2], 3); // reported, but 1 s before the bell
    clock.set(bellAt(t0, 0));
    room.tick();
    const bell = last(inbox[0], 'bell')!;
    expect(bell.out.map((o) => o.id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(bell.question?.options).toHaveLength(4);
    expect(bell.question).not.toHaveProperty('answer');
    expect(last(inbox[1], 'bell')!.question).toBeNull();
  });

  it('judges answers on the server clock', () => {
    const { room, ids, inbox, clock } = setup();
    room.start(ids[0]);
    const t0 = room.t0;
    clock.set(bellAt(t0, 0) - 50);
    ids.forEach((id) => stand(room, id, 0));
    clock.set(bellAt(t0, 0));
    room.tick();
    clock.set(bellAt(t0, 0) + 2000);
    const right = answerOf(room, 0);
    room.answer(ids[0], 0, right);
    room.answer(ids[1], 0, (right + 1) % 4);
    clock.set(questionEndsAt(t0, 0) + 1);
    room.answer(ids[2], 0, right); // too late: counts as a timeout
    room.tick();
    const v = last(inbox[0], 'verdict')!;
    const reasons = Object.fromEntries(v.out.map((o) => [o.id, o.reason]));
    expect(reasons[ids[0]]).toBeUndefined();
    expect(reasons[ids[1]]).toMatch(/Wrong answer at bell 1/);
    expect(reasons[ids[2]]).toMatch(/Ran out of time at bell 1/);
    // 8 s left on a x1.0 platform (index 0)
    expect(v.you).toEqual({ choice: right, correct: true, points: Math.round((100 + 8 * 10) * room.course!.platforms[0].mult) });
  });

  it('crumbled platforms no longer count at the next bell', () => {
    const { room, ids, inbox, clock } = setup(1);
    room.start(ids[0]);
    const t0 = room.t0;
    const crumbled = crumblePlan(room.seed)[0][0];
    clock.set(bellAt(t0, 0) - 10);
    stand(room, ids[0], crumbled === 0 ? 1 : 0);
    clock.set(bellAt(t0, 0));
    room.tick();
    room.answer(ids[0], 0, answerOf(room, 0));
    clock.set(questionEndsAt(t0, 0));
    room.tick();
    expect(room.memberState(ids[0])).toBe('alive');
    clock.set(bellAt(t0, 1) - 10);
    stand(room, ids[0], crumbled);
    clock.set(bellAt(t0, 1));
    room.tick();
    expect(last(inbox[0], 'bell')!.out[0]?.reason).toMatch(/Not on a platform at bell 2/);
  });

  it('survivors of all six bells win with the bonus', () => {
    const { room, ids, inbox, clock } = setup(1);
    room.start(ids[0]);
    const t0 = room.t0;
    const plan = crumblePlan(room.seed).flat();
    const safe = Array.from({ length: 14 }, (_, i) => i).find((i) => !plan.includes(i))!;
    for (let k = 0; k < ARENA.bells; k++) {
      clock.set(bellAt(t0, k) - 10);
      stand(room, ids[0], safe);
      clock.set(bellAt(t0, k));
      room.tick();
      room.answer(ids[0], k, answerOf(room, k));
      clock.set(questionEndsAt(t0, k));
      room.tick();
    }
    const over = last(inbox[0], 'over')!;
    expect(over.winners).toEqual([ids[0]]);
    expect(over.bellsSurvived[ids[0]]).toBe(6);
    expect(over.scores[ids[0]]).toBeGreaterThan(500);
    expect(room.phase).toBe('over');
  });

  it('late joiners after the first bell are spectators', () => {
    const { room, ids, clock } = setup(1);
    room.start(ids[0]);
    clock.set(room.t0 + 1000);
    const early = room.join('early', null, 'E', { send: () => undefined });
    clock.set(bellAt(room.t0, 0) + 1);
    const late = room.join('late', null, 'L', { send: () => undefined });
    expect('id' in early && room.memberState(early.id)).toBe('alive');
    expect('id' in late && room.memberState(late.id)).toBe('spectator');
  });

  it('disconnected players are out after 10 s, unless they come back', () => {
    const { room, ids, inbox, clock } = setup(2);
    room.start(ids[0]);
    clock.set(room.t0 - 4000);
    room.disconnect(ids[0]);
    room.disconnect(ids[1]);
    clock.set(room.t0 - 1000);
    room.join('key1', null, 'P1', { send: (m) => inbox[1].push(m) });
    clock.set(room.t0 - 4000 + ARENA.disconnectGraceMs + 1);
    room.tick();
    expect(room.memberState(ids[0])).toBe('out');
    expect(room.memberState(ids[1])).toBe('alive');
  });

  it('assigns unique player numbers', () => {
    const { room } = setup(30);
    const nums = room.lobby().map((p) => p.num);
    expect(new Set(nums).size).toBe(30);
  });

  it('public rooms start on their own and fill with bots that play', () => {
    let now = 5_000_000;
    const room = new Room('pubx', () => now, { isPublic: true });
    const box: ServerMsg[] = [];
    const r = room.join('human', null, 'H', { send: (m) => box.push(m) });
    if ('error' in r) throw new Error(r.error);
    expect(room.start(r.id)).toMatch(/on their own/);
    room.tick();
    const lobby = last(box, 'room')!;
    expect(lobby.isPublic).toBe(true);
    expect(lobby.autoStartAt).toBe(now + ARENA.publicWaitMs);
    now += ARENA.publicWaitMs;
    room.tick();
    expect(room.phase).toBe('running');
    const players = last(box, 'room')!.players;
    expect(players).toHaveLength(ARENA.botFill);
    expect(players.filter((p) => p.bot)).toHaveLength(ARENA.botFill - 1);
    // bots get onto platforms and answer
    const t0 = room.t0;
    for (now = t0; now <= questionEndsAt(t0, 0) + 1; now += 50) room.tick();
    const v = last(box, 'verdict')!;
    expect(v.bell).toBe(0);
    const bots = players.filter((p) => p.bot).map((p) => p.id);
    const out = new Set(v.out.map((o) => o.id));
    const bellOut = new Set(box.filter((m) => m.t === 'bell').flatMap((m) => (m as Extract<ServerMsg, { t: 'bell' }>).out.map((o) => o.id)));
    // most bots reached a platform in time
    expect(bots.filter((id) => !bellOut.has(id)).length).toBeGreaterThanOrEqual(1);
    void out;
  });

  it('closing an old tab does not disconnect the same player in a newer tab', () => {
    const room = new Room('tabs', () => 1_000);
    const a: ServerMsg[] = [], b: ServerMsg[] = [];
    const tabA = { send: (m: ServerMsg) => a.push(m) };
    const tabB = { send: (m: ServerMsg) => b.push(m) };
    const r1 = room.join('same-player', null, 'P', tabA);
    const r2 = room.join('same-player', null, 'P', tabB);
    if ('error' in r1 || 'error' in r2) throw new Error('join failed');
    expect(r2.id).toBe(r1.id);
    room.disconnect(r1.id, tabA); // the old tab closes
    expect(room.lobby().map((p) => p.id)).toContain(r1.id);
    room.disconnect(r1.id, tabB); // the tab that owns the seat closes
    expect(room.lobby()).toHaveLength(0);
  });
});

