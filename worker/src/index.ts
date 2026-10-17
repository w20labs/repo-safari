/** Idea Shower Worker entry: the request handler lives in ideas.ts; a Worker entry may only export handlers and Durable Object classes. */
import { handle } from './ideas';

export { Limiter } from './limiter';
export default { fetch: handle };
