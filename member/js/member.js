import { sb, configured, $, $$, esc, rpc, busy, notice, toast, day, mountLogin, setupMissing, session, prettyPhone, changePassword, waLink, forgetLogin, maxBirth17 } from './lib.js';

const app = $('#app');
const VIEWS = ['kartu', 'hadiah', 'riwayat', 'akun'];
const TZ = 'Asia/Jakarta';
const GENDERS = [['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki'], ['tidak_disebut', 'Tidak ingin menyebutkan']];
const REWARD_IMG = { 3: 'img/reward-10.webp', 7: 'img/reward-20.webp', 10: 'img/reward-free.webp' };
const SHORT = { 3: '10%', 7: '20%', 10: 'Gratis' };
const CACHE = 'hs-member';
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const label = (list, v) => (list.find(([k]) => k === v) || [, 'Belum diisi'])[1];
const fmt = (opts) => (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, ...opts }).format(new Date(iso));
const monthYear = fmt({ month: 'long', year: 'numeric' });
const shortDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const clock = fmt({ hour: '2-digit', minute: '2-digit' });
const longDay = (ymd) => ymd ? new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(ymd + 'T00:00:00Z')) : 'Belum diisi';
const imgFor = (slot) => REWARD_IMG[slot] || REWARD_IMG[10];
// New-member and birthday vouchers (my_card.vouchers): open, used or not open yet.
const VOUCHER_IMG = { welcome: 'img/reward-free.webp', ulang_tahun: '../img/mini-8.webp', kode: 'img/reward-free.webp' };
const imgForRedeemed = (r) => VOUCHER_IMG[r.kind] || imgFor(r.slot);
const ymdShort = (ymd) => new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(ymd + 'T00:00:00Z'));
const openVouchers = (c) => (c.vouchers || []).filter((v) => v.status === 'tersedia');
const helpText = (c) => `Halo Hanashuya, saya member${c?.card_code ? ` dengan kode kartu ${c.card_code}` : ''}. Saya mau tanya: `;

const ICONS = {
  kartu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 9.5h19M6 14.5h4"/></svg>',
  hadiah: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v7.5h14v-7.5M12 8.5V20M12 8.5c-1.5-3.5-5.5-4-5.5-1.5S10 8.5 12 8.5zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 8.5 12 8.5z"/></svg>',
  riwayat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  akun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/></svg>',
  qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM17.5 17.5h3v3M14 20.5h.01M20.5 14h.01"/></svg>',
};
const NAMES = { kartu: 'Kartu', hadiah: 'Hadiah', riwayat: 'Riwayat', akun: 'Akun' };

let card = null;
let tokenTimer, pollTimer, fastPoll, wakeLock = null;

/* ---------------- printed voucher codes. The voucher QR opens /v/<code>, which Vercel
   redirects to /member/?v=<code>. The code waits on this phone (localStorage) until the
   member has an account and is signed in, then claim_voucher_code saves it to the card.
   Nothing is claimed by the scan itself, so an unfinished sign-up just scans again. */
