// Security settings: ALTCHA bot check on sign-in forms, failed sign-in lockouts, session lengths,
// password length and the sign-in activity log. Settings live in the `settings` table as sec_*;
// the ALTCHA signing keys are generated on first use and stored as secret_* (never sent to browsers).
import { HttpError } from './util.js';

export const SECURITY_DEFAULTS = {
  altcha_enabled: true,      // bot check on sign-in, activation and setup forms
  max_failed_logins: 5,      // failed tries per email (or account number) before a lockout
  lockout_minutes: 15,
  staff_session_hours: 12,   // staff are signed out after this long
  resident_session_days: 7,
  min_password_length: 8,
};
const RANGES = {
  max_failed_logins: [3, 20], lockout_minutes: [5, 1440], staff_session_hours: [1, 168],
  resident_session_days: [1, 90], min_password_length: [8, 64],
};
// One IP address may fail this many times the limit (across all emails) per lockout window.
export const IP_FAILURE_FACTOR = 4;
// One email may fail this many times the limit across ALL addresses. The normal limit is per email
// and address together, so a stranger guessing wrong can't lock a staff member or tenant out.
export const IDENTIFIER_FAILURE_FACTOR = 5;

export async function loadSecurity(db) {
  const rows = (await db.prepare("SELECT key, value FROM settings WHERE key LIKE 'sec\\_%' ESCAPE '\\'").all()).results;
  return parseSecurity(rows);
}

/** Security settings from settings rows ({key, value}); other keys are ignored. */
export function parseSecurity(rows) {
  const out = { ...SECURITY_DEFAULTS };
  for (const { key, value } of rows) {
    const k = key.slice(4);
    if (!key.startsWith('sec_') || !(k in SECURITY_DEFAULTS) || value === null) continue;
    out[k] = typeof SECURITY_DEFAULTS[k] === 'boolean' ? value === '1' : Number(value);
  }
  return out;
}

