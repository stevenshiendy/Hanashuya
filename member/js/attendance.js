// Attendance (absensi), task 14 of POSDEVELOPMENT.md. Database: supabase/attendance.sql.
//   mountKasirAbsen(panel)  kasir tablet tab "Absen": the rotating QR, who is on duty, and
//                           for managers the day, approvals and corrections.
//   stopKasirAbsen()        stops the QR refresh when the tab is left.
//   mountOwnerAbsensi(panel, { part }) owner page, Tim: one part per menu item (Absen
//                           harian, Per staf, Izin dan cuti, Lembur, Jadwal, Rekap, Profil staf).
//   /staf (staf/index.html) boots the staff phone page (data-page="absen") by itself, with its
//                           own sign-in. member/absen.html only forwards there (Glenn, 13 Nov 2026).
import { configured, $, $$, esc, rpc, busy, notice, toast, time, mountLogin, setupMissing, session, signOut, tabs, prettyPhone, qrSvg } from './lib.js';
import { parseScheduleRows, WEEKDAYS } from './schedule.js';
import { formDialog, confirmDialog } from './data-table.js';

const TZ = 'Asia/Jakarta';
const ACTION = { masuk: 'Masuk', istirahat: 'Istirahat', kembali: 'Kembali', pulang: 'Pulang' };
const KIND = { kerja: 'Kerja', kuliah: 'Kuliah', tidak_bisa: 'Tidak bisa', libur: 'Libur' };
const FLAG = {
  terlambat: ['Terlambat', 'tag-warn'], tidak_hadir: ['Tidak hadir', 'tag-bad'],
  tidak_scan_pulang: ['Tidak scan pulang', 'tag-bad'], tidak_scan_kembali: ['Tidak scan kembali', 'tag-bad'],
  istirahat_lebih: ['Istirahat lebih lama', 'tag-warn'], pulang_awal: ['Pulang lebih awal', 'tag-warn'],
  pulang_lewat: ['Pulang lewat 10 menit', 'tag-warn'], lembur: ['Lembur, perlu disetujui', 'tag-warn'],
  di_luar_jadwal: ['Di luar jadwal', 'tag-warn'], lokasi_kurang_akurat: ['Lokasi kurang akurat', 'tag-warn'],
  lokasi_booth_belum_diatur: ['Jarak tidak dicek: lokasi booth belum disimpan', 'tag-warn'], sedang_bekerja: ['Sedang bekerja', 'tag-ok'], sedang_istirahat: ['Sedang istirahat', 'tag'],
};
const LEAVE = { menunggu: ['Menunggu', 'tag-warn'], disetujui: ['Disetujui', 'tag-ok'], ditolak: ['Ditolak', 'tag-bad'], dibatalkan: ['Dibatalkan', 'tag'] };

const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dmy = (s) => s ? new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(s + 'T00:00:00Z')) : '';
const hm = (min) => { const m = Math.max(0, Math.round(min || 0)); return m >= 60 ? `${Math.floor(m / 60)} j ${m % 60} m` : `${m} m`; };
const tag = ([label, cls]) => `<span class="tag ${cls}">${esc(label)}</span>`;
const flags = (list) => (list || []).map((f) => tag(FLAG[f] || [f, 'tag'])).join(' ');
const range = (b) => b.start ? `${b.start} sampai ${b.end}` : '';
const blockText = (b) => b.kind === 'libur' ? 'Libur' : `${b.kind === 'kerja' ? (b.shift || 'Kerja') : KIND[b.kind]} ${range(b)}`;
const errBox = (p, e) => { p.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; };
const skel = (p) => { p.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>'; };
const state = (next) => next?.[0] === 'masuk' ? 'Belum masuk' : next?.[0] === 'kembali' ? 'Istirahat' : 'Sedang bekerja';

// Times as Indonesians write them (11.00), a block or a day as one short line.
const dot = (s) => (s || '').replace(':', '.');
// A word joiner either side of the dash keeps 11.00–21.00 on one line on narrow phones.
const span = (b) => `${dot(b.start)}\u2060–\u2060${dot(b.end)}`;
const blocksLine = (bl) => !bl?.length ? 'Tidak ada jadwal' : bl.some((b) => b.kind === 'libur') ? 'Libur'
  : bl.map((b) => `${b.kind === 'kerja' ? (b.shift || 'Kerja') : KIND[b.kind]} · ${span(b)}`).join(', ');
const dayLine = (d) => !d ? 'Tidak ada jadwal' : d.leave ? 'Izin' : blocksLine(d.blocks);
const longDate = (s, opt = {}) => new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short', ...opt }).format(new Date(s + 'T00:00:00Z'));
const longRange = (a, b) => a === b ? longDate(a, { year: 'numeric' }) : `${longDate(a)} sampai ${longDate(b, { year: 'numeric' })}`;
const monday = (s) => addDays(s, -((new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7));
const addMonths = (s, n) => { const d = new Date(s.slice(0, 8) + '01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

// One period for Rekap and Per staf, kept while the page is open.
const PERIODS = [['minggu-ini', 'Minggu ini'], ['minggu-lalu', 'Minggu lalu'], ['bulan-ini', 'Bulan ini'], ['bulan-lalu', 'Bulan lalu'], ['custom', 'Custom']];
let period = { key: 'bulan-ini', from: null, to: null };
function periodRange(key = period.key) {
  const t = ymd(), m = monday(t), first = t.slice(0, 8) + '01';
  if (key === 'minggu-ini') return [m, addDays(m, 6)];
  if (key === 'minggu-lalu') return [addDays(m, -7), addDays(m, -1)];
  if (key === 'bulan-lalu') return [addMonths(first, -1), addDays(first, -1)];
  if (key === 'custom' && period.from && period.to) return [period.from, period.to];
  return [first, addDays(addMonths(first, 1), -1)];
}
const periodBar = () => {
  const [f, t] = periodRange();
  return `<div class="rep-range" role="group" aria-label="Periode">
    ${PERIODS.map(([k, l]) => `<button class="btn btn-quiet" type="button" data-period="${k}" aria-pressed="${period.key === k}">${l}</button>`).join('')}
    <span class="att-custom"${period.key === 'custom' ? '' : ' hidden'}>
      <label>Dari<input type="date" data-pf value="${f}"></label><label>Sampai<input type="date" data-pt value="${t}"></label>
      <button class="btn" type="button" data-papply>Tampilkan</button></span></div>`;
};
function wirePeriod(p, reload) {
  $$('[data-period]', p).forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.period !== 'custom') { period = { key: b.dataset.period, from: null, to: null }; return reload(); }
    $$('[data-period]', p).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('.att-custom', p).hidden = false; $('[data-pf]', p).focus();
  }));
  $('[data-papply]', p)?.addEventListener('click', () => {
    const f = $('[data-pf]', p).value, t = $('[data-pt]', p).value;
    if (!f || !t) return toast('Isi tanggal dari dan sampai.');
    if (t < f) return toast('Tanggal sampai harus sesudah tanggal dari.');
    period = { key: 'custom', from: f, to: t }; reload();
  });
}

// Names open the Per staf view (owner menu item, or the part button on the tablet).
let pickStaff = null;
const nameBtn = (id, label) => `<button class="btn btn-text att-name" type="button" data-staff-open="${esc(id)}">${esc(label)}</button>`;
function wireNames(p) {
  $$('[data-staff-open]', p).forEach((b) => b.addEventListener('click', () => {
    pickStaff = b.dataset.staffOpen;
    const t = document.querySelector('[role="tab"][data-tab="absen-staf"]') || document.querySelector('[data-part="staf"]');
    if (t) { t.click(); t.focus(); }
  }));
}

// Owner or manager types a staff member's name and bank details (att_save_profile).
// 13 Nov 2026: only the owner types another person's bank details (att_save_profile);
// a manager may fill in the name of a profile that isn't saved yet.
function bankForm(box, s, onDone, owner = true) {
  box.innerHTML = `<form class="stack att-bank" novalidate>
    <div class="form-grid">
      <label class="field"><span>Nama lengkap <span class="hint is-req">wajib</span></span><input type="text" data-k="full" value="${esc(s.full_name || '')}" maxlength="80" autocomplete="off" required></label>
      ${owner ? '' : '<p class="muted small">Rekening diisi oleh staf sendiri lewat Profil saya, atau oleh pemilik.</p>'}
      ${owner ? `<label class="field"><span>Bank</span><input type="text" data-k="bank" value="${esc(s.bank_name || '')}" maxlength="40" placeholder="Contoh: BCA" autocomplete="off"></label>
      <label class="field"><span>Nomor rekening</span><input type="text" data-k="acct" value="${esc(s.bank_account || '')}" inputmode="numeric" autocomplete="off"></label>
      <label class="field"><span>Nama pemilik rekening</span><input type="text" data-k="holder" value="${esc(s.bank_holder || '')}" maxlength="80" autocomplete="off"></label>` : ''}
    </div>
    <div class="notice" data-k="msg" hidden></div>
    <div class="row"><button class="btn" type="submit">Simpan</button><button class="btn btn-quiet" type="button" data-k="no">Batal</button></div>
  </form>`;
  const f = box.firstElementChild, v = (k) => $(`[data-k="${k}"]`, f);
  v('full').focus();
  v('no').addEventListener('click', () => onDone(false));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', f);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('att_save_profile', { p_staff: s.id, p_full_name: v('full').value, p_bank_name: owner ? v('bank').value : (s.bank_name || ''), p_bank_account: owner ? v('acct').value : (s.bank_account || ''), p_bank_holder: owner ? v('holder').value : (s.bank_holder || '') });
      toast('Profil tersimpan'); onDone(true);
    } catch (err) { notice(v('msg'), err.message); busy(btn, false); }
  });
}

/* ======================================================== kasir tablet */
// The QR changes every `seconds` (att_qr_seconds, 20 since 11 Nov 2026); the tablet
// fetches a new one when the server says the window ends and counts down to it.
let qrTimer = null, qrTick = null, qrCount = null;
export function stopKasirAbsen() { clearTimeout(qrTimer); clearInterval(qrCount); qrTimer = null; qrTick = null; qrCount = null; }

export async function mountKasirAbsen(panel) {
  stopKasirAbsen();
  let who = null;
  try { who = await rpc('whoami'); } catch { /* the QR still works */ }
  const manager = ['manager', 'owner'].includes(who?.role);
  // Only the kasir tablet account shows the QR (att_qr_token refuses the rest).
  const device = !!who?.kasir_tablet;
  panel.innerHTML = `
  <section class="panel stack join-inner" aria-labelledby="ab-title">
    <h2 id="ab-title">Presensi staf</h2>
    ${device || !who ? `<p class="muted" id="ab-lead">Scan QR ini dengan HP Anda sendiri, masuk dengan akun staf Anda.</p>
    <div class="join-qr" id="ab-qr" style="width:min(80vw,24rem)" role="img" aria-label="QR presensi"></div>
    <p class="muted small num" id="ab-count" aria-hidden="true"></p>`
    : `<p id="ab-lead">QR presensi hanya tampil di akun kasir tablet. Keluar, lalu masuk dengan akun kasir tablet dari pemilik. Akun staf pribadi dipakai untuk scan dari HP masing-masing.</p>`}
    <div class="notice" id="ab-msg" hidden></div>
  </section>
  <section class="panel stack" aria-labelledby="ab-duty-title">
    <h2 id="ab-duty-title">Sedang bertugas</h2>
    <div id="ab-duty"><p class="muted">Memuat…</p></div>
  </section>
  ${manager ? '<div id="ab-manage" class="stack-lg"></div>' : ''}`;
  let endsAt = 0;
  const count = () => {
    const el = $('#ab-count', panel);
    if (!el) return;
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    el.textContent = endsAt ? `QR baru dalam ${left} detik` : '';
  };
  const loadDuty = async () => {
    const duty = await rpc('att_on_duty');
    $('#ab-duty', panel).innerHTML = duty.length ? `<ul class="list">${duty.map((d) => `<li><span class="grow"><strong>${esc(d.name)}</strong><br>
      <span class="muted small">Masuk ${d.since ? esc(time(d.since)) : ''}</span></span>${d.status === 'istirahat' ? tag(['Istirahat', 'tag']) : tag(['Bekerja', 'tag-ok'])}</li>`).join('')}</ul>`
      : '<p class="muted">Belum ada yang masuk.</p>';
  };
  const tick = async () => {
    if (!panel.isConnected || panel.hidden) return stopKasirAbsen();
    let wait = 10;
    try {
      if (who && !device) { await loadDuty(); qrTimer = setTimeout(tick, 30000); return; }
      const t = await rpc('att_qr_token');
      $('#ab-qr', panel).innerHTML = qrSvg(location.origin + '/staf/#t=' + t.token);
      $('#ab-lead', panel).textContent = `Scan QR ini dengan HP Anda sendiri, masuk dengan akun staf Anda. QR berganti setiap ${t.seconds} detik.`;
      notice($('#ab-msg', panel), '');
      wait = Math.max(1, t.expires_in) + 0.3;
      endsAt = Date.now() + Math.max(1, t.expires_in) * 1000;
      count();
      await loadDuty();
    } catch (e) { endsAt = 0; count(); notice($('#ab-msg', panel), e.message); }
    if (qrTick === tick) qrTimer = setTimeout(tick, wait * 1000);
  };
  qrTick = tick;
  clearInterval(qrCount);
  qrCount = setInterval(count, 1000);
  tick();
  if (manager) mountManage($('#ab-manage', panel), { owner: who.role === 'owner', compact: true });
}
// A tablet that wakes up gets a fresh QR at once.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && qrTick) { clearTimeout(qrTimer); qrTick(); }
});

