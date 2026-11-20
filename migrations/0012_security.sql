-- Security settings: sign-in log / lockouts, ALTCHA replay protection, staff last sign-in.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,            -- staff | resident | activate | setup
  identifier  TEXT,                     -- email (or account number for activation), lowercased
  ip          TEXT,
  success     INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,                     -- why it failed (wrong password, bot check, locked out…)
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON login_attempts (identifier, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts (ip, created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts (created_at);

-- Each solved ALTCHA challenge can be used once.
CREATE TABLE IF NOT EXISTS altcha_used (
  nonce       TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL          -- unix seconds
);

ALTER TABLE admins ADD COLUMN last_login_at TEXT;
ALTER TABLE admins ADD COLUMN last_login_ip TEXT;
