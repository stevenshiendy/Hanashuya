import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, AUTH_EMAIL_DOMAIN, RESET_VIA, HANASHUYA_WHATSAPP } from './config.js';

export const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(SUPABASE_URL) && !SUPABASE_ANON_KEY.startsWith('ISI');
export const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' } })
  : null;

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

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(cleanError(error));
  return data;
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
      const k = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
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

export function mountLogin(root, { title, lead, onDone, stage = false, staff = false, start = 'masuk' }) {
  const today = new Date();
  const maxBirth = new Date(today.getFullYear() - 17, today.getMonth(), today.getDate()).toISOString().slice(0, 10);
  const forms = `
    <div class="seg" role="tablist" aria-label="Masuk atau daftar" ${staff ? 'hidden' : ''}>
      <button type="button" role="tab" id="seg-masuk" aria-selected="true">Masuk</button>
      <button type="button" role="tab" id="seg-daftar" aria-selected="false">Daftar</button>
    </div>

    <form id="login-form" class="stack" novalidate>
      <label class="field"><span>Username atau nomor WhatsApp</span>
        <input type="text" id="login" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
      ${pw('password', 'Password', 'current-password')}
      <div class="notice" id="login-msg" hidden></div>
      <button class="btn btn-block" type="submit">Masuk</button>
      <button class="btn btn-text" type="button" id="to-forgot">Lupa password?</button>
      ${staff ? '<p class="muted small">Akun staf dibuat oleh pemilik.</p>' : ''}
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
      <fieldset class="field"><legend>Jenis kelamin <span class="hint">tidak wajib</span></legend>
        <div class="choices">${[['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki'], ['tidak_disebut', 'Tidak ingin menyebutkan']].map(([v, l]) =>
          `<label class="choice"><input type="radio" name="su-gender" value="${v}"><span>${l}</span></label>`).join('')}</div></fieldset>
      <label class="check"><input type="checkbox" id="su-consent" required>
        <span>Saya setuju dengan <a href="../syarat-ketentuan.html" target="_blank">syarat dan ketentuan</a> dan sudah membaca <a href="../kebijakan-privasi.html" target="_blank">kebijakan privasi</a>.</span></label>
      <label class="check"><input type="checkbox" id="su-marketing">
        <span>Kirim info promo Hanashuya ke WhatsApp saya. Tidak wajib, bisa diubah kapan saja di Akun.</span></label>
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
    <div class="stack-sm"><h1 id="login-title">${esc(title)}</h1><p class="muted">${esc(lead)}</p></div>
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
    if (!$('#su-consent', root).checked) return fail('Centang persetujuan syarat dan ketentuan untuk melanjutkan.', 'su-consent');
    notice(msg, '');
    busy(btn, true, 'Membuat kartu…');
    try {
      const taken = await rpc('signup_check', { p_username: username, p_phone: phone });
      if (taken.username_taken) { busy(btn, false); return fail('Username sudah dipakai. Coba yang lain.', 'su-username'); }
      if (taken.phone_taken) { busy(btn, false); return fail('Nomor ini sudah punya akun. Masuk saja, atau tekan Lupa password.', 'su-phone'); }
      const { data, error } = await sb.auth.signUp({
        email: randomHandle(), password,
        options: { data: { full_name: name, birth_date: birth, whatsapp: phone, username, gender, consent: true, marketing: $('#su-marketing', root).checked } },
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
    if (a) a.href = `https://wa.me/${HANASHUYA_WHATSAPP}?text=${encodeURIComponent(`Halo Hanashuya, saya lupa password kartu member. Username atau nomor: ${fgLogin.value.trim()}`)}`;
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
    busy(e.currentTarget, true, 'Mengirim…');
    const { data, error } = await sb.functions.invoke('wa-reset', { body: { login: fgLogin.value.trim() } });
    busy(e.currentTarget, false);
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
  return data.session;
}

export async function signOut() {
  await sb.auth.signOut();
  location.hash = '';
  location.reload();
}
