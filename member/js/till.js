// kasir.html: the till on the booth tablet (POSDEVELOPMENT.md tasks 5 and 6b).
// Layout "A, Dua panel" as Glenn picked it on 11 Nov 2026 (draft: Hanashuya Drafts/
// pos-kasir/kasir-a-r1.html): products on the left, the order and member on the right.
//
// Flow: products (flavour only after a product is tapped) -> Konfirmasi pesanan
// (pos_place_order gives the invoice number) -> Tunai or QRIS (pos_pay) -> done, with
// the printed receipt (receipt-fast.js over printer.js) and the WhatsApp image.
// After Konfirmasi pesanan staff can only ask (pos_request_void); a manager or the
// owner cancels (pos_cancel_order). The database enforces both.
// Every price, discount and total on screen comes from pos_quote; the local figures
// only fill the gap while a quote is on its way.
// Till v2 (Glenn, 13 Nov 2026): a note per order (Konfirmasi), Bayar 2 cara (Tunai + QRIS on one
// order, the change only from the Tunai part), refund of some pieces with where the money goes
// (Tunai, Transfer, QRIS), Diskon 50% malam (box products from 19.00) and Diskon 50% atas
// instruksi (any time, names the manager or owner who said so). No DP on pre-orders.
import { configured, $, esc, rpc, busy, notice, toast, rupiah, time, mountLogin, setupMissing, session, signOut, prettyPhone, toPhone, qrSvg, setRpcTimeout, maxBirth17 } from './lib.js';
import { fastReceipt, queueSlipBytes } from './receipt-fast.js';
import { receiptBlob, chargeRows, goodsTotal } from './receipt.js';
import * as printer from './printer.js';
import { isNative, shareNative } from './native.js';
import { SAMPLES } from './print-samples.js';
import { staffStock } from './stock.js';
import { mountApprovals } from './approvals.js';
import { rekapReceipt, rekapPdf, rekapFile, rekapChargeRows } from './receipt-rekap.js';
import { sharePdf } from './pdf.js';
import * as off from './till-offline.js';
import { openReservations } from './till-reservasi.js';

// Glenn picked the sheet (12 Nov 2026). 'inplace' is kept only for ?rasa=inplace testing.
const FLAVOUR_PICKER = 'sheet';
const PICKER = ['sheet', 'inplace'].includes(new URLSearchParams(location.search).get('rasa'))
  ? new URLSearchParams(location.search).get('rasa') : FLAVOUR_PICKER;

// Glenn's static QRIS poster, uncropped (Hanashuya Bakehouse, Papaya Bandung; NMID ID1025436208173).
const QRIS_IMG = 'img/qris-hanashuya.jpg';
const GENDERS = [['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki']];
const AGES = [['<17', 'Di bawah 17'], ['17-24', '17–24'], ['25-34', '25–34'], ['35-44', '35–44'], ['45+', '45+']];
const GENDER_CHOICES = [['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki'], ['tidak_disebut', 'Tidak ingin menyebutkan']];
const STATUS = { menunggu: ['Menunggu bayar', 'tag-warn'], dibayar: ['Dibayar', 'tag-ok'], batal: ['Dibatalkan', 'tag-bad'], refund: ['Refund', 'tag-bad'] };
const METHOD = { tunai: 'Tunai', qris: 'QRIS', campur: 'Tunai + QRIS', platform: 'Aplikasi', gratis: 'Gratis' };
const REFUND_TO = [['tunai', 'Tunai dari laci'], ['transfer', 'Transfer'], ['qris', 'Refund QRIS']];
const NOTE_MAX = 200;
const PAY_SCREENS = ['method', 'qris', 'cash', 'split'];
// The two parts of a Bayar 2 cara receipt.
const partOf = (r, m) => ((r.payments || []).find((p) => p.method === m) || {}).amount || 0;

const app = $('#app');
const S = {
  me: null, role: '', cat: null, shift: null, online: navigator.onLine,
  screen: 'home',           // home | order | method | qris | cash | done | today | close | open | stock
  back: 'home',             // where Hari ini, Tutup shift and Stok return to: home or order
  home: null,               // the last pos_home reply
  duty: null,               // first names of staff clocked in (att_on_duty), or null
  asks: null,               // void and refund requests waiting (managers and the owner only)
  stockMode: 'masuk',
  left: 'tiles',            // tiles | flavour | find | voucher | join
  pick: null,               // flavour picker: { code, flavour, qty, counts }
  tab: null,                // category tab: a pos_categories id, or null for Semua
  items: [],                // [{ product, flavour, qty }]
  served: null,
  member: null,             // the card from staff_lookup / staff_find_phone / staff_create_member
  memberPhone: null,        // a WhatsApp number the cashier typed or made the card with
  promo: null,              // { kind, cycle, slot } or { kind, period }, plus line
  bags: null,               // free paper bags the cashier set; null = the suggestion
  gender: null, age: null,
  quote: null, quoteErr: '', quoting: false,
  orderId: newId(),
  placed: null,             // pos_place_order receipt (status menunggu)
  confirming: false,        // Konfirmasi pesanan is on its way: the order is locked (13 Nov 2026)
  localNo: null,            // the L number this order got offline, kept through Ubah pesanan
  stash: null,              // the order in progress while a pre-order pickup is paid
  catAt: 0, catKey: '',     // when pos_catalog was last loaded, and the WIB day and hour then
  paid: null,               // pos_pay receipt
  cash: null,
  note: '',                 // Catatan pesanan (max 200), typed before Konfirmasi
  customerName: '',         // Pesanan atas nama Kak … (max 40): for calling the customer, kept on the order only
  noteOpen: false,
  split: null,              // Bayar 2 cara: { tunai, cash } (QRIS part = total - tunai)
  waitingCode: null,        // a voucher QR read before the member card
  sample: null,             // Sampel mode (12 Nov 2026): { id, items: [{ product, flavour, qty }] }, pieces given away
  sampleQuota: null,        // sample_quota_now() while Sampel is open: { hour, quota, given } (14 Nov 2026, warn only)
  count: {},                // Tutup shift: notes per denomination, koin in rupiah
  rekap: null,              // the closed shift's rekap (pos_close_shift)
};

function newId() {
  return crypto.randomUUID ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};
const paper = () => (store.get('hs-till-paper') === '80' ? '80' : '58');
// Nota antrian (14 Nov 2026): the owner turns it on for the booth (settings.queue_slip, loaded with the
// catalogue); this tablet can turn it off for itself (Printer screen). It shows only when both are on.
const queueDevice = () => store.get('hs-till-queue-slip') !== '0';
const queueOn = () => !!S.queueSlip && queueDevice();
async function loadQueueSlip() { try { S.queueSlip = !!(await rpc('pos_queue_slip')); } catch { /* keep the last value; older databases have no switch */ } }
const product = (code) => (S.cat?.products || []).find((p) => p.code === code);
const flavour = (id) => (S.cat?.flavours || []).find((f) => f.id === id);
const unitPrice = (p, f) => p.price + (f && f.surcharge ? p.flavour_surcharge : 0);
const isStaffOnly = () => S.role === 'staff';
const canCancel = () => S.role === 'manager' || S.role === 'owner';
const shortDay = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' }).format(new Date(iso));
// Rupiah fields: typed as digits, shown with dots (150.000). money(el) reads the number, or null when empty.
const money = (el) => { const d = String(el?.value || '').replace(/\D/g, ''); return d ? Number(d) : null; };
const moneyField = (attrs) => `<span class="tl-money"><span aria-hidden="true">Rp</span><input type="text" inputmode="numeric" autocomplete="off" data-money ${attrs}></span>`;
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('input[data-money]')) return;
  const n = money(el);
  el.value = n == null ? '' : n.toLocaleString('id-ID');
});
// "Signature Box isi 6" -> ["Signature Box", "isi 6"], for the tile's two lines. Any product
// the owner adds: a trailing size ("isi 15", "1 pcs", "isi 4 pcs") goes to the small line.
const splitName = (n) => { const m = String(n).match(/^(.*?)\s+(isi\s+\d+(?:\s*pcs)?|\d+\s*pcs)$/i); return m ? [m[1], m[2]] : [n, '']; };

/* ---------------------------------------------------------------- start */
async function start() {
  if (!configured) return setupMissing(app);
  // Every call gives up after 15 s, so flaky Wi-Fi turns into the offline path instead of a
  // button stuck on "Menyimpan…" (13 Nov 2026).
  setRpcTimeout(15000);
  registerWorker();
  // No internet and this tablet has opened the till before: open it from what it kept.
  if (!navigator.onLine && off.loadBoot()) return boot(true);
  if (!(await session().catch(() => null))) {
    if (off.loadBoot() && !navigator.onLine) return boot(true);
    return mountLogin(app, { staff: true, title: 'Masuk ke kasir', lead: 'Pakai username atau nomor WhatsApp dan password dari pemilik.', onDone: boot });
  }
  boot();
}

async function boot(offline = false) {
  $('#logout').hidden = false;
  let who;
  const kept = off.loadBoot();
  if (!offline) {
    try { who = await rpc('whoami'); }
    catch (e) {
      if (!(off.isNetError(e) && kept)) { app.innerHTML = `<div class="notice notice-error tl-solo" role="alert">${esc(e.message)}</div>`; return; }
      offline = true;
    }
  }
  if (offline) { who = kept.who; S.online = false; }
  if (!who || !['staff', 'manager', 'owner'].includes(who.role)) {
    app.innerHTML = `<section class="panel stack tl-solo"><h1>Tidak ada akses</h1>
      <button class="btn btn-quiet" type="button" id="reload">Keluar</button></section>`;
    $('#reload').addEventListener('click', signOut);
    return;
  }
  S.me = who; S.role = who.role;
  if (offline) S.cat = kept.cat;
  else {
    try { S.cat = await rpc('pos_catalog'); off.saveBoot(who, S.cat); markCatalog(); loadQueueSlip(); }
    catch (e) { app.innerHTML = `<div class="notice notice-error tl-solo" role="alert">${esc(e.message)}</div>`; return; }
  }
  S.shift = S.cat.shift;
  // The owner can serve too; the catalogue lists staff and managers only.
  // The kasir tablet account is a device, never the one who served (13 Nov 2026).
  if (!who.kasir_tablet && !S.cat.staff.some((x) => x.id === who.id)) S.cat.staff.push({ id: who.id, name: (who.full_name || 'Saya').split(' ')[0], is_me: true });
  const last = store.get('hs-till-served');
  S.served = S.cat.staff.some((x) => x.id === last) ? last : (S.cat.staff.find((x) => x.is_me) || {}).id || null;
    app.classList.add('is-till');
  if (!offline) await ensureShift();
  S.screen = 'home';
  render();
  setInterval(tick, 60000);
  sendQueued();
}

/* ---------------------------------------------------------------- offline (task 7) */
// Sales rung while the internet was down wait in off.queued() and go out with pos_checkout.
// The header shows how many wait, only while any do (no online indicator: Glenn, 12 Nov).
async function sendQueued() {
  if (!off.pending() || !navigator.onLine) { renderBar(); return; }
  const r = await off.flush(rpc);
  if (r.online && !S.online) goOnline();
  if (!r.online) markOffline();
  if (r.expired) toast('Sesi kasir berakhir. Tekan Keluar lalu masuk lagi. Penjualan offline tetap tersimpan di tablet.');
  if (r.sent) toast(r.left ? `${r.sent} penjualan offline terkirim, ${r.left} masih menunggu.` : `${r.sent} penjualan offline terkirim.`);
  if (r.check) toast(`${r.check} pembayaran tidak tercatat karena pesanannya sudah dibatalkan. Lihat Perlu dicek.`);
  renderBar();
  if (r.sent && S.screen === 'home') loadHome();
}
// Back online with nothing waiting: one light call tells whether the server is reachable.
async function probe() {
  try { await rpc('pos_shift_now'); goOnline(); } catch { /* still offline */ }
}
function markOffline() {
  if (!S.online) return;
  S.online = false; renderBar();
  if (S.screen === 'order') requote();
}
async function goOnline() {
  S.online = true;
  try { S.cat = { ...(await rpc('pos_catalog')), staff: S.cat.staff }; S.shift = S.cat.shift; off.saveBoot(S.me, S.cat); markCatalog(); loadQueueSlip(); } catch { /* next tick */ }
  await ensureShift();
  renderBar();
  if (S.screen === 'order') requote();
}
// The catalogue carries the promos as of the moment it was loaded: BOGO after 19.00, Tebus Murah
// on its days, the owner's promos with a time window, the stamp bonus. The installed till stays
// open for days, so it loads again when the WIB hour changes, every 10 minutes, and when the
// tablet wakes up or comes back online (13 Nov 2026). Never in the middle of a payment.
const wibKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).format(new Date());
const wibDay = () => wibKey().slice(0, 10);
function markCatalog() { S.catAt = Date.now(); S.catKey = wibKey(); }
let catLoading = false;
async function refreshCatalog(force = false) {
  if (!S.me || !S.cat || !S.online || !navigator.onLine || catLoading || S.confirming) return;
  if (PAY_SCREENS.includes(S.screen)) return;
  if (!force && S.catKey === wibKey() && Date.now() - S.catAt < 10 * 60000) return;
  catLoading = true;
  try {
    const c = await rpc('pos_catalog');
    S.cat = { ...c, staff: S.cat.staff };
    if (c.shift) S.shift = c.shift;
    off.saveBoot(S.me, S.cat); markCatalog();
    if (S.screen === 'order' && !S.sample) { renderLeft(); if (S.items.length) requote(); else renderRight(); }
  } catch (e) { if (off.isNetError(e)) markOffline(); }
  finally { catLoading = false; }
}

function showQueue() {
  const q = off.queued(), chk = off.toCheck();
  const li = (x, extra = '') => `<li><span class="grow"><b class="num">${esc(x.receipt.receipt_no)}</b>${x.receipt.server_no && x.receipt.server_no !== x.receipt.receipt_no ? ` <span class="small num">(${esc(x.receipt.server_no)})</span>` : ''} · ${esc(x.receipt.time || '')} · ${esc(METHOD[x.receipt.payment_method] || '')}
    ${x.err ? `<br><span class="small">${extra ? '' : 'Ditolak: '}${esc(x.err)}</span>` : ''}</span><b class="num">${rupiah(x.receipt.total)}</b>${extra}</li>`;
  const checkBtn = (x) => (canCancel() ? `<button class="tl-use" type="button" data-checked="${esc(x.order.id)}">Sudah dicek</button>` : '');
  ask({
    title: q.length ? `${q.length} penjualan belum terkirim` : 'Perlu dicek',
    body: `${q.length ? `<p class="small">Penjualan ini tersimpan di tablet dan terkirim otomatis saat internet kembali. Jangan hapus data browser dan jangan keluar dari kasir sebelum semuanya terkirim.</p>
      <ul class="list">${q.map((x) => li(x)).join('')}</ul>${q.some((x) => x.err) ? '<p class="small">Yang ditolak tetap disimpan. Hubungi manajer atau pemilik.</p>' : ''}` : ''}
      ${chk.length ? `${q.length ? `<h3 class="tl-h">Perlu dicek · ${chk.length}</h3>` : ''}
      <p class="small">Uangnya sudah diterima, tapi pesanannya dibatalkan sebelum pembayaran terkirim, jadi penjualannya tidak tercatat. Pemilik sudah mendapat tandanya. Manajer atau pemilik mencocokkan uangnya, lalu menekan Sudah dicek.</p>
      <ul class="list" id="tl-check-list">${chk.map((x) => li(x, checkBtn(x))).join('')}</ul>` : ''}`,
    confirm: q.length ? 'Kirim sekarang' : 'Tutup',
    run: async () => {
      if (!q.length) return;
      if (!navigator.onLine) throw new Error('Belum ada internet. Penjualan dikirim otomatis saat internet kembali.');
      const r = await off.flush(rpc);
      if (!r.online) throw new Error('Belum bisa terhubung. Coba lagi sebentar lagi.');
      renderBar();
      if (r.check) throw new Error(`${r.check} pembayaran pindah ke Perlu dicek: pesanannya sudah dibatalkan.`);
      if (r.failed) throw new Error(`${r.failed} penjualan ditolak server. Hubungi manajer atau pemilik.`);
      if (!S.online) goOnline();
    },
  });
  if (!q.length) $('#tl-dlg button[value="no"]').hidden = true;
  $('#tl-check-list')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-checked]'); if (!b) return;
    off.checked(b.dataset.checked);
    b.closest('li')?.remove();
    renderBar();
  });
}
function registerWorker() {
  if (!('serviceWorker' in navigator) || !/^https:|^http:\/\/localhost/.test(location.origin)) return;
  navigator.serviceWorker.register('sw-kasir.js', { scope: './kasir' }).catch(() => {});
}

/* ---------------------------------------------------------------- the order */
const boxes = () => S.items.reduce((n, it) => n + (product(it.product)?.is_box ? it.qty : 0), 0);
const bagsMax = () => Math.floor(boxes() / 2);
const freeBags = () => Math.min(S.bags ?? bagsMax(), bagsMax());

function orderPayload() {
  const promo = S.promo ? { ...S.promo } : null;
  return {
    id: S.orderId, channel: 'toko', ticket: S.member?.ticket || null, served_by: S.served,
    items: S.items.map((it) => ({ product: it.product, flavour: it.flavour, qty: it.qty })),
    free_bags: freeBags(), promo,
    gender: S.gender, age_range: S.age,
    note: S.note.trim() || null,
    customer_name: S.customerName.trim().replace(/\s+/g, ' ') || null,
  };
}

function addItem(code, flv, qty = 1) {
  const it = S.items.find((x) => x.product === code && (x.flavour || null) === (flv || null));
  if (it) it.qty = Math.min(50, it.qty + qty);
  else { S.items.push({ product: code, flavour: flv || null, qty }); if (S.promo) S.promo.line = null; }
  requote();
}

function changeQty(i, d) {
  const it = S.items[i]; if (!it) return;
  it.qty += d;
  if (it.qty <= 0) { S.items.splice(i, 1); if (S.promo) S.promo.line = null; }
  it.qty = Math.min(50, it.qty);
  requote();
}

let qTimer = null, qSeq = 0;
function requote() {
  clearTimeout(qTimer);
  S.quoteErr = '';
  if (!S.items.length) { S.quote = null; S.quoting = false; renderRight(); return; }
  if (!S.online) {
    try { S.quote = off.localQuote(S.cat, S.items, freeBags()); } catch (e) { S.quote = null; S.quoteErr = e.message; }
    S.quoting = false; renderRight(); return;
  }
  S.quoting = true;
  renderRight();
  qTimer = setTimeout(runQuote, 250);
}
async function runQuote() {
  const n = ++qSeq;
  try {
    const q = await rpc('pos_quote', { p_order: orderPayload() });
    if (n !== qSeq) return;
    S.quote = q; S.quoteErr = '';
  } catch (e) {
    if (n !== qSeq) return;
    if (off.isNetError(e)) { S.quoting = false; S.online = true; markOffline(); return; }
    S.quote = null; S.quoteErr = e.message;
  }
  S.quoting = false;
  renderRight();
}
const needsLine = () => /Pilih produk yang mendapat promo/i.test(S.quoteErr);