// The phone's location, once. { lat, lng, acc } or { error: 'denied' | 'timeout' | 'unavailable' | 'unsupported' }.
function getLocation(timeout = 10000) {
  if (!navigator.geolocation) return Promise.resolve({ error: 'unsupported' });
  return new Promise((res) => navigator.geolocation.getCurrentPosition(
    (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
    (e) => res({ error: e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable' }),
    { enableHighAccuracy: true, timeout, maximumAge: 15000 }));
}
const LOC_ERR = {
  denied: 'Izin lokasi ditolak. Izinkan lokasi untuk browser ini, lalu coba lagi.',
  timeout: 'Lokasi belum terbaca dalam waktu yang cukup. Coba lagi di dekat jendela.',
  unavailable: 'Lokasi tidak tersedia. Nyalakan lokasi atau Wi-Fi perangkat, lalu coba lagi.',
  unsupported: 'Perangkat ini tidak bisa membaca lokasi.',
};

// Owner or manager: save the booth location from the device in hand, at the booth
// (att_set_location). Shown at the top of Presensi harian (13 Nov 2026: the tablet now runs
// on the kasir tablet account, which may not move the location).
function locPanel(box, t) {
  const st = { set: t.location_set, radius: t.radius_m || 200, at: t.location_at };
  const draw = (found = null) => {
    box.innerHTML = `
    <h2 id="ab-loc-title">Lokasi booth</h2>
    <p class="muted small">${st.set
      ? `Tersimpan${st.at ? ' ' + esc(dmy(ymd(new Date(st.at)))) : ''}. Presensi hanya diterima dari HP yang berada dalam ${st.radius} m dari titik ini.`
      : 'Belum disimpan. Staf tetap wajib menyalakan lokasi saat presensi, tapi jaraknya ke booth baru dicek setelah lokasi booth disimpan.'}</p>
    <label class="field" style="max-width:14rem"><span>Jarak presensi (meter)</span>
      <input type="number" id="ab-loc-r" min="50" max="2000" step="10" value="${st.radius}" inputmode="numeric"></label>
    ${found ? `<p>Lokasi perangkat terbaca, akurasi ± ${Math.round(found.acc)} m.${found.acc > 100 ? ' Kurang tepat: coba di dekat jendela atau tunggu sebentar.' : ''}</p>
      <div class="row"><button class="btn" type="button" id="ab-loc-save">Simpan lokasi ini</button>
      <button class="btn btn-quiet" type="button" id="ab-loc-cancel">Batal</button></div>`
    : `<div class="row"><button class="btn btn-quiet" type="button" id="ab-loc-get">Simpan lokasi booth dari perangkat ini</button>
      ${st.set ? '<button class="btn btn-text" type="button" id="ab-loc-clear">Hapus lokasi</button>' : ''}</div>
      <p class="muted small">Pakai tombol ini saat Anda ada di booth.</p>`}
    <div class="notice" id="ab-loc-msg" hidden></div>`;
    const msg = $('#ab-loc-msg', box), radius = () => Number($('#ab-loc-r', box).value) || st.radius;
    $('#ab-loc-get', box)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget; // currentTarget is null after the first await
      busy(btn, true, 'Membaca lokasi…');
      const r = await getLocation(15000);
      if (r.error) { busy(btn, false); return notice(msg, LOC_ERR[r.error]); }
      st.radius = radius(); draw(r);
    });
    $('#ab-loc-cancel', box)?.addEventListener('click', () => draw());
    const save = async (btn, lat, lng, acc) => {
      busy(btn, true, 'Menyimpan…');
      try {
        const r = await rpc('att_set_location', { p_lat: lat, p_lng: lng, p_radius: radius(), p_acc: acc });
        Object.assign(st, { set: r.location_set, radius: r.radius_m, at: r.location_set ? new Date().toISOString() : null });
        toast(r.location_set ? 'Lokasi booth tersimpan' : 'Lokasi booth dihapus'); draw();
      } catch (err) { busy(btn, false); notice(msg, err.message); }
    };
    $('#ab-loc-save', box)?.addEventListener('click', (e) => save(e.currentTarget, found.lat, found.lng, found.acc));
    $('#ab-loc-clear', box)?.addEventListener('click', (e) => save(e.currentTarget, null, null, null));
  };
  draw();
}

/* ======================================================== owner page */
// With { part } (owner menu, one feature per view, Glenn 12 Nov): only that part, one of
// 'hari', 'setuju', 'jadwal', 'rekap', 'profil'. Without it, the old page with a switch.
// 'setuju' (leave and overtime together) stays for the manager tablet view; the owner menu
// has 'izin' and 'lembur' as two items (Glenn, 11 Nov).
const PARTS = { hari: dayPart, staf: staffPart, setuju: approvePart, izin: (p, o) => approvePart(p, o, 'izin'), lembur: (p, o) => approvePart(p, o, 'lembur'),
  jadwal: schedulePart, rekap: recapPart, profil: profilePart };
// On the owner page each part is the whole view, so its first title is the page h1 (Glenn, 12 Nov 2026:
// "titles must be the same size wherever"); inside the manager's Absensi switch it stays an h2.
const hx = (el) => (el.closest('[data-top]') ? 'h1' : 'h2');
export function mountOwnerAbsensi(panel, { part } = {}) {
  if (PARTS[part]) { panel.innerHTML = '<div class="stack-lg" data-top></div>'; return PARTS[part](panel.firstElementChild, { owner: true }); }
  mountManage(panel, { owner: true });
}

// Shared by the owner page and the manager view on the tablet.
function mountManage(root, { owner, compact = false }) {
  const parts = [['hari', 'Hari ini'], ['staf', 'Per staf'], ['setuju', 'Persetujuan'], ['jadwal', 'Jadwal'], ['rekap', 'Rekap'], ['profil', 'Profil staf']];
  root.innerHTML = `
  <div class="panel stack">
    <div class="row-between"><h2>${compact ? 'Presensi (manajer)' : 'Presensi'}</h2></div>
    <div class="rep-range" role="group" aria-label="Bagian presensi">
      ${parts.map(([k, l], i) => `<button class="btn btn-quiet" type="button" data-part="${k}" aria-pressed="${i === 0}">${l}</button>`).join('')}
    </div>
  </div>
  <div id="am-body" class="stack-lg"></div>`;
  const body = $('#am-body', root);
  const show = (k) => {
    $$('[data-part]', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.part === k)));
    PARTS[k](body, { owner });
  };
  $$('[data-part]', root).forEach((b) => b.addEventListener('click', () => show(b.dataset.part)));
  show('hari');
}

/* ---------- one day: a table with one row per person (Glenn, 14 Nov 2026: "simplify presensi
   harian"). Jadwal, Masuk, Istirahat, Pulang and one Keterangan column; every correction
   (add a forgotten scan or cancel one) goes through one Koreksi dialog per person. */
function dayRow(x, isToday) {
  const live = x.scans.filter((s) => !s.voided);
  const first = (a) => live.find((s) => s.action === a);
  const last = (a) => [...live].reverse().find((s) => s.action === a);
  const sched = x.report.filter((r) => r.kind !== 'di_luar_jadwal');
  const jadwal = !sched.length ? '<span class="muted">Tidak ada jadwal</span>'
    : sched.map((r) => r.kind === 'izin' ? tag(['Izin', 'tag-warn']) : `<span class="dp-block">${esc(r.shift || 'Jadwal')} <span class="num muted">${esc(span(r))}</span></span>`).join('');
  const brk = x.report.reduce((n, r) => n + (r.break_min || 0), 0);
  const onBreak = isToday && x.next?.[0] === 'kembali';
  const masuk = first('masuk'), pulang = last('pulang'), lastBreak = last('istirahat');
  // Keterangan: what is happening now (today only), then anything that needs a look.
  const notes = [];
  if (isToday) {
    if (onBreak) notes.push(['Istirahat', 'tag']);
    else if (masuk && !pulang) notes.push(['Sedang bekerja', 'tag-ok']);
    else if (!masuk && sched.some((r) => r.kind !== 'izin')) notes.push(['Belum masuk', 'tag']);
  }
  const late = x.report.reduce((n, r) => n + (r.late_min || 0), 0);
  if (late) notes.push([`Terlambat ${hm(late)}`, 'tag-warn']);
  const seen = new Set(['terlambat']);
  x.report.forEach((r) => r.flags.forEach((f) => { if (!f.startsWith('sedang_') && !seen.has(f)) { seen.add(f); notes.push(FLAG[f] || [f, 'tag']); } }));
  const fixed = x.scans.filter((s) => s.voided || s.via === 'koreksi').length;
  if (fixed) notes.push([`${fixed} koreksi`, 'tag']);
  const t = (s) => s ? `<span class="num">${esc(dot(time(s.at)))}</span>` : '<span class="muted">–</span>';
  return `<tr>
    <th scope="row">${nameBtn(x.id, x.full_name || x.name)}</th>
    <td>${jadwal}</td>
    <td>${t(masuk)}</td>
    <td>${onBreak && lastBreak ? `sejak ${t(lastBreak)}` : brk ? `<span class="num">${esc(hm(brk))}</span>` : '<span class="muted">–</span>'}</td>
    <td>${t(pulang)}</td>
    <td><span class="dp-notes">${notes.map(tag).join('') || '<span class="muted">–</span>'}</span></td>
    <td class="dp-act">${x.is_me ? '<span class="muted small">Akun Anda</span>' : `<button class="btn btn-quiet" type="button" data-fix="${esc(x.id)}">Koreksi</button>`}</td></tr>`;
}

function fixDialog(x, date, done) {
  const live = x.scans.filter((s) => !s.voided);
  const hist = x.scans.length ? `<ul class="list dp-hist">${x.scans.map((s) => `<li><span class="grow"><span class="num">${esc(dot(time(s.at)))}</span> ${ACTION[s.action]}
      ${s.via === 'koreksi' ? `<span class="muted small">ditambah: ${esc(s.reason)}</span>` : ''}
      ${s.voided ? `<span class="muted small">dibatalkan: ${esc(s.void_reason)}</span>` : ''}</span>${s.voided ? tag(['Dibatalkan', 'tag-bad']) : ''}</li>`).join('')}</ul>`
    : '<p class="muted small">Belum ada scan di tanggal ini.</p>';
  return formDialog({
    title: `Koreksi presensi ${x.full_name || x.name}`,
    submitLabel: 'Simpan koreksi',
    html: `<div class="stack-sm"><p class="h-small">Scan ${esc(dmy(date))}</p>${hist}</div>
      <label class="field"><span>Yang dikoreksi</span><select name="what">
        <option value="add">Tambah scan yang lupa</option>
        ${live.map((s) => `<option value="${s.id}">Batalkan scan ${esc(dot(time(s.at)))} ${ACTION[s.action]}</option>`).join('')}</select></label>
      <div class="form-grid" data-addonly>
        <label class="field"><span>Scan</span><select name="action">${Object.entries(ACTION).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <label class="field"><span>Jam <span class="hint is-req">wajib</span></span><input type="time" name="at"></label></div>
      <label class="field"><span>Alasan <span class="hint is-req">wajib</span></span><input type="text" name="reason" placeholder="Contoh: lupa scan pulang" required></label>
      <p class="muted small">Setiap koreksi tercatat dengan nama Anda dan alasannya.</p>`,
    onOpen: (f) => { const sync = () => { $('[data-addonly]', f).hidden = f.elements.what.value !== 'add'; }; f.elements.what.addEventListener('change', sync); sync(); },
    onSubmit: async (f) => {
      const what = f.elements.what.value, reason = f.elements.reason.value;
      if (what === 'add') {
        if (!f.elements.at.value) throw new Error('Isi jamnya.');
        await rpc('att_correct_add', { p_staff: x.id, p_action: f.elements.action.value, p_at: `${date}T${f.elements.at.value}:00+07:00`, p_reason: reason });
      } else await rpc('att_correct_void', { p_event: Number(what), p_reason: reason });
      toast('Koreksi tersimpan'); done();
    },
  });
}

async function dayPart(p, opts, date = ymd()) {
  skel(p);
  let d;
  try { d = await rpc('att_day_report', { p_date: date }); } catch (e) { return errBox(p, e); }
  const isToday = d.date === ymd();
  p.innerHTML = `
  <section class="panel stack">
    <div class="row-between"><div class="stack-sm"><${hx(p)}>Presensi per hari</${hx(p)}><p class="muted">${esc(longDate(d.date, { weekday: 'long', year: 'numeric' }))}</p></div>
      <label class="field"><span class="visually-hidden">Tanggal</span><input type="date" id="am-date" value="${esc(d.date)}" max="${ymd()}"></label></div>
    ${d.people.length ? `<div class="table-wrap"><table class="att-day">
      <thead><tr><th scope="col">Staf</th><th scope="col">Jadwal</th><th scope="col">Masuk</th><th scope="col">Istirahat</th><th scope="col">Pulang</th><th scope="col">Keterangan</th><th scope="col"><span class="visually-hidden">Koreksi</span></th></tr></thead>
      <tbody>${d.people.map((x) => dayRow(x, isToday)).join('')}</tbody></table></div>
    <p class="muted small">Lupa scan atau scan salah? Tekan Koreksi di baris orangnya. Ketuk nama untuk rincian per staf.</p>` : '<p class="muted">Belum ada akun staf.</p>'}
  </section>`;
  $('#am-date', p).addEventListener('change', (e) => e.target.value && dayPart(p, opts, e.target.value));
  wireNames(p);
  $$('[data-fix]', p).forEach((b) => b.addEventListener('click', () => fixDialog(d.people.find((x) => x.id === b.dataset.fix), d.date, () => dayPart(p, opts, d.date))));
  // Lokasi booth, under the day (owner or manager, from a device at the booth).
  const loc = document.createElement('section');
  loc.className = 'panel stack'; loc.id = 'ab-loc'; loc.setAttribute('aria-labelledby', 'ab-loc-title');
  p.append(loc);
  rpc('att_location').then((t) => { if (loc.isConnected) locPanel(loc, t); }).catch(() => loc.remove());
}

