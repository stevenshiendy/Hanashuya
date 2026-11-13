// Parser for the staff schedule template (Template Jadwal Staf.xlsx).
// Dependency-free. Input rows come from SheetJS sheet_to_json(ws, {header:1, raw:false}).

export const DEFAULT_SHIFTS = [
  { name: 'Fulltime 1', start: '08:00', end: '18:00' },
  { name: 'Fulltime 2', start: '11:00', end: '21:00' },
  { name: 'Parttime 1', start: '08:00', end: '14:00' },
  { name: 'Parttime 2', start: '15:00', end: '21:00' },
];
export const OPENING = { open: '08:00', close: '21:00' };
export const WEEKDAYS = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];

const DAY_ALIASES = {
  senin: 1, sen: 1, selasa: 2, sel: 2, rabu: 3, rab: 3, kamis: 4, kam: 4,
  jumat: 5, jum: 5, jumaat: 5, "jum'at": 5, sabtu: 6, sab: 6, minggu: 7, min: 7, ahad: 7,
};
const KIND_ALIASES = {
  kerja: 'kerja', kuliah: 'kuliah', 'tidak bisa': 'tidak_bisa', tidakbisa: 'tidak_bisa',
  'tdk bisa': 'tidak_bisa', libur: 'libur',
};
const HEADERS = {
  nama: 'name', name: 'name', hari: 'day', tanggal: 'date', tgl: 'date', shift: 'shift',
  mulai: 'start', selesai: 'end', jenis: 'kind', catatan: 'note',
};

const clean = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const norm = (v) => clean(v).toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
export const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

// Returns 'HH:MM', '' (empty) or null (unreadable).
export function parseTime(v) {
  if (typeof v === 'number') v = String(v);
  const s = clean(v).replace(/\s*wib$/i, '');
  if (!s) return '';
  let m = s.match(/^(\d{1,2})[.:](\d{2})(?:[.:]\d{2})?$/);
  if (m && !/^0[.,]/.test(s)) {
    const h = +m[1], mi = +m[2];
    return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null;
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) return +m[1] < 24 ? `${pad(+m[1])}:00` : null;
  m = s.replace(',', '.').match(/^(0?\.\d+|1\.0+)$/); // Excel fraction of a day
  if (m) {
    const total = Math.round(parseFloat(m[1]) * 1440);
    return total >= 0 && total < 1440 ? fmtMin(total) : null;
  }
  return null;
}

