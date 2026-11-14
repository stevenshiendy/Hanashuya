// Owner page, Laporan hubs (13 Nov 2026, Glenn: "cover what VireoPOS offers"). Each Laporan item
// (Stok, Pembelian, Penjualan, Laba, Lainnya) opens a list of its sub-reports, as in VireoPOS. A
// sub-report has a date range and its own filters, a Tampilkan button, a table (data-table.js) with
// a Jumlah row, and Ekspor (.xlsx or .csv). Yesterday's views stay as the first item of their hub.
//   mountReportHub(panel, { rpc, hub, open })   hub: 'stok' | 'pembelian' | 'penjualan' | 'laba' | 'lainnya'
//                                               open: a sub-report key to open straight away (demo)
//   accExtraView(body, { rpc, tab, from, to, accounts })   Neraca bulanan and Laporan jurnal for owner-akunting.js
// SQL: supabase/pos-laporan2.sql (owner_laporan, acc_balance_monthly, acc_journal_lines).
import { $, $$, esc, notice, busy } from './lib.js';
import { dataTable, loadSheetJS } from './data-table.js';
import { mountOwnerReports } from './owner-reports.js';
import { presetRange, rangeHtml, wireRange, KEYS_YEAR } from './owner-range.js';
import { mountLaporan } from './owner-laporan.js';
import { ownerStock } from './stock.js';

const TZ = 'Asia/Jakarta';
const ymdToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const dmy = (s) => (s ? String(s).slice(0, 10).split('-').reverse().join('/') : '');
const rp = (n) => (Number(n) < 0 ? '-' : '') + 'Rp' + Math.abs(Math.round(Number(n) || 0)).toLocaleString('id-ID');
const num = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const pct = (n) => (n == null ? '–' : Number(n).toLocaleString('id-ID', { maximumFractionDigits: 1 }) + '%');

/* ---------------------------------------------------------------- filters */
const F = {
  statusJual: { k: 'status', l: 'Status', o: [['', 'Semua'], ['dibayar', 'Selesai'], ['batal', 'Dibatalkan'], ['refund', 'Pengembalian']] },
  statusBatal: { k: 'status', l: 'Status', o: [['', 'Batal dan refund'], ['batal', 'Dibatalkan'], ['refund', 'Pengembalian']] },
  method: { k: 'method', l: 'Metode bayar', o: [['', 'Semua'], ['tunai', 'Tunai'], ['qris', 'QRIS'], ['campur', 'Tunai + QRIS'], ['platform', 'Platform'], ['gratis', 'Gratis']] },
  channel: { k: 'channel', l: 'Saluran', o: [['', 'Semua'], ['toko', 'Di booth'], ['grabfood', 'GrabFood'], ['gofood', 'GoFood'], ['shopeefood', 'ShopeeFood']] },
  staff: { k: 'staff', l: 'Staf', src: 'staff' },
  item: { k: 'item', l: 'Barang', src: 'items' },
  supplier: { k: 'supplier', l: 'Pemasok', src: 'suppliers' },
  empty: { k: 'empty', l: 'Tampilkan barang kosong', check: true },
  q: { k: 'q', l: 'Cari nama atau nomor', search: true },
  perHari: { k: 'group', l: 'Tampilan', o: [['', 'Rangkuman'], ['hari', 'Per hari']] },
  moveKind: { k: 'kind', l: 'Jenis', o: [['', 'Semua'], ['masuk', 'Barang masuk'], ['penjualan', 'Penjualan'], ['sampel', 'Sampel'], ['buang', 'Dibuang'], ['rusak', 'Rusak'], ['promo', 'Promo'], ['koreksi', 'Koreksi'], ['potong_liner', 'Potong liner']] },
  opname: { k: 'status', l: 'Status', o: [['', 'Semua'], ['diterima', 'Diterima'], ['menunggu_keputusan', 'Menunggu keputusan'], ['ditolak', 'Ditolak'], ['diganti', 'Diganti']] },
  po: { k: 'status', l: 'Status', o: [['terbuka', 'Belum selesai'], ['semua', 'Semua']] },
  cashKind: { k: 'kind', l: 'Jenis', o: [['', 'Semua'], ['masuk', 'Kas masuk'], ['keluar', 'Kas keluar'], ['setor', 'Setor ke pemilik']] },
  hpp: { k: 'group', l: 'Tampilan', o: [['', 'Per produk'], ['bahan', 'Per bahan']] },
  voucher: { k: 'kind', l: 'Jenis', o: [['', 'Semua'], ['stempel', 'Hadiah stempel'], ['welcome', 'Diskon member baru'], ['ulang_tahun', 'Hadiah ulang tahun'], ['kode', 'Voucher kertas'], ['tebus_murah', 'Tebus Murah Rp1']] },
  memberStatus: { k: 'status', l: 'Status', o: [['', 'Semua'], ['dibayar', 'Selesai'], ['batal', 'Dibatalkan'], ['refund', 'Pengembalian']] },
  promoGroup: { k: 'group', l: 'Tampilan', o: [['', 'Per promo'], ['jenis', 'Per jenis promo']] },
};
// Glenn, 13 Nov 2026: one rule for every sales figure, said under each report that uses it.
const RULE = 'Penjualan dihitung di tanggal transaksi. Batal dan refund mengurangi di tanggal disetujui, bukan di tanggal jualnya.';
const RULE_LIST = 'Satu baris per struk di tanggal transaksinya. Refund sebagian ditulis di kolom Refund; pengurangannya masuk laporan di tanggal disetujui.';
const ruleFor = (key) => (['jual_rinci', 'jual_rinci_barang', 'diskon', 'transaksi_pelanggan'].includes(key) ? RULE_LIST
  : /^(jual_|laba_)/.test(key) || ['hpp', 'komisi'].includes(key) ? RULE : '');

