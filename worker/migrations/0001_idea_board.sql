-- Repo Safari idea board (D1). Times are Unix milliseconds, UTC.
-- Public text lives in `ideas`; private records (sessions, receipts, login codes, votes) never leave the Worker.

-- Board-wide settings: launch_at (first time the board ran enabled), policy.
CREATE TABLE board_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- GitHub accounts, keyed by GitHub's immutable numeric id. The handle is refreshed at each sign-in.
CREATE TABLE accounts (
  github_id INTEGER PRIMARY KEY,
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Sessions: only a SHA-256 of the bearer token is stored.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES accounts(github_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE INDEX sessions_account ON sessions(github_id);

-- OAuth "state" values (single use, 10 minutes), bound to the page's PKCE-style challenge and return address.
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);

-- One-time login codes handed back to the page in a URL fragment (single use, 2 minutes), exchanged for a session.
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  github_id INTEGER NOT NULL REFERENCES accounts(github_id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX login_codes_expiry ON login_codes(expires_at);

-- Generated output, saved as the Worker validated it, so a browser can't substitute its own text.
-- Deleted 24 hours after generation unless published (the published copy lives in `ideas`).
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  receipt_hash TEXT NOT NULL,
  repos_json TEXT NOT NULL,
  ideas_json TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX drafts_expiry ON drafts(expires_at);

-- Published ideas. Text and source snapshot never change after publication.
-- status: collecting -> selected -> building -> built, or held / declined (with a public note).
CREATE TABLE ideas (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('useful', 'unexpected', 'ridiculous')),
  name TEXT NOT NULL,
  pitch TEXT NOT NULL,
  concept TEXT NOT NULL,
  inspiration TEXT NOT NULL,
  repos_json TEXT NOT NULL,
  publisher_id INTEGER NOT NULL REFERENCES accounts(github_id),
  publisher_login TEXT NOT NULL,
  draft_id TEXT,
  model TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting', 'selected', 'building', 'built', 'held', 'declined')),
  status_note TEXT,
  hidden_at INTEGER,
  stars_total INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ideas_new ON ideas(published_at DESC, id DESC) WHERE hidden_at IS NULL;
CREATE INDEX ideas_publisher ON ideas(publisher_id, published_at);

-- One star per (idea, GitHub account). first_starred_at never changes, so an old star can't move into a new week.
CREATE TABLE stars (
  idea_id TEXT NOT NULL REFERENCES ideas(id),
  github_id INTEGER NOT NULL REFERENCES accounts(github_id),
  first_starred_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  invalidated_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (idea_id, github_id)
);
CREATE INDEX stars_week ON stars(first_starred_at, idea_id);
CREATE INDEX stars_account ON stars(github_id);

-- Append-only star history, written by triggers in the same transaction as the change.
-- A delayed weekly close reads it to see every star exactly as it was at the cutoff.
CREATE TABLE star_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id TEXT NOT NULL,
  github_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('star', 'unstar', 'invalidate', 'restore'))
);
CREATE INDEX star_events_pair ON star_events(idea_id, github_id, at);
CREATE INDEX star_events_account ON star_events(github_id, at);

CREATE TRIGGER stars_inserted AFTER INSERT ON stars BEGIN
  INSERT INTO star_events (idea_id, github_id, at, action) VALUES (NEW.idea_id, NEW.github_id, NEW.updated_at, 'star');
  UPDATE ideas SET stars_total = stars_total + 1 WHERE id = NEW.idea_id AND NEW.active = 1 AND NEW.invalidated_at IS NULL;
END;
CREATE TRIGGER stars_toggled AFTER UPDATE OF active ON stars WHEN OLD.active <> NEW.active BEGIN
  INSERT INTO star_events (idea_id, github_id, at, action) VALUES (NEW.idea_id, NEW.github_id, NEW.updated_at, CASE NEW.active WHEN 1 THEN 'star' ELSE 'unstar' END);
  UPDATE ideas SET stars_total = stars_total + CASE NEW.active WHEN 1 THEN 1 ELSE -1 END WHERE id = NEW.idea_id AND NEW.invalidated_at IS NULL;
END;
CREATE TRIGGER stars_moderated AFTER UPDATE OF invalidated_at ON stars WHEN (OLD.invalidated_at IS NULL) <> (NEW.invalidated_at IS NULL) BEGIN
  INSERT INTO star_events (idea_id, github_id, at, action) VALUES (NEW.idea_id, NEW.github_id, NEW.updated_at, CASE WHEN NEW.invalidated_at IS NULL THEN 'restore' ELSE 'invalidate' END);
  UPDATE ideas SET stars_total = stars_total + CASE WHEN NEW.invalidated_at IS NULL THEN 1 ELSE -1 END WHERE id = NEW.idea_id AND NEW.active = 1;
END;

-- Moderation history: what made an idea eligible or not, and when (hide/unhide, hold/release, decline/reinstate).
CREATE TABLE moderation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id TEXT NOT NULL REFERENCES ideas(id),
  at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('hide', 'unhide', 'hold', 'release', 'decline', 'reinstate')),
  reason TEXT NOT NULL
);
CREATE INDEX moderation_events_idea ON moderation_events(idea_id, at);

-- One immutable row per closed contest week. A no-winner week has winner_id NULL. An idea can win only once.
CREATE TABLE contests (
  week_start INTEGER PRIMARY KEY,
  week_end INTEGER NOT NULL UNIQUE,
  partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
  policy_version TEXT NOT NULL,
  winner_id TEXT REFERENCES ideas(id),
  winner_score INTEGER,
  winner_reached_at INTEGER,
  winner_lifetime INTEGER,
  eligible_count INTEGER NOT NULL,
  voters INTEGER NOT NULL,
  stars INTEGER NOT NULL,
  submissions INTEGER NOT NULL,
  closed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX contests_one_win ON contests(winner_id) WHERE winner_id IS NOT NULL;

-- The build queue: at most one entry per week and per idea, created in the same transaction as the week's result.
CREATE TABLE build_queue (
  idea_id TEXT PRIMARY KEY REFERENCES ideas(id),
  week_start INTEGER NOT NULL UNIQUE REFERENCES contests(week_start),
  week_end INTEGER NOT NULL,
  frozen_json TEXT NOT NULL,
  weekly_stars INTEGER NOT NULL,
  lifetime_stars INTEGER NOT NULL,
  policy_version TEXT NOT NULL,
  selected_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('selected', 'building', 'built', 'held', 'declined')),
  status_note TEXT,
  demo_url TEXT,
  source_url TEXT,
  updated_at INTEGER NOT NULL
);

-- Owner actions, with reasons.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT
);

-- Local preview only: a controllable clock. The endpoint that writes it refuses non-local hosts, so it stays empty in production.
CREATE TABLE dev_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  now_ms INTEGER NOT NULL
);
