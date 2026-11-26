// Monthly presensi recap in Glenn's payroll workbook layout (Glenn, 26 Nov 2026: "export
// monthly recap with the uploaded format", the ABSENSI GAJI KARAMEL JUICE file).
// Sheet "Absensi": one block per employer, a column per day (date, then SAT/SUN/MON…),
// each cell ON / OFF / A / IZIN, then link foto SKD, LEMBUR hari/JAM, TELAT, OFF LEMBUR and
// the COUNTIF totals OFF, IZIN SAKIT, A, ON. Sheet "Gaji": the same people with the salary
// columns of that file; MASUK, OFF, ALPHA, IZIN and LEMBUR link to the Absensi sheet, and
// the money columns (gaji pokok, staff meal, kasbon, bonus, tarif lembur) are left for the
// owner to type, because the app holds no salaries.
// Needs the styled SheetJS build (xlsx-js-style), passed in as X.

const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
// Colours exactly as in the uploaded file.
const C = { orange: 'FFC000', cyan: '00FFFF', red: 'FF0000', yellow: 'FFFF00', magenta: 'FF00FF', green: '00FF00', white: 'FFFFFF' };
const thin = { style: 'thin', color: { rgb: '000000' } };
const BORDER = { top: thin, bottom: thin, left: thin, right: thin };
const st = (fill, o = {}) => ({ font: { name: 'Calibri', sz: o.sz || 11, bold: !!o.b, color: { rgb: o.color || '000000' } },
  alignment: { horizontal: o.left ? 'left' : 'center', vertical: 'center', wrapText: !!o.wrap },
  border: o.noBorder ? undefined : BORDER, ...(fill ? { fill: { patternType: 'solid', fgColor: { rgb: fill } } } : {}) });
const MARK_STYLE = { ON: st(C.green), OFF: st(C.red, { color: C.white }), A: st(C.magenta, { color: C.white }), IZIN: st(C.yellow), '': st(null) };

