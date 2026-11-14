// Demo only: turns the shared sample data set (sample-data.js) into the reply of each rpc the
// POS and member-app pages call. The reply shapes follow the SQL in member/supabase/.
// No imports from the app and no network, so it also loads in node.
import { data, TZ, STAFF, MANAGER, OWNER, SHIFTS, WEEKLY, FLAVOURS, PRODUCTS, CATEGORIES, STOCK_ITEMS, recipe, addD, dow, hm, mins, iso, ymdOf, minOf } from './sample-data.js';

const fmt = (o) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, ...o });
const fTime = fmt({ hour: '2-digit', minute: '2-digit' }), fDate = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const fDT = fmt({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
export const tm = (i) => fTime.format(new Date(i));
export const dt = (i) => fDate.format(new Date(i));
const dtl = (i) => fDT.format(new Date(i)).replace(/\./g, ':').replace(',', '');
const stamp = (i) => (i ? `${ymdOf(new Date(i))} ${hm(minOf(new Date(i)))}:${String(new Date(i).getUTCSeconds()).padStart(2, '0')}` : '');
const all = [...STAFF, MANAGER, OWNER];
const who = (id) => all.find((s) => s.id === id);
const first = (id) => (who(id) ? who(id).name : 'Tidak dicatat');
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const D = () => data();
const upTo = (o) => o.sold_at <= D().nowIso || o.day < D().today;
export const PAYL = { tunai: 'Tunai', qris: 'QRIS', gratis: 'Gratis', platform: 'Platform' };
const STATL = { dibayar: 'Selesai', batal: 'Dibatalkan', refund: 'Pengembalian', menunggu: 'Menunggu pembayaran' };
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const range = (a, d) => { const t = D().today; const f = (a && a.p_from) || d || t, e = (a && a.p_to) || f; return [f, e]; };

/* ------------------------------------------------------------------ orders */
export const ordersOn = (from, to) => D().orders.filter((o) => o.day >= from && o.day <= to);
export const paidOn = (from, to) => ordersOn(from, to).filter((o) => o.status === 'dibayar');
export const todayOrders = () => D().orders.filter((o) => o.day === D().today);
export const memberOf = (o) => (o.member_id ? D().byId[o.member_id] : null);
export function orderRow(o) {
  const m = memberOf(o);
  return { id: o.id, receipt_no: o.receipt_no, sold_at: o.sold_at, total: o.status === 'menunggu' ? o.total : o.total, payment_method: o.payment_method, status: o.status, stamps: o.stamps,
    promo_label: o.promo_label, served_by: first(o.served_by), member: m ? m.first : null, void_pending: !!(o.void && o.void.status === 'menunggu') };
}
const itemsText = (o) => o.lines.filter((l) => !l.free_bag).map((l) => `${l.qty}× ${l.name}${l.flavour_label ? ' ' + l.flavour_label : ''}`).join(', ');
export function receiptOf(o) {
  const m = memberOf(o);
  const nextSlot = m ? ([3, 7, 10].find((s) => s > m.position) || 10) : null;
  return {
    id: o.id, receipt_no: o.receipt_no, status: o.status, outlet: 'Papaya Fresh Gallery Bandung', channel: 'toko', channel_label: 'Di booth', sold_at: o.sold_at,
    date: dt(o.sold_at), time: tm(o.sold_at), served_by: first(o.served_by), member: m ? m.first : null,
    lines: o.lines.map((l) => ({ name: l.name, flavour: l.flavour_label, qty: l.qty, unit_price: l.unit_price, line_total: l.line_total, discount: l.discount, free_bag: l.free_bag })),
    subtotal: o.subtotal, discount: o.discount, promo_label: o.promo_label, promo_product: o.promo ? (o.lines.find((l) => l.discount > 0) || {}).name || null : null,
    total: o.total, payment_method: o.payment_method, cash_received: o.cash_received, change: o.change, stamps: o.stamps,
    card: m ? { position: m.position, size: 10, waiting: 0, next_label: nextSlot === 3 ? 'Diskon 10%' : nextSlot === 7 ? 'Diskon 20%' : 'Gratis 1 produk', next_in: Math.max(0, nextSlot - m.position) } : null,
    new_rewards: m && o.stamps ? [] : null, rewards_ready: m ? [] : null };
}

/* ------------------------------------------------------------------ till */
export function posHome(opts = {}) {
  const d = D(), os = todayOrders().filter(upTo), paid = os.filter((o) => o.status === 'dibayar');
  const items = paid.flatMap((o) => o.lines.filter((l) => l.code !== 'bag').map((l) => ({ ...l, order: o })));
  const units = sum(items, (l) => l.qty), rev = sum(paid, (o) => o.total);
  const omzet = !!opts.omzet, cur = omzet ? rev : units, val = omzet ? 1000000 : 10;
  const top = {}; items.forEach((l) => { top[l.name] = (top[l.name] || 0) + l.qty; });
  const cat = {}; items.forEach((l) => { const n = CATEGORIES[PRODUCTS[l.code].cat]; cat[n] = (cat[n] || 0) + l.qty; });
  return { day: d.today, revenue: rev, orders: paid.length, average: paid.length ? Math.round(rev / paid.length) : 0, cancelled: os.filter((o) => ['batal', 'refund'].includes(o.status)).length,
    waiting: os.filter((o) => o.status === 'menunggu').length, by_method: { tunai: sum(paid.filter((o) => o.payment_method === 'tunai'), (o) => o.total), qris: sum(paid.filter((o) => o.payment_method === 'qris'), (o) => o.total) },
    products_sold: units, by_category: Object.entries(cat).map(([name, qty]) => ({ name, qty })),
    hourly: Array.from({ length: 13 }, (_, i) => { const h = os.filter((o) => o.status === 'dibayar' && Math.floor(o.sold_m / 60) === 8 + i); return { hour: 8 + i, revenue: sum(h, (o) => o.total), orders: h.length }; }),
    top_products: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty, unit: PRODUCTS[Object.values(PRODUCTS).find((p) => p.name === name).code].box ? 'box' : 'pcs' })),
    by_flavour: FLAVOURS.map((f) => ({ label: f.label, qty: sum(items.filter((l) => l.flavour === f.id), (l) => l.qty) })),
    drawer: null, drawer_low: null, target: { kind: omzet ? 'omzet' : 'produk', value: val, current: cur, percent: Math.round(cur * 100 / val), remaining: Math.max(0, val - cur) } };
}
// The shift that is open now (today's), in the shape of pos_shift_now.
export const currentShift = () => D().shifts[D().shifts.length - 1];
export const lastClosedShift = () => D().shifts[D().shifts.length - 2];
export function shiftJson(sh, all_) {
  const os = D().orders.filter((o) => o.shift_id === sh.id && (sh.closed_at || upTo(o)));
  const paid = os.filter((o) => o.status === 'dibayar');
  const tunai = sum(paid.filter((o) => o.payment_method === 'tunai'), (o) => o.total), qris = sum(paid.filter((o) => o.payment_method === 'qris'), (o) => o.total);
  const mv = sh.moves.filter((m) => !sh.closed_at || true);
  const cin = sum(mv.filter((m) => m.kind === 'masuk'), (m) => m.amount), cout = sum(mv.filter((m) => m.kind === 'keluar'), (m) => m.amount), setor = sum(mv.filter((m) => m.kind === 'setor'), (m) => m.amount);
  const j = { id: sh.id, opened_at: sh.opened_at, opened_by: first(sh.opened_by.id), device: sh.device, closed_at: sh.closed_at, closed_by: sh.closed_by ? sh.closed_by.name : null,
    orders: paid.length, sales_total: tunai + qris, by_method: { tunai, qris }, voided: os.filter((o) => ['batal', 'refund'].includes(o.status)).length, cash_in: cin, cash_out: cout,
    moves: all_ ? mv : mv.filter((m) => m.kind !== 'setor'), cash_received: sum(paid.filter((o) => o.payment_method === 'tunai'), (o) => o.cash_received), change_given: sum(paid.filter((o) => o.payment_method === 'tunai'), (o) => o.change),
    counted_cash: null, note: null, blind: !all_ };
  if (all_) Object.assign(j, { opening_cash: sh.opening_cash, setor, expected_cash: sh.opening_cash + tunai + cin - cout - setor, difference: null, flags: [] });
  return j;
}
function groupItems(paid) {
  const rows = new Map();
  for (const o of paid) for (const l of o.lines) {
    const net = l.qty ? Math.round((l.line_total - l.discount) / l.qty) : 0;
    const key = [l.name, l.flavour_label, l.free_bag ? 'bag' : net, l.discount > 0].join('|');
    const r = rows.get(key) || { name: l.name, flavour: l.flavour_label, qty: 0, unit: l.free_bag ? 0 : net, total: 0, promo: l.discount > 0 };
    if (l.free_bag) r.free_bag = true;
    r.qty += l.qty; r.total += l.line_total - l.discount; rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || String(a.flavour).localeCompare(String(b.flavour)));
}
// Rekap kas of one shift (pos_shift_rekap). asFull = manager / owner copy.
export function rekapOf(sh, asFull) {
  const os = D().orders.filter((o) => o.shift_id === sh.id), paid = os.filter((o) => o.status === 'dibayar');
  const closed = sh.closed_at || D().nowIso, tunai = paid.filter((o) => o.payment_method === 'tunai'), counted = sh.counted_cash;
  const staffNames = [...new Set(paid.map((o) => first(o.served_by)))].sort().join(', ');
  const closedBy = sh.closed_by ? sh.closed_by.name : null;
  const subtotal = sum(paid, (o) => o.subtotal), discount = sum(paid, (o) => o.discount);
  const bad = os.filter((o) => ['batal', 'refund'].includes(o.status));
  const moves = sh.moves.map((m) => ({ ...m, time: tm(m.at) }));
  const k = { id: sh.id, closed: !!sh.closed_at, opened_at: sh.opened_at, closed_at: closed, start: dtl(sh.opened_at), end: dtl(closed), now: dtl(D().nowIso),
    outlet: 'Hanashuya Papaya Fresh Gallery Bandung', device: sh.device, staff: staffNames, opened_by: first(sh.opened_by.id), closed_by: closedBy,
    printed_at: sh.printed_at, printed_time: sh.printed_at ? tm(sh.printed_at) : null, printed_by: closedBy, reprints: sh.reprints,
    items: groupItems(paid), orders: paid.length, subtotal, discount, total: subtotal - discount,
    payments: ['qris', 'tunai'].map((m) => ({ method: m, count: paid.filter((o) => o.payment_method === m).length, amount: sum(paid.filter((o) => o.payment_method === m), (o) => o.total) })).filter((p) => p.count),
    voids: { batal_count: bad.filter((o) => o.status === 'batal').length, batal_amount: sum(bad.filter((o) => o.status === 'batal'), (o) => o.total), refund_count: bad.filter((o) => o.status === 'refund').length, refund_amount: sum(bad.filter((o) => o.status === 'refund'), (o) => o.total) },
    moves: moves.filter((m) => m.kind !== 'setor').map(({ kind, amount, reason, time, by }) => ({ kind, amount, reason, time, by })), cash_in: sh.cash_in, cash_out: sh.cash_out,
    cash_received: sum(tunai, (o) => o.cash_received), change_given: sum(tunai, (o) => o.change), tunai_count: tunai.length, counted_cash: counted,
    denominations: sh.denominations || { 100000: 0, 50000: 0, 20000: 0, 10000: 0, 5000: 0, 2000: 0, 1000: 0, koin: 0 }, note: sh.note, blind: !asFull };
  if (asFull) {
    const setor = sum(sh.moves.filter((m) => m.kind === 'setor'), (m) => m.amount), exp = sh.opening_cash + sum(tunai, (o) => o.total) + sh.cash_in - sh.cash_out - setor;
    const ev = [];
    ev.push({ t: sh.opened_at, time: tm(sh.opened_at), kind: 'modal', label: 'Uang modal', amount: sh.opening_cash });
    sh.moves.forEach((m) => ev.push({ t: m.at, time: tm(m.at), kind: m.kind, label: m.reason, amount: m.kind === 'masuk' ? m.amount : -m.amount }));
    tunai.forEach((o) => ev.push({ t: o.sold_at, time: tm(o.sold_at), kind: 'jual', label: o.receipt_no, received: o.cash_received, change: o.change, amount: o.total }));
    ev.sort((a, b) => a.t.localeCompare(b.t));
    let bal = 0; const ledger = ev.map(({ t, ...e }) => { bal += e.amount; return { ...e, balance: bal }; });
    if (counted != null) ledger.push({ time: tm(closed), kind: 'hitung', label: 'Uang laci dihitung', amount: 0, counted });
    Object.assign(k, { opening_cash: sh.opening_cash, float_source: sh.float_source, setor, expected_cash: exp, difference: counted == null ? null : counted - exp,
      flags: sh.flags, cash_float: D().cashFloat, flag_at: D().cashFlagAt, ledger });
  } else { delete k.printed_by; }
  return k;
}
export function cashShifts(a) {
  const d = D(); const [from, to] = a && a.p_from ? [a.p_from, a.p_to || d.today] : [addD(d.today, -13), d.today];
  const rows = d.shifts.filter((s) => s.day >= from && s.day <= to).reverse().map((s) => { const j = shiftJson(s, true); return { id: s.id, opened_at: s.opened_at, closed_at: s.closed_at, opened_by: first(s.opened_by.id),
    closed_by: s.closed_by ? s.closed_by.name : null, device: s.device, orders: j.orders, sales_total: j.sales_total, qris: j.by_method.qris, tunai: j.by_method.tunai, opening_cash: s.opening_cash,
    expected_cash: j.expected_cash, counted_cash: s.counted_cash, difference: s.difference, flags: s.flags, setor: j.setor, printed_at: s.printed_at, reprints: s.reprints }; });
  return { settings: { cash_float: d.cashFloat, cash_flag_at: d.cashFlagAt }, shifts: rows };
}

