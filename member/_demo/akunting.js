// Demo only: fake replies for the Akunting views (js/owner-akunting.js), a small in-memory ledger
// built on the sample orders. Returns undefined for anything else. Hooked into owner-lib.js.
import { data } from './sample-data.js';

const CHART = [
  ['1-1100', 'Kas laci', 'aset', 'debit', 1], ['1-1200', 'Kas QRIS (GoPay Merchant)', 'aset', 'debit', 1], ['1-1300', 'Bank', 'aset', 'debit', 1],
  ['1-1400', 'Piutang platform pesan-antar', 'aset', 'debit', 1], ['1-1500', 'Persediaan bahan (choux, vla, kemasan)', 'aset', 'debit', 1],
  ['2-1100', 'Hutang usaha (pemasok)', 'kewajiban', 'kredit', 1], ['2-1200', 'Hutang komisi', 'kewajiban', 'kredit', 1], ['2-1300', 'Hutang lain-lain', 'kewajiban', 'kredit', 0],
  ['3-1100', 'Modal pemilik', 'ekuitas', 'kredit', 1], ['3-1200', 'Prive / setor ke pemilik', 'ekuitas', 'debit', 1],
  ['4-1100', 'Pendapatan penjualan booth', 'pendapatan', 'kredit', 1], ['4-1200', 'Pendapatan pesan-antar', 'pendapatan', 'kredit', 1],
  ['4-1300', 'Pendapatan lain-lain', 'pendapatan', 'kredit', 0], ['4-2000', 'Diskon penjualan', 'pendapatan', 'debit', 1],
  ['5-1100', 'Harga pokok penjualan (HPP)', 'beban', 'debit', 1], ['6-1100', 'Beban komisi', 'beban', 'debit', 1], ['6-2410', 'Beban sampel', 'beban', 'debit', 1],
  ['6-1300', 'Beban promosi', 'beban', 'debit', 1], ['6-1400', 'Beban barang rusak / dibuang', 'beban', 'debit', 1], ['6-1500', 'Selisih kas', 'beban', 'debit', 1],
  ['6-2100', 'Beban sewa', 'beban', 'debit', 0], ['6-2200', 'Beban gaji', 'beban', 'debit', 0], ['6-2300', 'Beban listrik dan air', 'beban', 'debit', 0],
  ['6-2400', 'Beban pemasaran', 'beban', 'debit', 0], ['6-9000', 'Beban lain-lain', 'beban', 'debit', 1],
];
let accounts = null, journals = null, nextId = 1, counters = {};
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const byCode = (c) => accounts.find((a) => a.code === c);

function post(day, description, source, rows, extra = {}) {
  const key = day.slice(2).replace(/-/g, '');
  counters[key] = (counters[key] || 0) + 1;
  const j = { id: nextId++, day, no: `JU-${key}-${pad(counters[key])}`, description, source, source_id: null, reversed_by: null, reverses: null, reason: null, posted_by: source === 'manual' ? 'Glenn' : null,
    created_at: day + 'T10:00:00Z', lines: rows.filter((r) => r[1] || r[2]).map((r) => { const a = byCode(r[0]); return { account_id: a.id, code: a.code, name: a.name, debit: r[1] || 0, credit: r[2] || 0, memo: r[3] || null }; }), ...extra };
  j.amount = j.lines.reduce((t, l) => t + l.debit, 0);
  journals.push(j); return j;
}

