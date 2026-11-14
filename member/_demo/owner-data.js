// Demo only (_demo-owner.html): fake replies for the owner views that backoffice-data.js,
// stock-lib.js and attendance-lib.js don't cover. Returns undefined for anything else.
const iso = (h, m, daysAgo = 0) => { const d = new Date(Date.now() - daysAgo * 864e5); d.setHours(h, m, 0, 0); return d.toISOString(); };
const ymd = (daysAhead = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(Date.now() + daysAhead * 864e5));

const settings = {
  last_backup: iso(10, 0, 9), open_time: '08:00', close_time: '21:00', rupiah_per_stamp: 50000, max_stamps_per_day: 3, late_minutes: 15,
  menu: [{ id: 1, name: 'Signature 1 pcs', price: 20000, active: true }, { id: 2, name: 'Mini Box isi 8', price: 68000, active: true }, { id: 3, name: 'Mini Box isi 15', price: 99000, active: true }],
  campaigns: [{ id: 1, title: 'Mini choux isi 8 lebih hemat tiap Selasa', body: 'Khusus member, tunjukkan kartu di booth.', starts_on: ymd(-3), ends_on: ymd(11), active: true }],
};

const products = {
  categories: [{ id: 1, name: 'Signature', active: true, products: 2 }, { id: 2, name: 'Mini Choux', active: true, products: 2 }, { id: 3, name: 'Lainnya', active: true, products: 1 }],
  products: [
    { code: 'sig1', pos_name: 'Signature 1 pcs', category_id: 1, price: 20000, flavour_surcharge: 0, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'sig6', pos_name: 'Signature Box isi 6', category_id: 1, price: 120000, flavour_surcharge: 3000, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'mini15', pos_name: 'Mini Box isi 15', category_id: 2, price: 99000, flavour_surcharge: 3000, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'mini8', pos_name: 'Mini Box isi 8', category_id: 2, price: 68000, flavour_surcharge: 3000, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'bag', pos_name: 'Paper bag', category_id: 3, price: 5000, flavour_surcharge: 0, active: true, needs_flavour: false, channel_prices: {} }],
  channels: [{ id: 'toko', label: 'Di booth', delivery: false, active: true }, { id: 'shopeefood', label: 'ShopeeFood', delivery: true, active: false }, { id: 'grabfood', label: 'GrabFood', delivery: true, active: false }],
  flavours: [{ id: 'vanilla', label: 'Vanilla', surcharge: false, active: true }, { id: 'choco', label: 'Choco', surcharge: true, active: true },
    { id: 'matcha', label: 'Matcha', surcharge: true, active: true }, { id: 'matcha_strawberry', label: 'Matcha Strawberry', surcharge: true, active: true }],
};


import * as V from './sample-views.js';
import { data, addD, iso as isoAt, STAFF, MANAGER, OWNER } from './sample-data.js';
const PEOPLE = [...STAFF, MANAGER, OWNER];

const derive = {
  owner_dashboard: (a) => V.dashboard(a),
  owner_sales: () => V.ownerSales(),
  owner_people: () => V.people(),
  // Kasir tablet account (13 Nov 2026). ?kt=0 starts without one, to see the add form.
  owner_kasir_accounts: () => kasirTablets,
  owner_code_report: () => V.codeReport(),
  owner_find_account: () => { const m = data().byId.desi; return [{ full_name: m.name, username: 'desi', whatsapp: m.phone, role: 'member', birth_date: m.birth_date }]; },
  owner_settings: () => settings,
  owner_pos_products: () => products,
  pos_home: () => V.posHome(),
  owner_pos_stats: (a) => statsWithGrain(a),
  owner_pos_profit: (a) => V.profit(a),
  owner_pos_report: (a) => V.report(a),
  stock_low: () => V.stockItems().filter((i) => i.low).map(({ id, name, unit, qty, low_level }) => ({ id, name, unit, qty, low_level })),
  owner_cash_shifts: (a) => V.cashShifts(a),
  pos_shift_rekap: (a) => { const d = data(); const sh = (a && a.p_shift && d.shifts.find((x) => x.id === a.p_shift)) || V.lastClosedShift(); return V.rekapOf(sh, true); },
};
let kasirTablets = new URLSearchParams(location.search).get('kt') === '0' ? []
  : [{ id: 'k-tablet', username: 'kasir.booth', full_name: 'Kasir tablet', created_at: '2026-11-13T08:00:00+07:00' }];
