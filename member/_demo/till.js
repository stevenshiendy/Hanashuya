// Demo only (_demo-till.html): the helpers of js/lib.js plus a fake rpc that answers every
// call js/till.js makes, with the same maths and Indonesian errors as pos.sql.
// URL: ?role=staff|manager|owner  &shift=0 (no open shift)  &offline=1  &malam (Diskon 50% malam on)
// Till v2 (13 Nov 2026): order note, Bayar 2 cara (campur), refund of some pieces, 50% malam and
// 50% instruksi, promo counts on the rekap, pre-orders without DP.
import * as V from './sample-views.js';
import { localCharges } from '../js/till-offline.js';
// ?pajak=1 turns on service charge 5% and PBJT 10% added on top; ?pajak=inc puts PBJT inside the price.
const CHARGES = (() => { const v = new URLSearchParams(location.search).get('pajak'); return v ? { service_on: true, service_pct: 5, pbjt_on: true, pbjt_pct: 10, pbjt_included: v === 'inc' } : null; })();
import { data as sampleData, addD } from './sample-data.js';
export const configured = true;
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TZ = 'Asia/Jakarta';
export const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
export const time = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const when = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const day = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
// Busy buttons (charles-ux-animation, 14 Nov 2026): the button is disabled on the same frame (no double
// taps), but the busy label ("Menyimpan…") shows only after 300 ms, so fast answers never flash it, and
// once shown it stays at least 500 ms, so slow answers don't flicker.
const BUSY_DELAY = 300, BUSY_MIN = 500;
const busyState = new WeakMap();
export function busy(btn, on, label) {
  if (!btn) return;
  const prev = busyState.get(btn);
  if (prev) clearTimeout(prev.timer);
  if (on) {
    const st = { label: prev?.label ?? btn.textContent, busyText: label || '', shownAt: 0, timer: 0 };
    btn.dataset.label = st.label;
    if (label) st.timer = setTimeout(() => { btn.textContent = label; st.shownAt = performance.now(); }, BUSY_DELAY);
    busyState.set(btn, st);
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    return;
  }
  const done = () => {
    busyState.delete(btn);
    // Only put the label back if nothing else changed the text meanwhile (some callers set a new label).
    if (prev && prev.shownAt && btn.textContent === prev.busyText) btn.textContent = prev.label;
    btn.disabled = false;
    btn.setAttribute('aria-busy', 'false');
  };
  const left = prev?.shownAt ? BUSY_MIN - (performance.now() - prev.shownAt) : 0;
  if (left > 0) { prev.timer = setTimeout(done, left); busyState.set(btn, prev); } else done();
}
export function notice(el, msg, kind = 'error') {
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.className = 'notice notice-' + kind;
  el.textContent = msg;
  el.hidden = false;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}
