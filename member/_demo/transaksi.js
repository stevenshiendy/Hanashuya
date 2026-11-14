// Demo only (_demo-owner.html, _demo-transaksi.html): fake replies for the Transaksi views
// (js/owner-transaksi.js), built on the shared sample data. Returns undefined for anything else.
import * as V from './sample-views.js';
import { data, STAFF } from './sample-data.js';

const stamp = (day, m = 600) => new Date(`${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00+07:00`).toISOString();
const shopCodes = ['Dus besar', 'Dus kecil', 'Paper liner besar', 'Paper liner kecil', 'Paper pouch (untuk 1 pcs)', 'Paper bag'];
const estOf = (l) => (shopCodes.includes(l.item) ? Math.round((V.stockItems().find((i) => i.id === l.item_id)?.low_level || 20) * 0 + 450 + (l.item_id % 5) * 350) : null);
const withPo = (r) => {
  const lines = r.lines.map((l) => ({ ...l, est_cost: estOf(l) }));
  const est = lines.reduce((s, l) => s + (l.est_cost != null ? l.est_cost * Number(l.qty) : 0), 0);
  return { ...r, lines, lines_count: lines.length, est_total: est || null };
};
const adjust = [];
const payouts = [];
let pid = 1;
// Seed rows so every Transaksi list has something to look at (Glenn, 12 Nov 2026: mock data for every function).
{
  const t = data().today, back = (n) => { const d = new Date(t + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  [[1, 'Vla Vanilla', 'g', -180, 'Tumpah saat isi ulang piping bag'], [3, 'Paper liner kecil', 'pcs', 20, 'Ditemukan 1 pak di gudang belakang'],
    [6, 'Mini Choux', 'pcs', -12, 'Selisih hitung pagi, disetujui Glenn']].forEach(([n, item, unit, delta, reason]) =>
    adjust.push({ id: adjust.length + 1, at: stamp(back(n), 9 * 60 + 15), day: back(n), item, unit, delta, reason, by: 'Glenn' }));
  const from = back(35), to = back(5);
  STAFF.filter((x) => x.role !== 'owner').slice(0, 3).forEach((x, i) => payouts.push({ id: pid++, period_from: from, period_to: to, staff_id: x.id, name: x.name,
    orders: [62, 48, 21][i], sales: [4210000, 3380000, 1460000][i], commission: [42100, 33800, 14600][i], processed_by: 'Glenn', processed_at: stamp(back(4), 20 * 60),
    paid_at: i < 2 ? stamp(back(3), 10 * 60) : null, paid_by: i < 2 ? 'Glenn' : null, note: null, cancelled_at: null, cancel_reason: null, status: i < 2 ? 'dibayar' : 'diproses' }));
}

function preview(a) {
  const d = data(), by = {};
  d.orders.filter((o) => o.status === 'dibayar' && o.day >= a.p_from && o.day <= a.p_to).forEach((o) => {
    const x = (by[o.served_by] ||= { staff_id: o.served_by, name: (STAFF.find((s) => s.id === o.served_by) || {}).name, orders: 0, sales: 0, commission: 0 });
    x.orders += 1; x.sales += o.total; x.commission += Math.round(o.total * 0.01);
  });
  const rows = Object.values(by).map((x) => {
    const p = payouts.find((y) => y.staff_id === x.staff_id && y.status !== 'batal' && y.period_from <= a.p_to && y.period_to >= a.p_from);
    return { ...x, payout_id: p ? p.id : null, payout_paid: p ? p.status === 'dibayar' : null };
  });
  return { from: a.p_from, to: a.p_to, unassigned: 0, rows: rows.sort((x, y) => y.commission - x.commission) };
}

export function transaksiFake(name, a = {}) {
  switch (name) {
    case 'stock_po_list': return V.requestsIn(a).map(withPo);
    case 'stock_po_create': case 'stock_po_update': return { id: 99, no: 'PB-DEMO-01', status: 'dikirim' };
    case 'stock_po_receive': return { id: a.p_request, status: 'sebagian' };
    case 'stock_request_open': return V.requestsOpen().map(withPo);
    case 'stock_request_cancel': return { id: a.p_id, status: 'batal' };
    case 'stock_goods_in_list': return V.goodsInList(a).map((g) => ({ ...g, day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(g.at)) })).map((g, i) => (g.supplier_id === 2 ? { ...g, request_id: 100 + (i % 3), request_no: `PB-${String(2611 - (i % 3)).padStart(6, '2')}-0${1 + (i % 3)}` } : { ...g, request_id: null, request_no: null }));
    case 'stock_change_goods_in': case 'stock_cancel_goods_in': case 'stock_goods_in': case 'stock_out': return { ok: true };
    case 'stock_supplier_delete': return { id: a.p_id, deleted: true };
    case 'stock_out_list': {
      const d = data(), items = V.stockItems(), rows = [];
      let id = 1;
      d.orders.filter((o) => o.status === 'dibayar' && o.day >= a.p_from && o.day <= a.p_to).slice(-60).forEach((o) => o.lines.slice(0, 1).forEach((l) => {
        rows.push({ id: id++, at: o.sold_at, day: o.day, item: 'Mini Choux', unit: 'pcs', qty: l.qty * (l.code === 'mini15' ? 15 : l.code === 'sig6' ? 6 : 1), kind: 'penjualan', reason: null, receipt_no: o.receipt_no, responsible: (STAFF.find((s) => s.id === o.served_by) || {}).name });
      }));
      [['sampel', 'Sampel mini', 3], ['buang', 'Sisa hari ini', 4], ['rusak', 'Jatuh saat dikemas', 1], ['promo', 'Voucher Papaya', 2]].forEach(([kind, reason, qty], i) => {
        rows.push({ id: id++, at: stamp(d.today, 540 + i * 60), day: d.today, item: items[i % 2].name, unit: 'pcs', qty, kind, reason, receipt_no: null, responsible: 'Ranny' });
      });
      return rows.filter((r) => !a.p_kind || r.kind === a.p_kind).sort((x, y) => y.at.localeCompare(x.at));
    }
    case 'stock_adjust_list': return adjust.slice().reverse();
    case 'stock_adjust': {
      const i = V.stockItems().find((x) => x.id === a.p_item), delta = a.p_mode === 'set' ? a.p_qty - i.qty : a.p_qty;
      adjust.push({ id: adjust.length + 1, at: new Date().toISOString(), day: data().today, item: i.name, unit: i.unit, delta, reason: a.p_reason, by: 'Glenn' });
      return { item: i.name, before: i.qty, after: i.qty + delta, delta };
    }
    case 'stock_decide_count': return { ok: true };
    case 'pos_commission_preview': return preview(a);
    case 'pos_commission_payouts': return payouts.filter((p) => p.period_from <= a.p_to && p.period_to >= a.p_from).slice().reverse();
    case 'pos_commission_process': {
      const rows = preview(a).rows.filter((r) => !r.payout_id && r.commission > 0 && (!a.p_staff || a.p_staff.includes(r.staff_id)));
      if (!rows.length) throw new Error('Komisi periode ini sudah diproses.');
      rows.forEach((r) => payouts.push({ id: pid++, period_from: a.p_from, period_to: a.p_to, staff_id: r.staff_id, name: r.name, orders: r.orders, sales: r.sales, commission: r.commission,
        processed_by: 'Glenn', processed_at: new Date().toISOString(), paid_at: null, paid_by: null, note: a.p_note || null, cancelled_at: null, cancel_reason: null, status: 'diproses' }));
      return { processed: rows.length, skipped: 0, total: rows.reduce((s, r) => s + r.commission, 0) };
    }
    case 'pos_commission_mark_paid': { const p = payouts.find((x) => x.id === a.p_id); p.status = 'dibayar'; p.paid_at = new Date().toISOString(); p.paid_by = 'Glenn'; return { id: p.id, status: 'dibayar' }; }
    case 'pos_commission_cancel': { const p = payouts.find((x) => x.id === a.p_id); p.status = 'batal'; p.cancelled_at = new Date().toISOString(); p.cancel_reason = a.p_reason; return { id: p.id, status: 'batal' }; }
    case 'pos_void_overview': {
      const d = data();
      return d.orders.filter((o) => o.void && o.day >= a.p_from && o.day <= a.p_to).map((o) => ({ key: 'v' + o.id, order_id: o.id, receipt_no: o.receipt_no, sold_at: o.sold_at, at: o.void.created_at, kind: o.void.kind,
        amount: o.total, reason: o.void.reason, asked_by: o.void.requested_by, decided_by: o.void.decided_by, decided_at: o.void.decided_at, status: o.void.status }))
        .sort((x, y) => y.at.localeCompare(x.at));
    }
    default: return undefined;
  }
}
