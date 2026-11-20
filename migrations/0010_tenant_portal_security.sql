-- Resident portal: last sign-in (time + IP) and account lock.
ALTER TABLE tenants ADD COLUMN last_login_at TEXT;
ALTER TABLE tenants ADD COLUMN last_login_ip TEXT;
ALTER TABLE tenants ADD COLUMN locked_at TEXT;
ALTER TABLE tenants ADD COLUMN locked_reason TEXT;
