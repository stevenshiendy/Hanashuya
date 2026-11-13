import { sb, configured, $, $$, esc, rpc, busy, notice, toast, rupiah, time, day, mountLogin, setupMissing, session, signOut, tabs, prettyPhone, toPhone, signupUrl, qrSvg, maxBirth17, RETIRE_STAF_PAGE, staffHome } from './lib.js';

import { mountApprovals, loadApprovals } from './approvals.js';
import { staffStock } from './stock.js';
import { mountKasirAbsen, stopKasirAbsen } from './attendance.js';

const app = $('#app');
let myRole = '';
let menu = [];
let member = null;      // { ticket, first_name, ... } or { walkin: true }
let qty = {};
let stream = null, scanning = false;
let settingsRupiah = 50000;
let rewards = [];       // [{ slot, label }] from the rewards table
let waitingCode = null; // a voucher QR scanned before the member card: saved once the card is found

const GENDERS = [['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki']];
const AGES = [['<17', 'Di bawah 17'], ['17-24', '17–24'], ['25-34', '25–34'], ['35-44', '35–44'], ['45+', '45+']];

async function start() {
  if (!configured) return setupMissing(app);
  // Old cashier page retired (switch in lib.js): signed out goes to the till's own sign-in.
  if (RETIRE_STAF_PAGE && !(await session().catch(() => null))) return location.replace('kasir.html');
  if (!(await session())) {
    return mountLogin(app, { staff: true, title: 'Masuk sebagai kasir', lead: 'Pakai username atau nomor WhatsApp dan password dari pemilik.', onDone: boot });
  }
  boot();
}

