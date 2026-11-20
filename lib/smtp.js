// Minimal SMTP client for Cloudflare Workers / Pages Functions (TCP sockets).
// Supports implicit TLS (port 465), STARTTLS (port 587 / 2525) and AUTH PLAIN / LOGIN.
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(str) {
  const bytes = typeof str === 'string' ? enc.encode(str) : str;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const cleanAddr = (s) => String(s || '').replace(/[\r\n<>]/g, '').trim();
const address = (email, name) => (name ? `${encodeHeader(String(name).replace(/[\r\n"]/g, ''))} <${cleanAddr(email)}>` : `<${cleanAddr(email)}>`);

export function buildMessage({ from, fromName, to, toName, replyTo, subject, text, html, attachments = [], domain = 'localhost' }) {
  const mixed = 'mixed_' + crypto.randomUUID();
  const alt = 'alt_' + crypto.randomUUID();
  const headers = [
    `From: ${address(from, fromName)}`,
    `To: ${address(to, toName)}`,
    replyTo ? `Reply-To: ${address(replyTo)}` : null,
    `Subject: ${encodeHeader(String(subject).replace(/[\r\n]/g, ' '))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ].filter(Boolean);
  const parts = [
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || '')),
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html || '')),
    `--${alt}--`, '',
  ];
  for (const a of attachments) {
    const name = String(a.filename).replace(/[\r\n"]/g, '');
    parts.push(`--${mixed}`, `Content-Type: ${a.contentType}; name="${name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`, '', wrap76(b64(a.content)));
  }
  parts.push(`--${mixed}--`, '');
  return headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
}

class Conn {
  constructor(socket) { this.attach(socket); }
  attach(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = '';
  }
  async readLine() {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) { const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); return line; }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('SMTP server closed the connection');
      this.buf += dec.decode(value, { stream: true });
    }
  }
  async reply() {
    const lines = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
    }
  }
  async cmd(line, expect, label = line) {
    this.step = label.split(' ')[0];
    if (line !== null) await this.writer.write(enc.encode(line + '\r\n'));
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new Error(`SMTP ${label.split(' ')[0]} failed: ${r.text}`);
    return r;
  }
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`SMTP timed out ${what()}`)), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * cfg: {host, port, security: 'ssl'|'starttls'|'none', username, password}
 * msg: {from, fromName, to, toName, replyTo, bcc, subject, text, html, attachments}
 */
export async function sendMail(cfg, msg) {
  const port = Number(cfg.port) || (cfg.security === 'ssl' ? 465 : 587);
  const secureTransport = cfg.security === 'ssl' ? 'on' : cfg.security === 'starttls' ? 'starttls' : 'off';
  const socket = connect({ hostname: cfg.host, port }, { secureTransport, allowHalfOpen: false });
  const c = new Conn(socket);
  const domain = cleanAddr(msg.from).split('@')[1] || 'localhost';
  const run = async () => {
    await c.cmd(null, [220], 'greeting');
    let ehlo = await c.cmd(`EHLO ${domain}`, [250]);
    if (secureTransport === 'starttls') {
      await c.cmd('STARTTLS', [220]);
      c.reader.releaseLock(); c.writer.releaseLock();
      c.attach(socket.startTls());
      ehlo = await c.cmd(`EHLO ${domain}`, [250]);
    }
    if (cfg.username) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text) || !/AUTH[ =][^\n]*LOGIN/i.test(ehlo.text)) {
        await c.cmd(`AUTH PLAIN ${b64(`\0${cfg.username}\0${cfg.password || ''}`)}`, [235], 'AUTH (check username/password)');
      } else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(b64(cfg.username), [334], 'AUTH username');
        await c.cmd(b64(cfg.password || ''), [235], 'AUTH (check username/password)');
      }
    }
    await c.cmd(`MAIL FROM:<${cleanAddr(msg.from)}>`, [250]);
    const recipients = [msg.to, ...(msg.bcc ? String(msg.bcc).split(/[,;\s]+/).filter(Boolean) : [])];
    for (const r of recipients) await c.cmd(`RCPT TO:<${cleanAddr(r)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const body = buildMessage({ ...msg, domain }).replace(/\r\n\./g, '\r\n..'); // dot-stuffing
    await c.writer.write(enc.encode(body + '\r\n.\r\n'));
    const done = await c.cmd(null, [250], 'message');
    await c.writer.write(enc.encode('QUIT\r\n')).catch(() => {});
    return { ok: true, response: done.text };
  };
  try {
    return await withTimeout(run(), 25000, () => (c.step === 'greeting' || !c.step
      ? '- no answer from the server. Check the host, port and security setting (465 = SSL, 587 = STARTTLS).'
      : `waiting for the server after ${c.step}.${/AUTH/.test(c.step) ? ' Check the username and password.' : ''}`));
  } finally {
    try { await socket.close(); } catch { /* already closed */ }
  }
}