const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayList = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const longDay = (s) => { const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
export const periodTitle = (from, to) => {
  const [a, b] = [from.split('-').map(Number), to.split('-').map(Number)];
  return a[0] === b[0] ? `${a[2]} ${MONTHS[a[1] - 1]} - ${longDay(to)}` : `${longDay(from)} - ${longDay(to)}`;
};

// The period for a month: 26th of the month before to the 25th (the uploaded file), or the
// calendar month. month = 'YYYY-MM'.
export function monthPeriod(month, mode = '26-25') {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (mode === 'kalender') return [first, last];
  const prev = new Date(Date.UTC(y, m - 2, 26)).toISOString().slice(0, 10);
  return [prev, `${month}-25`];
}

// One person's day: ON when any scan or a counted day exists, IZIN on approved leave,
// A when a scheduled block was missed, empty for a scheduled day still to come, OFF when
// nothing was scheduled (libur or no schedule).
export function dayMark(rows, date, today) {
  if (!rows.length) return date > today ? '' : 'OFF';
  if (rows.some((r) => r.kind === 'izin')) return 'IZIN';
  if (rows.some((r) => r.masuk)) return 'ON';
  if (rows.some((r) => (r.flags || []).includes('tidak_hadir'))) return 'A';
  return '';
}

const col = (n) => { let s = ''; n += 1; while (n) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const jam = (min) => Math.round(((min || 0) / 60) * 100) / 100;
const ROLE = { staff: 'Staff', manager: 'Manajer' };

export function buildGajiBook(X, { people, staff = [], from, to, today }) {
  const days = dayList(from, to), nd = days.length;
  const byId = Object.fromEntries(staff.map((s) => [s.id, s]));
  const groups = new Map();
  for (const p of people) {
    const emp = byId[p.id]?.employer || 'Hanashuya';
    if (!groups.has(emp)) groups.set(emp, []);
    groups.get(emp).push(p);
  }
  const title = periodTitle(from, to);
  const totalCols = ['link foto SKD', 'LEMBUR hari/JAM', 'TELAT', 'OFF LEMBUR', 'OFF', 'IZIN SAKIT', 'A', 'ON'];
  const c0 = 2, cT = c0 + nd; // first day column, first column after the days
  const ws = {}, merges = [];
  const put = (r, c, v, s, f) => {
    const cell = { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s };
    if (f) cell.f = f;
    ws[col(c) + (r + 1)] = cell;
  };
  const ref = {}; // person id -> Absensi row (1-based) for the Gaji sheet
  let r = 0;
  for (const [emp, list] of groups) {
    put(r, 1, `ABSENSI ${emp.toUpperCase()} PAPAYA BANDUNG`, st(null, { b: true, left: true, noBorder: true })); r++;
    put(r, 1, 'PERIODE', st(null, { b: true, left: true, noBorder: true }));
    put(r, 2, title, st(null, { left: true, noBorder: true })); r++;
    put(r, 0, 'NO', st(C.orange)); put(r, 1, 'TANGGAL', st(C.orange, { b: true, sz: 8 }));
    put(r + 1, 0, '', st(C.orange)); put(r + 1, 1, 'NAMA', st(C.orange, { b: true, sz: 8 }));
    merges.push({ s: { r, c: 0 }, e: { r: r + 1, c: 0 } });
    days.forEach((d, i) => {
      put(r, c0 + i, Number(d.slice(8)), st(C.cyan, { b: true }));
      const w = new Date(d + 'T00:00:00Z').getUTCDay();
      put(r + 1, c0 + i, DOW[w], st(w === 0 || w === 6 ? C.red : C.orange, { b: true }));
    });
    const headFill = [null, null, null, null, [C.red, C.white], [C.yellow], [C.magenta, C.white], [C.green]];
    totalCols.forEach((h, i) => {
      const [fill, color] = headFill[i] || [];
      put(r, cT + i, h, st(fill, { b: true, sz: i >= 4 ? 8 : 11, color, wrap: true }));
      put(r + 1, cT + i, '', st(fill));
      merges.push({ s: { r, c: cT + i }, e: { r: r + 1, c: cT + i } });
    });
    r += 2;
    list.forEach((p, n) => {
      put(r, 0, n + 1, st(null)); put(r, 1, p.full_name || p.name, st(null, { left: true }));
      const marks = days.map((d) => dayMark((p.days || []).filter((x) => x.date === d), d, today));
      marks.forEach((m, i) => put(r, c0 + i, m, MARK_STYLE[m]));
      const span = `${col(c0)}${r + 1}:${col(cT - 1)}${r + 1}`;
      const count = (m) => marks.filter((x) => x === m).length;
      put(r, cT, '', st(null));
      put(r, cT + 1, jam(p.overtime_approved_min), st(null));
      put(r, cT + 2, p.late_count || 0, st(null));
      put(r, cT + 3, '', st(null));
      put(r, cT + 4, count('OFF'), st(null, { b: true }), `COUNTIF(${span},"OFF")`);
      put(r, cT + 5, count('IZIN'), st(null, { b: true }), `COUNTIF(${span},"IZIN")`);
      put(r, cT + 6, count('A'), st(null, { b: true }), `COUNTIF(${span},"A")`);
      put(r, cT + 7, count('ON'), st(C.green, { b: true }), `COUNTIF(${span},"ON")`);
      ref[p.id] = r + 1;
      r++;
    });
    r += 2;
  }
  if (!people.length) put(0, 1, 'Belum ada akun staf.', st(null, { left: true, noBorder: true }));
  ws['!ref'] = `A1:${col(cT + totalCols.length - 1)}${Math.max(r, 1)}`;
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 5 }, { wch: 24 }, ...days.map(() => ({ wch: 5.5 })), { wch: 9 }, { wch: 10 }, { wch: 7 }, { wch: 9 }, { wch: 6 }, { wch: 7 }, { wch: 5 }, { wch: 6 }];
  ws['!rows'] = [];

  // Gaji sheet, same columns as the uploaded file.
  const gs = {}, gm = [];
  const gput = (r, c, v, s, f, z) => {
    const cell = { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s };
    if (f) cell.f = f;
    if (z) cell.z = z;
    gs[col(c) + (r + 1)] = cell;
  };
  const RP = '#,##0';
  const head = ['No.', 'Nama', 'Join Date', 'Jabatan', 'No Rekening', 'Gaji Pokok ', 'Staff Meal', 'ALPHA', 'IZIN', 'SAKIT', 'MASUK', 'OFF',
    'LEMBUR', 'transportasi tambahan', 'TELAT', 'Absensi', 'Bonus Omset Bln Lalu', 'Kasbon', 'TUNJANGAN MAKAN STAF', 'GAJI 1 HARI', 'Total Yang Diterima sebenarnya'];
  const A = (c, row) => `Absensi!${col(c)}${row}`;
  let g = 0;
  gput(g, 0, `PERIODE ${title.toUpperCase()}`, st(null, { b: true, left: true, noBorder: true }));
  gput(g, 20, 'WORKING DAYS ', st(null, { b: true, noBorder: true }));
  gput(g + 1, 18, 'Tarif lembur per jam', st(null, { b: true, left: true, noBorder: true }));
  gput(g + 1, 20, 0, st(C.yellow), null, RP);
  const rate = '$U$2';
  g += 2;
  const totals = [];
  for (const [emp, list] of groups) {
    g++;
    gput(g, 0, `OUTLET : ${emp.toUpperCase()} PAPAYA BANDUNG`, st(null, { b: true, left: true, noBorder: true }));
    gput(g, 20, nd, st(null, { b: true }));
    const wd = `$U$${g + 1}`;
    g++;
    head.forEach((h, i) => gput(g, i, h, st(C.orange, { b: true, wrap: true })));
    g += 2;
    const top = g + 1;
    list.forEach((p, n) => {
      const s = byId[p.id] || p, ar = ref[p.id], R = g + 1;
      const acct = [s.bank_name, s.bank_account].filter(Boolean).join(' ');
      const txt = st(null, { left: true });
      gput(g, 0, n + 1, st(null)); gput(g, 1, p.full_name || p.name, txt); gput(g, 2, '', txt);
      gput(g, 3, ROLE[p.role] || 'Staff', txt); gput(g, 4, acct, txt);
      gput(g, 5, 0, st(C.yellow), null, RP); gput(g, 6, 0, st(C.yellow), null, RP);
      const v = (c) => ws[`${col(c)}${ar}`]?.v || 0;
      gput(g, 7, v(cT + 6), st(null), A(cT + 6, ar));
      gput(g, 8, v(cT + 5), st(null), A(cT + 5, ar));
      gput(g, 9, 0, st(null));
      gput(g, 10, v(cT + 7), st(null), A(cT + 7, ar));
      gput(g, 11, v(cT + 4), st(null), A(cT + 4, ar));
      gput(g, 12, 0, st(null), `${A(cT + 1, ar)}*${rate}`, RP);
      gput(g, 13, 0, st(C.yellow), null, RP);
      gput(g, 14, v(cT + 2), st(null), A(cT + 2, ar));
      gput(g, 15, v(cT + 7) + v(cT + 4), st(null), `K${R}+L${R}`);
      gput(g, 16, 0, st(C.yellow), null, RP); gput(g, 17, 0, st(C.yellow), null, RP);
      gput(g, 18, 0, st(null), `G${R}*K${R}`, RP);
      gput(g, 19, 0, st(null), `IF(${wd}=0,0,F${R}/${wd})`, RP);
      gput(g, 20, 0, st(null, { b: true }), `T${R}*P${R}-R${R}+Q${R}+S${R}+N${R}+M${R}`, RP);
      g++;
    });
    gput(g, 0, 'TOTAL', st(null, { b: true, left: true }));
    gput(g, 20, 0, st(null, { b: true }), `SUM(U${top}:U${Math.max(g, top)})`, RP);
    totals.push(`U${g + 1}`);
    g += 2;
  }
  if (groups.size > 1) { gput(g, 0, 'TOTAL SEMUA OUTLET', st(null, { b: true, left: true })); gput(g, 20, 0, st(null, { b: true }), totals.join('+'), RP); g++; }
  g++;
  gput(g, 0, 'Kolom kuning diisi sendiri (gaji pokok, staff meal, transportasi, bonus, kasbon, tarif lembur). Lembur = jam lembur yang disetujui x tarif.', st(null, { left: true, noBorder: true, sz: 9 }));
  gs['!ref'] = `A1:U${g + 1}`;
  gs['!merges'] = gm;
  gs['!cols'] = [{ wch: 5 }, { wch: 26 }, { wch: 11 }, { wch: 9 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 7 }, { wch: 6 }, { wch: 7 }, { wch: 8 }, { wch: 6 },
    { wch: 11 }, { wch: 12 }, { wch: 7 }, { wch: 8 }, { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 16 }];

  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, 'Absensi');
  X.utils.book_append_sheet(wb, gs, 'Gaji');
  return wb;
}
