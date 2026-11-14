// Rekap kas (Glenn, 11 Nov 2026): the shift's cash recap, from pos_shift_rekap /
// pos_close_shift output. Three outputs:
//   rekapReceipt(k, { dots, reprint })  thermal print, TEXT ONLY in the printer's own font (no
//                                       picture, so it prints fast and light). VireoPOS "Rekap Kas"
//                                       layout plus orders, batal/refund, kas moves and the cash.
//   rekapPreview(k, { dots })           a canvas picture of that print (owner app PNG, demo).
//   rekapPdf(k)                         a PDF for the team WhatsApp group (js/pdf.js).
// A staff rekap (k.blind) never carries the modal, the expected drawer or the selisih, and
// none of these functions print them for it. The owner's copy (k.blind false) adds them.
import { Receipt, wrap } from './escpos.js';
import { fastPreview } from './receipt-fast.js';
import { pdfBlob } from './pdf.js';

const rp = (n) => (Number(n) || 0).toLocaleString('id-ID').replace(/,/g, '.');
const sign = (n) => (n > 0 ? '+' : n < 0 ? '-' : '') + rp(Math.abs(n));
const METHOD = { qris: 'QRIS', tunai: 'Tunai', platform: 'Aplikasi', gratis: 'Gratis' };
export const DENOMS = ['100000', '50000', '20000', '10000', '5000', '2000', '1000'];
const MOVE = { masuk: 'Kas masuk', keluar: 'Kas keluar', setor: 'Setor ke pemilik' };
const REFUND_TO = { tunai: 'tunai', transfer: 'transfer', qris: 'QRIS', campur: 'tunai + QRIS', platform: 'aplikasi' };
// Promo items per promo (Glenn, 13 Nov 2026): BOGO, 50% malam, 50% instruksi (with who said so),
// Tebus murah, member vouchers, stamp rewards and the owner's promos, each with pieces and rupiah.
const promoName = (m) => `${m.label}${m.by ? ` (${m.by})` : ''}`;
const promoQty = (m) => `${m.items} item, ${m.orders} pesanan`;
const pct = (n) => (n == null ? '' : ' ' + String(Number(n)).replace('.', ',') + '%');
// Service charge and PBJT apart from sales (14 Nov 2026), [label, text]; PBJT inside the price says "termasuk".
export const rekapChargeRows = (k) => [
  ...(k.service_charge ? [[`Service charge${pct(k.service_pct)}`, rp(k.service_charge)]] : []),
  ...(k.tax ? [[`PBJT${pct(k.tax_pct)}`, rp(k.tax)]] : []),
  ...(k.tax_in ? [[`PBJT${pct(k.tax_pct)} (termasuk)`, rp(k.tax_in)]] : []),
];
const refundRows = (k) => Object.entries(k.refunds?.by_method || {}).map(([m, a]) => [`  lewat ${REFUND_TO[m] || m}`, a]);

const itemName = (i) => [i.name, i.flavour, i.promo ? '(promo)' : '', i.free_bag ? '(gratis)' : ''].filter(Boolean).join(' ');
const itemQty = (i) => (i.unit != null ? `${i.qty} x ${rp(i.unit)}` : `${i.qty} pcs`);
export const denomText = (d) => {
  if (!d) return '';
  const parts = DENOMS.filter((k) => Number(d[k]) > 0).map((k) => `${rp(k)} x${d[k]}`);
  if (Number(d.koin) > 0) parts.push(`koin ${rp(d.koin)}`);
  return parts.join(', ');
};

