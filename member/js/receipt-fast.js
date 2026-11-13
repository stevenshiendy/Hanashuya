// Fast receipt for the thermal printer (12 Nov 2026). The full design as one picture is
// about 58 KB and takes some 25 seconds over Bluetooth on the booth's PANDA printer.
// This prints the header (logo, address, channels) as a small picture and everything
// below in the printer's own font, about 15 KB in all, in the same order as the
// approved receipt (B revision 1). Same input as receipt.js: pos_checkout / pos_receipt output.
import { receiptCanvas, cardCanvas, receiptDate, rupiah, paymentRows } from './receipt.js';
import { Receipt } from './escpos.js';

const WA_NUMBER = '0858-9012-0577';

// Builds the printer commands. header: RGBA bitmap from receiptCanvas(..., { headerOnly: true }).
// card: RGBA bitmap of the loyalty card box from cardCanvas(), or null for a walk-in.
// margin: 2 empty characters each side, so the text doesn't run to the paper's edge.
export function fastReceiptBytes(r, header, card, { dots = 384, cut = true, drawer = false, margin = 2 } = {}) {
  const p = new Receipt({ dots, margin });
  p.init();
  if (drawer) p.drawer();
  p.align('center');
  p.image(header, { dither: false });
  p.align('left');
  p.rule('-');

  const meta = (k, v) => p.text(k.padEnd(9) + v);
  meta('No.', r.receipt_no);
  if (r.local_no && r.local_no !== r.receipt_no) meta('No. offline', r.local_no);
  meta('Tanggal', receiptDate(r.sold_at));
  if (r.served_by) meta('Kasir', r.served_by);
  if (r.member) meta('Member', 'Kak ' + r.member);
  if (r.channel && r.channel !== 'toko') meta('Pesanan', r.channel_label);
  if (r.status === 'batal' || r.status === 'refund') {
    p.align('center').bold(true).text(r.status === 'batal' ? 'Pesanan ini sudah dibatalkan.' : 'Pesanan ini sudah direfund.').bold(false).align('left');
  }
  p.rule('=');

  for (const l of r.lines) {
    p.bold(true).row(`${l.qty} ${l.name}`, l.free_bag ? 'Gratis' : rupiah(l.line_total)).bold(false);
    if (l.flavour) p.text('  ' + l.flavour);
  }
  p.rule('-');
  p.row('Subtotal', rupiah(r.subtotal));
  if (r.discount > 0) {
    // Label on its own line, so a long promo name never pushes the amount onto a new line.
    p.text(r.promo_label || 'Diskon');
    p.row('  ' + (r.promo_product || ''), '-' + rupiah(r.discount));
  }
  p.rule('=');
  p.bold(true).size(1, 2).row('TOTAL', 'Rp' + rupiah(r.total)).size(1, 1).bold(false);
  p.rule('=');

  // Payment rows as on the picture receipt; Bayar 2 cara lists both parts (13 Nov 2026).
  for (const [k, v] of paymentRows(r)) p.row(k, v);
  if (r.note) { p.line(1); p.text('Catatan: ' + r.note); }
  p.line(1);

  if (r.card && card) {
    // The loyalty card stays the picture from the approved design (Glenn, 12 Nov 2026).
    p.align('center').image(card, { dither: false }).align('left');
  } else if (!r.member) {
    p.align('center').bold(true).text('Belum jadi member Kak?').bold(false);
    p.text('Daftar di hanashuya.vercel.app/daftar').align('left');
  }
  p.rule('-');

  p.align('center');
  p.bold(true).text(r.member ? `Terima kasih Kak ${r.member}.` : 'Terima kasih Kak.').bold(false);
  p.text('Sampai bertemu kembali.');
  p.line(1);
  // Small text, as in the approved design.
  p.small(true);
  p.text('Where every crunch tells a story');
  p.line(1);
  p.text(`Ada yang kurang pas Kak? Chat CS kami di WhatsApp ${WA_NUMBER}`);
  p.small(false);
  p.align('left');
  if (cut) p.cut();
  return p;
}

// Rough picture of the fast receipt: the header image, then the printer's 12 x 24 dot
// font (Font A) drawn on a fixed grid. The real letters come from the printer.
export function fastPreview(receipt, header, dots, card = null) {
  const lines = [];
  let h = 0;
  for (const op of receipt.ops) {
    if (op.type === 'image') { lines.push(op); h += op.height; }
    else if (op.type === 'text') { lines.push(op); h += (op.fontB ? 17 : 24) * op.sh + 6; }
    else if (op.type === 'feed') { lines.push(op); h += 24 * op.n; }
  }
  const c = document.createElement('canvas');
  c.width = dots; c.height = h + 24;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  const imgs = [header, card].filter(Boolean);
  let y = 0;
  for (const op of lines) {
    if (op.type === 'image') { const im = imgs.shift(); ctx.drawImage(im, Math.round((dots - im.width) / 2), y); y += op.height; continue; }
    if (op.type === 'feed') { y += 24 * op.n; continue; }
    const t = op.text, cw = (op.fontB ? 9 : 12) * op.sw, lh = op.fontB ? 17 : 24;
    const x0 = op.align === 'center' ? (dots - t.length * cw) / 2 : op.align === 'right' ? dots - t.length * cw : 0;
    ctx.font = `${op.bold ? 700 : 400} ${op.fontB ? 15 : 20}px Menlo, Consolas, monospace`;
    ctx.save(); ctx.translate(0, y + 2); ctx.scale(op.sw, op.sh);
    for (let k = 0; k < t.length; k++) ctx.fillText(t[k], (x0 + k * cw) / op.sw, 0);
    ctx.restore();
    y += lh * op.sh + 6;
  }
  return c;
}

// Crops white columns off both sides, keeping the width a multiple of 8 dots.
function cropSides(c) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let left = w, right = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i] < 200) { if (x < left) left = x; if (x > right) right = x; }
    }
  }
  if (right < left) return c;
  let cw = Math.ceil((right - left + 1) / 8) * 8;
  left = Math.max(0, Math.min(left - Math.floor((cw - (right - left + 1)) / 2), w - cw));
  cw = Math.min(cw, w);
  const out = document.createElement('canvas');
  out.width = cw; out.height = h;
  out.getContext('2d').drawImage(c, left, 0, cw, h, 0, 0, cw, h);
  return out;
}

// Header picture + commands, ready to send. Returns { receipt, bytes }.
export async function fastReceipt(r, { dots = 384, cut = true, drawer = false } = {}) {
  // A smaller logo, and the empty paper either side cropped off: the printer centres it.
  const full = await receiptCanvas(r, { mode: 'print', dots, headerOnly: true, logoWidth: dots >= 576 ? 240 : 190 });
  const head = cropSides(full);
  const bitmap = (c) => { const im = c.getContext('2d').getImageData(0, 0, c.width, c.height); return { width: im.width, height: im.height, data: im.data }; };
  // The card box lines up with the text margin (2 characters = 24 dots), cropped to whole bytes.
  const cardC = r.card ? cropSides(await cardCanvas(r, { dots, pad: 24 })) : null;
  const receipt = fastReceiptBytes(r, bitmap(head), cardC ? bitmap(cardC) : null, { dots, cut, drawer });
  return { receipt, bytes: receipt.bytes(), header: head, card: cardC };
}
