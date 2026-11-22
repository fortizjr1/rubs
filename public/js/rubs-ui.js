// Split-rule ("RUBS template") form, rule descriptions and Test Calculation,
// laid out like Rent Manager's RUBS Template screen.
import { api, esc, money, modal, closeModal, table } from './ui.js';

export const OCCUPANCY_WEIGHTING = [
  ['headcount', 'Headcount (each person = 1)'],
  ['conservice', 'Conservice factored (1.0 / 1.6 / 1.9 / 2.2, +0.3 each additional)'],
  ['half', '1.0 + 0.5 per additional person'],
  ['cap2', 'Cap at 2 people'],
];
const WEIGHTING_SHORT = { headcount: 'headcount', conservice: 'Conservice factored', half: '1.0 + 0.5 per additional', cap2: 'capped at 2' };

const FACTORS = [
  { key: 'occupants', label: 'Occupancy', scope: false, note: 'Uses the People number on each tenant. Vacant units have 0 people.' },
  { key: 'sqft', label: 'Square Feet', scope: true, of: 'square footage' },
  { key: 'bedrooms', label: 'Bedrooms', scope: true, of: 'bedrooms' },
  { key: 'bathrooms', label: 'Bathrooms', scope: true, of: 'bathrooms' },
];
const pct = (n) => `${Math.round(Number(n) * 100) / 100}%`;

/** One-line description of how a utility is split, in Rent Manager's terms. */
export function describeAllocation(u) {
  const mode = u.allocation_mode;
  if (mode === 'even_all') return 'Divided evenly across all units';
  if (mode === 'even_occupied') return 'Divided evenly across occupied units only';
  if (mode === 'factors') {
    const parts = FACTORS.filter((f) => Number(u['w_' + f.key]) > 0)
      .map((f) => `${f.label} ${pct(u['w_' + f.key])}${f.scope ? ` (${u[f.key + '_scope'] === 'occupied' ? 'occupied units' : 'all units'})`
        : u.occupancy_weighting && u.occupancy_weighting !== 'headcount' ? ` (${WEIGHTING_SHORT[u.occupancy_weighting]})` : ''}`);
    return parts.length ? parts.join(' + ') : 'No allocation factors set';
  }
  // Older rules saved before allocation modes existed.
  const old = [['w_sqft', 'sq ft'], ['w_bedrooms', 'bedrooms'], ['w_occupants', 'occupants'], ['w_equal', 'equal']].filter(([k]) => Number(u[k]) > 0);
  const total = old.reduce((s, [k]) => s + Number(u[k]), 0);
  if (!total) return 'No split rule set';
  return old.map(([k, l]) => `${pct((Number(u[k]) / total) * 100)} ${l}`).join(' + ') + (u.vacancy_mode === 'occupied' ? ' (occupied units)' : ' (all units)');
}

export function describeRule(u) {
  const tax = Number(u.tax_pct) ? ` · +${pct(u.tax_pct)} tax` : '';
  if (u.charge_method === 'flat') return `Fixed ${money(u.flat_amount_cents)} per tenant${Number(u.flat_prorate) ? ', prorated by days' : ''}${tax}`;
  return `${pct(u.recovery_pct ?? 100)} tenant contribution · ${describeAllocation(u)}${tax}`;
}

