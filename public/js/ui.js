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

export function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

export function modal(html, { wide = false } = {}) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog">${html}</div></div>`;
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
  const id = 'f_' + f.name;
  const req = f.required ? 'required' : '';
  let input;
  if (f.type === 'select') {
    input = `<select id="${id}" name="${f.name}" ${req}>
      ${f.required ? '' : '<option value=""></option>'}
      ${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}
    </select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea id="${id}" name="${f.name}" rows="3">${esc(value)}</textarea>`;
  } else if (f.type === 'checkbox') {
    input = `<input type="checkbox" id="${id}" name="${f.name}" ${value ? 'checked' : ''}>`;
  } else {
    const type = f.type === 'money' ? 'number' : f.type || 'text';
    const step = f.type === 'money' ? '0.01' : f.step || (f.type === 'number' ? 'any' : '');
    const v = f.type === 'money' && value !== null && value !== undefined && value !== '' ? (value / 100).toFixed(2) : value;
    input = `<input id="${id}" name="${f.name}" type="${type}" ${step ? `step="${step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''}
      value="${esc(v)}" ${req} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${f.autocomplete ? `autocomplete="${f.autocomplete}"` : ''}>`;
  }
  return `<div class="field ${f.full ? 'full' : ''}"><label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>${input}
    ${f.help ? `<div class="help">${f.help}</div>` : ''}</div>`;
}

export function readForm(form, fields) {
  const data = {};
  for (const f of fields) {
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
  form.querySelector('input,select,textarea')?.focus();
  return m;
}

/** columns: [{label, value: (row) => html | 'key', cls}] — cell values from keys are escaped. */
export function table({ columns, rows, actions, empty = 'Nothing here yet.', footer }) {
  if (!rows.length) return `<div class="table-wrap"><div class="empty">${empty}</div></div>`;
  return `<div class="table-wrap"><table>
    <thead><tr>${columns.map((c) => `<th class="${c.cls || ''}">${esc(c.label)}</th>`).join('')}${actions ? '<th></th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td class="${c.cls || ''}">${typeof c.value === 'function' ? c.value(r) : esc(r[c.value])}</td>`).join('')}
      ${actions ? `<td class="actions">${actions(r)}</td>` : ''}</tr>`).join('')}</tbody>
    ${footer ? `<tfoot>${footer}</tfoot>` : ''}
  </table></div>`;
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
    if (fn) { e.preventDefault(); Promise.resolve(fn(el.dataset, el)).catch((err) => toast(err.message, true)); }
  });
}
