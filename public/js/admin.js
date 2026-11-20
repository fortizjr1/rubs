// Admin app: dashboard, properties, units, tenants, utilities, billing, exports, settings.
import {
  api, esc, money, date, fullName, toast, modal, closeModal, confirmBox, formModal, table, parseCSV, onActions, bindSelection,
} from './ui.js';
import { runsTable, runsView, runForm, runDetailPage, emailSettingsView } from './billing.js';
import { DEFAULT_TEXT } from './shared/statement-pdf.js';

let root, currentUser, doLogout;

const NAV = [
  ['dashboard', 'Dashboard'], ['properties', 'Properties'], ['tenants', 'Tenants'],
  ['billing', 'Billing'], ['exports', 'Export to Rent Manager'], ['settings', 'Settings'],
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
      case 'billing': return parts[1] ? await runDetailPage(root, parts[1]) : await listPage('Billing', (el) => runsView(el, {}));
      case 'exports': return await exportsPage();
      case 'settings': return await settingsPage(parts[1] || 'email');
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
// Pickers for new tenants, units and imports only offer active properties (plus `keepId`, e.g. a tenant's current property).
const getActiveProperties = async (keepId) => (await getProperties()).filter((p) => p.active || p.id == keepId);
const propertyLabel = (p) => (p.active ? p.name : `${p.name} (inactive)`);
const getUnits = (propertyId) => api('/admin/units' + (propertyId ? `?property_id=${propertyId}` : ''));
const getUtilities = (propertyId) => api('/admin/utilities' + (propertyId ? `?property_id=${propertyId}` : ''));
const statusBadge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
const propertyOptions = (props) => props.map((p) => [p.id, propertyLabel(p)]);

// --------------------------------------------------------------- dashboard

async function dashboard() {
  const d = await api('/admin/dashboard');
  const c = d.counts;
  const recovery = d.ytd.city_bills ? Math.round((d.ytd.billed_to_residents / d.ytd.city_bills) * 1000) / 10 : 0;
  const stat = (label, value, href) => `<a class="card stat plain" href="${href}">
    <div class="label">${label}</div><div class="value">${value}</div></a>`;
  const div = mount(`<div class="topbar"><h1>Dashboard</h1>
      <div class="row"><button data-action="import">Import tenants</button><button class="primary" data-action="newRun">+ New billing batch</button></div></div>
    <div class="grid cards mb">
      ${stat('Active properties', c.properties + (c.inactive_properties ? `<span class="small muted"> · ${c.inactive_properties} inactive</span>` : ''), '#/properties')}
      ${stat('Total units', c.total_units, '#/properties')}
      ${stat('Occupied', c.occupied_units, '#/properties')}
      ${stat('Vacant', Math.max(0, c.total_units - c.occupied_units), '#/properties')}
      ${stat('Current residents', c.current_tenants, '#/tenants')}
      ${stat('Upcoming move-ins', c.upcoming_move_ins, '#/tenants')}
      ${stat('Move-outs next 30 days', c.move_outs_30d, '#/tenants')}
      ${stat('Batches not finalized', c.open_batches, '#/billing')}
      ${stat('Statements not emailed', c.unsent_statements, '#/billing')}
      ${stat('Statements not exported', c.unexported_statements, '#/exports')}
    </div>
    <div class="grid cards mb">
      ${stat('Utility bills this year', money(d.ytd.city_bills), '#/billing')}
      ${stat('Billed to residents this year', money(d.ytd.billed_to_residents), '#/billing')}
      ${stat('Recovery rate', recovery + '%', '#/billing')}
    </div>
    <h2>Recent billing batches</h2>
    ${runsTable(d.recent_runs)}`);
  onActions(div, {
    newRun: () => runForm({}),
    import: () => importModal(null, () => (location.hash = '#/tenants')),
  });
}

// --------------------------------------------------------------- properties

const PROPERTY_FIELDS = [
  { name: 'name', label: 'Property name', required: true, full: true },
  { name: 'rm_property_code', label: 'Rent Manager property code', help: 'Short name / ID used in Rent Manager. Goes into the export.' },
  { name: 'total_units', label: 'Total units', type: 'number', min: 0, help: 'How many units the property has. Used for the occupied / vacant counts.' },
  { name: 'address', label: 'Street address' },
  { name: 'city', label: 'City' },
  { name: 'state', label: 'State' },
  { name: 'zip', label: 'ZIP' },
  { type: 'heading', label: 'Printed on statements' },
  { name: 'phone', label: 'Office phone', type: 'tel' },
  { name: 'email', label: 'Office email', type: 'email', help: 'Also used as the reply-to address for statement emails.' },
  { name: 'due_days', label: 'Days until due', type: 'number', min: 0, help: 'Due date = statement date + this many days (default 28).' },
  { name: 'day_count', label: 'How to count days', type: 'select', required: true,
    options: [['meter', 'Like the utility bill: end date minus start date'], ['calendar', 'Calendar: include first and last day']],
    help: 'With the first option, Oct 6 – Nov 3 is 28 days, matching most city bills.' },
  { name: 'tax_label', label: 'Tax line name', placeholder: 'Utility tax', help: 'Set the tax % on each utility.' },
  { name: 'tax_charge_code', label: 'Tax Rent Manager charge code', placeholder: 'UTILTAX' },
  { name: 'billing_fee_cents', label: 'Billing fee per statement ($)', type: 'money', min: 0, help: 'Optional flat fee added to every statement.' },
  { name: 'fee_label', label: 'Fee line name', placeholder: 'Billing fee' },
  { name: 'fee_charge_code', label: 'Fee Rent Manager charge code', placeholder: 'BILLFEE' },
  { type: 'heading', label: 'Statement text', help: 'Leave blank to use the default text shown. You can use {address}, {phone}, {email}, {property}.' },
  { name: 'payment_text', label: 'Payment section', type: 'textarea', full: true, placeholder: DEFAULT_TEXT.payment },
  { name: 'questions_text', label: '"Questions?" box', type: 'textarea', full: true, placeholder: DEFAULT_TEXT.questions },
  { name: 'footer_text', label: 'Footer', type: 'textarea', full: true, placeholder: DEFAULT_TEXT.footer },
  { type: 'heading', label: 'Other' },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true },
];

