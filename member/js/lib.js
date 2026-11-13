import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, AUTH_EMAIL_DOMAIN, RESET_VIA, HANASHUYA_WHATSAPP } from './config.js';

export const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_ANON_KEY.startsWith('ISI');
export const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } })
  : null;

// Login cookie (api/session.js): a copy of the refresh token in a 400-day HttpOnly
// cookie, so a member stays signed in even after iPhone Safari wipes localStorage.
// Renewed on every open; cleared on Keluar. Fails quietly where /api isn't served.
async function keep(body) {
  try {
    const r = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.status === 200 ? await r.json() : null;
  } catch { return null; }
}
// Call before signing out, so the cookie is gone before the page moves on.
export const forgetLogin = () => keep({ action: 'clear' });
sb?.auth.onAuthStateChange((event, s) => {
  if (s?.refresh_token && ['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED'].includes(event)) keep({ action: 'save', refresh_token: s.refresh_token });
  if (event === 'SIGNED_OUT') keep({ action: 'clear' });
});

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TZ = 'Asia/Jakarta';
export const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
export const when = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const day = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
export const time = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

export function cleanError(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e || '');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Tidak ada koneksi. Periksa internet, lalu coba lagi.';
  if (/Token has expired|invalid.*otp|otp.*invalid/i.test(m)) return 'Kode salah atau sudah kedaluwarsa. Minta kode baru.';
  if (/rate limit|too many/i.test(m)) return 'Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.';
  if (/banned/i.test(m)) return 'Akun ini sudah dinonaktifkan pemilik.';
  if (/JWT|not authenticated|Silakan masuk/i.test(m)) return 'Sesi berakhir. Silakan masuk lagi.';
  return m;
}

// A time limit for every rpc call on pages that set one (the till: 15 s, 13 Nov 2026). On Wi-Fi
// that is connected but passes nothing the browser waits minutes; after the limit the call
// fails with a "waktu habis" message, which the till treats like no internet.
let rpcLimit = 0;
export const setRpcTimeout = (ms) => { rpcLimit = Number(ms) || 0; };
const TIMEOUT_MSG = 'Koneksi lambat, waktu habis. Periksa internet, lalu coba lagi.';

export async function rpc(name, args = {}, { timeout = rpcLimit } = {}) {
  let q = sb.rpc(name, args), timer = null, ctl = null;
  if (timeout > 0 && typeof AbortController !== 'undefined') {
    ctl = new AbortController();
    timer = setTimeout(() => ctl.abort(), timeout);
    q = q.abortSignal(ctl.signal);
  }
  try {
    const { data, error } = await q;
    if (error) throw new Error(ctl?.signal.aborted ? TIMEOUT_MSG : cleanError(error));
    return data;
  } catch (e) {
    if (ctl?.signal.aborted || e?.name === 'AbortError') throw new Error(TIMEOUT_MSG);
    throw e;
  } finally { clearTimeout(timer); }
}

// The latest birth date for someone 17 or older today, as YYYY-MM-DD, by the date in Bandung
// (WIB). toISOString() gave the UTC day, one day early, so a 17th birthday was refused.
export function maxBirth17(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now).split('-').map(Number);
  // On 29 Feb the year 17 back has no 29 Feb, so the limit is 28 Feb (Date rolled it to 1 Mar).
  const dd = m === 2 && d === 29 ? 28 : d;
  return `${y - 17}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; if (label) btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
}

export function notice(el, msg, kind = 'error') {
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.className = 'notice notice-' + kind;
  el.textContent = msg;
  el.hidden = false;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

let toastTimer;
export function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// One tab strip: arrow keys move between tabs, the hash keeps the open tab.
export function tabs(root, onChange) {
  const list = $$('[role="tab"]', root);
  const show = (tab, push) => {
    list.forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
    if (push) history.replaceState(null, '', '#' + tab.dataset.tab);
    onChange && onChange(tab.dataset.tab);
  };
  list.forEach((t, i) => {
    t.addEventListener('click', () => show(t, true));
    t.addEventListener('keydown', (e) => {
      // Left/right for a tab row, up/down for a vertical sidebar (owner page).
      const vertical = t.closest('[aria-orientation="vertical"]');
      const k = (vertical ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1 })[e.key];
      let n = null;
      if (k) n = list[(i + k + list.length) % list.length];
      if (e.key === 'Home') n = list[0];
      if (e.key === 'End') n = list[list.length - 1];
      if (n) { e.preventDefault(); n.focus(); show(n, true); }
    });
  });
  const start = list.find((t) => '#' + t.dataset.tab === location.hash) || list[0];
  show(start, false);
  return (name) => { const t = list.find((x) => x.dataset.tab === name); if (t) show(t, true); };
}

export function setupMissing(root) {
  root.innerHTML = `<div class="panel stack">
    <h1>Hubungkan Supabase dulu</h1>
    <p>Isi <code>js/config.js</code> dengan URL proyek dan anon key dari Supabase, Project Settings, API. Langkah lengkapnya ada di README.</p>
  </div>`;
}

// The sign-up address in every booth QR. It opens the sign-up form directly. (/daftar is
// a shorter address for typing, and redirects here.)
export const signupUrl = () => location.origin + '/member/#daftar';

// A QR code as inline SVG. Needs qrcode-generator loaded on the page.
export function qrSvg(text) {
  if (!window.qrcode) return '';
  const q = window.qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// A chat with Hanashuya on WhatsApp, with the first message already typed.
export const waLink = (text) => `https://wa.me/${HANASHUYA_WHATSAPP}` + (text ? `?text=${encodeURIComponent(text)}` : '');

