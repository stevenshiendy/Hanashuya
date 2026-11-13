// Working offline (POSDEVELOPMENT.md task 7, 11 Nov 2026).
//
// The supermarket Wi-Fi drops, and the till must keep selling. What works offline:
//   - walk-in sales (no member card), Tunai or QRIS, with a printed receipt;
//   - the receipt carries a local number, L + date + device + running number;
//   - each sale waits in this tablet's storage and is sent with pos_checkout when the
//     internet is back, once (the server keys it on the order id made here).
// What needs the internet: member cards, rewards, vouchers and every promo (they must be
// checked live so they can't be used twice), Hari ini, Kas masuk/keluar, Tutup shift.
// Prices offline come from the last catalogue this tablet loaded; the server works the
// total out again and flags harga_offline_beda when it differs.

const K_QUEUE = 'hs-till-queue';
const K_BOOT = 'hs-till-boot';
const K_DEV = 'hs-till-dev';
const K_SEQ = 'hs-till-lno';
const K_CHECK = 'hs-till-check';

const read = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export const isNetError = (e) => /Tidak ada koneksi|Failed to fetch|NetworkError|Load failed|waktu habis/i.test(String(e?.message || e || ''));

/* ------------------------------------------------------------ boot cache */
// Who is signed in and the catalogue, so a reload with no internet still opens the till.
// The last known shift is kept too: without it a reload offline left Mode penjualan disabled
// (stress test 12 Nov 2026). The server files offline sales under its own open shift anyway.
export function saveBoot(who, cat) {
  write(K_BOOT, { at: new Date().toISOString(), who, cat });
}
export const loadBoot = () => read(K_BOOT, null);

/* ------------------------------------------------------------ local numbers */
const jakartaDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: '2-digit', month: '2-digit', day: '2-digit' })
  .format(new Date()).replace(/-/g, '');
function deviceTag() {
  let t = read(K_DEV, null);
  if (!t) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const r = crypto.getRandomValues(new Uint8Array(2));
    t = abc[r[0] % abc.length] + abc[r[1] % abc.length];
    write(K_DEV, t);
  }
  return t;
}
// L261111-A7-03: the day, this tablet's tag, and its own running number for the day.
export function nextLocalNo() {
  const day = jakartaDay();
  const s = read(K_SEQ, null);
  const n = s && s.day === day ? s.n + 1 : 1;
  write(K_SEQ, { day, n });
  return `L${day}-${deviceTag()}-${String(n).padStart(2, '0')}`;
}

/* ------------------------------------------------------------ prices and receipt */
// The same sums as _pos_price for a walk-in with no promo: price + flavour surcharge,
// and the free paper bags at Rp0.
export function localQuote(cat, items, freeBags) {
  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const p = cat.products.find((x) => x.code === it.product);
    const f = cat.flavours.find((x) => x.id === it.flavour);
    if (!p) throw new Error('Produk tidak dikenal. Muat ulang kasir saat internet kembali.');
    const unit = p.price + (f && f.surcharge ? p.flavour_surcharge : 0);
    lines.push({ line: lines.length + 1, code: p.code, name: p.name, flavour: f?.id || null, flavour_label: f?.label || null,
      qty: it.qty, unit_price: unit, line_total: unit * it.qty, discount: 0, free_bag: false });
    subtotal += unit * it.qty;
  }
  const bag = cat.products.find((x) => x.code === 'bag');
  if (freeBags > 0) {
    lines.push({ line: lines.length + 1, code: 'bag', name: bag?.name || 'Paper bag', flavour: null, flavour_label: null,
      qty: freeBags, unit_price: 0, line_total: 0, discount: 0, free_bag: true });
  }
  return { offline: true, lines, subtotal, discount: 0, total: subtotal, promo: null };
}

