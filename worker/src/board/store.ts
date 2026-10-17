/**
 * Idea board storage (D1): drafts and receipts, publication, stars, board queries, weekly closing, owner operations.
 * Every write that has to stay consistent is one statement or one batch (a transaction); star history and the
 * materialized lifetime count are kept by triggers (migrations/0001_idea_board.sql).
 */
import type { D1Database } from './d1';
import { DAY, POLICY_VERSION, WEEK, applyModeration, eligibleAt, type Moderation, type ModerationAction, rank, validContributions, weekAt, weeksToClose, type Contribution, type ModerationEvent, type StarEvent, type Week } from './contest';
import { cleanNote, newId, newSecret, safeHttpsUrl, sameSecret, sha256Hex } from './util';

export const DRAFT_TTL = DAY; // unpublished generated output is deleted after 24 hours
export const PUBLISH_PER_DAY = 10; // new publications per account per 24 hours
export const STARS_PER_MINUTE = 60; // star/unstar changes per account per minute
const PAGE = 12;

export type Kind = 'useful' | 'unexpected' | 'ridiculous';
export type DraftIdea = { kind: Kind; name: string; pitch: string; concept: string; inspiration: string };
/** What we keep about a source repo when an idea is generated: enough to explain it after it leaves the trail. */
export type RepoSnapshot = { name: string; url: string; desc: string; room?: string; stars?: number; seenAt: string };
export type Account = { githubId: number; login: string };

const json = <T>(s: unknown): T => JSON.parse(String(s)) as T;
/**
 * The end of the newest week that closing has sealed. Every vote, moderation and publication time is written as
 * MAX(request time, this) inside its own statement, so a write that lands after a week was sealed (a slow request that
 * read the clock on Sunday) is dated into the next week instead of slipping behind a frozen result. D1 runs writes one
 * at a time, so each write sees the seal or doesn't, atomically.
 */
const SEALED = "COALESCE((SELECT CAST(value AS INTEGER) FROM board_settings WHERE key = 'sealed_through'), 0)";
const at = (param = '?') => `MAX(${param}, ${SEALED})`;
const ids = (list: string[]) => JSON.stringify(list); // bound as one parameter and read with json_each (D1 allows 100 parameters)

// ---------- launch and clock ----------
/** When the board first ran enabled; recorded once (the first contest starts here). */
export async function launchAt(db: D1Database, now: number | null): Promise<number | null> {
  if (now !== null) await db.prepare("INSERT OR IGNORE INTO board_settings (key, value) VALUES ('launch_at', ?)").bind(String(now)).run();
  const row = await db.prepare("SELECT value FROM board_settings WHERE key = 'launch_at'").first<{ value: string }>();
  return row ? Number(row.value) : null;
}