// A fresh, empty order. Also run when the cashier leaves a paid order's done screen by the
// header (Dashboard, Hari ini) instead of Pesanan baru, so the paid lines don't come back.
function freshOrder() {
  stopCamera();
  Object.assign(S, {
    left: 'tiles', pick: null, tab: null, items: [], member: null, memberPhone: null, promo: null, bags: null,
    gender: null, age: null, quote: null, quoteErr: '', quoting: false, orderId: newId(), placed: null, paid: null, cash: null,
    waitingCode: null, confirming: false, localNo: null, note: '', noteOpen: false, split: null, customerName: '',
  });
  // Back from a pre-order pickup: the order the cashier had in progress comes back.
  if (S.stash) { Object.assign(S, S.stash); S.stash = null; }
}
function resetOrder() { freshOrder(); S.screen = 'order'; S.back = 'order'; render(); }

/* ---------------------------------------------------------------- render */
function render() {
  renderBar();
  if (S.screen === 'home') return renderHome();
  if (S.screen === 'stock') return renderStock();
  if (S.screen === 'qr') return renderQr();
  if (S.screen === 'printer') return renderPrinter();
  if (S.screen === 'approve') return renderApprove();
  if (S.screen === 'closed') return renderClosed();
  if (S.screen === 'close') return renderClose();
  if (S.screen === 'today') return renderToday();
  if (PAY_SCREENS.includes(S.screen)) return renderPay();
  if (S.screen === 'done') return renderDone();
  app.innerHTML = `<div class="tl-order"><section class="tl-left" id="tl-left" aria-label="Produk"></section>
    <section class="tl-right" id="tl-right" aria-label="Pesanan"></section></div>`;
  renderLeft(); renderRight();
}

function renderBar() {
  const home = S.screen === 'home';
  const duty = home && S.duty?.length ? ` · ${S.duty.join(', ')} bertugas` : '';
  $('#tl-shift').textContent = S.shift ? `Shift dibuka ${time(S.shift.opened_at)}${duty}` : (S.me ? 'Shift belum dibuka' : '');
  const inSale = PAY_SCREENS.includes(S.screen);
  // On the home screen the tools are the buttons on the right, so the header stays quiet.
  for (const id of ['tl-home', 'tl-cash', 'tl-today', 'tl-close']) $('#' + id).hidden = !S.me || home;
  $('#tl-home').disabled = !S.shift || inSale;
  $('#tl-cash').disabled = !S.shift || inSale;
  $('#tl-close').disabled = !S.shift || inSale;
  $('#tl-today').disabled = inSale;
  $('#tl-today').textContent = S.screen === 'today' ? 'Kembali' : 'Hari ini';
  const n = off.pending(), c = off.toCheck().length;
  $('#tl-queue').hidden = !n && !c;
  $('#tl-queue').textContent = [n ? `${n} penjualan belum terkirim` : '', c ? `${c} perlu dicek` : ''].filter(Boolean).join(' · ');
  $('#tl-clock').hidden = !home;
  $('#tl-printer').hidden = !S.me || !home;
  if (home) $('#tl-clock').textContent = clockText();
}
const clockText = () => {
  const f = (o) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', ...o }).format(new Date());
  return `${f({ weekday: 'long' })}, ${f({ day: 'numeric', month: 'short', year: 'numeric' })} · ${f({ hour: '2-digit', minute: '2-digit' })}`;
};
// Leave Hari ini, Tutup shift or Stok for where the cashier came from.
const goBack = () => { S.screen = S.back === 'order' && S.shift ? 'order' : 'home'; render(); };
const goTo = (screen) => { stopCamera(); if (S.paid) freshOrder(); if (screen !== 'qr') stopQr(); if (screen === 'today') { S.todayTab = null; S.todayQ = ''; } if (S.screen === 'home' || S.screen === 'order') S.back = S.screen; S.screen = screen; render(); };

/* ---------------------------------------------------------------- home (design A) */
// The till opens here (Glenn, 12 Nov 2026): today's figures on the left, the tools as
// buttons on the right. Figures come from pos_home and refresh each minute while shown.
const short = (n) => (n >= 1e6 ? `Rp${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })}jt` : n >= 1000 ? `Rp${Math.round(n / 1000)}rb` : `Rp${n}`);
// Rounded y-axis ticks, at most 5 (0 and up to four steps).
function ticks(max, whole) {
  if (max <= 0) max = whole ? 4 : 100000;
  const raw = max / 4, pow = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((v) => v >= raw);
  if (whole) step = Math.max(1, Math.ceil(step));
  const out = [];
  for (let v = 0; v < max + step; v += step) out.push(v);
  return out;
}
function chartHtml(h) {
  const mode = store.get('hs-till-chart') === 'orders' ? 'orders' : 'revenue';
  const vals = h.hourly.map((x) => x[mode]);
  const tk = ticks(Math.max(0, ...vals), mode === 'orders'), top = tk[tk.length - 1];
  const pct = (v) => (v / top * 100).toFixed(1);
  const lbl = (v) => (mode === 'orders' ? String(v) : short(v));
  const hh = (n) => String(n).padStart(2, '0');
  const first = h.hourly[0]?.hour ?? 8, last = (h.hourly[h.hourly.length - 1]?.hour ?? 20) + 1;
  const seg = (v, l) => `<button type="button" aria-pressed="${mode === v}" class="${mode === v ? 'is-on' : ''}" data-act="chart" data-v="${v}">${l}</button>`;
  return `<section class="hm-panel" aria-labelledby="hm-chart-t">
    <div class="hm-ph"><h2 id="hm-chart-t">${mode === 'orders' ? 'Pesanan' : 'Penjualan'} per jam · buka ${hh(first)}.00 sampai tutup ${hh(last)}.00</h2>
      <span class="hm-seg" role="group" aria-label="Isi grafik">${seg('revenue', 'Omzet')}${seg('orders', 'Jumlah pesanan')}</span></div>
    <div class="hm-plot" role="img" aria-label="${esc(h.hourly.filter((x) => x[mode] > 0).map((x) => `${hh(x.hour)}.00: ${mode === 'orders' ? x.orders + ' pesanan' : rupiah(x.revenue)}`).join(', ') || 'Belum ada penjualan hari ini')}">
      <div class="hm-yax">${tk.map((v) => `<span class="num" style="bottom:${pct(v)}%">${lbl(v)}</span>`).join('')}</div>
      <div class="hm-area">${tk.map((v) => `<em style="bottom:${pct(v)}%"></em>`).join('')}
        <div class="hm-bars">${h.hourly.map((x) => `<div class="hm-hb"><i class="${x[mode] > 0 ? '' : 'is-zero'}" style="height:${x[mode] > 0 ? pct(x[mode]) : 1.5}%"></i><span class="num">${hh(x.hour)}</span></div>`).join('')}</div></div>
    </div></section>`;
}
function targetHtml(t) {
  const money_ = t.kind === 'omzet', f = (n) => (money_ ? rupiah(n) : n);
  const unit = money_ ? '' : ' produk';
  return `<div class="hm-kpi is-goal"><span class="hm-l">Target hari ini · ${money_ ? short(t.value) : t.value}${unit}</span>
    <span class="hm-v num">${t.percent}%</span>
    <div class="hm-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, t.percent)}" aria-label="Target hari ini"><i style="width:${Math.min(100, t.percent)}%"></i></div>
    <span class="hm-s num">${f(t.current)} dari ${f(t.value)}${unit}${money_ ? '<br>' : ' · '}${t.remaining > 0 ? `${f(t.remaining)} lagi` : 'Target tercapai'}</span></div>`;
}
// Stok minimum warning (Glenn, 12 Nov 2026): items at or under the minimum a manager or the owner set.
// One calm line (Glenn, 13 Nov 2026: the list was "too hectic"); Lihat opens the list in a sheet.
function lowHtml() {
  if (!S.low?.length) return '';
  return `<button class="hm-lowbar" type="button" data-act="low-open"><span><b>Stok menipis</b> · <span class="num">${S.low.length}</span> barang</span><span class="hm-lowgo">Lihat <span aria-hidden="true">›</span></span></button>`;
}
const qtyText = (n, unit) => (Number(n) <= 0 ? 'Habis' : `${Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 })} ${unit || ''}`.trim());
function openLow() {
  const rows = (S.low || []).slice().sort((a, b) => a.qty - b.qty);
  sheet({
    title: `Stok menipis · ${rows.length} barang`,
    body: `<div class="table-wrap"><table class="tl-lowt"><thead><tr><th>Barang</th><th class="num">Stok</th><th class="num">Minimum</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${esc(x.name)}</td><td class="num${Number(x.qty) <= 0 ? ' is-out' : ''}">${esc(qtyText(x.qty, x.unit))}</td><td class="num">${esc(qtyText(x.low_level, x.unit))}</td></tr>`).join('')}
    </tbody></table></div>`,
    actions: '<button class="btn tl-btn" type="button" data-act="low-request">Buat permintaan barang</button>',
  });
}
function homeLeft(h) {
  if (!h) return '<div class="hm-dash" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
  const topMax = Math.max(1, ...h.top_products.map((x) => x.qty));
  return `<div class="hm-dash">
    ${lowHtml()}
    <div class="hm-tiles">
      <div class="hm-kpi"><span class="hm-l">Omzet hari ini</span><span class="hm-v num">${rupiah(h.revenue)}</span>
        <span class="hm-s num">${h.orders} pesanan · rata-rata ${short(h.average)}<br>QRIS ${short(h.by_method.qris)} · Tunai ${short(h.by_method.tunai)}${h.service_charge || h.pbjt ? `<br>di luar omzet: ${[h.service_charge ? `service ${short(h.service_charge)}` : '', h.pbjt ? `PBJT ${short(h.pbjt)}` : ''].filter(Boolean).join(' · ')}` : ''}</span></div>
      <div class="hm-kpi"><span class="hm-l">Produk terjual</span><span class="hm-v num">${h.products_sold}</span>
        <span class="hm-s num">${esc(h.by_category.map((c) => `${c.name} ${c.qty}`).join(' · ') || 'Belum ada')}</span></div>
      <div class="hm-kpi"><span class="hm-l">Pesanan dibatalkan</span><span class="hm-v num">${h.cancelled_count ?? h.cancelled ?? 0}</span>
        <span class="hm-s num">${(h.cancelled_count ?? h.cancelled) ? `${rupiah(h.cancelled_amount || 0)} batal dan refund` : 'Tidak ada'}</span></div>
      <button class="hm-kpi is-tap${(h.pending_count ?? h.waiting) ? ' is-due' : ''}" type="button" data-act="home-pending"><span class="hm-l">Tagihan gantung</span><span class="hm-v num">${h.pending_count ?? h.waiting ?? 0}</span>
        <span class="hm-s num">${(h.pending_count ?? h.waiting) ? `${rupiah(h.pending_amount || 0)} belum dibayar` : 'Semua sudah dibayar'}</span></button>
      ${targetHtml(h.target)}
    </div>
    ${chartHtml(h)}
    <div class="hm-two">
      <section class="hm-panel" aria-labelledby="hm-top-t"><h2 id="hm-top-t">Paling laku hari ini</h2>
        ${h.top_products.length ? `<ol class="hm-rank">${h.top_products.slice(0, 4).map((x, i) => `<li><b class="num">${i + 1}</b><span>${esc(x.name)}</span><span class="hm-n num">${x.qty} ${esc(x.unit)}</span>
          <span class="hm-mini" aria-hidden="true"><i style="width:${Math.round(x.qty / topMax * 100)}%"></i></span></li>`).join('')}</ol>` : '<p class="muted">Belum ada penjualan hari ini.</p>'}</section>
      <section class="hm-panel" aria-labelledby="hm-fl-t"><h2 id="hm-fl-t">Produk terjual per rasa</h2>
        <dl class="hm-sold">${h.by_flavour.map((f) => `<dt>${esc(f.label)}</dt><dd class="num">${f.qty}</dd>`).join('')}</dl></section>
    </div></div>`;
}
function homeRight(h) {
  const tool = (act, name, sub, off = false) => `<button class="hm-tool" type="button" data-act="${act}" ${off ? 'disabled' : ''}>
    <span class="hm-tt"><b>${name}</b><small class="num">${esc(sub)}</small></span><span class="hm-chev" aria-hidden="true">›</span></button>`;
  const open = !!S.shift;
  return `<aside class="hm-tools" aria-label="Menu kasir">
    <button class="hm-sell" type="button" data-act="sell" ${open ? '' : 'disabled'}>Mode penjualan<small>${S.items.length ? 'Lanjutkan pesanan' : 'Mulai pesanan baru'}</small></button>
    <span class="hm-sec">Kasir</span>
    ${tool('home-cash', 'Kas masuk / keluar', 'Uang masuk atau keluar', !open)}
    ${tool('stock', 'Stok', 'Masuk, keluar, opname')}
    ${tool('home-today', 'Pesanan hari ini', h ? `${h.orders} dibayar` : 'Semua pesanan')}
    ${tool('home-rsv', 'Pesanan di muka', 'Ambil, bayar penuh', !open)}
    ${tool('home-close', 'Tutup shift', 'Hitung laci, cetak rekap', !open)}
    <span class="hm-sec">Presensi staf</span>
    <div class="hm-pair">${tool('qr-absen', 'QR presensi', 'Masuk, pulang')}
    ${tool('qr-istirahat', 'QR istirahat', 'Mulai, selesai')}</div>
    ${canCancel() ? tool('approve', 'Persetujuan', S.asks == null ? 'Batal dan refund' : S.asks ? `${S.asks} menunggu keputusan` : 'Tidak ada yang menunggu') : ''}
    ${canCancel() && h?.drawer != null ? `<p class="small muted num">Laci ${rupiah(h.drawer)}${h.drawer_low ? ' · di bawah modal standar' : ''}</p>` : ''}
  </aside>`;
}
function renderHome() {
  app.innerHTML = `<div class="hm">${homeLeft(S.home)}${homeRight(S.home)}</div>`;
  loadHome();
}
let homeSeq = 0;
async function loadHome() {
  const n = ++homeSeq;
  try {
    // Managers and the owner also see how many void or refund requests wait for them.
    const [h, asks, low] = await Promise.all([rpc('pos_home'), canCancel() ? rpc('pos_void_list').catch(() => null) : null,
      rpc('stock_low').catch(() => null)]);
    if (n !== homeSeq) return;
    S.home = h; S.asks = asks ? asks.length : null; S.low = low;
  } catch (e) {
    if (n !== homeSeq || S.screen !== 'home') return;
    const m = off.isNetError(e) ? 'Tidak ada internet. Angka hari ini muncul lagi saat internet kembali. Penjualan tanpa kartu member tetap bisa lewat Mode penjualan.' : e.message;
    const dash = $('.hm-dash');
    if (!S.home && dash) dash.outerHTML = `<div class="hm-dash"><p class="notice notice-${off.isNetError(e) ? 'warn' : 'error'}" role="alert">${esc(m)}</p></div>`;
    return;
  }
  // Who is clocked in, once attendance is in use; without it the header shows the shift only.
  rpc('att_on_duty').then((d) => { S.duty = (d || []).map((x) => x.name); if (S.screen === 'home') renderBar(); }).catch(() => {});
  if (S.screen !== 'home') return;
  // Keep focus on the button the cashier is on while the figures refresh.
  const at = document.activeElement?.dataset?.act, v = document.activeElement?.dataset?.v;
  app.innerHTML = `<div class="hm">${homeLeft(S.home)}${homeRight(S.home)}</div>`;
  if (at) app.querySelector(`[data-act="${at}"]${v ? `[data-v="${v}"]` : ''}`)?.focus({ preventScroll: true });
}
function tick() {
  if (off.pending() || !S.online) sendQueued().then(() => { if (!S.online && navigator.onLine && !off.pending()) probe(); });
  if (!document.hidden) refreshCatalog();
  if (S.screen !== 'home' || document.hidden) return;
  renderBar();
  if (!$('#tl-dlg')?.open) loadHome();
}

/* Persetujuan: a manager or the owner decides Minta batal requests on the till itself
 * (approvals.js, shared with the old cashier page). Leave and other HR approvals are not here:
 * they stay on the staff website (Glenn, 11 Nov 2026). */
function renderApprove() {
  app.innerHTML = `<section class="hm-stock"><div><button class="tl-link" type="button" data-act="back">← Dashboard</button></div><div class="stack" id="hm-appr"></div></section>`;
  mountApprovals($('#hm-appr'));
}

/* Stok: the till's stock chooser and forms from stock.js. */
/* QR presensi and QR istirahat (Glenn, 12 Nov 2026): the till shows one QR at a time, full size;
 * staff scan it with their own phone on /staf (staf/index.html). The absen QR does Masuk and Pulang, the
 * istirahat QR starts and ends a break (1 hour, late after 5 minutes over). Both rotate
 * (att_qr_token(kind)); a photo sent home stops working. */
let qrTimer = null, qrRun = 0;
// qrRun ends a loop whose token call was still on its way when the cashier switched QR or left.
const stopQr = () => { clearTimeout(qrTimer); qrTimer = null; qrRun++; };
// Printer struk (Glenn, 12 Nov 2026: a till feature, not back office). Pair the Bluetooth
// printer, pick the paper, print a test receipt (no sale is recorded), or forget the printer.
function renderPrinter() {
  const ok = printer.supported(), on = printer.isConnected(), name = printer.current()?.name;
  app.innerHTML = `<section class="tl-solo tl-printer stack" aria-labelledby="tl-pr-t">
    <div><button class="tl-link" type="button" data-act="back">← Dashboard</button></div>
    <h1 id="tl-pr-t" class="tl-title">Printer struk</h1>
    ${!ok ? '<p class="notice notice-warn">Browser ini tidak bisa memakai Bluetooth. Buka kasir dari aplikasi Kasir Hanashuya di tablet.</p>' : ''}
    <div class="tl-paper"><span class="tl-h">Status</span><strong id="tl-pr-state">${on ? `Tersambung ke ${esc(name || 'printer')}` : printer.hasDevice() ? 'Printer dipilih, belum tersambung' : 'Belum ada printer'}</strong></div>
    <div class="tl-paper">
      <span class="tl-h">Kertas printer</span>
      ${['58', '80'].map((w) => `<button type="button" class="tl-chip is-sm${paper() === w ? ' is-on' : ''}" aria-pressed="${paper() === w}" data-act="paper" data-v="${w}">${w} mm</button>`).join('')}
    </div>
    <div class="tl-paper">
      <span class="tl-h">Nota antrian di tablet ini</span>
      ${[['1', 'Cetak'], ['0', 'Jangan cetak']].map(([v, l]) => `<button type="button" class="tl-chip is-sm${(queueDevice() ? '1' : '0') === v ? ' is-on' : ''}" aria-pressed="${(queueDevice() ? '1' : '0') === v}" data-act="queue-device" data-v="${v}">${l}</button>`).join('')}
      <span class="muted small">${S.queueSlip ? 'Aktif dari pemilik.' : 'Dimatikan pemilik di Pengaturan, Nota antrian.'}</span>
    </div>
    <div class="tl-acts">
      <button class="btn tl-btn" type="button" data-act="printer-connect" ${ok ? '' : 'disabled'}>${on ? 'Sambungkan ulang' : 'Sambungkan printer'}</button>
      <button class="btn btn-quiet tl-btn" type="button" data-act="printer-test" ${ok ? '' : 'disabled'}>Cetak struk uji</button>
      <button class="btn btn-quiet tl-btn" type="button" data-act="printer-forget" ${printer.hasDevice() ? '' : 'disabled'}>Lupakan printer</button>
    </div>
    <div class="notice" id="tl-print-msg" hidden></div>
    <p class="muted small">Struk uji tidak tercatat sebagai penjualan. Setelah tersambung, struk dicetak dari layar selesai bayar dan rekap dari Tutup shift.</p>
  </section>`;
}

async function renderQr() {
  stopQr();
  const brk = S.qrKind === 'istirahat';
  // Only the kasir tablet account shows the QR (Glenn, 13 Nov 2026; att_qr_token refuses the rest).
  if (S.me && !S.me.kasir_tablet) {
    app.innerHTML = `<section class="tl-qrpage" aria-labelledby="tl-qr-t">
      <div><button class="tl-link" type="button" data-act="back">← Dashboard</button></div>
      <h1 id="tl-qr-t" class="tl-title">${brk ? 'QR istirahat' : 'QR presensi'}</h1>
      <p class="notice" role="status">QR presensi dan QR istirahat hanya tampil di akun kasir tablet. Tablet ini sedang masuk dengan akun ${esc((S.me.full_name || 'staf').split(' ')[0])}. Keluar, lalu masuk dengan akun kasir tablet dari pemilik.</p>
      <p class="small muted">Akun staf pribadi dipakai untuk scan dari HP masing-masing (${esc(location.host)}/staf).</p>
    </section>`;
    return;
  }
  app.innerHTML = `<section class="tl-qrpage" aria-labelledby="tl-qr-t">
    <div><button class="tl-link" type="button" data-act="back">← Dashboard</button></div>
    <div class="tl-qrkind" role="group" aria-label="Pilih QR">
      <button type="button" class="tl-chip${brk ? '' : ' is-on'}" aria-pressed="${!brk}" data-act="qr-absen">QR presensi</button>
      <button type="button" class="tl-chip${brk ? ' is-on' : ''}" aria-pressed="${brk}" data-act="qr-istirahat">QR istirahat</button></div>
    <h1 id="tl-qr-t" class="tl-title">${brk ? 'QR istirahat' : 'QR presensi'}</h1>
    <p class="muted">${brk ? 'Scan sebelum mulai istirahat dan sesudah kembali. Istirahat 1 jam, terlambat kalau lebih dari 5 menit.'
      : 'Scan saat masuk dan saat pulang. Jam kerja dihitung dari scan ini: 9 jam untuk full-time, 5 jam untuk Kevin.'}</p>
    <div class="tl-qrbig" id="tl-qr" role="img" aria-label="${brk ? 'QR istirahat' : 'QR presensi'}"></div>
    <p class="muted small num" id="tl-qr-count" aria-live="off"></p>
    <div class="notice" id="tl-qr-msg" hidden></div>
    <p class="small muted" id="tl-qr-loc" aria-live="polite"></p>
    <p class="small muted">Buka halaman presensi di HP masing-masing (${esc(location.host)}/staf), masuk dengan akun staf, lalu scan.</p>
  </section>`;
  const run = qrRun;
  const tick = async () => {
    if (S.screen !== 'qr' || run !== qrRun) return;
    let wait = 10;
    try {
      const t = await rpc('att_qr_token', { p_kind: brk ? 'istirahat' : 'absen' });
      if (run !== qrRun || S.screen !== 'qr') return;
      $('#tl-qr').innerHTML = qrSvg(`${location.origin}/staf/#t=${t.token}`);
      $('#tl-qr-count').textContent = `QR berganti setiap ${t.seconds} detik`;
      notice($('#tl-qr-msg'), '');
      wait = Math.max(1, t.expires_in) + 0.3;
    } catch (e) { if (run !== qrRun) return; notice($('#tl-qr-msg'), e.message); }
    qrTimer = setTimeout(tick, wait * 1000);
  };
  tick();
  boothFromTablet(run);
}