// A receipt in the shape of _pos_receipt, so the same screens, printer and WhatsApp code work.
export function localReceipt({ id, localNo, quote, servedBy, payment, soldAt = new Date().toISOString() }) {
  const t = new Date(soldAt);
  const f = (o) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', ...o }).format(t);
  const cash = payment?.method === 'tunai' ? payment.cash : null;
  return {
    id, receipt_no: localNo, local_no: localNo, offline: true, status: payment ? 'dibayar' : 'menunggu',
    outlet: 'Papaya Fresh Gallery Bandung', channel: 'toko', channel_label: 'Di booth',
    sold_at: soldAt, date: f({ day: '2-digit', month: 'short', year: 'numeric' }), time: f({ hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', '.'),
    served_by: servedBy || null, member: null,
    lines: quote.lines.map((l) => ({ name: l.name, flavour: l.flavour_label, qty: l.qty, unit_price: l.unit_price,
      line_total: l.line_total, discount: 0, free_bag: l.free_bag })),
    subtotal: quote.subtotal, discount: 0, promo_label: null, promo_product: null, total: quote.total,
    payment_method: payment ? (quote.total === 0 ? 'gratis' : payment.method) : null,
    cash_received: cash, change: cash == null ? null : cash - quote.total,
    stamps: 0, card: null, new_rewards: null, rewards_ready: null,
  };
}

/* ------------------------------------------------------------ the queue */
export const queued = () => read(K_QUEUE, []);
export const pending = () => queued().length;

// Saved before the done screen shows, so a sale is never lost to a reload.
export function enqueue(order, receipt) {
  const q = queued();
  if (q.some((x) => x.order.id === order.id)) return true;
  q.push({ order, receipt, at: new Date().toISOString(), tries: 0, err: null });
  return write(K_QUEUE, q);
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('waktu habis')), ms))]);

/* ------------------------------------------------------------ perlu dicek */
// A queued payment the server would not record because the order was cancelled meanwhile
// (13 Nov 2026). The money was taken, so the sale is kept here, shown under "Perlu dicek"
// until a manager or the owner has sorted the cash out; the server flagged it in audit_log.
export const toCheck = () => read(K_CHECK, []);
export function checked(id) { write(K_CHECK, toCheck().filter((x) => x.order.id !== id)); }
function keepForCheck(item, why) {
  const list = toCheck().filter((x) => x.order.id !== item.order.id);
  list.push({ ...item, err: why, checkAt: new Date().toISOString() });
  return write(K_CHECK, list);
}
const REJECTED = {
  batal: 'Pesanan sudah dibatalkan manajer atau pemilik, jadi pembayarannya tidak tercatat. Uangnya perlu dicek.',
  menunggu_batal: 'Pesanan sedang menunggu keputusan batal dari manajer. Terkirim setelah permintaan batalnya ditolak.',
};

// Sends the waiting sales one by one, oldest first. A network error stops the round (the
// rest would fail too); a refusal from the server is kept with its reason for a manager,
// and the round goes on. An ended sign-in stops it too, keeping every sale. Only a reply
// that says the order is paid counts as sent; a payment for a cancelled order moves to
// "Perlu dicek", and one whose order waits on a batal decision stays in the queue.
// Returns { sent, left, failed, check, online, expired }.
let running = null;
export function flush(rpc) {
  if (running) return running;
  running = (async () => {
    let sent = 0, check = 0, online = true, expired = false;
    const mark = (id, err) => write(K_QUEUE, queued().map((x) => (x.order.id === id ? { ...x, tries: x.tries + 1, err } : x)));
    for (const item of queued()) {
      try {
        const r = await withTimeout(rpc('pos_checkout', { p_order: item.order }), 15000);
        if (r?.rejected === 'batal' || r?.status === 'batal') {
          if (keepForCheck({ ...item, receipt: { ...item.receipt, server_no: r.receipt_no || null } }, REJECTED.batal)) {
            write(K_QUEUE, queued().filter((x) => x.order.id !== item.order.id));
            check++;
          }
        } else if (r?.status && r.status !== 'dibayar' && r.status !== 'refund') {
          mark(item.order.id, REJECTED[r.rejected] || `Belum tercatat (status ${r.status}).`);
        } else {
          write(K_QUEUE, queued().filter((x) => x.order.id !== item.order.id));
          sent++;
        }
      } catch (e) {
        if (isNetError(e)) { online = false; break; }
        if (/Sesi berakhir/i.test(e.message)) { expired = true; break; }
        mark(item.order.id, e.message);
      }
    }
    const q = queued();
    return { sent, left: q.length, failed: q.filter((x) => x.err).length, check, online, expired };
  })().finally(() => { running = null; });
  return running;
}
