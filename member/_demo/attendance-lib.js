// Demo only (skipped by the build): the real lib.js helpers with a fake rpc and session.
// Schedule, scans, leave and overtime come from the shared sample data set (sample-data.js).
export * from '/member/js/lib.js?real';
import * as V from './sample-views.js';
import { data, STAFF, MANAGER, WEEKLY, addD, dow, iso } from './sample-data.js';

const SD = data(), today = SD.today;
const at = (hmm, d = today) => `${d}T${hmm}:00+07:00`;
const P = new URLSearchParams(location.search);
const staff = STAFF.map((s) => ({ id: s.id, name: s.name, full_name: s.full_name, role: s.role }));
const meId = 's-ranny'; // the phone / tablet user (Ranny); the owner page is signed in as a manager
const ranny = STAFF.find((s) => s.id === meId);
const myBlock = (d) => (SD.att[meId][d] || []).find((b) => b.kind === 'jadwal');
const nextList = () => (P.get('next') ? P.get('next').split(',') : ['masuk']);
const D = {
  // ?akun=kasir: signed in as the kasir tablet account (whoami role 'staff', kasir_tablet true).
  whoami: P.get('akun') === 'kasir' ? { role: 'staff', kasir_tablet: true, full_name: 'Kasir tablet', username: 'kasir.booth', whatsapp: null }
    : { role: P.get('role') || 'manager', full_name: 'Kevin Hadiyan', username: 'kevinhadiyan', whatsapp: STAFF[3].whatsapp, must_set_password: P.get('pw') === '1' },
  set_first_password: (a) => { if ((a.p_password || '').length < 8) throw new Error('Password minimal 8 karakter.'); D.whoami.must_set_password = false; return D.whoami; },
  att_qr_token: null, att_on_duty: () => V.onDuty(), att_day_report: (a) => V.dayReport(a && a.p_date),
  att_leave_list: () => V.leaveList(), att_overtime_list: () => V.overtimeList(), att_setup: () => V.setup(),
  att_recap: () => V.recapRange({ p_from: today.slice(0, 8) + '01', p_to: today }),
  att_staff_list: () => STAFF.map((s, i) => ({ id: s.id, name: s.name, full_name: s.full_name, role: s.role, whatsapp: s.whatsapp, bank_name: s.bank, bank_account: s.bank ? '12345678' + (90 + i) : null, bank_holder: s.bank ? s.full_name : null,
    device_bound: i !== 2, device_label: i !== 2 ? ['iPhone · Safari', 'Android · Chrome', '', 'Samsung Internet'][i] : null, device_bound_at: i !== 2 ? at('08:01', addD(today, -6)) : null, device_last_seen_at: i !== 2 ? at('08:0' + i) : null })),
  att_status: () => {
    const b = myBlock(today), l = [...myLeave, ...V.leaveList().filter((x) => x.staff_id === meId)];
    return { name: ranny.name, next: nextList(), last: P.get('next') ? { action: 'masuk', at: b ? b.masuk : at('10:58') } : null,
      today_scans: P.get('next') ? [{ action: 'masuk', at: b ? b.masuk : at('10:58'), via: 'qr' }] : [], today_report: [{ flags: [] }],
      week: Array.from({ length: 14 }, (_, i) => { const d = addD(today, i); return { date: d, leave: SD.onLeave(meId, d), blocks: SD.blocksOf(meId, d).map(({ kind, start, end, shift }) => ({ kind, start, end, shift })) }; }),
      leave: l.map(({ id, start, end, reason, status, note }) => ({ id, start, end, reason, status, ...(note ? { note } : {}) })), leave_from: addD(today, 7), location_required: true };
  },
  att_scan: null,
  att_recap_range: (a) => V.recapRange(a), att_week: (a) => V.week(a),
  att_save_shift: null, att_decide_leave: null, att_add_leave: null, att_set_day: null, att_decide_overtime: null, att_correct_add: null, att_correct_void: null, att_correct_day: () => ({ added: 1, voided: 1 }),
};
// Phone, QR and location checks (11 Nov): ?hp=lain = a second phone, ?hp=dipakai = a phone
// already used by another account, ?loc=jauh = 3 km from the booth, ?loc=off = booth
// location not set, ?lokasi=1 on the tablet = booth location already saved.
const locSet = P.get('loc') !== 'off';
// att_qr_token answers only the kasir tablet account (13 Nov 2026).
D.att_location = () => ({ location_set: P.get('lokasi') === '1', radius_m: 200, location_at: P.get('lokasi') === '1' ? at('07:55') : null });
D.att_qr_token = () => (P.get('akun') !== 'kasir' ? (() => { throw new Error('QR presensi hanya tampil di akun kasir tablet. Keluar, lalu masuk dengan akun kasir tablet dari pemilik.'); })() : { token: 'HSA1.29384756.3f9a1c0b7d2e4a61', expires_in: 20 - (Math.floor(Date.now() / 1000) % 20), seconds: 20,
  location_set: P.get('lokasi') === '1', radius_m: 200, location_at: P.get('lokasi') === '1' ? at('07:55') : null });
