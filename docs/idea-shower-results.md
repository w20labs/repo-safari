# Idea Shower: running, launching and reading the results

The Idea Shower is a small experiment inside Repo Safari. A card at the top of the page always offers 3 repos (the visitor's stickers when they have 3, otherwise random repos from this week's trail). **Mix these 3** opens the pipe machine and starts it in one click; **🎲 Shuffle** swaps the 3, and **✏️ or build your own** searches this week's repos. Stickers can also be picked with "+ mix" in the album or from the one-time nudge at the 3rd sticker. The pipe machine sends them to one Cloudflare Worker, and the Worker asks Claude for 3 ideas: useful, unexpected and ridiculous. Each idea can be copied, or copied as a build prompt for a coding agent, and a whole mix can be shared as a link.

It answers two questions:

1. **Fun:** do people enjoy mixing repos into ideas?
2. **Spread:** do people share mixes, and do the shared links get opened?

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Page | `prototypes/repo-safari.template.html` | Built by `scripts/build-safari-page.ts`. `IDEAS_URL` decides the mode: unset = no Idea Shower at all, `mock` = canned ideas, a URL = the Worker |
| Repo list | `_site/repos.json` | Written by the build: every repo in the rooms and the Rising room. The Worker only accepts these |
| Worker | `worker/src/ideas.ts` (entry `worker/src/index.ts`) | `POST /ideas` with `{repos: [3 names]}`. One `claude-sonnet-5-5` call, at most 1,200 output tokens, JSON-schema output, validated before it's returned |
| Limits | Durable Object `Limiter` (`worker/src/limiter.ts`) | 5 generations per visitor per day (salted hash of the IP, never the IP), 300 per day in total. One object handles every check-and-count in turn, so the caps are exact even when requests arrive together |
| Analytics | GoatCounter, https://repo-safari.goatcounter.com | 11 events, each counted at most once per page load |

## Run it locally

Canned ideas, no server, no cost:

```sh
IDEAS_URL=mock npm run build-safari -- https://w20labs.github.io/repo-safari/ --site _site
python3 -m http.server 8765 --directory _site   # then open http://127.0.0.1:8765/
```

Add `?mock=limit` or `?mock=error` to the address to see the limit and error states.

With the real Worker (it calls Anthropic for real, so it costs a little per generation):

```sh
cd worker && npm ci
cat > .dev.vars <<'EOF'            # git-ignored
ANTHROPIC_API_KEY=sk-ant-...
IP_SALT=any-long-random-string
REPOS_URL=http://127.0.0.1:8765/repos.json
ALLOWED_ORIGINS=http://127.0.0.1:8765
EOF
npx wrangler dev --port 8787
# in the repo root, in another terminal:
IDEAS_URL=http://127.0.0.1:8787 npm run build-safari -- https://w20labs.github.io/repo-safari/ --site _site
```

To try the Worker without an API key, add `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` to `.dev.vars` and point it at any stand-in that answers `POST /v1/messages` like the Messages API.

## Test the shared view

1. Generate ideas, press **Share this mix**, and open the copied link in a private window. You should see "Shared mix" with the 3 repos and 3 ideas, the line "Shared mix. Generate your own to get fresh ideas.", **no** copy buttons, and one button, **Mix these yourself**. Opening it makes no API call.
2. **Mix these yourself** loads the 3 repos as ingredients. Generating from there uses the normal limits.
3. A crafted, invalid link (here `v: 2`) must be ignored: the normal page loads and nothing opens.

   ```
   /#mix=eyJ2IjoyLCJyZXBvcyI6WyJuOG4taW8vbjhuIiwiYS9iIiwiYy9kIl0sImlkZWFzIjpbeyJraW5kIjoidXNlZnVsIiwibmFtZSI6IlRlc3QgdXNlZnVsIiwicGl0Y2giOiJBIHRlc3QgcGl0Y2guIiwiaW5zcGlyYXRpb24iOiJUZXN0IGluc3BpcmF0aW9uLiJ9LHsia2luZCI6InVuZXhwZWN0ZWQiLCJuYW1lIjoiVGVzdCB1bmV4cGVjdGVkIiwicGl0Y2giOiJBIHRlc3QgcGl0Y2guIiwiaW5zcGlyYXRpb24iOiJUZXN0IGluc3BpcmF0aW9uLiJ9LHsia2luZCI6InJpZGljdWxvdXMiLCJuYW1lIjoiVGVzdCByaWRpY3Vsb3VzIiwicGl0Y2giOiJBIHRlc3QgcGl0Y2guIiwiaW5zcGlyYXRpb24iOiJUZXN0IGluc3BpcmF0aW9uLiJ9XX0
   ```

