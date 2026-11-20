// Single API router for Cloudflare Pages Functions. Handles every /api/* request.
// D1 database binding name: DB (see wrangler.toml).

import { calculateRubs, parseDate } from '../../lib/rubs.js';
import { toCSV, csvResponse, dollars } from '../../lib/csv.js';
import {
  hashPassword, verifyPassword, validatePassword, createSession, sessionCookie,
  getSession, readSessionToken, HttpError,
} from '../../lib/auth.js';

// ---------------------------------------------------------------- helpers

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

async function body(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON body');
  }
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const today = () => new Date().toISOString().slice(0, 10);
const blank = (v) => v === undefined || v === null || String(v).trim() === '';

// Field types used to validate and clean user input.
function coerce(type, value, label) {
  if (blank(value)) return null;
  switch (type) {
    case 'text': return String(value).trim().slice(0, 2000);
    case 'email': {
      const s = String(value).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, `${label}: invalid email "${s}"`);
      return s;
    }
    case 'date': {
      const s = normalizeDate(value);
      if (!s) throw new HttpError(400, `${label}: invalid date "${value}" (use YYYY-MM-DD or MM/DD/YYYY)`);
      return s;
    }
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new HttpError(400, `${label}: must be a number`);
      return Math.round(n);
    }
    case 'num': {
      const n = Number(String(value).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new HttpError(400, `${label}: must be a number`);
      return n;
    }
    case 'bool': return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
    default:
      if (Array.isArray(type)) {
        if (!type.includes(value)) throw new HttpError(400, `${label}: must be one of ${type.join(', ')}`);
        return value;
      }
      throw new Error('Unknown field type ' + type);
  }
}

