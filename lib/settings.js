// App settings (company + SMTP + email templates) stored in the D1 `settings` table.
import { HttpError, coerce } from './util.js';
import { sendMail } from './smtp.js';

export const DEFAULT_SETTINGS = {
  company_name: '',
  smtp_host: 'smtp.maileroo.com',
  smtp_port: '465',
  smtp_security: 'ssl',
  smtp_username: '',
  from_email: '',
  from_name: '',
  reply_to: '',
  bcc: '',
  email_subject: 'Utility statement for {property}, Unit {unit} - {amount} due {due_date}',
  email_body: [
    'Hi {first_name},',
    '',
    'Your utility statement for {property}, Unit {unit} is attached.',
    '',
    'Service period: {period}',
    'Amount due: {amount}',
    'Due date: {due_date}',
    '',
    'This charge has been posted to your resident account. Please pay it with your rent.',
    '',
    'Questions? Call the office at {phone} or email {email}.',
    '',
    'Thank you,',
    '{property}',
  ].join('\n'),
};

const FIELDS = {
  company_name: 'text', smtp_host: 'text', smtp_port: 'int', smtp_security: ['ssl', 'starttls', 'none'],
  smtp_username: 'text', smtp_password: 'text', from_email: 'email', from_name: 'text', reply_to: 'email',
  bcc: 'text', email_subject: 'text', email_body: 'text',
};
const SECRET = new Set(['smtp_password']);

export async function loadSettings(db, { includeSecrets = false } = {}) {
  const rows = (await db.prepare('SELECT key, value FROM settings').all()).results;
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.value !== null) out[r.key] = r.value;
  out.smtp_password_set = Boolean(out.smtp_password);
  if (!includeSecrets) delete out.smtp_password;
  return out;
}

export async function saveSettings(db, input) {
  const stmts = [];
  for (const [key, type] of Object.entries(FIELDS)) {
    if (!(key in input)) continue;
    // A blank password field means "keep the saved one".
    if (SECRET.has(key) && (input[key] === null || input[key] === '')) continue;
    const v = SECRET.has(key) ? String(input[key]) : coerce(type, input[key], key);
    stmts.push(db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind(key, v === null ? null : String(v)));
  }
  if (input.clear_smtp_password) stmts.push(db.prepare("DELETE FROM settings WHERE key = 'smtp_password'"));
  if (stmts.length) await db.batch(stmts);
  return loadSettings(db);
}

export function smtpConfig(s) {
  if (!s.smtp_host || !s.from_email) {
    throw new HttpError(400, 'Email is not set up yet. Go to Settings → Email (SMTP) and enter the server details and From address.');
  }
  return { host: s.smtp_host, port: s.smtp_port, security: s.smtp_security, username: s.smtp_username, password: s.smtp_password };
}

export async function sendTestEmail(db, to) {
  const s = await loadSettings(db, { includeSecrets: true });
  const toAddr = coerce('email', to, 'Send test to');
  if (!toAddr) throw new HttpError(400, 'Enter an email address to send the test to');
  try {
    await sendMail(smtpConfig(s), {
      from: s.from_email, fromName: s.from_name, to: toAddr, replyTo: s.reply_to || undefined,
      subject: 'Test email from Utility Billing',
      text: 'Your SMTP settings work. Resident statements can now be emailed.',
      html: '<p>Your SMTP settings work. Resident statements can now be emailed.</p>',
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Could not send: ${e.message}`);
  }
  return { ok: true };
}
