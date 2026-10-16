/** Idea Shower Worker entry: everything lives in ideas.ts, since a Worker entry module may only export handlers. */
import { handle } from './ideas';

export default { fetch: handle };
