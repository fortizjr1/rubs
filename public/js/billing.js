// Billing batches: enter the utility company's bill, run RUBS for every utility,
// review one statement per tenant, finalize, then download PDFs / email / export.
import { api, esc, money, date, fullName, toast, modal, closeModal, confirmBox, table, onActions } from './ui.js';
import { statementsPdf } from './shared/statement-pdf.js';
import { describeRule } from './rubs-ui.js';

const propertyLabel = (p) => (p.active ? p.name : `${p.name} (inactive)`);

const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s === 'finalized' ? 'finalized' : s)}</span>`;

const lineLabel = (u) => (u.statement_label || '').trim() || u.utility_name;

// Short description of how a utility or charge is billed.
const chargeRule = describeRule;

// Owner discount label, e.g. "10%" or "$200.00".
const discountLabel = (type, value) => (type === 'pct' ? `${(value / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%` : type === 'amount' ? money(value) : '');


// --------------------------------------------------------------- list

export function runsTable(runs, showProperty = true) {
  return table({
    columns: [
      ...(showProperty ? [{ label: 'Property', value: 'property_name' }] : []),
      { label: 'Service period', value: (r) => `<a href="#/billing/${r.id}">${date(r.period_start)} – ${date(r.period_end)}</a>` },
      { label: 'Utilities', value: 'utilities' },
      { label: 'Utility bill', value: (r) => money(r.city_total_cents), cls: 'num' },
      // From the batch's last calculation: utilities split from the bill, fixed charges, and the statements' total.
      { label: 'Utilities billed', value: (r) => (r.statement_count && r.summary ? money(r.summary.rubs_share_cents ?? 0) : '—'), cls: 'num' },
      { label: 'Fixed charges', value: (r) => (r.statement_count && r.summary ? money(r.summary.fixed_cents ?? 0) : '—'), cls: 'num' },
      { label: 'Total billed to tenants', value: (r) => (r.statement_count ? `<b>${money(r.billed_cents)}</b>` : '—'), cls: 'num' },
      { label: 'Statements', value: (r) => (r.statement_count ? `${r.statement_count}` : '—'), cls: 'num' },
      { label: 'Emailed', value: (r) => (r.statement_count ? `${r.emailed_count} / ${r.statement_count}` : '—'), cls: 'num' },
      { label: 'Status', value: (r) => statusBadge(r.status) },
    ],
    rows: runs,
    actions: (r) => `<a href="#/billing/${r.id}">Open</a>`,
    empty: 'No billing batches yet. When a utility bill arrives, click "New billing batch".',
  });
}

export async function runsView(el, { propertyId, filters = {} }) {
  const qs = new URLSearchParams();
  if (propertyId || filters.property_id) qs.set('property_id', propertyId || filters.property_id);
  if (filters.status) qs.set('status', filters.status);
  const [runs, props] = await Promise.all([api('/admin/runs?' + qs), propertyId ? [] : api('/admin/properties')]);
  const div = document.createElement('div');
  div.innerHTML = `<div class="notice small"><b>How billing works:</b> 1) When the bill arrives from the utility company, create a
      <b>billing batch</b> and enter each amount on it (Water, Sewer…). 2) <b>Calculate</b>: the split rules divide each amount among the
      tenants who lived there during the service period, prorated by days. 3) Review the statements and <b>Finalize</b>.
      4) <b>Email</b> the PDF statements, download them for printing, and <b>export</b> the charges to Rent Manager.</div>
    <div class="topbar"><form class="row filters" data-filters>
      ${propertyId ? '' : `<select name="property_id"><option value="">All properties</option>
        ${props.map((p) => `<option value="${p.id}" ${String(filters.property_id) === String(p.id) ? 'selected' : ''}>${esc(propertyLabel(p))}</option>`).join('')}</select>`}
      <select name="status">${[['', 'Any status'], ['draft', 'Draft'], ['calculated', 'Calculated'], ['finalized', 'Finalized']]
        .map(([v, l]) => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></form>
      <button class="primary" data-action="add">+ New billing batch</button></div>
    ${propertyId ? billHistoryChart(runs) : ''}
    ${runsTable(runs, !propertyId)}`;
  el.replaceChildren(div);
  div.querySelectorAll('[data-filters] select').forEach((s) => s.addEventListener('change', () =>
    runsView(el, { propertyId, filters: Object.fromEntries(new FormData(s.form)) })));
  onActions(div, { add: () => runForm({ property_id: propertyId }) });
}

// --------------------------------------------------------------- bill history chart

// Two series, validated with the dataviz palette checker (light surface): city bill vs. what tenants paid.
const SERIES = [
  { key: 'city', label: 'City utility bill', color: '#2a78d6' },
  { key: 'paid', label: 'Water & sewer billed to tenants', color: '#eb6834' },
];
const shortMonth = (iso) => { const [y, m] = iso.split('-'); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} '${y.slice(2)}`; };
const niceMax = (v) => { if (v <= 0) return 100; const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p / (v / p > 5 ? 2 : 1)) * p * (v / p > 5 ? 2 : 1); };
const axisMoney = (cents) => { const d = cents / 100; return d >= 1000 ? `$${(d / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}k` : `$${Math.round(d)}`; };
// Bar with a 4px rounded top, square at the baseline.
const barPath = (x, y, w, h) => { const r = Math.min(4, w / 2, h); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };

/** City bill vs. water & sewer billed to tenants for the property's last 12 finalized batches. */
function billHistoryChart(runs) {
  const data = runs.filter((r) => r.status === 'finalized' && r.summary)
    .sort((a, b) => a.period_end.localeCompare(b.period_end)).slice(-12)
    .map((r) => ({ id: r.id, end: r.period_end, start: r.period_start, city: r.summary.city_total_cents || 0,
      paid: r.summary.rubs_share_cents ?? r.summary.resident_share_cents ?? 0, discount: r.summary.discount_cents || 0 }));
  if (!data.length) return '';
  const W = 720, H = 250, padL = 52, padR = 12, padT = 14, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.city, d.paid))));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const band = plotW / data.length;
  const bw = Math.min(24, (band - 14) / 2);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const groups = data.map((d, i) => {
    const cx = padL + band * i + band / 2;
    const bars = SERIES.map((s, j) => {
      const v = d[s.key];
      const x = cx - bw - 1 + j * (bw + 2); // 2px gap between the pair
      const h = Math.max(0, (v / max) * plotH);
      return h > 0 ? `<path d="${barPath(x, y(v), bw, h)}" fill="${s.color}"/>` : '';
    }).join('');
    const rate = d.city ? `${(Math.round((d.paid / d.city) * 1000) / 10).toFixed(1)}%` : '—';
    const tip = `${d.start} to ${d.end}\nCity utility bill: ${money(d.city)}\nBilled to tenants (water & sewer): ${money(d.paid)}\nRecovery: ${rate}${d.discount ? `\nOwner discount: ${money(d.discount)}` : ''}`;
    return `<a href="#/billing/${d.id}" class="chart-hit" aria-label="${esc(tip.replace(/\n/g, ', '))}">
      <title>${esc(tip)}</title>
      <rect x="${cx - band / 2}" y="${padT}" width="${band}" height="${plotH}" fill="transparent" class="hit"/>${bars}
      <text x="${cx}" y="${H - 12}" text-anchor="middle" class="axis-label">${shortMonth(d.end)}</text></a>`;
  }).join('');
  const grid = ticks.map((t) => `<line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" class="${t ? 'grid' : 'baseline'}"/>
    <text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" class="axis-label">${axisMoney(t)}</text>`).join('');
  return `<section class="card chart-card">
    <div class="chart-head"><h3 class="m0">Bill history</h3>
      <ul class="legend">${SERIES.map((s) => `<li><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" rx="3" fill="${s.color}"/></svg>${s.label}</li>`).join('')}</ul></div>
    <p class="small muted m0">Last ${data.length} finalized batch${data.length === 1 ? '' : 'es'}, by the month the service period ended. Hover a month for the numbers; click it to open the batch.</p>
    <svg class="bill-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bill history: city utility bill and water and sewer billed to tenants per batch">${grid}${groups}</svg>
  </section>`;
}

// --------------------------------------------------------------- create / edit

export async function runForm(values = {}) {
  // Inactive (e.g. sold) properties stay selectable for a final bill, listed after the active ones.
  const props = await api('/admin/properties');
  if (!props.length) return toast('Add a property first', true);
  if (!values.property_id) values = { ...values, property_id: (props.find((p) => p.active) || props[0]).id };
  const editing = Boolean(values.id);
  const m = modal(`<h2>${editing ? 'Edit billing batch' : 'New billing batch'}</h2>
    <p class="muted small">Enter the bill exactly as the utility company sent it. Leave a utility blank if it's not on this bill.</p>
    <div class="error" hidden></div>
    <form class="form-grid" novalidate>
      <div class="field full"><label>Property *</label><select name="property_id" ${editing ? 'disabled' : ''}>
        ${props.map((p) => `<option value="${p.id}" ${String(p.id) === String(values.property_id) ? 'selected' : ''}>${esc(propertyLabel(p))}</option>`).join('')}</select></div>
      <div class="field"><label>Utility company</label><input name="vendor" value="${esc(values.vendor || '')}" placeholder="City of Tallahassee"></div>
      <div class="field"><label>Utility account #</label><input name="vendor_account" value="${esc(values.vendor_account || '')}"></div>
      <div class="field"><label>Bill date (received from the city)</label><input type="date" name="bill_date" value="${esc(values.bill_date || '')}">
        <div class="help">For your records only. Not shown on statements.</div></div>
      <div class="field"><label>Service period start *</label><input type="date" name="period_start" required value="${esc(values.period_start || '')}"></div>
      <div class="field"><label>Service period end *</label><input type="date" name="period_end" required value="${esc(values.period_end || '')}"></div>
      <h3 class="full form-heading">Charges for this batch</h3>
      <div class="full" data-lines></div>
      <div class="full discount-box" data-discount-box>
        <div class="discount-head"><b>Owner discount</b> <span class="muted small">(optional) — e.g. a courtesy credit after a pool leak</span></div>
        <div class="discount-grid">
          <div class="field"><label>Discount</label><select name="discount_type">
            <option value="none">No discount</option>
            <option value="pct" ${values.discount_type === 'pct' ? 'selected' : ''}>Percent off the utility bill</option>
            <option value="amount" ${values.discount_type === 'amount' ? 'selected' : ''}>Dollar amount off the utility bill</option></select></div>
          <div class="field" data-discount-only><label data-discount-label>Amount</label><input type="number" inputmode="decimal" step="0.01" min="0" name="discount_input"
            value="${values.discount_type === 'pct' ? (values.discount_value / 100) : values.discount_type === 'amount' ? (values.discount_value / 100).toFixed(2) : ''}"></div>
          <div class="field full" data-discount-only><label>Reason (staff only, not shown to tenants)</label>
            <input name="discount_note" value="${esc(values.discount_note || '')}" placeholder="e.g. Pool leak in October"></div>
        </div>
        <p class="small m0" data-discount-preview></p>
        <p class="small muted m0" data-discount-only>Taken off the utility bill before it is split, so every tenant's utility charge is lower.
          Fixed charges are not discounted. Statements show the charges, then Total, Discounts and Grand total, but never the reason.</p>
      </div>
      <h3 class="full form-heading">Statement dates</h3>
      <div class="field"><label>Statement date</label><input type="date" name="statement_date" value="${esc(values.statement_date || new Date().toISOString().slice(0, 10))}">
        <div class="help">Also used as the charge date in the Rent Manager export.</div></div>
      <div class="field"><label>Due date</label><input type="date" name="due_date" value="${esc(values.due_date || '')}">
        <div class="help" data-due-help></div></div>
      <div class="field full"><label>Notes</label><textarea name="notes" rows="2">${esc(values.notes || '')}</textarea></div>
      <div class="footer full"><button type="button" data-close>Cancel</button>
        <button class="primary" type="submit">${editing ? 'Save & recalculate' : 'Save & calculate'}</button></div>
    </form>`, { wide: true });
  const form = m.querySelector('form');
  const err = m.querySelector('.error');
  const linesEl = m.querySelector('[data-lines]');
  const existing = new Map((values.bills || []).map((b) => [b.property_utility_id, b.total_cents]));

  async function renderLines() {
    const pid = form.elements.property_id.value;
    const prop = props.find((p) => String(p.id) === String(pid));
    m.querySelector('[data-due-help]').textContent = `Leave blank for statement date + ${prop?.due_days ?? 28} days.`;
    const all = (await api(`/admin/utilities?property_id=${pid}`)).filter((u) => u.active || existing.has(u.id));
    const split = all.filter((u) => u.charge_method !== 'flat');
    const fixed = all.filter((u) => u.charge_method === 'flat');
    const shownAs = (u) => (lineLabel(u) !== u.utility_name ? `<div class="muted small">On statement as "${esc(lineLabel(u))}"</div>` : '');
    linesEl.innerHTML = !all.length
      ? `<div class="error">This property has no utilities set up. Add them on the property's <a href="#/properties/${pid}/utilities" data-close>Utilities & fixed charges</a> tab first.</div>`
      : `${split.length ? `<table class="lines"><thead><tr><th>Utility</th><th>Split rule</th><th class="num">Amount on bill</th></tr></thead><tbody>
        ${split.map((u) => `<tr><td><b>${esc(u.utility_name)}</b>${shownAs(u)}</td>
          <td class="small muted">${esc(chargeRule(u))}</td>
          <td class="num amt"><input type="number" inputmode="decimal" step="0.01" min="0" data-util="${u.id}" placeholder="0.00"
            value="${existing.has(u.id) ? (existing.get(u.id) / 100).toFixed(2) : ''}"></td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="2">Bill total</td><td class="num" data-total></td></tr></tfoot></table>` : ''}
        ${fixed.length ? `<table class="lines mt-sm"><thead><tr><th>Fixed monthly charges <span class="muted small">(from the property's settings)</span></th><th>Amount</th><th class="num">Include</th></tr></thead><tbody>
          ${fixed.map((u) => `<tr><td><b>${esc(u.utility_name)}</b>${shownAs(u)}</td>
            <td class="small muted">${esc(chargeRule(u))}</td>
            <td class="num inc"><input type="checkbox" data-fixed="${u.id}" ${!editing || existing.has(u.id) ? 'checked' : ''} aria-label="Include ${esc(u.utility_name)}"></td></tr>`).join('')}
          </tbody></table>
          <p class="small muted m0">These come from the property's <b>Fixed monthly charges</b> and are added to every tenant automatically. Untick one only if it shouldn't be on this batch, e.g. it's already billed in another batch for the same period.</p>` : ''}`;
    const updateTotal = () => {
      const t = [...linesEl.querySelectorAll('[data-util]')].reduce((s, i) => s + Math.round(Number(i.value || 0) * 100), 0);
      const el = linesEl.querySelector('[data-total]');
      if (el) el.textContent = money(t);
      updateDiscount();
    };
    linesEl.querySelectorAll('[data-util]').forEach((i) => i.addEventListener('input', updateTotal));
    linesEl.querySelectorAll('[data-close]').forEach((a) => a.addEventListener('click', closeModal));
    updateTotal();
  }
  // Owner discount: show the value field only when a discount is picked, and preview the result.
  const billTotal = () => [...linesEl.querySelectorAll('[data-util]')].reduce((s, i) => s + Math.round(Number(i.value || 0) * 100), 0);
  const discountCentsFor = (type, raw, total) => {
    const v = Number(raw);
    if (!(v > 0)) return 0;
    return type === 'pct' ? Math.round((total * Math.min(v, 100)) / 100) : Math.min(Math.round(v * 100), total);
  };
  function updateDiscount() {
    const type = form.elements.discount_type.value;
    const on = type !== 'none';
    m.querySelectorAll('[data-discount-only]').forEach((e) => (e.hidden = !on));
    m.querySelector('[data-discount-label]').textContent = type === 'pct' ? 'Percent off (%)' : 'Amount off ($)';
    form.elements.discount_input.placeholder = type === 'pct' ? '10' : '200.00';
    form.elements.discount_input.max = type === 'pct' ? '100' : '';
    const total = billTotal();
    const d = on ? discountCentsFor(type, form.elements.discount_input.value, total) : 0;
    m.querySelector('[data-discount-preview]').innerHTML = on && total && d
      ? `Tenants' share will be split from <b>${money(total - d)}</b> instead of ${money(total)}. The owner covers <b>${money(d)}</b>.`
      : on && !total ? '<span class="muted">Enter the utility bill amounts above first.</span>' : '';
  }
  form.elements.discount_type.addEventListener('change', updateDiscount);
  form.elements.discount_input.addEventListener('input', updateDiscount);
  form.elements.property_id.addEventListener('change', renderLines);
  await renderLines();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    err.hidden = true;
    const data = Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, v === '' ? null : v]));
    data.property_id = form.elements.property_id.value;
    delete data.discount_input;
    if (data.discount_type && data.discount_type !== 'none') {
      const v = Number(form.elements.discount_input.value);
      if (!(v > 0)) { err.textContent = 'Enter the discount amount, or choose "No discount".'; err.hidden = false; btn.disabled = false; return; }
      data.discount_value = data.discount_type === 'pct' ? Math.round(v * 100) : Math.round(v * 100);
    } else { data.discount_type = null; data.discount_note = null; }
    data.lines = [
      ...[...linesEl.querySelectorAll('[data-util]')].filter((i) => i.value !== '')
        .map((i) => ({ property_utility_id: Number(i.dataset.util), total_cents: Math.round(Number(i.value) * 100) })),
      ...[...linesEl.querySelectorAll('[data-fixed]')].filter((c) => c.checked)
        .map((c) => ({ property_utility_id: Number(c.dataset.fixed), include: true })),
    ];
    let run;
    try {
      run = editing ? await api(`/admin/runs/${values.id}`, { method: 'PUT', body: data }) : await api('/admin/runs', { method: 'POST', body: data });
    } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; return; }
    closeModal();
    try {
      await api(`/admin/runs/${run.id}/calculate`, { method: 'POST' });
      toast('Bill saved and statements calculated');
    } catch (ex) { toast(`Bill saved, but it could not be calculated: ${ex.message}`, true); }
    if (location.hash === `#/billing/${run.id}`) window.dispatchEvent(new HashChangeEvent('hashchange'));
    else location.hash = `#/billing/${run.id}`;
  });
}

