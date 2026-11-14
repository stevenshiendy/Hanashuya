// Demo only (_demo-owner.html): the real lib.js with a signed-in owner and fake data for
// every owner view: owner-data.js first, then the back-office, stock and attendance fakes.
import { rpc as office } from './backoffice-data.js';
import { insightsFake } from './member-insights-data.js';
import { rpc as stockRpc } from './stock-lib.js';
import { rpc as attRpc } from './attendance-lib.js';
import { ownerFake, staffExtra } from './owner-data.js';
import { transaksiFake } from './transaksi.js';
import { akuntingFake } from './akunting.js';
import { produksiFake } from './produksi-data.js';
import { reservasiFake } from './reservasi-data.js';
import { laporan2Fake } from './laporan2-data.js';
import { sampleFake } from './sample-quota-data.js';
import { komisiFake, schedule, komisiAnchor, komisiToday, komisiDue, komisiEnd } from './komisi-data.js';
export * from '../js/lib.js';
export const configured = true;
export const session = async () => true;
// Bonus stempel and Komisi (12 Nov 2026), kept in memory for this demo visit.
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const addDays = (n) => ymd(new Date(Date.now() + n * 864e5));
const boosts = [
  { id: 2, name: 'Minggu ganda', starts_on: addDays(-3), ends_on: addDays(25), days: [7], multiplier: 2, active: true, note: null, orders: 3, extra_stamps: 5 },
  { id: 1, name: 'Ulang tahun booth', starts_on: addDays(-40), ends_on: addDays(-38), days: null, multiplier: 3, active: true, note: null, orders: 14, extra_stamps: 31 },
].map((b) => ({ ...b, running: b.active && b.starts_on <= ymd(new Date()) && b.ends_on >= ymd(new Date()) }));
const rules = [
  { id: 2, name: 'Signature Box', product_code: 'sig6', product: 'Signature Box isi 6', kind: 'rupiah', value: 2000, starts_on: addDays(-10), ends_on: null, active: true },
  { id: 1, name: 'Komisi standar 1%', product_code: null, product: null, kind: 'persen', value: 1, starts_on: '2026-01-01', ends_on: null, active: true },
];
// Komisi switches (14 Nov 2026): off by default.
const komisi = { enabled: true, staff: [
  { id: 's-rany', name: 'Rany Marlina', role: 'staff', employer: 'Hanashuya', enabled: true, self: false },
  { id: 's-fajar', name: 'Fajar Prihantoro', role: 'staff', employer: 'Hanashuya', enabled: true, self: false },
  { id: 's-kevin', name: 'Kevin Hadiyan', role: 'staff', employer: 'Kaaramel Juice', enabled: true, self: false },
  { id: 's-yuya', name: 'Eoudia Samulla Vidiani', role: 'staff', employer: 'Kaaramel Juice', enabled: false, self: false },
  { id: 'o-glenn', name: 'Glenn', role: 'owner', employer: null, enabled: false, self: true }] };