// Returns 'YYYY-MM-DD', '' or null.
export function parseDate(v) {
  const s = clean(v);
  if (!s) return '';
  let y, mo, d, m;
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/))) [d, mo, y] = [+m[1], +m[2], +m[3]];
  else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if (/^\d{5}$/.test(s)) { // Excel serial
    const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return dt.toISOString().slice(0, 10);
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function shiftMap(shifts) {
  const list = Array.isArray(shifts) ? shifts : Object.entries(shifts || {}).map(([name, v]) => ({ name, ...v }));
  const map = new Map();
  for (const s of list) map.set(norm(s.name), s);
  return map;
}

export function parseScheduleRows(rows, { shifts = DEFAULT_SHIFTS, staffNames = [], opening = OPENING } = {}) {
  const entries = [];
  const problems = [];
  const err = (row, message) => problems.push({ row, message, level: 'error' });
  const warn = (row, message) => problems.push({ row, message, level: 'warn' });
  const shiftBy = shiftMap(shifts);
  const staffBy = new Map(staffNames.map((n) => [norm(n), n]));

  if (!rows || !rows.length) { err(1, 'Sheet kosong. Isi mulai dari baris kedua, di bawah judul kolom.'); return { entries, problems }; }

  // header (first non-empty row)
  let h = 0;
  while (h < rows.length && !(rows[h] || []).some((c) => clean(c))) h++;
  const col = {};
  (rows[h] || []).forEach((c, i) => { const k = HEADERS[norm(c)]; if (k && !(k in col)) col[k] = i; });
  if (!('name' in col)) { err(h + 1, 'Kolom "Nama" tidak ditemukan di baris judul.'); return { entries, problems }; }
  if (!('day' in col) && !('date' in col)) { err(h + 1, 'Kolom "Hari" atau "Tanggal" tidak ditemukan di baris judul.'); return { entries, problems }; }
  const get = (r, k) => (k in col ? r[col[k]] : '');

  const open = toMin(opening.open), close = toMin(opening.close);
  const accepted = []; // {entry,row}

  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r.some((c) => clean(c))) continue;
    const row = i + 1;
    const before = problems.length;

    // name
    const rawName = clean(get(r, 'name'));
    let name = null;
    if (!rawName) err(row, 'Nama kosong.');
    else if (!staffBy.has(norm(rawName))) err(row, `Nama "${rawName}" tidak ada di daftar staf.`);
    else name = staffBy.get(norm(rawName));

    // day or date
    const rawDay = clean(get(r, 'day')), rawDate = clean(get(r, 'date'));
    let weekday = null, date = null;
    if (rawDay && rawDate) err(row, 'Isi salah satu saja, Hari atau Tanggal, jangan dua-duanya.');
    else if (rawDay) {
      weekday = DAY_ALIASES[norm(rawDay).replace(/[.,]$/, '')] || null;
      if (!weekday) err(row, `Hari "${rawDay}" tidak dikenal. Pakai Senin sampai Minggu.`);
    } else if (rawDate) {
      date = parseDate(rawDate);
      if (!date) err(row, `Tanggal "${rawDate}" tidak terbaca. Pakai format dd/mm/yyyy.`);
    } else err(row, 'Hari atau Tanggal harus diisi.');

    // kind + shift
    const rawShift = clean(get(r, 'shift')), rawKind = norm(get(r, 'kind'));
    let kind = rawKind ? KIND_ALIASES[rawKind] : null;
    if (rawKind && !kind) err(row, `Jenis "${clean(get(r, 'kind'))}" tidak dikenal. Pilih Kerja, Kuliah, atau Tidak bisa.`);
    const shiftKey = norm(rawShift);
    let shift = null, isLibur = false;
    if (shiftKey === 'libur') isLibur = true;
    else if (shiftKey && shiftKey !== 'custom') {
      shift = shiftBy.get(shiftKey) || null;
      if (!shift) err(row, `Shift "${rawShift}" tidak dikenal. Lihat sheet Shift.`);
    }
    if (isLibur && kind && kind !== 'libur') err(row, 'Shift Libur tidak cocok dengan Jenis ' + clean(get(r, 'kind')) + '.');
    if (kind === 'libur') isLibur = true;
    if (!kind && !isLibur) kind = 'kerja';
    if ((kind === 'kuliah' || kind === 'tidak_bisa') && (shift || isLibur)) err(row, 'Kuliah atau Tidak bisa tidak memakai Shift. Isi jam Mulai dan Selesai.');

    const note = clean(get(r, 'note'));
    if (problems.length > before) continue;

    if (isLibur) {
      accepted.push({ row, entry: { name, ...(weekday ? { weekday } : { date }), kind: 'libur', start: null, end: null, shift: null, note } });
      continue;
    }

    // times
    let start = parseTime(get(r, 'start')), end = parseTime(get(r, 'end'));
    if (start === null) err(row, `Jam Mulai "${clean(get(r, 'start'))}" tidak terbaca. Contoh: 08:00.`);
    if (end === null) err(row, `Jam Selesai "${clean(get(r, 'end'))}" tidak terbaca. Contoh: 18:00.`);
    if (problems.length > before) continue;
    if (shift) {
      if (!start && !end) { start = shift.start; end = shift.end; }
      else {
        if (!start) start = shift.start;
        if (!end) end = shift.end;
        if (start !== shift.start || end !== shift.end)
          warn(row, `Jam ${start} sampai ${end} berbeda dari ${shift.name} (${shift.start} sampai ${shift.end}). Jam yang ditulis dipakai.`);
      }
    }
    if (!start || !end) { err(row, 'Jam Mulai dan Selesai harus diisi (atau pilih salah satu shift).'); continue; }
    if (toMin(end) <= toMin(start)) { err(row, `Jam Selesai (${end}) harus setelah Mulai (${start}).`); continue; }
    if (kind === 'kerja' && (toMin(start) < open || toMin(end) > close)) {
      err(row, `Jam ${start} sampai ${end} di luar jam buka ${opening.open} sampai ${opening.close}.`); continue;
    }
    accepted.push({ row, entry: { name, ...(weekday ? { weekday } : { date }), kind, start, end, shift: shift ? shift.name : null, note } });
  }

  // cross-row checks per person and day
  const groups = new Map();
  for (const a of accepted) {
    const k = `${a.entry.name}|${a.entry.weekday ?? a.entry.date}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  }
  const drop = new Set();
  for (const list of groups.values()) {
    const work = list.filter((a) => a.entry.kind === 'kerja');
    const libur = list.filter((a) => a.entry.kind === 'libur');
    if (libur.length && work.length) {
      for (const a of work) { err(a.row, `${a.entry.name} ditandai Libur dan punya jam kerja di hari yang sama.`); drop.add(a); }
      for (const a of libur) drop.add(a);
      continue;
    }
    const sorted = [...work].sort((a, b) => toMin(a.entry.start) - toMin(b.entry.start));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (toMin(cur.entry.start) < toMin(prev.entry.end)) {
        err(cur.row, `Jam kerja ${cur.entry.start} sampai ${cur.entry.end} bertumpuk dengan baris ${prev.row} (${prev.entry.start} sampai ${prev.entry.end}).`);
        drop.add(cur);
      }
    }
    for (const w of work) for (const u of list.filter((a) => a.entry.kind === 'kuliah' || a.entry.kind === 'tidak_bisa')) {
      if (toMin(w.entry.start) < toMin(u.entry.end) && toMin(u.entry.start) < toMin(w.entry.end))
        warn(w.row, `Jam kerja ${w.entry.start} sampai ${w.entry.end} bertabrakan dengan jam tidak bisa di baris ${u.row}.`);
    }
  }
  for (const a of accepted) if (!drop.has(a)) entries.push(a.entry);
  problems.sort((a, b) => a.row - b.row);
  return { entries, problems };
}
