// Demo only: ONE shared, deterministic sample data set for every _demo-*.html page.
// ~60 days of Hanashuya history ending today (Asia/Jakarta): staff and their weekly schedule,
// attendance scans, members, paid / cancelled orders with promos and stamps, shifts with drawer
// counts, and stock (goods in, deductions from the recipes, samples, waste, counts).
// A seeded PRNG keeps screenshots stable; the same calendar day always gives the same history.
// Pure JS with no imports, so it also loads in node:  import { data } from './sample-data.js'
// Nothing here talks to Supabase. sample-views.js turns this into the reply of each rpc.

export const TZ = 'Asia/Jakarta';
const DAYS = 60;

/* ------------------------------------------------------------------ small helpers */
const J = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const parts = (d) => { const o = {}; for (const p of J.formatToParts(d)) o[p.type] = p.value; return o; };
export const ymdOf = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
export const minOf = (d) => { const p = parts(d); return Number(p.hour) * 60 + Number(p.minute); };
export const addD = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const dow = (s) => (new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7 + 1; // 1 = Senin ... 7 = Minggu
const pad = (n) => String(n).padStart(2, '0');
export const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export const iso = (day, m, sec = 0) => new Date(`${day}T${hm(m)}:${pad(sec)}+07:00`).toISOString();
const roundUp = (n, k) => Math.ceil(n / k) * k;

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261112);
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const wpick = (arr, w) => { const t = arr.reduce((s, x) => s + w(x), 0); let r = rnd() * t; for (const x of arr) { r -= w(x); if (r < 0) return x; } return arr[arr.length - 1]; };

/* ------------------------------------------------------------------ catalog */
export const FLAVOURS = [{ id: 'vanilla', label: 'Vanilla', surcharge: false }, { id: 'choco', label: 'Choco', surcharge: true },
  { id: 'matcha', label: 'Matcha', surcharge: true }, { id: 'matcha_strawberry', label: 'Matcha Strawberry', surcharge: true }];
const FL = Object.fromEntries(FLAVOURS.map((f) => [f.id, f]));
export const PRODUCTS = {
  sig1: { code: 'sig1', name: 'Signature 1 pcs', price: 20000, box: false, flav: true, sur: 0, cat: 1 },
  sig6: { code: 'sig6', name: 'Signature Box isi 6', price: 120000, box: true, flav: true, sur: 3000, cat: 1 },
  mini15: { code: 'mini15', name: 'Mini Box isi 15', price: 99000, box: true, flav: true, sur: 3000, cat: 2 },
  mini8: { code: 'mini8', name: 'Mini Box isi 8', price: 68000, box: true, flav: true, sur: 3000, cat: 2 },
  bag: { code: 'bag', name: 'Paper bag', price: 5000, box: false, flav: false, sur: 0, cat: 3 },
};
export const CATEGORIES = { 1: 'Signature', 2: 'Mini Choux', 3: 'Lainnya', 4: 'Pistachoux' };

// Stock items (task 15) with unit costs from the COGS workbook (pos stock.sql).
export const STOCK_ITEMS = [
  { id: 1, code: 'mini', name: 'Mini Choux', unit: 'pcs', cost: 726, low: null, zero: true },
  { id: 2, code: 'sig', name: 'Signature Choux', unit: 'pcs', cost: 1940, low: null, zero: true },
  { id: 3, code: 'vla_vanilla', name: 'Vla Vanilla', unit: 'g', cost: 85, low: 1000, zero: false },
  { id: 4, code: 'vla_choco', name: 'Vla Chocolate', unit: 'g', cost: 85, low: 1000, zero: false },
  { id: 5, code: 'jam_strawberry', name: 'Selai strawberry', unit: 'g', cost: 0, low: 200, zero: false },
  { id: 6, code: 'vla_matcha', name: 'Vla Matcha', unit: 'g', cost: 85, low: 1000, zero: false },
  { id: 7, code: 'dus_besar', name: 'Dus besar', unit: 'pcs', cost: 2650, low: 20, zero: false },
  { id: 8, code: 'dus_kecil', name: 'Dus kecil', unit: 'pcs', cost: 1700, low: 20, zero: false },
  { id: 9, code: 'bag', name: 'Paper bag', unit: 'pcs', cost: 6000, low: 20, zero: false },
  { id: 10, code: 'liner_besar', name: 'Paper liner besar', unit: 'pcs', cost: 300, low: 20, zero: false },
  { id: 11, code: 'liner_kecil', name: 'Paper liner kecil', unit: 'pcs', cost: 150, low: 20, zero: false },
  { id: 12, code: 'pouch', name: 'Paper pouch (untuk 1 pcs)', unit: 'pcs', cost: 750, low: 20, zero: false },
];
const COST = Object.fromEntries(STOCK_ITEMS.map((i) => [i.code, i.cost]));
const vlaOf = (fl) => (fl === 'choco' ? 'vla_choco' : fl === 'vanilla' ? 'vla_vanilla' : 'vla_matcha');
// Recipe of one unit of a product (stock item code, qty).
export function recipe(code, flavour) {
  const v = vlaOf(flavour), jam = flavour === 'matcha_strawberry';
  if (code === 'sig1') return [['sig', 1], [v, 35], ['pouch', 1], ...(jam ? [['jam_strawberry', 2]] : [])];
  if (code === 'sig6') return [['sig', 6], [v, 210], ['dus_besar', 1], ['liner_besar', 1], ...(jam ? [['jam_strawberry', 12]] : [])];
  if (code === 'mini15') return [['mini', 15], [v, 225], ['dus_besar', 1], ['liner_besar', 1], ...(jam ? [['jam_strawberry', 30]] : [])];
  if (code === 'mini8') return [['mini', 8], [v, 120], ['dus_kecil', 1], ['liner_kecil', 1], ...(jam ? [['jam_strawberry', 16]] : [])];
  if (code === 'bag') return [['bag', 1]];
  return [];
}
export const unitCost = (code, flavour) => recipe(code, flavour).reduce((s, [c, q]) => s + q * COST[c], 0);

/* ------------------------------------------------------------------ staff and schedule (POSDEVELOPMENT.md task 14) */
export const STAFF = [
  { id: 's-ranny', name: 'Ranny', full_name: 'Ranny Puspita', role: 'staff', whatsapp: '6281200010001', username: 'ranny', bank: 'BCA' },
  { id: 's-fajar', name: 'Fajar', full_name: 'Fajar Nugraha', role: 'staff', whatsapp: '6281200010002', username: 'fajar', bank: 'BCA' },
  { id: 's-kevin', name: 'Kevin', full_name: 'Kevin Santoso', role: 'staff', whatsapp: '6281200010003', username: 'kevin', bank: 'BRI' },
  { id: 's-yuya', name: 'Yuya', full_name: 'Yuya Tanaka', role: 'manager', whatsapp: '6281200010004', username: 'yuya', bank: null },
];
export const MANAGER = { id: 's-manajer', name: 'Manajer', full_name: 'Manajer Uji', role: 'manager', whatsapp: '6281200010005', username: 'manajer' };
export const OWNER = { id: 'o-glenn', name: 'Glenn', full_name: 'Glenn Shiendy', role: 'owner', whatsapp: '6285890120577', username: 'glenn' };
export const SHIFTS = [['Fulltime 1', '08:00', '18:00'], ['Fulltime 2', '11:00', '21:00'], ['Parttime 1', '08:00', '14:00'], ['Parttime 2', '15:00', '21:00']]
  .map(([name, start, end], i) => ({ id: i + 1, name, start, end, break_minutes: 60, active: true }));
