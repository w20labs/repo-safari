/**
 * Weekly contest rules, as pure functions (the database code in store.ts feeds them).
 *
 * - A week runs Monday 00:00 UTC (inclusive) to the next Monday 00:00 UTC (exclusive). The first contest starts when
 *   the board launches and ends at the next Monday: a partial week.
 * - A star counts once per GitHub account per idea, in the week of its first star, if it is still active and valid at
 *   that week's closing instant.
 * - Eligible: published before the close, not hidden, held or declined at the close, and never selected before.
 * - Most valid new stars wins; at least one is needed. Ties: whoever first reached its final score, then the earlier
 *   publication, then the smaller id.
 */
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
export const POLICY_VERSION = 'weekly-v1';

/** Monday 00:00 UTC at or before `t`. */
export function mondayOf(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
}

export type Week = { start: number; end: number; partial: boolean };

/** The contest week that `t` falls in, or null before launch. */
export function weekAt(t: number, launchAt: number): Week | null {
  if (t < launchAt) return null;
  const monday = mondayOf(t);
  const start = Math.max(monday, launchAt);
  return { start, end: monday + WEEK, partial: start !== monday };
}

/**
 * Weeks that have ended by `now` and aren't closed yet, oldest first, at most `limit` (a long outage catches up over
 * several runs). `closedThrough` is the end of the last closed week, or null if none.
 */
export function weeksToClose(launchAt: number, closedThrough: number | null, now: number, limit = 8): Week[] {
  const out: Week[] = [];
  let w = weekAt(closedThrough ?? launchAt, launchAt);
  while (w && w.end <= now && out.length < limit) {
    out.push(w);
    w = weekAt(w.end, launchAt);
  }
  return out;
}

export type StarEvent = { ideaId: string; githubId: number; at: number; action: 'star' | 'unstar' | 'invalidate' | 'restore' };
export type Contribution = { ideaId: string; githubId: number; firstAt: number };

/**
 * The contributions that count for a week, as of its closing instant: stars first given inside the week whose last
 * star/unstar before the cutoff is a star, and that weren't invalidated before the cutoff. Events at or after the
 * cutoff are ignored, so a delayed close sees exactly what was true at the cutoff.
 */
export function validContributions(week: Week, firstStars: Contribution[], events: StarEvent[]): Contribution[] {
  const state = new Map<string, { on: boolean; valid: boolean }>();
  const sorted = events.filter((e) => e.at < week.end).sort((a, b) => a.at - b.at);
  for (const e of sorted) {
    const key = `${e.ideaId}\u0000${e.githubId}`;
    const s = state.get(key) ?? { on: false, valid: true };
    if (e.action === 'star') s.on = true;
    else if (e.action === 'unstar') s.on = false;
    else if (e.action === 'invalidate') s.valid = false;
    else s.valid = true;
    state.set(key, s);
  }
  return firstStars.filter((c) => {
    if (c.firstAt < week.start || c.firstAt >= week.end) return false;
    const s = state.get(`${c.ideaId}\u0000${c.githubId}`);
    return !!s && s.on && s.valid;
  });
}

export type ModerationEvent = { ideaId: string; at: number; action: 'hide' | 'unhide' | 'hold' | 'release' | 'decline' | 'reinstate' };
export type Candidate = { id: string; publishedAt: number };

/** Ideas eligible at the week's close: published before it, not hidden/held/declined then, and not selected before. */
export function eligibleAt(week: Week, ideas: Candidate[], moderation: ModerationEvent[], selectedBefore: Set<string>): Candidate[] {
  const flags = new Map<string, { hidden: boolean; held: boolean; declined: boolean }>();
  for (const e of [...moderation].filter((m) => m.at < week.end).sort((a, b) => a.at - b.at)) {
    const f = flags.get(e.ideaId) ?? { hidden: false, held: false, declined: false };
    if (e.action === 'hide' || e.action === 'unhide') f.hidden = e.action === 'hide';
    else if (e.action === 'hold' || e.action === 'release') f.held = e.action === 'hold';
    else f.declined = e.action === 'decline';
    flags.set(e.ideaId, f);
  }
  return ideas.filter((i) => {
    const f = flags.get(i.id);
    return i.publishedAt < week.end && !selectedBefore.has(i.id) && !(f && (f.hidden || f.held || f.declined));
  });
}

export type Score = { id: string; score: number; reachedAt: number; publishedAt: number };

/** Eligible ideas with at least one valid star, best first, by the published tie-break. */
export function rank(eligible: Candidate[], contributions: Contribution[]): Score[] {
  const by = new Map(eligible.map((i) => [i.id, { id: i.id, score: 0, reachedAt: 0, publishedAt: i.publishedAt }]));
  for (const c of contributions) {
    const s = by.get(c.ideaId);
    if (!s) continue;
    s.score++;
    s.reachedAt = Math.max(s.reachedAt, c.firstAt); // the moment its last still-valid star arrived
  }
  return [...by.values()].filter((s) => s.score > 0).sort((a, b) =>
    b.score - a.score || a.reachedAt - b.reachedAt || a.publishedAt - b.publishedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
