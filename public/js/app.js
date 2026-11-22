// Entry point: decides between first-time setup, sign in, admin app and tenant portal.
import { api, esc, toast } from './ui.js';
import { startAdmin } from './admin.js';
import { startResident } from './resident.js';

const app = document.getElementById('app');
let company = '';
let altchaOn = false; // ALTCHA "I'm not a robot" check on sign-in forms (Settings → Security)
let minPw = 8;

// ALTCHA widget (self-hosted in /vendor/altcha): loaded only on the sign-in screens.
let altchaLoaded;
function loadAltcha() {
  altchaLoaded ??= (async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/altcha/altcha.css';
    document.head.append(css);
    await import('/vendor/altcha/altcha.min.js');
    const worker = () => new Worker('/vendor/altcha/pbkdf2.js');
    globalThis.$altcha.algorithms.set('PBKDF2/SHA-256', worker);
  })();
  return altchaLoaded;
}
const altchaWidget = () => (altchaOn
  ? '<div class="altcha-wrap"><altcha-widget challenge="/api/auth/challenge" auto="onload" name="altcha"></altcha-widget></div>'
  : '');

async function boot() {
  let status;
  try { status = await api('/auth/status'); }
  catch (e) { app.innerHTML = `<div class="center"><div class="error">Could not reach the server: ${esc(e.message)}</div></div>`; return; }
  company = status.company_name || '';
  altchaOn = Boolean(status.altcha);
  minPw = status.min_password_length || 8;
  if (status.needsSetup) return setupScreen();
  // A "Forgot password" email link: #reset=<token>
  const reset = /^#reset=([a-f0-9]{64})$/.exec(location.hash);
  if (reset) return resetScreen(reset[1]);
  if (!status.user) return loginScreen(location.hash === '#staff' ? 'staff' : 'resident');
  const user = { ...status.user, company_name: company, payment_url: status.payment_url || '' };
  if (user.type === 'admin') return startAdmin(app, user, logout);
  return startResident(app, user, logout, stopPreview);
}

// Leave a staff "log in as a tenant" preview and return to the staff screens.
async function stopPreview() {
  const r = await api('/auth/stop-view-as', { method: 'POST' });
  if (r.relogin) toast('Your staff session expired. Please sign in again.', true);
  location.hash = r.relogin ? '#staff' : '#/tenants';
  boot();
}

async function logout() {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.hash = '';
  boot();
}

// ---------------------------------------------------------------- layout pieces

const ICONS = {
  doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l5 5v13H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M14 3v5h5M10 13h6M10 17h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M7 16v-5M12 16V7M17 16v-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  drop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" fill="currentColor"/></svg>',
  building: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V5l8-2v18M12 9l8 2v10M3 21h18M7 8h2M7 12h2M7 16h2M15 14h2M15 17h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function brandPanel({ title, text, points }) {
  return `<aside class="login-brand">
    <div class="login-logo"><span class="logo-mark">${ICONS.drop}</span><span>Utility Billing</span></div>
    <div class="login-pitch">
      <h1>${title}</h1>
      <p>${text}</p>
      <ul>${points.map(([icon, t]) => `<li><span class="pt-icon">${ICONS[icon]}</span><span>${t}</span></li>`).join('')}</ul>
    </div>
    <div class="login-foot">${company ? `Managed by ${esc(company)}` : '&nbsp;'}</div>
  </aside>`;
}

const RESIDENT_BRAND = {
  title: 'Your utility statements, all in one place.',
  text: 'Sign in to the tenant portal to see what you owe for water, sewer and other utilities, and why.',
  points: [
    ['doc', 'View and download every statement as a PDF'],
    ['chart', 'See exactly how your share was calculated'],
    ['user', 'Keep your phone number up to date'],
  ],
};
const STAFF_BRAND = {
  title: 'Utility billing for your properties.',
  text: 'Enter the utility bill, split it with your RUBS rules, then email statements and export to Rent Manager.',
  points: [
    ['building', 'Properties, units and tenants'],
    ['chart', 'Batch billing with prorated RUBS splits'],
    ['doc', 'PDF statements, email and Rent Manager export'],
  ],
};

function passwordField({ name = 'password', label = 'Password', autocomplete, minlength, help = '' }) {
  return `<div class="field"><label for="f_${name}">${label}</label>
    <div class="pw-wrap"><input id="f_${name}" name="${name}" type="password" required ${minlength ? `minlength="${minlength}"` : ''} autocomplete="${autocomplete}">
      <button type="button" class="pw-toggle" data-pw-toggle aria-label="Show password">Show</button></div>
    ${help ? `<div class="help">${help}</div>` : ''}</div>`;
}

function render(brand, body) {
  app.innerHTML = `<div class="login">${brandPanel(brand)}<main class="login-main"><div class="login-box">${body}</div></main></div>`;
  const box = app.querySelector('.login-box');
  box.querySelectorAll('[data-pw-toggle]').forEach((b) => b.addEventListener('click', () => {
    const input = b.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  }));
  if (altchaOn) loadAltcha().catch(() => {});
  box.querySelector('input')?.focus();
  return box;
}

function bindForm(box, handler, check) {
  const form = box.querySelector('form');
  const err = box.querySelector('.error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    let data = Object.fromEntries(new FormData(form));
    const problem = check?.(data);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const btn = form.querySelector('button[type=submit]');
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait…';
    const widget = form.querySelector('altcha-widget');
    try {
      if (widget && !data.altcha) {
        // The check normally finishes while the user types; if not, run it now.
        btn.textContent = 'Checking you\'re not a robot…';
        await loadAltcha();
        await widget.verify();
        data = Object.fromEntries(new FormData(form));
        if (!data.altcha) throw new Error('Please tick "I\'m not a robot" and try again.');
        btn.textContent = 'Please wait…';
      }
      await handler(data);
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false; btn.disabled = false; btn.textContent = label;
      // A solved check can only be used once: get a fresh one for the next try.
      if (widget && typeof widget.reset === 'function') widget.reset();
    }
  });
}