const NAMED = Object.fromEntries(SHIFTS.map((s) => [s.start + s.end, s.name]));
const K = (s, e) => ({ kind: 'kerja', start: s, end: e, shift: NAMED[s + e] || null });
const L = { kind: 'libur' }, U = (s, e) => ({ kind: 'kuliah', start: s, end: e });
// Weekday 1..7: Senin ... Minggu, as in the table of task 14.
export const WEEKLY = {
  's-fajar': { 1: [L], 2: [K('11:00', '21:00')], 3: [K('08:00', '18:00')], 4: [K('11:00', '21:00')], 5: [K('08:00', '18:00')], 6: [K('11:00', '21:00')], 7: [K('08:00', '18:00')] },
  's-ranny': { 1: [K('11:00', '21:00')], 2: [K('08:00', '18:00')], 3: [L], 4: [K('11:00', '21:00')], 5: [K('08:00', '18:00')], 6: [K('08:00', '18:00')], 7: [K('11:00', '21:00')] },
  's-yuya': { 1: [K('08:00', '18:00')], 2: [L], 3: [K('11:00', '21:00')], 4: [K('08:00', '18:00')], 5: [K('11:00', '21:00')], 6: [K('11:00', '21:00')], 7: [K('08:00', '18:00')] },
  's-kevin': { 1: [U('08:00', '18:00'), K('18:00', '21:00')], 2: [U('08:00', '12:00'), K('15:00', '21:00')], 3: [K('08:00', '11:00'), U('12:00', '16:00'), K('18:00', '21:00')],
    4: [L], 5: [U('08:00', '11:00'), K('15:00', '21:00')], 6: [K('08:00', '14:00')], 7: [K('15:00', '21:00')] },
};

/* ------------------------------------------------------------------ build */
let memo = null;
export function data() { const d = ymdOf(new Date()); if (!memo || memo.today !== d) memo = build(); return memo; }

