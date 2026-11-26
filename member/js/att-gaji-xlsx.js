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
// Every row gets an explicit height (26 Nov 2026): without one, the iPhone and Mac preview
// (Quick Look, opening the file from WhatsApp) guessed a giant first row and showed a blank page.
// Wrapped headers get room for their lines, everything else 16 pt.
function setRowHeights(sheet) {
  const m = /:([A-Z]+)(\d+)$/.exec(sheet['!ref'] || ''); if (!m) return;
  const widths = (sheet['!cols'] || []).map((c) => c.wch || 9);
  const colIdx = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const rows = Array.from({ length: Number(m[2]) }, () => ({ hpt: 16 }));
  for (const [ref, cell] of Object.entries(sheet)) {
    if (ref[0] === '!' || !cell?.s?.alignment?.wrapText) continue;
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(ref);
    const lines = Math.ceil(String(cell.v ?? '').length / Math.max(1, (widths[colIdx(letters)] || 9) - 1));
    rows[row - 1].hpt = Math.max(rows[row - 1].hpt, lines * 13 + 4);
  }
  sheet['!rows'] = rows;
}
const jam = (min) => Math.round(((min || 0) / 60) * 100) / 100;
const ROLE = { staff: 'Staff', manager: 'Manajer' };

// The employer a staff account belongs to ('Hanashuya' when not set).
export const employerOf = (s) => s?.employer || 'Hanashuya';
// Each employer closes its month on its own day (Glenn, 26 Nov 2026): Hanashuya staff run
// from the 1st to the last day of the month, Kaaramel Juice (and any other employer) from
// the 26th of the month before to the 25th, as in the KJ payroll file.
export const employerMode = (emp) => (emp === 'Hanashuya' ? 'kalender' : '26-25');

