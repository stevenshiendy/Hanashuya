// Demo only: fake replies for Pesanan di muka, deposit and koreksi stempel (used by _demo-reservasi.html and _demo-owner.html).
// No DP since 13 Nov 2026 (Glenn): open pre-orders have none; r4 and r5 keep an older DP as history.
import { rupiah } from '../js/lib.js';

const ymd = (n = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(Date.now() + n * 864e5));
const at = (n, hm) => new Date(`${ymd(n)}T${hm}:00+07:00`).toISOString();
const PRODUCTS = [
  { code: 'sig1', name: 'Signature 1 pcs', price: 20000, needs_flavour: true, flavour_surcharge: 0 },
  { code: 'sig6', name: 'Signature Box isi 6', price: 120000, needs_flavour: true, flavour_surcharge: 3000 },
  { code: 'mini15', name: 'Mini Box isi 15', price: 99000, needs_flavour: true, flavour_surcharge: 3000 },
  { code: 'mini8', name: 'Mini Box isi 8', price: 68000, needs_flavour: true, flavour_surcharge: 3000 },
];
const FLAV = [{ id: 'vanilla', label: 'Vanilla', surcharge: false }, { id: 'choco', label: 'Choco', surcharge: true }, { id: 'matcha', label: 'Matcha', surcharge: true }, { id: 'matcha_strawberry', label: 'Matcha Strawberry', surcharge: true }];
export const STAFF = [{ id: 's1', name: 'Ranny', is_me: true }, { id: 's2', name: 'Fajar' }, { id: 's3', name: 'Kevin' }];
const line = (n, code, fl, qty) => { const p = PRODUCTS.find((x) => x.code === code), f = FLAV.find((x) => x.id === fl); const u = p.price + (f.surcharge ? p.flavour_surcharge : 0);
  return { line: n, product: code, name: p.name, flavour: fl, flavour_label: f.label, qty, unit_price: u, line_total: u * qty }; };
let nid = 10;
const dep = (kind, amount, method, by, a, note = null, receipt_no = null) => ({ id: nid++, kind, label: { dp: 'DP masuk', pakai: 'Dipakai', refund: 'Dikembalikan', hangus: 'Hangus', koreksi: 'Koreksi' }[kind], amount, method, note, at: a, by, receipt_no });
const R = [
  { id: 'r1', no: 'PM-261110-01', status: 'siap', customer_name: 'Bu Rina (arisan RT 04)', whatsapp: '6281712345678', member: null, pickup_at: at(0, '15:30'), pickup_day: ymd(0), pickup_time: '15:30',
    note: 'Pakai pita merah, 2 paper bag', free_bags: 2, items: [line(1, 'sig6', 'vanilla', 3), line(2, 'mini15', 'matcha', 1)], deposits: [], created_at: at(-2, '10:10'), created_by: 'Glenn' },
  { id: 'r2', no: 'PM-261111-01', status: 'dikonfirmasi', customer_name: 'Desi Ayu', whatsapp: '6281555555555', member: { id: 'm1', name: 'Desi Ayu', card_code: 'K7PX-3MQ9' }, pickup_at: at(0, '18:00'), pickup_day: ymd(0), pickup_time: '18:00',
    note: null, free_bags: 0, items: [line(1, 'sig6', 'choco', 1)], deposits: [], created_at: at(-1, '14:18'), created_by: 'Ranny' },
  { id: 'r3', no: 'PM-261112-01', status: 'baru', customer_name: 'PT Sinar Kantor', whatsapp: '6281811112222', member: null, pickup_at: at(2, '09:30'), pickup_day: ymd(2), pickup_time: '09:30',
    note: 'Untuk rapat, diambil kurir', free_bags: 0, items: [line(1, 'mini8', 'vanilla', 5), line(2, 'mini8', 'matcha_strawberry', 5)], deposits: [], created_at: at(0, '09:02'), created_by: 'Glenn' },
  { id: 'r4', no: 'PM-261108-02', status: 'batal', customer_name: 'Pak Budi', whatsapp: '6281933334444', member: null, pickup_at: at(-1, '12:00'), pickup_day: ymd(-1), pickup_time: '12:00', cancel_reason: 'Acara diundur',
    note: null, free_bags: 0, items: [line(1, 'sig6', 'vanilla', 2)], deposits: [dep('dp', 100000, 'tunai', 'Fajar', at(-4, '11:00')), dep('refund', -60000, 'tunai', 'Manajer', at(-1, '10:00'), 'Setengah dikembalikan')], created_at: at(-4, '10:58'), created_by: 'Fajar' },
  { id: 'r5', no: 'PM-261105-01', status: 'diambil', customer_name: 'Kak Nadia', whatsapp: '6281277778888', member: null, pickup_at: at(-5, '16:00'), pickup_day: ymd(-5), pickup_time: '16:00', receipt_no: 'HS-261107-0012', picked_at: at(-5, '16:05'),
    note: null, free_bags: 1, items: [line(1, 'sig6', 'matcha', 2)], deposits: [dep('dp', 100000, 'qris', 'Glenn', at(-7, '20:00')), dep('pakai', -100000, 'tunai', 'Ranny', at(-5, '16:05'), 'Dipakai di HS-261107-0012', 'HS-261107-0012')], created_at: at(-7, '19:58'), created_by: 'Glenn' },
];
const full = (r) => { const total = r.items.reduce((s, i) => s + i.line_total, 0), bal = r.deposits.reduce((s, d) => s + d.amount, 0);
  return { ...r, total, subtotal: total, deposit: bal, due: ['diambil', 'batal'].includes(r.status) ? 0 : total, over: Math.max(0, bal), receipt_no: r.receipt_no || null, picked_at: r.picked_at || null, cancel_reason: r.cancel_reason || null }; };