export function toPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('62')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 9 && d.length <= 13 && d.startsWith('8') ? '+62' + d : null;
}
export const prettyPhone = (p) => {
  const d = String(p || '').replace(/\D/g, '').replace(/^62/, '');
  return d ? '+62 ' + d.replace(/(\d{3})(\d{4})(\d+)/, '$1-$2-$3') : '';
};

// Everyone signs in with a username or WhatsApp number plus a password. Each
// account has a hidden login address (u-xxxx@AUTH_EMAIL_DOMAIN); login_handle()
// finds it from the username or number. No email is ever sent to it.
const USERNAME = /^[a-z0-9._]{3,20}$/;
const isWrongLogin = (e) => /invalid login credentials/i.test(e?.message || '');
const randomHandle = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return 'u-' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('') + '@' + AUTH_EMAIL_DOMAIN;
};
const pw = (id, label, auto, hint = '') => `<label class="field"><span>${label}</span>
  <span class="pw"><input type="password" id="${id}" autocomplete="${auto}" minlength="8" required>
  <button class="btn btn-text pw-toggle" type="button" data-for="${id}" aria-label="Tampilkan password">Lihat</button></span>${hint}</label>`;

async function signInWith(login, password) {
  const handle = await rpc('login_handle', { p_login: login });
  if (!handle) return { message: 'Username atau nomor WhatsApp belum terdaftar.' };
  const { error } = await sb.auth.signInWithPassword({ email: handle, password });
  if (isWrongLogin(error)) return { message: 'Password salah. Coba lagi, atau tekan Lupa password.' };
  return error;
}

