// Resident portal: profile, unit info and posted utility charges with breakdown.
import { api, esc, money, date, fullName, toast, formModal, table, onActions } from './ui.js';

const BASIS = { sqft: 'square footage', bedrooms: 'bedrooms', occupants: 'number of occupants', equal: 'equal share per unit' };

export async function startResident(app, user, logout) {
  let data;
  try { data = await api('/resident/me'); } catch (e) { if (e.status === 401) return logout(); throw e; }
  const { me, statements } = data;
  const year = new Date().getFullYear();
  const ytd = statements.filter((st) => (st.statement_date || st.period_end).startsWith(String(year))).reduce((t, st) => t + st.total_cents, 0);
  const latest = statements[0];
  const wrap = document.createElement('div');
  app.replaceChildren(wrap);
  wrap.innerHTML = `<div class="main centered">
    <div class="topbar"><div><h1>Hi, ${esc(me.first_name || fullName(me))}</h1>
      <div class="muted">${esc(me.property_name)} · Unit ${esc(me.unit_number)}</div></div>
      <div class="row"><button data-action="profile">Update phone</button><button data-action="password">Change password</button>
      <button data-action="logout">Sign out</button></div></div>
    <div class="grid cards mb">
      <div class="card stat"><div class="label">Latest statement</div><div class="value">${money(latest ? latest.total_cents : 0)}</div>
        <div class="muted small">${latest ? `Due ${date(latest.due_date)}` : 'No statements yet'}</div>
        ${latest ? `<a href="/api/resident/statements/${latest.id}/pdf" target="_blank" rel="noopener">Download PDF</a>` : ''}</div>
      <div class="card stat"><div class="label">Utility charges in ${year}</div><div class="value">${money(ytd)}</div></div>
    </div>
    <div class="grid two mb">
      <div class="card"><h2>My account</h2><dl class="kv">
        <dt>Name</dt><dd>${esc(fullName(me))}</dd>
        <dt>Account #</dt><dd>${esc(me.account_number || '—')}</dd>
        <dt>Email</dt><dd>${esc(me.email || '—')}</dd>
        <dt>Phone</dt><dd>${esc(me.phone || '—')}</dd>
        <dt>Address</dt><dd>${esc(me.mailing_address || [me.address, 'Unit ' + me.unit_number, me.city, me.state, me.zip].filter(Boolean).join(', '))}</dd></dl></div>
      <div class="card"><h2>My unit</h2><dl class="kv">
        <dt>Unit</dt><dd>${esc(me.unit_number)}</dd>
        <dt>Square feet</dt><dd>${Number(me.sqft).toLocaleString()}</dd>
        <dt>Bedrooms</dt><dd>${esc(me.bedrooms)}</dd>
        <dt>Occupants on file</dt><dd>${esc(me.occupants)}</dd>
        <dt>Move-in</dt><dd>${date(me.move_in)}</dd>
        ${me.move_out ? `<dt>Move-out</dt><dd>${date(me.move_out)}</dd>` : ''}</dl>
        <p class="muted small">If any of this is wrong, contact the office. These values are used to calculate your share.</p></div>
    </div>
    <h2>Utility statements</h2>
    ${table({
      columns: [
        { label: 'Statement date', value: (st) => date(st.statement_date) },
        { label: 'Service period', value: (st) => `${date(st.period_start)} – ${date(st.period_end)}` },
        { label: 'Charges', value: (st) => st.lines.map((l) => `${esc(l.label)} ${money(l.amount_cents)}`).join('<br>') },
        { label: 'Total', value: (st) => `<b>${money(st.total_cents)}</b>`, cls: 'num' },
        { label: 'Due', value: (st) => date(st.due_date) },
        { label: '', value: (st) => `<a href="/api/resident/statements/${st.id}/pdf" target="_blank" rel="noopener">PDF</a>
          <details><summary>How was this calculated?</summary><div class="small">
          ${st.charges.map((c) => `<div><b>${esc(c.utility_name)}</b>: the property's bill was ${money(c.bill_total_cents)}.
            ${c.detail ? `${c.detail.recovery_pct}% is shared by residents.` : ''} You were billed for ${c.days} of ${c.period_days} days.
            ${(c.detail?.bases || []).map((d) => `${d.weight_pct}% is split by ${BASIS[d.basis]}: your factor ${d.factor} × ${d.days} days = ${d.ratio_pct}% of that part → ${money(d.share_cents)}.`).join(' ')}
            ${c.tax_cents ? `Tax: ${money(c.tax_cents)}.` : ''}</div>`).join('')}
          </div></details>` },
      ],
      rows: statements,
      empty: 'No utility statements have been posted to your account yet.',
    })}
    <p class="muted small">Charges are posted to your Rent Manager ledger. Pay through your usual rent payment method.</p>
  </div>`;

  onActions(wrap, {
    logout: () => logout(),
    profile: () => formModal({ title: 'Update phone number', intro: '<p class="muted small">To change your email address, contact the office.</p>', fields: [
      { name: 'phone', label: 'Phone', type: 'tel', full: true }], values: me,
      onSubmit: async (d) => { await api('/resident/profile', { method: 'PUT', body: d }); toast('Saved'); startResident(app, user, logout); } }),
    password: () => formModal({ title: 'Change password', fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password (8+ characters)', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/resident/password', { method: 'PUT', body: d }); toast('Password changed'); } }),
  });
}
