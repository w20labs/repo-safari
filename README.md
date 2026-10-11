<p align="center">
  <a href="https://w20labs.github.io/repo-safari/"><img src="assets/readme/hero.png" alt="Repo Safari: a new trail through open source every day" width="100%"></a>
</p>

<p align="center">
  <a href="https://w20labs.github.io/repo-safari/"><img src="https://img.shields.io/badge/%E2%96%B6%20Play%20now-w20labs.github.io%2Frepo--safari-D4F25C?style=for-the-badge&labelColor=0A0C14" alt="Play now"></a>
</p>

<p align="center">
  <a href="https://github.com/w20labs/repo-safari/actions/workflows/pages.yml"><img src="https://github.com/w20labs/repo-safari/actions/workflows/pages.yml/badge.svg" alt="Deploy"></a>
  <a href="https://github.com/w20labs/repo-safari/actions/workflows/ci.yml"><img src="https://github.com/w20labs/repo-safari/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EC4A6" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-24-9AA3B8" alt="Node 24">
</p>

**Repo Safari is a tiny daily game for finding open-source projects worth knowing about.**
Every day there's a new trail of about a dozen categories (OCR, vector databases, game engines, note-taking apps…).
Walk the trail, drop into a category, and its leading active repos are waiting on the wall as stickers, ranked by stars.
Keep the ones you like. No sign-up, no quiz, nothing to lose. A walk takes about three minutes.

<p align="center">
  <img src="assets/readme/demo.gif" alt="Walking the trail, dropping into the Multi agent room, browsing the sticker wall and saving a sticker" width="720">
</p>

## How to play

| | Keyboard | Phone |
|---|---|---|
| Walk | <kbd>←</kbd> <kbd>→</kbd> | ◀ ▶ |
| Jump, then again in the air for a double jump | <kbd>Space</kbd> | ▲ |
| Drop into a category's room | <kbd>↓</kbd> | ▼ |
| Save a sticker to your album | <kbd>E</kbd> | ★ |
| Open the repo on GitHub | <kbd>Enter</kbd> | ▼ in a room |
| Climb back out | <kbd>Esc</kbd> | ▲ in a room |

1. **Walk the trail.** Each platform is a category. Stand on one to see its best-known repo.
2. **Drop in.** The room shows up to eight selected active repos from that category as stickers, most stars first, with forks, open issues, language and last commit.
3. **Collect.** Save the ones you want to remember. They go into your sticker album.
4. **Reach the end.** This week's rising repos sit on a high platform at the end of the trail. Getting there takes a double jump, and their stickers are rare.

<table>
  <tr>
    <td width="58%"><img src="assets/readme/room.png" alt="Inside a room: repos as sticker cards ranked by stars, with details for the selected one"></td>
    <td width="42%"><img src="assets/readme/album.png" alt="The sticker album, with two rare stickers from this week's rising repos"></td>
  </tr>
  <tr>
    <td align="center"><sub>Inside a room: compare a category's leading active repos</sub></td>
    <td align="center"><sub>Your album: rare stickers are available to collect on this week's trail</sub></td>
  </tr>
</table>

## Built by rules, not by hand

Nobody picks the categories. A pipeline builds them from GitHub's own topics every week, and a set of rules decides what makes the cut.

```mermaid
flowchart LR
    A["GitHub API<br/>top 1,000 repos<br/>+ a search per topic"] --> B["One room per<br/>specific topic"]
    B --> C["Merge topics that<br/>share most repos"]
    C --> D{"Rules"}
    D --> E["rooms.json<br/>~80 rooms"]
    F["Rising this week<br/>newest repos with the most stars"] --> G
    E --> G["Today's trail<br/>12 rooms, same for everyone,<br/>picked by the date"]
    G --> H["One static page<br/>on GitHub Pages"]
```

| Rule | Why |
|---|---|
| A commit in the last 6 months, not archived | The trail is about what's alive now |
| The repo is about the topic (name or opening words), or carries two of its topics | Keeps out repos that just mention a word |
| At most two repos from the same owner | A room compares alternatives, not one team's projects |
| No room named after one of its own repos | "Vite" would just be Vite's family |
| Rooms that overlap are merged, near-identical names are folded together | No two rooms with the same content |
| A safety filter for exploits, malware, piracy, people-tracking, leaked prompts, paid-AI bypasses and adult content | It's a game people share |

The rules live in [`scripts/build-rooms.ts`](scripts/build-rooms.ts) and [`server/rising-filter.ts`](server/rising-filter.ts). Grouping by topics isn't perfect; if a room looks wrong, [tell us](https://github.com/w20labs/repo-safari/issues/new?template=room.yml).

## Your data

There's no server and no account. Your sticker album is saved in your own browser (`localStorage`) and never leaves it. Clearing your browser data clears your album. The page doesn't use cookies or analytics.

## Run it locally

You need **Node.js 24** (`nvm use` reads `.nvmrc`).

```sh
npm install
GITHUB_TOKEN=$(gh auth token) npm run build-safari -- https://w20labs.github.io/repo-safari/ --site _site
open _site/index.html
```

| Command | What it does |
|---|---|
| `npm run build-rooms` | Rebuild the rooms from the GitHub API (`-- --cached` reuses the last fetch) |
| `npm run refresh-rising` | Refresh this week's rising repos |
| `npm run build-safari -- <url> --site _site` | Build the page into `_site/` |
| `npm run typecheck` / `npm test` / `npm run test:e2e` | Type-check, unit tests, browser tests |

Every push to `main` deploys through [`.github/workflows/pages.yml`](.github/workflows/pages.yml), and on Mondays it refreshes the rooms and rising repos first.

## Contributing

Ideas, bug reports and "this room is weird" reports are very welcome: [open an issue](https://github.com/w20labs/repo-safari/issues/new/choose).

Pull requests are limited to the project's collaborators, and every change to `main` needs passing checks and a maintainer's review. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get involved, and [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE). The bundled fonts are under the SIL Open Font License; see [assets/fonts](assets/fonts/README.md).
Repo names, descriptions and numbers come from the GitHub API. Repo Safari is an independent project and isn't affiliated with GitHub.

<sub>This repository started as <a href="docs/last-commit-standing.md">Last Commit Standing</a>, a quiz platformer. Its code is still here.</sub>
