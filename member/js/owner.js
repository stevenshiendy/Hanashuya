import { sb, configured, $, $$, esc, rpc, busy, notice, toast, rupiah, when, day, mountLogin, setupMissing, session, signOut, tabs, prettyPhone, signupUrl, qrSvg } from './lib.js';

const app = $('#app');
const DAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const FLAG = { kode_diketik: 'Kode kartu diketik', nomor_dicari: 'Kartu dicari lewat nomor WhatsApp', staf_sama_sering: 'Staf yang sama sering memberi stempel ke kartu ini', banyak_stempel_sehari: 'Banyak stempel dalam sehari' };
const PROBLEM = { tidak_ada_struk_cocok: 'Tidak ada struk dengan total dan jam yang sama', nama_beda: 'Nama pelanggan di VireoPOS beda' };
const LABEL = { perempuan: 'Perempuan', 'laki-laki': 'Laki-laki', tidak_disebut: 'Tidak disebut', kosong: 'Tidak diisi', '<17': 'Di bawah 17' };
let range = Number(new URLSearchParams(location.search).get('hari')) || 30;

async function start() {
  if (!configured) return setupMissing(app);
  if (!(await session())) return mountLogin(app, { staff: true, title: 'Dasbor pemilik', lead: 'Masuk dengan username atau nomor WhatsApp dan password pemilik.', onDone: boot });
  boot();
}

async function boot() {
  $('#logout').hidden = false;
  const who = await rpc('whoami').catch(() => null);
  if (!who || who.role !== 'owner') {
    app.innerHTML = `<section class="panel stack"><h1>Khusus pemilik</h1><p>Nomor ${esc(prettyPhone(who?.whatsapp) || 'ini')} bukan akun pemilik. Akun pemilik pertama diatur sekali lewat SQL, lihat README.</p></section>`;
    return;
  }
  $('#to-staff').hidden = false;
  app.innerHTML = `
  <div class="stack-lg">
    <div class="tabs" role="tablist" aria-label="Dasbor">
      <button role="tab" id="t-sum" aria-controls="p-sum" data-tab="ringkasan">Ringkasan</button>
      <button role="tab" id="t-sales" aria-controls="p-sales" data-tab="penjualan">Penjualan</button>
      <button role="tab" id="t-match" aria-controls="p-match" data-tab="cocokkan">Cocokkan struk</button>
      <button role="tab" id="t-staff" aria-controls="p-staff" data-tab="staf">Staf</button>
      <button role="tab" id="t-help" aria-controls="p-help" data-tab="bantuan">Bantuan akun</button>
      <button role="tab" id="t-set" aria-controls="p-set" data-tab="pengaturan">Pengaturan</button>
    </div>
    <section id="p-sum" role="tabpanel" aria-labelledby="t-sum" class="stack-lg"></section>
    <section id="p-sales" role="tabpanel" aria-labelledby="t-sales" class="stack" hidden></section>
    <section id="p-match" role="tabpanel" aria-labelledby="t-match" class="stack-lg" hidden></section>
    <section id="p-staff" role="tabpanel" aria-labelledby="t-staff" class="stack-lg" hidden></section>
    <section id="p-help" role="tabpanel" aria-labelledby="t-help" class="stack-lg" hidden></section>
    <section id="p-set" role="tabpanel" aria-labelledby="t-set" class="stack-lg" hidden></section>
  </div>`;
  const loaders = { ringkasan: summary, penjualan: sales, cocokkan: match, staf: staff, bantuan: help, pengaturan: settings };
  tabs(app, (t) => loaders[t]());
}

