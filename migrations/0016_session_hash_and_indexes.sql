-- Session tokens are now stored hashed (SHA-256), so existing sessions can't be matched any more:
-- everyone signs in once more.
DELETE FROM sessions;
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_impersonated ON sessions (impersonated_by);
CREATE INDEX IF NOT EXISTS idx_runs_property_status ON billing_runs (property_id, status, period_end);
