/**
 * Refreshes the rising-repo pool from the GitHub search API.
 *
 *   npm run refresh-rising            # fetch, filter, rewrite clues, write to the DB
 *   npm run refresh-rising -- --dry   # print what would be stored
 *
 * Env: GITHUB_TOKEN (optional, higher rate limit), ANTHROPIC_API_KEY (optional, better clues), DB_PATH.
 */
import Anthropic from '@anthropic-ai/sdk';
import { exclusionReason, mentionsName, pickVariety, stripName, tidySentence, type GhRepo } from '../server/rising-filter.ts';

const DRY = process.argv.includes('--dry');
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function search(): Promise<GhRepo[]> {
  const since = iso(new Date(Date.now() - 60 * DAY));
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`created:>${since}`)}&sort=stars&order=desc&per_page=40`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'last-commit-standing-refresh',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GitHub search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items: GhRepo[] };
  return data.items;
}

const SYSTEM = `You write one-sentence clues for a quiz game where players guess a GitHub repository from its description.
Rules:
- One plain-language sentence, at most 25 words.
- Never mention the repository name, the owner name, or any part of them that would give the answer away.
- Use only facts present in the description and metadata you are given. Do not invent features, numbers or claims.
- No emoji, no marketing words like "revolutionary" or "blazing".
- Reply with the sentence only.`;

const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

/** Asks Claude for a name-free clue; returns null if unavailable or unusable. */
async function claudeClue(r: GhRepo): Promise<string | null> {
  if (!claude) return null;
  try {
    const response = await claude.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      output_config: { effort: 'low' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Repository: ${r.full_name}\nPrimary language: ${r.language ?? 'unknown'}\nTopics: ${(r.topics ?? []).join(', ') || 'none'}\nDescription: ${r.description}`,
        },
      ],
    } as Parameters<typeof claude.beta.messages.create>[0]);
    if (!('content' in response) || response.stop_reason === 'refusal') return null;
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ').trim();
    if (!text) return null;
    const clue = tidySentence(text);
    return mentionsName(clue, r) ? null : clue;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.warn(`  rate limited on ${r.full_name}; using regex fallback`);
    else if (err instanceof Anthropic.APIError) console.warn(`  Claude API error ${err.status} on ${r.full_name}; using regex fallback`);
    else throw err;
    return null;
  }
}

async function main() {
  const items = await search();
  console.log(`GitHub returned ${items.length} repos created in the last 60 days.`);
  const kept: GhRepo[] = [];
  for (const r of items) {
    const why = exclusionReason(r);
    if (why) console.log(`  skip ${r.full_name.padEnd(40)} ${why}`);
    else kept.push(r);
  }
  const picked = pickVariety(kept, 12, 3);
  if (picked.length < 10) console.warn(`Only ${picked.length} repos passed the filters (wanted 10–12).`);

  const rows: { name: string; desc: string; desc_auto: number; orig_desc: string | null; lang: string | null; stars: number; url: string; source: string }[] = [];
  for (const r of picked) {
    const viaClaude = await claudeClue(r);
    const desc = viaClaude ?? stripName(r.description!, r) ?? tidySentence(r.description!);
    // Everything not written by a person is flagged for review; a raw fallback may still contain the name.
    rows.push({
      name: r.full_name,
      desc,
      desc_auto: 1,
      orig_desc: r.description,
      lang: r.language,
      stars: r.stargazers_count,
      url: r.html_url ?? `https://github.com/${r.full_name}`,
      source: viaClaude ? 'claude' : mentionsName(desc, r) ? 'ORIGINAL (contains name, review!)' : 'regex',
    });
  }

  const asOf = iso(new Date());
  console.log(`\nRising pool as of ${asOf}:`);
  for (const r of rows) console.log(`  ${r.name.padEnd(40)} ${String(r.stars).padStart(6)}★ ${(r.lang ?? '-').padEnd(11)} [${r.source}] ${r.desc}`);
  if (DRY) return console.log('\n--dry: nothing written.');
  if (rows.length < 2) throw new Error('Not enough repos to store; keeping the previous pool.');

  const { db, setMeta } = await import('../server/db.ts');
  db.transaction(() => {
    db.prepare('DELETE FROM rising').run();
    const ins = db.prepare('INSERT INTO rising (name, rank, desc, desc_auto, orig_desc, lang, stars, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    rows.forEach((r, i) => ins.run(r.name, i, r.desc, r.desc_auto, r.orig_desc, r.lang, r.stars, r.url));
    setMeta('rising_as_of', asOf);
  })();
  console.log(`\nStored ${rows.length} rising repos. Descriptions are marked desc_auto=1 for review.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