export async function saveSecurity(db, input) {
  const stmts = [];
  for (const [k, def] of Object.entries(SECURITY_DEFAULTS)) {
    if (!(k in input)) continue;
    let v;
    if (typeof def === 'boolean') v = input[k] === true || input[k] === 1 || input[k] === '1' || input[k] === 'on' ? '1' : '0';
    else {
      const n = Number(input[k]);
      const [min, max] = RANGES[k];
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${k.replace(/_/g, ' ')} must be a whole number from ${min} to ${max}`);
      v = String(n);
    }
    stmts.push(db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(`sec_${k}`, v));
  }
  if (stmts.length) await db.batch(stmts);
  return loadSecurity(db);
}

export function validatePassword(pw, minLength = SECURITY_DEFAULTS.min_password_length) {
  if (typeof pw !== 'string' || pw.length < minLength) throw new HttpError(400, `Password must be at least ${minLength} characters`);
  if (pw.length > 200) throw new HttpError(400, 'Password must be 200 characters or fewer');
}

export const clientIp = (request) =>
  (request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '').split(',')[0].trim().slice(0, 64) || null;

// ---------------------------------------------------------------- failed sign-in lockouts

const windowStart = (minutes) => new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);

/** Throws 429 when this email/account or this IP has failed too often recently. */
export async function checkLockout(db, sec, { identifier, ip }) {
  const since = windowStart(sec.lockout_minutes);
  const id = identifier || '';
  const lastOk = "COALESCE((SELECT MAX(created_at) FROM login_attempts WHERE identifier = ? AND success = 1), '')";
  const [pairR, idR, ipR] = await db.batch([
    // This email from this address (since its last successful sign-in).
    db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS first FROM login_attempts
      WHERE identifier = ? AND ip = ? AND success = 0 AND created_at > ? AND created_at > ${lastOk}`).bind(id, ip || '', since, id),
    // This email from anywhere.
    db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS first FROM login_attempts
      WHERE identifier = ? AND success = 0 AND created_at > ? AND created_at > ${lastOk}`).bind(id, since, id),
    // This address, any email.
    db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM login_attempts WHERE ip = ? AND success = 0 AND created_at > ?')
      .bind(ip || '', since),
  ]);
  const pair = pairR.results[0], all = idR.results[0], byIp = ipR.results[0];
  const max = sec.max_failed_logins;
  const hit = (identifier && ip && pair.n >= max) ? pair
    : (identifier && all.n >= max * (ip ? IDENTIFIER_FAILURE_FACTOR : 1)) ? all
    : (ip && byIp.n >= max * IP_FAILURE_FACTOR) ? byIp : null;
  if (!hit) return;
  const until = new Date(`${hit.first.replace(' ', 'T')}Z`).getTime() + sec.lockout_minutes * 60000;
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60000));
  throw new HttpError(429, `Too many failed sign-in attempts. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again, or contact the office.`);
}

export async function recordAttempt(db, request, { kind, identifier, success, reason = null }) {
  const stmts = [db.prepare('INSERT INTO login_attempts (kind, identifier, ip, success, reason, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(kind, identifier || null, clientIp(request), success ? 1 : 0, reason, (request.headers.get('User-Agent') || '').slice(0, 200) || null)];
  // Keep the log small: drop entries older than 90 days now and then.
  if (Math.random() < 0.05) stmts.push(db.prepare("DELETE FROM login_attempts WHERE created_at < datetime('now', '-90 days')"));
  await db.batch(stmts);
}

/** Recent sign-in activity for Settings → Security. */
export async function signInActivity(db, { limit = 100, failedOnly = false } = {}) {
  const rows = (await db.prepare(`SELECT id, kind, identifier, ip, success, reason, user_agent, created_at FROM login_attempts
    ${failedOnly ? 'WHERE success = 0' : ''} ORDER BY id DESC LIMIT ?`).bind(Math.min(500, limit)).all()).results;
  const sec = await loadSecurity(db);
  const since = windowStart(sec.lockout_minutes);
  // Locked out = an email from one address at the limit (the same rule checkLockout applies first).
  const locked = (await db.prepare(`SELECT identifier, ip, COUNT(*) AS n, MAX(created_at) AS last FROM login_attempts l
    WHERE success = 0 AND created_at > ? AND identifier IS NOT NULL
      AND created_at > COALESCE((SELECT MAX(created_at) FROM login_attempts s WHERE s.identifier = l.identifier AND s.success = 1), '')
    GROUP BY identifier, ip HAVING COUNT(*) >= ?`).bind(since, sec.max_failed_logins).all()).results;
  const stats = await db.prepare(`SELECT SUM(success = 0) AS failed, SUM(success = 1) AS ok FROM login_attempts WHERE created_at > datetime('now', '-1 day')`).first();
  return { rows, locked, last_24h: { failed: stats?.failed || 0, ok: stats?.ok || 0 } };
}

/** Lift lockouts: forget recent failed attempts (for one email/account, or everyone). */
export async function clearLockouts(db, identifier) {
  const sec = await loadSecurity(db);
  const since = windowStart(sec.lockout_minutes);
  const r = identifier
    ? await db.prepare('DELETE FROM login_attempts WHERE success = 0 AND identifier = ? AND created_at > ?').bind(identifier, since).run()
    : await db.prepare('DELETE FROM login_attempts WHERE success = 0 AND created_at > ?').bind(since).run();
  return { cleared: r.meta?.changes ?? 0 };
}

// ---------------------------------------------------------------- ALTCHA (proof-of-work bot check)
// Self-hosted, compatible with the ALTCHA v3 widget and altcha-lib v2: PBKDF2/SHA-256 challenge in
// "deterministic" mode, so checking an answer is one HMAC (cheap on the free plan's CPU limit).

const ALGORITHM = 'PBKDF2/SHA-256';
const COST = 1000;               // PBKDF2 iterations per guess
const COUNTER_MIN = 1000;        // the browser tries on average ~2,000 guesses (well under a second)
const COUNTER_MAX = 3000;
const CHALLENGE_MINUTES = 15;

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => {
  if (typeof hex !== 'string' || hex.length % 2 || !/^[0-9a-f]*$/i.test(hex)) throw new Error('bad hex');
  return Uint8Array.from(hex.match(/../g) || [], (h) => parseInt(h, 16));
};
const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.fromEntries(Object.keys(o).sort().flatMap((k) => (o[k] === undefined ? [] : [[k, sortKeys(o[k])]])))
  : o);
const sameText = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data));
}
async function deriveKey(nonce, salt, counter) {
  const password = new Uint8Array(nonce.length + 4);
  password.set(nonce, 0);
  new DataView(password.buffer).setUint32(nonce.length, counter, false);
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: COST, hash: 'SHA-256' }, key, 256));
}

/** The two ALTCHA signing keys: created once, kept in the settings table. */
async function altchaKeys(db) {
  const read = async () => (await db.prepare("SELECT key, value FROM settings WHERE key IN ('secret_altcha_hmac', 'secret_altcha_key_sig')").all()).results;
  let rows = await read();
  if (rows.length < 2) {
    const rnd = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret_altcha_hmac', ?)").bind(rnd()),
      db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret_altcha_key_sig', ?)").bind(rnd()),
    ]);
    rows = await read();
  }
  const get = (k) => rows.find((r) => r.key === k).value;
  return { hmac: get('secret_altcha_hmac'), keySig: get('secret_altcha_key_sig') };
}

export async function createAltchaChallenge(db) {
  const keys = await altchaKeys(db);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const span = COUNTER_MAX - COUNTER_MIN + 1;
  const counter = COUNTER_MIN + (crypto.getRandomValues(new Uint32Array(1))[0] % span);
  const derived = await deriveKey(nonce, salt, counter);
  const parameters = sortKeys({
    algorithm: ALGORITHM, cost: COST, keyLength: 32, nonce: toHex(nonce), salt: toHex(salt),
    // The browser must find a counter whose key starts with these bytes.
    keyPrefix: toHex(derived.slice(0, 16)),
    keySignature: await hmacHex(keys.keySig, derived),
    expiresAt: Math.floor(Date.now() / 1000) + CHALLENGE_MINUTES * 60,
  });
  return { parameters, signature: await hmacHex(keys.hmac, JSON.stringify(parameters)) };
}

/** Throws 400 unless `payload` (the widget's base64 "altcha" field) is a fresh, correctly solved challenge. */
export async function verifyAltcha(db, payload) {
  const fail = (msg = 'The "I\'m not a robot" check failed. Please tick it again and retry.') => { throw new HttpError(400, msg); };
  if (!payload || typeof payload !== 'string') fail('Please complete the "I\'m not a robot" check.');
  let data;
  try { data = JSON.parse(atob(payload)); } catch { fail(); }
  const ch = data?.challenge;
  const sol = data?.solution;
  if (!ch?.parameters || typeof ch.signature !== 'string' || !sol) fail();
  const p = ch.parameters;
  if (!p.expiresAt || p.expiresAt < Date.now() / 1000) fail('The "I\'m not a robot" check expired. Please tick it again.');
  const keys = await altchaKeys(db);
  if (!sameText(ch.signature, await hmacHex(keys.hmac, JSON.stringify(sortKeys(p))))) fail();
  if (p.algorithm !== ALGORITHM || typeof sol.derivedKey !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(sol.derivedKey)) fail();
  let derived;
  try { derived = fromHex(sol.derivedKey); } catch { fail(); }
  if (!p.keySignature || !sameText(p.keySignature, await hmacHex(keys.keySig, derived))) fail();
  // One use per solved challenge.
  const now = Math.floor(Date.now() / 1000);
  const r = await db.batch([
    db.prepare('DELETE FROM altcha_used WHERE expires_at < ?').bind(now),
    db.prepare('INSERT OR IGNORE INTO altcha_used (nonce, expires_at) VALUES (?, ?)').bind(String(p.nonce), Number(p.expiresAt)),
  ]);
  if (!r[1].meta?.changes) fail('That "I\'m not a robot" check was already used. Please tick it again.');
}
