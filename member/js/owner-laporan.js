// Owner page, Laporan group (Glenn, 12 Nov 2026, like VireoPOS Laporan): Laporan pembelian and
// Laporan lainnya. Laporan stok, penjualan and laba reuse their existing views (owner.js).
// SQL: pos-laporan.sql (owner_purchase_report, owner_other_report).
import { $, $$, esc, rupiah, busy, notice } from './lib.js';
import { presetRange, rangeHtml, wireRange, KEYS_YEAR } from './owner-range.js';

const KIND = { sampel: 'Sampel', buang: 'Dibuang', rusak: 'Rusak', promo: 'Promo' };
const FLAG = { total_besar: 'Total di atas Rp500.000', offline: 'Penjualan offline', dikirim_terlambat: 'Dikirim terlambat', harga_offline_beda: 'Harga offline beda', bonus_stempel: 'Bonus stempel',
  kartu_staf: 'Kartu milik staf', kode_diketik: 'Kode kartu diketik', nomor_dicari: 'Kartu dicari lewat nomor', di_luar_jam: 'Di luar jam buka', banyak_stempel_sehari: 'Banyak stempel sehari',
  staf_sama_sering: 'Staf yang sama sering melayani kartu ini' };
const q = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const dmy = (s) => s.split('-').reverse().join('/');
const state = { preset: '30', custom: null };

