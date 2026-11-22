// Single API router for Cloudflare Pages Functions. Handles every /api/* request.
// D1 database binding name: DB (see wrangler.toml).

import { toCSV, csvResponse, dollars } from '../../lib/csv.js';
import {
  hashPassword, verifyPassword, createSession, sessionCookie, hashIterations, storedIterations,
  getSession, readSessionToken,
} from '../../lib/auth.js';
import { HttpError, json, body, today, blank, coerce } from '../../lib/util.js';
import { loadSettings, saveSettings, sendTestEmail } from '../../lib/settings.js';
import { systemInfo, backupPage, getPlan, setPlan } from '../../lib/system.js';
import {
  loadSecurity, saveSecurity, validatePassword, clientIp, checkLockout, recordAttempt, signInActivity, clearLockouts,
  createAltchaChallenge, verifyAltcha,
} from '../../lib/security.js';
import {
  listRuns, runDetail, createRun, updateRun, deleteRun, calculateRun, setRunStatus, testUtility,
  statementRenderData, pdfResponse, emailStatement,
} from '../../lib/billing.js';

// ---------------------------------------------------------------- resources (admin CRUD)

const RESOURCES = {
  properties: {
    table: 'properties',
    fields: {
      name: ['text', 'Property name', true], rm_property_code: ['text', 'Rent Manager property code'],
      total_units: ['int', 'Total units'],
      active: ['bool', 'Active'], inactive_date: ['date', 'Inactive since'], inactive_reason: ['text', 'Reason'],
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
    filters: { id: 'x.id', active: 'x.active' },
    search: ['x.name', 'x.address', 'x.rm_property_code'],
    order: 'x.active DESC, x.name',
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
      forwarding_address: ['text', 'Forwarding address'],
    },
    // final_pending: moved out (within the last 90 days) but no finalized billing batch covers the
    // move-out date yet, so their final bill still has to be produced.
    list: `SELECT t.id, t.unit_id, t.first_name, t.last_name, t.email, t.phone, t.account_number,
             t.mailing_address, t.forwarding_address, t.move_in, t.move_out, t.occupants, t.notes, t.created_at,
             (t.password_hash IS NOT NULL) AS portal_active, t.activated_at, t.last_login_at, t.last_login_ip, t.locked_at, t.locked_reason,
             (t.move_out IS NOT NULL AND t.move_out <= date('now') AND t.move_out >= date('now', '-90 days')
               AND NOT EXISTS (SELECT 1 FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
                 WHERE s.tenant_id = t.id AND r.status = 'finalized' AND r.period_end >= t.move_out)) AS final_pending,
             u.unit_number, u.property_id, u.sqft, u.bedrooms, p.name AS property_name,
             CASE WHEN t.move_in > date('now') THEN 'future'
                  WHEN t.move_out IS NOT NULL AND t.move_out < date('now') THEN 'past'
                  ELSE 'current' END AS status
           FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id WHERE 1=1`,
    filters: { property_id: 'u.property_id', unit_id: 't.unit_id', id: 't.id', property_active: 'p.active' },
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
      statement_label: ['text', 'Show on statement as'], charge_method: [['rubs', 'flat'], 'How it is charged'],
      allocation_mode: [['even_all', 'even_occupied', 'factors'], 'Allocation'], w_bathrooms: ['num', 'Bathrooms weight'],
      sqft_scope: [['all', 'occupied'], 'Square footage of'], bedrooms_scope: [['all', 'occupied'], 'Bedrooms of'],
      bathrooms_scope: [['all', 'occupied'], 'Bathrooms of'],
      occupancy_weighting: [['headcount', 'cap2', 'half', 'conservice'], 'Occupancy weighting'],
      flat_amount_cents: ['int', 'Fixed amount'], flat_prorate: ['bool', 'Prorate by days'],
      active: ['bool', 'Active'], notes: ['text', 'Notes'],
    },
    list: `SELECT pu.*, p.name AS property_name FROM property_utilities pu
           JOIN properties p ON p.id = pu.property_id WHERE 1=1`,
    filters: { property_id: 'pu.property_id', id: 'pu.id' },
    search: ['pu.utility_name', 'p.name'],
    order: 'p.name, pu.sort_order, pu.id',
    validate: (r) => {
      if (r.tax_pct != null && (r.tax_pct < 0 || r.tax_pct > 100)) throw new HttpError(400, 'Tax % must be between 0 and 100');
      if (r.charge_method === 'flat' && !(r.flat_amount_cents > 0)) throw new HttpError(400, 'Enter the fixed amount charged to each resident');
      if (r.charge_method !== 'flat' && r.allocation_mode === 'factors') {
        // Like Rent Manager: the active allocation factors must add up to 100%.
        const total = ['w_occupants', 'w_sqft', 'w_bedrooms', 'w_bathrooms'].reduce((t, k) => t + (Number(r[k]) || 0), 0);
        if (total <= 0) throw new HttpError(400, 'Turn on at least one allocation factor');
        if (Math.abs(total - 100) > 0.01) throw new HttpError(400, `The allocation factors add up to ${Math.round(total * 100) / 100}%. They must total 100%.`);
      }
      if (r.flat_amount_cents != null && r.flat_amount_cents < 0) throw new HttpError(400, 'Fixed amount cannot be negative');
      if (r.recovery_pct != null && (r.recovery_pct < 0 || r.recovery_pct > 100)) throw new HttpError(400, 'Recovery % must be between 0 and 100');
      for (const k of ['w_sqft', 'w_bedrooms', 'w_bathrooms', 'w_occupants', 'w_equal']) {
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
  if (res.table === 'tenants' && ['current', 'past', 'future', 'final_pending', 'signed_up', 'not_signed_up'].includes(status)) {
    const special = { final_pending: 'final_pending = 1', signed_up: 'portal_active = 1', not_signed_up: 'portal_active = 0' };
    sql = special[status] ? `SELECT * FROM (${sql}) WHERE ${special[status]}` : `SELECT * FROM (${sql}) WHERE status = ?`;
    if (!special[status]) args.push(status);
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
    data.charge_method ??= 'rubs';
    data.flat_amount_cents ??= 0;
    data.flat_prorate ??= 1;
    data.active ??= 1;
    for (const k of ['w_sqft', 'w_bedrooms', 'w_bathrooms', 'w_occupants', 'w_equal']) data[k] ??= 0;
    data.allocation_mode ??= 'factors';
    for (const k of ['sqft_scope', 'bedrooms_scope', 'bathrooms_scope']) data[k] ??= 'all';
    data.occupancy_weighting ??= 'headcount';
    if (data.sort_order === null) {
      const m = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM property_utilities WHERE property_id = ?').bind(data.property_id).first();
      data.sort_order = m.n;
    }
  }
  if (name === 'properties') {
    for (const k of ['due_days', 'day_count', 'tax_label', 'billing_fee_cents', 'fee_label']) if (data[k] === null) delete data[k];
    data.active = data.active === 0 ? 0 : 1;
    if (data.active) { data.inactive_date = null; data.inactive_reason = null; } else data.inactive_date ??= today();
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
  for (const k of ['sqft', 'bedrooms', 'bathrooms', 'occupants', 'recovery_pct', 'w_sqft', 'w_bedrooms', 'w_occupants', 'w_equal', 'vacant_occupants', 'admin_fee_cents', 'tax_pct', 'sort_order', 'flat_amount_cents', 'w_bathrooms', 'active']) {
    if (k in data && data[k] === null) data[k] = 0;
  }
  if ('recovery_pct' in input && blank(input.recovery_pct)) data.recovery_pct = 100;
  const stmts = [];
  if (name === 'properties') {
    if ('active' in data) {
      // Reactivating clears the inactive date/reason; deactivating defaults the date to today.
      if (data.active) { data.inactive_date = null; data.inactive_reason = null; }
      else data.inactive_date = data.inactive_date ?? existing.inactive_date ?? today();
    }
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

// Import column definitions. Used both to read CSV files and to show the column guide in the
// import window (GET /api/admin/import-columns), so the two never disagree.
// required: true = must be in the file; a string = required in that situation.
const PROPERTY_COLUMN = {
  key: 'property', name: 'Property', required: true,
  aliases: ['property', 'property code', 'property_code', 'property short name', 'short name', 'shortname', 'rm_property_code', 'rm code', 'property id'],
  example: 'cwa',
  help: "The property's short name: its Rent Manager property code, as entered in Edit property. Needed on every row.",
};

/** Finds a property by its short name (Rent Manager code), ignoring case. Throws a row error if not found. */
function propertyByCode(props, value) {
  if (blank(value)) throw new Error('property short name is missing');
  const k = String(value).trim().toLowerCase();
  const p = props.find((x) => (x.rm_property_code || '').trim().toLowerCase() === k);
  if (p) return p;
  const byName = props.find((x) => x.name.trim().toLowerCase() === k);
  if (byName) throw new Error(`"${value}" is a property name; use its short name${byName.rm_property_code ? ` "${byName.rm_property_code}"` : ' (set one in Edit property first)'}`);
  throw new Error(`no property has the short name "${value}"`);
}

const TENANT_COLUMNS = [
  PROPERTY_COLUMN,
  { key: 'unit_number', name: 'Unit', required: true, aliases: ['unit', 'unit number', 'unit_number', 'unit #', 'unit no', 'apt'],
    example: '100B', help: "Units that don't exist yet are created automatically (unless you untick that option)." },
  { key: 'first_name', name: 'First Name', required: false, aliases: ['first name', 'first_name', 'firstname', 'first'], example: 'Paul' },
  { key: 'last_name', name: 'Last Name', required: 'Yes, unless you use a Name column', aliases: ['last name', 'last_name', 'lastname', 'last'], example: 'Ianazzo' },
  { key: 'full_name', name: 'Name', required: 'Instead of First Name + Last Name', aliases: ['name', 'tenant name', 'tenant', 'full name', 'resident', 'resident name'],
    example: 'Ianazzo, Paul  or  Paul Ianazzo', help: 'Used only when there is no Last Name column.' },
  { key: 'email', name: 'Email', required: false, aliases: ['email', 'email address', 'e-mail'], example: 'paul@example.com',
    help: 'Needed to email statements and for the resident portal.' },
  { key: 'phone', name: 'Phone', required: false, aliases: ['phone', 'phone number', 'cell', 'mobile', 'telephone'], example: '(850) 555-0123' },
  { key: 'account_number', name: 'Account Number', required: true, aliases: ['account', 'account number', 'account_number', 'account #', 'tenant id', 'tenant_id', 'acct'],
    example: '33580', help: 'Rent Manager tenant account, needed on every row and unique per tenant. Re-importing updates the tenant with the same account number instead of adding a duplicate.' },
  { key: 'mailing_address', name: 'Address', required: false, aliases: ['address', 'mailing address', 'mailing_address', 'street'],
    example: '810 Wadsworth St Apt #100B, Tallahassee, FL 32304', help: "Printed on statements. Leave blank to use the property's address and unit." },
  { key: 'move_in', name: 'Move In', required: true, aliases: ['move in', 'move-in', 'move_in', 'move in date', 'move-in date', 'movein'],
    example: '08/01/2025  or  2025-08-01' },
  { key: 'move_out', name: 'Move Out', required: false, aliases: ['move out', 'move-out', 'move_out', 'move out date', 'move-out date', 'moveout'],
    example: '07/31/2026', help: 'Leave blank for current residents.' },
  { key: 'occupants', name: 'Occupants', required: false, aliases: ['occupants', 'people', 'number of occupants', 'household size', '# occupants'],
    example: '2', help: 'Number of people in the unit. Defaults to 1.' },
  { key: 'sqft', name: 'Sq Ft', required: false, aliases: ['sqft', 'sq ft', 'square feet', 'square footage', 'sf'], example: '850',
    help: "Fills in the unit's square footage." },
  { key: 'bedrooms', name: 'Bedrooms', required: false, aliases: ['bedrooms', 'beds', 'br', 'bedroom'], example: '2',
    help: "Fills in the unit's bedrooms." },
];

const UNIT_COLUMNS = [
  PROPERTY_COLUMN,
  { key: 'unit_number', name: 'Unit', required: true,
    aliases: ['unit', 'unit number', 'unit_number', 'unit #', 'unit no', 'unit name', 'unit_name', 'unitname', 'unit id', 'apt', 'apt #', 'apartment'],
    example: '100B', help: 'An existing unit with the same number (upper/lower case ignored) is updated.' },
  { key: 'sqft', name: 'Sq Ft', required: 'Needed if you split by square footage',
    aliases: ['sqft', 'sq ft', 'sq. ft.', 'sq.ft.', 'square feet', 'square_feet', 'square footage', 'sf', 'size', 'unit size'],
    example: '1,050  or  850 sq ft' },
  { key: 'bedrooms', name: 'Bedrooms', required: 'Needed if you split by bedrooms', aliases: ['bedrooms', 'bedroom', 'beds', 'bed', 'br', 'bd'], example: '2' },
  { key: 'bathrooms', name: 'Bathrooms', required: false, aliases: ['bathrooms', 'bathroom', 'baths', 'bath', 'ba'], example: '1.5' },
  { key: 'notes', name: 'Notes', required: false, aliases: ['notes', 'note', 'comments', 'unit type', 'type', 'floorplan', 'floor plan'], example: '2x1 corner unit' },
];

const aliasMap = (cols) => Object.fromEntries(cols.map((c) => [c.key, c.aliases]));
const IMPORT_ALIASES = aliasMap(TENANT_COLUMNS);

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

// ---- unit import
const UNIT_ALIASES = aliasMap(UNIT_COLUMNS);

// ---- import history (undo) and bulk delete

// One CSV file may be sent in several chunks; the first chunk creates the import record and
// later chunks pass its import_id so everything from one file belongs to one import.
async function openImportBatch(db, kind, payload, adminId) {
  if (payload.import_id) {
    const b = await db.prepare('SELECT id FROM import_batches WHERE id = ? AND kind = ? AND undone_at IS NULL').bind(payload.import_id, kind).first();
    if (!b) throw new HttpError(400, 'That import was not found or was already undone');
    return { id: b.id, isNew: false };
  }
  const r = await db.prepare('INSERT INTO import_batches (kind, filename, created_by) VALUES (?, ?, ?) RETURNING id')
    .bind(kind, coerce('text', payload.filename, 'File name'), adminId ?? null).first();
  return { id: r.id, isNew: true };
}

async function runImportBatch(db, kind, payload, adminId, ops, counts) {
  if (!ops.length) return null;
  const batch = await openImportBatch(db, kind, payload, adminId);
  try {
    await db.batch([
      ...ops.map((op) => op(batch.id)),
      db.prepare(`UPDATE import_batches SET created_count = created_count + ?, updated_count = updated_count + ?,
                  units_created = units_created + ? WHERE id = ?`)
        .bind(counts.created, counts.updated, counts.units_created || 0, batch.id),
    ]);
  } catch (e) {
    if (batch.isNew) await db.prepare('DELETE FROM import_batches WHERE id = ?').bind(batch.id).run();
    throw e;
  }
  return batch.id;
}

const chunks = (arr, n = 90) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const inList = (ids) => ids.map(() => '?').join(',');

function cleanIds(payload) {
  const ids = [...new Set((Array.isArray(payload.ids) ? payload.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new HttpError(400, 'Nothing selected');
  if (ids.length > 5000) throw new HttpError(400, 'Delete at most 5000 at a time');
  return ids;
}

/** Deletes tenants that have no billing statements; others are skipped with the reason. */
async function deleteTenants(db, ids) {
  const blocked = new Map();
  for (const c of chunks(ids)) {
    const rows = (await db.prepare(
      `SELECT t.id, TRIM(COALESCE(t.first_name,'') || ' ' || t.last_name) AS name, COUNT(s.id) AS n
       FROM tenants t JOIN statements s ON s.tenant_id = t.id WHERE t.id IN (${inList(c)}) GROUP BY t.id`,
    ).bind(...c).all()).results;
    for (const r of rows) blocked.set(r.id, { id: r.id, name: r.name, reason: `has ${r.n} billing statement${r.n === 1 ? '' : 's'} (set a move-out date instead)` });
  }
  const ok = ids.filter((id) => !blocked.has(id));
  const stmts = [];
  for (const c of chunks(ok)) {
    stmts.push(db.prepare(`DELETE FROM sessions WHERE user_type = 'tenant' AND user_id IN (${inList(c)})`).bind(...c));
    stmts.push(db.prepare(`DELETE FROM tenants WHERE id IN (${inList(c)})`).bind(...c));
  }
  if (stmts.length) await db.batch(stmts);
  return { deleted: ok.length, skipped: [...blocked.values()] };
}

/**
 * Mass edit tenants: set the number of occupants and/or the move-out date (or clear it).
 * A move-out before a tenant's move-in is skipped and reported.
 */
async function bulkUpdateTenants(db, payload) {
  const ids = cleanIds(payload);
  const setOcc = payload.occupants !== undefined && payload.occupants !== null && payload.occupants !== '';
  const occupants = setOcc ? coerce('int', payload.occupants, 'Number of people') : null;
  if (setOcc && (occupants < 0 || occupants > 50)) throw new HttpError(400, 'Number of people must be between 0 and 50');
  const clearOut = payload.clear_move_out === true;
  const moveOut = clearOut ? null : coerce('date', payload.move_out, 'Move-out date');
  if (!setOcc && !moveOut && !clearOut) throw new HttpError(400, 'Choose what to change');
  const skipped = [];
  let ok = ids;
  if (moveOut) {
    ok = [];
    for (const c of chunks(ids)) {
      const rows = (await db.prepare(`SELECT id, move_in, TRIM(COALESCE(first_name,'') || ' ' || last_name) AS name FROM tenants WHERE id IN (${inList(c)})`).bind(...c).all()).results;
      for (const r of rows) {
        if (moveOut < r.move_in) skipped.push({ id: r.id, name: r.name, reason: `moved in ${r.move_in}, after the move-out date` });
        else ok.push(r.id);
      }
    }
  }
  const sets = [];
  const vals = [];
  if (setOcc) { sets.push('occupants = ?'); vals.push(occupants); }
  if (moveOut || clearOut) { sets.push('move_out = ?'); vals.push(moveOut); }
  if (ok.length) await db.batch(chunks(ok, 80).map((c) => db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id IN (${inList(c)})`).bind(...vals, ...c)));
  return { updated: ok.length, skipped };
}

/** Deletes units that have no tenants (current or past); others are skipped with the reason. */
async function deleteUnits(db, ids) {
  const blocked = new Map();
  for (const c of chunks(ids)) {
    const rows = (await db.prepare(
      `SELECT u.id, u.unit_number AS name, COUNT(t.id) AS n FROM units u JOIN tenants t ON t.unit_id = u.id
       WHERE u.id IN (${inList(c)}) GROUP BY u.id`,
    ).bind(...c).all()).results;
    for (const r of rows) blocked.set(r.id, { id: r.id, name: `Unit ${r.name}`, reason: `has ${r.n} tenant${r.n === 1 ? '' : 's'} (delete those first)` });
  }
  const ok = ids.filter((id) => !blocked.has(id));
  if (ok.length) await db.batch(chunks(ok).map((c) => db.prepare(`DELETE FROM units WHERE id IN (${inList(c)})`).bind(...c)));
  return { deleted: ok.length, skipped: [...blocked.values()] };
}

async function listImports(db, kind) {
  return (await db.prepare(
    `SELECT b.*, a.email AS created_by_email,
       (SELECT COUNT(*) FROM tenants t WHERE t.import_batch_id = b.id) AS tenants_remaining,
       (SELECT COUNT(*) FROM units u WHERE u.import_batch_id = b.id) AS units_remaining
     FROM import_batches b LEFT JOIN admins a ON a.id = b.created_by
     WHERE b.kind = ? ORDER BY b.id DESC LIMIT 100`,
  ).bind(kind).all()).results;
}

/** Undo an import: delete the tenants and units it created (records it only updated are not changed). */
async function undoImport(db, id) {
  const b = await db.prepare('SELECT * FROM import_batches WHERE id = ?').bind(id).first();
  if (!b) throw new HttpError(404, 'Import not found');
  const tenantIds = (await db.prepare('SELECT id FROM tenants WHERE import_batch_id = ?').bind(id).all()).results.map((r) => r.id);
  const t = tenantIds.length ? await deleteTenants(db, tenantIds) : { deleted: 0, skipped: [] };
  const unitIds = (await db.prepare('SELECT id FROM units WHERE import_batch_id = ?').bind(id).all()).results.map((r) => r.id);
  const u = unitIds.length ? await deleteUnits(db, unitIds) : { deleted: 0, skipped: [] };
  await db.prepare("UPDATE import_batches SET undone_at = datetime('now') WHERE id = ?").bind(id).run();
  return { tenants_deleted: t.deleted, units_deleted: u.deleted, skipped: [...t.skipped, ...u.skipped] };
}

// Reads the number at the start of a cell: "1,050", "850 sq ft", "2 BR", "1.5".
function leadingNumber(v, label) {
  if (blank(v)) return null;
  const m = /^\s*(\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(String(v));
  if (!m) throw new Error(`${label} "${v}" is not a number`);
  return Number(m[1].replace(/,/g, ''));
}

// Creates units, or updates sqft/bedrooms/bathrooms of existing ones (matched by
// property + unit number, ignoring case). Blank cells keep the existing value.
async function importUnits(db, payload, adminId) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new HttpError(400, 'No rows to import');
  if (rows.length > 1000) throw new HttpError(400, 'Import at most 1000 rows per request');
  const updateExisting = payload.update_existing !== false;

  const props = (await db.prepare('SELECT id, name, rm_property_code FROM properties').all()).results;
  const existing = (await db.prepare('SELECT id, property_id, unit_number, sqft, bedrooms, bathrooms, notes FROM units').all()).results;
  const key = (pid, num) => `${pid}|${String(num).trim().toLowerCase()}`;
  const byKey = new Map(existing.map((u) => [key(u.property_id, u.unit_number), u]));

  const errors = [];
  const ops = []; // (importId) => statement
  const seen = new Map();
  const result = { created: 0, updated: 0, unchanged: 0, skipped_existing: 0 };
  rows.forEach((raw, idx) => {
    const line = idx + 2;
    try {
      const lower = {};
      for (const [k, v] of Object.entries(raw)) lower[String(k).trim().toLowerCase()] = v;
      const r = {};
      for (const [field, aliases] of Object.entries(UNIT_ALIASES)) {
        for (const a of aliases) if (!blank(lower[a])) { r[field] = String(lower[a]).trim(); break; }
      }
      const prop = propertyByCode(props, r.property);
      if (!r.unit_number) throw new Error('unit number is missing');
      if (r.unit_number.length > 50) throw new Error('unit number is too long');
      const k = key(prop.id, r.unit_number);
      if (seen.has(k)) throw new Error(`unit ${r.unit_number} is listed twice (also on line ${seen.get(k)})`);
      seen.set(k, line);
      const sqft = leadingNumber(r.sqft, 'Sq ft');
      const bedrooms = leadingNumber(r.bedrooms, 'Bedrooms');
      const bathrooms = leadingNumber(r.bathrooms, 'Bathrooms');
      const notes = blank(r.notes) ? null : r.notes.slice(0, 2000);

      const u = byKey.get(k);
      if (!u) {
        ops.push((importId) => db.prepare('INSERT INTO units (property_id, unit_number, sqft, bedrooms, bathrooms, notes, import_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(prop.id, r.unit_number, sqft ?? 0, bedrooms ?? 0, bathrooms ?? 0, notes, importId));
        result.created++;
      } else if (!updateExisting) {
        result.skipped_existing++;
      } else {
        const next = { sqft: sqft ?? u.sqft, bedrooms: bedrooms ?? u.bedrooms, bathrooms: bathrooms ?? u.bathrooms, notes: notes ?? u.notes };
        if (next.sqft === u.sqft && next.bedrooms === u.bedrooms && next.bathrooms === u.bathrooms && next.notes === u.notes) {
          result.unchanged++;
        } else {
          ops.push(() => db.prepare('UPDATE units SET sqft = ?, bedrooms = ?, bathrooms = ?, notes = ? WHERE id = ?')
            .bind(next.sqft, next.bedrooms, next.bathrooms, next.notes, u.id));
          result.updated++;
        }
      }
    } catch (e) {
      errors.push({ line, error: e.message });
    }
  });

  if (errors.length && !payload.skip_errors) return { created: 0, updated: 0, unchanged: 0, skipped_existing: 0, errors };
  const importId = await runImportBatch(db, 'units', payload, adminId, ops, { created: result.created, updated: result.updated });
  return { ...result, errors, import_id: importId ?? payload.import_id ?? null };
}

// Rows are imported in a single D1 batch to stay within per-request query limits.
// Existing tenants (matched by account number) are updated; others are inserted.
async function importTenants(db, payload, adminId) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) throw new HttpError(400, 'No rows to import');
  if (rows.length > 500) throw new HttpError(400, 'Import at most 500 rows per request');
  const createUnits = payload.create_units !== false;

  const props = (await db.prepare('SELECT id, name, rm_property_code FROM properties').all()).results;
  const units = (await db.prepare('SELECT id, property_id, unit_number FROM units').all()).results;
  const accounts = new Set((await db.prepare('SELECT account_number FROM tenants WHERE account_number IS NOT NULL').all()).results.map((r) => r.account_number));
  const unitKey = (pid, num) => `${pid}|${String(num).trim().toLowerCase()}`;
  const unitSet = new Set(units.map((u) => unitKey(u.property_id, u.unit_number)));

  const errors = [];
  const ops = []; // (importId) => statement
  const newUnits = new Set();
  const seenAccounts = new Map();
  let count = 0, created = 0, updated = 0;
  rows.forEach((raw, idx) => {
    const line = idx + 2; // header is line 1
    try {
      const r = mapImportRow(raw);
      const prop = propertyByCode(props, r.property);
      if (!r.unit_number) throw new Error('unit number is missing');
      if (!r.last_name) throw new Error('tenant name is missing');
      if (blank(r.account_number)) throw new Error('account number is missing');
      const acctKey = r.account_number.trim();
      if (seenAccounts.has(acctKey)) throw new Error(`account number ${acctKey} is listed twice (also on line ${seenAccounts.get(acctKey)})`);
      seenAccounts.set(acctKey, line);
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
          const sq = coerce('num', r.sqft, 'Sq ft') ?? 0, br = coerce('num', r.bedrooms, 'Bedrooms') ?? 0;
          ops.push((importId) => db.prepare('INSERT OR IGNORE INTO units (property_id, unit_number, sqft, bedrooms, import_batch_id) VALUES (?, ?, ?, ?, ?)')
            .bind(prop.id, r.unit_number, sq, br, importId));
        }
      } else if (!blank(r.sqft) || !blank(r.bedrooms)) {
        // Fill in unit size when the import provides it.
        const sq = coerce('num', r.sqft, 'Sq ft'), br = coerce('num', r.bedrooms, 'Bedrooms');
        ops.push(() => db.prepare(
          `UPDATE units SET sqft = COALESCE(?, sqft), bedrooms = COALESCE(?, bedrooms)
           WHERE property_id = ? AND unit_number = ? COLLATE NOCASE`,
        ).bind(sq, br, prop.id, r.unit_number));
      }
      const acct = acctKey;
      if (accounts.has(acct)) updated++; else created++;
      // import_batch_id is only set on INSERT, so updating an existing tenant doesn't make it undoable.
      ops.push((importId) => db.prepare(
        `INSERT INTO tenants (unit_id, first_name, last_name, email, phone, account_number, mailing_address, move_in, move_out, occupants, import_batch_id)
         VALUES ((SELECT id FROM units WHERE property_id = ? AND unit_number = ? COLLATE NOCASE), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_number) DO UPDATE SET
           unit_id = excluded.unit_id, first_name = excluded.first_name, last_name = excluded.last_name,
           email = COALESCE(excluded.email, email), phone = COALESCE(excluded.phone, phone),
           mailing_address = COALESCE(excluded.mailing_address, mailing_address),
           move_in = excluded.move_in, move_out = excluded.move_out, occupants = excluded.occupants`,
      ).bind(prop.id, r.unit_number, r.first_name || null, r.last_name, email, r.phone || null, acct,
        r.mailing_address || null, moveIn, moveOut, occupants, importId));
      count++;
    } catch (e) {
      errors.push({ line, error: e.message });
    }
  });

  if (errors.length && !payload.skip_errors) return { imported: 0, created: 0, updated: 0, errors, units_created: 0 };
  const importId = await runImportBatch(db, 'tenants', payload, adminId, ops, { created, updated, units_created: newUnits.size });
  return { imported: count, created, updated, units_created: newUnits.size, errors, import_id: importId ?? payload.import_id ?? null };
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
  // One row per Rent Manager charge code per statement: lines that share a code (e.g. Water, Sewer and
  // Utility tax all posted as UTIL) become a single charge, matching how the bill is posted in Rent Manager.
  const byCode = (lines) => {
    const m = new Map();
    for (const l of lines) {
      const k = String(l.charge_code || l.label).trim().toUpperCase();
      const g = m.get(k);
      if (g) { g.amount_cents += l.amount_cents; g.label = `${g.label} + ${l.label}`; } else m.set(k, { ...l });
    }
    return [...m.values()];
  };
  const rows = statements.flatMap((s) => byCode(JSON.parse(s.lines)).map((line) => ({ ...s, line, reverse })));
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
      (SELECT COUNT(*) FROM properties WHERE active = 1) AS properties,
      (SELECT COUNT(*) FROM properties WHERE active = 0) AS inactive_properties,
      (SELECT COUNT(*) FROM units u JOIN properties p ON p.id = u.property_id WHERE p.active = 1) AS units,
      (SELECT COALESCE(SUM(COALESCE(p.total_units, (SELECT COUNT(*) FROM units u WHERE u.property_id = p.id))), 0) FROM properties p WHERE p.active = 1) AS total_units,
      (SELECT COUNT(DISTINCT u.id) FROM units u JOIN tenants t ON t.unit_id = u.id JOIN properties p ON p.id = u.property_id
         WHERE p.active = 1 AND t.move_in <= date('now') AND (t.move_out IS NULL OR t.move_out >= date('now'))) AS occupied_units,
      (SELECT COUNT(*) FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
         WHERE p.active = 1 AND t.move_in <= date('now') AND (t.move_out IS NULL OR t.move_out >= date('now'))) AS current_tenants,
      (SELECT COUNT(*) FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
         WHERE p.active = 1 AND t.move_in > date('now')) AS upcoming_move_ins,
      (SELECT COUNT(*) FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
         WHERE p.active = 1 AND t.move_out BETWEEN date('now') AND date('now','+30 days')) AS move_outs_30d,
      (SELECT COUNT(*) FROM billing_runs WHERE status != 'finalized') AS open_batches,
      (SELECT COUNT(*) FROM tenants t WHERE t.move_out IS NOT NULL AND t.move_out <= date('now') AND t.move_out >= date('now', '-90 days')
         AND NOT EXISTS (SELECT 1 FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
           WHERE s.tenant_id = t.id AND r.status = 'finalized' AND r.period_end >= t.move_out)) AS final_pending,
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

// ---------------------------------------------------------------- resident portal security

// Checked when an email is unknown (same work as a real password check), so timing reveals nothing.
const dummyHash = (rounds) => `pbkdf2$${rounds}$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`;
const LOCKED_MESSAGE = 'This account is locked. Please contact the office.';

/** Records a resident's sign-in time and IP (Cloudflare passes the visitor's IP in CF-Connecting-IP). */
async function recordResidentLogin(db, tenantId, request) {
  const ip = clientIp(request);
  await db.prepare("UPDATE tenants SET last_login_at = datetime('now'), last_login_ip = ? WHERE id = ?").bind(ip, tenantId).run();
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
        const t = await db.prepare('SELECT id, email, first_name, last_name, locked_at FROM tenants WHERE id = ?').bind(s.user_id).first();
        if (t && (!t.locked_at || s.impersonated_by)) user = { type: 'tenant', id: t.id, email: t.email, name: `${t.first_name || ''} ${t.last_name}`.trim() };
        if (user && s.impersonated_by) {
          const a = await db.prepare('SELECT name, email FROM admins WHERE id = ?').bind(s.impersonated_by).first();
          user.preview = { staff: a ? a.name || a.email : 'Staff', expires_at: s.expires_at };
        }
      }
      // Company name is shown on the sign-in page (it is printed on every statement anyway).
      const rows = (await db.prepare("SELECT key, value FROM settings WHERE key IN ('company_name', 'payment_url')").all()).results;
      const setting = (k) => rows.find((r) => r.key === k)?.value || '';
      const sec = await loadSecurity(db);
      return json({ needsSetup, user, company_name: setting('company_name'), payment_url: setting('payment_url'),
        altcha: sec.altcha_enabled, min_password_length: sec.min_password_length });
    }
    if (action === 'challenge' && method === 'GET') {
      // ALTCHA bot check: a fresh proof-of-work puzzle for the sign-in forms.
      return json(await createAltchaChallenge(db));
    }
    if (action === 'setup' && method === 'POST') {
      const b = await body(request);
      if (await db.prepare('SELECT 1 FROM admins LIMIT 1').first()) throw new HttpError(409, 'Setup has already been completed');
      const sec = await loadSecurity(db);
      if (sec.altcha_enabled) await verifyAltcha(db, b.altcha);
      const email = coerce('email', b.email, 'Email');
      if (!email) throw new HttpError(400, 'Email is required');
      validatePassword(b.password, sec.min_password_length);
      const r = await db.prepare('INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?) RETURNING id')
        .bind(email, b.name || null, await hashPassword(b.password, hashIterations(await getPlan(db)))).first();
      await recordAttempt(db, request, { kind: 'setup', identifier: email.toLowerCase(), success: true });
      const token = await createSession(db, 'admin', r.id, { hours: sec.staff_session_hours });
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, sec.staff_session_hours * 3600) });
    }
    if (action === 'login' && method === 'POST') {
      const b = await body(request);
      const email = String(b.email || '').trim().slice(0, 254);
      const isAdmin = b.type === 'admin';
      const kind = isAdmin ? 'staff' : 'resident';
      const identifier = email.toLowerCase() || null;
      const sec = await loadSecurity(db);
      const failed = async (reason, status, message) => {
        await recordAttempt(db, request, { kind, identifier, success: false, reason });
        throw new HttpError(status, message);
      };
      await checkLockout(db, sec, { identifier, ip: clientIp(request) });
      if (sec.altcha_enabled) {
        try { await verifyAltcha(db, b.altcha); } catch (e) { await failed('bot check failed', 400, e.message); }
      }
      const row = isAdmin
        ? await db.prepare('SELECT id, password_hash FROM admins WHERE email = ? COLLATE NOCASE').bind(email).first()
        : await db.prepare('SELECT id, password_hash, locked_at FROM tenants WHERE email = ? COLLATE NOCASE AND password_hash IS NOT NULL ORDER BY move_in DESC LIMIT 1').bind(email).first();
      // Check a password even when the email is unknown, so response times don't reveal which emails exist.
      const rounds = hashIterations(await getPlan(db));
      const password = String(b.password || '').slice(0, 200);
      const ok = await verifyPassword(password, row?.password_hash || dummyHash(rounds));
      if (!row || !ok) await failed(row ? 'wrong password' : 'unknown email', 401, 'Incorrect email or password');
      if (!isAdmin && row.locked_at) await failed('account locked', 403, LOCKED_MESSAGE);
      await recordAttempt(db, request, { kind, identifier, success: true });
      // Upgrade older, weaker password hashes now that we have the password.
      if (storedIterations(row.password_hash) < rounds) {
        await db.prepare(`UPDATE ${isAdmin ? 'admins' : 'tenants'} SET password_hash = ? WHERE id = ?`).bind(await hashPassword(password, rounds), row.id).run();
      }
      if (isAdmin) await db.prepare("UPDATE admins SET last_login_at = datetime('now'), last_login_ip = ? WHERE id = ?").bind(clientIp(request), row.id).run();
      else await recordResidentLogin(db, row.id, request);
      const hours = isAdmin ? sec.staff_session_hours : sec.resident_session_days * 24;
      const token = await createSession(db, isAdmin ? 'admin' : 'tenant', row.id, { hours });
      return json({ ok: true, type: isAdmin ? 'admin' : 'tenant' }, 200, { 'Set-Cookie': sessionCookie(token, hours * 3600) });
    }
    if (action === 'activate' && method === 'POST') {
      // Resident sets up portal access using their account number + the email on file.
      const b = await body(request);
      const sec = await loadSecurity(db);
      const account = String(b.account_number || '').trim().slice(0, 64);
      const identifier = account ? `account ${account.toLowerCase()}` : null;
      const failed = async (reason, status, message) => {
        await recordAttempt(db, request, { kind: 'activate', identifier, success: false, reason });
        throw new HttpError(status, message);
      };
      await checkLockout(db, sec, { identifier, ip: clientIp(request) });
      if (sec.altcha_enabled) {
        try { await verifyAltcha(db, b.altcha); } catch (e) { await failed('bot check failed', 400, e.message); }
      }
      validatePassword(b.password, sec.min_password_length);
      const t = await db.prepare('SELECT id, password_hash, locked_at FROM tenants WHERE account_number = ? AND email = ? COLLATE NOCASE')
        .bind(account, String(b.email || '').trim()).first();
      if (!t) await failed('account number and email do not match', 400, 'No resident found with that account number and email. Contact the office.');
      if (t.locked_at) await failed('account locked', 403, LOCKED_MESSAGE);
      if (t.password_hash) await failed('already activated', 409, 'This account is already activated. Sign in, or ask the office to reset your access.');
      await recordAttempt(db, request, { kind: 'activate', identifier, success: true });
      await db.prepare("UPDATE tenants SET password_hash = ?, activated_at = datetime('now') WHERE id = ?").bind(await hashPassword(b.password, hashIterations(await getPlan(db))), t.id).run();
      await recordResidentLogin(db, t.id, request);
      const hours = sec.resident_session_days * 24;
      const token = await createSession(db, 'tenant', t.id, { hours });
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, hours * 3600) });
    }
    if (action === 'stop-view-as' && method === 'POST') {
      // Leave a "log in as a resident" preview and restore the staff member's own session.
      const s = await getSession(db, request);
      if (!s?.impersonated_by) throw new HttpError(400, 'You are not viewing the portal as a resident');
      const back = s.return_token
        ? await db.prepare("SELECT token FROM sessions WHERE token = ? AND user_type = 'admin' AND user_id = ? AND expires_at > ?")
          .bind(s.return_token, s.impersonated_by, new Date().toISOString()).first()
        : null;
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(s.token).run();
      if (!back) return json({ ok: true, relogin: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(back.token) });
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
    if (!session.impersonated_by) {
      const lock = await db.prepare('SELECT locked_at FROM tenants WHERE id = ?').bind(tid).first();
      if (!lock || lock.locked_at) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(session.token).run();
        throw new HttpError(401, LOCKED_MESSAGE);
      }
    }
    if (seg[1] === 'me' && method === 'GET') {
      const me = await db.prepare(
        `SELECT t.id, t.first_name, t.last_name, t.email, t.phone, t.account_number, t.mailing_address,
                t.move_in, t.move_out, t.occupants, u.unit_number, u.sqft, u.bedrooms,
                p.name AS property_name, p.address, p.city, p.state, p.zip, p.phone AS office_phone, p.email AS office_email
         FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id WHERE t.id = ?`,
      ).bind(tid).first();
      const statements = (await db.prepare(
        `SELECT s.id, s.days, s.total_cents, s.lines, r.period_start, r.period_end, r.statement_date, r.due_date
         FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
         WHERE s.tenant_id = ? AND r.status = 'finalized' ORDER BY r.period_end DESC, s.id DESC`,
      ).bind(tid).all()).results;
      const charges = (await db.prepare(
        `SELECT c.statement_id, c.days, c.period_days, c.share_cents, c.tax_cents, c.detail, b.total_cents AS bill_total_cents, json_extract(b.calc_summary, '$.discount_cents') AS bill_discount_cents, pu.utility_name
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
    if (session.impersonated_by && method !== 'GET') {
      throw new HttpError(403, 'Not available in the staff preview. Residents make this change themselves.');
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
      validatePassword(b.new_password, (await loadSecurity(db)).min_password_length);
      // A new password signs out the resident's other devices.
      await db.batch([
        db.prepare('UPDATE tenants SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.new_password, hashIterations(await getPlan(db))), tid),
        db.prepare("DELETE FROM sessions WHERE user_type = 'tenant' AND user_id = ? AND token != ?").bind(tid, session.token),
      ]);
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

  if (name === 'tenants' && id === 'import' && method === 'POST') return json(await importTenants(db, await body(request), session.user_id));
  if (name === 'units' && id === 'import' && method === 'POST') return json(await importUnits(db, await body(request), session.user_id));
  if (name === 'utilities' && id && action === 'test' && method === 'POST') return json(await testUtility(db, id, await body(request)));
  if (name === 'tenants' && id === 'bulk-update' && method === 'POST') return json(await bulkUpdateTenants(db, await body(request)));
  if (name === 'tenants' && id === 'bulk-delete' && method === 'POST') return json(await deleteTenants(db, cleanIds(await body(request))));
  if (name === 'units' && id === 'bulk-delete' && method === 'POST') return json(await deleteUnits(db, cleanIds(await body(request))));
  if (name === 'imports') {
    if (method === 'GET' && !id) {
      const kind = url.searchParams.get('kind');
      if (!['tenants', 'units'].includes(kind)) throw new HttpError(400, 'kind must be tenants or units');
      return json(await listImports(db, kind));
    }
    if (method === 'POST' && id && action === 'undo') return json(await undoImport(db, id));
  }
  if (name === 'import-columns' && method === 'GET') return json({ tenants: TENANT_COLUMNS, units: UNIT_COLUMNS });
  if (name === 'tenants' && id && action === 'view-as' && method === 'POST') {
    // "Log in as a resident": a read-only, 2-hour resident session that remembers this staff session.
    const t = await db.prepare('SELECT id FROM tenants WHERE id = ?').bind(id).first();
    if (!t) throw new HttpError(404, 'Tenant not found');
    const token = await createSession(db, 'tenant', t.id, { impersonatedBy: session.user_id, returnToken: session.token, hours: 2 });
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, 2 * 3600) });
  }
  if (name === 'tenants' && id && (action === 'lock' || action === 'unlock') && method === 'POST') {
    const t = await db.prepare('SELECT id FROM tenants WHERE id = ?').bind(id).first();
    if (!t) throw new HttpError(404, 'Tenant not found');
    if (action === 'lock') {
      const reason = coerce('text', (await body(request)).reason, 'Reason');
      await db.batch([
        db.prepare("UPDATE tenants SET locked_at = datetime('now'), locked_reason = ? WHERE id = ?").bind(reason, id),
        // Sign the resident out everywhere (staff previews are left alone).
        db.prepare("DELETE FROM sessions WHERE user_type = 'tenant' AND user_id = ? AND impersonated_by IS NULL").bind(id),
      ]);
    } else {
      await db.prepare('UPDATE tenants SET locked_at = NULL, locked_reason = NULL WHERE id = ?').bind(id).run();
    }
    return json({ ok: true });
  }
  if (name === 'tenants' && id && action === 'reset-portal' && method === 'POST') {
    await db.batch([
      db.prepare('UPDATE tenants SET password_hash = NULL, activated_at = NULL WHERE id = ?').bind(id),
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

  // ---- Settings → Security
  if (name === 'security') {
    if (method === 'GET' && !id) return json({ ...(await loadSecurity(db)), hash_rounds: hashIterations(await getPlan(db)), plan: await getPlan(db) });
    if (method === 'PUT' && !id) return json(await saveSecurity(db, await body(request)));
    if (method === 'GET' && id === 'activity') return json(await signInActivity(db, { failedOnly: url.searchParams.get('failed') === '1' }));
    if (method === 'POST' && id === 'clear-lockouts') return json(await clearLockouts(db, (await body(request)).identifier || null));
    if (method === 'GET' && id === 'sessions') {
      const r = await db.prepare(`SELECT
          SUM(user_type = 'admin' AND impersonated_by IS NULL) AS staff, SUM(user_type = 'tenant' AND impersonated_by IS NULL) AS residents
        FROM sessions WHERE expires_at > ?`).bind(new Date().toISOString()).first();
      return json({ staff: r?.staff || 0, residents: r?.residents || 0 });
    }
    if (method === 'POST' && id === 'sign-out-all') {
      // Everyone (staff and residents) is signed out, except the person doing it.
      const who = (await body(request)).who;
      const sql = who === 'residents' ? "DELETE FROM sessions WHERE user_type = 'tenant'"
        : who === 'staff' ? "DELETE FROM sessions WHERE user_type = 'admin' AND token != ?"
        : 'DELETE FROM sessions WHERE token != ?';
      const st = db.prepare(sql);
      const r = await (who === 'residents' ? st : st.bind(session.token)).run();
      return json({ signed_out: r.meta?.changes ?? 0 });
    }
  }

  // ---- Settings → System: storage, stack and backups
  if (name === 'system' && method === 'GET') {
    if (!id) return json(await systemInfo(db, request));
  }
  if (name === 'system' && method === 'PUT' && id === 'plan') return json(await setPlan(db, (await body(request)).plan));
  if (name === 'system' && method === 'GET') {
    if (id === 'backup') {
      const q = url.searchParams;
      return json(await backupPage(db, { table: q.get('table'), offset: q.get('offset'), secrets: q.get('secrets') === '1' }));
    }
  }

  if (name === 'admins') {
    if (method === 'GET' && !id) return json((await db.prepare('SELECT id, email, name, created_at, last_login_at, last_login_ip FROM admins ORDER BY email').all()).results);
    if (method === 'POST' && !id) {
      const b = await body(request);
      const email = coerce('email', b.email, 'Email');
      if (!email) throw new HttpError(400, 'Email is required');
      validatePassword(b.password, (await loadSecurity(db)).min_password_length);
      await db.prepare('INSERT INTO admins (email, name, password_hash) VALUES (?, ?, ?)').bind(email, b.name || null, await hashPassword(b.password, hashIterations(await getPlan(db)))).run();
      return json({ ok: true });
    }
    if (method === 'PUT' && id === 'me' && action === 'password') {
      const b = await body(request);
      const a = await db.prepare('SELECT password_hash FROM admins WHERE id = ?').bind(session.user_id).first();
      if (!(await verifyPassword(String(b.current_password || ''), a.password_hash))) throw new HttpError(400, 'Current password is incorrect');
      validatePassword(b.new_password, (await loadSecurity(db)).min_password_length);
      // A new password signs out this staff member's other devices.
      await db.batch([
        db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.new_password, hashIterations(await getPlan(db))), session.user_id),
        db.prepare("DELETE FROM sessions WHERE user_type = 'admin' AND user_id = ? AND token != ?").bind(session.user_id, session.token),
      ]);
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