/* ---------------------------------------------------------------- the sub-reports */
// Columns: [key, label, type, total]. type: t text, d date, rp rupiah, n number, pct percent, auto (row.satuan).
// total: 1 = summed in the Jumlah row.
const R = {
  // Laporan stok
  stok_kartu: { t: 'Kartu stok', d: 'Per barang: stok awal, masuk, terjual, keluar lain (sampel, dibuang, rusak, promo), potong liner, penyesuaian dan stok akhir dengan nilainya.',
    f: [F.item, F.empty], c: [['barang', 'Barang'], ['satuan', 'Satuan'], ['awal', 'Stok awal', 'n'], ['masuk', 'Masuk', 'n'], ['penjualan', 'Terjual', 'n'],
      ['keluar_lain', 'Keluar lain', 'n'], ['potong_liner', 'Potong liner', 'n'], ['penyesuaian', 'Penyesuaian', 'n'], ['akhir', 'Stok akhir', 'n'], ['hpp', 'Harga pokok', 'rp'], ['nilai', 'Nilai stok', 'rp', 1]] },
  stok_terkini: { t: 'Stok terkini', d: 'Stok sekarang per barang, dengan harga pokok dan nilainya.', now: true,
    f: [F.empty], c: [['barang', 'Barang'], ['satuan', 'Satuan'], ['stok', 'Stok', 'n'], ['minimum', 'Minimum', 'n'], ['hpp', 'Harga pokok', 'rp'], ['nilai', 'Nilai stok', 'rp', 1], ['keadaan', 'Keadaan']] },
  stok_riwayat: { t: 'Riwayat stok', d: 'Setiap gerakan stok dengan dokumennya (nomor struk, barang masuk, stok opname) dan saldo berjalan per barang.',
    f: [F.item, F.moveKind], c: [['tanggal', 'Tanggal', 'd'], ['barang', 'Barang'], ['jenis', 'Jenis'], ['dokumen', 'Dokumen'], ['masuk', 'Masuk', 'n', 1], ['keluar', 'Keluar', 'n', 1],
      ['saldo', 'Saldo', 'n'], ['satuan', 'Satuan'], ['oleh', 'Oleh']] },
  stok_minimum: { t: 'Peringatan stok minimum', d: 'Barang yang stoknya sudah di bawah atau sama dengan stok minimum.', now: true,
    c: [['barang', 'Barang'], ['satuan', 'Satuan'], ['stok', 'Stok', 'n'], ['minimum', 'Minimum', 'n'], ['kurang', 'Kurang', 'n']] },
  stok_opname: { t: 'Laporan stok opname', d: 'Hasil hitung stok per barang: stok sistem, hasil hitung, selisih dan nilainya.',
    f: [F.opname, F.item], c: [['tanggal', 'Tanggal', 'd'], ['status', 'Status'], ['jenis', 'Jenis'], ['barang', 'Barang'], ['sistem', 'Sistem', 'n'], ['dihitung', 'Dihitung', 'n'],
      ['selisih', 'Selisih', 'n'], ['dibuang', 'Dibuang', 'n'], ['nilai_selisih', 'Nilai selisih', 'rp', 1], ['oleh', 'Oleh']] },
  // Laporan pembelian
  beli_rinci: { t: 'Pembelian rinci', d: 'Setiap barang masuk yang tidak dibatalkan, dengan pemasok, PO dan harga beli.',
    f: [F.supplier, F.item], c: [['tanggal', 'Tanggal', 'd'], ['barang', 'Barang'], ['jumlah', 'Jumlah', 'n'], ['satuan', 'Satuan'], ['pemasok', 'Pemasok'], ['po', 'PO'],
      ['surat_jalan', 'Surat jalan'], ['harga_satuan', 'Harga per satuan', 'rp'], ['total', 'Total', 'rp', 1], ['status', 'Status'], ['penerima', 'Penerima']] },
  beli_pemasok: { t: 'Pembelian per pemasok', d: 'Jumlah kiriman dan total pembelian per pemasok.',
    c: [['pemasok', 'Pemasok'], ['kiriman', 'Kiriman', 'n', 1], ['jenis_barang', 'Jenis barang', 'n'], ['tanpa_harga', 'Tanpa harga beli', 'n', 1], ['total', 'Total', 'rp', 1]] },
  beli_barang: { t: 'Pembelian per barang', d: 'Jumlah dan total pembelian per barang, dengan harga rata-rata, termurah dan termahal.',
    f: [F.supplier], c: [['barang', 'Barang'], ['jumlah', 'Jumlah', 'n'], ['satuan', 'Satuan'], ['kiriman', 'Kiriman', 'n', 1], ['total', 'Total', 'rp', 1],
      ['rata_rata', 'Rata-rata', 'rp'], ['termurah', 'Termurah', 'rp'], ['termahal', 'Termahal', 'rp']] },
  beli_po: { t: 'PO belum selesai', d: 'Purchase order dan permintaan barang: yang dipesan, yang sudah datang, dan sisanya.',
    f: [F.po, F.supplier], c: [['no', 'No'], ['tanggal', 'Tanggal', 'd'], ['dibutuhkan', 'Dibutuhkan', 'd'], ['pemasok', 'Pemasok'], ['status', 'Status'], ['barang', 'Barang'],
      ['dipesan', 'Dipesan', 'n'], ['diterima', 'Diterima', 'n'], ['sisa', 'Sisa', 'n'], ['satuan', 'Satuan'], ['harga_perkiraan', 'Harga perkiraan', 'rp'], ['nilai_sisa', 'Nilai sisa', 'rp', 1]] },
  // Laporan penjualan
  jual_ringkas: { t: 'Penjualan ringkas', d: 'Penjualan kotor, diskon, bersih, struk, cara bayar, batal dan refund dalam satu tabel.',
    c: [['keterangan', 'Keterangan'], ['nilai', 'Nilai', 'auto']] },
  jual_rinci: { t: 'Penjualan rinci', d: 'Satu baris per struk, termasuk yang dibatalkan, dengan staf, pelanggan, promo dan pembayaran.',
    f: [F.statusJual, F.method, F.channel, F.staff], c: [['waktu', 'Waktu'], ['struk', 'Nomor struk'], ['no_offline', 'No. offline'], ['saluran', 'Saluran'], ['staf', 'Staf'], ['kasir', 'Kasir'],
      ['pelanggan', 'Pelanggan'], ['status', 'Status'], ['metode', 'Metode'], ['referensi', 'Referensi'], ['promo', 'Promo'], ['subtotal', 'Subtotal', 'rp', 1],
      ['diskon', 'Diskon', 'rp', 1], ['total', 'Total', 'rp', 1], ['refund', 'Refund', 'rp', 1], ['dibayar', 'Dibayar', 'rp', 1], ['kembalian', 'Kembalian', 'rp', 1], ['tanda', 'Tanda']] },
  jual_rinci_barang: { t: 'Penjualan rinci per barang', d: 'Satu baris per barang di setiap struk.',
    f: [F.statusJual, F.method, F.channel], c: [['waktu', 'Waktu'], ['struk', 'Nomor struk'], ['status', 'Status'], ['metode', 'Metode'], ['kategori', 'Kategori'], ['produk', 'Produk'],
      ['rasa', 'Rasa'], ['qty', 'Qty', 'n', 1], ['harga', 'Harga', 'rp'], ['kotor', 'Kotor', 'rp', 1], ['diskon', 'Diskon', 'rp', 1], ['bersih', 'Bersih', 'rp', 1], ['catatan', 'Catatan']] },
  jual_harian: { t: 'Penjualan harian', d: 'Per hari: struk, produk terjual, penjualan, batal dan refund yang disetujui hari itu, dan rata-rata per struk.',
    c: [['tanggal', 'Tanggal', 'd'], ['hari', 'Hari'], ['struk', 'Struk', 'n', 1], ['qty', 'Produk terjual', 'n', 1], ['kotor', 'Kotor', 'rp', 1], ['diskon', 'Diskon', 'rp', 1],
      ['refund', 'Batal dan refund', 'rp', 1], ['bersih', 'Bersih', 'rp', 1], ['rata_rata', 'Rata-rata per struk', 'rp'], ['batal', 'Jumlah batal dan refund', 'n', 1]] },
  jual_jam: { t: 'Penjualan per jam', d: 'Per jam buka booth: struk, produk terjual dan penjualan, untuk melihat jam ramai dan sepi.',
    c: [['jam', 'Jam'], ['struk', 'Struk', 'n', 1], ['qty', 'Produk terjual', 'n', 1], ['bersih', 'Penjualan', 'rp', 1], ['rata_rata', 'Rata-rata per struk', 'rp']] },
  jual_produk: { t: 'Penjualan per produk', d: 'Kuantitas terjual, diskon dan penjualan bersih per produk.',
    f: [F.channel], c: [['kategori', 'Kategori'], ['produk', 'Produk'], ['kode', 'Kode'], ['qty', 'Qty', 'n', 1], ['kotor', 'Kotor', 'rp', 1], ['diskon', 'Diskon', 'rp', 1],
      ['bersih', 'Bersih', 'rp', 1], ['rata_rata', 'Rata-rata', 'rp']] },
  jual_kategori: { t: 'Penjualan per kategori', d: 'Struk, kuantitas dan penjualan bersih per kategori produk, dengan bagiannya.',
    f: [F.channel], c: [['kategori', 'Kategori'], ['struk', 'Struk', 'n'], ['qty', 'Qty', 'n', 1], ['bersih', 'Bersih', 'rp', 1], ['persen', 'Bagian', 'pct']] },
  jual_rasa: { t: 'Penjualan per rasa', d: 'Per produk dan rasa: kuantitas, penjualan dan bagian rasa itu di produknya.',
    c: [['produk', 'Produk'], ['rasa', 'Rasa'], ['qty', 'Qty', 'n', 1], ['bersih', 'Bersih', 'rp', 1], ['persen_produk', 'Bagian di produk', 'pct']] },
  jual_staf: { t: 'Penjualan per staf', d: 'Per staf yang melayani: struk, produk, penjualan dan komisinya.',
    c: [['staf', 'Staf'], ['struk', 'Struk', 'n', 1], ['qty', 'Produk', 'n', 1], ['bersih', 'Penjualan', 'rp', 1], ['rata_rata', 'Rata-rata per struk', 'rp'], ['komisi', 'Komisi', 'rp', 1]] },
  jual_metode: { t: 'Penjualan per metode bayar', d: 'Tunai, QRIS dan lainnya, dirangkum atau per hari.',
    f: [F.perHari], c: [['tanggal', 'Tanggal', 'd'], ['metode', 'Metode'], ['struk', 'Struk', 'n', 1], ['total', 'Total', 'rp', 1], ['persen', 'Bagian', 'pct']] },
  jual_member: { t: 'Penjualan per pelanggan', d: 'Per member: struk, total, stempel dan kunjungan terakhir. Pembeli tanpa kartu digabung dalam satu baris.',
    f: [F.q], c: [['pelanggan', 'Pelanggan'], ['whatsapp', 'WhatsApp'], ['struk', 'Struk', 'n', 1], ['total', 'Total', 'rp', 1], ['rata_rata', 'Rata-rata', 'rp'],
      ['stempel', 'Stempel', 'n', 1], ['terakhir', 'Terakhir', 'd']] },
  jual_saluran: { t: 'Penjualan per saluran', d: 'Di booth dan aplikasi pesan-antar.',
    c: [['saluran', 'Saluran'], ['struk', 'Struk', 'n', 1], ['kotor', 'Kotor', 'rp', 1], ['diskon', 'Diskon', 'rp', 1], ['bersih', 'Bersih', 'rp', 1], ['rata_rata', 'Rata-rata', 'rp']] },
  jual_promo: { t: 'Penjualan per promo', d: 'Per jenis promo (BOGO, Diskon 50% flash sale, Diskon 50% instruksi, Tebus Murah, voucher, hadiah stempel, Promo POS): struk, item promo, diskon dan penjualan bersihnya. Item promo adalah barang yang mendapat harga promo.',
    f: [F.promoGroup], c: [['jenis', 'Jenis'], ['promo', 'Promo'], ['dipakai', 'Struk', 'n', 1], ['item', 'Item promo', 'n', 1], ['kotor', 'Kotor', 'rp', 1], ['diskon', 'Diskon', 'rp', 1], ['bersih', 'Bersih', 'rp', 1]] },
  jual_batal: { t: 'Batal dan refund', d: 'Setiap batal dan refund yang disetujui di rentang ini (menurut tanggal disetujui), dengan jumlah uang yang kembali, alasan, yang meminta dan yang menyetujui.',
    f: [F.statusBatal], c: [['waktu', 'Disetujui'], ['waktu_jual', 'Dijual'], ['struk', 'Nomor struk'], ['status', 'Status'], ['bagian', 'Bagian'], ['metode', 'Uang kembali lewat'],
      ['total', 'Jumlah', 'rp', 1], ['alasan', 'Alasan'], ['diminta', 'Diminta'], ['disetujui', 'Disetujui oleh']] },
  // Laporan laba
  laba_produk: { t: 'Laba per produk', d: 'Penjualan, harga pokok dan laba kotor per produk, dirangkum atau per hari.',
    f: [F.perHari], c: [['tanggal', 'Tanggal', 'd'], ['produk', 'Produk'], ['qty', 'Qty', 'n', 1], ['diskon', 'Diskon', 'rp', 1], ['penjualan', 'Penjualan', 'rp', 1], ['hpp', 'Harga pokok', 'rp', 1],
      ['laba', 'Laba kotor', 'rp', 1], ['margin', 'Margin', 'pct'], ['catatan', 'Catatan']] },
  laba_hari: { t: 'Laba per hari', d: 'Penjualan, harga pokok dan laba kotor per hari.',
    c: [['tanggal', 'Tanggal', 'd'], ['hari', 'Hari'], ['penjualan', 'Penjualan', 'rp', 1], ['diskon', 'Diskon', 'rp', 1], ['hpp', 'Harga pokok', 'rp', 1], ['laba', 'Laba kotor', 'rp', 1],
      ['margin', 'Margin', 'pct'], ['catatan', 'Catatan']] },
  laba_transaksi: { t: 'Laba per transaksi', d: 'Laba kotor setiap struk yang dibayar, dan satu baris minus untuk setiap batal atau refund di tanggal disetujui.',
    c: [['waktu', 'Waktu'], ['struk', 'Nomor struk'], ['metode', 'Metode'], ['penjualan', 'Penjualan', 'rp', 1], ['hpp', 'Harga pokok', 'rp', 1], ['laba', 'Laba kotor', 'rp', 1],
      ['margin', 'Margin', 'pct'], ['catatan', 'Catatan']] },
  // Laporan lainnya
  kas_rekap: { t: 'Rekapitulasi kas', d: 'Satu baris per shift: struk, produk terjual dan penjualan, laci kas dan selisihnya. Tekan baris atau Lihat untuk rincian setiap transaksi di shift itu.',
    drill: (panel, rpc, row, back) => shiftDetail(panel, rpc, row.id, back),
    c: [['mulai', 'Mulai'], ['berakhir', 'Berakhir'], ['perangkat', 'Perangkat'], ['akun', 'Akun'], ['dilayani', 'Dilayani'],
      ['struk', 'Struk', 'n', 1], ['produk', 'Produk terjual', 'n', 1], ['penjualan', 'Penjualan', 'rp', 1], ['tunai', 'Tunai', 'rp', 1],
      ['kas_masuk', 'Kas masuk', 'rp', 1], ['kas_keluar', 'Kas keluar', 'rp', 1], ['setor', 'Setor', 'rp', 1], ['seharusnya', 'Seharusnya', 'rp'], ['dihitung', 'Dihitung', 'rp'],
      ['selisih', 'Selisih', 'rp', 1], ['status', 'Status']] },
  kas_gerak: { t: 'Kas masuk dan keluar', d: 'Setiap uang masuk, keluar dan setor dari laci, dengan alasannya.',
    f: [F.cashKind], c: [['waktu', 'Waktu'], ['jenis', 'Jenis'], ['masuk', 'Masuk', 'rp', 1], ['keluar', 'Keluar', 'rp', 1], ['alasan', 'Alasan'], ['oleh', 'Oleh'], ['shift', 'Shift', 'n']] },
  diskon: { t: 'Diskon', d: 'Setiap struk dengan diskon: promo, subtotal, diskon dan total.',
    c: [['waktu', 'Waktu'], ['struk', 'Nomor struk'], ['pelanggan', 'Pelanggan'], ['promo', 'Promo'], ['subtotal', 'Subtotal', 'rp', 1], ['diskon', 'Diskon', 'rp', 1], ['total', 'Total', 'rp', 1]] },
  hpp: { t: 'Harga pokok penjualan', d: 'Harga pokok yang terpakai untuk penjualan, per produk atau per bahan.',
    f: [F.hpp], c: (fl) => (fl.group === 'bahan'
      ? [['barang', 'Bahan'], ['qty', 'Terpakai', 'n'], ['satuan', 'Satuan'], ['harga_pokok', 'Harga pokok', 'rp'], ['hpp', 'Total', 'rp', 1]]
      : [['produk', 'Produk'], ['qty', 'Qty', 'n', 1], ['per_satuan', 'Per satuan', 'rp'], ['hpp', 'Total', 'rp', 1], ['catatan', 'Catatan']]) },
  komisi: { t: 'Komisi', d: 'Komisi per staf menurut aturan di Tim, Komisi.',
    f: [F.staff], c: [['staf', 'Staf'], ['struk', 'Struk', 'n', 1], ['penjualan', 'Penjualan', 'rp', 1], ['komisi', 'Komisi', 'rp', 1]] },
  komisi_proses: { t: 'Proses komisi', d: 'Komisi yang sudah diproses di Transaksi, Proses komisi, dan statusnya.',
    f: [F.staff], c: [['dari', 'Dari', 'd'], ['sampai', 'Sampai', 'd'], ['staf', 'Staf'], ['struk', 'Struk', 'n', 1], ['penjualan', 'Penjualan', 'rp', 1], ['komisi', 'Komisi', 'rp', 1],
      ['status', 'Status'], ['diproses', 'Diproses'], ['dibayar', 'Dibayar'], ['catatan', 'Catatan']] },
  voucher: { t: 'Penggunaan voucher dan hadiah', d: 'Setiap hadiah stempel, voucher member baru, ulang tahun dan voucher kertas yang dipakai.',
    f: [F.voucher], c: [['waktu', 'Waktu'], ['member', 'Member'], ['jenis', 'Jenis'], ['hadiah', 'Hadiah'], ['struk', 'Nomor struk'], ['diskon', 'Diskon', 'rp', 1], ['kasir', 'Kasir'], ['dari', 'Dari']] },
  transaksi_pelanggan: { t: 'Transaksi pelanggan', d: 'Setiap struk member dengan barang yang dibeli.',
    f: [F.q, F.memberStatus], c: [['waktu', 'Waktu'], ['struk', 'Nomor struk'], ['member', 'Member'], ['whatsapp', 'WhatsApp'], ['barang', 'Barang'], ['promo', 'Promo'],
      ['total', 'Total', 'rp', 1], ['stempel', 'Stempel', 'n', 1], ['status', 'Status']] },
};