// Writes the owner page makes (nothing is stored, except the kasir tablet account for this page view).

const writes = {
  owner_save_cash_settings: () => ({ cash_float: data().cashFloat, cash_flag_at: data().cashFlagAt }),
  pos_rekap_printed: () => ({ reprint: true, reprints: 2 }),
  owner_add_kasir: (a) => { if (kasirTablets.length) throw new Error('Sudah ada akun kasir tablet. Hapus yang lama dulu kalau mau membuat yang baru.');
    kasirTablets = [{ id: 'k-tablet', username: a.p_username, full_name: 'Kasir tablet', created_at: new Date().toISOString() }]; return kasirTablets[0]; },
  owner_remove_kasir: () => { kasirTablets = []; return null; },
  owner_kasir_password: () => null,
  pos_rekap_exported: () => ({ at: new Date().toISOString() }),
};
// Ringkasan chart (13 Nov 2026): p_grain jam | hari | minggu | bulan, like owner_pos_stats in pos-reports.sql.
function statsWithGrain(a = {}) {
  const s = V.stats(a), g = a.p_grain;
  s.sales_before_refunds = s.sales; s.discount = 0;
  if (!g || g === s.grain) return s;
  const f = s.from, t = s.to, days = [];
  for (let x = f; x <= t; x = addD(x, 1)) days.push(x);
  if (g === 'jam') {
    const hrs = new Map();
    days.forEach((x) => V.stats({ p_from: x, p_to: x }).series.forEach((r) => { const h = hrs.get(r.label) || { label: r.label, sales: 0, receipts: 0 }; h.sales += r.sales; h.receipts += r.receipts; hrs.set(r.label, h); }));
    s.series = [...hrs.values()];
  } else {
    const daily = days.map((x) => { const d = V.stats({ p_from: x, p_to: x }); return { day: x, sales: d.sales, receipts: d.receipts }; });
    const key = g === 'hari' ? (d) => d.day : g === 'bulan' ? (d) => d.day.slice(0, 7) : (d) => { const i = Math.floor(days.indexOf(d.day) / 7); return days[i * 7]; };
    const lab = g === 'hari' ? (k) => `${k.slice(8)}/${k.slice(5, 7)}` : g === 'bulan' ? (k) => `${k.slice(5)}/${k.slice(0, 4)}` : (k) => `Mg ${k.slice(8)}/${k.slice(5, 7)}`;
    const m = new Map();
    daily.forEach((d) => { const k = key(d), r = m.get(k) || { label: lab(k), sales: 0, receipts: 0 }; r.sales += d.sales; r.receipts += d.receipts; m.set(k, r); });
    s.series = [...m.values()];
  }
  s.grain = g;
  return s;
}
// Penjualan per staf on Ringkasan: revenue and pieces by who served (pos-reports.sql report_dashboard).
export function staffExtra(from, to) {
  const out = new Map();
  V.paidOn(from, to).forEach((o) => { const k = PEOPLE.find((x) => x.id === o.served_by)?.full_name, r = out.get(k) || { revenue: 0, items: 0 }; r.revenue += o.total; r.items += o.lines.filter((l) => !l.free_bag).reduce((n, l) => n + l.qty, 0); out.set(k, r); });
  return out;
}
export const ownerFake = (name, args = {}) => (name in derive ? structuredClone(derive[name](args)) : name in writes ? writes[name](args) : undefined);