// The booth location is this tablet's GPS (Glenn, 14 Nov 2026). Sent each time the QR screen opens;
// staff phones must be near it to clock in. A poor reading (worse than 200 m) is ignored by the server.
async function boothFromTablet(run) {
  const out = () => (run === qrRun && S.screen === 'qr' ? $('#tl-qr-loc') : null);
  if (!navigator.geolocation) { const o = out(); if (o) o.textContent = 'Tablet ini tidak bisa membaca lokasi. Lokasi booth tidak diperbarui.'; return; }
  const pos = await new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
    (e) => res({ error: e.code === 1 ? 'denied' : 'other' }), { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }));
  let o = out(); if (!o) return;
  if (pos.error) {
    o.textContent = pos.error === 'denied'
      ? `Izinkan lokasi untuk aplikasi kasir di tablet ini (Pengaturan > Aplikasi > ${isNative() ? 'Kasir Hanashuya' : 'Chrome'} > Izin > Lokasi), supaya presensi staf bisa dicek ke lokasi booth.`
      : 'Lokasi tablet belum terbaca. Nyalakan lokasi tablet supaya presensi staf bisa dicek ke lokasi booth.';
    return;
  }
  try {
    const r = await rpc('att_tablet_location', { p_lat: pos.lat, p_lng: pos.lng, p_acc: pos.acc });
    o = out(); if (!o) return;
    o.textContent = r.saved ? `Lokasi booth dari GPS tablet ini, akurasi ± ${r.acc_m} m.`
      : `GPS tablet kurang akurat (± ${Math.round(pos.acc)} m), lokasi booth tidak diubah.`;
  } catch (e) { o = out(); if (o) o.textContent = e.message; }
}

async function renderStock() {
  app.innerHTML = `<section class="hm-stock"><div><button class="tl-link" type="button" data-act="back">← Dashboard</button></div><div class="stack" id="hm-stock"></div></section>`;
  // One Stok button (Glenn, 11 Nov 2026): stock.js shows the chooser (Barang masuk, Barang
  // keluar, Stok opname, Riwayat stok opname).
  await staffStock($('#hm-stock'), { part: S.stockMode || 'menu', role: S.role });
}

/* left panel: tiles, the flavour picker, member search and sign-up */
// Category tabs (Glenn, 12 Nov 2026, like VireoPOS): Semua first, then the owner's categories.
// The tab stays while the order is open and goes back to Semua for the next order.
// A category without products on sale today gets no tab.
const tabCats = () => (S.cat.categories || []).filter((c) => (S.cat.products || []).some((p) => p.category_id === c.id));
function tabsHtml() {
  const cats = tabCats();
  if (cats.length < 2) return '';
  const tab = (id, label) => `<button type="button" role="tab" aria-selected="${S.tab === id}" data-act="cat" data-v="${id ?? ''}">${esc(label)}</button>`;
  return `<div class="tabs tl-tabs" role="tablist" aria-label="Kategori produk">${tab(null, 'Semua')}${cats.map((c) => tab(c.id, c.name)).join('')}</div>`;
}

// "Catat sampel" sits at the right end of the category bar (Glenn, 12 Nov 2026), not under "Dilayani oleh".
function barHtml() {
  const busy = S.items.length > 0;
  return `<div class="tl-catbar">${tabsHtml() || '<span></span>'}
    <button class="tl-sample-btn" type="button" data-act="sample-on"${busy ? ' disabled aria-describedby="tl-sample-why"' : ''}>Catat sampel</button>
    ${busy ? '<span class="visually-hidden" id="tl-sample-why">Selesaikan pesanan dulu</span>' : ''}</div>`;
}

// Samples are given per piece: one Mini choux or one Signature, in a flavour (Glenn, 12 Nov 2026).
const SAMPLE_CODES = [['mini8', 'Mini choux'], ['sig1', 'Signature']];
const sampleName = (code) => (SAMPLE_CODES.find(([c]) => c === code) || [, product(code)?.name || code])[1];
function sampleTilesHtml(on) {
  return `<p class="tl-h">Sampel per pcs. Pilih produk, lalu rasa.</p>
    <div class="tl-tiles">${SAMPLE_CODES.filter(([c]) => product(c)).map(([c, n]) => `<button class="tl-tile${on === c ? ' is-on' : ''}" type="button" data-act="tile" data-code="${c}">
      <span class="tl-tile-n">${esc(n)}</span><span class="tl-tile-d">1 pcs</span><span class="tl-tile-p">Sampel</span></button>`).join('')}</div>`;
}
function tilesHtml(on) {
  if (S.sample) return sampleTilesHtml(on);
  if (S.tab != null && !tabCats().some((c) => c.id === S.tab)) S.tab = null;
  const shown = (S.cat.products || []).filter((p) => S.tab == null || p.category_id === S.tab);
  // The paper bag keeps its slim dashed row; every other product, also new ones, is a tile.
  const ps = shown.filter((p) => p.code !== 'bag');
  const extras = shown.filter((p) => p.code === 'bag');
  const showDemo = !S.member || !S.member.has_demography;
  return `${barHtml()}<div class="tl-tiles" role="tabpanel">${ps.map((p) => {
      const [n, d] = splitName(p.name);
      return `<button class="tl-tile${on === p.code ? ' is-on' : ''}" type="button" data-act="tile" data-code="${esc(p.code)}">
        <span class="tl-tile-n">${esc(n)}</span><span class="tl-tile-d">${esc(d)}</span><span class="tl-tile-p num">${rupiah(p.price)}</span></button>`;
    }).join('')}</div>
    ${extras.map((p) => `<button class="tl-extra" type="button" data-act="tile" data-code="${esc(p.code)}"><span>${esc(p.name)}</span><span class="num muted">${rupiah(p.price)}</span></button>`).join('')}
    ${showDemo ? `<div class="tl-demo">
      <p class="tl-h">${S.member ? 'Data pembeli' : 'Pembeli tanpa kartu'} <span class="muted">perkiraan, boleh dilewati</span></p>
      <div class="tl-chips">${GENDERS.map(([v, l]) => `<button type="button" class="tl-chip${S.gender === v ? ' is-on' : ''}" aria-pressed="${S.gender === v}" data-act="gender" data-v="${v}">${l}</button>`).join('')}
        <span class="tl-chips-gap" aria-hidden="true"></span>
        ${AGES.filter(([v]) => !S.member || v !== '<17').map(([v, l]) => `<button type="button" class="tl-chip${S.age === v ? ' is-on' : ''}" aria-pressed="${S.age === v}" data-act="age" data-v="${esc(v)}">${l}</button>`).join('')}</div>
    </div>` : ''}`;
}

function flavourTiles(p, tall) {
  return `<div class="tl-fgrid${tall ? ' is-tall' : ''}">${S.cat.flavours.map((f) => {
    const on = tall ? (S.pick.counts[f.id] || 0) > 0 : S.pick.flavour === f.id;
    return `<button class="tl-ftile${on ? ' is-on' : ''}" type="button" data-act="flavour" data-v="${esc(f.id)}" aria-pressed="${on}">
      <b>${esc(f.label)}</b><span class="num">${rupiah(unitPrice(p, f))}</span>
      ${tall && S.pick.counts[f.id] ? `<span class="tl-cnt num" aria-label="${S.pick.counts[f.id]} ditambahkan">${S.pick.counts[f.id]}</span>` : ''}</button>`;
  }).join('')}</div>`;
}

function renderLeft() {
  const el = $('#tl-left'); if (!el) return;
  el.classList.toggle('is-fit', false);
  if (S.left === 'find' || S.left === 'voucher') return renderFind(el);
  if (S.left === 'join') return renderJoin(el);
  if (S.left === 'flavour' && S.pick && PICKER === 'inplace') {
    const p = product(S.pick.code), [n, d] = splitName(p.name);
    el.innerHTML = `<div class="tl-inl">
      <div class="tl-sh-head"><button class="tl-link" type="button" data-act="pick-close">← Produk</button>
        <span><span class="tl-sh-n">${esc(n)}</span> <span class="muted">${esc(d)} · ${rupiah(p.price)}</span></span></div>
      <p class="tl-h">Pilih rasa. Ketuk sekali untuk menambah 1.</p>
      ${flavourTiles(p, true)}</div>`;
    return;
  }
  el.classList.add('is-fit');
  el.innerHTML = tilesHtml(S.left === 'flavour' ? S.pick?.code : null);
  if (S.left === 'flavour' && S.pick) {
    const p = product(S.pick.code), [n, d] = splitName(p.name);
    const f = flavour(S.pick.flavour);
    el.insertAdjacentHTML('beforeend', `<div class="tl-scrim" data-act="pick-close"></div>
      <div class="tl-sheet" role="dialog" aria-label="Pilih rasa ${esc(p.name)}">
        <div class="tl-sh-head"><span><span class="tl-sh-n">${esc(S.sample ? sampleName(p.code) : n)}</span> <span class="muted">${S.sample ? 'sampel, per pcs' : `${esc(d)} · ${rupiah(p.price)}`}</span></span>
          <button class="tl-link" type="button" data-act="pick-close">Batal</button></div>
        <p class="tl-h">Pilih rasa</p>
        ${flavourTiles(p, false)}
        <div class="tl-add">
          <span class="tl-step is-big"><button type="button" data-act="pick-qty" data-d="-1" aria-label="Kurangi" ${S.pick.qty <= 1 ? 'disabled' : ''}>−</button>
            <output class="num" aria-live="polite">${S.pick.qty}</output>
            <button type="button" data-act="pick-qty" data-d="1" aria-label="Tambah">+</button></span>
          <button class="btn tl-btn" type="button" data-act="pick-add" ${f ? '' : 'disabled'}><span>Tambah</span>${f ? `<span class="num">${S.sample ? `${S.pick.qty} pcs` : rupiah(unitPrice(p, f) * S.pick.qty)}</span>` : ''}</button>
        </div>
      </div>`);
  }
}

function renderFind(el) {
  const forVoucher = S.left === 'voucher';
  el.innerHTML = `<div class="tl-inl tl-find">
    <div class="tl-sh-head"><button class="tl-link" type="button" data-act="find-close">← Produk</button>
      <span class="tl-sh-n">${forVoucher ? 'Voucher kertas' : 'Kartu member'}</span></div>
    <div class="tl-find-grid">
      <div class="stack">
        <button class="btn tl-btn" type="button" id="tl-scan">${forVoucher ? 'Scan QR voucher' : 'Scan QR member'}</button>
        <div class="scan-view tl-cam" id="cam" hidden><video id="video" playsinline muted></video><span class="frame" aria-hidden="true"></span></div>
        <button class="btn btn-quiet btn-block" type="button" id="cam-stop" hidden>Tutup kamera</button>
        <button class="btn btn-quiet btn-block" type="button" id="photo-btn">Scan dari foto</button>
        <input type="file" id="photo" accept="image/*" capture="environment" hidden>
      </div>
      <div class="stack">
        <form id="tl-code-form" class="stack" novalidate>
          <label class="field"><span>${forVoucher ? 'Kode di bawah QR voucher' : 'Tanpa QR: nomor WhatsApp atau kode kartu'}</span>
            <input type="text" id="tl-code" autocomplete="off" autocapitalize="characters" spellcheck="false"
              placeholder="${forVoucher ? 'K7PX-3MQ9' : '0812 3456 7890'}" maxlength="20"></label>
          <button class="btn btn-quiet btn-big" type="submit">${forVoucher ? 'Simpan voucher' : 'Cari'}</button>
        </form>
        <div class="notice" id="tl-find-msg" hidden></div>
        ${forVoucher ? '<p class="muted small">Terima voucher kertasnya dari pembeli dan cocokkan kodenya.</p>' : `
        <button class="btn btn-quiet btn-block" type="button" id="tl-join-this" hidden>Daftarkan nomor ini</button>
        <button class="btn btn-quiet btn-block btn-big" type="button" data-act="join">Daftar member baru di tablet</button>
        <p class="muted small">Belum member dan buru-buru? Lanjutkan saja sebagai pembeli tanpa kartu.</p>`}
      </div>
    </div></div>`;
  $('#tl-scan').addEventListener('click', startCamera);
  $('#cam-stop').addEventListener('click', stopCamera);
  $('#photo-btn').addEventListener('click', () => $('#photo').click());
  $('#photo').addEventListener('change', fromPhoto);
  $('#tl-code-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#tl-code').value;
    if (forVoucher) saveCode(v); else lookup(v);
  });
  $('#tl-join-this')?.addEventListener('click', () => { const v = $('#tl-code').value; S.left = 'join'; renderLeft(); const ph = toPhone(v); if (ph) $('#jf-phone').value = ph.slice(3); });
}

const maxBirth = () => maxBirth17();

function renderJoin(el) {
  el.innerHTML = `<form class="tl-inl tl-join" id="join-form" novalidate>
    <div class="tl-sh-head"><button class="tl-link" type="button" data-act="find">← Cari member</button><span class="tl-sh-n">Daftar member</span></div>
    <p class="muted small">Kasir mengisi datanya. Kartu langsung terbuka di pesanan ini dengan password awal, dan member membuat password sendiri saat pertama masuk.</p>
    <div class="tl-join-grid">
      <label class="field"><span>Nama lengkap ${REQ}</span><input type="text" id="jf-name" autocomplete="off" required></label>
      <label class="field"><span>Nomor WhatsApp aktif ${REQ}</span>
        <span class="phone"><span class="cc" aria-hidden="true">+62</span>
        <input type="tel" id="jf-phone" inputmode="tel" autocomplete="off" placeholder="812 3456 7890" required></span></label>
      <label class="field"><span>Tanggal lahir ${REQ}</span><input type="date" id="jf-birth" autocomplete="off" max="${maxBirth()}" required>
        <span class="hint">Kartu member untuk usia 17 tahun ke atas.</span></label>
      <fieldset class="field"><legend>Jenis kelamin</legend>
        <div class="choices">${GENDER_CHOICES.map(([v, l]) => `<label class="choice"><input type="radio" name="jf-gender" value="${v}"><span>${l}</span></label>`).join('')}</div></fieldset>
    </div>
    <label class="check"><input type="checkbox" id="jf-marketing">
      <span>Pembeli mau dapat info promo Hanashuya lewat WhatsApp. Tanya dulu, centang hanya kalau pembeli setuju.</span></label>
    <div class="notice" id="jf-msg" hidden></div>
    <button class="btn tl-btn" type="submit">Buat kartu dan pakai di pesanan ini</button>
  </form>`;
  $('#join-form').addEventListener('submit', createMember);
  $('#jf-name').focus({ preventScroll: true });
}

