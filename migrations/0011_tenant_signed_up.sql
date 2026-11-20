-- When the resident created their own portal login (activation). NULL = never signed up,
-- or signed up before this was recorded (then password_hash is set).
ALTER TABLE tenants ADD COLUMN activated_at TEXT;
