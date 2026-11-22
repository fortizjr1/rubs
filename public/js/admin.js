// Admin app: dashboard, properties, units, tenants, utilities, billing, exports, settings.
import {
  api, esc, money, date, fullName, toast, modal, closeModal, confirmBox, formModal, table, parseCSV, onActions, bindSelection,
  rowActions, resetPage, ICONS, initials, toggleGroups,
} from './ui.js';
import { runsTable, runsView, runForm, runDetailPage, emailSettingsView } from './billing.js';
import { DEFAULT_TEXT } from './shared/statement-pdf.js';
import { rubsTemplateModal, testCalculationModal, describeAllocation } from './rubs-ui.js';

let root, currentUser, doLogout;

const NAV = [
  ['dashboard', 'Dashboard', 'home'], ['properties', 'Properties', 'building'], ['tenants', 'Tenants', 'users'],
  ['billing', 'Billing', 'doc'], ['exports', 'Export to Rent Manager', 'export'], ['settings', 'Settings', 'gear'],
];

export function startAdmin(app, user, logout) {
  currentUser = user;
  doLogout = logout;
  app.innerHTML = `<div class="shell">
    <nav class="sidebar">
      <div class="side-brand"><span class="logo-mark">${ICONS.drop}</span>
        <div><div class="side-title">Utility Billing</div>${user.company_name ? `<div class="side-sub">${esc(user.company_name)}</div>` : ''}</div></div>
      <div class="side-nav">${NAV.map(([k, l, icon]) => `<a href="#/${k}" data-nav="${k}" title="${l}">${ICONS[icon]}<span>${l}</span></a>`).join('')}</div>
      <div class="side-section">Preview</div>
      <a href="#" id="viewAs" class="side-link" title="Log in as a tenant">${ICONS.eye}<span>Log in as a tenant</span></a>
      <div class="spacer"></div>
      <div class="side-user"><span class="avatar">${esc(initials(user.name || user.email))}</span>
        <div class="side-user-text"><div class="side-user-name">${esc(user.name || 'Staff')}</div><div class="side-user-email">${esc(user.email)}</div></div></div>
      <a href="#" id="logout" class="side-link" title="Sign out">${ICONS.logout}<span>Sign out</span></a>
    </nav>
    <main class="main" id="view"></main></div>`;
  root = app.querySelector('#view');
  app.querySelector('#logout').addEventListener('click', (e) => { e.preventDefault(); doLogout(); });
  app.querySelector('#viewAs').addEventListener('click', (e) => { e.preventDefault(); viewAsPicker(); });
  window.onhashchange = route;
  route();
}

// ---- "Log in as a tenant": opens a read-only tenant session (staff preview)
async function viewAsResident(tenantId) {
  await api(`/admin/tenants/${tenantId}/view-as`, { method: 'POST' });
  location.hash = '';
  location.reload();
}