/* right panel: served by, member, promos, lines, total */
function stampDots(pos, size) {
  let h = '';
  for (let i = 1; i <= size; i++) h += `<i class="${i <= pos ? 'is-on' : ''}"></i>`;
  return `<span class="tl-dots" role="img" aria-label="${pos} dari ${size} stempel">${h}</span>`;
}

// Promos in the order panel (Glenn, 13 Nov 2026: the panel must fit the tablet with no scrolling):
// at most two one-line rows, the active one first; the rest, and the less common actions
// (voucher kertas, Mulai BOGO, Diskon 50% atas instruksi), sit behind "Promo lainnya".
const curPromoKey = () => (S.promo ? (S.promo.kind === 'stempel' ? `stempel:${S.promo.cycle}:${S.promo.slot}` : `${S.promo.kind}:${S.promo.period ?? 0}`) : null);
function promoList() {
  const m = S.member;
  if (!m) {
    const rows = [...(bogoOn() ? [{ key: 'bogo:0', label: 'BOGO Deals', sub: 'Beli 1 gratis 1, sisa stok hari ini.' }] : []), ...halfRows(), ...ownerPromos(false)];
    return { rows, extras: (bogoOn() ? '' : bogoStartHtml()) + halfAskHtml() };
  }
  const rows = [
    ...(m.vouchers || []).map((v) => ({ key: `${v.kind}:${v.period}`, promo: { kind: v.kind, period: v.period }, label: v.label,
      sub: `${v.title}, sampai ${shortDay(v.ends_on)}${v.kind === 'kode' ? '. Terima voucher kertasnya' : ''}` })),
    ...(m.rewards || []).map((r) => ({ key: `stempel:${r.cycle}:${r.slot}`, promo: { kind: 'stempel', cycle: r.cycle, slot: r.slot }, label: r.label,
      sub: `Hadiah stempel ke-${r.slot}` })),
    // SOP Bab 6 B: only on its days; the server checks the day, the member and once per member.
    ...(S.cat.promos?.tebus_murah_ktp ? [{ key: 'tebus_murah:0', label: 'Tebus Murah Rp1',
      sub: `Mini isi 15 + Rp1 = Mini isi 8. Cek ${S.cat.promos.tebus_murah_ktp} & ulasan Maps.` }] : []),
    ...(bogoOn() ? [{ key: 'bogo:0', label: 'BOGO Deals', sub: 'Beli 1 gratis 1, sisa stok hari ini.' }] : []),
    ...halfRows(),
    ...ownerPromos(true),
  ];
  return { rows, extras: '<button class="tl-mini" type="button" data-act="voucher">Ada voucher kertas?</button>' + (bogoOn() ? '' : bogoStartHtml()) + halfAskHtml() };
}
const promoCompact = (x, cur) => `<div class="tl-prm${cur === x.key ? ' is-on' : ''}"><span class="tl-prm-t"><b>${esc(x.label)}</b><small title="${esc(x.sub)}">${esc(x.sub)}</small></span>
  ${cur === x.key ? '<button class="tl-use" type="button" data-act="promo-off">Batal</button>'
    : `<button class="tl-use" type="button" data-act="promo" data-key="${esc(x.key)}" ${cur ? 'disabled' : ''}>Pakai</button>`}</div>`;
function promoStrip() {
  const { rows, extras } = promoList(), cur = curPromoKey();
  // With the order note open, one row is shown so the panel still fits a 700 px tall tablet.
  const shown = [...rows.filter((x) => x.key === cur), ...rows.filter((x) => x.key !== cur)].slice(0, S.noteOpen || S.note ? 1 : 2);
  const more = rows.length - shown.length;
  return (shown.length ? `<div class="tl-promos">${shown.map((x) => promoCompact(x, cur)).join('')}</div>` : '')
    + (more || extras ? `<button class="tl-mini" type="button" data-act="promo-more">${more ? `${more} promo lainnya` : 'Voucher dan promo lainnya'}</button>` : '');
}
function openPromos() {
  const { rows, extras } = promoList(), cur = curPromoKey();
  sheet({ title: 'Promo dan voucher', body: `${rows.length ? `<div class="tl-promos">${rows.map((x) => promoRow(x, cur)).join('')}</div>` : '<p class="muted">Tidak ada promo yang berlaku sekarang.</p>'}
    ${extras ? `<div class="tl-sheet-x">${extras}</div>` : ''}` });
}
function memberHtml() {
  const m = S.member;
  if (!m) {
    // Scan member first and clear (Glenn, 14 Nov 2026); typing a number is the second button.
    return `<div class="tl-scanrow"><button class="btn tl-scan-btn" type="button" data-act="scan">Scan member</button>
      <button class="btn btn-quiet tl-scan-alt" type="button" data-act="find">Ketik nomor</button></div>${promoStrip()}`;
  }
  return `<div class="tl-member">
      <div class="tl-row"><span class="tl-mname">${esc(m.full_name || m.first_name)}</span><button class="tl-mlink" type="button" data-act="member-clear">Ganti</button></div>
      <div class="tl-row">${stampDots(Math.min(m.position, m.card_size), m.card_size)}<span class="tl-mlink num" aria-label="${m.position} dari ${m.card_size} stempel">${m.position}/${m.card_size} stempel</span></div>
    </div>
    ${m.via === 'nomor' ? '<p class="notice notice-warn tl-mnote">Cek nama: "Atas nama siapa Kak?"</p>' : ''}
    ${m.via === 'daftar' ? `<div class="notice notice-ok tl-new tl-mnote">Kartu baru aktif. Password awal <b class="num start-code">${esc(m.start_code)}</b>
      <a class="btn btn-text" href="${esc(cardWaLink(m))}" target="_blank" rel="noopener">Kirim link kartu ke WhatsApp</a></div>` : ''}
    ${promoStrip()}`;
}

// SOP Bab 6 C: BOGO Deals from 19.00 (settings), or earlier once a manager starts it.
// active is as of the catalogue load; a load from an earlier day says nothing about today.
function timeGate(active, from) {
  if (active && S.catKey.slice(0, 10) === wibDay()) return true;
  const [h, mi] = String(from || '19.00').split('.').map(Number);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const [ch, cm] = t.split(':').map(Number);
  return ch * 60 + cm >= h * 60 + mi;
}
function bogoOn() {
  const p = S.cat?.promos;
  return !!p && timeGate(p.bogo_active, p.bogo_from);
}
// Diskon 50% malam (Glenn, 13 Nov 2026): the box products at half price from malam50_from (19.00).
function malamOn() {
  const p = S.cat?.promos;
  return !!p && p.malam50_from != null && timeGate(p.malam50_active, p.malam50_from);
}
// Both 50% promos count per item. Diskon 50% atas instruksi is there any time, but only when a
// manager or the owner says so: the cashier picks who, and the owner sees it.
function halfRows() {
  const from = S.cat?.promos?.malam50_from || '19.00';
  return [
    ...(malamOn() ? [{ key: 'malam50:0', label: 'Diskon 50% flash sale', sub: `Produk box setengah harga, mulai ${from}.` }] : []),
    ...(S.promo?.kind === 'instruksi50' ? [{ key: 'instruksi50:0', label: S.promo.label || 'Diskon 50% atas instruksi',
      sub: 'Semua produk setengah harga. Tercatat untuk pemilik.' }] : []),
  ];
}
const halfAskHtml = () => (S.promo || !(S.cat?.promos?.instructors || []).length ? ''
  : '<button class="tl-mini" type="button" data-act="half-ask">Diskon 50% atas instruksi</button>');
function askHalf() {
  const who = S.cat.promos.instructors || [];
  ask({
    title: 'Diskon 50% atas instruksi',
    body: `<p class="small muted">Hanya kalau manajer atau pemilik meminta. Semua produk di pesanan ini jadi setengah harga, dan pemilik melihat siapa yang menginstruksikan.</p>
      <span class="tl-h">Diinstruksikan oleh ${REQ}</span>${pickRow('by', who.map((x) => [x.id, x.name]), '')}`,
    confirm: 'Pakai Diskon 50%',
    run: async (f) => {
      const by = f.elements.by.value;
      if (!by) throw new Error('Pilih manajer atau pemilik yang menginstruksikan.');
      S.promo = { kind: 'instruksi50', by, line: null, label: `Diskon 50% instruksi ${who.find((x) => x.id === by)?.name || ''}`.trim() };
      requote();
    },
  });
}
function bogoStartHtml() {
  return S.role === 'manager' || S.role === 'owner'
    ? '<button class="tl-mini" type="button" data-act="bogo-start">Mulai BOGO Deals sekarang</button>' : '';
}
// Promos the owner set up in the owner page, Promo tab (pos_catalog().promos.custom).
// With a card: all of them; without: only those not marked "khusus member".
function ownerPromos(withMember) {
  return (S.cat?.promos?.custom || []).filter((p) => withMember || !p.member_only).map((p) => {
    const sub = [p.kind === 'persen' ? `${p.value}%` : `Potongan ${rupiah(p.value)}`,
      p.products?.length ? p.products.map((c) => product(c)?.name || c).join(', ') : 'semua produk',
      p.min_spend ? `min. ${rupiah(p.min_spend)}` : '', p.time_to ? `sampai ${p.time_to}` : '', p.note || ''].filter(Boolean).join(' · ');
    return { key: `promo:${p.id}`, label: p.name, sub };
  });
}
const promoRow = (x, cur) => `<div class="tl-vch${cur === x.key ? ' is-on' : ''}"><span><b>${esc(x.label)}</b>${esc(x.sub)}</span>
  ${cur === x.key ? '<button class="tl-use" type="button" data-act="promo-off">Batal pakai</button>'
    : `<button class="tl-use" type="button" data-act="promo" data-key="${esc(x.key)}" ${cur ? 'disabled' : ''}>Pakai</button>`}</div>`;

// SOP Bab 5, teknik stamp: when the total is at most Rp20.000 short of the next Rp50.000,
// one more Signature earns one more stamp. Only a hint; staff offer it once.
// Stamps this order earns, with the running bonus period (stamp_boost in pos_catalog, 12 Nov 2026).
// Service charge and PBJT under the total (14 Nov 2026): "Service charge 5% Rp1.000", "PBJT 10% Rp2.100" or "Termasuk PBJT 10%".
const chargesHtml = (r) => chargeRows(r).map(([label, amt]) => `<br><span class="muted small num" style="white-space:nowrap">${esc(label)} ${rupiah(amt)}</span>`).join('');
function earnText(total, per) {
  const base = Math.floor(total / per), b = S.cat.stamp_boost;
  return b && base > 0 ? `${base * b.multiplier} stempel (bonus ${b.multiplier}x)` : `${base} stempel`;
}
function stampTip(total, per) {
  const sig = S.cat.products.find((x) => x.code === 'sig1');
  const gap = (per - (total % per)) % per;
  if (!sig || !total || gap === 0 || gap > sig.price) return '';
  return `<br><span class="small muted">Tambah 1 Signature, jadi ${Math.floor((total + sig.price) / per)} stempel.</span>`;
}

async function startBogo(btn) {
  try {
    btn.disabled = true;
    await rpc('pos_start_bogo');
    S.cat = { ...(await rpc('pos_catalog')), staff: S.cat.staff };
    renderRight();
  } catch (e) { btn.disabled = false; toast(e.message); }
}

function linesHtml() {
  const q = !S.quoting && S.quote ? S.quote : null;
  const pick = needsLine();
  const rows = S.items.map((it, i) => {
    const p = product(it.product), f = flavour(it.flavour);
    const ql = q?.lines?.[i];
    const amount = ql ? ql.line_total - ql.discount : unitPrice(p, f) * it.qty;
    const disc = ql && ql.discount > 0 ? ` · ${esc(q.promo?.label || 'promo')} −${rupiah(ql.discount)}` : '';
    const chosen = S.promo?.line === i + 1;
    return `<div class="tl-line${pick ? ' is-pick' : ''}${chosen ? ' is-chosen' : ''}">
      ${pick ? `<button class="tl-line-pick" type="button" data-act="promo-line" data-i="${i}">Promo untuk ${esc(p.name)}</button>` : ''}
      <b>${esc(p.name)}</b><b class="num">${rupiah(amount)}</b>
      <span class="tl-sub"><span>${esc(f?.label || '')}${disc}</span>
        <span class="tl-step"><button type="button" data-act="qty" data-i="${i}" data-d="-1" aria-label="Kurangi ${esc(p.name)}">−</button>
          <output class="num">${it.qty}</output>
          <button type="button" data-act="qty" data-i="${i}" data-d="1" aria-label="Tambah ${esc(p.name)}">+</button></span></span></div>`;
  });
  const max = bagsMax();
  if (max > 0) {
    const n = freeBags();
    rows.push(`<div class="tl-line"><b>Paper bag gratis</b><b class="num muted">Gratis</b>
      <span class="tl-sub"><span>1 untuk setiap 2 box</span>
        <span class="tl-step"><button type="button" data-act="bags" data-d="-1" aria-label="Kurangi paper bag gratis" ${n <= 0 ? 'disabled' : ''}>−</button>
          <output class="num">${n}</output>
          <button type="button" data-act="bags" data-d="1" aria-label="Tambah paper bag gratis" ${n >= max ? 'disabled' : ''}>+</button></span></span></div>`);
  }
  return rows.join('') || '<p class="tl-empty muted">Belum ada produk. Ketuk produk di kiri.</p>';
}

