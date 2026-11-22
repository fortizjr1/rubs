// Owner report: one page per billing batch for the property owner. City bill, owner discount, what
// tenants paid, the owner's cost (vacant units, common area, discount), fixed charges, and the
// year-to-date totals. No tenant names or amounts.
import { PdfDocument } from '../public/js/shared/pdf.js';
import { usd, longDate } from '../public/js/shared/statement-pdf.js';
import { HttpError } from './util.js';
import { runDetail } from './billing.js';
import { loadSettings } from './settings.js';

const NAVY = '#0c4a6e', ORANGE = '#f59e0b', GRAY_BG = '#f1f2f4', GRAY_LINE = '#d0d4da', TEXT = '#1f2328', MUTED = '#6b7280', WHITE = '#ffffff', GREEN = '#067647';
const L = 54, R = 558;
const pct = (a, b) => (b ? `${(Math.round((a / b) * 1000) / 10).toFixed(1)}%` : '—');

/** Year-to-date totals for the batch's property: finalized batches whose service period ends in the same
 *  calendar year, up to and including this batch (included even if it isn't finalized yet). */
async function yearToDate(db, run) {
  const year = run.period_end.slice(0, 4);
  const rows = (await db.prepare(`SELECT r.id, r.calc_summary,
        (SELECT COUNT(*) FROM statements s WHERE s.billing_run_id = r.id) AS statements
      FROM billing_runs r WHERE r.property_id = ? AND substr(r.period_end, 1, 4) = ? AND r.period_end <= ?
        AND (r.status = 'finalized' OR r.id = ?)`).bind(run.property_id, year, run.period_end, run.id).all()).results;
  const t = { year, batches: 0, city: 0, discount: 0, recovered: 0, fixed: 0, billed: 0, owner: 0, statements: 0 };
  for (const r of rows) {
    const s = r.calc_summary ? JSON.parse(r.calc_summary) : null;
    if (!s) continue;
    t.batches++;
    t.city += s.city_total_cents || 0;
    t.discount += s.discount_cents || 0;
    t.recovered += s.rubs_share_cents ?? s.resident_share_cents ?? 0;
    t.fixed += s.fixed_cents || 0;
    t.billed += s.billed_cents || 0;
    t.owner += s.owner_cost_cents || 0;
    t.statements += r.statements;
  }
  return t;
}