function init() {
  if (accounts) return;
  accounts = CHART.map(([code, name, type, normal, system], i) => ({ id: i + 1, code, name, type, normal, parent_id: null, active: true, system: !!system }));
  journals = [];
  const today = ymd(new Date()), first = today.slice(0, 5) + '01-01';
  post(first, 'Modal awal laci dan bank', 'manual', [['1-1100', 500000], ['1-1300', 4500000], ['3-1100', null, 5000000]]);
  post(first, 'Bayar sewa booth', 'manual', [['6-2100', 2500000], ['1-1300', null, 2500000]]);
  const orders = data().orders.filter((o) => o.status === 'dibayar' && o.payment_method);
  orders.forEach((o) => {
    const cash = o.payment_method === 'qris' ? '1-1200' : '1-1100', disc = Math.round(o.total * 0.04), cost = Math.round(o.total * 0.34);
    post(o.day, 'Penjualan ' + o.receipt_no, 'penjualan', [[cash, o.total], ['4-2000', disc], ['4-1100', null, o.total + disc], ['5-1100', cost], ['1-1500', null, cost]]);
  });
  const days = [...new Set(orders.map((o) => o.day))].sort();
  days.filter((_, i) => i % 7 === 3).forEach((d) => post(d, 'Barang masuk Mini Choux dari hanashuya.id', 'pembelian', [['1-1500', 420000], ['2-1100', null, 420000]]));
  days.filter((_, i) => i % 5 === 1).forEach((d) => post(d, 'Sampel (harga pokok)', 'stok', [['6-2410', 18000], ['1-1500', null, 18000]]));
  if (days.length > 3) post(days[2], 'Setor ke pemilik: setoran mingguan', 'kas', [['3-1200', 300000], ['1-1100', null, 300000]]);
}