// Sample quota of this hour (Glenn, 14 Nov 2026: warn only). The owner sets it per weekday and hour in
// Laporan sampel; going over shows a warning and never blocks Simpan sampel.
async function loadSampleQuota() {
  try { S.sampleQuota = await rpc('sample_quota_now'); } catch { S.sampleQuota = null; }
  if (S.sample) renderRight();
}
function sampleQuotaHtml(n) {
  const q = S.sampleQuota; if (!q) return '';
  const hh = String(q.hour).padStart(2, '0') + '.00';
  if (q.quota == null) return `<p class="small muted">Sampel jam ${hh}: ${q.given} pcs sudah diberikan.</p>`;
  const after = q.given + n;
  return `<p class="small">Kuota sampel jam ${hh}: <b class="num">${q.given} dari ${q.quota} pcs</b> sudah diberikan.</p>`
    + (after > q.quota ? `<p class="notice notice-warn" role="status">Melebihi kuota jam ini (${q.quota} pcs). Sampel tetap bisa disimpan.</p>` : '');
}
function renderSampleRight(el) {
  const it = S.sample.items, n = it.reduce((t, x) => t + x.qty, 0);
  el.innerHTML = `
    <div class="tl-served"><span class="tl-h">Diberikan oleh</span><span class="tl-who">${S.cat.staff.map((x) =>
      `<button type="button" class="tl-chip is-sm${S.served === x.id ? ' is-on' : ''}" aria-pressed="${S.served === x.id}" data-act="served" data-v="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</span></div>
    <div class="tl-sample-head"><span><b>Sampel</b><br><span class="muted small">Tidak dijual. Stok choux, vla dan selai berkurang per pcs.</span></span>
      <button class="tl-link" type="button" data-act="sample-off">Batal</button></div>
    ${sampleQuotaHtml(n)}
    <div class="tl-lines">${it.length ? it.map((x, i) => `<div class="tl-line"><b>${esc(sampleName(x.product))}</b><b class="num">${x.qty} pcs</b>
      <span class="tl-sub"><span>${esc(flavour(x.flavour)?.label || '')}</span>
        <span class="tl-step"><button type="button" data-act="sample-qty" data-i="${i}" data-d="-1" aria-label="Kurangi">−</button>
          <output class="num">${x.qty}</output>
          <button type="button" data-act="sample-qty" data-i="${i}" data-d="1" aria-label="Tambah">+</button></span></span></div>`).join('')
      : '<p class="tl-empty muted">Ketuk Mini choux atau Signature di kiri.</p>'}</div>
    <div class="tl-foot">
      <div class="tl-tot"><span class="tl-h">Total sampel</span><span class="tl-big num">${n} pcs</span></div>
      ${!S.online ? '<p class="small muted" role="status">Tidak ada internet. Sampel bisa disimpan setelah internet kembali.</p>' : ''}
      <button class="btn tl-btn" type="button" data-act="sample-save" ${!n || !S.served || !S.online ? 'disabled' : ''}>Simpan sampel</button>
      <p class="notice" id="tl-confirm-msg" hidden></p>
    </div>`;
}
async function saveSample(btn) {
  busy(btn, true, 'Menyimpan…');
  try {
    const r = await rpc('stock_sample', { p_sample: { id: S.sample.id, served_by: S.served, items: S.sample.items } });
    const q = S.sampleQuota, over = !r.repeat && q && q.quota != null && q.given + r.pieces > q.quota;
    toast(r.repeat ? 'Sampel ini sudah tersimpan.' : `Sampel tersimpan: ${r.pieces} pcs.${over ? ' Kuota jam ini terlewati.' : ''}`);
    S.sample = null; S.pick = null; S.left = 'tiles'; render();
  } catch (e) { busy(btn, false); notice($('#tl-confirm-msg'), e.message); }
}
function renderRight() {
  const el = $('#tl-right'); if (!el) return;
  if (S.sample) return renderSampleRight(el);
  const q = !S.quoting && S.quote ? S.quote : null;
  const estimate = S.items.reduce((t, it) => t + unitPrice(product(it.product), flavour(it.flavour)) * it.qty, 0);
  const total = q ? q.total : off.localCharges(S.cat.charges, estimate, false).total;
  const per = S.cat.rupiah_per_stamp || 50000;
  const liveOnly = !S.online && (S.member || S.promo);
  const why = liveOnly ? 'Tidak ada internet. Kartu member dan promo butuh internet. Hapus kartu atau promo untuk menjual tanpa kartu.'
    : !S.served ? 'Pilih siapa yang melayani.'
    : !S.online && S.items.length ? 'Tidak ada internet. Penjualan tanpa kartu tetap bisa. Struknya memakai nomor L dan terkirim saat internet kembali.'
    : '';
  const blocked = liveOnly || !S.served || !S.items.length || S.quoting || !q || S.confirming;
  // The panel fits the screen (13 Nov 2026); only the order lines scroll. Keep their place on re-render
  // and bring a newly added line into view.
  const keep = $('.tl-lines', el)?.scrollTop || 0, added = S.items.length > (el._lines || 0);
  const typing = ['tl-note-in', 'tl-name-in'].includes(document.activeElement?.id) ? document.activeElement.id : null;
  el._lines = S.items.length;
  el.innerHTML = `
    <label class="tl-cname"><span class="tl-h">Pesanan atas nama Kak</span>
      <input type="text" id="tl-name-in" maxlength="40" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Nama pembeli" value="${esc(S.customerName)}"></label>
    <div class="tl-served"><span class="tl-h">Dilayani</span><span class="tl-who" role="group" aria-label="Dilayani oleh">${S.cat.staff.map((x) =>
      `<button type="button" class="tl-chip is-sm${S.served === x.id ? ' is-on' : ''}" aria-pressed="${S.served === x.id}" data-act="served" data-v="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</span></div>
    <div class="tl-mem">${memberHtml()}</div>
    <div class="tl-lines">${linesHtml()}</div>
    ${S.items.length ? noteHtml() : ''}
    <div class="tl-foot">
      ${needsLine() ? '<p class="notice notice-warn" role="status">Ketuk produk yang mendapat promo.</p>'
        : S.quoteErr ? `<p class="notice notice-error" role="alert">${esc(S.quoteErr)}</p>` : ''}
      <div class="tl-tot"><span><span class="tl-h">Total</span>${q?.discount ? `<br><span class="muted small num">Diskon −${rupiah(q.discount)}</span>` : ''}
        ${q ? chargesHtml(q) : ''}
        ${S.member && q ? `<br><span class="tl-earn">Dapat ${earnText(goodsTotal(q), per)}</span>${stampTip(goodsTotal(q), per)}` : ''}</span>
        <span class="tl-big num${q ? '' : ' is-stale'}">${rupiah(total)}</span></div>
      ${why ? `<p class="small muted" role="status">${esc(why)}</p>` : ''}
      <button class="btn tl-btn" type="button" data-act="confirm" ${blocked ? 'disabled' : ''}${S.confirming ? ' aria-busy="true"' : ''}>${S.confirming ? 'Mengonfirmasi…' : 'Konfirmasi pesanan'}</button>
      <p class="notice" id="tl-confirm-msg" hidden></p>
    </div>`;
  const ln = $('.tl-lines', el); if (ln) ln.scrollTop = keep;
  if (added && ln) ln.scrollTop = ln.scrollHeight;
  if (typing) { const t = $('#' + typing); if (t) { t.focus({ preventScroll: true }); t.setSelectionRange(t.value.length, t.value.length); } }
}
// Catatan pesanan (Glenn, 13 Nov 2026): optional, typed before Konfirmasi, printed on the receipt.
// Closed by default so the fast path stays one tap.
function noteHtml() {
  if (!S.noteOpen && !S.note) return '<button class="tl-mini tl-note-add" type="button" data-act="note-open">Tambah catatan pesanan</button>';
  return `<label class="field tl-note"><span>Catatan pesanan <span class="hint" id="tl-note-left">${NOTE_MAX - S.note.length} huruf lagi</span></span>
    <textarea id="tl-note-in" rows="1" maxlength="${NOTE_MAX}" placeholder="Contoh: tulis Selamat ulang tahun di kotak">${esc(S.note)}</textarea></label>`;
}

/* ---------------------------------------------------------------- payment screens */
function summaryHtml(r) {
  const who = [r.customer_name ? `Atas nama Kak ${r.customer_name}` : '', r.member ? `member ${r.member}` : 'Tanpa kartu member', r.served_by ? `dilayani ${r.served_by}` : ''].filter(Boolean).join(' · ');
  const per = S.cat.rupiah_per_stamp || 50000;
  return `<div class="tl-h">${esc(who)}</div>
    <div class="tl-lines">${r.lines.map((l) => `<div class="tl-line"><b>${esc(l.name)}</b><b class="num">${l.free_bag ? 'Gratis' : rupiah(l.line_total - (l.discount || 0))}</b>
      <span class="tl-sub"><span>${esc([l.flavour, l.discount > 0 ? (r.promo_label || 'promo') : ''].filter(Boolean).join(' · '))}</span><span class="num">${l.qty}×</span></span></div>`).join('')}</div>
    ${r.note ? `<p class="tl-onote"><span class="tl-h">Catatan</span> ${esc(r.note)}</p>` : ''}
    <div class="tl-tot"><span><span class="tl-h">Total</span>${chargesHtml(r)}${r.member ? `<br><span class="tl-earn">Dapat ${r.status === 'dibayar' ? `${r.stamps} stempel` : earnText(goodsTotal(r), per)}</span>` : ''}</span>
      <span class="tl-big num">${rupiah(r.total)}</span></div>`;
}

function cashOptions(total) {
  const out = [];
  for (const step of [10000, 50000, 100000]) {
    const v = Math.ceil(total / step) * step;
    if (v > total && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 3);
}

function renderPay() {
  const r = S.placed;
  const inv = `<div class="tl-inv"><span><span class="tl-h">No. invoice</span><br><span class="tl-no num">${esc(r.receipt_no)}</span></span>
    <span class="muted">${esc(r.time || '')} · ${esc(r.channel_label || 'Di booth')}</span></div>`;
  const lock = r.offline ? '<p class="small muted">Tidak ada internet. Pesanan ini tersimpan di tablet setelah dibayar.</p>'
    // Once confirmed, staff can't cancel or ask to cancel here (Glenn, 14 Nov 2026); only a manager
    // or the owner signed in on the till sees Batalkan pesanan.
    : canCancel() ? `<div class="tl-lock"><span>Pesanan sudah dikonfirmasi. Hanya manajer atau pemilik yang bisa membatalkan.</span>
    <button class="tl-use" type="button" data-act="cancel-order">Batalkan pesanan</button></div>`
    : '';
  let left = '';
  if (S.screen === 'method') {
    left = r.total === 0 ? `${inv}
      <p class="tl-h is-lead">Pesanan ini gratis dengan promo</p>
      <button class="btn tl-btn" type="button" data-act="pay-free">Selesai</button>
      <div class="notice" id="tl-pay-msg" hidden></div>
      <button class="btn btn-quiet tl-btn" type="button" data-act="edit-order">Kembali ke pesanan</button>${lock}`
      : `${inv}
      <p class="tl-h is-lead">Pilih cara bayar</p>
      <div class="tl-methods">
        <button class="tl-mth" type="button" data-act="to-cash"><span class="tl-ic" aria-hidden="true">Rp</span>Tunai<small>Hitung kembalian</small></button>
        <button class="tl-mth" type="button" data-act="to-qris"><span class="tl-ic" aria-hidden="true">QR</span>QRIS<small>Tampilkan QRIS Hanashuya</small></button>
      </div>
      ${r.offline ? '' : '<button class="tl-mini" type="button" data-act="to-split">Split payment: sebagian Tunai, sisanya QRIS</button>'}
      <div class="notice" id="tl-pay-msg" hidden></div>
      <button class="btn btn-quiet tl-btn" type="button" data-act="edit-order">Kembali ke pesanan</button>${lock}`;
  } else if (S.screen === 'split') {
    // Bayar 2 cara (Glenn, 13 Nov 2026): the Tunai part first, the rest by QRIS. The change comes
    // only from the Tunai part.
    const sp = S.split || (S.split = { tunai: null, cash: null });
    const opts = [10000, 20000, 50000, 100000].filter((v) => v < r.total);
    left = `${inv}
      <p class="tl-h is-lead">Split payment · sebagian Tunai, sisanya QRIS</p>
      <div class="tl-quick">${opts.map((v) => `<button type="button" class="tl-q num${sp.tunai === v ? ' is-on' : ''}" data-act="sp-t" data-v="${v}">Tunai ${rupiah(v)}</button>`).join('')}</div>
      <div class="tl-sp-grid">
        <label class="field"><span>Bagian tunai</span>
          ${moneyField(`id="tl-sp-t" placeholder="atau ketik jumlahnya" value="${sp.tunai == null ? '' : sp.tunai.toLocaleString('id-ID')}"`)}</label>
        <label class="field"><span>Uang tunai diterima <span class="hint">kosongkan kalau uang pas</span></span>
          ${moneyField(`id="tl-sp-c" placeholder="sama dengan bagian tunai" value="${sp.cash == null ? '' : sp.cash.toLocaleString('id-ID')}"`)}</label>
      </div>
      <div id="tl-sp-sum">${splitSum(r.total)}</div>
      <div class="notice" id="tl-pay-msg" hidden></div>
      <div class="tl-row2"><button class="btn btn-quiet tl-btn" type="button" data-act="to-method">Kembali</button>
        <button class="btn tl-btn" type="button" data-act="split-qris" id="tl-sp-go" ${splitOk(r.total) ? '' : 'disabled'}>Lanjut ke QRIS</button></div>`;
  } else if (S.screen === 'qris') {
    const sp = S.split, part = sp ? r.total - sp.tunai : r.total;
    // QRIS as big as the screen allows (Glenn, 14 Nov 2026): the invoice number moves beside it
    // and the order summary on the right gets narrower.
    left = `<div class="tl-qrlay">
        <div class="tl-qrbox"><img id="tl-qris" src="${QRIS_IMG}" alt="QRIS Hanashuya Bakehouse, Papaya Bandung">
          <p class="tl-qr-missing" hidden>Gambar QRIS belum dipasang. Minta pemilik mengirim file QRIS-nya.</p></div>
        <div class="tl-qrside">
          <span><span class="tl-h">No. invoice</span><br><span class="tl-no num">${esc(r.receipt_no)}</span></span>
          <span class="tl-h">${sp ? 'Sisa lewat QRIS' : 'Total'}</span>
          <span class="tl-amt num">${rupiah(part)}</span>
          ${sp ? `<span class="small num">Tunai ${rupiah(sp.tunai)} · diterima ${rupiah(sp.cash ?? sp.tunai)} · kembali ${rupiah((sp.cash ?? sp.tunai) - sp.tunai)}</span>` : ''}
          <span class="muted">Minta Kakak scan. Tekan Pembayaran sudah masuk hanya setelah pembayarannya masuk di GoPay Merchant.</span>
          <label class="field"><span>No. referensi GoPay <span class="hint">boleh dikosongkan</span></span>
            <input type="text" id="tl-qris-ref" maxlength="40" autocomplete="off" placeholder="Contoh: 4 angka terakhir"></label>
          <div class="notice" id="tl-pay-msg" hidden></div>
          <button class="btn tl-btn" type="button" data-act="pay-qris">Pembayaran sudah masuk</button>
          ${sp ? '<button class="btn btn-quiet tl-btn" type="button" data-act="to-split">Ubah pembagian</button>'
            : '<button class="btn btn-quiet tl-btn" type="button" data-act="to-cash">Ganti ke Tunai</button>'}
          <button class="btn btn-quiet tl-btn" type="button" data-act="edit-order">Kembali ke pesanan</button>
        </div>
      </div>`;
  } else {
    const cash = S.cash, opts = cashOptions(r.total);
    const enough = cash != null && cash >= r.total;
    left = `${inv}
      <p class="tl-h is-lead">Tunai · uang diterima</p>
      <div class="tl-quick">
        <button type="button" class="tl-q num${cash === r.total ? ' is-on' : ''}" data-act="cash" data-v="${r.total}">Uang pas</button>
        ${opts.map((v) => `<button type="button" class="tl-q num${cash === v ? ' is-on' : ''}" data-act="cash" data-v="${v}">${rupiah(v)}</button>`).join('')}
      </div>
      <label class="tl-cashfield"><span class="visually-hidden">Uang diterima</span>
        ${moneyField(`id="tl-cash-in" placeholder="ketik jumlah lain" value="${cash == null ? '' : cash.toLocaleString('id-ID')}"`)}</label>
      <div class="tl-chg${enough ? '' : ' is-short'}" id="tl-chg">${chgHtml(cash, r.total)}</div>
      <p class="tl-chg-hint" id="tl-chg-hint" role="status">${shortHint(cash, r.total)}</p>
      <div class="notice" id="tl-pay-msg" hidden></div>
      <div class="tl-row2"><button class="btn btn-quiet tl-btn" type="button" data-act="to-qris">Ganti ke QRIS</button>
        <button class="btn tl-btn" type="button" data-act="pay-cash" id="tl-pay-cash" ${enough ? '' : 'disabled'}>Selesai</button></div>`;
  }
  app.innerHTML = `<div class="tl-pay${S.screen === 'qris' ? ' is-qris' : ''}"><section class="tl-pl" aria-label="Pembayaran">${left}</section>
    <section class="tl-pr" aria-label="Ringkasan pesanan">${summaryHtml(r)}</section></div>`;
  const img = $('#tl-qris');
  if (img) {
    const missing = () => { img.hidden = true; $('.tl-qr-missing').hidden = false; };
    img.addEventListener('error', missing);
    if (img.complete && !img.naturalWidth) missing();
  }
  const st = $('#tl-sp-t'), sc = $('#tl-sp-c');
  if (st) {
    const sync = () => {
      S.split.tunai = money(st); S.split.cash = money(sc);
      $('#tl-sp-sum').innerHTML = splitSum(r.total);
      $('#tl-sp-go').disabled = !splitOk(r.total);
      document.querySelectorAll('[data-act="sp-t"]').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.v) === S.split.tunai));
    };
    st.addEventListener('input', sync); sc.addEventListener('input', sync);
  }
  const ci = $('#tl-cash-in');
  if (ci) {
    ci.addEventListener('input', () => {
      S.cash = money(ci);
      const ok = S.cash != null && S.cash >= r.total;
      $('#tl-chg').innerHTML = chgHtml(S.cash, r.total);
      $('#tl-chg').classList.toggle('is-short', !ok);
      $('#tl-chg-hint').textContent = shortHint(S.cash, r.total);
      $('#tl-pay-cash').disabled = !ok;
      document.querySelectorAll('.tl-q').forEach((b) => b.classList.toggle('is-on', Number(b.dataset.v) === S.cash));
    });
  }
}
// Bayar 2 cara: the Tunai part is above Rp0 and below the total; cash covers it.
function splitOk(total) {
  const sp = S.split; if (!sp) return false;
  const t = sp.tunai, c = sp.cash ?? t;
  return t != null && t > 0 && t < total && c >= t;
}
function splitSum(total) {
  const sp = S.split || {}, t = sp.tunai, c = sp.cash ?? t;
  if (t == null) return '<p class="small muted">Isi berapa yang dibayar tunai. Sisanya dibayar lewat QRIS.</p>';
  if (t <= 0 || t >= total) return `<p class="tl-chg-hint" role="status">Bagian tunai harus di antara Rp0 dan total ${rupiah(total)}. Kalau semuanya tunai, pilih Tunai saja.</p>`;
  return `<div class="tl-sp-grid"><div class="tl-chg is-qris"><span>QRIS</span><b class="num">${rupiah(total - t)}</b></div>
    <div class="tl-chg${c >= t ? '' : ' is-short'}">${chgHtml(c, t)}</div></div>
    <p class="tl-chg-hint" role="status">${c < t ? `Minta ${rupiah(t - c)} lagi untuk bagian tunai.` : ''}</p>`;
}
// What to do when the cash handed over is short (Glenn, 12 Nov 2026).
const shortHint = (cash, total) => (cash != null && cash < total ? `Minta ${rupiah(total - cash)} lagi, atau ganti ke QRIS.` : '');
function chgHtml(cash, total) {
  if (cash == null) return '<span>Kembalian</span><b class="num">–</b>';
  return cash >= total ? `<span>Kembalian</span><b class="num">${rupiah(cash - total)}</b>` : `<span>Kurang</span><b class="num">${rupiah(total - cash)}</b>`;
}

async function placeOrder(btn) {
  const msg = $('#tl-confirm-msg');
  if (S.confirming) return;
  if (!S.online) return placeOffline();
  // Locked while it is on its way: a tile tapped now would not be in the order (13 Nov 2026).
  S.confirming = true;
  busy(btn, true, 'Mengonfirmasi…');
  try {
    const r = await rpc('pos_place_order', { p_order: orderPayload() });
    S.confirming = false;
    stopCamera();
    S.placed = r;
    if (r.status === 'dibayar') { S.paid = r; S.screen = 'done'; }
    else if (r.status === 'batal') { toast(`Pesanan ${r.receipt_no} sudah dibatalkan.`); resetOrder(); return; }
    else S.screen = 'method';
    render();
  } catch (e) {
    S.confirming = false;
    busy(btn, false);
    // The line dropped as the cashier confirmed: a walk-in carries on offline under the same id.
    // If the order did reach the server, pos_checkout settles it there and keeps the L number.
    if (off.isNetError(e) && !S.member && !S.promo) { S.online = true; markOffline(); return placeOffline(); }
    renderRight();
    notice($('#tl-confirm-msg') || msg, e.message);
  }
}
// Ubah pesanan before payment (Glenn, 14 Nov 2026): the confirmed, unpaid order is closed on the
// server (pos_edit_order, logged) and the cart comes back as it was, under a new order id so the
// changed order gets its own invoice number when it is confirmed again. Offline orders were never
// sent, so they just go back.
async function editOrder(btn) {
  if (!S.placed) return;
  if (S.placed.offline) { S.placed = null; S.split = null; S.screen = 'order'; render(); return; }
  busy(btn, true, 'Membuka pesanan…');
  try {
    await rpc('pos_edit_order', { p_id: S.placed.id });
    S.orderId = newId(); S.placed = null; S.split = null; S.cash = null;
    S.screen = 'order'; render(); requote();
  } catch (e) {
    busy(btn, false);
    const m = $('#tl-pay-msg');
    if (m) notice(m, e.message, 'error'); else toast(e.message);
  }
}
function placeOffline() {
  stopCamera();
  const quote = off.localQuote(S.cat, S.items, freeBags());
  const served = S.cat.staff.find((x) => x.id === S.served);
  // Ubah pesanan keeps the same order id, so it keeps its L number too: no gaps in the series.
  S.localNo = S.localNo || off.nextLocalNo();
  S.placed = off.localReceipt({ id: S.orderId, localNo: S.localNo, quote, servedBy: served?.name });
  S.placed.quote = quote;
  S.placed.note = S.note.trim() || null;
  S.placed.customer_name = S.customerName.trim() || null;
  S.screen = 'method';
  render();
}

async function pay(btn, payment) {
  const msg = $('#tl-pay-msg');
  const at = new Date().toISOString();
  if (S.placed.offline) return payOffline(btn, msg, payment, at);
  busy(btn, true, 'Menyimpan…');
  try {
    const r = await rpc('pos_pay', { p_id: S.placed.id, p_payment: payment, p_client_at: at });
    S.paid = r; S.screen = 'done';
    if (navigator.vibrate) navigator.vibrate(40);
    render();
  } catch (e) {
    busy(btn, false);
    // Confirmed online, then the line dropped: the order waits on the server, so send the
    // payment later with pos_checkout (same id; a payment that did arrive is not counted twice).
    if (off.isNetError(e)) {
      const split = payment.method === 'campur';
      const r = { ...S.placed, status: 'dibayar', offline: true, payment_method: S.placed.total === 0 ? 'gratis' : payment.method,
        cash_received: payment.method === 'tunai' || split ? payment.cash : null,
        change: payment.method === 'tunai' ? payment.cash - S.placed.total : split ? payment.cash - payment.tunai : null,
        payments: split ? [{ method: 'qris', amount: payment.qris }, { method: 'tunai', amount: payment.tunai }] : [],
        stamps: 0, card: null, new_rewards: null, sold_at: at };
      if (!off.enqueue({ id: S.placed.id, payment, client_at: at }, r)) { notice(msg, 'Tablet tidak bisa menyimpan penjualan. Coba lagi.'); return; }
      markOffline();
      S.paid = r; S.screen = 'done'; render(); return;
    }
    if (msg) notice(msg, e.message); else toast(e.message);
  }
}
function payOffline(btn, msg, payment, at) {
  const p = S.placed, quote = p.quote;
  const order = { ...orderPayload(), ticket: null, promo: null, local_no: p.local_no, expect_total: quote.total, payment, client_at: at };
  const r = off.localReceipt({ id: p.id, localNo: p.local_no, quote, servedBy: p.served_by, payment, soldAt: at });
  r.note = p.note || null;
  if (!off.enqueue(order, r)) { notice(msg, 'Tablet tidak bisa menyimpan penjualan. Coba lagi.'); return; }
  S.paid = r; S.screen = 'done';
  if (navigator.vibrate) navigator.vibrate(40);
  render();
  sendQueued();
}

