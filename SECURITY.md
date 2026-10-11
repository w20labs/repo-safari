# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

Report it privately through GitHub: go to the repository's **Security** tab and choose
**Report a vulnerability**. Describe the problem, how to reproduce it, and what an attacker could
do with it. We aim to reply within a week.

## Scope

- **Repo Safari** (`prototypes/repo-safari.template.html`, `scripts/`): a static page on GitHub Pages.
  It stores nothing on a server; the sticker album lives in the player's browser. Of most interest:
  ways for data from the GitHub API to inject script into the page, or for the room pipeline to
  feature harmful repositories.
- **Last Commit Standing server** (`server/`): the original game's API and multiplayer server.
  It isn't deployed by this repository, but reports about it are welcome.

## Supported versions

Only the latest version on `main` is supported.