export async function ownerReportPdf(db, id) {
  const run = await runDetail(db, id);
  const s = run.summary;
  if (!s || !run.statements.length) throw new HttpError(409, 'Calculate the batch first. The owner report is built from the calculated statements.');
  const prop = await db.prepare('SELECT * FROM properties WHERE id = ?').bind(run.property_id).first();
  const settings = await loadSettings(db);
  const ytd = await yearToDate(db, run);
  const split = run.bills.filter((b) => b.charge_method !== 'flat');
  const fixed = run.bills.filter((b) => b.charge_method === 'flat');
  const finals = run.statements.filter((st) => st.move_out && st.move_out <= run.period_end).length;
  const recovered = s.rubs_share_cents ?? s.resident_share_cents ?? 0;
  const taxFees = (s.tax_cents || 0) + (s.fee_cents || 0);

  const doc = new PdfDocument({ title: `Owner report ${prop.name} ${run.period_start} to ${run.period_end}` });
  const page = doc.addPage();
  const cityLine = [prop.city, [prop.state, prop.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  // Header
  page.rect(0, 0, 612, 96, NAVY).rect(0, 96, 612, 4, ORANGE);
  page.text(String(prop.name || '').toUpperCase(), L, 44, { size: 20, weight: 'bold', color: WHITE });
  page.text([prop.address, cityLine].filter(Boolean).join(', '), L, 62, { size: 8.5, color: WHITE });
  page.text('OWNER UTILITY REPORT', R, 44, { size: 12, weight: 'bold', color: WHITE, align: 'right' });
  if (settings.company_name) page.text(`Managed by ${settings.company_name}`, R, 61, { size: 8.5, color: WHITE, align: 'right' });
  if (run.status !== 'finalized') page.text('PREVIEW – BATCH NOT FINALIZED', R, 112, { size: 8, weight: 'bold', color: '#b91c1c', align: 'right' });

  // Batch facts
  const facts = [
    ['Service period', `${longDate(run.period_start)} – ${longDate(run.period_end)} (${run.period_days} days)`],
    ['Utility company', [run.vendor, run.vendor_account ? `#${run.vendor_account}` : ''].filter(Boolean).join(' ') || '—'],
    ['Bill received', run.bill_date ? longDate(run.bill_date) : '—'],
    ['Statement date', longDate(run.statement_date)],
  ];
  facts.forEach(([k, v], i) => {
    const y = 132 + i * 15;
    page.text(k, L, y, { size: 8.5, color: MUTED });
    page.text(v, L + 110, y, { size: 9, color: TEXT });
  });

  // Headline numbers
  const boxes = [
    ['Utility bill', usd(s.city_total_cents)],
    ['Paid by tenants', usd(recovered)],
    ['Recovery rate', pct(recovered, s.city_total_cents)],
    ['Owner cost', usd(s.owner_cost_cents)],
  ];
  const bw = (R - L - 18) / 4;
  boxes.forEach(([k, v], i) => {
    const x = L + i * (bw + 6);
    page.rect(x, 202, bw, 50, i === 3 ? NAVY : GRAY_BG);
    page.text(k.toUpperCase(), x + 10, 218, { size: 7, weight: 'bold', color: i === 3 ? WHITE : MUTED });
    page.text(v, x + 10, 240, { size: 15, weight: 'bold', color: i === 3 ? WHITE : TEXT });
  });

  // Utility bill table
  let y = 282;
  const section = (title) => {
    page.text(title, L, y, { size: 10, weight: 'bold', color: NAVY });
    page.line(L, y + 6, R, y + 6, GRAY_LINE, 1);
    y += 20;
  };
  section('UTILITY BILL SPLIT (RUBS)');
  const cols = [['Utility', L + 6, 'left'], ['Bill', 300, 'right'], ['Discount', 355, 'right'], ['Tenants pay', 425, 'right'], ['Vacant units', 492, 'right'], ['Common area', R - 6, 'right']];
  cols.forEach(([h, x, a]) => page.text(h, x, y, { size: 7.5, weight: 'bold', color: MUTED, align: a }));
  y += 6;
  const row = (cells, { bold = false, shade = false } = {}) => {
    if (shade) page.rect(L, y, R - L, 17, GRAY_BG);
    cells.forEach((c, i) => page.text(c, cols[i][1], y + 12, { size: 8.5, weight: bold ? 'bold' : 'regular', color: TEXT, align: cols[i][2] }));
    y += 17;
  };
  const sum = (f) => split.reduce((t, b) => t + (f(b) || 0), 0);
  split.forEach((b, i) => {
    const sm = b.summary || {};
    row([b.utility_name, usd(b.total_cents), sm.discount_cents ? `-${usd(sm.discount_cents)}` : '—', usd(sm.resident_share_cents || 0),
      usd(sm.vacancy_cents || 0), usd(sm.common_area_cents || 0)], { shade: i % 2 === 0 });
  });
  page.line(L, y + 1, R, y + 1, GRAY_LINE, 1);
  row(['Total', usd(sum((b) => b.total_cents)), s.discount_cents ? `-${usd(s.discount_cents)}` : '—', usd(sum((b) => b.summary?.resident_share_cents)),
    usd(sum((b) => b.summary?.vacancy_cents)), usd(sum((b) => b.summary?.common_area_cents))], { bold: true });
  if (s.discount_cents) {
    page.text('The owner discount was taken off the bill before it was split; the owner covers it.', L + 6, y + 8, { size: 7.5, color: MUTED });
    y += 12;
  }

  // Summary
  y += 18;
  section('THIS BATCH');
  const kv = (k, v, { bold = false, color = TEXT } = {}) => {
    page.text(k, L + 6, y, { size: 9, color: bold ? TEXT : MUTED, weight: bold ? 'bold' : 'regular' });
    page.text(v, R - 6, y, { size: 9, weight: bold ? 'bold' : 'regular', color, align: 'right' });
    y += 15;
  };
  kv('Utility bill from the city', usd(s.city_total_cents));
  if (s.discount_cents) kv('Owner discount', `-${usd(s.discount_cents)}`, { color: GREEN });
  kv('Recovered from tenants (utilities split from the bill)', usd(recovered));
  kv('Recovery rate', pct(recovered, s.city_total_cents));
  kv(`Owner cost (vacant units ${usd(s.vacancy_cents || 0)} + common area ${usd(s.common_area_cents || 0)}${s.discount_cents ? ` + discount ${usd(s.discount_cents)}` : ''})`, usd(s.owner_cost_cents), { bold: true });
  y += 4;
  for (const b of fixed) kv(`Fixed charge billed to tenants: ${b.utility_name}`, usd(b.summary?.resident_share_cents || 0));
  if (taxFees) kv('Tax and fees billed to tenants', usd(taxFees));
  kv('Total billed to tenants', usd(s.billed_cents), { bold: true });
  kv('Statements', `${run.statements.length}${finals ? ` (${finals} final bill${finals === 1 ? '' : 's'})` : ''}`);

  // Year to date
  y += 14;
  section(`YEAR TO DATE (JAN 1 – ${longDate(run.period_end).toUpperCase()})`);
  kv('Billing batches', String(ytd.batches));
  kv('Utility bills from the city', usd(ytd.city));
  if (ytd.discount) kv('Owner discounts', `-${usd(ytd.discount)}`, { color: GREEN });
  kv('Recovered from tenants (utilities split from the bill)', usd(ytd.recovered));
  kv('Recovery rate', pct(ytd.recovered, ytd.city));
  kv('Owner cost', usd(ytd.owner), { bold: true });
  kv('Fixed charges billed to tenants', usd(ytd.fixed));
  kv('Total billed to tenants', usd(ytd.billed), { bold: true });

  // Footer
  page.line(L, 742, R, 742, GRAY_LINE, 0.75);
  page.text(`Generated ${longDate(new Date().toISOString().slice(0, 10))}. Recovery rate counts only utilities split from the bill (fixed charges have no city bill behind them).`, L, 754, { size: 6.8, color: MUTED });
  page.text([prop.name, settings.company_name].filter(Boolean).join('  ·  '), L, 764, { size: 6.8, color: MUTED });

  return { bytes: doc.toBytes(), filename: `Owner_Report_${String(prop.rm_property_code || prop.name).replace(/[^\w-]+/g, '')}_${run.period_start}_${run.period_end}.pdf` };
}