let propertyStatus = 'active';

async function propertiesPage() {
  const all = await getProperties();
  const props = all.filter((p) => propertyStatus === 'all' || (propertyStatus === 'active' ? p.active : !p.active));
  const count = (st) => all.filter((p) => (st === 'active' ? p.active : !p.active)).length;
  const div = mount(`<div class="topbar"><h1>Properties</h1>
      <div class="row"><a class="btn" href="/api/admin/export/properties.csv">Export CSV</a>
      <button class="primary" data-action="add">+ Add property</button></div></div>
    <div class="tabs">${[['active', `Active (${count('active')})`], ['inactive', `Inactive (${count('inactive')})`], ['all', `All (${all.length})`]]
      .map(([k, l]) => `<button data-action="status" data-status="${k}" class="${k === propertyStatus ? 'active' : ''}">${l}</button>`).join('')}</div>
    ${table({
      columns: [
        { label: 'Property', value: (p) => `<a href="#/properties/${p.id}">${esc(p.name)}</a>${p.active ? '' : `<div class="small"><span class="badge">inactive</span> ${p.inactive_date ? `since ${date(p.inactive_date)}` : ''}${p.inactive_reason ? ` · ${esc(p.inactive_reason)}` : ''}</div>`}` },
        { label: 'RM code', value: 'rm_property_code' },
        { label: 'Address', value: (p) => esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', ')) },
        { label: 'Total units', value: (p) => `${p.units_total}${unitsWarning(p) ? `<div class="small warn">${unitsWarning(p, true)}</div>` : ''}`, cls: 'num' },
        { label: 'Occupied', value: 'occupied_units', cls: 'num' },
        { label: 'Vacant', value: 'vacant_units', cls: 'num' },
        { label: 'Occupancy', value: (p) => occupancy(p), cls: 'num' },
      ],
      rows: props,
      actions: (p) => `<button class="link" data-action="edit" data-id="${p.id}">Edit</button>
        ${p.active ? `<button class="link" data-action="deactivate" data-id="${p.id}">Mark inactive</button>`
          : `<button class="link" data-action="reactivate" data-id="${p.id}">Reactivate</button>`}
        <button class="link danger" data-action="del" data-id="${p.id}">Delete</button>`,
      empty: propertyStatus === 'inactive' ? 'No inactive properties.' : 'No properties yet. Add your first property to get started.',
    })}`);
  onActions(div, {
    status: ({ status }) => { propertyStatus = status; propertiesPage(); },
    deactivate: ({ id }) => deactivateProperty(all.find((p) => p.id == id), propertiesPage),
    reactivate: ({ id }) => reactivateProperty(all.find((p) => p.id == id), propertiesPage),
    add: () => formModal({
      title: 'Add property', fields: PROPERTY_FIELDS, wide: true, values: { day_count: 'meter', due_days: 28 },
      onSubmit: async (d) => { const p = await api('/admin/properties', { method: 'POST', body: d }); location.hash = `#/properties/${p.id}/utilities`; toast('Property added. Next, set up its utilities.'); },
    }),
    edit: ({ id }) => editProperty(props.find((p) => p.id == id), propertiesPage),
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this property? Only possible if it has no units or billing batches. To keep its history (e.g. after a sale), use Mark inactive instead.'))) return;
      await api(`/admin/properties/${id}`, { method: 'DELETE' }); toast('Deleted'); propertiesPage();
    },
  });
}

const occupancy = (p) => (p.units_total ? `${Math.round((p.occupied_units / p.units_total) * 1000) / 10}%` : '—');

// The split rules only know about units set up on the Units tab, so flag a mismatch with the total.
function unitsWarning(p, short = false) {
  if (p.total_units == null || p.total_units === p.unit_count) return '';
  if (short) return `${p.unit_count} set up`;
  return p.unit_count < p.total_units
    ? `${p.unit_count} of ${p.total_units} units are set up on the Units tab. Add the other ${p.total_units - p.unit_count} (with square footage and bedrooms) so vacant units are counted correctly when the utility bill is split.`
    : `${p.unit_count} units are set up on the Units tab, but the property's total units is ${p.total_units}. Check the total in Edit property.`;
}