function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembuat file Excel gagal dimuat. Periksa internet lalu coba lagi.'));
    document.head.append(s);
  });
}
const table = (head, rows, empty = 'Tidak ada data di rentang ini.') => (rows.length
  ? `<div class="table-wrap"><table><thead><tr>${head.map(([l, num]) => `<th scope="col"${num ? ' class="num"' : ''}>${l}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${head[i][1] ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
  : `<p class="muted">${empty}</p>`);

export function mountLaporan(p, { rpc, part }) {
  const pembelian = part === 'pembelian';
  p.innerHTML = `<section class="panel stack" aria-labelledby="lp-t">
      <div class="row-between"><h1 id="lp-t">${pembelian ? 'Laporan pembelian' : 'Laporan lainnya'}</h1>
        <button class="btn btn-quiet" type="button" id="lp-xlsx" disabled>Ekspor .xlsx</button></div>
      <p class="muted small">${pembelian ? 'Semua barang masuk dengan pemasok dan harga beli. Barang masuk yang dibatalkan tidak dihitung.'
        : 'Laci kas, komisi staf, promo yang dipakai, barang keluar selain penjualan, kartu member dibuat di kasir, dan tanda pada penjualan.'}</p>
      ${rangeHtml({ preset: state.preset, from: state.custom?.[0], to: state.custom?.[1], keys: KEYS_YEAR })}
      <p class="muted small num" id="lp-range"></p>
      <div class="notice" id="lp-msg" hidden></div>
    </section><div id="lp-body" class="stack-lg"></div>`;
  let data = null;
  const load = async () => {
    const [from, to] = presetRange(state.preset, state.custom) || [];
    if (!from) return;
    $('#lp-range', p).textContent = `${dmy(from)} sampai ${dmy(to)}`;
    const body = $('#lp-body', p);
    body.innerHTML = '<div class="panel" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
    try { data = await rpc(pembelian ? 'owner_purchase_report' : 'owner_other_report', { p_from: from, p_to: to }); }
    catch (e) { body.innerHTML = ''; notice($('#lp-msg', p), e.message); return; }
    notice($('#lp-msg', p), '');
    $('#lp-xlsx', p).disabled = false;
    body.innerHTML = pembelian ? purchaseHtml(data) : otherHtml(data);
  };
  wireRange(p, { onChange: ({ preset, from, to }) => { state.preset = preset; state.custom = [from, to]; load(); } });
  $('#lp-xlsx', p).addEventListener('click', async (e) => {
    const btn = e.currentTarget; busy(btn, true, 'Menyiapkan…');
    try {
      await loadSheetJS();
      const X = window.XLSX, wb = X.utils.book_new();
      const sheet = (name, rows) => X.utils.book_append_sheet(wb, X.utils.json_to_sheet(rows.length ? rows : [{ Keterangan: 'Tidak ada data' }]), name);
      if (pembelian) {
        sheet('Barang masuk', data.rows.map((r) => ({ Tanggal: r.day, Barang: r.item, Jumlah: Number(r.qty), Satuan: r.unit, Pemasok: r.supplier || '', PO: r.po || '', 'Harga beli (Rp)': r.cost ?? '', Catatan: r.note || '' })));
        sheet('Per pemasok', data.by_supplier.map((r) => ({ Pemasok: r.supplier, 'Barang masuk': r.deliveries, 'Total (Rp)': r.cost ?? '' })));
        sheet('Per barang', data.by_item.map((r) => ({ Barang: r.item, Jumlah: Number(r.qty), Satuan: r.unit, 'Total (Rp)': r.cost ?? '', 'Rata-rata per satuan (Rp)': r.avg_unit_cost ?? '' })));
      } else {
        sheet('Komisi', data.commission.map((r) => ({ Staf: r.name, Pesanan: r.orders, 'Komisi (Rp)': r.commission })));
        sheet('Promo', data.promos.map((r) => ({ Promo: r.name, Jenis: r.kind || '', Dipakai: r.uses, 'Item promo': r.items ?? 0, 'Diskon (Rp)': r.discount })));
        sheet('Barang keluar', data.stock_out.map((r) => ({ Alasan: KIND[r.kind] || r.kind, Barang: r.item, Jumlah: Number(r.qty), Satuan: r.unit, 'Harga pokok (Rp)': r.cost })));
      }
      X.writeFile(wb, `laporan-${pembelian ? 'pembelian' : 'lainnya'}-${data.from}-${data.to}.xlsx`);
    } catch (err) { notice($('#lp-msg', p), err.message); }
    busy(btn, false);
  });
  load();
}

function purchaseHtml(d) {
  return `<section class="panel stack"><div class="stats">
      <div class="stat"><span>Barang masuk</span><b class="num">${d.deliveries}</b></div>
      <div class="stat"><span>Total pembelian</span><b class="num">${rupiah(d.total_cost)}</b></div>
      <div class="stat"><span>Tanpa harga beli</span><b class="num">${d.without_cost}</b></div></div>
      ${d.without_cost ? '<p class="small muted">Barang masuk tanpa harga beli tidak masuk total. Isi harga belinya lewat Stok masuk, Ubah.</p>' : ''}</section>
    <section class="panel stack"><h2>Per pemasok</h2>${table([['Pemasok'], ['Barang masuk', 1], ['Total', 1]],
      d.by_supplier.map((r) => [esc(r.supplier), r.deliveries, r.cost == null ? '–' : rupiah(r.cost)]))}</section>
    <section class="panel stack"><h2>Per barang</h2>${table([['Barang'], ['Jumlah', 1], ['Total', 1], ['Rata-rata per satuan', 1]],
      d.by_item.map((r) => [esc(r.item), `${q(r.qty)} ${esc(r.unit)}`, r.cost == null ? '–' : rupiah(r.cost), r.avg_unit_cost == null ? '–' : rupiah(Math.round(r.avg_unit_cost))]))}</section>
    <section class="panel stack"><h2>Rincian</h2>${table([['Tanggal'], ['Barang'], ['Jumlah', 1], ['Pemasok'], ['PO'], ['Harga beli', 1]],
      d.rows.map((r) => [esc(dmy(r.day)), esc(r.item), `${q(r.qty)} ${esc(r.unit)}`, esc(r.supplier || 'Tanpa pemasok'), esc(r.po || '–'), r.cost == null ? '–' : rupiah(r.cost)]))}</section>`;
}

function otherHtml(d) {
  const c = d.cash || {};
  return `<section class="panel stack"><h2>Laci kas</h2><div class="stats">
      <div class="stat"><span>Shift ditutup</span><b class="num">${c.shifts || 0}</b></div>
      <div class="stat"><span>Total selisih</span><b class="num">${rupiah(c.difference || 0)}</b></div>
      <div class="stat"><span>Selisih di atas batas</span><b class="num">${c.over_limit || 0}</b></div></div>
      <p class="small muted">Rinciannya ada di Penjualan, Rekap kas.</p></section>
    <section class="panel stack"><h2>Komisi staf</h2>${table([['Staf'], ['Pesanan', 1], ['Komisi', 1]], d.commission.map((r) => [esc(r.name), r.orders, rupiah(r.commission)]))}</section>
    <section class="panel stack"><h2>Promo dan voucher dipakai</h2>${table([['Promo'], ['Jenis'], ['Struk', 1], ['Item promo', 1], ['Diskon', 1]], d.promos.map((r) => [esc(r.name), esc(r.kind || ''), r.uses, r.items ?? 0, rupiah(r.discount)]))}
      <p class="muted small">Item promo: barang yang mendapat harga promo. Batal dan refund mengurangi di tanggal disetujui.</p></section>
    <section class="panel stack"><h2>Barang keluar selain penjualan</h2>${table([['Alasan'], ['Barang'], ['Jumlah', 1], ['Harga pokok', 1]],
      d.stock_out.map((r) => [esc(KIND[r.kind] || r.kind), esc(r.item), `${q(r.qty)} ${esc(r.unit)}`, rupiah(r.cost)]))}</section>
    <section class="panel stack"><h2>Lainnya</h2><div class="stats"><div class="stat"><span>Kartu member dibuat di kasir</span><b class="num">${d.cards_made}</b></div></div>
      ${table([['Tanda pada penjualan'], ['Jumlah', 1]], d.flags.map((r) => [esc(FLAG[r.flag] || r.flag), r.count]), 'Tidak ada penjualan bertanda.')}</section>`;
}