function build() {
  const real = new Date();
  const today = ymdOf(real);
  // "Now" of the demo: the real time, kept inside 13.30 to 20.45 so the sample day always has a few orders and an open shift.
  const nowMin = Math.min(Math.max(minOf(real), 13 * 60 + 30), 20 * 60 + 45);
  const nowIso = (nowMin === minOf(real)) ? real.toISOString() : iso(today, nowMin);
  const days = Array.from({ length: DAYS }, (_, i) => addD(today, i - (DAYS - 1)));
  const D = { today, nowMin, nowIso, days, staff: STAFF, manager: MANAGER, owner: OWNER, shiftDefs: SHIFTS };

  /* ---- leave (perizinan) ---- */
  const firstWork = (id, before) => { for (let k = before; k < before + 14; k++) { const d = addD(today, -k); if ((WEEKLY[id][dow(d)] || []).some((b) => b.kind === 'kerja')) return d; } return addD(today, -before); };
  D.leaves = [
    { id: 3, staff_id: 's-ranny', start: firstWork('s-ranny', 5), end: firstWork('s-ranny', 5), reason: 'Wisuda adik di Jatinangor', status: 'disetujui', note: 'Oke, semoga lancar', decided_by: 'Glenn', created_at: iso(addD(today, -20), 600) },
    { id: 2, staff_id: 's-fajar', start: firstWork('s-fajar', 14), end: firstWork('s-fajar', 14), reason: 'Sakit, kabar lewat WhatsApp', status: 'disetujui', decided_by: 'Glenn', created_at: iso(firstWork('s-fajar', 14), 460) },
    { id: 1, staff_id: 's-ranny', start: addD(today, 13), end: addD(today, 14), reason: 'Acara keluarga di Garut', status: 'menunggu', created_at: iso(today, 9 * 60 + 12) },
  ];
  const onLeave = (id, d) => D.leaves.some((l) => l.staff_id === id && l.status === 'disetujui' && d >= l.start && d <= l.end);
  D.oneOff = [{ staff_id: 's-yuya', date: addD(today, 2), kind: 'libur' }];
  D.blocksOf = (id, d) => { const one = D.oneOff.filter((e) => e.staff_id === id && e.date === d); return one.length ? one.map((e) => ({ kind: e.kind })) : (WEEKLY[id][dow(d)] || []); };
  D.onLeave = onLeave;

  /* ---- attendance days (scans) ---- */
  let scanId = 0;
  const att = {}; // att[staff][date] = [dayBlock]
  const special = { missing: [[ 's-kevin', 22 ], [ 's-fajar', 11 ]], overtimeOk: ['s-fajar', 33], overtimePending: ['s-ranny', 6], longBreak: [['s-ranny', 9], ['s-yuya', 17], ['s-fajar', 27]] };
  for (const s of STAFF) {
    att[s.id] = {};
    for (const d of days) {
      if (onLeave(s.id, d)) { att[s.id][d] = [{ date: d, kind: 'izin', flags: [], worked_min: 0, break_min: 0, scans: [] }]; continue; }
      const out = [];
      for (const b of D.blocksOf(s.id, d).filter((x) => x.kind === 'kerja')) {
        const st = mins(b.start), en = mins(b.end), len = en - st, ago = Math.round((Date.parse(today) - Date.parse(d)) / 864e5);
        const r = rnd();
        let late = r < 0.62 ? -ri(0, 7) : r < 0.82 ? ri(0, 6) : r < 0.96 ? ri(11, 24) : ri(28, 40);
        let outM = en + (rnd() < 0.7 ? ri(0, 9) : rnd() < 0.8 ? ri(10, 18) : ri(0, 5));
        const hasBreak = len >= 360;
        let bStart = st + Math.round(len * 0.45 / 15) * 15 + ri(-2, 3) * 5, bLen = hasBreak ? (rnd() < 0.85 ? ri(55, 62) : ri(63, 66)) : 0;
        if (special.longBreak.some(([id, k]) => id === s.id && k === ago)) bLen = 78;
        const missing = special.missing.some(([id, k]) => id === s.id && k === ago);
        if (special.overtimeOk[0] === s.id && ago === special.overtimeOk[1]) outM = en + 25 + 1 - 1 + 4;
        if (special.overtimePending[0] === s.id && ago === special.overtimePending[1]) outM = en + 37;
        const masukM = Math.max(st - 10, st + late);
        const lateMin = Math.max(0, masukM - st);
        const scans = [];
        const add = (action, m, via = 'qr') => { const sec = ri(0, 59); scans.push({ id: ++scanId, action, at: iso(d, Math.min(m, 1439), sec), via, _m: m }); };
        add('masuk', masukM);
        if (hasBreak) { add('istirahat', bStart); add('kembali', bStart + bLen); }
        if (!missing) add('pulang', outM);
        const over = !missing && outM - en >= 20 ? outM - en : 0;
        const flags = [lateMin > 10 ? 'terlambat' : null, bLen > 60 ? 'istirahat_lebih' : null, over ? 'pulang_lewat' : null, missing ? 'tidak_scan_pulang' : null].filter(Boolean);
        out.push({ date: d, kind: 'jadwal', shift: b.shift, start: b.start, end: b.end, masuk_m: masukM, pulang_m: missing ? null : outM, break_start_m: hasBreak ? bStart : null,
          break_end_m: hasBreak ? bStart + bLen : null, worked_min: (missing ? en : outM) - masukM - bLen, break_min: bLen, late_min: lateMin, early_min: 0, overtime_min: over, flags, scans,
          masuk: iso(d, masukM), pulang: missing ? null : iso(d, outM) });
      }
      att[s.id][d] = out;
    }
  }
  // Overtime decisions: Fajar's is approved, Ranny's is waiting.
  D.overtime = [];
  for (const s of STAFF) for (const d of days) for (const b of att[s.id][d]) if (b.overtime_min >= 20 && d !== today) {
    const ago = Math.round((Date.parse(today) - Date.parse(d)) / 864e5);
    D.overtime.push({ staff_id: s.id, name: s.name, date: d, start: b.start, end: b.end, pulang: b.pulang, minutes: b.overtime_min,
      status: ago > 20 ? 'disetujui' : 'menunggu', ...(ago > 20 ? { approved_min: b.overtime_min, decided_by: 'Glenn' } : {}) });
  }
  D.overtime = D.overtime.filter((o) => o.status === 'menunggu' ? o.staff_id === 's-ranny' || o.staff_id === 's-kevin' : true).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  D.att = att;

  // Who is at the booth at minute m of day d (clocked in, not on break).
  const dutyAt = (d, m) => STAFF.filter((s) => (att[s.id][d] || []).some((b) => b.kind === 'jadwal' && b.masuk_m <= m && m <= (b.pulang_m ?? mins(b.end)) && !(b.break_start_m != null && m >= b.break_start_m && m < b.break_end_m)));
  D.dutyAt = dutyAt;

  /* ---- members ---- */
  const nm = ['Tasya Amelia', 'Bima Sakti', 'Sari Wulandari', 'Putri Maharani', 'Dewi Lestari', 'Andika Pratama', 'Nadia Safitri', 'Rizky Ramadhan', 'Ayu Anggraini', 'Fitri Handayani',
    'Agus Setiawan', 'Maya Sari', 'Yoga Prasetyo', 'Citra Dewanti', 'Hendra Gunawan', 'Lia Permata', 'Dimas Anggara', 'Intan Permatasari', 'Eko Saputra', 'Wulan Pertiwi', 'Reza Firmansyah',
    'Sinta Maharani', 'Galih Pamungkas', 'Anisa Rahma', 'Fajri Hidayat', 'Mega Kurniasih', 'Bagas Wicaksono', 'Nanda Kusumawati', 'Tika Rahayu', 'Irfan Maulana', 'Salsa Nabila',
    'Rendi Saputra', 'Yuni Astuti', 'Arif Budiman', 'Dian Puspitasari', 'Kiki Amalia', 'Lutfi Hakim', 'Mita Anjani'];
  const CH = 'ACDEFGHJKLMNPQRTUVWXYZ23456789';
  const code = () => Array.from({ length: 8 }, () => CH[ri(0, CH.length - 1)]).join('');
  const members = [];
  const mk = (o) => { const m = { orders: [], stamps_total: 0, cards_done: 0, ready: [], welcome_used: false, birthday_used: {}, kode: null, gender: null, birth_date: null, marketing: true, last_visit: null, ...o }; members.push(m); return m; };
  mk({ id: 'desi', name: 'Desi Ratnasari', code: 'K7PX3MQ9', joined_day: addD(today, -3), gender: 'perempuan', birth_date: '1995-03-02', scripted: true });
  mk({ id: 'rina', name: 'Rina Kusuma', code: 'H2TB9WQA', joined_day: addD(today, -21), gender: 'perempuan', birth_date: '1998-07-19', scripted: true });
  // Bima has a card and the welcome voucher but has not bought anything yet.
  mk({ id: 'bima', name: 'Bima Sakti', code: 'P9QR2TXZ', joined_day: addD(today, -2), gender: 'laki-laki', birth_date: '2000-01-14', scripted: true });
  const bday = addD(today, 3).slice(5);
  mk({ id: 'tasya', name: 'Tasya Amelia', code: code(), joined_day: addD(today, -9), gender: 'perempuan', birth_date: '1999-' + bday });
  // The one birthday box that was used: birthday 19 days ago, member since before that.
  const bd2 = addD(today, -19).slice(5);
  const others = nm.filter((n) => !['Tasya Amelia', 'Bima Sakti'].includes(n));
  others.forEach((n, i) => {
    const joined = addD(today, -Math.min(58, Math.round(58 - (i + 0.5) / others.length * 56 + (rnd() - 0.5) * 8)));
    mk({ id: 'm' + String(i + 1).padStart(2, '0'), name: n, code: code(), joined_day: joined, gender: rnd() < 0.7 ? 'perempuan' : rnd() < 0.85 ? 'laki-laki' : null,
      birth_date: String(ri(1983, 2008)) + '-' + pad(ri(1, 12)) + '-' + pad(ri(1, 28)), marketing: rnd() < 0.8, w: 0.4 + rnd() * 2.4 });
  });
  members.forEach((m) => { if (m.w == null) m.w = 1; m.phone = '62812' + '0000' + String(1000 + Math.floor(rnd() * 8999)); m.first = m.name.split(' ')[0]; });
  const bdm = members.find((m) => m.id === 'm05'); bdm.birth_date = '1996-' + bd2; bdm.joined_day = addD(today, -52);
  // A few lapsed regulars: they stop coming 35 to 50 days ago.
  for (const id of ['m02', 'm04', 'm06', 'm08']) { const m = members.find((x) => x.id === id); m.stop = addD(today, -ri(35, 49)); if (m.joined_day > m.stop) m.joined_day = addD(m.stop, -ri(8, 15)); }
  // Papaya paper vouchers (4 claimed; 2 used, 1 more is waiting to be used).
  for (const [id, c] of [['m11', 'K3QX-7MPA'], ['m17', 'T8WD-2NRF'], ['m21', 'J6HB-9LCE'], ['m26', 'V4ZK-5SYG']]) { const m = members.find((x) => x.id === id); if (m.joined_day > addD(today, -5)) m.joined_day = addD(today, -20 - ri(0, 20)); m.kode = { code: c, used: false }; }
  members.forEach((m) => { m.joined_at = iso(m.joined_day, ri(10 * 60, 19 * 60)); });
  D.members = members;

  /* ---- orders ---- */
  const HOURW = [.4, .5, .8, 1.2, 1.6, 1.4, 1.0, 1.0, 1.5, 1.7, 1.6, 1.9, 1.6]; // 08..20
  const DOWF = { 1: 0.95, 2: 0.9, 3: 0.68, 4: 0.9, 5: 1.12, 6: 1.3, 7: 1.5 };
  const BASKETS = [
    [[['sig1', 1]], 3], [[['sig1', 2]], 14], [[['sig1', 3]], 6], [[['mini8', 1]], 36], [[['mini15', 1]], 12], [[['sig6', 1]], 5], [[['mini8', 2]], 2],
    [[['mini15', 1], ['sig1', 1]], 2], [[['mini8', 1], ['sig1', 1]], 8], [[['sig6', 1], ['sig1', 1]], 0.5], [[['mini15', 2]], 0.5], [[['mini15', 1], ['mini8', 1]], 0.5], [[['sig6', 1], ['mini8', 1]], 0.5],
  ];
  const FLW = { vanilla: 45, choco: 25, matcha: 18, matcha_strawberry: 12 };
  const flav = () => wpick(Object.keys(FLW), (k) => FLW[k]);
  const makeItems = (basket) => basket.map(([code, qty]) => ({ code, qty, flavour: PRODUCTS[code].flav ? flav() : null }));
  const mkLines = (items, freeBags) => {
    const lines = []; let n = 0, boxes = 0;
    for (const it of items) {
      const p = PRODUCTS[it.code], fl = it.flavour, sur = fl && FL[fl].surcharge ? p.sur : 0, unit = p.price + sur;
      lines.push({ line: ++n, code: p.code, name: p.name, flavour: fl, flavour_label: fl ? FL[fl].label : null, qty: it.qty, unit_price: unit, surcharge: sur, line_total: unit * it.qty, discount: 0, free_bag: false, is_box: p.box });
      if (p.box) boxes += it.qty;
    }
    const bags = Math.min(freeBags, Math.floor(boxes / 2));
    if (bags > 0) lines.push({ line: ++n, code: 'bag', name: 'Paper bag', flavour: null, flavour_label: null, qty: bags, unit_price: 0, surcharge: 0, line_total: 0, discount: 0, free_bag: true, is_box: false });
    return lines;
  };
  const goodsOf = (lines) => lines.filter((l) => l.code !== 'bag').reduce((s, l) => s + l.line_total, 0);
  const PROMO_LABEL = { 3: 'Diskon 10%', 7: 'Diskon 20%', 10: 'Gratis 1 produk' };
  const applyUnit = (lines, code, pct) => { const l = lines.find((x) => x.code === code && !x.free_bag) || lines.find((x) => x.code !== 'bag'); l.discount = Math.floor(l.unit_price * pct / 100); return l.discount; };
  const applyAll = (lines, pct, only) => { let t = 0; for (const l of lines) { if (l.code === 'bag' || (only && !only.includes(l.code))) continue; l.discount = Math.floor(l.line_total * pct / 100); t += l.discount; } return t; };

  const orders = [];
  let oid = 0;
  const memberOrders = (m) => orders.filter((o) => o.member_id === m.id && o.status === 'dibayar');
  const earn = (m, o) => { // stamps and card rewards
    let pos = m.stamps_total % 10; const n = Math.floor(o.total / 50000);
    for (let i = 0; i < n; i++) {
      pos++; m.stamps_total++;
      if ([3, 7, 10].includes(pos)) m.ready.push({ cycle: m.cards_done + 1, slot: pos, label: PROMO_LABEL[pos] });
      if (pos === 10) { m.cards_done++; pos = 0; }
    }
    o.stamps = n;
  };
  const claimWelcome = (m, day) => !m.welcome_used && Math.round((Date.parse(day) - Date.parse(m.joined_day)) / 864e5) <= 30;

  const scriptedToday = [];
  for (const day of days) {
    const wd = dow(day), isToday = day === today;
    let n = Math.round(5.5 / 1.1 * DOWF[wd] + (rnd() + rnd() + rnd() - 1.5) * 2.2);
    n = Math.max(2, Math.min(n, 14));
    if (isToday) n = Math.max(n, 10);
    const slots = []; // minutes
    for (let i = 0; i < n; i++) { const h = 8 + wpickIdx(HOURW); slots.push(Math.min(h * 60 + ri(0, 59), 20 * 60 + 55)); }
    slots.sort((a, b) => a - b);
    const todays = []; // [minute, forced member]
    const signups0 = day === addD(today, -17) ? [] : [];
    const signups = members.filter((m) => m.joined_day === day && !m.scripted);
    const forced = {};
    if (day === addD(today, -17)) forced[ri(0, slots.length - 1)] = members.find((x) => x.id === 'm05');
    signups.forEach((m) => { if (rnd() < 0.85) forced[ri(0, slots.length - 1)] = m; });
    // Scripted visits keep the till demo cards as they are (Desi: 2 stamps, Rina: 3 stamps + reward ready).
    const script = [];
    if (day === addD(today, -3)) script.push({ id: 'desi', basket: [['sig6', 1, 'matcha']], min: 15 * 60 + 40, noPromo: true });
    if (day === addD(today, -21)) script.push({ id: 'rina', basket: [['mini15', 1, 'vanilla'], ['sig1', 1, 'vanilla']], min: 13 * 60 + 10, noPromo: true });
    if (day === addD(today, -12)) script.push({ id: 'rina', basket: [['mini8', 1, 'choco']], min: 17 * 60 + 5, noPromo: true });
    if (isToday) script.push({ id: 'rina', basket: [['sig1', 2, 'choco']], min: 10 * 60 + 20, noPromo: true, voidPending: true });

    const todayOrders = [];
    slots.forEach((m, i) => todayOrders.push({ m, member: forced[i] || null }));
    script.forEach((s) => todayOrders.push({ m: s.min, member: members.find((x) => x.id === s.id), script: s }));
    todayOrders.sort((a, b) => a.m - b.m);
    let seq = 0;
    for (const t of todayOrders) {
      if (isToday && t.m > nowMin - 9) continue; // later orders do not exist yet
      const m = pickMember(t, day);
      const sold = iso(day, t.m, ri(0, 59));
      let items, boxesTaken = rnd() < 0.85;
      if (t.script) items = t.script.basket.map(([c, q, f]) => ({ code: c, qty: q, flavour: f }));
      else items = makeItems(wpick(BASKETS, (b) => b[1])[0]);
      if (!t.script && rnd() < 0.04) items.push({ code: 'bag', qty: 1, flavour: null });
      let promo = null;
      let lines;
      const hour = t.m / 60;
      // 1) a card promo (one per order)
      if (m && !t.script) {
        const ready = m.ready[0], bhit = m.id === 'm05' && day === addD(today, -17) && !m.birthday_used[2026];
        if (!bhit && ready && rnd() < 0.85) {
          lines = mkLines(items, boxesTaken ? 99 : 0);
          const d = ready.slot === 10 ? applyUnit(lines, 'sig1', 100) : applyAll(lines, ready.slot === 3 ? 10 : 20);
          promo = { kind: 'stempel', label: ready.label, discount: d, cycle: ready.cycle, slot: ready.slot }; m.ready.shift();
        } else if (!bhit && claimWelcome(m, day) && rnd() < 0.25 && m.id !== 'bima') {
          lines = mkLines(items, boxesTaken ? 99 : 0);
          const d = applyUnit(lines, items[0].code, 50); promo = { kind: 'welcome', label: 'Diskon 50% member baru', discount: d }; m.welcome_used = true;
        } else if (bhit) {
          if (!items.some((i) => i.code === 'mini8')) items.unshift({ code: 'mini8', qty: 1, flavour: flav() });
          lines = mkLines(items, boxesTaken ? 99 : 0);
          const d = applyUnit(lines, 'mini8', 100); promo = { kind: 'ulang_tahun', label: 'Hadiah ulang tahun', discount: d }; m.birthday_used[2026] = true;
        } else if (m.kode && !m.kode.used && rnd() < 0.5 && (m.id === 'm11' || m.id === 'm17')) {
          if (!items.some((i) => i.code === 'sig1')) items.push({ code: 'sig1', qty: 1, flavour: flav() });
          lines = mkLines(items, boxesTaken ? 99 : 0);
          const d = applyUnit(lines, 'sig1', 100); promo = { kind: 'kode', label: 'Voucher Papaya', discount: d }; m.kode.used = true;
        }
      }
      if (!lines) lines = mkLines(items, boxesTaken ? 99 : 0);
      // 2) an owner promo on weekends (everyone) or the member promo in the afternoon
      if (!promo && !t.script) {
        if ((wd === 6 || wd === 7) && lines.some((l) => ['mini15', 'mini8'].includes(l.code)) && rnd() < 0.55) {
          const d = applyAll(lines, 10, ['mini15', 'mini8']); if (d) promo = { kind: 'promo', label: 'Diskon Akhir Pekan', discount: d, promo_id: 1 };
        } else if (m && hour >= 13 && hour < 17 && goodsOf(lines) >= 100000 && rnd() < 0.3) {
          let left = 15000, d = 0; for (const l of lines) { if (l.code === 'bag' || left <= 0) continue; const x = Math.min(left, l.line_total); l.discount = x; left -= x; d += x; }
          promo = { kind: 'promo', label: 'Member Potong 15rb', discount: d, promo_id: 2 };
        }
      }
      const subtotal = lines.reduce((s, l) => s + l.line_total, 0), discount = lines.reduce((s, l) => s + l.discount, 0), total = subtotal - discount;
      const on = dutyAt(day, t.m), pool = on.length ? on : [STAFF[3]];
      const served = wpick(pool, (s) => (s.id === 's-ranny' || s.id === 's-fajar' ? 3 : 1));
      const cashier = pool[0].id === served.id || rnd() < 0.5 ? served : pool[0];
      const method = total === 0 ? 'gratis' : rnd() < 0.15 ? 'tunai' : 'qris';
      const o = { id: 'o' + (++oid), day, sold_at: sold, sold_m: t.m, status: 'dibayar', lines, subtotal, discount, total, promo, promo_label: promo ? promo.label : null,
        promo_kind: promo ? promo.kind : null, payment_method: method, cash_received: null, change: null, member_id: m ? m.id : null, served_by: served.id, cashier_id: cashier.id,
        stamps: 0, via: m ? (rnd() < 0.8 ? 'qr' : 'nomor') : null, flags: [], void: null };
      if (method === 'tunai') {
        const r = rnd(); o.cash_received = r < 0.25 ? total : r < 0.65 ? roundUp(total, 50000) : r < 0.92 ? roundUp(total + 1, 100000) : roundUp(total, 10000);
        if (o.cash_received < total) o.cash_received = roundUp(total, 50000);
        o.change = o.cash_received - total;
      }
      // cancelled / refunded (about 1 in 60, never member or promo orders)
      const wantVoid = !m && !promo && !t.script && (rnd() < 1 / 60);
      if (wantVoid) voidOrder(o, rnd() < 0.7 ? 'batal' : 'refund', day, t.m);
      if (t.script && t.script.voidPending) o.void = { kind: 'batal', reason: 'Salah input rasa', status: 'menunggu', requested_by: 'Ranny', created_at: iso(day, t.m + 8), decided_by: null, decided_at: null };
      if (o.status === 'dibayar' && m) { earn(m, o); m.orders.push(o.id); m.last_visit = o.sold_at; }
      orders.push(o); todays.push(o);
    }
    // number the day's receipts
    todays.sort((a, b) => a.sold_m - b.sold_m);
    todays.forEach((o, i) => { o.receipt_no = `HS-${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-${String(i + 1).padStart(4, '0')}`; });
    if (isToday) {
      // today: one cancelled order (decided by the manager) and one still waiting for payment
      const first = todays.find((o) => !o.member_id && !o.void && o.status === 'dibayar');
      if (first && todays.length >= 5) voidOrder(first, 'batal', day, first.sold_m);
      const m = nowMin - ri(3, 6);
      const items = makeItems([['mini8', 1], ['sig1', 1]]);
      const lines = mkLines(items, 0), sub = lines.reduce((s, l) => s + l.line_total, 0);
      const on = dutyAt(day, m), pool = on.length ? on : [STAFF[0]];
      const waiting = { id: 'o' + (++oid), day, sold_at: iso(day, m, 14), sold_m: m, status: 'menunggu', lines, subtotal: sub, discount: 0, total: sub, promo: null, promo_label: null, promo_kind: null,
        payment_method: null, cash_received: null, change: null, member_id: null, served_by: pool[0].id, cashier_id: pool[0].id, stamps: 0, via: null, flags: [], void: null,
        receipt_no: `HS-${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}-${String(todays.length + 1).padStart(4, '0')}` };
      orders.push(waiting); todays.push(waiting);
    }
  }
  function wpickIdx(w) { let t = w.reduce((s, x) => s + x, 0), r = rnd() * t; for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return i; } return w.length - 1; }
  function pickMember(t, day) {
    if (t.member) return t.member;
    const elig = members.filter((m) => !m.scripted && m.joined_day < day && (!m.stop || day <= m.stop));
    const k = Math.min(1, elig.length / 12);
    if (!elig.length || rnd() > 0.33 * k) return null;
    return wpick(elig, (m) => m.w * (m.ready.length ? 1.6 : 1));
  }
  function voidOrder(o, kind, day, m) {
    const reasons = kind === 'refund' ? ['Choux penyok, pelanggan minta uang kembali', 'Rasa tidak sesuai pesanan, pelanggan minta pengembalian'] : ['Salah input rasa', 'Pelanggan batal setelah bayar', 'Salah hitung pesanan', 'Uang kurang, pelanggan tidak jadi'];
    o.status = kind; o.stamps = 0;
    const by = STAFF.find((s) => s.id === o.served_by).name;
    o.void = { kind, reason: pick(reasons), status: 'disetujui', requested_by: by, created_at: iso(day, m + 6), decided_by: rnd() < 0.7 ? 'Manajer' : 'Yuya', decided_at: iso(day, m + ri(12, 40)) };
  }
  orders.sort((a, b) => a.sold_at.localeCompare(b.sold_at));
  D.orders = orders;
  D.paid = orders.filter((o) => o.status === 'dibayar');
  // cost of every order from the recipes
  for (const o of orders) for (const l of o.lines) l.cost = Math.round(l.qty * unitCost(l.code, l.flavour));
  orders.forEach((o) => { o.cost = o.lines.reduce((s, l) => s + l.cost, 0); });

  /* ---- member state for the apps ---- */
  for (const m of members) {
    const mine = orders.filter((o) => o.member_id === m.id && o.status === 'dibayar');
    m.visits = mine.length; m.spent = mine.reduce((s, o) => s + o.total, 0); m.position = m.stamps_total % 10;
    m.vouchers = [];
    const age = Math.round((Date.parse(today) - Date.parse(m.joined_day)) / 864e5);
    if (!m.welcome_used && age <= 30) m.vouchers.push({ kind: 'welcome', period: 0, title: 'Hadiah member baru', label: 'Diskon 50% untuk 1 produk', ends_on: addD(m.joined_day, 30), pos_code: 'NEWMEMBER50', status: 'tersedia' });
    if (m.id === 'tasya') m.vouchers.push({ kind: 'ulang_tahun', period: 2026, title: 'Hadiah ulang tahun', label: '1 Mini Box isi 8 gratis', ends_on: addD(today, 10), pos_code: 'BIRTHDAYGIFT', status: 'tersedia' });
    if (m.kode && !m.kode.used) m.vouchers.push({ kind: 'kode', period: 41, title: 'Voucher Papaya ' + m.kode.code, label: '1 Signature choux gratis', ends_on: '2027-01-31', pos_code: 'MANIS', status: 'tersedia' });
  }
  D.byId = Object.fromEntries(members.map((m) => [m.id, m]));
  D.orderById = Object.fromEntries(orders.map((o) => [o.id, o]));

  /* ---- shifts: one per day, back to back, closed nightly around 21.00 ---- */
  const shifts = [];
  let prevCounted = 200000, prevSetor = 0, prevCloser = STAFF[0], prevCloseIso = iso(addD(days[0], -1), 21 * 60 + 3), firstId = 1;
  days.forEach((day, i) => {
    const isToday = day === today;
    const orders_ = orders.filter((o) => o.day === day);
    const paid = orders_.filter((o) => o.status === 'dibayar');
    const tunai = paid.filter((o) => o.payment_method === 'tunai').reduce((s, o) => s + o.total, 0);
    const qris = paid.filter((o) => o.payment_method === 'qris').reduce((s, o) => s + o.total, 0);
    const opening = i === 0 ? 200000 : prevCounted; // back to back: modal = last count
    const floatSource = opening === 200000 ? 'standar' : 'bawaan';
    const moves = [];
    if (rnd() < 0.35) moves.push({ kind: 'keluar', amount: pick([10000, 15000, 15000, 20000]), reason: pick(['Beli es batu', 'Beli es batu', 'Beli tisu dan plastik', 'Ongkos ojek ambil dus']), at: iso(day, ri(12 * 60, 17 * 60)), by: pick(STAFF.slice(0, 2)).name });
    if (rnd() < 0.15) moves.push({ kind: 'masuk', amount: 50000, reason: 'Tambah uang kecil', at: iso(day, ri(9 * 60, 11 * 60)), by: pick(STAFF.slice(0, 2)).name });
    const cin = moves.filter((m) => m.kind === 'masuk').reduce((s, m) => s + m.amount, 0), cout = moves.filter((m) => m.kind === 'keluar').reduce((s, m) => s + m.amount, 0);
    const closeM = 21 * 60 + ri(0, 8), closeP = dutyAt(day, 20 * 60 + 45), closer = (closeP.filter((x) => x.id === 's-ranny' || x.id === 's-fajar')[0] || closeP.slice(-1)[0] || STAFF[3]);
    const sh = { id: firstId + i, day, opened_at: prevCloseIso, opened_by: prevCloser, closed_at: isToday ? null : iso(day, closeM), closed_by: isToday ? null : closer, device: 'Tablet kasir 7F2C',
      orders: paid.length, sales_total: tunai + qris, qris, tunai, voided: orders_.filter((o) => ['batal', 'refund'].includes(o.status)).length, opening_cash: opening, float_source: floatSource,
      moves, cash_in: cin, cash_out: cout, setor: 0, cash_received: paid.filter((o) => o.payment_method === 'tunai').reduce((s, o) => s + o.cash_received, 0),
      change_given: paid.filter((o) => o.payment_method === 'tunai').reduce((s, o) => s + o.change, 0), counted_cash: null, difference: null, flags: [], note: null, denominations: null,
      printed_at: null, reprints: 0 };
    sh.expected_cash = opening + tunai + cin - cout;
    if (!isToday) {
      let diff = 0; const r = rnd();
      if (r > 0.7 && r <= 0.97) diff = pick([-1000, 1000, -2000, 2000, -3000, -5000, 1000]);
      if (i === days.length - 2) { diff = -12000; sh.note = 'Kembalian kurang Rp12.000 di sore hari, kemungkinan salah hitung uang kembalian. Sudah dicek ulang dua kali.'; }
      let counted = sh.expected_cash + diff;
      let setor = 0;
      if (counted - 200000 >= 400000 + (i % 5) * 30000) { setor = Math.floor((counted - 200000) / 1000) * 1000; sh.moves.push({ kind: 'setor', amount: setor, reason: 'Setor ke Glenn', at: iso(day, closeM - 4), by: 'Manajer' }); sh.setor = setor; }
      sh.expected_cash = opening + tunai + cin - cout - setor;
      counted = sh.expected_cash + diff;
      sh.counted_cash = counted; sh.difference = diff; sh.flags = Math.abs(diff) > 10000 ? ['selisih_kas'] : [];
      sh.denominations = split(counted);
      sh.printed_at = iso(day, closeM + 3); sh.reprints = i === days.length - 2 ? 1 : 0;
      prevCounted = counted; prevSetor = 0; prevCloser = closer; prevCloseIso = sh.closed_at;
    }
    shifts.push(sh);
    orders_.forEach((o) => { o.shift_id = sh.id; });
  });
  D.shifts = shifts;
  D.cashFloat = 200000; D.cashFlagAt = 10000;

  buildStock(D);
  return D;
}

