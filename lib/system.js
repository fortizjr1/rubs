// Settings → System: storage use, record counts, what the app runs on, and full backups.
import { HttpError } from './util.js';

// Every table with app data, in an order that works for restoring (parents before children).
// Login sessions are left out: they expire and are useless in a backup.
export const BACKUP_TABLES = [
  'settings', 'admins', 'properties', 'import_batches', 'units', 'tenants', 'property_utilities',
  'billing_runs', 'bills', 'statements', 'charges', 'login_attempts',
];
const LABELS = {
  settings: 'Settings', admins: 'Staff accounts', properties: 'Properties', import_batches: 'CSV imports',
  units: 'Units', tenants: 'Tenants', property_utilities: 'Utilities & fixed charges', billing_runs: 'Billing batches',
  bills: 'Utility bills entered', statements: 'Resident statements', charges: 'Statement charge details',
  login_attempts: 'Sign-in log',
};
// Secrets are left out of backups unless staff ask for them. Staff accounts can't exist without a
// password, so without secrets they're skipped: after a restore the first-time setup screen
// creates a new staff login. Residents simply activate their portal account again.
const SECRET_COLUMNS = { tenants: ['password_hash'] };
const SKIP_WITHOUT_SECRETS = ['admins'];
const SECRET_SETTINGS = ['smtp_password'];

// Cloudflare free plan limits (https://developers.cloudflare.com/d1/platform/limits/).
export const LIMITS = { db_bytes: 500 * 1024 * 1024, account_bytes: 5 * 1024 * 1024 * 1024, rows_written_per_day: 100000, rows_read_per_day: 5000000 };

const STACK = [
  ['Hosting', 'Cloudflare Pages (static files on Cloudflare\'s global network)'],
  ['Server code', 'Cloudflare Pages Functions (JavaScript on the Workers runtime)'],
  ['Database', 'Cloudflare D1 (SQLite), database "rubs-billing-db"'],
  ['Front end', 'Plain JavaScript modules and CSS, no framework or build step'],
  ['PDF statements', 'Built-in PDF writer (no outside service)'],
  ['Email', 'Your SMTP server (Maileroo), sent directly from the server code'],
  ['Source code', 'GitHub: fortizjr1/rubs (each push to main deploys automatically)'],
  ['Sign-in', 'Passwords hashed with PBKDF2-SHA256; sessions in the database (HttpOnly cookie)'],
];

export async function systemInfo(db, request) {
  const started = Date.now();
  const stmts = BACKUP_TABLES.map((t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`));
  stmts.push(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > datetime('now')"));
  stmts.push(db.prepare('SELECT name, applied_at FROM d1_migrations ORDER BY id DESC LIMIT 1'));
  stmts.push(db.prepare("SELECT COUNT(*) AS n FROM d1_migrations"));
  stmts.push(db.prepare("SELECT COUNT(*) AS n FROM statements WHERE emailed_at >= date('now', 'start of month')"));
  const res = await db.batch(stmts);
  const ms = Date.now() - started;
  const n = BACKUP_TABLES.length;
  const meta = res[0].meta || {};
  let size = Number(meta.size_after) || null;
  if (!size) {
    // Local development: D1's size isn't reported, so ask SQLite.
    try {
      const pc = await db.prepare('PRAGMA page_count').first();
      const ps = await db.prepare('PRAGMA page_size').first();
      size = Number(Object.values(pc || {})[0]) * Number(Object.values(ps || {})[0]) || null;
    } catch { size = null; }
  }
  const cf = request.cf || {};
  const migration = res[n + 1].results[0] || {};
  return {
    database: {
      size_bytes: size, limit_bytes: LIMITS.db_bytes, account_limit_bytes: LIMITS.account_bytes,
      rows_written_per_day: LIMITS.rows_written_per_day, rows_read_per_day: LIMITS.rows_read_per_day,
      tables: BACKUP_TABLES.map((t, i) => ({ table: t, label: LABELS[t], rows: res[i].results[0].n })),
      total_rows: BACKUP_TABLES.reduce((s, t, i) => s + res[i].results[0].n, 0),
      schema_version: migration.name || null, schema_updated_at: migration.applied_at || null,
      migrations: res[n + 2].results[0].n,
      served_by: [meta.served_by_region, meta.served_by_colo].filter(Boolean).join(' / ') || meta.served_by || null,
      query_ms: ms,
    },
    server: {
      runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'Cloudflare Workers',
      data_center: cf.colo || null,
      location: [cf.city, cf.region, cf.country].filter(Boolean).join(', ') || null,
      http: cf.httpProtocol || null, tls: cf.tlsVersion || null,
      host: new URL(request.url).host,
      time: new Date().toISOString(),
      active_sessions: res[n].results[0].n,
      emails_this_month: res[n + 3].results[0].n,
    },
    stack: STACK,
    backup_tables: BACKUP_TABLES,
  };
}

/** One page of one table for the backup download. The browser asks page by page and builds the file. */
export async function backupPage(db, { table, offset = 0, secrets = false }) {
  if (!BACKUP_TABLES.includes(table)) throw new HttpError(400, 'Unknown table');
  const limit = 500;
  const start = Math.max(0, Number(offset) || 0);
  const rows = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).bind(limit + 1, start).all()).results;
  const more = rows.length > limit;
  let page = rows.slice(0, limit);
  if (!secrets && SKIP_WITHOUT_SECRETS.includes(table)) return { table, rows: [], next: null };
  if (!secrets) {
    const cols = SECRET_COLUMNS[table] || [];
    page = page
      .filter((r) => table !== 'settings' || (!SECRET_SETTINGS.includes(r.key) && !r.key.startsWith('secret_')))
      .map((r) => { const c = { ...r }; for (const k of cols) if (c[k] != null) c[k] = null; return c; });
  }
  return { table, rows: page, next: more ? start + limit : null };
}
