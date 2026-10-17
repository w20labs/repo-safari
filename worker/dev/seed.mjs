// Synthetic idea-board fixtures for the local preview. No real people, no paid calls.
//
//   node worker/dev/seed.mjs sql <file>     write the fixture SQL (accounts, ideas, stars at set times)
//   node worker/dev/seed.mjs finish <url>   then, with the preview Worker running: set the test clock, close the past
//                                           weeks with the real closing code, and move two winners along the build queue
//
// The story (UTC): the board launched Wednesday 23 Sep 2026 09:00, so the first week is partial.
//   23–28 Sep (partial)  Commit Weather 6 vs Error Karaoke 4          -> Commit Weather, now built
//   28 Sep–5 Oct         Error Karaoke 9 vs Dependency Bonsai 8       -> Error Karaoke, now building
//   5–12 Oct             no stars                                     -> no winner
//   12–19 Oct            Pancake Launcher 5 vs Dependency Bonsai 4    -> Pancake Launcher, selected, waiting
//   19–26 Oct (now: Wed 21 Oct 15:00)  Standup Haiku 4 and Rubber Duck Radio 4 tie (Haiku got there first);
//                        Dependency Bonsai has 2 new this week but 14 lifetime; a hidden spam idea and a held idea.
import { writeFileSync } from 'node:fs';

const T = (iso) => Date.parse(iso);
export const LAUNCH = T('2026-09-23T09:00:00Z');
export const NOW = T('2026-10-21T15:00:00Z');
const ADMIN = 'local-preview-admin-token-0123456789abcdef';

