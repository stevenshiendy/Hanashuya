import { sb, configured, $, $$, esc, rpc, busy, notice, toast, rupiah, time, mountLogin, setupMissing, session, signOut, tabs, prettyPhone } from './lib.js';

const app = $('#app');
let menu = [];
let member = null;      // { ticket, first_name, ... } or { walkin: true }
let qty = {};
let stream = null, scanning = false;
let settingsRupiah = 50000;
let rewards = [];       // [{ slot, label }] from the rewards table

const GENDERS = [['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki']];
const AGES = [['<17', 'Di bawah 17'], ['17-24', '17–24'], ['25-34', '25–34'], ['35-44', '35–44'], ['45+', '45+']];

async function start() {
  if (!configured) return setupMissing(app);
  if (!(await session())) {
    return mountLogin(app, { staff: true, title: 'Masuk sebagai kasir', lead: 'Pakai username atau nomor WhatsApp dan password dari pemilik.', onDone: boot });
  }
  boot();
}

async function boot() {
  $('#logout').hidden = false;
  let who;
  try { who = await rpc('whoami'); } catch (e) { app.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; return; }
  if (!who || (who.role !== 'staff' && who.role !== 'owner')) {
    app.innerHTML = `<section class="panel stack"><h1>Belum terdaftar sebagai kasir</h1>
      <p>Nomor <strong class="num">${esc(prettyPhone(who?.whatsapp) || 'ini')}</strong> bukan akun kasir. Akun kasir dibuat pemilik di dasbor pemilik, bagian Staf.</p>
      <button class="btn btn-quiet" type="button" id="reload">Keluar</button></section>`;
    $('#reload').addEventListener('click', signOut);
    return;
  }
  const [{ data }, { data: rw }] = await Promise.all([
    sb.from('menu_items').select('id, name, price').order('sort'),
    sb.from('rewards').select('slot, label').order('slot'),
  ]);
  menu = data || [];
  rewards = rw || [];
  render();
}

function render() {
  app.innerHTML = `
  <div class="stack-lg">
    <div class="tabs" role="tablist" aria-label="Kasir">
      <button role="tab" id="t-sale" aria-controls="p-sale" data-tab="penjualan">Kasir</button>
      <button role="tab" id="t-today" aria-controls="p-today" data-tab="hari-ini">Hari ini</button>
    </div>
    <section id="p-sale" role="tabpanel" aria-labelledby="t-sale" class="stack-lg"></section>
    <section id="p-today" role="tabpanel" aria-labelledby="t-today" class="stack" hidden></section>
  </div>`;
  saleForm();
  tabs(app, (t) => {
    if (t === 'hari-ini') loadToday();
    if (t !== 'penjualan') stopCamera();
  });
}

/* ---------------- sale: 1 find the card, 2 enter the purchase, 3 done */
// VireoPOS codes for each reward, from SOP Bab 9. Stamp 10 has no code: it goes through "tukar poin".
const POS_CODE = { 3: 'Kode VireoPOS DISKONSTAMP1', 7: 'Kode VireoPOS DISKONSTAMP2', 10: 'Tukar poin di VireoPOS' };

