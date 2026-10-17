// Stand-ins for GitHub (OAuth + /user) and the Anthropic Messages API, for the local idea-board preview and tests.
// Nothing here talks to the internet; no paid model calls.
//
//   node worker/dev/fake-services.mjs [port=8790]
//
// GitHub: /login/oauth/authorize shows "sign in as" buttons (or redirects straight away with ?as=<login>),
// /login/oauth/access_token swaps a single-use code for a token, /user returns that account.
// POST /fake/rename {id, login} changes a handle (the numeric id stays). POST /fake/fail-model {n} fails the next n
// model calls. Anthropic: POST /v1/messages answers with three canned ideas built from the prompt's repo names.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const port = Number(process.argv[2] ?? 8790);
const users = new Map([[1001, 'alice'], [1002, 'bob'], [1003, 'carol'], [1004, 'dana'], [1005, 'eve']]);
for (let i = 0; i < 40; i++) users.set(2000 + i, `voter${i}`);
const codes = new Map(); // code -> user id (single use)
const tokens = new Map(); // token -> user id
let failModel = 0;
let modelCalls = 0;

const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); });
const send = (res, status, data, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/login/oauth/authorize') {
    const redirect = url.searchParams.get('redirect_uri'), state = url.searchParams.get('state');
    if (url.searchParams.has('scope')) return send(res, 400, 'this app must not ask for scopes', 'text/plain');
    const back = (id) => { const code = randomBytes(12).toString('hex'); codes.set(code, id); return `${redirect}?code=${code}&state=${encodeURIComponent(state)}`; };
    const as = url.searchParams.get('as');
    if (as) {
      const id = [...users].find(([, l]) => l === as)?.[0];
      res.writeHead(302, { Location: id ? back(id) : `${redirect}?error=access_denied&state=${encodeURIComponent(state)}` });
      return res.end();
    }
    const list = [...users].slice(0, 5).map(([id, login]) => `<a class="as" data-login="${esc(login)}" href="${esc(back(id))}">Sign in as ${esc(login)}</a>`).join('');
    return send(res, 200, `<!doctype html><meta name="viewport" content="width=device-width"><title>Fake GitHub</title><body style="font:16px system-ui;padding:20px"><h1>Fake GitHub (local preview)</h1><p>Repo Safari asks for your public profile only.</p>${list}<p><a id="deny" href="${esc(`${redirect}?error=access_denied&state=${encodeURIComponent(state)}`)}">Cancel</a></p><style>a{display:block;margin:10px 0;padding:10px;border:1px solid #888;border-radius:8px}</style>`, 'text/html');
  }
  if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
    const { code, client_secret } = JSON.parse((await body(req)) || '{}');
    const id = codes.get(code);
    codes.delete(code);
    if (!id || client_secret !== 'local-preview-secret') return send(res, 200, { error: 'bad_verification_code' });
    const token = `gho_${randomBytes(10).toString('hex')}`;
    tokens.set(token, id);
    return send(res, 200, { access_token: token, token_type: 'bearer', scope: '' });
  }
  if (url.pathname === '/user') {
    const id = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    return id ? send(res, 200, { id, login: users.get(id) }) : send(res, 401, { message: 'Bad credentials' });
  }
  if (url.pathname === '/fake/rename' && req.method === 'POST') {
    const { id, login } = JSON.parse(await body(req));
    users.set(id, login);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/fake/fail-model' && req.method === 'POST') { failModel = JSON.parse(await body(req)).n ?? 1; return send(res, 200, { ok: true }); }
  if (url.pathname === '/fake/model-calls') return send(res, 200, { calls: modelCalls });
  if (url.pathname === '/v1/messages' && req.method === 'POST') {
    modelCalls++;
    if (failModel > 0) { failModel--; return send(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'fake outage' } }); }
    const prompt = JSON.parse(await body(req)).messages?.[0]?.content ?? '';
    const names = [...prompt.matchAll(/^- ([\w.-]+\/[\w.-]+):/gm)].map((m) => m[1].split('/')[1]);
    const [a = 'one', b = 'two', c = 'three'] = names;
    const ideas = [
      { kind: 'useful', name: `${a} Compass`, pitch: `A pocket guide that pairs ${a} with ${b}.`, concept: `It wires ${a} into ${b} and uses ${c} for the interface.`, inspiration: `${a} brings the engine, ${b} the data, ${c} the face.` },
      { kind: 'unexpected', name: `${b} Garden`, pitch: `Grow a tiny garden driven by ${b}.`, concept: `Every event from ${a} plants a seed and ${c} decides how it grows.`, inspiration: `${b} is the soil, ${a} the weather, ${c} the gardener.` },
      { kind: 'ridiculous', name: `${c} Karaoke`, pitch: `${c} sings your ${a} errors while ${b} keeps the beat.`, concept: `Each failure becomes a verse and ${b} sets the tempo.`, inspiration: `${a} supplies drama, ${b} rhythm, ${c} the voice.` },
    ];
    return send(res, 200, { id: `msg_${modelCalls}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: JSON.stringify({ ideas }) }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  }
  send(res, 404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`fake GitHub + Anthropic on http://127.0.0.1:${port}`));
