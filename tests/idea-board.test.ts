import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEK, eligibleAt, mondayOf, rank, validContributions, weekAt, weeksToClose, type Contribution, type StarEvent } from '../worker/src/board/contest.ts';
import { closeDueWeeks, closeWeek, moderate, moderateStars, publishDraft, saveDraft, setBuild, setStar, listIdeas, getIdea, contestInfo, launchAt, deleteAccount, cleanup, type DraftIdea, type RepoSnapshot } from '../worker/src/board/store.ts';
import { sqliteD1 } from './support/d1-sqlite.ts';

const T = (iso: string) => Date.parse(iso);
const LAUNCH = T('2026-10-07T10:00:00Z'); // a Wednesday: the first week is partial
const MON12 = T('2026-10-12T00:00:00Z'), MON19 = T('2026-10-19T00:00:00Z'), MON26 = T('2026-10-26T00:00:00Z');
const REPOS: RepoSnapshot[] = ['acme/rockets', 'acme/kites', 'zeta/pancakes'].map((name) => ({ name, url: `https://github.com/${name}`, desc: `${name} desc`, seenAt: '2026-10-07' }));
const idea = (n: string, kind: DraftIdea['kind'] = 'useful'): DraftIdea => ({ kind, name: n, pitch: `${n} pitch`, concept: `${n} concept`, inspiration: `${n} inspiration` });
const THREE = (p: string): DraftIdea[] => [idea(`${p} A`, 'useful'), idea(`${p} B`, 'unexpected'), idea(`${p} C`, 'ridiculous')];

describe('contest weeks', () => {
  it('weeks run Monday 00:00 UTC to Monday 00:00 UTC, and the launch week is partial', () => {
    expect(mondayOf(T('2026-10-18T23:59:59.999Z'))).toBe(MON12);
    expect(mondayOf(MON19)).toBe(MON19);
    expect(weekAt(LAUNCH - 1, LAUNCH)).toBeNull();
    expect(weekAt(LAUNCH, LAUNCH)).toEqual({ start: LAUNCH, end: MON12, partial: true });
    expect(weekAt(MON12 - 1, LAUNCH)).toEqual({ start: LAUNCH, end: MON12, partial: true });
    expect(weekAt(MON12, LAUNCH)).toEqual({ start: MON12, end: MON19, partial: false }); // the cutoff belongs to the new week
    expect(weekAt(MON12, MON12)?.partial).toBe(false); // launching on a Monday midnight: a full first week
  });
  it('closes ended weeks oldest first, a bounded number at a time', () => {
    expect(weeksToClose(LAUNCH, null, MON12 - 1)).toEqual([]);
    expect(weeksToClose(LAUNCH, null, MON26 + 5).map((w) => w.start)).toEqual([LAUNCH, MON12, MON19]);
    expect(weeksToClose(LAUNCH, MON12, MON26).map((w) => w.start)).toEqual([MON12, MON19]);
    expect(weeksToClose(LAUNCH, null, MON12 + 60 * WEEK, 8)).toHaveLength(8);
  });
});

describe('weekly scoring from history', () => {
  const week = { start: MON12, end: MON19, partial: false };
  const c = (ideaId: string, githubId: number, firstAt: number): Contribution => ({ ideaId, githubId, firstAt });
  const e = (ideaId: string, githubId: number, at: number, action: StarEvent['action']): StarEvent => ({ ideaId, githubId, at, action });
  it('counts a star in its first week only if it is active and valid at the cutoff', () => {
    const first = [c('a', 1, MON12 + 10), c('a', 2, MON12 + 20), c('a', 3, MON12 + 30), c('a', 4, MON12 + 40), c('a', 5, MON12 - 5)];
    const events = [
      e('a', 1, MON12 + 10, 'star'),
      e('a', 2, MON12 + 20, 'star'), e('a', 2, MON12 + 25, 'unstar'), // removed before close
      e('a', 3, MON12 + 30, 'star'), e('a', 3, MON12 + 35, 'unstar'), e('a', 3, MON12 + 36, 'star'), // restored before close: same contribution
      e('a', 4, MON12 + 40, 'star'), e('a', 4, MON19, 'unstar'), // unstarred at the cutoff instant: after the close, still counts
      e('a', 5, MON12 - 5, 'star'), // last week's star doesn't count this week
    ];
    expect(validContributions(week, first, events).map((x) => x.githubId)).toEqual([1, 3, 4]);
    // invalidated before the cutoff: out; invalidated after: still in (the result is frozen at the cutoff)
    expect(validContributions(week, first, [...events, e('a', 1, MON12 + 50, 'invalidate'), e('a', 3, MON19 + 1, 'invalidate')]).map((x) => x.githubId)).toEqual([3, 4]);
  });
  it('re-starring an old star in a later week adds nothing to the later week', () => {
    const first = [c('a', 1, MON12 - 100)]; // first starred last week
    expect(validContributions(week, first, [e('a', 1, MON12 - 100, 'star'), e('a', 1, MON12 - 50, 'unstar'), e('a', 1, MON12 + 10, 'star')])).toEqual([]);
  });
  it('ranks by new stars, then who reached the final score first, then publication, then id', () => {
    const ideas = [{ id: 'b', publishedAt: 5 }, { id: 'a', publishedAt: 5 }, { id: 'c', publishedAt: 1 }, { id: 'd', publishedAt: 2 }];
    const contribs = [c('a', 1, 100), c('a', 2, 300), c('b', 1, 100), c('b', 2, 300), c('c', 1, 50), c('c', 2, 400), c('d', 1, 10)];
    // a, b and c have 2; c reached 2 last (400); a and b both at 300, same publication time: smaller id
    expect(rank(ideas, contribs).map((s) => [s.id, s.score])).toEqual([['a', 2], ['b', 2], ['c', 2], ['d', 1]]);
    expect(rank([{ id: 'x', publishedAt: 9 }, { id: 'y', publishedAt: 3 }], [c('x', 1, 7), c('y', 1, 7)])[0].id).toBe('y'); // earlier publication
  });
  it('eligibility at the close: hidden, held, declined, previously selected or published after it are out', () => {
    const week2 = { start: MON12, end: MON19, partial: false };
    const ideas = ['ok', 'hid', 'held', 'dec', 'won', 'late', 'back'].map((id) => ({ id, publishedAt: id === 'late' ? MON19 : MON12 }));
    const mod = [
      { ideaId: 'hid', at: MON12 + 1, action: 'hide' as const }, { ideaId: 'held', at: MON12 + 1, action: 'hold' as const },
      { ideaId: 'dec', at: MON12 + 1, action: 'decline' as const }, { ideaId: 'back', at: MON12 + 1, action: 'hide' as const },
      { ideaId: 'back', at: MON12 + 2, action: 'unhide' as const }, { ideaId: 'ok', at: MON19 + 5, action: 'hide' as const }, // hidden after the close
    ];
    expect(eligibleAt(week2, ideas, mod, new Set(['won'])).map((i) => i.id)).toEqual(['ok', 'back']);
  });
});