// groups: [{ employer, from, to, people }] (people from att_recap_range for that range).
// pay: { staff_id: { base_salary, meal_per_day, transport, overtime_rate, join_date, job_title } }
// from owner_pay_list (owner only; empty for a manager, then the pay cells stay 0 to type in).
// withPay false: the copy for staff (Absensi and Kuota jam only, no Gaji sheet).
// scans: { staff_id: { 'YYYY-MM-DD': [{ action, at, via }] } } from att_day_report, for the scan columns.
export function buildGajiBook(X, { groups: groupList, staff = [], today, pay = {}, withPay = true, scans = null }) {
  const byId = Object.fromEntries(staff.map((s) => [s.id, s]));
  const groups = groupList.filter((g) => g.people.length);
  const people = groups.flatMap((g) => g.people);
  const totalCols = ['link foto SKD', 'LEMBUR hari/JAM', 'TELAT', 'OFF LEMBUR', 'OFF', 'IZIN SAKIT', 'A', 'ON'];
  const c0 = 2; // first day column
  let maxDays = 0;
  const ws = {}, merges = [];
  const put = (r, c, v, s, f) => {
    const cell = { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s };
    if (f) cell.f = f;
    ws[col(c) + (r + 1)] = cell;
  };
  const ref = {}; // person id -> { row (1-based), cT } on the Absensi sheet, for the Gaji sheet
  let r = 0;
  for (const { employer: emp, from, to, people: list } of groups) {
    const days = dayList(from, to), cT = c0 + days.length; // cT: first column after the days
    maxDays = Math.max(maxDays, days.length);
    put(r, 1, `ABSENSI ${emp.toUpperCase()} PAPAYA BANDUNG`, st(null, { b: true, left: true, noBorder: true })); r++;
    put(r, 1, 'PERIODE', st(null, { b: true, left: true, noBorder: true }));
    put(r, 2, periodTitle(from, to), st(null, { left: true, noBorder: true })); r++;
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
      ref[p.id] = { row: r + 1, cT };
      r++;
    });
    r += 2;
  }
  if (!people.length) put(0, 1, 'Belum ada akun staf.', st(null, { left: true, noBorder: true }));
  ws['!ref'] = `A1:${col(c0 + maxDays + totalCols.length - 1)}${Math.max(r, 1)}`;
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 5 }, { wch: 24 }, ...Array.from({ length: maxDays }, () => ({ wch: 5.5 })), { wch: 9 }, { wch: 10 }, { wch: 7 }, { wch: 9 }, { wch: 6 }, { wch: 7 }, { wch: 5 }, { wch: 6 }];

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
  const same = groups.every((x) => x.from === groups[0]?.from && x.to === groups[0]?.to);
  const title = !groups.length ? '' : same ? `PERIODE ${periodTitle(groups[0].from, groups[0].to).toUpperCase()}` : 'PERIODE PER OUTLET (LIHAT BARIS OUTLET)';
  gput(g, 0, title, st(null, { b: true, left: true, noBorder: true }));
  gput(g, 20, 'WORKING DAYS ', st(null, { b: true, noBorder: true }));
  gput(g + 1, 18, 'Tarif lembur per jam', st(null, { b: true, left: true, noBorder: true }));
  gput(g + 1, 20, 0, st(C.yellow), null, RP);
  const rate = '$U$2';
  g += 2;
  const totals = []; let grand = 0;
  for (const { employer: emp, from, to, people: list } of groups) {
    g++;
    gput(g, 0, `OUTLET : ${emp.toUpperCase()} PAPAYA BANDUNG`, st(null, { b: true, left: true, noBorder: true }));
    gput(g, 4, `PERIODE ${periodTitle(from, to).toUpperCase()}`, st(null, { b: true, left: true, noBorder: true }));
    gput(g, 20, dayList(from, to).length, st(null, { b: true }));
    const wd = `$U$${g + 1}`;
    g++;
    head.forEach((h, i) => gput(g, i, h, st(C.orange, { b: true, wrap: true })));
    g += 2;
    const top = g + 1, sums = [];
    list.forEach((p, n) => {
      const s = byId[p.id] || p, { row: ar, cT } = ref[p.id], R = g + 1;
      // Rekening from Profil staf (att_profiles), the recap's copy as a fallback; written as text
      // so leading zeros stay. Empty profiles say so instead of leaving a blank cell.
      const bank = s.bank_name || p.bank_name, no = s.bank_account || p.bank_account;
      const acct = no ? `${no}${bank ? ` (${bank})` : ''}` : 'Belum diisi di Profil staf';
      const txt = st(null, { left: true });
      const pp = pay[p.id] || {};
      gput(g, 0, n + 1, st(null)); gput(g, 1, p.full_name || p.name, txt);
      gput(g, 2, pp.join_date ? pp.join_date.split('-').reverse().join('/') : '', txt);
      gput(g, 3, pp.job_title || ROLE[p.role] || 'Staff', txt); gput(g, 4, acct, txt);
      gput(g, 5, pp.base_salary || 0, st(C.yellow), null, RP); gput(g, 6, pp.meal_per_day || 0, st(C.yellow), null, RP);
      const v = (c) => ws[`${col(c)}${ar}`]?.v || 0;
      gput(g, 7, v(cT + 6), st(null), A(cT + 6, ar));
      gput(g, 8, v(cT + 5), st(null), A(cT + 5, ar));
      gput(g, 9, 0, st(null));
      gput(g, 10, v(cT + 7), st(null), A(cT + 7, ar));
      gput(g, 11, v(cT + 4), st(null), A(cT + 4, ar));
      // Lembur: approved hours x the person's own rate, or the default rate in U2.
      const otH = ws[`${col(cT + 1)}${ar}`]?.v || 0;
      gput(g, 12, otH * (pp.overtime_rate || 0), st(null), `${A(cT + 1, ar)}*${pp.overtime_rate || rate}`, RP);
      gput(g, 13, pp.transport || 0, st(C.yellow), null, RP);
      gput(g, 14, v(cT + 2), st(null), A(cT + 2, ar));
      gput(g, 15, v(cT + 7) + v(cT + 4), st(null), `K${R}+L${R}`);
      gput(g, 16, 0, st(C.yellow), null, RP); gput(g, 17, 0, st(C.yellow), null, RP);
      const nDays = dayList(from, to).length, masuk = v(cT + 7), absen = masuk + v(cT + 4);
      const meal = (pp.meal_per_day || 0) * masuk, perDay = nDays ? (pp.base_salary || 0) / nDays : 0;
      const total = Math.round(perDay * absen + meal + (pp.transport || 0) + otH * (pp.overtime_rate || 0));
      gput(g, 18, meal, st(null), `G${R}*K${R}`, RP);
      gput(g, 19, Math.round(perDay), st(null), `IF(${wd}=0,0,F${R}/${wd})`, RP);
      gput(g, 20, total, st(null, { b: true }), `T${R}*P${R}-R${R}+Q${R}+S${R}+N${R}+M${R}`, RP);
      sums.push(total);
      g++;
    });
    gput(g, 0, 'TOTAL', st(null, { b: true, left: true }));
    gput(g, 20, sums.reduce((a, x) => a + x, 0), st(null, { b: true }), `SUM(U${top}:U${Math.max(g, top)})`, RP);
    totals.push(`U${g + 1}`); grand += sums.reduce((a, x) => a + x, 0);
    g += 2;
  }
  if (groups.length > 1) { gput(g, 0, 'TOTAL SEMUA OUTLET', st(null, { b: true, left: true })); gput(g, 20, grand, st(null, { b: true }), totals.join('+'), RP); g++; }
  g++;
  gput(g, 0, 'Gaji pokok, staff meal, transportasi dan tarif lembur diambil dari Profil staf > Gaji (diisi pemilik). Kolom kuning bisa diubah di file ini; bonus dan kasbon diisi sendiri. Lembur = jam lembur yang disetujui x tarif (tarif staf, atau U2 bila kosong).', st(null, { left: true, noBorder: true, sz: 9 }));
  gs['!ref'] = `A1:U${g + 1}`;
  gs['!merges'] = gm;
  gs['!cols'] = [{ wch: 5 }, { wch: 26 }, { wch: 11 }, { wch: 9 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 7 }, { wch: 6 }, { wch: 7 }, { wch: 8 }, { wch: 6 },
    { wch: 11 }, { wch: 12 }, { wch: 7 }, { wch: 8 }, { wch: 12 }, { wch: 11 }, { wch: 13 }, { wch: 11 }, { wch: 16 }];

  const quota = quotaSheet(groups, today, scans);
  [ws, gs, quota].forEach(setRowHeights);
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, 'Absensi');
  if (withPay) X.utils.book_append_sheet(wb, gs, 'Gaji');
  X.utils.book_append_sheet(wb, quota, 'Kuota jam');
  return wb;
}