const loading = (p) => { p.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton" style="height:96px"></div><div class="skeleton"></div><div class="skeleton"></div></div>'; };
const failed = (p, e, retry) => {
  p.innerHTML = `<div class="panel stack"><div class="notice notice-error" role="alert">${esc(e.message)}</div><button class="btn btn-quiet" type="button">Coba lagi</button></div>`;
  $('button', p).addEventListener('click', retry);
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

/* ---------------- summary */
async function summary() {
  const p = $('#p-sum');
  loading(p);
  let d;
  try { d = await rpc('owner_dashboard', { p_days: range }); } catch (e) { return failed(p, e, summary); }
  const t = d.totals;
  const backupDays = d.last_backup ? Math.floor((Date.now() - Date.parse(d.last_backup)) / 864e5) : null;
  p.innerHTML = `
  ${backupDays === null || backupDays >= 7 ? `<p class="notice notice-warn">${backupDays === null ? 'Data member belum pernah dicadangkan.' : `Cadangan data terakhir ${backupDays} hari lalu.`}
    <a href="#pengaturan" data-goto="t-set">Unduh cadangan di Pengaturan</a>.</p>` : ''}
  <div class="row-between">
    <h1>Ringkasan</h1>
    <fieldset><legend class="visually-hidden">Rentang waktu</legend><div class="choices" id="range">
      ${[7, 30, 90].map((n) => `<label class="choice"><input type="radio" name="range" value="${n}" ${n === range ? 'checked' : ''}><span>${n} hari</span></label>`).join('')}
    </div></fieldset>
  </div>
  ${d.undo.length ? `<section class="panel stack" aria-labelledby="undo-title">
    <h2 id="undo-title">Permintaan pembatalan (${d.undo.length})</h2>
    <ul class="list">${d.undo.map((u) => `<li><span class="grow"><strong>${esc(u.kind === 'penjualan' ? `${u.receipt_no ? 'Struk ' + u.receipt_no : 'Penjualan ' + rupiah(u.total || 0)}, ${u.stamps} stempel` : u.reward_label)}</strong> untuk ${esc(u.member)}<br>
      <span class="muted small">${esc(u.requested_by || 'Staf')}, ${esc(when(u.created_at))}: ${esc(u.reason)}</span></span>
      <span class="row"><button class="btn" type="button" data-undo="${u.id}" data-ok="1">Setujui</button><button class="btn btn-quiet" type="button" data-undo="${u.id}" data-ok="0">Tolak</button></span></li>`).join('')}</ul>
  </section>` : ''}
  ${t.sales === 0 ? `<div class="panel stack"><h2>Belum ada penjualan dalam ${d.days} hari terakhir</h2><p class="muted">Angka di sini terisi begitu kasir mencatat penjualan di halaman kasir.</p><a class="btn" href="staf.html">Buka halaman kasir</a></div>` : `
  <div class="stats">
    <div class="stat"><b>${t.sales}</b><span>Penjualan</span></div>
    <div class="stat"><b>${pct(t.member_sales, t.sales)}%</b><span>Penjualan oleh member (${t.member_sales})</span></div>
    <div class="stat"><b>${rupiah(t.revenue)}</b><span>Total belanja tercatat</span></div>
    <div class="stat"><b>${t.stamps}</b><span>Stempel diberikan</span></div>
    <div class="stat"><b>${t.redemptions}</b><span>Hadiah ditukar</span></div>
    <div class="stat"><b>${t.welcome_used ?? 0}</b><span>Voucher member baru dipakai</span></div>
    <div class="stat"><b>${t.birthday_used ?? 0}</b><span>Voucher ulang tahun dipakai</span></div>
    <div class="stat"><b>${t.new_members}</b><span>Member baru dari ${t.members}</span></div>
    <div class="stat"><b>${t.avg_days_between_visits ?? '–'}</b><span>Rata-rata hari antar kunjungan</span></div>
  </div>
  <section class="panel stack" aria-labelledby="heat-title">
    <div class="row-between"><h2 id="heat-title">Kapan pembeli datang</h2><span class="heat-legend">sepi <i></i> ramai</span></div>
    ${heatmap(d.heatmap)}
  </section>
  <div class="grid-2">
    <section class="panel stack" aria-labelledby="top-title">
      <h2 id="top-title">Produk terlaris</h2>
      ${d.top_items.length ? `<div class="table-wrap"><table><thead><tr><th>Produk</th><th class="num">Terjual</th><th class="num">Member beli lagi</th></tr></thead><tbody>
        ${d.top_items.map((i) => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${i.regulars}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">Member beli lagi: member yang membeli produk ini 2 kali atau lebih.</p>`
        : '<p class="muted">Belum ada produk tercatat. Kasir menandai produk saat mencatat penjualan.</p>'}
    </section>
    <section class="panel stack" aria-labelledby="mix-title">
      <h2 id="mix-title">Siapa pembelinya</h2>
      <h3>Jenis kelamin</h3>${bars(d.gender, ['perempuan', 'laki-laki', 'tidak_disebut', 'kosong'])}
      <h3>Usia</h3>${bars(d.age, ['<17', '17-24', '25-34', '35-44', '45+', 'tidak_disebut', 'kosong'])}
      <p class="muted small">Member mengisi sendiri. Untuk pembeli tanpa kartu, kasir memperkirakan.</p>
    </section>
  </div>
  <section class="panel stack" aria-labelledby="staff-title">
    <h2 id="staff-title">Kasir</h2>
    <div class="table-wrap"><table><thead><tr><th>Nama</th><th class="num">Penjualan</th><th class="num">Stempel</th><th class="num">Hadiah</th><th class="num">Ditandai</th></tr></thead><tbody>
      ${d.staff.map((s) => `<tr><td>${esc(s.full_name || prettyPhone(s.whatsapp))}</td><td class="num">${s.sales}</td><td class="num">${s.stamps}</td><td class="num">${s.redemptions}</td><td class="num">${s.flagged ? `<span class="tag tag-warn">${s.flagged}</span>` : 0}</td></tr>`).join('')}
    </tbody></table></div>
  </section>`}
  <section class="panel stack" aria-labelledby="flag-title">
    <h2 id="flag-title">Perlu dicek</h2>
    ${d.flags.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Struk</th><th>Member</th><th>Kasir</th><th class="num">Stempel</th><th>Catatan</th></tr></thead><tbody>
      ${d.flags.map((f) => `<tr><td class="tnum">${esc(when(f.created_at))}</td><td>${esc(f.receipt_no || '–')}</td><td>${esc(f.member)}</td><td>${esc(f.staff || '')}</td><td class="num">${f.stamps}</td><td>${f.flags.map((x) => esc(FLAG[x] || x)).join('<br>')}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Tidak ada stempel yang ditandai. Kode kartu yang diketik manual dan pola stempel yang aneh muncul di sini.</p>'}
    ${d.matched_days ? `<p>${d.mismatches.length ? `<strong>${d.mismatches.length} stempel</strong> tidak cocok dengan struk VireoPOS. Lihat tab Cocokkan struk.` : 'Semua stempel cocok dengan struk VireoPOS yang sudah diimpor.'}</p>`
      : '<p class="muted small">Impor struk VireoPOS di tab Cocokkan struk untuk mengecek setiap stempel dengan struk aslinya.</p>'}
  </section>
  <section class="panel stack" aria-labelledby="lapse-title">
    <h2 id="lapse-title">Member yang lama tidak datang</h2>
    ${d.lapsed.length ? `<ul class="list">${d.lapsed.map((l) => `<li><span class="grow"><strong>${esc(l.full_name || 'Member')}</strong><br>
      <span class="muted small">Terakhir ${esc(day(l.last_at))}, ${l.visits} kunjungan</span></span>
      ${l.whatsapp ? `<a class="btn btn-quiet" href="https://wa.me/${esc(l.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>` : '<span class="muted small">Tidak mau info promo</span>'}</li>`).join('')}</ul>`
      : '<p class="muted">Tidak ada member yang absen 30 sampai 120 hari.</p>'}
    ${d.lapsed.length ? '<p class="muted small">Tombol WhatsApp hanya muncul untuk member yang mau menerima info promo.</p>' : ''}
  </section>`;
  $$('[data-goto]', p).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $('#' + a.dataset.goto).click(); }));
  $$('#range input').forEach((r) => r.addEventListener('change', () => {
    range = Number(r.value);
    const u = new URL(location.href); u.searchParams.set('hari', range); history.replaceState(null, '', u);
    summary();
  }));
  $$('[data-undo]', p).forEach((b) => b.addEventListener('click', async () => {
    busy(b, true);
    try { await rpc('owner_decide_undo', { p_id: Number(b.dataset.undo), p_approve: b.dataset.ok === '1' }); toast(b.dataset.ok === '1' ? 'Dibatalkan' : 'Ditolak'); summary(); }
    catch (e) { toast(e.message); busy(b, false); }
  }));
}

function heatmap(cells) {
  if (!cells.length) return '<p class="muted">Belum ada data.</p>';
  const hours = cells.map((c) => c.hour);
  const lo = Math.min(...hours), hi = Math.max(...hours);
  const max = Math.max(...cells.map((c) => c.n));
  const get = (d, h) => cells.find((c) => c.dow === d && c.hour === h)?.n || 0;
  const top = cells.reduce((a, b) => (b.n > a.n ? b : a));
  const cols = hi - lo + 1;
  let html = `<p class="small">Paling ramai: <strong>${['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'][top.dow - 1]} jam ${top.hour}.00</strong>, ${top.n} penjualan.</p>
  <div class="table-wrap"><div class="heat" style="--cols:${cols}" role="img" aria-label="Jumlah penjualan per hari dan jam, paling ramai ${DAYS[top.dow - 1]} jam ${top.hour}">
    <span></span>${Array.from({ length: cols }, (_, i) => `<span class="h">${lo + i}</span>`).join('')}`;
  for (let d = 1; d <= 7; d++) {
    html += `<span class="d">${DAYS[d - 1]}</span>`;
    for (let h = lo; h <= hi; h++) {
      const n = get(d, h), v = n / max;
      html += `<span class="c${v > 0.55 ? ' hot' : ''}" style="--v:${v.toFixed(3)}" title="${DAYS[d - 1]} jam ${h}: ${n}">${n || ''}</span>`;
    }
  }
  return html + '</div></div>';
}

function bars(rows, order) {
  const total = rows.reduce((t, r) => t + Number(r.n), 0);
  if (!total) return '<p class="muted">Belum ada data.</p>';
  const sorted = order.map((k) => rows.find((r) => r.key === k)).filter(Boolean);
  return `<div class="bars">${sorted.map((r) => `<div class="bar-row"><span>${esc(LABEL[r.key] || r.key)}</span>
    <span class="track"><i style="transform:scaleX(${(r.n / total).toFixed(3)})"></i></span><span class="v">${pct(r.n, total)}%</span></div>`).join('')}</div>`;
}

/* ---------------- sales list */
async function sales() {
  const p = $('#p-sales');
  loading(p);
  let rows;
  try { rows = await rpc('owner_sales', { p_limit: 300 }); } catch (e) { return failed(p, e, sales); }
  p.innerHTML = `<div class="panel stack"><h2>300 penjualan terakhir</h2>
  ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Struk</th><th>Member</th><th>Kasir</th><th class="num">Total</th><th class="num">Stempel</th><th>Produk</th><th>Catatan</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="${r.reversed_at ? 'is-reversed' : ''}"><td class="tnum">${esc(when(r.created_at))}</td><td>${esc(r.receipt_no || '–')}</td><td>${esc(r.member || '–')}</td><td>${esc(r.staff || '')}</td>
    <td class="num">${rupiah(r.total)}</td><td class="num">${r.stamps}</td><td>${esc((r.items || []).map((i) => i.qty + '× ' + i.name).join(', '))}</td>
    <td>${r.reversed_at ? 'Dibatalkan' : r.flags.map((x) => esc(FLAG[x] || x)).join(', ')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Belum ada penjualan.</p>'}</div>`;
}

/* ---------------- receipt matching */
function parseCSV(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// VireoPOS gives .xls files (Laporan Penjualan Rinci). SheetJS reads them in the browser;
// the sheet "Rangkuman" has one row per receipt, under a few title rows.
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembaca file Excel gagal dimuat. Periksa internet, atau simpan file sebagai CSV.'));
    document.head.append(s);
  });
}
async function readRows(file) {
  if (/\.csv$/i.test(file.name)) return parseCSV(await file.text());
  await loadSheetJS();
  const book = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = book.Sheets['Rangkuman'] || book.Sheets[book.SheetNames[0]];
  const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
    .map((r) => r.map((c) => String(c ?? '')));
  const head = rows.findIndex((r) => r.some((c) => /nomor struk|no\.?\s*struk|receipt/i.test(c)));
  return (head > 0 ? rows.slice(head) : rows).filter((r) => r.some((c) => c.trim()));
}

function parseWhen(dateStr, timeStr) {
  let s = String(dateStr ?? '').trim();
  if (timeStr) s += ' ' + String(timeStr).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}+07:00`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T,]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] || '00'}+07:00`;
  return null;
}