const repo = (name, desc, room) => ({ name, url: `https://github.com/${name}`, desc, room, seenAt: '2026-09-23' });
const R = {
  n8n: repo('n8n-io/n8n', 'Fair-code workflow automation platform with native AI capabilities.', 'Low code'),
  ollama: repo('ollama/ollama', 'Get up and running with large language models.', 'LLM tools'),
  logseq: repo('logseq/logseq', 'A privacy-first, open-source platform for knowledge management.', 'Knowledge base'),
  axios: repo('axios/axios', 'Promise based HTTP client for the browser and node.js.', 'HTTP clients'),
  rustls: repo('rustls/rustls', 'A modern TLS library in Rust.', 'Security'),
  piper: repo('rhasspy/piper', 'A fast, local neural text to speech system.', 'Text to speech'),
  excalidraw: repo('excalidraw/excalidraw', 'Virtual whiteboard for sketching hand-drawn like diagrams.', 'Diagrams'),
  zx: repo('google/zx', 'A tool for writing better scripts.', 'CLI tools'),
  pocketbase: repo('pocketbase/pocketbase', 'Open Source realtime backend in 1 file.', 'Backend'),
};
const ideas = [
  { id: 'commitwthr', kind: 'useful', name: 'Commit Weather', pitch: 'A forecast of your repo’s week, made from its commit history.', concept: 'It reads recent commits and turns churn, reverts and quiet days into a five-day weather report. Storms mean risky files.', inspiration: 'n8n runs the daily job, ollama writes the forecast, excalidraw draws the map.', repos: [R.n8n, R.ollama, R.excalidraw], by: 1001, at: '2026-09-23T10:00:00Z' },
  { id: 'errkaraoke', kind: 'ridiculous', name: 'Error Karaoke', pitch: 'Turn your application errors into songs.', concept: 'Each new stack trace becomes a verse sung by a local voice model, and the chorus is the line that failed.', inspiration: 'axios catches the errors, piper sings them, zx glues it together.', repos: [R.axios, R.piper, R.zx], by: 1002, at: '2026-09-24T12:00:00Z' },
  { id: 'depbonsai2', kind: 'unexpected', name: 'Dependency Bonsai', pitch: 'Prune your dependency tree like a bonsai.', concept: 'Your lockfile grows as a little tree. Trim a branch and it shows what would break, before you do it for real.', inspiration: 'pocketbase stores the tree, excalidraw draws it, zx tries each cut.', repos: [R.pocketbase, R.excalidraw, R.zx], by: 1003, at: '2026-09-29T09:00:00Z' },
  { id: 'pancakelch', kind: 'ridiculous', name: 'Pancake Launcher', pitch: 'Flip a pancake every time a deploy goes green.', concept: 'A webhook drives a small catapult; a voice counts down and logs every flip to a shared wall of fame.', inspiration: 'n8n listens for deploys, piper counts down, pocketbase keeps the wall of fame.', repos: [R.n8n, R.piper, R.pocketbase], by: 1004, at: '2026-10-13T08:00:00Z' },
  { id: 'standuphku', kind: 'useful', name: 'Standup Haiku', pitch: 'Your daily standup, as three lines of haiku.', concept: 'It reads yesterday’s commits and notes and writes a 5-7-5 summary you can paste into chat.', inspiration: 'logseq holds the notes, ollama writes the haiku, zx posts it.', repos: [R.logseq, R.ollama, R.zx], by: 1001, at: '2026-10-19T10:00:00Z' },
  { id: 'duckradio2', kind: 'unexpected', name: 'Rubber Duck Radio', pitch: 'A rubber duck that talks back about your bug.', concept: 'Explain the bug out loud; it asks one good question at a time, in a calm radio voice.', inspiration: 'ollama asks the questions, piper is the voice, logseq remembers past bugs.', repos: [R.ollama, R.piper, R.logseq], by: 1002, at: '2026-10-20T08:00:00Z' },
  { id: 'kitephysic', kind: 'useful', name: 'Kite Physics Lab', pitch: 'Sketch a kite and see whether it would fly.', concept: 'Draw a kite shape, set the wind, and watch a simple simulation tell you where it would stall.', inspiration: 'excalidraw for the sketch, pocketbase for saved designs, zx to run the solver.', repos: [R.excalidraw, R.pocketbase, R.zx], by: 1005, at: '2026-10-21T08:00:00Z' },
  { id: 'changelogp', kind: 'useful', name: 'Changelog Postcards', pitch: 'Release notes as postcards your users actually read.', concept: 'Each release becomes a short illustrated postcard with the three changes that matter most.', inspiration: 'n8n collects the changes, ollama picks the three, excalidraw draws the card.', repos: [R.n8n, R.ollama, R.excalidraw], by: 1003, at: '2026-10-21T11:00:00Z' },
  { id: 'repotarot2', kind: 'ridiculous', name: 'Repo Tarot', pitch: 'Draw three cards and learn your repository’s fate.', concept: 'Cards are drawn from real signals: stale issues, bus factor, test coverage, with a dramatic reading.', inspiration: 'axios fetches the signals, ollama reads the cards, excalidraw draws them.', repos: [R.axios, R.ollama, R.excalidraw], by: 1004, at: '2026-10-21T12:30:00Z' },
  { id: 'lintlullab', kind: 'unexpected', name: 'Lint Lullabies', pitch: 'Soothing songs that fix your lint warnings while you sleep.', concept: 'Overnight, it fixes safe lint warnings one by one and sings a summary in the morning.', inspiration: 'zx runs the fixes, piper sings, pocketbase keeps the score.', repos: [R.zx, R.piper, R.pocketbase], by: 1005, at: '2026-10-21T13:45:00Z' },
  { id: 'scrapeall2', kind: 'unexpected', name: 'Scrape Every Profile', pitch: 'Collect everything public about a developer.', concept: 'Held for review.', inspiration: 'Held for review.', repos: [R.axios, R.n8n, R.ollama], by: 1003, at: '2026-10-20T09:00:00Z' },
  { id: 'hiddenspam', kind: 'useful', name: 'Buy Followers Fast', pitch: 'Spam that was hidden by the owner.', concept: 'Hidden.', inspiration: 'Hidden.', repos: [R.axios, R.zx, R.n8n], by: 1005, at: '2026-10-20T10:00:00Z' },
];
const logins = new Map([[1001, 'alice'], [1002, 'bob'], [1003, 'carol'], [1004, 'dana'], [1005, 'eve'], ...Array.from({ length: 40 }, (_, i) => [2000 + i, `voter${i}`])]);

