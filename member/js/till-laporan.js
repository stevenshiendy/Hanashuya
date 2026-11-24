// Laporan on the till (Glenn, 24 Nov 2026, draft A): one report at a time, the list on the left
// (Rekap kas, Penjualan, Stok, Presensi, Member) and the day on top (Hari ini, Kemarin or a date).
// Everyone signed in on the tablet sees them; staff work blind as before: the server leaves out
// modal, uang seharusnya, selisih and setor unless a manager or the owner is signed in.
// Database: supabase/till-laporan.sql (till_report_rekap, _sales, _stock, _att, _member).
import { $, esc, rpc, rupiah } from './lib.js';

const PARTS = [
  ['rekap', 'Rekap kas', 'Per shift, cetak ulang'],
  ['jual', 'Penjualan', 'Produk, rasa, jam'],
  ['stok', 'Stok', 'Masuk, keluar, selisih'],
  ['absen', 'Presensi', 'Siapa bertugas'],
  ['member', 'Member', 'Stempel, hadiah dipakai'],
];
const L = { part: 'rekap', day: null, shift: null };

const TZ = 'Asia/Jakarta';
const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const yesterday = () => ymd(new Date(Date.now() - 864e5));
const hhmm = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(':', '.');
const dayShort = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short' }).format(new Date(iso));
const longDay = (d) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${d}T12:00:00+07:00`));
// A time on the report's own day as "21.01"; on another day with the date, "23 Nov 21.02".
const at = (iso, day) => (iso ? (ymd(new Date(iso)) === day ? hhmm(iso) : `${dayShort(iso)} ${hhmm(iso)}`) : '');
const num = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const dash = '<span class="muted">–</span>';
const span = (k, day) => `${at(k.opened_at, day)} – ${k.closed_at ? at(k.closed_at, day) : 'sekarang'}`;
const pay = (k, m) => (k.payments || []).find((x) => x.method === m)?.amount || 0;
const mins = (m) => (m >= 60 ? `${Math.floor(m / 60)} j ${m % 60 ? `${m % 60} mnt` : ''}`.trim() : `${m} mnt`);

// tools: { printRekap(k, btn, msg), shareRekap(k, btn, msg) } from till.js, so a reprint follows the
// same rules and paper setting as the close screen.
export function mountLaporan(app, tools) {
  if (!L.day) L.day = ymd();
  app.innerHTML = `<div class="lp">
    <nav class="lp-nav" aria-label="Laporan">
      <span class="hm-sec">Laporan</span>
      ${PARTS.map(([k, name, sub]) => `<button class="hm-tool" type="button" data-lp="${k}"${L.part === k ? ' aria-current="page"' : ''}>
        <span class="hm-tt"><b>${name}</b><small>${sub}</small></span><span class="hm-chev" aria-hidden="true">›</span></button>`).join('')}
    </nav>
    <section class="lp-main" aria-labelledby="lp-t">
      <div class="lp-top"><h1 id="lp-t" class="tl-title">${PARTS.find((p) => p[0] === L.part)[1]}</h1>
        <div class="lp-day" role="group" aria-label="Tanggal">
          <button class="tl-chip" type="button" data-lpday="${ymd()}">Hari ini</button>
          <button class="tl-chip" type="button" data-lpday="${yesterday()}">Kemarin</button>
          <label><span class="visually-hidden">Pilih tanggal</span><input type="date" id="lp-date" value="${L.day}" max="${ymd()}"></label></div></div>
      <div id="lp-body" class="stack"></div>
    </section></div>`;
  const chips = () => app.querySelectorAll('[data-lpday]').forEach((b) => {
    const on = b.dataset.lpday === L.day; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on));
  });
  const setDay = (d) => { if (!d || d > ymd()) return; L.day = d; L.shift = null; $('#lp-date', app).value = d; chips(); load(app, tools); };
  chips();
  app.querySelectorAll('[data-lp]').forEach((b) => b.addEventListener('click', () => { L.part = b.dataset.lp; mountLaporan(app, tools); }));
  app.querySelectorAll('[data-lpday]').forEach((b) => b.addEventListener('click', () => setDay(b.dataset.lpday)));
  $('#lp-date', app).addEventListener('change', (e) => setDay(e.target.value));
  load(app, tools);
}

let seq = 0;
async function load(app, tools) {
  const body = $('#lp-body', app), n = ++seq;
  body.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div>';
  const fn = { rekap: 'till_report_rekap', jual: 'till_report_sales', stok: 'till_report_stock', absen: 'till_report_att', member: 'till_report_member' }[L.part];
  let d;
  try { d = await rpc(fn, { p_date: L.day }); }
  catch (e) {
    if (n !== seq) return;
    const missing = /till_report|PGRST202|Could not find/i.test(e.message);
    body.innerHTML = `<p class="notice notice-${missing ? 'warn' : 'error'}" role="alert">${esc(missing
      ? 'Laporan belum aktif di database. Pemilik perlu menjalankan till-laporan.sql di Supabase.' : e.message)}</p>`;
    return;
  }
  if (n !== seq || !body.isConnected) return;
  ({ rekap: rekapView, jual: salesView, stok: stockView, absen: attView, member: memberView })[L.part](body, d, tools);
}

/* ---------------------------------------------------------------- Rekap kas */
function rekapView(body, d, tools) {
  const shifts = d.shifts || [];
  if (!shifts.length) { body.innerHTML = `<p class="muted">Tidak ada shift pada ${esc(longDay(d.date))}.</p>`; return; }
  const pick = shifts.find((k) => k.id === L.shift) || [...shifts].reverse().find((k) => k.closed) || shifts[shifts.length - 1];
  L.shift = pick.id;
  const tag = (k) => !k.closed ? '<span class="tag">Berjalan</span>'
    : k.printed_at ? `<span class="tag tag-ok">Dicetak ${esc(hhmm(k.printed_at))}${k.reprints ? ` · ${k.reprints}× ulang` : ''}</span>` : '<span class="tag tag-warn">Belum dicetak</span>';
  body.innerHTML = `<div class="lp-two">
    <div class="hm-panel">
      <h2>${shifts.length} shift · ${esc(longDay(d.date))}</h2>
      <div class="table-wrap"><table class="lp-rows">
        <thead><tr><th scope="col">Shift</th><th scope="col">Staf</th><th scope="col" class="num">Penjualan</th><th scope="col">Struk</th><th scope="col"><span class="visually-hidden">Buka</span></th></tr></thead>
        <tbody>${shifts.map((k) => `<tr${k.id === pick.id ? ' class="is-on"' : ''}>
          <td class="num">${esc(span(k, d.date))}</td><td>${esc([k.opened_by, k.closed_by].filter((x, i, a) => x && a.indexOf(x) === i).join(' → ') || '–')}</td>
          <td class="num">${rupiah(k.sales ?? k.total)}</td><td>${tag(k)}</td>
          <td>${k.id === pick.id ? '' : `<button class="tl-use" type="button" data-shift="${k.id}">Buka</button>`}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Shift masuk ke tanggal rekapnya ditutup. Shift yang ditutup lewat tengah malam masuk ke hari berikutnya.</p>
    </div>
    <div class="hm-panel" id="lp-shift"></div></div>`;
  body.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => { L.shift = Number(b.dataset.shift); rekapView(body, d, tools); }));
  shiftPanel($('#lp-shift', body), pick, d, tools, () => rekapView(body, d, tools));
}

