// Staff activity log: one row for every change a staff member makes (anything that isn't a plain
// read under /api/admin), with a plain-language summary. Kept for a year.
import { readSessionToken, hashSessionToken } from './auth.js';
import { clientIp } from './security.js';

const NOUN = { tenants: 'tenant', units: 'unit', properties: 'property', utilities: 'utility / charge', runs: 'billing batch', admins: 'staff user' };

/** A readable name for an item, looked up in the database (before it's changed or deleted). */
async function labelFor(db, kind, id) {
  if (!id || !/^\d+$/.test(String(id))) return null;
  const q = {
    tenants: `SELECT TRIM(COALESCE(t.first_name,'') || ' ' || t.last_name) || ' (unit ' || u.unit_number || ', ' || COALESCE(p.rm_property_code, p.name) || ')' AS l
              FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id WHERE t.id = ?`,
    units: `SELECT 'Unit ' || u.unit_number || ' at ' || p.name AS l FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = ?`,
    properties: 'SELECT name AS l FROM properties WHERE id = ?',
    utilities: `SELECT pu.utility_name || ' at ' || p.name AS l FROM property_utilities pu JOIN properties p ON p.id = pu.property_id WHERE pu.id = ?`,
    runs: `SELECT p.name || ' ' || r.period_start || ' to ' || r.period_end AS l FROM billing_runs r JOIN properties p ON p.id = r.property_id WHERE r.id = ?`,
    statements: `SELECT TRIM(COALESCE(t.first_name,'') || ' ' || t.last_name) || ' (unit ' || u.unit_number || ')' AS l
                 FROM statements s JOIN tenants t ON t.id = s.tenant_id JOIN units u ON u.id = s.unit_id WHERE s.id = ?`,
    admins: 'SELECT COALESCE(name, email) AS l FROM admins WHERE id = ?',
    imports: "SELECT kind || ' import of ' || COALESCE(filename, 'a CSV file') AS l FROM import_batches WHERE id = ?",
  }[kind];
  if (!q) return null;
  try { return (await db.prepare(q).bind(id).first())?.l || null; } catch { return null; }
}

const nameFromBody = (kind, b) => {
  if (!b) return '';
  if (kind === 'tenants') return [b.first_name, b.last_name].filter(Boolean).join(' ');
  if (kind === 'units') return b.unit_number ? `Unit ${b.unit_number}` : '';
  if (kind === 'properties') return b.name || '';
  if (kind === 'utilities') return b.utility_name || '';
  if (kind === 'admins') return b.email || '';
  return '';
};