const sumLines = (acc, from, to) => {
  let d = 0, k = 0;
  journals.forEach((j) => { if ((from && j.day < from) || (to && j.day > to)) return; j.lines.forEach((l) => { if (l.account_id === acc.id) { d += l.debit; k += l.credit; } }); });
  return [d, k];
};
const net = (a, from, to) => { const [d, k] = sumLines(a, from, to); return d - k; };
const day0 = (s) => new Date(s + 'T00:00:00Z');
const before = (s) => { const d = day0(s); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

export function akuntingFake(name, a = {}) {
  if (!name.startsWith('acc_')) return undefined;
  init();
  switch (name) {
    case 'acc_sync': return { from: '2000-01-01', to: ymd(new Date()), result: { tetap: journals.length }, changed: 0 };
    case 'acc_accounts': return accounts.map((x) => ({ ...x, used: journals.reduce((t, j) => t + j.lines.filter((l) => l.account_id === x.id).length, 0), balance: (x.normal === 'debit' ? 1 : -1) * net(x) }));
    case 'acc_save_account': {
      const p = a.p || {};
      if (!a.p_id) {
        if (!/^[0-9]-[0-9]{4}$/.test(p.code || '')) throw new Error('Kode akun seperti 6-2500: satu angka, tanda minus, empat angka.');
        if (accounts.some((x) => x.code === p.code)) throw new Error(`Kode ${p.code} sudah dipakai.`);
        const n = { id: accounts.length + 1, code: p.code, name: p.name, type: p.type, normal: p.normal || (['aset', 'beban'].includes(p.type) ? 'debit' : 'kredit'), parent_id: null, active: true, system: false };
        accounts.push(n); return { id: n.id };
      }
      const x = accounts.find((y) => y.id === a.p_id); x.name = p.name; if (p.active != null) x.active = p.active; if (p.code && !x.system) x.code = p.code; return { id: x.id };
    }
    case 'acc_delete_account': accounts = accounts.filter((x) => x.id !== a.p_id); return { deleted: true };
    case 'acc_journals': {
      const q = (a.p_q || '').toLowerCase();
      return journals.filter((j) => j.day >= a.p_from && j.day <= a.p_to && (!a.p_source || j.source === a.p_source) && (!q || (j.no + j.description).toLowerCase().includes(q)))
        .sort((x, y) => (y.day + y.no).localeCompare(x.day + x.no));
    }
    case 'acc_post_manual': {
      const rows = a.p_lines.map((l) => [accounts.find((x) => x.id === l.account_id).code, l.debit, l.credit]);
      const d = rows.reduce((t, r) => t + (r[1] || 0), 0), k = rows.reduce((t, r) => t + (r[2] || 0), 0);
      if (d !== k) throw new Error(`Jurnal tidak seimbang: debit ${d} dan kredit ${k}.`);
      const j = post(a.p_day, a.p_desc, 'manual', rows); return { id: j.id, no: j.no };
    }
    case 'acc_reverse_journal': {
      const o = journals.find((j) => j.id === a.p_id);
      const r = post(ymd(new Date()), `Pembatalan ${o.no}: ${a.p_reason}`, 'manual', o.lines.map((l) => [l.code, l.credit, l.debit]), { reverses: o.id, reason: a.p_reason });
      o.reversed_by = r.id; return { id: r.id, no: r.no };
    }
    case 'acc_ledger': {
      const x = accounts.find((y) => y.id === a.p_account), sg = x.normal === 'debit' ? 1 : -1;
      let bal = sg * net(x, null, before(a.p_from)), dt = 0, kt = 0;
      const rows = [];
      journals.filter((j) => j.day >= a.p_from && j.day <= a.p_to).sort((p, q) => (p.day + p.id).localeCompare(q.day + q.id)).forEach((j) => j.lines.filter((l) => l.account_id === x.id).forEach((l) => {
        bal += sg * (l.debit - l.credit); dt += l.debit; kt += l.credit; rows.push({ journal_id: j.id, day: j.day, no: j.no, description: j.description, memo: l.memo, debit: l.debit, credit: l.credit, balance: bal }); }));
      return { account: { id: x.id, code: x.code, name: x.name, type: x.type, normal: x.normal }, from: a.p_from, to: a.p_to, opening: sg * net(x, null, before(a.p_from)), rows, debit_total: dt, credit_total: kt, closing: bal };
    }
    case 'acc_trial': {
      const rows = accounts.map((x) => { const opening = net(x, null, before(a.p_from)), [debit, credit] = sumLines(x, a.p_from, a.p_to), closing = opening + debit - credit;
        return { id: x.id, code: x.code, name: x.name, type: x.type, opening, debit, credit, closing, closing_debit: Math.max(closing, 0), closing_credit: Math.max(-closing, 0) }; })
        .filter((r) => r.opening || r.debit || r.credit);
      const s = (k) => rows.reduce((t, r) => t + r[k], 0);
      return { from: a.p_from, to: a.p_to, rows, total_debit: s('debit'), total_credit: s('credit'), closing_debit: s('closing_debit'), closing_credit: s('closing_credit'), balanced: s('closing') === 0 };
    }
    case 'acc_pnl': {
      const f = accounts.filter((x) => ['pendapatan', 'beban'].includes(x.type)).map((x) => ({ x, v: net(x, a.p_from, a.p_to) * (x.type === 'pendapatan' ? -1 : 1) })).filter((r) => r.v)
        .map((r) => ({ id: r.x.id, code: r.x.code, name: r.x.name, amount: r.v, grp: r.x.type === 'pendapatan' ? 'pendapatan' : r.x.code[0] === '5' ? 'hpp' : 'beban' }));
      const sum = (g) => f.filter((r) => r.grp === g).reduce((t, r) => t + r.amount, 0), pick = (g) => f.filter((r) => r.grp === g);
      return { from: a.p_from, to: a.p_to, pendapatan: pick('pendapatan'), hpp: pick('hpp'), beban: pick('beban'), revenue: sum('pendapatan'), hpp_total: sum('hpp'), gross_profit: sum('pendapatan') - sum('hpp'), expenses: sum('beban'), net_profit: sum('pendapatan') - sum('hpp') - sum('beban') };
    }
    case 'acc_balance_sheet': {
      const list = (t, sg) => accounts.filter((x) => x.type === t).map((x) => ({ id: x.id, code: x.code, name: x.name, amount: sg * net(x, null, a.p_at) })).filter((r) => r.amount);
      const aset = list('aset', 1), kewajiban = list('kewajiban', -1), ekuitas = list('ekuitas', -1);
      const profit = -accounts.filter((x) => ['pendapatan', 'beban'].includes(x.type)).reduce((t, x) => t + net(x, null, a.p_at), 0);
      const s = (l) => l.reduce((t, r) => t + r.amount, 0);
      return { at: a.p_at, aset, kewajiban, ekuitas, profit, total_aset: s(aset), total_kewajiban: s(kewajiban), total_ekuitas: s(ekuitas) + profit, balanced: s(aset) === s(kewajiban) + s(ekuitas) + profit };
    }
    default: return undefined;
  }
}