function shiftPanel(box, k, d, tools, redraw) {
  const kv = (label, v, cls = '') => `<div class="tl-kv${cls}"><span>${label}</span><b class="num">${v}</b></div>`;
  const rows = [
    kv('Pesanan dibayar', num(k.orders)),
    kv('Total penjualan', rupiah(k.sales ?? k.total)),
    k.service_charge ? kv('Service charge', rupiah(k.service_charge)) : '',
    k.tax ? kv('PBJT', rupiah(k.tax)) : '',
    kv('QRIS', rupiah(pay(k, 'qris'))),
    kv('Tunai', rupiah(pay(k, 'tunai'))),
    k.voids?.batal_count || k.voids?.refund_count ? kv('Batal dan refund', `${num((k.voids.batal_count || 0) + (k.voids.refund_count || 0))} · ${rupiah((k.voids.batal_amount || 0) + (k.voids.refund_amount || 0))}`) : '',
    k.cash_in ? kv('Kas masuk', rupiah(k.cash_in)) : '',
    k.cash_out ? kv('Kas keluar', rupiah(k.cash_out)) : '',
  ];
  // Managers and the owner: the drawer figures staff never see.
  const full = !k.blind ? [
    kv('Uang modal', rupiah(k.opening_cash)),
    k.setor ? kv('Setor ke pemilik', rupiah(k.setor)) : '',
    kv('Uang seharusnya', rupiah(k.expected_cash)),
    k.closed ? kv('Selisih', k.difference ? `${k.difference > 0 ? '+' : '−'}${rupiah(Math.abs(k.difference))}` : 'Rp0') : '',
  ] : [];
  const staffPrinted = k.blind && k.printed_at;
  box.innerHTML = `<h2>Shift ${esc(span(k, d.date))}</h2>
    <div>${rows.join('')}${full.join('')}
      ${k.closed ? kv('Uang laci dihitung', rupiah(k.counted_cash), ' is-total') : ''}</div>
    ${k.promos?.length ? `<div><span class="tl-h">Promo dipakai</span>${k.promos.map((p) => kv(`${esc(p.label)} · ${num(p.items)} item`, `−${rupiah(p.discount)}`)).join('')}</div>` : ''}
    ${k.blind ? '<p class="muted small">Modal, uang seharusnya dan selisih hanya tampil untuk manajer dan pemilik.</p>' : ''}
    ${k.closed ? `<div class="lp-acts">
        <button class="btn tl-btn" type="button" data-lpact="print"${staffPrinted ? ' disabled' : ''}>${k.printed_at ? 'Cetak ulang' : 'Cetak struk rekap'}</button>
        <button class="btn btn-quiet tl-btn" type="button" data-lpact="pdf">Bagikan PDF</button></div>
      ${staffPrinted ? `<p class="muted small">Sudah dicetak jam ${esc(hhmm(k.printed_at))}. Cetak ulang oleh manajer atau pemilik.</p>` : ''}`
    : '<p class="muted small">Shift ini masih berjalan. Rekapnya dicetak saat Tutup shift.</p>'}
    <div class="notice" id="lp-msg" hidden></div>`;
  const msg = $('#lp-msg', box);
  box.querySelector('[data-lpact="print"]')?.addEventListener('click', async (e) => {
    const was = k.printed_at;
    await tools.printRekap(k, e.currentTarget, msg);
    if (k.printed_at !== was || k.reprints) { const t = msg.textContent, cls = msg.className; redraw(); const m = $('#lp-msg'); if (m && t) { m.textContent = t; m.className = cls; m.hidden = false; } }
  });
  box.querySelector('[data-lpact="pdf"]')?.addEventListener('click', (e) => tools.shareRekap(k, e.currentTarget, msg));
}