function parseMoney(s) {
  let v = String(s || '').replace(/[^\d.,]/g, '');
  v = v.replace(/[.,]\d{1,2}$/, '').replace(/[.,]/g, '');
  return v ? Number(v) : null;
}

async function match() {
  const p = $('#p-match');
  p.innerHTML = `
  <div class="panel stack">
    <h1>Cocokkan struk</h1>
    <p>Di VireoPOS, unduh <strong>Laporan Penjualan Rinci</strong> lalu unggah filenya di sini (.xls atau .csv). Setiap stempel dipasangkan dengan satu struk VireoPOS yang totalnya sama dan jamnya paling dekat, selisih paling lama 15 menit. Satu struk hanya bisa dipakai satu stempel, dan nama pelanggan di struk ikut dicek.</p>
    <label class="field"><span>File laporan dari VireoPOS</span><input type="file" id="csv" accept=".xls,.xlsx,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
    <div class="notice" id="csv-msg" hidden></div>
    <div id="map" class="stack" hidden></div>
  </div>
  <div class="panel stack" id="mm"><div class="skeleton"></div></div>`;
  $('#csv').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    let rows;
    try { rows = await readRows(f); } catch (err) { notice($('#csv-msg'), err.message || 'File tidak bisa dibaca.'); return; }
    if (rows.length < 2) { notice($('#csv-msg'), 'File kosong atau bukan laporan penjualan.'); return; }
    notice($('#csv-msg'), '');
    mapColumns(rows);
  });
  loadMismatches();
}