/** n stars on an idea from voters starting at `from`, one every `stepMin` minutes from `startIso`. */
const stars = [];
const give = (id, from, n, startIso, stepMin = 30) => { for (let k = 0; k < n; k++) stars.push({ id, who: from + k, at: T(startIso) + k * stepMin * 60_000 }); };
give('commitwthr', 2000, 6, '2026-09-24T09:00:00Z');
give('errkaraoke', 2010, 4, '2026-09-25T09:00:00Z');
give('errkaraoke', 2014, 9, '2026-09-29T09:00:00Z');
give('depbonsai2', 2000, 8, '2026-09-30T09:00:00Z');
give('pancakelch', 2020, 5, '2026-10-14T09:00:00Z');
give('depbonsai2', 2030, 4, '2026-10-15T09:00:00Z');
give('depbonsai2', 2008, 2, '2026-10-19T14:00:00Z'); // 2 new this week, 14 lifetime before
give('standuphku', 2000, 4, '2026-10-19T12:00:00Z', 60); // reaches 4 at 15:00 on the 19th
give('duckradio2', 2004, 4, '2026-10-20T09:00:00Z', 60); // reaches 4 at 12:00 on the 20th: tied, but later
give('kitephysic', 1001, 1, '2026-10-21T09:00:00Z');
give('hiddenspam', 2020, 9, '2026-10-20T11:00:00Z');
give('scrapeall2', 2025, 3, '2026-10-20T10:00:00Z');
const unstars = [{ id: 'pancakelch', who: 2020, at: T('2026-10-16T09:00:00Z') }, { id: 'pancakelch', who: 2020, at: T('2026-10-16T10:00:00Z'), on: true }]; // unstar and restore within the week: still counts once

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function sql() {
  const out = ['PRAGMA foreign_keys = ON;', `INSERT OR REPLACE INTO board_settings (key, value) VALUES ('launch_at', '${LAUNCH}');`];
  for (const [id, login] of logins) out.push(`INSERT INTO accounts (github_id, login, created_at, updated_at) VALUES (${id}, ${q(login)}, ${LAUNCH}, ${LAUNCH});`);
  for (const i of ideas) {
    out.push(`INSERT INTO ideas (id, content_hash, kind, name, pitch, concept, inspiration, repos_json, publisher_id, publisher_login, model, published_at) VALUES (${[i.id, `seed-${i.id}`, i.kind, i.name, i.pitch, i.concept, i.inspiration, JSON.stringify(i.repos), i.by, logins.get(i.by), 'fixture', T(i.at)].map(q).join(', ')});`);
  }
  const events = [...stars.map((s) => ({ ...s, on: true, first: true })), ...unstars].sort((a, b) => a.at - b.at);
  for (const e of events) {
    if (e.first) out.push(`INSERT INTO stars (idea_id, github_id, first_starred_at, active, updated_at) VALUES (${q(e.id)}, ${e.who}, ${e.at}, 1, ${e.at});`);
    else out.push(`UPDATE stars SET active = ${e.on ? 1 : 0}, updated_at = ${e.at} WHERE idea_id = ${q(e.id)} AND github_id = ${e.who};`);
  }
  // moderation, as the owner would record it (the admin API does the same)
  const hideAt = T('2026-10-20T12:00:00Z'), holdAt = T('2026-10-20T13:00:00Z');
  out.push(`UPDATE ideas SET hidden_at = ${hideAt} WHERE id = 'hiddenspam';`,
    `INSERT INTO moderation_events (idea_id, at, action, reason) VALUES ('hiddenspam', ${hideAt}, 'hide', 'spam (fixture)');`,
    `UPDATE ideas SET status = 'held', status_note = 'On hold: collecting personal data isn’t something we’ll build.' WHERE id = 'scrapeall2';`,
    `INSERT INTO moderation_events (idea_id, at, action, reason) VALUES ('scrapeall2', ${holdAt}, 'hold', 'privacy (fixture)');`);
  return out.join('\n') + '\n';
}

async function finish(base) {
  const call = async (path, body, admin = false) => {
    const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Admin-Token': ADMIN } : {}) }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(`${path}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  await call('/dev/clock', { at: NOW });
  const { closed } = await call('/dev/close', {});
  console.log('closed:', closed.map((c) => `${new Date(c.start).toISOString().slice(0, 10)} -> ${c.winner ?? 'no winner'} (${c.score})`).join(', '));
  await call('/board/admin', { action: 'building', idea: 'commitwthr', note: 'Prototype in progress.' }, true);
  await call('/board/admin', { action: 'built', idea: 'commitwthr', sourceUrl: 'https://github.com/w20labs/commit-weather', demoUrl: 'https://w20labs.github.io/commit-weather/', note: 'Preview fixture: these links are placeholders.' }, true);
  await call('/board/admin', { action: 'building', idea: 'errkaraoke', note: 'The singing works; the chorus doesn’t yet.' }, true);
}

const [mode, arg] = process.argv.slice(2);
if (mode === 'sql') { writeFileSync(arg, sql()); console.log(`wrote ${arg}`); }
else if (mode === 'finish') await finish(arg ?? 'http://127.0.0.1:8788');
else { console.error('usage: seed.mjs sql <file> | finish <worker-url>'); process.exit(1); }