// Yesterday's views, now the first item of their hub.
const LEGACY = {
  stok: { t: 'Masuk, keluar, selisih', d: 'Ringkasan per barang dengan selisih stok opname (tampilan sebelumnya).', mount: (el) => ownerStock(el, { part: 'report' }) },
  pembelian: { t: 'Ringkasan pembelian', d: 'Per pemasok, per barang dan rinciannya dalam satu halaman (tampilan sebelumnya).', mount: (el, rpc) => mountLaporan(el, { rpc, part: 'pembelian' }) },
  penjualan: { t: 'Ringkasan dan grafik', d: 'Angka hari ini, grafik, produk terlaris, dan ekspor empat lembar ala VireoPOS (tampilan sebelumnya).', mount: (el, rpc) => mountOwnerReports(el, { rpc }) },
  laba: { t: 'Laba kotor', d: 'Laba kotor per produk dan per hari dengan komisi (tampilan sebelumnya).', mount: (el, rpc) => mountOwnerReports(el, { rpc, part: 'laba' }) },
  lainnya: { t: 'Ringkasan lainnya', d: 'Laci kas, komisi, promo, barang keluar, kartu dibuat di kasir dan tanda (tampilan sebelumnya).', mount: (el, rpc) => mountLaporan(el, { rpc, part: 'lainnya' }) },
};