function mapColumns(rows) {
  const head = rows[0].map((h) => h.trim());
  const guess = (re) => head.findIndex((h) => re.test(h));
  const g = {
    // "Nomor Struk" first: VireoPOS also has a "No" column that only counts the rows.
    no: [/nomor struk|no\.?\s*struk/i, /receipt|invoice|nota|no\.?\s*trans/i, /struk|nomor/i].map(guess).find((i) => i >= 0) ?? -1,
    date: guess(/^tanggal$|tanggal|date|waktu|time/i),
    time: guess(/^jam$|^time$|^waktu$/i),
    total: head.findIndex((h) => /^total$/i.test(h)) >= 0 ? head.findIndex((h) => /^total$/i.test(h)) : guess(/grand|total|jumlah|amount|nominal/i),
    customer: guess(/pelanggan|customer|nama/i),
    status: guess(/^status$/i),
  };
  if (g.time === g.date) g.time = -1;
  const opts = (sel, none) => `${none ? '<option value="-1">Tidak ada</option>' : ''}${head.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || 'Kolom ' + (i + 1))}</option>`).join('')}`;
  const m = $('#map');
  m.hidden = false;
  m.innerHTML = `
    <h2>Pilih kolom</h2>
    <div class="form-grid">
      <label class="field"><span>Nomor struk</span><select id="c-no">${opts(g.no)}</select></label>
      <label class="field"><span>Tanggal dan jam</span><select id="c-date">${opts(g.date)}</select></label>
      <label class="field"><span>Jam, jika kolomnya terpisah</span><select id="c-time">${opts(g.time, true)}</select></label>
      <label class="field"><span>Total</span><select id="c-total">${opts(g.total)}</select></label>
      <label class="field"><span>Nama pelanggan</span><select id="c-cust">${opts(g.customer, true)}</select></label>
    </div>
    <div id="prev"></div>
    <button class="btn" type="button" id="imp">Impor struk</button>`;
  const read = () => {
    const ix = { no: +$('#c-no').value, date: +$('#c-date').value, time: +$('#c-time').value, total: +$('#c-total').value, cust: +$('#c-cust').value };
    const out = [], bad = [];
    let cancelled = 0, free = 0;
    rows.slice(1).forEach((r, i) => {
      // Cancelled receipts never count as a sale; Rp0 receipts (free products) earn no
      // stamp; a row without a number is the TOTAL line at the bottom of the report.
      if (g.status >= 0 && /cancel|batal|void/i.test(r[g.status] || '')) { cancelled++; return; }
      const sold = parseWhen(r[ix.date], ix.time >= 0 ? r[ix.time] : '');
      const no = (r[ix.no] || '').trim(), total = parseMoney(r[ix.total]);
      if (!no) return;
      if (total === 0) { free++; return; }
      if (!sold || !total) { bad.push(i + 2); return; }
      out.push({ receipt_no: no, sold_at: sold, total, customer: ix.cust >= 0 ? (r[ix.cust] || '').trim() : '' });
    });
    return { out, bad, cancelled, free };
  };
  const show = () => {
    const { out, bad, cancelled, free } = read();
    $('#prev').innerHTML = `<p>${out.length} struk siap diimpor.${cancelled || free ? ` Dilewati: ${[cancelled ? cancelled + ' struk batal' : '', free ? free + ' struk Rp0' : ''].filter(Boolean).join(', ')}.` : ''}${bad.length ? ` <span class="tag tag-warn">${bad.length} baris dilewati</span> (baris ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ', …' : ''}), tanggal, nomor, atau totalnya tidak terbaca.` : ''}</p>
      ${out.length ? `<div class="table-wrap"><table><thead><tr><th>Struk</th><th>Waktu</th><th>Pelanggan</th><th class="num">Total</th></tr></thead><tbody>
      ${out.slice(0, 5).map((o) => `<tr><td>${esc(o.receipt_no)}</td><td class="tnum">${esc(when(o.sold_at))}</td><td>${esc(o.customer || '–')}</td><td class="num">${rupiah(o.total)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    $('#imp').disabled = !out.length;
  };
  $$('select', m).forEach((s) => s.addEventListener('change', show));
  show();
  $('#imp').addEventListener('click', async (e) => {
    const { out } = read();
    busy(e.currentTarget, true, 'Mengimpor…');
    try {
      const r = await rpc('owner_import_receipts', { p_rows: out });
      m.hidden = true;
      notice($('#csv-msg'), `${r.imported} struk diimpor.`, 'ok');
      loadMismatches();
    } catch (err) { notice($('#csv-msg'), err.message); busy(e.currentTarget, false); }
  });
}

async function loadMismatches() {
  const box = $('#mm');
  try {
    const d = await rpc('owner_dashboard', { p_days: 90 });
    box.innerHTML = `<h2>Hasil pengecekan, 90 hari</h2>
    ${!d.matched_days ? '<p class="muted">Belum ada struk yang diimpor.</p>'
      : d.mismatches.length ? `<p>${d.mismatches.length} stempel perlu dicek, dari ${d.matched_days} hari yang struknya sudah diimpor.</p>
      <div class="table-wrap"><table><thead><tr><th>Waktu stempel</th><th>Member</th><th class="num">Total</th><th class="num">Stempel</th><th>Struk VireoPOS</th><th>Pelanggan di VireoPOS</th><th>Masalah</th></tr></thead><tbody>
      ${d.mismatches.map((x) => `<tr><td class="tnum">${esc(when(x.created_at))}</td><td>${esc(x.member || '–')}</td><td class="num">${rupiah(x.total)}</td><td class="num">${x.stamps}</td>
        <td>${x.pos_no ? `${esc(x.pos_no)}<br><span class="muted tnum">${esc(when(x.sold_at))}</span>` : '–'}</td><td>${esc(x.pos_customer || '–')}</td>
        <td><span class="tag ${x.problem === 'nama_beda' ? 'tag-warn' : 'tag-bad'}">${esc(PROBLEM[x.problem] || x.problem)}</span></td></tr>`).join('')}</tbody></table></div>`
      : `<p><span class="tag tag-ok">Cocok</span> Semua stempel cocok dengan struk VireoPOS dari ${d.matched_days} hari yang sudah diimpor.</p>`}`;
  } catch (e) { box.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; }
}

