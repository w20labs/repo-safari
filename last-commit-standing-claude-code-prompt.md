# Build "Last Commit Standing" — a GitHub-repo elimination platformer

You are building a browser game from scratch in this repo. Read this whole brief, then **propose a short plan (stack, folder layout, milestones) and wait for my OK before writing code.** Ask me only about things this brief leaves open (mainly hosting). Everything else is decided below.

## 1. The game in one paragraph

A 2D side-scrolling platformer for developers. Every floating platform is a famous or newly-rising GitHub repo. You run and jump across them; the moment you land on an uncleared platform the world freezes and you get one multiple-choice question about that repo (which repo is it, what it does, what language it's written in, or trivia). Answer right and the platform turns green and shows the repo's name. Answer wrong, run out of time, or fall into the pit and you're eliminated. The theme is a "456 players, one wrong answer and you're out" elimination show — player numbers, a tracksuited character, pink/teal palette — but use **original** art and naming only; no copyrighted characters, logos, or music from any show.

## 2. Stack (default — tell me if you'd change it and why)

- **Client:** Vite + TypeScript, a single `<canvas>` for the world, HTML/CSS overlays for menus, questions, and results. No game engine; hand-rolled physics is fine and keeps the bundle small.
- **Server:** Node + TypeScript with `ws` (WebSockets) for the multiplayer Arena and a tiny HTTP API for the leaderboard and repo pool. SQLite (better-sqlite3) for storage.
- **Repo-pool refresh:** a script (`npm run refresh-rising`) that calls the GitHub REST search API and writes the pool to the DB. Run it weekly via cron, or a GitHub Action, depending on hosting.
- **Tests:** Vitest for the pure logic (RNG, course generation, question generation, scoring, arena round timing).
- Everything must work locally with `npm install && npm run dev` (client + server together).

## 3. Visual direction

- Single dark theme. Background `#0A0C14`, panels `#121626`, sunken `#0B0E19`, lines `#262C42`, text `#ECEFF7`, muted `#9AA3B8`.
- Accents: teal `#2EC4A6` (player, success), pink `#FF3E8A` (danger, elimination, primary buttons), amber `#F2B544` (score, gold platforms), lime `#D4F25C` (rising repos, high multipliers), green `#7BE08F` (correct answer).
- Region colors for platform top strips: AI & ML `#5CC8E8`, Web `#F2B544`, Dev tools `#9BE07A`, Infra `#B79CFF`, Languages & runtimes `#FF8A65`, Rising `#D4F25C`.
- Fonts (Google Fonts): **Bungee** for the title and big stamps, **Bricolage Grotesque** for UI text, **JetBrains Mono** for numbers, labels, and code-like bits.
- No emoji in the UI. Icons are inline stroke SVG.
- Background: a faint parallax "commit graph" (vertical lines and dots) at 0.35× camera speed.
- The pit is dark crimson with a glowing, animated pink wavy line and repeated `<<<<<<< merge conflict` text.
- Respect `prefers-reduced-motion`: no bobbing, fewer particles, instant camera.

## 4. Controls

- Move: ← → or A D. Jump: ↑, W or Space. Double jump allowed (second jump at 0.9× strength). Releasing jump early while rising fast cuts the jump (multiply vy by 0.55 when vy < −420).
- ↓ or S drops through the platform you're standing on (ignore platform collisions for 0.25 s).
- Answer with keys 1–4 or by clicking.
- Touch: on coarse pointers or widths ≤ 700 px, show an on-screen pad (left, right, drop, jump) under the stage, 64 px buttons, using pointer capture.
- Ignore game keys while focus is in a text input.

## 5. Physics and world (use these numbers)

- Logical view height 720 world units, scaled to the stage height; camera follows the player (target x = player.x − 40% of view width, y = player.y − 58% of view height), clamped to world bounds, lerp factor `min(1, dt*6)`.
- World height 1400, floor line y = 1320. Gravity 2400, jump velocity 1000, max run speed 330, ground acceleration 2800, air acceleration 1900, coyote time 0.1 s, jump buffer 0.14 s. Clamp dt to 1/30.
- Player body 26×40.
- **One-way platforms:** land only when falling and the previous bottom was at or above the platform top (+6 tolerance for moving platforms). Carry entities with a moving platform's per-frame delta.
- **Ground exists only on two pads:** a start pad x ∈ [0, 340] and an end pad from `W − 440` to `W`. Everything between is the pit. Falling more than 90 units below the floor = eliminated ("You fell into the merge conflict").
- **Course layout** for n repos: world width `W = 380 + n*220 + 520`. Platform i is centered at x = 380 + i*220, with base y = `round(1180 − (sin(i*0.62 − π/2) + 1)*230 − (i%3==2 ? 50 : 0))`. That keeps every step reachable (max rise is about 160; a single jump reaches 208, a double about 376). Write a unit test that asserts reachability for every generated course.
- Platform width by star band: 200k+ → 200, 100k+ → 168, 50k+ → 146, 20k+ → 132, rising → 140, gold → 100. Height 30.
- **Height multiplier:** `mult = round((1 + (1180 − baseY)/460) * 10)/10`, so ×1.0 to about ×2.0. Show it on the platform as `×1.4`.
- **Gold platforms** (solo modes, every i % 5 == 3): narrow, amber border, always moving, multiplier doubled, 8-second timer instead of 12.
- **Moving platforms** (solo modes, gold or i % 4 == 1): sine motion, horizontal amplitude 55 (even i) or vertical 42 (odd i), period 2.6–3.6 s, random phase from the course RNG. Freeze world time while a solo question is open.
- **Exit gate** on the end pad (92×130, at x = W − 300). It's locked until the unlock count is reached; walking into the locked gate blocks you and toasts "Gate locked. Clear N more platforms." When it's open, entering wins: +500 bonus.

## 6. Questions

Each repo record has: `id, region, short, name (owner/repo), lang, langQ (false when GitHub's language label is ambiguous), band, clues[2], what (one line), choices[4] (for identify), trivia {q, a, w[3]}`.

Question types, chosen at random (seeded in Daily mode):

- **identify** — show one clue, four repo names (from `choices`).
- **what** — "What does X do?", correct `what` + three other repos' `what` lines, single-column layout.
- **lang** — "Which language is most of owner/repo written in?" Only when `langQ !== false`. Distractors come from [Python, Go, Rust, TypeScript, JavaScript, C++, Zig, Shell, C, Java, Swift].
- **trivia** — weighted double.
- **Rising repos** use only: identify (description as the clue, distractors from other rising names), lang (if known), and **stars bucket** (Under 1k / 1k–5k / 5k–25k / 25k+ "as of <date>").

Timer: 12 s (8 s on gold, 10 s in Arena), shown as a shrinking bar that turns pink under 4 s.

**Score per correct answer:** `round((100 + ceil(secondsLeft)*10) * multiplier)`.

After answering, highlight the correct option green and a wrong pick pink, then continue after 850 ms.

### Seed data — the 24 classic repos (use exactly these facts)

Use these as the starting `src/data/classic.ts`. Don't invent new facts. If you add repos later, only use facts you can verify.

| id | region | short | name | lang (langQ) | band | clues | what | identify choices | trivia (answer first) |
|---|---|---|---|---|---|---|---|---|---|
| transformers | ai | Transformers | huggingface/transformers | Python | 100k+ | "The flagship library of a model hub with an emoji for a logo." / "pipeline("sentiment-analysis") and you are done." | Pretrained text, vision and audio models behind one Python API | PyTorch, Transformers, Keras, JAX | Which company maintains Transformers? — Hugging Face; Google, Meta, OpenAI |
| ollama | ai | Ollama | ollama/ollama | Go | 100k+ | "Run large language models on your laptop with one command." / "Brought Docker-style pull and run to local LLMs." | Downloads and runs open-weight LLMs locally behind a CLI and API | vLLM, LocalAI, Ollama, LM Studio | Which command downloads a model in Ollama? — ollama pull; ollama get, ollama fetch, ollama add |
| sdwebui | ai | SD WebUI | AUTOMATIC1111/stable-diffusion-webui | Python | 100k+ | "A browser UI for generating images from text prompts." / "txt2img, img2img and an endless Extensions tab." | A do-everything web interface for Stable Diffusion image generation | ComfyUI, InvokeAI, Fooocus, SD WebUI | Which Python UI library does SD WebUI build on? — Gradio; Streamlit, Dash, Panel |
| langchain | ai | LangChain | langchain-ai/langchain | Python (langQ false) | 100k+ | "A framework for chaining LLM calls, tools and memory." / "The 2023 agent hype ran straight through it." | Building blocks for LLM apps: prompts, retrieval, tools and agents | LangChain, LlamaIndex, Haystack, DSPy | What is LangChain's graph-based agent framework called? — LangGraph; LangTree, ChainFlow, AgentMesh |
| llamacpp | ai | llama.cpp | ggml-org/llama.cpp | C++ | 50k+ | "LLM inference in plain C and C++." / "Made Apple Silicon a serious inference machine." | Fast, dependency-light LLM inference on CPUs and consumer GPUs | MLX, TensorRT-LLM, llama.cpp, vLLM | Which model file format came out of the llama.cpp project? — GGUF; safetensors, ONNX, GPTQ |
| whisper | ai | Whisper | openai/whisper | Python | 50k+ | "Open-weight speech-to-text model released in 2022." / "Trained on 680,000 hours of audio." | Multilingual speech recognition and translation model | Vosk, Whisper, wav2vec 2.0, DeepSpeech | What kind of model architecture is Whisper? — Encoder-decoder Transformer; Recurrent neural network, GAN, Decision forest |
| react | web | React | facebook/react | JavaScript | 200k+ | "Open-sourced by a social network in 2013." / "Made "UI is a function of state" mainstream." | A library for building user interfaces out of components | Vue, Angular, React, Svelte | Which company open-sourced React? — Facebook (Meta); Google, Microsoft, Twitter |
| next | web | Next.js | vercel/next.js | JavaScript (langQ false) | 100k+ | "A full-stack framework built on top of a UI library." / "Its "app" directory sparked a thousand threads." | A React framework with routing, server rendering and server components | Remix, Next.js, Nuxt, Gatsby | Which company maintains Next.js? — Vercel; Netlify, Cloudflare, Shopify |
| tailwind | web | Tailwind CSS | tailwindlabs/tailwindcss | TypeScript (langQ false) | 50k+ | "Write your styles without leaving the HTML." / "Critics call it inline styles with extra steps." | A utility-first CSS framework for styling directly in markup | Bootstrap, UnoCSS, Bulma, Tailwind CSS | Tailwind v4 moved parts of its engine to which language? — Rust; Go, Zig, C++ |
| svelte | web | Svelte | sveltejs/svelte | JavaScript (langQ false) | 50k+ | "A UI framework that compiles itself away." / "Its fifth major version introduced "runes"." | A compiler-based UI framework with no virtual DOM | Svelte, Solid, Preact, Lit | Who created Svelte? — Rich Harris; Evan You, Ryan Dahl, Dan Abramov |
| vue | web | Vue | vuejs/core | TypeScript | 50k+ | "The "progressive" JavaScript framework." / "Template, script and style in a single file." | An approachable framework for building web user interfaces | Ember, React, Vue, Alpine.js | Who created Vue? — Evan You; Rich Harris, Ryan Dahl, Dan Abramov |
| go | lang | Go | golang/go | Go | 100k+ | "A language designed at Google in 2007." / "if err != nil {" | A simple compiled language built for networked services | Rust, Go, Zig, Kotlin | In which year did Go add generics? — 2022; 2012, 2016, 2019 |
| rust | lang | Rust | rust-lang/rust | Rust | 100k+ | "Memory safety without a garbage collector." / "The borrow checker said no." | A systems language with compile-time memory safety | Zig, C++, Carbon, Rust | What is Rust's package manager called? — Cargo; Crate, Forge, Rocket |
| deno | lang | Deno | denoland/deno | Rust | 100k+ | "A JavaScript runtime from the creator of Node." / "Its name is an anagram of its predecessor." | A secure TypeScript and JavaScript runtime with built-in tooling | Deno, Bun, Node.js, workerd | Who created Deno? — Ryan Dahl; Evan You, TJ Holowaychuk, Rich Harris |
| bun | lang | Bun | oven-sh/bun | Zig | 50k+ | "Runtime, bundler, test runner and package manager in one." / "Named after a dumpling, more or less." | An all-in-one, very fast JavaScript runtime and toolkit | esbuild, Deno, Bun, Node.js | Which JavaScript engine does Bun use? — JavaScriptCore; V8, SpiderMonkey, QuickJS |
| vscode | dev | VS Code | microsoft/vscode | TypeScript | 100k+ | "The most used code editor on the planet." / "Its open-source build is called "Code - OSS"." | An extensible code editor with debugging, Git and a huge extension market | VS Code, Atom, Sublime Text, Zed | VS Code's desktop app is built on which framework? — Electron; Tauri, Qt, GTK |
| ohmyzsh | dev | Oh My Zsh | ohmyzsh/ohmyzsh | Shell | 100k+ | "A framework for managing your shell config." / "Hundreds of plugins and over a hundred themes." | A community framework of plugins and themes for Zsh | Starship, Prezto, Oh My Zsh, Fish | What is Oh My Zsh's default theme? — robbyrussell; agnoster, powerlevel10k, spaceship |
| neovim | dev | Neovim | neovim/neovim | Vim Script (langQ false) | 50k+ | "A fork of a text editor from 1991." / "You still cannot exit it." | A hyperextensible, modernized fork of Vim | Vim, Helix, Neovim, Emacs | Which language became Neovim's go-to config language? — Lua; TOML, YAML, JSON |
| fzf | dev | fzf | junegunn/fzf | Go | 50k+ | "A command-line fuzzy finder." / "Pipe anything into it and pick." | An interactive fuzzy filter for files, history, processes and more | ripgrep, fzf, fd, zoxide | Which shell shortcut does fzf famously supercharge? — Ctrl-R; Ctrl-Z, Ctrl-L, Ctrl-D |
| uv | dev | uv | astral-sh/uv | Rust | 50k+ | "A Python package manager written in Rust." / "Claims to be 10–100x faster than pip." | An extremely fast Python package and project manager | Poetry, pipenv, Rye, uv | uv comes from the same team as which tool? — Ruff; Black, Poetry, mypy |
| k8s | infra | Kubernetes | kubernetes/kubernetes | Go | 100k+ | "Container orchestration from a search giant." / "Greek for "helmsman"." | Runs, scales and heals containerized apps across a cluster | Nomad, Kubernetes, Docker Swarm, Mesos | Kubernetes grew out of which internal Google system? — Borg; Colossus, Spanner, Chubby |
| moby | infra | Moby | moby/moby | Go | 50k+ | "Open-source upstream of the best-known container engine." / "Renamed in 2017 after a whale of a novel." | The open-source project behind Docker Engine | Podman, containerd, Moby, LXC | Moby is the upstream of which product? — Docker Engine; Podman, Kubernetes, Nomad |
| terraform | infra | Terraform | hashicorp/terraform | Go | 20k+ | "Infrastructure as code in HCL." / "plan, apply, then pray." | Declares cloud infrastructure in code and applies the changes | Pulumi, Ansible, CloudFormation, Terraform | Which fork appeared after Terraform's 2023 license change? — OpenTofu; Pulumi, Crossplane, CDKTF |
| supabase | infra | Supabase | supabase/supabase | TypeScript | 50k+ | "The open-source Firebase alternative." / "Auth, storage and realtime in one dashboard." | A Postgres backend with auth, storage, realtime and edge functions | Supabase, Appwrite, PocketBase, Firebase | Which database is Supabase built on? — PostgreSQL; MySQL, MongoDB, SQLite |

Write a test that every generated question has exactly 4 unique options and a valid answer index.

## 7. Modes

### Daily (the main mode)

- Seed: FNV-1a hash of `"lcs-" + YYYYMMDD` (UTC) into a mulberry32 RNG. Every player gets the same 12 platforms: 10 classic plus 2 rising (if the rising pool is available), shuffled with the seed. Each platform's question is also seeded (`YYYYMMDD-q-<platformNumber>`), so it's the same no matter the order you land.
- Unlock the gate at 8 cleared.
- The **first run of the day is official** and goes on the leaderboard. Later runs are "Daily replay" and don't count. Enforce this server-side, per player.

### Practice

- All classic plus rising repos, random order every run, unlock at 12.
- 8 wandering bot players with random numbers. When you answer correctly, the nearest bot gets eliminated with a puff, and a toast reads "Player 214 eliminated, along with N others".
- A "Players left" counter starts at 456 and drops by 6–19 per correct answer.

### Arena (real-time multiplayer)

- Create a room and get a 4-character code (alphabet `abcdefghjkmnpqrstuvwxyz23456789`), or join with one. The lobby lists player numbers and names, and the creator is the host and presses Start.
- **The server is authoritative for timing and answers.** This is better than the client-trusted version I prototyped:
  - The server picks the seed and `t0 = now + 5 s` and broadcasts them.
  - Clients render course and timers from the seed and server time. Do a simple clock-offset sync on connect: ping 5×, use the median round-trip.
  - Clients stream their position to the server about 15 times a second, and the server relays it. Render other players with interpolation and their name tags.
  - **Rounds:** 6 bells. Bell k rings at `t0 + 9 s + k*20 s`. At the bell, any player not standing on a platform (client reports `groundPlatformIndex` with its position; the server checks the last report is within 300 ms and on an existing platform) is out.
  - Then everyone gets the same seeded question for 10 s. Answers go to the server, which decides right, wrong, or timeout and broadcasts eliminations.
  - After each question window, two seeded platforms shake for 2.5 s ("CRUMBLING", pink) and disappear. The course is 14 static platforms with no gate.
  - Survivors after bell 6 win (+500).
  - A HUD pill shows "Bell 3 in 4.2s", turning pink under 3 s, or "Bell 3 · answer".
- Late joiners after the first bell become spectators. Disconnected players count as eliminated after 10 s.

## 8. Results screen and sharing (this is the virality lever, so make it great)

- Show a stamp ("ELIMINATED" in pink, rotated, with a border, or "STILL STANDING" in teal), the reason, and stats: score, cleared/total (or bells survived), and rank or players left.
- **Copyable result text:**
  ```
  Last Commit Standing · Daily 2026-10-10
  Player 067 · 1,840 pts · 7/12 cleared
  ■■■◆■■■✕□□□□
  Out on #8 Terraform (trivia)
  ```
  ■ = cleared, ◆ = gold cleared, ✕ = where you died, □ = not reached. Add the game URL as the last line.
- **A 1200×630 PNG result card** drawn on a canvas in the game's style: title, mode and date, big player number, the row of squares, the status, the score, and a footer with the out reason or "Can you outlast me?". Offer it as a download, and also serve it at `/card/:runId.png` so the shared URL gets an Open Graph image.
- Each official run gets a shareable URL (`/r/:runId`) that shows the card and a "Play today's course" button.
- Daily leaderboard: today's top 10 (name or "Player NNN", cleared/12, score), with your own row highlighted.

## 9. Server API (sketch; refine in your plan)

- `POST /api/daily/start` → `{runId}`. One official run per player per UTC day. Identify the player with an anonymous id cookie, plus an optional display name they type once.
- `POST /api/daily/finish {runId, results[], score, outLabel}` → validated: recompute the maximum possible score from the seed and the claimed results, and reject impossible values.
- `GET /api/daily/leaderboard?date=YYYYMMDD`
- `GET /api/rising` → `{asOf, repos:[{name, desc, lang, stars}]}`
- WebSocket `/arena` for the room protocol in section 7.

## 10. Rising-repo refresh script

- Query `https://api.github.com/search/repositories?q=created:>{today−60d}&sort=stars&order=desc&per_page=40` (use `GITHUB_TOKEN` if set).
- Keep 10–12 repos with variety. **Exclude** CVE exploits and proofs of concept, tools for evading AI detection or stripping watermarks or provenance, account or credential abuse, adult content, and repos with no usable description.
- For each repo, store a one-sentence description **rewritten so it doesn't contain the owner or repo name** (it's the identify clue). Generate it with the Anthropic API if `ANTHROPIC_API_KEY` is set, otherwise strip the name with a regex and fall back to the original description. Mark auto-generated descriptions for review.
- Never invent features. Use only what the API returned.

## 11. Quality bar

- 60 fps on a mid-range laptop. No layout shift. Works at 400 px width (stage height `clamp(420px, 72vh, 700px)`).
- Accessible overlays: real `<button>`s, visible focus rings, focus moves to the first answer when a question opens, and an `aria-live` HUD.
- All copy in plain language.
- Unit tests pass. Add a Playwright smoke test: load the page, start Practice, hold right and jump until the first question opens, then answer it.

## 12. Milestones (commit after each, and show me how to run it)

1. Solo engine: physics, course generation, pit, moving and gold platforms, questions, Practice mode, results screen with copy text.
2. Daily mode: seeding, server API, leaderboard, official-run enforcement, PNG card, share URLs with OG images.
3. Rising pool: refresh script, API, and rising questions in Daily and Practice.
4. Arena: WebSocket server, lobby, clock sync, server-authoritative bells, questions and crumbling, spectators.
5. Polish: touch pad, reduced motion, Playwright test, deploy notes for the host we pick.
