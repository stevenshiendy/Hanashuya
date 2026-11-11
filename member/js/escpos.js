// Dependency-free ESC/POS builder for 58 mm (384 dot) and 80 mm (576 dot) thermal printers.
// Runs in browsers and Node. Output is a Uint8Array to send to the printer.

const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

// CP437 high half, 0x80..0xAF (letters and signs we can map to safely).
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»';
const CP437_MAP = new Map([...CP437_HIGH].map((c, i) => [c, 0x80 + i]));

// Characters with no CP437 slot, replaced by plain ASCII.
const TRANSLIT = {
  '‘': "'", '’': "'", '‚': ',', '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-', '‐': '-', '‑': '-',
  '…': '...', ' ': ' ', ' ': ' ', ' ': ' ', '​': '',
  '×': 'x', '•': '*', '·': '.', '→': '->', '©': '(c)',
  '®': '(R)', '™': '(TM)', '°': 'o', '\t': ' ',
};

// Returns a string in which every char is a single printable CP437 byte (ASCII or mapped).
export function clean(str) {
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (ch === '\n') out += '\n';
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (CP437_MAP.has(ch)) out += ch;
    else {
      // Strip accents (NFD) and keep the ASCII base letter; anything else becomes '?'.
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      out += /^[\x20-\x7e]+$/.test(base) ? base : '?';
    }
  }
  return out;
}

export function encode(str) {
  const s = clean(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    out[i] = CP437_MAP.has(ch) ? CP437_MAP.get(ch) : ch === '\n' ? LF : ch.charCodeAt(0);
  }
  return out;
}

