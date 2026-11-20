// Batch billing: a billing batch holds one utility-company bill (several utility lines)
// for one property and service period. Calculating it runs RUBS for every line and
// builds one statement per resident. Statements become PDFs, emails and Rent Manager rows.
import { calculateRubs, periodLength } from './rubs.js';
import { HttpError, coerce, today, addDays, blank } from './util.js';
import { statementsPdf, longDate, usd, fillTemplate } from '../public/js/shared/statement-pdf.js';
import { loadSettings, smtpConfig } from './settings.js';
import { sendMail } from './smtp.js';

const RUN_LIST_SQL = `
  SELECT r.*, p.name AS property_name,
    (SELECT COALESCE(SUM(total_cents),0) FROM bills b WHERE b.billing_run_id = r.id) AS city_total_cents,
    (SELECT COUNT(*) FROM statements s WHERE s.billing_run_id = r.id) AS statement_count,
    (SELECT COALESCE(SUM(total_cents),0) FROM statements s WHERE s.billing_run_id = r.id) AS billed_cents,
    (SELECT COUNT(*) FROM statements s WHERE s.billing_run_id = r.id AND s.emailed_at IS NOT NULL) AS emailed_count,
    (SELECT GROUP_CONCAT(pu.utility_name, ', ') FROM bills b JOIN property_utilities pu ON pu.id = b.property_utility_id
       WHERE b.billing_run_id = r.id) AS utilities
  FROM billing_runs r JOIN properties p ON p.id = r.property_id WHERE 1=1`;

export async function listRuns(db, url) {
  let sql = RUN_LIST_SQL;
  const args = [];
  for (const [param, col] of [['property_id', 'r.property_id'], ['status', 'r.status']]) {
    const v = url.searchParams.get(param);
    if (!blank(v)) { sql += ` AND ${col} = ?`; args.push(v); }
  }
  sql += ' ORDER BY r.period_end DESC, r.id DESC LIMIT 1000';
  return (await db.prepare(sql).bind(...args).all()).results.map(stripSummary);
}

function stripSummary(r) {
  const { calc_summary, ...rest } = r;
  return { ...rest, summary: calc_summary ? JSON.parse(calc_summary) : null };
}

async function getRunRow(db, id) {
  const r = await db.prepare('SELECT * FROM billing_runs WHERE id = ?').bind(id).first();
  if (!r) throw new HttpError(404, 'Billing batch not found');
  return r;
}

export async function runDetail(db, id) {
  const run = stripSummary(await db.prepare(`${RUN_LIST_SQL} AND r.id = ?`).bind(id).first() || {});
  if (!run.id) throw new HttpError(404, 'Billing batch not found');
  const [bills, statements] = await db.batch([
    db.prepare(`SELECT b.*, pu.utility_name, pu.rm_charge_code, pu.recovery_pct, pu.w_sqft, pu.w_bedrooms, pu.w_occupants,
                  pu.w_equal, pu.vacancy_mode, pu.tax_pct
                FROM bills b JOIN property_utilities pu ON pu.id = b.property_utility_id
                WHERE b.billing_run_id = ? ORDER BY pu.sort_order, pu.id`).bind(id),
    db.prepare(`SELECT s.*, t.first_name, t.last_name, t.email, t.account_number, t.occupants, t.move_in, t.move_out,
                  u.unit_number, u.sqft, u.bedrooms
                FROM statements s JOIN tenants t ON t.id = s.tenant_id JOIN units u ON u.id = s.unit_id
                WHERE s.billing_run_id = ? ORDER BY u.unit_number COLLATE NOCASE, t.move_in`).bind(id),
  ]);
  run.bills = bills.results.map(stripSummary);
  run.statements = statements.results.map((s) => ({ ...s, lines: JSON.parse(s.lines) }));
  run.period_days = periodLength(run.period_start, run.period_end, (await propertyRow(db, run.property_id)).day_count);
  return run;
}

async function propertyRow(db, id) {
  const p = await db.prepare('SELECT * FROM properties WHERE id = ?').bind(id).first();
  if (!p) throw new HttpError(404, 'Property not found');
  return p;
}

