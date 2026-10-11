# Contributing to Repo Safari

Thanks for your interest. Please read this before you start, because **this project does not accept
pull requests from outside its contributors list.**

## Who can open pull requests

Only people listed as collaborators on this repository can open pull requests. GitHub enforces this:
if you aren't on the list, the "New pull request" button won't work for you, and that's intentional.
We review every change by hand and don't merge unsolicited code.

If you'd like to become a contributor, open an issue that says what you'd like to work on and why.
A maintainer will reply. Being added is a decision the maintainers make case by case.

## How everyone else can help

You don't need to write code to make a difference:

- **Report a bug**: open an issue with the "Bug report" template. Say what you did, what you
  expected and what happened, and include your browser and device.
- **Flag a room**: rooms are grouped automatically from GitHub topics, so some are odd.
  Use the "Room feedback" template to point out a room that doesn't make sense, a repo in the
  wrong room, or a repo that shouldn't be featured at all.
- **Suggest an idea**: open an issue and describe the problem you'd like solved, not just the
  solution.
- **Report a security problem privately**: see [SECURITY.md](SECURITY.md). Don't open a public
  issue for it.

## For contributors

### Setup

You need **Node.js 24** (see `.nvmrc`; `nvm use` picks it up).

```sh
npm install
npm run dev            # the original game: client on :5173, server on :8787
npm run typecheck
npm test               # unit tests
npm run test:e2e       # browser tests (run `npx playwright install chromium` once)
```

Repo Safari is one generated page. To rebuild it locally:

```sh
GITHUB_TOKEN=$(gh auth token) npm run build-rooms -- --cached   # rooms from the last fetch
GITHUB_TOKEN=$(gh auth token) npm run build-safari -- https://w20labs.github.io/repo-safari/ --site _site
open _site/index.html
```

### Rules for changes

1. **Open or pick an issue first** for anything bigger than a typo, so we agree on the approach
   before you write code.
2. **Branch from `main`** and keep each pull request to one change. Small pull requests get reviewed
   faster.
3. **Everything must pass**: `npm run typecheck`, `npm test` and the browser tests. CI runs them on
   every pull request, and `main` only accepts pull requests that pass.
4. **Add or update tests** for any change in behaviour, and say in the pull request how you
   tested it.
5. **Every pull request needs an approving review** from a code owner before it can be merged.
   We merge with squash.
6. **Don't hand-edit generated data.** `shared/data/rooms.json` and `shared/data/rising.json` come
   from the GitHub API. Change the rules in `scripts/` instead, and say what the change did to the
   rooms.
7. **Never commit secrets**: tokens, `.env` files or local databases. Secret scanning blocks
   pushes that contain known token formats, but it doesn't catch everything.
8. **Rooms must stay fair to the projects in them.** Only use facts the GitHub API returns, and keep
   the safety rules in `server/rising-filter.ts` intact unless the change is discussed first.
9. **Write commit messages** that say what changed and why, in the present tense.

### Licensing of contributions

By contributing, you agree that your contribution is licensed under this repository's
[MIT License](LICENSE).

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