/* ------------------------------------------------------------------ reports */
export function stats(a) {
  const d = D(); const [d1, d2] = range(a); const todayPartial = (o) => o.day < d.today || upTo(o);
  const paid = paidOn(d1, d2).filter(todayPartial), lines = paid.flatMap((o) => o.lines.map((l) => ({ ...l, o })));
  const grain = d1 === d2 ? 'jam' : (Date.parse(d2) - Date.parse(d1)) / 864e5 > 92 ? 'bulan' : 'hari';
  const agg = (rows) => ({ sales: sum(rows, (o) => o.total), receipts: rows.length });
  let series;
  if (grain === 'jam') {
    series = []; for (let h = 8; h <= 21; h++) series.push({ label: String(h).padStart(2, '0') + '.00', ...agg(paid.filter((o) => Math.floor(o.sold_m / 60) === h)) });
  } else if (grain === 'hari') {
    series = []; for (let x = d1; x <= d2; x = addD(x, 1)) series.push({ label: x.slice(8) + '/' + x.slice(5, 7), ...agg(paid.filter((o) => o.day === x)) });
  } else {
    const ms = [...new Set(paid.map((o) => o.day.slice(0, 7)))].sort();
    series = ms.map((m) => ({ label: m.slice(5) + '/' + m.slice(0, 4), ...agg(paid.filter((o) => o.day.startsWith(m))) }));
  }
  const group = (rows, key, f) => { const m = new Map(); rows.forEach((r) => { const k = key(r); m.set(k, [...(m.get(k) || []), r]); }); return [...m].map(([k, v]) => f(k, v)); };
  const staffRows = group(paid, (o) => o.served_by, (k, v) => ({ name: first(k), receipts: v.length, sales: sum(v, (o) => o.total), commission: Math.round(sum(v, (o) => o.total) * 0.01) })).sort((a, b) => b.sales - a.sales);
  const cards = group(D().members.filter((m) => m.joined_day >= d1 && m.joined_day <= d2 && !m.scripted_hidden), (m) => (m.id.charCodeAt(m.id.length - 1) % 3 ? 's-ranny' : 's-fajar'), (k, v) => ({ name: first(k), cards: v.length }));
  const all_ = ordersOn(d1, d2).filter(todayPartial);
  const last7 = []; for (let x = addD(d.today, -6); x <= d.today; x = addD(x, 1)) { const r = paidOn(x, x).filter(todayPartial); last7.push({ label: x.slice(8) + '/' + x.slice(5, 7), ...agg(r) }); }
  return { from: d1, to: d2, grain, sales: sum(paid, (o) => o.total), receipts: paid.length, average: paid.length ? Math.round(sum(paid, (o) => o.total) / paid.length) : 0, items: sum(lines, (l) => l.qty),
    series, last7,
    top_products: group(lines, (l) => l.name, (k, v) => ({ name: k, qty: sum(v, (l) => l.qty), net: sum(v, (l) => l.line_total - l.discount) })).sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name)).slice(0, 10),
    groups: group(lines, (l) => CATEGORIES[PRODUCTS[l.code].cat], (k, v) => ({ name: k, qty: sum(v, (l) => l.qty), net: sum(v, (l) => l.line_total - l.discount) })).sort((a, b) => b.net - a.net),
    by_method: group(paid, (o) => o.payment_method, (k, v) => ({ name: PAYL[k] || k, receipts: v.length, sales: sum(v, (o) => o.total) })).sort((a, b) => b.sales - a.sales),
    by_channel: [{ name: 'Di booth', receipts: paid.length, sales: sum(paid, (o) => o.total) }], by_staff: staffRows,
    cards_by_cashier: cards.sort((a, b) => b.cards - a.cards), promos: group(paid.filter((o) => o.promo), (o) => o.promo_label, (k, v) => ({ name: k, used: v.length, discount: sum(v, (o) => o.discount) })).sort((a, b) => b.used - a.used),
    voids: { batal: all_.filter((o) => o.status === 'batal').length, batal_value: sum(all_.filter((o) => o.status === 'batal'), (o) => o.total), refund: all_.filter((o) => o.status === 'refund').length, refund_value: sum(all_.filter((o) => o.status === 'refund'), (o) => o.total) },
    free_orders: paid.filter((o) => o.payment_method === 'gratis').length, flagged: paid.filter((o) => o.flags.length).length };
}
export function profit(a) {
  const [d1, d2] = range(a); const paid = paidOn(d1, d2).filter((o) => o.day < D().today || upTo(o)), lines = paid.flatMap((o) => o.lines.map((l) => ({ ...l, day: o.day })));
  const rev = (l) => l.line_total - l.discount;
  const by = (key) => { const m = new Map(); lines.forEach((l) => { const k = key(l); m.set(k, [...(m.get(k) || []), l]); }); return m; };
  return { from: d1, to: d2, revenue: sum(lines, rev), cost: sum(lines, (l) => l.cost), profit: sum(lines, (l) => rev(l) - l.cost), commission: Math.round(sum(paid, (o) => o.total) * 0.01), estimated: 0,
    products: [...by((l) => l.name)].map(([name, v]) => ({ name, qty: sum(v, (l) => l.qty), revenue: sum(v, rev), cost: sum(v, (l) => l.cost), profit: sum(v, (l) => rev(l) - l.cost) })).sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name)),
    days: [...by((l) => l.day)].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, revenue: sum(v, rev), cost: sum(v, (l) => l.cost), profit: sum(v, (l) => rev(l) - l.cost) })),
    missing_costs: ['Selai strawberry'] };
}
export function report(a) {
  const d = D(); const [d1, d2] = range(a); const os = ordersOn(d1, d2).filter((o) => o.day < d.today || upTo(o));
  const rangk = os.map((o, i) => { const m = memberOf(o); return { No: i + 1, Gerai: 'Papaya Fresh Gallery Bandung', Channel: 'Di booth', Tanggal: stamp(o.sold_at), 'Nomor Struk': o.receipt_no, Staff: who(o.served_by).full_name, Kasir: who(o.cashier_id).full_name,
    Pelanggan: m ? m.first : '', Fasilitas: '', Status: STATL[o.status], 'Metode Pembayaran': PAYL[o.payment_method] || '', 'Tanggal Pembayaran': stamp(o.sold_at), Catatan: o.promo_label || '', Kasbon: 0, 'Jatuh Tempo': '', Referensi: '',
    'Tipe Kalkulasi Pajak': '', Subtotal: o.subtotal, Diskon: 0, 'Diskon Loyalti': 0, 'Diskon Kupon': o.discount, 'Biaya Layanan': 0, PB1: 0, PPN: 0, Pembulatan: 0, Total: o.total, 'Platform Fee': 0, 'Total Bersih': o.total,
    Pembayaran: o.cash_received ?? o.total, Kembalian: o.change || 0 }; });
  let n = 0; const rinc = os.flatMap((o) => { const m = memberOf(o); return o.lines.map((l) => ({ No: ++n, Gerai: 'Papaya Fresh Gallery Bandung', Tanggal: stamp(o.sold_at), 'Nomor Struk': o.receipt_no, 'Metode Pembayaran': PAYL[o.payment_method] || '',
    Staff: who(o.served_by).full_name, Kasir: who(o.cashier_id).full_name, Pelanggan: m ? m.first : '', Fasilitas: '', Status: STATL[o.status], 'Nama Barang': l.name, 'Grup Harga': 'Di booth',
    Catatan: ((l.flavour_label ? 'Rasa ' + l.flavour_label : '') + (l.free_bag ? ' (paper bag gratis)' : '')).trim(), Harga: l.qty ? Math.round(l.line_total / l.qty) : 0, Qty: l.qty, Diskon: l.discount, Total: l.line_total - l.discount })); });
  const m2 = new Map(); os.filter((o) => o.status === 'dibayar').flatMap((o) => o.lines).forEach((l) => { const r = m2.get(l.name) || { l, qty: 0, net: 0 }; r.qty += l.qty; r.net += l.line_total - l.discount; m2.set(l.name, r); });
  const perp = [...m2.values()].sort((a, b) => PRODUCTS[a.l.code].cat - PRODUCTS[b.l.code].cat || a.l.name.localeCompare(b.l.name)).map((r, i) => ({ No: i + 1, Gerai: 'Papaya Fresh Gallery Bandung', Channel: 'Di booth', Kategori: CATEGORIES[PRODUCTS[r.l.code].cat],
    'Nama Barang': r.l.name, 'Kode Barang': r.l.code, 'Kuantitas Terjual': r.qty, 'Penjualan Bersih': r.net, 'Penjualan Rata-Rata': r.qty ? Math.round(r.net / r.qty) : 0 }));
  const kas = d.shifts.filter((s) => s.day >= d1 && s.day <= d2).map((s, i) => { const j = shiftJson(s, true); return { No: i + 1, 'Tanggal Mulai': stamp(s.opened_at), 'Tanggal Berakhir': stamp(s.closed_at), Gerai: 'Papaya Fresh Gallery Bandung', Perangkat: s.device,
    Staff: first(s.opened_by.id), 'Kas Masuk': s.cash_in, 'Kas Keluar': s.cash_out, Penjualan: j.sales_total, Kembalian: j.change_given, 'Kas Awal': s.opening_cash, 'Kas Seharusnya': j.expected_cash, 'Kas Dihitung': s.counted_cash == null ? '' : String(s.counted_cash),
    Selisih: s.counted_cash == null ? '' : String(s.counted_cash - j.expected_cash), Catatan: s.note || '', 'Uang Diterima': j.cash_received, Modal: s.float_source === 'diubah' ? 'diubah saat buka' : 'standar',
    Pecahan: s.denominations ? Object.entries(s.denominations).filter(([, v]) => v > 0).sort((x, y) => (y[0] === 'koin' ? 0 : +y[0]) - (x[0] === 'koin' ? 0 : +x[0]) ).map(([k, v]) => (k === 'koin' ? 'koin ' + rp(v) : rp(k) + ' x' + v)).join(', ') : '', Tanda: s.flags.join(', ') }; });
  return { from: d1, to: d2, rangkuman: rangk, rincian: rinc, per_produk: perp, kas };
}