// Accepts YYYY-MM-DD, M/D/YYYY, M/D/YY.
function normalizeDate(v) {
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y, mo, d;
  if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    [mo, d, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- resources (admin CRUD)

const RESOURCES = {
  properties: {
    table: 'properties',
    fields: {
      name: ['text', 'Property name', true], rm_property_code: ['text', 'Rent Manager property code'],
      address: ['text', 'Address'], city: ['text', 'City'], state: ['text', 'State'], zip: ['text', 'ZIP'],
      notes: ['text', 'Notes'],
    },
    list: `SELECT p.*,
             (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id) AS unit_count,
             (SELECT COUNT(*) FROM tenants t JOIN units u ON u.id = t.unit_id
                WHERE u.property_id = p.id AND t.move_in <= date('now')
                  AND (t.move_out IS NULL OR t.move_out >= date('now'))) AS current_tenants
           FROM properties p WHERE 1=1`,
    filters: { id: 'p.id' },
    search: ['p.name', 'p.address', 'p.rm_property_code'],
    order: 'p.name',
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
      admin_fee_cents: ['int', 'Admin fee'], active: ['bool', 'Active'], notes: ['text', 'Notes'],
    },
    list: `SELECT pu.*, p.name AS property_name FROM property_utilities pu
           JOIN properties p ON p.id = pu.property_id WHERE 1=1`,
    filters: { property_id: 'pu.property_id', id: 'pu.id' },
    search: ['pu.utility_name', 'p.name'],
    order: 'p.name, pu.utility_name',
    validate: (r) => {
      if (r.recovery_pct != null && (r.recovery_pct < 0 || r.recovery_pct > 100)) throw new HttpError(400, 'Recovery % must be between 0 and 100');
      for (const k of ['w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal']) {
        if (r[k] != null && r[k] < 0) throw new HttpError(400, 'Weights cannot be negative');
      }
    },
  },
  bills: {
    table: 'bills',
    fields: {
      property_id: ['int', 'Property', true], property_utility_id: ['int', 'Utility', true],
      vendor: ['text', 'Utility company'], vendor_account: ['text', 'Utility account #'],
      period_start: ['date', 'Service period start', true], period_end: ['date', 'Service period end', true],
      total_cents: ['int', 'Bill total', true], statement_date: ['date', 'Statement date'],
      charge_date: ['date', 'Charge date'], notes: ['text', 'Notes'],
    },
    list: `SELECT b.id, b.property_id, b.property_utility_id, b.vendor, b.vendor_account, b.period_start,
             b.period_end, b.total_cents, b.statement_date, b.charge_date, b.status, b.notes, b.created_at,
             p.name AS property_name, pu.utility_name, pu.rm_charge_code,
             (SELECT COUNT(*) FROM charges c WHERE c.bill_id = b.id) AS charge_count,
             (SELECT COALESCE(SUM(amount_cents),0) FROM charges c WHERE c.bill_id = b.id) AS charged_cents
           FROM bills b JOIN properties p ON p.id = b.property_id
           JOIN property_utilities pu ON pu.id = b.property_utility_id WHERE 1=1`,
    filters: { property_id: 'b.property_id', status: 'b.status', id: 'b.id' },
    search: ['p.name', 'pu.utility_name', 'b.vendor'],
    order: 'b.period_end DESC, b.id DESC',
    validate: (r) => {
      if (r.period_end && r.period_start && r.period_end < r.period_start) throw new HttpError(400, 'Service period end is before the start');
      if (r.total_cents != null && r.total_cents < 0) throw new HttpError(400, 'Bill total cannot be negative');
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

async function checkBillRefs(db, data, existing) {
  const propertyId = data.property_id ?? existing?.property_id;
  const utilId = data.property_utility_id ?? existing?.property_utility_id;
  const u = await db.prepare('SELECT property_id FROM property_utilities WHERE id = ?').bind(utilId).first();
  if (!u || u.property_id !== Number(propertyId)) throw new HttpError(400, 'That utility does not belong to the selected property');
}

async function createResource(db, name, input) {
  const res = RESOURCES[name];
  const data = cleanInput(res, input, false);
  if (name === 'bills') {
    await checkBillRefs(db, data);
    data.charge_date ??= today();
  }
  if (name === 'utilities') {
    data.recovery_pct ??= 100;
    data.vacancy_mode ??= 'owner';
    data.vacant_occupants ??= 1;
    data.admin_fee_cents ??= 0;
    data.active ??= 1;
    for (const k of ['w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal']) data[k] ??= 0;
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
  for (const k of ['sqft', 'bedrooms', 'bathrooms', 'occupants', 'recovery_pct', 'w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal', 'vacant_occupants', 'admin_fee_cents', 'active']) {
    if (k in data && data[k] === null) data[k] = 0;
  }
  if ('recovery_pct' in input && blank(input.recovery_pct)) data.recovery_pct = 100;
  const stmts = [];
  if (name === 'bills') {
    if (existing.status === 'posted') throw new HttpError(409, 'This bill is posted. Unpost it before editing.');
    await checkBillRefs(db, data, existing);
    // Any edit invalidates a previous calculation.
    stmts.push(db.prepare('DELETE FROM charges WHERE bill_id = ?').bind(id));
    data.status = 'draft';
    data.calc_summary = null;
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
  if (name === 'bills') {
    const b = await db.prepare('SELECT status FROM bills WHERE id = ?').bind(id).first();
    if (b?.status === 'posted') throw new HttpError(409, 'This bill is posted. Unpost it before deleting.');
  }
  if (name === 'utilities') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM bills WHERE property_utility_id = ?').bind(id).first();
    if (n.n > 0) throw new HttpError(409, 'This utility has bills. Mark it inactive instead of deleting it.');
  }
  const r = await db.prepare(`DELETE FROM ${res.table} WHERE id = ?`).bind(id).run();
  if (!r.meta.changes) throw new HttpError(404, 'Not found');
  return { ok: true };
}

// ---------------------------------------------------------------- RUBS calculation

async function loadCalcInputs(db, billId) {
  const bill = await db.prepare('SELECT * FROM bills WHERE id = ?').bind(billId).first();
  if (!bill) throw new HttpError(404, 'Bill not found');
  const config = await db.prepare('SELECT * FROM property_utilities WHERE id = ?').bind(bill.property_utility_id).first();
  const units = (await db.prepare('SELECT id, unit_number, sqft, bedrooms FROM units WHERE property_id = ?').bind(bill.property_id).all()).results;
  const tenants = (await db.prepare(
    `SELECT t.id, t.unit_id, t.move_in, t.move_out, t.occupants FROM tenants t JOIN units u ON u.id = t.unit_id
     WHERE u.property_id = ? AND t.move_in <= ? AND (t.move_out IS NULL OR t.move_out >= ?)`,
  ).bind(bill.property_id, bill.period_end, bill.period_start).all()).results;
  return { bill, config, units, tenants };
}

async function calculateBill(db, billId) {
  const { bill, config, units, tenants } = await loadCalcInputs(db, billId);
  if (bill.status === 'posted') throw new HttpError(409, 'This bill is posted. Unpost it to recalculate.');
  if (!units.length) throw new HttpError(400, 'This property has no units yet');
  let result;
  try {
    result = calculateRubs({
      totalCents: bill.total_cents, periodStart: bill.period_start, periodEnd: bill.period_end,
      config, units, tenants,
    });
  } catch (e) { throw new HttpError(400, e.message); }

  const summary = { ...result.summary, utility_name: config.utility_name, calculated_at: new Date().toISOString() };
  const stmts = [db.prepare('DELETE FROM charges WHERE bill_id = ?').bind(billId)];
  for (const l of result.lines) {
    stmts.push(db.prepare(
      `INSERT INTO charges (bill_id, tenant_id, unit_id, days, period_days, share_cents, admin_fee_cents, amount_cents, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(billId, l.tenant_id, l.unit_id, l.days, l.period_days, l.share_cents, l.admin_fee_cents, l.amount_cents, JSON.stringify(l.detail)));
  }
  stmts.push(db.prepare("UPDATE bills SET status = 'calculated', calc_summary = ? WHERE id = ?").bind(JSON.stringify(summary), billId));
  await db.batch(stmts);
  return billDetail(db, billId);
}

async function billDetail(db, billId) {
  const bill = await getOne(db, RESOURCES.bills, billId);
  const full = await db.prepare('SELECT calc_summary FROM bills WHERE id = ?').bind(billId).first();
  bill.summary = full.calc_summary ? JSON.parse(full.calc_summary) : null;
  bill.charges = (await db.prepare(
    `SELECT c.*, t.first_name, t.last_name, t.account_number, t.move_in, t.move_out, t.occupants,
            u.unit_number, u.sqft, u.bedrooms
     FROM charges c JOIN tenants t ON t.id = c.tenant_id JOIN units u ON u.id = c.unit_id
     WHERE c.bill_id = ? ORDER BY u.unit_number COLLATE NOCASE, t.move_in`,
  ).bind(billId).all()).results.map((c) => ({ ...c, detail: c.detail ? JSON.parse(c.detail) : null }));
  return bill;
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

// Columns for the Rent Manager charge import. Adjust labels/order here to match
// the import template configured in your Rent Manager database.
const RM_CHARGE_COLUMNS = [
  { label: 'PropertyCode', value: (r) => r.rm_property_code || r.property_name },
  { label: 'Unit', value: 'unit_number' },
  { label: 'TenantAccount', value: 'account_number' },
  { label: 'TenantName', value: (r) => [r.first_name, r.last_name].filter(Boolean).join(' ') },
  { label: 'ChargeType', value: (r) => r.rm_charge_code || r.utility_name },
  { label: 'Amount', value: (r) => dollars(r.amount_cents) },
  { label: 'TransactionDate', value: (r) => r.charge_date || today() },
  { label: 'Comment', value: (r) => `${r.utility_name} ${r.period_start} to ${r.period_end} (${r.days}/${r.period_days} days)` },
  { label: 'PeriodStart', value: 'period_start' },
  { label: 'PeriodEnd', value: 'period_end' },
  { label: 'UtilityShare', value: (r) => dollars(r.share_cents) },
  { label: 'AdminFee', value: (r) => dollars(r.admin_fee_cents) },
];

async function exportCharges(db, url) {
  let sql = `SELECT c.*, t.first_name, t.last_name, t.account_number, u.unit_number,
               p.name AS property_name, p.rm_property_code, pu.utility_name, pu.rm_charge_code,
               b.period_start, b.period_end, b.charge_date, b.status
             FROM charges c JOIN bills b ON b.id = c.bill_id JOIN tenants t ON t.id = c.tenant_id
             JOIN units u ON u.id = c.unit_id JOIN properties p ON p.id = b.property_id
             JOIN property_utilities pu ON pu.id = b.property_utility_id WHERE 1=1`;
  const args = [];
  const p = (k) => url.searchParams.get(k);
  if (p('bill_id')) { sql += ' AND b.id = ?'; args.push(p('bill_id')); }
  if (p('property_id')) { sql += ' AND b.property_id = ?'; args.push(p('property_id')); }
  if (p('from')) { sql += ' AND b.charge_date >= ?'; args.push(p('from')); }
  if (p('to')) { sql += ' AND b.charge_date <= ?'; args.push(p('to')); }
  if (p('status') !== 'all') sql += " AND b.status = 'posted'";
  if (p('unexported') === '1') sql += ' AND c.exported_at IS NULL';
  sql += ' ORDER BY p.name, u.unit_number COLLATE NOCASE, pu.utility_name';
  const rows = (await db.prepare(sql).bind(...args).all()).results;
  if (p('mark') === '1' && rows.length) {
    const now = new Date().toISOString();
    const ids = rows.map((r) => r.id);
    const stmts = [];
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      stmts.push(db.prepare(`UPDATE charges SET exported_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(now, ...chunk));
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
  const [counts, billing, recent] = await db.batch([
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM properties) AS properties,
      (SELECT COUNT(*) FROM units) AS units,
      (SELECT COUNT(*) FROM tenants WHERE move_in <= date('now') AND (move_out IS NULL OR move_out >= date('now'))) AS current_tenants,
      (SELECT COUNT(*) FROM tenants WHERE move_in > date('now')) AS upcoming_move_ins,
      (SELECT COUNT(*) FROM tenants WHERE move_out BETWEEN date('now') AND date('now','+30 days')) AS move_outs_30d,
      (SELECT COUNT(*) FROM bills WHERE status != 'posted') AS open_bills,
      (SELECT COUNT(*) FROM charges c JOIN bills b ON b.id = c.bill_id WHERE b.status = 'posted' AND c.exported_at IS NULL) AS unexported_charges`),
    db.prepare(`SELECT COALESCE(SUM(b.total_cents),0) AS billed_by_utilities,
      COALESCE((SELECT SUM(c.amount_cents) FROM charges c JOIN bills b2 ON b2.id = c.bill_id
                WHERE b2.status = 'posted' AND b2.period_end >= date('now','start of year')),0) AS charged_to_residents
      FROM bills b WHERE b.status = 'posted' AND b.period_end >= date('now','start of year')`),
    db.prepare(`${RESOURCES.bills.list} ORDER BY b.created_at DESC LIMIT 8`),
  ]);
  return { counts: counts.results[0], ytd: billing.results[0], recent_bills: recent.results };
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
      const charges = (await db.prepare(
        `SELECT c.id, c.days, c.period_days, c.share_cents, c.admin_fee_cents, c.amount_cents, c.detail,
                b.period_start, b.period_end, b.charge_date, b.total_cents AS bill_total_cents, pu.utility_name
         FROM charges c JOIN bills b ON b.id = c.bill_id JOIN property_utilities pu ON pu.id = b.property_utility_id
         WHERE c.tenant_id = ? AND b.status = 'posted' ORDER BY b.period_end DESC, pu.utility_name`,
      ).bind(tid).all()).results.map((c) => ({ ...c, detail: c.detail ? JSON.parse(c.detail) : null }));
      return json({ me, charges });
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

  if (name === 'bills' && id && method === 'POST') {
    if (action === 'calculate') return json(await calculateBill(db, id));
    if (action === 'post') {
      const b = await db.prepare('SELECT status FROM bills WHERE id = ?').bind(id).first();
      if (b?.status !== 'calculated') throw new HttpError(409, 'Calculate the bill before posting it');
      await db.prepare("UPDATE bills SET status = 'posted' WHERE id = ?").bind(id).run();
      return json(await billDetail(db, id));
    }
    if (action === 'unpost') {
      await db.prepare("UPDATE bills SET status = 'calculated' WHERE id = ? AND status = 'posted'").bind(id).run();
      return json(await billDetail(db, id));
    }
  }
  if (name === 'bills' && id && method === 'GET') return json(await billDetail(db, id));

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