// Break an amount of rupiah into the notes the staff counted (multiples of Rp1.000).
function split(total) {
  const out = { 100000: 0, 50000: 0, 20000: 0, 10000: 0, 5000: 0, 2000: 0, 1000: 0, koin: 0 };
  let left = total;
  const take = (v, max) => { const n = Math.min(max, Math.floor(left / v)); out[v] = n; left -= n * v; };
  take(100000, 2 + (total % 3)); take(50000, 3); take(20000, 4); take(10000, 5); take(5000, 4); take(2000, 6); take(1000, 99);
  if (left) { out.koin = left; }
  // anything still above the small notes goes to Rp100.000
  return out;
}

/* ------------------------------------------------------------------ stock */
function buildStock(D) {
  const { days, today, orders } = D;
  const ids = Object.fromEntries(STOCK_ITEMS.map((i) => [i.code, i]));
  const qty = { mini: 0, sig: 0, vla_vanilla: 3400, vla_choco: 1700, jam_strawberry: 450, vla_matcha: 1500, dus_besar: 52, dus_kecil: 40, bag: 66, liner_besar: 48, liner_kecil: 50, pouch: 70 };
  const DELIV = { vla_vanilla: 5000, vla_choco: 2000, vla_matcha: 2000, jam_strawberry: 600, dus_besar: 100, dus_kecil: 100, bag: 100, liner_besar: 100, liner_kecil: 100, pouch: 100 };
  const REORDER = { vla_vanilla: 1100, vla_choco: 800, vla_matcha: 800, jam_strawberry: 150, dus_besar: 16, dus_kecil: 16, bag: 18, liner_besar: 16, liner_kecil: 16, pouch: 18 };
  const moves = []; // {day, at, item, kind, qty (+in / -out), reason, by}
  const goodsIn = []; const counts = []; const requests = [];
  let gid = 0, cid = 0, rid = 0;
  const firstDuty = (d) => { const f = STAFF.filter((s) => (D.att[s.id][d] || []).some((b) => b.kind === 'jadwal')).sort((a, b) => D.att[a.id][d][0].masuk_m - D.att[b.id][d][0].masuk_m)[0]; return f || STAFF[0]; };
  const lastDuty = (d) => { const p = D.dutyAt(d, 20 * 60 + 40); return p.filter((x) => x.id === 's-ranny' || x.id === 's-fajar')[0] || p.slice(-1)[0] || STAFF[0]; };
  const give = (day, m, code, q, kind, reason, by) => { qty[code] += q; moves.push({ day, at: iso(day, m, ri(0, 59)), item: code, kind, qty: q, reason, by: by.name, _m: m }); };
  const addGoods = (day, m, code, q, note, by, slip) => { const g = { id: ++gid, item_code: code, item: ids[code].name, unit: ids[code].unit, qty: q, current_qty: q, status: 'aktif', note, slip_note: slip || null,
    at: iso(day, m, ri(0, 59)), day, received_by: by.name, recorded_by: by.name, changes: [] }; goodsIn.push(g); give(day, m, code, q, 'masuk', note, by); return g; };
  const flavMix = (list) => list;
  const pendingFor = {};
  days.forEach((day, di) => {
    const isToday = day === today;
    const paid = orders.filter((o) => o.day === day && o.status === 'dibayar');
    const used = {};
    const useOrder = (o) => { for (const l of o.lines) for (const [c, q] of recipe(l.code, l.flavour)) used[c] = (used[c] || 0) + q * l.qty; };
    paid.forEach(useOrder);
    const by = firstDuty(day), close = lastDuty(day);
    if (pendingFor[day]) for (const c of pendingFor[day]) addGoods(day, 8 * 60 + 20 + ri(0, 15), c, DELIV[c], 'Kiriman supplier', by, 'Nota ' + (2000 + gid));
    // choux come fresh each morning, topped up when stock runs out
    const sampleMini = ri(2, 4), sampleSig = ri(1, 2);
    const needMini = (used.mini || 0) + sampleMini + 1, needSig = (used.sig || 0) + sampleSig + 1;
    const fullDay = orders.filter((o) => o.day === day); // planning uses the whole day
    const planned = { mini: 0, sig: 0 };
    for (const o of fullDay) if (o.status === 'dibayar') for (const l of o.lines) for (const [c, q] of recipe(l.code, l.flavour)) if (c === 'mini' || c === 'sig') planned[c] += q * l.qty;
    const split2 = rnd() < 0.15 && !isToday;
    for (const [c, need, smp] of [['mini', planned.mini + sampleMini + 2, sampleMini], ['sig', planned.sig + sampleSig + 1, sampleSig]]) {
      const tot = roundUp(Math.round(need * 1.18), 10);
      if (split2) { addGoods(day, 7 * 60 + ri(35, 55), c, roundUp(Math.round(tot * 0.7), 10), 'Kiriman dapur', by, 'Surat jalan ' + String(1000 + gid)); addGoods(day, 14 * 60 + ri(0, 20), c, tot - roundUp(Math.round(tot * 0.7), 10) + 10, 'Isi ulang karena habis', by); }
      else addGoods(day, 7 * 60 + ri(35, 55), c, tot, 'Kiriman dapur', by, 'Surat jalan ' + String(1000 + gid));
    }
    // sales deductions, hour by hour
    for (const o of paid) {
      if (isToday && o.sold_m > D.nowMin) continue;
      const bag = {}; for (const l of o.lines) for (const [c, q] of recipe(l.code, l.flavour)) bag[c] = (bag[c] || 0) + q * l.qty;
      for (const [c, q] of Object.entries(bag)) give(day, o.sold_m, c, -q, 'penjualan', o.receipt_no, STAFF.find((s) => s.id === o.served_by));
    }
    const smpAt = isToday ? Math.min(D.nowMin - 5, 11 * 60 + 20) : 11 * 60 + 20;
    if (smpAt >= 9 * 60) { give(day, smpAt, 'mini', -sampleMini, 'sampel', 'Sampel', by); give(day, smpAt + 1, 'sig', -sampleSig, 'sampel', 'Sampel', by); }
    if (!isToday) {
      if (rnd() < 0.15) give(day, 15 * 60, 'mini', -1, 'rusak', 'Penyok saat dikemas', by);
      // end of day: the choux are thrown away
      for (const c of ['mini', 'sig']) if (qty[c] > 0) give(day, 21 * 60 + 5, c, -qty[c], 'buang', 'Sisa saat tutup', close);
      // other items: reorder, liner cut, count
      const late = Object.keys(REORDER).filter((c) => qty[c] <= REORDER[c] && !(c === 'liner_kecil' && qty.liner_besar > 30) && !goodsIn.some((g) => g.item_code === c && g.day === addD(day, 1)));
      if (late.length) pendingFor[addD(day, 1)] = late;
      if (qty.liner_kecil < 24 && qty.liner_besar > 24) { const k = 10; give(day, 21 * 60 + 8, 'liner_besar', -k, 'potong_liner', 'Potong liner', close); give(day, 21 * 60 + 8, 'liner_kecil', 2 * k, 'potong_liner', 'Potong liner', close); }
      const rot = ['vla_vanilla', 'vla_choco', 'vla_matcha', 'dus_besar', 'dus_kecil', 'bag', 'liner_besar', 'liner_kecil', 'pouch', 'jam_strawberry'];
      const picks = [rot[di % rot.length], rot[(di + 4) % rot.length]];
      const lines = [];
      for (const c of ['mini', 'sig']) { const thrown = -moves.filter((m) => m.day === day && m.item === c && m.kind === 'buang').reduce((s, m) => s + m.qty, 0); lines.push(cl(c, 0, 0, thrown)); }
      for (const c of picks) { const sys = qty[c]; const unit = ids[c].unit; const r = rnd(); const d = unit === 'g' ? (r < 0.7 ? 0 : pick([-40, 25, -60, 15])) : (r < 0.8 ? 0 : pick([-1, 1, -2])); lines.push(cl(c, sys, sys + d, 0)); }
      const status = di === days.length - 2 ? 'menunggu' : di === days.length - 25 ? 'ditolak' : 'diterima';
      const cnt = { id: ++cid, day, status, at: iso(day, 21 * 60 + 12), by: close.name, responsible: close.name, closing: true, note: 'Tutup booth', lines };
      if (status !== 'menunggu') { cnt.decided_by = 'Glenn'; cnt.decided_at = iso(addD(day, 1), 9 * 60 + ri(0, 30)); }
      if (status === 'ditolak') { cnt.decision_note = 'Hitung ulang dulu, selisih vla tidak masuk akal'; }
      if (status === 'diterima') for (const l of lines) if (l.selisih && l.code !== 'mini' && l.code !== 'sig') { qty[l.code] += l.selisih; moves.push({ day, at: cnt.decided_at, item: l.code, kind: 'selisih', qty: l.selisih, reason: 'Opname diterima', by: 'Glenn', _m: 21 * 60 + 20 }); }
      counts.push(cnt);
    }
  });
  function cl(code, sys, fis, thrown) { const i = ids[code]; return { code, item: i.name, unit: i.unit, expected: sys, counted: fis, thrown, difference: fis - sys, system: sys, physical: fis, selisih: fis - sys }; }
  // second pass: apply the morning deliveries and rebuild the running quantities in time order
  rebuildStock(D, { ids, DELIV, goodsIn, counts, moves, addGoodsFn: null });
  D.stock = { moves, goodsIn, counts, requests };
  // audit examples: one goods-in changed, one cancelled
  decorateAudit(D, ids);
  buildRequests(D, ids, requests);
}

