// Admin app: dashboard, properties, units, tenants, utilities, bills, exports, settings.
import {
  api, esc, money, date, fullName, toast, modal, closeModal, confirmBox, formModal, table, parseCSV, onActions,
} from './ui.js';

let root, currentUser, doLogout;

const NAV = [
  ['dashboard', 'Dashboard'], ['properties', 'Properties'], ['tenants', 'Tenants'],
  ['bills', 'Utility Bills'], ['exports', 'Export to Rent Manager'], ['settings', 'Settings'],
];

export function startAdmin(app, user, logout) {
  currentUser = user;
  doLogout = logout;
  app.innerHTML = `<div class="shell">
    <nav class="sidebar"><div class="brand">Utility Billing</div>
      ${NAV.map(([k, l]) => `<a href="#/${k}" data-nav="${k}">${l}</a>`).join('')}
      <div class="spacer"></div>
      <div class="small muted who">${esc(user.name || user.email)}</div>
      <a href="#" id="logout">Sign out</a>
    </nav>
    <main class="main" id="view"></main></div>`;
  root = app.querySelector('#view');
  app.querySelector('#logout').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });
  window.onhashchange = route;
  route();
}

function mount(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  root.replaceChildren(div);
  return div;
}

async function route() {
  const parts = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === parts[0]));
  root.innerHTML = '<p class="muted">Loading…</p>';
  try {
    switch (parts[0]) {
      case 'properties': return parts[1] ? await propertyDetail(parts[1], parts[2] || 'units') : await propertiesPage();
      case 'tenants': return await listPage('Tenants', (el) => tenantsView(el, {}));
      case 'bills': return parts[1] ? await billDetail(parts[1]) : await listPage('Utility Bills', (el) => billsView(el, {}));
      case 'exports': return await exportsPage();
      case 'settings': return await settingsPage();
      default: return await dashboard();
    }
  } catch (e) {
    if (e.status === 401) return doLogout();
    root.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

async function listPage(title, render) {
  const div = mount(`<div class="topbar"><h1>${esc(title)}</h1></div><div data-list></div>`);
  await render(div.querySelector('[data-list]'));
}

// --------------------------------------------------------------- shared lookups

const getProperties = () => api('/admin/properties');
const getUnits = (propertyId) => api('/admin/units' + (propertyId ? `?property_id=${propertyId}` : ''));
const getUtilities = (propertyId) => api('/admin/utilities' + (propertyId ? `?property_id=${propertyId}` : ''));
const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const propertyOptions = (props) => props.map((p) => [p.id, p.name]);

// --------------------------------------------------------------- dashboard

async function dashboard() {
  const d = await api('/admin/dashboard');
  const c = d.counts;
  const recovery = d.ytd.billed_by_utilities ? Math.round((d.ytd.charged_to_residents / d.ytd.billed_by_utilities) * 1000) / 10 : 0;
  const stat = (label, value, href) => `<a class="card stat plain" href="${href}">
    <div class="label">${label}</div><div class="value">${value}</div></a>`;
  const div = mount(`<div class="topbar"><h1>Dashboard</h1>
      <div class="row"><button data-action="import">Import tenants</button><button class="primary" data-action="addBill">+ Add utility bill</button></div></div>
    <div class="grid cards mb">
      ${stat('Properties', c.properties, '#/properties')}
      ${stat('Units', c.units, '#/properties')}
      ${stat('Current residents', c.current_tenants, '#/tenants')}
      ${stat('Upcoming move-ins', c.upcoming_move_ins, '#/tenants')}
      ${stat('Move-outs next 30 days', c.move_outs_30d, '#/tenants')}
      ${stat('Bills not posted', c.open_bills, '#/bills')}
      ${stat('Charges to export', c.unexported_charges, '#/exports')}
    </div>
    <div class="grid cards mb">
      ${stat('Utility bills this year (posted)', money(d.ytd.billed_by_utilities), '#/bills')}
      ${stat('Billed to residents this year', money(d.ytd.charged_to_residents), '#/bills')}
      ${stat('Recovery rate', recovery + '%', '#/bills')}
    </div>
    <h2>Recent utility bills</h2>
    ${billsTable(d.recent_bills)}`);
  onActions(div, {
    addBill: () => billForm({}, (b) => (location.hash = `#/bills/${b.id}`)),
    import: () => importModal(null, () => (location.hash = '#/tenants')),
  });
}

// --------------------------------------------------------------- properties

const PROPERTY_FIELDS = [
  { name: 'name', label: 'Property name', required: true, full: true },
  { name: 'rm_property_code', label: 'Rent Manager property code', help: 'Short name / ID used in Rent Manager. Goes into the export.' },
  { name: 'address', label: 'Street address' },
  { name: 'city', label: 'City' },
  { name: 'state', label: 'State' },
  { name: 'zip', label: 'ZIP' },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true },
];