/** Utility bill split rule form (create or edit). save(data) persists it. */
export function rubsTemplateModal({ title, values = {}, save, utilityId }) {
  const v = {
    allocation_mode: 'factors', recovery_pct: 100, tax_pct: 0, active: true,
    w_occupants: 0, w_sqft: 0, w_bedrooms: 0, w_bathrooms: 0, sqft_scope: 'all', bedrooms_scope: 'all', bathrooms_scope: 'all',
    occupancy_weighting: 'headcount',
    ...values,
  };
  if (!values.allocation_mode && values.id) {
    // Older rule: show it in the new layout.
    const onlyEqual = Number(v.w_equal) > 0 && !['w_sqft', 'w_bedrooms', 'w_occupants'].some((k) => Number(v[k]) > 0);
    v.allocation_mode = onlyEqual ? (v.vacancy_mode === 'occupied' ? 'even_occupied' : 'even_all') : 'factors';
  }
  const radio = (val, label) => `<label class="radio-row"><input type="radio" name="allocation_mode" value="${val}" ${v.allocation_mode === val ? 'checked' : ''}> ${label}</label>`;
  const m = modal(`<h2>${esc(title)}</h2>
    <form class="rubs-form" novalidate>
      <div class="rubs-grid">
        <section class="card flat-card">
          <h3>Template basics</h3>
          <div class="field"><label>Utility *</label><input name="utility_name" required value="${esc(v.utility_name || '')}" placeholder="Water, Sewer, Water/Sewer…"></div>
          <div class="field"><label>Tenant contribution *</label><div class="suffix"><input name="recovery_pct" type="number" min="0" max="100" step="0.01" value="${esc(v.recovery_pct)}"><span>%</span></div>
            <div class="help">Share of the bill passed to tenants. The rest is paid by the owner.</div></div>
          <div class="field"><label>Show on statement as</label><input name="statement_label" value="${esc(v.statement_label || '')}" placeholder="e.g. Water & Sewer">
            <div class="help">Charges with the same name are combined into one statement line.</div></div>
          <div class="form-grid">
            <div class="field"><label>Rent Manager charge code</label><input name="rm_charge_code" value="${esc(v.rm_charge_code || '')}"></div>
            <div class="field"><label>Tax added</label><div class="suffix"><input name="tax_pct" type="number" min="0" max="100" step="0.01" value="${esc(v.tax_pct ?? 0)}"><span>%</span></div></div>
            <div class="field"><label>Order on statement</label><input name="sort_order" type="number" value="${esc(v.sort_order ?? '')}"></div>
            <div class="field"><label>&nbsp;</label><label><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active</label></div>
          </div>
        </section>
        <section class="card flat-card">
          <h3>Allocation</h3>
          <p class="small muted">How the tenants' share of the bill is divided.</p>
          ${radio('even_all', 'Divide utility costs evenly across all units')}
          ${radio('even_occupied', 'Divide utility costs evenly across occupied units only')}
          ${radio('factors', 'Choose allocation factors')}
          <div class="factors" data-factors>
            ${FACTORS.map((f) => {
              const w = Number(v['w_' + f.key]) || 0;
              return `<div class="factor-row" data-factor="${f.key}">
                <label class="switch"><input type="checkbox" data-on ${w > 0 ? 'checked' : ''}><span></span>${f.label}</label>
                <div class="suffix small-input"><input type="number" min="0" max="100" step="0.01" data-w value="${w}" ${w > 0 ? '' : 'disabled'}><span>%</span></div>
                ${f.scope ? `<div class="scope small">Use ${f.of} of:
                    <label><input type="radio" name="${f.key}_scope" value="all" ${v[f.key + '_scope'] !== 'occupied' ? 'checked' : ''}> All units</label>
                    <label><input type="radio" name="${f.key}_scope" value="occupied" ${v[f.key + '_scope'] === 'occupied' ? 'checked' : ''}> Occupied units only</label></div>`
                  : `<div class="scope small"><label class="weighting">Count people as
                      <select name="occupancy_weighting">${OCCUPANCY_WEIGHTING.map(([val, l]) => `<option value="${val}" ${v.occupancy_weighting === val ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
                      <div class="muted">${f.note}</div></div>`}
              </div>`;
            }).join('')}
            <div class="factor-total" data-total></div>
            <p class="small muted m0">"All units" keeps vacant units in the calculation, so the owner pays their share.
              "Occupied units only" splits that part among tenants.</p>
          </div>
        </section>
      </div>
      <div class="error" hidden></div>
      <div class="footer">
        ${utilityId ? '<button type="button" data-test class="mr-auto">Test calculation</button>' : ''}
        <button type="button" data-close>Cancel</button><button class="primary" type="submit">Save</button></div>
    </form>`, { wide: true });
  const form = m.querySelector('form');
  const err = m.querySelector('.error');
  const factorsEl = m.querySelector('[data-factors]');
  const rows = [...m.querySelectorAll('[data-factor]')];
  const total = () => rows.reduce((t, r) => t + (r.querySelector('[data-on]').checked ? Number(r.querySelector('[data-w]').value) || 0 : 0), 0);
  const refresh = () => {
    factorsEl.hidden = form.elements.allocation_mode.value !== 'factors';
    const t = Math.round(total() * 100) / 100;
    const el = m.querySelector('[data-total]');
    el.textContent = `Total: ${t}%`;
    el.className = `factor-total ${t === 100 ? 'ok' : 'bad'}`;
  };
  rows.forEach((r) => {
    const on = r.querySelector('[data-on]'), w = r.querySelector('[data-w]');
    on.addEventListener('change', () => {
      w.disabled = !on.checked;
      if (on.checked && !(Number(w.value) > 0)) w.value = Math.max(0, Math.round((100 - total()) * 100) / 100) || 0;
      if (!on.checked) w.value = 0;
      refresh();
    });
    w.addEventListener('input', refresh);
  });
  form.querySelectorAll('[name=allocation_mode]').forEach((x) => x.addEventListener('change', refresh));
  refresh();

  const collect = () => {
    const f = form.elements;
    const mode = f.allocation_mode.value;
    const d = {
      charge_method: 'rubs', utility_name: f.utility_name.value.trim(), statement_label: f.statement_label.value.trim() || null,
      rm_charge_code: f.rm_charge_code.value.trim() || null, recovery_pct: f.recovery_pct.value === '' ? null : Number(f.recovery_pct.value),
      tax_pct: f.tax_pct.value === '' ? 0 : Number(f.tax_pct.value), sort_order: f.sort_order.value === '' ? null : Number(f.sort_order.value),
      active: f.active.checked, allocation_mode: mode, w_equal: 0,
      // Keep the older field in step for anything that still reads it.
      vacancy_mode: mode === 'even_occupied' ? 'occupied' : 'owner',
    };
    rows.forEach((r) => {
      const k = r.dataset.factor;
      d['w_' + k] = r.querySelector('[data-on]').checked ? Number(r.querySelector('[data-w]').value) || 0 : 0;
      if (f[k + '_scope']) d[k + '_scope'] = f[k + '_scope'].value;
    });
    d.occupancy_weighting = f.occupancy_weighting.value;
    return d;
  };
  const check = (d) => {
    if (!d.utility_name) return 'Enter the utility name';
    if (d.recovery_pct === null || d.recovery_pct < 0 || d.recovery_pct > 100) return 'Tenant contribution must be between 0 and 100%';
    if (d.allocation_mode === 'factors') {
      const t = Math.round(total() * 100) / 100;
      if (t <= 0) return 'Turn on at least one allocation factor';
      if (t !== 100) return `The allocation factors add up to ${t}%. They must total 100%.`;
    }
    return null;
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    const d = collect();
    const problem = check(d);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try { await save(d); closeModal(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
  m.querySelector('[data-test]')?.addEventListener('click', () => {
    const d = collect();
    const problem = check(d);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    testCalculationModal({ ...v, ...d, id: utilityId }, { config: d, back: () => rubsTemplateModal({ title, values: { ...v, ...d }, save, utilityId }) });
  });
}

function lastFullMonth() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

/**
 * Test Calculation: runs the rule on a sample bill with the property's current units and tenants.
 * opts.config tests unsaved form values; opts.back reopens the form afterwards.
 */
export function testCalculationModal(u, opts = {}) {
  const flat = u.charge_method === 'flat';
  const [ds, de] = lastFullMonth();
  const m = modal(`<h2>Test calculation · ${esc(u.utility_name)}</h2>
    <p class="small muted">${esc(describeRule(u))}. Uses the property's current units and tenants. Nothing is saved or billed.</p>
    <form class="row test-form" novalidate>
      ${flat ? '' : `<div class="field"><label>Sample bill amount ($)</label><input type="number" name="amount" min="0" step="0.01" placeholder="e.g. 1234.56" required></div>`}
      <div class="field"><label>Service period start</label><input type="date" name="start" value="${ds}"></div>
      <div class="field"><label>Service period end</label><input type="date" name="end" value="${de}"></div>
      <div class="field"><label>&nbsp;</label><button class="primary" type="submit">Calculate</button></div>
    </form>
    <div class="error" hidden></div>
    <div data-result></div>
    <div class="footer">${opts.back ? '<button type="button" data-back>Back to the template</button>' : ''}<button data-close>Close</button></div>`, { wide: true });
  m.querySelector('[data-back]')?.addEventListener('click', () => opts.back());
  const form = m.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = m.querySelector('.error');
    err.hidden = true;
    const body = { period_start: form.elements.start.value, period_end: form.elements.end.value };
    if (!flat) body.total_cents = Math.round(Number(form.elements.amount.value || 0) * 100);
    if (opts.config) body.config = opts.config;
    try {
      const r = await api(`/admin/utilities/${u.id}/test`, { method: 'POST', body });
      const s = r.summary;
      const hasTax = r.lines.some((l) => l.tax_cents);
      m.querySelector('[data-result]').innerHTML = `
        ${flat ? '' : `<div class="grid cards test-cards">
          <div class="card stat"><div class="label">Bill</div><div class="value">${money(s.total_cents)}</div></div>
          <div class="card stat"><div class="label">Tenants pay</div><div class="value">${money(s.resident_share_cents)}</div>
            <div class="muted small">${s.resident_count} tenants · ${s.period_days} days</div></div>
          <div class="card stat"><div class="label">Vacant units (owner)</div><div class="value">${money(s.vacancy_cents)}</div></div>
          <div class="card stat"><div class="label">Not contributed (owner)</div><div class="value">${money(s.common_area_cents)}</div>
            <div class="muted small">${pct(s.recovery_pct)} tenant contribution</div></div></div>`}
        ${table({
          columns: [
            { label: 'Unit', value: 'unit_number' },
            { label: 'Tenant', value: 'tenant' },
            { label: 'Days', value: (l) => `${l.days}/${l.period_days}`, cls: 'num' },
            { label: 'People', value: 'occupants', cls: 'num' },
            { label: 'Sq ft', value: (l) => Number(l.sqft).toLocaleString(), cls: 'num' },
            { label: 'Beds', value: 'bedrooms', cls: 'num' },
            { label: 'Baths', value: 'bathrooms', cls: 'num' },
            { label: 'Share', value: (l) => `<b>${money(l.share_cents)}</b>`, cls: 'num' },
            ...(hasTax ? [{ label: 'Tax', value: (l) => money(l.tax_cents), cls: 'num' }] : []),
          ],
          rows: r.lines,
          empty: 'No tenants lived at the property during this period.',
          footer: r.lines.length ? `<tr><td colspan="7">Total (${r.lines.length} tenants)</td><td class="num">${money(r.lines.reduce((t, l) => t + l.share_cents, 0))}</td>${hasTax ? `<td class="num">${money(r.lines.reduce((t, l) => t + l.tax_cents, 0))}</td>` : ''}</tr>` : '',
        })}
        ${r.vacant_units.length ? `<p class="small muted">Vacant for the whole period: ${r.vacant_units.map(esc).join(', ')}</p>` : ''}
        <p class="small muted">To compare with Rent Manager, run its Test Calculation with the same amount and dates.</p>`;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  form.querySelector('input')?.focus();
}