// Re-run the whole period in time order so deliveries (ordered after a low count) land the next morning
// and every quantity in the ledger agrees with the orders.
function rebuildStock(D, { ids, DELIV, goodsIn, counts, moves }) {
  const { days, today } = D;
  moves.sort((a, b) => a.at.localeCompare(b.at));
  goodsIn.sort((a, b) => a.at.localeCompare(b.at));
  goodsIn.forEach((g, i) => { g.id = i + 1; });
  // balances after every movement, so any date range can be answered
  const bal = { mini: 0, sig: 0, vla_vanilla: 0, vla_choco: 0, jam_strawberry: 0, vla_matcha: 0, dus_besar: 0, dus_kecil: 0, bag: 0, liner_besar: 0, liner_kecil: 0, pouch: 0 };
  // opening balances (the initial quantities used for the deductions above)
  const open = { vla_vanilla: 3400, vla_choco: 1700, jam_strawberry: 450, vla_matcha: 1500, dus_besar: 52, dus_kecil: 40, bag: 66, liner_besar: 48, liner_kecil: 50, pouch: 70 };
  Object.assign(bal, open);
  D.stock_open = { ...bal };
  for (const mv of moves) { bal[mv.item] += mv.qty; mv.balance = bal[mv.item]; }
  D.stock_end = { ...bal };
}

