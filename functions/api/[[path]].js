// Single API router for Cloudflare Pages Functions. Handles every /api/* request.
// D1 database binding name: DB (see wrangler.toml).

import { toCSV, csvResponse, dollars } from '../../lib/csv.js';
import {
  hashPassword, verifyPassword, validatePassword, createSession, sessionCookie,
  getSession, readSessionToken,
} from '../../lib/auth.js';
import { HttpError, json, body, today, blank, coerce } from '../../lib/util.js';
import { loadSettings, saveSettings, sendTestEmail } from '../../lib/settings.js';
import {
  listRuns, runDetail, createRun, updateRun, deleteRun, calculateRun, setRunStatus,
  statementRenderData, pdfResponse, emailStatement,
} from '../../lib/billing.js';

// ---------------------------------------------------------------- resources (admin CRUD)

const RESOURCES = {
  properties: {
    table: 'properties',
    fields: {
      name: ['text', 'Property name', true], rm_property_code: ['text', 'Rent Manager property code'],
      total_units: ['int', 'Total units'],
      address: ['text', 'Address'], city: ['text', 'City'], state: ['text', 'State'], zip: ['text', 'ZIP'],
      phone: ['text', 'Office phone'], email: ['email', 'Office email'], notes: ['text', 'Notes'],
      due_days: ['int', 'Days until due'], day_count: [['meter', 'calendar'], 'Day count'],
      tax_label: ['text', 'Tax line label'], tax_charge_code: ['text', 'Tax charge code'],
      billing_fee_cents: ['int', 'Billing fee'], fee_label: ['text', 'Fee line label'], fee_charge_code: ['text', 'Fee charge code'],
      payment_text: ['text', 'Payment text'], questions_text: ['text', 'Questions text'], footer_text: ['text', 'Footer text'],
    },
    validate: (r) => {
      if (r.total_units != null && (r.total_units < 0 || r.total_units > 100000)) throw new HttpError(400, 'Total units must be a positive number');
      if (r.due_days != null && (r.due_days < 0 || r.due_days > 120)) throw new HttpError(400, 'Days until due must be between 0 and 120');
      if (r.billing_fee_cents != null && r.billing_fee_cents < 0) throw new HttpError(400, 'Billing fee cannot be negative');
    },
    // units_total: the number entered on the property, or the units set up if none was entered.
    // occupied_units: units with at least one current resident today. vacant_units = total - occupied.
    list: `SELECT x.*, COALESCE(x.total_units, x.unit_count) AS units_total,
             MAX(COALESCE(x.total_units, x.unit_count) - x.occupied_units, 0) AS vacant_units
           FROM (SELECT p.*,
             (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS unit_count,
             (SELECT COUNT(DISTINCT u.id) FROM units u JOIN tenants t ON t.unit_id = u.id
                WHERE u.property_id = p.id AND t.move_in <= date('now')
                  AND (t.move_out IS NULL OR t.move_out >= date('now'))) AS occupied_units,
             (SELECT COUNT(*) FROM tenants t JOIN units u ON u.id = t.unit_id
                WHERE u.property_id = p.id AND t.move_in <= date('now')
                  AND (t.move_out IS NULL OR t.move_out >= date('now'))) AS current_tenants
           FROM properties p) x WHERE 1=1`,
    filters: { id: 'x.id' },
    search: ['x.name', 'x.address', 'x.rm_property_code'],
    order: 'x.name',
  },
  units: {
    table: 'units',
    fields: {
      property_id: ['int', 'Property', true], unit_number: ['text', 'Unit number', true],
      sqft: ['num', 'Square feet'], bedrooms: ['num', 'Bedrooms'], bathrooms: ['num', 'Bathrooms'],
      notes: ['text', 'Notes'],
    },
    list: `SELECT u.*, p.name AS property_name,
             (SELECT TRIM(COALESCE(t.first_name,'') || ' ' || t.last_name) FROM tenants t
                WHERE t.unit_id = u.id AND t.move_in <= date('now')
                  AND (t.move_out IS NULL OR t.move_out >= date('now'))
                ORDER BY t.move_in DESC LIMIT 1) AS current_tenant
           FROM units u JOIN properties p ON p.id = u.property_id WHERE 1=1`,
    filters: { property_id: 'u.property_id', id: 'u.id' },
    search: ['u.unit_number', 'p.name'],
    order: 'p.name, u.unit_number COLLATE NOCASE',
  },
  tenants: {
    table: 'tenants',
    fields: {
      unit_id: ['int', 'Unit', true], first_name: ['text', 'First name'], last_name: ['text', 'Last name', true],
      email: ['email', 'Email'], phone: ['text', 'Phone'], account_number: ['text', 'Account number'],
      mailing_address: ['text', 'Address'], move_in: ['date', 'Move-in date', true], move_out: ['date', 'Move-out date'],
      occupants: ['int', 'Number of occupants'], notes: ['text', 'Notes'],
    },
    list: `SELECT t.id, t.unit_id, t.first_name, t.last_name, t.email, t.phone, t.account_number,
             t.mailing_address, t.move_in, t.move_out, t.occupants, t.notes, t.created_at,
             (t.password_hash IS NOT NULL) AS portal_active,
             u.unit_number, u.property_id, u.sqft, u.bedrooms, p.name AS property_name,
             CASE WHEN t.move_in > date('now') THEN 'future'
                  WHEN t.move_out IS NOT NULL AND t.move_out < date('now') THEN 'past'
                  ELSE 'current' END AS status
           FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id WHERE 1=1`,
    filters: { property_id: 'u.property_id', unit_id: 't.unit_id', id: 't.id' },
    search: ['t.first_name', 't.last_name', 't.email', 't.account_number', 'u.unit_number', 't.phone'],
    order: 'p.name, u.unit_number COLLATE NOCASE, t.move_in DESC',
    validate: (r) => {
      if (r.move_out && r.move_in && r.move_out < r.move_in) throw new HttpError(400, 'Move-out date is before move-in date');
      if (r.occupants !== undefined && r.occupants !== null && r.occupants < 0) throw new HttpError(400, 'Occupants cannot be negative');
    },
  },
  utilities: {
    table: 'property_utilities',
    fields: {
      property_id: ['int', 'Property', true], utility_name: ['text', 'Utility', true],
      rm_charge_code: ['text', 'Rent Manager charge code'], recovery_pct: ['num', 'Recovery %'],
      w_sqft: ['num', 'Square footage weight'], w_bedrooms: ['num', 'Bedrooms weight'],
      w_occupants: ['num', 'Occupants weight'], w_equal: ['num', 'Equal split weight'],
      vacancy_mode: [['owner', 'occupied'], 'Vacancy handling'], vacant_occupants: ['num', 'Vacant unit occupant factor'],
      admin_fee_cents: ['int', 'Admin fee'], tax_pct: ['num', 'Tax %'], sort_order: ['int', 'Order on statement'],
      active: ['bool', 'Active'], notes: ['text', 'Notes'],
    },
    list: `SELECT pu.*, p.name AS property_name FROM property_utilities pu
           JOIN properties p ON p.id = pu.property_id WHERE 1=1`,
    filters: { property_id: 'pu.property_id', id: 'pu.id' },
    search: ['pu.utility_name', 'p.name'],
    order: 'p.name, pu.sort_order, pu.id',
    validate: (r) => {
      if (r.tax_pct != null && (r.tax_pct < 0 || r.tax_pct > 100)) throw new HttpError(400, 'Tax % must be between 0 and 100');
      if (r.recovery_pct != null && (r.recovery_pct < 0 || r.recovery_pct > 100)) throw new HttpError(400, 'Recovery % must be between 0 and 100');
      for (const k of ['w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal']) {
        if (r[k] != null && r[k] < 0) throw new HttpError(400, 'Weights cannot be negative');
      }
    },
  },
};

