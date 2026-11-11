// Draws a POS receipt (the JSON from pos_checkout / pos_receipt) onto a canvas, in the
// design Glenn approved on 11 Nov 2026 (receipt B, revision 1; source in
// Hanashuya Drafts/pos-receipt/receipt.html#r58).
//
//   receiptCanvas(r, { mode: 'print', dots: 384 | 576 })  black on white, 58 or 80 mm paper
//   receiptCanvas(r, { mode: 'wa' })                        cream and red image for WhatsApp
//   receiptBitmap(r, dots)  -> { width, height, data }      RGBA for the printer (escpos renderFull)
//   receiptBlob(r)          -> PNG Blob                      for sending by WhatsApp
//
// No dependencies. Text is wrapped here, so long product or promo names never overflow.

const IMG = (f) => new URL(`../img/${f}`, import.meta.url).href;
const FONT_SANS = 'HS Receipt Sans';
const FONT_SERIF = 'HS Receipt Serif';
const WA_NUMBER = '0858-9012-0577';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Instagram, TikTok and WhatsApp glyphs (24 x 24), the same ones as on the A2 posters.
const ICONS = {
  ig: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
  tt: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
  wa: 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z',
};

// Sizes from the approved draft. The WhatsApp image is wider, with larger body text.
const STYLE = {
  print: {
    pad: 6, top: 10, bottom: 24, base: [21, 28], muted: [19, 26], addr: [21, 28], ch: [19, 26], icon: 19,
    key: 100, totL: 22, totV: [38, 44], thanks: [24, 30], brand: [18, 22], cs: [16, 21],
    logoGap: 10, ink: '#000', accent: '#000', rule: '#000', paper: '#fff',
  },
  wa: {
    pad: 56, top: 48, bottom: 56, base: [25, 34], muted: [19, 26], addr: [25, 34], ch: [22, 30], icon: 22,
    key: 125, totL: 22, totV: [46, 52], thanks: [24, 30], brand: [18, 22], cs: [19, 26],
    logoGap: 18, ink: '#5D210C', accent: '#A30007', rule: '#5D210C', paper: '#FFFAEE',
  },
};

let fontsReady = null;
function loadFonts() {
  if (!fontsReady) {
    const sans = new FontFace(FONT_SANS, `url(${new URL('../fonts/dmsans.woff2', import.meta.url).href})`, { weight: '100 1000' });
    const serif = new FontFace(FONT_SERIF, `url(${new URL('../fonts/cinzel.woff2', import.meta.url).href})`, { weight: '400 900' });
    fontsReady = Promise.all([sans.load(), serif.load()]).then((f) => f.forEach((x) => document.fonts.add(x)));
  }
  return fontsReady;
}

const images = {};
function loadImage(src) {
  if (!images[src]) {
    images[src] = new Promise((ok, fail) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => fail(new Error('Logo struk tidak bisa dimuat.'));
      im.src = src;
    });
  }
  return images[src];
}

export const rupiah = (n) => (n || 0).toLocaleString('id-ID').replace(/,/g, '.');