// --------------------------------------------------------------- checks before finalizing

function checksHtml(checks, { compact = false } = {}) {
  const warns = checks.filter((c) => c.level === 'warn');
  const shown = compact ? warns : checks;
  return `<ul class="checks">${shown.map((c) => `<li class="${c.level}">
      <span class="chk" aria-hidden="true">${c.level === 'ok' ? '✓' : '!'}</span>
      <div><b>${esc(c.title)}</b>${c.detail ? `<div class="small muted">${esc(c.detail)}</div>` : ''}
        ${c.items?.length ? `<div class="small check-items">${c.items.slice(0, 12).map(esc).join(' · ')}${c.items.length > 12 ? ` · and ${c.items.length - 12} more` : ''}</div>` : ''}</div></li>`).join('')}</ul>`;
}

/** Finalize confirmation that lists anything that looks wrong. Resolves true to finalize. */
function finalizeBox(count, warns) {
  return new Promise((resolve) => {
    const m = modal(`<h2>Finalize ${count} statement${count === 1 ? '' : 's'}?</h2>
      ${warns.length
        ? `<div class="notice warn-notice"><b>${warns.length} thing${warns.length === 1 ? '' : 's'} to check first.</b> You can still finalize, but these are often mistakes.</div>${checksHtml(warns)}`
        : '<div class="notice ok-notice"><b>All checks passed.</b> People, unit details, emails and the bill amount look right.</div>'}
      <p class="small">Tenants will see the statements in the portal, and you can then email them and export to Rent Manager.</p>
      <div class="footer"><button data-close>Go back</button><button class="primary" data-ok>${warns.length ? 'Finalize anyway' : 'Finalize'}</button></div>`);
    m.querySelector('[data-ok]').addEventListener('click', () => { closeModal(); resolve(true); });
    m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

// --------------------------------------------------------------- detail

export async function runDetailPage(root, id) {
  const r = await api(`/admin/runs/${id}`);
  const s = r.summary;
  const emailable = r.statements.filter((x) => x.email);
  const unsent = emailable.filter((x) => !x.emailed_at);
  const exported = r.statements.filter((x) => x.exported_at).length;
  // Statement columns: one per combined statement line (e.g. "Water & Sewer"), in statement order.
  const utilNames = [...new Set(r.bills.map((b) => b.statement_label || b.utility_name))];
  const lineAmt = (st, pred) => st.lines.filter(pred).reduce((t, l) => t + l.amount_cents, 0);
  const hasTax = r.statements.some((st) => st.lines.some((l) => l.kind === 'tax'));
  const hasFee = r.statements.some((st) => st.lines.some((l) => l.kind === 'fee'));
  const step = (n, label, done, current) => `<li class="${done ? 'done' : ''} ${current ? 'current' : ''}"><span>${done ? '✓' : n}</span>${label}</li>`;

  const div = document.createElement('div');
  div.innerHTML = `<div class="topbar"><div><a href="#/billing" class="small">← Billing</a>
      <h1>${esc(r.property_name)} — ${esc(r.utilities || 'Utility bill')} ${statusBadge(r.status)}</h1>
      <div class="muted small">Service ${date(r.period_start)} – ${date(r.period_end)} (${r.period_days} days)${r.vendor ? ` · ${esc(r.vendor)}` : ''}${r.vendor_account ? ` #${esc(r.vendor_account)}` : ''}${r.bill_date ? ` · Bill received ${date(r.bill_date)}` : ''}
        · Statement ${date(r.statement_date)} · Due ${date(r.due_date)}</div></div>
      <div class="row">
        ${r.status !== 'finalized' ? '<button data-action="edit">Edit bill</button>' : ''}
        ${r.status !== 'finalized' ? `<button data-action="calc">${r.status === 'draft' ? 'Calculate' : 'Recalculate'}</button>` : ''}
        ${r.status === 'calculated' ? '<button class="primary" data-action="finalize">Finalize statements</button>' : ''}
        ${r.statements.length ? `<button data-action="pdfAll">${r.status === 'finalized' ? 'Download all PDFs' : 'Preview all PDFs'}</button>` : ''}
        ${r.statements.length ? `<a class="btn" href="/api/admin/runs/${r.id}/owner-report.pdf" target="_blank" rel="noopener">Owner report (PDF)</a>` : ''}
        ${r.status === 'finalized' ? `<button class="primary" data-action="emailAll">Email statements${unsent.length ? ` (${unsent.length})` : ''}</button>
          <a class="btn" href="/api/admin/export/charges.csv?run_id=${r.id}&mark=1" data-export>Export CSV for Rent Manager</a>
          <button data-action="reopen">Reopen</button>` : ''}
        <button class="danger" data-action="del">Delete batch</button>
      </div></div>
    <ol class="steps">
      ${step(1, 'Bill entered', true, false)}
      ${step(2, 'Calculated', r.status !== 'draft', r.status === 'draft')}
      ${step(3, 'Finalized', r.status === 'finalized', r.status === 'calculated')}
      ${step(4, `Emailed ${emailable.length ? `${emailable.length - unsent.length}/${emailable.length}` : ''}`, r.status === 'finalized' && emailable.length > 0 && !unsent.length, r.status === 'finalized' && unsent.length > 0)}
      ${step(5, `Exported to Rent Manager ${r.statements.length ? `${exported}/${r.statements.length}` : ''}`, r.statements.length > 0 && exported === r.statements.length, r.status === 'finalized' && exported < r.statements.length)}
    </ol>
    ${r.status === 'calculated' ? '<div class="notice">Review the statements below. Click a <b>PDF</b> link to preview one. When everything looks right, click <b>Finalize statements</b>. Finalized statements can be emailed and exported, and tenants can see them in the portal. If you change tenants, units or split rules, click <b>Recalculate</b> first.</div>' : ''}
    ${r.status === 'draft' ? '<div class="notice">This batch has not been calculated yet. Click <b>Calculate</b>.</div>' : ''}
    ${r.status === 'calculated' ? '<div data-checks class="checks-panel"><div class="muted small">Checking the batch…</div></div>' : ''}
    ${s ? `<div class="grid cards mb">
      <div class="card stat"><div class="label">Utility bill total</div><div class="value">${money(s.city_total_cents)}</div>
        ${s.discount_cents ? `<div class="muted small">Split after the owner discount: ${money(s.city_total_cents - s.discount_cents)}</div>` : ''}</div>
      ${s.discount_cents ? `<div class="card stat discount-stat"><div class="label">Owner discount</div><div class="value">−${money(s.discount_cents)}</div>
        <div class="muted small">${esc(discountLabel(s.discount_type, s.discount_value))} off the utility bill · tenants save ${money(s.resident_discount_cents || 0)}
        ${r.discount_note ? `<br>Reason (staff only): ${esc(r.discount_note)}` : ''}</div></div>` : ''}
      <div class="card stat"><div class="label">Billed to tenants</div><div class="value">${money(s.billed_cents)}</div>
        <div class="muted small">${money((s.rubs_share_cents ?? s.resident_share_cents))} utilities${s.fixed_cents ? ` + ${money(s.fixed_cents)} fixed charges` : ''}${s.tax_cents ? ` + ${money(s.tax_cents)} tax` : ''}${s.fee_cents ? ` + ${money(s.fee_cents)} fees` : ''}</div></div>
      <div class="card stat"><div class="label">Owner cost</div><div class="value">${money(s.owner_cost_cents)}</div>
        <div class="muted small">${money(s.common_area_cents)} common area + ${money(s.vacancy_cents)} vacant units${s.discount_cents ? ` + ${money(s.discount_cents)} owner discount` : ''}</div></div>
      <div class="card stat"><div class="label">Statements</div><div class="value">${s.statements}</div>
        <div class="muted small">${r.statements.length - emailable.length} without email (print these)</div></div>
    </div>` : ''}
    <h2>Utility bill</h2>
    ${table({
      columns: [
        { label: 'Utility', value: (b) => `<b>${esc(b.utility_name)}</b><div class="muted small">${esc(b.rm_charge_code || '')}</div>` },
        { label: 'How it is charged', value: (b) => `${esc(chargeRule(b))}${b.statement_label !== b.utility_name ? `<div class="muted small">On statement as "${esc(b.statement_label)}"</div>` : ''}` },
        { label: 'Bill amount', value: (b) => (b.charge_method === 'flat' ? '<span class="muted">fixed</span>' : money(b.total_cents)), cls: 'num' },
        { label: 'Tenants pay', value: (b) => (b.summary ? money(b.summary.resident_share_cents) : '—'), cls: 'num' },
        { label: 'Vacant (owner)', value: (b) => (b.summary && b.charge_method !== 'flat' ? money(b.summary.vacancy_cents) : '—'), cls: 'num' },
        { label: 'Common area (owner)', value: (b) => (b.summary && b.charge_method !== 'flat' ? money(b.summary.common_area_cents) : '—'), cls: 'num' },
      ],
      rows: r.bills,
    })}
    <h2 class="mt">Tenant statements</h2>
    ${table({
      columns: [
        { label: 'Unit', value: 'unit_number' },
        { label: 'Tenant', value: (st) => `${esc(fullName(st))}${st.move_out && st.move_out <= r.period_end ? ` <span class="badge draft" title="Moved out ${date(st.move_out)}">final bill</span>` : ''}<div class="muted small">${esc(st.account_number || 'no account #')}</div>` },
        { label: 'Days', value: (st) => (st.days < r.period_days ? `<b>${st.days}</b>/${r.period_days}` : `${st.days}`), cls: 'num' },
        ...utilNames.map((n) => ({ label: n, value: (st) => money(lineAmt(st, (l) => l.kind === 'utility' && l.label === n)), cls: 'num' })),
        ...(hasTax ? [{ label: 'Tax', value: (st) => money(lineAmt(st, (l) => l.kind === 'tax')), cls: 'num' }] : []),
        ...(hasFee ? [{ label: 'Fee', value: (st) => money(lineAmt(st, (l) => l.kind === 'fee')), cls: 'num' }] : []),
        { label: 'Total', value: (st) => {
          const d = st.lines.reduce((t, l) => t + (l.discount_cents || 0), 0);
          return `<b>${money(st.total_cents)}</b>${d ? `<div class="small discount-text">−${money(d)} discount</div>` : ''}`;
        }, cls: 'num' },
        { label: 'Email', value: (st) => !st.email ? '<span class="badge draft">no email</span>'
          : st.emailed_at ? `<span class="badge posted" title="${esc(st.email_to)}">sent ${date(st.emailed_at)}</span>`
          : st.email_error ? `<span class="badge danger" title="${esc(st.email_error)}">failed</span><div class="small muted">${esc(st.email_error).slice(0, 80)}</div>`
          : `<span class="muted small">${esc(st.email)}</span>` },
      ],
      rows: r.statements,
      pageKey: `run-${id}`,
      actions: (st) => `<a href="/api/admin/statements/${st.id}/pdf" target="_blank" rel="noopener">PDF</a>
        ${r.status === 'finalized' && st.email ? `<button class="link" data-action="emailOne" data-id="${st.id}">${st.emailed_at ? 'Resend' : 'Email'}</button>` : ''}`,
      empty: r.status === 'draft' ? 'Click Calculate to create the statements.' : 'No statements.',
      footer: r.statements.length ? `<tr><td colspan="3">Total (${r.statements.length})</td>
        ${utilNames.map((n) => `<td class="num">${money(r.statements.reduce((t, st) => t + lineAmt(st, (l) => l.kind === 'utility' && l.label === n), 0))}</td>`).join('')}
        ${hasTax ? `<td class="num">${money(r.statements.reduce((t, st) => t + lineAmt(st, (l) => l.kind === 'tax'), 0))}</td>` : ''}
        ${hasFee ? `<td class="num">${money(r.statements.reduce((t, st) => t + lineAmt(st, (l) => l.kind === 'fee'), 0))}</td>` : ''}
        <td class="num">${money(r.statements.reduce((t, st) => t + st.total_cents, 0))}</td><td></td><td></td></tr>` : '',
    })}`;
  root.replaceChildren(div);
  const reload = () => runDetailPage(root, id);
  const checksEl = div.querySelector('[data-checks]');
  if (checksEl) {
    api(`/admin/runs/${id}/checks`).then((checks) => {
      const warns = checks.filter((c) => c.level === 'warn');
      checksEl.innerHTML = `<div class="checks-head"><b>Checks before finalizing</b>
          <span class="badge ${warns.length ? 'draft' : 'posted'}">${warns.length ? `${warns.length} to review` : 'all good'}</span></div>${checksHtml(checks)}`;
    }).catch((e) => { checksEl.innerHTML = `<div class="small muted">Couldn't run the checks: ${esc(e.message)}</div>`; });
  }
  // The CSV downloads in place; refresh afterwards so the "Exported" step updates.
  div.querySelector('[data-export]')?.addEventListener('click', () => setTimeout(reload, 1500));
  onActions(div, {
    edit: () => runForm(r),
    calc: async () => { await api(`/admin/runs/${id}/calculate`, { method: 'POST' }); toast('Statements calculated'); reload(); },
    finalize: async () => {
      const checks = await api(`/admin/runs/${id}/checks`);
      const warns = checks.filter((c) => c.level === 'warn');
      if (!(await finalizeBox(r.statements.length, warns))) return;
      await api(`/admin/runs/${id}/finalize`, { method: 'POST' }); toast('Statements finalized'); reload();
    },
    reopen: async () => {
      const warn = emailable.length - unsent.length ? ` ${emailable.length - unsent.length} statements were already emailed; if you change amounts, tenants will need a corrected statement.` : '';
      if (!(await confirmBox(`Reopen this batch for changes? Tenants won't see it until it's finalized again.${warn}`, 'Reopen'))) return;
      await api(`/admin/runs/${id}/reopen`, { method: 'POST' }); toast('Batch reopened'); reload();
    },
    del: () => deleteRunModal(r, emailable.length - unsent.length, exported),
    pdfAll: () => downloadAllPdfs(r),
    emailOne: async ({ id: sid }) => {
      const res = await api(`/admin/statements/${sid}/email`, { method: 'POST' });
      if (res.ok) toast(`Emailed to ${res.email_to}`); else toast(`Not sent: ${res.error}`, true);
      reload();
    },
    emailAll: () => emailAllModal(r, reload),
  });
}

// Delete a batch and every tenant statement created from it, at any stage.
function deleteRunModal(r, emailedCount, exportedCount) {
  const strict = r.status === 'finalized' || emailedCount > 0 || exportedCount > 0;
  const n = r.statements.length;
  const m = modal(`<h2>Delete this billing batch?</h2>
    <p>${esc(r.property_name)} · ${esc(r.utilities || '')} · service ${date(r.period_start)} – ${date(r.period_end)}</p>
    <p>This permanently deletes:</p>
    <ul>
      <li>the utility bill amounts entered for this batch (${money(r.city_total_cents)})</li>
      <li><b>${n} tenant statement${n === 1 ? '' : 's'}</b>${n ? ` totaling ${money(r.statements.reduce((t, s) => t + s.total_cents, 0))}` : ''}, including their PDFs and RUBS calculation details</li>
      ${r.status === 'finalized' ? '<li>the statements tenants can currently see in the tenant portal</li>' : ''}
    </ul>
    <p class="muted small">Tenants, units, properties and split rules are not affected. To fix a mistake you can also use
      ${r.status === 'finalized' ? '<b>Reopen</b>, then <b>Edit bill</b>' : '<b>Edit bill</b>'} instead of deleting.</p>
    ${emailedCount ? `<div class="notice small"><b>${emailedCount} statement${emailedCount === 1 ? ' was' : 's were'} already emailed.</b>
      Emails can't be recalled. Consider letting those tenants know the statement was sent in error.</div>` : ''}
    ${exportedCount ? `<div class="notice small"><b>${exportedCount} statement${exportedCount === 1 ? ' was' : 's were'} already exported to Rent Manager.</b>
      Deleting here does not remove those charges from Rent Manager. Download the reversal file first. It has the same charges with
      negative amounts, so you can import it into Rent Manager to cancel them.
      <div class="row mt-sm"><a class="btn" href="/api/admin/export/charges.csv?run_id=${r.id}&reverse=1" data-reversal>Download reversal CSV for Rent Manager</a></div></div>` : ''}
    ${strict ? `<div class="field"><label for="del_confirm">Type <b>DELETE</b> to confirm</label>
      <input id="del_confirm" autocomplete="off" data-confirm></div>` : ''}
    <div class="error" hidden></div>
    <div class="footer"><button data-close>Cancel</button><button class="primary danger-fill" data-go ${strict ? 'disabled' : ''}>Delete batch</button></div>`);
  const go = m.querySelector('[data-go]');
  const input = m.querySelector('[data-confirm]');
  input?.addEventListener('input', () => { go.disabled = input.value.trim() !== 'DELETE'; });
  input?.focus();
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const qs = strict ? '?confirm=DELETE' : '';
      const res = await api(`/admin/runs/${r.id}${qs}`, { method: 'DELETE' });
      closeModal();
      toast(`Batch deleted with ${res.deleted.statements} statement${res.deleted.statements === 1 ? '' : 's'}`);
      location.hash = '#/billing';
    } catch (e) {
      const err = m.querySelector('.error');
      err.textContent = e.message; err.hidden = false; go.disabled = false;
    }
  });
}

async function downloadAllPdfs(r) {
  toast('Building PDF…');
  const data = await api(`/admin/runs/${r.id}/pdf-data`);
  const bytes = statementsPdf(data, `${r.property_name} utility statements`);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `Statements_${r.property_name.replace(/[^\w]+/g, '_')}_${r.period_end}${r.status === 'finalized' ? '' : '_PREVIEW'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function emailAllModal(r, after) {
  const withEmail = r.statements.filter((s) => s.email);
  const m = modal(`<h2>Email statements</h2>
    <p>${withEmail.length} of ${r.statements.length} tenants have an email address.
      ${withEmail.length < r.statements.length ? `<br><span class="muted small">${r.statements.length - withEmail.length} without email: use "Download all PDFs" to print theirs.</span>` : ''}</p>
    <label><input type="checkbox" data-resend> Also resend to tenants who were already emailed</label>
    <div class="progress" hidden><div class="bar"></div></div>
    <div class="small" data-status></div>
    <div class="log small" data-log></div>
    <div class="footer"><button data-close>Close</button><button class="primary" data-go>Send</button></div>`, { wide: true });
  const go = m.querySelector('[data-go]');
  const bar = m.querySelector('.bar');
  const status = m.querySelector('[data-status]');
  const log = m.querySelector('[data-log]');
  let stop = false;
  m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { stop = true; after(); }));
  go.addEventListener('click', async () => {
    const resend = m.querySelector('[data-resend]').checked;
    const queue = withEmail.filter((s) => resend || !s.emailed_at);
    if (!queue.length) { status.textContent = 'Everyone has already been emailed.'; return; }
    go.disabled = true;
    m.querySelector('.progress').hidden = false;
    let ok = 0, failed = 0;
    for (let i = 0; i < queue.length && !stop; i++) {
      const s = queue[i];
      status.textContent = `Sending ${i + 1} of ${queue.length}…`;
      try {
        const res = await api(`/admin/statements/${s.id}/email`, { method: 'POST' });
        if (res.ok) ok++; else { failed++; log.insertAdjacentHTML('beforeend', `<div class="error">Unit ${esc(s.unit_number)} ${esc(fullName(s))}: ${esc(res.error)}</div>`); }
      } catch (e) {
        failed++;
        log.insertAdjacentHTML('beforeend', `<div class="error">Unit ${esc(s.unit_number)} ${esc(fullName(s))}: ${esc(e.message)}</div>`);
        if (e.status === 400) break; // e.g. SMTP not configured: no point continuing
      }
      bar.style.width = `${Math.round(((i + 1) / queue.length) * 100)}%`;
    }
    status.innerHTML = `<b>Done.</b> ${ok} sent${failed ? `, ${failed} failed` : ''}.`;
    go.hidden = true;
  });
}

// --------------------------------------------------------------- settings: company + email

const SETTINGS_FIELDS = [
  ['company_name', 'Management company name', 'text', 'Printed as "Managed by …" on statements.'],
  ['payment_url', 'Online payment link (Rent Manager TWA)', 'url', 'Shown as a "Pay online" button in the tenant portal, e.g. https://walden.twa.rentmanager.com/'],
];
const SMTP_FIELDS = [
  ['smtp_host', 'SMTP server', 'text', 'Maileroo: smtp.maileroo.com'],
  ['smtp_port', 'Port', 'number', '465 (SSL) or 587 (STARTTLS)'],
  ['smtp_username', 'Username', 'text', 'From your Maileroo SMTP credentials'],
  ['smtp_password', 'Password', 'password', ''],
  ['from_email', 'From email', 'email', 'Must be on a domain verified in Maileroo'],
  ['from_name', 'From name', 'text', 'Leave blank to use the property name'],
  ['reply_to', 'Reply-to email', 'email', 'Leave blank to use the property\'s office email'],
  ['bcc', 'Send a copy (BCC) to', 'text', 'Optional, e.g. the office. Separate several with commas.'],
];

export async function emailSettingsView(el) {
  const s = await api('/admin/settings');
  const input = ([k, label, type, help]) => `<div class="field"><label for="s_${k}">${label}</label>
    <input id="s_${k}" name="${k}" type="${type}" value="${type === 'password' ? '' : esc(s[k] ?? '')}"
      ${type === 'password' ? `placeholder="${s.smtp_password_set ? '•••••••• saved – leave blank to keep' : 'Not set'}" autocomplete="new-password"` : ''}>
    ${help ? `<div class="help">${help}</div>` : ''}</div>`;
  const div = document.createElement('div');
  div.innerHTML = `<form data-settings>
    <div class="card mb"><h2>Company</h2><div class="form-grid">${SETTINGS_FIELDS.map(input).join('')}</div></div>
    <div class="card mb"><h2>Email (SMTP)</h2>
      <p class="muted small">Statements are emailed through your SMTP provider. In Maileroo, open your sending domain and copy its SMTP
        credentials. The From email must use that domain.</p>
      <div class="form-grid">
        ${input(SMTP_FIELDS[0])}
        <div class="field"><label for="s_smtp_security">Security</label><select id="s_smtp_security" name="smtp_security">
          ${[['ssl', 'SSL/TLS (port 465)'], ['starttls', 'STARTTLS (port 587 or 2525)'], ['none', 'None (not recommended)']]
            .map(([v, l]) => `<option value="${v}" ${s.smtp_security === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${SMTP_FIELDS.slice(1).map(input).join('')}
      </div></div>
    <div class="card mb"><h2>Statement email</h2>
      <p class="muted small">Placeholders: {first_name} {name} {property} {unit} {account} {amount} {due_date} {statement_date} {period} {phone} {email} {pay_link}.
        When an online payment link is set above, a <b>Pay online</b> button is added to every statement email automatically.
        The PDF statement is attached automatically.</p>
      <div class="field"><label for="s_email_subject">Subject</label><input id="s_email_subject" name="email_subject" value="${esc(s.email_subject)}"></div>
      <div class="field"><label for="s_email_body">Message</label><textarea id="s_email_body" name="email_body" rows="14">${esc(s.email_body)}</textarea></div>
    </div>
    <div class="error" hidden></div>
    <div class="row mb"><button class="primary" type="submit">Save settings</button></div>
    </form>
    <div class="card"><h2>Send a test email</h2><p class="muted small">Save your settings first.</p>
      <form class="row" data-test><input type="email" name="to" required placeholder="you@example.com" class="grow">
      <button type="submit">Send test email</button></form><div class="small" data-test-result></div></div>`;
  el.replaceChildren(div);
  const form = div.querySelector('[data-settings]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error');
    err.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    try { await api('/admin/settings', { method: 'PUT', body: data }); toast('Settings saved'); emailSettingsView(el); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  div.querySelector('[data-test]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = div.querySelector('[data-test-result]');
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    out.innerHTML = '<span class="muted">Sending…</span>';
    try {
      await api('/admin/settings/test-email', { method: 'POST', body: { to: e.target.elements.to.value } });
      out.innerHTML = '<span class="badge posted">Sent. Check the inbox (and spam folder).</span>';
    } catch (ex) { out.innerHTML = `<div class="error">${esc(ex.message)}</div>`; }
    btn.disabled = false;
  });
}