function saleForm() {
  member = null; qty = {};
  const p = $('#p-sale');
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="m-title">
    <h2 id="m-title" class="step"><span class="step-n" aria-hidden="true">1</span>Kartu member</h2>
    <div id="m-pick" class="stack">
      <button class="btn btn-block btn-big" type="button" id="scan">Scan QR member</button>
      <div class="scan-view" id="cam" hidden><video id="video" playsinline muted></video><span class="frame" aria-hidden="true"></span></div>
      <button class="btn btn-quiet btn-block" type="button" id="cam-stop" hidden>Tutup kamera</button>
      <form id="code-form" class="code-row" novalidate>
        <label class="field"><span>Atau ketik kode kartu</span>
          <input type="text" id="card-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345" maxlength="9"></label>
        <button class="btn btn-quiet" type="submit">Cari</button>
      </form>
      <div class="notice" id="m-msg" hidden></div>
      <div class="row-between alt-row">
        <button class="btn btn-text" type="button" id="photo-btn">Scan dari foto</button>
        <input type="file" id="photo" accept="image/*" capture="environment" hidden>
        <button class="btn btn-text" type="button" id="walkin">Pembeli tanpa kartu</button>
      </div>
    </div>
    <div id="m-chip" class="stack" hidden></div>
  </section>

  <form class="panel stack-lg" id="sale" novalidate aria-labelledby="s-title" hidden>
    <h2 id="s-title" class="step"><span class="step-n" aria-hidden="true">2</span>Belanja</h2>
    <div class="stack-sm">
      <p class="muted small">Ketuk produknya kalau mau, total terisi otomatis. Boleh langsung isi total.</p>
      <div>${menu.map((m) => `
        <div class="menu-item">
          <span><span>${esc(m.name)}</span><br><span class="muted small num">${rupiah(m.price)}</span></span>
          <span class="stepper" data-id="${m.id}">
            <button type="button" data-d="-1" aria-label="Kurangi ${esc(m.name)}">−</button>
            <output aria-live="polite" id="q-${m.id}">0</output>
            <button type="button" data-d="1" aria-label="Tambah ${esc(m.name)}">+</button>
          </span>
        </div>`).join('') || '<p class="muted">Belum ada produk. Pemilik bisa menambahkannya di Pengaturan.</p>'}</div>
    </div>
    <label class="field"><span>Total di struk VireoPOS (Rp)</span>
      <input type="number" id="total" inputmode="numeric" min="1" step="1" required></label>
    <p class="stamp-preview" id="stamp-preview" aria-live="polite"></p>
    <div id="demo" class="stack" hidden>
      <fieldset class="field"><legend>Jenis kelamin pembeli <span class="hint">perkiraan, boleh dilewati</span></legend>
        <div class="choices">${GENDERS.map(([v, l]) => `<label class="choice"><input type="radio" name="gender" value="${v}"><span>${l}</span></label>`).join('')}</div></fieldset>
      <fieldset class="field"><legend>Usia pembeli <span class="hint">perkiraan, boleh dilewati</span></legend>
        <div class="choices" id="ages"></div></fieldset>
    </div>
    <div class="notice" id="s-msg" hidden></div>
    <button class="btn btn-block btn-big" type="submit" id="save">Simpan penjualan</button>
  </form>`;

  $('#scan').addEventListener('click', startCamera);
  $('#cam-stop').addEventListener('click', stopCamera);
  $('#photo-btn').addEventListener('click', () => $('#photo').click());
  $('#photo').addEventListener('change', fromPhoto);
  $('#code-form').addEventListener('submit', (e) => { e.preventDefault(); lookup($('#card-code').value); });
  $('#walkin').addEventListener('click', () => choose({ walkin: true }));
  $$('.stepper').forEach((s) => s.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = s.dataset.id; qty[id] = Math.max(0, (qty[id] || 0) + Number(b.dataset.d));
    $('#q-' + id).textContent = qty[id];
    const sum = menu.reduce((t, m) => t + (qty[m.id] || 0) * m.price, 0);
    $('#total').value = sum || '';
    preview();
  }));
  $('#total').addEventListener('input', preview);
  $('#sale').addEventListener('submit', saveSale);
}

// The member's card as staff see it: ten slots, rewards marked, and what is ready to use.
function stampRow(position, size) {
  let html = '';
  for (let i = 1; i <= size; i++) {
    const r = rewards.find((x) => x.slot === i);
    html += `<span class="sdot${i <= position ? ' on' : ''}${r ? ' gift' : ''}">${r ? `<small>${esc(shortLabel(r.label))}</small>` : ''}</span>`;
  }
  return `<div class="srow" style="--n:${size}" role="img" aria-label="${position} dari ${size} stempel">${html}</div>`;
}
function shortLabel(label) { return label.replace(/^Diskon\s*/i, '').replace(/^Gratis.*/i, 'Gratis'); }
function nextGoal(position) {
  const r = rewards.find((x) => x.slot > position);
  return r ? `${r.slot - position} stempel lagi menuju ${r.label}` : '';
}

function choose(m) {
  member = m;
  if (m.rupiah_per_stamp) settingsRupiah = m.rupiah_per_stamp;
  stopCamera();
  $('#m-pick').hidden = true;
  const chip = $('#m-chip');
  chip.hidden = false;
  if (m.walkin) {
    chip.innerHTML = `<div class="mem"><div class="mem-head"><span><strong class="mem-name">Tanpa kartu member</strong>
      <span class="muted small">Penjualan dicatat tanpa stempel.</span></span>
      <button class="btn btn-quiet" type="button" id="change">Ganti</button></div></div>`;
  } else {
    const ready = m.rewards || [];
    chip.innerHTML = `<div class="mem">
      <div class="mem-head"><span><strong class="mem-name">${esc(m.first_name)}</strong>
        <span class="muted small num">Kartu ${esc(m.card_code)}</span></span>
        <button class="btn btn-quiet" type="button" id="change">Ganti</button></div>
      ${stampRow(m.position, m.card_size)}
      <p class="mem-count"><b class="num">${m.position}</b> dari ${m.card_size} stempel<span class="muted">${nextGoal(m.position) ? ' · ' + esc(nextGoal(m.position)) : ''}</span></p>
    </div>
    ${ready.length ? `<div class="ready">
      <h3>Hadiah siap dipakai</h3>
      <ul class="list">${ready.map((r) => `<li><strong>${esc(r.label)}</strong><span class="muted small">${esc(POS_CODE[r.slot] || 'Tukar di VireoPOS')}</span></li>`).join('')}</ul>
      <p class="muted small">Kalau member mau memakainya hari ini, minta ia menekan Tukar di tab Hadiah pada kartunya, lalu masukkan kodenya di VireoPOS.</p>
    </div>` : '<p class="muted small">Belum ada hadiah yang siap dipakai.</p>'}
    ${m.via === 'kode' ? '<p class="muted small">Kode diketik manual. Pemilik akan melihat catatan ini.</p>' : ''}`;
  }
  $('#change').addEventListener('click', () => {
    member = null; $('#m-chip').hidden = true; $('#m-pick').hidden = false; $('#sale').hidden = true; preview();
  });
  const needDemo = m.walkin || !m.has_demography;
  $('#demo').hidden = !needDemo;
  $('#ages').innerHTML = AGES.filter(([v]) => m.walkin || v !== '<17')
    .map(([v, l]) => `<label class="choice"><input type="radio" name="age" value="${v}"><span>${l}</span></label>`).join('');
  $('#sale').hidden = false;
  preview();
  $('#total').focus({ preventScroll: true });
  $('#m-title').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function preview() {
  const btn = $('#save'), out = $('#stamp-preview');
  if (!member) return;
  const total = Number($('#total').value || 0);
  btn.disabled = !(total > 0);
  if (member.walkin) { btn.textContent = 'Simpan penjualan'; out.textContent = ''; return; }
  const n = Math.floor(total / settingsRupiah);
  btn.textContent = n > 0 ? `Simpan dan beri ${n} stempel` : 'Simpan penjualan';
  out.textContent = total ? (n > 0 ? `${member.first_name} dapat ${n} stempel.` : `Belum dapat stempel. 1 stempel setiap ${rupiah(settingsRupiah)}.`) : '';
}

async function lookup(raw) {
  const msg = $('#m-msg');
  notice(msg, '');
  if (!raw || !raw.trim()) { notice(msg, 'Tulis kode kartu dari layar member.'); $('#card-code').focus(); return; }
  try {
    const m = await rpc('staff_lookup', { p_scan: raw });
    choose(m);
  } catch (e) { notice(msg, e.message); }
}

async function saveSale(e) {
  e.preventDefault();
  const msg = $('#s-msg'), btn = $('#save');
  const total = Number($('#total').value);
  if (!total || total <= 0) { notice(msg, 'Isi total belanja sesuai struk.'); $('#total').focus(); return; }
  const items = menu.filter((m) => qty[m.id] > 0).map((m) => ({ name: m.name, qty: qty[m.id] }));
  const g = $('input[name="gender"]:checked'), a = $('input[name="age"]:checked');
  busy(btn, true, 'Menyimpan…');
  try {
    const r = await rpc('staff_record_sale', {
      p_ticket: member.walkin ? null : member.ticket, p_receipt_no: null, p_total: total, p_items: items,
      p_gender: g ? g.value : null, p_age_range: a ? a.value : null,
    });
    done(r, total);
  } catch (err) { notice(msg, err.message); busy(btn, false); }
}

function done(r, total) {
  stopCamera();
  const p = $('#p-sale');
  p.innerHTML = `
  <section class="panel stack done" aria-labelledby="d-title" tabindex="-1" id="done">
    <h2 id="d-title" class="step"><span class="step-n is-ok" aria-hidden="true">✓</span>Tersimpan</h2>
    ${r.member ? `
      <p class="done-big">${esc(r.first_name)} dapat <b class="num">${r.stamps}</b> stempel</p>
      ${stampRow(r.position, r.card_size)}
      <p class="mem-count"><b class="num">${r.position}</b> dari ${r.card_size} stempel<span class="muted">${nextGoal(r.position) ? ' · ' + esc(nextGoal(r.position)) : ''}</span></p>
      ${r.rewards.length ? `<p class="notice notice-ok">Hadiah siap dipakai: ${esc(r.rewards.join(', '))}.</p>` : ''}`
      : `<p class="done-big">Penjualan tanpa kartu member</p>`}
    <p class="muted small num">Total ${rupiah(total)}</p>
    <button class="btn btn-block btn-big" type="button" id="next">Pembeli berikutnya</button>
  </section>`;
  $('#next').addEventListener('click', () => { saleForm(); $('#scan').focus(); });
  $('#done').focus();
}

/* ---------------- QR reading */
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembaca QR gagal dimuat. Periksa internet, atau ketik kodenya.'));
    document.head.append(s);
  });
}

async function startCamera() {
  const msg = $('#m-msg');
  notice(msg, '');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice(msg, 'Kamera hanya bisa dipakai lewat https atau localhost. Pakai Foto QR atau Ketik kode.', 'warn');
    return;
  }
  try {
    await loadJsQR();
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    notice(msg, e.name === 'NotAllowedError' ? 'Izin kamera ditolak. Izinkan kamera di browser, atau pakai Foto QR.' : e.message);
    return;
  }
  const v = $('#video');
  v.srcObject = stream;
  await v.play();
  $('#cam').hidden = false; $('#cam-stop').hidden = false;
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
      if (hit && hit.data) { stopCamera(); if (navigator.vibrate) navigator.vibrate(60); lookup(hit.data); return; }
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

async function fromPhoto(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const msg = $('#m-msg');
  try {
    await loadJsQR();
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const hit = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    if (!hit) { notice(msg, 'QR tidak terbaca di foto itu. Foto lebih dekat dan tegak, atau ketik kodenya.'); return; }
    lookup(hit.data);
  } catch (err) { notice(msg, err.message); }
}

/* ---------------- today */
async function loadToday() {
  const p = $('#p-today');
  p.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
  let d;
  try { d = await rpc('staff_today'); }
  catch (e) { p.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; return; }
  const status = (x) => x.reversed ? '<span class="tag tag-bad">Dibatalkan</span>'
    : x.undo_pending ? '<span class="tag tag-warn">Menunggu pemilik</span>' : '';
  const undoBtn = (x, kind) => (x.reversed || x.undo_pending) ? '' : `<button class="btn btn-text" type="button" data-kind="${kind}" data-id="${x.id}">Minta batal</button>`;
  p.innerHTML = `
  <div class="panel stack">
    <h2>Penjualan saya hari ini</h2>
    ${d.sales.length ? `<ul class="list">${d.sales.map((x) => `
      <li><span class="grow"><strong class="num">${esc(time(x.created_at))}</strong>${x.receipt_no ? ' struk ' + esc(x.receipt_no) : ''}<br>
        <span class="muted small">${esc(x.member || 'Tanpa member')}, ${rupiah(x.total)}, ${x.stamps} stempel</span></span>
        ${status(x)}${undoBtn(x, 'sale')}</li>`).join('')}</ul>` : '<p class="muted">Belum ada penjualan hari ini.</p>'}
  </div>
  <div class="panel stack">
    <h2>Hadiah ditukar hari ini</h2>
    ${d.redemptions.length ? `<ul class="list">${d.redemptions.map((x) => `
      <li><span class="grow"><strong class="num">${esc(time(x.created_at))}</strong> ${esc(x.reward_label)}<br><span class="muted small">${esc(x.member || 'Member')}</span></span>
        ${status(x)}${undoBtn(x, 'redemption')}</li>`).join('')}</ul>` : '<p class="muted">Belum ada penukaran hari ini.</p>'}
  </div>
  <form class="panel stack" id="undo" hidden novalidate>
    <h2>Minta pembatalan</h2>
    <p class="muted small">Pemilik yang memutuskan. Stempel atau hadiah tetap tercatat sampai disetujui.</p>
    <label class="field"><span>Alasan</span><input type="text" id="undo-reason" placeholder="Contoh: salah scan kartu" required></label>
    <div class="notice" id="undo-msg" hidden></div>
    <div class="row"><button class="btn" type="submit">Kirim ke pemilik</button><button class="btn btn-quiet" type="button" id="undo-no">Batal</button></div>
  </form>`;
  let target = null;
  $$('[data-kind]', p).forEach((b) => b.addEventListener('click', () => {
    target = { kind: b.dataset.kind, id: Number(b.dataset.id) };
    $('#undo').hidden = false; $('#undo-reason').focus();
  }));
  $('#undo-no').addEventListener('click', () => { $('#undo').hidden = true; });
  $('#undo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Mengirim…');
    try {
      await rpc('staff_request_undo', { p_kind: target.kind, p_id: target.id, p_reason: $('#undo-reason').value });
      toast('Permintaan dikirim ke pemilik');
      loadToday();
    } catch (err) { notice($('#undo-msg'), err.message); busy(btn, false); }
  });
}

$('#logout').addEventListener('click', signOut);
window.addEventListener('pagehide', stopCamera);
start();