export function mountLogin(root, { title, lead, onDone, stage = false, staff = false, start = 'masuk', level = 1 }) {
  const maxBirth = maxBirth17();
  const forms = `
    <div class="seg" role="tablist" aria-label="Masuk atau daftar" ${staff ? 'hidden' : ''}>
      <button type="button" role="tab" id="seg-masuk" aria-selected="true">Masuk</button>
      <button type="button" role="tab" id="seg-daftar" aria-selected="false">Daftar</button>
    </div>

    <form id="login-form" class="stack" novalidate>
      <label class="field"><span>Username atau nomor WhatsApp</span>
        <input type="text" id="login" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      ${pw('password', 'Password', 'current-password', staff ? '<span class="hint">Pertama kali masuk? Pakai password awal dari pemilik, lalu buat password Anda sendiri.</span>' : '<span class="hint">Didaftarkan kasir di booth? Pakai password awal dari kasir.</span>')}
      <div class="notice" id="login-msg" hidden></div>
      <button class="btn btn-block" type="submit">Masuk</button>
      <button class="btn btn-text" type="button" id="to-forgot">Lupa password?</button>
    </form>

    <form id="signup-form" class="stack" novalidate hidden>
      <label class="field"><span>Nama lengkap</span><input type="text" id="su-name" autocomplete="name" required></label>
      <label class="field"><span>Tanggal lahir</span><input type="date" id="su-birth" autocomplete="bday" max="${maxBirth}" required>
        <span class="hint">Kartu member untuk usia 17 tahun ke atas.</span></label>
      <label class="field"><span>Nomor WhatsApp aktif</span>
        <span class="phone"><span class="cc" aria-hidden="true">+62</span>
        <input type="tel" id="su-phone" autocomplete="tel-national" inputmode="tel" placeholder="812 3456 7890" required></span>
        <span class="hint">Untuk masuk dan kode jika lupa password.</span></label>
      <label class="field"><span>Username</span><input type="text" id="su-username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required>
        <span class="hint">3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.</span></label>
      ${pw('su-password', 'Password', 'new-password', '<span class="hint">Minimal 8 karakter.</span>')}
      <fieldset class="field"><legend>Jenis kelamin</legend>
        <div class="choices">${[['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki'], ['tidak_disebut', 'Tidak ingin menyebutkan']].map(([v, l]) =>
          `<label class="choice"><input type="radio" name="su-gender" value="${v}"><span>${l}</span></label>`).join('')}</div></fieldset>
      <label class="check"><input type="checkbox" id="su-marketing">
        <span>Kirim info promo Hanashuya ke WhatsApp saya. Bisa diubah kapan saja di Akun.</span></label>
      <div class="notice" id="signup-msg" hidden></div>
      <button class="btn btn-block" type="submit">Buat kartu member</button>
    </form>

    <form id="forgot-form" class="stack" novalidate hidden>
      <h2 class="h-small">Lupa password</h2>
      <div id="fg-step1" class="stack">
        <label class="field"><span>Username atau nomor WhatsApp</span>
          <input type="text" id="fg-login" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        ${RESET_VIA === 'whatsapp-api'
          ? '<p class="muted small">Kode 6 angka dikirim ke nomor WhatsApp akun Anda.</p><button class="btn btn-block" type="button" id="fg-send">Kirim kode lewat WhatsApp</button>'
          : `<p class="muted small">Kirim pesan ke WhatsApp Hanashuya dari nomor akun Anda. Kami balas dengan kode 6 angka.</p>
             <a class="btn btn-block" id="fg-wa" href="https://wa.me/${HANASHUYA_WHATSAPP}" target="_blank" rel="noopener">Minta kode lewat WhatsApp</a>
             <button class="btn btn-quiet btn-block" type="button" id="fg-have">Saya sudah punya kode</button>`}
      </div>
      <div id="fg-step2" class="stack" hidden>
        <p class="small" id="fg-sent"></p>
        <label class="field"><span>Kode 6 angka</span>
          <input class="code" type="text" id="fg-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
        ${pw('fg-password', 'Password baru', 'new-password', '<span class="hint">Minimal 8 karakter.</span>')}
        <button class="btn btn-block" type="submit">Simpan password dan masuk</button>
      </div>
      <div class="notice" id="fg-msg" hidden></div>
      <button class="btn btn-text" type="button" id="fg-back">Kembali ke Masuk</button>
    </form>`;
  root.innerHTML = stage ? `
  <section class="welcome" aria-labelledby="login-title">
    <div class="stage"><div class="stage-inner">
      <div class="card3d" aria-hidden="true"><div class="float"><div class="card">
        <span class="card-face back"><img class="art" src="img/card-front.webp" width="900" height="514" alt=""></span>
      </div></div></div>
      <h1 id="login-title">${esc(title)}</h1>
      <p class="lead">${esc(lead)}</p>
    </div></div>
    <div class="sheet-paper"><div>${forms}</div></div>
  </section>` : `
  <section class="panel stack-lg" aria-labelledby="login-title">
    <div class="stack-sm"><h${level} id="login-title">${esc(title)}</h${level}><p class="muted">${esc(lead)}</p></div>
    ${forms}
  </section>`;

  const show = (which) => {
    $('#login-form', root).hidden = which !== 'masuk';
    $('#signup-form', root).hidden = which !== 'daftar';
    $('#forgot-form', root).hidden = which !== 'lupa';
    $('#seg-masuk', root).setAttribute('aria-selected', String(which === 'masuk'));
    $('#seg-daftar', root).setAttribute('aria-selected', String(which === 'daftar'));
    $('.seg', root).hidden = staff || which === 'lupa';
  };
  $('#seg-masuk', root).addEventListener('click', () => show('masuk'));
  $('#seg-daftar', root).addEventListener('click', () => { show('daftar'); $('#su-name', root).focus(); });
  $('#to-forgot', root).addEventListener('click', () => { show('lupa'); $('#fg-login', root).value = $('#login', root).value; $('#fg-login', root).focus(); });
  $('#fg-back', root).addEventListener('click', () => show('masuk'));
  $$('.pw-toggle', root).forEach((b) => b.addEventListener('click', () => {
    const input = $('#' + b.dataset.for, root), shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    b.textContent = shown ? 'Lihat' : 'Tutup';
    b.setAttribute('aria-label', shown ? 'Tampilkan password' : 'Sembunyikan password');
  }));
  if (start === 'daftar' && !staff) show('daftar');

  // Masuk
  $('#login-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#login-msg', root), btn = $('button[type="submit"]', e.currentTarget);
    const login = $('#login', root).value.trim(), password = $('#password', root).value;
    if (login.length < 3) { notice(msg, 'Tulis username atau nomor WhatsApp.'); $('#login', root).focus(); return; }
    if (!password) { notice(msg, 'Tulis password.'); $('#password', root).focus(); return; }
    notice(msg, '');
    busy(btn, true, 'Masuk…');
    let error;
    try { error = await signInWith(login, password); } catch (err) { error = err; }
    busy(btn, false);
    if (error) { notice(msg, cleanError(error)); return; }
    onDone();
  });

  // Daftar
  $('#signup-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#signup-msg', root), btn = $('button[type="submit"]', e.currentTarget);
    const name = $('#su-name', root).value.trim(), birth = $('#su-birth', root).value;
    const phone = toPhone($('#su-phone', root).value), username = $('#su-username', root).value.trim().toLowerCase();
    const password = $('#su-password', root).value, gender = $('input[name="su-gender"]:checked', root)?.value || '';
    const fail = (text, id) => { notice(msg, text); if (id) $('#' + id, root).focus(); };
    if (!name) return fail('Isi nama lengkap.', 'su-name');
    if (!birth) return fail('Isi tanggal lahir.', 'su-birth');
    if (birth > maxBirth) return fail('Kartu member hanya untuk usia 17 tahun ke atas.', 'su-birth');
    if (!phone) return fail('Tulis nomor WhatsApp yang aktif, misalnya 0812 3456 7890.', 'su-phone');
    if (!USERNAME.test(username)) return fail('Username 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.', 'su-username');
    if (password.length < 8) return fail('Password minimal 8 karakter.', 'su-password');
    notice(msg, '');
    busy(btn, true, 'Membuat kartu…');
    try {
      const taken = await rpc('signup_check', { p_username: username, p_phone: phone });
      if (taken.username_taken) { busy(btn, false); return fail('Username sudah dipakai. Coba yang lain.', 'su-username'); }
      if (taken.phone_taken) { busy(btn, false); return fail('Nomor ini sudah punya akun. Masuk saja, atau tekan Lupa password.', 'su-phone'); }
      const { data, error } = await sb.auth.signUp({
        email: randomHandle(), password,
        options: { data: { full_name: name, birth_date: birth, whatsapp: phone, username, gender, marketing: $('#su-marketing', root).checked } },
      });
      busy(btn, false);
      if (error) return fail(/database error/i.test(error.message) ? 'Akun belum bisa dibuat. Periksa data Anda, lalu coba lagi.' : cleanError(error));
      if (!data.session) return fail('Pendaftaran belum aktif. Pemilik perlu mematikan Confirm email di Supabase (lihat README).');
      onDone();
    } catch (err) { busy(btn, false); fail(cleanError(err)); }
  });

  // Lupa password
  const toStep2 = (text) => {
    $('#fg-step1', root).hidden = true; $('#fg-step2', root).hidden = false;
    $('#fg-sent', root).textContent = text;
    $('#fg-code', root).focus();
  };
  const fgLogin = $('#fg-login', root);
  const waLink = () => {
    const a = $('#fg-wa', root);
    if (a) a.href = `https://wa.me/${HANASHUYA_WHATSAPP}?text=${encodeURIComponent(`Halo Hanashuya, saya lupa password ${staff ? 'akun staf' : 'kartu member'}. Username atau nomor: ${fgLogin.value.trim()}`)}`;
  };
  fgLogin.addEventListener('input', waLink); waLink();
  $('#fg-wa', root)?.addEventListener('click', (e) => {
    if (fgLogin.value.trim().length < 3) { e.preventDefault(); notice($('#fg-msg', root), 'Tulis username atau nomor WhatsApp dulu.'); fgLogin.focus(); return; }
    notice($('#fg-msg', root), '');
    setTimeout(() => toStep2('Setelah kami membalas di WhatsApp, masukkan kodenya di sini.'), 300);
  });
  $('#fg-have', root)?.addEventListener('click', () => {
    if (fgLogin.value.trim().length < 3) { notice($('#fg-msg', root), 'Tulis username atau nomor WhatsApp dulu.'); fgLogin.focus(); return; }
    notice($('#fg-msg', root), '');
    toStep2('Masukkan kode dari WhatsApp Hanashuya.');
  });
  $('#fg-send', root)?.addEventListener('click', async (e) => {
    const msg = $('#fg-msg', root);
    if (fgLogin.value.trim().length < 3) { notice(msg, 'Tulis username atau nomor WhatsApp dulu.'); fgLogin.focus(); return; }
    const b = e.currentTarget; // null after the await
    busy(b, true, 'Mengirim…');
    const { data, error } = await sb.functions.invoke('wa-reset', { body: { login: fgLogin.value.trim() } });
    busy(b, false);
    if (error || data?.error) { notice(msg, data?.error || 'Kode belum bisa dikirim. Coba lagi sebentar.'); return; }
    notice(msg, '');
    toStep2('Jika akun ini terdaftar, kode 6 angka sudah dikirim ke WhatsApp-nya. Berlaku 15 menit.');
  });
  $('#forgot-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#fg-msg', root), btn = $('#fg-step2 button[type="submit"]', root);
    const code = $('#fg-code', root).value.replace(/\D/g, ''), password = $('#fg-password', root).value;
    if (code.length !== 6) { notice(msg, 'Kode terdiri dari 6 angka.'); $('#fg-code', root).focus(); return; }
    if (password.length < 8) { notice(msg, 'Password minimal 8 karakter.'); $('#fg-password', root).focus(); return; }
    busy(btn, true, 'Menyimpan…');
    try {
      const handle = await rpc('reset_with_code', { p_login: fgLogin.value.trim(), p_code: code, p_password: password });
      if (!handle) { busy(btn, false); notice(msg, 'Kode salah. Periksa lagi pesan WhatsApp Anda.'); return; }
      const { error } = await sb.auth.signInWithPassword({ email: handle, password });
      busy(btn, false);
      if (error) { notice(msg, cleanError(error)); return; }
      toast('Password baru tersimpan');
      onDone();
    } catch (err) { busy(btn, false); notice(msg, cleanError(err)); }
  });
}