export const HUBS = {
  stok: { t: 'Laporan stok', items: ['stok_kartu', 'stok_terkini', 'stok_riwayat', 'stok_minimum', 'stok_opname'] },
  pembelian: { t: 'Laporan pembelian', items: ['beli_rinci', 'beli_pemasok', 'beli_barang', 'beli_po'] },
  penjualan: { t: 'Laporan penjualan', items: ['jual_ringkas', 'jual_rinci', 'jual_rinci_barang', 'jual_harian', 'jual_jam', 'jual_produk', 'jual_kategori', 'jual_rasa',
    'jual_staf', 'jual_metode', 'jual_member', 'jual_saluran', 'jual_promo', 'jual_batal'] },
  laba: { t: 'Laporan laba', items: ['laba_produk', 'laba_hari', 'laba_transaksi'] },
  lainnya: { t: 'Laporan lainnya', items: ['kas_rekap', 'kas_gerak', 'diskon', 'hpp', 'komisi', 'komisi_proses', 'voucher', 'transaksi_pelanggan'] },
};

/* ---------------------------------------------------------------- formatting */
const cellText = (type, v, row) => {
  if (v == null || v === '') return type === 'rp' || type === 'n' ? '–' : '';
  if (type === 'auto') return row.satuan === 'rp' ? rp(v) : num(v);
  if (type === 'rp') return rp(v);
  if (type === 'rpz') return Number(v) ? rp(v) : '';
  if (type === 'n') return num(v);
  if (type === 'pct') return pct(v);
  if (type === 'd') return dmy(v);
  return String(v);
};
const isNum = (type) => ['rp', 'rpz', 'n', 'pct', 'auto'].includes(type);
const columnsFor = (spec, filters) => (typeof spec.c === 'function' ? spec.c(filters) : spec.c)
  .filter(([key]) => !(key === 'tanggal' && spec.f?.includes(F.perHari) && filters.group !== 'hari'));

function footFor(cols) {
  if (!cols.some((c) => c[3])) return null;
  return (rows) => cols.map(([key, , type, total], i) => {
    if (i === 0) return ['Jumlah', 'Jumlah'];
    if (!total) return null;
    const s = rows.reduce((t, r) => t + (Number(r[key]) || 0), 0);
    return [cellText(type, s, {}), Math.round(s * 100) / 100];
  });
}

let optCache = null;
async function options(rpc) {
  if (optCache) return optCache;
  try { optCache = await rpc('stock_catalog'); } catch { optCache = { staff: [], items: [], suppliers: [] }; }
  return optCache;
}