function decorateAudit(D, ids) {
  const g = D.stock.goodsIn;
  const dk = g.filter((x) => x.item_code === 'dus_kecil' && x.day < D.today).slice(-1)[0];
  const old = g.filter((x) => x.item_code === 'vla_choco' && x.day < addD(D.today, -5)).slice(-1)[0] || g.filter((x) => x.item_code === 'bag')[0];
  if (dk) { const d = dk.qty; dk.status = 'diubah'; dk.current_qty = d - 5; dk.slip_note = 'Surat jalan 0123'; dk.changes = [{ kind: 'ubah', old_qty: d, new_qty: d - 5, reason: 'Dihitung ulang, isi ' + (d - 5), by: 'Yuya', at: iso(dk.day, 10 * 60) }];
    const mv = D.stock.moves.find((m) => m.item === 'dus_kecil' && m.kind === 'masuk' && m.at === dk.at); if (mv) { mv.qty -= 5; } }
  if (old) { old.status = 'dibatalkan'; old.note = 'Tercatat dua kali'; old.current_qty = 0; old.changes = [{ kind: 'batal', old_qty: old.qty, new_qty: 0, reason: 'Tercatat dua kali', by: 'Yuya', at: iso(old.day, 11 * 60) }];
    const mv = D.stock.moves.find((m) => m.item === old.item_code && m.kind === 'masuk' && m.at === old.at); if (mv) mv.qty = 0; }
  // recompute balances after the edits
  const bal = { ...D.stock_open };
  for (const mv of D.stock.moves) { bal[mv.item] += mv.qty; mv.balance = bal[mv.item]; }
  D.stock_end = { ...bal };
}

