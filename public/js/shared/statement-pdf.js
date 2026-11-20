// Resident utility statement layout (letter size), modeled on the property's sample statement.
import { PdfDocument, wrapText } from './pdf.js';

const NAVY = '#0c4a6e';
const ORANGE = '#f59e0b';
const GRAY_BG = '#f1f2f4';
const GRAY_LINE = '#d0d4da';
const TEXT = '#1f2328';
const MUTED = '#6b7280';
const WHITE = '#ffffff';

const L = 54;   // left margin
const R = 558;  // right edge

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
export const usd = (cents) => '$' + (Math.round(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const DEFAULT_TEXT = {
  payment: 'This charge has been posted to your resident account. Pay it with your rent through the resident portal, or at the office at {address}. Please do not send payment to the utility company.',
  questions: 'Call the office at {phone} or email {email}. Please report any change in the number of occupants in your apartment.',
  footer: 'Utilities are allocated to residents under the ratio utility billing method set out in your lease. This is not a bill from the utility company.',
};

// Default "Questions?" text that only mentions the contact details the property actually has.
function defaultQuestions(p) {
  const contact = p.phone && p.email ? `Call the office at ${p.phone} or email ${p.email}.`
    : p.phone ? `Call the office at ${p.phone}.`
    : p.email ? `Email the office at ${p.email}.`
    : 'Contact the leasing office.';
  return `${contact} Please report any change in the number of occupants in your apartment.`;
}

export function fillTemplate(text, vars) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

/**
 * s = {
 *   property: {name, address, city, state, zip, phone, email, payment_text, questions_text, footer_text},
 *   company_name, tenant_name, address_lines: [..], account_number, unit_number,
 *   statement_date, due_date, period_start, period_end, period_days,
 *   lines: [{label, amount_cents}], total_cents, preview: bool
 * }
 */
function drawStatement(page, s) {
  const p = s.property;
  const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const vars = { address: p.address || '', phone: p.phone || '', email: p.email || '', property: p.name };
  const contact = [p.phone, p.email].filter(Boolean).join('  ·  ');

  // Header band
  page.rect(0, 0, 612, 96, NAVY).rect(0, 96, 612, 4, ORANGE);
  page.text(String(p.name || '').toUpperCase(), L, 44, { size: 21, weight: 'bold', color: WHITE });
  page.text([p.address, cityLine].filter(Boolean).join(', '), L, 62, { size: 8.5, color: WHITE });
  page.text(contact, L, 76, { size: 8.5, color: WHITE });
  page.text(s.final ? 'FINAL UTILITY STATEMENT' : 'UTILITY STATEMENT', R, 44, { size: 12, weight: 'bold', color: s.final ? ORANGE : WHITE, align: 'right' });
  if (s.company_name) page.text(`Managed by ${s.company_name}`, R, 61, { size: 8.5, color: WHITE, align: 'right' });
  if (s.preview) page.text('PREVIEW – NOT FINAL', R, 112, { size: 8, weight: 'bold', color: '#b91c1c', align: 'right' });

  // Service for
  page.text('SERVICE FOR', L, 128, { size: 7.5, color: MUTED });
  page.text(s.tenant_name, L, 143, { size: 11, weight: 'bold', color: TEXT });
  let ay = 158;
  for (const a of s.address_lines.filter(Boolean)) {
    for (const ln of wrapText(a, 9.5, 250)) { page.text(ln, L, ay, { size: 9.5, color: TEXT }); ay += 13; }
  }

  // Account box
  const rows = [['Account number', s.account_number || '—'], ['Unit', s.unit_number], ['Statement date', longDate(s.statement_date)], ['Due date', longDate(s.due_date)]];
  if (s.final && s.move_out) rows.push(['Moved out', longDate(s.move_out)]);
  page.rect(339, 116, R - 339, 6 + rows.length * 14, GRAY_BG);
  rows.forEach(([k, v], i) => {
    const y = 129 + i * 14;
    page.text(k, 346, y, { size: 8, color: MUTED });
    page.text(v, R - 6, y, { size: 8, weight: 'bold', color: TEXT, align: 'right' });
  });

  // Amount due
  const top = Math.max(210, ay + 14);
  page.rect(L, top, R - L, 46, NAVY);
  // Amount for this statement only; payments and any other balance are in Rent Manager.
  page.text('TOTAL AMOUNT DUE FOR THIS STATEMENT', L + 18, top + 28, { size: 11, weight: 'bold', color: WHITE });
  page.text(usd(s.total_cents), R - 14, top + 32, { size: 23, weight: 'bold', color: WHITE, align: 'right' });

  // Current charges
  let y = top + 78;
  page.text('CURRENT CHARGES', L, y, { size: 10, weight: 'bold', color: NAVY });
  page.line(L, y + 6, R, y + 6, GRAY_LINE, 1);
  y += 22;
  page.text(`Service period  ${longDate(s.period_start)} – ${longDate(s.period_end)}  (${s.period_days} days)`, L + 8, y, { size: 8, color: MUTED });
  if (s.days < s.period_days) page.text(`${s.final ? 'Final bill: ' : ''}You were billed for ${s.days} of ${s.period_days} days`, R - 8, y, { size: 8, color: MUTED, align: 'right' });
  else if (s.final) page.text('Final bill', R - 8, y, { size: 8, color: MUTED, align: 'right' });
  y += 8;
  s.lines.forEach((ln, i) => {
    if (i % 2 === 0) page.rect(L, y, R - L, 18, GRAY_BG);
    page.text(ln.label, L + 8, y + 12.5, { size: 9.5, color: TEXT });
    page.text(usd(ln.amount_cents), R - 8, y + 12.5, { size: 9.5, color: TEXT, align: 'right' });
    y += 18;
  });
  page.line(L, y + 1, R, y + 1, GRAY_LINE, 1);
  y += 17;
  page.text('Total for this statement', L + 8, y, { size: 9.5, weight: 'bold', color: TEXT });
  page.text(usd(s.total_cents), R - 8, y, { size: 9.5, weight: 'bold', color: TEXT, align: 'right' });

  // Payment
  y += 34;
  page.text('PAYMENT', L, y, { size: 10, weight: 'bold', color: NAVY });
  page.line(L, y + 6, R, y + 6, GRAY_LINE, 1);
  y = page.paragraph(fillTemplate(p.payment_text || DEFAULT_TEXT.payment, vars), L + 8, y + 22, R - L - 40, { size: 9, color: TEXT, leading: 12.5 });

  // Questions box
  y += 28;
  const qLines = wrapText(p.questions_text ? fillTemplate(p.questions_text, vars) : defaultQuestions(p), 8.5, R - L - 40);
  const boxH = 30 + qLines.length * 12;
  page.rect(L, y, R - L, boxH, GRAY_BG).rect(L, y, 3.5, boxH, ORANGE);
  page.text('Questions?', L + 14, y + 16, { size: 9, weight: 'bold', color: TEXT });
  qLines.forEach((t, i) => page.text(t, L + 14, y + 30 + i * 12, { size: 8.5, color: TEXT }));

  // Footer
  const footer = wrapText(fillTemplate(p.footer_text || DEFAULT_TEXT.footer, vars), 6.8, R - L);
  const footerTop = 752 - footer.length * 9;
  page.line(L, footerTop - 10, R, footerTop - 10, GRAY_LINE, 0.75);
  footer.forEach((t, i) => page.text(t, L, footerTop + i * 9, { size: 6.8, color: MUTED }));
  page.text([p.name, [p.address, cityLine].filter(Boolean).join(', '), p.phone].filter(Boolean).join('  ·  '), L, footerTop + footer.length * 9, { size: 6.8, color: MUTED });
}

export function statementsPdf(statements, title = 'Utility statements') {
  const doc = new PdfDocument({ title });
  for (const s of statements) drawStatement(doc.addPage(), s);
  return doc.toBytes();
}