async function viewAsPicker() {
  const tenants = await api('/admin/tenants?property_active=1');
  const m = modal(`<h2>Log in as a tenant</h2>
    <p class="small muted">See the tenant portal exactly as this tenant sees it. It's read-only (no password or phone changes) and you can go back
      to the staff view at any time. Works even if the tenant hasn't activated their portal.</p>
    <input type="search" placeholder="Search name, unit, account or email…" data-q class="mb">
    <div class="picker" data-list></div>
    <div class="footer"><button data-close>Cancel</button></div>`, { wide: true });
  const list = m.querySelector('[data-list]');
  const draw = (q = '') => {
    const k = q.trim().toLowerCase();
    const rows = tenants.filter((t) => !k || [fullName(t), t.unit_number, t.account_number, t.email, t.property_name].some((v) => String(v || '').toLowerCase().includes(k)))
      .sort((a, b) => (a.status === 'current' ? 0 : 1) - (b.status === 'current' ? 0 : 1)).slice(0, 50);
    list.innerHTML = rows.length ? rows.map((t) => `<button type="button" class="picker-row" data-id="${t.id}">
        <span class="avatar sm">${esc(initials(fullName(t)))}</span>
        <span class="grow"><b>${esc(fullName(t))}</b><span class="muted small"> · ${esc(t.property_name)} · Unit ${esc(t.unit_number)}${t.account_number ? ` · #${esc(t.account_number)}` : ''}</span></span>
        <span class="badge ${esc(t.status)}">${esc(t.status)}</span></button>`).join('')
      : '<div class="empty">No tenants match.</div>';
  };
  draw();
  m.querySelector('[data-q]').addEventListener('input', (e) => draw(e.target.value));
  m.querySelector('[data-q]').focus();
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) viewAsResident(row.dataset.id).catch((err) => toast(err.message, true));
  });
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
      case 'tenants': return await listPage('Tenants', (el) => tenantsView(el, { filters: parts[1] === 'final' ? { tenant_status: 'final_pending' } : {} }));
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
  // Recovery: what tenants were charged for utilities split from a bill (water & sewer) ÷ those bills.
  // Fixed charges (trash, pest control, internet…) have no bill behind them, so they are left out.
  const y = d.ytd;
  const recovery = y.city_bills ? Math.round(((y.split_billed ?? y.billed_to_residents) / y.city_bills) * 1000) / 10 : 0;
  const otherBilled = y.billed_to_residents - (y.split_billed || 0) - (y.fixed_billed || 0);
  const stat = (label, value, href, sub = '') => `<a class="card stat plain" href="${href}">
    <div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="muted small">${sub}</div>` : ''}</a>`;
  const div = mount(`<div class="topbar"><h1>Dashboard</h1>
      <div class="row"><button data-action="import">Import tenants</button><button class="primary" data-action="newRun">+ New billing batch</button></div></div>
    <div class="grid cards mb">
      ${stat('Active properties', c.properties + (c.inactive_properties ? `<span class="small muted"> · ${c.inactive_properties} inactive</span>` : ''), '#/properties')}
      ${stat('Total units', c.total_units, '#/properties')}
      ${stat('Occupied', c.occupied_units, '#/properties')}
      ${stat('Vacant', Math.max(0, c.total_units - c.occupied_units), '#/properties')}
      ${stat('Current tenants', c.current_tenants, '#/tenants')}
      ${stat('Upcoming move-ins', c.upcoming_move_ins, '#/tenants')}
      ${stat('Move-outs next 30 days', c.move_outs_30d, '#/tenants')}
      ${stat('Batches not finalized', c.open_batches, '#/billing')}
      ${stat('Final bills pending', c.final_pending, '#/tenants/final')}
      ${stat('Statements not emailed', c.unsent_statements, '#/billing')}
      ${stat('Statements not exported', c.unexported_statements, '#/exports')}
    </div>
    <div class="grid cards mb">
      ${stat('Utility bills this year', money(d.ytd.city_bills), '#/billing')}
      ${stat('Billed to tenants this year', money(d.ytd.billed_to_residents), '#/billing',
        `${money(y.split_billed || 0)} utilities + ${money(y.fixed_billed || 0)} fixed charges${otherBilled > 0 ? ` + ${money(otherBilled)} tax &amp; fees` : ''}`)}
      ${stat('Recovery rate', recovery + '%', '#/billing',
        `${money(y.split_billed || 0)} water &amp; sewer charged ÷ ${money(y.city_bills)} utility bills. Fixed charges not included.`)}
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
      pageKey: 'properties',
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
      you can still create a final billing batch for it, and tenants can still see their past statements. You can reactivate it at any time.</p>`,
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
  const tabs = [['units', 'Units'], ['tenants', 'Tenants'], ['utilities', 'Utilities & fixed charges'], ['billing', 'Billing']];
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
        <div class="muted small">${p.current_tenants} current tenant${p.current_tenants === 1 ? '' : 's'}</div></div>
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
        { label: 'Current tenant', value: (u) => u.current_tenant ? esc(u.current_tenant) : '<span class="muted">Vacant</span>' },
      ],
      rows: units,
      pageKey: `units-${propertyId || 'all'}`,
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
    { name: 'move_out', label: 'Move-out date', type: 'date', help: 'Leave blank for current tenants.' },
    { name: 'forwarding_address', label: 'Forwarding address', full: true, help: 'Printed on the final bill instead of the apartment address.' },
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
          ${[['', 'All tenants'], ['current', 'Current'], ['future', 'Future move-ins'], ['past', 'Moved out'], ['final_pending', 'Final bill pending'], ['signed_up', 'Signed up for portal'], ['not_signed_up', 'Not signed up']]
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
        { label: 'Name', value: (t) => `<b>${esc(fullName(t))}</b>${t.account_number ? `<div class="muted small">Acct ${esc(t.account_number)}</div>` : ''}` },
        { label: 'Unit', value: (t) => `${esc(t.unit_number)}${propertyId ? '' : `<div class="muted small">${esc(t.property_name)}</div>`}` },
        { label: 'Contact', cls: 'contact', value: (t) => `${esc(t.email || '')}<div class="muted small">${esc(t.phone || '')}</div>` },
        { label: 'Dates', cls: 'dates', value: (t) => `<div><span class="muted small">In</span> ${date(t.move_in)}</div>${t.move_out ? `<div><span class="muted small">Out</span> ${date(t.move_out)}</div>` : ''}` },
        { label: 'People', cls: 'num', value: (t) => `<span class="inline-edit"><input type="number" class="inline-num" min="0" max="50" step="1"
            value="${esc(t.occupants)}" data-occ="${t.id}" data-was="${esc(t.occupants)}" aria-label="Number of people for ${esc(fullName(t))}"
            title="Type a number, then press Enter or Tab to save"><span class="inline-ok" aria-hidden="true"></span></span>` },
        { label: 'Status', value: (t) => statusBadge(t.status) + (t.final_pending ? ' <span class="badge draft" title="Moved out: their move-out date is not covered by a finalized billing batch yet">final bill pending</span>' : '') },
        { label: 'Signed up', value: signedUpCell },
        { label: 'Portal', value: portalCell, cls: 'portal-col hide-lg' },
      ],
      rows: tenants,
      pageKey: `tenants-${propertyId || 'all'}`,
      actions: (t) => rowActions([`<button class="link" data-action="edit" data-id="${t.id}">Edit</button>`], [
        `<button class="link" data-action="viewAs" data-id="${t.id}">View as tenant</button>`,
        !t.move_out && `<button class="link" data-action="moveout" data-id="${t.id}">Move out</button>`,
        t.portal_active && `<button class="link" data-action="resetPortal" data-id="${t.id}">Reset login</button>`,
        t.locked_at ? `<button class="link" data-action="unlock" data-id="${t.id}">Unlock portal</button>`
          : `<button class="link danger" data-action="lock" data-id="${t.id}">Lock portal</button>`,
        `<button class="link danger" data-action="del" data-id="${t.id}">Delete</button>`]),
      empty: 'No tenants found. Add one, or import a CSV.',
    })}
    ${tenants.length && tenants.length <= 25 ? `<p class="muted small">${tenants.length} tenant${tenants.length === 1 ? '' : 's'}</p>` : ''}
    ${filters.tenant_status === 'final_pending' ? `<div class="notice small">These tenants moved out in the last 90 days, but no finalized billing batch covers their
      move-out date yet. Their final bill is created automatically in the next batch for their property whose service period includes the move-out date.
      Add a forwarding address (Edit or Move out) so it prints on the final bill.</div>` : ''}`;
  el.replaceChildren(div);
  const reload = (f = filters) => tenantsView(el, { propertyId, filters: f });
  div.querySelector('[data-filters]').addEventListener('submit', (e) => {
    e.preventDefault();
    resetPage(`tenants-${propertyId || 'all'}`);
    reload(Object.fromEntries(new FormData(e.target)));
  });
  div.querySelectorAll('[data-filters] select').forEach((s) => s.addEventListener('change', () => s.form.requestSubmit()));
  const sel = bindSelection(div, div.querySelector('[data-selbar]'), selectionBar('tenant', (ids) => bulkDeleteModal({
    noun: 'tenant', ids, endpoint: '/admin/tenants/bulk-delete', after: () => reload(),
    names: ids.map((i) => fullName(tenants.find((t) => t.id === i) || {})),
    note: 'Tenants who already have billing statements are skipped. For those, set a move-out date instead. Their units are not deleted.',
  }), (ids) => bulkEditTenantsModal(ids, tenants, () => reload())));
  div.querySelector('[data-selbar]').addEventListener('click', (e) => { if (e.target.matches('[data-bulk-clear]')) sel.clear(); });
  bindInlinePeople(div, tenants);
  onActions(div, {
    viewAs: ({ id }) => viewAsResident(id),
    history: () => importHistoryModal('tenants', () => reload()),
    add: () => tenantForm({ title: 'Add tenant', propertyId,
      onSave: async (d) => { await api('/admin/tenants', { method: 'POST', body: d }); toast('Tenant added'); reload(); } }),
    edit: ({ id }) => tenantForm({ title: 'Edit tenant', propertyId, values: tenants.find((x) => x.id == id),
      onSave: async (d) => { await api(`/admin/tenants/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); } }),
    moveout: ({ id }) => {
      const t = tenants.find((x) => x.id == id);
      formModal({ title: `Move out ${fullName(t)}`, submitLabel: 'Save move-out',
        intro: '<p class="muted small">The next billing batch whose service period includes this date is prorated to it and becomes this tenant\'s <b>final bill</b>.</p>',
        fields: [{ name: 'move_out', label: 'Move-out date', type: 'date', required: true, full: true },
          { name: 'forwarding_address', label: 'Forwarding address (for the final bill)', type: 'textarea', full: true,
            placeholder: '123 New St, Apt 4, Tallahassee, FL 32301' }],
        values: { move_out: new Date().toISOString().slice(0, 10), forwarding_address: t.forwarding_address },
        onSubmit: async (d) => { await api(`/admin/tenants/${id}`, { method: 'PUT', body: d }); toast('Move-out saved'); reload(); } });
    },
    lock: ({ id }) => {
      const t = tenants.find((x) => x.id == id);
      formModal({ title: `Lock ${fullName(t)}'s portal account`, submitLabel: 'Lock account',
        intro: `<p class="small">They are signed out right away and can't sign in or re-activate until you unlock the account.
          They'll see "This account is locked. Please contact the office." Billing, statements and emails are not affected.</p>`,
        fields: [{ name: 'reason', label: 'Reason (staff only, optional)', full: true, placeholder: 'e.g. Suspicious sign-ins, or requested by tenant' }],
        onSubmit: async (d) => { await api(`/admin/tenants/${id}/lock`, { method: 'POST', body: d }); toast('Account locked'); reload(); } });
    },
    unlock: async ({ id }) => {
      const t = tenants.find((x) => x.id == id);
      if (!(await confirmBox(`Unlock ${fullName(t)}'s portal account? They can sign in again with their current password.`, 'Unlock'))) return;
      await api(`/admin/tenants/${id}/unlock`, { method: 'POST' }); toast('Account unlocked'); reload();
    },
    resetPortal: async ({ id }) => {
      if (!(await confirmBox('Reset this tenant\'s portal login? They will need to activate their account again.', 'Reset'))) return;
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
    <p>${skipped.length} ${title.startsWith('Updated') ? 'could not be updated' : 'could not be deleted, so they were kept'}:</p>
    <div class="log small">${skipped.map((x) => `<div><b>${esc(x.name)}</b>: ${esc(x.reason)}</div>`).join('')}</div>
    <div class="footer"><button class="primary" data-close>OK</button></div>`);
}

/** Selection bar shown above a list while rows are checked. */
function selectionBar(noun, onDelete, onEdit) {
  return (bar, ids) => {
    bar.innerHTML = `<b>${ids.length}</b> ${noun}${ids.length === 1 ? '' : 's'} selected
      ${onEdit ? '<button data-bulk-edit>Edit selected</button>' : ''}
      <button class="danger" data-bulk-delete>Delete selected</button><button class="link" data-bulk-clear>Clear selection</button>`;
    bar.querySelector('[data-bulk-delete]').onclick = () => onDelete(ids);
    if (onEdit) bar.querySelector('[data-bulk-edit]').onclick = () => onEdit(ids);
  };
}

/**
 * Inline editing of the People column: each row saves its own number when you press Enter
 * or leave the field. Esc puts the previous value back.
 */
function bindInlinePeople(root, tenants) {
  const save = async (input) => {
    const was = input.dataset.was;
    const raw = input.value.trim();
    if (raw === was) return;
    const mark = input.nextElementSibling;
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0 || n > 50) {
      input.value = was;
      toast('Number of people must be a whole number from 0 to 50', true);
      return;
    }
    input.disabled = true;
    mark.className = 'inline-ok saving';
    try {
      await api(`/admin/tenants/${input.dataset.occ}`, { method: 'PUT', body: { occupants: n } });
      input.dataset.was = String(n);
      const t = tenants.find((x) => String(x.id) === input.dataset.occ);
      if (t) t.occupants = n;
      mark.className = 'inline-ok done';
      mark.textContent = '✓';
      setTimeout(() => { mark.className = 'inline-ok'; mark.textContent = ''; }, 2500);
    } catch (e) {
      input.value = was;
      mark.className = 'inline-ok';
      toast(`Not saved: ${e.message}`, true);
    }
    input.disabled = false;
  };
  root.addEventListener('change', (e) => { if (e.target.matches('[data-occ]')) save(e.target); });
  root.addEventListener('keydown', (e) => {
    if (!e.target.matches('[data-occ]')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.key === 'Escape') { e.target.value = e.target.dataset.was; e.target.blur(); }
  });
}

// "2026-11-20 19:45:03" (UTC, from SQLite) -> local date and time
const dateTime = (sqlUtc) => {
  if (!sqlUtc) return '';
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  if (isNaN(d)) return sqlUtc;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
};

/** Signed up column: did the tenant ever create their own portal login, and when. */
function signedUpCell(t) {
  if (!t.portal_active) return '<span class="muted">No</span>';
  return t.activated_at
    ? `<span class="badge posted">Yes</span><div class="small muted">${esc(dateTime(t.activated_at))}</div>`
    : '<span class="badge posted">Yes</span><div class="small muted">date not recorded</div>';
}

/** Portal column: locked state, last sign-in time and IP. */
function portalCell(t) {
  const lines = [];
  if (t.locked_at) {
    lines.push(`<span class="badge danger">locked</span> <span class="small muted">${esc(dateTime(t.locked_at))}</span>`);
    if (t.locked_reason) lines.push(`<div class="small muted">${esc(t.locked_reason)}</div>`);
  } else if (t.portal_active) lines.push('<span class="badge posted">active</span>');
  else lines.push('<span class="small muted">—</span>');
  if (t.portal_active) {
    lines.push(t.last_login_at
      ? `<div class="small" title="Last sign-in and its IP address">Last login ${esc(dateTime(t.last_login_at))}</div><div class="small muted">IP ${esc(t.last_login_ip || 'unknown')}</div>`
      : '<div class="small muted">Never signed in</div>');
  }
  return `<div class="portal-cell">${lines.join('')}</div>`;
}

/** Mass edit: number of people and/or move-out date for the selected tenants. */
function bulkEditTenantsModal(ids, tenants, after) {
  const n = ids.length;
  const picked = ids.map((i) => tenants.find((t) => t.id === i)).filter(Boolean);
  const m = modal(`<h2>Edit ${n} tenant${n === 1 ? '' : 's'}</h2>
    <p class="small muted">${picked.slice(0, 12).map((t) => esc(fullName(t))).join(', ')}${n > 12 ? `, and ${n - 12} more` : ''}</p>
    <p class="small">Tick what you want to change. Everything else stays as it is.
      To give each unit its own number of people, type it straight into the <b>People</b> column instead.</p>
    <div class="bulk-edit">
      <label class="bulk-opt"><input type="checkbox" data-on="occ"> <b>Set the same number of people for all of them</b></label>
      <div class="field" data-for="occ" hidden><input type="number" min="0" max="50" step="1" data-occ placeholder="e.g. 2"></div>
      <label class="bulk-opt"><input type="checkbox" data-on="out"> <b>Move-out date</b></label>
      <div data-for="out" hidden>
        <div class="field"><input type="date" data-out></div>
        <label class="small"><input type="checkbox" data-clear> Remove the move-out date instead (they're staying)</label>
        <p class="small muted">Their next billing batch is prorated to this date and becomes their final bill.</p>
      </div>
    </div>
    <div class="error" hidden></div>
    <div class="footer"><button data-close>Cancel</button><button class="primary" data-go>Update ${n} tenant${n === 1 ? '' : 's'}</button></div>`);
  m.querySelectorAll('[data-on]').forEach((c) => c.addEventListener('change', () => {
    m.querySelector(`[data-for="${c.dataset.on}"]`).hidden = !c.checked;
  }));
  const clear = m.querySelector('[data-clear]');
  clear.addEventListener('change', () => { m.querySelector('[data-out]').disabled = clear.checked; });
  m.querySelector('[data-go]').addEventListener('click', async () => {
    const err = m.querySelector('.error');
    err.hidden = true;
    const body = { ids };
    if (m.querySelector('[data-on="occ"]').checked) {
      const v = m.querySelector('[data-occ]').value;
      if (v === '') { err.textContent = 'Enter the number of people.'; err.hidden = false; return; }
      body.occupants = Number(v);
    }
    if (m.querySelector('[data-on="out"]').checked) {
      if (clear.checked) body.clear_move_out = true;
      else {
        const d = m.querySelector('[data-out]').value;
        if (!d) { err.textContent = 'Pick the move-out date, or tick "Remove the move-out date".'; err.hidden = false; return; }
        body.move_out = d;
      }
    }
    if (body.occupants === undefined && !body.move_out && !body.clear_move_out) { err.textContent = 'Tick at least one thing to change.'; err.hidden = false; return; }
    try {
      const r = await api('/admin/tenants/bulk-update', { method: 'POST', body });
      closeModal();
      after();
      if (r.skipped.length) skippedModal(`Updated ${r.updated} tenant${r.updated === 1 ? '' : 's'}`, r.skipped);
      else toast(`Updated ${r.updated} tenant${r.updated === 1 ? '' : 's'}`);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  });
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

const UTILITY_HELP = `<div class="notice small"><b>Two kinds of charges:</b> utilities <b>split from a bill</b> using RUBS (water, sewer, trash…),
  and <b>fixed amounts per tenant</b> (internet, cable, pest control…). Use "Show on statement as" to combine several into one line,
  e.g. Water + Sewer → "Water & Sewer", or Internet + Pest Control + Trash → "Amenity Fee".<br><b>How the split works (RUBS):</b> First, <b>Recovery %</b> of the bill is passed to tenants.
  The rest (common areas, office, pool, etc.) is paid by the owner. That amount is then divided using the <b>weights</b>, for example
  100 for square footage only, or 50 sq ft + 50 occupants. Each tenant's share = their factor × days occupied ÷ the total for the property.
  <br><b>Vacancy handling:</b> "Owner absorbs vacant units" counts vacant unit-days, so the owner pays the vacant share (recommended).
  "Split among occupied units only" divides 100% of the billable amount among tenants.</div>`;

const UTILITY_FIELDS = [
  { name: 'utility_name', label: 'Utility / charge', required: true, placeholder: 'Water, Sewer, Trash, Pest Control, Internet…' },
  { name: 'charge_method', label: 'How it is charged', type: 'select', required: true,
    options: [['rubs', 'Split a utility bill using RUBS'], ['flat', 'Fixed amount per tenant']],
    help: 'Use "Fixed amount" for flat monthly charges like Internet, Cable or Pest Control that are not split from a bill.' },
  { name: 'statement_label', label: 'Show on statement as', placeholder: 'e.g. Water & Sewer, or Amenity Fee',
    help: 'Charges with the same name here are combined into one line on the statement and in the Rent Manager export. Leave blank to use the utility name.' },
  { name: 'rm_charge_code', label: 'Rent Manager charge code', help: 'For a combined line, the code of the first charge in the group (by order) is used.' },
  { type: 'heading', label: 'Fixed amount', group: 'flat' },
  { name: 'flat_amount_cents', label: 'Amount per tenant, per billing period ($)', type: 'money', min: 0, group: 'flat' },
  { name: 'flat_prorate', label: 'Prorate by days lived there (move-ins and move-outs)', type: 'checkbox', group: 'flat' },
  { type: 'heading', label: 'RUBS split', group: 'rubs' },
  { name: 'recovery_pct', label: 'Recovery % billed to tenants', type: 'number', min: 0, help: 'Example: 85 means 15% is deducted for common areas', group: 'rubs' },
  { name: 'vacancy_mode', label: 'Vacancy handling', type: 'select', required: true, group: 'rubs',
    options: [['owner', 'Owner absorbs vacant units'], ['occupied', 'Split among occupied units only']] },
  { name: 'w_sqft', label: 'Weight: square footage', type: 'number', min: 0, group: 'rubs' },
  { name: 'w_bedrooms', label: 'Weight: bedrooms', type: 'number', min: 0, group: 'rubs' },
  { name: 'w_occupants', label: 'Weight: number of occupants', type: 'number', min: 0, group: 'rubs' },
  { name: 'w_equal', label: 'Weight: equal per unit', type: 'number', min: 0, group: 'rubs' },
  { name: 'vacant_occupants', label: 'Occupants assumed for vacant units', type: 'number', min: 0, help: 'Only used with the occupants weight and "owner absorbs"', group: 'rubs' },
  { type: 'heading', label: 'Other' },
  { name: 'tax_pct', label: 'Tax % added to tenants\' charge', type: 'number', min: 0, help: 'e.g. 10 for a 10% utility tax on water. Use 0 for none.' },
  { name: 'sort_order', label: 'Order on statement', type: 'number', help: 'Lower numbers are listed first.' },
  { name: 'active', label: 'Active', type: 'checkbox' },
  { name: 'notes', label: 'Notes', type: 'textarea', full: true },
];

function describeCharge(u) {
  if (u.charge_method === 'flat') return `Fixed ${money(u.flat_amount_cents)} per tenant${u.flat_prorate ? ', prorated by days' : ''}`;
  return `${u.recovery_pct}% tenant contribution · ${describeAllocation(u)}`;
}

async function utilitiesView(el, { propertyId }) {
  const utils = await getUtilities(propertyId);
  const lineOf = (u) => (u.statement_label || '').trim() || u.utility_name;
  // Statement lines in the order they will print, with the charges combined into each.
  const lines = [];
  for (const u of utils.filter((x) => x.active)) {
    const l = lines.find((x) => x.label.toLowerCase() === lineOf(u).toLowerCase());
    if (l) l.utils.push(u); else lines.push({ label: lineOf(u), utils: [u] });
  }
  const mixedCodes = lines.filter((l) => l.utils.length > 1 && new Set(l.utils.map((u) => u.rm_charge_code || '')).size > 1);
  const split = utils.filter((u) => u.charge_method !== 'flat');
  const fixed = utils.filter((u) => u.charge_method === 'flat');
  const nameCell = (u) => esc(u.utility_name) + (u.active ? '' : ' <span class="badge">inactive</span>');
  const lineCell = (u) => esc(lineOf(u)) + (lineOf(u) !== u.utility_name ? ' <span class="badge">combined</span>' : '');
  const actions = (u) => `<button class="link" data-action="test" data-id="${u.id}">Test calculation</button>
    <button class="link" data-action="edit" data-id="${u.id}">Edit</button>
    <button class="link danger" data-action="del" data-id="${u.id}">Delete</button>`;
  const div = document.createElement('div');
  div.innerHTML = `${lines.length ? `<div class="card mb statement-preview"><h3 class="m0">On the statement</h3>
      <p class="small muted">How these charges will appear on each tenant's statement (and as rows in the Rent Manager export):</p>
      <ul>${lines.map((l) => `<li><b>${esc(l.label)}</b> <span class="muted small">· ${esc(l.utils[0].rm_charge_code || 'no charge code')}${l.utils.length > 1 ? ` · combines ${l.utils.map((u) => esc(u.utility_name)).join(' + ')}` : ''}</span></li>`).join('')}</ul>
      ${mixedCodes.length ? `<div class="warn small">${mixedCodes.map((l) => `"${esc(l.label)}" combines charges with different Rent Manager codes. The combined line uses ${esc(l.utils[0].rm_charge_code || '(none)')}.`).join(' ')}</div>` : ''}
    </div>` : ''}

    <section class="mb">
      <div class="topbar"><div><h2 class="m0">1. Utility bill (split with RUBS)</h2>
        <div class="muted small">Utilities on the bill from the utility company, usually water and sewer. You enter the amounts in each billing batch.</div></div>
        <button class="primary" data-action="addSplit">+ Add utility</button></div>
      ${table({
        columns: [
          { label: 'Utility', value: nameCell },
          { label: 'On statement as', value: lineCell },
          { label: 'RM charge code', value: 'rm_charge_code' },
          { label: 'Split rule', value: (u) => esc(describeCharge(u)) },
          { label: 'Tax', value: (u) => (Number(u.tax_pct) ? `${u.tax_pct}%` : '—'), cls: 'num' },
          { label: 'Order', value: 'sort_order', cls: 'num' },
        ],
        rows: split, actions,
        empty: 'No utilities yet. Add the utilities on your utility bill, e.g. Water and Sewer.',
      })}
    </section>

    <section class="mb">
      <div class="topbar"><div><h2 class="m0">2. Fixed monthly charges</h2>
        <div class="muted small">Set the amount per tenant here once, e.g. Trash, Pest Control, Internet or Cable. Every billing batch adds them automatically.</div></div>
        <button class="primary" data-action="addFixed">+ Add fixed charge</button></div>
      ${table({
        columns: [
          { label: 'Charge', value: nameCell },
          { label: 'On statement as', value: lineCell },
          { label: 'RM charge code', value: 'rm_charge_code' },
          { label: 'Amount per tenant', value: (u) => `<b>${money(u.flat_amount_cents)}</b><div class="muted small">${u.flat_prorate ? 'prorated by days lived there' : 'full amount, not prorated'}</div>`, cls: 'num' },
          { label: 'Tax', value: (u) => (Number(u.tax_pct) ? `${u.tax_pct}%` : '—'), cls: 'num' },
          { label: 'Order', value: 'sort_order', cls: 'num' },
        ],
        rows: fixed, actions,
        empty: 'No fixed charges. Add flat monthly charges such as Trash, Pest Control, Internet or Cable.',
      })}
    </section>
    <details class="hint"><summary>How the split and statement lines work</summary>${UTILITY_HELP}</details>`;
  el.replaceChildren(div);
  const reload = () => utilitiesView(el, { propertyId });
  // Utilities split from the bill use the Rent Manager-style template form; fixed charges use the simple form.
  const openForm = (title, values, save) => {
    if (values.charge_method !== 'flat') return rubsTemplateModal({ title, values, save, utilityId: values.id });
    const m = formModal({ title, fields: UTILITY_FIELDS, wide: true, values, onSubmit: save });
    toggleGroups(m.querySelector('form'), 'charge_method');
  };
  const create = async (d) => { await api('/admin/utilities', { method: 'POST', body: { ...d, property_id: propertyId } }); toast('Saved'); reload(); };
  onActions(div, {
    addSplit: () => openForm('Add utility (from the utility bill)',
      { charge_method: 'rubs', recovery_pct: 100, allocation_mode: 'factors', w_occupants: 50, w_sqft: 50, sqft_scope: 'all', occupancy_weighting: 'headcount', active: true, tax_pct: 0 }, create),
    test: ({ id }) => testCalculationModal(utils.find((u) => u.id == id)),
    addFixed: () => openForm('Add fixed monthly charge',
      { charge_method: 'flat', recovery_pct: 100, vacancy_mode: 'owner', vacant_occupants: 1, active: true, tax_pct: 0, flat_prorate: true }, create),
    edit: ({ id }) => openForm('Edit charge', utils.find((u) => u.id == id),
      async (d) => { await api(`/admin/utilities/${id}`, { method: 'PUT', body: d }); toast('Saved'); reload(); }),
    del: async ({ id }) => {
      if (!(await confirmBox('Delete this charge?'))) return;
      await api(`/admin/utilities/${id}`, { method: 'DELETE' }); toast('Deleted'); reload();
    },
  });
}

// --------------------------------------------------------------- exports

async function exportsPage() {
  const props = await getProperties();
  const first = new Date(); first.setDate(1);
  const div = mount(`<div class="topbar"><h1>Export to Rent Manager</h1></div>
    <div class="card mb"><h2>Tenant charges (finalized statements)</h2>
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
  const tabs = [['email', 'Company & email'], ['staff', 'Staff accounts'], ['security', 'Security'], ['system', 'System & storage']];
  const div0 = mount(`<div class="topbar"><h1>Settings</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a href="#/settings/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
    <div data-tab></div>`);
  const el = div0.querySelector('[data-tab]');
  if (tab === 'email') return emailSettingsView(el);
  if (tab === 'system') return systemView(el);
  if (tab === 'security') return securityView(el);
  const admins = await api('/admin/admins');
  const div = document.createElement('div');
  el.replaceChildren(div);
  div.innerHTML = `
    <div class="topbar"><h2 class="m0">Staff accounts</h2><div class="row">
      <button data-action="password">Change my password</button><button class="primary" data-action="add">+ Add staff user</button></div></div>
    ${table({
      columns: [{ label: 'Name', value: 'name' }, { label: 'Email', value: 'email' }, { label: 'Created', value: (a) => date(a.created_at) },
        { label: 'Last sign-in', value: (a) => (a.last_login_at ? `${esc(dateTime(a.last_login_at))}<div class="small muted">IP ${esc(a.last_login_ip || 'unknown')}</div>` : '<span class="muted">—</span>') }],
      rows: admins,
      actions: (a) => (a.id === currentUser.id ? '<span class="muted small">you</span>' : `<button class="link danger" data-action="del" data-id="${a.id}">Remove</button>`),
    })}`;
  onActions(div, {
    add: () => formModal({ title: 'Add staff user', fields: [
      { name: 'name', label: 'Name' }, { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'password', label: 'Temporary password', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/admin/admins', { method: 'POST', body: d }); toast('Staff user added'); settingsPage('staff'); } }),
    password: () => formModal({ title: 'Change my password', fields: [
      { name: 'current_password', label: 'Current password', type: 'password', required: true, full: true, autocomplete: 'current-password' },
      { name: 'new_password', label: 'New password', type: 'password', required: true, full: true, autocomplete: 'new-password' }],
      onSubmit: async (d) => { await api('/admin/admins/me/password', { method: 'PUT', body: d }); toast('Password changed'); } }),
    del: async ({ id }) => {
      if (!(await confirmBox('Remove this staff user?', 'Remove'))) return;
      await api(`/admin/admins/${id}`, { method: 'DELETE' }); toast('Removed'); settingsPage('staff');
    },
  });
}

// --------------------------------------------------------------- settings → system & storage

const bytes = (n) => {
  if (n == null) return 'unknown';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${Number.isInteger(n) ? n : n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
};
const pct = (a, b) => (a == null || !b ? null : (a / b) * 100);
const pctText = (p) => (p == null ? '—' : p < 0.01 ? 'Less than 0.01%' : `${p < 1 ? p.toFixed(2) : p.toFixed(1)}%`);

async function systemView(el) {
  const s = await api('/admin/system');
  const db = s.database;
  const used = pct(db.size_bytes, db.limit_bytes);
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="grid sys-grid">
      <section class="card">
        <h2>Database storage</h2>
        <div class="sys-big">${bytes(db.size_bytes)} <span class="muted">of ${bytes(db.limit_bytes)}</span></div>
        <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used == null ? 0 : used.toFixed(2)}"><span data-meter></span></div>
        <p class="small muted">${pctText(used)} of the ${esc(db.plan_label)} plan's ${bytes(db.limit_bytes)} limit per database.
          ${db.plan === 'paid' ? `The first ${bytes(db.included_bytes)} of storage across your account is included in the $5.` : `Your Cloudflare account can hold ${bytes(db.account_limit_bytes)} across all D1 databases.`}
          Statement PDFs aren't stored: they're built from the data each time they're opened or emailed, so they take no space.</p>
        <dl class="kv small">
          <dt>Cloudflare plan</dt><dd><select data-plan aria-label="Cloudflare plan">
            <option value="free" ${db.plan === 'free' ? 'selected' : ''}>Workers Free</option>
            <option value="paid" ${db.plan === 'paid' ? 'selected' : ''}>Workers Paid ($5/month)</option></select>
            <div class="muted">Pick the plan your Cloudflare account is on (the app can't see it).</div></dd>
          <dt>Total records</dt><dd>${db.total_rows.toLocaleString()}</dd>
          <dt>Rows read</dt><dd>${esc(db.reads)}</dd>
          <dt>Rows written</dt><dd>${esc(db.writes)}</dd>
          <dt>Over the limit</dt><dd>${esc(db.over)}</dd>
          <dt>Restore points</dt><dd>Cloudflare keeps ${db.time_travel_days} days of automatic restore points ("Time Travel")</dd>
          <dt>Server time limit</dt><dd>${esc(db.cpu)}</dd>
        </dl>
      </section>
      <section class="card">
        <h2>Records</h2>
        <table class="plain small"><tbody>
          ${db.tables.map((t) => `<tr><td>${esc(t.label)}</td><td class="num">${t.rows.toLocaleString()}</td></tr>`).join('')}
        </tbody></table>
      </section>
      <section class="card">
        <h2>Server</h2>
        <dl class="kv small">
          <dt>Web address</dt><dd>${esc(s.server.host)}</dd>
          <dt>Runtime</dt><dd>${esc(s.server.runtime)}</dd>
          <dt>Data center</dt><dd>${esc(s.server.data_center || '—')}${s.server.location ? ` <span class="muted">(you're connecting from ${esc(s.server.location)})</span>` : ''}</dd>
          <dt>Database served by</dt><dd>${esc(db.served_by || '—')}</dd>
          <dt>Database response</dt><dd>${db.query_ms} ms</dd>
          <dt>Connection</dt><dd>${esc([s.server.http, s.server.tls].filter(Boolean).join(' · ') || '—')}</dd>
          <dt>Database version</dt><dd>${esc(db.schema_version || '—')}${db.schema_updated_at ? ` <span class="muted">(updated ${esc(dateTime(db.schema_updated_at))})</span>` : ''}</dd>
          <dt>Signed-in sessions</dt><dd>${s.server.active_sessions}</dd>
          <dt>Emails sent this month</dt><dd>${s.server.emails_this_month}</dd>
          <dt>Server time</dt><dd>${esc(new Date(s.server.time).toLocaleString())}</dd>
        </dl>
      </section>
      <section class="card">
        <h2>What the app runs on</h2>
        <dl class="kv small">${s.stack.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      </section>
      <section class="card sys-wide">
        <h2>Back up the database</h2>
        <p class="small">Downloads every table (properties, units, tenants, utilities, billing batches, statements, settings and staff)
          as one file. Keep it somewhere safe. It contains tenants' personal details.</p>
        <ul class="small">
          <li><b>SQL file</b>: can be loaded back into a Cloudflare D1 database (create the database, apply the files in
            <code>migrations/</code>, then <code>npx wrangler d1 execute &lt;database&gt; --remote --file=backup.sql</code>).</li>
          <li><b>JSON file</b>: easy to open in other tools, or to keep as a readable archive.</li>
        </ul>
        <label class="check small"><input type="checkbox" data-secrets> Include passwords (hashed staff and tenant passwords, and the SMTP password).
          Leave this off unless you need a full restore. Without it, staff accounts are left out (after a restore you create a new staff
          login on the first-time setup screen) and tenants activate their portal account again.</label>
        <div class="row mt">
          <button class="primary" data-action="backup" data-format="sql">${ICONS.download}<span>Download SQL backup</span></button>
          <button data-action="backup" data-format="json">${ICONS.download}<span>Download JSON backup</span></button>
          <span class="small muted" data-progress></span>
        </div>
      </section>
    </div>`;
  el.replaceChildren(div);
  div.querySelector('[data-meter]').style.width = `${Math.max(used || 0, 0.5)}%`;
  div.querySelector('[data-plan]').addEventListener('change', async (e) => {
    try {
      await api('/admin/system/plan', { method: 'PUT', body: { plan: e.target.value } });
      toast(e.target.value === 'paid' ? 'Saved: Workers Paid. Passwords get stronger protection as people sign in.' : 'Saved: Workers Free');
      systemView(el);
    } catch (ex) { toast(ex.message, true); }
  });
  let busy = false;
  onActions(div, {
    backup: async ({ format }) => {
      if (busy) return;
      busy = true;
      const progress = div.querySelector('[data-progress]');
      const buttons = div.querySelectorAll('[data-action=backup]');
      buttons.forEach((b) => (b.disabled = true));
      try {
        const secrets = div.querySelector('[data-secrets]').checked;
        const data = {};
        for (const table of s.backup_tables) {
          data[table] = [];
          let offset = 0;
          while (offset !== null) {
            progress.textContent = `Reading ${table} (${data[table].length})…`;
            const page = await api(`/admin/system/backup?table=${table}&offset=${offset}${secrets ? '&secrets=1' : ''}`);
            data[table].push(...page.rows);
            offset = page.next;
          }
        }
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        const info = { app: 'RUBS utility billing', created_at: new Date().toISOString(), database_version: db.schema_version, includes_passwords: secrets };
        const text = format === 'sql' ? backupSql(data, info) : JSON.stringify({ ...info, tables: data }, null, 1);
        const blob = new Blob([text], { type: format === 'sql' ? 'application/sql' : 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `rubs-backup-${stamp}.${format}`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        const total = Object.values(data).reduce((t, r) => t + r.length, 0);
        progress.textContent = `Downloaded ${total.toLocaleString()} records (${bytes(blob.size)}).`;
        toast('Backup downloaded');
      } catch (e) {
        progress.textContent = '';
        throw e;
      } finally {
        busy = false;
        buttons.forEach((b) => (b.disabled = false));
      }
    },
  });
}

// Data-only SQL dump for a database that already has the schema (the migrations).
function backupSql(data, info) {
  const val = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const out = [
    `-- RUBS utility billing backup, ${info.created_at}`,
    `-- Database version: ${info.database_version || 'unknown'}. Passwords included: ${info.includes_passwords ? 'yes' : 'no'}`,
    '-- Restore into a database that has the migrations applied (data only, no table definitions).',
    'PRAGMA defer_foreign_keys = true;',
  ];
  for (const [table, rows] of Object.entries(data)) {
    out.push('', `-- ${table}: ${rows.length} rows`);
    for (const r of rows) {
      const cols = Object.keys(r);
      out.push(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => val(r[c])).join(', ')});`);
    }
  }
  return out.join('\n') + '\n';
}

// --------------------------------------------------------------- settings → security

const KIND_LABEL = { staff: 'Staff sign-in', resident: 'Tenant sign-in', activate: 'Tenant activation', setup: 'First-time setup' };
// A short "Chrome on Windows" style label from the browser's user agent.
function deviceLabel(ua) {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|wget|Go-http|node|axios|bot|spider/i.test(ua) ? 'Script/bot' : 'Other';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

let activityFailedOnly = false;

async function securityView(el) {
  const [sec, act, ses] = await Promise.all([
    api('/admin/security'), api(`/admin/security/activity${activityFailedOnly ? '?failed=1' : ''}`), api('/admin/security/sessions'),
  ]);
  const check = (ok, text) => `<li class="${ok ? 'ok' : 'off'}"><span class="chk" aria-hidden="true">${ok ? '✓' : '!'}</span><span>${text}</span></li>`;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="grid sys-grid">
      <section class="card">
        <h2>What's protecting the app</h2>
        <ul class="checklist small">
          ${check(true, '<b>HTTPS only.</b> Cloudflare encrypts every connection, and the browser is told never to use plain HTTP.')}
          ${check(true, `<b>Passwords are never stored.</b> Only a salted PBKDF2-SHA256 hash is kept (${sec.hash_rounds.toLocaleString()} rounds${sec.plan === 'paid' ? ', the maximum Cloudflare allows; older passwords are upgraded the next time each person signs in' : '; set your plan to Workers Paid in System &amp; storage for 100,000 rounds'}).`)}
          ${check(true, '<b>Secure sign-in cookies</b> (HttpOnly, Secure, SameSite=Strict), so other websites can\'t use your session.')}
          ${check(true, '<b>Strict browser security headers</b>: no outside scripts, no framing of the app (stops click-jacking), no camera/mic/location access.')}
          ${check(sec.altcha_enabled, sec.altcha_enabled ? '<b>Bot check (ALTCHA)</b> on sign-in, activation and setup forms. Self-hosted: no outside service and no tracking.' : '<b>Bot check (ALTCHA) is off.</b> Turn it on below to slow down automated password guessing.')}
          ${check(true, `<b>Failed sign-in lockout</b>: ${sec.max_failed_logins} wrong tries locks that email for ${sec.lockout_minutes} minutes. One internet address is also limited to ${sec.max_failed_logins * 4} failures across all emails.`)}
          ${check(true, '<b>Same answer for unknown emails</b>: the sign-in page doesn\'t reveal which emails have accounts.')}
          ${check(true, '<b>Changing a password signs out your other devices</b>, and locking a tenant signs them out right away.')}
        </ul>
      </section>
      <section class="card">
        <h2>Settings</h2>
        <form data-sec class="sec-form">
          <label class="check"><input type="checkbox" name="altcha_enabled" ${sec.altcha_enabled ? 'checked' : ''}>
            <span><b>"I'm not a robot" check (ALTCHA)</b> on sign-in, activation and setup<span class="help">The browser solves a small puzzle in about a second. People just tick the box; bots trying thousands of passwords are slowed down.</span></span></label>
          <div class="form-grid">
            <div class="field"><label>Wrong passwords before lockout</label><input type="number" name="max_failed_logins" min="3" max="20" value="${sec.max_failed_logins}" required></div>
            <div class="field"><label>Lockout length (minutes)</label><input type="number" name="lockout_minutes" min="5" max="1440" value="${sec.lockout_minutes}" required></div>
            <div class="field"><label>Staff stay signed in for (hours)</label><input type="number" name="staff_session_hours" min="1" max="168" value="${sec.staff_session_hours}" required></div>
            <div class="field"><label>Tenants stay signed in for (days)</label><input type="number" name="resident_session_days" min="1" max="90" value="${sec.resident_session_days}" required></div>
            <div class="field"><label>Minimum password length</label><input type="number" name="min_password_length" min="8" max="64" value="${sec.min_password_length}" required>
              <div class="help">For new and changed passwords. Existing passwords keep working.</div></div>
          </div>
          <div class="error" hidden></div>
          <button class="primary" type="submit">Save security settings</button>
        </form>
      </section>
      <section class="card">
        <h2>Signed-in sessions</h2>
        <p class="small">Right now: <b>${ses.staff}</b> staff session${ses.staff === 1 ? '' : 's'} and <b>${ses.tenants}</b> tenant session${ses.tenants === 1 ? '' : 's'}.
          If you think a password was stolen, sign everyone out, then change that password.</p>
        <div class="row">
          <button data-action="signOut" data-who="staff">Sign out all other staff</button>
          <button data-action="signOut" data-who="tenants">Sign out all tenants</button>
          <button class="danger" data-action="signOut" data-who="all">Sign out everyone but me</button>
        </div>
      </section>
      <section class="card">
        <h2>Locked out right now</h2>
        ${act.locked.length ? `<table class="plain small"><tbody>${act.locked.map((l) => `<tr><td>${esc(l.identifier)}<div class="muted">${l.n} failed tries, last ${esc(dateTime(l.last))}</div></td>
            <td class="right"><button class="link" data-action="unlock" data-id="${esc(l.identifier)}">Unlock</button></td></tr>`).join('')}</tbody></table>
            <button class="link" data-action="unlock">Unlock everyone</button>`
          : '<p class="small muted m0">Nobody is locked out.</p>'}
        <p class="small muted">In the last 24 hours: ${act.last_24h.ok} successful and ${act.last_24h.failed} failed sign-in${act.last_24h.failed === 1 ? '' : 's'}.</p>
      </section>
    </div>
    <div class="topbar mt"><h2 class="m0">Sign-in activity</h2>
      <div class="tabs m0">${[[false, 'All'], [true, 'Failed only']].map(([v, l]) => `<button data-action="filter" data-failed="${v}" class="${v === activityFailedOnly ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    ${table({
      columns: [
        { label: 'When', value: (r) => esc(dateTime(r.created_at)) },
        { label: 'Result', value: (r) => (r.success ? '<span class="badge posted">success</span>' : `<span class="badge danger">failed</span>${r.reason ? `<div class="small muted">${esc(r.reason)}</div>` : ''}`) },
        { label: 'Type', value: (r) => esc(KIND_LABEL[r.kind] || r.kind) },
        { label: 'Email / account', value: (r) => esc(r.identifier || '—'), cls: 'contact' },
        { label: 'IP address', value: (r) => esc(r.ip || '—') },
        { label: 'Device', value: (r) => `<span title="${esc(r.user_agent || '')}">${esc(deviceLabel(r.user_agent))}</span>` },
      ],
      rows: act.rows,
      pageKey: 'signins',
      empty: 'No sign-ins recorded yet.',
    })}
    <p class="small muted">Shows the latest 100 attempts. Entries are kept for 90 days.</p>`;
  el.replaceChildren(div);
  const again = () => securityView(el);
  div.querySelector('[data-sec]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = f.querySelector('.error');
    err.hidden = true;
    const d = Object.fromEntries(new FormData(f));
    d.altcha_enabled = f.altcha_enabled.checked;
    for (const k of ['max_failed_logins', 'lockout_minutes', 'staff_session_hours', 'resident_session_days', 'min_password_length']) d[k] = Number(d[k]);
    try { await api('/admin/security', { method: 'PUT', body: d }); toast('Security settings saved'); again(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
  onActions(div, {
    filter: ({ failed }) => { activityFailedOnly = failed === 'true'; resetPage('signins'); again(); },
    unlock: async ({ id }) => {
      const r = await api('/admin/security/clear-lockouts', { method: 'POST', body: { identifier: id || null } });
      toast(id ? `${id} can sign in again` : `Lockouts cleared (${r.cleared} failed tries forgotten)`); again();
    },
    signOut: async ({ who }) => {
      const what = { staff: 'all other staff members', tenants: 'all tenants', all: 'everyone except you (staff and tenants)' }[who];
      if (!(await confirmBox(`Sign out ${what}? They'll need to sign in again.`, 'Sign out'))) return;
      const r = await api('/admin/security/sign-out-all', { method: 'POST', body: { who } });
      toast(`${r.signed_out} session${r.signed_out === 1 ? '' : 's'} signed out`); again();
    },
  });
}