// Break text into lines of at most `width` chars, at spaces where possible.
export function wrap(str, width) {
  const lines = [];
  for (const para of clean(str).split('\n')) {
    let line = '';
    for (let word of para.split(' ')) {
      while (word.length > width) {
        if (line) { lines.push(line); line = ''; }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

// RGBA -> array of 0/1 (1 = black ink). Transparent pixels count as white.
export function toBits(img, { dither = true, threshold = 128 } = {}) {
  const { width: w, height: h, data } = img;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    const y = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    lum[i] = y * a + 255 * (1 - a);
  }
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const old = lum[i];
      const nu = old < threshold ? 0 : 255;
      bits[i] = nu === 0 ? 1 : 0;
      if (!dither) continue;
      const err = old - nu;
      if (x + 1 < w) lum[i + 1] += err * 7 / 16;
      if (y + 1 < h) {
        if (x > 0) lum[i + w - 1] += err * 3 / 16;
        lum[i + w] += err * 5 / 16;
        if (x + 1 < w) lum[i + w + 1] += err * 1 / 16;
      }
    }
  }
  return bits;
}

const BAND_ROWS = 128; // rows per GS v 0 command, keeps each command small for cheap printers

export class Receipt {
  constructor({ dots = 384 } = {}) {
    if (dots !== 384 && dots !== 576) throw new Error('dots must be 384 (58 mm) or 576 (80 mm)');
    this.dots = dots;
    this.cols = dots / 12; // Font A is 12 dots wide
    this.buf = [];
    this.ops = []; // semantic log, used by the preview
    this.sw = 1;
    this.sh = 1;
    this._bold = false;
    this._align = 'left';
  }

  _push(...b) { for (const x of b) this.buf.push(x); return this; }
  _op(op) { this.ops.push({ align: this._align, bold: this._bold, sw: this.sw, sh: this.sh, ...op }); }
  get width() { return Math.floor(this.cols / this.sw); } // chars per line at the current size

  init() {
    this.sw = this.sh = 1; this._bold = false; this._align = 'left';
    this._op({ type: 'init' });
    return this._push(ESC, 0x40, ESC, 0x74, 0x00); // reset, code page CP437
  }
  align(a) {
    const n = { left: 0, center: 1, right: 2 }[a];
    if (n === undefined) throw new Error('align: left, center or right');
    this._align = a;
    return this._push(ESC, 0x61, n);
  }
  bold(on = true) { this._bold = !!on; return this._push(ESC, 0x45, on ? 1 : 0); }
  size(w = 1, h = w) {
    if (!(w >= 1 && w <= 8 && h >= 1 && h <= 8)) throw new Error('size 1..8');
    this.sw = w; this.sh = h;
    return this._push(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }
  _lines(lines) {
    for (const l of lines) {
      this._op({ type: 'text', text: l });
      for (const b of encode(l)) this.buf.push(b);
      this.buf.push(LF);
    }
    return this;
  }
  text(str) { return this._lines(wrap(str, this.width)); }
  line(n = 1) { this._op({ type: 'feed', n }); return this._push(ESC, 0x64, n); }
  rule(ch = '-') { return this._lines([ch.repeat(this.width)]); }

  // Left text and right text on one line; left wraps onto extra lines if it is too long.
  row(left, right) {
    const r = clean(right).replace(/\n/g, ' ');
    const room = Math.max(1, this.width - r.length - 1);
    const parts = wrap(left, room);
    const last = parts.pop();
    const out = parts.slice();
    out.push(last + ' '.repeat(Math.max(1, this.width - last.length - r.length)) + r);
    return this._lines(out.map((l) => l.slice(0, this.width)));
  }

  // img: {width, height, data: RGBA}. ImageData from a canvas works as is.
  image(img, opts = {}) {
    const { width: w, height: h } = img;
    if (w > this.dots) throw new Error(`image is ${w} dots wide, paper holds ${this.dots}`);
    const bits = toBits(img, opts);
    const wb = Math.ceil(w / 8); // width padded to whole bytes, padding is white
    for (let y0 = 0; y0 < h; y0 += BAND_ROWS) {
      const rows = Math.min(BAND_ROWS, h - y0);
      this._push(GS, 0x76, 0x30, 0x00, wb & 0xff, wb >> 8, rows & 0xff, rows >> 8);
      for (let y = y0; y < y0 + rows; y++) {
        for (let xb = 0; xb < wb; xb++) {
          let v = 0;
          for (let k = 0; k < 8; k++) {
            const x = xb * 8 + k;
            v = (v << 1) | (x < w ? bits[y * w + x] : 0);
          }
          this.buf.push(v);
        }
      }
    }
    this._op({ type: 'image', width: w, height: h, bits, wb });
    return this;
  }

  // Native QR. size = module size in dots (1..16). ecc: 'L' | 'M' | 'Q' | 'H'.
  qr(text, { size = 6, ecc = 'M' } = {}) {
    const data = new TextEncoder().encode(text);
    if (data.length === 0 || data.length > 700) throw new Error('qr: 1..700 bytes');
    if (!(size >= 1 && size <= 16)) throw new Error('qr size 1..16');
    const e = { L: 48, M: 49, Q: 50, H: 51 }[ecc];
    const n = data.length + 3;
    this._push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
    this._push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size);
    this._push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, e);
    this._push(GS, 0x28, 0x6b, n & 0xff, n >> 8, 0x31, 0x50, 0x30, ...data);
    this._push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
    this._op({ type: 'qr', text, size, ecc });
    return this;
  }

  cut({ full = false, feed = 3 } = {}) {
    this._op({ type: 'cut' });
    if (feed) this._push(ESC, 0x64, feed);
    return this._push(GS, 0x56, full ? 65 : 66, 0x00);
  }
  // Cash drawer kick on connector pin 0 or 1; pulse times are in 2 ms units.
  drawer({ pin = 0, on = 25, off = 250 } = {}) {
    this._op({ type: 'drawer' });
    return this._push(ESC, 0x70, pin ? 1 : 0, on, off);
  }

  bytes() { return Uint8Array.from(this.buf); }
}

// Whole receipt as one picture, for printers whose built-in fonts look bad.
// bitmap: RGBA drawn by the app on a canvas, exactly 384 or 576 dots wide.
export function renderFull(bitmap, { dither = true, threshold = 128, cut = true, drawer = false } = {}) {
  const r = new Receipt({ dots: bitmap.width <= 384 ? 384 : 576 });
  if (bitmap.width !== r.dots) throw new Error(`bitmap must be ${r.dots} dots wide, got ${bitmap.width}`);
  r.init();
  if (drawer) r.drawer();
  r.image(bitmap, { dither, threshold });
  if (cut) r.cut();
  return r.bytes();
}
