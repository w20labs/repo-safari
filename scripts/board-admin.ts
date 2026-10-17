/**
 * Owner operations for the idea board, through the Worker's protected /board/admin endpoint.
 * The token is a long random secret set on the Worker (`npx wrangler secret put ADMIN_TOKEN`); it never goes in the page.
 *
 *   BOARD_ADMIN_URL=https://repo-safari-ideas.<account>.workers.dev BOARD_ADMIN_TOKEN=... npm run board-admin -- <action> [options]
 *
 *   hide | unhide | hold | release | decline | reinstate   --idea <id> --reason "<private reason>" [--note "<public note>"]
 *   exclude-stars | restore-stars                          --github-id <n> [--idea <id>] --reason "<why>"
 *   building | built | selected                            --idea <id> [--source https://github.com/...] [--demo https://...] [--note "..."]
 *   delete-account                                         --github-id <n> --reason "<request reference>"
 *   report                                                 weekly numbers and the build backlog
 *   close                                                  close any ended weeks now (the hourly schedule does this anyway)
 */
const [action, ...rest] = process.argv.slice(2);
const opt = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const url = (process.env.BOARD_ADMIN_URL ?? '').replace(/\/+$/, '');
const token = process.env.BOARD_ADMIN_TOKEN ?? '';
if (!action || !url || !token) {
  console.error('usage: BOARD_ADMIN_URL=<worker> BOARD_ADMIN_TOKEN=<secret> npm run board-admin -- <action> [--idea id] [--github-id n] [--reason text] [--note text] [--source url] [--demo url]');
  process.exit(1);
}
const githubId = opt('github-id');
const body = {
  action, idea: opt('idea'), reason: opt('reason'), note: opt('note'), sourceUrl: opt('source'), demoUrl: opt('demo'),
  ...(githubId ? { githubId: Number(githubId) } : {}),
};
const res = await fetch(`${url}/board/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: JSON.stringify(body) });
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);

export {}; // a module, so top-level await is allowed