const RUN_FIELDS = {
  property_id: ['int', 'Property', true], vendor: ['text', 'Utility company'], vendor_account: ['text', 'Utility account #'],
  period_start: ['date', 'Service period start', true], period_end: ['date', 'Service period end', true],
  statement_date: ['date', 'Statement date'], due_date: ['date', 'Due date'], charge_date: ['date', 'Charge date'],
  notes: ['text', 'Notes'],
};

async function cleanRun(db, input) {
  const data = {};
  for (const [k, [type, label, required]] of Object.entries(RUN_FIELDS)) {
    data[k] = coerce(type, input[k], label);
    if (required && data[k] === null) throw new HttpError(400, `${label} is required`);
  }
  if (data.period_end <= data.period_start) throw new HttpError(400, 'Service period end must be after the start');
  const p = await propertyRow(db, data.property_id);
  data.statement_date ??= today();
  data.due_date ??= addDays(data.statement_date, p.due_days ?? 28);
  data.charge_date ??= data.statement_date;

  const utilities = (await db.prepare('SELECT id, utility_name FROM property_utilities WHERE property_id = ?').bind(p.id).all()).results;
  const lines = [];
  for (const l of Array.isArray(input.lines) ? input.lines : []) {
    if (blank(l.total_cents)) continue;
    const u = utilities.find((x) => x.id === Number(l.property_utility_id));
    if (!u) throw new HttpError(400, 'A bill line refers to a utility that is not set up for this property');
    const cents = coerce('int', l.total_cents, `${u.utility_name} amount`);
    if (cents < 0) throw new HttpError(400, `${u.utility_name} amount cannot be negative`);
    if (lines.some((x) => x.property_utility_id === u.id)) throw new HttpError(400, `${u.utility_name} is entered twice`);
    lines.push({ property_utility_id: u.id, total_cents: cents });
  }
  if (!lines.length) throw new HttpError(400, 'Enter the amount for at least one utility from the bill');
  return { data, lines };
}

export async function createRun(db, input) {
  const { data, lines } = await cleanRun(db, input);
  const keys = Object.keys(data);
  const r = await db.prepare(`INSERT INTO billing_runs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`)
    .bind(...keys.map((k) => data[k])).first();
  await db.batch(lines.map((l) => db.prepare('INSERT INTO bills (billing_run_id, property_utility_id, total_cents) VALUES (?, ?, ?)')
    .bind(r.id, l.property_utility_id, l.total_cents)));
  return r.id;
}

export async function updateRun(db, id, input) {
  const run = await getRunRow(db, id);
  if (run.status === 'finalized') throw new HttpError(409, 'This batch is finalized. Reopen it before making changes.');
  const { data, lines } = await cleanRun(db, { property_id: run.property_id, ...input });
  const keys = Object.keys(data);
  await db.batch([
    db.prepare('DELETE FROM statements WHERE billing_run_id = ?').bind(id),
    db.prepare('DELETE FROM bills WHERE billing_run_id = ?').bind(id),
    db.prepare(`UPDATE billing_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, status = 'draft', calc_summary = NULL WHERE id = ?`)
      .bind(...keys.map((k) => data[k]), id),
    ...lines.map((l) => db.prepare('INSERT INTO bills (billing_run_id, property_utility_id, total_cents) VALUES (?, ?, ?)')
      .bind(id, l.property_utility_id, l.total_cents)),
  ]);
}

/**
 * Deletes a batch with everything created from it: its utility lines, the RUBS
 * charge details and every resident statement. A finalized batch (residents can
 * see it, and it may have been emailed or exported) needs confirm === 'DELETE'.
 */
export async function deleteRun(db, id, confirm) {
  const run = await getRunRow(db, id);
  const c = await db.prepare(`SELECT COUNT(*) AS statements,
      COALESCE(SUM(emailed_at IS NOT NULL), 0) AS emailed, COALESCE(SUM(exported_at IS NOT NULL), 0) AS exported
    FROM statements WHERE billing_run_id = ?`).bind(id).first();
  if ((run.status === 'finalized' || c.emailed > 0 || c.exported > 0) && confirm !== 'DELETE') {
    throw new HttpError(409, 'This batch has been finalized, emailed or exported. Type DELETE to confirm.');
  }
  // Children are removed explicitly (not only through ON DELETE CASCADE) so nothing is left behind.
  await db.batch([
    db.prepare('DELETE FROM charges WHERE bill_id IN (SELECT id FROM bills WHERE billing_run_id = ?)').bind(id),
    db.prepare('DELETE FROM charges WHERE statement_id IN (SELECT id FROM statements WHERE billing_run_id = ?)').bind(id),
    db.prepare('DELETE FROM statements WHERE billing_run_id = ?').bind(id),
    db.prepare('DELETE FROM bills WHERE billing_run_id = ?').bind(id),
    db.prepare('DELETE FROM billing_runs WHERE id = ?').bind(id),
  ]);
  return { ok: true, deleted: { statements: c.statements, emailed: c.emailed, exported: c.exported } };
}