const passwordsMatch = (d) => (d.password !== d.password2 ? 'The two passwords do not match.' : null);

// ---------------------------------------------------------------- screens

function loginScreen(mode = 'resident') {
  if (mode === 'activate') return activateScreen();
  if (mode === 'forgot') return forgotScreen();
  const staff = mode === 'staff';
  const box = render(staff ? STAFF_BRAND : RESIDENT_BRAND, `
    <div class="segmented" role="tablist">
      <button type="button" role="tab" data-mode="resident" class="${staff ? '' : 'active'}" aria-selected="${!staff}">Tenant</button>
      <button type="button" role="tab" data-mode="staff" class="${staff ? 'active' : ''}" aria-selected="${staff}">Staff</button>
    </div>
    <h2>${staff ? 'Staff sign in' : 'Welcome back'}</h2>
    <p class="muted">${staff ? 'For property management staff.' : 'Sign in to see your utility statements.'}</p>
    <div class="error" hidden role="alert"></div>
    <form novalidate>
      <div class="field"><label for="f_email">Email</label><input id="f_email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      ${passwordField({ autocomplete: 'current-password' })}
      ${altchaWidget()}
      <button class="primary block" type="submit">Sign in</button>
    </form>
    ${staff
      ? '<p class="login-note">Need access? An administrator can add you in Settings → Staff accounts.</p>'
      : `<div class="login-cta"><span>First time here?</span> <button type="button" class="link" data-mode="activate">Activate your account →</button></div>
         <p class="login-note">Forgot your password? <button type="button" class="link inline" data-mode="forgot">Reset it by email</button></p>`}`);
  box.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    history.replaceState(null, '', b.dataset.mode === 'staff' ? '#staff' : location.pathname);
    loginScreen(b.dataset.mode);
  }));
  bindForm(box, async (d) => {
    await api('/auth/login', { method: 'POST', body: { email: d.email, password: d.password, type: staff ? 'admin' : 'resident', altcha: d.altcha } });
    boot();
  }, (d) => (!d.email || !d.password ? 'Enter your email and password.' : null));
}

function activateScreen() {
  const box = render(RESIDENT_BRAND, `
    <button type="button" class="link back" data-back>← Back to sign in</button>
    <h2>Activate your account</h2>
    <p class="muted">Set up your tenant portal login in one step. You'll need:</p>
    <ol class="steps-list">
      <li>Your <b>account number</b>, printed on your utility statement</li>
      <li>The <b>email address</b> the office has on file for you</li>
    </ol>
    <div class="error" hidden role="alert"></div>
    <form novalidate>
      <div class="field"><label for="f_account_number">Account number</label><input id="f_account_number" name="account_number" required autocomplete="off" placeholder="e.g. 33580"></div>
      <div class="field"><label for="f_email">Email on file</label><input id="f_email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      ${passwordField({ label: 'Choose a password', autocomplete: 'new-password', minlength: minPw, help: `At least ${minPw} characters.` })}
      ${passwordField({ name: 'password2', label: 'Confirm password', autocomplete: 'new-password', minlength: minPw })}
      ${altchaWidget()}
      <button class="primary block" type="submit">Activate my account</button>
    </form>
    <p class="login-note">Account number or email not recognized? Contact your leasing office to check the details they have on file.</p>`);
  box.querySelector('[data-back]').addEventListener('click', () => loginScreen('resident'));
  bindForm(box, async (d) => {
    await api('/auth/activate', { method: 'POST', body: { account_number: d.account_number, email: d.email, password: d.password, altcha: d.altcha } });
    toast('Your account is active. Welcome!');
    boot();
  }, (d) => {
    if (!d.account_number || !d.email) return 'Enter your account number and email.';
    if ((d.password || '').length < minPw) return `Your password must be at least ${minPw} characters.`;
    return passwordsMatch(d);
  });
}

