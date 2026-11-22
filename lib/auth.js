// Password hashing (PBKDF2 via WebCrypto) and cookie sessions stored in D1.

// Cloudflare's free plan limits CPU time per request, so the iteration count is
// moderate. The count is stored in each hash, so it can be raised later.
const ITERATIONS = 20000;
// Workers caps PBKDF2 at 100,000 iterations. Used once the account is on the Workers Paid plan
// (more CPU time per request); older hashes are upgraded the next time that person signs in.
export const PAID_ITERATIONS = 100000;
export const hashIterations = (plan) => (plan === 'paid' ? PAID_ITERATIONS : ITERATIONS);
export const storedIterations = (stored) => Number(String(stored || '').split('$')[1]) || 0;
const SESSION_DAYS = 7;
const enc = new TextEncoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password, iterations = ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, iterations);
  return `pbkdf2$${iterations}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const bits = new Uint8Array(await derive(password, fromB64(saltB64), Number(iter)));
  const expected = fromB64(hashB64);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i];
  return diff === 0;
}

/**
 * opts.impersonatedBy / opts.returnToken: a staff member viewing the portal as a tenant.
 * opts.hours: shorter lifetime (used for those preview sessions).
 */
export async function createSession(db, userType, userId, opts = {}) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ms = opts.hours ? opts.hours * 3600000 : SESSION_DAYS * 86400000;
  const expires = new Date(Date.now() + ms).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()),
    db.prepare('INSERT INTO sessions (token, user_type, user_id, expires_at, impersonated_by, return_token) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(token, userType, userId, expires, opts.impersonatedBy ?? null, opts.returnToken ?? null),
  ]);
  return token;
}

export function sessionCookie(token, maxAgeSeconds = SESSION_DAYS * 86400) {
  return `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function readSessionToken(request) {
  const cookie = request.headers.get('Cookie') || '';
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(cookie);
  return m ? m[1] : null;
}

export async function getSession(db, request) {
  const token = readSessionToken(request);
  if (!token) return null;
  const s = await db.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?')
    .bind(token, new Date().toISOString()).first();
  return s || null;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