/* ------------------------------------------------------------------ owner: orders, members */
export function ownerOrders(a) {
  const d = D(); const [d1, d2] = range(a); const q = String(a.p_q || '').toLowerCase().trim(), st = a.p_status && a.p_status !== 'semua' ? a.p_status : null, digits = q.replace(/\D/g, '');
  let rows = ordersOn(d1, d2).filter((o) => o.day < d.today || upTo(o)).filter((o) => !st || (st === 'batal' ? ['batal', 'refund'].includes(o.status) : o.status === st)).filter((o) => {
    if (!q) return true; const m = memberOf(o);
    return [o.receipt_no, m && m.name, who(o.served_by).full_name, o.promo_label].some((v) => String(v || '').toLowerCase().includes(q)) || (digits.length >= 4 && m && m.phone.includes(digits)); });
  rows = rows.sort((x, y) => y.sold_at.localeCompare(x.sold_at));
  const out = rows.slice(0, 300).map((o) => ({ ...orderRow(o), local_no: null, discount: o.discount, items: itemsText(o) }));
  return { rows: out, total_rows: rows.length, paid_total: sum(rows.filter((o) => o.status === 'dibayar'), (o) => o.total) };
}
export function ownerOrder(a) {
  const o = D().orderById[a.p_id] || D().orders[D().orders.length - 1], m = memberOf(o);
  return { receipt: receiptOf(o), cashier: who(o.cashier_id).full_name, served_by_full: who(o.served_by).full_name, member_full: m ? m.name : null, member_whatsapp: m ? m.phone : null, via: o.via, flags: o.flags,
    cost: o.cost, voids: o.void ? [{ kind: o.void.kind, reason: o.void.reason, status: o.void.status, requested_by: o.void.requested_by, created_at: o.void.created_at, ...(o.void.decided_by ? { decided_by: o.void.decided_by, decided_at: o.void.decided_at } : {}) }] : [] };
}
const memberRows = () => D().members.filter((m) => m.joined_day <= D().today);
export function ownerMembers(a) {
  const q = String(a.p_q || '').toLowerCase().trim(), digits = q.replace(/\D/g, ''); const sort = a.p_sort || 'baru';
  let rows = memberRows().filter((m) => !q || m.name.toLowerCase().includes(q) || m.code.toLowerCase().includes(q) || (digits.length >= 4 && m.phone.includes(digits)));
  const key = { baru: (x, y) => y.joined_at.localeCompare(x.joined_at), kunjungan: (x, y) => y.visits - x.visits, belanja: (x, y) => y.spent - x.spent, terakhir: (x, y) => String(y.last_visit || '').localeCompare(String(x.last_visit || '')), nama: (x, y) => x.name.localeCompare(y.name) }[sort];
  rows = rows.sort(key); const page = a.p_page || 0;
  return { total: rows.length, all_members: memberRows().length, page, page_size: 50, rows: rows.slice(page * 50, page * 50 + 50).map((m) => ({ id: m.id, name: m.name, whatsapp: m.phone, card_code: m.code, joined: m.joined_at, visits: m.visits, spent: m.spent,
    last_visit: m.last_visit, position: m.position, cards_done: m.cards_done, ready: m.ready.length + m.vouchers.length })) };
}
export function ownerMember(a) {
  const m = D().byId[a.p_id] || memberRows()[0], os = D().orders.filter((o) => o.member_id === m.id && o.status === 'dibayar' && upTo(o));
  const used = (s, c) => os.some((o) => o.promo && o.promo.kind === 'stempel' && o.promo.slot === s && o.promo.cycle === c);
  const cyc = m.cards_done + 1;
  const rewards = [3, 7, 10].map((s) => ({ label: s === 3 ? 'Diskon 10%' : s === 7 ? 'Diskon 20%' : 'Gratis 1 produk', slot: s, cycle: cyc, status: used(s, cyc) ? 'dipakai' : m.ready.some((r) => r.slot === s) ? 'tersedia' : 'terkunci' }));
  const wel = os.find((o) => o.promo && o.promo.kind === 'welcome');
  const vouchers = [...(wel ? [{ title: 'Hadiah member baru', label: 'Diskon 50% untuk 1 produk', ends_on: addD(m.joined_day, 30), status: 'dipakai' }] : []), ...m.vouchers.map((v) => ({ title: v.title, label: v.label, ends_on: v.ends_on, status: 'tersedia' }))];
  return { name: m.name, whatsapp: m.phone, card_code: m.code, joined: m.joined_at, birth_date: m.birth_date, marketing: m.marketing, stamps: m.stamps_total, card: { card_position: m.position, waiting: 0 }, rewards, vouchers,
    visits: os.slice().reverse().slice(0, 12).map((o) => ({ at: o.sold_at, total: o.total, stamps: o.stamps, receipt_no: o.receipt_no })) };
}
export function ownerPromos() {
  const used = (id) => D().orders.filter((o) => o.status === 'dibayar' && o.promo && o.promo.promo_id === id);
  const live = dow(D().today) >= 6;
  const base = [
    { id: 1, name: 'Diskon Akhir Pekan', kind: 'persen', value: 10, products: ['mini15', 'mini8'], min_spend: 0, days: [6, 7], time_from: null, time_to: null, starts_on: null, ends_on: addD(D().today, 50), member_only: false, per_member: null, quota: null, active: true, note: null, live_now: live },
    { id: 2, name: 'Member Potong 15rb', kind: 'rupiah', value: 15000, products: null, min_spend: 100000, days: null, time_from: '13:00', time_to: '17:00', starts_on: null, ends_on: null, member_only: true, per_member: 1, quota: 50, active: true, note: 'Tanya dulu sudah follow Instagram', live_now: D().nowMin >= 780 && D().nowMin < 1020 },
  ];
  return { promos: [...base.map((p) => ({ ...p, used: used(p.id).length, discount_given: sum(used(p.id), (o) => o.discount) })),
    { id: 3, name: 'Grand Opening', kind: 'persen', value: 50, products: ['sig6'], min_spend: 0, days: null, time_from: null, time_to: null, starts_on: '2026-07-01', ends_on: '2026-07-31', member_only: false, per_member: null, quota: null, active: false, note: null, used: 41, discount_given: 2460000, live_now: false }],
  products: ['sig1', 'sig6', 'mini15', 'mini8'].map((c) => ({ code: c, name: PRODUCTS[c].name })) };
}
export function dashboard(a) {
  const d = D(), custom = !!(a && a.p_from), to = custom ? a.p_to : d.today, from = custom ? a.p_from : addD(d.today, -(((a && a.p_days) || 30) - 1));
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const paid = paidOn(from, to).filter(upTo), mem = paid.filter((o) => o.member_id);
  const daily = []; for (let x = to; x >= from; x = addD(x, -1)) { const o = paid.filter((y) => y.day === x), om = o.filter((y) => y.member_id);
    daily.push({ date: x, sales: o.length, member_sales: om.length, revenue: sum(o, (y) => y.total), stamps: sum(om, (y) => y.stamps), redemptions: om.filter((y) => y.promo).length, new_members: memberRows().filter((m) => m.joined_day === x).length }); }
  const heat = []; for (let w = 1; w <= 7; w++) for (let h = 9; h <= 20; h++) heat.push({ dow: w, hour: h, n: paid.filter((o) => dow(o.day) === w && Math.floor(o.sold_m / 60) === h).length });
  const lines = paid.flatMap((o) => o.lines.filter((l) => !l.free_bag).map((l) => ({ l, o })));
  const reg = (m) => m && m.visits >= 3;
  const tops = new Map(); lines.forEach(({ l, o }) => { const r = tops.get(l.name) || { name: l.name, qty: 0, regs: new Set() }; r.qty += l.qty; if (reg(memberOf(o))) r.regs.add(o.member_id); tops.set(l.name, r); });
  const ms = memberRows(), cnt = (f) => ms.filter(f).length, age = (m) => 2026 - Number(m.birth_date.slice(0, 4));
  const gaps = []; ms.forEach((m) => { const v = D().orders.filter((o) => o.member_id === m.id && o.status === 'dibayar' && upTo(o)); for (let i = 1; i < v.length; i++) gaps.push((Date.parse(v[i].day) - Date.parse(v[i - 1].day)) / 864e5); });
  const sv = new Map(); paid.forEach((o) => { const r = sv.get(o.served_by) || { full_name: who(o.served_by).full_name, sales: 0, stamps: 0, redemptions: 0, flagged: 0 }; r.sales++; r.stamps += o.stamps; if (o.promo && o.member_id) r.redemptions++; sv.set(o.served_by, r); });
  const pend = todayOrders().filter((o) => o.void && o.void.status === 'menunggu');
  const lapsed = ms.filter((m) => m.last_visit && m.last_visit < iso(addD(d.today, -30), 0) ).sort((x, y) => x.last_visit.localeCompare(y.last_visit));
  const promoUsed = (k) => paid.filter((o) => o.promo && o.promo.kind === k).length;
  return { days, from, to, custom, daily, last_backup: iso(addD(d.today, -9), 10 * 60), matched_days: 6,
    totals: { sales: paid.length, member_sales: mem.length, revenue: sum(paid, (o) => o.total), stamps: sum(mem, (o) => o.stamps), redemptions: mem.filter((o) => o.promo).length, welcome_used: promoUsed('welcome'), birthday_used: promoUsed('ulang_tahun'),
      new_members: ms.filter((m) => m.joined_day >= from).length, members: ms.length, avg_days_between_visits: gaps.length ? Math.round(sum(gaps, (g) => g) / gaps.length * 10) / 10 : 0 },
    undo: pend.map((o, i) => ({ id: 7 + i, kind: 'penjualan', receipt_no: o.receipt_no, total: o.total, stamps: o.stamps, member: memberOf(o) ? memberOf(o).name : null, requested_by: o.void.requested_by, created_at: o.void.created_at, reason: o.void.reason })),
    heatmap: heat, top_items: [...tops.values()].sort((x, y) => y.qty - x.qty).slice(0, 5).map((r) => ({ name: r.name, qty: r.qty, regulars: r.regs.size })),
    gender: [{ key: 'perempuan', n: cnt((m) => m.gender === 'perempuan') }, { key: 'laki-laki', n: cnt((m) => m.gender === 'laki-laki') }, { key: 'kosong', n: cnt((m) => !m.gender) }],
    age: [{ key: '17-24', n: cnt((m) => age(m) <= 24) }, { key: '25-34', n: cnt((m) => age(m) >= 25 && age(m) <= 34) }, { key: '35-44', n: cnt((m) => age(m) >= 35) }, { key: 'kosong', n: 0 }].filter((x) => x.n || x.key !== 'kosong'),
    staff: [...sv.values()].sort((x, y) => y.sales - x.sales),
    flags: [{ created_at: iso(addD(d.today, -4), 15 * 60 + 12), receipt_no: null, member: 'Desi Ratnasari', staff: 'Ranny', stamps: 1, flags: ['kode_diketik'] }],
    mismatches: [{ created_at: iso(addD(d.today, -2), 13 * 60 + 5), member: ms[5].name, total: 99000, stamps: 1, pos_no: null, sold_at: null, pos_customer: null, problem: 'tidak_ada_struk_cocok' }],
    lapsed: lapsed.slice(0, 6).map((m) => ({ full_name: m.name, last_at: m.last_visit, visits: m.visits, whatsapp: m.phone })) };
}
export function ownerSales() {
  return D().orders.filter((o) => o.member_id && o.status === 'dibayar' && upTo(o)).slice(-40).reverse().map((o) => ({ created_at: o.sold_at, receipt_no: o.receipt_no, member: memberOf(o).name, staff: first(o.served_by), total: o.total, stamps: o.stamps,
    items: o.lines.filter((l) => !l.free_bag).map((l) => ({ qty: l.qty, name: l.name })), flags: o.flags, reversed_at: null }));
}
export function people() {
  return [{ ...OWNER, is_me: true }, MANAGER, ...STAFF].map((p) => ({ full_name: p.full_name, username: p.username, whatsapp: p.whatsapp, role: p.role, is_me: p.id === 'o-glenn' }));
}
export function codeReport() {
  const ms = D().members.filter((m) => m.kode);
  return [{ title: 'Voucher Papaya', label: 'papaya-1', pos_code: 'MANIS', ends_on: '2027-01-31', printed: 155, claimed: ms.length, used: ms.filter((m) => m.kode.used).length }];
}