async function boot() {
  $('#logout').hidden = false;
  let who;
  try { who = await rpc('whoami'); } catch (e) { app.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; return; }
  if (RETIRE_STAF_PAGE && who && ['staff', 'manager', 'owner'].includes(who.role)) return location.replace(staffHome(who));
  if (!who || !['staff', 'manager', 'owner'].includes(who.role)) {
    app.innerHTML = `<section class="panel stack"><h1>Belum terdaftar sebagai kasir</h1>
      <p>Nomor <strong class="num">${esc(prettyPhone(who?.whatsapp) || 'ini')}</strong> bukan akun kasir. Akun kasir dibuat pemilik di dasbor pemilik, bagian Staf.</p>
      <button class="btn btn-quiet" type="button" id="reload">Keluar</button></section>`;
    $('#reload').addEventListener('click', signOut);
    return;
  }
  // The owner switches between this page and the dashboard from the header.
  if (who.role === 'owner') $('#to-owner').hidden = false;
  myRole = who.role;
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
      <button role="tab" id="t-join" aria-controls="p-join" data-tab="daftar-member">Daftar member</button>
      <button role="tab" id="t-stock" aria-controls="p-stock" data-tab="stok">Stok</button>
      <button role="tab" id="t-absen" aria-controls="p-absen" data-tab="absen">Absen</button>
      ${myRole === 'manager' || myRole === 'owner' ? '<button role="tab" id="t-appr" aria-controls="p-appr" data-tab="persetujuan">Persetujuan</button>' : ''}
    </div>
    <section id="p-sale" role="tabpanel" aria-labelledby="t-sale" class="stack-lg"></section>
    <section id="p-today" role="tabpanel" aria-labelledby="t-today" class="stack" hidden></section>
    <section id="p-join" role="tabpanel" aria-labelledby="t-join" class="stack" hidden></section>
    <section id="p-stock" role="tabpanel" aria-labelledby="t-stock" class="stack-lg" hidden></section>
    <section id="p-absen" role="tabpanel" aria-labelledby="t-absen" class="stack-lg" hidden></section>
    ${myRole === 'manager' || myRole === 'owner' ? '<section id="p-appr" role="tabpanel" aria-labelledby="t-appr" class="stack" hidden></section>' : ''}
  </div>`;
  saleForm();
  joinTab();
  if ($('#p-appr')) mountApprovals($('#p-appr'));
  tabs(app, (t) => {
    if (t === 'persetujuan') loadApprovals();
    if (t === 'hari-ini') loadToday();
    if (t === 'stok') staffStock($('#p-stock'), myRole);
    if (t === 'absen') mountKasirAbsen($('#p-absen')); else stopKasirAbsen();
    if (t !== 'penjualan') stopCamera();
  });
}

/* ---------------- sale: 1 find the card, 2 enter the purchase, 3 done */
// VireoPOS codes for each reward, from SOP Bab 9. Stamp 10 has no code: it goes through "tukar poin".
const POS_CODE = { 3: 'DISKONSTAMP1', 7: 'DISKONSTAMP2' };
const posStep = (slot) => POS_CODE[slot] ? `Masukkan kode ${POS_CODE[slot]} di VireoPOS` : 'Tukar poin di VireoPOS';
// The VireoPOS code the cashier enters for each voucher.
const VOUCHER_STEP = {
  welcome: 'Masukkan kode NEWMEMBER50 di VireoPOS',
  ulang_tahun: 'Masukkan kode BIRTHDAYGIFT di VireoPOS',
};
// Printed voucher codes carry their own VireoPOS code (pos_code, MANIS for the Papaya voucher).
// A paper voucher must be handed over at the booth: take it and match its code first.
const voucherStep = (v) => v.kind === 'kode'
  ? `Terima voucher kertasnya dan cocokkan kodenya, lalu masukkan kode ${v.pos_code} di VireoPOS`
  : v.pos_code ? `Masukkan kode ${v.pos_code} di VireoPOS` : (VOUCHER_STEP[v.kind] || '');
// A printed voucher's QR holds https://…/v/<code>; a typed code is 8 letters and numbers.
const voucherFromScan = (raw) => (String(raw || '').match(/\/v\/([A-Za-z0-9-]{8,9})\b/) || [])[1]?.toUpperCase().replace(/-/g, '') || null;

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
        <label class="field"><span>Tanpa QR: nomor WhatsApp atau kode kartu</span>
          <input type="text" id="card-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="0812 3456 7890" maxlength="20"></label>
        <button class="btn btn-quiet" type="submit">Cari</button>
      </form>
      <div class="notice" id="m-msg" hidden></div>
      <button class="btn btn-quiet btn-block" type="button" id="m-join" hidden>Daftarkan nomor ini</button>
      <div class="row-between alt-row">
        <button class="btn btn-text" type="button" id="photo-btn">Scan dari foto</button>
        <input type="file" id="photo" accept="image/*" capture="environment" hidden>
        <button class="btn btn-text" type="button" id="walkin">Pembeli tanpa kartu</button>
      </div>
      <button class="btn btn-quiet btn-block" type="button" id="join-qr">Belum member? Tunjukkan QR daftar</button>
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
  $('#join-qr').addEventListener('click', () => $('#t-join').click());
  $('#m-join').addEventListener('click', () => openJoinForm($('#card-code').value));
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

// A full card stays until all its rewards are used; extra stamps wait for the next card.
function cardNote(c) {
  if (c.position >= c.card_size) return ` · Kartu penuh, kartu baru dimulai setelah hadiahnya dipakai${c.waiting ? `. ${c.waiting} stempel menunggu` : ''}`;
  const goal = nextGoal(c.position);
  return goal ? ' · ' + esc(goal) : '';
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
    const ready = m.rewards || [], vouchers = m.vouchers || [];
    chip.innerHTML = `<div class="mem">
      <div class="mem-head"><span><strong class="mem-name">${esc(m.full_name || m.first_name)}</strong>
        <span class="muted small num">Kartu ${esc(m.card_code)}</span></span>
        <button class="btn btn-quiet" type="button" id="change">Ganti</button></div>
      ${m.via === 'nomor' ? `<p class="notice notice-warn">Dicari lewat nomor WhatsApp. Tanya dulu "Atas nama siapa Kak?" lalu cocokkan dengan nama di atas.</p>` : ''}
      ${m.via === 'daftar' ? `<div class="notice notice-ok stack-sm"><p>Kartu baru sudah aktif. Password awal: <b class="num start-code">${esc(m.start_code)}</b></p>
        <p class="small">Member masuk pakai nomor WhatsApp dan password awal ini, lalu langsung membuat password sendiri.</p></div>
        <a class="btn btn-quiet btn-block" href="${esc(cardWaLink(m))}" target="_blank" rel="noopener">Kirim link kartu ke WhatsApp-nya</a>` : ''}
      ${stampRow(m.position, m.card_size)}
      <p class="mem-count"><b class="num">${m.position}</b> dari ${m.card_size} stempel<span class="muted">${cardNote(m)}</span></p>
    </div>
    ${ready.length || vouchers.length ? `<div class="ready">
      <h3>Hadiah siap dipakai</h3>
      <p class="small">Tanya dulu: "Mau dipakai sekarang Kak?" Kalau iya, tekan Pakai.</p>
      <ul class="list">${vouchers.map((v) => `<li><span class="grow"><strong>${esc(v.label)}</strong> <span class="tag">${esc(v.title)}</span><br>
        <span class="muted small">${esc(voucherStep(v))}. Berlaku sampai ${esc(day(v.ends_on))}.</span></span>
        <button class="btn" type="button" data-voucher data-kind="${esc(v.kind)}" data-period="${v.period}" data-step="${esc(voucherStep(v))}">Pakai</button></li>`).join('')}${ready.map((r) => `<li><span class="grow"><strong>${esc(r.label)}</strong><br>
        <span class="muted small">${esc(posStep(r.slot))}</span></span>
        <button class="btn" type="button" data-use data-cycle="${r.cycle}" data-slot="${r.slot}">Pakai</button></li>`).join('')}</ul>
      <div class="notice" id="use-msg" hidden></div>
    </div>` : '<p class="muted small">Belum ada hadiah yang siap dipakai.</p>'}
    <form id="vc-form" class="code-row" novalidate>
      <label class="field"><span>Voucher kertas: kode di bawah QR-nya</span>
        <input type="text" id="vc-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="K7PX-3MQ9"></label>
      <button class="btn btn-quiet" type="submit">Simpan</button>
    </form>
    <div class="notice" id="vc-msg" hidden></div>
    ${m.via === 'kode' ? '<p class="muted small">Kode diketik manual. Pemilik akan melihat catatan ini.</p>' : ''}
    ${m.via === 'nomor' ? '<p class="muted small">Dicari lewat nomor. Pemilik akan melihat catatan ini.</p>' : ''}`;
  }
  $('#change').addEventListener('click', () => {
    member = null; $('#m-chip').hidden = true; $('#m-pick').hidden = false; $('#sale').hidden = true; preview();
  });
  $$('[data-use]', chip).forEach((b) => b.addEventListener('click', () => useReward(b)));
  $$('[data-voucher]', chip).forEach((b) => b.addEventListener('click', () => useVoucher(b)));
  $('#vc-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveCode($('#vc-code').value); });
  if (waitingCode && !m.walkin) { const k = waitingCode; waitingCode = null; saveCode(k); }
  else if (waitingCode && m.walkin) { waitingCode = null; toast('Voucher kertas hanya untuk member. Scan atau buat kartu member dulu.'); }
  const needDemo = m.walkin || !m.has_demography;
  $('#demo').hidden = !needDemo;
  $('#ages').innerHTML = AGES.filter(([v]) => m.walkin || v !== '<17')
    .map(([v, l]) => `<label class="choice"><input type="radio" name="age" value="${v}"><span>${l}</span></label>`).join('');
  $('#sale').hidden = false;
  preview();
  $('#total').focus({ preventScroll: true });
  $('#m-title').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// Saves a paper voucher's code to the scanned card; it then shows in the ready list.
async function saveCode(raw) {
  const msg = $('#vc-msg'), k = (voucherFromScan(raw) || String(raw || '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (k.length !== 8) { notice(msg, 'Kode voucher terdiri dari 8 huruf dan angka, misalnya K7PX-3MQ9.'); $('#vc-code')?.focus(); return; }
  notice(msg, '');
  try {
    const r = await rpc('staff_claim_code', { p_ticket: member.ticket, p_code: k });
    if (r.status !== 'tersimpan' && r.status !== 'sudah') { notice(msg, `Voucher ditolak. ${r.message}`, 'warn'); return; }
    choose({ ...r, start_code: member.start_code });   // keep a new card's starting password on screen
    toast(r.status === 'sudah' ? 'Voucher sudah ada di kartu ini. Tekan Pakai.' : 'Voucher diterima. Tekan Pakai.');
  } catch (e) { notice(msg, e.message); }
}

// The cashier uses a reward from the card scan; the member's phone shows it within seconds.
async function useReward(btn) {
  const li = btn.closest('li'), msg = $('#use-msg');
  const cycle = Number(btn.dataset.cycle), slot = Number(btn.dataset.slot);
  notice(msg, '');
  busy(btn, true, 'Memakai…');
  try {
    const r = await rpc('staff_redeem_reward', { p_ticket: member.ticket, p_cycle: cycle, p_slot: slot });
    li.innerHTML = `<span class="grow"><strong>${esc(r.label)}</strong> <span class="tag tag-ok">Dipakai ${esc(time(r.created_at))}</span><br>
      <span class="used-step">${esc(posStep(slot))}</span></span>`;
    if (r.new_card) notice(msg, `Kartu ini selesai. Kartu ke-${r.cycle + 1} dimulai${r.position ? ` dengan ${r.position} stempel` : ''}.`, 'ok');
    member.rewards = member.rewards.filter((x) => !(x.cycle === cycle && x.slot === slot));
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) { busy(btn, false); notice(msg, e.message); }
}

// New-member and birthday vouchers, used from the same scan.
async function useVoucher(btn) {
  const li = btn.closest('li'), msg = $('#use-msg'), kind = btn.dataset.kind;
  notice(msg, '');
  busy(btn, true, 'Memakai…');
  try {
    const r = await rpc('staff_use_voucher', { p_ticket: member.ticket, p_kind: kind, p_period: Number(btn.dataset.period) });
    li.innerHTML = `<span class="grow"><strong>${esc(r.label)}</strong> <span class="tag tag-ok">Dipakai ${esc(time(r.created_at))}</span><br>
      <span class="used-step">${esc(btn.dataset.step)}</span></span>`;
    member.vouchers = (member.vouchers || []).filter((v) => !(v.kind === kind && v.period === Number(btn.dataset.period)));
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (e) { busy(btn, false); notice(msg, e.message); }
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

// A typed entry is a WhatsApp number when it is 9 or more digits; a card code is
// 8 letters and numbers, and a scanned QR starts with HS1.
const looksLikePhone = (raw) => /^\+?[\d\s().-]+$/.test(raw.trim()) && raw.replace(/\D/g, '').length >= 9;

async function lookup(raw) {
  const msg = $('#m-msg'), join = $('#m-join');
  notice(msg, ''); join.hidden = true;
  if (!raw || !raw.trim()) { notice(msg, 'Tulis nomor WhatsApp member, atau kode kartu dari layar member.'); $('#card-code').focus(); return; }
  const vk = voucherFromScan(raw);
  if (vk) {
    if (member && !member.walkin) return saveCode(vk);
    waitingCode = vk;
    notice(msg, `QR voucher ${vk.slice(0, 4)}-${vk.slice(4)} terbaca. Sekarang scan QR member, voucher langsung masuk ke kartunya.`, 'ok');
    return;
  }
  const phone = looksLikePhone(raw);
  try {
    const m = phone ? await rpc('staff_find_phone', { p_phone: raw }) : await rpc('staff_lookup', { p_scan: raw });
    $('#card-code').value = '';
    choose(m);
  } catch (e) {
    // An unknown number isn't a mistake: offer to make the card for it straight away.
    const unknown = phone && /belum terdaftar/i.test(e.message);
    notice(msg, e.message, unknown ? 'warn' : 'error');
    join.hidden = !unknown;
  }
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
      <p class="mem-count"><b class="num">${r.position}</b> dari ${r.card_size} stempel<span class="muted">${cardNote(r)}</span></p>
      ${r.rewards.length ? `<p class="notice notice-ok">Hadiah siap dipakai: ${esc(r.rewards.join(', '))}.</p>` : ''}`
      : `<p class="done-big">Penjualan tanpa kartu member</p>`}
    <p class="muted small num">Total ${rupiah(total)}</p>
    <button class="btn btn-block btn-big" type="button" id="next">Pembeli berikutnya</button>
  </section>`;
  $('#next').addEventListener('click', () => { saleForm(); $('#scan').focus(); });
  $('#done').focus();
}

/* ---------------- Daftar member tab: QR for the customer's phone (fastest), the cashier
   filling in the card on this tablet when the customer asks for help (staff_create_member),
   and the link sent by WhatsApp for later. The member page itself can't be used on the
   tablet: it shares the kasir sign-in. */
const GENDER_CHOICES = [['perempuan', 'Perempuan'], ['laki-laki', 'Laki-laki'], ['tidak_disebut', 'Tidak ingin menyebutkan']];
const cardWaLink = (m) => {
  const text = `Halo Kak ${m.first_name}, kartu member Hanashuya sudah aktif. Buka ${location.origin}/member/ lalu masuk pakai nomor WhatsApp ini dan password awal ${m.start_code}. Setelah masuk, Kakak langsung diminta membuat password sendiri.`;
  return `https://wa.me/${String(m.whatsapp || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
};