function cleanInput(res, input, partial) {
  const out = {};
  for (const [key, [type, label, required]] of Object.entries(res.fields)) {
    if (partial && !(key in input)) continue;
    const v = coerce(type, input[key], label);
    if (required && v === null) throw new HttpError(400, `${label} is required`);
    out[key] = v;
  }
  res.validate?.(out);
  return out;
}

async function listResource(db, res, url) {
  let sql = res.list;
  const args = [];
  for (const [param, col] of Object.entries(res.filters || {})) {
    const v = url.searchParams.get(param);
    if (!blank(v)) { sql += ` AND ${col} = ?`; args.push(v); }
  }
  const q = url.searchParams.get('q');
  if (!blank(q) && res.search) {
    sql += ' AND (' + res.search.map((c) => `${c} LIKE ?`).join(' OR ') + ')';
    res.search.forEach(() => args.push(`%${q}%`));
  }
  const status = url.searchParams.get('tenant_status');
  if (res.table === 'tenants' && ['current', 'past', 'future'].includes(status)) {
    sql = `SELECT * FROM (${sql}) WHERE status = ?`;
    args.push(status);
    return (await db.prepare(sql + ' ORDER BY property_name, unit_number COLLATE NOCASE').bind(...args).all()).results;
  }
  sql += ` ORDER BY ${res.order} LIMIT 5000`;
  return (await db.prepare(sql).bind(...args).all()).results;
}

