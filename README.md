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

## How the rules are enforced

- **Daily:** the course comes from `FNV-1a("lcs-YYYYMMDD")` → mulberry32, and each question from
  `YYYYMMDD-q-<n>`. The rising pool used for a date is frozen the first time anyone loads that
  date, so a refresh partway through the day can't change the course.
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
                ANTHROPIC_API_KEY=<optional, for better rising clues>
fly deploy
fly ssh console -C "sh -c 'cd /app && npm run refresh-rising'"   # first rising pool
```

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

- Identity is a cookie. Clearing cookies gives a new player number and another official run.
  Adding real accounts would close that gap.
- The client is trusted for *when* it answered within the timer (it reports `ceil(secondsLeft)`).
  The server bounds it by the timer and total run time, but a modified client could still claim
  fast answers. Arena answers are fully server-timed.
- Arena positions are client-reported. The server checks freshness and that the platform exists,
  not the physics.
