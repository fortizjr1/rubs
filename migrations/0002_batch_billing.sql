-- Batch billing: one billing batch per utility-company bill, one statement per resident.
-- Replaces the old one-bill-at-a-time tables (they held no data when this was written).

DROP TABLE IF EXISTS charges;
DROP TABLE IF EXISTS bills;

-- App-wide settings (company name, SMTP, email templates). Key/value.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Contact details and statement options printed on each property's statements.
ALTER TABLE properties ADD COLUMN phone TEXT;
ALTER TABLE properties ADD COLUMN email TEXT;
ALTER TABLE properties ADD COLUMN due_days INTEGER NOT NULL DEFAULT 28;
-- 'meter'    = days are counted like a utility meter read: end date minus start date
--              (Oct 6 to Nov 3 = 28 days); the move-out day is not billed.
-- 'calendar' = both the first and last day count (Oct 6 to Nov 3 = 29 days).
ALTER TABLE properties ADD COLUMN day_count TEXT NOT NULL DEFAULT 'meter';
ALTER TABLE properties ADD COLUMN tax_label TEXT NOT NULL DEFAULT 'Utility tax';
ALTER TABLE properties ADD COLUMN tax_charge_code TEXT;
ALTER TABLE properties ADD COLUMN billing_fee_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE properties ADD COLUMN fee_label TEXT NOT NULL DEFAULT 'Billing fee';
ALTER TABLE properties ADD COLUMN fee_charge_code TEXT;
ALTER TABLE properties ADD COLUMN payment_text TEXT;
ALTER TABLE properties ADD COLUMN questions_text TEXT;
ALTER TABLE properties ADD COLUMN footer_text TEXT;

-- Tax added on top of each resident's share of this utility (e.g. 10% utility tax on water).
ALTER TABLE property_utilities ADD COLUMN tax_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE property_utilities ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- A billing batch = one bill from the utility company for one property and service period.
CREATE TABLE billing_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id    INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  vendor         TEXT,
  vendor_account TEXT,
  period_start   TEXT NOT NULL,
  period_end     TEXT NOT NULL,
  statement_date TEXT NOT NULL,
  due_date       TEXT NOT NULL,
  charge_date    TEXT NOT NULL,     -- transaction date in the Rent Manager export
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','finalized')),
  calc_summary   TEXT,              -- JSON totals from the last calculation
  notes          TEXT,
  finalized_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_runs_property ON billing_runs(property_id);

-- One line of the utility company's bill (Water $X, Sewer $Y) inside a batch.
CREATE TABLE bills (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_run_id      INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  property_utility_id INTEGER NOT NULL REFERENCES property_utilities(id) ON DELETE RESTRICT,
  total_cents         INTEGER NOT NULL,
  calc_summary        TEXT,
  UNIQUE (billing_run_id, property_utility_id)
);

-- One statement (invoice) per resident per batch.
CREATE TABLE statements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  billing_run_id INTEGER NOT NULL REFERENCES billing_runs(id) ON DELETE CASCADE,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  unit_id        INTEGER NOT NULL,
  days           INTEGER NOT NULL,
  total_cents    INTEGER NOT NULL,
  lines          TEXT NOT NULL,     -- JSON [{label, amount_cents, charge_code, kind}]
  emailed_at     TEXT,
  email_to       TEXT,
  email_error    TEXT,
  exported_at    TEXT,
  UNIQUE (billing_run_id, tenant_id)
);
CREATE INDEX idx_statements_tenant ON statements(tenant_id);

-- RUBS result per resident per utility line (the detail behind each statement line).
CREATE TABLE charges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  statement_id    INTEGER NOT NULL REFERENCES statements(id) ON DELETE CASCADE,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  unit_id         INTEGER NOT NULL,
  days            INTEGER NOT NULL,
  period_days     INTEGER NOT NULL,
  share_cents     INTEGER NOT NULL,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  admin_fee_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents    INTEGER NOT NULL,
  detail          TEXT
);
CREATE INDEX idx_charges_bill ON charges(bill_id);
CREATE INDEX idx_charges_statement ON charges(statement_id);
