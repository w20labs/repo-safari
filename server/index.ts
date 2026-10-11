import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { IS_PROD } from './http.ts';
import { attachArena } from './arena/index.ts';
import { handleRoute } from './routes.ts';

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = resolve('dist/client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(pathname: string, res: import('node:http').ServerResponse): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return true;
  }
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  let file = join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  if (!existsSync(file)) return false;
  const hashed = file.includes(`${join(STATIC_DIR, 'assets')}`);
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

export const server = createServer(async (req, res) => {
  try {
    if (await handleRoute(req, res)) return;
    if (IS_PROD && (req.method === 'GET' || req.method === 'HEAD') && serveStatic(new URL(req.url ?? '/', 'http://x').pathname, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    // last line of defence: one bad request must never crash the server for everyone
    console.error('[server] request failed', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something went wrong');
  }
});

attachArena(server);

server.listen(PORT, () => console.log(`[server] listening on http://localhost:${PORT}${IS_PROD ? '' : ' (API only; open the Vite URL)'}`));