function describe({ method, seg, url, body, label, result }) {
  const [, name, id, action] = seg;
  const noun = NOUN[name] || name;
  const n = (v) => (Number.isFinite(v) ? v : '?');
  const what = label || (id ? `#${id}` : '');
  const ids = Array.isArray(body?.ids) ? body.ids.length : null;
  switch (name) {
    case 'export':
      return `Exported statements to Rent Manager${url.searchParams.get('run_id') ? ` (batch #${url.searchParams.get('run_id')})` : ''}${url.searchParams.get('reverse') === '1' ? ' as a REVERSAL file' : ''}`;
    case 'imports':
      return action === 'undo' ? `Undid ${label || `import #${id}`}` : `${method} imports`;
    case 'runs':
      if (method === 'POST' && !id) return `Created billing batch ${result?.property_name ? `for ${result.property_name} ` : ''}${result?.period_start ? `${result.period_start} to ${result.period_end}` : ''}`.trim();
      if (method === 'PUT') return `Edited billing batch ${what}`;
      if (method === 'DELETE') return `Deleted billing batch ${what}`;
      if (action === 'calculate') return `Calculated billing batch ${what}`;
      if (action === 'finalize') return `Finalized billing batch ${what}`;
      if (action === 'reopen') return `Reopened billing batch ${what}`;
      break;
    case 'statements':
      if (action === 'email') return `${result?.ok === false ? 'Tried to email' : 'Emailed'} statement to ${label || `#${id}`}${result?.email_to ? ` (${result.email_to})` : ''}`;
      break;
    case 'settings':
      if (id === 'test-email') return `Sent a test email to ${body?.to || '?'}`;
      return 'Changed company & email settings';
    case 'security':
      if (id === 'clear-lockouts') return body?.identifier ? `Unlocked sign-in for ${body.identifier}` : 'Cleared all sign-in lockouts';
      if (id === 'sign-out-all') return `Signed out ${body?.who === 'tenants' ? 'all tenants' : body?.who === 'staff' ? 'all other staff' : 'everyone else'}`;
      return 'Changed security settings';
    case 'system':
      if (id === 'plan') return `Set the Cloudflare plan to ${body?.plan === 'paid' ? 'Workers Paid' : 'Workers Free'}`;
      if (id === 'backup-log') return `Downloaded a full database backup (${body?.format === 'json' ? 'JSON' : 'SQL'}, ${body?.secrets ? 'WITH passwords' : 'without passwords'})`;
      break;
    case 'admins':
      if (method === 'POST') return `Added staff user ${body?.email || ''}`.trim();
      if (method === 'DELETE') return `Removed staff user ${what}`;
      if (action === 'password') return 'Changed own password';
      break;
    case 'tenants':
    case 'units':
      if (id === 'import') return `Imported ${n(result?.imported)} ${name} from CSV${result?.created != null ? ` (${result.created} new, ${result.updated} updated)` : ''}`;
      if (id === 'bulk-delete') return `Deleted ${n(result?.deleted ?? ids)} ${name} (bulk)${result?.skipped?.length ? `, ${result.skipped.length} skipped` : ''}`;
      if (id === 'bulk-update') return `Edited ${n(result?.updated ?? ids)} tenants (bulk)`;
      if (action === 'lock') return `Locked the portal account of ${what}`;
      if (action === 'unlock') return `Unlocked the portal account of ${what}`;
      if (action === 'reset-portal') return `Reset the portal login of ${what}`;
      if (action === 'view-as') return `Viewed the portal as ${what}`;
    // fall through
    case 'properties':
    case 'utilities':
      if (method === 'POST' && !id) return `Added ${noun} ${nameFromBody(name, body)}`.trim();
      if (method === 'PUT' && id) {
        const keys = body ? Object.keys(body) : [];
        if (name === 'properties' && keys.includes('active') && keys.length <= 3) return `${body.active ? 'Reactivated' : 'Marked inactive'} property ${what}`;
        if (name === 'tenants' && keys.length <= 2 && keys.includes('occupants')) return `Changed people to ${body.occupants} for ${what}`;
        if (name === 'tenants' && keys.includes('move_out') && keys.length <= 2) return `Moved out ${what} on ${body.move_out}`;
        return `Edited ${noun} ${what}`;
      }
      if (method === 'DELETE') return `Deleted ${noun} ${what}`;
      if (action === 'test') return null; // test calculations change nothing
      break;
    default:
  }
  return `${method} ${url.pathname.replace(/^\/api/, '')}`;
}

/** Called before the request is handled: who is doing it, and names of items about to change. */
export async function activityPrepare(db, request, seg, url) {
  const token = readSessionToken(request);
  if (!token) return null;
  // One query: the staff session and the staff member's name.
  const s = await db.prepare(`SELECT s.user_id, a.name, a.email FROM sessions s JOIN admins a ON a.id = s.user_id
      WHERE s.token = ? AND s.user_type = 'admin' AND s.expires_at > ?`).bind(await hashSessionToken(token), new Date().toISOString()).first();
  if (!s) return null;
  const admin = s;
  let body = null;
  if ((request.headers.get('Content-Type') || '').includes('application/json')) {
    try { body = await request.clone().json(); } catch { body = null; }
  }
  const [, name, id] = seg;
  const kind = name === 'imports' ? 'imports' : name;
  const label = await labelFor(db, kind, id);
  return { admin_id: s.user_id, admin_name: admin ? admin.name || admin.email : 'Staff', method: request.method, seg, url, body, label, ip: clientIp(request) };
}

/** Called after a successful change. */
export async function activityRecord(db, pre, response) {
  let result = null;
  if ((response.headers.get('Content-Type') || '').includes('application/json')) {
    try { result = await response.clone().json(); } catch { result = null; }
  }
  // A new item has no name yet before it's created; use the response.
  if (!pre.label && pre.method === 'POST' && result?.id && ['tenants', 'units', 'properties', 'utilities'].includes(pre.seg[1])) {
    pre.label = await labelFor(db, pre.seg[1], result.id);
  }
  // "Edited unit Unit 101B" -> "Edited unit 101B"
  const summary = describe({ ...pre, result })?.replace(/\bunit Unit /, 'unit ') ?? null;
  if (summary === null) return;
  const stmts = [db.prepare('INSERT INTO activity_log (admin_id, admin_name, method, path, summary, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(pre.admin_id, pre.admin_name, pre.method, pre.url.pathname + pre.url.search, String(summary).slice(0, 500), pre.ip)];
  if (Math.random() < 0.02) stmts.push(db.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', '-1 year')"));
  await db.batch(stmts);
}

export async function listActivity(db, url) {
  const q = url.searchParams;
  let sql = 'SELECT id, admin_id, admin_name, method, path, summary, ip, created_at FROM activity_log WHERE 1=1';
  const args = [];
  if (q.get('admin_id')) { sql += ' AND admin_id = ?'; args.push(Number(q.get('admin_id'))); }
  if (q.get('kind') === 'billing') sql += " AND (path LIKE '/api/admin/runs%' OR path LIKE '/api/admin/statements%' OR path LIKE '/api/admin/export%')";
  if (q.get('kind') === 'tenants') sql += " AND (path LIKE '/api/admin/tenants%' OR path LIKE '/api/admin/units%' OR path LIKE '/api/admin/imports%')";
  if (q.get('kind') === 'settings') sql += " AND (path LIKE '/api/admin/settings%' OR path LIKE '/api/admin/security%' OR path LIKE '/api/admin/system%' OR path LIKE '/api/admin/admins%')";
  sql += ' ORDER BY id DESC LIMIT 1000';
  return (await db.prepare(sql).bind(...args).all()).results;
}