/* ---------------- staff access */
async function staff() {
  const p = $('#p-staff');
  loading(p);
  let people;
  try { people = await rpc('owner_people'); } catch (e) { return failed(p, e, staff); }
  p.innerHTML = `
  <div class="panel stack">
    <div class="row-between"><h1>Staf</h1><span class="muted small">${people.length} akun aktif</span></div>
    <p class="muted small">Hanya akun di sini yang bisa memberi stempel dan melihat penukaran hadiah. Staf masuk di halaman kasir dengan username atau nomor dan password dari Anda.</p>
    <ul class="list">${people.map((x) => `<li>
      <span class="grow"><strong>${esc(x.full_name || 'Tanpa nama')}</strong>${x.is_me ? ' <span class="muted small">(Anda)</span>' : ''}<br><span class="muted small num">${x.username ? '@' + esc(x.username) + ', ' : ''}${esc(prettyPhone(x.whatsapp))}</span></span>
      <span class="tag">${x.role === 'owner' ? 'Pemilik' : 'Kasir'}</span>
      <span class="row">
        <button class="btn btn-text" type="button" data-reset="${esc(x.whatsapp)}" data-name="${esc(x.full_name || prettyPhone(x.whatsapp))}">Ganti password</button>
        ${x.is_me ? '' : `<button class="btn btn-text" type="button" data-remove="${esc(x.whatsapp)}" data-name="${esc(x.full_name || prettyPhone(x.whatsapp))}">Hapus</button>`}
      </span></li>`).join('')}</ul>
    <div class="panel-sunk stack-sm" id="remove" hidden>
      <p id="remove-text"></p>
      <div class="row"><button class="btn btn-danger" type="button" id="remove-yes">Ya, hapus akses</button><button class="btn btn-quiet" type="button" id="remove-no">Batal</button></div>
      <div class="notice" id="remove-msg" hidden></div>
    </div>
    <form class="panel-sunk stack-sm" id="reset" hidden novalidate>
      <h2 id="reset-title">Ganti password</h2>
      <div class="form-grid">
        <label class="field"><span>Password baru, minimal 8 karakter</span><input type="text" id="reset-pin" autocomplete="off" spellcheck="false"></label>
        <button class="btn" type="submit">Simpan password</button>
        <button class="btn btn-quiet" type="button" id="reset-no">Batal</button>
      </div>
      <p class="muted small">Berikan password baru langsung ke staf. Password lama langsung tidak berlaku.</p>
      <div class="notice" id="reset-msg" hidden></div>
    </form>
  </div>
  <form class="panel stack" id="add" novalidate aria-labelledby="add-title">
    <h2 id="add-title">Tambah staf</h2>
    <div class="form-grid">
      <label class="field"><span>Nama</span><input type="text" id="add-name" autocomplete="off" required></label>
      <label class="field"><span>Username</span><input type="text" id="add-username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" required></label>
      <label class="field"><span>Nomor WhatsApp</span><input type="tel" id="add-phone" inputmode="tel" placeholder="0812 3456 7890" required></label>
      <label class="field"><span>Password awal, minimal 8 karakter</span><input type="text" id="add-pin" autocomplete="off" spellcheck="false" required></label>
      <label class="field"><span>Peran</span><select id="add-role"><option value="staff">Kasir</option><option value="owner">Pemilik</option></select></label>
    </div>
    <p class="muted small">Pakai nomor kerja staf. Nomor yang sudah dipakai untuk kartu member tidak bisa jadi akun staf. Peran Pemilik bisa melihat dasbor ini. Berikan username dan password langsung ke staf.</p>
    <div class="notice" id="add-msg" hidden></div>
    <button class="btn" type="submit" style="justify-self:start">Tambah staf</button>
  </form>`;

  $('#add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), msg = $('#add-msg');
    const pin = $('#add-pin').value, username = $('#add-username').value.trim().toLowerCase();
    if (!$('#add-name').value.trim()) { notice(msg, 'Isi nama staf.'); $('#add-name').focus(); return; }
    if (!/^[a-z0-9._]{3,20}$/.test(username)) { notice(msg, 'Username 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.'); $('#add-username').focus(); return; }
    if (pin.length < 8) { notice(msg, 'Password minimal 8 karakter.'); $('#add-pin').focus(); return; }
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('owner_add_staff', { p_name: $('#add-name').value, p_username: username, p_phone: $('#add-phone').value, p_password: pin, p_role: $('#add-role').value });
      toast(`${$('#add-name').value.trim()} bisa masuk di halaman kasir`);
      staff();
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });

  let resetFor = '', removeFor = '';
  $$('[data-reset]', p).forEach((b) => b.addEventListener('click', () => {
    resetFor = b.dataset.reset;
    $('#remove').hidden = true;
    $('#reset-title').textContent = `Ganti password ${b.dataset.name}`;
    $('#reset').hidden = false; $('#reset-pin').value = ''; notice($('#reset-msg'), ''); $('#reset-pin').focus();
  }));
  $('#reset-no').addEventListener('click', () => { $('#reset').hidden = true; });
  $('#reset').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), pin = $('#reset-pin').value;
    if (pin.length < 8) { notice($('#reset-msg'), 'Password minimal 8 karakter.'); return; }
    busy(btn, true, 'Menyimpan…');
    try { await rpc('owner_reset_password', { p_phone: resetFor, p_password: pin }); $('#reset').hidden = true; toast('Password baru tersimpan'); }
    catch (err) { notice($('#reset-msg'), err.message); }
    busy(btn, false);
  });

  $$('[data-remove]', p).forEach((b) => b.addEventListener('click', () => {
    removeFor = b.dataset.remove;
    $('#reset').hidden = true;
    $('#remove-text').textContent = `Hapus akses ${b.dataset.name}? Ia tidak bisa masuk lagi. Penjualan yang pernah ia catat tetap tersimpan.`;
    $('#remove').hidden = false; notice($('#remove-msg'), ''); $('#remove-no').focus();
  }));
  $('#remove-no').addEventListener('click', () => { $('#remove').hidden = true; });
  $('#remove-yes').addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Menghapus…');
    try { await rpc('owner_remove_staff', { p_phone: removeFor }); toast('Akses dihapus'); staff(); }
    catch (err) { notice($('#remove-msg'), err.message); busy(e.currentTarget, false); }
  });
}

