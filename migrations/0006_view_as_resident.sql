-- "Log in as a resident": a staff member can open a read-only resident session.
-- impersonated_by = the staff (admin) id; return_token = that staff member's own session,
-- restored when they click "Back to staff view".
ALTER TABLE sessions ADD COLUMN impersonated_by INTEGER;
ALTER TABLE sessions ADD COLUMN return_token TEXT;