D.att_scan = (a) => {
  if (P.get('hp') === 'lain') throw new Error('HP ini belum terdaftar untuk presensi akun Anda. Minta manajer atau pemilik reset HP presensi.');
  if (P.get('hp') === 'dipakai') throw new Error('HP ini sudah dipakai presensi akun lain.');
  if (a.p_lat == null || a.p_lng == null) throw new Error('Lokasi HP tidak terbaca. Presensi perlu lokasi untuk memastikan Anda ada di booth. Izinkan lokasi untuk browser ini, nyalakan lokasi HP, lalu scan ulang.');
  if (locSet && P.get('loc') === 'jauh') throw new Error('Lokasi Anda terlalu jauh dari booth (± 3,4 km). Presensi hanya bisa di booth.');
  if (!a.p_device) throw new Error('HP ini belum bisa dikenali.');
  const next = nextList();
  return a.p_action ? { ok: true, action: a.p_action, at: new Date().toISOString(), next: ['istirahat', 'pulang'], phone_bound: !P.get('next'), flags: [] }
    : { ok: true, next, name: ranny.name, ticket: 'HST1.' + Math.floor(Date.now() / 1000) + '.0123456789abcdef', kind: 'absen', flags: locSet ? [] : ['lokasi_booth_belum_diatur'] };
};
D.att_my_schedule = () => ({ today, weekday: dow(today), weekly: V.setup().weekly.filter((w) => w.staff_id === meId),
  dates: SD.days.length ? Array.from({ length: 14 }, (_, i) => addD(today, i)).filter((d) => SD.oneOff.some((e) => e.staff_id === meId && e.date === d)).map((date) => ({ date, blocks: SD.blocksOf(meId, date) })) : [],
  leave: SD.leaves.filter((l) => l.staff_id === meId && l.status === 'disetujui' && l.end >= today && l.start <= addD(today, 13)) });
