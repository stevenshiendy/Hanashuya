// Demo replies for Member > Analitik member (sample data, untracked, skipped by the build).
const G = [['baru', 88, 1.0, 71000, 58, 62, 'perempuan', '17-24', 52], ['aktif', 74, 3.1, 98000, 0, 49, '', '25-34', 46], ['setia', 38, 7.2, 124000, 0, 24, '', '25-34', 30],
  ['mulai_hilang', 47, 2.4, 88000, 14, 34, '', '25-34', 26], ['hilang', 41, 1.6, 64000, 9, 28, '', '17-24', 10]];
const NAMES = ['Member contoh 1', 'Member contoh 2', 'Member contoh 3', 'Member contoh 4', 'Member contoh 5'];
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();

export function insightsFake(name, args) {
  if (name === 'owner_member_groups') {
    const days = args.p_days || 30, k = days / 30;
    return { days, total: 288,
      groups: G.map(([key, n, va, pr, wo, f, , age, wa]) => ({ key, n, visits_avg: va, per_receipt: pr, spent: n * pr * va, welcome_open: wo, female: f, gender_known: Math.round(n * 0.95), top_age: age, wa })),
      actions: [['diskon_50', 14, 9], ['satu_stempel', 19, 12], ['baru_belum_kembali', 31, 18], ['ulang_tahun', 8, 6], ['mulai_hilang', 47, 26], ['hilang', 41, 10]].map(([key, n, wa]) => ({ key, n, wa })),
      moves: [['belum', 'baru', 70], ['belum', 'aktif', 14], ['belum', 'setia', 0], ['baru', 'aktif', 31], ['baru', 'baru', 4], ['baru', 'setia', 2], ['baru', 'mulai_hilang', 9],
        ['aktif', 'aktif', 50], ['aktif', 'setia', 6], ['aktif', 'mulai_hilang', 12], ['setia', 'setia', 30], ['setia', 'mulai_hilang', 3],
        ['mulai_hilang', 'aktif', 7], ['mulai_hilang', 'setia', 1], ['mulai_hilang', 'mulai_hilang', 23], ['mulai_hilang', 'hilang', 14],
        ['hilang', 'aktif', 2], ['hilang', 'hilang', 27]].map(([from, to, n]) => ({ from, to, n: Math.max(0, Math.round(n * Math.min(k, 1.4))) })) };
  }
  if (name === 'owner_member_action_list') {
    const note = { diskon_50: 'Berakhir 19/11', satu_stempel: 'Diskon 10%', baru_belum_kembali: 'Daftar 02/11', ulang_tahun: 'Ulang tahun 22/11' }[args.p_key] || null;
    return { hidden: 3, rows: NAMES.slice(0, 4).map((nm, i) => ({ id: 'demo-' + i, name: nm, whatsapp: '62815000000' + i, visits: 6 - i, spent: 412000 - i * 80000,
      last_visit: iso(33 + i * 5), joined: iso(90), position: 7 - i * 2, note })) };
  }
  if (name === 'owner_member_overview') {
    const heat = [];
    for (let d = 1; d <= 7; d++) for (let h = 8; h <= 20; h++) heat.push({ dow: d, hour: h, n: Math.max(0, (h >= 15 && h <= 17 ? 4 : h >= 11 && h <= 13 ? 3 : 1) + (d >= 6 ? 2 : d === 5 ? 1 : 0) + ((d * 5 + h) % 2)) });
    const mon = new Date(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    return { total: 288, new: 88, active: 112, visited: 288, repeat: 118, gap_days: 9, wa: 164,
      member_orders: 71, member_revenue: 6840000, other_orders: 158, other_revenue: 10744000,
      weeks: [6, 9, 7, 12, 17, 21, 22, 28].map((n, i) => ({ week: new Date(mon - (7 - i) * 7 * 864e5).toISOString().slice(0, 10), n })),
      source: { qr: 51, tablet: 29, voucher: 8 },
      visits: { v1: 288, v2: 118, v3: 63, v5: 26 },
      stamps: { s0: 89, s1: 98, s3: 49, s7: 4, full: 2 },
      vouchers: { welcome: { used: 184, given: 288 }, birthday: { used: 9, given: 18 }, reward: { used: 37, given: 52 }, code: { used: 15, given: 17 } },
      heatmap: heat.filter((c) => c.n),
      products: [{ name: 'Signature 1 pcs', flavour: 'Vanilla', member_qty: 96, qty: 234 }, { name: 'Mini Box isi 8', flavour: 'Choco', member_qty: 38, qty: 73 },
        { name: 'Signature Box isi 6', flavour: 'Matcha', member_qty: 21, qty: 37 }, { name: 'Mini Box isi 15', flavour: 'Matcha Strawberry', member_qty: 12, qty: 25 }],
      gender: [{ key: 'perempuan', n: 196 }, { key: 'laki-laki', n: 78 }, { key: 'tidak_disebut', n: 11 }, { key: 'kosong', n: 3 }],
      age: [{ key: '17-24', n: 89 }, { key: '25-34', n: 109 }, { key: '35-44', n: 55 }, { key: '45+', n: 23 }, { key: 'kosong', n: 12 }],
      age_top: [{ key: '17-24', n: 10 }, { key: '25-34', n: 26 }, { key: '35-44', n: 15 }, { key: '45+', n: 4 }, { key: 'kosong', n: 2 }],
      birthdays: [3, 2, 4, 5, 3, 6, 4, 5, 7, 6, 9, 8].map((n, i) => ({ month: i + 1, n })) };
  }
  return undefined;
}