// Kuota jam (Glenn, 26 Nov 2026: Kevin must work 6 hours a day): per person, every date of
// the period with the hours worked from the QR scans (breaks left out) against that person's
// daily quota (Per staf > Jam kerja per hari, work_target_min), the difference, and totals.
// Only days with a Masuk count toward the quota, as in the app's "Kurang dari target".
const HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const clock = (iso) => iso ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)).replace(':', '.') : '';
function quotaSheet(groups, today, scans) {
  const q = {};
  const put = (r, c, v, s, f, z) => {
    const cell = { v: v ?? '', t: typeof v === 'number' ? 'n' : 's', s };
    if (f) cell.f = f;
    if (z) cell.z = z;
    q[col(c) + (r + 1)] = cell;
  };
  const H = '0.00', bold = st(null, { b: true, left: true, noBorder: true }), txt = st(null, { left: true });
  // Waktu scan (Glenn, 26 Nov 2026: "must write waktu scan clearly"): every scan of the day in its
  // own column, HH.MM in WIB; a scan added by a correction carries a * (see the note under the title).
  const head = ['Tanggal', 'Hari', 'Jadwal', 'Scan Masuk', 'Scan Istirahat', 'Scan Kembali', 'Scan Pulang', 'Istirahat (menit)', 'Jam kerja', 'Kuota (jam)', 'Selisih (jam)', 'Keterangan'];
  const ACTS = ['masuk', 'istirahat', 'kembali', 'pulang'];
  let r = 0;
  for (const { employer, from, to, people } of groups) {
    for (const p of people) {
      const quota = (p.work_target_min ?? 540) / 60;
      put(r, 0, `KUOTA JAM KERJA: ${(p.full_name || p.name).toUpperCase()} (${employer.toUpperCase()})`, bold); r++;
      put(r, 0, `Periode ${periodTitle(from, to)} · kuota ${quota.toLocaleString('id-ID')} jam per hari kerja (di luar istirahat) · waktu scan dalam WIB, * = dicatat lewat koreksi, bukan scan QR`, st(null, { left: true, noBorder: true })); r++;
      head.forEach((h, i) => put(r, i, h, st(C.orange, { b: true, wrap: true }))); r++;
      const top = r + 1;
      for (const d of dayList(from, to)) {
        const rows = (p.days || []).filter((x) => x.date === d);
        const mark = dayMark(rows, d, today);
        const worked = rows.reduce((a, x) => a + (x.worked_min || 0), 0);
        const plan = rows.filter((x) => x.start).map((x) => `${x.shift ? x.shift + ' ' : ''}${x.start.replace(':', '.')}-${x.end.replace(':', '.')}`).join(', ');
        const ins = rows.map((x) => x.masuk).filter(Boolean).sort(), outs = rows.map((x) => x.pulang).filter(Boolean).sort();
        const daySc = scans?.[p.id]?.[d];
        // Times per action; without the scan list (older data or a failed read) Masuk and Pulang come from the recap.
        const times = (act) => daySc ? daySc.filter((e) => e.action === act).map((e) => clock(e.at) + (e.via === 'koreksi' ? '*' : '')).join(', ')
          : act === 'masuk' ? clock(ins[0]) : act === 'pulang' ? clock(outs[outs.length - 1]) : '';
        // Today has not passed yet (Glenn, 26 Nov 2026): its hours so far are shown, but it is not
        // judged against the quota and stays out of the totals until the day is over.
        const open = mark === 'ON' && d >= today;
        const on = mark === 'ON' && !open, R = r + 1;
        const short = on && worked / 60 < quota;
        const fill = mark === 'A' ? C.magenta : short ? C.yellow : null;
        const note = open ? 'Hari ini, belum selesai' : mark === 'ON' ? (short ? 'Kurang dari kuota' : 'Cukup') : mark === 'A' ? 'Tidak hadir' : mark === 'IZIN' ? 'Izin' : mark === 'OFF' ? 'Libur' : 'Belum lewat';
        const w = new Date(d + 'T00:00:00Z').getUTCDay();
        put(r, 0, d.split('-').reverse().join('/'), st(fill));
        put(r, 1, HARI[w], st(fill, { left: true }));
        put(r, 2, plan, st(fill, { left: true }));
        ACTS.forEach((act, i) => put(r, 3 + i, times(act), st(fill, { wrap: true })));
        put(r, 7, rows.reduce((a, x) => a + (x.break_min || 0), 0), st(fill));
        put(r, 8, jam(worked), st(fill), null, H);
        put(r, 9, on ? quota : 0, st(fill), null, H);
        put(r, 10, on ? Math.round((jam(worked) - quota) * 100) / 100 : 0, st(fill, { b: short }), on ? `I${R}-J${R}` : null, H);
        put(r, 11, note, st(fill, { left: true, color: mark === 'A' ? C.white : undefined }));
        r++;
      }
      const bot = r;
      const sumRow = (label, v, f, z = H) => { put(r, 7, label, st(null, { b: true, left: true })); put(r, 8, v, st(null, { b: true }), f, z); r++; };
      const ds = (p.days || []).filter((x) => x.date >= from && x.date <= to);
      const workedDays = new Set(ds.filter((x) => x.masuk && x.date < today).map((x) => x.date));
      const perDay = [...workedDays].map((d) => ds.filter((x) => x.date === d).reduce((a, x) => a + (x.worked_min || 0), 0) / 60);
      sumRow('Hari kerja', workedDays.size, `COUNTIF(L${top}:L${bot},"Cukup")+COUNTIF(L${top}:L${bot},"Kurang dari kuota")`, '0');
      sumRow('Total jam kerja', jam(perDay.reduce((a, x) => a + x * 60, 0)), `SUMIF(L${top}:L${bot},"Cukup",I${top}:I${bot})+SUMIF(L${top}:L${bot},"Kurang dari kuota",I${top}:I${bot})`);
      sumRow('Total kuota', workedDays.size * quota, `SUM(J${top}:J${bot})`);
      sumRow('Total kurang', perDay.reduce((a, x) => a + Math.max(quota - x, 0), 0), `-SUMIF(K${top}:K${bot},"<0")`);
      sumRow('Total lebih', perDay.reduce((a, x) => a + Math.max(x - quota, 0), 0), `SUMIF(K${top}:K${bot},">0")`);
      sumRow('Hari kurang dari kuota', perDay.filter((x) => x < quota).length, `COUNTIF(L${top}:L${bot},"Kurang dari kuota")`, '0');
      r += 2;
    }
  }
  if (!r) put(0, 0, 'Belum ada akun staf.', bold);
  q['!ref'] = `A1:L${Math.max(r, 1)}`;
  q['!cols'] = [{ wch: 11 }, { wch: 8 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 22 }];
  return q;
}
