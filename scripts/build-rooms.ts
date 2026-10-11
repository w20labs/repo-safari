/**
 * Builds Repo Safari's category rooms automatically from GitHub topics. Nothing is hand-picked.
 *
 *   GITHUB_TOKEN=$(gh auth token) npm run build-rooms
 *
 * 1. Candidates: the 1,000 most-starred repos, plus a search per promising topic.
 * 2. Rooms: one per specific topic (umbrella topics like "python" or "ai" are skipped);
 *    topics whose repo sets overlap a lot are merged into one room.
 * 3. Clean-up: a repo stays in a room only if the subject is in its name or the first 8 words of its
 *    description (it is about the subject, not just listing it), or it carries two of the room's topics; unsafe repos are dropped (same filter as rising repos);
 *    each repo sits in at most two rooms; rooms need 4+ repos and keep the top 8 by stars.
 *
 * Only active repos count: a commit in the last ~6 months and not archived.
 *
 * Output: shared/data/rooms.json, with every number as returned by the API on the as-of date.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exclusionReason, type GhRepo } from '../server/rising-filter.ts';

const token = process.env.GITHUB_TOKEN;
const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'repo-safari-rooms', Authorization: `Bearer ${token}` };

interface Repo extends GhRepo {
  archived?: boolean;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  created_at: string;
  license: { spdx_id: string | null } | null;
  topics: string[];
}

/** Umbrella topics: languages, platforms and buzzwords that say little about what a repo does. */
const UMBRELLA = new Set(`
python javascript typescript go golang rust java cpp c csharp c-sharp php ruby swift kotlin dart shell bash zsh html css scss lua perl r scala elixir haskell
nodejs node deno react reactjs vue vuejs angular svelte nextjs django flask laravel rails spring spring-boot dotnet
linux macos windows ios android web webapp frontend backend fullstack api rest-api cli terminal command-line gui desktop mobile cross-platform
ai ml machine-learning deep-learning artificial-intelligence llm llms large-language-models gpt chatgpt openai generative-ai genai nlp ai-agent ai-agents agents agent
hacktoberfest awesome awesome-list list lists resources open-source opensource github developer-tools devtools tools tool productivity education
interview tutorial tutorials learning beginner-friendly library framework self-hosted selfhosted docker kubernetes cloud aws devops automation
mcp claude anthropic gemini deepseek ollama hacktoberfest2021 hacktoberfest2022 hacktoberfest2023 good-first-issue first-timers-only design
programming free language engineering data skills ui workflow components html5 es6 npm distributed assistant realtime mac chrome
cursor copilot antigravity opencode qwen glm llama gpt-4 gpt4 hermes hermes-agent openclaw dsh-plugin claude-code claude-code-plugin
claude-skills agent-skills vibe-coding ai-tools language-model hacking shadowsocks software-engineering computer-science
`.split(/\s+/).filter(Boolean));

const ACRONYMS: Record<string, string> = {
  llm: 'LLM', llms: 'LLMs', api: 'API', ui: 'UI', cli: 'CLI', orm: 'ORM', sql: 'SQL', css: 'CSS', ide: 'IDE', ci: 'CI', cd: 'CD', js: 'JS',
  gpu: 'GPU', ocr: 'OCR', tts: 'TTS', asr: 'ASR', rag: 'RAG', json: 'JSON', yaml: 'YAML', http: 'HTTP', ssh: 'SSH', vpn: 'VPN', dns: 'DNS',
  ai: 'AI', ml: 'ML', nlp: 'NLP', pdf: 'PDF', iot: 'IoT', vr: 'VR', ar: 'AR', os: 'OS', db: 'DB', etl: 'ETL', oauth: 'OAuth', jwt: 'JWT', p2p: 'P2P',
};
const titleOf = (topic: string) =>
  topic.split('-').map((w, i) => ACRONYMS[w] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastSearch = 0;
async function search(q: string, perPage: number, page = 1): Promise<Repo[]> {
  // search API: 30 requests/minute with a token
  const wait = lastSearch + 2100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastSearch = Date.now();
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return ((await res.json()) as { items: Repo[] }).items;
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      await sleep(Math.max(5000, reset - Date.now() + 1000));
      continue;
    }
    throw new Error(`search "${q}" failed: ${res.status} ${await res.text()}`);
  }
  throw new Error(`search "${q}" kept hitting the rate limit`);
}