// Opens the sign-up form, with the number the cashier already typed in step 1.
function openJoinForm(raw) {
  $('#t-join').click();
  const phone = toPhone(raw);
  if (phone) $('#jf-phone').value = phone.slice(3);
  $('#join-form').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('#jf-name').focus({ preventScroll: true });
}

function joinTab() {
  const url = signupUrl();
  const message = `Halo Kak, ini link daftar member Hanashuya: ${url} Setelah daftar, tunjukkan QR kartu ke kasir untuk pakai diskon 50% untuk 1 produk.`;
  const p = $('#p-join');
  p.innerHTML = `
  <section class="panel stack join-inner" aria-labelledby="join-title">
    <h2 id="join-title">Daftar member Hanashuya</h2>
    <p>Minta pembeli scan QR ini dengan kamera HP-nya. Isi data sebentar, kartu langsung aktif.</p>
    <div class="join-qr" role="img" aria-label="QR pendaftaran member">${qrSvg(url)}</div>
    <p class="muted small num">${esc(url.replace(/^https?:\/\//, ''))}</p>
    <p class="small">Setelah daftar, minta pembeli menunjukkan QR kartunya. Hadiah member baru langsung bisa dipakai.</p>
    <div class="row join-actions">
      <a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Buka formulir daftar</a>
      <button class="btn btn-quiet" type="button" id="join-copy">Salin link</button>
    </div>
  </section>
  <form class="panel stack" id="join-form" novalidate aria-labelledby="join-form-title">
    <h2 id="join-form-title">Daftarkan di tablet ini</h2>
    <p class="muted small">Kalau pembeli minta dibantu. Kasir mengisi datanya, kartu langsung terbuka di Kasir dengan password awal. Member membuat password sendiri saat pertama masuk.</p>
    <label class="field"><span>Nama lengkap</span><input type="text" id="jf-name" autocomplete="off" required></label>
    <label class="field"><span>Tanggal lahir</span><input type="date" id="jf-birth" autocomplete="off" max="${maxBirth()}" required>
      <span class="hint">Kartu member untuk usia 17 tahun ke atas.</span></label>
    <label class="field"><span>Nomor WhatsApp aktif</span>
      <span class="phone"><span class="cc" aria-hidden="true">+62</span>
      <input type="tel" id="jf-phone" inputmode="tel" autocomplete="off" placeholder="812 3456 7890" required></span>
      <span class="hint">Dipakai member untuk masuk ke kartunya.</span></label>
    <fieldset class="field"><legend>Jenis kelamin</legend>
      <div class="choices">${GENDER_CHOICES.map(([v, l]) => `<label class="choice"><input type="radio" name="jf-gender" value="${v}"><span>${l}</span></label>`).join('')}</div></fieldset>
    <label class="check"><input type="checkbox" id="jf-marketing">
      <span>Pembeli mau dapat info promo Hanashuya lewat WhatsApp. Tanya dulu, centang hanya kalau pembeli setuju.</span></label>
    <div class="notice" id="jf-msg" hidden></div>
    <button class="btn btn-block btn-big" type="submit">Buat kartu dan lanjut ke kasir</button>
  </form>
  <form class="panel stack" id="join-wa" novalidate aria-labelledby="join-wa-title">
    <h2 id="join-wa-title">Kirim link ke WhatsApp pembeli</h2>
    <p class="muted small">Untuk pembeli yang buru-buru: link daftar dikirim ke HP-nya, isi nanti.</p>
    <label class="field"><span>Nomor WhatsApp pembeli</span>
      <span class="phone"><span class="cc" aria-hidden="true">+62</span>
      <input type="tel" id="join-phone" inputmode="tel" autocomplete="off" placeholder="812 3456 7890"></span></label>
    <div class="notice" id="join-msg" hidden></div>
    <button class="btn" type="submit">Kirim lewat WhatsApp</button>
  </form>`;
  $('#join-form').addEventListener('submit', createMember);
  $('#join-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); toast('Link daftar tersalin'); }
    catch { toast(url); }
  });
  $('#join-wa').addEventListener('submit', (e) => {
    e.preventDefault();
    const phone = toPhone($('#join-phone').value);
    if (!phone) { notice($('#join-msg'), 'Tulis nomor WhatsApp yang aktif, misalnya 0812 3456 7890.'); $('#join-phone').focus(); return; }
    notice($('#join-msg'), '');
    window.open(`https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`, '_blank', 'noopener');
    $('#join-phone').value = '';
  });
}

