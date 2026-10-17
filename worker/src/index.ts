/**
 * Worker entry: requests go to ideas.ts (POST /ideas, and the idea board's routes when it's enabled); the hourly
 * schedule closes ended contest weeks. A Worker entry may only export handlers and Durable Object classes.
 */
import { boardOn, runSchedule } from './board/routes';
import { handle, type Env } from './ideas';

export { Limiter } from './limiter';
export default {
  fetch: handle,
  /** With the board off this does nothing: no contests are created and no winners selected. */
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    if (boardOn(env)) ctx.waitUntil(runSchedule(env));
  },
};