// The printer commands. reprint: a manager's or the owner's second copy (CETAK ULANG).
export function rekapReceipt(k, { dots = 384, reprint = false, cut = true, at = null } = {}) {
  const p = new Receipt({ dots, margin: 2 });
  p.init();
  p.align('center').bold(true).size(2, 2).text('HANASHUYA').size(1, 1).text('Rekap Kas').bold(false);
  if (reprint) p.bold(true).text(`CETAK ULANG ${at || k.now || ''}`.trim()).bold(false);
  p.align('left').rule('-');
  const meta = (key, v) => {
    if (v == null || v === '') return;
    // Value in its own column; wrapped lines stay indented under it (_lines keeps the spaces).
    const lines = wrap(String(v), Math.max(8, p.width - 12));
    p._lines(lines.map((l, n) => (n ? '' : key).padEnd(12) + l));
  };
  meta('Staff', k.staff);
  meta('Gerai', k.outlet);
  meta('Perangkat', k.device || 'Tablet kasir');
  meta('Mulai Shift', k.start);
  meta('Akhir Shift', k.end || 'shift masih buka');
  p.rule('-');

  p.bold(true).text('Barang terjual').bold(false).rule('-');
  if (!k.items.length) p.text('Belum ada penjualan.');
  for (const i of k.items) { p.text(itemName(i)); p.row('  ' + itemQty(i), rp(i.total)); }
  p.rule('-');
  p.row('Subtotal', rp(k.subtotal));
  if (k.discount > 0) p.row('Diskon', '-' + rp(k.discount));
  p.row('Penjualan', rp(k.sales ?? k.total));
  for (const [l, a] of rekapChargeRows(k)) p.row(l, a);
  p.bold(true).row('Total Akhir', rp(k.total)).bold(false);
  p.rule('-');

  p.bold(true).text('Pembayaran').bold(false).rule('-');
  if (!k.payments.length) p.text('Belum ada pembayaran.');
  for (const m of k.payments) p.row(`${(METHOD[m.method] || m.method).padEnd(7)}Diterima`, rp(m.amount));
  if (k.split_count) p.small(true).text(`${k.split_count} pesanan split payment, masuk di QRIS dan Tunai`).small(false);
  p.rule('-');
  p.bold(true).row('Total Akhir', rp(k.total)).bold(false);
  p.rule('-');

  p.row('Pesanan dibayar', String(k.orders));
  p.row(`Batal (${k.voids.batal_count})`, rp(k.voids.batal_amount));
  p.row(`Refund (${k.voids.refund_count})`, rp(k.voids.refund_amount));
  for (const [l, a] of refundRows(k)) p.row(l, rp(a));
  p.rule('-');

  p.bold(true).text('Promo dipakai').bold(false);
  if (!k.promos?.length) p.text('Tidak ada.');
  for (const m of k.promos || []) { p.text(promoName(m)); p.row('  ' + promoQty(m), '-' + rp(m.discount)); }
  p.rule('-');

  p.bold(true).text('Kas masuk / keluar').bold(false);
  if (!k.moves.length) p.text('Tidak ada.');
  for (const m of k.moves) {
    p.text(`${m.time} ${MOVE[m.kind] || m.kind}${m.by ? ', ' + m.by : ''}`);
    p.row('  ' + m.reason, (m.kind === 'masuk' ? '+' : '-') + rp(m.amount));
  }
  p.rule('-');

  p.bold(true).text('Tunai').bold(false);
  p.row('Uang diterima dari pembeli', rp(k.cash_received));
  p.row('Kembalian diberikan', rp(k.change_given));
  if (k.counted_cash != null) p.bold(true).row('Uang laci dihitung', rp(k.counted_cash)).bold(false);
  if (!k.blind) {
    // The owner's copy only (k.blind false): never on a staff print.
    p.rule('-');
    p.bold(true).text('Khusus pemilik').bold(false);
    p.row('Uang modal', rp(k.opening_cash));
    if (k.setor) p.row('Setor ke pemilik', '-' + rp(k.setor));
    p.row('Seharusnya di laci', rp(k.expected_cash));
    if (k.difference != null) p.bold(true).row('Selisih', sign(k.difference)).bold(false);
  }
  if (k.note) { p.rule('-'); p.text('Catatan: ' + k.note); }
  p.rule('-');
  p.small(true).text(`Dicetak ${at || k.now || ''}`).small(false);
  if (cut) p.cut();
  return p;
}

// Picture of the text print (printer font approximated), for previews and the owner PNG.
export function rekapPreview(k, { dots = 384, reprint = false } = {}) {
  return fastPreview(rekapReceipt(k, { dots, reprint, cut: false }), null, dots);
}