async function getOne(db, res, id) {
  const col = res.filters.id;
  const row = await db.prepare(`${res.list} AND ${col} = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Not found');
  return row;
}

async function createResource(db, name, input) {
  const res = RESOURCES[name];
  const data = cleanInput(res, input, false);
  if (name === 'utilities') {
    data.recovery_pct ??= 100;
    data.vacancy_mode ??= 'owner';
    data.vacant_occupants ??= 1;
    data.admin_fee_cents ??= 0;
    data.tax_pct ??= 0;
    data.active ??= 1;
    for (const k of ['w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal']) data[k] ??= 0;
    if (data.sort_order === null) {
      const m = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM property_utilities WHERE property_id = ?').bind(data.property_id).first();
      data.sort_order = m.n;
    }
  }
  if (name === 'properties') {
    for (const k of ['due_days', 'day_count', 'tax_label', 'billing_fee_cents', 'fee_label']) if (data[k] === null) delete data[k];
  }
  if (name === 'tenants') data.occupants ??= 1;
  if (name === 'units') for (const k of ['sqft', 'bedrooms', 'bathrooms']) data[k] ??= 0;
  const keys = Object.keys(data);
  const r = await db.prepare(`INSERT INTO ${res.table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`)
    .bind(...keys.map((k) => data[k])).first();
  return getOne(db, res, r.id);
}

async function updateResource(db, name, id, input) {
  const res = RESOURCES[name];
  const existing = await db.prepare(`SELECT * FROM ${res.table} WHERE id = ?`).bind(id).first();
  if (!existing) throw new HttpError(404, 'Not found');
  const data = cleanInput(res, input, true);
  // Validate cross-field rules against the merged record.
  res.validate?.({ ...existing, ...data });
  for (const k of ['sqft', 'bedrooms', 'bathrooms', 'occupants', 'recovery_pct', 'w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal', 'vacant_occupants', 'admin_fee_cents', 'tax_pct', 'sort_order', 'active']) {
    if (k in data && data[k] === null) data[k] = 0;
  }
  if ('recovery_pct' in input && blank(input.recovery_pct)) data.recovery_pct = 100;
  const stmts = [];
  if (name === 'properties') {
    if ('due_days' in data && data.due_days === null) data.due_days = 28;
    if ('day_count' in data && data.day_count === null) data.day_count = 'meter';
    if ('tax_label' in data && data.tax_label === null) data.tax_label = 'Utility tax';
    if ('fee_label' in data && data.fee_label === null) data.fee_label = 'Billing fee';
    if ('billing_fee_cents' in data && data.billing_fee_cents === null) data.billing_fee_cents = 0;
  }
  const keys = Object.keys(data);
  if (keys.length) {
    stmts.push(db.prepare(`UPDATE ${res.table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .bind(...keys.map((k) => data[k]), id));
    await db.batch(stmts);
  }
  return getOne(db, res, id);
}

async function deleteResource(db, name, id) {
  const res = RESOURCES[name];
  if (name === 'utilities') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM bills WHERE property_utility_id = ?').bind(id).first();
    if (n.n > 0) throw new HttpError(409, 'This utility is used in billing batches. Mark it inactive instead of deleting it.');
  }
  const r = await db.prepare(`DELETE FROM ${res.table} WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Not found');
  return { ok: true };
}

// ---------------------------------------------------------------- tenant import

const IMPORT_ALIASES = {
  property: ['property', 'property name', 'property_name', 'property code', 'property_code', 'rm_property_code'],
  unit_number: ['unit', 'unit number', 'unit_number', 'unit #', 'unit no', 'apt'],
  first_name: ['first name', 'first_name', 'firstname', 'first'],
  last_name: ['last name', 'last_name', 'lastname', 'last'],
  full_name: ['name', 'tenant name', 'tenant', 'full name', 'resident', 'resident name'],
  email: ['email', 'email address', 'e-mail'],
  phone: ['phone', 'phone number', 'cell', 'mobile', 'telephone'],
  account_number: ['account', 'account number', 'account_number', 'account #', 'tenant id', 'tenant_id', 'acct'],
  mailing_address: ['address', 'mailing address', 'mailing_address', 'street'],
  move_in: ['move in', 'move-in', 'move_in', 'move in date', 'move-in date', 'movein'],
  move_out: ['move out', 'move-out', 'move_out', 'move out date', 'move-out date', 'moveout'],
  occupants: ['occupants', 'people', 'number of occupants', 'household size', '# occupants'],
  sqft: ['sqft', 'sq ft', 'square feet', 'square footage', 'sf'],
  bedrooms: ['bedrooms', 'beds', 'br', 'bedroom'],
};

function mapImportRow(raw) {
  const lower = {};
  for (const [k, v] of Object.entries(raw)) lower[String(k).trim().toLowerCase()] = v;
  const out = {};
  for (const [key, aliases] of Object.entries(IMPORT_ALIASES)) {
    for (const a of aliases) if (!blank(lower[a])) { out[key] = String(lower[a]).trim(); break; }
  }
  if (!out.last_name && out.full_name) {
    const n = out.full_name.includes(',')
      ? out.full_name.split(',').map((s) => s.trim()).reverse()
      : out.full_name.split(/\s+/);
    out.last_name = n.length > 1 ? n.slice(-1)[0] : n[0];
    out.first_name ??= n.length > 1 ? n.slice(0, -1).join(' ') : '';
  }
  return out;
}

// Rows are imported in a single D1 batch to stay within per-request query limits.
// Existing tenants (matched by account number) are updated; others are inserted.
async function importTenants(db, payload) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new HttpError(400, 'No rows to import');
  if (rows.length > 500) throw new HttpError(400, 'Import at most 500 rows per request');
  const defaultPropertyId = payload.property_id ? Number(payload.property_id) : null;
  const createUnits = payload.create_units !== false;

  const props = (await db.prepare('SELECT id, name, rm_property_code FROM properties').all()).results;
  const units = (await db.prepare('SELECT id, property_id, unit_number FROM units').all()).results;
  const unitKey = (pid, num) => `${pid}|${String(num).trim().toLowerCase()}`;
  const unitSet = new Set(units.map((u) => unitKey(u.property_id, u.unit_number)));
  const findProperty = (s) => {
    const k = String(s).trim().toLowerCase();
    return props.find((p) => String(p.id) === k || p.name.toLowerCase() === k || (p.rm_property_code || '').toLowerCase() === k);
  };

  const errors = [];
  const stmts = [];
  const newUnits = new Set();
  let count = 0;
  rows.forEach((raw, idx) => {
    const line = idx + 2; // header is line 1
    try {
      const r = mapImportRow(raw);
      const prop = r.property ? findProperty(r.property) : props.find((p) => p.id === defaultPropertyId);
      if (!prop) throw new Error(r.property ? `property "${r.property}" not found` : 'no property given (add a Property column or pick a property)');
      if (!r.unit_number) throw new Error('unit number is missing');
      if (!r.last_name) throw new Error('tenant name is missing');
      const moveIn = coerce('date', r.move_in, 'Move-in');
      if (!moveIn) throw new Error('move-in date is missing');
      const moveOut = coerce('date', r.move_out, 'Move-out');
      if (moveOut && moveOut < moveIn) throw new Error('move-out is before move-in');
      const email = coerce('email', r.email, 'Email');
      const occupants = blank(r.occupants) ? 1 : coerce('int', r.occupants, 'Occupants');

      const key = unitKey(prop.id, r.unit_number);
      if (!unitSet.has(key)) {
        if (!createUnits) throw new Error(`unit ${r.unit_number} does not exist at ${prop.name}`);
        if (!newUnits.has(key)) {
          newUnits.add(key);
          stmts.push(db.prepare('INSERT OR IGNORE INTO units (property_id, unit_number, sqft, bedrooms) VALUES (?, ?, ?, ?)')
            .bind(prop.id, r.unit_number, coerce('num', r.sqft, 'Sq ft') ?? 0, coerce('num', r.bedrooms, 'Bedrooms') ?? 0));
        }
      } else if (!blank(r.sqft) || !blank(r.bedrooms)) {
        // Fill in unit size when the import provides it.
        stmts.push(db.prepare(
          `UPDATE units SET sqft = COALESCE(?, sqft), bedrooms = COALESCE(?, bedrooms)
           WHERE property_id = ? AND unit_number = ? COLLATE NOCASE`,
        ).bind(coerce('num', r.sqft, 'Sq ft'), coerce('num', r.bedrooms, 'Bedrooms'), prop.id, r.unit_number));
      }
      const acct = blank(r.account_number) ? null : r.account_number;
      stmts.push(db.prepare(
        `INSERT INTO tenants (unit_id, first_name, last_name, email, phone, account_number, mailing_address, move_in, move_out, occupants)
         VALUES ((SELECT id FROM units WHERE property_id = ? AND unit_number = ? COLLATE NOCASE), ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_number) DO UPDATE SET
           unit_id = excluded.unit_id, first_name = excluded.first_name, last_name = excluded.last_name,
           email = COALESCE(excluded.email, email), phone = COALESCE(excluded.phone, phone),
           mailing_address = COALESCE(excluded.mailing_address, mailing_address),
           move_in = excluded.move_in, move_out = excluded.move_out, occupants = excluded.occupants`,
      ).bind(prop.id, r.unit_number, r.first_name || null, r.last_name, email, r.phone || null, acct,
        r.mailing_address || null, moveIn, moveOut, occupants));
      count++;
    } catch (e) {
      errors.push({ line, error: e.message });
    }
  });

  if (errors.length && !payload.skip_errors) return { imported: 0, errors, units_created: 0 };
  if (stmts.length) await db.batch(stmts);
  return { imported: count, units_created: newUnits.size, errors };
}

// ---------------------------------------------------------------- exports

// Columns for the Rent Manager charge import: one row per statement line (Water, Sewer, tax, fee).
// Adjust labels/order here to match the import template in your Rent Manager database.
const RM_CHARGE_COLUMNS = [
  { label: 'PropertyCode', value: (r) => r.rm_property_code || r.property_name },
  { label: 'Unit', value: 'unit_number' },
  { label: 'TenantAccount', value: 'account_number' },
  { label: 'TenantName', value: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') },
  { label: 'ChargeType', value: (r) => r.line.charge_code },
  { label: 'Amount', value: (r) => (r.reverse ? '-' : '') + dollars(r.line.amount_cents) },
  { label: 'TransactionDate', value: 'charge_date' },
  { label: 'DueDate', value: 'due_date' },
  { label: 'Comment', value: (r) => `${r.reverse ? 'REVERSAL of ' : ''}${r.line.label} ${r.period_start} to ${r.period_end}` },
  { label: 'PeriodStart', value: 'period_start' },
  { label: 'PeriodEnd', value: 'period_end' },
];

async function exportCharges(db, url) {
  let sql = `SELECT s.id, s.lines, t.first_name, t.last_name, t.account_number, u.unit_number,
               p.name AS property_name, p.rm_property_code, r.period_start, r.period_end, r.charge_date, r.due_date
             FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id JOIN tenants t ON t.id = s.tenant_id
             JOIN units u ON u.id = s.unit_id JOIN properties p ON p.id = r.property_id
             WHERE 1=1`;
  const args = [];
  const p = (k) => url.searchParams.get(k);
  // reverse=1: the same rows with negative amounts, for statements already exported,
  // to back them out of Rent Manager before a batch is deleted or corrected.
  const reverse = p('reverse') === '1';
  sql += reverse ? ' AND s.exported_at IS NOT NULL' : " AND r.status = 'finalized'";
  if (p('run_id')) { sql += ' AND r.id = ?'; args.push(p('run_id')); }
  if (p('property_id')) { sql += ' AND r.property_id = ?'; args.push(p('property_id')); }
  if (p('from')) { sql += ' AND r.charge_date >= ?'; args.push(p('from')); }
  if (p('to')) { sql += ' AND r.charge_date <= ?'; args.push(p('to')); }
  if (p('unexported') === '1') sql += ' AND s.exported_at IS NULL';
  sql += ' ORDER BY p.name, r.period_end, u.unit_number COLLATE NOCASE';
  const statements = (await db.prepare(sql).bind(...args).all()).results;
  const rows = statements.flatMap((s) => JSON.parse(s.lines).map((line) => ({ ...s, line, reverse })));
  if (reverse) return csvResponse(`rent-manager-REVERSAL-${today()}.csv`, toCSV(RM_CHARGE_COLUMNS, rows));
  if (p('mark') === '1' && statements.length) {
    const ids = statements.map((r) => r.id);
    const stmts = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      stmts.push(db.prepare(`UPDATE statements SET exported_at = datetime('now') WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
    }
    await db.batch(stmts);
  }
  return csvResponse(`rent-manager-charges-${today()}.csv`, toCSV(RM_CHARGE_COLUMNS, rows));
}