function loyalty(name, a) {
  // Jadwal komisi (14 Nov 2026): the schedule lives in komisi-data.js with the dashboard fakes.
  const withSchedule = () => { const from = komisiAnchor(), to = komisiEnd(from);
    return { ...komisi, ...schedule, enabled_at: '2026-09-01', today: komisiToday, anchor: from, is_owner: !AS_MANAGER, current: { from, to, due: komisiDue(to) } }; };
  if (name === 'commission_settings') return withSchedule();
  if (name === 'commission_set_enabled') { komisi.enabled = !!a.p_enabled; return withSchedule(); }
  if (name === 'commission_set_staff') { komisi.staff.find((s) => s.id === a.p_staff).enabled = !!a.p_enabled; return withSchedule(); }
  const km = komisiFake(name, a, !AS_MANAGER);
  if (km !== undefined) return km ?? withSchedule();
  if (name === 'owner_stamp_boosts') return boosts;
  if (name === 'owner_commission_rules') return rules;
  if (name === 'owner_save_stamp_boost' || name === 'owner_save_commission_rule') {
    const list = name === 'owner_save_stamp_boost' ? boosts : rules;
    const row = a.p_id ? list.find((x) => x.id === a.p_id) : null;
    if (row) Object.assign(row, a.p); else list.unshift({ id: list.length + 3, orders: 0, extra_stamps: 0, ...a.p });
    return { id: row?.id || list[0].id };
  }
  // Laporan pembelian and Laporan lainnya (12 Nov 2026): a fixed, realistic month.
  if (name === 'owner_purchase_report') {
    const rows = Array.from({ length: 24 }, (_, i) => {
      const it = [['Mini Choux', 'pcs', 120, 726], ['Signature Choux', 'pcs', 30, 1940], ['Vla Vanilla', 'g', 2000, 85], ['Dus besar', 'pcs', 50, 2650]][i % 4];
      return { id: 100 + i, day: addDays(-Math.floor(i * 1.2)), item: it[0], unit: it[1], qty: it[2], supplier: i % 4 === 3 ? 'Toko Sejati' : 'hanashuya.id', po: i % 5 === 0 ? `PB-261${100 + i}-01` : null, cost: i % 7 === 6 ? null : it[2] * it[3], unit_cost: it[3], note: null };
    });
    const sumBy = (k) => Object.values(rows.reduce((m, r) => { const key = r[k]; m[key] ||= { [k]: key, deliveries: 0, qty: 0, cost: 0, unit: r.unit }; m[key].deliveries++; m[key].qty += r.qty; m[key].cost += r.cost || 0; return m; }, {}));
    return { from: a.p_from, to: a.p_to, deliveries: rows.length, total_cost: rows.reduce((t, r) => t + (r.cost || 0), 0), without_cost: rows.filter((r) => r.cost == null).length,
      by_supplier: sumBy('supplier'), by_item: sumBy('item').map((x) => ({ ...x, avg_unit_cost: x.cost / x.qty })), rows };
  }
  if (name === 'owner_other_report') {
    return { from: a.p_from, to: a.p_to, cash: { shifts: 30, difference: -14000, over_limit: 1 },
      commission: [{ name: 'Ranny', orders: 58, commission: 44100 }, { name: 'Fajar', orders: 51, commission: 38900 }, { name: 'Yuya', orders: 47, commission: 35200 }, { name: 'Kevin', orders: 19, commission: 13800 }],
      promos: [{ name: 'Diskon 50% member baru', uses: 9, discount: 112000 }, { name: 'Diskon 10% (stempel 3)', uses: 6, discount: 43800 }, { name: 'Voucher Papaya', uses: 4, discount: 80000 }, { name: 'BOGO Deals', uses: 11, discount: 220000 }],
      stock_out: [{ kind: 'sampel', item: 'Mini Choux', unit: 'pcs', qty: 46, cost: 33396 }, { kind: 'sampel', item: 'Vla Vanilla', unit: 'g', qty: 690, cost: 58650 }, { kind: 'buang', item: 'Mini Choux', unit: 'pcs', qty: 22, cost: 15972 }, { kind: 'rusak', item: 'Dus besar', unit: 'pcs', qty: 3, cost: 7950 }],
      cards_made: 17, flags: [{ flag: 'nomor_dicari', count: 9 }, { flag: 'bonus_stempel', count: 6 }, { flag: 'kode_diketik', count: 3 }, { flag: 'dikirim_terlambat', count: 2 }] };
  }
  return undefined;
}
// ?as=manager (13 Nov 2026): the page as a manager sees it. Like the SQL, only the read-only report
// calls answer; anything else is refused, so a view that still asks for owner data shows up at once.
const AS_MANAGER = new URLSearchParams(location.search).get('as') === 'manager';
const MANAGER_OK = /^(whoami|report_dashboard|owner_pos_stats|owner_pos_report|owner_pos_profit|owner_laporan|owner_shift_detail|owner_purchase_report|owner_other_report|acc_(sync|accounts|journals|ledger|trial|pnl|balance_sheet|balance_monthly|journal_lines)|pos_void_overview|pos_commission_payouts|commission_(settings|dashboard|set_enabled|set_staff|set_schedule)|pos_commission_mark_paid|stock_[a-z_]+|staff_daily_summary)$/;
export async function rpc(name, args = {}) {
  if (AS_MANAGER && !MANAGER_OK.test(name)) throw new Error('Halaman ini hanya untuk pemilik.');
  if (name === 'whoami') return AS_MANAGER ? { id: 'm-ranny', role: 'manager', full_name: 'Manajer Uji', whatsapp: '6281444444444' }
    : { id: 'o-glenn', role: 'owner', full_name: 'Glenn', whatsapp: '6285890120577' };
  if (name === 'report_dashboard') {
    const d = ownerFake('owner_dashboard', args);
    d.rule = 'Penjualan dihitung di tanggal transaksi. Batal, refund dan pembatalan stempel mengurangi di tanggal disetujui.';
    const ex = staffExtra(d.from, d.to);
    d.staff = d.staff.map((x) => ({ ...x, ...(ex.get(x.full_name) || { revenue: 0, items: 0 }) }));
    if (!AS_MANAGER) return { ...d, role: 'owner' };
    return { ...d, role: 'manager', lapsed: [], last_backup: null, undo: [], staff: d.staff.map((x) => ({ ...x, whatsapp: null, email: null })) };
  }
  if (/^owner_member_(groups|action_list|overview)$/.test(name)) return insightsFake(name, args);
  if (/^owner_sample_/.test(name)) return sampleFake(name, args);
  if (name === 'owner_charges') return globalThis.__charges ||= { service_on: false, service_pct: 5, pbjt_on: false, pbjt_pct: 10, pbjt_included: false };
  if (name === 'owner_set_charges') { const p = args.p; if (Number(p.pbjt_pct) > 10) throw new Error('PBJT paling tinggi 10 persen (UU 1/2022).'); globalThis.__charges = { ...p, service_pct: Number(p.service_pct), pbjt_pct: Number(p.pbjt_pct) }; return globalThis.__charges; }
  if (name === 'pos_queue_slip') return !!globalThis.__queueSlip;
  if (name === 'owner_set_queue_slip') { globalThis.__queueSlip = !!args.p_on; return globalThis.__queueSlip; }
  // Laporan hubs, transfers/produksi and pesanan di muka (12 Nov 2026): the agents' demo fakes.
  const lap = await laporan2Fake(name, args); if (lap !== undefined) return lap;
  const prd = produksiFake(name, args); if (prd !== undefined) return prd;
  if (/^pos_(reservation|deposit|stamp|member_search|catalog$)/.test(name)) { const rs = await reservasiFake(name, args); if (rs !== undefined) return rs; }
  const acc = akuntingFake(name, args); if (acc !== undefined) return acc;
  const loy = loyalty(name, args);
  if (loy !== undefined) return loy;
  const trx = transaksiFake(name, args);
  if (trx !== undefined) return trx;
  const mine = ownerFake(name, args);
  if (mine !== undefined) return mine;
  if (name.startsWith('att_')) return attRpc(name, args);
  if (name.startsWith('stock_') || name.startsWith('owner_stock')) return stockRpc(name, args);
  return office(name, args);
}