// Tenant asks for a password reset link by email.
function forgotScreen() {
  const box = render(RESIDENT_BRAND, `
    <button type="button" class="link back" data-back>← Back to sign in</button>
    <h2>Reset your password</h2>
    <p class="muted">Enter the email address the office has on file for you. We'll email you a link to choose a new password.</p>
    <div class="error" hidden role="alert"></div>
    <div class="notice ok-notice" hidden data-sent role="status"></div>
    <form novalidate>
      <div class="field"><label for="f_email">Email on file</label><input id="f_email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></div>
      ${altchaWidget()}
      <button class="primary block" type="submit">Email me a reset link</button>
    </form>
    <p class="login-note">Never set up a portal account? Go back and choose <b>Activate your account</b>.</p>`);
  box.querySelector('[data-back]').addEventListener('click', () => loginScreen('resident'));
  bindForm(box, async (d) => {
    const r = await api('/auth/forgot', { method: 'POST', body: { email: d.email, altcha: d.altcha } });
    const sent = box.querySelector('[data-sent]');
    sent.textContent = r.message;
    sent.hidden = false;
    box.querySelector('form').hidden = true;
  }, (d) => (!d.email ? 'Enter your email address.' : null));
}

// Opened from the email link: choose a new password.
async function resetScreen(token) {
  const box = render(RESIDENT_BRAND, `
    <h2>Choose a new password</h2>
    <div class="error" hidden role="alert"></div>
    <form novalidate>
      ${passwordField({ label: 'New password', autocomplete: 'new-password', minlength: minPw, help: `At least ${minPw} characters.` })}
      ${passwordField({ name: 'password2', label: 'Confirm new password', autocomplete: 'new-password', minlength: minPw })}
      <button class="primary block" type="submit">Save new password</button>
    </form>
    <p class="login-note"><button type="button" class="link inline" data-forgot>Request a new link</button> · <button type="button" class="link inline" data-signin>Back to sign in</button></p>`);
  const leave = (mode) => { history.replaceState(null, '', location.pathname); loginScreen(mode); };
  box.querySelector('[data-forgot]').addEventListener('click', () => leave('forgot'));
  box.querySelector('[data-signin]').addEventListener('click', () => leave('resident'));
  try { await api('/auth/reset-check', { method: 'POST', body: { token } }); } catch (e) {
    const err = box.querySelector('.error');
    err.textContent = e.message; err.hidden = false;
    box.querySelector('form').hidden = true;
    return;
  }
  bindForm(box, async (d) => {
    await api('/auth/reset', { method: 'POST', body: { token, password: d.password } });
    history.replaceState(null, '', location.pathname);
    toast('Your password was changed. Welcome back!');
    boot();
  }, (d) => ((d.password || '').length < minPw ? `Your password must be at least ${minPw} characters.` : passwordsMatch(d)));
}

function setupScreen() {
  const box = render({
    title: 'Set up your billing workspace.',
    text: 'Create the first administrator account. You can add more staff and your company details afterwards in Settings.',
    points: STAFF_BRAND.points,
  }, `
    <h2>Create the admin account</h2>
    <p class="muted">This is a one-time step for the first staff user.</p>
    <div class="error" hidden role="alert"></div>
    <form novalidate>
      <div class="field"><label for="f_name">Your name</label><input id="f_name" name="name" autocomplete="name"></div>
      <div class="field"><label for="f_email">Email</label><input id="f_email" name="email" type="email" required autocomplete="email"></div>
      ${passwordField({ autocomplete: 'new-password', minlength: minPw, help: `At least ${minPw} characters.` })}
      ${passwordField({ name: 'password2', label: 'Confirm password', autocomplete: 'new-password', minlength: minPw })}
      ${altchaWidget()}
      <button class="primary block" type="submit">Create admin account</button>
    </form>`);
  bindForm(box, async (d) => {
    await api('/auth/setup', { method: 'POST', body: { name: d.name, email: d.email, password: d.password, altcha: d.altcha } });
    boot();
  }, (d) => {
    if (!d.email) return 'Enter your email.';
    if ((d.password || '').length < minPw) return `Your password must be at least ${minPw} characters.`;
    return passwordsMatch(d);
  });
}

boot();