async function propertiesPage() {
  const props = await getProperties();
  const div = mount(`<div class="topbar"><h1>Properties</h1>
      <div class="row"><a class="btn" href="/api/admin/export/properties.csv">Export CSV</a>
      <button class="primary" data-action="add">+ Add property</button></div></div>
    ${table({
      columns: [
        { label: 'Property', value: (p) => `<a href="#/properties/${p.id}">${esc(p.name)}</a>` },
        { label: 'RM code', value: 'rm_property_code' },
        { label: 'Address', value: (p) => esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')) },
        { label: 'Units', value: 'unit_count', cls: 'num' },
        { label: 'Current residents', value: 'current_tenants', cls: 'num' },
      ],
      rows: props,
      actions: (p) => `<button class="link" data-action="edit" data-id="${p.id}">Edit</button>
        <button class="link danger" data-action="del" data-id="${p.id}">Delete</button>`,
      empty: 'No properties yet. Add your first property to get started.',
    })}`);
  onActions(div, {
    add: () => formModal({
      title: 'Add property', fields: PROPERTY_FIELDS,
      onSubmit: async (d) => { const p = await api('/admin/properties', { method: 'POST', body: d }); location.hash = `#/properties/${p.id}/utilities`; toast('Property added. Next, set up its utilities.'); },
    }),
    edit: ({ id }) => editProperty(props.find((p) => p.id == id), propertiesPage),
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this property? Only possible if it has no units or bills.'))) return;
      await api(`/admin/properties/${id}`, { method: 'DELETE' }); toast('Deleted'); propertiesPage();
    },
  });
}

function editProperty(p, after) {
  formModal({
    title: 'Edit property', fields: PROPERTY_FIELDS, values: p,
    onSubmit: async (d) => { await api(`/admin/properties/${p.id}`, { method: 'PUT', body: d }); toast('Saved'); after(); },
  });
}

async function propertyDetail(id, tab) {
  const p = await api(`/admin/properties/${id}`);
  const tabs = [['units', 'Units'], ['tenants', 'Tenants'], ['utilities', 'Utilities & split rules'], ['bills', 'Utility bills']];
  const div = mount(`<div class="topbar"><div><a href="#/properties" class="small">← Properties</a><h1>${esc(p.name)}</h1>
      <div class="muted small">${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}
      ${p.rm_property_code ? ` · RM code: ${esc(p.rm_property_code)}` : ''}</div></div>
      <button data-action="edit">Edit property</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/properties/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    <div data-tab></div>`);
  onActions(div, { edit: () => editProperty(p, () => propertyDetail(id, tab)) });
  const el = div.querySelector('[data-tab]');
  const opts = { propertyId: Number(id) };
  if (tab === 'units') await unitsView(el, opts);
  else if (tab === 'tenants') await tenantsView(el, opts);
  else if (tab === 'utilities') await utilitiesView(el, opts);
  else await billsView(el, opts);
}

// --------------------------------------------------------------- units