function filterHtml(fl, opts, val) {
  const id = `lap-f-${fl.k}`;
  if (fl.check) return `<label class="row" style="align-self:end;min-height:40px;gap:var(--space-xs)"><input type="checkbox" id="${id}" data-f="${fl.k}"${val ? ' checked' : ''}> <span>${esc(fl.l)}</span></label>`;
  if (fl.search) return `<label class="field"><span>${esc(fl.l)}</span><input type="search" id="${id}" data-f="${fl.k}" value="${esc(val || '')}" autocomplete="off"></label>`;
  let o = fl.o;
  if (fl.src === 'staff') o = [['', 'Semua'], ...(opts.staff || []).map((s) => [s.id, s.name])];
  if (fl.src === 'items') o = [['', 'Semua barang'], ...(opts.items || []).map((s) => [String(s.id), s.name])];
  if (fl.src === 'suppliers') o = [['', 'Semua'], ['tanpa', 'Tanpa pemasok'], ...(opts.suppliers || []).map((s) => [String(s.id), s.name])];
  return `<label class="field"><span>${esc(fl.l)}</span><select id="${id}" data-f="${fl.k}">${o.map(([v, l]) => `<option value="${esc(v)}"${String(val ?? o[0][0]) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
}

/* ---------------------------------------------------------------- hub and report views */
export function mountReportHub(panel, { rpc, hub, open } = {}) {
  const H = HUBS[hub];
  if (!H) { panel.innerHTML = '<p class="muted">Laporan tidak dikenal.</p>'; return; }
  panel.className = 'stack-lg';
  const list = () => {
    const lg = LEGACY[hub];
    panel.innerHTML = `<section class="panel stack" aria-labelledby="lap-h-${hub}">
        <div class="dt-head"><h1 id="lap-h-${hub}">${esc(H.t)}</h1><p class="muted small">Pilih laporan. Setiap laporan punya rentang tanggal, saringan, tombol Tampilkan dan Ekspor.</p></div>
        <div class="lap-list">${H.items.map((k) => `<button type="button" class="lap-item" data-open="${k}"><span><b>${esc(R[k].t)}</b><small>${esc(R[k].d)}</small></span><span class="hm-chev" aria-hidden="true">›</span></button>`).join('')}
          ${lg ? `<button type="button" class="lap-item" data-open="_legacy"><span><b>${esc(lg.t)}</b><small>${esc(lg.d)}</small></span><span class="hm-chev" aria-hidden="true">›</span></button>` : ''}</div>
      </section>`;
    $$('[data-open]', panel).forEach((b) => b.addEventListener('click', () => show(b.dataset.open)));
  };
  const back = () => `<button class="btn btn-text" type="button" data-back>‹ Semua ${esc(H.t.toLowerCase())}</button>`;
  const show = (key) => {
    if (key === '_legacy') {
      panel.innerHTML = `<div class="row">${back()}</div><div data-legacy class="stack-lg"></div>`;
      $('[data-back]', panel).addEventListener('click', list);
      LEGACY[hub].mount($('[data-legacy]', panel), rpc);
      return;
    }
    reportView(panel, rpc, key, back(), list);
  };
  if (open && (R[open] || open === '_legacy')) show(open); else list();
}

const state = {};   // per report: { from, to, filters } kept while the page is open
async function reportView(panel, rpc, key, backHtml, onBack) {
  const spec = R[key];
  const today = ymdToday();
  const st = state[key] || (state[key] = { from: presetRange('7', null, today)[0], to: today, filters: {} });
  if (spec.f?.includes(F.po) && !st.filters.status) st.filters.status = 'terbuka';
  const opts = spec.f?.some((x) => x.src) ? await options(rpc) : {};
  panel.innerHTML = `<div class="row">${backHtml}</div>
    <section class="panel stack" aria-labelledby="lap-t-${key}">
      <div class="dt-head"><h1 id="lap-t-${key}">${esc(spec.t)}</h1><p class="muted small">${esc(spec.d)}</p>${ruleFor(key) ? `<p class="muted small">${esc(ruleFor(key))}</p>` : ''}</div>
      <form class="stack" data-form novalidate>
        ${spec.now ? '<p class="small muted">Keadaan saat ini, tidak memakai rentang tanggal.</p>' : rangeHtml({ from: st.from, to: st.to, keys: KEYS_YEAR })}
        <div class="lap-bar">
          ${(spec.f || []).map((fl) => filterHtml(fl, opts, st.filters[fl.k])).join('')}
          <button class="btn" type="submit" data-go>Tampilkan</button>
        </div>
      </form>
      <div class="notice" data-msg role="status" hidden></div>
      <p class="muted small num" data-sum aria-live="polite"></p>
      <div data-table></div>
    </section>`;
  $('[data-back]', panel).addEventListener('click', onBack);
  const msg = $('[data-msg]', panel), form = $('[data-form]', panel);
  if (!spec.now) wireRange(panel, { onChange: () => load() });
  const read = () => {
    if (!spec.now) {
      const f = $('[data-from]', panel).value, t = $('[data-to]', panel).value;
      if (!f || !t) throw new Error('Isi tanggal dari dan sampai.');
      if (f > t) throw new Error('Tanggal akhir tidak boleh sebelum tanggal awal.');
      st.from = f; st.to = t;
    }
    st.filters = {};
    $$('[data-f]', panel).forEach((el) => {
      const v = el.type === 'checkbox' ? el.checked : el.value.trim();
      if (v !== '' && v !== false) st.filters[el.dataset.f] = v;
    });
  };
  let table = null;
  async function load() {
    notice(msg, '');
    try { read(); } catch (e) { notice(msg, e.message); return; }
    const btn = $('[data-go]', panel);
    busy(btn, true, 'Memuat…');
    const from = spec.now ? today : st.from, to = spec.now ? today : st.to;
    let d;
    try { d = await rpc('owner_laporan', { p_report: key, p_from: from, p_to: to, p_filter: st.filters }); }
    catch (e) { busy(btn, false); notice(msg, e.message); return; }
    busy(btn, false);
    const cols = columnsFor(spec, st.filters);
    const rows = (d.rows || []).map((r, i) => ({ ...r, _k: i }));
    $('[data-sum]', panel).textContent = `${spec.now ? 'Per ' + dmy(today) : dmy(from) + ' sampai ' + dmy(to)}. ${rows.length} baris.`;
    const host = $('[data-table]', panel);
    host.innerHTML = '';
    table = dataTable(host, {
      rowKey: '_k', rows, pageSize: 25, emptyText: 'Tidak ada data di rentang ini.',
      exportName: `hanashuya-${key.replace(/_/g, '-')}-${from}-${to}`,
      searchKeys: cols.filter((c) => !isNum(c[2])).map((c) => c[0]),
      columns: cols.map(([k, label, type]) => ({
        key: k, label, sort: true, align: isNum(type) ? 'num' : undefined,
        format: (v, r) => cellText(type, v, r),
        export: (r) => (isNum(type) && type !== 'auto' && r[k] != null && r[k] !== '' ? Number(r[k]) : (type === 'auto' ? Number(r[k]) : r[k] ?? '')),
      })),
      foot: footFor(cols),
      // A report with a drill-down (Rekapitulasi kas, 13 Nov 2026): the row and its Lihat button open it.
      ...(spec.drill ? { editLabel: 'Lihat', onEdit: (r) => spec.drill(panel, rpc, r, () => reportView(panel, rpc, key, backHtml, onBack)) } : {}),
    });
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
}

/* ---------------------------------------------------------------- Rekapitulasi kas: one shift */
// Glenn, 13 Nov 2026: clicking a rekap opens a detailed view, as in VireoPOS. Info about the shift, three
// tabs (Penjualan with quantity, price and total apart; Pembayaran; Lainnya for the drawer), then every
// transaction of the shift with a Jumlah row. SQL: owner_shift_detail (pos-laporan2.sql).
const ORDER_COLS = [['waktu', 'Waktu'], ['struk', 'Nomor struk'], ['saluran', 'Saluran'], ['dilayani', 'Dilayani'], ['kasir', 'Akun kasir'], ['pelanggan', 'Pelanggan'],
  ['status', 'Status'], ['metode', 'Metode bayar'], ['catatan', 'Catatan'], ['produk', 'Produk', 'n', 1], ['subtotal', 'Subtotal', 'rp', 1], ['diskon', 'Diskon', 'rp', 1],
  ['total', 'Total', 'rp', 1], ['dibayar', 'Dibayar', 'rp', 1], ['kembalian', 'Kembalian', 'rp', 1]];

// '2026-11-13 19:38:42' -> '13/11/2026 19.38'
const stampShort = (v) => { const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(v || ''); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}.${m[5]}` : (v || ''); };
async function shiftDetail(panel, rpc, id, back) {
  panel.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
  let d;
  try { d = await rpc('owner_shift_detail', { p_shift: id }); }
  catch (e) {
    panel.innerHTML = `<div class="row"><button class="btn btn-text" type="button" data-back>‹ Rekapitulasi kas</button></div><div class="notice notice-error" role="alert">${esc(e.message)}</div>`;
    $('[data-back]', panel).addEventListener('click', back);
    return;
  }
  const i = d.info, x = d.other;
  const paid = d.orders.filter((o) => o.status === 'Selesai');
  const pcs = paid.reduce((t, o) => t + Number(o.produk || 0), 0);
  const kv = (label, value) => `<div><dt>${esc(label)}</dt><dd class="num">${value}</dd></div>`;
  const rowKv = (label, value, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><th scope="row">${esc(label)}</th><td class="num">${value}</td></tr>`;
  const signedRp = (n) => (n == null ? '–' : (n > 0 ? '+' : '') + rp(n));
  const itemsHtml = d.items.length ? `<div class="table-wrap"><table><thead><tr><th>Produk</th><th>Rasa</th><th class="num">Qty</th><th class="num">Harga</th><th class="num">Total</th></tr></thead><tbody>
      ${d.items.map((it) => `<tr><td>${esc(it.produk)}${it.promo ? ' <span class="tag tag-warn">promo</span>' : ''}${it.paper_bag_gratis ? ' <span class="tag">gratis</span>' : ''}</td><td>${esc(it.rasa || '–')}</td>
        <td class="num">${num(it.qty)}</td><td class="num">${it.harga == null ? '–' : rp(it.harga)}</td><td class="num">${rp(it.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row" colspan="4">Subtotal (harga normal)</th><td class="num">${rp(d.subtotal)}</td></tr>
        ${d.diskon ? `<tr><th scope="row" colspan="4">Diskon</th><td class="num">-${rp(d.diskon)}</td></tr>` : ''}
        <tr><th scope="row" colspan="4">Total penjualan</th><td class="num"><b>${rp(d.total)}</b></td></tr></tfoot></table></div>
      <p class="muted small">Harga adalah harga per barang yang dibayar. Barang dengan promo ditulis di baris sendiri, jadi Total sama dengan penjualan.</p>`
    : '<p class="muted">Belum ada penjualan di shift ini.</p>';
  const payHtml = d.payments.length ? `<div class="table-wrap"><table><thead><tr><th>Metode bayar</th><th class="num">Struk</th><th class="num">Total</th></tr></thead><tbody>
      ${d.payments.map((p) => `<tr><td>${esc(p.metode)}</td><td class="num">${num(p.struk)}</td><td class="num">${rp(p.total)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><th scope="row">Jumlah</th><td></td><td class="num"><b>${rp(d.payments.reduce((t, p) => t + Number(p.total || 0), 0))}</b></td></tr></tfoot></table></div>
      ${d.split_count ? `<p class="muted small">${d.split_count} struk dibayar dengan Tunai + QRIS; bagiannya masuk ke dua baris di atas.</p>` : ''}`
    : '<p class="muted">Belum ada pembayaran.</p>';
  const otherHtml = `<div class="table-wrap"><table class="rk-kv"><tbody>
      ${rowKv('Uang modal', rp(x.modal))}
      ${rowKv('Uang tunai diterima dari pembeli', '+' + rp(x.uang_diterima))}
      ${rowKv('Kembalian diberikan', '-' + rp(x.kembalian))}
      ${rowKv('Kas masuk', '+' + rp(x.kas_masuk))}
      ${rowKv('Kas keluar', '-' + rp(x.kas_keluar))}
      ${rowKv('Setor ke pemilik', '-' + rp(x.setor))}
      ${rowKv('Seharusnya di laci', `<b>${rp(x.seharusnya)}</b>`, 'rk-sum')}
      ${rowKv('Dihitung staf', x.dihitung == null ? '–' : rp(x.dihitung))}
      ${rowKv('Selisih', signedRp(x.selisih), 'rk-sum')}
      ${rowKv(`Dibatalkan (${x.batal_count} struk)`, rp(x.batal_amount))}
      ${rowKv(`Refund (${x.refund_count})`, rp(x.refund_amount))}
    </tbody></table></div>
    ${x.catatan ? `<p class="small">Catatan staf: ${esc(x.catatan)}</p>` : ''}
    ${(d.moves || []).length ? `<h3>Kas masuk, keluar dan setor</h3><ul class="rk-moves">${d.moves.map((m) => `<li><span>${esc(m.time)} · ${esc({ masuk: 'Masuk', keluar: 'Keluar', setor: 'Setor' }[m.kind] || m.kind)}: ${esc(m.reason)}${m.by ? ` (${esc(m.by)})` : ''}</span><b class="num">${m.kind === 'masuk' ? '+' : '-'}${rp(m.amount)}</b></li>`).join('')}</ul>` : ''}`;
  const tabs = [['jual', 'Penjualan', itemsHtml], ['bayar', 'Pembayaran', payHtml], ['lain', 'Lainnya', otherHtml]];
  panel.innerHTML = `<div class="row">
      <button class="btn btn-text" type="button" data-back>‹ Rekapitulasi kas</button></div>
    <section class="panel stack" aria-labelledby="rk-title">
      <div class="row-between"><div class="dt-head"><h1 id="rk-title">Rekapitulasi kas</h1>
        <p class="muted small num">Shift #${d.id} · ${esc(stampShort(i.mulai))} sampai ${esc(i.berakhir ? stampShort(i.berakhir) : 'sekarang')}</p></div>
        <button class="btn btn-quiet" type="button" data-x>Ekspor Excel</button></div>
      <div class="notice" data-msg role="status" hidden></div>
      <dl class="rk-info">
        ${kv('Mulai', esc(stampShort(i.mulai)))}${kv('Berakhir', i.berakhir ? esc(stampShort(i.berakhir)) : '<span class="tag tag-ok">Berjalan</span>')}
        ${kv('Gerai', esc(i.gerai || '–'))}${kv('Perangkat', esc(i.perangkat || '–'))}
        ${kv('Akun kasir', esc(i.akun || '–'))}${kv('Dilayani oleh', esc(i.dilayani || '–'))}
      </dl>
      <div class="rk-figs">
        <div><span>Penjualan</span><b class="num">${rp(d.total)}</b></div>
        <div><span>Struk dibayar</span><b class="num">${num(paid.length)}</b></div>
        <div><span>Produk terjual</span><b class="num">${num(pcs)} pcs</b></div>
        <div><span>Selisih laci</span><b class="num">${signedRp(x.selisih)}</b></div>
      </div>
      <div class="tabs" role="tablist" aria-label="Rincian shift">
        ${tabs.map(([k, l], n) => `<button role="tab" type="button" id="rk-t-${k}" aria-controls="rk-p-${k}" aria-selected="${n === 0}" tabindex="${n === 0 ? 0 : -1}">${esc(l)}</button>`).join('')}
      </div>
      ${tabs.map(([k, , html], n) => `<div class="stack" role="tabpanel" id="rk-p-${k}" aria-labelledby="rk-t-${k}" tabindex="0"${n === 0 ? '' : ' hidden'}>${html}</div>`).join('')}
    </section>
    <section class="panel stack" aria-labelledby="rk-data">
      <div class="dt-head"><h2 id="rk-data">Transaksi di shift ini</h2>
        <p class="muted small">Setiap struk, termasuk yang dibatalkan. Dibayar adalah uang yang diberikan pembeli; Kembalian hanya untuk tunai. Baris Jumlah hanya menghitung struk Selesai, sama dengan penjualan di atas.</p></div>
      <div data-table></div>
    </section>`;
  $('[data-back]', panel).addEventListener('click', back);
  // Tabs: click, or left/right, Home and End.
  const list = $$('[role="tab"]', panel);
  const pick = (t, focus) => {
    list.forEach((b) => { const on = b === t; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; $('#' + b.getAttribute('aria-controls'), panel).hidden = !on; });
    if (focus) t.focus();
  };
  list.forEach((t, n) => {
    t.addEventListener('click', () => pick(t));
    t.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      const to = step ? list[(n + step + list.length) % list.length] : e.key === 'Home' ? list[0] : e.key === 'End' ? list[list.length - 1] : null;
      if (to) { e.preventDefault(); pick(to, true); }
    });
  });
  dataTable($('[data-table]', panel), {
    rowKey: 'struk', rows: d.orders, pageSize: 50, emptyText: 'Belum ada transaksi di shift ini.',
    exportName: `hanashuya-rekap-kas-shift-${d.id}`,
    searchKeys: ORDER_COLS.filter((c) => !isNum(c[2])).map((c) => c[0]),
    columns: ORDER_COLS.map(([k, label, type]) => ({
      key: k, label, sort: true, align: isNum(type) ? 'num' : undefined,
      // Time and receipt number on one line.
      ...(k === 'waktu' || k === 'struk' ? { html: true, format: (v) => `<span class="rk-nowrap">${esc(k === 'waktu' ? stampShort(v) : v || '')}</span>` }
        : { format: (v, r) => cellText(type, v, r) }),
      export: (r) => (isNum(type) ? Number(r[k] || 0) : r[k] ?? ''),
    })),
    // Jumlah: paid receipts only, so it matches Penjualan above (a cancelled receipt is listed but not counted).
    foot: (rows) => { const ok = rows.filter((r) => r.status === 'Selesai'); return footFor(ORDER_COLS)(ok).map((c, n) => (n === 0 ? ['Jumlah (selesai)', 'Jumlah (selesai)'] : c)); },
  });
  // One workbook: Transaksi, Barang, Pembayaran, Lainnya.
  $('[data-x]', panel).addEventListener('click', async (e) => {
    const btn = e.currentTarget, msg = $('[data-msg]', panel);
    busy(btn, true, 'Menyiapkan…');
    try {
      await loadSheetJS();
      const X = window.XLSX, wb = X.utils.book_new();
      const info = [['Shift', d.id], ['Mulai', i.mulai], ['Berakhir', i.berakhir || 'Berjalan'], ['Gerai', i.gerai], ['Perangkat', i.perangkat], ['Akun kasir', i.akun], ['Dilayani oleh', i.dilayani], []];
      const tx = [ORDER_COLS.map((c) => c[1]), ...d.orders.map((o) => ORDER_COLS.map(([k, , t]) => (isNum(t) ? Number(o[k] || 0) : o[k] ?? ''))),
        ORDER_COLS.map(([k, , t, tot], n) => (n === 0 ? 'Jumlah (selesai)' : tot ? d.orders.filter((o) => o.status === 'Selesai').reduce((s, o) => s + Number(o[k] || 0), 0) : ''))];
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([...info, ...tx]), 'Transaksi');
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Produk', 'Rasa', 'Qty', 'Harga', 'Total', 'Promo'],
        ...d.items.map((it) => [it.produk, it.rasa, it.qty, it.harga ?? '', it.total, it.promo ? 'Ya' : '']),
        ['Subtotal (harga normal)', '', '', '', d.subtotal], ['Diskon', '', '', '', -d.diskon], ['Total penjualan', '', '', '', d.total]]), 'Barang');
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Metode bayar', 'Struk', 'Total'], ...d.payments.map((p) => [p.metode, p.struk, p.total])]), 'Pembayaran');
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Keterangan', 'Nilai'], ['Uang modal', x.modal], ['Uang tunai diterima', x.uang_diterima], ['Kembalian', x.kembalian],
        ['Kas masuk', x.kas_masuk], ['Kas keluar', x.kas_keluar], ['Setor', x.setor], ['Seharusnya di laci', x.seharusnya], ['Dihitung staf', x.dihitung ?? ''],
        ['Selisih', x.selisih ?? ''], ['Dibatalkan (struk)', x.batal_count], ['Nilai dibatalkan', x.batal_amount], ['Refund', x.refund_count], ['Nilai refund', x.refund_amount]]), 'Lainnya');
      X.writeFile(wb, `hanashuya-rekap-kas-shift-${d.id}.xlsx`);
      notice(msg, 'File Excel tersimpan di unduhan.', 'ok');
    } catch (err) { notice(msg, err.message); } finally { busy(btn, false); }
  });
}

