// Shared front-end helpers: API calls, HTML escaping, formatting, modals, tables.

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Small inline icons (stroke = currentColor) used across the app.
const svg = (d, fill = false) => `<svg viewBox="0 0 24 24" aria-hidden="true" class="icon">${fill ? d : `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</g>`}</svg>`;
export const ICONS = {
  drop: svg('<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" fill="currentColor"/>', true),
  home: svg('<path d="M3 11l9-7 9 7M5 10v10h14V10"/>'),
  building: svg('<path d="M4 21V5l8-2v18M12 9l8 2v10M3 21h18M7 8h2M7 12h2M7 16h2M15 14h2M15 17h2"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.6-5.5 6.5-5.5s5.5 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c1.8.6 3 2.6 3.5 5.5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>'),
  doc: svg('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
  chart: svg('<path d="M4 20h16M7 16v-5M12 16V7M17 16v-8"/>'),
  export: svg('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  logout: svg('<path d="M9 21H5V3h4M16 17l5-5-5-5M21 12H9"/>'),
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>'),
  phone: svg('<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  card: svg('<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
};
export const initials = (name) => String(name || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (cents) =>
  (Number(cents || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const date = (s) => {
  if (!s) return '';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
};

export const fullName = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ');

let toastTimer;
export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
  document.body.classList.remove('modal-open');
}

export function modal(html, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  // The ✕ button matters most on phones, where the window fills the screen.
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <button type="button" class="modal-x" data-close aria-label="Close">×</button>${html}</div></div>`;
  document.body.classList.add('modal-open'); // stop the page behind from scrolling
  const bg = root.firstElementChild;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal(); });
  bg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  return bg.querySelector('.modal');
}

export function confirmBox(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const m = modal(`<h2>Are you sure?</h2><p>${esc(message)}</p>
      <div class="footer"><button data-close>Cancel</button><button class="primary" data-ok>${esc(okLabel)}</button></div>`);
    m.querySelector('[data-ok]').addEventListener('click', () => { closeModal(); resolve(true); });
    m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => resolve(false)));
  });
}

function fieldHtml(f, value) {
  if (f.type === 'heading') return `<h3 class="full form-heading" ${f.group ? `data-group="${f.group}"` : ''}>${esc(f.label)}</h3>${f.help ? `<p class="full muted small m0" ${f.group ? `data-group="${f.group}"` : ''}>${esc(f.help)}</p>` : ''}`;
  const id = 'f_' + f.name;
  const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}" ${req}>
      ${f.required ? '' : '<option value=""></option>'}
      ${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" rows="3" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''}>${esc(value)}</textarea>`;
  } else if (f.type === 'checkbox') {
    input = `<input type="checkbox" id="${id}" name="${f.name}" ${value ? 'checked' : ''}>`;
  } else {
    const type = f.type === 'money' ? 'number' : f.type || 'text';
    const step = f.type === 'money' ? '0.01' : f.step || (f.type === 'number' ? 'any' : '');
    const v = f.type === 'money' && value !== null && value !== undefined && value !== '' ? (value / 100).toFixed(2) : value;
    input = `<input id="${id}" name="${f.name}" type="${type}" ${step ? `step="${step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''}
      value="${esc(v)}" ${req} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}>`;
  }
  return `<div class="field ${f.full ? 'full' : ''}" ${f.group ? `data-group="${f.group}"` : ''}><label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}
    ${f.help ? `<div class="help">${f.help}</div>` : ''}</div>`;
}

/** Shows only the form parts whose data-group matches the current value of a select (e.g. charge type). */
export function toggleGroups(form, selectName) {
  const sel = form.elements[selectName];
  const apply = () => form.querySelectorAll('[data-group]').forEach((el) => { el.hidden = el.dataset.group !== sel.value; });
  sel.addEventListener('change', apply);
  apply();
}

export function readForm(form, fields) {
  const data = {};
  for (const f of fields) {
    if (f.type === 'heading') continue;
    const el = form.elements[f.name];
    if (!el) continue;
    if (f.type === 'checkbox') data[f.name] = el.checked;
    else if (f.type === 'money') data[f.name] = el.value === '' ? null : Math.round(Number(el.value) * 100);
    else data[f.name] = el.value === '' ? null : el.value;
  }
  return data;
}

/** Opens a modal form. onSubmit(data) may throw; the error is shown in the form. */
export function formModal({ title, fields, values = {}, submitLabel = 'Save', onSubmit, intro = '', wide = false }) {
  const m = modal(`<h2>${esc(title)}</h2>${intro}<div class="error" hidden></div>
    <form class="form-grid" novalidate>${fields.map((f) => fieldHtml(f, values[f.name])).join('')}
      <div class="footer full"><button type="button" data-close>Cancel</button><button class="primary" type="submit">${esc(submitLabel)}</button></div>
    </form>`, { wide });
  const form = m.querySelector('form');
  const errBox = m.querySelector('.error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await onSubmit(readForm(form, fields), form);
      closeModal();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
      btn.disabled = false;
    }
  });
  form.querySelector('input:not([type=hidden]),select,textarea')?.focus();
  return m;
}

/**
 * columns: [{label, value: (row) => html | 'key', cls}] — cell values from keys are escaped.
 * select: true adds a checkbox column (rows need an id); use bindSelection() to handle it.
 */
export function table({ columns, rows, actions, empty = 'Nothing here yet.', footer, select = false, pageKey }) {
  if (!rows.length) return `<div class="table-wrap"><div class="empty">${empty}</div></div>`;
  // pageKey: show the rows a page at a time, with a pager underneath. All rows stay in the page
  // (hidden when off-page), so selection, inline edits and row actions work the same.
  const paged = pageKey && rows.length > PAGE_SIZES[0];
  const size = paged ? pageSize() : 0;
  const page = paged ? clampPage(pageKey, rows.length, size) : 0;
  const off = (i) => paged && size && (i < page * size || i >= (page + 1) * size);
  return `<div class="table-wrap${paged ? ' paged' : ''}" ${paged ? `data-page-key="${esc(pageKey)}"` : ''}><div class="table-scroll"><table class="responsive">
    <thead><tr>${select ? '<th class="sel"><input type="checkbox" data-select-all aria-label="Select all on this page"></th>' : ''}${columns.map((c) => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}${actions ? '<th class="actions"></th>' : ''}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr${off(i) ? ' class="off-page"' : ''}>${select ? `<td class="sel"><input type="checkbox" data-select value="${esc(r.id)}" aria-label="Select"></td>` : ''}${columns.map((c) => `<td class="${c.cls || ''}" data-label="${esc(c.label)}">${typeof c.value === 'function' ? c.value(r) : esc(r[c.value])}</td>`).join('')}
      ${actions ? `<td class="actions">${actions(r)}</td>` : ''}</tr>`).join('')}</tbody>
    ${footer ? `<tfoot>${footer}</tfoot>` : ''}
  </table></div>${paged ? `<div class="pager" data-pager>${pagerHtml(rows.length, page, size)}</div>` : ''}</div>`;
}

// ---- pagination (rows per page is remembered in this browser; the page per list until a reload of the app)

const PAGE_SIZES = [25, 50, 100];
const pages = {};
const pageSize = () => {
  const v = localStorage.getItem('rowsPerPage');
  return v !== null && (Number(v) === 0 || PAGE_SIZES.includes(Number(v))) ? Number(v) : PAGE_SIZES[0];
};
const clampPage = (key, total, size) => (pages[key] = size ? Math.min(Math.max(pages[key] || 0, 0), Math.ceil(total / size) - 1) : 0);
/** Go back to page 1 of a list (e.g. after the search or a filter changes). */
export const resetPage = (key) => { pages[key] = 0; };

function pagerHtml(total, page, size) {
  const count = size ? Math.ceil(total / size) : 1;
  const from = size ? page * size + 1 : 1;
  const to = size ? Math.min(total, (page + 1) * size) : total;
  const btn = (p, label, aria) => `<button type="button" class="pg" data-goto="${p}" ${p < 0 || p >= count || p === page ? 'disabled' : ''} aria-label="${aria}">${label}</button>`;
  // Page buttons: first, last, and two either side of the current page.
  const nums = [];
  for (let p = 0; p < count; p++) {
    if (p === 0 || p === count - 1 || Math.abs(p - page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return `<div class="pager-info">Showing <b>${from}–${to}</b> of <b>${total}</b></div>
    <label class="pager-size">Rows per page <select data-page-size>${[...PAGE_SIZES, 0].map((n) => `<option value="${n}" ${n === size ? 'selected' : ''}>${n || 'All'}</option>`).join('')}</select></label>
    ${count > 1 ? `<nav class="pager-nav" aria-label="Pages">${btn(page - 1, '‹ Prev', 'Previous page')}
      ${nums.map((p) => (p === '…' ? '<span class="pg-gap">…</span>' : `<button type="button" class="pg${p === page ? ' current' : ''}" data-goto="${p}" ${p === page ? 'aria-current="page"' : ''}>${p + 1}</button>`)).join('')}
      ${btn(page + 1, 'Next ›', 'Next page')}</nav>` : ''}`;
}

function showPage(wrap, page) {
  const rows = [...wrap.querySelectorAll(':scope > .table-scroll > table > tbody > tr')];
  const size = pageSize();
  const key = wrap.dataset.pageKey;
  pages[key] = page;
  page = clampPage(key, rows.length, size);
  rows.forEach((tr, i) => tr.classList.toggle('off-page', Boolean(size) && (i < page * size || i >= (page + 1) * size)));
  wrap.querySelector('[data-pager]').innerHTML = pagerHtml(rows.length, page, size);
  wrap.dispatchEvent(new CustomEvent('pagechange', { bubbles: true }));
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pager] [data-goto]');
  if (!b) return;
  const wrap = b.closest('.paged');
  showPage(wrap, Number(b.dataset.goto));
  if (wrap.getBoundingClientRect().top < 0) wrap.scrollIntoView({ block: 'start' });
});
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-pager] [data-page-size]')) return;
  const wrap = e.target.closest('.paged');
  const first = pages[wrap.dataset.pageKey] * pageSize(); // keep the first visible row in view
  localStorage.setItem('rowsPerPage', e.target.value);
  const size = pageSize();
  showPage(wrap, size ? Math.floor(first / size) : 0);
});

// ---- row "More" menus: <details class="row-menu">. The panel is fixed-positioned so the table's
// scroll box can't cut it off.

/** Row actions: the first items stay visible, the rest go in a "More" menu. */
export function rowActions(visible, more) {
  const items = more.filter(Boolean);
  return `${visible.filter(Boolean).join('')}${items.length ? `<details class="row-menu"><summary class="link" title="More actions">More ▾</summary>
    <div class="menu-panel" role="menu">${items.join('')}</div></details>` : ''}`;
}

const closeMenus = (except) => document.querySelectorAll('details.row-menu[open]').forEach((d) => { if (d !== except) d.open = false; });
function placeMenu(d) {
  const panel = d.querySelector('.menu-panel');
  const r = d.querySelector('summary').getBoundingClientRect();
  const box = d.closest('.table-scroll')?.getBoundingClientRect();
  // Close it once its row has scrolled out of sight.
  if (r.bottom < 0 || r.top > window.innerHeight || (box && (r.bottom < box.top || r.top > box.bottom))) { d.open = false; return; }
  panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  panel.style.top = `${r.bottom + 4}px`;
  const h = panel.offsetHeight;
  if (r.bottom + 4 + h > window.innerHeight - 8 && r.top - h - 4 > 8) panel.style.top = `${r.top - h - 4}px`;
}
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('row-menu') || !d.open) return;
  closeMenus(d);
  placeMenu(d);
}, true);
// Close on any click outside the menu's own toggle (clicking an item runs it, then closes the menu).
document.addEventListener('click', (e) => {
  const own = e.target.closest('details.row-menu');
  if (own && e.target.closest('summary')) return closeMenus(own);
  closeMenus();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
window.addEventListener('resize', () => closeMenus());
document.addEventListener('scroll', () => document.querySelectorAll('details.row-menu[open]').forEach(placeMenu), true);

/**
 * Checkbox selection for a table rendered with select: true. Shows `bar` when something is
 * selected and calls render(bar, ids) to fill it. Returns {ids(), clear()}.
 */
export function bindSelection(root, bar, render) {
  const selected = new Set();
  const boxes = () => [...root.querySelectorAll('[data-select]')];
  // "Select all" works on the rows shown on the current page.
  const shown = () => boxes().filter((b) => !b.closest('tr').classList.contains('off-page'));
  const all = root.querySelector('[data-select-all]');
  const update = () => {
    boxes().forEach((b) => { b.checked = selected.has(Number(b.value)); b.closest('tr').classList.toggle('selected', b.checked); });
    if (all) {
      const n = shown().filter((b) => b.checked).length;
      all.checked = n > 0 && n === shown().length;
      all.indeterminate = n > 0 && n < shown().length;
    }
    bar.hidden = selected.size === 0;
    if (selected.size) render(bar, [...selected]);
  };
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-select]')) {
      const id = Number(e.target.value);
      if (e.target.checked) selected.add(id); else selected.delete(id);
      update();
    } else if (e.target.matches('[data-select-all]')) {
      shown().forEach((b) => (e.target.checked ? selected.add(Number(b.value)) : selected.delete(Number(b.value))));
      update();
    }
  });
  root.addEventListener('pagechange', update);
  const api = { ids: () => [...selected], clear: () => { selected.clear(); update(); } };
  update();
  return api;
}

/** Minimal RFC 4180 CSV parser -> array of objects keyed by header. */
export function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Delegated click handling: <button data-action="x" data-id="1"> */
export function onActions(root, handlers) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.action];
    // stopPropagation: views are nested (e.g. a property page holding its Units tab), and both may
    // use the same action name ("edit"); only the innermost view should handle the click.
    if (fn) { e.preventDefault(); e.stopPropagation(); Promise.resolve(fn(el.dataset, el)).catch((err) => toast(err.message, true)); }
  });
}
