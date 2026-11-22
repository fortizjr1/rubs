// Tenant "Forgot password": a single-use link, emailed, valid for an hour. Only a SHA-256 hash of
// the token is stored, so a copy of the database can't be used to reset anyone's password.
import { HttpError } from './util.js';
import { loadSettings, smtpConfig } from './settings.js';
import { sendMail } from './smtp.js';

const MINUTES = 60;
const MAX_EMAILS_PER_HOUR = 3; // per email address, so the form can't be used to flood someone's inbox
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hashToken = async (token) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(String(token))));

const escHtml = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function emailBody({ name, property, link, company, activate }) {
  const intro = activate
    ? `Someone asked to reset the tenant portal password for this email address, but the account hasn't been set up yet. To start using the portal, open the sign-in page and choose "First time here? Activate your account". You'll need the account number printed on your utility statement.`
    : `We received a request to reset your tenant portal password${property ? ` for ${property}` : ''}. Use the link below to choose a new password. The link works once and expires in ${MINUTES} minutes.`;
  const text = [`Hi ${name},`, '', intro, '', activate ? link : `Reset your password: ${link}`, '',
    "If you didn't ask for this, you can ignore this email. Your password won't change.", '', company || property || ''].join('\n');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2328;max-width:560px">
    <div style="background:#0c4a6e;color:#fff;padding:16px 20px;border-bottom:4px solid #f59e0b">
      <div style="font-size:18px;font-weight:bold">${escHtml(property || company || 'Tenant portal')}</div>
      <div style="font-size:12px">Tenant portal</div></div>
    <div style="padding:16px 4px"><p>Hi ${escHtml(name)},</p><p>${escHtml(intro)}</p>
      <p style="margin:20px 0"><a href="${escHtml(link)}" style="display:inline-block;background:#1f5eff;color:#fff;font-weight:bold;text-decoration:none;padding:11px 22px;border-radius:6px">${activate ? 'Open the tenant portal' : 'Choose a new password'}</a></p>
      <p style="font-size:12px;color:#6b7280">Or copy this link: ${escHtml(link)}</p>
      <p style="font-size:12px;color:#6b7280">If you didn't ask for this, you can ignore this email. Your password won't change.</p></div></div>`;
  return { text, html };
}

/**
 * Sends a reset link if the email belongs to a tenant with a portal account (or an activation hint if
 * they haven't set one up). Never says which happened, so the form can't be used to find out who lives where.
 */
export async function requestReset(db, email, origin) {
  const t = await db.prepare(`SELECT t.id, t.first_name, t.last_name, t.email, t.password_hash, t.locked_at, p.name AS property_name
      FROM tenants t JOIN units u ON u.id = t.unit_id JOIN properties p ON p.id = u.property_id
      WHERE t.email = ? COLLATE NOCASE ORDER BY (t.password_hash IS NOT NULL) DESC, t.move_in DESC LIMIT 1`).bind(email).first();
  if (!t || t.locked_at) return { sent: false };
  const recent = await db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE kind = 'reset' AND identifier = ? AND success = 1
      AND reason = 'reset email sent' AND created_at > datetime('now', '-1 hour')`).bind(`reset ${String(email).toLowerCase()}`).first();
  if ((recent?.n || 0) >= MAX_EMAILS_PER_HOUR) return { sent: false, limited: true };
  const settings = await loadSettings(db, { includeSecrets: true });
  let cfg;
  try { cfg = smtpConfig(settings); } catch { throw new HttpError(503, "Password reset emails aren't set up yet. Please contact the office."); }
  const name = t.first_name || t.last_name;
  let link = `${origin}/`;
  const activate = !t.password_hash;
  if (!activate) {
    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + MINUTES * 60000).toISOString();
    await db.batch([
      // Older unused links for this tenant stop working; expired rows are cleaned up.
      db.prepare("DELETE FROM password_resets WHERE tenant_id = ? OR expires_at < ? OR used_at IS NOT NULL").bind(t.id, new Date().toISOString()),
      db.prepare('INSERT INTO password_resets (token_hash, tenant_id, expires_at) VALUES (?, ?, ?)').bind(await hashToken(token), t.id, expires),
    ]);
    link = `${origin}/#reset=${token}`;
  }
  const { text, html } = emailBody({ name, property: t.property_name, link, company: settings.company_name, activate });
  await sendMail(cfg, {
    from: settings.from_email, fromName: settings.from_name || t.property_name,
    to: t.email, toName: [t.first_name, t.last_name].filter(Boolean).join(' '),
    replyTo: settings.reply_to || undefined,
    subject: activate ? 'Set up your tenant portal account' : 'Reset your tenant portal password', text, html,
  });
  return { sent: true };
}

/** Checks a reset token; returns the tenant id or throws. Does not use it up. */
export async function checkResetToken(db, token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) throw new HttpError(400, 'This reset link is not valid. Please request a new one.');
  const r = await db.prepare('SELECT tenant_id, expires_at, used_at FROM password_resets WHERE token_hash = ?').bind(await hashToken(token)).first();
  if (!r || r.used_at) throw new HttpError(400, 'This reset link has already been used or is not valid. Please request a new one.');
  if (r.expires_at < new Date().toISOString()) throw new HttpError(400, 'This reset link has expired. Please request a new one.');
  return r.tenant_id;
}