/* ---------- leave and overtime approvals */
// which: 'izin' (Izin dan cuti), 'lembur' (Lembur) or nothing for both (manager tablet).
async function approvePart(p, opts, which) {
  const again = () => approvePart(p, opts, which);
  const lv = which !== 'lembur', ov = which !== 'izin';
  const hl = opts?.only ? 'h2' : hx(p);
  skel(p);
  let leave, ot, setup;
  try { [leave, ot, setup] = await Promise.all([rpc('att_leave_list'), rpc('att_overtime_list', {}), rpc('att_setup')]); } catch (e) { return errBox(p, e); }
  // Per staf (Glenn, 12 Nov 2026): opts.only keeps one person's requests and fixes the form to them.
  if (opts?.only) {
    leave = leave.filter((l) => l.staff_id === opts.only);
    ot = ot.filter((o) => o.staff_id === opts.only);
    setup = { ...setup, staff: setup.staff.filter((s) => s.id === opts.only) };
  }
  const pending = leave.filter((l) => l.status === 'menunggu');
  const otOpen = ot.filter((o) => o.status === 'menunggu');
  p.innerHTML = `
  ${lv ? `<section class="panel stack" aria-labelledby="am-lv">
    <${hl} id="am-lv">Izin menunggu (${pending.length})</${hl}>
    ${pending.length ? `<ul class="list">${pending.map((l) => `<li><span class="grow"><strong>${esc(l.name)}</strong>, ${esc(dmy(l.start))}${l.end !== l.start ? ' sampai ' + esc(dmy(l.end)) : ''}<br>
      <span class="muted small">${esc(l.reason)}</span></span>
      ${l.is_me ? '<span class="muted small">Izin Anda sendiri</span>' : `<span class="row ap-actions"><button class="btn ap-btn" type="button" data-leave="${l.id}" data-ok="1">Setujui</button>
      <button class="btn btn-quiet ap-btn" type="button" data-leave="${l.id}" data-ok="0">Tolak</button></span>`}</li>`).join('')}</ul>` : '<p class="muted">Tidak ada izin yang menunggu.</p>'}
    <div class="notice" id="am-lv-msg" hidden></div>
  </section>` : ''}
  ${ov ? `<section class="panel stack" aria-labelledby="am-ot">
    <${hl} id="am-ot">Lembur 14 hari terakhir</${hl}>
    <p class="muted small">Lembur dihitung dari jam selesai jadwal, kalau pulang 20 menit atau lebih setelahnya. Baru dihitung setelah disetujui.</p>
    ${ot.length ? `<ul class="list">${ot.map((o) => `<li><span class="grow"><strong>${esc(o.name)}</strong>, ${esc(dmy(o.date))}, jadwal ${esc(o.start)} sampai ${esc(o.end)}<br>
      <span class="muted small">Pulang ${esc(time(o.pulang))}, lembur ${hm(o.minutes)}${o.status !== 'menunggu' ? `. ${o.status === 'disetujui' ? `Disetujui ${hm(o.approved_min)}` : 'Ditolak'} oleh ${esc(o.decided_by || '')}` : ''}</span></span>
      ${o.is_me ? '<span class="muted small">Lembur Anda sendiri</span>' : `<span class="row ap-actions">
        <label class="field"><span class="visually-hidden">Menit disetujui</span><input type="number" min="0" max="${o.minutes}" value="${o.approved_min ?? o.minutes}" data-otmin="${esc(o.staff_id + o.date + o.start)}" style="width:6rem" inputmode="numeric"></label>
        <button class="btn ap-btn" type="button" data-ot="1" data-s="${esc(o.staff_id)}" data-d="${esc(o.date)}" data-b="${esc(o.start)}">Setujui</button>
        <button class="btn btn-quiet ap-btn" type="button" data-ot="0" data-s="${esc(o.staff_id)}" data-d="${esc(o.date)}" data-b="${esc(o.start)}">Tolak</button></span>`}</li>`).join('')}</ul>`
      : '<p class="muted">Tidak ada lembur.</p>'}
    ${otOpen.length ? `<p class="small">${otOpen.length} lembur belum diputuskan.</p>` : ''}
    <div class="notice" id="am-ot-msg" hidden></div>
  </section>` : ''}
  ${lv ? `<form class="panel stack" id="am-addlv" novalidate aria-labelledby="am-addlv-t">
    <h2 id="am-addlv-t">Catat izin langsung</h2>
    <p class="muted small">Untuk izin mendadak (sakit, keadaan darurat) yang disampaikan lewat WhatsApp. Langsung disetujui.</p>
    <div class="form-grid">
      ${opts?.only ? `<input type="hidden" id="am-lv-staff" value="${esc(opts.only)}">` : `<label class="field"><span>Staf</span><select id="am-lv-staff">${setup.staff.map((s) => `<option value="${esc(s.id)}">${esc(s.full_name || s.name)}</option>`).join('')}</select></label>`}
      <label class="field"><span>Mulai <span class="hint is-req">wajib</span></span><input type="date" id="am-lv-start" required></label>
      <label class="field"><span>Sampai <span class="hint">kosongkan kalau 1 hari</span></span><input type="date" id="am-lv-end"></label>
      <label class="field"><span>Alasan <span class="hint is-req">wajib</span></span><input type="text" id="am-lv-reason" required placeholder="Contoh: sakit, ada surat dokter"></label>
    </div>
    <div class="notice" id="am-addlv-msg" hidden></div>
    <button class="btn" type="submit" style="justify-self:start">Catat izin</button>
  </form>
  <section class="panel stack" aria-labelledby="am-lvh">
    <h2 id="am-lvh">Riwayat izin</h2>
    ${leave.filter((l) => l.status !== 'menunggu').length ? `<ul class="list">${leave.filter((l) => l.status !== 'menunggu').map((l) => `<li><span class="grow">${esc(l.name)}, ${esc(dmy(l.start))}${l.end !== l.start ? ' sampai ' + esc(dmy(l.end)) : ''}<br>
      <span class="muted small">${esc(l.reason)}${l.decided_by ? ', oleh ' + esc(l.decided_by) : ''}</span></span>${tag(LEAVE[l.status])}</li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}
  </section>` : ''}`;
  $$('[data-leave]', p).forEach((b) => b.addEventListener('click', async () => {
    busy(b, true);
    try { await rpc('att_decide_leave', { p_id: Number(b.dataset.leave), p_approve: b.dataset.ok === '1', p_note: null }); toast(b.dataset.ok === '1' ? 'Izin disetujui' : 'Izin ditolak'); again(); }
    catch (e) { notice($('#am-lv-msg', p), e.message); busy(b, false); }
  }));
  $$('[data-ot]', p).forEach((b) => b.addEventListener('click', async () => {
    const mins = Number($(`[data-otmin="${CSS.escape(b.dataset.s + b.dataset.d + b.dataset.b)}"]`, p)?.value);
    busy(b, true);
    try {
      await rpc('att_decide_overtime', { p_staff: b.dataset.s, p_date: b.dataset.d, p_block_start: b.dataset.b, p_approve: b.dataset.ot === '1', p_minutes: Number.isFinite(mins) ? mins : null, p_note: null });
      toast(b.dataset.ot === '1' ? 'Lembur disetujui' : 'Lembur ditolak'); again();
    } catch (e) { notice($('#am-ot-msg', p), e.message); busy(b, false); }
  }));
  $('#am-addlv', p)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('att_add_leave', { p_staff: $('#am-lv-staff', p).value, p_start: $('#am-lv-start', p).value || null, p_end: $('#am-lv-end', p).value || null, p_reason: $('#am-lv-reason', p).value });
      toast('Izin tercatat'); again();
    } catch (err) { notice($('#am-addlv-msg', p), err.message); busy(btn, false); }
  });
}

/* ---------- shifts and schedule */
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembaca file Excel gagal dimuat. Periksa internet.'));
    document.head.append(s);
  });
}
// The template explains itself (Glenn, 14 Nov 2026: "make the templates easier to understand"):
// each header carries its hint in brackets (schedule.js ignores the bracket), shift rows leave
// the times empty, Jenis is empty for plain work, people are grouped with a blank row between,
// and a Cara mengisi sheet shows numbered steps plus example rows.
const HEADER = ['Nama', 'Hari (Senin sampai Minggu)', 'Tanggal (satu tanggal saja, dd/mm/yyyy)', 'Shift (lihat sheet Shift, atau Libur)',
  'Mulai (kalau tanpa shift)', 'Selesai (kalau tanpa shift)', 'Jenis (kosong = kerja)', 'Catatan'];
const toRow = (e, nameOf, shifts) => {
  const nm = nameOf(e.staff_id) || e.name;
  const hari = e.weekday ? WEEKDAYS[e.weekday - 1] : '', tgl = e.date ? e.date.split('-').reverse().join('/') : '';
  if (e.kind === 'libur') return [nm, hari, tgl, 'Libur', '', '', '', e.note || ''];
  if (e.kind !== 'kerja') return [nm, hari, tgl, '', e.start, e.end, KIND[e.kind], e.note || ''];
  const sh = shifts.find((x) => x.name === e.shift);
  const same = sh && sh.start === e.start && sh.end === e.end;
  return [nm, hari, tgl, e.shift || '', same ? '' : e.start, same ? '' : e.end, '', e.note || ''];
};

async function downloadTemplate(setup) {
  await loadSheetJS();
  const X = window.XLSX, wb = X.utils.book_new();
  const nameOf = (id) => setup.staff.find((s) => s.id === id)?.name;
  const active = setup.shifts.filter((s) => s.active);
  const order = (e) => [setup.staff.findIndex((s) => s.id === e.staff_id), e.date ? 10 : 0, e.weekday || 0, e.date || '', e.start || ''];
  const cmp = (a, b) => { const x = order(a), y = order(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; };
  const saved = [...setup.weekly, ...setup.dates.filter((e) => e.date >= setup.today)].sort(cmp);
  const rows = [];
  if (saved.length) saved.forEach((e, i) => { if (i && e.staff_id !== saved[i - 1].staff_id) rows.push([]); rows.push(toRow(e, nameOf, active)); });
  // Nothing saved yet: one Libur row per person and day, ready to overwrite.
  else setup.staff.forEach((s, i) => { if (i) rows.push([]); WEEKDAYS.forEach((d) => rows.push([s.name, d, '', 'Libur', '', '', '', ''])); });
  const ws = X.utils.aoa_to_sheet([HEADER, ...rows]);
  ws['!cols'] = [14, 16, 20, 22, 12, 12, 14, 30].map((wch) => ({ wch }));
  X.utils.book_append_sheet(wb, ws, 'Jadwal');

  const who = setup.staff[0]?.name || 'Nama', sh1 = active[0], sh2 = active[1] || active[0];
  const ex = [
    [who, 'Senin', '', sh1 ? sh1.name : 'Fulltime 1', '', '', '', `Kerja ${sh1 ? sh1.name : 'shift'} setiap Senin, jamnya ikut shift`],
    [who, 'Selasa', '', 'Libur', '', '', '', 'Libur setiap Selasa'],
    [who, 'Rabu', '', '', '13:00', '17:00', '', 'Kerja di luar shift: kosongkan Shift, isi jamnya'],
    [who, 'Kamis', '', '', '08:00', '12:00', 'Kuliah', 'Jam kuliah, tidak bisa dijadwalkan kerja'],
    [who, 'Kamis', '', sh2 ? sh2.name : 'Parttime 2', '', '', '', 'Hari yang sama boleh dua baris'],
    [who, '', '24/12/2026', 'Libur', '', '', '', 'Satu tanggal saja, menggantikan jadwal mingguan hari itu'],
  ];
  const help = [
    ['Cara mengisi jadwal staf'], [''],
    ['1. Isi sheet Jadwal. Satu baris = satu orang, satu hari, satu blok jam.'],
    ['2. Jadwal yang sama setiap minggu: isi kolom Hari. Untuk satu tanggal saja (tukar shift, libur khusus): isi kolom Tanggal dan kosongkan Hari.'],
    ['3. Kerja sesuai shift: tulis nama shift persis seperti di sheet Shift. Jam Mulai dan Selesai dikosongkan, jamnya ikut shift.'],
    ['4. Kerja di luar shift: kosongkan Shift, lalu isi Mulai dan Selesai, contoh 13:00 dan 17:00.'],
    ['5. Tidak masuk: tulis Libur di kolom Shift.'],
    ['6. Kuliah atau jam lain yang tidak bisa kerja: tulis Kuliah atau Tidak bisa di kolom Jenis, lalu isi Mulai dan Selesai. Kolom Jenis kosong berarti kerja.'],
    ['7. Simpan file, lalu unggah di halaman Jadwal. Aplikasi menunjukkan baris yang salah sebelum ada yang disimpan.'],
    [''], ['Contoh'], HEADER.map((h) => h.replace(/\s*\(.*$/, '')), ...ex, [''],
    ['Perlu diingat'],
    ['Nama ditulis persis seperti di aplikasi: ' + setup.staff.map((s) => s.name).join(', ') + '.'],
    [`Jam kerja harus di dalam jam buka booth, ${setup.opening.open} sampai ${setup.opening.close}.`],
    ['Orang yang ada di file ini: jadwal mingguannya diganti isi file. Orang yang tidak ada di file: jadwalnya tetap.'],
    ['Baris kosong boleh dibiarkan.'],
  ];
  const wh = X.utils.aoa_to_sheet(help);
  wh['!cols'] = [16, 10, 12, 14, 8, 8, 10, 60].map((wch) => ({ wch }));
  X.utils.book_append_sheet(wb, wh, 'Cara mengisi');
  const sh = X.utils.aoa_to_sheet([['Tulis di kolom Shift', 'Mulai', 'Selesai', 'Istirahat'],
    ...active.map((s) => [s.name, s.start, s.end, `${s.break_minutes} menit`]), ['Libur', '', '', 'tidak masuk']]);
  sh['!cols'] = [{ wch: 20 }, { wch: 9 }, { wch: 9 }, { wch: 14 }];
  X.utils.book_append_sheet(wb, sh, 'Shift');
  X.writeFile(wb, `jadwal-staf-${ymd()}.xlsx`);
}

// Names the parser accepts: full names, plus first names that only one person has.
function staffNames(setup) {
  const map = new Map();
  const firsts = setup.staff.map((s) => s.name.toLowerCase());
  setup.staff.forEach((s) => {
    if (s.full_name) map.set(s.full_name, s.id);
    if (firsts.filter((f) => f === s.name.toLowerCase()).length === 1) map.set(s.name, s.id);
  });
  return map;
}

/* ---------- week overview (read-only), Jadwal */
let weekStart = null;
const weekCell = (d) => {
  if (d.leave) return tag(['Izin', 'tag-warn']);
  if (!d.blocks.length) return '<span class="muted">Kosong</span>';
  const own = d.one_off ? '<span class="att-wb is-note">Tanggal khusus</span>' : '';
  if (d.blocks.some((b) => b.kind === 'libur')) return `<span class="att-wb is-off">Libur</span>${own}`;
  return d.blocks.map((b) => `<span class="att-wb${b.kind === 'kerja' ? '' : ' muted'}">${esc(b.kind === 'kerja' ? (b.shift || 'Kerja') : KIND[b.kind])}
    <span class="num small">${esc(span(b))}</span></span>`).join('') + own;
};
async function weekGrid(box) {
  box.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  let w;
  try { w = await rpc('att_week', { p_start: weekStart || ymd() }); } catch (e) { return errBox(box, e); }
  const dates = Array.from({ length: 7 }, (_, i) => addDays(w.start, i)), thisWeek = w.start === monday(w.today);
  box.innerHTML = `
    <div class="row-between">
      <div class="stack-sm"><${hx(box)} id="am-wg">${thisWeek ? 'Jadwal minggu ini' : 'Jadwal per minggu'}</${hx(box)}><p class="muted">${esc(longRange(w.start, w.end))}</p></div>
      <div class="row" role="group" aria-label="Pilih minggu">
        <button class="btn btn-quiet" type="button" data-wk="-7">Sebelumnya</button>
        <button class="btn btn-quiet" type="button" data-wk="0"${thisWeek ? ' disabled' : ''}>Minggu ini</button>
        <button class="btn btn-quiet" type="button" data-wk="7">Berikutnya</button></div></div>
    <p class="muted small">Sudah termasuk tanggal khusus dan izin yang disetujui. Ubah lewat Pola mingguan atau Tanggal khusus di bawah. Ketuk nama untuk rincian presensinya.</p>
    ${w.people.length ? `<div class="table-wrap"><table class="att-week">
      <thead><tr><th scope="col">Staf</th>${dates.map((d, i) => `<th scope="col"${d === w.today ? ' class="is-today" aria-current="date"' : ''}>${WEEKDAYS[i].slice(0, 3)}
        <span class="num">${esc(longDate(d))}</span></th>`).join('')}</tr></thead>
      <tbody>${w.people.map((x) => `<tr><th scope="row">${nameBtn(x.id, x.name)}</th>${x.days.map((d) => `<td${d.date === w.today ? ' class="is-today"' : ''}>${weekCell(d)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">Belum ada akun staf.</p>'}`;
  $$('[data-wk]', box).forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.wk);
    weekStart = n ? addDays(w.start, n) : null;
    weekGrid(box).then(() => $(`[data-wk="${n}"]`, box)?.focus());
  }));
  wireNames(box);
}

/* ---------- Pilihan shift. 'kartu' = design A (a card per shift, Ubah opens the card as a
   form; Glenn picks, 11 Nov), 'tabel' = the old row-per-shift table. Drafts A, B, C:
   Hanashuya Drafts/pos-kasir/shift-drafts.html. */
const SHIFT_EDITOR = 'kartu';
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
function shiftCards(sec, setup, reload, editing = null) {
  const blank = { id: 'baru', name: '', start: '', end: '', break_minutes: 60, active: true };
  const form = (s) => `<form class="stack sh-form" novalidate aria-labelledby="sh-f-t">
    <h3 class="h-small" id="sh-f-t">${s.id === 'baru' ? 'Shift baru' : 'Ubah ' + esc(s.name)}</h3>
    <label class="field"><span>Nama shift <span class="hint is-req">wajib</span></span><input type="text" data-f="name" value="${esc(s.name)}" maxlength="30" required placeholder="Contoh: Fulltime 3" autocomplete="off"></label>
    <div class="sh-times">
      <label class="field"><span>Mulai <span class="hint is-req">wajib</span></span><input type="time" data-f="start" value="${esc(s.start)}" required></label>
      <label class="field"><span>Selesai <span class="hint is-req">wajib</span></span><input type="time" data-f="end" value="${esc(s.end)}" required></label>
      <label class="field"><span>Istirahat (menit)</span><input type="number" data-f="break" min="0" max="240" step="5" value="${s.break_minutes}" inputmode="numeric"></label>
    </div>
    <label class="sw"><input type="checkbox" role="switch" data-f="active"${s.active ? ' checked' : ''}><span class="sw-track" aria-hidden="true"></span><span>Aktif, bisa dipilih di jadwal</span></label>
    <div class="notice" data-f="msg" hidden></div>
    <div class="row"><button class="btn" type="submit">${s.id === 'baru' ? 'Tambah shift' : 'Simpan'}</button><button class="btn btn-quiet" type="button" data-f="no">Batal</button></div>
  </form>`;
  const card = (s) => String(s.id) === String(editing) ? `<li class="sh-card is-editing" data-shift="${s.id}">${form(s)}</li>`
    : `<li class="sh-card${s.active ? '' : ' is-off'}" data-shift="${s.id}">
      <div class="row-between"><p class="sh-name">${esc(s.name)}</p>${s.active ? '' : tag(['Nonaktif', 'tag'])}</div>
      <p class="sh-time num">${esc(dot(s.start))}–${esc(dot(s.end))}</p>
      <p class="muted small">Istirahat ${s.break_minutes} menit · ${esc(hm(toMin(s.end) - toMin(s.start) - s.break_minutes))} kerja</p>
      <button class="btn btn-quiet sh-edit" type="button" data-sh-edit="${s.id}" aria-label="Ubah shift ${esc(s.name)}">Ubah</button></li>`;
  sec.innerHTML = `
    <div class="stack-sm"><h2 id="am-sh">Pilihan shift</h2>
      <p class="muted small">Jam kerja yang dipakai berulang. Nama shift ini yang ditulis di jadwal dan di file Excel. Shift yang dimatikan tidak muncul lagi sebagai pilihan, jadwal lama tetap.</p></div>
    <ul class="sh-cards">${setup.shifts.map(card).join('')}
      ${editing === 'baru' ? card(blank) : '<li class="sh-card sh-new"><button class="sh-add" type="button" data-sh-edit="baru">Tambah shift</button></li>'}</ul>`;
  $$('[data-sh-edit]', sec).forEach((b) => b.addEventListener('click', () => shiftCards(sec, setup, reload, b.dataset.shEdit)));
  const f = $('.sh-form', sec);
  if (!f) return;
  const v = (k) => $(`[data-f="${k}"]`, f), s = setup.shifts.find((x) => String(x.id) === String(editing)) || blank;
  v('name').focus();
  v('no').addEventListener('click', () => { shiftCards(sec, setup, reload); $(`[data-sh-edit="${editing}"]`, sec)?.focus(); });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', f);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('att_save_shift', { p_id: s.id === 'baru' ? null : Number(s.id), p_name: v('name').value, p_start: v('start').value, p_end: v('end').value,
        p_break: Number(v('break').value), p_active: v('active').checked });
      toast('Shift tersimpan'); reload();
    } catch (err) { notice(v('msg'), err.message); busy(btn, false); }
  });
}