/* ---------------- account help: reset codes sent by hand on WhatsApp */
/* Paper voucher codes (voucher_codes): per print run, how many are printed, saved to a
   card and used. "Dipakai" should match the VireoPOS count of the batch's code (MANIS). A
   code someone else claimed first can be moved to the right member, or freed. */
async function codePanel(p) {
  p.insertAdjacentHTML('beforeend', `
  <section class="panel stack" aria-labelledby="codes-title">
    <h2 id="codes-title">Voucher kertas</h2>
    <div id="codes-report"><div class="skeleton"></div></div>
    <p class="muted small">Cek tiap minggu: jumlah "Dipakai" harus sama dengan jumlah pemakaian kode kasirnya di VireoPOS. Selisih berarti kode kasir dipakai tanpa voucher.</p>
    <form class="stack-sm" id="move-code" novalidate>
      <h3>Pindahkan voucher</h3>
      <p class="muted small">Kalau voucher seseorang sudah tersimpan di akun lain (misalnya orang lain scan duluan). Kosongkan nomor untuk melepas kodenya.</p>
      <div class="row">
        <label class="field" style="flex:1 1 10rem"><span>Kode voucher</span><input type="text" id="mv-code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="K7PX-3MQ9"></label>
        <label class="field" style="flex:1 1 12rem"><span>Nomor WhatsApp atau username member</span><input type="text" id="mv-to" autocomplete="off"></label>
        <button class="btn btn-quiet" type="submit" style="align-self:end">Pindahkan</button>
      </div>
      <div class="notice" id="mv-msg" hidden></div>
    </form>
  </section>`);
  const report = async () => {
    try {
      const rows = await rpc('owner_code_report');
      $('#codes-report').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>Voucher</th><th>Kode kasir</th><th>Berlaku s.d.</th><th class="num">Dicetak</th><th class="num">Tersimpan</th><th class="num">Dipakai</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.title)}<br><span class="muted small">${esc(r.label)}</span></td><td>${esc(r.pos_code || '–')}</td><td class="tnum">${esc(day(r.ends_on))}</td><td class="num">${r.printed}</td><td class="num">${r.claimed}</td><td class="num">${r.used}</td></tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Belum ada voucher kertas.</p>';
    } catch (e) { $('#codes-report').innerHTML = `<p class="notice notice-error">${esc(e.message)}</p>`; }
  };
  report();
  $('#move-code').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), msg = $('#mv-msg');
    busy(btn, true, 'Memindahkan…');
    try {
      const r = await rpc('owner_move_code', { p_code: $('#mv-code').value, p_login: $('#mv-to').value.trim() || null });
      notice(msg, r.member ? `Voucher ${r.code} sekarang di kartu ${r.member}.` : `Kode ${r.code} dilepas. Bisa disimpan lagi oleh siapa saja.`, 'ok');
      e.currentTarget.reset();
      report();
    } catch (err) { notice(msg, err.message); }
    busy(btn, false);
  });
}

function help() {
  const p = $('#p-help');
  p.innerHTML = `
  <div class="panel stack">
    <h1>Bantuan akun</h1>
    <p>Saat member atau staf lupa password, mereka mengirim pesan ke WhatsApp Hanashuya. Cari akunnya di sini, buat kode, lalu kirim kode itu ke nomor akun tersebut. Kode berlaku 15 menit dan hanya bisa dipakai sekali.</p>
    <p class="notice notice-warn">Kirim kode hanya ke nomor yang tercatat di akun, bukan ke nomor lain yang meminta.</p>
    <form class="row" id="find" novalidate role="search">
      <label class="field" style="flex:1 1 16rem"><span>Nama, username, atau nomor</span><input type="search" id="find-q" autocomplete="off"></label>
      <button class="btn" type="submit" style="align-self:end">Cari</button>
    </form>
    <div id="found"></div>
  </div>`;
  codePanel(p);
  $('#find').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#found'), q = $('#find-q').value.trim();
    if (q.length < 3) { box.innerHTML = '<p class="muted">Tulis minimal 3 huruf atau angka.</p>'; return; }
    box.innerHTML = '<div class="skeleton"></div>';
    let rows;
    try { rows = await rpc('owner_find_account', { p_query: q }); } catch (err) { box.innerHTML = `<div class="notice notice-error">${esc(err.message)}</div>`; return; }
    box.innerHTML = rows.length ? `<ul class="list">${rows.map((r) => `<li>
      <span class="grow"><strong>${esc(r.full_name || 'Tanpa nama')}</strong> <span class="tag">${r.role === 'member' ? 'Member' : r.role === 'owner' ? 'Pemilik' : 'Kasir'}</span><br>
        <span class="muted small num">${r.username ? '@' + esc(r.username) + ', ' : ''}${esc(prettyPhone(r.whatsapp))}</span></span>
      <span class="row">${r.role === 'member' ? `<button class="btn btn-quiet" type="button" data-bd="${esc(r.username || r.whatsapp)}" data-bd-now="${esc(r.birth_date || '')}">Tanggal lahir</button>` : ''}
      <button class="btn btn-quiet" type="button" data-code="${esc(r.username || r.whatsapp)}" data-wa="${esc(r.whatsapp)}" data-name="${esc(r.full_name || '')}">Buat kode</button></span>
      <div class="code-out" hidden style="flex-basis:100%"></div></li>`).join('')}</ul>` : '<p class="muted">Tidak ada akun yang cocok.</p>';
    $$('[data-bd]', box).forEach((b) => b.addEventListener('click', () => {
      const out = b.closest('li').querySelector('.code-out');
      out.hidden = false;
      out.innerHTML = `<form class="panel-sunk stack-sm" novalidate>
        <p class="small">Member tidak bisa mengubah tanggal lahir sendiri karena dipakai untuk hadiah ulang tahun. Ganti hanya setelah dicek, misalnya dari KTP.</p>
        <label class="field"><span>Tanggal lahir</span><input type="date" value="${esc(b.dataset.bdNow)}" required></label>
        <div class="notice" hidden></div>
        <div class="row"><button class="btn" type="submit">Simpan tanggal lahir</button></div></form>`;
      const f = $('form', out);
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = $('button[type="submit"]', f), val = $('input', f).value;
        if (!val) { notice($('.notice', f), 'Isi tanggal lahir.'); return; }
        busy(btn, true, 'Menyimpan…');
        try { await rpc('owner_set_birth_date', { p_login: b.dataset.bd, p_birth_date: val }); b.dataset.bdNow = val; toast('Tanggal lahir tersimpan'); out.hidden = true; }
        catch (err) { notice($('.notice', f), err.message); busy(btn, false); }
      });
      $('input', f).focus();
    }));
    $$('[data-code]', box).forEach((b) => b.addEventListener('click', async () => {
      const out = b.closest('li').querySelector('.code-out');
      busy(b, true, 'Membuat…');
      try {
        const r = await rpc('owner_issue_reset_code', { p_login: b.dataset.code });
        const first = (r.full_name || '').split(' ')[0];
        const text = `Halo ${first}, ini kode untuk membuat password baru kartu member Hanashuya: ${r.code}. Berlaku 15 menit. Buka halaman kartu member, tekan Lupa password, lalu masukkan kode ini. Jangan bagikan kode ini ke siapa pun.`;
        out.hidden = false;
        out.innerHTML = `<div class="panel-sunk stack-sm"><p>Kode untuk ${esc(r.full_name || '')}: <strong class="big-code" style="font-size:var(--text-xl)">${esc(r.code)}</strong></p>
          <div class="row"><a class="btn" href="https://wa.me/${esc(r.whatsapp)}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Kirim lewat WhatsApp ke ${esc(prettyPhone(r.whatsapp))}</a></div>
          <p class="muted small">Tombol ini membuka chat dengan nomor akun dan pesan yang sudah terisi. Anda tinggal menekan kirim.</p></div>`;
      } catch (err) { out.hidden = false; out.innerHTML = `<div class="notice notice-error">${esc(err.message)}</div>`; }
      busy(b, false);
    }));
  });
  $('#find-q').focus();
}