/* ---------------------------------------------------------------- done */
function renderDone() {
  const r = S.paid;
  const pay = r.payment_method === 'tunai' ? `Tunai ${rupiah(r.cash_received)} · kembali ${rupiah(r.change)}`
    : r.payment_method === 'campur' ? `QRIS ${rupiah(partOf(r, 'qris'))} · Tunai ${rupiah(partOf(r, 'tunai'))}, diterima ${rupiah(r.cash_received)}, kembali ${rupiah(r.change)}`
    : `${METHOD[r.payment_method] || ''} ${rupiah(r.total)}`;
  const card = r.card ? ` Kartunya ${Math.min(r.card.position, r.card.size)} dari ${r.card.size}.` : '';
  app.innerHTML = `<section class="tl-done" aria-labelledby="tl-done-t" tabindex="-1" id="tl-done">
    <span class="tl-h num">${esc(r.receipt_no)} · ${esc(pay)}</span>
    <h1 class="tl-ok" id="tl-done-t">Pembayaran diterima</h1>
    <p class="muted">${r.offline ? (r.member ? `Stempel Kak ${esc(r.member)} masuk saat penjualan ini terkirim.` : 'Penjualan tanpa kartu member.')
      : r.member ? `Kak ${esc(r.member)} dapat ${r.stamps} stempel.${card}` : 'Penjualan tanpa kartu member.'}</p>
    ${r.offline ? '<p class="notice notice-warn" role="status">Tersimpan di tablet. Terkirim otomatis saat internet kembali.</p>' : ''}
    ${r.note ? `<p class="tl-onote"><span class="tl-h">Catatan</span> ${esc(r.note)}</p>` : ''}
    ${r.new_rewards?.length ? `<p class="notice notice-ok">Hadiah baru: ${esc(r.new_rewards.join(', '))}. Bisa dipakai di kunjungan berikutnya.</p>` : ''}
    <div class="tl-acts">
      ${queueOn() ? '<button class="btn btn-quiet tl-btn" type="button" data-act="print-queue">Cetak nota antrian</button>' : ''}
      <button class="btn btn-quiet tl-btn" type="button" data-act="print">Cetak struk</button>
      <button class="btn tl-btn" type="button" data-act="new">Pesanan baru</button>
    </div>
    <div class="notice" id="tl-print-msg" hidden></div>
    <div class="tl-paper">
      <span class="tl-h">Kertas printer</span>
      ${['58', '80'].map((w) => `<button type="button" class="tl-chip is-sm${paper() === w ? ' is-on' : ''}" aria-pressed="${paper() === w}" data-act="paper" data-v="${w}">${w} mm</button>`).join('')}
      <button class="tl-link" type="button" data-act="printer-forget">Pilih printer lain</button>
    </div>
  </section>`;
  $('#tl-done').focus();
}

async function printQueue(r, btn, msg) {
  const say = (t, k = 'ok') => notice(msg, t, k);
  busy(btn, true, 'Mencetak…');
  try {
    const p = await printer.print(queueSlipBytes(r, { dots: paper() === '80' ? 576 : 384 }), (t) => say(t));
    say(`Nota antrian ${r.customer_name ? 'Kak ' + r.customer_name : r.receipt_no} terkirim ke ${p.name}.`);
  } catch (e) {
    if (e && e.name === 'NotFoundError') { printer.forget(); say('Tidak ada printer yang dipilih.', 'warn'); }
    else say(e.message || String(e), 'error');
  } finally { busy(btn, false); }
}

async function printReceipt(r, btn, msg) {
  const say = (t, k = 'ok') => notice(msg, t, k);
  busy(btn, true, 'Mencetak…');
  try {
    const f = await fastReceipt(r, { dots: paper() === '80' ? 576 : 384 });
    const p = await printer.print(f.bytes, (t) => say(t));
    say(`Struk ${r.receipt_no} terkirim ke ${p.name}.`);
  } catch (e) {
    if (e && e.name === 'NotFoundError') { printer.forget(); say('Tidak ada printer yang dipilih.', 'warn'); }
    else say(e.message || String(e), 'error');
  } finally { busy(btn, false); }
}

// Kirim struk WhatsApp lives in Riwayat transaksi only (Glenn, 14 Nov 2026: not needed after
// every sale). box shows the fallback (image saved, then attach it in WhatsApp); msg shows errors.
async function shareReceipt(r, btn, box, msg) {
  busy(btn, true, 'Menyiapkan…');
  try {
    const blob = await receiptBlob(r);
    const file = new File([blob], `struk-${r.receipt_no}.png`, { type: 'image/png' });
    if (await shareNative(blob, file.name, `Struk ${r.receipt_no}`)) { /* shared from the Android app */ }
    else if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `Struk ${r.receipt_no}` });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = file.name;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      notice(box, `Gambar struk ${r.receipt_no} tersimpan di tablet. Lampirkan di WhatsApp.`, 'ok');
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    notice(msg, e.message || 'Struk gagal dibuat. Coba lagi.');
  } finally { busy(btn, false); }
}

/* ---------------------------------------------------------------- member */
const cardWaLink = (m) => {
  const text = `Halo Kak ${m.first_name}, kartu member Hanashuya sudah aktif. Buka ${location.origin}/member/ lalu masuk pakai nomor WhatsApp ini dan password awal ${m.start_code}. Setelah masuk, Kakak langsung diminta membuat password sendiri.`;
  return `https://wa.me/${String(m.whatsapp || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
};
const voucherFromScan = (raw) => (String(raw || '').match(/\/v\/([A-Za-z0-9-]{8,9})\b/) || [])[1]?.toUpperCase().replace(/-/g, '') || null;
const looksLikePhone = (raw) => /^\+?[\d\s().-]+$/.test(raw.trim()) && raw.replace(/\D/g, '').length >= 9;

function setMember(m) {
  const keepStart = S.member?.start_code;
  S.member = { ...m, start_code: m.start_code || keepStart };
  if (!S.customerName.trim()) S.customerName = m.first_name || String(m.full_name || '').split(' ')[0] || '';
  if (m.whatsapp) S.memberPhone = m.whatsapp;
  if (m.rupiah_per_stamp) S.cat.rupiah_per_stamp = m.rupiah_per_stamp;
  S.promo = null;
  stopCamera();
  S.left = 'tiles';
  renderLeft();
  requote();
  if (S.waitingCode) { const k = S.waitingCode; S.waitingCode = null; saveCode(k); }
}

async function lookup(raw) {
  const msg = $('#tl-find-msg'), join = $('#tl-join-this');
  notice(msg, ''); if (join) join.hidden = true;
  if (!raw || !raw.trim()) { notice(msg, 'Tulis nomor WhatsApp member, atau kode kartu dari layar member.'); return; }
  const vk = voucherFromScan(raw);
  if (vk) {
    if (S.member) return saveCode(vk);
    S.waitingCode = vk;
    notice(msg, `QR voucher ${vk.slice(0, 4)}-${vk.slice(4)} terbaca. Sekarang scan QR member, voucher langsung masuk ke kartunya.`, 'ok');
    return;
  }
  const phone = looksLikePhone(raw);
  try {
    const m = phone ? await rpc('staff_find_phone', { p_phone: raw }) : await rpc('staff_lookup', { p_scan: raw });
    if (phone) S.memberPhone = toPhone(raw);
    setMember(m);
  } catch (e) {
    const unknown = phone && /belum terdaftar/i.test(e.message);
    notice(msg, e.message, unknown ? 'warn' : 'error');
    if (join) join.hidden = !unknown;
  }
}

async function saveCode(raw) {
  const msg = $('#tl-find-msg');
  const say = (t, k) => (msg ? notice(msg, t, k) : toast(t));
  const k = (voucherFromScan(raw) || String(raw || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (k.length !== 8) { say('Kode voucher terdiri dari 8 huruf dan angka, misalnya K7PX-3MQ9.'); return; }
  if (!S.member) { S.waitingCode = k; say('Scan kartu member dulu, voucher langsung masuk ke kartunya.', 'warn'); return; }
  try {
    const r = await rpc('staff_claim_code', { p_ticket: S.member.ticket, p_code: k });
    if (r.status !== 'tersimpan' && r.status !== 'sudah') { say(`Voucher ditolak. ${r.message}`, 'warn'); return; }
    setMember(r);
    toast(r.status === 'sudah' ? 'Voucher sudah ada di kartu ini. Tekan Pakai.' : 'Voucher diterima. Tekan Pakai.');
  } catch (e) { say(e.message); }
}

async function createMember(e) {
  e.preventDefault();
  const form = e.currentTarget, msg = $('#jf-msg'), btn = $('button[type="submit"]', form);
  const name = $('#jf-name').value.trim(), birth = $('#jf-birth').value, phone = toPhone($('#jf-phone').value);
  const gender = $('input[name="jf-gender"]:checked')?.value || '';
  const fail = (text, id) => { notice(msg, text); if (id) $('#' + id).focus(); };
  if (!name) return fail('Isi nama lengkap.', 'jf-name');
  if (!phone) return fail('Tulis nomor WhatsApp yang aktif, misalnya 0812 3456 7890.', 'jf-phone');
  if (!birth) return fail('Isi tanggal lahir.', 'jf-birth');
  if (birth > maxBirth()) return fail('Kartu member hanya untuk usia 17 tahun ke atas.', 'jf-birth');
  notice(msg, '');
  busy(btn, true, 'Membuat kartu…');
  try {
    const m = await rpc('staff_create_member', { p_name: name, p_birth_date: birth, p_phone: phone, p_gender: gender, p_marketing: $('#jf-marketing').checked });
    S.memberPhone = phone;
    form.reset();
    setMember(m);
    toast(`Kartu ${m.first_name} sudah aktif`);
  } catch (err) { busy(btn, false); fail(err.message); }
}

/* QR reading, as on the old cashier page (jsQR from jsDelivr) */
let stream = null, scanning = false;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembaca QR gagal dimuat. Periksa internet, atau ketik kodenya.'));
    document.head.append(s);
  });
}
const scanned = (raw) => (S.left === 'voucher' ? saveCode(raw) : lookup(raw));
async function startCamera() {
  const msg = $('#tl-find-msg');
  notice(msg, '');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice(msg, 'Kamera hanya bisa dipakai lewat https atau localhost. Pakai Scan dari foto atau ketik kodenya.', 'warn');
    return;
  }
  try {
    await loadJsQR();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    notice(msg, e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan kamera di browser, atau pakai Scan dari foto.' : e.message);
    return;
  }
  const v = $('#video');
  if (!v) { stopCamera(); return; }
  v.srcObject = stream;
  await v.play();
  $('#cam').hidden = false; $('#cam-stop').hidden = false;
  scanning = true;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!scanning) return;
    if (v.readyState >= 2) {
      const w = Math.min(v.videoWidth, 720), h = Math.round(v.videoHeight * (w / v.videoWidth));
      canvas.width = w; canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const hit = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (hit && hit.data) { stopCamera(); if (navigator.vibrate) navigator.vibrate(60); scanned(hit.data); return; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stopCamera() {
  scanning = false;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  const cam = $('#cam'); if (cam) { cam.hidden = true; $('#cam-stop').hidden = true; }
}
async function fromPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const msg = $('#tl-find-msg');
  try {
    await loadJsQR();
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const hit = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    if (!hit) { notice(msg, 'QR tidak terbaca di foto itu. Foto lebih dekat dan tegak, atau ketik kodenya.'); return; }
    scanned(hit.data);
  } catch (err) { notice(msg, err.message); }
}

/* ---------------------------------------------------------------- dialogs */
// A read-only sheet with a Tutup button. Buttons inside with data-act run the till's usual
// tap handler (onTap) and close the sheet first, so the same actions work from here.
function sheet({ title, body, actions = '' }) {
  let d = $('#tl-dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'tl-dlg'; d.className = 'tl-dlg'; document.body.append(d); }
  d.innerHTML = `<div class="stack tl-info"><h2>${esc(title)}</h2>${body}
    <div class="tl-row2"><button class="btn btn-quiet tl-btn" type="button" data-close>Tutup</button>${actions}</div></div>`;
  d.querySelector('[data-close]').addEventListener('click', () => d.close());
  d.querySelector('.tl-info').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    d.close(); onTap(e);
  });
  d.showModal();
}
// A small modal form. run(form) does the work; an error stays in the dialog.
function ask({ title, body, confirm, run }) {
  let d = $('#tl-dlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'tl-dlg'; d.className = 'tl-dlg'; document.body.append(d); }
  d.innerHTML = `<form method="dialog" class="stack" novalidate>
    <h2>${esc(title)}</h2>${body}
    <p class="notice" id="tl-dlg-msg" hidden></p>
    <div class="tl-row2"><button class="btn btn-quiet tl-btn" type="button" value="no">Kembali</button><button class="btn tl-btn" type="submit">${esc(confirm)}</button></div></form>`;
  const form = $('form', d);
  $('button[value="no"]', d).addEventListener('click', () => d.close());
  form.addEventListener('click', (e) => {
    const c = e.target.closest('[data-pick]');
    if (!c) return;
    form.querySelectorAll(`[data-pick="${c.dataset.pick}"]`).forEach((b) => { b.classList.toggle('is-on', b === c); b.setAttribute('aria-pressed', String(b === c)); });
    form.elements[c.dataset.pick].value = c.dataset.v;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    busy(btn, true, 'Menyimpan…');
    try { await run(form); d.close(); }
    catch (err) { busy(btn, false); notice($('#tl-dlg-msg'), err.message); }
  });
  d.showModal();
  form.querySelector('input:not([type="hidden"]), textarea')?.focus();
}
const pickRow = (name, opts, value) => `<input type="hidden" name="${name}" value="${esc(value)}"><div class="tl-chips">${opts.map(([v, l]) =>
  `<button type="button" class="tl-chip${v === value ? ' is-on' : ''}" aria-pressed="${v === value}" data-pick="${name}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>`;
// Required fields say so in bold; optional ones say nothing (Glenn, 11 Nov 2026).
const REQ = '<span class="hint is-req">wajib</span>';
const reasonField = (ph) => `<label class="field"><span>Alasan ${REQ}</span><input type="text" name="reason" maxlength="200" placeholder="${esc(ph)}" required></label>`;
const amount = (form, name) => money(form.elements[name]) ?? 0;

// Minta batal or refund (13 Nov 2026): a batal is always the whole order; a refund picks the
// pieces that come back (all of them to start with) and where the money goes. The amount shown
// is the price paid for those pieces, as the server works it out. A manager or the owner decides.
async function askVoid(order, after) {
  const paid = order.status === 'dibayar';
  let r = order;
  if (paid && !order.lines) {
    try { r = await rpc('pos_receipt', { p_id: order.id }); } catch (e) { toast(e.message); return; }
  }
  const lines = paid ? (r.lines || []).map((l, i) => ({ ...l, line: l.line ?? i + 1, left: l.qty - (l.refunded_qty || 0) })).filter((l) => l.left > 0) : [];
  const before = (r.refunded || 0) > 0;
  const pick = Object.fromEntries(lines.map((l) => [l.line, l.left]));
  const per = (l, q) => { const net = l.line_total - (l.discount || 0), done = l.refunded_qty || 0; return Math.floor(net * (done + q) / l.qty) - Math.floor(net * done / l.qty); };
  const amountNow = () => lines.reduce((t, l) => t + per(l, pick[l.line] || 0), 0);
  const method0 = r.payment_method === 'qris' ? 'qris' : 'tunai';
  const kinds = before ? [['refund', 'Refund sisa barang']] : [['batal', 'Batal (pembeli masih di booth)'], ['refund', 'Refund (uang dikembalikan)']];
  ask({
    title: paid ? `Minta batal atau refund ${r.receipt_no}` : `Minta batal ${r.receipt_no}`,
    body: `<p class="small muted">Manajer atau pemilik yang memutuskan${paid ? '. Stok, stempel dan hadiah ikut setelah disetujui' : ''}.</p>
      ${paid ? pickRow('kind', kinds, kinds[0][0]) : '<input type="hidden" name="kind" value="batal">'}
      ${paid ? `<div class="tl-rf stack" id="tl-rf"${kinds[0][0] === 'refund' ? '' : ' hidden'}>
        <span class="tl-h">Barang yang dikembalikan</span>
        ${lines.map((l) => `<div class="tl-rf-line"><span><b>${esc(l.name)}</b>${l.flavour ? ` · ${esc(l.flavour)}` : ''}<br>
          <span class="small muted num">${l.free_bag ? 'gratis · ' : ''}${l.left} bisa dikembalikan</span></span>
          <span class="tl-step"><button type="button" data-rf="${l.line}" data-d="-1" aria-label="Kurangi ${esc(l.name)}">−</button>
            <output class="num" data-rfq="${l.line}">${pick[l.line]}</output>
            <button type="button" data-rf="${l.line}" data-d="1" aria-label="Tambah ${esc(l.name)}">+</button></span></div>`).join('')}
        <span class="tl-h">Uang dikembalikan lewat</span>${pickRow('method', REFUND_TO, method0)}
        <div class="tl-kv is-total"><span>Dikembalikan</span><b class="num" id="tl-rf-amt">${rupiah(amountNow())}</b></div>
        <p class="small muted">Tunai keluar dari laci setelah disetujui. Transfer dan refund QRIS dikirim manajer atau pemilik, tidak lewat laci.</p>
      </div>` : ''}
      ${reasonField('Contoh: salah input rasa')}`,
    confirm: 'Kirim permintaan',
    run: async (f) => {
      const kind = f.elements.kind.value;
      const args = { p_order: r.id, p_kind: kind, p_reason: f.elements.reason.value };
      if (kind === 'refund') {
        const sel = lines.filter((l) => pick[l.line] > 0).map((l) => ({ line: l.line, qty: pick[l.line] }));
        if (!sel.length) throw new Error('Pilih barang yang dikembalikan.');
        if (amountNow() <= 0) throw new Error('Barang yang dipilih gratis, jadi tidak ada uang yang dikembalikan. Pilih barang lain.');
        Object.assign(args, { p_lines: sel, p_refund_method: f.elements.method.value });
      }
      const res = await rpc('pos_request_void', args);
      toast(kind === 'refund' ? `Permintaan refund ${rupiah(res?.amount ?? amountNow())} dikirim ke manajer atau pemilik.` : 'Permintaan dikirim ke manajer atau pemilik.');
      after?.();
    },
  });
  const form = $('#tl-dlg form');
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rf]');
    if (b) {
      const ln = Number(b.dataset.rf), l = lines.find((x) => x.line === ln);
      pick[ln] = Math.max(0, Math.min(l.left, (pick[ln] || 0) + Number(b.dataset.d)));
      form.querySelector(`[data-rfq="${ln}"]`).textContent = pick[ln];
      $('#tl-rf-amt').textContent = rupiah(amountNow());
      return;
    }
    const box = $('#tl-rf'); if (box && form.elements.kind) box.hidden = form.elements.kind.value !== 'refund';
  });
}

