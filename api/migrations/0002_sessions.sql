-- Ranked sessions (one per Turnstile-verified run) and a flag for runs that look automated.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  client_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_client_created ON sessions (client_hash, created_at);

ALTER TABLE runs ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN session_id TEXT;