/* ---------------- backup: one Excel file, a sheet per table */
const BACKUP_SHEETS = [
  ['akun', 'Akun'], ['penjualan', 'Penjualan'], ['hadiah_dipakai', 'Hadiah dipakai'], ['kartu_penuh', 'Kartu penuh'],
  ['persetujuan', 'Persetujuan'], ['pembatalan', 'Pembatalan'], ['struk_vireopos', 'Struk VireoPOS'],
  ['promo', 'Promo'], ['produk', 'Produk'], ['aturan_hadiah', 'Aturan hadiah'], ['catatan_aktivitas', 'Catatan aktivitas'],
];
async function downloadBackup(e) {
  const btn = e.currentTarget, msg = $('#backup-msg');
  notice(msg, '');
  busy(btn, true, 'Menyiapkan…');
  try {
    await loadSheetJS();
    const d = await rpc('owner_backup');
    const X = window.XLSX, book = X.utils.book_new();
    // Lists and objects inside a row (products bought, flags) are kept as text.
    const flat = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));
    const info = [['Cadangan Hanashuya', ''], ['Dibuat', d.dibuat], ['Versi', d.versi],
      ...Object.entries(d.pengaturan || {}).map(([k, v]) => [k, v])];
    X.utils.book_append_sheet(book, X.utils.aoa_to_sheet(info), 'Info');
    BACKUP_SHEETS.forEach(([key, name]) => {
      const rows = (d[key] || []).map(flat);
      X.utils.book_append_sheet(book, rows.length ? X.utils.json_to_sheet(rows) : X.utils.aoa_to_sheet([['Kosong']]), name);
    });
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
    X.writeFile(book, `hanashuya-cadangan-${ymd}.xlsx`);
    notice(msg, `Tersimpan: ${(d.akun || []).length} akun, ${(d.penjualan || []).length} penjualan. Pindahkan file ke Google Drive atau iCloud pribadi.`, 'ok');
  } catch (err) { notice(msg, err.message); }
  busy(btn, false);
}

