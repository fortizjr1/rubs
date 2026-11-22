-- Tenant "Forgot password" links (token stored hashed, single use, short-lived).
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  tenant_id  INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_tenant ON password_resets (tenant_id);

-- Staff activity log: who changed what, and when.
CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER,
  admin_name TEXT,
  method     TEXT NOT NULL,
  path       TEXT NOT NULL,
  summary    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log (created_at);
CREATE INDEX IF NOT EXISTS idx_activity_admin ON activity_log (admin_id, created_at);