async function schedulePart(p) {
  skel(p);
  let setup;
  try { setup = await rpc('att_setup'); } catch (e) { return errBox(p, e); }
  const shiftOpts = (sel) => `<option value="">Custom</option>${setup.shifts.filter((s) => s.active).map((s) => `<option value="${esc(s.name)}" ${s.name === sel ? 'selected' : ''}>${esc(s.name)} (${esc(s.start)} sampai ${esc(s.end)})</option>`).join('')}`;
  const cell = (id, wd) => {
    const bl = setup.weekly.filter((e) => e.staff_id === id && e.weekday === wd);
    const short = (b) => b.kind === 'libur' ? 'Libur' : b.kind === 'kerja' && b.shift ? b.shift : `${b.kind === 'kerja' ? '' : KIND[b.kind] + ' '}${b.start}–${b.end}`;
    return bl.length ? bl.map((b) => `<span style="display:block" class="${b.kind === 'kerja' ? '' : 'muted'}">${esc(short(b))}</span>`).join('') : '<span class="muted">Kosong</span>';
  };
  p.innerHTML = `
  <section class="panel stack" id="am-weekgrid" aria-labelledby="am-wg"></section>
  ${SHIFT_EDITOR === 'tabel' ? `<section class="panel stack" aria-labelledby="am-sh">
    <h2 id="am-sh">Pilihan shift</h2>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Nama</th><th scope="col">Mulai</th><th scope="col">Selesai</th><th scope="col">Istirahat (menit)</th><th scope="col">Aktif</th><th scope="col"><span class="visually-hidden">Simpan</span></th></tr></thead>
      <tbody>${[...setup.shifts, { id: '', name: '', start: '', end: '', break_minutes: 60, active: true }].map((s) => `<tr data-shift="${s.id}">
        <td><input type="text" value="${esc(s.name)}" data-f="name" aria-label="Nama shift" placeholder="${s.id ? '' : 'Shift baru'}"></td>
        <td><input type="time" value="${esc(s.start)}" data-f="start" aria-label="Mulai"></td>
        <td><input type="time" value="${esc(s.end)}" data-f="end" aria-label="Selesai"></td>
        <td><input type="number" min="0" max="240" value="${s.break_minutes}" data-f="break" aria-label="Istirahat dalam menit" style="width:6rem"></td>
        <td><input type="checkbox" ${s.active ? 'checked' : ''} data-f="active" aria-label="Aktif"></td>
        <td><button class="btn btn-quiet" type="button" data-save-shift>${s.id ? 'Simpan' : 'Tambah'}</button></td></tr>`).join('')}</tbody>
    </table></div>
    <div class="notice" id="am-sh-msg" hidden></div>
  </section>` : '<section class="panel stack" id="am-shifts" aria-labelledby="am-sh"></section>'}
  <section class="panel stack" aria-labelledby="am-up">
    <h2 id="am-up">Isi jadwal lewat Excel</h2>
    <ol class="small stack-sm" style="padding-left:1.25rem;margin:0">
      <li>Unduh file jadwal. Isinya jadwal yang tersimpan sekarang, plus sheet Cara mengisi dengan contoh.</li>
      <li>Ubah di Excel atau Google Sheets: satu baris untuk satu orang dan satu hari. Tulis nama shift, atau Libur.</li>
      <li>Unggah lagi. Baris yang salah ditunjukkan dulu, belum ada yang disimpan sampai Anda menekan Simpan.</li></ol>
    <div class="row"><button class="btn btn-quiet" type="button" id="am-tpl">Unduh file jadwal</button>
      <button class="btn" type="button" id="am-pick">Unggah file .xlsx</button><input type="file" id="am-file" accept=".xlsx,.xls,.csv" hidden></div>
    <div id="am-preview" class="stack"></div>
  </section>
  <section class="panel stack" aria-labelledby="am-wk">
    <h2 id="am-wk">Pola mingguan</h2>
    <p class="muted small">Jadwal yang berulang setiap minggu. Ketuk satu kotak untuk mengubah hari itu.</p>
    <div class="table-wrap"><table>
      <thead><tr><th scope="col">Staf</th>${WEEKDAYS.map((d) => `<th scope="col">${d}</th>`).join('')}</tr></thead>
      <tbody>${setup.staff.map((s) => `<tr><th scope="row">${esc(s.name)}</th>${WEEKDAYS.map((_, i) => `<td><button class="btn btn-text small" type="button" data-cell="${esc(s.id)}" data-wd="${i + 1}" style="display:block;text-align:left;white-space:nowrap">${cell(s.id, i + 1)}</button></td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <h3 class="h-small">Tanggal khusus</h3>
    ${setup.dates.length ? `<ul class="list">${[...new Set(setup.dates.map((e) => e.staff_id + '|' + e.date))].map((k) => {
      const [sid, dt] = k.split('|'); const bl = setup.dates.filter((e) => e.staff_id === sid && e.date === dt);
      return `<li><span class="grow"><strong>${esc(bl[0].name)}</strong>, ${esc(dmy(dt))}<br><span class="muted small">${bl.map((b) => esc(blockText(b))).join(', ')}</span></span>
        <button class="btn btn-text" type="button" data-cell="${esc(sid)}" data-date="${esc(dt)}">Ubah</button></li>`;
    }).join('')}</ul>` : '<p class="muted small">Belum ada. Tanggal khusus menggantikan jadwal mingguan di hari itu.</p>'}
    <button class="btn btn-quiet" type="button" id="am-newdate" style="justify-self:start">Atur tanggal khusus</button>
  </section>
  <form class="panel stack" id="am-edit" hidden novalidate>
    <h2 id="am-edit-title">Ubah jadwal</h2>
    <div class="form-grid" id="am-edit-who">
      <label class="field"><span>Staf</span><select id="am-edit-staff">${setup.staff.map((s) => `<option value="${esc(s.id)}">${esc(s.full_name || s.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Tanggal</span><input type="date" id="am-edit-date"></label>
    </div>
    <div id="am-blocks" class="stack-sm"></div>
    <div class="row"><button class="btn btn-quiet" type="button" id="am-addblock">Tambah blok jam</button>
      <button class="btn btn-quiet" type="button" id="am-libur">Jadikan libur</button></div>
    <p class="muted small">Tanpa blok jam: hari itu kosong (untuk tanggal khusus, kembali ke jadwal mingguan).</p>
    <div class="notice" id="am-edit-msg" hidden></div>
    <div class="row"><button class="btn" type="submit">Simpan</button><button class="btn btn-quiet" type="button" id="am-edit-no">Batal</button></div>
  </form>`;

  weekGrid($('#am-weekgrid', p));
  if (SHIFT_EDITOR !== 'tabel') shiftCards($('#am-shifts', p), setup, () => schedulePart(p));
  // shift options (old table)
  $$('[data-save-shift]', p).forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'), f = (k) => $(`[data-f="${k}"]`, tr);
    busy(b, true);
    try {
      await rpc('att_save_shift', { p_id: tr.dataset.shift ? Number(tr.dataset.shift) : null, p_name: f('name').value, p_start: f('start').value, p_end: f('end').value, p_break: Number(f('break').value), p_active: f('active').checked });
      toast('Shift tersimpan'); schedulePart(p);
    } catch (e) { notice($('#am-sh-msg', p), e.message); busy(b, false); }
  }));

  // upload
  $('#am-tpl', p).addEventListener('click', async (e) => { const b = e.currentTarget; busy(b, true); try { await downloadTemplate(setup); } catch (err) { toast(err.message); } busy(b, false); });
  $('#am-pick', p).addEventListener('click', () => $('#am-file', p).click());
  $('#am-file', p).addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    const out = $('#am-preview', p);
    out.innerHTML = '<p class="muted">Membaca…</p>';
    try {
      await loadSheetJS();
      const book = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = book.Sheets.Jadwal || book.Sheets[book.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      const names = staffNames(setup);
      const r = parseScheduleRows(rows, { shifts: setup.shifts.filter((s) => s.active), staffNames: [...names.keys()], opening: setup.opening });
      const entries = r.entries.map((x) => ({ ...x, staff_id: names.get(x.name) }));
      const errs = r.problems.filter((x) => x.level === 'error');
      const people = [...new Set(entries.map((x) => x.staff_id))];
      out.innerHTML = `
        ${r.problems.length ? `<div class="notice ${errs.length ? 'notice-error' : 'notice-warn'}" role="${errs.length ? 'alert' : 'status'}">
          <p>${errs.length ? `${errs.length} baris tidak terbaca. Perbaiki di file, lalu unggah lagi. Belum ada yang disimpan.` : 'Ada catatan, jadwal tetap bisa disimpan.'}</p>
          <ul>${r.problems.map((x) => `<li>Baris ${x.row}: ${esc(x.message)}${x.level === 'warn' ? ' (catatan)' : ''}</li>`).join('')}</ul></div>` : ''}
        <p>${entries.length} baris terbaca untuk ${people.length} orang.</p>
        <div class="table-wrap"><table><thead><tr><th scope="col">Staf</th><th scope="col">Hari atau tanggal</th><th scope="col">Jadwal</th></tr></thead>
          <tbody>${entries.map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.weekday ? WEEKDAYS[x.weekday - 1] : dmy(x.date))}</td><td>${esc(blockText(x))}${x.note ? ` <span class="muted small">${esc(x.note)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
        <div class="notice" id="am-up-msg" hidden></div>
        ${entries.length && !errs.length ? '<button class="btn" type="button" id="am-save-up" style="justify-self:start">Simpan jadwal ini</button>' : ''}`;
      $('#am-save-up', out)?.addEventListener('click', async (ev) => {
        const b = ev.currentTarget; busy(b, true, 'Menyimpan…');
        try { const s = await rpc('att_replace_schedule', { p_entries: entries }); toast(`${s.saved} baris jadwal tersimpan`); schedulePart(p); }
        catch (err) { notice($('#am-up-msg', out), err.message); busy(b, false); }
      });
    } catch (err) { out.innerHTML = `<div class="notice notice-error" role="alert">${esc(err.message)}</div>`; }
  });

  // edit one day by hand
  let edit = null;
  const blockRow = (b = { kind: 'kerja', shift: '', start: '', end: '' }) => `<div class="form-grid" data-block>
    <label class="field"><span>Jenis</span><select data-b="kind">${['kerja', 'kuliah', 'tidak_bisa'].map((k) => `<option value="${k}" ${b.kind === k ? 'selected' : ''}>${KIND[k]}</option>`).join('')}</select></label>
    <label class="field"><span>Shift</span><select data-b="shift">${shiftOpts(b.shift)}</select></label>
    <label class="field"><span>Mulai</span><input type="time" data-b="start" value="${esc(b.start || '')}"></label>
    <label class="field"><span>Selesai</span><input type="time" data-b="end" value="${esc(b.end || '')}"></label>
    <button class="btn btn-text" type="button" data-rm>Hapus blok</button></div>`;
  const wire = () => {
    $$('[data-rm]', p).forEach((b) => { b.onclick = () => b.closest('[data-block]').remove(); });
    $$('[data-b="shift"]', p).forEach((s) => { s.onchange = () => {
      const sh = setup.shifts.find((x) => x.name === s.value), row = s.closest('[data-block]');
      if (sh) { $('[data-b="start"]', row).value = sh.start; $('[data-b="end"]', row).value = sh.end; }
    }; });
  };
  const openEdit = (sid, wd, dt) => {
    edit = { sid, wd, dt, libur: false };
    const list = wd ? setup.weekly.filter((e) => e.staff_id === sid && e.weekday === wd) : setup.dates.filter((e) => e.staff_id === sid && e.date === dt);
    edit.libur = list.some((e) => e.kind === 'libur');
    const nm = setup.staff.find((s) => s.id === sid)?.name || '';
    $('#am-edit-title', p).textContent = wd ? `${nm}, setiap ${WEEKDAYS[wd - 1]}` : dt ? `${nm}, ${dmy(dt)}` : 'Tanggal khusus';
    $('#am-edit-who', p).hidden = !!wd || !!dt;
    $('#am-blocks', p).innerHTML = edit.libur ? '<p>Libur</p>' : list.map(blockRow).join('');
    wire();
    $('#am-edit', p).hidden = false; notice($('#am-edit-msg', p), '');
    $('#am-edit', p).scrollIntoView({ block: 'nearest' });
  };
  $$('[data-cell]', p).forEach((b) => b.addEventListener('click', () => openEdit(b.dataset.cell, b.dataset.wd ? Number(b.dataset.wd) : null, b.dataset.date || null)));
  $('#am-newdate', p).addEventListener('click', () => openEdit(null, null, null));
  $('#am-addblock', p).addEventListener('click', () => {
    if (edit.libur) { edit.libur = false; $('#am-blocks', p).innerHTML = ''; }
    $('#am-blocks', p).insertAdjacentHTML('beforeend', blockRow()); wire();
  });
  $('#am-libur', p).addEventListener('click', () => { edit.libur = true; $('#am-blocks', p).innerHTML = '<p>Libur</p>'; });
  $('#am-edit-no', p).addEventListener('click', () => { $('#am-edit', p).hidden = true; });
  $('#am-edit', p).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    const sid = edit.sid || $('#am-edit-staff', p).value, dt = edit.wd ? null : (edit.dt || $('#am-edit-date', p).value || null);
    const blocks = edit.libur ? [{ kind: 'libur' }] : $$('[data-block]', p).map((r) => {
      const v = (k) => $(`[data-b="${k}"]`, r).value;
      return { kind: v('kind'), shift: v('kind') === 'kerja' ? v('shift') : '', start: v('start'), end: v('end') };
    });
    busy(btn, true, 'Menyimpan…');
    try {
      if (!edit.wd && !dt) throw new Error('Pilih tanggalnya.');
      await rpc('att_set_day', { p_staff: sid, p_weekday: edit.wd, p_date: dt, p_blocks: blocks });
      toast('Jadwal tersimpan'); schedulePart(p);
    } catch (err) { notice($('#am-edit-msg', p), err.message); busy(btn, false); }
  });
}