// Jadwal saya day by day and the profile lock (12 Nov 2026). ?prof=baru = profile not saved yet,
// ?prof=menunggu = a change request waiting, ?prof=ditolak = the last request was refused.
D.att_my_days = (a) => {
  const out = []; for (let d = a.p_from; d <= a.p_to; d = addD(d, 1)) out.push({ date: d, leave: SD.onLeave(meId, d),
    blocks: SD.blocksOf(meId, d).map(({ kind, start, end, shift }) => ({ kind, start, end, shift, changed: SD.oneOff.some((e) => e.staff_id === meId && e.date === d) })) });
  // ?diubah=1: day H+3 changed by a manager (Ranny has no one-off change in the shared sample data).
  const ch = P.get('diubah') && out.find((x) => x.date === addD(today, 3));
  if (ch) ch.blocks = [{ kind: 'kerja', start: '13:00', end: '21:00', shift: 'Siang', changed: true }];
  return { today, days: out };
};
const prof = { full_name: ranny.full_name, whatsapp: ranny.whatsapp, username: 'kevinhadiyan', employer: 'Kaaramel Juice', bank_name: 'BCA', bank_account: '1234567890', bank_holder: ranny.full_name, locked: true, request: null };
if (P.get('prof') === 'baru') Object.assign(prof, { bank_name: null, bank_account: null, bank_holder: null, locked: false });
if (P.get('prof') === 'menunggu') prof.request = { id: 7, changes: { bank_name: 'BNI', bank_account: '0987654321' }, reason: 'Pindah ke rekening BNI', status: 'menunggu', created_at: at('09:10') };
if (P.get('prof') === 'ditolak') prof.request = { id: 6, changes: { bank_holder: 'Ranny P' }, reason: 'Salah ketik', status: 'ditolak', created_at: at('09:10', addD(today, -2)), decided_at: at('12:00', addD(today, -1)), note: 'Nama harus sama dengan buku tabungan' };
D.att_my_profile = () => prof;
// Leave requests and profile saves with the same checks as attendance.sql, so the page's errors can be tried.
const myLeave = [];
D.att_request_leave = (a) => {
  const from = addD(today, 7), e = a.p_end || a.p_start;
  if (!a.p_start) throw new Error('Pilih tanggal izin.');
  if (a.p_start < from) throw new Error(`Izin paling lambat 7 hari sebelumnya (paling cepat ${from.split('-').reverse().join('/')}). Untuk izin mendadak, hubungi pemilik langsung.`);
  if (e < a.p_start) throw new Error('Tanggal selesai harus sama atau setelah tanggal mulai.');
  if (e > addD(a.p_start, 30)) throw new Error('Izin paling lama 31 hari sekali minta.');
  if ((a.p_reason || '').trim().length < 3) throw new Error('Tulis alasan izin.');
  if (myLeave.some((x) => x.status === 'menunggu' && x.start <= e && x.end >= a.p_start)) throw new Error('Sudah ada izin di tanggal itu.');
  const id = 900 + myLeave.length; myLeave.unshift({ id, start: a.p_start, end: e, reason: a.p_reason.trim(), status: 'menunggu' }); return { id, status: 'menunggu' };
};
D.att_cancel_leave = (a) => { const x = myLeave.find((y) => y.id === a.p_id && y.status === 'menunggu'); if (!x) throw new Error('Izin tidak ditemukan atau sudah diputuskan.'); x.status = 'dibatalkan'; return null; };
const acctOf = (v) => String(v || '').replace(/[\s.-]/g, '');
D.att_save_profile = (a) => {
  if (!a.p_staff && prof.locked) throw new Error('Profil sudah tersimpan. Untuk mengubahnya, tekan Minta perubahan.');
  if (!/^[0-9]{5,20}$/.test(acctOf(a.p_bank_account))) throw new Error('Nomor rekening hanya angka, 5 sampai 20 digit.');
  a.p_bank_account = acctOf(a.p_bank_account);
  if (!a.p_staff) Object.assign(prof, { full_name: a.p_full_name, bank_name: a.p_bank_name, bank_account: a.p_bank_account, bank_holder: a.p_bank_holder, locked: true }); return null; };
D.att_request_profile_change = (a) => {
  if (prof.request?.status === 'menunggu') throw new Error('Masih ada permintaan yang menunggu. Batalkan dulu kalau mau mengganti isinya.');
  const ch = typeof a.p_changes === 'string' ? JSON.parse(a.p_changes) : a.p_changes;
  if ('bank_account' in ch && !/^[0-9]{5,20}$/.test(acctOf(ch.bank_account))) throw new Error('Nomor rekening hanya angka, 5 sampai 20 digit.');
  prof.request = { id: 8, changes: typeof a.p_changes === 'string' ? JSON.parse(a.p_changes) : a.p_changes, reason: a.p_reason, status: 'menunggu', created_at: new Date().toISOString() }; return { id: 8 }; };
D.att_cancel_profile_request = () => { prof.request = null; return null; };
const reqs = [{ id: 7, staff_id: meId, name: ranny.name, changes: { bank_name: 'BNI', bank_account: '0987654321' }, reason: 'Pindah ke rekening BNI', status: 'menunggu', created_at: at('09:10'),
  current: { full_name: ranny.full_name, bank_name: 'BCA', bank_account: '1234567890', bank_holder: ranny.full_name } }];
D.att_profile_requests = () => reqs;
D.att_decide_profile_request = (a) => { const r = reqs.find((x) => x.id === a.p_id);
  if (!r || r.status !== 'menunggu') throw new Error('Permintaan tidak ditemukan atau sudah diputuskan.');
  if (!a.p_approve && !(a.p_note || '').trim()) throw new Error('Tulis alasan penolakan.');
  if (r) { r.status = a.p_approve ? 'disetujui' : 'ditolak'; r.note = a.p_note; r.decided_at = new Date().toISOString(); r.decided_by = 'Yuya'; } return null; };
D.att_set_location = (a) => ({ location_set: a.p_lat != null, radius_m: a.p_radius || 200 });
D.att_reset_device = () => ({ reset: true });
export const configured = true;
export async function session() { return true; }
export async function signOut() {}
export async function rpc(name, args = {}) { await new Promise((r) => setTimeout(r, 20)); if (!(name in D)) throw new Error('demo: ' + name); const v = D[name]; return structuredClone(typeof v === 'function' ? v(args) : v); }
