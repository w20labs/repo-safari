import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/src/index.ts';
import { PER_DAY, PER_VISITOR, parseRepos, resetRepoCache, validIdeas, type Env } from '../worker/src/ideas.ts';
import { Limiter, reserve, type LimitState } from '../worker/src/limiter.ts';

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

/** A real Limiter on in-memory storage, behind a stand-in for the Durable Object namespace binding. */
function memoryLimiter() {
  const store = new Map<string, unknown>();
  let broken = false;
  const obj = new Limiter({ storage: { get: async <T>(k: string) => structuredClone(store.get(k)) as T | undefined, put: async <T>(k: string, v: T) => { store.set(k, structuredClone(v)); } } });
  return {
    store, break: () => { broken = true; },
    idFromName: (n: string) => n,
    get: () => ({ fetch: async (url: string, init?: RequestInit) => { if (broken) throw new Error('object unavailable'); return obj.fetch(new Request(url, init)); } }),
  };
}
let limiter: ReturnType<typeof memoryLimiter>;
let siteRepos: { name: string; desc: string }[];
let repoFetches: number;
let modelCalls: { body: Record<string, unknown> }[];
let modelReply: () => unknown;
const env = (): Env => ({ ANTHROPIC_API_KEY: 'test-key', IP_SALT: 'salt', LIMITER: limiter, REPOS_URL: 'https://site.test/repos.json', ALLOWED_ORIGINS: 'https://site.test' });
const message = (text: string, stop = 'end_turn') => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } });

beforeEach(() => {
  limiter = memoryLimiter();
  siteRepos = REPOS;
  repoFetches = 0;
  modelCalls = [];
  modelReply = () => message(JSON.stringify(IDEAS));
  resetRepoCache();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://site.test/repos.json?t=')) { repoFetches++; return new Response(JSON.stringify(siteRepos)); }
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
    expect(JSON.stringify([...limiter.store.values()])).not.toContain('1.2.3.4');
  });

  it(`stops everyone after ${PER_DAY} generations a day`, async () => {
    limiter.store.set('state', { day: new Date().toISOString().slice(0, 10), total: PER_DAY, visitors: {} });
    expect((await ask(names)).status).toBe(429);
    expect(modelCalls).toHaveLength(0);
  });

  it('counts requests that arrive at the same moment exactly once each', async () => {
    const answers = await Promise.all(Array.from({ length: 12 }, () => ask(names)));
    expect(answers.filter((r) => r.status === 200)).toHaveLength(PER_VISITOR);
    expect(answers.filter((r) => r.status === 429)).toHaveLength(12 - PER_VISITOR);
    expect(modelCalls).toHaveLength(PER_VISITOR);
    expect((limiter.store.get('state') as LimitState).total).toBe(PER_VISITOR);
  });

  it('answers a broken limit store with a readable 503, never a model call', async () => {
    limiter.break();
    const res = await ask(names);
    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://site.test');
    expect(await res.json()).toEqual({ error: 'busy' });
    expect(modelCalls).toHaveLength(0);
  });

  it('refetches the repo list once when a repo is new to it, at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect((await ask(names)).status).toBe(200);
      siteRepos = [...REPOS.slice(0, 2), { name: 'new/arrival', desc: 'Published a moment ago' }];
      vi.setSystemTime(Date.now() + 61_000); // past the once-a-minute refresh limit, well inside the hour-long cache
      const fresh = ['acme/rockets', 'acme/kites', 'new/arrival'];
      expect((await ask(fresh, { ip: '2.2.2.2' })).status).toBe(200);
      expect(repoFetches).toBe(2);
      // an unknown repo right after doesn't hammer the site
      expect((await ask(['acme/rockets', 'acme/kites', 'never/listed'], { ip: '3.3.3.3' })).status).toBe(400);
      expect(repoFetches).toBe(2);
      vi.setSystemTime(Date.now() + 61_000);
      expect((await ask(['acme/rockets', 'acme/kites', 'never/listed'], { ip: '3.3.3.3' })).status).toBe(400);
      expect(repoFetches).toBe(3);
    } finally { vi.useRealTimers(); }
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

describe('limits', () => {
  it('reserve counts per visitor and per day, and starts over on a new day', () => {
    let s: LimitState | undefined;
    for (let i = 0; i < PER_VISITOR; i++) { const r = reserve(s, 'v1', '2026-10-17'); expect(r.ok).toBe(true); s = r.state; }
    expect(reserve(s, 'v1', '2026-10-17').ok).toBe(false);
    expect(reserve(s, 'v2', '2026-10-17').ok).toBe(true);
    const next = reserve(s, 'v1', '2026-10-18');
    expect(next.ok).toBe(true);
    expect(next.state).toEqual({ day: '2026-10-18', total: 1, visitors: { v1: 1 } });
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
