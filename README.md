# Repo Safari

**Play: https://w20labs.github.io/repo-safari/**

A new trail through open source every day. Each platform is a category of active GitHub repos
(OCR, vector databases, game engines…), grouped automatically from GitHub topics. Drop into a
category's room to compare its repos as stickers, ranked by stars, and collect the ones you like.
It's an early playtest: no sign-up, and your sticker album stays in your browser.

| | |
|---|---|
| Page template | `prototypes/repo-safari.template.html` |
| Category rooms | `npm run build-rooms` → `shared/data/rooms.json` (rules in `scripts/build-rooms.ts`) |
| Rising repos | `npm run refresh-rising` → `shared/data/rising.json` |
| Build the site | `npm run build-safari -- https://w20labs.github.io/repo-safari/ --site _site` |
| Deploy | `.github/workflows/pages.yml`: every push to `main`, plus a weekly data refresh on Mondays |

The rest of this README covers **Last Commit Standing**, the quiz platformer this repo started as.
Its client, server and tests are still here and still pass.

---

# Last Commit Standing

A 2D elimination platformer for developers. Every platform is a GitHub repo. Land on one, answer a
question about it, and keep going. A wrong answer, running out of time or falling into the merge
conflict knocks you out.

## Run it locally

```sh
npm install
npm run dev            # Vite on http://localhost:5173, API + Arena on :8787 (proxied)
```

Open http://localhost:5173. That's it; the SQLite file is created at `data/lcs.db`.

| Command | What it does |
| --- | --- |
| `npm run dev` | Client (Vite) and server (`tsx watch`) together |
| `npm test` | Unit tests (Vitest): RNG, course generation and reachability, questions, scoring, run validation, Arena timing and rooms, rising filters |
| `npm run test:e2e` | Playwright smoke tests (`npx playwright install chromium` once first) |
| `npm run typecheck` | `tsc --noEmit` across client, server, shared and tests |
| `npm run build` | Typecheck and bundle the client to `dist/client` |
| `npm start` | Production server: API, Arena and the built client on `$PORT` (default 8787) |
| `npm run refresh-rising` | Refresh the rising-repo pool from GitHub (`-- --dry` to preview) |
| `npm run build-catalog` | Rebuild `shared/data/catalog.json` from the GitHub API (`GITHUB_TOKEN=$(gh auth token) npm run build-catalog`) |

To try the Arena alone, create a room in the browser and add scripted players:
`npx tsx scripts/dev/arena-bot.ts <code> --name "Bot"` (stands on a safe platform, answers at random).

## Layout

```
shared/   game logic used by both sides: rng, course, questions, scoring, arena timing,
          share text, PNG card drawing, protocol types, data/classic.ts (the 24 repos)
client/   Vite + TypeScript. game/ (physics, world, renderer, input, bots), ui/ (overlays),
          modes/ (solo = Daily + Practice, arena, menu backdrop), net/ (API, Arena socket)
server/   Node http + ws. routes.ts (API, /r/:id, /card/:id.png), store.ts + db.ts (SQLite),
          daily.ts (run validation), arena/ (rooms, bells, judging), rising-filter.ts
scripts/  refresh-rising.ts, dev/arena-bot.ts
tests/    Vitest        e2e/  Playwright
```

## Content

- **24 classic repos** (`shared/data/classic.ts`), hand-written clues and trivia from the original brief.
- **215 catalog repos** (`shared/data/catalog-list.ts` → `catalog.json`). Only the name, display name
  and region are hand-picked. Every fact used in a question (description, primary language and its
  share of the code, license, creation year, stars) comes from the GitHub API with an as-of date.
  Questions: identify (name-free clue), what it does, language (only when one language is 60%+ of
  the code), year the repository was created, license, and star range.
- Clues are the repo's own description with the name removed. When that leaves a hole, a reworded
  version lives in `shared/data/catalog-clues.ts` (same facts, no name); repos whose description is
  just their name get no clue and skip identify/what. A test checks no clue leaks its repo's name.
- **Rising repos** refresh weekly (see below). The Daily mixes 10 classic/catalog repos with 2 rising.

## Social features

- **Streaks and stats:** played, made-the-gate rate, current and best streak, best score, and the
  last 14 days, all from official Daily runs.
- **Share text and cards** add rank, top percent, streak, team rank and fastest answer, e.g.
  `#212 of 5,310 · top 4% · streak 5 · team acme #2 of 31 · fastest 1.4s`.