/** Words that tell us a description is about the topic: the topic's own words, minus filler. */
const FILLER = new Set(['and', 'the', 'for', 'of', 'to', 'in', 'on', 'with', 'a', 'an', 'js', 'app', 'apps']);
const topicWords = (t: string) => t.split('-').filter((w) => w.length >= 2 && !FILLER.has(w));
/** The repo is about the subject: it's in the repo name or in the first 8 words of the description. */
function about(r: { name: string; description: string | null }, words: string[]): boolean {
  const lead = (r.description ?? '').split(/\s+/).slice(0, 8).join(' ');
  return mentions(`${r.name.replace(/[-_.]/g, ' ')} ${lead}`, words);
}

function mentions(desc: string, words: string[]): boolean {
  const d = desc.toLowerCase();
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(d));
}

const CACHE = 'data/rooms-cache.json';
/** A repo must have a commit this recent to be in a room. */
const ACTIVE_DAYS = 183;

async function main() {
  const asOf = new Date().toISOString().slice(0, 10);
  if (process.argv.includes('--cached') && existsSync(CACHE)) {
    const c = JSON.parse(readFileSync(CACHE, 'utf8')) as { fetchedAt?: string; repos: Repo[]; members: Record<string, string[]> };
    return buildRooms(c.fetchedAt ?? asOf, new Map(c.repos.map((r) => [r.full_name, r])), new Map(Object.entries(c.members).map(([k, v]) => [k, new Set(v)])));
  }
  if (!token) throw new Error('Set GITHUB_TOKEN (e.g. GITHUB_TOKEN=$(gh auth token)); the search API needs it. Or pass --cached to rebuild from the last fetch.');
  const all = new Map<string, Repo>();
  const add = (r: Repo) => {
    if (exclusionReason(r)) return;
    all.set(r.full_name, r);
  };

  console.log('1/3 Fetching the most-starred repos…');
  for (let page = 1; page <= 10; page++) (await search('stars:>5000', 100, page)).forEach(add);

  const counts = new Map<string, number>();
  for (const r of all.values()) for (const t of r.topics ?? []) if (!UMBRELLA.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const seeds = [...counts].filter(([, n]) => n >= 2 && n <= 60).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([t]) => t);
  console.log(`2/3 Searching ${seeds.length} topics…`);
  const members = new Map<string, Set<string>>();
  for (const [i, t] of seeds.entries()) {
    const found = await search(`topic:${t} stars:>800 archived:false`, 30);
    found.forEach(add);
    members.set(t, new Set(found.filter((r) => all.has(r.full_name)).map((r) => r.full_name)));
    if ((i + 1) % 25 === 0) console.log(`   ${i + 1}/${seeds.length}`);
  }
  // repos from the top-1000 pass also count toward the topics they carry
  for (const r of all.values()) for (const t of r.topics ?? []) members.get(t)?.add(r.full_name);
  writeFileSync(CACHE, JSON.stringify({ fetchedAt: asOf, repos: [...all.values()], members: Object.fromEntries([...members].map(([k, v]) => [k, [...v]])) }));
  buildRooms(asOf, all, members);
}

