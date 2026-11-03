-- Stream A: accounts, passkeys, sessions, WebSocket tickets, app handoff codes, auth rate limits.
-- Every account-owned row cascades from accounts(id); D1 enforces foreign keys.

CREATE TABLE accounts (
  -- 16 random bytes, base64url. Also the WebAuthn user.id (user handle).
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  name_changed_at INTEGER,
  -- bit 0 badlands, bit 1 banned, bit 2 reported
  flags INTEGER NOT NULL DEFAULT 0,
  ghost_opt_out INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE passkeys (
  -- base64url credential id
  credential_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- base64url COSE public key
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  -- JSON array of transports, e.g. ["internal","hybrid"]
  transports TEXT,
  aaguid TEXT,
  device_type TEXT,
  backed_up INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_account ON passkeys (account_id);

-- One row per outstanding ceremony. Consumed (deleted) by the matching verify call.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login', 'reauth', 'add_passkey')),
  -- register only: the name being reserved and the account id that will own it
  name TEXT,
  name_key TEXT,
  -- register: the new account id; reauth/add_passkey: the signed-in account
  account_id TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX webauthn_challenges_expires ON webauthn_challenges (expires_at);

-- A name picked at registration options is held for 5 minutes for that client.
CREATE TABLE name_reservations (
  name_key TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  client_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Names of deleted accounts stay unavailable for 30 days.
CREATE TABLE name_tombstones (
  name_key TEXT PRIMARY KEY,
  released_at INTEGER NOT NULL
);

CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- one family per sign-in; reusing a rotated token revokes the whole family
  family_id TEXT NOT NULL,
  -- SHA-256 of the token, hex; the token itself is never stored
  token_hash TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL CHECK (platform IN ('web', 'ios-app', 'android-app')),
  -- when the passkey ceremony behind this family happened
  auth_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_account ON refresh_tokens (account_id);

CREATE TABLE app_auth_codes (
  code_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- base64url(SHA-256(verifier))
  challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'register', 'reauth')),
  auth_time INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Single-use WebSocket tickets (30 s).
CREATE TABLE ws_tickets (
  ticket_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('duel', 'town')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX ws_tickets_expires ON ws_tickets (expires_at);

-- Fixed-window counters for auth rate limits. Keys hash the client or name the account.
CREATE TABLE auth_rate (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
