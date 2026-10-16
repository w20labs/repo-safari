import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/src/index.ts';
import { PER_DAY, PER_VISITOR, parseRepos, resetRepoCache, validIdeas, type Env } from '../worker/src/ideas.ts';

const REPOS = [
  { name: 'acme/rockets', desc: 'Tiny rocket engine' },
  { name: 'acme/kites', desc: 'Kite physics' },
  { name: 'zeta/pancakes', desc: 'Pancake recipes as code' },
];
const IDEAS = {
  ideas: [
    { kind: 'ridiculous', name: 'Pancake Launcher', pitch: 'p3', concept: 'c3', inspiration: 'i3' },
    { kind: 'useful', name: 'Kite Planner', pitch: 'p1', concept: 'c1', inspiration: 'i1' },
    { kind: 'unexpected', name: 'Rocket Breakfast', pitch: 'p2', concept: 'c2', inspiration: 'i2' },
  ],
};

function memoryKv() {
  const store = new Map<string, string>();
  return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } };
}
let kv: ReturnType<typeof memoryKv>;
let modelCalls: { body: Record<string, unknown> }[];
let modelReply: () => unknown;
const env = (): Env => ({ ANTHROPIC_API_KEY: 'test-key', IP_SALT: 'salt', LIMITS: kv, REPOS_URL: 'https://site.test/repos.json', ALLOWED_ORIGINS: 'https://site.test' });
const message = (text: string, stop = 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });

beforeEach(() => {
  kv = memoryKv();
  modelCalls = [];
  modelReply = () => message(JSON.stringify(IDEAS));
  resetRepoCache();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://site.test/repos.json') return new Response(JSON.stringify(REPOS));
    if (url.endsWith('/v1/messages')) {
      modelCalls.push({ body: JSON.parse(String(init?.body ?? (input as Request).body)) });
      return new Response(JSON.stringify(modelReply()), { headers: { 'Content-Type': 'application/json', 'request-id': 'req_1' } });
    }
    return new Response('not found', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const ask = (repos: unknown, { origin = 'https://site.test', ip = '1.2.3.4', method = 'POST' } = {}) =>
  worker.fetch(new Request('https://ideas.test/ideas', { method, headers: { Origin: origin, 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify({ repos }) : undefined }), env());
const names = REPOS.map((r) => r.name);

describe('Idea Shower worker', () => {
  it('returns one idea of each kind, in order, from one model call', async () => {
    const res = await ask(names);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://site.test');
    const body = (await res.json()) as { ideas: { kind: string; name: string }[] };
    expect(body.ideas.map((i) => i.kind)).toEqual(['useful', 'unexpected', 'ridiculous']);
    expect(modelCalls).toHaveLength(1);
    const sent = modelCalls[0].body as { model: string; max_tokens: number; thinking: unknown; messages: { content: string }[] };
    expect(sent.model).toBe('claude-sonnet-5-5');
    expect(sent.max_tokens).toBe(1200);
    expect(sent.thinking).toEqual({ type: 'between_tools' }); // Sonnet 5.5 rejects { type: 'disabled' } with a 400
    expect(sent.messages[0].content).toContain('acme/kites: Kite physics');
  });

  it('rejects repos that are not on the site, duplicates and the wrong count, without calling the model', async () => {
    expect((await ask(['acme/rockets', 'acme/kites', 'evil/unknown'])).status).toBe(400);
    expect((await ask(['acme/rockets', 'acme/rockets', 'acme/kites'])).status).toBe(400);
    expect((await ask(names.slice(0, 2))).status).toBe(400);
    expect(modelCalls).toHaveLength(0);
  });

  it('only answers allowed origins', async () => {
    expect((await ask(names, { origin: 'https://evil.test' })).status).toBe(403);
    const pre = await ask(names, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('POST');
  });

  it(`stops a visitor after ${PER_VISITOR} generations a day and never stores the raw IP`, async () => {
    for (let i = 0; i < PER_VISITOR; i++) expect((await ask(names)).status).toBe(200);
    const limited = await ask(names);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'limit' });
    expect((await ask(names, { ip: '5.6.7.8' })).status).toBe(200); // someone else still can
    expect([...kv.store.keys()].join(' ')).not.toContain('1.2.3.4');
  });

  it(`stops everyone after ${PER_DAY} generations a day`, async () => {
    kv.store.set(`day:${new Date().toISOString().slice(0, 10)}`, String(PER_DAY));
    expect((await ask(names)).status).toBe(429);
    expect(modelCalls).toHaveLength(0);
  });

  it('turns a refusal, a cut-off answer or a malformed answer into an error', async () => {
    modelReply = () => message(JSON.stringify(IDEAS), 'refusal');
    expect((await ask(names)).status).toBe(502);
    modelReply = () => message(JSON.stringify(IDEAS), 'max_tokens');
    expect((await ask(names, { ip: '9.9.9.9' })).status).toBe(502);
    modelReply = () => message('{"ideas": []}');
    expect((await ask(names, { ip: '8.8.8.8' })).status).toBe(502);
  });
});

describe('validation', () => {
  it('parseRepos wants exactly 3 distinct owner/name strings', () => {
    expect(parseRepos({ repos: names })).toEqual(names);
    expect(parseRepos({ repos: ['a/b', 'c/d', 'not a repo'] })).toBeNull();
    expect(parseRepos({ repos: 'a/b' })).toBeNull();
    expect(parseRepos(null)).toBeNull();
  });
  it('validIdeas wants one of each kind and short, non-empty fields', () => {
    expect(validIdeas(IDEAS)?.map((i) => i.kind)).toEqual(['useful', 'unexpected', 'ridiculous']);
    const long = structuredClone(IDEAS); long.ideas[0].pitch = 'x'.repeat(401);
    expect(validIdeas(long)).toBeNull();
    const twice = structuredClone(IDEAS); twice.ideas[0].kind = 'useful';
    expect(validIdeas(twice)).toBeNull();
    const blank = structuredClone(IDEAS); blank.ideas[1].name = '  ';
    expect(validIdeas(blank)).toBeNull();
  });
});
