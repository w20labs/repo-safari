/**
 * The Idea Shower's rate limits, kept in one Durable Object so every check-and-count is atomic:
 * 5 generations per visitor (a salted hash of the IP, never the IP) and 300 in total per UTC day.
 * KV can't do this: it allows one write per second per key and has no transactions.
 */
export const PER_VISITOR = 5;
export const PER_DAY = 300;

export type LimitState = { day: string; total: number; visitors: Record<string, number> };

/** Pure: take one slot for `visitor` on `day`, starting the counts over when the day changes. */
export function reserve(state: LimitState | undefined, visitor: string, day: string): { ok: boolean; state: LimitState } {
  const s: LimitState = state?.day === day ? { day, total: state.total, visitors: { ...state.visitors } } : { day, total: 0, visitors: {} };
  const mine = s.visitors[visitor] ?? 0;
  if (s.total >= PER_DAY || mine >= PER_VISITOR) return { ok: false, state: s };
  s.total += 1;
  s.visitors[visitor] = mine + 1;
  return { ok: true, state: s };
}

/** The slice of Durable Object storage this class uses. */
type Storage = { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> };

/** One global instance. Requests run one after another through `queue`, so two can never read the same count. */
export class Limiter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly ctx: { storage: Storage }) {}

  async fetch(req: Request): Promise<Response> {
    const { visitor, day } = (await req.json()) as { visitor: string; day: string };
    const step = this.queue.then(async () => {
      const r = reserve(await this.ctx.storage.get<LimitState>('state'), visitor, day);
      if (r.ok) await this.ctx.storage.put('state', r.state);
      return r.ok;
    });
    this.queue = step.catch(() => undefined);
    return Response.json({ ok: await step });
  }
}