// ---------- storage, on the real schema ----------
describe('board storage', () => {
  let db: ReturnType<typeof sqliteD1>;
  const account = (githubId: number, login = `user${githubId}`) => {
    db.raw.prepare('INSERT OR REPLACE INTO accounts (github_id, login, created_at, updated_at) VALUES (?, ?, 0, 0)').run(githubId, login);
    return { githubId, login };
  };
  /** Publishes a fresh idea (its own draft) at time `at`. */
  const publishAt = async (name: string, at: number, by = account(1)) => {
    const d = await saveDraft(db, REPOS, [idea(name)], 'test-model', at);
    const r = await publishDraft(db, by, d.id, d.receipt, 0, at);
    if ('error' in r) throw new Error(r.error);
    return r.id;
  };
  const stars = async (id: string, from: number, n: number, at: number, step = 1000) => {
    for (let k = 0; k < n; k++) { account(from + k); await setStar(db, id, from + k, true, at + k * step, weekAt(at + k * step, LAUNCH)); }
  };
  beforeEach(async () => { db = sqliteD1(); await launchAt(db, LAUNCH); });

  it('publishes exactly the saved idea; a receipt is required and a retry or duplicate reuses the record', async () => {
    const me = account(7, 'octo');
    const d = await saveDraft(db, REPOS, THREE('Kite'), 'test-model', LAUNCH);
    expect(await publishDraft(db, me, d.id, 'x'.repeat(43), 0, LAUNCH)).toEqual({ error: 'receipt' }); // the id alone isn't enough
    const first = await publishDraft(db, me, d.id, d.receipt, 1, LAUNCH);
    const again = await publishDraft(db, me, d.id, d.receipt, 1, LAUNCH + 5);
    expect(first).toMatchObject({ created: true });
    expect(again).toEqual({ id: (first as { id: string }).id, created: false });
    // the same idea generated again elsewhere and published by someone else: still one record
    const d2 = await saveDraft(db, REPOS, THREE('Kite'), 'test-model', LAUNCH + 9);
    expect(await publishDraft(db, account(8), d2.id, d2.receipt, 1, LAUNCH + 9)).toEqual({ id: (first as { id: string }).id, created: false });
    expect(await publishDraft(db, me, d.id, d.receipt, 5, LAUNCH)).toEqual({ error: 'index' });
    expect(await publishDraft(db, me, d.id, d.receipt, 0, LAUNCH + 86_400_001)).toEqual({ error: 'expired' });
    const row = db.raw.prepare('SELECT name, pitch, repos_json, stars_total, publisher_login FROM ideas').all() as { name: string; repos_json: string; stars_total: number }[];
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ name: 'Kite B', stars_total: 0, publisher_login: 'octo' }); // publishing doesn't star it
    expect(JSON.parse(row[0].repos_json).map((r: RepoSnapshot) => r.url)).toEqual(REPOS.map((r) => r.url));
  });

  it('limits publications per account per day, and never republishes a hidden duplicate', async () => {
    const me = account(3);
    for (let k = 0; k < 10; k++) await publishAt(`Idea ${k}`, LAUNCH + k, me);
    const d = await saveDraft(db, REPOS, [idea('Eleventh')], 'm', LAUNCH + 20);
    expect(await publishDraft(db, me, d.id, d.receipt, 0, LAUNCH + 20)).toEqual({ error: 'limit' });
    const id = await publishAt('Hidden one', LAUNCH + 86_400_100, me);
    await moderate(db, id, 'hide', 'spam', null, LAUNCH + 86_400_200);
    const d2 = await saveDraft(db, REPOS, [idea('Hidden one')], 'm', LAUNCH + 86_400_300);
    expect(await publishDraft(db, me, d2.id, d2.receipt, 0, LAUNCH + 86_400_300)).toEqual({ error: 'removed' });
  });

  it('stars are one per account, idempotent, keep their first time, and keep the count consistent', async () => {
    const id = await publishAt('Star me', LAUNCH);
    const w = weekAt(LAUNCH + 100, LAUNCH);
    account(11); account(12);
    const results = await Promise.all(Array.from({ length: 10 }, () => setStar(db, id, 11, true, LAUNCH + 100, w)));
    expect(results.every((r) => 'starred' in r && r.starred && r.total === 1)).toBe(true);
    await setStar(db, id, 12, true, LAUNCH + 200, w);
    expect(await setStar(db, id, 11, false, LAUNCH + 300, w)).toEqual({ starred: false, total: 1, week: 1 });
    expect(await setStar(db, id, 11, false, LAUNCH + 301, w)).toEqual({ starred: false, total: 1, week: 1 }); // idempotent
    await setStar(db, id, 11, true, MON19 + 5, weekAt(MON19 + 5, LAUNCH)); // re-star two weeks later
    const row = db.raw.prepare('SELECT first_starred_at FROM stars WHERE github_id = 11').get() as { first_starred_at: number };
    expect(row.first_starred_at).toBe(LAUNCH + 100); // never moves into the new week
    expect(db.raw.prepare('SELECT stars_total FROM ideas').get()).toEqual({ stars_total: 2 });
    expect((await getIdea(db, id, weekAt(MON19 + 5, LAUNCH)))?.weekStars).toBe(0);
    // a handle change is the same voter: the numeric id is the identity
    account(12, 'renamed');
    await setStar(db, id, 12, true, MON19 + 6, weekAt(MON19 + 6, LAUNCH));
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM stars').get()).toEqual({ n: 2 });
  });

  it('a week goes to new stars, not lifetime stars: 7 new beats 100 lifetime with 2 new', async () => {
    const old = await publishAt('Old favourite', LAUNCH);
    await stars(old, 1000, 98, LAUNCH + 1000, 10); // 98 in the launch week
    const old2 = await publishAt('Old but not chosen', LAUNCH + 50);
    await stars(old2, 3000, 98, LAUNCH + 2000, 10); // lifetime 98 + 2 below = 100 (still launch week)
    await closeDueWeeks(db, MON12 + 1); // launch week: 98 each; Old favourite got there first and wins it
    const fresh = await publishAt('Fresh', MON12 + 10);
    await stars(old2, 4000, 2, MON12 + 100);
    await stars(fresh, 5000, 7, MON12 + 200);
    const top = await listIdeas(db, 'top', null, weekAt(MON12 + 1000, LAUNCH));
    expect(top.items.map((i) => [i.name, i.weekStars, i.totalStars, i.rank])).toEqual([['Fresh', 7, 7, 1], ['Old but not chosen', 2, 100, 2]]);
    const [w] = await closeDueWeeks(db, MON19);
    expect(w).toMatchObject({ start: MON12, winner: fresh, score: 7, already: false });
    expect(db.raw.prepare('SELECT status FROM ideas WHERE id = ?').get(fresh)).toEqual({ status: 'selected' });
    expect(db.raw.prepare('SELECT weekly_stars, lifetime_stars, status FROM build_queue WHERE idea_id = ?').get(fresh)).toEqual({ weekly_stars: 7, lifetime_stars: 7, status: 'selected' });
  });

  it('a slow write that lands after its week was closed is dated into the next week (and can’t contradict the result)', async () => {
    const a = await publishAt('Late star', LAUNCH);
    account(42);
    const sundayRead = MON12 - 1000; // the request read the clock on Sunday…
    expect((await closeDueWeeks(db, MON12 + 5))[0]).toMatchObject({ winner: null }); // …the week closed on Monday…
    await setStar(db, a, 42, true, sundayRead, weekAt(sundayRead, LAUNCH)); // …then its write landed
    expect(db.raw.prepare('SELECT first_starred_at AS f FROM stars').get()).toEqual({ f: MON12 });
    expect(db.raw.prepare('SELECT MIN(at) AS t FROM star_events').get()).toEqual({ t: MON12 });
    // the history still agrees with the frozen result, and the star counts for the week it really joined
    const replay = validContributions(weekAt(LAUNCH, LAUNCH)!, [], db.raw.prepare('SELECT idea_id AS ideaId, github_id AS githubId, at, action FROM star_events').all() as StarEvent[]);
    expect(replay).toEqual([]);
    expect((await listIdeas(db, 'top', null, weekAt(MON12, LAUNCH))).items.map((i) => [i.id, i.weekStars])).toEqual([[a, 1]]);
    expect((await closeDueWeeks(db, MON19))[0]).toMatchObject({ winner: a, score: 1 });
    // late unstars, moderation and publications are dated after the seal too
    await setStar(db, a, 42, false, MON12 - 50, null);
    await moderate(db, a, 'hold', 'late', null, MON12 - 40);
    expect(db.raw.prepare("SELECT MIN(at) AS t FROM star_events WHERE action = 'unstar'").get()).toEqual({ t: MON19 });
    expect(db.raw.prepare('SELECT at FROM moderation_events').get()).toEqual({ at: MON19 });
  });

  it('moderation: what the board shows and what the close decides follow the same rules, for every sequence', async () => {
    const actions = ['hide', 'unhide', 'hold', 'release', 'decline', 'reinstate'] as const;
    const seqs: (typeof actions[number])[][] = [[]];
    for (let len = 1; len <= 3; len++) for (const prev of seqs.filter((q) => q.length === len - 1)) for (const a of actions) seqs.push([...prev, a]);
    let n = 0;
    for (const seq of seqs) {
      const id = await publishAt(`Mod ${n++}`, LAUNCH, account(9000 + n));
      for (const [k, a] of seq.entries()) await moderate(db, id, a, 'test', null, LAUNCH + 10 + k);
      const row = db.raw.prepare('SELECT status, hidden_at FROM ideas WHERE id = ?').get(id) as { status: string; hidden_at: number | null };
      const live = row.status === 'collecting' && row.hidden_at === null;
      const events = (db.raw.prepare('SELECT idea_id AS ideaId, at, action FROM moderation_events WHERE idea_id = ?').all(id)) as Parameters<typeof eligibleAt>[2];
      const replayed = eligibleAt(weekAt(LAUNCH, LAUNCH)!, [{ id, publishedAt: LAUNCH }], events, new Set()).length === 1;
      expect([seq.join('>'), live]).toEqual([seq.join('>'), replayed]);
    }
    expect(seqs.length).toBe(259);
  });

  it('hold, decline, reinstate: the idea leads and it can win', async () => {
    const duck = await publishAt('Duck', LAUNCH), haiku = await publishAt('Haiku', LAUNCH);
    await stars(duck, 100, 7, LAUNCH + 10); await stars(haiku, 200, 4, LAUNCH + 10);
    for (const a of ['hold', 'decline', 'reinstate'] as const) await moderate(db, duck, a, 'test', null, LAUNCH + 5000);
    expect((await listIdeas(db, 'top', null, weekAt(LAUNCH + 6000, LAUNCH))).items[0].id).toBe(duck);
    expect((await closeDueWeeks(db, MON12))[0].winner).toBe(duck);
  });

  it('simultaneous publications can’t pass the daily limit; simultaneous stars can’t pass the rate limit', async () => {
    const me = account(55);
    const drafts = await Promise.all(Array.from({ length: 12 }, (_, k) => saveDraft(db, REPOS, [idea(`Burst ${k}`)], 'm', LAUNCH)));
    const results = await Promise.all(drafts.map((d) => publishDraft(db, me, d.id, d.receipt, 0, LAUNCH + 1)));
    expect(results.filter((r) => 'id' in r)).toHaveLength(10);
    expect(results.filter((r) => 'error' in r && r.error === 'limit')).toHaveLength(2);
    const targets = await Promise.all(Array.from({ length: 70 }, (_, k) => publishAt(`Target ${k}`, LAUNCH + 2, account(7000 + k))));
    account(66);
    const w = weekAt(LAUNCH + 10, LAUNCH);
    const stars = await Promise.all(targets.map((t) => setStar(db, t, 66, true, LAUNCH + 10, w)));
    expect(stars.filter((r) => 'starred' in r)).toHaveLength(60);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM stars WHERE github_id = 66').get()).toEqual({ n: 60 });
  });

  it('the same idea from the same repos in another order is the same record', async () => {
    const d1 = await saveDraft(db, REPOS, [idea('Same')], 'm', LAUNCH);
    const d2 = await saveDraft(db, [...REPOS].reverse(), [idea('Same')], 'm', LAUNCH);
    const a = await publishDraft(db, account(1), d1.id, d1.receipt, 0, LAUNCH);
    const b = await publishDraft(db, account(2), d2.id, d2.receipt, 0, LAUNCH);
    expect(b).toEqual({ id: (a as { id: string }).id, created: false });
    expect(JSON.parse((db.raw.prepare('SELECT repos_json AS r FROM ideas').get() as { r: string }).r).map((r: RepoSnapshot) => r.name)).toEqual(REPOS.map((r) => r.name)); // the first publication's order is kept
  });

  it('one star can win; a week with no stars has no winner; a winner never wins again', async () => {
    const a = await publishAt('Lonely', LAUNCH);
    await stars(a, 1, 1, LAUNCH + 5);
    expect((await closeDueWeeks(db, MON12))[0]).toMatchObject({ winner: a, score: 1 });
    await stars(a, 50, 5, MON12 + 5); // more stars for the earlier winner
    const results = await closeDueWeeks(db, MON19);
    expect(results[0]).toMatchObject({ winner: null, score: 0 }); // it can't win twice and nobody else had a star
    expect(db.raw.prepare('SELECT winner_id FROM contests WHERE week_start = ?').get(MON12)).toEqual({ winner_id: null });
  });

  it('hidden and held ideas are skipped at the close; the next best wins', async () => {
    const [h, held, ok] = [await publishAt('Hidden', LAUNCH), await publishAt('Held', LAUNCH), await publishAt('Fine', LAUNCH)];
    await stars(h, 100, 5, LAUNCH + 10); await stars(held, 200, 4, LAUNCH + 10); await stars(ok, 300, 1, LAUNCH + 10);
    await moderate(db, h, 'hide', 'abuse', null, LAUNCH + 5000);
    await moderate(db, held, 'hold', 'licence check', 'On hold: checking a dependency licence.', LAUNCH + 5000);
    expect((await closeDueWeeks(db, MON12))[0]).toMatchObject({ winner: ok, score: 1 });
  });

  it('a delayed close uses the cutoff: later stars, unstars and moderation change nothing', async () => {
    const a = await publishAt('A', LAUNCH), b = await publishAt('B', LAUNCH);
    await stars(a, 100, 3, LAUNCH + 10);
    await stars(b, 200, 2, LAUNCH + 10);
    // after the cutoff, before the (late) job runs:
    for (const g of [100, 101, 102]) await setStar(db, a, g, false, MON12 + 10, weekAt(MON12 + 10, LAUNCH));
    await stars(b, 300, 9, MON12 + 20);
    await moderate(db, a, 'hide', 'late report', null, MON12 + 30);
    await moderateStars(db, 200, b, true, 'late exclusion', MON12 + 40);
    const [w] = await closeDueWeeks(db, MON12 + 3 * 86_400_000);
    expect(w).toMatchObject({ winner: a, score: 3 });
    // and an unstar after the close can't rewrite it
    await setStar(db, b, 201, false, MON12 + 4 * 86_400_000, null);
    expect(db.raw.prepare('SELECT winner_id, winner_score FROM contests').all()).toEqual([{ winner_id: a, winner_score: 3 }]);
  });

  it('closing twice, or at the same time, gives one result and one queue entry', async () => {
    const a = await publishAt('A', LAUNCH);
    await stars(a, 100, 2, LAUNCH + 10);
    const week = weekAt(LAUNCH, LAUNCH)!;
    const runs = await Promise.all([closeWeek(db, week, MON12), closeWeek(db, week, MON12 + 1), closeDueWeeks(db, MON12 + 2)]);
    expect(runs.flat().filter((r) => !r.already)).toHaveLength(1);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM contests').get()).toEqual({ n: 1 });
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM build_queue').get()).toEqual({ n: 1 });
  });

  it('catching up several missed weeks closes them in order and never picks the same idea twice', async () => {
    const a = await publishAt('A', LAUNCH), b = await publishAt('B', LAUNCH);
    await stars(a, 100, 5, LAUNCH + 10); await stars(b, 200, 3, LAUNCH + 10); // launch week: A
    await stars(a, 300, 4, MON12 + 10); await stars(b, 400, 1, MON12 + 10); // week 2: A has more but already won -> B
    await stars(a, 500, 2, MON19 + 10); // week 3: only A (already won) -> no winner
    const closed = await closeDueWeeks(db, MON26 + 1);
    expect(closed.map((c) => [c.start, c.winner])).toEqual([[LAUNCH, a], [MON12, b], [MON19, null]]);
    expect(db.raw.prepare('SELECT idea_id, week_start FROM build_queue ORDER BY week_start').all()).toEqual([{ idea_id: a, week_start: LAUNCH }, { idea_id: b, week_start: MON12 }]);
    expect(db.raw.prepare('SELECT partial FROM contests ORDER BY week_start').all().map((r) => (r as { partial: number }).partial)).toEqual([1, 0, 0]);
  });

  it('ties go to the idea that reached its final score first', async () => {
    const a = await publishAt('A', LAUNCH), b = await publishAt('B', LAUNCH + 1);
    await stars(a, 100, 2, LAUNCH + 10, 1000); // reaches 2 at +1010
    await stars(b, 200, 2, LAUNCH + 10, 500); // reaches 2 at +510: first
    expect((await closeDueWeeks(db, MON12))[0].winner).toBe(b);
  });

  it('the build moves through building to built with checked links; holds explain themselves publicly', async () => {
    const a = await publishAt('A', LAUNCH);
    await stars(a, 100, 1, LAUNCH + 10);
    await closeDueWeeks(db, MON12);
    expect(await setBuild(db, a, 'built', {}, MON12 + 1)).toEqual({ error: 'source_required' });
    expect(await setBuild(db, a, 'built', { sourceUrl: 'javascript:alert(1)' }, MON12 + 1)).toEqual({ error: 'bad_url' });
    expect(await setBuild(db, a, 'built', { sourceUrl: 'https://evil.example/x' }, MON12 + 1)).toEqual({ error: 'bad_url' });
    await setBuild(db, a, 'building', { note: 'Started.' }, MON12 + 2);
    expect((await listIdeas(db, 'building', null, null)).items.map((i) => [i.id, i.build?.status, i.build?.queuePosition])).toEqual([[a, 'building', 1]]);
    await setBuild(db, a, 'built', { sourceUrl: 'https://github.com/w20labs/a', demoUrl: 'https://w20labs.github.io/a/' }, MON12 + 3);
    const built = (await listIdeas(db, 'built', null, null)).items[0];
    expect(built.build).toMatchObject({ status: 'built', sourceUrl: 'https://github.com/w20labs/a', demoUrl: 'https://w20labs.github.io/a/', weeklyStars: 1 });
    expect(built).not.toHaveProperty('publisherId');
  });

  it('hidden ideas vanish from every view and their page; the contest shows a provisional leader', async () => {
    const a = await publishAt('Visible', LAUNCH), b = await publishAt('Gone', LAUNCH);
    await stars(a, 100, 1, LAUNCH + 10); await stars(b, 200, 3, LAUNCH + 10);
    await moderate(db, b, 'hide', 'abuse', null, LAUNCH + 50);
    const w = weekAt(LAUNCH + 100, LAUNCH);
    expect((await listIdeas(db, 'new', null, w)).items.map((i) => i.id)).toEqual([a]);
    expect((await listIdeas(db, 'top', null, w)).items.map((i) => i.id)).toEqual([a]);
    expect(await getIdea(db, b, w)).toBeNull();
    const info = await contestInfo(db, LAUNCH + 100, LAUNCH);
    expect(info.leader).toMatchObject({ id: a, provisional: true });
    expect(info.week).toEqual({ start: LAUNCH, end: MON12, partial: true });
  });

  it('pages through New without repeats', async () => {
    for (let k = 0; k < 30; k++) await publishAt(`N${k}`, LAUNCH + (k % 5), account(500 + k)); // ties on time: the id breaks them
    const seen: string[] = [];
    let cursor: string | null = null;
    do { const p = await listIdeas(db, 'new', cursor, null, 7); seen.push(...p.items.map((i) => i.id)); cursor = p.next; } while (cursor);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
  });

  it('deleting an account withdraws its stars and handle; expired records are cleaned up', async () => {
    const a = await publishAt('A', LAUNCH, account(1, 'publisher'));
    await stars(a, 100, 2, LAUNCH + 10);
    await deleteAccount(db, 1, 'user request', LAUNCH + 20);
    await deleteAccount(db, 100, 'user request', LAUNCH + 20);
    expect(db.raw.prepare('SELECT stars_total, publisher_login FROM ideas').get()).toEqual({ stars_total: 1, publisher_login: 'deleted-account' });
    await saveDraft(db, REPOS, [idea('temp')], 'm', LAUNCH);
    await cleanup(db, LAUNCH + 86_400_001);
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get()).toEqual({ n: 0 });
  });
});