function buildRooms(asOf: string, allIn: Map<string, Repo>, membersIn: Map<string, Set<string>>) {
  // drop anything the (possibly newer) filters reject, and umbrella topics added since the cache was made
  // only active projects: a commit in the last ~6 months, not archived
  const cutoff = Date.parse(asOf) - ACTIVE_DAYS * 86_400_000;
  const all = new Map([...allIn].filter(([, r]) => !exclusionReason(r) && !r.archived && Date.parse(r.pushed_at) >= cutoff));
  const members = new Map([...membersIn].filter(([t]) => !UMBRELLA.has(t)).map(([t, set]) => [t, new Set([...set].filter((id) => all.has(id)))]));
  console.log('3/3 Building rooms…');
  // merge topics whose member sets overlap a lot (e.g. speech-recognition + speech-to-text)
  const topics = [...members.keys()].filter((t) => members.get(t)!.size >= 4);
  const parent = new Map(topics.map((t) => [t, t]));
  const find = (t: string): string => (parent.get(t) === t ? t : find(parent.get(t)!));
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const a = members.get(topics[i])!, b = members.get(topics[j])!;
      const inter = [...a].filter((x) => b.has(x)).length;
      if (inter / (a.size + b.size - inter) >= 0.4) parent.set(find(topics[j]), find(topics[i]));
    }
  }
  const groups = new Map<string, string[]>();
  for (const t of topics) groups.set(find(t), [...(groups.get(find(t)) ?? []), t]);

  type Room = { id: string; title: string; topics: string[]; repos: Repo[] };
  let rooms: Room[] = [];
  for (const group of groups.values()) {
    const main = group.sort((a, b) => members.get(b)!.size - members.get(a)!.size)[0];
    const words = [...new Set(group.flatMap(topicWords))];
    const ids = new Set(group.flatMap((t) => [...members.get(t)!]));
    const repos = [...ids]
      .map((id) => all.get(id)!)
      .filter((r) => {
        const own = (r.topics ?? []).filter((t) => group.includes(t)).length;
        return own >= 2 || about(r, words);
      })
      .sort((a, b) => b.stargazers_count - a.stargazers_count);
    // coherence: most of the room has to be about the room's subject, not just tagged with it
    const onTopic = repos.filter((r) => about(r, words)).length;
    if (repos.length >= 4 && onTopic / repos.length >= 0.5) rooms.push({ id: main, title: titleOf(main), topics: group, repos });
  }

  // near-duplicates (e.g. "Algorithm" and "Algorithms"): when two rooms share 30%+ of their top repos, keep the bigger one
  rooms.sort((a, b) => b.repos.length - a.repos.length);
  const kept: Room[] = [];
  for (const room of rooms) {
    const top = new Set(room.repos.slice(0, 8).map((r) => r.full_name));
    const dup = kept.some((k) => {
      const other = new Set(k.repos.slice(0, 8).map((r) => r.full_name));
      const inter = [...top].filter((x) => other.has(x)).length;
      return inter / Math.min(top.size, other.size) >= 0.3;
    });
    // same subject under two names ("Design system" / "Design systems", "Editor" / "Text editor")
    const stem = (t: string) => t.toLowerCase().split(' ').map((w) => w.replace(/s$/, ''));
    const words = stem(room.title);
    const sameName = kept.some((k) => {
      const kw = stem(k.title);
      const same = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));
      return words.every((w) => kw.some((x) => same(w, x))) || kw.every((x) => words.some((w) => same(w, x)));
    });
    if (!dup && !sameName) kept.push(room);
  }
  rooms = kept;

  // each repo in at most two rooms: keep it where the room is most specific (smallest)
  const placed = new Map<string, number>();
  rooms.sort((a, b) => a.repos.length - b.repos.length);
  for (const room of rooms) {
    room.repos = room.repos.filter((r) => {
      const n = placed.get(r.full_name) ?? 0;
      if (n >= 2) return false;
      placed.set(r.full_name, n + 1);
      return true;
    });
  }
  rooms = rooms.filter((r) => r.repos.length >= 4).map((r) => ({ ...r, repos: r.repos.slice(0, 8) }));
  rooms.sort((a, b) => b.repos[0].stargazers_count - a.repos[0].stargazers_count);

  const out = {
    asOf,
    source: 'GitHub topics, grouped automatically by scripts/build-rooms.ts',
    activeDays: ACTIVE_DAYS,
    rooms: rooms.map((room) => ({
      id: room.id,
      title: room.title,
      topics: room.topics,
      repos: room.repos.map((r) => ({
        name: r.full_name,
        desc: r.description ?? '',
        lang: r.language,
        stars: r.stargazers_count,
        forks: r.forks_count,
        issues: r.open_issues_count,
        created: r.created_at.slice(0, 10),
        pushed: r.pushed_at.slice(0, 10),
        license: r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : null,
      })),
    })),
  };
  writeFileSync('shared/data/rooms.json', `${JSON.stringify(out, null, 1)}\n`);
  console.log(`Wrote ${out.rooms.length} rooms (${out.rooms.reduce((n, r) => n + r.repos.length, 0)} repo slots) to shared/data/rooms.json`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