async function exportTable(db, name, url) {
  const res = RESOURCES[name];
  const rows = await listResource(db, res, url);
  const skip = new Set(['password_hash', 'calc_summary']);
  const cols = rows.length ? Object.keys(rows[0]).filter((k) => !skip.has(k)) : Object.keys(res.fields);
  return csvResponse(`${name}-${today()}.csv`, toCSV(cols.map((c) => ({
    label: c,
    value: c.endsWith('_cents') ? (r) => dollars(r[c] || 0) : c,
  })), rows));
}

// ---------------------------------------------------------------- dashboard

async function adminDashboard(db) {
  const [counts, ytd, recent] = await db.batch([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM properties) AS properties,
      (SELECT COUNT(*) FROM units) AS units,
      (SELECT COALESCE(SUM(COALESCE(p.total_units, (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id))), 0) FROM properties p) AS total_units,
      (SELECT COUNT(DISTINCT u.id) FROM units u JOIN tenants t ON t.unit_id = u.id
         WHERE t.move_in <= date('now') AND (t.move_out IS NULL OR t.move_out >= date('now'))) AS occupied_units,
      (SELECT COUNT(*) FROM tenants WHERE move_in <= date('now') AND (move_out IS NULL OR move_out >= date('now'))) AS current_tenants,
      (SELECT COUNT(*) FROM tenants WHERE move_in > date('now')) AS upcoming_move_ins,
      (SELECT COUNT(*) FROM tenants WHERE move_out BETWEEN date('now') AND date('now','+30 days')) AS move_outs_30d,
      (SELECT COUNT(*) FROM billing_runs WHERE status != 'finalized') AS open_batches,
      (SELECT COUNT(*) FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id JOIN tenants t ON t.id = s.tenant_id
         WHERE r.status = 'finalized' AND s.emailed_at IS NULL AND t.email IS NOT NULL) AS unsent_statements,
      (SELECT COUNT(*) FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
         WHERE r.status = 'finalized' AND s.exported_at IS NULL) AS unexported_statements`),
    db.prepare(`SELECT
      COALESCE((SELECT SUM(b.total_cents) FROM bills b JOIN billing_runs r ON r.id = b.billing_run_id
        WHERE r.status = 'finalized' AND r.period_end >= date('now','start of year')),0) AS city_bills,
      COALESCE((SELECT SUM(s.total_cents) FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
        WHERE r.status = 'finalized' AND r.period_end >= date('now','start of year')),0) AS billed_to_residents`),
    db.prepare(`SELECT r.id, r.period_start, r.period_end, r.status, p.name AS property_name,
      (SELECT COALESCE(SUM(total_cents),0) FROM bills b WHERE b.billing_run_id = r.id) AS city_total_cents,
      (SELECT COALESCE(SUM(total_cents),0) FROM statements s WHERE s.billing_run_id = r.id) AS billed_cents,
      (SELECT COUNT(*) FROM statements s WHERE s.billing_run_id = r.id) AS statement_count,
      (SELECT COUNT(*) FROM statements s WHERE s.billing_run_id = r.id AND s.emailed_at IS NOT NULL) AS emailed_count,
      (SELECT GROUP_CONCAT(pu.utility_name, ', ') FROM bills b JOIN property_utilities pu ON pu.id = b.property_utility_id
         WHERE b.billing_run_id = r.id) AS utilities
      FROM billing_runs r JOIN properties p ON p.id = r.property_id ORDER BY r.created_at DESC LIMIT 8`),
  ]);
  return { counts: counts.results[0], ytd: ytd.results[0], recent_runs: recent.results };
}

// ---------------------------------------------------------------- router

async function handle({ request, env }) {
  const db = env.DB;
  if (!db) throw new HttpError(500, 'D1 database binding "DB" is not configured');
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const seg = path.split('/').slice(2); // after /api

  // ---- auth (public)
  if (seg[0] === 'auth') {
    const action = seg[1];
    if (action === 'status' && method === 'GET') {
      const needsSetup = !(await db.prepare('SELECT 1 FROM admins LIMIT 1').first());
      const s = await getSession(db, request);
      let user = null;
      if (s?.user_type === 'admin') {
        const a = await db.prepare('SELECT id, email, name FROM admins WHERE id = ?').bind(s.user_id).first();
        if (a) user = { type: 'admin', ...a };
      } else if (s?.user_type === 'tenant') {
        const t = await db.prepare('SELECT id, email, first_name, last_name FROM tenants WHERE id = ?').bind(s.user_id).first();
        if (t) user = { type: 'tenant', id: t.id, email: t.email, name: `${t.first_name || ''} ${t.last_name}`.trim() };
      }
      return json({ needsSetup, user });
    }
    if (action === 'setup' && method === 'POST') {
      const b = await body(request);
      if (await db.prepare('SELECT 1 FROM admins LIMIT 1').first()) throw new HttpError(409, 'Setup has already been completed');
      const email = coerce('email', b.email, 'Email');
      if (!email) throw new HttpError(400, 'Email is required');
      validatePassword(b.password);
      const r = await db.prepare('INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
        .bind(email, b.name || null, await hashPassword(b.password)).first();
      const token = await createSession(db, 'admin', r.id);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (action === 'login' && method === 'POST') {
      const b = await body(request);
      const email = String(b.email || '').trim();
      const isAdmin = b.type === 'admin';
      const row = isAdmin
        ? await db.prepare('SELECT id, password_hash FROM admins WHERE email = ?').bind(email).first()
        : await db.prepare('SELECT id, password_hash FROM tenants WHERE email = ? AND password_hash IS NOT NULL ORDER BY move_in DESC LIMIT 1').bind(email).first();
      if (!row || !(await verifyPassword(String(b.password || ''), row.password_hash))) {
        throw new HttpError(401, 'Incorrect email or password');
      }
      const token = await createSession(db, isAdmin ? 'admin' : 'tenant', row.id);
      return json({ ok: true, type: isAdmin ? 'admin' : 'tenant' }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (action === 'activate' && method === 'POST') {
      // Resident sets up portal access using their account number + the email on file.
      const b = await body(request);
      const t = await db.prepare('SELECT id, password_hash FROM tenants WHERE account_number = ? AND email = ?')
        .bind(String(b.account_number || '').trim(), String(b.email || '').trim()).first();
      if (!t) throw new HttpError(400, 'No resident found with that account number and email. Contact the office.');
      if (t.password_hash) throw new HttpError(409, 'This account is already activated. Sign in, or ask the office to reset your access.');
      validatePassword(b.password);
      await db.prepare('UPDATE tenants SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.password), t.id).run();
      const token = await createSession(db, 'tenant', t.id);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
    }
    if (action === 'logout' && method === 'POST') {
      const token = readSessionToken(request);
      if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
    }
    throw new HttpError(404, 'Not found');
  }

  const session = await getSession(db, request);
  if (!session) throw new HttpError(401, 'Please sign in');

  // ---- resident portal
  if (seg[0] === 'resident') {
    if (session.user_type !== 'tenant') throw new HttpError(403, 'Resident access only');
    const tid = session.user_id;
    if (seg[1] === 'me' && method === 'GET') {
      const me = await db.prepare(
        `SELECT t.id, t.first_name, t.last_name, t.email, t.phone, t.account_number, t.mailing_address,
                t.move_in, t.move_out, t.occupants, u.unit_number, u.sqft, u.bedrooms,
                p.name AS property_name, p.address, p.city, p.state, p.zip
         FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id WHERE t.id = ?`,
      ).bind(tid).first();
      const statements = (await db.prepare(
        `SELECT s.id, s.days, s.total_cents, s.lines, r.period_start, r.period_end, r.statement_date, r.due_date
         FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
         WHERE s.tenant_id = ? AND r.status = 'finalized' ORDER BY r.period_end DESC, s.id DESC`,
      ).bind(tid).all()).results;
      const charges = (await db.prepare(
        `SELECT c.statement_id, c.days, c.period_days, c.share_cents, c.tax_cents, c.detail, b.total_cents AS bill_total_cents, pu.utility_name
         FROM charges c JOIN bills b ON b.id = c.bill_id JOIN property_utilities pu ON pu.id = b.property_utility_id
         JOIN billing_runs r ON r.id = b.billing_run_id
         WHERE c.tenant_id = ? AND r.status = 'finalized' ORDER BY pu.sort_order, pu.id`,
      ).bind(tid).all()).results;
      const out = statements.map((s) => ({
        ...s, lines: JSON.parse(s.lines),
        charges: charges.filter((c) => c.statement_id === s.id).map((c) => ({ ...c, detail: c.detail ? JSON.parse(c.detail) : null })),
      }));
      return json({ me, statements: out });
    }
    if (seg[1] === 'statements' && seg[3] === 'pdf' && method === 'GET') {
      const [s] = await statementRenderData(db, { statementId: seg[2], tenantId: tid, onlyFinalized: true });
      if (!s) throw new HttpError(404, 'Statement not found');
      return pdfResponse(s);
    }
    if (seg[1] === 'profile' && method === 'PUT') {
      const b = await body(request);
      // Email is the login and is managed by the office, so residents can only change their phone.
      await db.prepare('UPDATE tenants SET phone = ? WHERE id = ?').bind(coerce('text', b.phone, 'Phone'), tid).run();
      return json({ ok: true });
    }
    if (seg[1] === 'password' && method === 'PUT') {
      const b = await body(request);
      const t = await db.prepare('SELECT password_hash FROM tenants WHERE id = ?').bind(tid).first();
      if (!(await verifyPassword(String(b.current_password || ''), t.password_hash))) throw new HttpError(400, 'Current password is incorrect');
      validatePassword(b.new_password);
      await db.prepare('UPDATE tenants SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.new_password), tid).run();
      return json({ ok: true });
    }
    throw new HttpError(404, 'Not found');
  }

  // ---- admin
  if (seg[0] !== 'admin') throw new HttpError(404, 'Not found');
  if (session.user_type !== 'admin') throw new HttpError(403, 'Admin access only');
  const [, name, id, action] = seg;

  if (name === 'dashboard' && method === 'GET') return json(await adminDashboard(db));

  if (name === 'export') {
    if (id === 'charges.csv') return exportCharges(db, url);
    const t = id?.replace(/\.csv$/, '');
    if (RESOURCES[t]) return exportTable(db, t, url);
    throw new HttpError(404, 'Unknown export');
  }

  if (name === 'tenants' && id === 'import' && method === 'POST') return json(await importTenants(db, await body(request)));
  if (name === 'tenants' && id && action === 'reset-portal' && method === 'POST') {
    await db.batch([
      db.prepare('UPDATE tenants SET password_hash = NULL WHERE id = ?').bind(id),
      db.prepare("DELETE FROM sessions WHERE user_type = 'tenant' AND user_id = ?").bind(id),
    ]);
    return json({ ok: true });
  }

  // ---- billing batches
  if (name === 'runs') {
    if (method === 'GET' && !id) return json(await listRuns(db, url));
    if (method === 'GET' && id && !action) return json(await runDetail(db, id));
    if (method === 'GET' && id && action === 'pdf-data') return json(await statementRenderData(db, { runId: id }));
    if (method === 'POST' && !id) return json(await runDetail(db, await createRun(db, await body(request))), 201);
    if (method === 'PUT' && id) { await updateRun(db, id, await body(request)); return json(await runDetail(db, id)); }
    if (method === 'DELETE' && id) return json(await deleteRun(db, id, url.searchParams.get('confirm')));
    if (method === 'POST' && action === 'calculate') return json(await calculateRun(db, id));
    if (method === 'POST' && (action === 'finalize' || action === 'reopen')) return json(await setRunStatus(db, id, action));
    throw new HttpError(404, 'Not found');
  }
  if (name === 'statements' && id) {
    if (method === 'GET' && action === 'pdf') {
      const [s] = await statementRenderData(db, { statementId: id });
      if (!s) throw new HttpError(404, 'Statement not found');
      return pdfResponse(s);
    }
    if (method === 'POST' && action === 'email') return json(await emailStatement(db, id));
  }

  // ---- settings
  if (name === 'settings') {
    if (method === 'GET' && !id) return json(await loadSettings(db));
    if (method === 'PUT' && !id) return json(await saveSettings(db, await body(request)));
    if (method === 'POST' && id === 'test-email') return json(await sendTestEmail(db, (await body(request)).to));
  }

  if (name === 'admins') {
    if (method === 'GET' && !id) return json((await db.prepare('SELECT id, email, name, created_at FROM admins ORDER BY email').all()).results);
    if (method === 'POST' && !id) {
      const b = await body(request);
      const email = coerce('email', b.email, 'Email');
      if (!email) throw new HttpError(400, 'Email is required');
      validatePassword(b.password);
      await db.prepare('INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?)').bind(email, b.name || null, await hashPassword(b.password)).run();
      return json({ ok: true });
    }
    if (method === 'PUT' && id === 'me' && action === 'password') {
      const b = await body(request);
      const a = await db.prepare('SELECT password_hash FROM admins WHERE id = ?').bind(session.user_id).first();
      if (!(await verifyPassword(String(b.current_password || ''), a.password_hash))) throw new HttpError(400, 'Current password is incorrect');
      validatePassword(b.new_password);
      await db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.new_password), session.user_id).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) {
      if (Number(id) === session.user_id) throw new HttpError(400, 'You cannot delete your own account');
      await db.batch([
        db.prepare('DELETE FROM admins WHERE id = ?').bind(id),
        db.prepare("DELETE FROM sessions WHERE user_type = 'admin' AND user_id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
  }

  const res = RESOURCES[name];
  if (!res) throw new HttpError(404, 'Not found');
  if (method === 'GET' && !id) return json(await listResource(db, res, url));
  if (method === 'GET' && id) return json(await getOne(db, res, id));
  if (method === 'POST' && !id) return json(await createResource(db, name, await body(request)), 201);
  if (method === 'PUT' && id) return json(await updateResource(db, name, id, await body(request)));
  if (method === 'DELETE' && id) return json(await deleteResource(db, name, id));
  throw new HttpError(405, 'Method not allowed');
}

export async function onRequest(context) {
  try {
    return await handle(context);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    const msg = String(e?.message || e);
    if (/FOREIGN KEY/i.test(msg)) return json({ error: 'This record is linked to other records (units, tenants, bills or charges) and cannot be deleted. For tenants, set a move-out date instead.' }, 409);
    if (/UNIQUE/i.test(msg)) {
      const field = /UNIQUE constraint failed: \w+\.(\w+)/.exec(msg)?.[1];
      return json({ error: field === 'account_number' ? 'That account number is already used by another tenant.' : field === 'email' ? 'That email is already in use.' : field === 'unit_number' ? 'That unit number already exists at this property.' : 'A record with these values already exists.' }, 409);
    }
    console.error(e);
    return json({ error: 'Server error: ' + msg }, 500);
  }
}