const PENDING = 'hs-voucher-code';
const prettyCode = (k) => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.+)$/, '$1-$2');
let codeMsg = null;   // { text, kind } shown at the top of Hadiah (only when the claim could not be sent)
let claimShow = null; // { r, code }: the received / rejected pop-up after a claim (Glenn, 11 Nov 2026)
const pendingCode = () => { try { return localStorage.getItem(PENDING); } catch { return null; } };
const setPending = (k) => { try { k ? localStorage.setItem(PENDING, k) : localStorage.removeItem(PENDING); } catch { /* private mode: the QR still works when scanned again */ } };
{
  const q = new URLSearchParams(location.search), k = q.get('v');
  if (k) {
    setPending(k.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    history.replaceState(null, '', location.pathname + location.hash);
  }
}

// Saves a code to the card. Returns true when the card changed and should reload.
async function claimCode(code) {
  let r;
  try { r = await rpc('claim_voucher_code', { p_code: code }); }
  catch (e) { codeMsg = { text: `Voucher belum bisa disimpan: ${e.message} Buka lagi halaman ini sebentar lagi.`, kind: 'warn' }; return false; }   // network: a pending code stays for next time
  claimShow = { r, code };
  if (r.status !== 'terlalu_sering') setPending(null);
  return r.status === 'tersimpan';
}

function choices(name, list, current) {
  return `<div class="choices">${list.map(([v, l]) => `
    <label class="choice"><input type="radio" name="${name}" value="${v}" ${current === v ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`;
}

/* ---------------- shared with the landing page: who is signed in and how far along */
function remember(c) {
  try {
    localStorage.setItem(CACHE, JSON.stringify({
      first: (c.full_name || '').split(' ')[0], position: c.position, size: c.card_size,
      ready: c.rewards.filter((r) => r.status === 'tersedia').length + openVouchers(c).length,
    }));
  } catch { /* the landing page just shows the plain link */ }
}
function forget() { try { localStorage.removeItem(CACHE); } catch { /* nothing to clear */ } }

/* ---------------- start */
async function start() {
  if (!configured) return setupMissing(app);
  if (!(await session())) {
    forget();
    mountLogin(app, {
      stage: true,
      title: 'Kartu member Hanashuya',
      lead: 'Daftar sekarang, langsung dapat diskon 50% untuk 1 produk. Lalu 1 stempel setiap belanja Rp50.000: stempel ke-3 diskon 10%, ke-7 diskon 20%, ke-10 satu produk gratis.',
      start: location.hash === '#daftar' || pendingCode() ? 'daftar' : 'masuk',
      onDone: () => { if (location.hash === '#daftar') history.replaceState(null, '', location.pathname); boot(); },
    });
    // Came from a voucher QR: the banner says what signing up gets them (Glenn, 11 Nov 2026). Only here,
    // because a plain sign-up gets the 50% welcome voucher, not a free Signature.
    if (pendingCode()) $('.stage-inner')?.insertAdjacentHTML('afterbegin', `
      <div class="promo-banner" role="note">
        <img src="img/reward-free.webp" alt="" width="56" height="56">
        <div><strong>Setelah daftar, dapat 1 Signature choux gratis</strong>
        <span>Voucher <b class="num">${esc(prettyCode(pendingCode()))}</b> langsung masuk ke kartu member Anda. Tukar di booth dengan menyerahkan voucher kertasnya. Sudah punya akun? Pilih Masuk.</span></div>
      </div>`);
    $('.sheet-paper > div')?.insertAdjacentHTML('beforeend',
      `<p class="help-line">Ada kendala? <a href="${esc(waLink('Halo Hanashuya, saya mau tanya soal kartu member: '))}" target="_blank" rel="noopener">Chat Hanashuya di WhatsApp</a></p>`);
    return;
  }
  boot();
}

function errorView(msg, retry) {
  app.innerHTML = `<div class="wrap page-pad"><section class="stack"><h1>Kartu belum bisa dibuka</h1>
    <div class="notice notice-error" role="alert">${esc(msg)}</div>
    <button class="btn btn-quiet" type="button" id="retry">Coba lagi</button></section></div>`;
  $('#retry').addEventListener('click', retry);
}

async function boot() {
  try {
    const who = await rpc('whoami');
    if (!who) throw new Error('Akun tidak ditemukan. Keluar, lalu masuk lagi.');
    if (who.role !== 'member') {
      app.innerHTML = `<div class="wrap page-pad"><section class="stack"><h1>Ini akun staf</h1>
        ${location.hash === '#daftar' ? '<p class="notice notice-warn">Perangkat ini sedang masuk sebagai kasir, jadi formulir daftar member tidak bisa dibuka di sini. Minta pembeli scan QR di tab Daftar member dengan HP-nya, atau kirim link lewat WhatsApp dari tab itu.</p>' : ''}
        <p>Akun staf tidak bisa mengumpulkan stempel. Pakai nomor WhatsApp lain untuk kartu member pribadi.</p>
        <div class="row"><a class="btn" href="staf.html">Buka halaman kasir</a>${who.role === 'owner' ? '<a class="btn btn-quiet" href="pemilik.html">Buka dasbor pemilik</a>' : ''}
        <button class="btn btn-text" type="button" id="out">Keluar</button></div></section></div>`;
      $('#out').addEventListener('click', logout);
      return;
    }
    if (who.must_set_password) return firstPassword(who);
    if (!who.profile_complete) return profileForm(null, who.whatsapp);
    if (who.terms_ok === false) return profileForm(await rpc('my_card'), null, { renew: true });
    await load();
  } catch (e) { errorView(e.message, boot); }
}

async function logout() {
  forget();
  await forgetLogin();
  await sb.auth.signOut();
  location.href = './';
}

/* ---------------- first sign-in of a card the cashier made: the member signed in with
   the 6-digit starting code and now chooses their own password (set_first_password). */
function firstPassword(who) {
  clearTimers();
  $('#who').textContent = '';
  const first = String(who.full_name || '').trim().split(/\s+/)[0];
  app.innerHTML = `<div class="wrap page-pad">
  <form class="stack-lg" id="first-pw" novalidate aria-labelledby="fp-title">
    <div class="stack-sm">
      <h1 id="fp-title">Buat password Anda</h1>
      <p class="muted">${first ? `Halo Kak ${esc(first)}, k` : 'K'}artu member Anda dibuat di booth Hanashuya. Satu langkah lagi: ganti password awal dari kasir dengan password Anda sendiri.</p>
    </div>
    <div class="field"><span>Nomor WhatsApp</span><p class="num">${esc(prettyPhone(who.whatsapp))}</p>
      <span class="hint">Masuk berikutnya pakai nomor ini dan password baru Anda.</span></div>
    <label class="field"><span>Password baru</span>
      <span class="pw"><input type="password" id="fp-password" autocomplete="new-password" minlength="8" required>
      <button class="btn btn-text pw-toggle" type="button" id="fp-show" aria-label="Tampilkan password">Lihat</button></span>
      <span class="hint">Minimal 8 karakter.</span></label>
    <div class="notice" id="fp-msg" hidden></div>
    <div class="row">
      <button class="btn" type="submit">Simpan dan buka kartu</button>
      <button class="btn btn-text" type="button" id="fp-out">Keluar</button>
    </div>
  </form></div>`;
  const input = $('#fp-password');
  $('#fp-show').addEventListener('click', (e) => {
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    e.currentTarget.textContent = shown ? 'Lihat' : 'Tutup';
    e.currentTarget.setAttribute('aria-label', shown ? 'Tampilkan password' : 'Sembunyikan password');
  });
  $('#fp-out').addEventListener('click', logout);
  $('#first-pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#fp-msg'), btn = $('button[type="submit"]', e.currentTarget);
    if (input.value.length < 8) { notice(msg, 'Password minimal 8 karakter.'); input.focus(); return; }
    notice(msg, '');
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('set_first_password', { p_password: input.value });
      await boot();
      toast('Password tersimpan. Tunjukkan QR saat membayar.');
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
  input.focus();
}

/* ---------------- first visit and edit */
function profileForm(c, phone, { renew = false } = {}) {
  clearTimers();
  const edit = Boolean(c) && !renew;
  const maxBirth = maxBirth17();
  $('#who').textContent = '';
  app.innerHTML = `<div class="wrap page-pad">
  <form class="stack-lg" id="profile" novalidate aria-labelledby="pf-title">
    <div class="stack-sm">
      <h1 id="pf-title">${renew ? 'Syarat dan ketentuan baru' : edit ? 'Ubah data' : 'Lengkapi data'}</h1>
      <p class="muted">${renew ? 'Syarat dan ketentuan atau kebijakan privasi kartu member sudah diperbarui. Baca, periksa data Anda, lalu setujui untuk terus memakai kartu.' : edit ? 'Perbarui data Anda.' : 'Isi data berikut, lalu kartu langsung bisa dipakai di booth.'}</p>
    </div>
    <label class="field"><span>Nama lengkap</span>
      <input type="text" id="full_name" autocomplete="name" required value="${esc(c?.full_name)}"></label>
    <label class="field"><span>Username</span>
      <input type="text" id="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" value="${esc(c?.username)}">
      <span class="hint">3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah. Tanpa username, masuk pakai nomor WhatsApp.</span></label>
    ${c?.birth_date ? `<div class="field"><span>Tanggal lahir</span><p>${esc(longDay(c.birth_date))}</p>
      <input type="hidden" id="birth_date" value="${esc(c.birth_date)}">
      <span class="hint">Dipakai untuk hadiah ulang tahun. Untuk menggantinya, <a href="${esc(waLink(helpText(c) + 'saya mau mengganti tanggal lahir.'))}" target="_blank" rel="noopener">hubungi Hanashuya</a>.</span></div>`
    : `<label class="field"><span>Tanggal lahir</span>
      <input type="date" id="birth_date" autocomplete="bday" max="${maxBirth}" required value="">
      <span class="hint">Dipakai untuk hadiah ulang tahun dan tidak bisa diubah sendiri nanti.</span></label>`}
    <div class="field"><span>Nomor WhatsApp</span><p class="num">${esc(prettyPhone(c?.whatsapp || phone))}</p>
      <span class="hint">Untuk mengganti nomor, <a href="${esc(waLink(helpText(c) + 'saya mau mengganti nomor WhatsApp.'))}" target="_blank" rel="noopener">hubungi Hanashuya</a>.</span></div>
    <fieldset class="field"><legend>Jenis kelamin</legend>${choices('gender', GENDERS, c?.gender)}</fieldset>
    <label class="check"><input type="checkbox" id="marketing" ${c?.marketing_opt_in ? 'checked' : ''}>
      <span>Kirim info promo Hanashuya ke WhatsApp saya.</span></label>
    <div class="notice" id="pf-msg" hidden></div>
    <div class="row">
      <button class="btn" type="submit">${renew ? 'Setuju dan lanjut' : edit ? 'Simpan' : 'Aktifkan kartu'}</button>
      ${edit ? '<button class="btn btn-quiet" type="button" id="pf-cancel">Batal</button>' : ''}
    </div>
  </form></div>`;
  const f = $('#profile');
  $('#pf-cancel')?.addEventListener('click', () => load('akun'));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#pf-msg'), btn = $('button[type="submit"]', f);
    const name = $('#full_name').value.trim(), username = $('#username').value.trim().toLowerCase(), birth = $('#birth_date').value;
    if (!name) { notice(msg, 'Isi nama lengkap.'); $('#full_name').focus(); return; }
    if (username && !/^[a-z0-9._]{3,20}$/.test(username)) { notice(msg, 'Username 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.'); $('#username').focus(); return; }
    if (!birth) { notice(msg, 'Isi tanggal lahir.'); $('#birth_date').focus(); return; }
    if (birth > maxBirth) { notice(msg, 'Kartu member hanya untuk usia 17 tahun ke atas.'); $('#birth_date').focus(); return; }
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('update_my_profile', { p_full_name: name, p_username: username, p_birth_date: birth, p_gender: $('input[name="gender"]:checked')?.value || null, p_adult: true, p_marketing: $('#marketing').checked });
      await load(edit ? 'akun' : 'kartu');
      toast(renew ? 'Terima kasih. Kartu siap dipakai.' : edit ? 'Data tersimpan' : 'Kartu aktif. Tunjukkan QR saat membayar.');
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
  $('#full_name').focus();
}

/* ---------------- the app shell: four views and a tab bar */
async function load(go, fresh = []) {
  clearTimers();
  try { card = await rpc('my_card'); } catch (e) { return errorView(e.message, () => load(go)); }
  const waiting = pendingCode();
  if (waiting) {
    if (await claimCode(waiting)) { try { card = await rpc('my_card'); } catch { /* shown on the next poll */ } }
    go = 'hadiah';
  }
  remember(card);
  if (!$('#views')) shell();
  render(fresh);
  codeMsg = null;   // shown once
  if (claimShow) { const c = claimShow; claimShow = null; showClaim(c); }
  if (go && location.hash !== '#' + go) location.hash = go; else route(false);
  pollTimer = setInterval(poll, 15000);
}

function shell() {
  app.innerHTML = `
  <div id="views">${VIEWS.map((v) => `<section class="view" id="v-${v}" data-view="${v}" aria-labelledby="h-${v}" hidden></section>`).join('')}</div>
  <nav class="tabbar" aria-label="Kartu member"><ul>${VIEWS.map((v) => `
    <li><a href="#${v}" data-tab="${v}">${ICONS[v]}<span>${NAMES[v]}</span>${v === 'hadiah' ? '<span class="badge" id="badge" hidden></span>' : ''}</a></li>`).join('')}</ul></nav>

  <dialog class="sheet" id="qr-sheet" aria-labelledby="qr-title">
    <div class="sheet-inner">
      <div class="sheet-head"><h2 id="qr-title">Kartu member</h2><button class="btn btn-quiet" type="button" data-close>Tutup</button></div>
      <div class="sheet-mid">
        <div class="qr" id="qr" role="img" aria-label="QR kartu member"><div class="skeleton" style="height:100%"></div></div>
        <span class="who" id="qr-name"></span>
        <span class="card-code" id="qr-code" aria-label="Kode kartu"></span>
        <div class="ring-row"><svg class="ring" viewBox="0 0 56 56" aria-hidden="true"><circle class="bg" cx="28" cy="28" r="24"/><circle class="fg" id="qr-ring" cx="28" cy="28" r="24"/></svg>
          <span id="qr-note">QR berganti setiap 5 menit. Kasir juga bisa mengetik kode di atas.</span></div>
      </div>
      <p class="muted small" style="text-align:center">Naikkan kecerahan layar jika kasir sulit memindai.</p>
    </div>
  </dialog>

  <dialog class="sheet voucher" id="voucher" aria-labelledby="vc-title">
    <div class="sheet-inner">
      <div class="sheet-head"><h2 id="vc-title">Hadiah dipakai</h2><button class="btn btn-quiet" type="button" data-close>Tutup</button></div>
      <div class="sheet-mid" aria-live="polite">
        <img class="photo" id="vc-img" src="" alt="" width="148" height="148">
        <span class="label" id="vc-label"></span>
        <span class="meta" id="vc-meta"></span>
      </div>
      <div class="stack-sm">
        <p class="note" id="vc-note"></p>
        <button class="btn done btn-block" type="button" data-close>Selesai</button>
      </div>
    </div>
  </dialog>

  <dialog class="sheet voucher" id="claim" aria-labelledby="cl-title">
    <div class="sheet-inner">
      <div class="sheet-head"><h2 id="cl-title"></h2><button class="btn btn-quiet" type="button" data-close>Tutup</button></div>
      <div class="sheet-mid" aria-live="polite">
        <img class="photo" id="cl-img" src="img/reward-free.webp" alt="" width="148" height="148">
        <span class="label" id="cl-label"></span>
        <span class="meta" id="cl-meta"></span>
        <span class="cl-code" id="cl-code"></span>
      </div>
      <div class="stack-sm">
        <p class="note" id="cl-note"></p>
        <a class="btn btn-quiet btn-block" id="cl-wa" target="_blank" rel="noopener" hidden>Chat Hanashuya di WhatsApp</a>
        <button class="btn done btn-block" type="button" id="cl-go">Lihat di Hadiah</button>
      </div>
    </div>
  </dialog>`;
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#qr-sheet').addEventListener('close', closeQR);
  $('#voucher').addEventListener('close', () => route(false));
  if (!shell.wired) { window.addEventListener('hashchange', () => route(true)); shell.wired = true; }
}

function route(animate) {
  if (!$('#views')) return;
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'kartu';
  const swap = () => {
    VIEWS.forEach((x) => { const el = $('#v-' + x); el.hidden = x !== v; el.classList.toggle('is-in', x === v && animate); });
    $$('[data-tab]').forEach((a) => (a.dataset.tab === v ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  };
  if (animate && !reduced && document.startViewTransition) document.startViewTransition(swap); else swap();
  if (animate) { scrollTo({ top: 0 }); $('#h-' + v)?.focus({ preventScroll: true }); }
  document.title = `${NAMES[v]} · Kartu Member Hanashuya`;
}

function render(fresh) {
  const c = card;
  const ready = c.rewards.filter((r) => r.status === 'tersedia');
  const count = ready.length + openVouchers(c).length;
  $('#who').textContent = `Hai, ${(c.full_name || '').split(' ')[0]}`;
  const badge = $('#badge');
  badge.hidden = !count;
  badge.textContent = count;
  $('#v-kartu').innerHTML = viewCard(c, ready, fresh);
  $('#v-hadiah').innerHTML = viewRewards(c, ready);
  $('#v-riwayat').innerHTML = viewHistory(c);
  $('#v-akun').innerHTML = viewAccount(c);
  $('#qr-name').textContent = c.full_name;
  $('#qr-code').textContent = c.card_code;
  wireCard();
  if (fresh.length) {
    $('#card').classList.add('thump');
    if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
  }
  $('#show-qr').addEventListener('click', openQR);
  $$('[data-show-qr]').forEach((b) => b.addEventListener('click', openQR));
  $('#edit').addEventListener('click', () => profileForm(card));
  $('#code-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const k = $('#code-in').value.toUpperCase().replace(/[^A-Z0-9]/g, ''), btn = $('button[type="submit"]', e.currentTarget);
    if (k.length !== 8) { notice($('#code-msg'), 'Kode voucher terdiri dari 8 huruf dan angka, misalnya K7PX-3MQ9.'); $('#code-in').focus(); return; }
    busy(btn, true, 'Menyimpan…');
    await claimCode(k);
    await load('hadiah');
    $('#h-hadiah')?.focus();
  });
  $('#logout').addEventListener('click', logout);
  $('#pw-open').addEventListener('click', () => { $('#pw-form').hidden = false; $('#pw-new').focus(); });
  $('#pw-cancel').addEventListener('click', () => { $('#pw-form').hidden = true; });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#pw-msg'), btn = $('button[type="submit"]', e.currentTarget);
    if ($('#pw-new').value !== $('#pw-new2').value) { notice(msg, 'Kedua password tidak sama.'); return; }
    busy(btn, true, 'Menyimpan…');
    try { await changePassword($('#pw-new').value); $('#pw-form').hidden = true; toast('Password baru tersimpan'); }
    catch (err) { notice(msg, err.message); }
    busy(btn, false);
  });
  $('#del').addEventListener('click', () => { $('#del-confirm').hidden = false; $('#del-yes').focus(); });
  $('#del-no').addEventListener('click', () => { $('#del-confirm').hidden = true; $('#del').focus(); });
  $('#del-yes').addEventListener('click', async (e) => {
    const b = e.currentTarget; // null after the first await
    busy(b, true, 'Menghapus…');
    try { await rpc('delete_my_account'); forget(); await forgetLogin(); await sb.auth.signOut(); location.href = './'; }
    catch (err) { notice($('#del-msg'), err.message); busy(b, false); }
  });
  loadPromo();
}

/* ---------------- Kartu */
function slots(c, fresh) {
  let html = '';
  for (let i = 1; i <= Math.min(c.position, 10); i++) html += `<span class="slot${fresh.includes(i) ? ' is-new' : ''}" data-s="${i}"><img src="img/rose-stamp.webp" alt=""></span>`;
  return html;
}

function nextLine(c) {
  const wait = c.waiting > 0 ? ` ${c.waiting} stempel sudah menunggu di kartu berikutnya.` : '';
  if (c.position >= c.card_size) return `Kartu penuh. Kartu baru dimulai setelah semua hadiahnya dipakai.${wait}`;
  const ahead = c.rewards.filter((r) => r.cycle === c.cycle && r.status === 'terkunci').sort((a, b) => a.slot - b.slot)[0];
  return ahead ? `${ahead.slot - c.position} stempel lagi menuju ${ahead.label}` : 'Semua hadiah di kartu ini sudah terbuka';
}

function viewCard(c, ready, fresh) {
  const first = (c.full_name || '').split(' ')[0];
  const miles = c.rewards.filter((r) => r.cycle === c.cycle).map((r) =>
    `<span class="mile${c.position >= r.slot ? ' done' : ''}" style="left:${(r.slot / c.card_size) * 100}%"><span>${SHORT[r.slot] || r.label}</span></span>`).join('');
  return `
  <div class="stage"><div class="wrap stage-inner">
    <h1 class="hello" id="h-kartu" tabindex="-1">Halo, ${esc(first)}</h1>
    <p class="since">Member sejak ${esc(monthYear(c.member_since))}${c.cycle > 0 ? ` · Kartu ke-${c.cycle + 1}` : ''}</p>
    <div class="card3d" id="c3d"><div class="float"><div class="tilt">
      <button class="card" type="button" id="card" aria-pressed="false" aria-label="Kartu member, ${c.position} dari ${c.card_size} stempel. Ketuk untuk membalik.">
        <span class="card-face back"><img class="art" src="img/card-back.webp" width="900" height="514" alt="">${slots(c, fresh)}</span>
        <span class="card-face front"><img class="art" src="img/card-front.webp" width="900" height="514" alt=""></span>
      </button>
    </div></div></div>
    <p class="card-hint">Ketuk kartu untuk membalik</p>
    <div class="count"><b>${c.position}</b><span>dari ${c.card_size} stempel</span></div>
    <div class="track" style="--p:${c.position / c.card_size}" aria-hidden="true"><i></i>${miles}</div>
    <p class="next">${esc(nextLine(c))}<small>1 stempel setiap belanja Rp${Number(c.rupiah_per_stamp).toLocaleString('id-ID')}</small></p>
    <button class="btn qr-btn" type="button" id="show-qr">${ICONS.qr}Tunjukkan QR ke kasir</button>
  </div></div>
  <div class="wrap view-body" style="padding-top:var(--space-xl)">
    ${teaser(c, ready)}
    <section class="sec" aria-labelledby="promo-title">
      <h2 id="promo-title">Promo</h2>
      <div id="promo" class="stack-sm"><div class="skeleton" style="height:72px"></div></div>
    </section>
    <p class="help-line">Ada pertanyaan? <a href="${esc(waLink(helpText(c)))}" target="_blank" rel="noopener">Chat Hanashuya di WhatsApp</a></p>
  </div>`;
}

function teaser(c, ready) {
  const vouchers = openVouchers(c);
  const n = ready.length + vouchers.length;
  if (!n) return '';
  const first = vouchers[0];
  const img = first ? VOUCHER_IMG[first.kind] : imgFor(ready[0].slot);
  const title = n > 1 ? `${n} hadiah siap ditukar` : `${first ? first.label : ready[0].label} siap ditukar`;
  const sub = first && n === 1 ? `${first.title}, berlaku sampai ${ymdShort(first.ends_on)}. Tunjukkan QR kartu ke kasir.` : 'Tunjukkan QR kartu ke kasir untuk memakainya';
  return `<a class="teaser" href="#hadiah"><img src="${img}" alt="">
      <span><b>${esc(title)}</b><span>${esc(sub)}</span></span>
      <span class="go">Lihat</span></a>`;
}

/* ---------------- Hadiah */
function viewRewards(c, ready) {
  const other = ready.filter((r) => r.cycle !== c.cycle);
  const now = c.rewards.filter((r) => r.cycle === c.cycle && r.status !== 'ditukar');
  const list = [...now, ...other];
  const vouchers = (c.vouchers || []).filter((v) => v.status === 'tersedia' || v.status === 'belum');
  const openCount = ready.length + openVouchers(c).length;
  return `
  <div class="wrap">
    <header class="view-head"><h1 id="h-hadiah" tabindex="-1">Hadiah</h1>
      <p>${openCount ? `${openCount} hadiah siap dipakai. Di kasir, tunjukkan QR kartu Kakak. Kasir yang memakaikannya.` : 'Kumpulkan stempel untuk membuka hadiah berikutnya.'}</p></header>
    <div class="view-body">
      ${codeMsg ? `<p class="notice notice-${codeMsg.kind}" role="status">${esc(codeMsg.text)}</p>` : ''}
      <ul class="tickets">${vouchers.map((v) => {
        const open = v.status === 'tersedia';
        return `<li class="ticket ${open ? 'is-ready' : 'is-locked'}"><img src="${VOUCHER_IMG[v.kind]}" alt="" loading="lazy">
          <div class="body"><span class="title">${esc(v.label)}</span>
          <span class="meta">${esc(v.title)}. ${open ? `Berlaku sampai ${esc(ymdShort(v.ends_on))}` : `Bisa dipakai ${esc(ymdShort(v.starts_on))} sampai ${esc(ymdShort(v.ends_on))}`}${v.kind === 'kode' ? '. Bawa voucher kertasnya ke booth' : ''}</span>
          ${open ? '<button class="btn" type="button" data-show-qr>Tunjukkan QR ke kasir</button>' : ''}
          </div></li>`;
      }).join('')}${list.map((r) => {
        const open = r.status === 'tersedia';
        const left = r.slot - c.position;
        return `<li class="ticket ${open ? 'is-ready' : 'is-locked'}"><img src="${imgFor(r.slot)}" alt="" loading="lazy">
          <div class="body"><span class="title">${esc(r.label)}</span>
          ${open ? `<span class="meta">${r.cycle === c.cycle ? `Terbuka di stempel ke-${r.slot}` : `Dari kartu ke-${r.cycle + 1}`}</span>
            <button class="btn" type="button" data-show-qr>Tunjukkan QR ke kasir</button>`
          : `<span class="meta">Kurang ${left} stempel lagi</span><span class="mini-track" aria-hidden="true"><i style="--p:${Math.min(1, c.position / r.slot)}"></i></span>`}
          </div></li>`;
      }).join('')}</ul>
      <form class="sec stack-sm" id="code-form" novalidate aria-labelledby="code-title">
        <h2 id="code-title">Punya voucher kertas?</h2>
        <p class="muted small">Scan QR di voucher dengan kamera HP, atau ketik kodenya di sini.</p>
        <div class="code-row">
          <label class="field"><span>Kode voucher</span>
            <input type="text" id="code-in" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="K7PX-3MQ9"></label>
          <button class="btn btn-quiet" type="submit">Simpan</button>
        </div>
        <div class="notice" id="code-msg" hidden></div>
      </form>
      <section class="sec" aria-labelledby="used-title">
        <h2 id="used-title">Sudah dipakai</h2>
        ${c.redeemed.length ? `<ul class="plain">${c.redeemed.map((r) => `
          <li class="rowline"><span class="what">${esc(r.reward_label)}<small>${esc(shortDay(r.created_at))}, ${esc(clock(r.created_at))}</small></span>
          <span class="tag tag-ok">Dipakai</span></li>`).join('')}</ul>`
          : '<p class="muted">Belum ada hadiah yang dipakai.</p>'}
      </section>
    </div>
  </div>`;
}

// Received or rejected, right after a voucher QR scan or a typed code. Received is the red celebration
// sheet; rejected is a calm cream sheet that leads with the reason (Glenn, 11 Nov: no icon, no big code).
function showClaim({ r, code }) {
  const ok = r.status === 'tersimpan' || r.status === 'sudah';
  const [why, ...rest] = String(r.message || '').split(/(?<=\.)\s+/);
  $('#claim').classList.toggle('is-no', !ok);
  $('#cl-title').textContent = ok ? (r.status === 'sudah' ? 'Voucher sudah tersimpan' : 'Voucher diterima') : 'Voucher ditolak';
  $('#cl-img').hidden = !ok;
  $('#cl-label').textContent = ok ? r.label : why;
  $('#cl-meta').textContent = ok ? `${r.title}, berlaku sampai ${ymdShort(r.ends_on)}` : rest.join(' ');
  $('#cl-meta').hidden = !$('#cl-meta').textContent;
  $('#cl-code').textContent = ok ? '' : `Kode voucher ${prettyCode(code)}`;
  $('#cl-code').hidden = ok;
  $('#cl-note').textContent = ok ? 'Bawa voucher kertasnya ke booth dan tunjukkan QR kartu ke kasir.' : '';
  const wa = $('#cl-wa');
  wa.hidden = r.status !== 'dipakai_lain';
  if (!wa.hidden) wa.href = waLink(`${helpText(card)}kode voucher ${prettyCode(code)} saya ditolak karena sudah dipakai akun lain.`);
  const go = $('#cl-go');
  go.textContent = ok ? 'Lihat di Hadiah' : 'Kembali ke kartu';
  go.onclick = () => { $('#claim').close(); location.hash = ok ? 'hadiah' : 'kartu'; };
  $('#claim').showModal();
  if (navigator.vibrate) navigator.vibrate(ok ? [30, 40, 30] : 120);
}

function showVoucher(r, newCard = false) {
  $('#vc-note').textContent = newCard
    ? `Kartu Kakak sudah penuh dan semua hadiahnya terpakai. Kartu ke-${card.cycle + 1} dimulai${card.position ? ` dengan ${card.position} stempel` : ''}.`
    : 'Kasir sudah memakai hadiah ini untuk belanja Kakak. Selamat menikmati!';
  $('#vc-img').src = imgForRedeemed(r);
  $('#vc-label').textContent = r.reward_label;
  $('#vc-meta').textContent = `${card.full_name}, kartu ${card.card_code}. Dipakai ${shortDay(r.created_at)} pukul ${clock(r.created_at)}.`;
  $('#voucher').showModal();
  if (navigator.vibrate) navigator.vibrate(60);
}

/* ---------------- Riwayat */
function viewHistory(c) {
  const groups = [];
  c.visits.forEach((v) => {
    const m = monthYear(v.created_at);
    if (!groups.length || groups.at(-1).m !== m) groups.push({ m, rows: [] });
    groups.at(-1).rows.push(v);
  });
  return `
  <div class="wrap">
    <header class="view-head"><h1 id="h-riwayat" tabindex="-1">Riwayat</h1><p>Kunjungan dan stempel Kakak di booth.</p></header>
    <div class="view-body">
      <div class="tiles">
        <div class="tile"><b>${c.total_stamps}</b><span>stempel</span></div>
        <div class="tile"><b>${c.visit_count ?? c.visits.length}</b><span>kunjungan</span></div>
        <div class="tile"><b>${c.redeemed.length}</b><span>hadiah</span></div>
      </div>
      ${groups.length ? groups.map((g) => `
        <section aria-label="${esc(g.m)}"><p class="month">${esc(g.m)}</p>
        <ul class="plain">${g.rows.map((v) => `
          <li class="rowline"><span class="what">${esc((v.items || []).map((i) => (i.qty > 1 ? i.qty + '× ' : '') + i.name).join(', ') || 'Belanja')}
            <small>${esc(shortDay(v.created_at))}, ${esc(clock(v.created_at))}</small></span>
          <span class="plus${v.stamps ? '' : ' zero'}">${v.stamps ? '+' + v.stamps + ' stempel' : 'tanpa stempel'}</span></li>`).join('')}</ul></section>`).join('')
        : '<p class="muted">Belum ada kunjungan. Tunjukkan QR di tab Kartu saat membayar di booth.</p>'}
    </div>
  </div>`;
}

/* ---------------- Akun */
function viewAccount(c) {
  const initials = (c.full_name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `
  <div class="wrap">
    <header class="view-head"><h1 id="h-akun" tabindex="-1">Akun</h1></header>
    <div class="view-body">
      <div class="me"><span class="avatar" aria-hidden="true">${esc(initials)}</span>
        <span><b>${esc(c.full_name)}</b><span class="sub">${esc(prettyPhone(c.whatsapp))}</span><br><span class="sub">Member sejak ${esc(monthYear(c.member_since))}</span></span></div>
      <dl class="facts">
        <dt>Username</dt><dd>${esc(c.username || 'Belum diisi')}</dd>
        <dt>Tanggal lahir</dt><dd>${esc(longDay(c.birth_date))}</dd>
        <dt>Jenis kelamin</dt><dd>${esc(label(GENDERS, c.gender))}</dd>
        <dt>Info promo WhatsApp</dt><dd>${c.marketing_opt_in ? 'Ya' : 'Tidak'}</dd>
        <dt>Kode kartu</dt><dd class="num">${esc(c.card_code)}</dd>
      </dl>
      <div class="row"><button class="btn btn-quiet" type="button" id="edit">Ubah data</button>
        <button class="btn btn-quiet" type="button" id="pw-open">Ganti password</button>
        <button class="btn btn-quiet" type="button" id="logout">Keluar</button></div>
      <form class="panel-sunk stack-sm" id="pw-form" hidden novalidate>
        <label class="field"><span>Password baru</span><input type="password" id="pw-new" autocomplete="new-password" minlength="8"><span class="hint">Minimal 8 karakter.</span></label>
        <label class="field"><span>Ulangi password baru</span><input type="password" id="pw-new2" autocomplete="new-password" minlength="8"></label>
        <div class="notice" id="pw-msg" hidden></div>
        <div class="row"><button class="btn" type="submit">Simpan password</button><button class="btn btn-quiet" type="button" id="pw-cancel">Batal</button></div>
      </form>
      <section class="panel-sunk stack-sm" aria-labelledby="help-title">
        <h2 id="help-title">Butuh bantuan?</h2>
        <p class="small">Stempel belum masuk, lupa password, atau mau ganti data? Chat kami di WhatsApp.</p>
        <a class="btn" href="${esc(waLink(helpText(c)))}" target="_blank" rel="noopener">Chat WhatsApp Hanashuya</a>
      </section>
      <nav class="links" aria-label="Tautan">
        <a href="../">Situs Hanashuya</a>
        <a href="../#menu">Menu dan harga</a>
      </nav>
      <div class="stack-sm">
        <button class="btn btn-text" type="button" id="del" style="justify-self:start;padding-inline:0">Hapus akun</button>
        <div class="panel-sunk stack-sm" id="del-confirm" hidden>
          <p>Nama, nomor WhatsApp, dan stempel Anda akan dihapus permanen. Riwayat belanja disimpan tanpa nama.</p>
          <div class="row"><button class="btn btn-danger" type="button" id="del-yes">Ya, hapus akun saya</button>
          <button class="btn btn-quiet" type="button" id="del-no">Batal</button></div>
          <div class="notice" id="del-msg" hidden></div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ---------------- the card: tap to flip, tilt with the finger or the phone */
function wireCard() {
  const wrap = $('#c3d'), btn = $('#card');
  btn.addEventListener('click', () => {
    const front = wrap.classList.toggle('is-front');
    btn.setAttribute('aria-pressed', String(front));
    askMotion();
  });
  if (reduced) return;
  wrap.addEventListener('pointermove', (e) => {
    const r = wrap.getBoundingClientRect();
    wrap.classList.add('is-moving');
    tilt((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  });
  const rest = () => { wrap.classList.remove('is-moving'); if (!motionOn) tilt(0.5, 0.5); };
  wrap.addEventListener('pointerleave', rest);
  wrap.addEventListener('pointercancel', rest);
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function') listenMotion();
}
// The tilt sits on .tilt and the flip on .card, so phone motion never restarts the flip.
function tilt(x, y) {
  const wrap = $('#c3d'); if (!wrap) return;
  wrap.style.setProperty('--ry', `${(x - 0.5) * 16}deg`);
  wrap.style.setProperty('--rx', `${(0.5 - y) * 12}deg`);
  wrap.style.setProperty('--mx', `${x * 100}%`);
  wrap.style.setProperty('--my', `${y * 100 - 20}%`);
}
// Phone motion: the angle the phone is held at counts as level, readings are
// smoothed once per frame, and the jump when the phone passes upright is ignored.
let motionOn = false, motionFrame = 0, base = null, lastGamma = null;
const motionNow = { x: 0.5, y: 0.5 }, motionGoal = { x: 0.5, y: 0.5 };
const clamp01 = (n) => Math.min(1, Math.max(0, n));
function listenMotion() {
  if (motionOn) return;
  motionOn = true;
  window.addEventListener('deviceorientation', (e) => {
    const wrap = $('#c3d');
    if (!wrap || e.beta == null || e.gamma == null || $('#v-kartu')?.hidden || wrap.classList.contains('is-moving')) return;
    if (lastGamma != null && Math.abs(e.gamma - lastGamma) > 40) { base = null; lastGamma = e.gamma; return; }
    lastGamma = e.gamma;
    if (!base) base = { b: e.beta, g: e.gamma };
    base.b += (e.beta - base.b) * 0.01;
    base.g += (e.gamma - base.g) * 0.01;
    motionGoal.x = clamp01(0.5 + (e.gamma - base.g) / 40);
    motionGoal.y = clamp01(0.5 + (e.beta - base.b) / 40);
    if (!motionFrame) motionFrame = requestAnimationFrame(motionStep);
  });
}
function motionStep() {
  motionFrame = 0;
  motionNow.x += (motionGoal.x - motionNow.x) * 0.18;
  motionNow.y += (motionGoal.y - motionNow.y) * 0.18;
  tilt(motionNow.x, motionNow.y);
  if (Math.abs(motionGoal.x - motionNow.x) + Math.abs(motionGoal.y - motionNow.y) > 0.002) motionFrame = requestAnimationFrame(motionStep);
}
async function askMotion() {
  if (reduced || motionOn || !window.DeviceOrientationEvent || typeof DeviceOrientationEvent.requestPermission !== 'function') return;
  try { if ((await DeviceOrientationEvent.requestPermission()) === 'granted') listenMotion(); } catch { /* tilt stays on touch */ }
}

/* ---------------- QR sheet */
function restartRing(id, seconds) {
  const old = $('#' + id); if (!old) return;
  const fresh = old.cloneNode(true);
  fresh.style.setProperty('--d', seconds + 's');
  old.replaceWith(fresh);
}
async function openQR() {
  $('#qr-sheet').showModal();
  refreshToken();
  clearInterval(fastPoll);
  fastPoll = setInterval(poll, 3000);
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { wakeLock = null; }
}
function closeQR() { clearTimeout(tokenTimer); clearInterval(fastPoll); wakeLock?.release?.().catch(() => {}); wakeLock = null; }
async function refreshToken() {
  clearTimeout(tokenTimer);
  const box = $('#qr');
  if (!box || !$('#qr-sheet').open) return;
  try {
    const t = await rpc('card_token');
    if (window.qrcode) {
      const q = window.qrcode(0, 'M');
      q.addData(t.token);
      q.make();
      box.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    }
    restartRing('qr-ring', t.expires_in);
    tokenTimer = setTimeout(refreshToken, Math.max(2, t.expires_in) * 1000 + 300);
  } catch {
    box.innerHTML = '';
    $('#qr-note').textContent = 'QR belum bisa dimuat. Kasir bisa mengetik kode kartu di atas.';
    tokenTimer = setTimeout(refreshToken, 10000);
  }
}

async function loadPromo() {
  const { data, error } = await sb.from('campaigns').select('title, body, ends_on').order('ends_on');
  const box = $('#promo');
  if (!box) return;
  if (error) { box.innerHTML = '<div class="notice notice-error">Promo belum bisa dimuat. Muat ulang halaman.</div>'; return; }
  box.innerHTML = data.length ? data.map((p) => `<div class="promo"><b>${esc(p.title)}</b><span>${esc(p.body)}</span><small>Sampai ${esc(day(p.ends_on))}</small></div>`).join('')
    : '<p class="muted">Belum ada promo saat ini.</p>';
}

/* ---------------- new stamps arrive while the card is open */
async function poll() {
  if (document.hidden || !card || $('#voucher')?.open || $('#claim')?.open) return;
  try {
    const next = await rpc('my_card');
    if (next.total_stamps === card.total_stamps && next.redeemed.length === card.redeemed.length
      && (next.vouchers || []).length === (card.vouchers || []).length) return;
    const fresh = [];
    if (next.cycle === card.cycle) for (let i = card.position + 1; i <= next.position; i++) fresh.push(i);
    else for (let i = 1; i <= next.position; i++) fresh.push(i);
    const gained = next.total_stamps - card.total_stamps;
    const known = new Set(card.redeemed.map((r) => r.id));
    const used = next.redeemed.filter((r) => !known.has(r.id));
    const newCard = next.cycle > card.cycle;
    $('#qr-sheet')?.close();
    card = next;
    remember(card);
    render(fresh);
    if (location.hash !== '#kartu' && (gained > 0 || newCard)) location.hash = 'kartu'; else route(false);
    if (used.length) showVoucher(used[0], newCard);
    else if (gained > 0) toast(`${gained} stempel masuk. Terima kasih!`);
  } catch { /* the next poll retries */ }
}

function clearTimers() { clearTimeout(tokenTimer); clearInterval(pollTimer); clearInterval(fastPoll); }

document.addEventListener('visibilitychange', () => { if (!document.hidden) { if ($('#qr-sheet')?.open) refreshToken(); poll(); } });
start();
