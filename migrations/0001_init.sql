-- RUBS Utility Billing - initial schema (Cloudflare D1 / SQLite)
-- Money is stored as integer cents. Dates are ISO strings: YYYY-MM-DD.

CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_type  TEXT NOT NULL CHECK (user_type IN ('admin','tenant')),
  user_id    INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE properties (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  rm_property_code TEXT,              -- Rent Manager property short name / ID
  address          TEXT,
  city             TEXT,
  state            TEXT,
  zip              TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE units (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id  INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  unit_number  TEXT NOT NULL,
  sqft         REAL NOT NULL DEFAULT 0,
  bedrooms     REAL NOT NULL DEFAULT 0,
  bathrooms    REAL NOT NULL DEFAULT 0,
  notes        TEXT,
  UNIQUE (property_id, unit_number)
);

CREATE TABLE tenants (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  first_name      TEXT,
  last_name       TEXT NOT NULL,
  email           TEXT COLLATE NOCASE,
  phone           TEXT,
  account_number  TEXT UNIQUE,         -- Rent Manager tenant account / display ID
  mailing_address TEXT,
  move_in         TEXT NOT NULL,
  move_out        TEXT,
  occupants       INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  password_hash   TEXT,                -- resident portal login (set by resident on activation)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tenants_unit ON tenants(unit_id);

-- Per-property utility setup ("set asides"): how each utility is split.
-- Weights are percentages across allocation bases, e.g. 50 sqft + 50 occupants.
CREATE TABLE property_utilities (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id      INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  utility_name     TEXT NOT NULL,      -- Water, Sewer, Trash, Gas, Electric...
  rm_charge_code   TEXT,               -- Rent Manager charge type
  recovery_pct     REAL NOT NULL DEFAULT 100, -- % of bill passed to residents (rest = common area / owner)
  w_sqft           REAL NOT NULL DEFAULT 0,
  w_bedrooms       REAL NOT NULL DEFAULT 0,
  w_occupants      REAL NOT NULL DEFAULT 0,
  w_equal          REAL NOT NULL DEFAULT 0,
  vacancy_mode     TEXT NOT NULL DEFAULT 'owner' CHECK (vacancy_mode IN ('owner','occupied')),
  vacant_occupants REAL NOT NULL DEFAULT 1, -- occupant factor used for vacant unit-days
  admin_fee_cents  INTEGER NOT NULL DEFAULT 0, -- flat billing fee per resident per bill
  active           INTEGER NOT NULL DEFAULT 1,
  notes            TEXT
);

CREATE TABLE bills (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id         INTEGER NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  property_utility_id INTEGER NOT NULL REFERENCES property_utilities(id) ON DELETE RESTRICT,
  vendor              TEXT,
  vendor_account      TEXT,
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  total_cents         INTEGER NOT NULL,
  statement_date      TEXT,
  charge_date         TEXT,            -- transaction date used in the Rent Manager export
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','calculated','posted')),
  calc_summary        TEXT,            -- JSON snapshot of the last calculation
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_bills_property ON bills(property_id);

CREATE TABLE charges (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id         INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  unit_id         INTEGER NOT NULL,
  days            INTEGER NOT NULL,
  period_days     INTEGER NOT NULL,
  share_cents     INTEGER NOT NULL,
  admin_fee_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents    INTEGER NOT NULL,
  detail          TEXT,                -- JSON breakdown shown to residents
  exported_at     TEXT
);
CREATE INDEX idx_charges_bill ON charges(bill_id);
CREATE INDEX idx_charges_tenant ON charges(tenant_id);