function deactivateProperty(p, after) {
  formModal({
    title: `Mark ${p.name} inactive`, submitLabel: 'Mark inactive',
    intro: `<p class="small">Use this when a property is sold or no longer managed. It is hidden from the Properties list, the Dashboard counts,
      the Tenants page and the pickers for new tenants and units. All billing batches, statements and exports are kept,
      you can still create a final billing batch for it, and residents can still see their past statements. You can reactivate it at any time.</p>`,
    fields: [
      { name: 'inactive_date', label: 'Inactive since', type: 'date', required: true },
      { name: 'inactive_reason', label: 'Reason', placeholder: 'Sold' },
    ],
    values: { inactive_date: new Date().toISOString().slice(0, 10), inactive_reason: 'Sold' },
    onSubmit: async (d) => { await api(`/admin/properties/${p.id}`, { method: 'PUT', body: { ...d, active: false } }); toast(`${p.name} marked inactive`); after(); },
  });
}

async function reactivateProperty(p, after) {
  if (!(await confirmBox(`Reactivate ${p.name}? It will show up again in the Properties list, Dashboard and pickers.`, 'Reactivate'))) return;
  await api(`/admin/properties/${p.id}`, { method: 'PUT', body: { active: true } });
  toast(`${p.name} is active again`);
  after();
}

function editProperty(p, after) {
  formModal({
    title: 'Edit property', fields: PROPERTY_FIELDS, values: p, wide: true,
    onSubmit: async (d) => { await api(`/admin/properties/${p.id}`, { method: 'PUT', body: d }); toast('Saved'); after(); },
  });
}