- **Teams:** set a team (or open `/?team=acme`). A team's daily score is its best 3 official runs
  added up. Leaderboard tabs: Everyone, Verified, My team, Teams.
- **Rising reveal:** after a Daily, the results list today's rising repos with links (also on the
  `/r/:id` share page), plus the whole weekly pool.
- **Arena:** private rooms, or *Quick match* into a public room that starts 15 s after the first
  player arrives (sooner when 12+ are waiting). Empty seats are filled with clearly labeled bots
  (about 70% accurate). Invite links are `/a/<code>`, with a preview card for chat apps.
- **Sign in with GitHub** (optional): verified players show as `@login` with a check mark, and the
  Verified tab shows only them. Display names can't start with `@`.
- **Sound:** small synthesized effects (no audio files); mute with the speaker button or `M`.

## How the rules are enforced

- **Daily:** the course comes from `FNV-1a("lcs-YYYYMMDD")` → mulberry32, and each question from
  `YYYYMMDD-q-<n>`. The day's rising pool and its 12 repos are stored the first time anyone loads
  that date, so a weekly refresh or a catalog rebuild can't change a course (or old share cards).
- **Official run:** `POST /api/daily/start` creates at most one official run per player per UTC
  day (enforced by a unique index). Players are identified by an anonymous `lcs_pid` cookie.
- **Finish validation:** the server recomputes the score from the seeded course and the claimed
  per-platform results, and rejects unknown or repeated platforms, answers after a wrong one,
  impossible timer values, an early gate win, score mismatches, and runs faster than their answers.
  The server works out the "Out on #8 Terraform (trivia)" label itself.
- **Arena:** the server picks the seed and `t0 = now + 5 s`, rings bells at `t0 + 9 s + k·20 s`,
  checks each player's last position report (within 300 ms, on a platform that is still standing),
  and judges answers on its own clock. Questions come from a secret per-match seed, so the public
  course seed can't be used to precompute answers. Crumbling is deterministic from the public seed.

## Deploy (Fly.io)

One always-on machine with a volume. The Arena keeps rooms in memory and SQLite is a local file,
so **don't scale past one machine**.

```sh
fly launch --no-deploy --copy-config      # pick an app name; it updates fly.toml
fly volumes create lcs_data --size 1 --region iad
fly secrets set PUBLIC_URL=https://<app>.fly.dev \
                GITHUB_TOKEN=<read-only token> \
                ANTHROPIC_API_KEY=<optional, for better rising clues> \
                GITHUB_CLIENT_ID=<optional, OAuth app> GITHUB_CLIENT_SECRET=<optional>
fly deploy
fly ssh console -C "sh -c 'cd /app && npm run refresh-rising'"   # first rising pool
```

**GitHub sign-in (optional):** create an OAuth app at github.com/settings/developers with the
callback URL `<PUBLIC_URL>/auth/github/callback`, then set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`. Without them the sign-in button is hidden and everything else works.

`PUBLIC_URL` is used for absolute links in share pages and Open Graph tags. Set it to your custom
domain if you add one.

**Weekly refresh:** `.github/workflows/refresh-rising.yml` runs every Monday at 06:00 UTC and
executes the script inside the live machine. Add a `FLY_API_TOKEN` repo secret
(`fly tokens create deploy`) and, if your app isn't called `last-commit-standing`, a `FLY_APP`
repo variable.

**Reviewing rising clues:** every stored description is marked `desc_auto = 1`. The script prints
each one with its source (`claude`, `regex`, or `ORIGINAL (contains name, review!)`). To fix one:

```sh
fly ssh console -C "sqlite3 /data/lcs.db \"UPDATE rising SET desc='…', desc_auto=0 WHERE name='owner/repo'\""
```

(`sqlite3` isn't in the image by default; add it to the Dockerfile's runtime stage, or edit with a
one-off `node -e` using better-sqlite3.)

**Deploys end live Arena matches.** Rooms are in memory, so clients get "No room with that code"
and return to the Arena screen. Daily runs are unaffected.

## Known limits

- Anonymous identity is a cookie, so clearing cookies gives an anonymous player another official
  run. GitHub-verified players can't do that, which is what the Verified tab is for.
- Anyone can join any team by typing its name. Teams are for friendly rivalry, not access control.
- The client is trusted for *when* it answered within the timer (it reports `ceil(secondsLeft)`).
  The server bounds it by the timer and total run time, but a modified client could still claim
  fast answers. Arena answers are fully server-timed.
- Arena positions are client-reported. The server checks freshness and that the platform exists,
  not the physics.
