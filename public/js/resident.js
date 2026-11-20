// Resident portal: profile, unit info and posted utility charges with breakdown.
import { api, esc, money, date, fullName, toast, formModal, table, onActions } from './ui.js';

const BASIS = { sqft: 'square footage', bedrooms: 'bedrooms', occupants: 'number of occupants', equal: 'equal share per unit' };

export async function startResident(app, user, logout) {
  let data;
  try { data = await api('/resident/me'); } catch (e) { if (e.status === 401) return logout(); throw e; }
  const { me, charges } = data;
  const year = new Date().getFullYear();
  const ytd = charges.filter((c) => (c.charge_date || c.period_end).startsWith(String(year))).reduce((s, c) => s + c.amount_cents, 0);
  const latest = charges[0];
  const latestTotal = latest ? charges.filter((c) => c.period_end === latest.period_end).reduce((s, c) => s + c.amount_cents, 0) : 0;

  const wrap = document.createElement('div');
  app.replaceChildren(wrap);
  wrap.innerHTML = `<div class="main centered">
    <div class="topbar"><div><h1>Hi, ${esc(me.first_name || fullName(me))}</h1>
      <div class="muted">${esc(me.property_name)} · Unit ${esc(me.unit_number)}</div></div>
      <div class="row"><button data-action="profile">Update phone</button><button data-action="password">Change password</button>
      <button data-action="logout">Sign out</button></div></div>
    <div class="grid cards mb">
      <div class="card stat"><div class="label">Latest utility charges</div><div class="value">${money(latestTotal)}</div>
        <div class="muted small">${latest ? `Service ending ${date(latest.period_end)}` : 'No charges yet'}</div></div>
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
    <h2>Utility charges</h2>
    ${table({
      columns: [
        { label: 'Utility', value: 'utility_name' },
        { label: 'Service period', value: (c) => `${date(c.period_start)} – ${date(c.period_end)}` },
        { label: 'Days billed', value: (c) => `${c.days} of ${c.period_days}` },
        { label: 'Property bill', value: (c) => money(c.bill_total_cents), cls: 'num' },
        { label: 'Your share', value: (c) => money(c.share_cents), cls: 'num' },
        { label: 'Admin fee', value: (c) => money(c.admin_fee_cents), cls: 'num' },
        { label: 'Total', value: (c) => `<b>${money(c.amount_cents)}</b>`, cls: 'num' },
        { label: '', value: (c) => `<details><summary>How was this calculated?</summary><div class="small">
            ${c.detail ? `${c.detail.recovery_pct}% of the property's bill is shared by residents.` : ''}
            ${(c.detail?.bases || []).map((d) => `<div>${d.weight_pct}% is split by ${BASIS[d.basis]}: your factor ${d.factor} × ${d.days} days = ${d.ratio_pct}% → ${money(d.share_cents)}</div>`).join('')}
          </div></details>` },
      ],
      rows: charges,
      empty: 'No utility charges have been posted to your account yet.',
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