// toast(msg) shows a short status line for 3.5 s. toast(msg, { undo }) adds a Batalkan button and stays
// 5 s, so a removal can be put back (14 Nov 2026). It rises in over --dur-short and leaves in 150 ms (app.css).
let toastTimer, toastOut;
export function toast(msg, opts = {}) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.hidden = true; document.body.append(t); }
  clearTimeout(toastTimer); clearTimeout(toastOut);
  const wasShown = !t.hidden && t.classList.contains('is-in');
  t.textContent = '';
  const span = document.createElement('span'); span.textContent = msg; t.append(span);
  if (typeof opts.undo === 'function') {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'toast-act'; b.textContent = opts.undoLabel || 'Batalkan';
    b.addEventListener('click', () => { hide(); opts.undo(); }, { once: true });
    t.append(b);
  }
  t.classList.remove('is-out');
  t.hidden = false;
  if (!wasShown) { t.classList.remove('is-in'); void t.offsetWidth; }
  t.classList.add('is-in');
  function hide() {
    clearTimeout(toastTimer);
    t.classList.add('is-out'); t.classList.remove('is-in');
    toastOut = setTimeout(() => { t.hidden = true; t.classList.remove('is-out'); }, 150);
  }
  toastTimer = setTimeout(hide, opts.undo ? 5000 : 3500);
}
export function toPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('62')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 9 && d.length <= 13 && d.startsWith('8') ? '+62' + d : null;
}
export const prettyPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '').replace(/^62/, '');
  return d ? '+62 ' + d.replace(/(\d{3})(\d{4})(\d+)/, '$1-$2-$3') : '';
};
export const session = async () => true;
// As lib.js: the till sets a 15 s limit; ?slow=<ms> (or window.demoDelay) makes every call that slow.
let rpcLimit = 0;
export const setRpcTimeout = (ms) => { rpcLimit = Number(ms) || 0; };
export function maxBirth17(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).split('-').map(Number);
  const dd = m === 2 && d === 29 ? 28 : d;
  return `${y - 17}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
export function qrSvg(text) { if (!window.qrcode) return ''; const q = window.qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }); }
// Keluar in the demo: show what the real page shows after signing out (the login screen).
export const signOut = () => {
  document.querySelectorAll('.tl-bar .tl-ghost').forEach((b) => { b.hidden = true; });
  document.querySelector('#tl-shift').textContent = '';
  document.querySelector('#app').classList.remove('is-till');
  document.querySelector('#app').innerHTML = `<section class="panel stack tl-solo"><h1>Masuk ke kasir</h1>
    <p>Anda sudah keluar. Di kasir yang sebenarnya, layar ini adalah halaman masuk.</p>
    <a class="btn" href="${location.pathname}">Masuk lagi (demo)</a></section>`;
};
export const setupMissing = (root) => { root.textContent = 'Belum diatur.'; };
export const mountLogin = (root) => { root.textContent = 'Masuk (demo)'; };

/* ---------------------------------------------------------------- fake database */
const q = new URLSearchParams(location.search);
const role = q.get('role') || 'staff';
// &jam=20.30 moves the clock to that WIB time today (demo only, for the closing reminder).
if (q.get('jam')) {
  const [jh, jm] = q.get('jam').split('.').map(Number), RD = Date;
  const wib = new RD(RD.now() + 7 * 3600000), want = RD.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate(), jh, jm || 0) - 7 * 3600000;
  const shift = want - RD.now();
  globalThis.Date = class extends RD { constructor(...x) { if (x.length) super(...x); else super(RD.now() + shift); } static now() { return RD.now() + shift; } };
}
if (q.get('offline') === '1') Object.defineProperty(navigator, 'onLine', { get: () => false });
// role=manager signs in as Ranny with the manager role, so no made-up person is listed. Whoever
// is clocked in today (att_on_duty of the shared sample data) is in the staff picker; the person
// signed in is Ranny, or Fajar when Ranny is off today.
const SD = sampleData();
const duty = V.onDuty();
const meId = duty.some((x) => x.id === 's-ranny') ? 's-ranny' : duty.some((x) => x.id === 's-fajar') ? 's-fajar' : 's-ranny';
const meFull = SD.staff.find((x) => x.id === meId).full_name;
const ME = role === 'owner' ? { id: 'o-glenn', name: 'Glenn Shiendy' } : { id: meId, name: meFull };
const now = () => new Date().toISOString();
const hoursAgo = (h, m = 0) => new Date(Date.now() - (h * 60 + m) * 60000).toISOString();

// Categories as seeded in pos.sql, plus one the owner added (demo only) so the tabs show a
// product without flavours. Add &cats=seed for exactly the three seeded categories.
const categories = [{ id: 1, name: 'Signature' }, { id: 2, name: 'Mini Choux' }, { id: 3, name: 'Lainnya' }, { id: 4, name: 'Pistachoux' }];
const products = [
  { code: 'sig1', name: 'Signature 1 pcs', category_id: 1, price: 20000, is_box: false, needs_flavour: true, flavour_surcharge: 0 },
  { code: 'sig6', name: 'Signature Box isi 6', category_id: 1, price: 120000, is_box: true, needs_flavour: true, flavour_surcharge: 3000 },
  { code: 'mini15', name: 'Mini Box isi 15', category_id: 2, price: 99000, is_box: true, needs_flavour: true, flavour_surcharge: 3000 },
  { code: 'mini8', name: 'Mini Box isi 8', category_id: 2, price: 68000, is_box: true, needs_flavour: true, flavour_surcharge: 3000 },
  { code: 'bag', name: 'Paper bag', category_id: 3, price: 5000, is_box: false, needs_flavour: false, flavour_surcharge: 0 },
  { code: 'pistachoux_1_pcs', name: 'Pistachoux 1 pcs', category_id: 4, price: 35000, is_box: false, needs_flavour: false, flavour_surcharge: 0 },
];
if (q.get('cats') === 'seed') { categories.pop(); products.pop(); }
const flavours = [
  { id: 'vanilla', label: 'Vanilla', surcharge: false }, { id: 'choco', label: 'Choco', surcharge: true },
  { id: 'matcha', label: 'Matcha', surcharge: true }, { id: 'matcha_strawberry', label: 'Matcha Strawberry', surcharge: true },
];
// As pos_catalog: every active staff account (Ranny, Fajar, Kevin, Yuya), not only who is on shift today.
const staff = SD.staff.filter((x) => ['staff', 'manager'].includes(x.role) || x.id === meId)
  .map((x) => ({ id: x.id, name: x.name, full_name: x.full_name, role: role === 'manager' && x.id === meId ? 'manager' : x.role === 'manager' ? 'staff' : x.role, is_me: x.id === ME.id }));
const gshift = V.currentShift();
let shift = q.get('shift') === '0' ? null : { id: gshift.id, opened_at: gshift.opened_at, opening_cash: gshift.opening_cash, opened_by: gshift.opened_by.name, device: gshift.device };
let closedShift = null;
// Stok minimum set in this demo visit (item id -> minimum). Vla Matcha starts set high so the
// Dashboard shows the warning; ?low=0 hides it.
const minSet = {};
{ const vm = V.stockItems().find((i) => i.code === 'vla_matcha'); if (vm && q.get('low') !== '0') minSet[vm.id] = Math.ceil(vm.qty / 100) * 100 + 500; }
const moves = gshift.moves.filter((m) => m.at <= SD.nowIso && m.kind !== 'setor');
const ends = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
const cardCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
const members = {};
for (const m of SD.members.filter((x) => x.joined_day <= SD.today)) {
  members[m.id] = { first_name: m.first, full_name: m.name, card_code: cardCode(m.code), position: m.position, card_size: 10, waiting: 0, has_demography: m.id === 'rina' ? false : !!m.gender,
    whatsapp: m.id === 'desi' ? null : m.phone, rupiah_per_stamp: 50000, rewards: m.ready.map(({ label, cycle, slot }) => ({ label, cycle, slot })),
    vouchers: m.vouchers.map(({ kind, period, title, label, ends_on, pos_code }) => ({ kind, period, title, label, ends_on, pos_code })) };
}
const memberKey = (id) => id;
// Owner promos for the demo (Promo tab in the owner page).
const customPromos = [
  { id: 1, name: 'Diskon Akhir Pekan', kind: 'persen', value: 10, products: ['mini15', 'mini8'], min_spend: 0, member_only: false, note: null, time_to: null },
  { id: 2, name: 'Member Potong 15rb', kind: 'rupiah', value: 15000, products: null, min_spend: 100000, member_only: true, note: 'Tanya dulu sudah follow Instagram', time_to: '17.00' },
  // Voucher-code promos (14 Nov 2026): not listed, used by typing the code in Kode voucher.
  { id: 3, name: 'Diskon 10% (DISKONSTAMP1)', kind: 'persen', value: 10, products: null, min_spend: 0, member_only: false, note: 'Voucher lama VireoPOS (DISKONSTAMP1), untuk input ulang pesanan', time_to: null },
  { id: 4, name: 'Diskon 20% (DISKONSTAMP2)', kind: 'persen', value: 20, products: null, min_spend: 0, member_only: false, note: null, time_to: null, code: 'DISKONSTAMP2' },
];
const tickets = {};
// Who can instruct Diskon 50% (pos_catalog().promos.instructors): managers and the owner.
const INSTRUCTORS = [...SD.staff.filter((x) => x.role === 'manager').map((x) => ({ id: x.id, name: x.name, role: 'manager' })), { id: 'o-glenn', name: 'Glenn', role: 'owner' }];
const openCard = (key, via, extra = {}) => {
  const t = crypto.randomUUID();
  const m = structuredClone(members[key]);
  tickets[t] = key;
  return { ticket: t, via, ...m, full_name: via === 'nomor' || via === 'daftar' || key === 'desi' ? m.full_name : null, ...extra };
};
const gen = V.todayOrders().filter((o) => o.sold_at <= SD.nowIso);
const orders = gen.slice().reverse().map((o) => ({ ...V.orderRow(o), cash_received: o.cash_received, change: o.change }));
// Tutup shift screenshots: nothing waiting for payment.
if (['close', 'closed', 'closed-80'].includes(q.get('s'))) orders.filter((o) => o.status === 'menunggu').forEach((o) => Object.assign(o, { status: 'dibayar', payment_method: 'qris' }));
const full = role !== 'staff';
let printedAt = null;
const receipts = {};
let seq = gen.length + 1;
const rno = (n) => 'HS-' + SD.today.slice(2, 4) + SD.today.slice(5, 7) + SD.today.slice(8, 10) + '-' + String(n).padStart(4, '0');
const fail = (m) => { throw new Error(m); };

function price(p, mkey) {
  if (!Array.isArray(p.items) || !p.items.length) fail('Pesanan masih kosong.');
  let lines = [], subtotal = 0, goods = 0, boxes = 0, n = 0;
  for (const it of p.items) {
    const pr = products.find((x) => x.code === it.product) || fail('Produk tidak dikenal atau sedang tidak dijual.');
    let fl = null;
    if (pr.needs_flavour) fl = flavours.find((f) => f.id === it.flavour) || fail(`Pilih rasa untuk ${pr.name}.`);
    const sur = fl && fl.surcharge ? pr.flavour_surcharge : 0, unit = pr.price + sur;
    lines.push({ line: ++n, code: pr.code, name: pr.name, flavour: fl?.id || null, flavour_label: fl?.label || null, qty: it.qty, unit_price: unit, surcharge: sur, line_total: unit * it.qty, discount: 0, free_bag: false, is_box: pr.is_box });
    subtotal += unit * it.qty; if (pr.code !== 'bag') goods += unit * it.qty; if (pr.is_box) boxes += it.qty;
  }
  const bags = p.free_bags || 0;
  if (bags > Math.floor(boxes / 2)) fail(`Paper bag gratis hanya 1 untuk setiap 2 box (pesanan ini: ${Math.floor(boxes / 2)}).`);
  if (bags > 0) lines.push({ line: ++n, code: 'bag', name: 'Paper bag', flavour: null, flavour_label: null, qty: bags, unit_price: 0, surcharge: 0, line_total: 0, discount: 0, free_bag: true, is_box: false });
  let disc = 0, promo = null;
  if (p.promo && (p.promo.kind === 'malam50' || p.promo.kind === 'instruksi50')) {
    // Half price per item: box products from 19.00 (malam), every product when instructed.
    const malam = p.promo.kind === 'malam50';
    if (malam && !q.has('malam') && new Date().getHours() < 19) fail('Diskon 50% flash sale mulai pukul 19.00. Sebelum itu hanya Diskon 50% atas instruksi manajer atau pemilik.');
    const who = INSTRUCTORS.find((x) => x.id === p.promo.by);
    if (!malam && !who) fail('Pilih manajer atau pemilik yang menginstruksikan Diskon 50%.');
    for (const l of lines) { if (l.code === 'bag' || (malam && !l.is_box)) continue; l.discount = Math.floor(l.line_total / 2); disc += l.discount; }
    if (!disc) fail(malam ? 'Diskon 50% flash sale hanya untuk produk box. Tambahkan box ke pesanan.' : 'Diskon 50% perlu minimal 1 produk di pesanan.');
    promo = { ...p.promo, label: malam ? 'Diskon 50% malam' : `Diskon 50% instruksi ${who.name}`, line: null, discount: disc, by: who?.id || null };
  } else if (p.promo && p.promo.kind === 'promo') {
    // Owner promos (pos_promos), same maths as pos.sql.
    const op = customPromos.find((x) => x.id === p.promo.period) || fail('Promo tidak dikenal.');
    if (op.member_only && !mkey) fail(`Promo ${op.name} khusus member. Scan kartu member dulu.`);
    if (goods < op.min_spend) fail(`Promo ${op.name} perlu belanja minimal ${rupiah(op.min_spend)} (sekarang ${rupiah(goods)}).`);
    let left = op.value;
    for (const l of lines) {
      if (l.code === 'bag' || (op.products && !op.products.includes(l.code))) continue;
      const d = op.kind === 'persen' ? Math.floor(l.line_total * op.value / 100) : Math.min(left, l.line_total);
      if (op.kind === 'rupiah') left -= d;
      l.discount = d; disc += d;
    }
    if (!disc) fail(`Promo ${op.name} berlaku untuk: ${op.products.map((c) => products.find((x) => x.code === c).name).join(', ')}.`);
    promo = { ...p.promo, label: op.name, line: null, discount: disc };
  } else if (p.promo) {
    if (!mkey) fail('Promo member hanya bisa dipakai setelah kartu member discan.');
    const m = members[mkey];
    let rule, val, only = null, label;
    if (p.promo.kind === 'stempel') {
      const r = m.rewards.find((x) => x.cycle === p.promo.cycle && x.slot === p.promo.slot) || fail('Hadiah ini sudah dipakai atau belum terbuka.');
      label = r.label; rule = 'persen'; val = r.slot === 3 ? 10 : r.slot === 7 ? 20 : 100; if (r.slot === 10) rule = 'gratis_produk';
    } else {
      const v = m.vouchers.find((x) => x.kind === p.promo.kind && x.period === p.promo.period) || fail('Voucher ini sudah dipakai atau sedang tidak berlaku.');
      label = v.label;
      if (v.kind === 'welcome') { rule = 'persen_satu'; val = 50; } else { rule = 'gratis_produk'; val = 100; only = v.kind === 'ulang_tahun' ? 'mini8' : 'sig1'; }
    }
    let target = p.promo.line || null;
    if (rule === 'persen') disc = Math.floor(goods * val / 100);
    else {
      const c = lines.filter((l) => l.code !== 'bag' && (!only || l.code === only)).map((l) => l.line);
      if (!c.length) fail(`Tambahkan ${products.find((x) => x.code === only).name} ke pesanan dulu untuk voucher ini.`);
      if (!target) { if (c.length > 1) fail('Pilih produk yang mendapat promo.'); target = c[0]; }
      else if (!c.includes(target)) fail('Promo ini tidak berlaku untuk produk yang dipilih.');
      disc = Math.floor(lines[target - 1].unit_price * val / 100); lines[target - 1].discount = disc;
    }
    promo = { ...p.promo, label, line: target, discount: disc };
  }
  return { channel: 'toko', delivery: false, lines, subtotal, discount: disc, promo, boxes, free_bags: bags, free_bags_max: Math.floor(boxes / 2), ...localCharges(CHARGES, subtotal - disc, false) };
}

function receiptOf(o) {
  const m = o.mkey ? members[o.mkey] : null;
  const pos = m ? m.position : null;
  return {
    id: o.id, receipt_no: o.receipt_no, status: o.status, outlet: 'Papaya Fresh Gallery Bandung', channel: 'toko', channel_label: 'Di booth',
    sold_at: o.sold_at, date: day(o.sold_at), time: time(o.sold_at), served_by: staff.find((s) => s.id === o.served)?.name || 'Ranny',
    member: m ? m.first_name : null, customer_name: o.customer_name || null,
    lines: o.q.lines.map((l, i) => ({ line: l.line ?? i + 1, code: l.code, name: l.name, flavour: l.flavour_label, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total, discount: l.discount, free_bag: l.free_bag, refunded_qty: l.refunded_qty || 0 })),
    subtotal: o.q.subtotal, discount: o.q.discount, promo_label: o.q.promo?.label || null, promo_kind: o.q.promo?.kind || null,
    promo_by: o.q.promo?.by ? INSTRUCTORS.find((x) => x.id === o.q.promo.by)?.name || null : null,
    promo_product: o.q.promo ? o.q.lines.find((l) => l.discount > 0)?.name : null,
    service_charge: o.q.service_charge || 0, service_pct: o.q.service_pct, tax: o.q.tax || 0, tax_pct: o.q.tax_pct, tax_included: !!o.q.tax_included,
    total: o.q.total, payment_method: o.method || null, cash_received: o.cash ?? null,
    change: o.cash != null ? o.cash - (o.method === 'campur' ? o.split.tunai : o.q.total) : null,
    payments: o.method === 'campur' ? [{ method: 'qris', amount: o.split.qris }, { method: 'tunai', amount: o.split.tunai }]
      : ['tunai', 'qris'].includes(o.method) && o.q.total > 0 ? [{ method: o.method, amount: o.q.total }] : [],
    note: o.note || null, refunded: o.refunded || 0, refunds: o.refunds || [],
    stamps: o.stamps || 0,
    card: m ? { position: pos, size: 10, waiting: 0, next_label: 'Diskon 10%', next_in: Math.max(0, 3 - pos) } : null,
    new_rewards: m && o.stamps ? [] : null, rewards_ready: m ? [] : null,
  };
}

const delay = (ms) => new Promise((ok) => setTimeout(ok, ms));
export async function rpc(name, a = {}, { timeout = rpcLimit } = {}) {
  const wait = window.demoDelay ?? Number(q.get('slow') || 60);
  if (timeout > 0 && wait >= timeout) { await delay(timeout); throw new Error('Koneksi lambat, waktu habis. Periksa internet, lalu coba lagi.'); }
  await delay(wait);
  return fake(name, a);
}
async function fake(name, a) {
  // ?net=0 (or window.demoNet = false) acts as if the internet were down (task 7).
  if (window.demoNet === false || (window.demoNet == null && q.get('net') === '0')) throw new Error('Tidak ada koneksi. Periksa internet, lalu coba lagi.');
  const tk = (t) => { if (!t) return null; if (!tickets[t]) fail('Scan kartu sudah lewat 10 menit. Scan ulang kartunya.'); return tickets[t]; };
  switch (name) {
    // Default: the kasir tablet account (role 'staff' with kasir_tablet, 13 Nov 2026). ?akun=staf
    // signs in with a personal staff account instead, so the QR screens show why there is no QR.
    case 'whoami': return role === 'staff' && q.get('akun') !== 'staf' ? { id: 'k-tablet', role, kasir_tablet: true, full_name: 'Kasir tablet', username: 'kasir.booth', whatsapp: null }
      : { id: ME.id, role, full_name: ME.name, whatsapp: '6281200000000' };
    case 'pos_catalog': return { categories: structuredClone(categories), products: structuredClone(products), flavours, channels: [{ id: 'toko', label: 'Di booth', delivery: false }], staff: structuredClone(staff), shift, rupiah_per_stamp: 50000, charges: CHARGES,
      promos: { bogo_active: new URLSearchParams(location.search).has('bogo'), bogo_from: '19.00', tebus_murah_ktp: 'KTP Bandung', custom: q.get('promos') === '0' ? [] : customPromos,
        malam50_active: q.has('malam'), malam50_from: '19.00', instructors: INSTRUCTORS } };
    case 'pos_quote': return price(a.p_order, tk(a.p_order.ticket));
    case 'sample_quota_now': return { hour: 15, quota: 2, given: 1 };   // Laporan sampel kuota (14 Nov 2026)
    case 'stock_sample': { const n = (a.p_sample.items || []).reduce((t, x) => t + x.qty, 0); if (!n) fail('Pilih produk untuk sampel.'); return { id: a.p_sample.id, pieces: n, items: [], served_by: 'Ranny' }; }
    case 'pos_checkout': {
      // As pos.sql (13 Nov 2026): a payment for an order cancelled meanwhile, or with a batal
      // request waiting, is not recorded; the reply says why.
      const o = receipts[a.p_order.id], row = orders.find((x) => x.id === a.p_order.id);
      if (o && a.p_order.payment?.method && (o.status === 'batal' || row?.void_pending)) {
        return { ...receiptOf(o), repeat: true, rejected: o.status === 'batal' ? 'batal' : 'menunggu_batal' };
      }
      window.demoSent = (window.demoSent || []).concat([a.p_order]);
      if (o) { Object.assign(o, { status: 'dibayar', method: a.p_order.payment?.method, cash: a.p_order.payment?.cash ?? null, local_no: o.local_no || a.p_order.local_no || null }); if (row) Object.assign(row, { status: 'dibayar', payment_method: o.method }); }
      return { id: a.p_order.id, status: 'dibayar', receipt_no: o?.receipt_no || rno(99), local_no: o?.local_no || a.p_order.local_no };
    }
    // Pesanan di muka (pos-reservasi.sql), enough to drive the till's pickup.
    // No DP since 13 Nov 2026: the whole total is paid at pickup.
    case 'pos_reservation_today': return [{ id: 'rsv-1', no: 'PM-261113-01', customer_name: 'Dewi', pickup_time: '15:00', pickup_at: now(), items_text: '1 Signature Box isi 6',
      total: 120000, deposit: 0, due: 120000, status: 'siap' }];
    case 'pos_reservation_get': return { id: 'rsv-1', no: 'PM-261113-01', customer_name: 'Dewi', status: 'siap', total: 120000, deposit: 0, due: 120000, free_bags: 0, note: 'Pita merah',
      member: null, items: [{ qty: 1, name: 'Signature Box isi 6', flavour_label: 'Vanilla', line_total: 120000 }] };
    case 'pos_reservation_checkout': {
      const pm = a.p_order.payment || {}, due = 120000;
      if (pm.method === 'tunai' && !(pm.cash >= due)) fail(`Uang diterima kurang dari total ${rupiah(due)}.`);
      const o = { id: a.p_order.id, served: a.p_order.served_by, q: { lines: [{ name: 'Signature Box isi 6', flavour: 'vanilla', flavour_label: 'Vanilla', qty: 1, unit_price: 120000, line_total: 120000, discount: 0, free_bag: false }], subtotal: 120000, discount: 0, total: 120000, promo: null },
        status: 'dibayar', sold_at: now(), receipt_no: rno(seq++), method: pm.method, cash: pm.method === 'tunai' ? pm.cash : null, note: 'Pita merah' };
      receipts[o.id] = o;
      return receiptOf(o);
    }
    case 'pos_place_order': {
      const p = a.p_order;
      if (receipts[p.id]) return { ...receiptOf(receipts[p.id]), repeat: true };
      if (!p.served_by) fail('Pilih siapa yang melayani.');
      const mkey = tk(p.ticket);
      if (p.note && String(p.note).trim().length > 200) fail(`Catatan pesanan paling panjang 200 huruf (sekarang ${String(p.note).trim().length}).`);
      const o = { id: p.id, mkey, served: p.served_by, q: price(p, mkey), status: 'menunggu', sold_at: now(), receipt_no: rno(seq++), note: String(p.note || '').trim() || null, customer_name: String(p.customer_name || '').trim() || null };
      receipts[p.id] = o;
      // Like the real server: the reward or voucher is used up as soon as the order is confirmed,
      // so the same card can't use it again (Glenn, 12 Nov 2026: free Signature used twice in the demo).
      if (mkey && p.promo && !['bogo', 'promo', 'malam50', 'instruksi50'].includes(p.promo.kind)) {
        const m = members[mkey];
        o.held = { mkey, rewards: m.rewards.slice(), vouchers: m.vouchers.slice() };
        if (p.promo.kind === 'stempel') m.rewards = m.rewards.filter((x) => !(x.cycle === p.promo.cycle && x.slot === p.promo.slot));
        else m.vouchers = m.vouchers.filter((x) => !(x.kind === p.promo.kind && x.period === p.promo.period));
      }
      orders.unshift({ id: o.id, receipt_no: o.receipt_no, sold_at: o.sold_at, total: o.q.total, payment_method: null, status: 'menunggu', stamps: 0, promo_label: o.q.promo?.label || null, served_by: staff.find((x) => x.id === p.served_by)?.name || 'Ranny', member: mkey ? members[mkey].first_name : null, void_pending: false, note: o.note, customer_name: o.customer_name, refunded: 0 });
      return receiptOf(o);
    }
    case 'pos_pay': {
      // A waiting order from the sample data, picked up again with Lanjutkan bayar.
      if (!receipts[a.p_id] && SD.orderById[a.p_id]) {
        const g = SD.orderById[a.p_id], pm = a.p_payment || {};
        if (g.status === 'dibayar') return { ...V.receiptOf(g), repeat: true };
        if (pm.method === 'tunai' && !(pm.cash >= g.total)) fail(`Uang diterima kurang dari total ${rupiah(g.total)}.`);
        if (!['tunai', 'qris'].includes(pm.method) && g.total > 0) fail('Pilih Tunai atau QRIS.');
        Object.assign(g, { status: 'dibayar', payment_method: g.total === 0 ? 'gratis' : pm.method,
          cash_received: pm.method === 'tunai' ? pm.cash : null, change: pm.method === 'tunai' ? pm.cash - g.total : null, sold_at: now() });
        const row = orders.find((x) => x.id === g.id);
        if (row) Object.assign(row, { status: 'dibayar', payment_method: g.payment_method, cash_received: g.cash_received, change: g.change });
        return V.receiptOf(g);
      }
      const o = receipts[a.p_id] || fail('Pesanan tidak ditemukan.');
      if (o.status === 'dibayar') return { ...receiptOf(o), repeat: true };
      const pm = a.p_payment || {};
      if (o.q.total === 0) o.method = 'gratis';
      else if (pm.method === 'tunai') {
        if (!(pm.cash >= o.q.total)) fail(`Uang diterima kurang dari total ${rupiah(o.q.total)}.`);
        o.method = 'tunai'; o.cash = pm.cash;
      } else if (pm.method === 'qris') o.method = 'qris';
      else if (pm.method === 'campur') {
        // Bayar 2 cara, as pos.sql: the parts add up to the total; change only from the Tunai part.
        if (!(pm.tunai > 0 && pm.qris > 0)) fail('Isi bagian Tunai dan bagian QRIS, masing-masing lebih dari Rp0.');
        if (pm.tunai + pm.qris !== o.q.total) fail(`Tunai ${rupiah(pm.tunai)} ditambah QRIS ${rupiah(pm.qris)} harus sama dengan total ${rupiah(o.q.total)}.`);
        const c = pm.cash ?? pm.tunai;
        if (c < pm.tunai) fail(`Uang tunai diterima kurang dari bagian Tunai ${rupiah(pm.tunai)}.`);
        o.method = 'campur'; o.cash = c; o.split = { tunai: pm.tunai, qris: pm.qris };
      } else fail('Pilih Tunai atau QRIS.');
      o.status = 'dibayar';
      if (o.mkey) { o.stamps = Math.floor(o.q.total / 50000); members[o.mkey].position += o.stamps; }
      const row = orders.find((x) => x.id === o.id); if (row) Object.assign(row, { status: 'dibayar', payment_method: o.method, stamps: o.stamps || 0, cash_received: o.cash ?? null, change: o.cash != null ? o.cash - (o.split ? o.split.tunai : o.q.total) : null, split: o.split || null });
      return receiptOf(o);
    }
    case 'pos_receipt': {
      if (receipts[a.p_id]) return receiptOf(receipts[a.p_id]);
      const g = SD.orderById[a.p_id] || fail('Struk tidak ditemukan.');
      return V.receiptOf(g);
    }
    // Home screen (design A), the sample day of pos-kasir/home-drafts.html. &target=omzet shows a rupiah target.
    case 'pos_home': {
      const h = V.posHome({ omzet: q.get('target') === 'omzet' });
      const paidNow = orders.filter((o) => o.status === 'dibayar');
      h.waiting = orders.filter((o) => o.status === 'menunggu').length;
      { const w = orders.filter((o) => o.status === 'menunggu'), c = orders.filter((o) => o.status === 'batal' || o.status === 'refund');
        h.pending_count = w.length; h.pending_amount = w.reduce((t, o) => t + o.total, 0);
        h.cancelled_count = c.length; h.cancelled_amount = c.reduce((t, o) => t + o.total, 0); h.cancelled = c.length; }
      h.drawer = shift && full ? shiftJson().expected_cash : null; h.drawer_low = shift && full ? shiftJson().expected_cash < 200000 : null;
      if (paidNow.length !== h.orders) { // orders taken in this demo session
        h.orders = paidNow.length; h.revenue = paidNow.reduce((t, o) => t + o.total, 0); h.average = h.orders ? Math.round(h.revenue / h.orders) : 0;
        h.by_method = { tunai: paidNow.filter((o) => o.payment_method === 'tunai').reduce((t, o) => t + o.total, 0), qris: paidNow.filter((o) => o.payment_method === 'qris').reduce((t, o) => t + o.total, 0) };
        if (h.target.kind === 'omzet') Object.assign(h.target, { current: h.revenue, percent: Math.round(h.revenue * 100 / h.target.value), remaining: Math.max(0, h.target.value - h.revenue) });
      }
      return h;
    }
    case 'pos_void_list': return orders.filter((o) => o.void_pending).map((o, i) => { const g = SD.orderById[o.id], va = o.void_ask; return { id: i + 1, kind: va?.kind || g?.void?.kind || 'batal', receipt_no: o.receipt_no,
      total: va?.kind === 'refund' ? va.amount : o.total, payment_method: va?.kind === 'refund' ? va.method : o.payment_method,
      requested_by: g?.void?.requested_by || o.served_by, created_at: g?.void?.created_at || hoursAgo(0, 20), reason: g?.void?.reason || 'Salah input rasa' }; });
    case 'manager_pending_undo': return [];
    // 14 Nov 2026: &opname=0 (none sent), 1 (sent, not the closing one), 2 (both); the bar shows from 20.00 WIB.
    case 'stock_count_today': { const o = q.get('opname') ?? '0'; return { day: now().slice(0, 10), sent: o !== '0', closing: o === '2' }; }
    case 'stock_cancel_pending': if (role === 'staff') fail('Hanya pemilik atau manajer.'); return stockAsks.slice();
    case 'stock_cancel_decide': { const i = stockAsks.findIndex((x) => x.id === a.p_id); if (i < 0) fail('Permintaan ini sudah diputuskan.'); stockAsks.splice(i, 1); return { id: a.p_id, status: a.p_approve ? 'disetujui' : 'ditolak' }; }
    case 'pos_decide_void': { const o = orders.find((x) => x.void_pending); if (o) { o.void_pending = false; if (a.p_approve) o.status = 'batal'; } return null; }
    case 'att_on_duty': return V.onDuty();
    case 'att_tablet_location': return a.p_acc > 200 ? { saved: false, acc_m: Math.round(a.p_acc), location_set: true } : { saved: true, acc_m: Math.round(a.p_acc), location_set: true };
    case 'att_qr_token': if (!(role === 'staff' && q.get('akun') !== 'staf')) fail('QR absen hanya tampil di akun kasir tablet. Keluar, lalu masuk dengan akun kasir tablet dari pemilik.'); { const w = Math.floor(Date.now() / 20000); return { kind: a.p_kind || 'absen', token: `${a.p_kind === 'istirahat' ? 'HSB1' : 'HSA1'}.${w}.demo0000demo0000`, seconds: 20, expires_in: 20 - (Math.floor(Date.now() / 1000) % 20) }; }
    case 'stock_catalog': return { role, items: V.stockItems(), suppliers: [{ id: 1, name: 'Hanashuya' }, { id: 2, name: 'Toko Sejati' }], staff: staff.map((x) => ({ id: x.id, name: x.name, is_me: x.is_me })) };
    case 'stock_now': return V.stockItems().map((i) => (i.id in minSet ? { ...i, low_level: minSet[i.id], low: minSet[i.id] != null && i.qty <= minSet[i.id] } : i));
    case 'stock_today': return V.stockToday();
    // Stok minimum (12 Nov 2026): the Dashboard warning, and a manager or the owner setting it.
    case 'stock_low': return V.stockItems().map((i) => (i.id in minSet ? { ...i, low_level: minSet[i.id] } : i))
      .filter((i) => i.low_level != null && i.qty <= i.low_level);
    case 'stock_set_minimum': {
      if (role === 'staff') fail('Stok minimum hanya bisa diatur manajer atau pemilik.');
      const it = V.stockItems().find((i) => i.id === a.p_item) || fail('Barang tidak dikenal.');
      minSet[it.id] = a.p_min; return { id: it.id, name: it.name, unit: it.unit, min: a.p_min, stock: it.qty };
    }
    case 'stock_count_pending': return V.countPending();
    case 'stock_goods_in_list': return V.goodsInList(a);
    case 'stock_opname_list': { const rows = V.opnameList(a).map((x) => ({ ...x, status: cancelledCounts.has(x.id) ? 'dibatalkan' : x.status, cancel_pending: false }));
      const top = rows.find((x) => ['menunggu', 'diterima'].includes(x.status)); return rows.map((x) => ({ ...x, removable: x === top })); }
    case 'stock_cancel_count': cancelledCounts.add(a.p_id); return { id: a.p_id, status: 'dibatalkan' };
    case 'stock_opname_detail': return V.opnameDetail(a);
    case 'stock_request_list': return V.requestsIn(a);
    case 'stock_request_open': return V.requestsOpen();
    case 'pos_queue_slip': return !q.has('nota0');
    case 'pos_today': return structuredClone(orders);
    // Blind cash and back-to-back shifts (11 Nov 2026), as in pos.sql.
    case 'pos_open_shift': {
      if (!shift) shift = { id: 13, opened_at: now(), opening_cash: 300000, opened_by: ME.name.split(' ')[0], device: a.p_device };
      return shiftJson();
    }
    case 'pos_cash_move': {
      if (a.p_kind === 'setor' && !full) fail('Setor hanya bisa dicatat manajer atau pemilik.');
      if (!(a.p_amount > 0)) fail('Isi jumlah uang.');
      if (!String(a.p_reason || '').trim()) fail('Tulis alasannya.');
      moves.push({ kind: a.p_kind, amount: a.p_amount, reason: a.p_reason, at: now(), by: ME.name.split(' ')[0] });
      return shiftJson();
    }
    case 'pos_shift_now': return shift ? shiftJson() : null;
    case 'pos_close_shift': {
      if (orders.some((o) => o.status === 'menunggu')) fail('Masih ada pesanan yang menunggu pembayaran. Selesaikan atau minta manajer membatalkannya dulu.');
      const s = shiftJson(true);
      if (full && a.p_counted_cash !== s.expected_cash && !String(a.p_note || '').trim()) fail(`Uang di laci beda ${rupiah(a.p_counted_cash - s.expected_cash)} dari catatan. Tulis catatan sebelum menutup shift.`);
      const t = now();
      closedShift = { ...shift, closed_at: t, counted: a.p_counted_cash, note: a.p_note, den: a.p_denominations };
      shift = { id: shift.id + 1, opened_at: t, opening_cash: a.p_counted_cash, opened_by: ME.name.split(' ')[0], device: shift.device };
      moves.length = 0;
      return { ...rekapOf(closedShift), next_shift: shiftJson() };
    }
    case 'pos_shift_rekap': return rekapOf(closedShift || null);
    case 'pos_rekap_printed': {
      if (printedAt && !full) fail(`Rekap hari ini sudah dicetak jam ${time(printedAt)}. Minta manajer atau pemilik kalau perlu cetak ulang.`);
      const reprint = !!printedAt; printedAt ||= now();
      return { printed_at: printedAt, reprint, reprints: reprint ? 1 : 0, at: now() };
    }
    case 'pos_rekap_exported': return { at: now() };
    case 'pos_request_void': {
      if (!String(a.p_reason || '').trim()) fail('Tulis alasannya.');
      const row = orders.find((x) => x.id === a.p_order); if (row) { if (row.void_pending) fail('Permintaan untuk pesanan ini sudah dikirim.'); row.void_pending = true; }
      if (a.p_kind === 'refund' && !['tunai', 'transfer', 'qris'].includes(a.p_refund_method || 'tunai')) fail('Pilih uang dikembalikan lewat Tunai, Transfer atau QRIS.');
      // The amount as pos.sql works it out: the price paid for the pieces picked.
      const rc = receipts[a.p_order] ? receiptOf(receipts[a.p_order]) : SD.orderById[a.p_order] ? V.receiptOf(SD.orderById[a.p_order]) : null;
      const amount = !rc ? 0 : a.p_kind !== 'refund' ? rc.total : !a.p_lines ? rc.total - (rc.refunded || 0)
        : a.p_lines.reduce((t, x) => { const l = rc.lines.find((y, i) => (y.line ?? i + 1) === x.line); const net = l.line_total - (l.discount || 0), d = l.refunded_qty || 0;
          return t + Math.floor(net * (d + x.qty) / l.qty) - Math.floor(net * d / l.qty); }, 0);
      if (row) row.void_ask = { kind: a.p_kind, lines: a.p_lines || null, method: a.p_refund_method || null, amount };
      return { id: 1, kind: a.p_kind, amount, refund_method: a.p_refund_method || null, lines: a.p_lines || null };
    }
    case 'pos_edit_order': {
      const row = orders.find((x) => x.id === a.p_id); if (row) row.status = 'batal';
      const rc = receipts[a.p_id];
      if (rc) { rc.status = 'batal'; if (rc.held) Object.assign(members[rc.held.mkey], { rewards: rc.held.rewards, vouchers: rc.held.vouchers }); }
      return { ok: true };
    }
    case 'pos_cancel_order': {
      if (role === 'staff') fail('Pesanan yang sudah masuk pembayaran hanya bisa dibatalkan manajer atau pemilik.');
      if (!String(a.p_reason || '').trim()) fail('Tulis alasannya.');
      const row = orders.find((x) => x.id === a.p_id); if (row) row.status = 'batal';
      if (receipts[a.p_id]) receipts[a.p_id].status = 'batal';
      return { status: 'batal' };
    }
    case 'staff_lookup': {
      const code = String(a.p_scan).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.startsWith('HS1')) return openCard('desi', 'qr');
      const hit = Object.keys(members).find((k) => members[k].card_code.replace('-', '') === code);
      if (hit) return openCard(hit, 'kode');
      if (code.length !== 8) fail('Kode kartu terdiri dari 8 huruf dan angka.');
      fail('Kartu tidak ditemukan.');
      break;
    }
    case 'staff_find_phone': {
      const d = String(a.p_phone).replace(/\D/g, '');
      const num = d.replace(/^(62|0)/, '');
      const byPhone = num.length >= 9 && SD.members.find((x) => x.joined_day <= SD.today && x.phone.endsWith(num));
      if (num.endsWith('81234567890') || (byPhone && byPhone.id === 'desi')) return openCard('desi', 'nomor', { whatsapp: SD.byId.desi.phone });
      if (byPhone) return openCard(byPhone.id, 'nomor', { whatsapp: byPhone.phone });
      if (d.length < 10) fail('Tulis nomor WhatsApp lengkap, misalnya 0812 3456 7890.');
      fail('Nomor ini belum terdaftar sebagai member. Tawarkan daftar member.');
      break;
    }
    case 'staff_create_member': {
      if (!String(a.p_name || '').trim()) fail('Isi nama lengkap.');
      members.baru = { first_name: a.p_name.split(' ')[0], full_name: a.p_name, card_code: 'N3WC-4RD1', position: 0, card_size: 10, waiting: 0, has_demography: Boolean(a.p_gender),
        rupiah_per_stamp: 50000, rewards: [], vouchers: [{ kind: 'welcome', period: 0, title: 'Hadiah member baru', label: 'Diskon 50% untuk 1 produk', ends_on: ends, pos_code: 'NEWMEMBER50' }] };
      return openCard('baru', 'daftar', { whatsapp: String(a.p_phone).replace(/\D/g, ''), start_code: '12345' });
    }
    case 'staff_claim_code': {
      const key = tk(a.p_ticket);
      if (a.p_code !== 'PAPA1234') return { status: 'salah', message: 'Kode voucher tidak dikenal. Periksa lagi kode di bawah QR voucher.' };
      const m = members[key];
      // One code per account, used once (as the server): claiming again after using it gives nothing back.
      if (m.codeClaimed) return { ...openCard(key, 'qr'), status: 'sudah_punya', message: 'Voucher Papaya hanya 1 per member, dan kartu ini sudah punya.' };
      m.codeClaimed = true;
      m.vouchers.push({ kind: 'kode', period: 41, title: 'Voucher Papaya PAPA-1234', label: '1 Signature choux gratis', ends_on: '2027-01-31', pos_code: 'MANIS' });
      return { ...openCard(key, 'qr'), status: 'tersimpan' };
    }
    default: fail(`Demo: ${name} tidak ada.`);
  }
  return null;
}

function shiftJson(all = full) {
  const paid = orders.filter((o) => o.status === 'dibayar');
  const tunai = paid.filter((o) => o.payment_method === 'tunai').reduce((t, o) => t + o.total, 0);
  const qris = paid.filter((o) => o.payment_method === 'qris').reduce((t, o) => t + o.total, 0);
  const cin = moves.filter((m) => m.kind === 'masuk').reduce((t, m) => t + m.amount, 0);
  const cout = moves.filter((m) => m.kind === 'keluar').reduce((t, m) => t + m.amount, 0);
  const setor = moves.filter((m) => m.kind === 'setor').reduce((t, m) => t + m.amount, 0);
  const j = { ...shift, closed_at: null, closed_by: null, orders: paid.length, sales_total: tunai + qris, by_method: { tunai, qris }, voided: orders.filter((o) => o.status === 'batal').length,
    cash_in: cin, cash_out: cout, moves: all ? moves : moves.filter((m) => m.kind !== 'setor'), cash_received: paid.filter((o) => o.payment_method === 'tunai').reduce((t, o) => t + (o.cash_received ?? o.total), 0), change_given: paid.filter((o) => o.payment_method === 'tunai').reduce((t, o) => t + (o.change || 0), 0), counted_cash: null, note: null, blind: !all };
  delete j.opening_cash;
  if (all) Object.assign(j, { opening_cash: shift.opening_cash, setor, expected_cash: shift.opening_cash + tunai + cin - cout - setor, difference: null, flags: [] });
  return j;
}

// The rekap in the shape of pos_shift_rekap: the last closed shift of the sample data, or the shift just closed in this demo.
// Promo items per promo, as pos_shift_rekap().promos (13 Nov 2026): the sample orders of that shift
// plus the orders paid in this demo visit.
// Stock cancel requests for Persetujuan (stock.sql stock_cancel_pending, 14 Nov 2026).
const cancelledCounts = new Set();
const stockAsks = [
  { id: 1, kind: 'masuk', reason: 'Salah jumlah, harusnya 5', at: new Date(Date.now() - 40 * 60000).toISOString(), requested_by: 'Ranny', own: false, item: 'Paper bag', unit: 'pcs', qty: 10, out_kind: null, supplier: 'Hanashuya', entry_at: new Date(Date.now() - 50 * 60000).toISOString() },
  { id: 2, kind: 'keluar', reason: 'Salah pilih barang', at: new Date(Date.now() - 15 * 60000).toISOString(), requested_by: 'Fajar', own: false, item: 'Kotak Mini isi 8', unit: 'pcs', qty: 2, out_kind: 'buang', supplier: null, entry_at: new Date(Date.now() - 20 * 60000).toISOString() },
];
const PROMO_LABEL = { bogo: 'BOGO', malam50: '50% malam', instruksi50: '50% instruksi', tebus_murah: 'Tebus murah', stempel: 'Hadiah stempel',
  welcome: 'Voucher member', ulang_tahun: 'Voucher member', kode: 'Voucher member' };
const PROMO_ORDER = ['bogo', 'malam50', 'instruksi50', 'tebus_murah', 'voucher', 'stempel', 'promo'];
function withPromos(k, session) {
  const rows = {};
  const add = (kind, label, lines, disc, by) => {
    const key = ['welcome', 'ulang_tahun', 'kode'].includes(kind) ? 'voucher' : kind === 'promo' ? 'promo:' + label : kind;
    const r = rows[key] || (rows[key] = { kind: key.startsWith('promo:') ? 'promo' : key, label: PROMO_LABEL[kind] || label, orders: 0, items: 0, discount: 0, by: null });
    r.orders++; r.items += lines.filter((l) => l.discount > 0).reduce((t, l) => t + l.qty, 0); r.discount += disc;
    if (by) r.by = [...new Set([...(r.by ? r.by.split(', ') : []), by])].join(', ');
  };
  for (const o of (SD.orders || []).filter((x) => x.shift_id === k.id && x.status === 'dibayar' && x.promo && x.discount > 0)) add(o.promo.kind, o.promo.label, o.lines, o.discount);
  if (session) for (const o of Object.values(receipts).filter((x) => x.status === 'dibayar' && x.q.promo && x.q.discount > 0)) {
    add(o.q.promo.kind, o.q.promo.label, o.q.lines, o.q.discount, o.q.promo.by ? INSTRUCTORS.find((x) => x.id === o.q.promo.by)?.name : null);
  }
  const promos = Object.values(rows).sort((a, b) => PROMO_ORDER.indexOf(a.kind) - PROMO_ORDER.indexOf(b.kind));
  const split = session ? Object.values(receipts).filter((x) => x.status === 'dibayar' && x.method === 'campur').length : 0;
  return { ...k, promos, split_count: split, refunds: { partial_count: 0, by_method: {} } };
}
export function rekapOf(sh, asFull = full) {
  if (!sh) return withPromos(V.rekapOf(V.lastClosedShift(), asFull), false);
  const base = V.currentShift(), exp = base.opening_cash + orders.filter((o) => o.status === 'dibayar' && o.payment_method === 'tunai').reduce((t, o) => t + o.total, 0) + moves.filter((m) => m.kind === 'masuk').reduce((t, m) => t + m.amount, 0)
    - moves.filter((m) => m.kind === 'keluar').reduce((t, m) => t + m.amount, 0);
  const pseudo = { ...base, closed_at: sh.closed_at, closed_by: { name: ME.name.split(' ')[0] }, counted_cash: sh.counted, note: sh.note, denominations: sh.den, printed_at: printedAt, reprints: 0,
    difference: sh.counted - exp, flags: Math.abs(sh.counted - exp) > 10000 ? ['selisih_kas'] : [], moves: base.moves.filter((m) => m.at <= SD.nowIso) };
  return withPromos(V.rekapOf(pseudo, asFull), true);
}
