/**
 * Adds community counts (outside PRs merged in the last 90 days) to the existing room and rising data, in place,
 * without rebuilding the rooms. The weekly build-rooms run does this itself; this is for a refresh in between.
 *
 *   GITHUB_TOKEN=$(gh auth token) npm run community
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { COMMUNITY_DAYS, countOutsidePrs, githubGraphql } from './community.ts';

const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('Set GITHUB_TOKEN (e.g. GITHUB_TOKEN=$(gh auth token))');
type R = { name: string; outsidePrs?: number; outsideCapped?: boolean };
const files = ['shared/data/rooms.json', 'shared/data/rising.json'];
const docs = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const repos: R[] = [...docs[0].rooms.flatMap((room: { repos: R[] }) => room.repos), ...(docs[1]?.repos ?? [])];
console.log(`Counting outside contributions for ${new Set(repos.map((r) => r.name)).size} repos…`);
const community = await countOutsidePrs(repos.map((r) => r.name), new Date(), githubGraphql(token));
for (const r of repos) {
  delete r.outsidePrs; delete r.outsideCapped;
  const c = community.get(r.name);
  if (c) { r.outsidePrs = c.outsidePrs; if (c.capped) r.outsideCapped = true; }
}
docs[0].communityDays = COMMUNITY_DAYS;
docs.forEach((d, i) => writeFileSync(files[i], `${JSON.stringify(d, null, 1)}\n`));
console.log(`Counted ${community.size} of ${new Set(repos.map((r) => r.name)).size} repos.`);
