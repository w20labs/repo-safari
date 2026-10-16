# Idea Shower: running, launching and reading the results

The Idea Shower is a small experiment inside Repo Safari. A player picks 3 stickers from their album (with "+ mix"), the pipe machine sends them to one Cloudflare Worker, and the Worker asks Claude for 3 ideas: useful, unexpected and ridiculous. Each idea can be copied, or copied as a build prompt for a coding agent, and a whole mix can be shared as a link.

It answers two questions:

1. **Fun:** do people enjoy mixing repos into ideas?
2. **Spread:** do people share mixes, and do the shared links get opened?

## How it fits together

| Piece | Where | Notes |
|---|---|---|
| Page | `prototypes/repo-safari.template.html` | Built by `scripts/build-safari-page.ts`. `IDEAS_URL` decides the mode: unset = no Idea Shower at all, `mock` = canned ideas, a URL = the Worker |
| Repo list | `_site/repos.json` | Written by the build: every repo in the rooms and the Rising room. The Worker only accepts these |
| Worker | `worker/src/ideas.ts` (entry `worker/src/index.ts`) | `POST /ideas` with `{repos: [3 names]}`. One `claude-sonnet-5-5` call, at most 1,200 output tokens, JSON-schema output, validated before it's returned |
| Limits | Worker KV `LIMITS` | 5 generations per visitor per day (salted hash of the IP, never the IP), 300 per day in total. KV is eventually consistent, so both are approximate |
| Analytics | GoatCounter, https://repo-safari.goatcounter.com | 8 events, each counted at most once per page load |

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
   npx wrangler kv namespace create LIMITS     # paste the id into wrangler.toml
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
| `machine/open` | Picked a first ingredient (or pressed Mix these yourself) | Once per page load |
| `machine/three` | Reached 3 ingredients | Once per page load |
| `ideas/generated` | Got a first set of ideas | Once per page load |
| `ideas/again` | Generated a second time | Once per page load |
| `idea/copy` | Copied an idea | Once per page load |
| `prompt/copy` | Copied a build prompt | Once per page load |
| `share/copy` | Copied a share link | Once per page load |
| `share/open` | Opened a valid shared link | Every time |

GoatCounter can't follow a person, so these are ratios of events, not of people. A page load is the closest thing to a visit.

| Question | Formula | Yes if |
|---|---|---|
| Enough data? | `machine/open` | at least 300; below that the result is "not enough data" |
| Fun, part 1 | `ideas/generated` ÷ `machine/open` | ≥ 40% |
| Fun, part 2 | (`ideas/again` + `idea/copy` + `prompt/copy` + `share/copy`) ÷ `ideas/generated` | ≥ 20% |
| Spread | `share/open` ÷ `share/copy` | ≥ 25% (approximate: it includes sharers opening their own links) |
| Build interest (for information) | `prompt/copy` ÷ `ideas/generated` | no pass or fail: clicks show curiosity, not demand |

Fun is a yes only if both parts pass. Also note the funnel step `machine/three` ÷ `machine/open`: if it's low, people start a mix but don't finish choosing, which points at the album selection rather than the ideas.

Costs to watch in the Anthropic console: at most 300 generations a day, one Sonnet call each.
