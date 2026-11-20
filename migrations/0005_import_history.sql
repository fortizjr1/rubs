-- Import history: each tenant/unit CSV import is recorded, and records it CREATED are tagged
-- so the import can be undone. (Records it only updated are not tagged.)
CREATE TABLE import_batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('tenants','units')),
  filename      TEXT,
  created_by    INTEGER,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  units_created INTEGER NOT NULL DEFAULT 0,
  undone_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE tenants ADD COLUMN import_batch_id INTEGER;
ALTER TABLE units ADD COLUMN import_batch_id INTEGER;
CREATE INDEX idx_tenants_import ON tenants(import_batch_id);
CREATE INDEX idx_units_import ON units(import_batch_id);