function askCancel(order, after) {
  ask({
    title: `Batalkan ${order.receipt_no}`,
    body: `<p class="small muted">Pesanan belum dibayar. Promo yang dipakai kembali ke kartu member.</p>${reasonField('Contoh: pembeli tidak jadi beli')}`,
    confirm: 'Batalkan pesanan',
    run: async (f) => {
      await rpc('pos_cancel_order', { p_id: order.id, p_reason: f.elements.reason.value });
      toast(`Pesanan ${order.receipt_no} dibatalkan.`);
      after?.();
    },
  });
}

// Kas masuk / keluar. Staff work blind (Glenn, 11 Nov 2026): the answer never says what the
// drawer should hold. Managers and the owner may also record Setor (cash taken to the owner).
function askCash() {
  const kinds = [['masuk', 'Uang masuk'], ['keluar', 'Uang keluar']];
  if (canCancel()) kinds.push(['setor', 'Setor ke pemilik']);
  ask({
    title: 'Kas masuk atau keluar',
    body: `${pickRow('kind', kinds, 'keluar')}
      <label class="field"><span>Jumlah (Rp) ${REQ}</span>${moneyField('name="amount" required')}</label>
      ${reasonField('Contoh: beli es batu, tambah uang kecil')}`,
    confirm: 'Simpan',
    run: async (f) => {
      const kind = f.elements.kind.value;
      await rpc('pos_cash_move', { p_kind: kind, p_amount: amount(f, 'amount'), p_reason: f.elements.reason.value });
      toast(kind === 'masuk' ? 'Uang masuk tercatat.' : kind === 'setor' ? 'Setor tercatat.' : 'Uang keluar tercatat.');
      if (S.screen === 'home') loadHome();
    },
  });
}

/* ---------------------------------------------------------------- shift screens */
// Shifts run back to back (Glenn, 11 Nov 2026): Tutup shift counts the drawer, prints the
// rekap, and the next shift opens at that same second with the counted cash. Staff never
// open a shift; the very first one opens by itself (pos_open_shift, the owner's float).
const deviceName = () => {
  let d = store.get('hs-till-device');
  if (!d) { d = `Tablet kasir ${newId().slice(0, 4).toUpperCase()}`; store.set('hs-till-device', d); }
  return d;
};
async function ensureShift() {
  if (S.shift) return;
  try { S.shift = await rpc('pos_open_shift', { p_device: deviceName() }); } catch (e) { toast(e.message); }
}

// The denomination counter (Glenn, 11 Nov 2026): notes with - and + steppers, koin as a rupiah
// amount, and a running total. This count is what staff close with.
const DENOM_ROWS = ['100000', '50000', '20000', '10000', '5000', '2000', '1000'];
function denomTotal() {
  let t = 0;
  for (const d of DENOM_ROWS) t += Number(d) * (S.count[d] || 0);
  return t + (S.count.koin || 0);
}
function denomHtml() {
  return `<div class="tl-den" role="group" aria-label="Hitung uang per pecahan">${DENOM_ROWS.map((d) => `
    <div class="tl-den-row"><span class="num">Rp${Number(d).toLocaleString('id-ID')}</span>
      <span class="tl-step"><button type="button" data-act="den" data-v="${d}" data-d="-1" aria-label="Kurangi Rp${Number(d).toLocaleString('id-ID')}">−</button>
        <input type="text" inputmode="numeric" class="num" data-den="${d}" value="${S.count[d] || 0}" aria-label="Lembar Rp${Number(d).toLocaleString('id-ID')}">
        <button type="button" data-act="den" data-v="${d}" data-d="1" aria-label="Tambah Rp${Number(d).toLocaleString('id-ID')}">+</button></span>
      <b class="num" data-sub="${d}">${rupiah(Number(d) * (S.count[d] || 0))}</b></div>`).join('')}
    <div class="tl-den-row"><span>Koin (jumlah Rp)</span>${moneyField(`id="tl-koin" value="${S.count.koin ? S.count.koin.toLocaleString('id-ID') : ''}" placeholder="0"`)}<b class="num" data-sub="koin">${rupiah(S.count.koin || 0)}</b></div>
  </div>`;
}
function denomUpdate() {
  for (const d of DENOM_ROWS) {
    const sub = app.querySelector(`[data-sub="${d}"]`); if (sub) sub.textContent = rupiah(Number(d) * (S.count[d] || 0));
    const inp = app.querySelector(`[data-den="${d}"]`); if (inp && document.activeElement !== inp) inp.value = S.count[d] || 0;
  }
  const ks = app.querySelector('[data-sub="koin"]'); if (ks) ks.textContent = rupiah(S.count.koin || 0);
  const tot = denomTotal();
  $('#tl-count-total').textContent = rupiah(tot);
  // While the close is being sent the button stays off, or a second tap closes the next shift too.
  const cb = $('#tl-close-btn');
  if (cb && cb.getAttribute('aria-busy') !== 'true') cb.disabled = false;
}

async function renderClose() {
  if (off.pending()) {
    app.innerHTML = `<section class="panel stack tl-solo"><h1>Kirim penjualan offline dulu</h1>
      <p>${off.pending()} penjualan masih tersimpan di tablet. Shift bisa ditutup setelah semuanya terkirim, supaya rekapnya lengkap.</p>
      <div class="tl-row2"><button class="btn btn-quiet tl-btn" type="button" data-act="back">Kembali</button>
        <button class="btn tl-btn" type="button" data-act="queue">Lihat dan kirim</button></div></section>`;
    return;
  }
  app.innerHTML = '<div class="panel stack tl-solo" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
  let sh;
  try { sh = await rpc('pos_shift_now'); }
  catch (e) { app.innerHTML = `<div class="notice notice-error tl-solo" role="alert">${esc(e.message)}</div>`; return; }
  if (!sh) { await ensureShift(); S.screen = 'home'; render(); return; }
  S.count = {};
  const row = (k, v, cls = '') => `<div class="tl-kv${cls}"><span>${k}</span><b class="num">${v}</b></div>`;
  // Managers and the owner see the drawer figures; staff count blind.
  const full = !sh.blind;
  app.innerHTML = `<form class="tl-close" id="tl-close-form" novalidate aria-labelledby="tl-close-t">
    <section class="panel stack">
      <h1 id="tl-close-t" class="tl-title">Tutup shift dan cetak rekap</h1>
      <p class="muted small">Shift dari ${esc(shortDay(sh.opened_at))} ${esc(time(sh.opened_at))}${sh.opened_by ? ` · ${esc(sh.opened_by)}` : ''} · ${sh.orders} pesanan dibayar</p>
      <div>
        ${row('Penjualan tunai', rupiah(sh.by_method?.tunai || 0))}
        ${row('Penjualan QRIS', rupiah(sh.by_method?.qris || 0))}
        ${sh.split_count ? row('Split payment (sudah masuk di atas)', `${sh.split_count} pesanan`) : ''}
        ${row('Uang diterima dari pembeli', rupiah(sh.cash_received))}
        ${row('Kembalian diberikan', rupiah(sh.change_given))}
        ${row('Kas masuk', rupiah(sh.cash_in))}
        ${row('Kas keluar', (sh.cash_out ? '−' : '') + rupiah(sh.cash_out))}
        ${full ? `${row('Uang modal', rupiah(sh.opening_cash))}${sh.setor ? row('Setor ke pemilik', '−' + rupiah(sh.setor)) : ''}${row('Seharusnya di laci', rupiah(sh.expected_cash), ' is-total')}` : ''}
      </div>
      <p class="muted small">${full ? 'Anda melihat angka laci karena masuk sebagai manajer atau pemilik.'
        : 'Hitung semua uang di laci per pecahan. Setelah ditutup, shift berikutnya langsung mulai dengan uang yang Anda hitung.'}</p>
    </section>
    <section class="panel stack">
      <span class="tl-h">Uang di laci ${REQ}</span>
      ${denomHtml()}
      <div class="tl-chg" id="tl-count-box"><span>Total dihitung</span><b class="num" id="tl-count-total">${rupiah(0)}</b></div>
      ${full ? '<div class="tl-chg is-short" id="tl-diff" hidden></div>' : ''}
      <label class="field"><span>Catatan${full ? ` <span class="hint is-req" id="tl-note-req" hidden>wajib</span>` : ''}</span>
        <textarea id="tl-note" maxlength="300" placeholder="Contoh: uang Rp2.000 sobek, disimpan terpisah"></textarea></label>
      <div class="notice" id="tl-close-msg" hidden></div>
      <div class="tl-row2"><button class="btn btn-quiet tl-btn" type="button" data-act="back">Kembali</button>
        <button class="btn tl-btn" type="submit" id="tl-close-btn">Tutup shift</button></div>
    </section>
  </form>`;
  const diffShow = () => {
    if (!full) return;
    const diff = denomTotal() - sh.expected_cash, box = $('#tl-diff');
    box.hidden = false;
    box.innerHTML = `<span>Selisih</span><b class="num">${diff > 0 ? '+' : diff < 0 ? '−' : ''}${rupiah(Math.abs(diff))}</b>`;
    box.classList.toggle('is-short', diff !== 0);
    $('#tl-note-req').hidden = !diff;
  };
  const form = $('#tl-close-form');
  form.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.den) {
      if (/\D/.test(t.value)) t.value = t.value.replace(/\D/g, '');   // letters never stay in a count field
      S.count[t.dataset.den] = Math.max(0, Math.min(9999, Number(t.value) || 0));
    }
    if (t.id === 'tl-koin') S.count.koin = money(t) || 0;
    denomUpdate(); diffShow();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act="den"]'); if (!b) return;
    e.stopPropagation();
    const d = b.dataset.v; S.count[d] = Math.max(0, (S.count[d] || 0) + Number(b.dataset.d));
    denomUpdate(); diffShow();
  });
  denomUpdate(); diffShow();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#tl-close-btn'), total = denomTotal(), msg = $('#tl-close-msg');
    if (full && total !== sh.expected_cash && !$('#tl-note').value.trim()) { notice(msg, 'Uang di laci beda dari catatan. Tulis catatannya.'); $('#tl-note').focus(); return; }
    if (!total && !window.confirm('Laci kosong (Rp0). Tutup shift?')) return;
    const den = Object.fromEntries([...DENOM_ROWS.map((d) => [d, S.count[d] || 0]), ['koin', S.count.koin || 0]]);
    busy(btn, true, 'Menutup…');
    try {
      const k = await rpc('pos_close_shift', { p_counted_cash: total, p_note: $('#tl-note').value, p_denominations: den, p_device: deviceName() });
      S.shift = k.next_shift || null;
      S.rekap = k;
      S.screen = 'closed';
      render();
      // Printing the rekap is part of closing. It starts by itself when the printer is already
      // connected; choosing a Bluetooth printer needs a tap (the browser's rule).
      if (printer.isConnected()) printRekap(k, $('[data-act="rekap-print"]'));
      else notice($('#tl-print-msg'), 'Tekan Cetak struk rekap untuk mencetak rekapnya.', 'warn');
    } catch (err) { busy(btn, false); notice(msg, err.message); }
  });
}

// Shift closed: the rekap, Cetak struk rekap (once per close for staff) and Bagikan PDF.
function renderClosed() {
  const k = S.rekap;
  const pay = (m) => (k.payments.find((x) => x.method === m) || {}).amount || 0;
  app.innerHTML = `<section class="panel stack tl-solo tl-closed" aria-labelledby="tl-closed-t" tabindex="-1" id="tl-closed">
    <h1 class="tl-title" id="tl-closed-t">Shift ditutup</h1>
    <p class="muted">${esc(k.start)} sampai ${esc(k.end || '')} · ${k.orders} pesanan dibayar. Shift berikutnya sudah mulai.</p>
    <div>
      <div class="tl-kv"><span>Total penjualan</span><b class="num">${rupiah(k.sales ?? k.total)}</b></div>
      ${rekapChargeRows(k).map(([l, a]) => `<div class="tl-kv"><span>${esc(l)}</span><b class="num">Rp${esc(a)}</b></div>`).join('')}
      <div class="tl-kv"><span>QRIS</span><b class="num">${rupiah(pay('qris'))}</b></div>
      <div class="tl-kv"><span>Tunai</span><b class="num">${rupiah(pay('tunai'))}</b></div>
      <div class="tl-kv is-total"><span>Uang laci dihitung</span><b class="num">${rupiah(k.counted_cash)}</b></div>
    </div>
    ${k.promos?.length ? `<div><span class="tl-h">Promo dipakai</span>${k.promos.map((p) => `<div class="tl-kv"><span>${esc(p.label)}${p.by ? ` (${esc(p.by)})` : ''} · <span class="num">${p.items} item</span></span><b class="num">−${rupiah(p.discount)}</b></div>`).join('')}</div>` : ''}
    <p class="muted small">Terima kasih. Hasil hitungan sudah tersimpan untuk pemilik.</p>
    <div class="tl-acts">
      <button class="btn tl-btn" type="button" data-act="rekap-print">Cetak struk rekap</button>
      <button class="btn btn-quiet tl-btn" type="button" data-act="rekap-pdf">Bagikan PDF</button>
      <button class="btn btn-quiet tl-btn" type="button" data-act="back-home">Ke Dashboard</button>
    </div>
    <div class="notice" id="tl-print-msg" hidden></div>
    <div class="tl-paper">
      <span class="tl-h">Kertas printer</span>
      ${['58', '80'].map((w) => `<button type="button" class="tl-chip is-sm${paper() === w ? ' is-on' : ''}" aria-pressed="${paper() === w}" data-act="paper-rekap" data-v="${w}">${w} mm</button>`).join('')}
    </div>
  </section>`;
  $('#tl-closed').focus();
}

// Text-only thermal print (fast and light). A staff account prints once per close: the
// server refuses a second mark, and the till checks first so nothing is wasted. Managers and
// the owner reprint; their copy says CETAK ULANG.
async function printRekap(k, btn, msg = $('#tl-print-msg')) {
  const say = (t, kind = 'ok') => (msg ? notice(msg, t, kind) : toast(t));
  if (k.printed_at && isStaffOnly()) { say(`Rekap hari ini sudah dicetak jam ${k.printed_time}. Minta manajer atau pemilik kalau perlu cetak ulang.`, 'warn'); return; }
  if (btn) busy(btn, true, 'Mencetak…');
  try {
    const reprint = !!k.printed_at;
    const bytes = rekapReceipt(k, { dots: paper() === '80' ? 576 : 384, reprint, at: nowText() }).bytes();
    const p = await printer.print(bytes, (t) => say(t));
    const m = await rpc('pos_rekap_printed', { p_shift: k.id });
    k.printed_at = m.printed_at; k.printed_time = time(m.printed_at);
    say(`Rekap ${reprint ? 'dicetak ulang' : 'terkirim'} ke ${p.name}.`);
  } catch (e) {
    if (e && e.name === 'NotFoundError') { printer.forget(); say('Tidak ada printer yang dipilih. Tekan Cetak struk rekap lagi.', 'warn'); }
    else say(e.message || String(e), 'error');
  } finally { if (btn) busy(btn, false); }
}
const nowText = () => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  .format(new Date()).replace(/\./g, ':').replace(',', '');
async function shareRekap(k, btn, msg = $('#tl-print-msg')) {
  notice(msg, '');
  busy(btn, true, 'Menyiapkan…');
  try {
    const blob = await rekapPdf(k);
    rpc('pos_rekap_exported', { p_shift: k.id }).catch(() => {});
    const how = await sharePdf(blob, rekapFile(k), `Rekap kas Hanashuya ${k.start} sampai ${k.end || 'sekarang'}`);
    if (msg && how === 'downloaded') notice(msg, 'PDF rekap tersimpan di unduhan.', 'ok');
  } catch (e) { if (msg) notice(msg, e.message, 'error'); else toast(e.message); }
  finally { busy(btn, false); }
}
// Hari ini: the last closed shift's rekap again (staff: only if not printed yet; managers and
// the owner: a marked reprint).
async function lastRekap(btn, act) {
  const msg = $('#tl-today-msg');
  busy(btn, true, 'Memuat…');
  let k;
  try { k = await rpc('pos_shift_rekap', { p_shift: null }); }
  catch (e) { busy(btn, false); notice(msg, e.message); return; }
  busy(btn, false);
  if (!k.closed) { notice(msg, 'Belum ada shift yang ditutup hari ini.', 'warn'); return; }
  if (act === 'pdf') shareRekap(k, btn, msg); else printRekap(k, btn, msg);
}