async function unitsView(el, { propertyId }) {
  const [units, props] = await Promise.all([getUnits(propertyId), getProperties()]);
  const fields = [
    { name: 'property_id', label: 'Property', type: 'select', options: propertyOptions(props), required: true },
    { name: 'unit_number', label: 'Unit number', required: true },
    { name: 'sqft', label: 'Square feet', type: 'number', min: 0 },
    { name: 'bedrooms', label: 'Bedrooms', type: 'number', min: 0 },
    { name: 'bathrooms', label: 'Bathrooms', type: 'number', min: 0 },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
  const totalSqft = units.reduce((s, u) => s + Number(u.sqft || 0), 0);
  const div = document.createElement('div');
  div.innerHTML = `<div class="topbar"><div class="muted">${units.length} units · ${totalSqft.toLocaleString()} total sq ft</div>
      <div class="row"><a class="btn" href="/api/admin/export/units.csv?property_id=${propertyId || ''}">Export CSV</a>
      <button class="primary" data-action="add">+ Add unit</button></div></div>
    ${table({
      columns: [
        { label: 'Unit', value: 'unit_number' },
        { label: 'Sq ft', value: (u) => Number(u.sqft).toLocaleString(), cls: 'num' },
        { label: 'Bedrooms', value: 'bedrooms', cls: 'num' },
        { label: 'Bathrooms', value: 'bathrooms', cls: 'num' },
        { label: 'Current resident', value: (u) => u.current_tenant ? esc(u.current_tenant) : '<span class="muted">Vacant</span>' },
      ],
      rows: units,
      actions: (u) => `<button class="link" data-action="edit" data-id="${u.id}">Edit</button>
        <button class="link danger" data-action="del" data-id="${u.id}">Delete</button>`,
      empty: 'No units yet. Add units here, or import tenants and units will be created automatically.',
    })}`;
  el.replaceChildren(div);
  const reload = () => unitsView(el, { propertyId });
  onActions(div, {
    add: () => formModal({ title: 'Add unit', fields, values: { property_id: propertyId },
      onSubmit: async (d) => { await api('/admin/units', { method: 'POST', body: d }); toast('Unit added'); reload(); } }),
    edit: ({ id }) => formModal({ title: 'Edit unit', fields, values: units.find((u) => u.id == id),
      onSubmit: async (d) => { await api(`/admin/units/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); } }),
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this unit? Only possible if no tenants are attached.'))) return;
      await api(`/admin/units/${id}`, { method: 'DELETE' }); toast('Deleted'); reload();
    },
  });
}

// --------------------------------------------------------------- tenants

async function tenantFields(propertyId) {
  const units = await getUnits(propertyId);
  return [
    { name: 'unit_id', label: 'Property / unit', type: 'select', required: true, full: true,
      options: units.map((u) => [u.id, `${u.property_name} — Unit ${u.unit_number}`]),
      help: units.length ? '' : 'No units yet. Add units to the property first.' },
    { name: 'first_name', label: 'First name' },
    { name: 'last_name', label: 'Last name', required: true },
    { name: 'email', label: 'Email', type: 'email' },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'account_number', label: 'Account number', help: 'Rent Manager tenant account / ID. Must be unique.' },
    { name: 'occupants', label: 'Number of people in unit', type: 'number', min: 0 },
    { name: 'mailing_address', label: 'Address', full: true },
    { name: 'move_in', label: 'Move-in date', type: 'date', required: true },
    { name: 'move_out', label: 'Move-out date', type: 'date', help: 'Leave blank for current residents.' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
}

async function tenantsView(el, { propertyId, filters = {} }) {
  const qs = new URLSearchParams();
  if (propertyId || filters.property_id) qs.set('property_id', propertyId || filters.property_id);
  if (filters.tenant_status) qs.set('tenant_status', filters.tenant_status);
  if (filters.q) qs.set('q', filters.q);
  const [tenants, props] = await Promise.all([api('/admin/tenants?' + qs), propertyId ? [] : getProperties()]);
  const div = document.createElement('div');
  div.innerHTML = `<div class="topbar"><form class="row filters" data-filters>
        ${propertyId ? '' : `<select name="property_id"><option value="">All properties</option>
          ${props.map((p) => `<option value="${p.id}" ${String(filters.property_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
        <select name="tenant_status">
          ${[['', 'All residents'], ['current', 'Current'], ['future', 'Future move-ins'], ['past', 'Moved out']]
            .map(([v, l]) => `<option value="${v}" ${filters.tenant_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input name="q" placeholder="Search name, email, unit, account…" value="${esc(filters.q || '')}">
        <button type="submit">Search</button></form>
      <div class="row"><a class="btn" href="/api/admin/export/tenants.csv?${qs}">Export CSV</a>
        <button data-action="import">Import CSV</button>
        <button class="primary" data-action="add">+ Add tenant</button></div></div>
    ${table({
      columns: [
        { label: 'Name', value: (t) => esc(fullName(t)) },
        { label: propertyId ? 'Unit' : 'Property / unit', value: (t) => esc(propertyId ? t.unit_number : `${t.property_name} — ${t.unit_number}`) },
        { label: 'Account', value: 'account_number' },
        { label: 'Contact', value: (t) => `${esc(t.email || '')}<div class="muted small">${esc(t.phone || '')}</div>` },
        { label: 'Move-in', value: (t) => date(t.move_in) },
        { label: 'Move-out', value: (t) => date(t.move_out) },
        { label: 'People', value: 'occupants', cls: 'num' },
        { label: 'Status', value: (t) => statusBadge(t.status) + (t.portal_active ? ' <span class="badge" title="Resident portal activated">portal</span>' : '') },
      ],
      rows: tenants,
      actions: (t) => `<button class="link" data-action="edit" data-id="${t.id}">Edit</button>
        ${!t.move_out ? `<button class="link" data-action="moveout" data-id="${t.id}">Move out</button>` : ''}
        ${t.portal_active ? `<button class="link" data-action="resetPortal" data-id="${t.id}">Reset login</button>` : ''}
        <button class="link danger" data-action="del" data-id="${t.id}">Delete</button>`,
      empty: 'No tenants found. Add one, or import a CSV.',
    })}
    <p class="muted small">${tenants.length} tenant${tenants.length === 1 ? '' : 's'}</p>`;
  el.replaceChildren(div);
  const reload = (f = filters) => tenantsView(el, { propertyId, filters: f });
  div.querySelector('[data-filters]').addEventListener('submit', (e) => {
    e.preventDefault();
    reload(Object.fromEntries(new FormData(e.target)));
  });
  div.querySelectorAll('[data-filters] select').forEach((s) => s.addEventListener('change', () => s.form.requestSubmit()));
  onActions(div, {
    add: async () => formModal({ title: 'Add tenant', fields: await tenantFields(propertyId), values: { occupants: 1 },
      onSubmit: async (d) => { await api('/admin/tenants', { method: 'POST', body: d }); toast('Tenant added'); reload(); } }),
    edit: async ({ id }) => {
      const t = tenants.find((x) => x.id == id);
      formModal({ title: 'Edit tenant', fields: await tenantFields(propertyId || t.property_id), values: t,
        onSubmit: async (d) => { await api(`/admin/tenants/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); } });
    },
    moveout: ({ id }) => {
      const t = tenants.find((x) => x.id == id);
      formModal({ title: `Move out ${fullName(t)}`, submitLabel: 'Save move-out',
        intro: '<p class="muted small">Charges for bills that overlap this date will be prorated by days occupied (the move-out day counts as occupied).</p>',
        fields: [{ name: 'move_out', label: 'Move-out date', type: 'date', required: true }],
        values: { move_out: new Date().toISOString().slice(0, 10) },
        onSubmit: async (d) => { await api(`/admin/tenants/${id}`, { method: 'PUT', body: d }); toast('Move-out saved'); reload(); } });
    },
    resetPortal: async ({ id }) => {
      if (!(await confirmBox('Reset this resident\'s portal login? They will need to activate their account again.', 'Reset'))) return;
      await api(`/admin/tenants/${id}/reset-portal`, { method: 'POST' }); toast('Portal login reset'); reload();
    },
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this tenant? Tenants with billing history cannot be deleted. Set a move-out date instead.'))) return;
      await api(`/admin/tenants/${id}`, { method: 'DELETE' }); toast('Deleted'); reload();
    },
    import: () => importModal(propertyId, () => reload()),
  });
}

async function importModal(propertyId, after) {
  const props = await getProperties();
  const m = modal(`<h2>Import tenants from CSV</h2>
    <div class="notice small">Columns are matched by name (case doesn't matter). Recognized: <b>Property, Unit, First Name, Last Name</b> (or <b>Name</b>),
      <b>Email, Phone, Account Number, Address, Move In, Move Out, Occupants, Sq Ft, Bedrooms</b>.
      Dates can be YYYY-MM-DD or MM/DD/YYYY. Tenants with an existing account number are updated instead of duplicated.
      <a href="/tenant-import-template.csv" download>Download a template</a>.</div>
    <div class="error" hidden></div>
    <div class="form-grid">
      <div class="field full"><label>CSV file</label><input type="file" accept=".csv,text/csv" data-file></div>
      <div class="field"><label>Property (for rows without a Property column)</label>
        <select data-prop><option value="">—</option>${props.map((p) => `<option value="${p.id}" ${p.id == propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      <div class="field"><label><input type="checkbox" data-create checked> Create units that don't exist yet</label>
        <label><input type="checkbox" data-skip> Skip rows with errors and import the rest</label></div>
    </div>
    <div data-preview></div>
    <div class="footer"><button data-close>Cancel</button><button class="primary" data-go disabled>Import</button></div>`, { wide: true });
  let rows = [];
  const err = m.querySelector('.error');
  const go = m.querySelector('[data-go]');
  m.querySelector('[data-file]').addEventListener('change', async (e) => {
    err.hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    rows = parseCSV(await file.text());
    const headers = rows.length ? Object.keys(rows[0]) : [];
    m.querySelector('[data-preview]').innerHTML = rows.length
      ? `<p><b>${rows.length}</b> rows found. Preview:</p>${table({ columns: headers.map((h) => ({ label: h, value: (r) => esc(r[h]) })), rows: rows.slice(0, 5) })}`
      : '<p class="error">No data rows found in that file.</p>';
    go.disabled = !rows.length;
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    err.hidden = true;
    const total = { imported: 0, units_created: 0, errors: [] };
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const r = await api('/admin/tenants/import', { method: 'POST', body: {
          rows: rows.slice(i, i + 500), property_id: m.querySelector('[data-prop]').value || null,
          create_units: m.querySelector('[data-create]').checked, skip_errors: m.querySelector('[data-skip]').checked,
        } });
        total.imported += r.imported;
        total.units_created += r.units_created;
        total.errors.push(...r.errors.map((x) => ({ ...x, line: x.line + i })));
      }
    } catch (e2) { err.textContent = e2.message; err.hidden = false; go.disabled = false; return; }
    if (total.errors.length && !total.imported) {
      err.innerHTML = `Nothing was imported. Fix these rows (or tick "Skip rows with errors"):<ul>${total.errors.slice(0, 50).map((x) => `<li>Line ${x.line}: ${esc(x.error)}</li>`).join('')}</ul>`;
      err.hidden = false; go.disabled = false; return;
    }
    closeModal();
    toast(`Imported ${total.imported} tenants${total.units_created ? `, created ${total.units_created} units` : ''}${total.errors.length ? `, skipped ${total.errors.length} rows` : ''}`);
    after();
  });
}

// --------------------------------------------------------------- utilities (split rules)

const UTILITY_HELP = `<div class="notice small"><b>How the split works (RUBS):</b> First, <b>Recovery %</b> of the bill is passed to residents.
  The rest (common areas, office, pool, etc.) is paid by the owner. That amount is then divided using the <b>weights</b>, for example
  100 for square footage only, or 50 sq ft + 50 occupants. Each resident's share = their factor × days occupied ÷ the total for the property.
  <br><b>Vacancy handling:</b> "Owner absorbs vacant units" counts vacant unit-days, so the owner pays the vacant share (recommended).
  "Split among occupied units only" divides 100% of the billable amount among residents.</div>`;

const UTILITY_FIELDS = [
  { name: 'utility_name', label: 'Utility', required: true, placeholder: 'Water, Sewer, Trash, Gas, Electric…' },
  { name: 'rm_charge_code', label: 'Rent Manager charge code', help: 'The charge type in Rent Manager, e.g. WATER' },
  { name: 'recovery_pct', label: 'Recovery % billed to residents', type: 'number', min: 0, help: 'Example: 85 means 15% is deducted for common areas' },
  { name: 'admin_fee_cents', label: 'Admin / billing fee per resident ($)', type: 'money', min: 0, help: 'Flat amount added to each resident\'s charge' },
  { name: 'w_sqft', label: 'Weight: square footage', type: 'number', min: 0 },
  { name: 'w_bedrooms', label: 'Weight: bedrooms', type: 'number', min: 0 },
  { name: 'w_occupants', label: 'Weight: number of occupants', type: 'number', min: 0 },
  { name: 'w_equal', label: 'Weight: equal per unit', type: 'number', min: 0 },
  { name: 'vacancy_mode', label: 'Vacancy handling', type: 'select', required: true,
    options: [['owner', 'Owner absorbs vacant units'], ['occupied', 'Split among occupied units only']] },
  { name: 'vacant_occupants', label: 'Occupants assumed for vacant units', type: 'number', min: 0, help: 'Only used with the occupants weight and "owner absorbs"' },
  { name: 'active', label: 'Active', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true },
];

function describeWeights(u) {
  const parts = [['w_sqft', 'sq ft'], ['w_bedrooms', 'bedrooms'], ['w_occupants', 'occupants'], ['w_equal', 'equal']]
    .filter(([k]) => Number(u[k]) > 0);
  const total = parts.reduce((s, [k]) => s + Number(u[k]), 0);
  if (!total) return '<span class="error small">Not set</span>';
  return parts.map(([k, l]) => `${Math.round((Number(u[k]) / total) * 1000) / 10}% ${l}`).join(' + ');
}

async function utilitiesView(el, { propertyId }) {
  const utils = await getUtilities(propertyId);
  const div = document.createElement('div');
  div.innerHTML = `${UTILITY_HELP}<div class="topbar"><div></div><button class="primary" data-action="add">+ Add utility</button></div>
    ${table({
      columns: [
        { label: 'Utility', value: (u) => esc(u.utility_name) + (u.active ? '' : ' <span class="badge">inactive</span>') },
        { label: 'RM charge code', value: 'rm_charge_code' },
        { label: 'Recovery', value: (u) => `${u.recovery_pct}%`, cls: 'num' },
        { label: 'Split by', value: describeWeights },
        { label: 'Vacancy', value: (u) => (u.vacancy_mode === 'owner' ? 'Owner absorbs' : 'Occupied only') },
        { label: 'Admin fee', value: (u) => money(u.admin_fee_cents), cls: 'num' },
      ],
      rows: utils,
      actions: (u) => `<button class="link" data-action="edit" data-id="${u.id}">Edit</button>
        <button class="link danger" data-action="del" data-id="${u.id}">Delete</button>`,
      empty: 'No utilities set up. Add one for each utility you bill back (water, sewer, trash…).',
    })}`;
  el.replaceChildren(div);
  const reload = () => utilitiesView(el, { propertyId });
  onActions(div, {
    add: () => formModal({ title: 'Add utility', fields: UTILITY_FIELDS, wide: true,
      values: { recovery_pct: 100, w_sqft: 100, vacancy_mode: 'owner', vacant_occupants: 1, active: true, admin_fee_cents: 0 },
      onSubmit: async (d) => { await api('/admin/utilities', { method: 'POST', body: { ...d, property_id: propertyId } }); toast('Utility added'); reload(); } }),
    edit: ({ id }) => formModal({ title: 'Edit utility', fields: UTILITY_FIELDS, wide: true, values: utils.find((u) => u.id == id),
      onSubmit: async (d) => { await api(`/admin/utilities/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); } }),
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this utility?'))) return;
      await api(`/admin/utilities/${id}`, { method: 'DELETE' }); toast('Deleted'); reload();
    },
  });
}

// --------------------------------------------------------------- bills

function billsTable(bills, showProperty = true) {
  return table({
    columns: [
      ...(showProperty ? [{ label: 'Property', value: 'property_name' }] : []),
      { label: 'Utility', value: (b) => `<a href="#/bills/${b.id}">${esc(b.utility_name)}</a>` },
      { label: 'Service period', value: (b) => `${date(b.period_start)} – ${date(b.period_end)}` },
      { label: 'Vendor', value: 'vendor' },
      { label: 'Bill total', value: (b) => money(b.total_cents), cls: 'num' },
      { label: 'Billed to residents', value: (b) => (b.charge_count ? money(b.charged_cents) : '—'), cls: 'num' },
      { label: 'Status', value: (b) => statusBadge(b.status) },
    ],
    rows: bills,
    actions: (b) => `<a href="#/bills/${b.id}">Open</a>`,
    empty: 'No utility bills yet.',
  });
}

async function billsView(el, { propertyId, filters = {} }) {
  const qs = new URLSearchParams();
  if (propertyId || filters.property_id) qs.set('property_id', propertyId || filters.property_id);
  if (filters.status) qs.set('status', filters.status);
  const [bills, props] = await Promise.all([api('/admin/bills?' + qs), propertyId ? [] : getProperties()]);
  const div = document.createElement('div');
  div.innerHTML = `<div class="topbar"><form class="row filters" data-filters>
      ${propertyId ? '' : `<select name="property_id"><option value="">All properties</option>
        ${props.map((p) => `<option value="${p.id}" ${String(filters.property_id) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`}
      <select name="status">${[['', 'Any status'], ['draft', 'Draft'], ['calculated', 'Calculated'], ['posted', 'Posted']]
        .map(([v, l]) => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></form>
      <div class="row"><a class="btn" href="/api/admin/export/bills.csv?${qs}">Export CSV</a>
      <button class="primary" data-action="add">+ Add utility bill</button></div></div>
    ${billsTable(bills, !propertyId)}`;
  el.replaceChildren(div);
  div.querySelectorAll('[data-filters] select').forEach((s) => s.addEventListener('change', () =>
    billsView(el, { propertyId, filters: Object.fromEntries(new FormData(s.form)) })));
  onActions(div, { add: () => billForm({ property_id: propertyId }, (b) => (location.hash = `#/bills/${b.id}`)) });
}

async function billForm(values, after) {
  const [props, utils] = await Promise.all([getProperties(), getUtilities()]);
  if (!props.length) return toast('Add a property first', true);
  const utilOptions = (pid) => utils.filter((u) => u.property_id == pid && (u.active || u.id == values.property_utility_id)).map((u) => [u.id, u.utility_name]);
  const startProp = values.property_id || props[0].id;
  const fields = [
    { name: 'property_id', label: 'Property', type: 'select', required: true, options: propertyOptions(props) },
    { name: 'property_utility_id', label: 'Utility', type: 'select', required: true, options: utilOptions(startProp),
      help: 'Utilities and split rules are set up on the property\'s "Utilities" tab.' },
    { name: 'vendor', label: 'Utility company' },
    { name: 'vendor_account', label: 'Utility account #' },
    { name: 'period_start', label: 'Service period start', type: 'date', required: true },
    { name: 'period_end', label: 'Service period end', type: 'date', required: true },
    { name: 'total_cents', label: 'Bill total ($)', type: 'money', required: true, min: 0 },
    { name: 'statement_date', label: 'Statement date', type: 'date' },
    { name: 'charge_date', label: 'Charge date for Rent Manager', type: 'date', help: 'Transaction date used in the export. Defaults to today.' },
    { name: 'notes', label: 'Notes', type: 'textarea', full: true },
  ];
  const m = formModal({
    title: values.id ? 'Edit utility bill' : 'Add utility bill', fields, values: { ...values, property_id: startProp },
    intro: values.id && values.status !== 'draft' ? '<div class="notice small">Saving changes clears the current calculation. Click Calculate again afterwards.</div>' : '',
    onSubmit: async (d) => {
      const b = values.id
        ? await api(`/admin/bills/${values.id}`, { method: 'PUT', body: d })
        : await api('/admin/bills', { method: 'POST', body: d });
      toast('Bill saved');
      after(b);
    },
  });
  const propSel = m.querySelector('[name=property_id]');
  const utilSel = m.querySelector('[name=property_utility_id]');
  propSel.addEventListener('change', () => {
    utilSel.innerHTML = utilOptions(propSel.value).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  });
}

async function billDetail(id) {
  const b = await api(`/admin/bills/${id}`);
  const s = b.summary;
  const basisLabel = { sqft: 'Sq ft', bedrooms: 'Bedrooms', occupants: 'Occupants', equal: 'Equal' };
  const chargesTotal = b.charges.reduce((t, c) => t + c.amount_cents, 0);
  const div = mount(`<div class="topbar"><div><a href="#/bills" class="small">← Utility bills</a>
      <h1>${esc(b.property_name)} — ${esc(b.utility_name)} ${statusBadge(b.status)}</h1>
      <div class="muted small">Service ${date(b.period_start)} – ${date(b.period_end)}${b.vendor ? ` · ${esc(b.vendor)}` : ''}${b.vendor_account ? ` #${esc(b.vendor_account)}` : ''}</div></div>
      <div class="row">
        ${b.status !== 'posted' ? '<button data-action="edit">Edit</button>' : ''}
        ${b.status !== 'posted' ? `<button class="primary" data-action="calc">${b.status === 'calculated' ? 'Recalculate' : 'Calculate charges'}</button>` : ''}
        ${b.status === 'calculated' ? '<button class="primary" data-action="post">Post charges</button>' : ''}
        ${b.status === 'posted' ? `<a class="btn primary" href="/api/admin/export/charges.csv?bill_id=${b.id}">Export CSV for Rent Manager</a><button data-action="unpost">Unpost</button>` : ''}
        ${b.status !== 'posted' ? '<button class="danger" data-action="del">Delete</button>' : ''}
      </div></div>
    ${b.status === 'draft' ? '<div class="notice">Click <b>Calculate charges</b> to split this bill among residents. Review the results, then <b>Post</b> to make them visible to residents and ready to export.</div>' : ''}
    ${b.status === 'calculated' ? '<div class="notice">Review the charges below. When they look right, click <b>Post charges</b>. Residents see posted charges, and posted charges can be exported. If you change tenants or units, click Recalculate.</div>' : ''}
    <div class="grid two mb">
      <div class="card"><h2>Bill</h2><dl class="kv">
        <dt>Bill total</dt><dd>${money(b.total_cents)}</dd>
        <dt>Statement date</dt><dd>${date(b.statement_date) || '—'}</dd>
        <dt>Charge date (export)</dt><dd>${date(b.charge_date) || '—'}</dd>
        <dt>RM charge code</dt><dd>${esc(b.rm_charge_code || b.utility_name)}</dd>
        ${b.notes ? `<dt>Notes</dt><dd>${esc(b.notes)}</dd>` : ''}</dl></div>
      <div class="card"><h2>Calculation</h2>${s ? `<dl class="kv">
        <dt>Days in period</dt><dd>${s.period_days}</dd>
        <dt>Split by</dt><dd>${Object.entries(s.weights).map(([k, w]) => `${basisLabel[k]} (${w})`).join(' + ')}</dd>
        <dt>Recovery</dt><dd>${s.recovery_pct}% → ${money(s.billable_cents)} billable</dd>
        <dt>Common area (owner)</dt><dd>${money(s.common_area_cents)}</dd>
        <dt>Vacant units (owner)</dt><dd>${money(s.vacancy_cents)}</dd>
        <dt>Resident share</dt><dd>${money(s.resident_share_cents)} across ${s.resident_count} residents</dd>
        <dt>Admin fees</dt><dd>${money(s.admin_fees_cents)}</dd>
        <dt><b>Total billed to residents</b></dt><dd><b>${money(s.billed_to_residents_cents)}</b></dd>
        <dt>Owner cost</dt><dd>${money(s.owner_cost_cents)}</dd></dl>` : '<p class="muted">Not calculated yet.</p>'}</div>
    </div>
    <h2>Resident charges</h2>
    ${table({
      columns: [
        { label: 'Unit', value: 'unit_number' },
        { label: 'Resident', value: (c) => `${esc(fullName(c))}<div class="muted small">${esc(c.account_number || '')}</div>` },
        { label: 'Occupied', value: (c) => `${c.days}/${c.period_days} days<div class="muted small">${date(c.move_in)}${c.move_out ? ' – ' + date(c.move_out) : ''}</div>` },
        { label: 'Sq ft / BR / people', value: (c) => `${Number(c.sqft).toLocaleString()} / ${c.bedrooms} / ${c.occupants}` },
        { label: 'Utility share', value: (c) => money(c.share_cents), cls: 'num' },
        { label: 'Admin fee', value: (c) => money(c.admin_fee_cents), cls: 'num' },
        { label: 'Total', value: (c) => `<b>${money(c.amount_cents)}</b>`, cls: 'num' },
        { label: 'Details', value: (c) => `<details><summary>How</summary>${(c.detail?.bases || []).map((d) =>
          `<div class="small">${basisLabel[d.basis]} (${d.weight_pct}% of billable): factor ${d.factor} × ${d.days} days = ${d.ratio_pct}% → ${money(d.share_cents)}</div>`).join('')}</details>` },
      ],
      rows: b.charges,
      empty: b.status === 'draft' ? 'Not calculated yet.' : 'No residents occupied a unit during this service period.',
      footer: b.charges.length ? `<tr><td colspan="4">Total</td><td class="num">${money(b.charges.reduce((t, c) => t + c.share_cents, 0))}</td>
        <td class="num">${money(b.charges.reduce((t, c) => t + c.admin_fee_cents, 0))}</td><td class="num">${money(chargesTotal)}</td><td></td></tr>` : '',
    })}`);
  const reload = () => billDetail(id);
  onActions(div, {
    edit: () => billForm(b, reload),
    calc: async () => { await api(`/admin/bills/${id}/calculate`, { method: 'POST' }); toast('Charges calculated'); reload(); },
    post: async () => { await api(`/admin/bills/${id}/post`, { method: 'POST' }); toast('Charges posted'); reload(); },
    unpost: async () => {
      if (!(await confirmBox('Unpost this bill? Residents will no longer see these charges until it is posted again.', 'Unpost'))) return;
      await api(`/admin/bills/${id}/unpost`, { method: 'POST' }); toast('Bill unposted'); reload();
    },
    del: async () => {
      if (!(await confirmBox('Delete this bill and its calculated charges?'))) return;
      await api(`/admin/bills/${id}`, { method: 'DELETE' }); toast('Bill deleted'); location.hash = '#/bills';
    },
  });
}

// --------------------------------------------------------------- exports

async function exportsPage() {
  const props = await getProperties();
  const first = new Date(); first.setDate(1);
  const div = mount(`<div class="topbar"><h1>Export to Rent Manager</h1></div>
    <div class="card mb"><h2>Resident charges (posted bills)</h2>
      <p class="muted small">One row per resident per utility bill. Columns: PropertyCode, Unit, TenantAccount, TenantName, ChargeType, Amount,
        TransactionDate, Comment, PeriodStart, PeriodEnd, UtilityShare, AdminFee. In Rent Manager, map these columns in your charge import template.
        (Column names can be changed in <code>functions/api/[[path]].js</code> → <code>RM_CHARGE_COLUMNS</code>.)</p>
      <form class="form-grid" data-export>
        <div class="field"><label>Property</label><select name="property_id"><option value="">All properties</option>
          ${props.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field"></div>
        <div class="field"><label>Charge date from</label><input type="date" name="from" value="${first.toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Charge date to</label><input type="date" name="to"></div>
        <div class="field full"><label><input type="checkbox" name="unexported" value="1" checked> Only charges not exported before</label>
          <label><input type="checkbox" name="mark" value="1" checked> Mark these charges as exported</label></div>
        <div class="full"><button class="primary" type="submit">Download CSV</button></div>
      </form></div>
    <div class="card"><h2>Other exports</h2><div class="row">
      <a class="btn" href="/api/admin/export/tenants.csv">Tenants</a>
      <a class="btn" href="/api/admin/export/units.csv">Units</a>
      <a class="btn" href="/api/admin/export/properties.csv">Properties</a>
      <a class="btn" href="/api/admin/export/utilities.csv">Utility split rules</a>
      <a class="btn" href="/api/admin/export/bills.csv">Utility bills</a>
      <a class="btn" href="/api/admin/export/charges.csv?status=all">All charges (including unposted)</a></div></div>`);
  div.querySelector('[data-export]').addEventListener('submit', (e) => {
    e.preventDefault();
    const qs = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v !== ''));
    location.href = '/api/admin/export/charges.csv?' + qs;
  });
}

// --------------------------------------------------------------- settings

async function settingsPage() {
  const admins = await api('/admin/admins');
  const div = mount(`<div class="topbar"><h1>Settings</h1></div>
    <div class="topbar"><h2 class="m0">Staff accounts</h2><div class="row">
      <button data-action="password">Change my password</button><button class="primary" data-action="add">+ Add staff user</button></div></div>
    ${table({
      columns: [{ label: 'Name', value: 'name' }, { label: 'Email', value: 'email' }, { label: 'Created', value: (a) => date(a.created_at) }],
      rows: admins,
      actions: (a) => (a.id === currentUser.id ? '<span class="muted small">you</span>' : `<button class="link danger" data-action="del" data-id="${a.id}">Remove</button>`),
    })}`);
  onActions(div, {
    add: () => formModal({ title: 'Add staff user', fields: [
      { name: 'name', label: 'Name' }, { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Temporary password (8+ characters)', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/admin/admins', { method: 'POST', body: d }); toast('Staff user added'); settingsPage(); } }),
    password: () => formModal({ title: 'Change my password', fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password (8+ characters)', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/admin/admins/me/password', { method: 'PUT', body: d }); toast('Password changed'); } }),
    del: async ({ id }) => {
      if (!(await confirmBox('Remove this staff user?', 'Remove'))) return;
      await api(`/admin/admins/${id}`, { method: 'DELETE' }); toast('Removed'); settingsPage();
    },
  });
}
