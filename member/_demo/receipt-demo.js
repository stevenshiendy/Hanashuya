// Test page for js/receipt.js: draws receipts from real pos_checkout output (PGlite tests).
import { receiptCanvas } from '../js/receipt.js';
const R = await (await fetch('_demo/receipts.json')).json();
const qris = { ...R.walk, payment_method: 'qris', cash_received: null, change: null, receipt_no: 'HS-261111-0009' };
const grab = { ...R.walk, channel: 'grabfood', channel_label: 'GrabFood', payment_method: 'platform', cash_received: null, change: null,
  lines: [...R.walk.lines, { name: 'Paper bag', flavour: null, qty: 1, line_total: 0, free_bag: true }] };
const which = (location.hash.slice(1) || 'all');
const cases = [
  ['Member + 50% · 58', R.member, 'print', 384], ['Reward opened · 58', R.reward, 'print', 384],
  ['Walk-in tunai · 58', R.walk, 'print', 384], ['Stamp reward 10% · 58', R.promo, 'print', 384],
  ['Free voucher · 58', R.free, 'print', 384], ['QRIS walk-in · 58', qris, 'print', 384], ['GrabFood · 58', grab, 'print', 384],
  ['Member + 50% · 80', R.member, 'print', 576], ['Member + 50% · WhatsApp', R.member, 'wa'], ['Walk-in · WhatsApp', R.walk, 'wa'],
].filter((c, i) => which === 'all' || which === String(i));
const out = document.getElementById('out');
for (const [label, r, mode, dots] of cases) {
  const f = document.createElement('figure');
  const cap = document.createElement('figcaption'); cap.textContent = label; f.append(cap);
  const cv = await receiptCanvas(r, { mode, dots });
  if (mode === 'wa') cv.style.width = '480px';
  f.append(cv); out.append(f);
}
document.title = 'H' + Math.ceil(document.body.scrollHeight);
