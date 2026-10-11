/**
 * Builds shared/data/catalog.json from CATALOG_LIST using only facts returned by the GitHub API.
 *
 *   GITHUB_TOKEN=$(gh auth token) npm run build-catalog
 *
 * For each repo: description, primary language and its byte share, license, creation year and
 * star count. The description becomes a name-free clue (Claude rewrite when ANTHROPIC_API_KEY is
 * set, otherwise regex). Repos that 404, are archived without a description, or whose clue still
 * leaks the name keep only the question kinds that don't need a clue.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'node:fs';
import { CATALOG_LIST } from '../shared/data/catalog-list.ts';
import { CLUE_OVERRIDES } from '../shared/data/catalog-clues.ts';
import { rngFrom, shuffle } from '../shared/rng.ts';
import type { Band, Repo } from '../shared/types.ts';
import { mentionsName, stripName, tidySentence } from '../server/rising-filter.ts';

const token = process.env.GITHUB_TOKEN;
if (!token) console.warn('GITHUB_TOKEN not set: you will hit the 60 requests/hour limit. Try GITHUB_TOKEN=$(gh auth token).');
const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'last-commit-standing-catalog',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

async function gh<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface GhRepoFull {
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  language: string | null;
  license: { spdx_id: string | null } | null;
  created_at: string;
  stargazers_count: number;
  archived: boolean;
}

const NO_LANG_Q = new Set(['Jupyter Notebook', 'HTML', 'CSS', 'Markdown', 'MDX', 'TeX', 'Dockerfile', 'Makefile', 'Roff']);

const band = (stars: number): Band =>
  stars >= 200_000 ? '200k+' : stars >= 100_000 ? '100k+' : stars >= 50_000 ? '50k+' : stars >= 20_000 ? '20k+' : '<20k';

const claude = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
const SYSTEM = `You write one-sentence clues for a quiz game where players guess a GitHub repository from its description.
Rules: one plain sentence, at most 22 words; never mention the project's name, its owner, or any part of them; use only facts in the description given; no emoji or marketing words. Reply with the sentence only.`;

async function clueFor(r: GhRepoFull, short: string): Promise<string | null> {
  const desc = r.description?.trim();
  const leaks = (s: string) => mentionsName(s, r) || new RegExp(`(^|[^a-z0-9])${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i').test(s);
  const override = CLUE_OVERRIDES[r.full_name];
  if (override) {
    if (!leaks(override)) return override;
    console.warn(`  override for ${r.full_name} mentions the name; ignoring it`);
  }
  if (!desc || desc.length < 12) return null;
  if (claude) {
    try {
      const msg = await claude.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 1024,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: SYSTEM,
        messages: [{ role: 'user', content: `Project: ${r.full_name} (also known as ${short})\nDescription: ${desc}` }],
      } as Parameters<typeof claude.beta.messages.create>[0]);
      if ('content' in msg && msg.stop_reason !== 'refusal') {
        const text = tidySentence(msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' '));
        if (text && !leaks(text)) return text;
      }
    } catch (err) {
      if (!(err instanceof Anthropic.APIError)) throw err;
      console.warn(`  Claude error ${err.status} for ${r.full_name}; using regex`);
    }
  }
  const stripped = stripName(desc, r);
  return stripped && !leaks(stripped) ? stripped : null;
}

async function main() {
  const asOf = new Date().toISOString().slice(0, 10);
  const built: (Repo & { clue: string | null })[] = [];
  for (const [name, short, region] of CATALOG_LIST) {
    const r = await gh<GhRepoFull>(`/repos/${name}`);
    if (!r) {
      console.warn(`  skip ${name}: not found`);
      continue;
    }
    const langs = (await gh<Record<string, number>>(`/repos/${r.full_name}/languages`)) ?? {};
    const total = Object.values(langs).reduce((a, b) => a + b, 0);
    const langShare = r.language && total ? (langs[r.language] ?? 0) / total : 0;
    const clue = await clueFor(r, short);
    const spdx = r.license?.spdx_id && r.license.spdx_id !== 'NOASSERTION' ? r.license.spdx_id : null;
    built.push({
      id: `gh:${r.full_name.toLowerCase()}`,
      region,
      short,
      name: r.full_name,
      lang: r.language ?? '',
      langQ: !!r.language && langShare >= 0.6 && !NO_LANG_Q.has(r.language),
      band: band(r.stargazers_count),
      clues: [clue ?? '', clue ?? ''],
      what: clue ?? '',
      about: r.description?.trim() ?? '',
      facts: { created: Number(r.created_at.slice(0, 4)), license: spdx, stars: r.stargazers_count, asOf, langShare: Math.round(langShare * 100) / 100 },
      clue,
    });
    console.log(`  ${r.full_name.padEnd(42)} ${String(r.stargazers_count).padStart(7)}★ ${(r.language ?? '-').padEnd(12)} ${Math.round(langShare * 100)}% ${spdx ?? '-'} ${r.created_at.slice(0, 4)} ${clue ? '' : '(no clue)'}`);
  }

  // distractors: other repos from the same region, seeded by id so rebuilds are stable
  const out: Repo[] = built.map(({ clue, ...repo }) => {
    const rng = rngFrom(`catalog:${repo.id}`);
    const sameRegion = built.filter((b) => b.region === repo.region && b.id !== repo.id);
    const others = shuffle(rng, sameRegion);
    const withClue = others.filter((b) => b.clue && b.clue !== clue);
    if (clue) {
      repo.choices = [repo.short, ...others.slice(0, 3).map((b) => b.short)] as Repo['choices'];
      if (withClue.length >= 3) repo.whatWrong = withClue.slice(0, 3).map((b) => b.clue!) as Repo['whatWrong'];
    }
    return repo;
  });

  writeFileSync('shared/data/catalog.json', `${JSON.stringify({ asOf, repos: out }, null, 1)}\n`);
  console.log(`\nWrote ${out.length} repos (${out.filter((r) => r.choices).length} with clues) to shared/data/catalog.json`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
