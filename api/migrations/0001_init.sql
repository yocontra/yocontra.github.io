-- out-west leaderboard: one row per submitted run.
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Normalised name used to group a player's runs (best run per name is shown).
  name_key TEXT NOT NULL,
  total INTEGER NOT NULL,
  duels INTEGER NOT NULL,
  wins INTEGER NOT NULL,
  economy_version INTEGER NOT NULL,
  -- SHA-256 of (client IP + daily salt). Used only for rate limiting; never the raw IP.
  client_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX runs_total ON runs (total DESC, created_at ASC);
CREATE INDEX runs_name_key ON runs (name_key, total DESC);
CREATE INDEX runs_client_created ON runs (client_hash, created_at);
