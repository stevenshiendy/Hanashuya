// Owner page, "Laporan POS": live statistics from the POS tables and the four VireoPOS-style reports as .xlsx.
// mountOwnerReports(panel, { rpc, part: 'laba' }) is the separate "Laba kotor" view (same range picker).
// Database side: supabase/pos-reports.sql (owner_pos_stats, owner_pos_report).
import { $, esc, busy, notice, rupiah } from './lib.js';
import { rangeHtml, wireRange, KEYS_YEAR, presetRange } from './owner-range.js';

export { presetRange };

const TZ = 'Asia/Jakarta';
const REFRESH_MS = 30000;

const ymdToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const dmy = (s) => s.split('-').reverse().join('/');

/* ---------------- drawing helpers (plain HTML, same look as the Ringkasan tab) */
// Column chart: one column per hour / day / month. Height is relative to the biggest column.
export function columns(rows, unit = 'Rp') {
  if (!rows.length) return '<p class="muted">Belum ada data.</p>';
  const max = Math.max(...rows.map((r) => r.sales));
  const total = rows.reduce((t, r) => t + r.sales, 0);
  if (!total) return '<p class="muted">Belum ada penjualan di rentang ini.</p>';
  const top = rows.reduce((a, b) => (b.sales > a.sales ? b : a));
  const every = Math.ceil(rows.length / 12);
  const cols = rows.map((r) => `<span class="col${r.sales ? '' : ' zero'}" style="height:${r.sales ? Math.max(2, (r.sales / max) * 100).toFixed(1) : 1}%" title="${esc(r.label)}: ${esc(rupiah(r.sales))}, ${r.receipts} struk"></span>`).join('');
  const xs = rows.map((r, i) => `<span>${i % every === 0 ? esc(r.label) : ''}</span>`).join('');
  return `<div class="cols" role="img" aria-label="Penjualan per ${rows.length} titik waktu, tertinggi ${esc(top.label)} sebesar ${esc(rupiah(top.sales))}">${cols}</div>
    <div class="cols-x" aria-hidden="true">${xs}</div>
    <p class="muted small">Tertinggi: ${esc(top.label)}, ${esc(rupiah(top.sales))} (${top.receipts} struk).</p>`;
}

// Horizontal bars: name, share of the biggest value, value text.
export function hbars(rows, valueKey, fmt = rupiah) {
  const total = rows.reduce((t, r) => t + Number(r[valueKey] || 0), 0);
  if (!total) return '<p class="muted">Belum ada data.</p>';
  const max = Math.max(...rows.map((r) => Number(r[valueKey] || 0)));
  return `<div class="bars">${rows.map((r) => `<div class="bar-row is-money"><span>${esc(r.name)}</span>
    <span class="track"><i style="transform:scaleX(${(Number(r[valueKey] || 0) / max).toFixed(3)})"></i></span><span class="v">${esc(fmt(r[valueKey]))}</span></div>`).join('')}</div>`;
}

// Low-stock warning. low = list from stock_low(), or null when stock.sql has not been run (then nothing is shown).
export function lowStock(low) {
  if (!Array.isArray(low) || !low.length) return '';
  const num = (n) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 }).format(Number(n));
  return `<div class="notice notice-error" role="status" id="rep-low"><b>Stok menipis (${low.length})</b>
    <ul>${low.map((i) => `<li>${esc(i.name)}: sisa ${esc(num(i.qty))} ${esc(i.unit)} (batas ${esc(num(i.low_level))})</li>`).join('')}</ul>
    ${document.getElementById('t-stock') ? '<button class="btn btn-quiet" type="button" id="rep-low-go">Buka Stok sekarang</button>' : ''}</div>`;
}

// Service charge and PBJT are not sales (14 Nov 2026): shown under the tiles only when there is any.
// PBJT inside the price is already part of Penjualan, so it says "termasuk".
function charges(d) {
  const sv = Number(d.service_charge || 0), tx = Number(d.pbjt || 0), ti = Number(d.pbjt_included || 0);
  if (!sv && !tx && !ti) return '';
  return `<div class="table-wrap"><table><caption class="muted small">Di luar penjualan</caption><tbody>
    ${sv ? `<tr><th scope="row">Service charge</th><td class="num">${esc(rupiah(sv))}</td></tr>` : ''}
    ${tx ? `<tr><th scope="row">PBJT</th><td class="num">${esc(rupiah(tx))}</td></tr>` : ''}
    ${ti ? `<tr><th scope="row">PBJT (termasuk dalam penjualan)</th><td class="num">${esc(rupiah(ti))}</td></tr>` : ''}
    <tr><th scope="row">Total uang masuk</th><td class="num">${esc(rupiah(d.paid))}</td></tr></tbody></table></div>`;
}