// The PDF for WhatsApp. Staff (k.blind): the same content as the print. Owner: plus modal,
// expected, counted, selisih, denomination count and the drawer ledger.
export function rekapPdf(k) {
  const b = [];
  b.push({ kv: ['Staff', k.staff || '-'] }, { kv: ['Gerai', k.outlet] }, { kv: ['Perangkat', k.device || 'Tablet kasir'] },
    { kv: ['Mulai shift', k.start] }, { kv: ['Akhir shift', k.end || 'shift masih buka'] }, { rule: true });
  b.push({ h: 'Barang terjual' });
  b.push(k.items.length ? { table: { head: ['Barang', 'Jumlah', 'Total'], align: ['l', 'r', 'r'],
    rows: k.items.map((i) => [itemName(i), itemQty(i), rp(i.total)]) } } : { p: 'Belum ada penjualan.' });
  b.push({ kv: ['Subtotal', rp(k.subtotal)] });
  if (k.discount > 0) b.push({ kv: ['Diskon', '-' + rp(k.discount)] });
  b.push({ kv: ['Penjualan', rp(k.sales ?? k.total)] });
  for (const [l, a] of rekapChargeRows(k)) b.push({ kv: [l, a] });
  b.push({ kv: ['Total akhir', rp(k.total)], bold: true }, { rule: true });
  b.push({ h: 'Pembayaran' });
  b.push(k.payments.length ? { table: { head: ['Cara bayar', 'Pesanan', 'Diterima'], align: ['l', 'r', 'r'],
    rows: k.payments.map((m) => [METHOD[m.method] || m.method, String(m.count), rp(m.amount)]) } } : { p: 'Belum ada pembayaran.' });
  if (k.split_count) b.push({ p: `${k.split_count} pesanan split payment, masuk di QRIS dan Tunai.` });
  b.push({ kv: ['Pesanan dibayar', String(k.orders)] },
    { kv: [`Batal (${k.voids.batal_count})`, rp(k.voids.batal_amount)] },
    { kv: [`Refund (${k.voids.refund_count})`, rp(k.voids.refund_amount)] });
  for (const [l, a] of refundRows(k)) b.push({ kv: [l.trim(), rp(a)] });
  b.push({ rule: true }, { h: 'Promo dipakai' });
  b.push(k.promos?.length ? { table: { head: ['Promo', 'Item', 'Pesanan', 'Potongan'], align: ['l', 'r', 'r', 'r'],
    rows: k.promos.map((m) => [promoName(m), String(m.items), String(m.orders), '-' + rp(m.discount)]) } } : { p: 'Tidak ada.' });
  b.push({ rule: true });
  b.push({ h: 'Kas masuk / keluar' });
  b.push(k.moves.length ? { table: { head: ['Jam', 'Keterangan', 'Jumlah'], align: ['l', 'l', 'r'],
    rows: k.moves.map((m) => [m.time, `${MOVE[m.kind] || m.kind}: ${m.reason}${m.by ? ` (${m.by})` : ''}`, (m.kind === 'masuk' ? '+' : '-') + rp(m.amount)]) } }
    : { p: 'Tidak ada.' });
  b.push({ h: 'Tunai' }, { kv: ['Uang diterima dari pembeli', rp(k.cash_received)] }, { kv: ['Kembalian diberikan', rp(k.change_given)] });
  if (k.counted_cash != null) b.push({ kv: ['Uang laci dihitung', rp(k.counted_cash)], bold: true });
  if (!k.blind) {
    if (k.denominations) b.push({ p: 'Pecahan: ' + (denomText(k.denominations) || '-') });
    b.push({ rule: true }, { h: 'Khusus pemilik' }, { kv: ['Uang modal', rp(k.opening_cash)] });
    if (k.setor) b.push({ kv: ['Setor ke pemilik', '-' + rp(k.setor)] });
    b.push({ kv: ['Seharusnya di laci', rp(k.expected_cash)] });
    if (k.difference != null) b.push({ kv: ['Selisih', sign(k.difference)], bold: true });
    if (k.ledger?.length) {
      b.push({ h: 'Catatan laci' }, { table: { head: ['Jam', 'Kejadian', 'Diterima', 'Kembalian', 'Laci'], align: ['l', 'l', 'r', 'r', 'r'],
        rows: k.ledger.map((e) => [e.time, ledgerLabel(e), e.received != null ? rp(e.received) : '', e.change != null ? rp(e.change) : '',
          e.kind === 'hitung' ? rp(e.counted) : rp(e.balance)]) } });
    }
  }
  if (k.note) b.push({ rule: true }, { p: 'Catatan: ' + k.note });
  return pdfBlob({ title: 'Rekap kas', subtitle: `${k.start} sampai ${k.end || 'sekarang'}`, blocks: b });
}

export const ledgerLabel = (e) => ({
  modal: 'Uang modal', jual: `Penjualan ${e.label}`, jual_refund: `Penjualan ${e.label} (refund)`,
  masuk: `Kas masuk: ${e.label}`, keluar: `Kas keluar: ${e.label}`, setor: `Setor: ${e.label}`, hitung: 'Uang laci dihitung',
}[e.kind] || e.label);

export const rekapFile = (k) => `rekap-kas-${String(k.start || '').slice(0, 10).split('/').reverse().join('-') || 'shift'}.pdf`;