// ---------- the Worker, end to end: generation, sign-in, publication, stars ----------
import worker from '../worker/src/index.ts';
import { Limiter } from '../worker/src/limiter.ts';
import { resetRepoCache } from '../worker/src/ideas.ts';
import { sha256B64url } from '../worker/src/board/util.ts';

describe('board through the Worker', () => {
  const PAGE = 'https://site.test';
  const IDEAS = { ideas: [idea('Error Karaoke', 'ridiculous'), idea('Kite Planner', 'useful'), idea('Rocket Breakfast', 'unexpected')] };
  let db: ReturnType<typeof sqliteD1>;
  let github: { id: number; login: string };
  let modelCalls = 0;
  const limiterNs = () => {
    const store = new Map<string, unknown>();
    const obj = new Limiter({ storage: { get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined, put: async <T>(k: string, v: T) => { store.set(k, structuredClone(v)); } } });
    return { idFromName: (n: string) => n, get: () => ({ fetch: (url: string, init?: RequestInit) => obj.fetch(new Request(url, init)) }) };
  };
  let limiter: ReturnType<typeof limiterNs>;
  const env = (on = true) => ({
    ANTHROPIC_API_KEY: 'k', IP_SALT: 's', LIMITER: limiter, REPOS_URL: `${PAGE}/repos.json`, ALLOWED_ORIGINS: PAGE,
    ...(on ? { BOARD_ENABLED: '1', BOARD_DB: db, GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'secret', ADMIN_TOKEN: 'a'.repeat(40) } : {}),
  });
  const call = (path: string, init: RequestInit & { origin?: string | null; token?: string; on?: boolean; ip?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.origin !== null) headers.set('Origin', init.origin ?? PAGE);
    if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
    headers.set('CF-Connecting-IP', init.ip ?? '1.1.1.1');
    if (init.body) headers.set('Content-Type', 'application/json');
    return worker.fetch(new Request(`https://w.test${path}`, { ...init, headers }), env(init.on ?? true) as never);
  };
  const generate = async (ip = '1.1.1.1') => (await (await call('/ideas', { method: 'POST', body: JSON.stringify({ repos: REPOS.map((r) => r.name) }), ip })).json()) as { ideas: DraftIdea[]; draft: { id: string; receipt: string } | null };
  /** The whole sign-in dance as a browser does it; returns the session token. */
  const signIn = async (as: { id: number; login: string }) => {
    github = as;
    const verifier = 'v'.repeat(43), challenge = await sha256B64url(verifier);
    const start = await call(`/auth/github/start?return=${encodeURIComponent(`${PAGE}/#ideas`)}&challenge=${challenge}`, { origin: null });
    const to = new URL(start.headers.get('Location')!);
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.has('scope')).toBe(false); // public profile only
    const back = await call(`/auth/github/callback?code=gh-code&state=${to.searchParams.get('state')}`, { origin: null });
    const landing = new URL(back.headers.get('Location')!);
    expect(landing.origin).toBe(PAGE);
    const code = new URLSearchParams(landing.hash.slice(1)).get('login')!;
    const ex = await call('/auth/exchange', { method: 'POST', body: JSON.stringify({ code, verifier }) });
    return { token: ((await ex.json()) as { token: string }).token, state: to.searchParams.get('state')!, code, verifier };
  };

  beforeEach(() => {
    db = sqliteD1(); limiter = limiterNs(); modelCalls = 0; resetRepoCache();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(LAUNCH);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${PAGE}/repos.json`)) return Response.json(REPOS.map((r) => ({ name: r.name, desc: r.desc, room: 'Test room', stars: 1234 })));
      if (url.endsWith('/v1/messages')) { modelCalls++; return Response.json({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: JSON.stringify(IDEAS) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }); }
      if (url === 'https://github.com/login/oauth/access_token') { expect(JSON.parse(String(init?.body)).client_secret).toBe('secret'); return Response.json({ access_token: 'gho_token' }); }
      if (url === 'https://api.github.com/user') return Response.json(github);
      return new Response('nope', { status: 404 });
    }));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('generate anonymously, sign in, publish, then another account stars it and both see the same count', async () => {
    const gen = await generate();
    expect(gen.ideas).toHaveLength(3);
    expect(gen.draft).toMatchObject({ id: expect.any(String), receipt: expect.any(String) });
    const alice = await signIn({ id: 101, login: 'alice' });
    const pub = await call('/board/publish', { method: 'POST', token: alice.token, body: JSON.stringify({ draftId: gen.draft!.id, receipt: gen.draft!.receipt, index: 2 }) });
    const { id } = (await pub.json()) as { id: string };
    expect(pub.status).toBe(200);
    const page = await (await call(`/board/ideas/${id}`, { origin: null })).json() as { idea: Record<string, unknown> };
    expect(page.idea).toMatchObject({ name: 'Error Karaoke', publisher: 'alice', totalStars: 0, weekStars: 0, status: 'collecting' });
    expect(JSON.stringify(page)).not.toMatch(/draft|receipt|101|publisher_id|token/i);
    const bob = await signIn({ id: 202, login: 'bob' });
    const s1 = await (await call(`/board/ideas/${id}/star`, { method: 'PUT', token: bob.token })).json();
    expect(s1).toEqual({ starred: true, total: 1, week: 1 });
    const s2 = await (await call(`/board/ideas/${id}/star`, { method: 'PUT', token: alice.token })).json(); // publishers may star their own
    expect(s2).toEqual({ starred: true, total: 2, week: 2 });
    const seen = await (await call(`/board/ideas/${id}`)).json() as { idea: { totalStars: number } };
    expect(seen.idea.totalStars).toBe(2);
    expect(await (await call(`/board/me?ids=${id}`, { token: bob.token })).json()).toEqual({ account: { login: 'bob' }, starred: [id] });
    expect(modelCalls).toBe(1); // signing in, publishing and starring call no model
  });

  it('refuses publication without a session, without the receipt, or with someone else’s draft text', async () => {
    const gen = await generate();
    const { token } = await signIn({ id: 5, login: 'eve' });
    const body = (b: unknown) => ({ method: 'POST', token, body: JSON.stringify(b) });
    expect((await call('/board/publish', { method: 'POST', body: JSON.stringify({ draftId: gen.draft!.id, receipt: gen.draft!.receipt, index: 0 }) })).status).toBe(401);
    expect((await call('/board/publish', body({ draftId: gen.draft!.id, receipt: 'A'.repeat(43), index: 0 }))).status).toBe(403);
    // extra fields (own text, own repos) are ignored: only the saved draft is published
    const r = await call('/board/publish', body({ draftId: gen.draft!.id, receipt: gen.draft!.receipt, index: 0, name: 'My own text', repos: ['evil/x', 'a/b', 'c/d'] }));
    const { id } = (await r.json()) as { id: string };
    const idea = (await (await call(`/board/ideas/${id}`)).json() as { idea: { name: string; repos: { name: string }[] } }).idea;
    expect(idea.name).toBe('Kite Planner'); // the Worker orders ideas useful, unexpected, ridiculous
    expect(idea.repos.map((x) => x.name)).toEqual(REPOS.map((x) => x.name));
    // a crafted legacy #mix= payload has no draft or receipt: there is nothing to submit it with
    expect((await call('/board/publish', body({ mix: 'eyJ2IjoxfQ', index: 0 }))).status).toBe(400);
  });

  it('a lost-response retry and two tabs give one star; unstar is idempotent', async () => {
    const gen = await generate();
    const { token } = await signIn({ id: 9, login: 'nine' });
    const { id } = (await (await call('/board/publish', { method: 'POST', token, body: JSON.stringify({ draftId: gen.draft!.id, receipt: gen.draft!.receipt, index: 1 }) })).json()) as { id: string };
    const tab2 = (await signIn({ id: 9, login: 'nine' })).token;
    const all = await Promise.all([token, tab2, token, tab2].map((t) => call(`/board/ideas/${id}/star`, { method: 'PUT', token: t }).then((r) => r.json())));
    expect(all.every((x) => (x as { total: number }).total === 1)).toBe(true);
    expect(await (await call(`/board/ideas/${id}/star`, { method: 'DELETE', token })).json()).toEqual({ starred: false, total: 0, week: 0 });
    expect(await (await call(`/board/ideas/${id}/star`, { method: 'DELETE', token: tab2 })).json()).toEqual({ starred: false, total: 0, week: 0 });
  });

  it('sign-in: replayed callbacks, wrong verifiers, reused codes, unsafe returns and expired sessions all fail', async () => {
    const ok = await signIn({ id: 1, login: 'one' });
    const replay = await call(`/auth/github/callback?code=gh-code&state=${ok.state}`, { origin: null });
    expect(replay.status).toBe(400); // the state was used up
    expect((await call('/auth/exchange', { method: 'POST', body: JSON.stringify({ code: ok.code, verifier: ok.verifier }) })).status).toBe(401); // the code was used up
    expect((await call(`/auth/github/start?return=${encodeURIComponent('https://evil.test/')}&challenge=${'c'.repeat(43)}`, { origin: null })).status).toBe(400);
    expect((await call(`/auth/github/start?return=${encodeURIComponent('javascript:alert(1)')}&challenge=${'c'.repeat(43)}`, { origin: null })).status).toBe(400);
    // a code without the verifier from the browser that started the sign-in is worthless
    github = { id: 2, login: 'two' };
    const start = await call(`/auth/github/start?return=${encodeURIComponent(PAGE)}&challenge=${await sha256B64url('w'.repeat(43))}`, { origin: null });
    const back = await call(`/auth/github/callback?code=x&state=${new URL(start.headers.get('Location')!).searchParams.get('state')}`, { origin: null });
    const code = new URLSearchParams(new URL(back.headers.get('Location')!).hash.slice(1)).get('login');
    expect((await call('/auth/exchange', { method: 'POST', body: JSON.stringify({ code, verifier: 'v'.repeat(43) }) })).status).toBe(401);
    // sessions expire after 30 days
    vi.setSystemTime(LAUNCH + 31 * 86_400_000);
    expect((await call('/board/me', { token: ok.token })).status).toBe(401);
  });

  it('writes need an allowed Origin; logout ends the session', async () => {
    const { token } = await signIn({ id: 3, login: 'three' });
    expect((await call('/board/ideas/abcdefghij/star', { method: 'PUT', token, origin: 'https://evil.test' })).status).toBe(403);
    expect((await call('/board/ideas/abcdefghij/star', { method: 'PUT', token, origin: null })).status).toBe(403);
    await call('/auth/logout', { method: 'POST', token });
    expect((await call('/board/me', { token })).status).toBe(401);
  });

  it('if saving the draft fails, the ideas still come back once, marked unpublishable', async () => {
    db.failNext(1);
    const gen = await generate();
    expect(gen.ideas).toHaveLength(3);
    expect(gen.draft).toBeNull();
    expect(modelCalls).toBe(1);
  });

  it('with the board off: no draft, and every board and sign-in path is a 404', async () => {
    const r = await call('/ideas', { method: 'POST', on: false, body: JSON.stringify({ repos: REPOS.map((x) => x.name) }) });
    expect(await r.json()).toEqual({ ideas: expect.any(Array) });
    for (const p of ['/board/contest', '/board/ideas?view=new', '/auth/github/start', '/board/admin', '/dev/clock']) expect((await call(p, { on: false })).status).toBe(404);
    const sched = vi.fn();
    await worker.scheduled({}, env(false) as never, { waitUntil: sched });
    expect(sched).not.toHaveBeenCalled();
  });

  it('owner operations need the admin token; the test clock only exists in the local preview', async () => {
    expect((await call('/board/admin', { method: 'POST', body: JSON.stringify({ action: 'report' }) })).status).toBe(401);
    const ok = await call('/board/admin', { method: 'POST', headers: { 'X-Admin-Token': 'a'.repeat(40) }, body: JSON.stringify({ action: 'report' }) });
    expect(ok.status).toBe(200);
    expect((await call('/dev/clock', { method: 'POST', body: JSON.stringify({ at: 1 }) })).status).toBe(404); // no BOARD_DEV
  });

  it('a star sent just before midnight but accepted after it counts in the new week (server clock)', async () => {
    const gen = await generate();
    const { token } = await signIn({ id: 77, login: 'late' });
    const { id } = (await (await call('/board/publish', { method: 'POST', token, body: JSON.stringify({ draftId: gen.draft!.id, receipt: gen.draft!.receipt, index: 0 }) })).json()) as { id: string };
    vi.setSystemTime(MON12); // the request left the browser at 23:59:59.9; the Worker handled it at 00:00:00.000
    expect(await (await call(`/board/ideas/${id}/star`, { method: 'PUT', token })).json()).toEqual({ starred: true, total: 1, week: 1 });
    expect(db.raw.prepare('SELECT first_starred_at FROM stars').get()).toEqual({ first_starred_at: MON12 });
    const contest = await (await call('/board/contest')).json() as { week: { start: number } };
    expect(contest.week.start).toBe(MON12);
  });
});