function render(d, state, low) {
  const days = state.from === state.to ? dmy(state.from) : `${dmy(state.from)} sampai ${dmy(state.to)}`;
  const gl = { jam: 'jam', hari: 'hari', bulan: 'bulan' }[d.grain];
  const v = d.voids;
  const cancelled = v.batal + v.refund;
  return `
  ${lowStock(low)}
  <div class="stats">
    <div class="stat"><span>Penjualan</span><b>${esc(rupiah(d.sales))}</b></div>
    <div class="stat"><span>Struk</span><b>${d.receipts}</b></div>
    <div class="stat"><span>Rata-rata per struk</span><b>${esc(rupiah(d.average))}</b></div>
    <div class="stat"><span>Produk terjual</span><b>${d.items}</b></div>
    <div class="stat"><span>Dibatalkan / refund</span><b>${cancelled}</b></div>
  </div>
  ${charges(d)}
  <p class="muted small">Rentang ${esc(days)}. Penjualan dihitung di tanggal transaksi; batal dan refund mengurangi di tanggal disetujui. Diperbarui ${new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}, otomatis tiap 30 detik.</p>
  <div class="panel stack"><h2>Penjualan per ${gl}</h2>${columns(d.series)}</div>
  <div class="panel stack"><h2>7 hari terakhir</h2>${columns(d.last7)}</div>
  <div class="grid-2">
    <div class="panel stack"><h2>Produk terlaris</h2>${d.top_products.length ? hbars(d.top_products, 'qty', (n) => n + ' pcs') : '<p class="muted">Belum ada data.</p>'}
      ${d.top_products.length ? `<div class="table-wrap"><table><thead><tr><th>Produk</th><th class="num">Terjual</th><th class="num">Penjualan</th></tr></thead><tbody>
        ${d.top_products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${esc(rupiah(p.net))}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>
    <div class="panel stack"><h2>Kelompok produk</h2>${hbars(d.groups.map((g) => ({ ...g, name: `${g.name} (${g.qty})` })), 'net')}</div>
    <div class="panel stack"><h2>Cara bayar</h2>${hbars(d.by_method.map((m) => ({ ...m, name: `${m.name} (${m.receipts})` })), 'sales')}</div>
    <div class="panel stack"><h2>Saluran</h2>${hbars(d.by_channel.map((m) => ({ ...m, name: `${m.name} (${m.receipts})` })), 'sales')}</div>
  </div>
  <div class="panel stack"><h2>Penjualan dan komisi per staf</h2>
    ${d.by_staff.length ? `<div class="table-wrap"><table><thead><tr><th>Yang melayani</th><th class="num">Struk</th><th class="num">Penjualan</th><th class="num">Komisi</th></tr></thead><tbody>
      ${d.by_staff.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.receipts}</td><td class="num">${esc(rupiah(s.sales))}</td><td class="num">${esc(rupiah(s.commission))}</td></tr>`).join('')}</tbody></table></div>
      <p class="muted small">Komisi dihitung dari aturan di Tim, Komisi, per orang yang melayani. Struk batal dan refund mengurangi komisi di tanggal disetujui.</p>` : '<p class="muted">Belum ada data.</p>'}
  </div>
  <div class="panel stack"><h2>Kartu member dibuat di tablet</h2>
    ${(d.cards_by_cashier || []).length ? `<div class="table-wrap"><table><thead><tr><th>Kasir</th><th class="num">Kartu</th></tr></thead><tbody>
      ${d.cards_by_cashier.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.cards}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Belum ada kartu dibuat di tablet pada rentang ini.</p>'}
  </div>
  <div class="grid-2">
    <div class="panel stack"><h2>Promo dipakai</h2>
      ${d.promos.length ? `<div class="table-wrap"><table><thead><tr><th>Promo</th><th>Jenis</th><th class="num">Struk</th><th class="num">Item promo</th><th class="num">Potongan</th></tr></thead><tbody>
        ${d.promos.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.kind_label || '')}</td><td class="num">${p.used}</td><td class="num">${p.items ?? '–'}</td><td class="num">${esc(rupiah(p.discount))}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted small">Item promo: barang yang mendapat harga promo. Refund mengurangi di tanggal disetujui.</p>` : '<p class="muted">Tidak ada promo dipakai.</p>'}
      ${d.free_orders ? `<p class="muted small">${d.free_orders} struk gratis (voucher).</p>` : ''}</div>
    <div class="panel stack"><h2>Dibatalkan dan refund</h2>
      <div class="table-wrap"><table><thead><tr><th>Jenis</th><th class="num">Struk</th><th class="num">Nilai</th></tr></thead><tbody>
        <tr><td>Dibatalkan</td><td class="num">${v.batal}</td><td class="num">${esc(rupiah(v.batal_value))}</td></tr>
        <tr><td>Refund</td><td class="num">${v.refund}</td><td class="num">${esc(rupiah(v.refund_value))}</td></tr></tbody></table></div>
      <p class="muted small">Dihitung di tanggal disetujui, dan sudah dikurangkan dari penjualan di atas.</p>
      ${d.flagged ? `<p class="small">${d.flagged} struk ditandai (misalnya tanpa shift atau dikirim terlambat).</p>` : ''}</div>
  </div>
  <div class="panel stack"><h2>Unduh laporan</h2>
    <p class="muted small">Satu file Excel dengan empat lembar berkolom sama seperti VireoPOS: Rangkuman, Rincian, Penjualan per Produk dan Rekapitulasi Kas, untuk rentang tanggal di atas.</p>
    <div class="row"><button class="btn" type="button" id="rep-xlsx">Unduh .xlsx</button></div>
    <div class="notice" id="rep-msg" hidden></div>
  </div>`;
}

// Laba kotor: sales after discount minus harga pokok from the recipes (gap 2, 11 Nov 2026).
export function profitHtml(pf, { heading = true } = {}) {
  const m = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '–');
  return `<div class="panel stack">${heading ? '<h2>Laba kotor</h2>' : ''}
    <div class="stats">
      <div class="stat"><span>Penjualan bersih</span><b>${esc(rupiah(pf.revenue))}</b></div>
      <div class="stat"><span>Harga pokok</span><b>${esc(rupiah(pf.cost))}</b></div>
      <div class="stat"><span>Laba kotor</span><b>${esc(rupiah(pf.profit))}</b></div>
      <div class="stat"><span>Margin</span><b>${m(pf.profit, pf.revenue)}</b></div>
      <div class="stat"><span>Komisi staf</span><b>${esc(rupiah(pf.commission))}</b></div>
    </div>
    ${pf.missing_costs.length ? `<p class="notice notice-warn">Harga pokok masih Rp0 untuk ${esc(pf.missing_costs.join(', '))}, jadi labanya terlihat lebih besar dari sebenarnya.
      ${document.getElementById('t-items') ? '<button class="btn btn-text" type="button" data-cost-go>Isi di Stok, Barang dan harga pokok</button>' : ''}</p>` : ''}
    ${pf.products.length ? `<div class="table-wrap"><table><thead><tr><th>Produk</th><th class="num">Terjual</th><th class="num">Penjualan</th><th class="num">Harga pokok</th><th class="num">Laba kotor</th><th class="num">Margin</th></tr></thead><tbody>
      ${pf.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num">${esc(rupiah(p.revenue))}</td><td class="num">${esc(rupiah(p.cost))}</td>
        <td class="num">${esc(rupiah(p.profit))}</td><td class="num">${m(p.profit, p.revenue)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Belum ada penjualan di rentang ini.</p>'}
    ${pf.days.length > 1 ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th class="num">Penjualan</th><th class="num">Harga pokok</th><th class="num">Laba kotor</th></tr></thead><tbody>
      ${pf.days.map((x) => `<tr><td class="num">${esc(x.day.split('-').reverse().join('/'))}</td><td class="num">${esc(rupiah(x.revenue))}</td><td class="num">${esc(rupiah(x.cost))}</td><td class="num">${esc(rupiah(x.profit))}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <p class="muted small">Harga pokok dihitung dari resep tiap produk dan harga pokok per barang (Stok, Barang dan harga pokok), dikunci saat pesanan dibayar.${pf.estimated ? ` ${pf.estimated} baris dibayar sebelum harga pokok diisi, jadi memakai harga pokok sekarang.` : ''} Laba kotor belum dikurangi komisi, gaji, sewa dan biaya lain. Batal dan refund mengurangi di tanggal disetujui.</p>
  </div>`;
}

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembuat file Excel gagal dimuat. Periksa internet lalu coba lagi.'));
    document.head.append(s);
  });
}

const SHEETS = [['rangkuman', 'Rangkuman'], ['rincian', 'Rincian'], ['per_produk', 'Penjualan per Produk'], ['kas', 'Rekapitulasi Kas']];
export function buildWorkbook(X, rep) {
  const book = X.utils.book_new();
  SHEETS.forEach(([key, name]) => {
    const rows = rep[key] || [];
    X.utils.book_append_sheet(book, rows.length ? X.utils.json_to_sheet(rows) : X.utils.aoa_to_sheet([['Tidak ada data di rentang ini']]), name);
  });
  return book;
}

const goTab = (...ids) => { for (const id of ids) { const t = document.getElementById(id); if (t) return t.click(); } };

export function mountOwnerReports(panel, { rpc, part }) {
  const laba = part === 'laba';
  const px = laba ? 'lab-' : 'rep-'; // ids per view, so both views can sit on one page
  const q = (s) => $('#' + px + s, panel);
  // The tab opens this again each time it is selected: reuse the same state and one timer.
  const st = panel._rep || (panel._rep = { preset: 'hari', from: ymdToday(), to: ymdToday(), customFrom: ymdToday(), customTo: ymdToday(), timer: null, busy: false, data: null });
  panel.className = 'stack-lg';

  async function load(quiet) {
    if (st.busy) return;
    st.busy = true;
    const body = q('body');
    if (!quiet && body) body.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton" style="height:96px"></div><div class="skeleton"></div></div>';
    try {
      [st.from, st.to] = presetRange(st.preset, [st.customFrom, st.customTo]);
      if (laba) {
        let pf;
        try { pf = await rpc('owner_pos_profit', { p_from: st.from, p_to: st.to }); } catch { pf = null; }
        const b = q('body');
        if (!b) return;
        b.innerHTML = pf ? profitHtml(pf, { heading: false }) : '<div class="panel stack"><p class="muted">Laba kotor aktif setelah pos-backoffice.sql dijalankan di Supabase.</p></div>';
        $('[data-cost-go]', b)?.addEventListener('click', () => goTab('t-items', 't-stock'));
        return;
      }
      const d = await rpc('owner_pos_stats', { p_from: st.from, p_to: st.to });
      st.data = d;
      // Missing function (stock.sql not run) or any error: hide the warning quietly.
      let low = null;
      try { low = await rpc('stock_low'); } catch { low = null; }
      const b = q('body');
      if (!b) return;
      b.innerHTML = render(d, st, low);
      const go = $('#rep-low-go', b);
      if (go) go.addEventListener('click', () => goTab('t-stock'));
      $('#rep-xlsx', b).addEventListener('click', download);
    } catch (e) {
      const b = q('body');
      if (b && !quiet) b.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`;
    } finally { st.busy = false; }
  }

  async function download(e) {
    const btn = e.currentTarget, msg = $('#rep-msg', panel);
    notice(msg, '');
    busy(btn, true, 'Menyiapkan…');
    try {
      await loadSheetJS();
      const rep = await rpc('owner_pos_report', { p_from: st.from, p_to: st.to });
      const X = window.XLSX;
      X.writeFile(buildWorkbook(X, rep), `hanashuya-laporan-pos-${st.from}${st.from === st.to ? '' : '_' + st.to}.xlsx`);
      notice(msg, `Tersimpan: ${rep.rangkuman.length} struk, ${rep.rincian.length} baris barang, ${rep.kas.length} shift.`, 'ok');
    } catch (err) { notice(msg, err.message); }
    busy(btn, false);
  }

  panel.innerHTML = `
  <div class="panel stack">
    <h1>${laba ? 'Laba kotor' : 'Laporan POS'}</h1>
    ${rangeHtml({ preset: st.preset, from: st.customFrom, to: st.customTo, keys: KEYS_YEAR })}
  </div>
  <div id="${px}body" class="stack-lg" aria-live="off"></div>`;

  wireRange(panel, { onChange: ({ preset, from, to }) => { st.preset = preset; st.customFrom = from; st.customTo = to; load(false); } });

  // Refresh every 30 seconds, only while this tab and the browser tab are visible.
  if (st.timer) clearInterval(st.timer);
  st.timer = setInterval(() => {
    if (!panel.isConnected) { clearInterval(st.timer); st.timer = null; return; }
    if (panel.hidden || document.hidden) return;
    load(true);
  }, REFRESH_MS);
  if (!st.vis) {
    st.vis = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !panel.hidden && panel.isConnected) load(true); });
  }

  load(false);
}