export async function changePassword(password) {
  if (String(password || '').length < 8) throw new Error('Password minimal 8 karakter.');
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw new Error(cleanError(error));
}

export async function session() {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session;
  const kept = await keep({ action: 'restore' });
  if (!kept?.access_token) return null;
  const { data: restored, error } = await sb.auth.setSession(kept);
  return error ? null : restored.session;
}

export async function signOut() {
  await forgetLogin();
  await sb.auth.signOut();
  location.hash = '';
  location.reload();
}

/* ---------------------------------------------------------------- staff landing pages
 * Retiring the old cashier page.
 * On since 13 Nov 2026 (Glenn: "if there is a web version it must be the new version"): staf.html
 * sends everyone to kasir.html. staffHome() still picks a landing page for other callers:
 *   kasir tablet account  -> kasir.html (the till)
 *   staff, manager        -> /staf/ (their own phone: absen, jadwal, izin, profil)
 *   owner                 -> kasir.html (the owner opened the cashier page; Dasbor is pemilik.html)
 * Signed out, staf.html goes to kasir.html, which has its own sign-in. */
export const RETIRE_STAF_PAGE = true; // on since 13 Nov 2026 (Glenn): the new till is live
export function staffHome(who) {
  if (!who || who.kasir_tablet || who.role === 'owner') return 'kasir.html';
  if (who.role === 'staff' || who.role === 'manager') return '/staf/';
  return 'kasir.html';
}
