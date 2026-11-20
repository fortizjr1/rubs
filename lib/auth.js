// Password hashing (PBKDF2 via WebCrypto) and cookie sessions stored in D1.

// Cloudflare's free plan limits CPU time per request, so the iteration count is
// moderate. The count is stored in each hash, so it can be raised later.
const ITERATIONS = 20000;
const SESSION_DAYS = 7;
const enc = new TextEncoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
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

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
}

export async function createSession(db, userType, userId) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()),
    db.prepare('INSERT INTO sessions (token, user_type, user_id, expires_at) VALUES (?, ?, ?, ?)').bind(token, userType, userId, expires),
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