// "11 Nov 2026  14.55" in Bandung time, with Indonesian month names.
export function receiptDate(iso) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${+parts.day} ${MONTHS[+parts.month - 1]} ${parts.year} ${parts.hour}.${parts.minute}`;
}

// A small layout engine: draws top to bottom and moves the cursor y.
class Sheet {
  constructor(ctx, width, st) {
    this.ctx = ctx; this.W = width; this.st = st; this.y = st.top;
    this.left = st.pad; this.right = width - st.pad;
  }
  font([size], weight = 500, family = FONT_SANS) {
    this.ctx.font = `${weight} ${size}px "${family}"`;
    this.ctx.letterSpacing = '0px';
  }
  w(t) { return this.ctx.measureText(t).width; }
  // Splits on spaces; a non-breaking space (U+00A0) keeps words together.
  wrap(text, max) {
    const out = []; let line = '';
    for (const word of String(text).split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (line && this.w(next) > max) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  }
  put(text, x, lh, align = 'left', color = this.st.ink) {
    const c = this.ctx;
    c.fillStyle = color; c.textAlign = align; c.textBaseline = 'middle';
    c.fillText(text.replace(/ /g, ' '), x, this.y + lh / 2 + 1);
  }
  // Plain text, wrapped to the column, left or centred.
  text(text, size = this.st.base, weight = 500, { align = 'left', family = FONT_SANS, color, spacing = 0 } = {}) {
    this.font(size, weight, family);
    this.ctx.letterSpacing = spacing + 'px';
    const x = align === 'center' ? this.W / 2 : this.left;
    for (const line of this.wrap(text, this.right - this.left)) { this.put(line, x, size[1], align, color); this.y += size[1]; }
    this.ctx.letterSpacing = '0px';
  }
  // Left text (wrapped) with right text on the first line.
  row(l, r, { size = this.st.base, lw = 500, rw = 500, rsize, rcolor, gap = 8, lspacing = 0 } = {}) {
    this.font(rsize || size, rw);
    const rW = r ? this.w(r) : 0;
    this.font(size, lw);
    this.ctx.letterSpacing = lspacing + 'px';
    const lines = this.wrap(l, this.right - this.left - rW - (r ? gap : 0));
    const lh = Math.max(size[1], rsize ? rsize[1] : 0);
    const y0 = this.y;
    lines.forEach((line, i) => { this.put(line, this.left, i ? size[1] : lh); this.y += i ? size[1] : lh; });
    this.ctx.letterSpacing = '0px';
    if (r) {
      const yEnd = this.y; this.y = y0;
      this.font(rsize || size, rw); this.put(r, this.right, lh, 'right', rcolor);
      this.y = yEnd;
    }
  }
  // Key column, then value (the No. / Tanggal / Kasir block).
  meta(k, v) {
    this.font(this.st.base, 500);
    this.put(k, this.left, this.st.base[1]);
    const lines = this.wrap(v, this.right - this.left - this.st.key);
    lines.forEach((line) => { this.put(line, this.left + this.st.key, this.st.base[1]); this.y += this.st.base[1]; });
  }
  dotted() {
    this.y += 10;
    this.ctx.fillStyle = this.st.rule;
    for (let x = this.left; x < this.right; x += 4) this.ctx.fillRect(x, this.y, 2, 2);
    this.y += 2 + 10;
  }
  solid() {
    this.y += 10;
    this.ctx.fillStyle = this.st.rule; this.ctx.fillRect(this.left, this.y, this.right - this.left, 3);
    this.y += 3 + 10;
  }
  gap(h) { this.y += h; }
  icon(name, x, size, color) {
    const c = this.ctx; c.save();
    c.translate(x, this.y + (this.st.ch[1] - size) / 2); c.scale(size / 24, size / 24);
    c.fillStyle = color; c.fill(new Path2D(ICONS[name])); c.restore();
  }
  // Content inside a rounded box with a 3 px border and 10 px padding.
  box(draw) {
    const top = this.y, b = 3, p = 10;
    const L = this.left, R = this.right;
    this.left = L + b + p; this.right = R - b - p; this.y += b + p;
    draw();
    this.y += p + b;
    this.left = L; this.right = R;
    const c = this.ctx; c.strokeStyle = this.st.rule; c.lineWidth = b;
    c.beginPath(); c.roundRect(L + b / 2, top + b / 2, R - L - b, this.y - top - b, 10); c.stroke();
  }
  stamps(size, before, now) {
    const gap = 6, n = size, w = (this.right - this.left - gap * (n - 1)) / n, c = this.ctx;
    const top = this.y + 8, bw = 2.5;
    for (let k = 1; k <= n; k++) {
      const x = this.left + (k - 1) * (w + gap);
      c.fillStyle = this.st.paper; c.fillRect(x, top, w, w);
      if (k <= now) { c.fillStyle = this.st.accent; c.fillRect(x, top, w, w); }
      if (k > before && k <= now) { // today's stamps: ringed
        c.fillStyle = this.st.paper; c.fillRect(x + 4, top + 4, w - 8, w - 8);
        c.fillStyle = this.st.accent; c.fillRect(x + 8, top + 8, w - 16, w - 16);
      }
      c.strokeStyle = k <= now ? this.st.accent : this.st.rule; c.lineWidth = bw;
      c.strokeRect(x + bw / 2, top + bw / 2, w - bw, w - bw);
    }
    this.y = top + w + 6;
  }
}

function lineLabel(l) { return `${l.qty} ${l.name}`; }

// Draws the receipt and returns the canvas, trimmed to its height.
export async function receiptCanvas(r, { mode = 'print', dots = 384 } = {}) {
  await loadFonts();
  const st = STYLE[mode];
  const W = mode === 'wa' ? 720 : dots;
  const logo = await loadImage(IMG(mode === 'wa' ? 'receipt-logo-red.svg' : dots >= 576 ? 'receipt-logo-80.png' : 'receipt-logo-58.png'));
  const tall = document.createElement('canvas');
  tall.width = W; tall.height = 6000;
  const ctx = tall.getContext('2d');
  ctx.fillStyle = st.paper; ctx.fillRect(0, 0, W, tall.height);
  const s = new Sheet(ctx, W, st);

  // Header: logo, address, channels.
  const lw = mode === 'wa' ? 300 : dots >= 576 ? 400 : 270;
  const lh = Math.round(logo.naturalHeight * (lw / logo.naturalWidth));
  ctx.drawImage(logo, Math.round((W - lw) / 2), s.y, lw, lh);
  s.y += lh + st.logoGap;
  s.text('Papaya Fresh Gallery Bandung', st.addr, 700, { align: 'center' });
  s.font(st.ch, 500);
  const handle = 'Hanashuya.id', icon = st.icon, gi = 2, gt = 5, between = 14;
  const wHandle = icon * 2 + gi + gt + s.w(handle), wPhone = icon + gt + s.w(WA_NUMBER);
  const iconColor = mode === 'wa' ? st.accent : st.ink;
  const one = wHandle + between + wPhone <= s.right - s.left;
  let x = one ? (W - (wHandle + between + wPhone)) / 2 : (W - wHandle) / 2;
  s.icon('ig', x, icon, iconColor); s.icon('tt', x + icon + gi, icon, iconColor);
  s.put(handle, x + icon * 2 + gi + gt, st.ch[1]);
  if (one) x += wHandle + between; else { s.y += st.ch[1]; x = (W - wPhone) / 2; }
  s.icon('wa', x, icon, iconColor); s.put(WA_NUMBER, x + icon + gt, st.ch[1]);
  s.y += st.ch[1];

  // Who and when.
  s.dotted();
  s.meta('No.', r.receipt_no);
  s.meta('Tanggal', receiptDate(r.sold_at));
  if (r.served_by) s.meta('Kasir', r.served_by);
  if (r.member) s.meta('Member', 'Kak ' + r.member);
  if (r.channel && r.channel !== 'toko') s.meta('Pesanan', r.channel_label);
  if (r.status === 'batal' || r.status === 'refund') {
    s.gap(6);
    s.text(r.status === 'batal' ? 'Pesanan ini sudah dibatalkan.' : 'Pesanan ini sudah direfund.', st.base, 700, { align: 'center' });
  }
  s.solid();

  // Items.
  for (const l of r.lines) {
    s.row(lineLabel(l), l.free_bag ? 'Gratis' : rupiah(l.line_total), { lw: 700 });
    if (l.flavour) s.text(l.flavour, st.muted);
    s.gap(6);
  }
  s.y -= 6;
  s.dotted();
  s.row('Subtotal', rupiah(r.subtotal));
  if (r.discount > 0) {
    s.row(r.promo_label || 'Diskon', '-' + rupiah(r.discount));
    if (r.promo_product) s.text(r.promo_product, st.muted);
  }
  s.solid();
  s.row('TOTAL', 'Rp' + rupiah(r.total), { size: [st.totL, st.totV[1]], lw: 700, lspacing: 2, rsize: st.totV, rw: 800, rcolor: st.accent });
  s.solid();

  // Payment.
  if (r.payment_method === 'tunai') { s.row('Tunai', rupiah(r.cash_received)); s.row('Kembali', rupiah(r.change)); }
  else if (r.payment_method === 'qris') s.row('QRIS', rupiah(r.total));
  else if (r.payment_method === 'platform') s.row(r.channel_label, rupiah(r.total));
  s.gap(12);

  // Loyalty card, or the sign-up invite for walk-ins.
  if (r.card) {
    const c = r.card, now = Math.min(c.position, c.size), before = Math.max(0, now - (r.stamps || 0));
    s.box(() => {
      s.row('Hanashuya Loyalty Card', r.stamps > 0 ? '+' + r.stamps : '', { lw: 700, rw: 700 });
      s.stamps(c.size, before, now);
      s.row('Kartu Kakak', `${c.position} dari ${c.size}`);
      if (c.next_label) s.text(`${c.next_in} stempel lagi menuju ${c.next_label}`, st.muted);
      if (c.waiting > 0) s.text(`${c.waiting} stempel menunggu kartu berikutnya`, st.muted);
      if (r.new_rewards && r.new_rewards.length) {
        s.dotted();
        s.text('Hadiah baru: ' + r.new_rewards.join(', '), st.base, 700);
        s.text('Selamat Kak! Hadiahnya bisa dipakai di kunjungan berikutnya ya.', st.muted);
      }
    });
  } else if (!r.member) {
    s.box(() => {
      s.text('Belum jadi member Kak?', st.base, 700, { align: 'center' });
      s.text('Daftar di hanashuya.vercel.app/daftar', st.muted, 500, { align: 'center' });
    });
  }

  // Footer.
  s.gap(14);
  s.text(r.member ? `Terima kasih Kak ${r.member}.` : 'Terima kasih Kak.', st.thanks, 700, { align: 'center' });
  s.text('Sampai bertemu kembali.', st.base, 500, { align: 'center' });
  s.gap(12);
  s.text('Where every crunch tells a story', st.brand, 600, { align: 'center', family: FONT_SERIF, spacing: 0.5 });
  s.gap(12);
  s.text(`Ada yang kurang pas Kak? Chat CS kami di WhatsApp ${WA_NUMBER.replace(/-/g, '‑')}`, st.cs, 500, { align: 'center' });

  const out = document.createElement('canvas');
  out.width = W; out.height = Math.ceil(s.y + st.bottom);
  out.getContext('2d').drawImage(tall, 0, 0);
  return out;
}

// RGBA pixels at the printer's dot width (384 for 58 mm, 576 for 80 mm), for escpos renderFull.
export async function receiptBitmap(r, dots = 384) {
  const cv = await receiptCanvas(r, { mode: 'print', dots });
  const im = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  return { width: im.width, height: im.height, data: im.data };
}

// The WhatsApp image as a PNG file.
export async function receiptBlob(r) {
  const cv = await receiptCanvas(r, { mode: 'wa' });
  return new Promise((ok) => cv.toBlob(ok, 'image/png'));
}