/* ---------------------------------------------------------------- Akunting: Neraca bulanan, Laporan jurnal */
const SOURCES = [['', 'Semua sumber'], ['penjualan', 'Penjualan'], ['batal', 'Retur / pembatalan penjualan'], ['pembelian', 'Pembelian'], ['kas', 'Kas'], ['stok', 'Stok'], ['komisi', 'Komisi'], ['manual', 'Manual']];
const SRC = Object.fromEntries(SOURCES);
// SAK EMKM terms; 'kewajiban' is the database key for Liabilitas (14 Nov 2026).
const TYPE = { aset: 'Aset', kewajiban: 'Liabilitas', ekuitas: 'Ekuitas', pendapatan: 'Pendapatan', beban: 'Beban' };

async function exportAoa(aoa, sheet, name) {
  await loadSheetJS();
  const X = window.XLSX, wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(aoa), sheet);
  X.writeFile(wb, name);
}

export function accExtraView(body, { rpc, tab, from, to, accounts = [] }) {
  return tab === 'bulanan' ? monthlyView(body, rpc, from, to) : journalLinesView(body, rpc, from, to, accounts);
}

function monthlyView(body, rpc, from, to) {
  const st = { mutasi: false, d: null };
  body.innerHTML = `<h2>Posisi keuangan bulanan <span class="muted small" lang="en">Monthly statement of financial position</span></h2>
    <p class="muted small">Saldo akun posisi keuangan (neraca) di akhir setiap bulan, berdampingan. Bulan diambil dari rentang tanggal di atas (paling banyak 24 bulan); bulan berjalan dihitung sampai hari ini.</p>
    <div class="lap-bar"><label class="row" style="gap:var(--space-xs);min-height:40px"><input type="checkbox" data-mutasi> <span>Tampilkan mutasi debit dan kredit</span></label>
      <button class="btn" type="button" data-go>Tampilkan</button><button class="btn btn-quiet" type="button" data-x disabled>Ekspor .xlsx</button></div>
    <div class="notice" data-msg role="status" hidden></div><div data-out></div>`;
  const msg = $('[data-msg]', body), out = $('[data-out]', body);
  const render = () => {
    const d = st.d, M = d.months, mut = st.mutasi;
    if (!d.rows.length) { out.innerHTML = '<p class="muted">Belum ada jurnal di bulan-bulan ini.</p>'; return; }
    const head = `<tr><th scope="col">Akun</th><th scope="col" class="num">Saldo awal</th>${M.map((m) => (mut ? `<th scope="col" class="num">${esc(m.label)} debit</th><th scope="col" class="num">${esc(m.label)} kredit</th>` : '') + `<th scope="col" class="num">${esc(m.label)}</th>`).join('')}</tr>`;
    const line = (label, opening, cells, strong) => `<tr>${strong ? `<th scope="row">${esc(label)}</th>` : `<td>${esc(label)}</td>`}<td class="num">${opening == null ? '' : esc(rp(opening))}</td>${cells.map((c) => (mut ? `<td class="num">${c.debit == null ? '' : esc(rp(c.debit))}</td><td class="num">${c.credit == null ? '' : esc(rp(c.credit))}</td>` : '') + `<td class="num">${strong ? `<b>${esc(rp(c.saldo))}</b>` : esc(rp(c.saldo))}</td>`).join('')}</tr>`;
    const sec = (type) => d.rows.filter((r) => r.type === type).map((r) => line(`${r.code} ${r.name}`, r.opening, r.months)).join('');
    const tot = (k, label) => line(label, null, d.totals.map((t) => ({ saldo: t[k] })), true);
    out.innerHTML = `<div class="table-wrap"><table><thead>${head}</thead><tbody>
      <tr><th scope="rowgroup" colspan="${2 + M.length * (mut ? 3 : 1)}">Aset</th></tr>${sec('aset')}${tot('aset', 'Jumlah aset')}
      <tr><th scope="rowgroup" colspan="${2 + M.length * (mut ? 3 : 1)}">Liabilitas</th></tr>${sec('kewajiban')}${tot('kewajiban', 'Jumlah liabilitas')}
      <tr><th scope="rowgroup" colspan="${2 + M.length * (mut ? 3 : 1)}">Ekuitas</th></tr>${sec('ekuitas')}
      ${line('Laba (rugi) periode berjalan', null, d.profit.map((p) => ({ saldo: p.saldo })))}${tot('ekuitas', 'Jumlah ekuitas')}
      ${line('Jumlah liabilitas dan ekuitas', null, d.totals.map((t) => ({ saldo: Number(t.kewajiban) + Number(t.ekuitas) })), true)}
      </tbody></table></div>
      <p class="${d.totals.every((t) => t.balanced) ? 'muted small' : 'notice notice-error'}">${d.totals.every((t) => t.balanced) ? 'Seimbang di setiap bulan: aset sama dengan liabilitas ditambah ekuitas.' : 'Ada bulan yang tidak seimbang. Hubungi pengembang.'}</p>`;
  };
  const load = async () => {
    notice(msg, '');
    const btn = $('[data-go]', body); busy(btn, true, 'Memuat…');
    try { st.d = await rpc('acc_balance_monthly', { p_from: from, p_to: to }); render(); $('[data-x]', body).disabled = false; }
    catch (e) { notice(msg, e.message); }
    busy(btn, false);
  };
  $('[data-mutasi]', body).addEventListener('change', (e) => { st.mutasi = e.target.checked; if (st.d) render(); });
  $('[data-go]', body).addEventListener('click', load);
  $('[data-x]', body).addEventListener('click', async (e) => {
    const d = st.d; if (!d) return;
    const aoa = [['Kode', 'Akun', 'Jenis', 'Saldo awal', ...d.months.flatMap((m) => [`${m.label} debit`, `${m.label} kredit`, `${m.label} saldo`])]];
    d.rows.forEach((r) => aoa.push([r.code, r.name, TYPE[r.type], Number(r.opening), ...r.months.flatMap((c) => [Number(c.debit), Number(c.credit), Number(c.saldo)])]));
    aoa.push(['', 'Laba (rugi) periode berjalan', 'Ekuitas', '', ...d.profit.flatMap((p) => ['', '', Number(p.saldo)])]);
    aoa.push(['', 'Jumlah aset', '', '', ...d.totals.flatMap((t) => ['', '', Number(t.aset)])]);
    aoa.push(['', 'Jumlah liabilitas', '', '', ...d.totals.flatMap((t) => ['', '', Number(t.kewajiban)])]);
    aoa.push(['', 'Jumlah ekuitas', '', '', ...d.totals.flatMap((t) => ['', '', Number(t.ekuitas)])]);
    const btn = e.currentTarget; // currentTarget is null after the first await
    busy(btn, true, 'Menyiapkan…');
    try { await exportAoa(aoa, 'Posisi keuangan bulanan', `hanashuya-posisi-keuangan-bulanan-${d.from}-${d.to}.xlsx`); } catch (err) { notice(msg, err.message); }
    busy(btn, false);
  });
  load();
}

