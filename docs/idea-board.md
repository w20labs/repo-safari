# Idea board: publish an idea, collect stars, build one a week

The idea board lets a visitor publish one of their Idea Shower ideas, share its permanent link, and collect stars from other GitHub accounts. During the launch phase, W20 Labs builds one community prototype a week: the eligible idea that earned the most new stars that week.

> **Public commitment (approved by the owner):** Every week, we build and share an open-source prototype of the idea that earns the most new stars that week.
>
> `POLICY_APPROVED = true` in `prototypes/board/board.js` shows it without the "Proposed wording, pending approval" tag. Changing the sentence later needs the owner's approval again.

The board went live on 17 Oct 2026. Local builds remain off by default; see [Activation](#activation) for setup and rollback instructions.

## How it works

```
 Idea Shower (anonymous)          Publish (signed in)               Stars (signed in)            Weekly close (Worker cron)
 POST /ideas ─────────────▶ draft + receipt ──▶ POST /board/publish ──▶ PUT/DELETE …/star ──▶ result + build-queue entry
 3 ideas, saved 24 h         kept in the page      exact saved text        one per account          one per week, immutable
```

| Piece | Where | Notes |
|---|---|---|
| Page hooks | `prototypes/repo-safari.template.html` | `BOARD` switch, Publish buttons, Ideas entry, privacy text. Loads the module below only when the board is on |
| Board UI | `prototypes/board/board.js`, `board.css` | Copied next to the page by the build. Talks only to the Worker. Adds the landing section below the game and the full board (a dialog) |
| API | `worker/src/board/routes.ts` | Routed from `worker/src/ideas.ts`; 404 when off |
| Sign-in | `worker/src/board/auth.ts` | GitHub OAuth, public profile only, bearer sessions (no cookies) |
| Storage | `worker/src/board/store.ts`, `worker/migrations/0001_idea_board.sql` | Cloudflare D1 |
| Contest rules | `worker/src/board/contest.ts` | Pure functions: weeks, scoring as of the cutoff, eligibility, tie-break |
| Owner tool | `scripts/board-admin.ts` | `npm run board-admin -- <action>` |
| Local preview | `worker/dev/` | Fake GitHub and Anthropic, fixtures, test clock |

### On the landing page

With the board on, a full-width **Idea board** section sits directly below the game (after the touch controls on phones), so the game stays near the top:

- The heading's payoff line, "Star the idea you want us to build next.", and the loop, "Mix repos → Publish an idea → Collect stars → Weekly pick".
- This week's top 5 ideas with their pitch, weekly stars and a Star button, plus the time until voting closes. On phones, names wrap, pitches get two lines, and the count and Star sit underneath.
- **Browse and star ideas →** opens the full board; **Create an idea ↑** brings the Idea Shower card into view. Publishing still happens from generated ideas, with sign-in and an explicit confirmation.
- The build card: **Last week's pick** with its status (Queued, Building, Built; built ones link to demo and source). It says **Latest pick** if the hourly close hasn't caught up yet. If last week had no pick, it says so and features a project **From the build queue** instead.
- Loading shows three placeholder rows; an error shows one compact line with Try again; an empty week says one star could win it; signed-out visitors see how starring works.

With the board off, none of this is on the page.

### Publishing

1. With the board on, `POST /ideas` saves the validated output as a **draft** (24 hours) and returns `{id, receipt}`. Only a SHA-256 of the receipt is stored. If saving fails, the ideas are still returned with `draft: null`; the page says publishing is unavailable and never asks the model again.
2. **Publish to idea board** asks for GitHub sign-in if needed. The chosen idea (with its receipt) waits in the page's local storage during the round trip, then a confirmation explains that the idea, its 3 source repos and the publisher's GitHub handle become public.
3. `POST /board/publish {draftId, receipt, index}` needs a session and the receipt. It copies the idea **from the stored draft**; anything else the browser sends is ignored. A crafted `#mix=` link has no draft or receipt, so it can't be published.
4. The record is keyed by a hash of the idea text and its repo names: a retry, a double click or the same idea published by someone else returns the same record, so stars never split. Published text never changes. A hidden idea can't be republished.
5. Publishing doesn't star it. The publisher can star it like anyone else.

Each idea gets a permanent link `…/#idea=<10-character id>`. The record keeps a snapshot of its source repos (name, GitHub URL, description, room, stars, date), so the link keeps working after the repos leave the weekly trail. Old `#mix=` links work exactly as before.

### Sign-in without third-party cookies

GitHub Pages and `workers.dev` are different sites, so the board never relies on cookies:

1. The page makes a random verifier, keeps it in its own storage and opens `/auth/github/start?return=<page>&challenge=<SHA-256 of the verifier>`.
2. The Worker stores a single-use OAuth state (10 minutes) and sends the browser to GitHub with **no scopes** (public profile only: no repositories, organizations or private email).
3. `/auth/github/callback` consumes the state (a replay finds nothing), exchanges the code, reads the numeric account id and handle, **drops the GitHub token**, and returns to the page with a one-time login code in the URL fragment (2 minutes; fragments aren't sent to servers).
4. The page posts the code with its verifier to `/auth/exchange` and gets a 30-day session token, sent as `Authorization: Bearer`. The page removes the code from the address bar at once.

Return addresses must be on an allowed origin (`ALLOWED_ORIGINS`). Writes also require an allowed `Origin` header; CORS isn't treated as authentication. The voter identity is GitHub's immutable numeric id, so renaming an account doesn't create a new voter.

The session token lives in the page's `localStorage`. On `w20labs.github.io` every W20 Labs project page shares that storage origin; a custom domain for Repo Safari would isolate it (recommended, not required).

### Stars

- One row per (idea, GitHub account), enforced by the primary key. `PUT …/star` sets it and `DELETE …/star` clears it; both are idempotent, so two tabs, double clicks and retries after a lost response can't double count. There's no toggle endpoint.
- The first-star time never changes. Unstarring and starring again restores the same contribution; it never moves into a later week.
- Database triggers keep the lifetime count and an append-only star history in the same transaction as each change.
- Limits: 60 star changes per account per minute; 10 publications per account per 24 hours.

### The weekly contest

| Rule | Detail |
|---|---|
| Week | Monday 00:00 UTC (inclusive) to the next Monday 00:00 UTC (exclusive). The first week starts when the board is first used while enabled and ends at the next Monday; if that would leave it under 3 days, it runs on to the Monday after. It's labelled the launch week |
| Score | Valid new stars: first given inside the week, still active and not excluded at the cutoff. Lifetime stars don't count |
| Example | An idea with 7 new stars this week beats one with 100 lifetime stars but only 2 new this week |
| Minimum | One star can win. If no eligible idea has a star, the week is recorded with no winner |
| Eligible | Published before the cutoff, not hidden, held or declined at the cutoff, and never selected before |
| Ties | The idea that first reached its final score (from its still-valid stars), then the earlier publication, then the smaller id |
| Several ideas | Each account can star any number of ideas, once each. It isn't one vote per week |

Closing runs from the Worker's own UTC clock (cron, hourly). For each ended, unclosed week (oldest first, at most 8 per run) it rebuilds the stars and moderation state **as of the cutoff** from the history tables, so a late job, later stars, unstars or moderation can't change the result. It writes the week's result and its build-queue entry in one transaction; the week and the winner are both unique, so duplicate or simultaneous runs can't select twice. A star removed after the close doesn't change the recorded result. The board shows the current count separately from the frozen winning count.

There is no 1,000-star rule in this release. A later policy change (such as a 1,000-star threshold) needs an owner decision, an announcement before it takes effect at a week boundary, and a decision on whether it uses lifetime stars or stars after the switch. Every result row records its `policy_version` (`weekly-v1`).

### Build queue

Statuses: `collecting → selected → building → built`, plus `held` and `declined` with a public note.

Selection only creates a queue entry with the frozen idea, its source snapshot, the week, its weekly and lifetime stars at the close, the policy version and the date. It doesn't run code, spend an agent budget, create a repository, deploy anything or post announcements. The promised deliverable is a small working open-source prototype with source code and run instructions, and a hosted demo where practical. It isn't an immediate delivery; the Building view shows the queue order so a backlog is visible.

## Owner operations

```sh
export BOARD_ADMIN_URL=https://repo-safari-ideas.<account>.workers.dev
export BOARD_ADMIN_TOKEN=...            # the Worker's ADMIN_TOKEN secret; never in the page or the repo

npm run board-admin -- building --idea <id> --note "Started the prototype."
npm run board-admin -- built --idea <id> --source https://github.com/w20labs/<repo> --demo https://<demo>
npm run board-admin -- hold --idea <id> --reason "licence check (private)" --note "On hold while we check a dependency licence."
npm run board-admin -- release --idea <id> --reason "licence fine"
npm run board-admin -- decline --idea <id> --reason "unsafe (private)" --note "Declined: it would collect personal data."
npm run board-admin -- hide --idea <id> --reason "spam"          # gone from every view and its link
npm run board-admin -- exclude-stars --github-id <n> [--idea <id>] --reason "vote ring"
npm run board-admin -- delete-account --github-id <n> --reason "user request #12"
npm run board-admin -- report                                     # weekly voters, stars, submissions, winning scores, backlog
npm run board-admin -- close                                      # close ended weeks now (the cron does this hourly)
```

- **Source links** must be `https://github.com/…`; demo links any `https://` URL without credentials. Built requires a source link.
- **Reasons** are private (audit log). **Notes** are public and should explain a hold or decline in plain language.
- **Excluding stars** after a week closed doesn't rewrite that week. If abuse changes a winner's legitimacy, put its build on hold with a public note; the board doesn't pick a second winner automatically.
- **Traction:** use `report` to decide when to change the policy. Nothing changes the policy automatically.

## Privacy and retention

| Record | Kept | Public? |
|---|---|---|
| Generated drafts and receipt hashes | 24 hours, then deleted by the cron | No |
| OAuth states / login codes | 10 / 2 minutes, single use | No |
| Sessions (token hash) | 30 days, deleted on sign-out | No |
| Account: GitHub numeric id and handle | Until deletion | The handle, on ideas it published |
| Stars and their history | Kept: they decide the weekly results | Counts only, never who starred |
| Published ideas | Kept | Yes |
| Contest results and build queue | Kept | Yes |

The GitHub access token is never stored. Analytics (GoatCounter) never receive identities, tokens, receipts or idea text.

**Account deletion** (`delete-account`): signs the account out everywhere, withdraws its active stars (lifetime and current-week counts drop; closed weeks keep their frozen results), and replaces its handle with `deleted-account` on its account and on ideas it published. The numeric id stays, without a handle, so the one-star-per-account rule and closed results hold. To remove a published idea itself, hide it.

**Backup and recovery:** D1 keeps point-in-time history (Time Travel, 30 days on paid plans, 7 on free): `npx wrangler d1 time-travel restore repo-safari-board --timestamp <ISO time>`. Export first for an offline copy: `npx wrangler d1 export repo-safari-board --remote --output board-backup.sql`. After a restore, run `close` again: weeks that ended in the meantime are closed from the restored history.

The page's privacy notes: the machine's fine print explains the 24-hour storage and what publishing makes public; the board's "How the weekly pick works" covers account data, stars and deletion.

## Settings

| Setting | Where | Default | Purpose |
|---|---|---|---|
| `BOARD_ENABLED` | site build env **and** Worker `[vars]` | off / `"0"` | The one switch. Both must be on |
| `BOARD_DB` | Worker D1 binding | none | Board storage. Without it the board stays off |
| `GITHUB_CLIENT_ID` | Worker var | none | The OAuth app |
| `GITHUB_CLIENT_SECRET` | Worker secret | none | The OAuth app |
| `ADMIN_TOKEN` | Worker secret | none | Owner operations; 32+ random characters |
| `ALLOWED_ORIGINS` | Worker var | `https://w20labs.github.io` | CORS, write `Origin` check, sign-in return addresses |
| `BOARD_DEV`, `GITHUB_OAUTH_URL`, `GITHUB_API_URL` | local preview only | unset | Test clock and stand-in GitHub. Ignored unless the address is `127.0.0.1`/`localhost` |

With the board off: no board UI, no board files published, every `/board/*`, `/auth/*` and `/dev/*` path is a 404, `/ideas` returns ideas without drafts, and the scheduled handler does nothing. Records are kept across a disable and re-enable.

**Interrupted contests:** while the board is off nobody can star, and no weeks close. When it's switched back on, the cron closes the missed weeks in order from their history: a week interrupted mid-way is decided by the stars it got before the switch-off; empty weeks are recorded with no winner. The launch time isn't reset, so week boundaries stay Monday 00:00 UTC.

## Local preview (no network, no paid calls)

```sh
npm ci && (cd worker && npm ci)
npm run board-preview          # = worker/dev/preview.sh; then open http://127.0.0.1:8765/board/
```

It starts the fake GitHub and Anthropic on :8790, the Worker on :8788 with a local D1 database (`worker/dev/.state`, recreated each run), loads fixtures, closes the past weeks with the real closing code, and builds the page with `BOARD_ENABLED=1 DB_PATH=/nonexistent` (committed data isn't rewritten). The preview config (`worker/dev/wrangler.preview.toml`) lives in its own folder so the real `worker/.dev.vars` is never loaded.

The fixtures (test clock Wednesday 21 Oct 2026, 15:00 UTC):

| Week | Result | Shows |
|---|---|---|
| 23–28 Sep (partial launch week) | Commit Weather, 6 | Built, with demo and source links |
| 28 Sep–5 Oct | Error Karaoke, 9 | Building, #1 in the queue |
| 5–12 Oct | no stars | No winner |
| 12–19 Oct | Pancake Launcher, 5 (one unstar and restore inside the week) | Selected, #2 in the queue |
| 19–26 Oct (now) | Standup Haiku 4 and Rubber Duck Radio 4 (tie: Haiku got there first), Dependency Bonsai 2 this week / 14 lifetime, Kite Physics Lab 1, new ideas with 0 | Top this week, New |

A hidden spam idea and a held idea are included and don't appear (or appear only as held). Sign in on the fake GitHub page as alice, bob, carol, dana or eve.

Test clock (local only): `curl -X POST http://127.0.0.1:8788/dev/clock -d '{"at": 1793577600000}'`, then `curl -X POST http://127.0.0.1:8788/dev/close`. `{"at": null}` returns to the real clock.

## Tests

| Command | What | Where it runs |
|---|---|---|
| `npm test` | Contest rules, storage on the real schema (SQLite stand-in for D1), the Worker end to end with mocked GitHub/Anthropic, plus the existing limiter tests | CI |
| `npm run test:board-integration` | The real local runtime (workerd + D1): the full journey, concurrent stars and closes, Sunday/Monday boundary, delayed and catch-up closing, renamed accounts, board off | Local (needs the fake services on :8790) |
| `npm run test:board-browser` | Chromium and mobile WebKit: sign-in round trips, publish, stars, views, keyboard, reduced motion, failures, four screen sizes, board off | Local |

## Analytics

Counted once per page load (GoatCounter events, like the Idea Shower's), with no identities, tokens, receipts or idea text. They aren't the vote count; D1 is.

| Event | Means |
|---|---|
| `board/open` | Opened the board |
| `board/view-top`, `-new`, `-building`, `-built` | Looked at that view |
| `board/idea-open` | Opened a permanent idea link (every time) |
| `board/signin-start`, `board/signin-done` | Started and finished a sign-in |
| `board/publish` | Published an idea |
| `board/star` | Starred at least one idea |
| `board/share` | Shared an idea link |

Useful ratios: publication rate `board/publish ÷ ideas/generated`; sign-in completion `board/signin-done ÷ board/signin-start`; starring visits `board/star ÷ board/open`; link pull `board/idea-open ÷ board/share`. Weekly selections, voters and stars come from `npm run board-admin -- report` (D1), not analytics.

## Activation

Done on 17 Oct 2026: the board is live, with the `repo-safari-board` database and the w20labs OAuth app. The launch (09:06 UTC) was less than 3 days before Monday 19 Oct, so the first contest week runs on to Monday 26 Oct, 00:00 UTC. The steps, for re-creating it (for example on another Cloudflare account):

1. **D1:** `cd worker && npx wrangler d1 create repo-safari-board`; put the new id in the `[[d1_databases]]` block of `worker/wrangler.toml`; `npx wrangler d1 migrations apply repo-safari-board --remote`.
2. **GitHub OAuth app** (w20labs organization → Settings → Developer settings → OAuth Apps): homepage `https://w20labs.github.io/repo-safari/`, callback `https://repo-safari-ideas.<account>.workers.dev/auth/github/callback`. Put the client id in `GITHUB_CLIENT_ID`; `npx wrangler secret put GITHUB_CLIENT_SECRET`; `npx wrangler secret put ADMIN_TOKEN` (e.g. `openssl rand -base64 36`).
3. **Worker:** set `BOARD_ENABLED = "1"` and `npx wrangler deploy`. The first board request records the launch time; the first week ends at the next Monday 00:00 UTC, or the one after if that's less than 3 days away.
4. **Site:** add the Actions variable `BOARD_ENABLED` = `1` (passed to the build next to `IDEAS_URL`) and run the Deploy workflow.
5. Check: open `#ideas`, sign in, publish a test idea, star it from a second account, then hide it with `board-admin`.

The weekly-build wording is approved (`POLICY_APPROVED = true` in `prototypes/board/board.js`).

**Rollback:** set the Actions variable `BOARD_ENABLED` to `0` and redeploy the site (the board disappears); set the Worker's `BOARD_ENABLED = "0"` and deploy (its routes and cron stop). Data stays in D1 for a later re-enable. To remove everything: `npx wrangler d1 delete repo-safari-board`.

Costs: D1 and Workers usage is small at this scale, but this isn't a guarantee of a zero bill; check the Cloudflare dashboard after launch.

## Verified locally vs. still to check when hosted

Verified locally (fake GitHub and Anthropic, local workerd + D1, test clock): everything in [Tests](#tests).

Not verifiable until activation:

- Real GitHub OAuth: the consent screen, that no scopes are requested in practice, callback URL registration, and GitHub's own error paths.
- Sign-in on real phones (iOS Safari, Android Chrome), including switching to the GitHub app and back. Locally, mobile WebKit and Chromium passed with no cookies at all.
- D1 in production: latency, `batch` transactions and `RETURNING` under real load, Time Travel restore.
- The Cloudflare cron actually firing hourly, and Worker logs (callback URLs contain GitHub's single-use code and state; Cloudflare observability may record them).
- GoatCounter receiving the board events on the published site.
- Edge caching: the Worker sends `Cache-Control: public, max-age=15` on public reads (a hidden idea can stay visible in a browser for up to 15 s); the page itself always asks fresh.