4. A well-formed link whose repos have left this week's rooms shows the toast "This shared mix has expired." and nothing else:

   ```
   /#mix=eyJ2IjoxLCJyZXBvcyI6WyJuOG4taW8vbjhuIiwic29tZW9uZS9sZWZ0LXRoZS10cmFpbCIsImFub3RoZXIvZ29uZS1yZXBvIl0sImlkZWFzIjpbeyJraW5kIjoidXNlZnVsIiwibmFtZSI6IlRlc3QgdXNlZnVsIiwicGl0Y2giOiJBIHRlc3QgcGl0Y2guIiwiaW5zcGlyYXRpb24iOiJUZXN0IGluc3BpcmF0aW9uLiJ9LHsia2luZCI6InVuZXhwZWN0ZWQiLCJuYW1lIjoiVGVzdCB1bmV4cGVjdGVkIiwicGl0Y2giOiJBIHRlc3QgcGl0Y2guIiwiaW5zcGlyYXRpb24iOiJUZXN0IGluc3BpcmF0aW9uLiJ9LHsia2luZCI6InJpZGljdWxvdXMiLCJuYW1lIjoiVGVzdCByaWRpY3Vsb3VzIiwicGl0Y2giOiJBIHRlc3QgcGl0Y2guIiwiaW5zcGlyYXRpb24iOiJUZXN0IGluc3BpcmF0aW9uLiJ9XX0
   ```

Shared links are untrusted: the page checks `v === 1`, exactly 3 distinct repos that are all in this week's data, exactly one idea of each kind, every string at most 400 characters, and renders all of it as plain text. Links longer than 6,000 characters drop the concept field.

## Launch

1. Merge the PR. With `IDEAS_URL` unset, the deployed page has no Idea Shower, so merging alone changes nothing for players.
2. Deploy the Worker (needs a Cloudflare account and an Anthropic API key):

   ```sh
   cd worker && npm ci
   npx wrangler login
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put IP_SALT             # any long random string
   npx wrangler deploy                         # prints https://repo-safari-ideas.<account>.workers.dev
   ```

3. Check it: `curl -X POST https://repo-safari-ideas.<account>.workers.dev/ideas -H 'Origin: https://w20labs.github.io' -H 'Content-Type: application/json' -d '{"repos":["n8n-io/n8n","a/b","c/d"]}'` should answer `{"error":"unknown_repo"}`.
4. In GitHub: **Settings → Secrets and variables → Actions → Variables**, add `IDEAS_URL` = the Worker URL (no trailing slash).
5. Run the **Deploy** workflow (or wait for the next push or Monday refresh). The Idea Shower appears in the album box.

To switch it off, delete the `IDEAS_URL` variable and redeploy. To stop the spending at once, `npx wrangler delete` in `worker/`.

## Reading the results

Open https://repo-safari.goatcounter.com and set the date range to the launch period. Event counts are in the list of paths:

| Event | Means | Counted |
|---|---|---|
| `card/shown` | The Idea Shower card was on the page | Once per page load |
| `card/shuffle` | Pressed 🎲 Shuffle on the card | Once per page load |
| `card/own` | Opened ✏️ or build your own | Once per page load |
| `machine/open` | Started a mix: a first pick ("+ mix" or build your own), Mix these 3, the nudge, or Mix these yourself | Once per page load |
| `machine/three` | Reached 3 ingredients | Once per page load |
| `ideas/try` | Asked the Worker for ideas (a real request was sent) | Once per page load |
| `ideas/generated` | Got a first set of ideas | Once per page load |
| `ideas/again` | Generated a second time | Once per page load |
| `idea/copy` | Copied an idea | Once per page load |
| `prompt/copy` | Copied a build prompt | Once per page load |
| `share/copy` | Copied a share link | Once per page load |
| `share/open` | Opened a valid shared link | Every time |
| `entry/top` | Pressed Mix these 3 (or See the ideas) on the card | Once per page load |
| `entry/surprise` | Pressed 🎲 Shuffle inside the machine | Once per page load |
| `entry/nudge` | Pressed Mix them on the one-time toast at the 3rd sticker | Once per page load |

Events that happen before GoatCounter's script has loaded wait in the page and are sent once it loads, so early ones like `card/shown` aren't lost. GoatCounter can't follow a person, so these are ratios of events, not of people. A page load is the closest thing to a visit.

| Question | Formula | Yes if |
|---|---|---|
| Enough data? | `card/shown` | at least 1,000; below that the result is "not enough data" |
| Fun, part 1 (adoption) | `ideas/generated` ÷ `card/shown` | ≥ 10% (proposed: the card is shown to every visitor, so this is a share of all visits) |
| Fun, part 2 | (`ideas/again` + `idea/copy` + `prompt/copy` + `share/copy`) ÷ `ideas/generated` | ≥ 20% |
| Spread | `share/open` ÷ `share/copy` | ≥ 25% (approximate: it includes sharers opening their own links) |
| Build interest (for information) | `prompt/copy` ÷ `ideas/generated` | no pass or fail: clicks show curiosity, not demand |

Fun is a yes only if both parts pass.

Two health checks, not pass or fail:

- **Reliability:** `ideas/generated` ÷ `ideas/try`: of the visits that asked for ideas, how many got them. Well under 90% means errors or the daily cap; check the Worker logs.
- **Picking:** `machine/three` ÷ `machine/open`: of the visits that started choosing repos, how many got to 3. Low means choosing is the hard part, not the ideas.
- **Which way in:** compare `entry/top`, `entry/nudge` and `machine/open` (the rest started by hand with "+ mix" or build your own). `card/shuffle` and `card/own` show whether people want to choose their repos rather than take the offered 3.

Costs to watch in the Anthropic console: at most 300 generations a day, one Sonnet call each.