const maxBirth = () => maxBirth17();

async function createMember(e) {
  e.preventDefault();
  const form = e.currentTarget, msg = $('#jf-msg'), btn = $('button[type="submit"]', form);
  const name = $('#jf-name').value.trim(), birth = $('#jf-birth').value, phone = toPhone($('#jf-phone').value);
  const gender = $('input[name="jf-gender"]:checked')?.value || '';
  const fail = (text, id) => { notice(msg, text); if (id) $('#' + id).focus(); };
  if (!name) return fail('Isi nama lengkap.', 'jf-name');
  if (!birth) return fail('Isi tanggal lahir.', 'jf-birth');
  if (birth > maxBirth()) return fail('Kartu member hanya untuk usia 17 tahun ke atas.', 'jf-birth');
  if (!phone) return fail('Tulis nomor WhatsApp yang aktif, misalnya 0812 3456 7890.', 'jf-phone');
  notice(msg, '');
  busy(btn, true, 'Membuat kartu…');
  try {
    const m = await rpc('staff_create_member', {
      p_name: name, p_birth_date: birth, p_phone: phone, p_gender: gender,
      p_marketing: $('#jf-marketing').checked,
    });
    busy(btn, false);
    // Clear the form so the next customer never sees this one's details.
    form.reset();
    $('#t-sale').click();
    saleForm();
    choose(m);
    toast(`Kartu ${m.first_name} sudah aktif`);
  } catch (err) { busy(btn, false); fail(err.message); }
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
    <h2>Ringkasan hari ini</h2>
    <p class="muted small">Salin laporan penjualan hari ini untuk dikirim ke grup WhatsApp Daily Sales Report.</p>
    <div class="row"><button class="btn btn-quiet" type="button" id="copy-dsr">Salin ringkasan hari ini</button></div>
    <div class="notice" id="dsr-msg" hidden></div>
  </div>
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
  $('#copy-dsr', p).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Menyiapkan…');
    try {
      const txt = await rpc('staff_daily_summary');
      await navigator.clipboard.writeText(txt);
      notice($('#dsr-msg', p), 'Tersalin. Tempel di grup WhatsApp.', 'ok');
    } catch (err) { notice($('#dsr-msg', p), err.message || 'Gagal menyalin. Coba lagi.'); }
    busy(btn, false);
  });
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