const row = (r) => { const f = full(r); return { ...f, items_text: r.items.map((i) => `${i.qty} ${i.name} ${i.flavour_label}`).join(', ') }; };
const STAMPS = [
  { sale_id: 1, at: at(0, '11:20'), member: 'Desi Ayu', card_code: 'K7PX-3MQ9', delta: 2, kind: 'koreksi', reason: 'Kemarin lupa scan kartu, struk HS-261111-0008', by: 'Manajer', adjustment_id: 1, reversed: false },
  { sale_id: 2, at: at(0, '10:02'), member: 'Sari Wulan', card_code: 'H2MN-8RT4', delta: 2, kind: 'penjualan', receipt_no: 'HS-261112-0003', by: 'Ranny', reversed: false },
  { sale_id: 3, at: at(-1, '17:40'), member: 'Andi Pratama', card_code: 'Q9WE-4ZX2', delta: -1, kind: 'koreksi', reason: 'Stempel ganda dari tap dua kali', by: 'Glenn', adjustment_id: 2, reversed: false },
  { sale_id: 4, at: at(-1, '15:12'), member: 'Desi Ayu', card_code: 'K7PX-3MQ9', delta: 1, kind: 'penjualan', receipt_no: 'HS-261111-0011', by: 'Fajar', reversed: false },
  { sale_id: 5, at: at(-2, '13:30'), member: 'Rina Kartika', card_code: 'P3LK-7YU6', delta: 3, kind: 'koreksi', reason: 'Salah member', cancel_reason: 'Dicatat ke kartu yang salah', by: 'Glenn', adjustment_id: 3, reversed: true },
];
const MEMBERS = [{ id: 'm1', name: 'Desi Ayu', whatsapp: '6281555555555', card_code: 'K7PX-3MQ9', stamps: 6, position: 6 }, { id: 'm2', name: 'Dewi Lestari', whatsapp: '6281299990000', card_code: 'T4GH-2JK8', stamps: 2, position: 2 }];

export async function reservasiFake(name, a = {}) {
  await new Promise((r) => setTimeout(r, 60));
  switch (name) {
    case 'pos_catalog': return { products: PRODUCTS, flavours: FLAV, staff: STAFF };
    case 'pos_reservation_list': return R.filter((r) => r.pickup_day >= a.p_from && r.pickup_day <= a.p_to && (!a.p_status || r.status === a.p_status || (a.p_status === 'aktif' && ['baru', 'dikonfirmasi', 'siap'].includes(r.status)))).map(row);
    case 'pos_reservation_today': return R.filter((r) => ['baru', 'dikonfirmasi', 'siap'].includes(r.status) && r.pickup_day <= ymd(0)).map(row);
    case 'pos_reservation_get': return full(R.find((r) => r.id === a.p_id));
    case 'pos_reservation_save': return { no: a.p_id ? R.find((r) => r.id === a.p_id).no : 'PM-261112-02' };
    case 'pos_reservation_set_status': { const r = R.find((x) => x.id === a.p_id); r.status = a.p_status; if (a.p_reason) r.cancel_reason = a.p_reason; return full(r); }
    case 'pos_deposit_add': throw new Error('Hanashuya tidak menerima DP. Pesanan di muka dibayar penuh saat diambil.');
    case 'pos_deposit_refund': case 'pos_deposit_forfeit': case 'pos_deposit_adjust': return full(R.find((r) => r.id === a.p_id));
    case 'pos_deposit_moves': { let bal = {}; return R.flatMap((r) => r.deposits.map((d) => ({ ...d, reservation_id: r.id, no: r.no, customer_name: r.customer_name, day: d.at.slice(0, 10) })))
      .sort((x, y) => x.id - y.id).map((d) => ({ ...d, balance_after: (bal[d.reservation_id] = (bal[d.reservation_id] || 0) + d.amount) }))
      .filter((d) => !a.p_kind || d.kind === a.p_kind).reverse(); }
    case 'pos_deposit_report': { const rows = R.map((r) => { const f = full(r), s = (k) => r.deposits.filter((d) => d.kind === k).reduce((x, d) => x + d.amount, 0);
      return { id: r.id, no: r.no, status: r.status, customer_name: r.customer_name, pickup_at: r.pickup_at, pickup_day: r.pickup_day, total: f.total, dp: s('dp'), used: -s('pakai'), refunded: -s('refund'), forfeited: -s('hangus'), adjusted: s('koreksi'), balance: f.deposit, receipt_no: f.receipt_no }; });
      return { rows, held_now: rows.reduce((s, r) => s + r.balance, 0), to_return: rows.filter((r) => ['batal', 'diambil'].includes(r.status) && r.balance > 0).reduce((s, r) => s + r.balance, 0) }; }
    case 'pos_member_search': return MEMBERS.filter((m) => m.name.toLowerCase().includes(a.p_q.toLowerCase()) || m.whatsapp.includes(a.p_q.replace(/\D/g, '').replace(/^0/, '')));
    case 'pos_stamp_history': return STAMPS;
    case 'pos_stamp_adjust': return { member: 'Desi', total_stamps: 8 };
    case 'pos_stamp_adjust_cancel': return { id: a.p_id };
    case 'pos_reservation_checkout': { const f = full(R.find((r) => r.id === a.p_id));
      return { receipt_no: 'HS-261112-0021', total: f.total, payment_method: a.p_order.payment.method, cash_received: a.p_order.payment.cash, change: a.p_order.payment.cash - f.due, member: f.member ? 'Desi' : null, stamps: 2, lines: [] }; }
    default: return undefined;
  }
}