// ---------- drafts: generated output, saved before anyone can publish it ----------
export async function saveDraft(db: D1Database, repos: RepoSnapshot[], ideas: DraftIdea[], model: string, now: number) {
  const id = newSecret().slice(0, 22), receipt = newSecret();
  await db.prepare('INSERT INTO drafts (id, receipt_hash, repos_json, ideas_json, model, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, await sha256Hex(receipt), JSON.stringify(repos), JSON.stringify(ideas), model, now, now + DRAFT_TTL).run();
  return { id, receipt, expiresAt: now + DRAFT_TTL };
}

export type PublishResult = { id: string; created: boolean } | { error: 'expired' | 'receipt' | 'index' | 'removed' | 'limit' };

/**
 * Publishes idea `index` of a saved draft, exactly as the Worker generated it. Needs the draft's receipt (the browser
 * that generated it holds it), not just its id. The same content and repos always map to one public record, so a
 * retry or a duplicate reuses it instead of splitting its stars.
 */
export async function publishDraft(db: D1Database, who: Account, draftId: string, receipt: string, index: number, now: number): Promise<PublishResult> {
  const d = await db.prepare('SELECT receipt_hash, repos_json, ideas_json, model, expires_at FROM drafts WHERE id = ?').bind(draftId)
    .first<{ receipt_hash: string; repos_json: string; ideas_json: string; model: string; expires_at: number }>();
  if (!d || d.expires_at <= now) return { error: 'expired' };
  if (!sameSecret(d.receipt_hash, await sha256Hex(receipt))) return { error: 'receipt' };
  const idea = json<DraftIdea[]>(d.ideas_json)[index];
  if (!Number.isInteger(index) || !idea) return { error: 'index' };
  const repos = json<RepoSnapshot[]>(d.repos_json);
  // identity ignores the order of the source repos (the snapshot keeps it for display)
  const hash = await sha256Hex(JSON.stringify([idea.kind, idea.name, idea.pitch, idea.concept, idea.inspiration, repos.map((r) => r.name.toLowerCase()).sort()]));
  const existing = await db.prepare('SELECT id, hidden_at FROM ideas WHERE content_hash = ?').bind(hash).first<{ id: string; hidden_at: number | null }>();
  if (existing) return existing.hidden_at ? { error: 'removed' } : { id: existing.id, created: false };
  const id = newId();
  // the daily limit is checked in the same statement as the insert, so simultaneous publications can't all slip under it
  await db.prepare(`INSERT INTO ideas (id, content_hash, kind, name, pitch, concept, inspiration, repos_json, publisher_id, publisher_login, draft_id, model, published_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${at()}
    WHERE (SELECT COUNT(*) FROM ideas WHERE publisher_id = ? AND published_at > ?) < ?
    ON CONFLICT(content_hash) DO NOTHING`)
    .bind(id, hash, idea.kind, idea.name, idea.pitch, idea.concept, idea.inspiration, d.repos_json, who.githubId, who.login, draftId, d.model, now,
      who.githubId, now - DAY, PUBLISH_PER_DAY).run();
  // a simultaneous duplicate may have won the insert: either way, that is the one public record
  const row = await db.prepare('SELECT id, hidden_at FROM ideas WHERE content_hash = ?').bind(hash).first<{ id: string; hidden_at: number | null }>();
  if (!row) return { error: 'limit' };
  if (row.hidden_at) return { error: 'removed' };
  return { id: row.id, created: row.id === id };
}

// ---------- stars ----------
export type StarResult = { starred: boolean; total: number; week: number } | { error: 'not_found' | 'limit' };

/**
 * Sets (on) or clears (off) this account's star. Idempotent: repeating it changes nothing, and a re-star keeps the
 * original first-star time, so old support never moves into a new week. The lifetime count and the history are
 * updated by triggers in the same statement.
 */
export async function setStar(db: D1Database, ideaId: string, githubId: number, on: boolean, now: number, week: Week | null): Promise<StarResult> {
  const idea = await db.prepare('SELECT hidden_at FROM ideas WHERE id = ?').bind(ideaId).first<{ hidden_at: number | null }>();
  if (!idea || idea.hidden_at) return { error: 'not_found' };
  // one statement each: the rate limit, the time (never behind a sealed week) and the change are decided together
  const underLimit = 'SELECT COUNT(*) FROM star_events WHERE github_id = ? AND at > ?';
  if (on) {
    await db.prepare(`INSERT INTO stars (idea_id, github_id, first_starred_at, active, updated_at)
      SELECT ?, ?, ${at()}, 1, ${at()} WHERE (${underLimit}) < ?
      ON CONFLICT(idea_id, github_id) DO UPDATE SET active = 1, updated_at = excluded.updated_at WHERE stars.active = 0`)
      .bind(ideaId, githubId, now, now, githubId, now - 60_000, STARS_PER_MINUTE).run();
  } else {
    await db.prepare(`UPDATE stars SET active = 0, updated_at = ${at()} WHERE idea_id = ? AND github_id = ? AND active = 1 AND (${underLimit}) < ?`)
      .bind(now, ideaId, githubId, githubId, now - 60_000, STARS_PER_MINUTE).run();
  }
  const mineNow = await db.prepare('SELECT active FROM stars WHERE idea_id = ? AND github_id = ?').bind(ideaId, githubId).first<{ active: number }>();
  if ((mineNow?.active === 1) !== on) return { error: 'limit' }; // the only way the change didn't stick
  // a request that crossed a sealed Monday counts in the new week: report that week
  const sealed = await sealedThrough(db);
  if (week && sealed >= week.end) week = { start: sealed, end: sealed + WEEK, partial: false };
  const [mine, counts] = await Promise.all([
    db.prepare('SELECT active FROM stars WHERE idea_id = ? AND github_id = ?').bind(ideaId, githubId).first<{ active: number }>(),
    weekCounts(db, [ideaId], week),
  ]);
  const total = await db.prepare('SELECT stars_total FROM ideas WHERE id = ?').bind(ideaId).first<{ stars_total: number }>();
  return { starred: mine?.active === 1, total: total?.stars_total ?? 0, week: counts.get(ideaId) ?? 0 };
}

export async function sealedThrough(db: D1Database): Promise<number> {
  const r = await db.prepare(`SELECT ${SEALED} AS s`).first<{ s: number }>();
  return r?.s ?? 0;
}

/** Which of these ideas the account has starred. */
export async function starredBy(db: D1Database, githubId: number, ideaIds: string[]): Promise<string[]> {
  if (!ideaIds.length) return [];
  const { results } = await db.prepare('SELECT idea_id FROM stars WHERE github_id = ? AND active = 1 AND idea_id IN (SELECT value FROM json_each(?))')
    .bind(githubId, ids(ideaIds)).all<{ idea_id: string }>();
  return results.map((r) => r.idea_id);
}

/** Valid stars first given this week, per idea. */
async function weekCounts(db: D1Database, ideaIds: string[], week: Week | null): Promise<Map<string, number>> {
  if (!week || !ideaIds.length) return new Map();
  const { results } = await db.prepare(`SELECT idea_id, COUNT(*) AS n FROM stars
    WHERE first_starred_at >= ? AND active = 1 AND invalidated_at IS NULL AND idea_id IN (SELECT value FROM json_each(?)) GROUP BY idea_id`)
    .bind(week.start, ids(ideaIds)).all<{ idea_id: string; n: number }>();
  return new Map(results.map((r) => [r.idea_id, r.n]));
}

// ---------- reading the board ----------
type IdeaRow = { id: string; kind: Kind; name: string; pitch: string; concept: string; inspiration: string; repos_json: string; publisher_login: string; published_at: number; status: string; status_note: string | null; stars_total: number };
type QueueRow = { idea_id: string; week_start: number; week_end: number; weekly_stars: number; lifetime_stars: number; selected_at: number; status: string; status_note: string | null; demo_url: string | null; source_url: string | null };
const IDEA_COLS = 'i.id, i.kind, i.name, i.pitch, i.concept, i.inspiration, i.repos_json, i.publisher_login, i.published_at, i.status, i.status_note, i.stars_total';

export type PublicIdea = {
  id: string; kind: Kind; name: string; pitch: string; concept?: string; inspiration?: string;
  repos: { name: string; url: string; desc?: string; room?: string }[]; publisher: string; publishedAt: number;
  status: string; statusNote: string | null; weekStars: number; totalStars: number; rank?: number;
  build?: { weekStart: number; weekEnd: number; weeklyStars: number; lifetimeStars: number; selectedAt: number; status: string; note: string | null; demoUrl: string | null; sourceUrl: string | null; queuePosition: number | null };
};

/** Only public fields: never draft ids, publisher ids, receipts or voters. */
function publicIdea(r: IdeaRow, weekStars: number, full: boolean, q?: QueueRow | null, queuePosition: number | null = null): PublicIdea {
  const repos = json<RepoSnapshot[]>(r.repos_json).map((x) => ({ name: x.name, url: x.url, ...(full ? { desc: x.desc, room: x.room } : {}) }));
  return {
    id: r.id, kind: r.kind, name: r.name, pitch: r.pitch, ...(full ? { concept: r.concept, inspiration: r.inspiration } : {}),
    repos, publisher: r.publisher_login, publishedAt: r.published_at, status: r.status, statusNote: r.status_note,
    weekStars, totalStars: r.stars_total,
    ...(q ? { build: { weekStart: q.week_start, weekEnd: q.week_end, weeklyStars: q.weekly_stars, lifetimeStars: q.lifetime_stars, selectedAt: q.selected_at, status: q.status, note: q.status_note, demoUrl: q.demo_url, sourceUrl: q.source_url, queuePosition } } : {}),
  };
}

export type View = 'top' | 'new' | 'building' | 'built';
export type Page = { items: PublicIdea[]; next: string | null };

/** One page of a board view. `cursor` is opaque to the page: an offset for ranked views, a position for New. */
export async function listIdeas(db: D1Database, view: View, cursor: string | null, week: Week | null, limit = PAGE): Promise<Page> {
  limit = Math.max(1, Math.min(limit, 30));
  if (view === 'top') {
    if (!week) return { items: [], next: null };
    const offset = Math.max(0, Math.min(Number(cursor) || 0, 500));
    const { results } = await db.prepare(`SELECT ${IDEA_COLS}, COUNT(*) AS week_stars, MAX(s.first_starred_at) AS reached
      FROM stars s JOIN ideas i ON i.id = s.idea_id
      WHERE s.first_starred_at >= ? AND s.active = 1 AND s.invalidated_at IS NULL AND i.hidden_at IS NULL AND i.status = 'collecting'
      GROUP BY i.id ORDER BY week_stars DESC, reached ASC, i.published_at ASC, i.id ASC LIMIT ? OFFSET ?`)
      .bind(week.start, limit + 1, offset).all<IdeaRow & { week_stars: number }>();
    const items = results.slice(0, limit).map((r, k) => ({ ...publicIdea(r, r.week_stars, false), rank: offset + k + 1 }));
    return { items, next: results.length > limit ? String(offset + limit) : null };
  }
  if (view === 'new') {
    const [at, id] = (cursor ?? '').split('.');
    const before = Number(at) || null;
    const { results } = await db.prepare(`SELECT ${IDEA_COLS} FROM ideas i WHERE i.hidden_at IS NULL
      AND (? IS NULL OR i.published_at < ? OR (i.published_at = ? AND i.id < ?)) ORDER BY i.published_at DESC, i.id DESC LIMIT ?`)
      .bind(before, before, before, id ?? '', limit + 1).all<IdeaRow>();
    const page = results.slice(0, limit), counts = await weekCounts(db, page.map((r) => r.id), week);
    const last = page.at(-1);
    return { items: page.map((r) => publicIdea(r, counts.get(r.id) ?? 0, false)), next: results.length > limit && last ? `${last.published_at}.${last.id}` : null };
  }
  // building: selected winners awaiting or under work (with holds and declines shown as such), in queue order; built: newest first
  const offset = Math.max(0, Math.min(Number(cursor) || 0, 500));
  const building = view === 'building';
  const { results } = await db.prepare(`SELECT ${IDEA_COLS}, q.idea_id, q.week_start, q.week_end, q.weekly_stars, q.lifetime_stars, q.selected_at,
      q.status AS q_status, q.status_note AS q_note, q.demo_url, q.source_url
    FROM build_queue q JOIN ideas i ON i.id = q.idea_id
    WHERE i.hidden_at IS NULL AND ${building ? "q.status <> 'built'" : "q.status = 'built'"}
    ORDER BY q.week_start ${building ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`).bind(limit + 1, offset).all<IdeaRow & QueueRow & { q_status: string; q_note: string | null }>();
  const page = results.slice(0, limit), counts = await weekCounts(db, page.map((r) => r.id), week);
  const positions = building ? await queuePositions(db) : new Map<string, number>();
  return {
    items: page.map((r) => publicIdea(r, counts.get(r.id) ?? 0, false, { ...r, status: r.q_status, status_note: r.q_note }, positions.get(r.id) ?? null)),
    next: results.length > limit ? String(offset + limit) : null,
  };
}

/** Place in the build queue for winners not built or declined yet (1 = next up). */
async function queuePositions(db: D1Database): Promise<Map<string, number>> {
  const { results } = await db.prepare("SELECT idea_id FROM build_queue WHERE status IN ('selected', 'building', 'held') ORDER BY week_start ASC LIMIT 200").all<{ idea_id: string }>();
  return new Map(results.map((r, k) => [r.idea_id, k + 1]));
}

/** One idea, in full, or null if it doesn't exist or is hidden. */
export async function getIdea(db: D1Database, id: string, week: Week | null): Promise<PublicIdea | null> {
  const r = await db.prepare(`SELECT ${IDEA_COLS} FROM ideas i WHERE i.id = ? AND i.hidden_at IS NULL`).bind(id).first<IdeaRow>();
  if (!r) return null;
  const [counts, q] = await Promise.all([weekCounts(db, [id], week), db.prepare('SELECT * FROM build_queue WHERE idea_id = ?').bind(id).first<QueueRow>()]);
  const out = publicIdea(r, counts.get(id) ?? 0, true, q, q ? (await queuePositions(db)).get(id) ?? null : null);
  if (week && r.status === 'collecting' && out.weekStars > 0) {
    const top = await listIdeas(db, 'top', null, week, 30);
    const at = top.items.find((x) => x.id === id);
    if (at) out.rank = at.rank;
  }
  return out;
}

/** The current contest (with its provisional leader) and the most recently closed one. */
export async function contestInfo(db: D1Database, now: number, launch: number | null) {
  const week = launch === null ? null : weekAt(now, launch);
  const leader = week ? (await listIdeas(db, 'top', null, week, 1)).items[0] ?? null : null;
  const last = await db.prepare('SELECT * FROM contests ORDER BY week_start DESC LIMIT 1').first<{ week_start: number; week_end: number; partial: number; winner_id: string | null; winner_score: number | null; policy_version: string }>();
  let winner: PublicIdea | null = null;
  if (last?.winner_id) winner = await getIdea(db, last.winner_id, week);
  return {
    policy: POLICY_VERSION, launchAt: launch, now,
    week: week && { start: week.start, end: week.end, partial: week.partial },
    leader: leader && { ...leader, provisional: true },
    previous: last && { start: last.week_start, end: last.week_end, partial: !!last.partial, winner, winnerScore: last.winner_score, noWinner: !last.winner_id },
  };
}

// ---------- weekly closing ----------
export type Closed = { start: number; end: number; winner: string | null; score: number; already: boolean };

/** Closes every ended, unclosed week up to `limit`, oldest first. Safe to run twice or at the same time: one result per week. */
export async function closeDueWeeks(db: D1Database, now: number, limit = 8): Promise<Closed[]> {
  const launch = await launchAt(db, null);
  if (launch === null) return [];
  const out: Closed[] = [];
  const last = await db.prepare('SELECT MAX(week_end) AS e FROM contests').first<{ e: number | null }>();
  for (const w of weeksToClose(launch, last?.e ?? null, now, limit)) out.push(await closeWeek(db, w, now));
  return out;
}

/** Decides one week from its history as of the cutoff, then saves the result and the queue entry in one transaction. */
export async function closeWeek(db: D1Database, week: Week, now: number): Promise<Closed> {
  const done = await db.prepare('SELECT winner_id, winner_score FROM contests WHERE week_start = ?').bind(week.start).first<{ winner_id: string | null; winner_score: number | null }>();
  if (done) return { start: week.start, end: week.end, winner: done.winner_id, score: done.winner_score ?? 0, already: true };
  // Seal first: from this commit on, every vote, moderation and publication is dated at or after the cutoff (see SEALED),
  // so everything read below is final for this week. It only moves forward.
  await db.prepare(`INSERT INTO board_settings (key, value) VALUES ('sealed_through', ?)
    ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`).bind(String(week.end)).run();

  const { results: first } = await db.prepare('SELECT idea_id, github_id, first_starred_at FROM stars WHERE first_starred_at >= ? AND first_starred_at < ?')
    .bind(week.start, week.end).all<{ idea_id: string; github_id: number; first_starred_at: number }>();
  const { results: ev } = await db.prepare(`SELECT e.idea_id, e.github_id, e.at, e.action FROM star_events e
    JOIN stars s ON s.idea_id = e.idea_id AND s.github_id = e.github_id
    WHERE s.first_starred_at >= ? AND s.first_starred_at < ? AND e.at < ? ORDER BY e.at, e.id`)
    .bind(week.start, week.end, week.end).all<{ idea_id: string; github_id: number; at: number; action: StarEvent['action'] }>();
  const contributions = validContributions(week,
    first.map((r): Contribution => ({ ideaId: r.idea_id, githubId: r.github_id, firstAt: r.first_starred_at })),
    ev.map((r): StarEvent => ({ ideaId: r.idea_id, githubId: r.github_id, at: r.at, action: r.action })));
  const touched = [...new Set(contributions.map((c) => c.ideaId))];
  const [ideasRes, modRes, selRes, subs] = await Promise.all([
    db.prepare('SELECT id, published_at FROM ideas WHERE id IN (SELECT value FROM json_each(?))').bind(ids(touched)).all<{ id: string; published_at: number }>(),
    db.prepare('SELECT idea_id, at, action FROM moderation_events WHERE at < ? AND idea_id IN (SELECT value FROM json_each(?)) ORDER BY at, id').bind(week.end, ids(touched)).all<{ idea_id: string; at: number; action: ModerationEvent['action'] }>(),
    db.prepare('SELECT winner_id FROM contests WHERE week_start < ? AND winner_id IN (SELECT value FROM json_each(?))').bind(week.start, ids(touched)).all<{ winner_id: string }>(),
    db.prepare('SELECT COUNT(*) AS n FROM ideas WHERE published_at >= ? AND published_at < ?').bind(week.start, week.end).first<{ n: number }>(),
  ]);
  const eligible = eligibleAt(week, ideasRes.results.map((r) => ({ id: r.id, publishedAt: r.published_at })),
    modRes.results.map((r) => ({ ideaId: r.idea_id, at: r.at, action: r.action })), new Set(selRes.results.map((r) => r.winner_id)));
  const ranking = rank(eligible, contributions);
  const top = ranking[0] ?? null;
  const voters = new Set(contributions.map((c) => c.githubId)).size;
  const lifetime = top ? await lifetimeAt(db, top.id, week.end) : null;

  const statements = [db.prepare(`INSERT INTO contests (week_start, week_end, partial, policy_version, winner_id, winner_score, winner_reached_at, winner_lifetime, eligible_count, voters, stars, submissions, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(week.start, week.end, week.partial ? 1 : 0, POLICY_VERSION, top?.id ?? null, top?.score ?? null, top?.reachedAt ?? null,
      lifetime, ranking.length, voters, contributions.length, subs?.n ?? 0, now)];
  if (top) {
    const idea = await db.prepare('SELECT kind, name, pitch, concept, inspiration, repos_json, publisher_login, published_at FROM ideas WHERE id = ?').bind(top.id).first<Record<string, unknown>>();
    const frozen = JSON.stringify({ ...idea, repos: json(idea!.repos_json), repos_json: undefined });
    statements.push(
      // the frozen win stands, but a hold or decline made after the cutoff carries over to the queue entry with its note
      db.prepare(`INSERT INTO build_queue (idea_id, week_start, week_end, frozen_json, weekly_stars, lifetime_stars, policy_version, selected_at, status, status_note, updated_at)
        SELECT id, ?, ?, ?, ?, ?, ?, ?, CASE WHEN status IN ('held', 'declined') THEN status ELSE 'selected' END,
          CASE WHEN status IN ('held', 'declined') THEN status_note END, ? FROM ideas WHERE id = ?`)
        .bind(week.start, week.end, frozen, top.score, lifetime, POLICY_VERSION, now, now, top.id),
      db.prepare("UPDATE ideas SET status = 'selected' WHERE id = ? AND status = 'collecting'").bind(top.id),
    );
  }
  try {
    await db.batch(statements);
  } catch (e) {
    // another run closed this week first (unique week, unique winner): its result stands
    const won = await db.prepare('SELECT winner_id, winner_score FROM contests WHERE week_start = ?').bind(week.start).first<{ winner_id: string | null; winner_score: number | null }>();
    if (won) return { start: week.start, end: week.end, winner: won.winner_id, score: won.winner_score ?? 0, already: true };
    throw e;
  }
  return { start: week.start, end: week.end, winner: top?.id ?? null, score: top?.score ?? 0, already: false };
}

/** Lifetime stars an idea had at an instant, from its star history. */
async function lifetimeAt(db: D1Database, ideaId: string, at: number): Promise<number> {
  const { results } = await db.prepare('SELECT github_id, action FROM star_events WHERE idea_id = ? AND at < ? ORDER BY at, id').bind(ideaId, at).all<{ github_id: number; action: StarEvent['action'] }>();
  const s = new Map<number, { on: boolean; valid: boolean }>();
  for (const e of results) {
    const x = s.get(e.github_id) ?? { on: false, valid: true };
    if (e.action === 'star' || e.action === 'unstar') x.on = e.action === 'star'; else x.valid = e.action === 'restore';
    s.set(e.github_id, x);
  }
  return [...s.values()].filter((x) => x.on && x.valid).length;
}

// ---------- owner operations (protected; see routes.ts and scripts/board-admin.ts) ----------
const audit = (db: D1Database, now: number, action: string, target: string, reason: string) =>
  db.prepare('INSERT INTO audit_log (at, action, target, reason) VALUES (?, ?, ?, ?)').bind(now, action, target, reason);

export type ModAction = ModerationAction;
const PUBLIC_NOTE: Partial<Record<ModAction, string>> = {
  hold: 'On hold while we check whether it can be built safely.',
  decline: 'Declined: it can’t be built as a safe, open-source prototype.',
};

/** Hide/unhide, hold/release or decline/reinstate an idea, with a private reason (audit log) and an optional public note. */
export async function moderate(db: D1Database, ideaId: string, action: ModAction, reason: string, publicNote: string | null, now: number) {
  const i = await db.prepare('SELECT status, hidden_at FROM ideas WHERE id = ?').bind(ideaId).first<{ status: string; hidden_at: number | null }>();
  if (!i) return { error: 'not_found' as const };
  const q = await db.prepare('SELECT status FROM build_queue WHERE idea_id = ?').bind(ideaId).first<{ status: string }>();
  const note = publicNote ?? PUBLIC_NOTE[action] ?? null;
  // the same transition the weekly close replays from history (contest.ts applyModeration)
  const before: Moderation = { hidden: i.hidden_at !== null, block: i.status === 'held' ? 'held' : i.status === 'declined' ? 'declined' : 'none' };
  const after = applyModeration(before, action);
  const s: ReturnType<D1Database['prepare']>[] = [
    db.prepare(`INSERT INTO moderation_events (idea_id, at, action, reason) VALUES (?, ${at()}, ?, ?)`).bind(ideaId, now, action, reason),
    audit(db, now, action, ideaId, reason),
  ];
  if (after.hidden !== before.hidden) s.push(db.prepare('UPDATE ideas SET hidden_at = ? WHERE id = ?').bind(after.hidden ? now : null, ideaId));
  if (after.block !== before.block || (after.block !== 'none' && publicNote)) {
    // blocked: held or declined, with a public note; unblocked: collecting again, or back in the queue if it was picked
    const status = after.block === 'held' ? 'held' : after.block === 'declined' ? 'declined' : q ? 'selected' : 'collecting';
    const shown = after.block === 'none' ? null : note;
    s.push(db.prepare('UPDATE ideas SET status = ?, status_note = ? WHERE id = ?').bind(status, shown, ideaId));
    if (q) s.push(db.prepare('UPDATE build_queue SET status = ?, status_note = ?, updated_at = ? WHERE idea_id = ?').bind(status, shown, now, ideaId));
  }
  await db.batch(s);
  return { ok: true as const };
}

/** Exclude (or restore) abusive stars: one account's star on one idea, or all of its stars. Closed weeks keep their results. */
export async function moderateStars(db: D1Database, githubId: number, ideaId: string | null, exclude: boolean, reason: string, now: number) {
  const where = `github_id = ?${ideaId ? ' AND idea_id = ?' : ''} AND invalidated_at IS ${exclude ? 'NULL' : 'NOT NULL'}`;
  const args: unknown[] = ideaId ? [githubId, ideaId] : [githubId];
  const [res] = await db.batch([
    db.prepare(`UPDATE stars SET invalidated_at = ?, updated_at = ${at()} WHERE ${where}`).bind(exclude ? now : null, now, ...args),
    audit(db, now, exclude ? 'exclude-stars' : 'restore-stars', `${githubId}${ideaId ? `/${ideaId}` : ''}`, reason),
  ]);
  return { ok: true as const, changed: res.meta.changes };
}

/** Moves a selected idea through the build: building, then built with a source link (github.com) and an optional demo. */
export async function setBuild(db: D1Database, ideaId: string, status: 'selected' | 'building' | 'built', links: { demoUrl?: unknown; sourceUrl?: unknown; note?: unknown }, now: number) {
  const q = await db.prepare('SELECT status FROM build_queue WHERE idea_id = ?').bind(ideaId).first<{ status: string }>();
  if (!q) return { error: 'not_queued' as const };
  const source = links.sourceUrl == null ? null : safeHttpsUrl(links.sourceUrl, 'github.com');
  const demo = links.demoUrl == null ? null : safeHttpsUrl(links.demoUrl);
  if ((links.sourceUrl != null && !source) || (links.demoUrl != null && !demo)) return { error: 'bad_url' as const };
  if (status === 'built' && !source) return { error: 'source_required' as const };
  const note = links.note == null ? null : cleanNote(links.note);
  await db.batch([
    db.prepare('UPDATE build_queue SET status = ?, status_note = ?, demo_url = COALESCE(?, demo_url), source_url = COALESCE(?, source_url), updated_at = ? WHERE idea_id = ?').bind(status, note, demo, source, now, ideaId),
    db.prepare('UPDATE ideas SET status = ?, status_note = ? WHERE id = ?').bind(status, note, ideaId),
    audit(db, now, `build-${status}`, ideaId, note ?? ''),
  ]);
  return { ok: true as const };
}

/**
 * Deletes an account's private data on request: sessions and login codes go, its active stars are withdrawn (closed
 * weeks keep their frozen results), and its handle is replaced on the account and on ideas it published.
 */
export async function deleteAccount(db: D1Database, githubId: number, reason: string, now: number) {
  await db.batch([
    db.prepare(`UPDATE stars SET active = 0, updated_at = ${at()} WHERE github_id = ? AND active = 1`).bind(now, githubId),
    db.prepare('DELETE FROM sessions WHERE github_id = ?').bind(githubId),
    db.prepare('DELETE FROM login_codes WHERE github_id = ?').bind(githubId),
    db.prepare("UPDATE accounts SET login = 'deleted-account', deleted_at = ?, updated_at = ? WHERE github_id = ?").bind(now, now, githubId),
    db.prepare("UPDATE ideas SET publisher_login = 'deleted-account' WHERE publisher_id = ?").bind(githubId),
    audit(db, now, 'delete-account', String(githubId), reason),
  ]);
  return { ok: true as const };
}

/** Weekly numbers for the owner's traction decisions: closed weeks plus the build backlog. */
export async function report(db: D1Database) {
  const { results: weeks } = await db.prepare('SELECT week_start, week_end, partial, winner_id, winner_score, eligible_count, voters, stars, submissions FROM contests ORDER BY week_start DESC LIMIT 26').all();
  const backlog = await db.prepare("SELECT status, COUNT(*) AS n FROM build_queue GROUP BY status").all<{ status: string; n: number }>();
  const accounts = await db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE deleted_at IS NULL').first<{ n: number }>();
  return { weeks, backlog: Object.fromEntries(backlog.results.map((r) => [r.status, r.n])), accounts: accounts?.n ?? 0 };
}

/** Deletes expired drafts, OAuth states, login codes and sessions. */
export async function cleanup(db: D1Database, now: number) {
  await db.batch([
    db.prepare('DELETE FROM drafts WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM login_codes WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
  ]);
}