/* ---------- recap for any period (Glenn, 11 Nov: week, month or custom) */
const hours = (m) => (Math.round((m / 60) * 100) / 100).toLocaleString('id-ID');
const DAY_KIND = { izin: 'Izin', jadwal: 'Jadwal', di_luar_jadwal: 'Di luar jadwal' };
async function recapPart(p, opts) {
  const [from, to] = periodRange();
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="am-rc">
    <div class="stack-sm"><h2 id="am-rc">Rekap presensi</h2><p class="muted" id="am-rc-range">${esc(longRange(from, to))}</p></div>
    ${periodBar()}
    <div id="am-rc-body" class="stack"><div class="skeleton"></div><div class="skeleton"></div></div>
  </section>`;
  wirePeriod(p, () => recapPart(p, opts));
  const body = $('#am-rc-body', p);
  let r;
  try { r = await rpc('att_recap_range', { p_from: from, p_to: to, p_staff: null }); } catch (e) { return errBox(body, e); }
  $('#am-rc-range', p).textContent = `${longRange(from, to)} · ${r.days_in_range} hari`;
  body.innerHTML = `
    <p class="muted small">Hanya jam dan hitungan, tanpa hitungan gaji. Lembur dihitung setelah disetujui. Ketuk nama untuk melihat rinciannya.</p>
    ${r.people.length ? `<div class="table-wrap"><table>
      <thead><tr><th scope="col">Staf</th><th scope="col">Hari kerja</th><th scope="col">Jam kerja</th><th scope="col">Terlambat</th><th scope="col">Istirahat</th>
        <th scope="col">Lembur disetujui</th><th scope="col">Izin</th><th scope="col">Scan terlewat</th><th scope="col">Tidak hadir</th></tr></thead>
      <tbody>${r.people.map((x) => `<tr><th scope="row">${nameBtn(x.id, x.full_name || x.name)}</th><td class="num">${x.days_worked}</td><td class="num">${hours(x.worked_min)}</td>
        <td class="num">${x.late_count}× (${x.late_min} m)</td><td class="num">${hm(x.break_min)}${x.break_over_count ? `, ${x.break_over_count}× lebih` : ''}</td>
        <td class="num">${hm(x.overtime_approved_min)}${x.overtime_candidate_min > x.overtime_approved_min ? ` <span class="muted small">dari ${hm(x.overtime_candidate_min)}</span>` : ''}</td>
        <td class="num">${x.leave_days} hari</td><td class="num">${x.missing_scans}</td><td class="num">${x.absent_count}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">Belum ada akun staf.</p>'}
    <div class="notice" id="am-rc-msg" hidden></div>
    <button class="btn" type="button" id="am-xlsx" style="justify-self:start">Unduh .xlsx untuk gaji</button>
    <p class="muted small">File berisi nomor rekening staf. Simpan di tempat pribadi dan jangan dibagikan di grup.</p>`;
  wireNames(body);
  $('#am-xlsx', p).addEventListener('click', async (e) => {
    const b = e.currentTarget; busy(b, true, 'Menyiapkan…');
    try {
      await loadSheetJS();
      const X = window.XLSX, wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.json_to_sheet(r.people.map((x) => ({
        Nama: x.full_name, WhatsApp: x.whatsapp, Dari: from, Sampai: to, 'Hari kerja': x.days_worked, 'Jam kerja': hours(x.worked_min), 'Menit kerja': x.worked_min,
        'Terlambat (kali)': x.late_count, 'Terlambat (menit)': x.late_min, 'Istirahat (menit)': x.break_min, 'Istirahat lebih dari batas (kali)': x.break_over_count,
        'Pulang awal (menit)': x.early_min, 'Lembur diajukan (menit)': x.overtime_candidate_min, 'Lembur disetujui (menit)': x.overtime_approved_min,
        'Izin (hari)': x.leave_days, 'Tidak hadir': x.absent_count, 'Scan terlewat': x.missing_scans,
        Bank: x.bank_name || '', 'Nomor rekening': x.bank_account || '', 'Nama pemilik rekening': x.bank_holder || '' }))), 'Rekap');
      const det = r.people.flatMap((x) => x.days.map((d) => ({ Nama: x.full_name, Tanggal: d.date, Jenis: DAY_KIND[d.kind] || d.kind,
        Shift: d.shift || '', Mulai: d.start || '', Selesai: d.end || '', Masuk: d.masuk ? time(d.masuk) : '', Pulang: d.pulang ? time(d.pulang) : '',
        'Menit kerja': d.worked_min, 'Istirahat (menit)': d.break_min, 'Terlambat (menit)': d.late_min, 'Pulang awal (menit)': d.early_min, 'Lembur (menit)': d.overtime_min,
        Catatan: (d.flags || []).map((f) => (FLAG[f] || [f])[0]).join(', ') })));
      X.utils.book_append_sheet(wb, det.length ? X.utils.json_to_sheet(det) : X.utils.aoa_to_sheet([['Kosong']]), 'Rincian');
      const lv = r.people.flatMap((x) => (x.leaves || []).map((l) => ({ Nama: x.full_name, Mulai: l.start, Sampai: l.end, Alasan: l.reason, Status: (LEAVE[l.status] || [l.status])[0] })));
      if (lv.length) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(lv), 'Izin');
      X.writeFile(wb, `presensi-${from}-sampai-${to}.xlsx`);
    } catch (err) { notice($('#am-rc-msg', p), err.message); }
    busy(b, false);
  });
}

/* ---------- one staff member: today, weekly pattern, totals, days, leave, bank */
async function staffPart(p, opts) {
  skel(p);
  let setup, week;
  try { [setup, week] = await Promise.all([rpc('att_setup'), rpc('att_week', { p_start: ymd() })]); } catch (e) { return errBox(p, e); }
  if (!setup.staff.length) { p.innerHTML = `<section class="panel stack"><${hx(p)}>Per staf</${hx(p)}><p class="muted">Belum ada akun staf.</p></section>`; return; }
  if (!setup.staff.some((s) => s.id === pickStaff)) pickStaff = setup.staff[0].id;
  const me = setup.staff.find((s) => s.id === pickStaff);
  const today = week.people.find((x) => x.id === me.id)?.days.find((d) => d.date === week.today);
  const [from, to] = periodRange();
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="am-ps">
    ${hx(p) === 'h1' ? '<h1>Per staf</h1>' : ''}
    <div class="rep-range" role="group" aria-label="Pilih staf">
      ${setup.staff.map((s) => `<button class="btn btn-quiet" type="button" data-pick="${esc(s.id)}" aria-pressed="${s.id === me.id}">${esc(s.name)}</button>`).join('')}
    </div>
    <div class="stack-sm">
      <h2 id="am-ps">${esc(me.full_name || me.name)} ${me.role === 'manager' ? tag(['Manajer', 'tag']) : ''}</h2>
      <p class="att-today"><span class="muted">Hari ini:</span> <strong>${esc(dayLine(today))}</strong></p>
    </div>
    <div class="att-pattern" role="list" aria-label="Jadwal mingguan">
      ${WEEKDAYS.map((d, i) => { const bl = setup.weekly.filter((e) => e.staff_id === me.id && e.weekday === i + 1);
        return `<div role="listitem" class="att-pat${week.today && (new Date(week.today + 'T00:00:00Z').getUTCDay() + 6) % 7 === i ? ' is-today' : ''}"><span class="small muted">${d}</span>
          ${bl.length ? bl.map((b) => `<span class="small${b.kind === 'kerja' ? '' : ' muted'}">${esc(b.kind === 'libur' ? 'Libur' : `${b.kind === 'kerja' ? (b.shift || 'Kerja') : KIND[b.kind]}`)}${b.kind === 'libur' ? '' : `<br><span class="num">${esc(span(b))}</span>`}</span>`).join('') : '<span class="small muted">Kosong</span>'}</div>`; }).join('')}
    </div>
  </section>
  <section class="panel stack" aria-labelledby="am-ps-per">
    <div class="stack-sm"><h2 id="am-ps-per">Presensi</h2><p class="muted" id="am-ps-range">${esc(longRange(from, to))}</p></div>
    ${periodBar()}
    <div id="am-ps-body" class="stack-lg"><div class="skeleton"></div><div class="skeleton"></div></div>
  </section>
  <div id="am-ps-izin" class="stack-lg"></div>
  <div id="am-ps-prof" class="stack-lg"></div>`;
  // Per staf covers every Tim function for one person (Glenn, 12 Nov 2026): izin (waiting,
  // Catat izin, history) and the profile (WhatsApp, rekening, HP presensi) sit under the absen.
  approvePart($('#am-ps-izin', p), { ...opts, only: me.id }, 'izin');
  profilePart($('#am-ps-prof', p), { ...opts, only: me.id });
  const again = () => staffPart(p, opts);
  $$('[data-pick]', p).forEach((b) => b.addEventListener('click', () => { pickStaff = b.dataset.pick; again(); }));
  wirePeriod(p, again);
  let r;
  try { r = await rpc('att_recap_range', { p_from: from, p_to: to, p_staff: me.id }); } catch (e) { return errBox($('#am-ps-body', p), e); }
  const x = r.people[0];
  if (!x) return errBox($('#am-ps-body', p), new Error('Staf ini tidak ditemukan.'));
  $('#am-ps-range', p).textContent = `${longRange(from, to)} · ${r.days_in_range} hari`;
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  const days = x.days.filter((d) => d.kind !== 'jadwal' || d.masuk || (d.flags || []).length || d.date <= ymd());
  $('#am-ps-body', p).innerHTML = `
    <div class="stats">
      ${stat(x.days_worked, 'Hari kerja')}${stat(hours(x.worked_min), 'Jam kerja')}${stat(`${x.late_count}×`, `Terlambat, ${x.late_min} menit`)}
      ${stat(`${x.break_over_count}×`, 'Istirahat lebih lama')}${stat(hm(x.overtime_approved_min), 'Lembur disetujui')}
      ${stat(x.leave_days, 'Hari izin')}${stat(x.absent_count, 'Tidak hadir')}${stat(x.missing_scans, 'Scan terlewat')}
      ${x.work_target_min != null ? stat(hm(x.short_min || 0), `Kurang dari target ${hm(x.work_target_min)}/hari`) : ''}
    </div>
    ${x.work_target_min != null ? `<form class="row" id="am-ps-target" novalidate>
      <label class="field"><span>Jam kerja per hari <span class="hint">dari scan QR presensi, di luar istirahat</span></span>
        <input type="number" inputmode="decimal" min="1" max="12" step="0.5" value="${x.work_target_min / 60}" style="width:7rem"></label>
      <button class="btn btn-quiet" type="submit" style="align-self:end">Simpan</button>
      <span class="small" role="status" data-st style="align-self:end"></span></form>` : ''}
    ${days.length ? `<div class="table-wrap"><table>
      <thead><tr><th scope="col">Tanggal</th><th scope="col">Jadwal</th><th scope="col">Masuk</th><th scope="col">Pulang</th><th scope="col">Kerja</th><th scope="col">Istirahat</th><th scope="col">Catatan</th></tr></thead>
      <tbody>${days.map((d) => `<tr><th scope="row">${esc(dmy(d.date))}</th>
        <td>${esc(d.kind === 'izin' ? 'Izin' : d.kind === 'di_luar_jadwal' ? 'Di luar jadwal' : `${d.shift || 'Jadwal'} ${d.start ? `${dot(d.start)}–${dot(d.end)}` : ''}`)}</td>
        <td class="num">${d.masuk ? esc(time(d.masuk)) : '–'}</td><td class="num">${d.pulang ? esc(time(d.pulang)) : '–'}</td>
        <td class="num">${d.worked_min ? hm(d.worked_min) : '–'}</td><td class="num">${d.break_min ? hm(d.break_min) : '–'}</td>
        <td>${flags((d.flags || []).filter((f) => !f.startsWith('sedang_'))) || ''}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="muted">Tidak ada hari kerja di periode ini.</p>'}`;
  // Daily working-time target (Glenn, 12 Nov 2026): 9 hours for full-timers, 5 for Kevin.
  $('#am-ps-target', p)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget, h = Number(f.querySelector('input').value), st = f.querySelector('[data-st]');
    if (!(h >= 1 && h <= 12)) { st.textContent = 'Isi 1 sampai 12 jam.'; return; }
    const btn = f.querySelector('button'); busy(btn, true, 'Menyimpan…');
    try { await rpc('att_set_work_target', { p_staff: me.id, p_min: Math.round(h * 60) }); toast('Jam kerja per hari tersimpan'); again(); }
    catch (err) { busy(btn, false); st.textContent = err.message; }
  });
}

/* ---------- staff profiles (bank details: managers and owner only) */
async function profilePart(p, opts) {
  skel(p);
  let list, reqs = [];
  try { list = await rpc('att_staff_list'); } catch (e) { return errBox(p, e); }
  // Profile change requests (12 Nov 2026); hidden until attendance.sql with them has run.
  try { reqs = await rpc('att_profile_requests'); } catch { reqs = []; }
  if (opts?.only) list = list.filter((s) => s.id === opts.only);
  const mine = reqs.filter((r) => !opts?.only || r.staff_id === opts.only);
  const others = opts?.only ? reqs.filter((r) => r.status === 'menunggu' && r.staff_id !== opts.only) : [];
  const reqHtml = !mine.length && !others.length ? '' : `<section class="panel stack" aria-labelledby="am-prq">
    <h2 id="am-prq">Permintaan ubah profil</h2>
    ${mine.map((r) => `<div class="stack-sm att-prq" data-rq="${r.id}">
      <p><strong>${esc(r.name)}</strong> <span class="muted small">${esc(dmy(ymd(new Date(r.created_at))))} ${esc(time(r.created_at))}</span>
        ${r.status === 'menunggu' ? tag(['Menunggu', 'tag-warn']) : r.status === 'disetujui' ? tag(['Disetujui', 'tag-ok']) : tag(['Ditolak', 'tag'])}</p>
      ${changeList(r.changes, r.status === 'menunggu' ? r.current : null)}
      <p class="muted small">Alasan: ${esc(r.reason)}${r.note ? `. Catatan: ${esc(r.note)}` : ''}${r.decided_by ? `, oleh ${esc(r.decided_by)}` : ''}</p>
      ${r.status === 'menunggu' ? `<div class="row"><button class="btn" type="button" data-rq-ok="${r.id}">Setujui</button>
        <button class="btn btn-quiet" type="button" data-rq-no="${r.id}">Tolak</button></div>` : ''}</div>`).join('')}
    ${others.length ? `<p class="muted small">Juga menunggu: ${others.map((r) => nameBtn(r.staff_id, r.name)).join(', ')}</p>` : ''}
  </section>`;
  p.innerHTML = `${reqHtml}<section class="panel stack">
    <h2>Profil staf</h2>
    <p class="muted small">Staf mengisi profilnya sendiri di halaman presensi (Profil saya), atau Anda isi di sini. Rekening hanya terlihat oleh staf itu, manajer dan pemilik.</p>
    <ul class="list">${list.map((s, i) => `<li data-prof="${i}"><span class="grow"><strong>${nameBtn(s.id, s.full_name || s.name)}</strong> ${s.role === 'manager' ? tag(['Manajer', 'tag']) : ''}<br>
      <span class="muted small num">${esc(prettyPhone(s.whatsapp))}${s.bank_account ? `, ${esc(s.bank_name)} ${esc(s.bank_account)} a.n. ${esc(s.bank_holder)}` : ', rekening belum diisi'}</span>
      <br><span class="muted small">${s.device_bound ? `HP presensi: ${esc(s.device_label || 'terdaftar')}, terakhir scan ${esc(dmy(ymd(new Date(s.device_last_seen_at))))} ${esc(time(s.device_last_seen_at))}` : 'HP presensi belum terdaftar (terdaftar saat scan pertama)'}</span></span>
      ${s.device_bound && !s.is_me ? `<button class="btn btn-text" type="button" data-dev-reset="${i}" aria-label="Reset HP presensi ${esc(s.full_name || s.name)}">Reset HP presensi</button>` : ''}
      ${opts.owner || !s.full_name ? `<button class="btn btn-quiet" type="button" data-prof-edit="${i}" aria-label="Ubah profil ${esc(s.full_name || s.name)}">Ubah</button>` : ''}
      <div class="att-prof-form" hidden></div></li>`).join('')}</ul>
  </section>`;
  wireNames(p);
  // Setujui and Tolak lock each other while one is busy, so a fast second tap can't decide twice.
  const rqLock = (b, on) => $$('[data-rq-ok], [data-rq-no]', b.closest('.att-prq')).forEach((x) => { if (x !== b) x.disabled = on; });
  $$('[data-rq-ok]', p).forEach((b) => b.addEventListener('click', async () => {
    busy(b, true, 'Menyimpan…'); rqLock(b, true);
    try { await rpc('att_decide_profile_request', { p_id: Number(b.dataset.rqOk), p_approve: true, p_note: null }); toast('Perubahan profil disetujui'); profilePart(p, opts); }
    catch (err) { toast(err.message); busy(b, false); rqLock(b, false); }
  }));
  $$('[data-rq-no]', p).forEach((b) => b.addEventListener('click', async () => {
    if (b.disabled) return;
    b.disabled = true; rqLock(b, true);
    const done = await formDialog({ title: 'Tolak permintaan?', submitLabel: 'Tolak',
      html: '<label class="field"><span>Alasan penolakan <span class="hint is-req">wajib</span></span><input type="text" name="note" maxlength="200" placeholder="Contoh: nama harus sama dengan buku tabungan"></label>',
      onSubmit: async (f) => {
        if (!f.elements.note.value.trim()) throw new Error('Tulis alasan penolakan.');
        await rpc('att_decide_profile_request', { p_id: Number(b.dataset.rqNo), p_approve: false, p_note: f.elements.note.value.trim() });
      } });
    b.disabled = false; rqLock(b, false);
    if (done) { toast('Permintaan ditolak'); profilePart(p, opts); }
  }));
  $$('[data-prof-edit]', p).forEach((b) => b.addEventListener('click', () => {
    const li = b.closest('li'), box = $('.att-prof-form', li), s = list[Number(b.dataset.profEdit)];
    b.hidden = true; box.hidden = false;
    bankForm(box, s, (saved) => { if (saved) return profilePart(p, opts); box.hidden = true; box.innerHTML = ''; b.hidden = false; b.focus(); }, !!opts.owner);
  }));
  // One phone per account: after a reset, the person's next scan binds their new phone.
  $$('[data-dev-reset]', p).forEach((b) => b.addEventListener('click', async () => {
    const s = list[Number(b.dataset.devReset)];
    if (!confirm(`Reset HP presensi ${s.full_name || s.name}? Scan berikutnya dari HP baru akan mendaftarkan HP itu.`)) return;
    busy(b, true, 'Mereset…');
    try { await rpc('att_reset_device', { p_staff: s.id }); toast('HP presensi direset'); profilePart(p, opts); }
    catch (err) { toast(err.message); busy(b, false); }
  }));
}

/* ======================================================== staff phone (absen.html) */
let token = null, stream = null, scanning = false, loc = null, schedView = 'minggu';

// One phone per account (11 Nov 2026): this phone's random id, kept in localStorage and a
// 400-day cookie. Only its hash is stored on the server. Safari may clear script storage
// (and caps script cookies to 7 days) after 7 days without a visit; the phone then gets
// a new id and the server asks for a reset by a manager or the owner.
const DEV_KEY = 'hs-att-device', DEV_COOKIE = 'hs_att_dev';
function deviceId() {
  let id = null;
  try { id = localStorage.getItem(DEV_KEY); } catch { /* storage blocked */ }
  if (!/^[A-Za-z0-9-]{16,64}$/.test(id || '')) {
    const m = document.cookie.match(new RegExp(`(?:^|; )${DEV_COOKIE}=([A-Za-z0-9-]{16,64})`));
    id = m ? m[1] : (crypto.randomUUID ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
  }
  try { localStorage.setItem(DEV_KEY, id); } catch { /* storage blocked */ }
  try { document.cookie = `${DEV_COOKIE}=${id}; max-age=${400 * 86400}; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch { /* cookies blocked */ }
  return id;
}
// A short name for the phone, shown to the owner next to "Reset HP presensi".
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'HP';
  const br = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}
const scanArgs = (extra = {}) => ({ p_device: deviceId(), p_lat: loc?.lat ?? null, p_lng: loc?.lng ?? null, p_acc: loc?.acc ?? null, ...extra });
async function geoGranted() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted'; } catch { return false; }
}

async function bootPhone() {
  const app = $('#app');
  if (!configured) return setupMissing(app);
  const hash = location.hash.match(/^#t=(HS[AB]1\.[0-9]+\.[0-9a-f]+)$/i);
  if (hash) { token = hash[1]; history.replaceState(null, '', location.pathname); }
  if (!(await session())) return gate(app);
  phone();
}

// Staff sign-in (Glenn, 13 Nov 2026): its own page at /staf, apart from the member card's.
function gate(app) {
  document.body.classList.add('is-gate');
  app.innerHTML = `<div class="sg">
    <section class="sg-stage" aria-label="Halaman staf Hanashuya">
      <img class="sg-logo" src="/member/img/logotype-cream.webp" width="600" height="96" alt="Hanashuya">
      <div class="sg-copy">
        <p class="sg-title">Ruang staf</p>
        <p class="sg-lead">Presensi, jadwal shift, izin dan profil kerja, dari HP Anda sendiri.</p>
      </div>
      <ul class="sg-list">
        <li><b>Presensi</b><span>Scan QR di tablet kasir untuk masuk, istirahat dan pulang.</span></li>
        <li><b>Jadwal</b><span>Shift minggu ini dan dua minggu ke depan.</span></li>
        <li><b>Izin</b><span>Ajukan paling lambat 7 hari sebelumnya.</span></li>
      </ul>
    </section>
    <div class="sg-form" id="sg-form"></div>
  </div>`;
  mountLogin($('#sg-form'), {
    staff: true, level: 1, title: 'Masuk',
    lead: 'Pakai username dan password akun staf Anda, bukan akun tablet kasir.',
    onDone: () => { document.body.classList.remove('is-gate'); phone(); },
  });
}

// First sign-in with the starting password: the staff member chooses their own (set_first_password).
function firstPassword(who) {
  const app = $('#app');
  const first = String(who.full_name || '').trim().split(/\s+/)[0];
  app.innerHTML = `<form class="panel stack-lg" id="fp" novalidate aria-labelledby="fp-t">
    <div class="stack-sm">
      <h1 id="fp-t">Buat password Anda</h1>
      <p class="muted">${first ? `Halo ${esc(first)}, ini` : 'Ini'} pertama kali Anda masuk. Ganti password awal dengan password Anda sendiri sebelum lanjut.</p>
    </div>
    <div class="field"><span>Username</span><p>${esc(who.username || prettyPhone(who.whatsapp))}</p>
      <span class="hint">Masuk berikutnya pakai username ini atau nomor WhatsApp Anda, dengan password baru.</span></div>
    <label class="field"><span>Password baru</span>
      <span class="pw"><input type="password" id="fp-pw" autocomplete="new-password" minlength="8" required>
      <button class="btn btn-text pw-toggle" type="button" id="fp-show" aria-label="Tampilkan password">Lihat</button></span>
      <span class="hint">Minimal 8 karakter, jangan 123456.</span></label>
    <label class="field"><span>Ulangi password baru</span>
      <input type="password" id="fp-pw2" autocomplete="new-password" minlength="8" required></label>
    <div class="notice" id="fp-msg" hidden></div>
    <div class="row"><button class="btn" type="submit">Simpan password</button></div>
  </form>`;
  const pw = $('#fp-pw'), pw2 = $('#fp-pw2');
  $('#fp-show').addEventListener('click', (e) => {
    const shown = pw.type === 'text';
    pw.type = pw2.type = shown ? 'password' : 'text';
    e.currentTarget.textContent = shown ? 'Lihat' : 'Tutup';
    e.currentTarget.setAttribute('aria-label', shown ? 'Tampilkan password' : 'Sembunyikan password');
  });
  $('#fp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#fp-msg'), btn = $('button[type="submit"]', e.currentTarget);
    if (pw.value.length < 8) { notice(msg, 'Password minimal 8 karakter.'); pw.focus(); return; }
    if (pw.value !== pw2.value) { notice(msg, 'Kedua password belum sama.'); pw2.focus(); return; }
    notice(msg, '');
    busy(btn, true, 'Menyimpan…');
    try { await rpc('set_first_password', { p_password: pw.value }); toast('Password baru tersimpan'); phone(); }
    catch (err) { notice(msg, err.message); busy(btn, false); }
  });
  pw.focus();
}

async function phone() {
  const app = $('#app');
  document.body.classList.remove('is-gate');
  $('#logout').hidden = false;
  let who;
  try { who = await rpc('whoami'); } catch (e) { return errBox(app, e); }
  // The kasir tablet account shows the QR; it never scans one (Glenn, 13 Nov 2026).
  if (who?.kasir_tablet) {
    app.innerHTML = `<section class="panel stack"><h1>Ini akun kasir tablet</h1><p>Akun kasir tablet hanya untuk tablet kasir: menampilkan QR presensi dan mencatat penjualan. Untuk presensi, keluar lalu masuk dengan akun staf Anda sendiri di HP Anda.</p>
      <div class="row"><a class="btn" href="/member/kasir">Buka kasir</a><button class="btn btn-quiet" type="button" id="out">Keluar</button></div></section>`;
    $('#out').addEventListener('click', signOut);
    return;
  }
  if (!who || !['staff', 'manager'].includes(who.role)) {
    app.innerHTML = `<section class="panel stack"><h1>Khusus akun staf</h1><p>Halaman ini dipakai staf dengan akunnya sendiri. Akun ${esc(prettyPhone(who?.whatsapp) || 'ini')} bukan akun staf.</p>
      <div class="row"><a class="btn" href="/member/">Buka kartu member</a><button class="btn btn-quiet" type="button" id="out">Keluar</button></div></section>`;
    $('#out').addEventListener('click', signOut);
    return;
  }
  if (who.must_set_password) return firstPassword(who);
  if ($('#to-card')) $('#to-card').hidden = false;
  app.innerHTML = `
  <div class="stack-lg">
    <div class="tabs" role="tablist" aria-label="Presensi">
      <button role="tab" id="t-ab" aria-controls="p-ab" data-tab="absen">Presensi</button>
      <button role="tab" id="t-me" aria-controls="p-me" data-tab="profil">Profil saya</button>
      <button role="tab" id="t-lv" aria-controls="p-lv" data-tab="izin">Izin</button>
    </div>
    <section id="p-ab" role="tabpanel" aria-labelledby="t-ab" class="stack-lg"></section>
    <section id="p-me" role="tabpanel" aria-labelledby="t-me" class="stack" hidden></section>
    <section id="p-lv" role="tabpanel" aria-labelledby="t-lv" class="stack" hidden></section>
  </div>`;
  tabs(app, (t) => { stopCamera(); ({ absen: scanTab, profil: meTab, izin: leaveTab })[t](); });
}

async function scanTab() {
  const p = $('#p-ab');
  skel(p);
  let s, sched = null, check = null, msg = '';
  try { [s, sched] = await Promise.all([rpc('att_status'), rpc('att_my_schedule').catch(() => null)]); } catch (e) { return errBox(p, e); }
  if (token && s.location_required && !loc) {
    // Location is checked once per scan, only when the owner has set the booth location.
    if (!(await geoGranted())) return askLocation(p);
    p.innerHTML = '<section class="panel stack" aria-busy="true"><h1>Mengecek lokasi…</h1><p class="muted">Sebentar, HP Anda sedang membaca lokasi.</p></section>';
    const r = await getLocation();
    loc = r.error ? null : r;
  }
  if (token) {
    try {
      check = await rpc('att_scan', scanArgs({ p_token: token, p_action: null }));
      if (check.ticket) token = check.ticket; // the tap may come after the 20-second QR has changed
    } catch (e) { token = null; loc = null; msg = e.message; }
  }
  const last = s.last ? `${ACTION[s.last.action]} ${time(s.last.at)}` : '';
  p.innerHTML = `
  <section class="panel stack"${check ? ' aria-labelledby="ab-cf-t"' : ''}>
    ${check ? '' : `<h1>Halo ${esc(s.name)}</h1>`}
    ${check ? '' : `<div class="stat"><span>Shift hari ini</span><b>${esc(dayLine(s.week[0]))}</b></div>`}
    ${check ? '' : `<p>${esc(state(s.next))}${last ? `. Scan terakhir: ${esc(last)}` : ''}.</p>`}
    ${check ? confirmHtml(check, s)
    : `<button class="btn btn-block btn-big" type="button" id="ab-scan">Scan QR di tablet kasir</button>
      <div class="scan-view" id="cam" hidden><video id="video" playsinline muted></video><span class="frame" aria-hidden="true"></span></div>
      <button class="btn btn-quiet btn-block" type="button" id="cam-stop" hidden>Tutup kamera</button>
      <p class="muted small">Berikutnya: ${s.next.map((a) => ACTION[a]).join(' atau ')}. Jam yang dicatat adalah jam server saat Anda menekan tombol. Presensi hanya dari HP Anda sendiri, di booth, dengan lokasi HP menyala.</p>`}
    <div class="notice" id="ab-note" hidden></div>
  </section>
  <section class="panel stack">
    <h2>Scan hari ini</h2>
    ${s.today_scans.length ? `<ul class="list">${s.today_scans.map((e) => `<li><span class="grow">${ACTION[e.action]}${e.via === 'koreksi' ? ' <span class="muted small">(koreksi)</span>' : ''}</span><span class="num">${esc(time(e.at))}</span></li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}
    ${s.today_report.map((r) => flags(r.flags.filter((f) => !f.startsWith('sedang_')))).join(' ')}
  </section>
  <section class="panel stack" id="ab-sched" aria-labelledby="ab-sched-title"></section>`;
  drawSchedule($('#ab-sched', p), s, sched);
  if (msg) notice($('#ab-note', p), msg);
  $$('[data-act]', p).forEach((b) => b.addEventListener('click', async () => {
    $$('[data-act]', p).forEach((x) => { x.disabled = true; });
    busy(b, true, 'Mencatat…');
    try {
      const r = await rpc('att_scan', scanArgs({ p_token: token, p_action: b.dataset.act, p_label: deviceLabel() }));
      token = null; loc = null;
      toast(`${ACTION[r.action]} tercatat pukul ${time(r.at)}${r.phone_bound ? '. HP ini sekarang HP presensi Anda' : ''}`);
      scanTab();
    } catch (e) { token = null; loc = null; notice($('#ab-note', p), e.message); busy(b, false); setTimeout(scanTab, 4000); }
  }));
  $('#ab-cancel', p)?.addEventListener('click', () => { token = null; loc = null; toast('Presensi dibatalkan, tidak ada yang tercatat'); scanTab(); });
  $('#ab-scan', p)?.addEventListener('click', startCamera);
  $('#cam-stop', p)?.addEventListener('click', stopCamera);
}

// The confirmation after a scan (Glenn, 14 Nov 2026): nothing is recorded until the staff member
// taps "Ya, catat …". Each QR offers exactly one action at a time, and the screen says up front
// how the scan will be recorded when it falls outside the schedule (di luar jadwal, terlambat,
// pulang lebih awal, lembur, istirahat lebih lama) or when the location could not be checked.
// The rules mirror _att_day in attendance.sql; the thresholds come from att_status().rules
// (defaults if the database is older).
function confirmHtml(check, s) {
  const a = check.next[0];
  const warns = scanWarnings(a, s, check.flags || []);
  return `<h1 id="ab-cf-t">Catat ${esc(ACTION[a])} sekarang?</h1>
    <p>${esc(s.full_name || s.name)} · <span class="num">${esc(time(new Date()))}</span> · ${check.kind === 'istirahat' ? 'QR istirahat' : 'QR presensi'}</p>
    <div class="stat"><span>Shift hari ini</span><b>${esc(dayLine(s.week[0]))}</b></div>
    ${warns.length ? `<div class="notice notice-warn" role="alert"><ul class="stack-sm" style="margin:0;padding-left:1.1rem">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    <div class="stack-sm">
      <button class="btn btn-block btn-big" type="button" data-act="${a}">Ya, catat ${esc(ACTION[a])}</button>
      <button class="btn btn-quiet btn-block" type="button" id="ab-cancel">Batal</button>
    </div>
    <p class="muted small">Jam yang dicatat adalah jam saat Anda menekan tombol. Belum ada yang tercatat sebelum Anda menekan Ya.</p>`;
}

const nowMin = (d = new Date()) => { const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d).split(':').map(Number); return h * 60 + m; };
const dur = (n) => n >= 60 ? `${Math.floor(n / 60)} jam${n % 60 ? ` ${n % 60} menit` : ''}` : `${n} menit`;
const OFF = 'Anda akan tercatat melakukan presensi di luar jadwal.';

function scanWarnings(action, s, fl) {
  const rules = { late: 10, out: 10, overtime: 20, ...(s.rules || {}) };
  const day = s.week?.[0], now = nowMin(), out = [];
  const blocks = (day?.blocks || []).filter((b) => b.kind === 'kerja' && b.start && b.end).map((b) => ({ ...b, bs: toMin(b.start), be: toMin(b.end) }));
  // The block a session belongs to: the one it overlaps, or one starting within 2 hours (as in _att_day).
  const blockFor = (start) => blocks.find((b) => start < b.be && start >= b.bs - 120) || blocks.find((b) => Math.abs(start - b.bs) <= 120);
  if (action === 'masuk') {
    if (day?.leave) out.push(`Hari ini Anda sedang izin. ${OFF}`);
    else if (!blocks.length) out.push(`Hari ini Anda tidak ada jadwal kerja. ${OFF}`);
    else {
      const b = blockFor(now);
      if (!b) out.push(`Sekarang di luar jam shift Anda. ${OFF}`);
      else if (now > b.bs + rules.late) out.push(`Anda akan tercatat terlambat ${dur(now - b.bs)} (jadwal masuk ${dot(b.start)}).`);
    }
  } else {
    const ins = (s.today_scans || []).filter((e) => e.action === 'masuk');
    const since = ins.length ? nowMin(new Date(ins.at(-1).at)) : null;
    const b = since == null ? null : blockFor(since);
    if (action === 'pulang' && b) {
      if (now < b.be) out.push(`Anda akan tercatat pulang lebih awal ${dur(b.be - now)} (jadwal pulang ${dot(b.end)}).`);
      else if (now >= b.be + rules.overtime) out.push(`Anda akan tercatat lembur ${dur(now - b.be)} setelah jadwal pulang ${dot(b.end)}. Lembur perlu disetujui manajer atau pemilik.`);
      else if (now > b.be + rules.out) out.push(`Anda akan tercatat pulang lewat ${dur(now - b.be)} dari jadwal (${dot(b.end)}).`);
    }
    if (action === 'kembali' && s.last?.action === 'istirahat') {
      const took = Math.max(0, Math.round((Date.now() - new Date(s.last.at)) / 60000));
      const limit = b?.break_minutes ?? rules.break ?? 60;
      if (took > limit + 5) out.push(`Istirahat Anda ${dur(took)}, lebih dari ${dur(limit)}. Anda akan tercatat istirahat lebih lama.`);
    }
  }
  if (fl.includes('lokasi_booth_belum_diatur')) out.push('Lokasi booth belum tersimpan, jadi jarak Anda ke booth belum dicek. Presensi tetap tercatat dan ditandai untuk pemilik.');
  if (fl.includes('lokasi_kurang_akurat')) out.push('Lokasi HP kurang akurat. Presensi tetap tercatat dan ditandai untuk pemilik.');
  return out;
}

// Before the browser's own location prompt: say why, in one sentence.
function askLocation(p) {
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="ab-loc-ask">
    <h1 id="ab-loc-ask">Izinkan lokasi untuk presensi</h1>
    <p>Presensi memakai lokasi HP Anda sekali saat scan, untuk memastikan Anda ada di booth. Lokasi tidak dilacak di luar itu.</p>
    <button class="btn btn-block btn-big" type="button" id="ab-loc-ok">Izinkan lokasi dan lanjut</button>
    <button class="btn btn-quiet btn-block" type="button" id="ab-loc-no">Batal</button>
    <div class="notice" id="ab-loc-note" hidden></div>
  </section>`;
  $('#ab-loc-ok', p).addEventListener('click', async (e) => {
    const b = e.currentTarget; // null after the first await
    busy(b, true, 'Membaca lokasi…');
    const r = await getLocation();
    if (r.error) {
      busy(b, false);
      return notice($('#ab-loc-note', p), r.error === 'denied'
        ? 'Izin lokasi ditolak. iPhone: Pengaturan > Privasi & Keamanan > Layanan Lokasi > Safari > Saat Menggunakan App. Android: ketuk ikon di samping alamat > Izin > Lokasi. Lalu scan ulang QR di tablet.'
        : LOC_ERR[r.error]);
    }
    loc = r; scanTab();
  });
  $('#ab-loc-no', p).addEventListener('click', () => { token = null; scanTab(); });
}

// Jadwal saya (Glenn, 12 Nov 2026): the days as they really are, from the shifts the owner or a
// manager set (weekly pattern plus one-off changes and approved leave), never a separate list
// of changes. Three views: this week (Mon-Sun), 14 days and 1 month ahead, the last two with a
// sub-header per week. Data: att_my_days; without it (older database) the 14 days of att_status.
const mondayOf = (iso) => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
const shortDay = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(iso + 'T00:00:00Z'));
async function drawSchedule(box, s, sched) {
  const today = s.today || sched?.today || ymd();
  const mon = mondayOf(today);
  let days = null;
  try { days = (await rpc('att_my_days', { p_from: mon < today ? mon : today, p_to: addDays(today, 29) })).days; }
  catch { days = s.week || []; if (schedView === 'bulan') schedView = '14'; }
  const byDate = new Map(days.map((d) => [d.date, d]));
  const views = [['minggu', 'Mingguan'], ['14', '14 hari'], ...(days.length > 14 ? [['bulan', '1 bulan'] ] : [])];
  const row = (date) => {
    const d = byDate.get(date), isToday = date === today, past = date < today;
    const changed = d?.blocks?.some((x) => x.changed);
    return `<li${isToday ? ' aria-current="date"' : ''}${past ? ' class="is-past"' : ''}><span class="grow">${esc(dmy(date))}${isToday ? ' <span class="muted small">(hari ini)</span>' : ''}</span>
      <span class="small">${d ? (d.leave ? 'Izin' : d.blocks.length ? esc(blocksLine(d.blocks)) : '<span class="muted">Tidak ada jadwal</span>') : '<span class="muted">Tidak ada data</span>'}${changed && !d.leave ? ' <span class="muted">(diubah)</span>' : ''}</span></li>`;
  };
  const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
  const weekTitle = (m) => {
    const label = m === mon ? 'Minggu ini · ' : m === addDays(mon, 7) ? 'Minggu depan · ' : ''; // later weeks: dates only ("Minggu" alone reads as Sunday)
    return `${label}${shortDay(m)} sampai ${shortDay(addDays(m, 6))}`;
  };
  const grouped = (dates) => {
    const weeks = [];
    dates.forEach((dt) => { const m = mondayOf(dt); if (!weeks.length || weeks.at(-1).m !== m) weeks.push({ m, ds: [] }); weeks.at(-1).ds.push(dt); });
    return weeks.map((w) => `<h3 class="h-small att-wk">${esc(weekTitle(w.m))}</h3><ul class="list att-sched">${w.ds.map(row).join('')}</ul>`).join('');
  };
  const body = schedView === 'minggu'
    ? `<p class="muted small">${esc(weekTitle(mon))}. Jadwal ikut berubah otomatis saat pemilik atau manajer mengubah shift.</p><ul class="list att-sched">${range(mon, 7).map(row).join('')}</ul>`
    : grouped(range(today, schedView === 'bulan' ? 30 : 14));
  box.innerHTML = `<h2 id="ab-sched-title">Jadwal saya</h2>
    <div class="rep-range att-sv" role="group" aria-label="Tampilan jadwal">${views.map(([k, l]) => `<button class="btn btn-quiet" type="button" data-sv="${k}" aria-pressed="${k === schedView}">${l}</button>`).join('')}</div>
    <div id="ab-sched-body" class="stack-sm">${body}</div>`;
  $$('[data-sv]', box).forEach((b) => b.addEventListener('click', () => { schedView = b.dataset.sv; drawSchedule(box, s, sched); }));
}

function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembaca QR gagal dimuat. Periksa internet.'));
    document.head.append(s);
  });
}

async function startCamera() {
  const msg = $('#ab-note');
  notice(msg, '');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice(msg, 'Kamera hanya bisa dipakai lewat https. Atau scan QR di tablet dengan aplikasi kamera HP.', 'warn');
    return;
  }
  try {
    await loadJsQR();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    notice(msg, e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan kamera di browser, atau scan QR dengan aplikasi kamera HP.' : e.message);
    return;
  }
  const v = $('#video');
  v.srcObject = stream;
  await v.play();
  $('#cam').hidden = false; $('#cam-stop').hidden = false; $('#ab-scan').hidden = true;
  scanning = true;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = () => {
    if (!scanning) return;
    if (v.readyState >= 2) {
      const w = Math.min(v.videoWidth, 720), h = Math.round(v.videoHeight * (w / v.videoWidth));
      canvas.width = w; canvas.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const hit = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
      if (hit && hit.data) {
        const m = hit.data.match(/HS[AB]1\.[0-9]+\.[0-9a-f]+/i);
        stopCamera();
        if (navigator.vibrate) navigator.vibrate(60);
        if (!m) { notice($('#ab-note'), 'Ini bukan QR presensi. Scan QR di tab Presensi pada tablet kasir.'); $('#ab-scan').hidden = false; return; }
        token = m[0];
        scanTab();
        return;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopCamera() {
  scanning = false;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  const cam = $('#cam'); if (cam) { cam.hidden = true; $('#cam-stop').hidden = true; }
}

// Profil saya (Glenn, 12 Nov 2026): filled once, with every field. After that the profile is
// locked; "Minta perubahan" beside Simpan profil asks a manager or the owner to change the
// fields the staff member picks (att_request_profile_change), one open request at a time.
const PROF_FIELDS = [['full_name', 'Nama lengkap'], ['bank_name', 'Nama bank'], ['bank_account', 'Nomor rekening'], ['bank_holder', 'Nama pemilik rekening']];
// Same rule as attendance.sql: digits only once spaces, dots and dashes are taken out.
const ACCT_OK = (v) => /^[0-9]{5,20}$/.test(v.replace(/[\s.-]/g, ''));
const ACCT_ERR = 'Nomor rekening hanya angka, 5 sampai 20 digit.';
const profLabel = (k) => (PROF_FIELDS.find(([x]) => x === k) || [k, k])[1];
const changeList = (changes, current) => `<ul class="list">${Object.entries(changes || {}).map(([k, v]) => `<li><span class="grow">${esc(profLabel(k))}</span>
  <span class="small">${current ? `<span class="muted">${esc(current[k] || 'kosong')}</span> → ` : ''}<strong>${esc(v)}</strong></span></li>`).join('')}</ul>`;
async function meTab() {
  const p = $('#p-me');
  skel(p);
  let m;
  try { m = await rpc('att_my_profile'); } catch (e) { return errBox(p, e); }
  const lock = !!m.locked, rq = m.request, waiting = rq?.status === 'menunggu';
  const ro = lock ? ' readonly aria-readonly="true"' : '';
  const req = lock ? '' : ' <span class="hint is-req">wajib</span>';
  p.innerHTML = `
  ${rq ? `<section class="panel stack" aria-labelledby="me-rq-t">
    <h2 id="me-rq-t">${waiting ? 'Permintaan perubahan menunggu' : rq.status === 'disetujui' ? 'Permintaan perubahan disetujui' : 'Permintaan perubahan ditolak'}</h2>
    ${changeList(rq.changes, waiting || rq.status === 'ditolak' ? m : null)}
    <p class="muted small">Alasan: ${esc(rq.reason)}${rq.note ? `. Catatan: ${esc(rq.note)}` : ''}</p>
    ${waiting ? '<div><button class="btn btn-quiet" type="button" id="me-rq-cancel">Batalkan permintaan</button></div>' : ''}
  </section>` : ''}
  <form class="panel stack" id="me-form" novalidate>
    <h2>Profil saya</h2>
    <p class="muted small">${lock ? 'Profil sudah tersimpan. Untuk mengubah data, tekan Minta perubahan. Pemilik atau manajer akan memeriksanya.'
      : 'Isi sekali dengan teliti. Setelah disimpan, perubahan harus lewat Minta perubahan dan disetujui pemilik atau manajer.'}</p>
    <label class="field"><span>Nama lengkap${req}</span><input type="text" id="me-name" value="${esc(m.full_name)}" autocomplete="name" required${ro}></label>
    <div class="field"><span>Nomor WhatsApp</span><p class="num">${esc(prettyPhone(m.whatsapp))}</p><span class="hint">Nomor ini dipakai untuk masuk. Kalau berganti, minta pemilik mengubahnya.</span></div>
    ${m.username ? `<div class="field"><span>Username</span><p>${esc(m.username)}</p><span class="hint">Huruf besar atau kecil sama saja saat masuk.</span></div>` : ''}
    ${m.employer ? `<div class="field"><span>Bekerja untuk</span><p>${esc(m.employer)}</p></div>` : ''}
    <h3 class="h-small">Rekening untuk gaji</h3>
    <label class="field"><span>Nama bank${req}</span><input type="text" id="me-bank" value="${esc(m.bank_name)}" placeholder="Contoh: BCA" maxlength="40" required${ro}></label>
    <label class="field"><span>Nomor rekening${req}</span><input type="text" id="me-acct" value="${esc(m.bank_account)}" inputmode="numeric" autocomplete="off" maxlength="24" required${ro}></label>
    <label class="field"><span>Nama pemilik rekening${req}</span><input type="text" id="me-holder" value="${esc(m.bank_holder)}" maxlength="80" required${ro}></label>
    <p class="muted small">Rekening hanya terlihat oleh Anda, manajer dan pemilik, dan hanya dipakai untuk membayar gaji.</p>
    <div class="notice" id="me-msg" hidden></div>
    <div class="row">
      <button class="btn" type="submit"${lock ? ' disabled' : ''}>Simpan profil</button>
      ${lock ? `<button class="btn btn-quiet" type="button" id="me-ask"${waiting ? ' disabled' : ''}>Minta perubahan</button>` : ''}
    </div>
    ${waiting ? '<p class="muted small">Minta perubahan bisa lagi setelah permintaan yang menunggu diputuskan atau dibatalkan.</p>' : ''}
  </form>
  <section class="panel stack" aria-labelledby="me-card-t">
    <h2 id="me-card-t">Kartu member saya</h2>
    <p class="muted small">Akun staf ini juga kartu member Hanashuya Anda, dengan nama dan nomor yang sama. Kalau belanja di booth, minta rekan yang bertugas memindai kartunya. Kartu sendiri tidak bisa dipakai saat Anda yang melayani.</p>
    <div><a class="btn btn-quiet" href="/member/">Buka kartu member</a></div>
  </section>`;
  $('#me-form', p).addEventListener('submit', async (e) => {
    e.preventDefault();
    if (lock || p.dataset.asking) return; // a fast double tap must not open two check dialogs
    const btn = $('button[type="submit"]', e.currentTarget), msg = $('#me-msg', p);
    const v = { name: $('#me-name', p).value.trim(), bank: $('#me-bank', p).value.trim(), acct: $('#me-acct', p).value.trim(), holder: $('#me-holder', p).value.trim() };
    if (!v.name || !v.bank || !v.acct || !v.holder) return notice(msg, 'Isi semua data: nama lengkap, nama bank, nomor rekening dan nama pemilik rekening.');
    if (!ACCT_OK(v.acct)) return notice(msg, ACCT_ERR);
    notice(msg, '');
    p.dataset.asking = '1';
    const sure = await confirmDialog({ title: 'Simpan profil?', confirmLabel: 'Simpan profil',
      text: `Periksa sekali lagi: ${v.bank} ${v.acct} a.n. ${v.holder}. Setelah disimpan, perubahan harus lewat Minta perubahan.` });
    delete p.dataset.asking;
    if (!sure) return;
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('att_save_profile', { p_staff: null, p_full_name: v.name, p_bank_name: v.bank, p_bank_account: v.acct, p_bank_holder: v.holder });
      toast('Profil tersimpan'); meTab();
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
  $('#me-rq-cancel', p)?.addEventListener('click', async (e) => {
    const b = e.currentTarget; // null after the first await
    busy(b, true, 'Membatalkan…');
    try { await rpc('att_cancel_profile_request', { p_id: rq.id }); toast('Permintaan dibatalkan'); meTab(); }
    catch (err) { toast(err.message); busy(b, false); }
  });
  $('#me-ask', p)?.addEventListener('click', async () => {
    if (p.dataset.asking) return;
    p.dataset.asking = '1';
    const sent = await formDialog({
      title: 'Minta perubahan profil', submitLabel: 'Kirim permintaan',
      html: `<p class="muted small">Centang data yang mau diubah, lalu isi data barunya.</p>
        ${PROF_FIELDS.map(([k, l]) => `<div class="stack-sm"><label class="check"><input type="checkbox" data-pick="${k}"><span>${esc(l)} <span class="muted small">sekarang: ${esc(m[k] || 'kosong')}</span></span></label>
          <label class="field" data-new="${k}" hidden><span>${esc(l)} baru</span><input type="text" name="${k}" maxlength="${k === 'bank_name' ? 40 : 80}"${k === 'bank_account' ? ' inputmode="numeric"' : ''}></label></div>`).join('')}
        <label class="field"><span>Alasan <span class="hint is-req">wajib</span></span><input type="text" name="reason" maxlength="300" placeholder="Contoh: pindah ke rekening BNI"></label>`,
      onOpen: (f) => $$('[data-pick]', f).forEach((c) => c.addEventListener('change', () => {
        const box = $(`[data-new="${c.dataset.pick}"]`, f); box.hidden = !c.checked; if (c.checked) $('input', box).focus();
      })),
      onSubmit: async (f) => {
        const changes = {};
        for (const c of $$('[data-pick]', f)) {
          if (!c.checked) continue;
          const v = f.elements[c.dataset.pick].value.trim();
          if (!v) throw new Error(`Isi ${profLabel(c.dataset.pick).toLowerCase()} yang baru.`);
          if (c.dataset.pick === 'bank_account' && !ACCT_OK(v)) throw new Error(ACCT_ERR);
          changes[c.dataset.pick] = v;
        }
        if (!Object.keys(changes).length) throw new Error('Centang minimal satu data yang mau diubah.');
        if (!f.elements.reason.value.trim()) throw new Error('Isi alasan perubahan.');
        await rpc('att_request_profile_change', { p_changes: changes, p_reason: f.elements.reason.value.trim() });
      },
    });
    delete p.dataset.asking;
    if (sent) { toast('Permintaan terkirim'); meTab(); }
  });
}

async function leaveTab() {
  const p = $('#p-lv');
  skel(p);
  let s;
  try { s = await rpc('att_status'); } catch (e) { return errBox(p, e); }
  p.innerHTML = `
  <form class="panel stack" id="lv-form" novalidate>
    <h2>Minta izin</h2>
    <p class="muted small">Izin paling lambat 7 hari sebelumnya, paling cepat ${esc(dmy(s.leave_from))}. Untuk izin mendadak, hubungi pemilik langsung.</p>
    <div class="form-grid">
      <label class="field"><span>Mulai <span class="hint is-req">wajib</span></span><input type="date" id="lv-start" min="${esc(s.leave_from)}" value="${esc(s.leave_from)}" required></label>
      <label class="field"><span>Sampai</span><input type="date" id="lv-end" min="${esc(s.leave_from)}"></label>
    </div>
    <label class="field"><span>Alasan <span class="hint is-req">wajib</span></span><input type="text" id="lv-reason" maxlength="300" required></label>
    <div class="notice" id="lv-msg" hidden></div>
    <button class="btn" type="submit" style="justify-self:start">Kirim permintaan</button>
  </form>
  <section class="panel stack">
    <h2>Izin saya</h2>
    ${s.leave.length ? `<ul class="list">${s.leave.map((l) => `<li><span class="grow">${esc(dmy(l.start))}${l.end !== l.start ? ' sampai ' + esc(dmy(l.end)) : ''}<br>
      <span class="muted small">${esc(l.reason)}${l.note ? `. Catatan: ${esc(l.note)}` : ''}</span></span>${tag(LEAVE[l.status])}
      ${l.status === 'menunggu' ? `<button class="btn btn-text" type="button" data-cancel="${l.id}">Batalkan</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum ada permintaan izin.</p>'}
  </section>`;
  $('#lv-start', p).addEventListener('change', (e) => { $('#lv-end', p).min = e.target.value || s.leave_from; });
  $('#lv-form', p).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Mengirim…');
    try {
      await rpc('att_request_leave', { p_start: $('#lv-start', p).value || null, p_end: $('#lv-end', p).value || null, p_reason: $('#lv-reason', p).value });
      toast('Permintaan izin terkirim'); leaveTab();
    } catch (err) { notice($('#lv-msg', p), err.message); busy(btn, false); }
  });
  $$('[data-cancel]', p).forEach((b) => b.addEventListener('click', async () => {
    busy(b, true);
    try { await rpc('att_cancel_leave', { p_id: Number(b.dataset.cancel) }); toast('Izin dibatalkan'); leaveTab(); }
    catch (err) { toast(err.message); busy(b, false); }
  }));
}

if (document.body?.dataset.page === 'absen') {
  $('#logout').addEventListener('click', signOut);
  window.addEventListener('pagehide', stopCamera);
  bootPhone();
}