/* ---------------- settings */
async function settings() {
  const p = $('#p-set');
  loading(p);
  let s;
  try { s = await rpc('owner_settings'); } catch (e) { return failed(p, e, settings); }
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="join-title">
    <h2 id="join-title">QR pendaftaran member</h2>
    <div class="join-row">
      <div class="join-qr" role="img" aria-label="QR pendaftaran member">${qrSvg(signupUrl())}</div>
      <div class="stack-sm">
        <p>Pembeli scan QR ini dengan HP-nya dan langsung masuk ke formulir daftar, tanpa membuka situs dulu. Alamatnya <span class="num">${esc(signupUrl().replace(/^https?:\/\//, ''))}</span>.</p>
        <p class="muted small">Cetak posternya untuk meja kasir. Kasir juga bisa menampilkan QR ini di tablet lewat tombol "Belum member? Tunjukkan QR daftar".</p>
        <div class="row"><a class="btn" href="qr-daftar.html">Buka poster untuk dicetak</a></div>
      </div>
    </div>
  </section>

  <section class="panel stack" aria-labelledby="backup-title">
    <h2 id="backup-title">Cadangan data</h2>
    <p>${s.last_backup ? `Terakhir diunduh ${esc(when(s.last_backup))}.` : 'Belum pernah diunduh.'}</p>
    <p class="muted small">Supabase versi gratis tidak menyimpan cadangan otomatis. Unduh seminggu sekali dan simpan di Google Drive atau iCloud pribadi. File ini berisi data pribadi member, jadi jangan dibagikan.</p>
    <div class="notice" id="backup-msg" hidden></div>
    <button class="btn" type="button" id="backup">Unduh cadangan</button>
  </section>

  <form class="panel stack" id="rules" novalidate>
    <h1>Aturan kartu</h1>
    <div class="form-grid">
      <label class="field"><span>Jam buka</span><input type="time" id="open" value="${s.open_time}"></label>
      <label class="field"><span>Jam tutup</span><input type="time" id="close" value="${s.close_time}"></label>
      <label class="field"><span>Belanja per stempel (Rp)</span><input type="number" id="rupiah" min="1000" step="1000" value="${s.rupiah_per_stamp}"></label>
      <label class="field"><span>Tandai kartu yang dapat lebih dari … stempel sehari</span><input type="number" id="max" min="1" value="${s.max_stamps_per_day}"></label>
      <label class="field"><span>Selisih jam dengan struk (menit)</span><input type="number" id="late" min="1" value="${s.late_minutes}"></label>
    </div>
    <p class="muted small">Stempel ditolak di luar jam buka. Tidak ada batas stempel per hari: setiap belanja tetap dapat stempel, tapi kartu yang melewati angka di atas muncul di Ringkasan, bagian Perlu dicek. Hadiah tetap di stempel ke-3, ke-7, dan ke-10 seperti kartu cetak.</p>
    <div class="notice" id="rules-msg" hidden></div>
    <button class="btn" type="submit">Simpan aturan</button>
  </form>

  <section class="panel stack" aria-labelledby="menu-title">
    <h2 id="menu-title">Produk di halaman kasir</h2>
    <div class="table-wrap"><table><thead><tr><th>Nama</th><th>Harga (Rp)</th><th>Tampil</th><th></th></tr></thead><tbody>
    ${s.menu.map((m) => `<tr data-menu="${m.id}"><td><input type="text" value="${esc(m.name)}" aria-label="Nama produk"></td>
      <td><input type="number" value="${m.price}" min="0" step="500" aria-label="Harga"></td>
      <td><label class="check"><input type="checkbox" ${m.active ? 'checked' : ''}><span>Tampil</span></label></td>
      <td><button class="btn btn-quiet" type="button">Simpan</button></td></tr>`).join('')}
    <tr data-menu=""><td><input type="text" placeholder="Produk baru" aria-label="Nama produk baru"></td><td><input type="number" min="0" step="500" aria-label="Harga produk baru"></td>
      <td><label class="check"><input type="checkbox" checked><span>Tampil</span></label></td><td><button class="btn" type="button">Tambah</button></td></tr>
    </tbody></table></div>
  </section>

  <section class="panel stack" aria-labelledby="camp-title">
    <h2 id="camp-title">Promo untuk member</h2>
    ${s.campaigns.length ? `<ul class="list">${s.campaigns.map((c) => `<li><span class="grow"><strong>${esc(c.title)}</strong><br>
      <span class="muted small">${esc(day(c.starts_on))} sampai ${esc(day(c.ends_on))}</span></span>
      <span class="tag ${c.active ? 'tag-ok' : ''}">${c.active ? 'Aktif' : 'Nonaktif'}</span>
      <button class="btn btn-text" type="button" data-camp='${esc(JSON.stringify(c))}'>Ubah</button></li>`).join('')}</ul>` : '<p class="muted">Belum ada promo.</p>'}
    <form class="stack" id="camp" novalidate>
      <input type="hidden" id="camp-id">
      <label class="field"><span>Judul</span><input type="text" id="camp-title-in" maxlength="80" placeholder="Contoh: Mini choux isi 8 lebih hemat tiap Selasa"></label>
      <label class="field"><span>Isi</span><textarea id="camp-body" maxlength="300"></textarea></label>
      <div class="form-grid">
        <label class="field"><span>Mulai</span><input type="date" id="camp-start"></label>
        <label class="field"><span>Selesai</span><input type="date" id="camp-end"></label>
        <label class="check"><input type="checkbox" id="camp-active" checked><span>Tampilkan ke member</span></label>
      </div>
      <div class="notice" id="camp-msg" hidden></div>
      <button class="btn" type="submit">Simpan promo</button>
    </form>
  </section>`;
  const ymd = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(ms));
  $('#camp-start').value = ymd(Date.now());
  $('#camp-end').value = ymd(Date.now() + 14 * 864e5);

  $('#backup').addEventListener('click', downloadBackup);
  $('#rules').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('owner_save_settings', { p_open: $('#open').value, p_close: $('#close').value, p_rupiah: +$('#rupiah').value, p_max: +$('#max').value, p_late: +$('#late').value });
      toast('Aturan tersimpan'); busy(btn, false); notice($('#rules-msg'), '');
    } catch (err) { notice($('#rules-msg'), err.message); busy(btn, false); }
  });
  $$('[data-menu]', p).forEach((tr) => $('button', tr).addEventListener('click', async (e) => {
    const [name, price] = $$('input[type="text"], input[type="number"]', tr).map((i) => i.value);
    const active = $('input[type="checkbox"]', tr).checked;
    busy(e.currentTarget, true);
    try { await rpc('owner_save_menu_item', { p_id: tr.dataset.menu ? Number(tr.dataset.menu) : null, p_name: name, p_price: Number(price || 0), p_active: active }); toast('Produk tersimpan'); settings(); }
    catch (err) { toast(err.message); busy(e.currentTarget, false); }
  }));
  $$('[data-camp]', p).forEach((b) => b.addEventListener('click', () => {
    const c = JSON.parse(b.dataset.camp);
    $('#camp-id').value = c.id; $('#camp-title-in').value = c.title; $('#camp-body').value = c.body;
    $('#camp-start').value = c.starts_on; $('#camp-end').value = c.ends_on; $('#camp-active').checked = c.active;
    $('#camp-title-in').focus();
  }));
  $('#camp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('owner_save_campaign', { p_id: $('#camp-id').value ? Number($('#camp-id').value) : null, p_title: $('#camp-title-in').value, p_body: $('#camp-body').value,
        p_starts: $('#camp-start').value, p_ends: $('#camp-end').value, p_active: $('#camp-active').checked });
      toast('Promo tersimpan'); settings();
    } catch (err) { notice($('#camp-msg'), err.message); busy(btn, false); }
  });
}

$('#logout').addEventListener('click', signOut);
start();
