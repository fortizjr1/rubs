// Tenant portal: latest amount due, statements with PDFs and "how was this calculated",
// account and unit details. Also used for the read-only staff preview ("Log in as a tenant").
import { api, esc, money, date, fullName, toast, formModal, onActions, ICONS, initials } from './ui.js';
import { lineGross, discountCents, statementTotals } from './shared/statement-pdf.js';

const BASIS = { sqft: 'square footage', bedrooms: 'bedrooms', bathrooms: 'bathrooms', occupants: 'number of people', equal: 'equal share per unit' };
const pdfUrl = (st) => `/api/resident/statements/${st.id}/pdf`;

function howCalculated(st) {
  return st.charges.map((c) => (c.detail?.method === 'flat'
    ? `<div class="how-item"><b>${esc(c.utility_name)}</b>: fixed charge of ${money(c.detail.amount_cents)} per billing period${c.detail.prorate && c.days < c.period_days
      ? `, prorated for the ${c.days} of ${c.period_days} days you lived there → ${money(c.share_cents)}` : ''}.${c.tax_cents ? ` Tax: ${money(c.tax_cents)}.` : ''}</div>`
    : `<div class="how-item"><b>${esc(c.utility_name)}</b>: the property's bill was ${money(c.bill_total_cents)}.
    ${c.detail?.discount_cents != null && c.bill_discount_cents ? `It was reduced by a ${money(c.bill_discount_cents)} discount before it was split, so ${money(c.bill_total_cents - c.bill_discount_cents)} was shared. Your discount: ${money(c.detail.discount_cents)}.` : ''}
    ${c.detail ? `${c.detail.recovery_pct}% of it is shared by tenants.` : ''} You were billed for ${c.days} of ${c.period_days} days.
    ${(c.detail?.bases || []).map((d) => `${d.weight_pct}% is split by ${BASIS[d.basis]}: your factor ${d.factor} × ${d.days} days = ${d.ratio_pct}% of that part → ${money(d.share_cents)}.`).join(' ')}
    ${c.tax_cents ? `Tax: ${money(c.tax_cents)}.` : ''}</div>`)).join('');
}

function statementCard(st, me) {
  const moveOut = st.tenant_move_out ?? me.move_out;
  const final = moveOut && moveOut <= st.period_end;
  // A statement from an earlier apartment of the same tenant.
  const otherUnit = st.unit_number && String(st.unit_number) !== String(me.unit_number) ? ` <span class="badge">Unit ${esc(st.unit_number)}</span>` : '';
  return `<article class="stmt">
    <div class="stmt-head">
      <div><div class="stmt-title">${date(st.period_start)} – ${date(st.period_end)}${otherUnit}${final ? ' <span class="badge draft">Final bill</span>' : ''}</div>
        <div class="muted small">Statement ${date(st.statement_date)} · Due by ${date(st.due_date)}</div></div>
      <div class="stmt-total">${money(st.total_cents)}</div>
    </div>
    <ul class="stmt-lines">${st.lines.map((l) => `<li><span>${esc(l.label)}</span><span>${money(lineGross(l))}</span></li>`).join('')}
      ${discountCents(st.lines) ? statementTotals(st).map((t, i) => `<li class="stmt-total-row${i === 0 ? ' first' : ''}${t.bold ? ' grand' : ''}${t.discount ? ' discount-text' : ''}"><span>${esc(t.label)}</span><span>${t.cents < 0 ? '-' : ''}${money(Math.abs(t.cents))}</span></li>`).join('') : ''}</ul>
    <div class="stmt-foot">
      <details><summary>How was this calculated?</summary><div class="small how">${howCalculated(st)}</div></details>
      <a class="btn" href="${pdfUrl(st)}" target="_blank" rel="noopener">${ICONS.download}<span>PDF</span></a>
    </div>
  </article>`;
}