function journalLinesView(body, rpc, from, to, accounts) {
  body.innerHTML = `<h2>Laporan jurnal</h2>
    <p class="muted small">Semua baris jurnal di rentang tanggal di atas. Saring per akun atau sumber, atau kelompokkan per akun.</p>
    <form class="lap-bar" data-form novalidate>
      <label class="field"><span>Akun</span><select data-acc><option value="">Semua akun</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Sumber</span><select data-src>${SOURCES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Kelompokkan</span><select data-grp><option value="">Tidak, per baris</option><option value="akun">Per akun</option></select></label>
      <button class="btn" type="submit" data-go>Tampilkan</button></form>
    <div class="notice" data-msg role="status" hidden></div><p class="muted small num" data-sum aria-live="polite"></p><div data-table></div>`;
  const msg = $('[data-msg]', body);
  const load = async () => {
    notice(msg, '');
    const btn = $('[data-go]', body); busy(btn, true, 'Memuat…');
    const acc = $('[data-acc]', body).value, src = $('[data-src]', body).value, grp = $('[data-grp]', body).value;
    let d;
    try { d = await rpc('acc_journal_lines', { p_from: from, p_to: to, p_account: acc ? Number(acc) : null, p_source: src || null }); }
    catch (e) { busy(btn, false); notice(msg, e.message); return; }
    busy(btn, false);
    let rows = d.rows, cols;
    if (grp === 'akun') {
      const m = new Map();
      rows.forEach((r) => {
        const g = m.get(r.account_id) || { _k: r.account_id, kode: r.kode, akun: r.akun, jenis: TYPE[r.jenis] || r.jenis, baris: 0, debit: 0, kredit: 0 };
        g.baris += 1; g.debit += Number(r.debit); g.kredit += Number(r.kredit); m.set(r.account_id, g);
      });
      rows = [...m.values()].map((g) => ({ ...g, selisih: g.debit - g.kredit })).sort((a, b) => a.kode.localeCompare(b.kode));
      cols = [['kode', 'Kode'], ['akun', 'Akun'], ['jenis', 'Jenis'], ['baris', 'Baris', 'n', 1], ['debit', 'Debit', 'rp', 1], ['kredit', 'Kredit', 'rp', 1], ['selisih', 'Debit - kredit', 'rp', 1]];
    } else {
      rows = rows.map((r) => ({ ...r, _k: r.id, sumber_l: SRC[r.sumber] || r.sumber }));
      cols = [['tanggal', 'Tanggal', 'd'], ['no', 'No jurnal'], ['keterangan', 'Keterangan'], ['sumber_l', 'Sumber'], ['kode', 'Kode'], ['akun', 'Akun'],
        ['debit', 'Debit', 'rpz', 1], ['kredit', 'Kredit', 'rpz', 1], ['memo', 'Memo'], ['status', 'Status']];
    }
    $('[data-sum]', body).textContent = `${dmy(from)} sampai ${dmy(to)}. ${d.rows.length} baris jurnal.`;
    const host = $('[data-table]', body); host.innerHTML = '';
    dataTable(host, {
      rowKey: '_k', rows, pageSize: 30, emptyText: 'Tidak ada jurnal di rentang ini.', exportName: `hanashuya-laporan-jurnal-${from}-${to}`,
      searchKeys: cols.filter((c) => !isNum(c[2])).map((c) => c[0]),
      columns: cols.map(([k, label, type]) => ({ key: k, label, sort: true, align: isNum(type) ? 'num' : undefined, format: (v, r) => cellText(type, v, r),
        export: (r) => (isNum(type) ? Number(r[k]) : r[k] ?? '') })),
      foot: footFor(cols),
    });
  };
  $('[data-form]', body).addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
}