/** Runs RUBS for every utility line and builds one statement per resident. */
export async function calculateRun(db, id) {
  const run = await getRunRow(db, id);
  if (run.status === 'finalized') throw new HttpError(409, 'This batch is finalized. Reopen it to recalculate.');
  const p = await propertyRow(db, run.property_id);
  const [billsR, unitsR, tenantsR] = await db.batch([
    db.prepare(`SELECT b.id AS bill_id, b.total_cents, pu.* FROM bills b JOIN property_utilities pu ON pu.id = b.property_utility_id
                WHERE b.billing_run_id = ? ORDER BY pu.sort_order, pu.id`).bind(id),
    db.prepare('SELECT id, unit_number, sqft, bedrooms FROM units WHERE property_id = ?').bind(p.id),
    db.prepare(`SELECT t.id, t.unit_id, t.move_in, t.move_out, t.occupants FROM tenants t JOIN units u ON u.id = t.unit_id
                WHERE u.property_id = ? AND t.move_in <= ? AND (t.move_out IS NULL OR t.move_out >= ?)`)
      .bind(p.id, run.period_end, run.period_start),
  ]);
  const bills = billsR.results, units = unitsR.results, tenants = tenantsR.results;
  if (!bills.length) throw new HttpError(400, 'This batch has no utility amounts');
  if (!units.length) throw new HttpError(400, 'This property has no units yet');

  const perTenant = new Map(); // tenant_id -> {unit_id, days, charges: []}
  const billSummaries = [];
  for (const b of bills) {
    let result;
    try {
      result = calculateRubs({
        totalCents: b.total_cents, periodStart: run.period_start, periodEnd: run.period_end,
        config: { ...b, day_count: p.day_count }, units, tenants,
      });
    } catch (e) { throw new HttpError(400, `${b.utility_name}: ${e.message}`); }
    billSummaries.push({ bill_id: b.bill_id, summary: result.summary });
    for (const l of result.lines) {
      const t = perTenant.get(l.tenant_id) || { unit_id: l.unit_id, days: 0, charges: [] };
      t.days = Math.max(t.days, l.days);
      t.charges.push({ ...l, bill: b });
      perTenant.set(l.tenant_id, t);
    }
  }
  if (!perTenant.size) throw new HttpError(400, 'No residents lived at this property during the service period. Check move-in and move-out dates.');

  const stmts = [db.prepare('DELETE FROM statements WHERE billing_run_id = ?').bind(id)];
  const totals = { statements: 0, billed_cents: 0, resident_share_cents: 0, tax_cents: 0, fee_cents: 0 };
  for (const [tenantId, t] of perTenant) {
    const lines = t.charges.map((c) => ({
      label: c.bill.utility_name, amount_cents: c.share_cents + c.admin_fee_cents,
      charge_code: c.bill.rm_charge_code || c.bill.utility_name, kind: 'utility',
    }));
    const tax = t.charges.reduce((s, c) => s + c.tax_cents, 0);
    if (tax > 0) lines.push({ label: p.tax_label || 'Utility tax', amount_cents: tax, charge_code: p.tax_charge_code || 'UTILTAX', kind: 'tax' });
    if (p.billing_fee_cents > 0) lines.push({ label: p.fee_label || 'Billing fee', amount_cents: p.billing_fee_cents, charge_code: p.fee_charge_code || 'BILLFEE', kind: 'fee' });
    const total = lines.reduce((s, l) => s + l.amount_cents, 0);
    totals.statements++;
    totals.billed_cents += total;
    totals.tax_cents += tax;
    totals.fee_cents += p.billing_fee_cents > 0 ? p.billing_fee_cents : 0;
    totals.resident_share_cents += t.charges.reduce((s, c) => s + c.share_cents + c.admin_fee_cents, 0);
    stmts.push(db.prepare('INSERT INTO statements (billing_run_id, tenant_id, unit_id, days, total_cents, lines) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, tenantId, t.unit_id, t.days, total, JSON.stringify(lines)));
    for (const c of t.charges) {
      stmts.push(db.prepare(
        `INSERT INTO charges (bill_id, statement_id, tenant_id, unit_id, days, period_days, share_cents, tax_cents, admin_fee_cents, amount_cents, detail)
         VALUES (?, (SELECT id FROM statements WHERE billing_run_id = ? AND tenant_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(c.bill.bill_id, id, tenantId, tenantId, c.unit_id, c.days, c.period_days, c.share_cents, c.tax_cents,
        c.admin_fee_cents, c.amount_cents, JSON.stringify(c.detail)));
    }
  }
  for (const b of billSummaries) stmts.push(db.prepare('UPDATE bills SET calc_summary = ? WHERE id = ?').bind(JSON.stringify(b.summary), b.bill_id));
  const city = bills.reduce((s, b) => s + b.total_cents, 0);
  const summary = {
    ...totals, city_total_cents: city,
    owner_cost_cents: city - totals.resident_share_cents,
    vacancy_cents: billSummaries.reduce((s, b) => s + b.summary.vacancy_cents, 0),
    common_area_cents: billSummaries.reduce((s, b) => s + b.summary.common_area_cents, 0),
    period_days: billSummaries[0].summary.period_days,
    calculated_at: new Date().toISOString(),
  };
  stmts.push(db.prepare("UPDATE billing_runs SET status = 'calculated', calc_summary = ? WHERE id = ?").bind(JSON.stringify(summary), id));
  await db.batch(stmts);
  return runDetail(db, id);
}

export async function setRunStatus(db, id, action) {
  const run = await getRunRow(db, id);
  if (action === 'finalize') {
    if (run.status !== 'calculated') throw new HttpError(409, 'Calculate the batch before finalizing it');
    await db.prepare("UPDATE billing_runs SET status = 'finalized', finalized_at = datetime('now') WHERE id = ?").bind(id).run();
  } else if (action === 'reopen') {
    if (run.status !== 'finalized') throw new HttpError(409, 'This batch is not finalized');
    await db.prepare("UPDATE billing_runs SET status = 'calculated', finalized_at = NULL WHERE id = ?").bind(id).run();
  }
  return runDetail(db, id);
}

// ---------------------------------------------------------------- statement rendering + email

const STATEMENT_SQL = `
  SELECT s.*, r.period_start, r.period_end, r.statement_date, r.due_date, r.status AS run_status, r.property_id,
         t.first_name, t.last_name, t.email AS tenant_email, t.account_number, t.mailing_address, u.unit_number
  FROM statements s JOIN billing_runs r ON r.id = s.billing_run_id
  JOIN tenants t ON t.id = s.tenant_id JOIN units u ON u.id = s.unit_id`;

/** Builds the object the PDF layout and email template need. */
function renderData(row, property, companyName) {
  const cityLine = [property.city, [property.state, property.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const addressLines = row.mailing_address
    ? [row.mailing_address]
    : [[property.address, `Apt #${row.unit_number}`].filter(Boolean).join(' '), cityLine];
  return {
    id: row.id,
    property: {
      name: property.name, address: property.address, city: property.city, state: property.state, zip: property.zip,
      phone: property.phone, email: property.email,
      payment_text: property.payment_text, questions_text: property.questions_text, footer_text: property.footer_text,
    },
    company_name: companyName,
    tenant_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    first_name: row.first_name || row.last_name,
    email: row.tenant_email,
    address_lines: addressLines,
    account_number: row.account_number,
    unit_number: row.unit_number,
    statement_date: row.statement_date, due_date: row.due_date,
    period_start: row.period_start, period_end: row.period_end,
    period_days: periodLength(row.period_start, row.period_end, property.day_count),
    days: row.days,
    lines: JSON.parse(row.lines),
    total_cents: row.total_cents,
    preview: row.run_status !== 'finalized',
  };
}

export async function statementRenderData(db, { statementId, runId, tenantId, onlyFinalized = false }) {
  let sql = STATEMENT_SQL + ' WHERE 1=1';
  const args = [];
  if (statementId) { sql += ' AND s.id = ?'; args.push(statementId); }
  if (runId) { sql += ' AND s.billing_run_id = ?'; args.push(runId); }
  if (tenantId) { sql += ' AND s.tenant_id = ?'; args.push(tenantId); }
  if (onlyFinalized) sql += " AND r.status = 'finalized'";
  sql += ' ORDER BY u.unit_number COLLATE NOCASE, t.move_in';
  const rows = (await db.prepare(sql).bind(...args).all()).results;
  if (!rows.length) return [];
  const settings = await loadSettings(db);
  const props = new Map();
  for (const r of rows) if (!props.has(r.property_id)) props.set(r.property_id, await propertyRow(db, r.property_id));
  return rows.map((r) => renderData(r, props.get(r.property_id), settings.company_name));
}

export function pdfFilename(s) {
  const clean = (v) => String(v || '').replace(/[^\w-]+/g, '');
  return `Utility_Statement_${clean(s.unit_number)}_${clean(s.account_number) || s.id}_${s.statement_date}.pdf`;
}

export function pdfResponse(s, disposition = 'inline') {
  return new Response(statementsPdf([s], `Utility statement ${s.unit_number}`), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${pdfFilename(s)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

function emailVars(s) {
  return {
    first_name: s.first_name, name: s.tenant_name, property: s.property.name, unit: s.unit_number,
    account: s.account_number || '', amount: usd(s.total_cents), due_date: longDate(s.due_date),
    statement_date: longDate(s.statement_date),
    period: `${longDate(s.period_start)} – ${longDate(s.period_end)}`,
    phone: s.property.phone || '', email: s.property.email || '',
  };
}

const escHtml = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function buildEmail(s, settings) {
  const vars = emailVars(s);
  const subject = fillTemplate(settings.email_subject, vars);
  const text = fillTemplate(settings.email_body, vars);
  const rows = s.lines.map((l) => `<tr><td style="padding:6px 0">${escHtml(l.label)}</td><td style="padding:6px 0;text-align:right">${usd(l.amount_cents)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2328;max-width:560px">
    <div style="background:#0c4a6e;color:#fff;padding:16px 20px;border-bottom:4px solid #f59e0b">
      <div style="font-size:18px;font-weight:bold">${escHtml(s.property.name)}</div>
      <div style="font-size:12px">Utility statement</div></div>
    <div style="padding:16px 4px">${text.split(/\n{2,}/).map((p) => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #d0d4da;margin-top:8px">${rows}
        <tr><td style="padding:8px 0;border-top:1px solid #d0d4da;font-weight:bold">Total amount due for this statement</td>
        <td style="padding:8px 0;border-top:1px solid #d0d4da;text-align:right;font-weight:bold">${usd(s.total_cents)}</td></tr></table>
      <p style="font-size:12px;color:#6b7280">Your statement is attached as a PDF.</p></div></div>`;
  return { subject, text, html };
}

/** Emails one statement. Records success or the error on the statement. */
export async function emailStatement(db, statementId) {
  const [s] = await statementRenderData(db, { statementId });
  if (!s) throw new HttpError(404, 'Statement not found');
  if (s.preview) throw new HttpError(409, 'Finalize the batch before emailing statements');
  if (!s.email) {
    await db.prepare("UPDATE statements SET email_error = 'No email address on file' WHERE id = ?").bind(statementId).run();
    return { ok: false, error: 'No email address on file' };
  }
  const settings = await loadSettings(db, { includeSecrets: true });
  const cfg = smtpConfig(settings);
  const { subject, text, html } = buildEmail(s, settings);
  try {
    await sendMail(cfg, {
      from: settings.from_email, fromName: settings.from_name || s.property.name,
      to: s.email, toName: s.tenant_name, replyTo: settings.reply_to || s.property.email || undefined,
      bcc: settings.bcc || undefined, subject, text, html,
      attachments: [{ filename: pdfFilename(s), contentType: 'application/pdf', content: statementsPdf([s]) }],
    });
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    await db.prepare('UPDATE statements SET email_error = ? WHERE id = ?').bind(msg, statementId).run();
    return { ok: false, error: msg };
  }
  await db.prepare("UPDATE statements SET emailed_at = datetime('now'), email_to = ?, email_error = NULL WHERE id = ?")
    .bind(s.email, statementId).run();
  return { ok: true, email_to: s.email };
}
