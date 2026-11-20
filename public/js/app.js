// Entry point: decides between first-time setup, sign in, admin app and resident portal.
import { api, esc, toast } from './ui.js';
import { startAdmin } from './admin.js';
import { startResident } from './resident.js';

const app = document.getElementById('app');

async function boot() {
  let status;
  try { status = await api('/auth/status'); }
  catch (e) { app.innerHTML = `<div class="center"><div class="error">Could not reach the server: ${esc(e.message)}</div></div>`; return; }
  if (status.needsSetup) return setupScreen();
  if (!status.user) return loginScreen();
  if (status.user.type === 'admin') return startAdmin(app, status.user, logout);
  return startResident(app, status.user, logout);
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.hash = '';
  boot();
}

function authCard(inner) {
  app.innerHTML = `<div class="auth"><div class="card">${inner}</div></div>`;
  return app.querySelector('.card');
}

function bindForm(card, handler) {
  const form = card.querySelector('form');
  const err = card.querySelector('.error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try { await handler(data); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
  });
}

function setupScreen() {
  const card = authCard(`<h1>Welcome</h1><p class="muted">Create the first administrator account.</p>
    <div class="error" hidden></div>
    <form>
      <div class="field"><label>Your name</label><input name="name" autocomplete="name"></div>
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Password (8+ characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="primary" type="submit">Create admin account</button>
    </form>`);
  bindForm(card, async (d) => { await api('/auth/setup', { method: 'POST', body: d }); boot(); });
}

function loginScreen(mode = 'resident') {
  const tabs = `<div class="tabs">
    <button data-mode="resident" class="${mode === 'resident' ? 'active' : ''}">Resident sign in</button>
    <button data-mode="activate" class="${mode === 'activate' ? 'active' : ''}">First time? Activate</button>
    <button data-mode="admin" class="${mode === 'admin' ? 'active' : ''}">Staff</button></div>`;
  const forms = {
    resident: `<form>
      <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
      <button class="primary" type="submit">Sign in</button></form>`,
    admin: `<form>
      <div class="field"><label>Staff email</label><input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Password</label><input name="password" type="password" required autocomplete="current-password"></div>
      <button class="primary" type="submit">Sign in</button></form>`,
    activate: `<p class="muted small">Use the account number from your lease or statement and the email address the office has on file.</p>
      <form>
      <div class="field"><label>Account number</label><input name="account_number" required></div>
      <div class="field"><label>Email on file</label><input name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label>Choose a password (8+ characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <button class="primary" type="submit">Activate my account</button></form>`,
  };
  const card = authCard(`<h1>Utility Billing</h1>${tabs}<div class="error" hidden></div>${forms[mode]}`);
  card.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => loginScreen(b.dataset.mode)));
  bindForm(card, async (d) => {
    if (mode === 'activate') {
      await api('/auth/activate', { method: 'POST', body: d });
      toast('Your account is active');
    } else {
      await api('/auth/login', { method: 'POST', body: { ...d, type: mode } });
    }
    boot();
  });
}

boot();