/* ---------------------------------------------------------------- Hari ini */
// Pesanan hari ini: status tabs and a search over invoice number, member, server and promo
// (VireoPOS has status tabs on its order list). Filtering happens in the browser.
const TODAY_TABS = [['semua', 'Semua'], ['menunggu', 'Menunggu bayar'], ['dibayar', 'Dibayar'], ['batal', 'Batal dan refund']];
async function renderToday() {
  app.innerHTML = '<div class="panel stack tl-solo" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
  let list;
  try { list = await rpc('pos_today'); }
  catch (e) { app.innerHTML = `<div class="notice notice-error tl-solo" role="alert">${esc(e.message)}</div>`; return; }
  S.todayList = list;
  if (!S.todayTab) S.todayTab = list.some((o) => o.status === 'menunggu') ? 'menunggu' : 'semua';
  const paid = list.filter((o) => o.status === 'dibayar');
  const count = (k) => list.filter((o) => inTab(o, k)).length;
  app.innerHTML = `<section class="tl-today" aria-labelledby="tl-today-t">
    <div class="row-between"><h1 id="tl-today-t" class="tl-title">Pesanan hari ini</h1>
      <span class="muted num">${paid.length} pesanan dibayar · ${rupiah(paid.reduce((t, o) => t + o.total, 0))}</span></div>
    <div class="tl-row2 tl-rekap-again"><button class="btn btn-quiet tl-btn" type="button" data-act="last-rekap">${canCancel() ? 'Cetak ulang rekap terakhir' : 'Cetak rekap shift terakhir'}</button>
      <button class="btn btn-quiet tl-btn" type="button" data-act="last-rekap-pdf">PDF rekap terakhir</button></div>
    <div class="tl-tfilter">
      <div class="tl-chips" role="group" aria-label="Status pesanan">${TODAY_TABS.map(([k, l]) =>
        `<button type="button" class="tl-chip${S.todayTab === k ? ' is-on' : ''}" aria-pressed="${S.todayTab === k}" data-act="today-tab" data-v="${k}">${l} <span class="num">${count(k)}</span></button>`).join('')}</div>
      <label class="tl-search"><span class="visually-hidden">Cari pesanan</span>
        <input type="search" id="tl-today-q" placeholder="Cari nomor invoice, member atau staf" autocomplete="off" value="${esc(S.todayQ || '')}"></label>
    </div>
    <div class="notice" id="tl-today-msg" hidden></div>
    <div id="tl-today-list"></div>
  </section>`;
  drawToday();
  // Typing searches every status, so a paid order isn't hidden behind the Menunggu tab.
  $('#tl-today-q').addEventListener('input', (e) => {
    S.todayQ = e.target.value;
    if (S.todayQ.trim() && S.todayTab !== 'semua') {
      S.todayTab = 'semua';
      app.querySelectorAll('[data-act="today-tab"]').forEach((x) => { const on = x.dataset.v === 'semua'; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', String(on)); });
    }
    drawToday();
  });
}
const inTab = (o, k) => k === 'semua' || (k === 'batal' ? ['batal', 'refund'].includes(o.status) : o.status === k);
function drawToday() {
  const q = String(S.todayQ || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const rows = (S.todayList || []).filter((o) => inTab(o, S.todayTab || 'semua'))
    .filter((o) => !q || [o.receipt_no, o.member, o.customer_name, o.served_by, o.promo_label, METHOD[o.payment_method], o.note]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  $('#tl-today-list').innerHTML = rows.length ? `<ul class="tl-olist">${rows.map((o) => {
    const [label, cls] = STATUS[o.status] || [o.status, ''];
    const acts = [];
    if (o.status === 'menunggu') {
      if (!o.void_pending) acts.push(`<button class="tl-use" type="button" data-act="resume" data-id="${esc(o.id)}">Lanjutkan bayar</button>`);
      if (canCancel()) acts.push(`<button class="tl-use" type="button" data-act="cancel" data-id="${esc(o.id)}">Batalkan</button>`);
    }
    if (o.status === 'dibayar') {
      acts.push(`<button class="tl-use" type="button" data-act="reprint" data-id="${esc(o.id)}">Cetak ulang</button>`);
      acts.push(`<button class="tl-use" type="button" data-act="share" data-id="${esc(o.id)}">Kirim struk WhatsApp</button>`);
    }
    if ((o.status === 'dibayar' || (o.status === 'menunggu' && isStaffOnly())) && !o.void_pending) {
      acts.push(`<button class="tl-use" type="button" data-act="void" data-id="${esc(o.id)}">${o.status === 'dibayar' ? (o.refunded ? 'Minta refund' : 'Minta batal / refund') : 'Minta batal'}</button>`);
    }
    return `<li class="tl-orow"><span class="tl-otime num">${esc(time(o.sold_at))}</span>
      <span class="tl-omain"><b class="num">${esc(o.receipt_no)}</b> <span class="tag ${cls}">${esc(label)}</span>${o.status === 'dibayar' && o.refunded ? ` <span class="tag tag-bad num">Refund ${esc(rupiah(o.refunded))}</span>` : ''}${o.void_pending ? ' <span class="tag tag-warn">Menunggu persetujuan</span>' : ''}<br>
        <span class="muted small">${o.customer_name ? 'Atas nama Kak ' + esc(o.customer_name) + ' · ' : ''}${esc(o.member ? 'member ' + o.member : 'Tanpa member')}${o.served_by ? ' · dilayani ' + esc(o.served_by) : ''}${o.promo_label ? ' · ' + esc(o.promo_label) : ''}${o.stamps ? ` · ${o.stamps} stempel` : ''}</span>
        ${o.note ? `<br><span class="small">Catatan: ${esc(o.note)}</span>` : ''}</span>
      <span class="tl-oamt"><b class="num">${rupiah(o.total)}</b><br><span class="muted small">${esc(METHOD[o.payment_method] || '')}</span></span>
      <span class="tl-oacts">${acts.join('')}</span></li>`;
  }).join('')}</ul>` : `<p class="muted">${(S.todayList || []).length ? 'Tidak ada pesanan yang cocok.' : 'Belum ada pesanan hari ini.'}</p>`;
}

async function todayAction(act, id, btn) {
  const o = (S.todayList || []).find((x) => x.id === id); if (!o) return;
  const msg = $('#tl-today-msg');
  if (act === 'void') return askVoid(o, renderToday);
  if (act === 'cancel') return askCancel(o, renderToday);
  busy(btn, true, 'Memuat…');
  try {
    const r = await rpc('pos_receipt', { p_id: id });
    if (act === 'reprint') { busy(btn, false); await printReceipt(r, btn, msg); return; }
    if (act === 'share') { busy(btn, false); await shareReceipt(r, btn, msg, msg); return; }
    if (act === 'resume') {
      if (S.items.length && !window.confirm('Pesanan yang sedang diisi akan dikosongkan. Lanjutkan?')) { busy(btn, false); return; }
      resetOrder();
      S.placed = r; S.screen = 'method'; render();
    }
  } catch (e) { busy(btn, false); notice(msg, e.message); }
}

/* ---------------------------------------------------------------- taps */
// What can't change while Konfirmasi pesanan is on its way.
const LOCKED = new Set(['tile', 'flavour', 'pick-qty', 'pick-add', 'qty', 'bags', 'promo', 'promo-off', 'promo-line', 'member-clear',
  'find', 'scan', 'voucher', 'join', 'served', 'gender', 'age', 'sample-on', 'bogo-start', 'confirm', 'note-open', 'half-ask']);
// The order note is kept as it is typed (no re-render, so the keyboard stays up).
app.addEventListener('input', (e) => {
  if (e.target.id === 'tl-name-in') {
    if (S.confirming) { e.target.value = S.customerName; return; }
    S.customerName = e.target.value.slice(0, 40); return;
  }
  if (e.target.id !== 'tl-note-in') return;
  if (S.confirming) { e.target.value = S.note; return; }
  S.note = e.target.value.slice(0, NOTE_MAX);
  const left = $('#tl-note-left'); if (left) left.textContent = `${NOTE_MAX - S.note.length} huruf lagi`;
});
async function onTap(e) {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const act = b.dataset.act;
  if (S.confirming && LOCKED.has(act)) return;
  switch (act) {
    case 'cat': S.tab = b.dataset.v === '' ? null : Number(b.dataset.v); renderLeft(); return;
    case 'tile': {
      const p = product(b.dataset.code); if (!p) return;
      if (!p.needs_flavour) { addItem(p.code, null); toast(`${p.name} ditambahkan`); return; }
      S.pick = { code: p.code, flavour: null, qty: 1, counts: {} }; S.left = 'flavour'; renderLeft(); return;
    }
    case 'flavour': {
      if (PICKER === 'inplace') {
        S.pick.counts[b.dataset.v] = (S.pick.counts[b.dataset.v] || 0) + 1;
        addItem(S.pick.code, b.dataset.v); renderLeft();
      } else { S.pick.flavour = b.dataset.v; renderLeft(); }
      return;
    }
    case 'pick-qty': S.pick.qty = Math.max(1, Math.min(50, S.pick.qty + Number(b.dataset.d))); renderLeft(); return;
    case 'pick-add':
      if (S.sample) {
        const x = S.sample.items.find((y) => y.product === S.pick.code && y.flavour === S.pick.flavour);
        if (x) x.qty = Math.min(30, x.qty + S.pick.qty); else S.sample.items.push({ product: S.pick.code, flavour: S.pick.flavour, qty: S.pick.qty });
        S.pick = null; S.left = 'tiles'; renderLeft(); renderRight(); return;
      }
      addItem(S.pick.code, S.pick.flavour, S.pick.qty); S.pick = null; S.left = 'tiles'; renderLeft(); return;
    case 'sample-on': stopCamera(); S.sample = { id: newId(), items: [] }; S.sampleQuota = null; S.left = 'tiles'; S.pick = null; renderLeft(); renderRight(); if (S.online) loadSampleQuota(); return;
    case 'sample-off': S.sample = null; S.pick = null; S.left = 'tiles'; renderLeft(); renderRight(); return;
    case 'sample-qty': {
      const x = S.sample.items[Number(b.dataset.i)]; if (!x) return;
      x.qty = Math.min(30, x.qty + Number(b.dataset.d));
      if (x.qty <= 0) S.sample.items.splice(Number(b.dataset.i), 1);
      renderRight(); return;
    }
    case 'sample-save': saveSample(b); return;
    case 'pick-close': S.pick = null; S.left = 'tiles'; renderLeft(); return;
    case 'gender': S.gender = S.gender === b.dataset.v ? null : b.dataset.v; renderLeft(); return;
    case 'age': S.age = S.age === b.dataset.v ? null : b.dataset.v; renderLeft(); return;
    case 'served': S.served = b.dataset.v; store.set('hs-till-served', S.served); renderRight(); return;
    case 'qty': changeQty(Number(b.dataset.i), Number(b.dataset.d)); return;
    case 'bags': S.bags = Math.max(0, Math.min(bagsMax(), freeBags() + Number(b.dataset.d))); requote(); return;
    case 'find': S.left = 'find'; renderLeft(); return;
    case 'scan': S.left = 'find'; renderLeft(); startCamera(); return;
    case 'voucher': S.left = 'voucher'; renderLeft(); return;
    case 'join': stopCamera(); S.left = 'join'; renderLeft(); return;
    case 'find-close': stopCamera(); S.left = 'tiles'; renderLeft(); return;
    case 'member-clear': S.member = null; S.memberPhone = null; S.promo = null; renderLeft(); requote(); return;
    case 'promo': {
      const [kind, a, c] = b.dataset.key.split(':');
      S.promo = kind === 'stempel' ? { kind, cycle: Number(a), slot: Number(c), line: null }
        : kind === 'tebus_murah' ? { kind, confirm: true, line: null }
        : kind === 'bogo' || kind === 'malam50' ? { kind, line: null }
        : { kind, period: Number(a), line: null };
      requote(); return;
    }
    case 'promo-off': S.promo = null; requote(); return;
    case 'bogo-start': startBogo(b); return;
    case 'promo-line': S.promo.line = Number(b.dataset.i) + 1; requote(); return;
    case 'confirm': placeOrder(b); return;
    case 'to-cash': S.split = null; S.screen = 'cash'; render(); return;
    case 'to-qris': S.split = null; S.screen = 'qris'; render(); return;
    case 'to-method': S.split = null; S.screen = 'method'; render(); return;
    case 'to-split': S.split = S.split || { tunai: null, cash: null }; S.screen = 'split'; render(); return;
    case 'sp-t': S.split.tunai = Number(b.dataset.v); render(); return;
    case 'split-qris': if (splitOk(S.placed.total)) { S.screen = 'qris'; render(); } return;
    case 'cash': S.cash = Number(b.dataset.v); render(); return;
    case 'pay-cash': pay(b, { method: 'tunai', cash: S.cash }); return;
    case 'pay-qris': {
      const ref = $('#tl-qris-ref')?.value.trim() || null;
      if (S.split) { const t = S.split.tunai; pay(b, { method: 'campur', tunai: t, qris: S.placed.total - t, cash: S.split.cash ?? t, ref }); return; }
      pay(b, { method: 'qris', ref }); return;
    }
    case 'note-open': S.noteOpen = true; renderRight(); $('#tl-note-in')?.focus(); return;
    case 'half-ask': askHalf(); return;
    case 'pay-free': pay(b, { method: 'gratis' }); return;
    case 'cancel-order': askCancel(S.placed, resetOrder); return;
    case 'ask-void': askVoid(S.placed, resetOrder); return;
    case 'print': printReceipt(S.paid, b, $('#tl-print-msg')); return;
    case 'print-queue': printQueue(S.paid, b, $('#tl-print-msg')); return;
    case 'queue-device': store.set('hs-till-queue-slip', b.dataset.v); renderPrinter(); return;
    case 'new': resetOrder(); return;
    case 'offline-edit': S.placed = null; S.screen = 'order'; render(); return;
    case 'edit-order': editOrder(b); return;
    case 'paper': store.set('hs-till-paper', b.dataset.v); if (S.screen === 'printer') renderPrinter(); else renderDone(); return;
    case 'printer-forget': printer.forget(); if (S.screen === 'printer') { renderPrinter(); notice($('#tl-print-msg'), 'Printer dilupakan. Tekan Sambungkan printer untuk memilih lagi.', 'ok'); return; } notice($('#tl-print-msg'), 'Printer dilupakan. Tekan Cetak struk untuk memilih lagi.', 'ok'); return;
    case 'printer-connect': {
      const msg = $('#tl-print-msg'); busy(b, true, 'Menyambungkan…');
      // Chrome's printer list sometimes never opens inside the installed app (TWA). Say so
      // after 10 s instead of leaving the cashier staring at "Menyambungkan…" (14 Nov 2026).
      // The app's own list (Capacitor) always opens, so the hint is for the browser only.
      const fresh = !isNative() && !printer.hasDevice();
      const stuck = setTimeout(() => { if (fresh && !printer.hasDevice()) { busy(b, false); notice(msg, 'Jendela pilih printer tidak muncul. Pastikan Bluetooth tablet menyala dan Chrome boleh memakai Perangkat di sekitar (Pengaturan Android > Aplikasi > Chrome > Izin). Kalau tetap tidak muncul, buka kasir di aplikasi Chrome biasa dan sambungkan dari sana.', 'warn'); } }, 10000);
      try { const pr = await printer.connect((t) => notice(msg, t, 'ok')); clearTimeout(stuck); renderPrinter(); notice($('#tl-print-msg'), `Tersambung ke ${pr.name}.`, 'ok'); }
      catch (e) { clearTimeout(stuck); busy(b, false); notice(msg, e && e.name === 'NotFoundError' ? 'Tidak ada printer yang dipilih.' : (e.message || String(e)), e && e.name === 'NotFoundError' ? 'warn' : 'error'); }
      return;
    }
    case 'printer-test': await printReceipt({ ...SAMPLES.walk, receipt_no: 'UJI-CETAK' }, b, $('#tl-print-msg')); if (S.screen === 'printer') $('#tl-pr-state').textContent = printer.isConnected() ? `Tersambung ke ${printer.current()?.name || 'printer'}` : 'Belum ada printer'; return;
    case 'back': goBack(); return;
    case 'queue': showQueue(); return;
    case 'sell': S.screen = 'order'; S.back = 'order'; render(); return;
    case 'chart': store.set('hs-till-chart', b.dataset.v); if (S.home) { $('.hm-panel').outerHTML = chartHtml(S.home); app.querySelector(`[data-act="chart"][data-v="${b.dataset.v}"]`)?.focus(); } return;
    case 'home-cash': askCash(); return;
    case 'home-today': goTo('today'); return;
    case 'home-rsv': {
      // One dialog at a time: a second tap while the list loads does nothing (13 Nov 2026).
      if (rsvOpen) return;
      rsvOpen = true; b.setAttribute('aria-busy', 'true');
      openReservations({ rpc, staff: S.cat?.staff || [], qrisImg: QRIS_IMG, onPaid: (r) => {
        // Keep the order in progress; it comes back when the cashier leaves this done screen.
        if (!S.paid && (S.items.length || S.member)) {
          S.stash = { items: S.items, member: S.member, memberPhone: S.memberPhone, promo: S.promo, bags: S.bags, gender: S.gender, age: S.age,
            orderId: S.orderId, placed: S.placed, localNo: S.localNo, waitingCode: S.waitingCode, quote: S.quote, note: S.note, noteOpen: S.noteOpen, customerName: S.customerName };
        }
        S.paid = r; S.screen = 'done'; render();
      } }).catch((err) => toast(err.message)).finally(() => { rsvOpen = false; b.removeAttribute('aria-busy'); });
      return;
    }
    case 'home-close': goTo('close'); return;
    case 'approve': if (canCancel()) goTo('approve'); return;
    case 'stock': S.stockMode = null; goTo('stock'); return;
    case 'qr-absen': case 'qr-istirahat': S.qrKind = act === 'qr-istirahat' ? 'istirahat' : 'absen'; if (S.screen === 'qr') renderQr(); else goTo('qr'); return;
    case 'low-request': $('#tl-dlg')?.close(); S.stockMode = 'permintaan'; goTo('stock'); return;
    case 'low-open': openLow(); return;
    case 'home-pending': goTo('today'); S.todayTab = 'menunggu'; return;
    case 'promo-more': openPromos(); return;
    case 'back-home': S.screen = 'home'; S.back = 'home'; render(); return;
    case 'rekap-print': printRekap(S.rekap, b); return;
    case 'rekap-pdf': shareRekap(S.rekap, b); return;
    case 'paper-rekap': store.set('hs-till-paper', b.dataset.v); renderClosed(); return;
    case 'last-rekap': lastRekap(b, 'print'); return;
    case 'last-rekap-pdf': lastRekap(b, 'pdf'); return;
    case 'resume': case 'reprint': case 'share': case 'void': case 'cancel': todayAction(act, b.dataset.id, b); return;
    case 'today-tab': S.todayTab = b.dataset.v; app.querySelectorAll('[data-act="today-tab"]').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-pressed', String(x === b)); }); drawToday(); return;
    default:
  }
}
app.addEventListener('click', onTap);

let rsvOpen = false;
$('#tl-today').addEventListener('click', () => (S.screen === 'today' ? goBack() : goTo('today')));
$('#tl-home').addEventListener('click', () => { stopCamera(); if (S.paid) freshOrder(); S.screen = 'home'; S.back = 'home'; render(); });
$('#tl-cash').addEventListener('click', askCash);
$('#tl-printer').addEventListener('click', () => goTo('printer'));
$('#tl-close').addEventListener('click', () => goTo('close'));
$('#tl-queue').addEventListener('click', showQueue);
// The waiting sales stay in this tablet's storage through Keluar and go out after the next sign-in.
const leave = () => { try { localStorage.removeItem('hs-till-boot'); } catch { /* private window */ } return signOut(); };
$('#logout').addEventListener('click', () => {
  if (!off.pending()) { leave(); return; }
  ask({ title: 'Keluar dari kasir?', confirm: 'Keluar',
    body: `<p>${off.pending()} penjualan offline belum terkirim. Penjualan itu tetap tersimpan di tablet ini dan terkirim setelah masuk lagi dengan akun kasir. Jangan hapus data browser.</p>`,
    run: leave });
});
const net = () => {
  if (!navigator.onLine) { markOffline(); return; }
  if (off.pending()) sendQueued(); else probe();
  refreshCatalog(true);
};
document.addEventListener('visibilitychange', () => { tick(); if (!document.hidden) refreshCatalog(true); });
window.addEventListener('online', net);
window.addEventListener('offline', net);
window.addEventListener('pagehide', stopCamera);
start();