/* ---------------------------------------------------------------- Penjualan */
function salesView(body, d) {
  const max = Math.max(1, ...d.hourly.map((h) => h.revenue));
  const fl = d.by_flavour.filter((f) => Number(f.qty));
  body.innerHTML = `<div class="lp-kpis">
      <div class="hm-kpi"><span class="hm-l">Omzet</span><b class="hm-v num">${rupiah(d.revenue)}</b><span class="hm-s num">${num(d.orders)} pesanan · rata-rata ${rupiah(d.average)}</span></div>
      <div class="hm-kpi"><span class="hm-l">Produk terjual</span><b class="hm-v num">${num(d.units)}</b><span class="hm-s num">${d.discount ? `diskon ${rupiah(d.discount)}` : 'tanpa diskon'}</span></div>
      <div class="hm-kpi"><span class="hm-l">Pembayaran</span><b class="hm-v num">${rupiah(d.by_method.qris + d.by_method.tunai + d.by_method.lain)}</b><span class="hm-s num">QRIS ${rupiah(d.by_method.qris)} · Tunai ${rupiah(d.by_method.tunai)}${d.by_method.lain ? ` · lain ${rupiah(d.by_method.lain)}` : ''}</span></div>
      <div class="hm-kpi"><span class="hm-l">Batal dan refund</span><b class="hm-v num">${num(d.cancelled_count)}</b><span class="hm-s num">${rupiah(d.cancelled_amount)}${d.pending_count ? ` · ${num(d.pending_count)} belum dibayar` : ''}</span></div>
    </div>
    <div class="lp-two">
      <div class="hm-panel"><h2>Per produk</h2>
        ${d.products.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Produk</th><th scope="col" class="num">Jumlah</th><th scope="col" class="num">Penjualan</th></tr></thead>
          <tbody>${d.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${num(p.qty)} ${esc(p.unit)}</td><td class="num">${rupiah(p.net)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Belum ada penjualan.</p>'}
        ${d.service_charge || d.pbjt ? `<p class="muted small">Di luar penjualan: ${[d.service_charge ? `service charge ${rupiah(d.service_charge)}` : '', d.pbjt ? `PBJT ${rupiah(d.pbjt)}` : ''].filter(Boolean).join(' · ')}.</p>` : ''}
      </div>
      <div class="stack">
        <div class="hm-panel"><h2>Per rasa</h2>
          ${fl.length ? `<dl class="hm-sold">${fl.map((f) => `<dt>${esc(f.label)}</dt><dd class="num">${num(f.qty)}</dd>`).join('')}</dl>` : '<p class="muted">Belum ada.</p>'}</div>
        <div class="hm-panel"><h2>Per jam</h2>
          <ol class="lp-hours">${d.hourly.map((h) => `<li><span class="num">${String(h.hour).padStart(2, '0')}.00</span>
            <span class="hm-mini" aria-hidden="true"><i style="width:${Math.round(h.revenue / max * 100)}%"></i></span>
            <span class="num">${h.revenue ? `${rupiah(h.revenue)} · ${num(h.orders)}` : dash}</span></li>`).join('')}</ol></div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- Stok */
const OUT = { sampel: 'Sampel', buang: 'Dibuang', rusak: 'Rusak', promo: 'Promo' };
function stockView(body, d) {
  const sel = (v) => (Number(v) ? `<span class="${v < 0 ? 'lp-neg' : ''}">${v > 0 ? '+' : ''}${num(v)}</span>` : dash);
  const count = d.count ? ({ menunggu: 'menunggu keputusan manajer', diterima: 'diterima', ditolak: 'ditolak', diganti: 'diganti' }[d.count.status] || d.count.status) : null;
  body.innerHTML = `<div class="hm-panel"><h2>Masuk dan keluar per barang</h2>
      ${d.items.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Barang</th><th scope="col" class="num">Masuk</th><th scope="col" class="num">Terjual</th>
        <th scope="col" class="num">Sampel</th><th scope="col" class="num">Keluar lain</th><th scope="col" class="num">Selisih opname</th><th scope="col" class="num">Sisa akhir hari</th></tr></thead>
        <tbody>${d.items.map((i) => `<tr><td>${esc(i.name)} <span class="muted small">${esc(i.unit)}</span></td>
          <td class="num">${Number(i.masuk) ? num(i.masuk) : dash}</td><td class="num">${Number(i.terjual) ? num(i.terjual) : dash}</td>
          <td class="num">${Number(i.sampel) ? num(i.sampel) : dash}</td><td class="num">${Number(i.keluar) ? num(i.keluar) : dash}</td>
          <td class="num">${sel(Number(i.selisih))}</td><td class="num">${num(i.closing)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Tidak ada barang masuk atau keluar.</p>'}
      <p class="muted small">Stok opname: ${count ? `dikirim ${esc(hhmm(d.count.at))}${d.count.by ? ` oleh ${esc(d.count.by)}` : ''}, ${esc(count)}` : 'belum dikirim'}.</p>
    </div>
    <div class="lp-two">
      <div class="hm-panel"><h2>Barang masuk</h2>
        ${d.goods_in.length ? `<ul class="list">${d.goods_in.map((g) => `<li><span class="grow"><b>${esc(g.item)}</b> <span class="num">${num(g.qty)} ${esc(g.unit)}</span><br>
          <span class="muted small">${esc(hhmm(g.at))}${g.responsible || g.recorded_by ? ` · ${esc(g.responsible || g.recorded_by)}` : ''}${g.supplier ? ` · ${esc(g.supplier)}` : ''}${g.note ? ` · ${esc(g.note)}` : ''}</span></span>
          ${g.status && g.status !== 'aktif' && g.status !== 'diterima' ? `<span class="tag">${esc(g.status)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Tidak ada.</p>'}</div>
      <div class="hm-panel"><h2>Barang keluar</h2>
        ${d.outs.length ? `<ul class="list">${d.outs.map((o) => `<li><span class="grow"><b>${esc(o.item)}</b> <span class="num">${num(o.qty)} ${esc(o.unit)}</span> · ${esc(OUT[o.kind] || o.kind)}<br>
          <span class="muted small">${esc(hhmm(o.at))}${o.by ? ` · ${esc(o.by)}` : ''}${o.reason ? ` · ${esc(o.reason)}` : ''}</span></span>
          ${o.cancelled ? '<span class="tag tag-bad">Dibatalkan</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">Tidak ada.</p>'}</div>
    </div>`;
}

/* ---------------------------------------------------------------- Presensi */
const FLAG = { terlambat: 'Terlambat', pulang_awal: 'Pulang awal', pulang_lewat: 'Pulang lewat', lembur: 'Lembur', istirahat_lebih: 'Istirahat lebih',
  tidak_masuk: 'Tidak masuk', lupa_pulang: 'Lupa scan pulang', di_luar_jadwal: 'Di luar jadwal' };
function attView(body, d) {
  const rows = d.people.filter((p) => p.report.length || p.scans.length);
  const first = (p, a) => p.scans.find((s) => s.action === a);
  const last = (p, a) => [...p.scans].reverse().find((s) => s.action === a);
  body.innerHTML = `<div class="hm-panel"><h2>${rows.length} staf · ${esc(longDay(d.date))}</h2>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th scope="col">Staf</th><th scope="col">Jadwal</th><th scope="col">Masuk</th><th scope="col">Istirahat</th><th scope="col">Pulang</th><th scope="col">Keterangan</th></tr></thead>
      <tbody>${rows.map((p) => {
        const sched = p.report.filter((r) => r.kind !== 'di_luar_jadwal');
        const izin = sched.some((r) => r.kind === 'izin');
        const brk = p.report.reduce((n, r) => n + (r.break_min || 0), 0);
        const notes = [...new Set(p.report.flatMap((r) => r.flags || []).filter((f) => !f.startsWith('sedang_')))].map((f) => {
          if (f === 'terlambat') { const m = p.report.reduce((n, r) => n + (r.late_min || 0), 0); return `Terlambat ${mins(m)}`; }
          if (f === 'lembur') { const m = p.report.reduce((n, r) => n + (r.overtime_min || 0), 0); return `Lembur ${mins(m)}`; }
          return FLAG[f] || f;
        });
        if (izin) notes.unshift('Izin');
        if (p.scans.some((s) => s.koreksi)) notes.push('Dikoreksi');
        const m = first(p, 'masuk'), q = last(p, 'pulang');
        return `<tr><th scope="row">${esc(p.full_name || p.name)}</th>
          <td>${sched.filter((r) => r.kind !== 'izin').map((r) => `<span class="num">${esc(r.start.replace(':', '.'))}–${esc(r.end.replace(':', '.'))}</span>`).join('<br>') || (izin ? 'Izin' : dash)}</td>
          <td class="num">${m ? esc(hhmm(m.at)) : dash}</td><td class="num">${brk ? esc(mins(brk)) : dash}</td><td class="num">${q ? esc(hhmm(q.at)) : dash}</td>
          <td>${notes.length ? notes.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') : dash}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="muted">Tidak ada jadwal atau presensi di tanggal ini.</p>'}
    <p class="muted small">Lupa scan atau jam salah? Minta manajer atau pemilik mengoreksinya di Tim > Absen harian.</p></div>`;
}

/* ---------------------------------------------------------------- Member */
const KIND = { stempel: 'Hadiah stempel', welcome: 'Voucher member baru', ulang_tahun: 'Voucher ulang tahun', kode: 'Voucher kertas' };
function memberView(body, d) {
  const sales = d.sales.filter((s) => !s.reversed), red = d.redemptions.filter((r) => !r.reversed);
  body.innerHTML = `<div class="lp-kpis">
      <div class="hm-kpi"><span class="hm-l">Kartu dipakai</span><b class="hm-v num">${num(sales.length)}</b><span class="hm-s num">${rupiah(sales.reduce((t, s) => t + s.total, 0))} belanja member</span></div>
      <div class="hm-kpi"><span class="hm-l">Stempel diberikan</span><b class="hm-v num">${num(sales.reduce((t, s) => t + s.stamps, 0))}</b><span class="hm-s">1 stempel per Rp50.000</span></div>
      <div class="hm-kpi"><span class="hm-l">Hadiah dan voucher dipakai</span><b class="hm-v num">${num(red.length)}</b><span class="hm-s">${esc([...new Set(red.map((r) => KIND[r.kind] || r.kind))].join(', ') || 'belum ada')}</span></div>
      <div class="hm-kpi"><span class="hm-l">Member baru</span><b class="hm-v num">${num(d.new_members)}</b><span class="hm-s">daftar di tanggal ini</span></div>
    </div>
    <div class="lp-two">
      <div class="hm-panel"><h2>Belanja dengan kartu</h2>
        ${d.sales.length ? `<ul class="list">${d.sales.map((s) => `<li><span class="grow"><b>${esc(s.member || 'Member')}</b> <span class="num">${rupiah(s.total)} · ${num(s.stamps)} stempel</span><br>
          <span class="muted small">${esc(hhmm(s.at))}${s.by ? ` · ${esc(s.by)}` : ''}</span></span>${s.reversed ? '<span class="tag tag-bad">Dibatalkan</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}</div>
      <div class="hm-panel"><h2>Hadiah dan voucher dipakai</h2>
        ${d.redemptions.length ? `<ul class="list">${d.redemptions.map((r) => `<li><span class="grow"><b>${esc(r.member || 'Member')}</b> · ${esc(r.label)}<br>
          <span class="muted small">${esc(hhmm(r.at))} · ${esc(KIND[r.kind] || r.kind)}${r.by ? ` · ${esc(r.by)}` : ''}</span></span>${r.reversed ? '<span class="tag tag-bad">Dibatalkan</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum ada.</p>'}</div>
    </div>`;
}

