// Tiny dependency-free PDF writer: letter-size pages, Helvetica / Helvetica-Bold,
// filled rectangles, lines and text with measuring, wrapping and right-alignment.
// Coordinates are in points from the TOP-LEFT corner (612 x 792 page).

// Glyph widths (per 1000 units) for WinAnsi codes 32..255, from the standard AFM files.
const WIDTHS = {"Helvetica":[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,500,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500],"Helvetica-Bold":[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,556,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556]};
const FONTS = { regular: { key: 'F1', name: 'Helvetica' }, bold: { key: 'F2', name: 'Helvetica-Bold' } };

// Unicode -> WinAnsi (cp1252) for the characters outside Latin-1.
const CP1252 = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function toCodes(str) {
  const out = [];
  for (const ch of String(str ?? '')) {
    const u = ch.codePointAt(0);
    if (u === 9 || u === 10 || u === 13) out.push(32);
    else if ((u >= 32 && u <= 126) || (u >= 160 && u <= 255)) out.push(u);
    else if (CP1252[u]) out.push(CP1252[u]);
    else out.push(63); // '?'
  }
  return out;
}

export function textWidth(str, size, weight = 'regular') {
  const table = WIDTHS[FONTS[weight].name];
  return toCodes(str).reduce((s, c) => s + (table[c - 32] || 0), 0) * size / 1000;
}

/** Splits text into lines no wider than maxWidth (respects existing newlines). */
export function wrapText(str, size, maxWidth, weight = 'regular') {
  const lines = [];
  for (const para of String(str ?? '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + word : word;
      if (line && textWidth(test, size, weight) > maxWidth) { lines.push(line); line = word; }
      else line = test;
    }
    lines.push(line);
  }
  return lines;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
function rgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => num(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ');
}
function pdfString(str) {
  return '(' + toCodes(str).map((c) => {
    const ch = String.fromCharCode(c);
    return ch === '(' || ch === ')' || ch === '\\' ? '\\' + ch : ch;
  }).join('') + ')';
}

class Page {
  constructor(width, height) { this.w = width; this.h = height; this.ops = []; }
  rect(x, y, w, h, fill) {
    this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re f`);
    return this;
  }
  line(x1, y1, x2, y2, color = '#000000', width = 1) {
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
    return this;
  }
  /** y is the text baseline. align: left | right | center (x is the anchor). */
  text(str, x, y, { size = 10, weight = 'regular', color = '#000000', align = 'left' } = {}) {
    if (str === null || str === undefined || str === '') return this;
    let tx = x;
    if (align !== 'left') {
      const w = textWidth(str, size, weight);
      tx = align === 'right' ? x - w : x - w / 2;
    }
    this.ops.push(`BT /${FONTS[weight].key} ${num(size)} Tf ${rgb(color)} rg ${num(tx)} ${num(this.h - y)} Td ${pdfString(str)} Tj ET`);
    return this;
  }
  /** Draws wrapped text; returns the y of the last baseline. */
  paragraph(str, x, y, maxWidth, { size = 10, leading = size * 1.35, ...opts } = {}) {
    const lines = wrapText(str, size, maxWidth, opts.weight);
    lines.forEach((l, i) => this.text(l, x, y + i * leading, { size, ...opts }));
    return y + (lines.length - 1) * leading;
  }
}

export class PdfDocument {
  constructor({ title = '' } = {}) { this.pages = []; this.title = title; }
  addPage(width = 612, height = 792) { const p = new Page(width, height); this.pages.push(p); return p; }

  toBytes() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const p of this.pages) {
      const content = p.ops.join('\n');
      const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${c} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Producer (RUBS Utility Billing) /Title ${pdfString(this.title)} >>`);

    // All content is single-byte (WinAnsi), so string length == byte length.
    let out = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
    const offsets = [];
    objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}