async function propertyDetail(id, tab) {
  const p = await api(`/admin/properties/${id}`);
  const tabs = [['units', 'Units'], ['tenants', 'Tenants'], ['utilities', 'Utilities & split rules'], ['billing', 'Billing']];
  const div = mount(`<div class="topbar"><div><a href="#/properties" class="small">← Properties</a><h1>${esc(p.name)}</h1>
      <div class="muted small">${esc([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '))}
      ${p.rm_property_code ? ` · RM code: ${esc(p.rm_property_code)}` : ''}</div></div>
      <div class="row">${p.active ? '<button data-action="deactivate">Mark inactive</button>' : '<button data-action="reactivate">Reactivate</button>'}
      <button data-action="edit">Edit property</button></div></div>
    ${p.active ? '' : `<div class="notice"><b>Inactive property</b>${p.inactive_date ? ` since ${date(p.inactive_date)}` : ''}${p.inactive_reason ? ` · ${esc(p.inactive_reason)}` : ''}.
      Its history is kept and you can still bill it, but it's left out of the Dashboard, the Tenants page and pickers for new data.</div>`}
    <div class="grid cards mb">
      <div class="card stat"><div class="label">Total units</div><div class="value">${p.units_total}</div></div>
      <div class="card stat"><div class="label">Occupied</div><div class="value">${p.occupied_units}</div>
        <div class="muted small">${p.current_tenants} current resident${p.current_tenants === 1 ? '' : 's'}</div></div>
      <div class="card stat"><div class="label">Vacant</div><div class="value">${p.vacant_units}</div></div>
      <div class="card stat"><div class="label">Occupancy</div><div class="value">${occupancy(p)}</div></div>
    </div>
    ${unitsWarning(p) ? `<div class="notice small">${esc(unitsWarning(p))}</div>` : ''}
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/properties/${id}/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    <div data-tab></div>`);
  const again = () => propertyDetail(id, tab);
  onActions(div, {
    edit: () => editProperty(p, again),
    deactivate: () => deactivateProperty(p, again),
    reactivate: () => reactivateProperty(p, again),
  });
  const el = div.querySelector('[data-tab]');
  const opts = { propertyId: Number(id) };
  if (tab === 'units') await unitsView(el, opts);
  else if (tab === 'tenants') await tenantsView(el, opts);
  else if (tab === 'utilities') await utilitiesView(el, opts);
  else await runsView(el, opts);
}

// --------------------------------------------------------------- units

async function unitsView(el, { propertyId }) {
  const [units, props] = await Promise.all([getUnits(propertyId), getActiveProperties(propertyId)]);
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
      <button data-action="import">Import CSV</button>
      <button data-action="history">Import history</button>
      <button class="primary" data-action="add">+ Add unit</button></div></div>
    <div class="selbar" data-selbar hidden></div>
    ${table({
      select: true,
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
      empty: 'No units yet. Click Import CSV to load all units at once (with square footage and bedrooms), or add them one at a time.',
    })}`;
  el.replaceChildren(div);
  // Reload the whole property page so the Total / Occupied / Vacant boxes update too.
  const reload = () => (propertyId ? window.dispatchEvent(new HashChangeEvent('hashchange')) : unitsView(el, { propertyId }));
  const sel = bindSelection(div, div.querySelector('[data-selbar]'), selectionBar('unit', (ids) => bulkDeleteModal({
    noun: 'unit', ids, endpoint: '/admin/units/bulk-delete', after: reload,
    names: ids.map((i) => `Unit ${units.find((u) => u.id === i)?.unit_number}`),
    note: 'Units that have tenants (current or past) are skipped. Delete or move those tenants first.',
  })));
  div.querySelector('[data-selbar]').addEventListener('click', (e) => { if (e.target.matches('[data-bulk-clear]')) sel.clear(); });
  onActions(div, {
    import: () => unitImportModal(propertyId, reload),
    history: () => importHistoryModal('units', reload),
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

const NEW_UNIT = '__new';

// Tenant add/edit form: pick a property, then a unit at that property, or add a new unit on the spot.
async function tenantForm({ title, values = {}, propertyId, onSave }) {
  const [props, units] = await Promise.all([getActiveProperties(values.property_id || propertyId), getUnits()]);
  if (!props.length) return toast('Add a property first (Properties → Add property).', true);
  const startProp = values.property_id || propertyId || props[0].id;
  const unitOptions = (pid) => [
    ...units.filter((u) => u.property_id == pid).map((u) => [u.id, `Unit ${u.unit_number}${u.current_tenant && u.id != values.unit_id ? ` (${u.current_tenant})` : ''}`]),
    [NEW_UNIT, '+ Add a new unit…'],
  ];
  const fields = [
    { name: 'property_id', label: 'Property', type: 'select', required: true, options: propertyOptions(props) },
    { name: 'unit_id', label: 'Unit', type: 'select', required: true, options: unitOptions(startProp) },
    { name: 'new_unit_number', label: 'New unit number', full: true, help: 'Creates this unit at the selected property.' },
    { name: 'new_sqft', label: 'New unit square feet', type: 'number', min: 0 },
    { name: 'new_bedrooms', label: 'New unit bedrooms', type: 'number', min: 0 },
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
  const firstUnits = unitOptions(startProp);
  const m = formModal({
    title, fields,
    values: { occupants: 1, ...values, property_id: startProp, unit_id: values.unit_id || firstUnits[0][0] },
    onSubmit: async (d) => {
      if (d.unit_id === NEW_UNIT) {
        if (!d.new_unit_number) throw new Error('Enter the new unit number');
        const u = await api('/admin/units', { method: 'POST', body: {
          property_id: d.property_id, unit_number: d.new_unit_number, sqft: d.new_sqft, bedrooms: d.new_bedrooms } });
        d.unit_id = u.id;
        // Select the unit we just created, so a retry after an error doesn't create it twice.
        units.push(u);
        unitSel.innerHTML = unitOptions(propSel.value).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
        unitSel.value = u.id;
        syncNew();
      }
      await onSave(d);
    },
  });
  const propSel = m.querySelector('[name=property_id]');
  const unitSel = m.querySelector('[name=unit_id]');
  const newFields = ['new_unit_number', 'new_sqft', 'new_bedrooms'].map((n) => m.querySelector(`[name=${n}]`).closest('.field'));
  const syncNew = () => newFields.forEach((f) => (f.hidden = unitSel.value !== NEW_UNIT));
  propSel.addEventListener('change', () => {
    unitSel.innerHTML = unitOptions(propSel.value).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    syncNew();
  });
  unitSel.addEventListener('change', syncNew);
  syncNew();
}

async function tenantsView(el, { propertyId, filters = {} }) {
  const qs = new URLSearchParams();
  if (propertyId || filters.property_id) qs.set('property_id', propertyId || filters.property_id);
  else qs.set('property_active', '1'); // tenants of inactive (e.g. sold) properties only show when that property is picked
  if (filters.tenant_status) qs.set('tenant_status', filters.tenant_status);
  if (filters.q) qs.set('q', filters.q);
  const [tenants, props] = await Promise.all([api('/admin/tenants?' + qs), propertyId ? [] : getProperties()]);
  const div = document.createElement('div');
  div.innerHTML = `<div class="topbar"><form class="row filters" data-filters>
        ${propertyId ? '' : `<select name="property_id"><option value="">All active properties</option>
          ${props.map((p) => `<option value="${p.id}" ${String(filters.property_id) === String(p.id) ? 'selected' : ''}>${esc(propertyLabel(p))}</option>`).join('')}</select>`}
        <select name="tenant_status">
          ${[['', 'All residents'], ['current', 'Current'], ['future', 'Future move-ins'], ['past', 'Moved out']]
            .map(([v, l]) => `<option value="${v}" ${filters.tenant_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input name="q" placeholder="Search name, email, unit, account…" value="${esc(filters.q || '')}">
        <button type="submit">Search</button></form>
      <div class="row"><a class="btn" href="/api/admin/export/tenants.csv?${qs}">Export CSV</a>
        <button data-action="import">Import CSV</button>
        <button data-action="history">Import history</button>
        <button class="primary" data-action="add">+ Add tenant</button></div></div>
    <div class="selbar" data-selbar hidden></div>
    ${table({
      select: true,
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
  const sel = bindSelection(div, div.querySelector('[data-selbar]'), selectionBar('tenant', (ids) => bulkDeleteModal({
    noun: 'tenant', ids, endpoint: '/admin/tenants/bulk-delete', after: () => reload(),
    names: ids.map((i) => fullName(tenants.find((t) => t.id === i) || {})),
    note: 'Tenants who already have billing statements are skipped. For those, set a move-out date instead. Their units are not deleted.',
  })));
  div.querySelector('[data-selbar]').addEventListener('click', (e) => { if (e.target.matches('[data-bulk-clear]')) sel.clear(); });
  onActions(div, {
    history: () => importHistoryModal('tenants', () => reload()),
    add: () => tenantForm({ title: 'Add tenant', propertyId,
      onSave: async (d) => { await api('/admin/tenants', { method: 'POST', body: d }); toast('Tenant added'); reload(); } }),
    edit: ({ id }) => tenantForm({ title: 'Edit tenant', propertyId, values: tenants.find((x) => x.id == id),
      onSave: async (d) => { await api(`/admin/tenants/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); } }),
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

let importColumnsCache;
const getImportColumns = async () => (importColumnsCache ??= await api('/admin/import-columns'));

function columnGuide(cols) {
  return `<table class="col-guide"><thead><tr><th>Column name</th><th>Required?</th><th>Example</th><th>Also accepted as</th></tr></thead><tbody>
    ${cols.map((c) => `<tr><td><b>${esc(c.name)}</b>${c.help ? `<div class="muted">${esc(c.help)}</div>` : ''}</td>
      <td>${c.required === true ? '<span class="badge danger">Required</span>' : c.required ? `<span class="badge draft">${esc(c.required)}</span>` : '<span class="muted">Optional</span>'}</td>
      <td><code>${esc(c.example)}</code></td>
      <td class="muted">${esc(c.aliases.filter((x) => x !== c.name.toLowerCase()).join(', '))}</td></tr>`).join('')}
    </tbody></table>`;
}

/** Matches the file's headers to known columns the same way the server does (case-insensitive). */
function checkColumns(headers, cols, kind) {
  const found = {};
  const mapped = headers.map((h) => {
    const c = cols.find((col) => col.aliases.includes(h.trim().toLowerCase()));
    if (c && !found[c.key]) found[c.key] = h;
    return { header: h, col: c, duplicate: c && found[c.key] !== h };
  });
  const missing = [];
  if (!found.property) missing.push('Property (short name)');
  if (!found.unit_number) missing.push('Unit');
  if (kind === 'tenants') {
    if (!found.account_number) missing.push('Account Number');
    if (!found.last_name && !found.full_name) missing.push('Last Name (or Name)');
    if (!found.move_in) missing.push('Move In');
  }
  return { mapped, missing };
}

/**
 * Shared CSV import window. Rows are parsed in the browser, checked against the column guide,
 * previewed, then sent in chunks.
 * opts: {kind: 'tenants'|'units', title, intro, template, endpoint, options: [{key, label, checked}], chunk, summary(total) -> text}
 */
async function csvImportModal(propertyId, after, opts) {
  const [props, columns] = await Promise.all([getActiveProperties(propertyId), getImportColumns()]);
  const cols = columns[opts.kind];
  const noCode = props.filter((p) => !p.rm_property_code);
  const m = modal(`<h2>${esc(opts.title)}</h2>
    <p class="small">${opts.intro} <a href="${opts.template}" download>Download a template</a> with the column headers.</p>
    <details class="hint" open><summary>Which columns do I need?</summary>
      <p class="small muted">Column names are not case-sensitive and can be in any order. Columns not listed here are ignored.</p>
      ${columnGuide(cols)}</details>
    <div class="notice small"><b>Property short names</b> to use in the Property column:
      ${props.filter((p) => p.rm_property_code).map((p) => `<code>${esc(p.rm_property_code)}</code> = ${esc(propertyLabel(p))}`).join(' · ') || 'none yet'}
      ${noCode.length ? `<div class="warn">No short name set for: ${noCode.map((p) => esc(p.name)).join(', ')}. Add one in Edit property (Rent Manager property code) before importing for them.</div>` : ''}</div>
    <div class="error" hidden></div>
    <div class="form-grid">
      <div class="field full"><label>CSV file</label><input type="file" accept=".csv,text/csv" data-file></div>
      <div class="field full">${opts.options.map((o) => `<label><input type="checkbox" data-opt="${o.key}" ${o.checked ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}
        <label><input type="checkbox" data-skip> Skip rows with errors and import the rest</label></div>
    </div>
    <div data-check></div>
    <div data-preview></div>
    <div class="footer"><button data-close>Cancel</button><button class="primary" data-go disabled>Import</button></div>`, { wide: true });
  let rows = [];
  let headers = [];
  let filename = '';
  const err = m.querySelector('.error');
  const go = m.querySelector('[data-go]');

  const renderCheck = () => {
    if (!rows.length) return;
    const { mapped, missing } = checkColumns(headers, cols, opts.kind);
    m.querySelector('[data-check]').innerHTML = `<div class="card col-check"><h3 class="m0">Column check</h3>
      <ul>${mapped.map((x) => x.col
        ? `<li class="ok">✓ <b>${esc(x.header)}</b> → ${esc(x.col.name)}${x.duplicate ? ' <span class="warn">(another column already matches this, so this one is ignored)</span>' : ''}</li>`
        : `<li class="muted">– <b>${esc(x.header)}</b>: not recognized, will be ignored</li>`).join('')}</ul>
      ${missing.length ? `<div class="error m0">Missing required column${missing.length > 1 ? 's' : ''}: <b>${missing.map(esc).join(', ')}</b>.
        Add the column, or rename a header in your file to one of the names in the guide above.</div>` : '<div class="ok">All required columns found.</div>'}</div>`;
    go.disabled = missing.length > 0;
  };

  m.querySelector('[data-file]').addEventListener('change', async (e) => {
    err.hidden = true;
    const file = e.target.files[0];
    if (!file) return;
    filename = file.name;
    rows = parseCSV(await file.text());
    headers = rows.length ? Object.keys(rows[0]) : [];
    m.querySelector('[data-preview]').innerHTML = rows.length
      ? `<p><b>${rows.length}</b> rows found. Preview:</p>${table({ columns: headers.map((h) => ({ label: h, value: (r) => esc(r[h]) })), rows: rows.slice(0, 5) })}`
      : '<p class="error">No data rows found in that file.</p>';
    m.querySelector('details.hint').open = false;
    m.querySelector('[data-check]').innerHTML = '';
    go.disabled = true;
    renderCheck();
  });
  go.addEventListener('click', async () => {
    go.disabled = true;
    err.hidden = true;
    const total = { errors: [] };
    const options = Object.fromEntries([...m.querySelectorAll('[data-opt]')].map((c) => [c.dataset.opt, c.checked]));
    let importId = null; // every chunk of this file belongs to one import (so it can be undone at once)
    try {
      for (let i = 0; i < rows.length; i += opts.chunk) {
        const r = await api(opts.endpoint, { method: 'POST', body: {
          rows: rows.slice(i, i + opts.chunk),
          skip_errors: m.querySelector('[data-skip]').checked, filename, import_id: importId, ...options,
        } });
        importId = r.import_id ?? importId;
        for (const [k, v] of Object.entries(r)) if (typeof v === 'number' && k !== 'import_id') total[k] = (total[k] || 0) + v;
        total.errors.push(...r.errors.map((x) => ({ ...x, line: x.line + i })));
      }
    } catch (e2) { err.textContent = e2.message; err.hidden = false; go.disabled = false; return; }
    const nothing = !Object.entries(total).some(([k, v]) => k !== 'errors' && v > 0);
    if (total.errors.length && nothing) {
      err.innerHTML = `Nothing was imported. Fix these rows (or tick "Skip rows with errors"):<ul>${total.errors.slice(0, 50).map((x) => `<li>Line ${x.line}: ${esc(x.error)}</li>`).join('')}</ul>`;
      err.hidden = false; go.disabled = false; return;
    }
    closeModal();
    toast(opts.summary(total) + (total.errors.length ? `, skipped ${total.errors.length} rows with errors` : '')
      + (importId ? '. To reverse it, use Import history → Undo.' : ''));
    after();
  });
}

// --------------------------------------------------------------- bulk delete + import history

/**
 * Confirm and delete many tenants or units at once. Records the server refuses
 * (tenants with billing statements, units with tenants) are listed with the reason.
 */
function bulkDeleteModal({ noun, ids, names, endpoint, note, after }) {
  const n = ids.length;
  const strict = n > 10;
  const m = modal(`<h2>Delete ${n} ${noun}${n === 1 ? '' : 's'}?</h2>
    <p class="small">${names.slice(0, 12).map(esc).join(', ')}${n > 12 ? `, and ${n - 12} more` : ''}</p>
    <div class="notice small">${note}</div>
    ${strict ? `<div class="field"><label for="bulk_confirm">Type <b>DELETE</b> to confirm</label><input id="bulk_confirm" autocomplete="off" data-confirm></div>` : ''}
    <div class="error" hidden></div>
    <div class="footer"><button data-close>Cancel</button>
      <button class="primary danger-fill" data-go ${strict ? 'disabled' : ''}>Delete ${n} ${noun}${n === 1 ? '' : 's'}</button></div>`);
  const go = m.querySelector('[data-go]');
  const input = m.querySelector('[data-confirm]');
  input?.addEventListener('input', () => { go.disabled = input.value.trim() !== 'DELETE'; });
  input?.focus();
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      const r = await api(endpoint, { method: 'POST', body: { ids } });
      closeModal();
      after();
      if (r.skipped.length) skippedModal(`Deleted ${r.deleted} ${noun}${r.deleted === 1 ? '' : 's'}`, r.skipped);
      else toast(`Deleted ${r.deleted} ${noun}${r.deleted === 1 ? '' : 's'}`);
    } catch (e) {
      const err = m.querySelector('.error');
      err.textContent = e.message; err.hidden = false; go.disabled = false;
    }
  });
}

function skippedModal(title, skipped) {
  modal(`<h2>${esc(title)}</h2>
    <p>${skipped.length} could not be deleted, so they were kept:</p>
    <div class="log small">${skipped.map((x) => `<div><b>${esc(x.name)}</b>: ${esc(x.reason)}</div>`).join('')}</div>
    <div class="footer"><button class="primary" data-close>OK</button></div>`);
}

/** Selection bar shown above a list while rows are checked. */
function selectionBar(noun, onDelete) {
  return (bar, ids) => {
    bar.innerHTML = `<b>${ids.length}</b> ${noun}${ids.length === 1 ? '' : 's'} selected
      <button class="danger" data-bulk-delete>Delete selected</button><button class="link" data-bulk-clear>Clear selection</button>`;
    bar.querySelector('[data-bulk-delete]').onclick = () => onDelete(ids);
  };
}

async function importHistoryModal(kind, after) {
  const imports = await api(`/admin/imports?kind=${kind}`);
  const noun = kind === 'tenants' ? 'tenant' : 'unit';
  const m = modal(`<h2>${kind === 'tenants' ? 'Tenant' : 'Unit'} import history</h2>
    <p class="small muted">Undo deletes the ${noun}s${kind === 'tenants' ? ' (and any new units)' : ''} that an import <b>created</b>.
      Changes an import made to records that already existed are not reversed.
      ${kind === 'tenants' ? 'Tenants who already have billing statements are kept.' : 'Units that have tenants are kept.'}</p>
    ${table({
      columns: [
        { label: 'Imported', value: (b) => `${date(b.created_at)} <span class="muted small">${esc(b.created_at.slice(11, 16))} UTC</span>` },
        { label: 'File', value: (b) => `${esc(b.filename || '—')}<div class="muted small">${esc(b.created_by_email || '')}</div>` },
        { label: 'Created', value: (b) => `${b.created_count}${kind === 'tenants' && b.units_created ? `<div class="muted small">+${b.units_created} units</div>` : ''}`, cls: 'num' },
        { label: 'Updated', value: 'updated_count', cls: 'num' },
        { label: 'Still in system', value: (b) => `${kind === 'tenants' ? `${b.tenants_remaining} tenants` : ''}${kind === 'tenants' && b.units_remaining ? ', ' : ''}${b.units_remaining || kind === 'units' ? `${b.units_remaining} units` : ''}` },
        { label: 'Status', value: (b) => (b.undone_at ? `<span class="badge">undone ${date(b.undone_at)}</span>` : '<span class="badge posted">imported</span>') },
      ],
      rows: imports,
      actions: (b) => (b.tenants_remaining || b.units_remaining
        ? `<button class="link danger" data-undo="${b.id}">${b.undone_at ? 'Undo again' : 'Undo'}</button>` : ''),
      empty: 'No imports recorded yet. (Imports made before this feature was added are not listed. Use the checkboxes and Delete selected instead.)',
    })}
    <div class="footer"><button class="primary" data-close>Close</button></div>`, { wide: true });
  m.querySelectorAll('[data-undo]').forEach((btn) => btn.addEventListener('click', async () => {
    const b = imports.find((x) => x.id == btn.dataset.undo);
    const what = [b.tenants_remaining ? `${b.tenants_remaining} tenant${b.tenants_remaining === 1 ? '' : 's'}` : '',
      b.units_remaining ? `${b.units_remaining} unit${b.units_remaining === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    if (!(await confirmBox(`Undo the import of "${b.filename || 'file'}"? This deletes the ${what} it created.`, 'Undo import'))) {
      importHistoryModal(kind, after); return;
    }
    try {
      const r = await api(`/admin/imports/${b.id}/undo`, { method: 'POST' });
      const msg = `Import undone: deleted ${r.tenants_deleted} tenants and ${r.units_deleted} units`;
      after();
      if (r.skipped.length) skippedModal(msg, r.skipped); else toast(msg);
    } catch (e) { toast(e.message, true); }
  }));
}

function importModal(propertyId, after) {
  return csvImportModal(propertyId, after, {
    kind: 'tenants',
    title: 'Import tenants from CSV',
    intro: 'One row per tenant. Every row needs the <b>Property</b> short name, <b>Unit</b>, <b>Account Number</b>, a <b>name</b> and a <b>Move In</b> date. Dates can be MM/DD/YYYY or YYYY-MM-DD.',
    template: '/tenant-import-template.csv',
    endpoint: '/admin/tenants/import',
    chunk: 500,
    options: [{ key: 'create_units', label: "Create units that don't exist yet", checked: true }],
    summary: (t) => `Imported ${t.imported || 0} tenants${t.units_created ? `, created ${t.units_created} units` : ''}`,
  });
}

function unitImportModal(propertyId, after) {
  return csvImportModal(propertyId, after, {
    kind: 'units',
    title: 'Import units from CSV',
    intro: 'One row per unit, including vacant units so the split rules can count them. Every row needs the <b>Property</b> short name and the <b>Unit</b>.',
    template: '/unit-import-template.csv',
    endpoint: '/admin/units/import',
    chunk: 1000,
    options: [{ key: 'update_existing', label: 'Update units that already exist', checked: true }],
    summary: (t) => [`Created ${t.created || 0} units`, t.updated ? `updated ${t.updated}` : '', t.unchanged ? `${t.unchanged} unchanged` : '',
      t.skipped_existing ? `${t.skipped_existing} already existed (not changed)` : ''].filter(Boolean).join(', '),
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
  { name: 'tax_pct', label: 'Tax % added to residents\' share', type: 'number', min: 0, help: 'e.g. 10 for a 10% utility tax on water. Use 0 for none.' },
  { name: 'w_sqft', label: 'Weight: square footage', type: 'number', min: 0 },
  { name: 'w_bedrooms', label: 'Weight: bedrooms', type: 'number', min: 0 },
  { name: 'w_occupants', label: 'Weight: number of occupants', type: 'number', min: 0 },
  { name: 'w_equal', label: 'Weight: equal per unit', type: 'number', min: 0 },
  { name: 'vacancy_mode', label: 'Vacancy handling', type: 'select', required: true,
    options: [['owner', 'Owner absorbs vacant units'], ['occupied', 'Split among occupied units only']] },
  { name: 'vacant_occupants', label: 'Occupants assumed for vacant units', type: 'number', min: 0, help: 'Only used with the occupants weight and "owner absorbs"' },
  { name: 'sort_order', label: 'Order on statement', type: 'number', help: 'Lower numbers are listed first.' },
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
        { label: 'Tax', value: (u) => (Number(u.tax_pct) ? `${u.tax_pct}%` : '—'), cls: 'num' },
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
      values: { recovery_pct: 100, w_sqft: 100, vacancy_mode: 'owner', vacant_occupants: 1, active: true, tax_pct: 0 },
      onSubmit: async (d) => { await api('/admin/utilities', { method: 'POST', body: { ...d, property_id: propertyId } }); toast('Utility added'); reload(); } }),
    edit: ({ id }) => formModal({ title: 'Edit utility', fields: UTILITY_FIELDS, wide: true, values: utils.find((u) => u.id == id),
      onSubmit: async (d) => { await api(`/admin/utilities/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); } }),
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this utility?'))) return;
      await api(`/admin/utilities/${id}`, { method: 'DELETE' }); toast('Deleted'); reload();
    },
  });
}

// --------------------------------------------------------------- exports

async function exportsPage() {
  const props = await getProperties();
  const first = new Date(); first.setDate(1);
  const div = mount(`<div class="topbar"><h1>Export to Rent Manager</h1></div>
    <div class="card mb"><h2>Resident charges (finalized statements)</h2>
      <p class="muted small">One row per charge on each statement (Water, Sewer, tax, fee), using each utility's Rent Manager charge code.
        Columns: PropertyCode, Unit, TenantAccount, TenantName, ChargeType, Amount, TransactionDate, DueDate, Comment, PeriodStart, PeriodEnd.
        Map these columns in your Rent Manager charge import template. You can also export a single batch from its page.</p>
      <form class="form-grid" data-export>
        <div class="field"><label>Property</label><select name="property_id"><option value="">All properties</option>
          ${props.map((p) => `<option value="${p.id}">${esc(propertyLabel(p))}</option>`).join('')}</select></div>
        <div class="field"></div>
        <div class="field"><label>Charge date from</label><input type="date" name="from" value="${first.toISOString().slice(0, 10)}"></div>
        <div class="field"><label>Charge date to</label><input type="date" name="to"></div>
        <div class="field full"><label><input type="checkbox" name="unexported" value="1" checked> Only statements not exported before</label>
          <label><input type="checkbox" name="mark" value="1" checked> Mark these statements as exported</label></div>
        <div class="full"><button class="primary" type="submit">Download CSV</button></div>
      </form></div>
    <div class="card"><h2>Other exports</h2><div class="row">
      <a class="btn" href="/api/admin/export/tenants.csv">Tenants</a>
      <a class="btn" href="/api/admin/export/units.csv">Units</a>
      <a class="btn" href="/api/admin/export/properties.csv">Properties</a>
      <a class="btn" href="/api/admin/export/utilities.csv">Utility split rules</a>
      </div></div>`);
  div.querySelector('[data-export]').addEventListener('submit', (e) => {
    e.preventDefault();
    const qs = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v !== ''));
    location.href = '/api/admin/export/charges.csv?' + qs;
  });
}

// --------------------------------------------------------------- settings

async function settingsPage(tab) {
  const tabs = [['email', 'Company & email'], ['staff', 'Staff accounts']];
  const div0 = mount(`<div class="topbar"><h1>Settings</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    <div data-tab></div>`);
  const el = div0.querySelector('[data-tab]');
  if (tab === 'email') return emailSettingsView(el);
  const admins = await api('/admin/admins');
  const div = document.createElement('div');
  el.replaceChildren(div);
  div.innerHTML = `
    <div class="topbar"><h2 class="m0">Staff accounts</h2><div class="row">
      <button data-action="password">Change my password</button><button class="primary" data-action="add">+ Add staff user</button></div></div>
    ${table({
      columns: [{ label: 'Name', value: 'name' }, { label: 'Email', value: 'email' }, { label: 'Created', value: (a) => date(a.created_at) }],
      rows: admins,
      actions: (a) => (a.id === currentUser.id ? '<span class="muted small">you</span>' : `<button class="link danger" data-action="del" data-id="${a.id}">Remove</button>`),
    })}`;
  onActions(div, {
    add: () => formModal({ title: 'Add staff user', fields: [
      { name: 'name', label: 'Name' }, { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Temporary password (8+ characters)', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/admin/admins', { method: 'POST', body: d }); toast('Staff user added'); settingsPage('staff'); } }),
    password: () => formModal({ title: 'Change my password', fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password (8+ characters)', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/admin/admins/me/password', { method: 'PUT', body: d }); toast('Password changed'); } }),
    del: async ({ id }) => {
      if (!(await confirmBox('Remove this staff user?', 'Remove'))) return;
      await api(`/admin/admins/${id}`, { method: 'DELETE' }); toast('Removed'); settingsPage('staff');
    },
  });
}
