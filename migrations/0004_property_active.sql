-- Properties can be marked inactive (e.g. sold). History is kept.
ALTER TABLE properties ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE properties ADD COLUMN inactive_date TEXT;
ALTER TABLE properties ADD COLUMN inactive_reason TEXT;