/* ------------------------------------------------------------------ stock */
const itemById = Object.fromEntries(STOCK_ITEMS.map((i) => [i.id, i]));
const itemByCode = Object.fromEntries(STOCK_ITEMS.map((i) => [i.code, i]));
const outKinds = ['penjualan', 'sampel', 'buang', 'rusak', 'promo'];
const mvs = () => D().stock.moves.filter((m) => m.day < D().today || m.at <= D().nowIso || m.kind === 'masuk');
export function stockItems() {
  const d = D(), bal = { ...d.stock_open }; mvs().forEach((m) => { bal[m.item] += m.qty; });
  return STOCK_ITEMS.map((i) => ({ id: i.id, code: i.code, name: i.name, unit: i.unit, low_level: i.low, closes_at_zero: i.zero, qty: bal[i.code], active: true, low: i.low !== null && bal[i.code] <= i.low }));
}
// Pemasok (12 Nov 2026): the two suppliers VireoPOS has. Packaging comes from Toko Sejati with a price,
// choux, vla and jam from the own kitchen (no price).
export const SUPPLIERS = [
  { id: 1, name: 'hanashuya.id', phone: null, address: null, note: 'Dapur sendiri', active: true },
  { id: 2, name: 'Toko Sejati', phone: '0812-3456-7890', address: 'Jl. Sukajadi 10, Bandung', note: 'Dus, liner, pouch dan paper bag', active: true },
];
const shop = (c) => ['dus_besar', 'dus_kecil', 'liner_besar', 'liner_kecil', 'pouch', 'bag'].includes(c);
const withSupplier = (g) => {
  const sp = SUPPLIERS.find((x) => x.id === (shop(g.item_code) ? 2 : 1));
  const cost = shop(g.item_code) ? itemByCode[g.item_code].cost : null;
  return { ...g, supplier_id: sp.id, supplier: sp.name, unit_cost: cost || null, total_cost: cost ? Math.round(cost * g.current_qty) : null };
};
export function goodsInList(a) {
  const d = D(); const [f, t] = a && a.p_from ? [a.p_from, a.p_to] : [addD(d.today, -30), d.today];
  return d.stock.goodsIn.filter((g) => g.day >= f && g.day <= t).slice().reverse().map(withSupplier).map(({ item_code, day, ...g }) => g);
}
export function opnameSummary(c) {
  const off = c.lines.filter((l) => l.selisih), by = {}; off.forEach((l) => { by[l.unit] = (by[l.unit] || 0) + l.selisih; });
  const { lines, ...rest } = c; return { ...rest, items: lines.length, items_off: off.length, selisih: Object.entries(by).map(([unit, qty]) => ({ unit, qty })) };
}
const lineOf = (c) => ({ ...c, lines: c.lines.map((l) => ({ ...l, actual: c.status === 'diterima' ? l.physical : c.status === 'menunggu' ? null : l.system })) });
export function opnameList(a) { const d = D(); const [f, t] = a && a.p_from ? [a.p_from, a.p_to] : [addD(d.today, -60), d.today]; return d.stock.counts.filter((c) => c.day >= f && c.day <= t).slice().reverse().map((c) => opnameSummary(c)); }
export function opnameDetail(a) { const c = D().stock.counts.find((x) => x.id === a.p_id); return JSON.parse(JSON.stringify(lineOf(c || D().stock.counts[0]))); }
export const countPending = () => { const c = D().stock.counts.find((x) => x.status === 'menunggu'); return c ? JSON.parse(JSON.stringify(lineOf(c))) : null; };
export function stockToday() {
  const d = D(), outs = d.stock.moves.filter((m) => m.day === d.today && ['sampel', 'buang', 'rusak', 'promo'].includes(m.kind) && m.at <= d.nowIso).map((m, i) => ({ id: i + 1, item: itemByCode[m.item].name, unit: itemByCode[m.item].unit, kind: m.kind, qty: -m.qty, reason: m.reason, at: m.at, by: m.by }));
  const cut = d.stock.moves.filter((m) => m.day === d.today && m.kind === 'potong_liner' && m.item === 'liner_besar').reduce((s, m) => s - m.qty, 0);
  // Keluar karena penjualan (stock_today().sold): today's sales deductions per item.
  const soldBy = {}; d.stock.moves.filter((m) => m.day === d.today && ['penjualan', 'batal_penjualan'].includes(m.kind) && (!m.at || m.at <= d.nowIso))
    .forEach((m) => { soldBy[m.item] = (soldBy[m.item] || 0) - m.qty; });
  const sold = STOCK_ITEMS.filter((i) => soldBy[i.code]).map((i) => ({ item: i.name, unit: i.unit, qty: Math.round(soldBy[i.code] * 100) / 100 }));
  return { day: d.today, goods_in: d.stock.goodsIn.filter((g) => g.day === d.today && g.at <= d.nowIso).slice().reverse().map(withSupplier).map(({ item_code, day, ...g }) => g), liner_cut: cut, count: null, outs, sold };
}
export function stockReport(a) {
  const d = D(); const [f, t] = a && a.p_from ? [a.p_from, a.p_to || a.p_from] : [d.today, d.today];
  const items = stockItems();
  return { from: f, to: t, items: items.map((it) => {
    const all_ = mvs().filter((m) => m.item === it.code), before = all_.filter((m) => m.day < f), within = all_.filter((m) => m.day >= f && m.day <= t);
    const opening = (d.stock_open[it.code] || 0) + sum(before, (m) => m.qty), s = (k) => 0 - sum(within.filter((m) => m.kind === k), (m) => m.qty);
    const masuk = sum(within.filter((m) => m.kind === 'masuk'), (m) => m.qty), pot = sum(within.filter((m) => m.kind === 'potong_liner'), (m) => m.qty), adj = sum(within.filter((m) => m.kind === 'selisih'), (m) => m.qty);
    const expected = opening + masuk - s('penjualan') - s('sampel') - s('buang') - s('rusak') - s('promo') + pot;
    const cnts = d.stock.counts.filter((c) => c.day >= f && c.day <= t && c.status !== 'ditolak').flatMap((c) => c.lines.filter((l) => l.code === it.code));
    const closing = expected + adj;
    return { ...it, opening, masuk, terjual: s('penjualan'), sampel: s('sampel'), buang: s('buang'), rusak: s('rusak'), promo: s('promo'), potong_liner: pot, expected, counted: cnts.length ? cnts[cnts.length - 1].counted : null, selisih: adj, closing };
  }) };
}
export function recipes() {
  const products = ['sig1', 'sig6', 'mini8', 'mini15', 'bag'].map((c) => ({ code: c, name: PRODUCTS[c].name, needs_flavour: PRODUCTS[c].flav }));
  const lines = [];
  for (const p of products) for (const f of (p.needs_flavour ? FLAVOURS.map((x) => x.id) : [null])) {
    for (const [c, q] of recipe(p.code, f)) lines.push({ product: p.code, flavour: ['vla_vanilla', 'vla_choco', 'vla_matcha', 'jam_strawberry'].includes(c) ? f : null, item_id: itemByCode[c].id, qty: q });
  }
  const seen = new Set(); const uniq = lines.filter((l) => { const k = [l.product, l.flavour, l.item_id].join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
  return { products, flavours: FLAVOURS.map((f) => ({ id: f.id, label: f.label })), items: stockItems().map((i) => ({ ...i, unit_cost: itemById[i.id].cost })), lines: uniq };
}
export function requests() { return JSON.parse(JSON.stringify(D().stock.requests)).map((r) => ({ ...r, supplier_id: 2, supplier: 'Toko Sejati' })); }
export function requestsIn(a) { const d = D(); const [f, t] = a && a.p_from ? [a.p_from, a.p_to] : [addD(d.today, -45), d.today]; return requests().filter((r) => r.day >= f && r.day <= t); }
export const requestsOpen = () => requests().filter((r) => ['dikirim', 'sebagian'].includes(r.status));

/* ------------------------------------------------------------------ attendance */
const dayBlocks = (id, d) => (D().att[id] && D().att[id][d]) || [];
export function onDuty() {
  const d = D(), out = [];
  for (const s of STAFF) for (const b of dayBlocks(s.id, d.today)) {
    if (b.kind !== 'jadwal' || b.masuk_m > d.nowMin || (b.pulang_m != null && b.pulang_m <= d.nowMin)) continue;
    const brk = b.break_start_m != null && d.nowMin >= b.break_start_m && d.nowMin < b.break_end_m;
    out.push({ id: s.id, name: s.name, status: brk ? 'istirahat' : 'kerja', since: iso(d.today, brk ? b.break_start_m : b.masuk_m) });
  }
  return out;
}
const shownScans = (b, d) => b.scans.filter((s) => d !== D().today || s._m <= D().nowMin).map(({ _m, ...s }) => s);
export function dayReport(date) {
  const d = D(), day = date || d.today;
  return { date: day, people: STAFF.map((s) => {
    const blocks = dayBlocks(s.id, day).filter((b) => b.kind === 'jadwal');
    const scans = blocks.flatMap((b) => shownScans(b, day));
    const report = blocks.filter((b) => day !== d.today || b.masuk_m <= d.nowMin).map((b) => {
      const live = day === d.today && (b.pulang_m == null || b.pulang_m > d.nowMin);
      const brk = live && b.break_start_m != null && d.nowMin >= b.break_start_m && d.nowMin < b.break_end_m;
      const fl = b.flags.filter((x) => !(live && x === 'pulang_lewat'));
      return { kind: 'jadwal', shift: b.shift, start: b.start, end: b.end, masuk: b.masuk, ...(live ? {} : { pulang: b.pulang }), late_min: b.late_min, break_min: live ? (b.break_start_m != null && d.nowMin >= b.break_end_m ? b.break_min : 0) : b.break_min,
        overtime_min: live ? 0 : b.overtime_min, flags: [...fl, ...(live ? [brk ? 'sedang_istirahat' : 'sedang_bekerja'] : [])] };
    });
    let next = []; if (day === d.today) { const on = onDuty().find((x) => x.id === s.id); next = on ? (on.status === 'istirahat' ? ['kembali'] : ['istirahat', 'pulang']) : (blocks.some((b) => b.masuk_m > d.nowMin) || !blocks.length ? ['masuk'] : []); }
    return { id: s.id, name: s.name, full_name: s.full_name, next, is_me: s.id === 's-yuya', report, scans };
  }) };
}
export const leaveList = () => [...D().leaves.map((l) => ({ id: l.id, staff_id: l.staff_id, name: who(l.staff_id).name, start: l.start, end: l.end, reason: l.reason, status: l.status, ...(l.decided_by ? { decided_by: l.decided_by } : {}) }))].sort((a, b) => b.id - a.id);
export const overtimeList = () => D().overtime.map((o) => ({ ...o, name: who(o.staff_id).name }));
export function setup() {
  const d = D(), weekly = [];
  for (const s of STAFF) for (let w = 1; w <= 7; w++) for (const b of WEEKLY[s.id][w]) weekly.push({ staff_id: s.id, name: s.name, weekday: w, kind: b.kind, ...(b.start ? { start: b.start, end: b.end } : {}), ...(b.shift ? { shift: b.shift } : {}) });
  return { staff: STAFF.map((s) => ({ id: s.id, name: s.name, full_name: s.full_name, role: s.role })), shifts: SHIFTS, weekly, dates: d.oneOff.map((e) => ({ ...e, name: who(e.staff_id).name })), opening: { open: '08:00', close: '21:00' }, today: d.today };
}
export function recapRange(a) {
  const d = D(), from = a.p_from, to = a.p_to, n = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  const people = STAFF.filter((s) => !a.p_staff || s.id === a.p_staff).map((s, i) => {
    const days = [];
    for (let k = 0; k < n; k++) {
      const day = addD(from, k);
      if (d.onLeave(s.id, day)) { days.push({ date: day, kind: 'izin', flags: [], worked_min: 0, break_min: 0 }); continue; }
      const bl = dayBlocks(s.id, day);
      if (bl.length) for (const b of bl) days.push({ date: day, kind: 'jadwal', shift: b.shift, start: b.start, end: b.end, masuk: day <= d.today ? b.masuk : undefined, pulang: day < d.today ? b.pulang : undefined,
        worked_min: day < d.today ? b.worked_min : 0, break_min: day < d.today ? b.break_min : 0, late_min: day <= d.today ? b.late_min : 0, early_min: 0, overtime_min: day < d.today ? b.overtime_min : 0, flags: day < d.today ? b.flags : [] });
      else if (day > d.today) d.blocksOf(s.id, day).filter((b) => b.kind === 'kerja').forEach((b) => days.push({ date: day, kind: 'jadwal', shift: b.shift, start: b.start, end: b.end, flags: [], worked_min: 0, break_min: 0 }));
    }
    const sm = (k) => sum(days, (x) => x[k] || 0), has = (f) => days.filter((x) => x.flags.includes(f)).length;
    const ot = d.overtime.filter((o) => o.staff_id === s.id && o.date >= from && o.date <= to);
    return { id: s.id, name: s.name, full_name: s.full_name, role: s.role, whatsapp: s.whatsapp, bank_name: s.bank, bank_account: s.bank ? '12345678' + (90 + i) : null, bank_holder: s.bank ? s.full_name : null,
      days_worked: days.filter((x) => x.masuk && x.date < d.today).length, worked_min: sm('worked_min'), late_count: has('terlambat'), late_min: days.filter((x) => (x.flags || []).includes('terlambat')).reduce((t, x) => t + x.late_min, 0),
      break_min: sm('break_min'), break_over_count: has('istirahat_lebih'), early_min: 0, overtime_candidate_min: sum(ot, (o) => o.minutes), overtime_approved_min: sum(ot.filter((o) => o.status === 'disetujui'), (o) => o.approved_min || 0),
      leave_days: days.filter((x) => x.kind === 'izin').length, absent_count: 0, missing_scans: has('tidak_scan_pulang'), days, leaves: d.leaves.filter((l) => l.staff_id === s.id && l.start <= to && l.end >= from),
      // Daily target (12 Nov 2026): 9 hours, Kevin 5 hours; short_min = time under target on days worked.
      ...(() => { const tgt = s.id === 's-kevin' ? 300 : 540, byDay = {};
        days.filter((x) => x.masuk && x.date < d.today).forEach((x) => { byDay[x.date] = (byDay[x.date] || 0) + (x.worked_min || 0); });
        return { work_target_min: tgt, short_min: Object.values(byDay).reduce((t, w) => t + Math.max(0, tgt - w), 0) }; })() };
  });
  return { from, to, month: from.slice(0, 7), days_in_range: n, people };
}
export function week(a) {
  const d = D(), t = (a && a.p_start) || d.today, s0 = addD(t, -(dow(t) - 1));
  return { start: s0, end: addD(s0, 6), today: d.today, people: STAFF.map((s) => ({ id: s.id, name: s.name, full_name: s.full_name, role: s.role, days: Array.from({ length: 7 }, (_, i) => { const x = addD(s0, i);
    return { date: x, leave: d.onLeave(s.id, x), one_off: d.oneOff.some((e) => e.staff_id === s.id && e.date === x), blocks: d.blocksOf(s.id, x).map(({ kind, start, end, shift }) => ({ kind, start, end, shift })) }; }) })) };
}