export async function startResident(app, user, logout, stopPreview) {
  let data;
  try { data = await api('/resident/me'); } catch (e) { if (e.status === 401) return logout(); throw e; }
  const { me, statements } = data;
  const preview = user.preview;
  const year = new Date().getFullYear();
  const ytd = statements.filter((st) => (st.statement_date || st.period_end).startsWith(String(year))).reduce((t, st) => t + st.total_cents, 0);
  const latest = statements[0];
  const address = me.mailing_address || [[me.address, `Apt #${me.unit_number}`].filter(Boolean).join(' '), me.city, [me.state, me.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const office = [me.office_phone, me.office_email].filter(Boolean);
  const payUrl = /^https:\/\//i.test(user.payment_url || '') ? user.payment_url : '';
  const payButton = (cls) => (payUrl ? `<a class="btn ${cls}" href="${esc(payUrl)}" target="_blank" rel="noopener noreferrer">${ICONS.card}<span>Pay online</span></a>` : '');

  const wrap = document.createElement('div');
  wrap.className = 'portal';
  app.replaceChildren(wrap);
  wrap.innerHTML = `
    ${preview ? `<div class="preview-bar">${ICONS.eye}<span><b>Staff preview:</b> you're viewing the portal as ${esc(fullName(me))}.
      Changes are turned off.</span><button data-action="exitPreview">Back to staff view</button></div>` : ''}
    <header class="portal-head">
      <div class="portal-head-inner">
        <div class="portal-brand"><span class="logo-mark">${ICONS.drop}</span>
          <div><div class="portal-prop">${esc(me.property_name)}</div><div class="portal-sub">Tenant portal · Unit ${esc(me.unit_number)}</div></div></div>
        <div class="portal-user">
          <span class="avatar">${esc(initials(fullName(me)))}</span>
          <div class="portal-user-name">${esc(fullName(me))}<div class="portal-sub">Account #${esc(me.account_number || '—')}</div></div>
          ${preview ? '' : `<button class="ghost" data-action="logout">${ICONS.logout}<span>Sign out</span></button>`}
        </div>
      </div>
    </header>
    <main class="portal-main">
      <h1 class="portal-hello">Hi, ${esc(me.first_name || fullName(me))}</h1>
      <section class="due ${latest ? '' : 'none'}">
        ${latest ? `<div>
            <div class="due-label">Latest utility charges</div>
            <div class="due-amount">${money(latest.total_cents)}</div>
            <div class="due-meta">Statement ${date(latest.statement_date)} · Service ${date(latest.period_start)} – ${date(latest.period_end)}</div>
          </div>
          <div class="due-actions">
            ${payButton('pay')}
            <a class="btn light" href="${pdfUrl(latest)}" target="_blank" rel="noopener">${ICONS.download}<span>Download statement</span></a>
          </div>`
        : `<div><div class="due-label">Latest utility charges</div>
            <div class="due-amount none">No statements yet</div>
            <div class="due-meta">Your utility statements will appear here once the office posts them.</div></div>
          ${payUrl ? `<div class="due-actions">${payButton('pay')}</div>` : ''}`}
        <p class="due-disclaimer">This shows what was billed to you for utilities, not your current balance. Charges are posted to your
          tenant account in Rent Manager. ${payUrl ? 'Use <b>Pay online</b> to sign in to the Rent Manager tenant portal, check your balance and make a payment, or contact the office.' : 'Check your balance and make payments there, or contact the office.'}</p>
      </section>

      <div class="portal-grid">
        <section>
          <div class="section-head"><h2>Statements</h2>
            <span class="muted small">${statements.length} statement${statements.length === 1 ? '' : 's'} · ${money(ytd)} billed in ${year}</span></div>
          ${statements.length ? statements.map((st) => statementCard(st, me)).join('') : '<div class="card empty">Your statements will appear here once the office posts them.</div>'}
        </section>
        <aside>
          <div class="card side-card"><h3>${ICONS.user}<span>My account</span></h3><dl class="kv">
            <dt>Name</dt><dd>${esc(fullName(me))}</dd>
            <dt>Account #</dt><dd>${esc(me.account_number || '—')}</dd>
            <dt>Email</dt><dd>${esc(me.email || '—')}</dd>
            <dt>Phone</dt><dd>${esc(me.phone || '—')}</dd>
            <dt>Address</dt><dd>${esc(address)}</dd></dl>
            <div class="side-actions">
              <button data-action="profile" ${preview ? 'disabled title="Turned off in the staff preview"' : ''}>${ICONS.phone}<span>Update phone</span></button>
              <button data-action="password" ${preview ? 'disabled title="Turned off in the staff preview"' : ''}>${ICONS.lock}<span>Change password</span></button>
            </div></div>
          <div class="card side-card"><h3>${ICONS.building}<span>My unit</span></h3><dl class="kv">
            <dt>Unit</dt><dd>${esc(me.unit_number)}</dd>
            <dt>Square feet</dt><dd>${Number(me.sqft).toLocaleString()}</dd>
            <dt>Bedrooms</dt><dd>${esc(me.bedrooms)}</dd>
            <dt>Occupants</dt><dd>${esc(me.occupants)}</dd>
            <dt>Move-in</dt><dd>${date(me.move_in)}</dd>
            ${me.move_out ? `<dt>Move-out</dt><dd>${date(me.move_out)}</dd>` : ''}</dl>
            <p class="muted small m0">These details are used to calculate your share. If something is wrong, contact the office.</p></div>
          ${payUrl ? `<div class="card side-card pay-card"><h3>${ICONS.card}<span>Make a payment</span></h3>
            <p class="small">Pay your utility charges with your rent through the Rent Manager tenant portal (opens in a new tab).</p>
            ${payButton('primary block')}</div>` : ''}
          <div class="card side-card help-card"><h3>Questions?</h3>
            <p class="small m0">${office.length ? `Contact the office: ${office.map(esc).join(' · ')}.` : 'Contact your leasing office.'}
              Please let them know if the number of people in your apartment changes.</p></div>
        </aside>
      </div>
    </main>
    <footer class="portal-foot">${esc(me.property_name)}${user.company_name ? ` · Managed by ${esc(user.company_name)}` : ''}</footer>`;

  const again = () => startResident(app, user, logout, stopPreview);
  onActions(wrap, {
    logout: () => logout(),
    exitPreview: () => stopPreview(),
    profile: () => formModal({ title: 'Update phone number', intro: '<p class="muted small">To change your email address, contact the office.</p>', fields: [
      { name: 'phone', label: 'Phone', type: 'tel', full: true }], values: me,
      onSubmit: async (d) => { await api('/resident/profile', { method: 'PUT', body: d }); toast('Saved'); again(); } }),
    password: () => formModal({ title: 'Change password', fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/resident/password', { method: 'PUT', body: d }); toast('Password changed'); } }),
  });
}