function buildRequests(D, ids, requests) {
  const { today } = D;
  const R = (id, item, unit, q, at, got = 0) => ({ item_id: id, item, unit, qty: q, stock_at: at, received: got });
  const mk = (n, day, status, lines, by, note, need) => ({ id: n, no: 'PB-' + day.slice(2).replace(/-/g, '') + '-0' + (n % 3 + 1), day, at: iso(day, 9 * 60 + 30), needed_by: need, status, by, responsible: by, note, lines });
  const e = D.stock_end;
  requests.push(mk(4, today, 'dikirim', [R(3, 'Vla Vanilla', 'g', 3000, e.vla_vanilla), R(10, 'Paper liner besar', 'pcs', 50, e.liner_besar)], 'Ranny', 'Untuk akhir pekan', addD(today, 2)));
  requests.push(mk(3, addD(today, -6), 'sebagian', [R(7, 'Dus besar', 'pcs', 100, 24, 60), R(8, 'Dus kecil', 'pcs', 100, 22, 0)], 'Fajar', null, addD(today, -4)));
  requests.push(mk(2, addD(today, -19), 'selesai', [R(9, 'Paper bag', 'pcs', 100, 15, 100)], 'Ranny', null, addD(today, -16)));
  requests.push(mk(1, addD(today, -41), 'batal', [R(12, 'Paper pouch (untuk 1 pcs)', 'pcs', 100, 30)], 'Fajar', 'Dobel dengan permintaan lain', addD(today, -38)));
  requests.sort((a, b) => b.id - a.id);
}
