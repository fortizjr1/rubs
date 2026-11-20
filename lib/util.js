// Shared server helpers: responses, input parsing and validation.
import { HttpError } from './auth.js';

export { HttpError };

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });

export async function body(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) {
    throw new HttpError(415, 'Expected JSON body');
  }
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export const today = () => new Date().toISOString().slice(0, 10);
export const blank = (v) => v === undefined || v === null || String(v).trim() === '';

export function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

// Accepts YYYY-MM-DD, M/D/YYYY, M/D/YY.
export function normalizeDate(v) {
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  let y, mo, d;
  if (m) { [y, mo, d] = [+m[1], +m[2], +m[3]]; }
  else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s))) {
    [mo, d, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// Field types used to validate and clean user input.
export function coerce(type, value, label) {
  if (blank(value)) return null;
  switch (type) {
    case 'text': return String(value).trim().slice(0, 4000);
    case 'email': {
      const s = String(value).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, `${label}: invalid email "${s}"`);
      return s;
    }
    case 'date': {
      const s = normalizeDate(value);
      if (!s) throw new HttpError(400, `${label}: invalid date "${value}" (use YYYY-MM-DD or MM/DD/YYYY)`);
      return s;
    }
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new HttpError(400, `${label}: must be a number`);
      return Math.round(n);
    }
    case 'num': {
      const n = Number(String(value).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw new HttpError(400, `${label}: must be a number`);
      return n;
    }
    case 'bool': return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
    default:
      if (Array.isArray(type)) {
        if (!type.includes(value)) throw new HttpError(400, `${label}: must be one of ${type.join(', ')}`);
        return value;
      }
      throw new Error('Unknown field type ' + type);
  }
}
