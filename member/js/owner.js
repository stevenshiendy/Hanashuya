import { sb, configured, $, $$, esc, rpc, busy, notice, toast, rupiah, when, day, mountLogin, setupMissing, session, signOut, tabs, prettyPhone, signupUrl, qrSvg } from './lib.js';
import { mountProducts } from './owner-products.js';
import { mountOwnerReports } from './owner-reports.js';
import { ownerStock } from './stock.js';
import { mountOwnerAbsensi } from './attendance.js';
import { mountOrders, mountMembers, mountPromos } from './owner-backoffice.js';
import { mountCashRekap } from './owner-cash.js';
import { mountStampBoosts, mountCommission } from './owner-loyalty.js';
import { mountWaTemplates } from './owner-wa.js';
import { mountMemberInsights } from './owner-member-insights.js';
import { mountSamples } from './owner-samples.js';
import { mountLaporan } from './owner-laporan.js';
import { mountTransaksi } from './owner-transaksi.js';
import { mountAkunting } from './owner-akunting.js';
import { mountProduksi } from './owner-produksi.js';
import { mountReservasi } from './owner-reservasi.js';
import { mountReportHub } from './owner-laporan2.js';
import * as rail from './side-rail.js';
import { rangeHtml, wireRange, presetRange, KEYS } from './owner-range.js';
import { ownerSearch } from './owner-search.js';

const sideRail = rail.sideRail;
// The owner menu: [group key, rail icon, heading, [tab id, #hash, label]...].
const MENU = [
  ['beranda', 'home', '', [['t-sum', 'ringkasan', 'Ringkasan']]],
  ['penjualan', 'doc', 'Penjualan', [['t-ord', 'pesanan', 'Pesanan'],
    ['t-sales', 'penjualan', 'Penjualan member'], ['t-kas', 'rekap-kas', 'Rekap kas']]],
  // Laporan group (Glenn, 12 Nov 2026, like VireoPOS): every report in one place.
  ['laporan', 'chart', 'Laporan', [['t-stock-rep', 'stok-laporan', 'Laporan stok'], ['t-lbuy', 'laporan-pembelian', 'Laporan pembelian'],
    ['t-rep', 'laporan-pos', 'Laporan penjualan'], ['t-profit', 'laba-kotor', 'Laporan laba'], ['t-sample', 'laporan-sampel', 'Laporan sampel'], ['t-lother', 'laporan-lainnya', 'Laporan lainnya']]],
  ['promo', 'tag', 'Promo', [['t-promo', 'promo', 'Promo POS'], ['t-camp', 'promo-member', 'Promo member'], ['t-codes', 'voucher-kertas', 'Voucher kertas']]],
  ['produk', 'box', 'Produk', [['t-prod', 'produk', 'Daftar produk'], ['t-cat', 'kategori', 'Kategori'], ['t-flav', 'rasa', 'Rasa'],
    ['t-target', 'target-harian', 'Target harian'], ['t-chan', 'saluran', 'Saluran pesan-antar']]],
  // Stok masuk and Stok opname are the same records as in Transaksi (13 Nov 2026: one name, one view):
  // a 4th field makes the item a shortcut that opens that Transaksi tab. Resep produk (what a sale
  // takes from stock) is not Resep produksi (what making a stock item uses), so both stay.
  ['stok', 'stack', 'Stok', [['t-stock', 'stok', 'Stok sekarang'], ['t-stock-in', 'stok-masuk', 'Stok masuk', 't-in'],
    ['t-stock-op', 'opname-transaksi', 'Stok opname', 't-op2'], ['t-stock-req', 'permintaan', 'Permintaan barang'],
    ['t-recipe', 'resep', 'Resep produk'], ['t-items', 'barang', 'Barang dan harga pokok'], ['t-supp', 'pemasok', 'Pemasok']]],
  ['member', 'person', 'Member', [['t-mem-an', 'analitik-member', 'Analitik member'], ['t-mem', 'member', 'Daftar member'], ['t-help', 'bantuan', 'Bantuan akun'], ['t-rules', 'aturan-kartu', 'Aturan kartu'],
    ['t-boost', 'bonus-stempel', 'Bonus stempel'], ['t-wa', 'template-wa', 'Template WhatsApp'], ['t-join', 'qr-daftar', 'QR pendaftaran']]],
  // Per staf holds izin, rekap and profil for one person (Glenn, 12 Nov 2026); only these keep their own item.
  ['tim', 'team', 'Tim', [['t-staff', 'staf', 'Staf'], ['t-att', 'absensi', 'Presensi harian'], ['t-att-one', 'absen-staf', 'Per staf'],
    ['t-att-ot', 'lembur', 'Lembur'], ['t-att-plan', 'jadwal', 'Jadwal'], ['t-komisi', 'komisi', 'Komisi']]],
  // Transaksi (Glenn, 12 Nov 2026, like VireoPOS): purchase orders, stock in and out, adjustments, commission payouts, voids.
  ['transaksi', 'swap', 'Transaksi', [['t-po', 'purchase-order', 'Purchase Order'], ['t-recv', 'penerimaan-barang', 'Penerimaan barang'],
    ['t-in', 'stok-masuk', 'Stok masuk'], ['t-out', 'stok-keluar', 'Stok keluar'], ['t-op2', 'opname-transaksi', 'Stok opname'],
    ['t-loc', 'lokasi-stok', 'Lokasi stok'], ['t-st', 'stok-transfer', 'Stok transfer'], ['t-to', 'transfer-order', 'Transfer order'], ['t-sj', 'surat-jalan', 'Surat jalan'],
    ['t-pt', 'penerimaan-transfer', 'Penerimaan transfer'], ['t-transit', 'dalam-perjalanan', 'Dalam perjalanan'], ['t-mk', 'produksi', 'Produksi'],
    ['t-unkit', 'bongkar-produksi', 'Bongkar produksi'], ['t-precipe', 'resep-produksi', 'Resep produksi'], ['t-card', 'kartu-stok', 'Kartu stok'],
    ['t-adj', 'penyesuaian-stok', 'Penyesuaian stok'], ['t-kp', 'proses-komisi', 'Proses komisi'], ['t-void', 'pembatalan', 'Pembatalan penjualan'],
    ['t-rsv', 'pesanan-di-muka', 'Pesanan di muka'], ['t-dmut', 'mutasi-deposito', 'Mutasi deposito'], ['t-dres', 'deposit-reservasi', 'Deposit reservasi'],
    ['t-stamp', 'koreksi-stempel', 'Koreksi stempel']]],
  // Akunting (Glenn, 12 Nov 2026, like VireoPOS): chart of accounts, journals (automatic from sales, purchases, cash and stock; manual), reports.
  ['akunting', 'book', 'Akunting', [['t-acc', 'akun-buku-besar', 'Bagan akun'], ['t-jurnal', 'buat-jurnal', 'Jurnal umum'], ['t-lacc', 'laporan-akunting', 'Laporan keuangan']]],
  ['pengaturan', 'gear', 'Pengaturan', [['t-set', 'cadangan', 'Cadangan data'], ['t-queue', 'nota-antrian', 'Nota antrian'], ['t-tax', 'pajak-service', 'Pajak dan service']]],
];
// Hashes that no longer name a view. Every other old hash (produk, stok, staf, absensi,
// member, promo, laporan-pos, ...) is still the first view of its feature.
const ALIAS = { pengaturan: 'cadangan', persetujuan: 'absen-staf', rekap: 'absen-staf', 'profil-staf': 'absen-staf',
  'barang-masuk': 'stok-masuk', 'stok-opname': 'opname-transaksi' };
const isLink = (item) => !!item[3];
// A manager signs in here too (Glenn, 13 Nov 2026) and sees the reports read-only: Ringkasan, the Laporan
// group, the Transaksi lists and Laporan akunting. Settings, staff accounts, products and prices, backups,
// promo setup, vouchers and member data stay with the owner (the SQL refuses them for a manager as well).
const MANAGER_VIEWS = new Set(['ringkasan', 'stok-laporan', 'laporan-pembelian', 'laporan-pos', 'laba-kotor', 'laporan-sampel', 'laporan-lainnya',
  'purchase-order', 'penerimaan-barang', 'stok-masuk', 'stok-keluar', 'opname-transaksi', 'penyesuaian-stok', 'kartu-stok',
  'dalam-perjalanan', 'proses-komisi', 'pembatalan', 'laporan-akunting']);
const menuFor = (role) => (role === 'owner' ? MENU : MENU.map(([key, icon, title, items]) =>
  [key, icon, title, items.filter((i) => !isLink(i) && MANAGER_VIEWS.has(i[1]))]).filter(([, , , items]) => items.length));
const viewsOf = (menu) => menu.flatMap(([, , group, items]) => items.filter((i) => !isLink(i)).map(([id, hash, label]) => ({ id, hash, label, group: group || 'Beranda' })));
let VIEWS = viewsOf(MENU);
let READ_ONLY = false;

const app = $('#app');
const DAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const FLAG = { kartu_staf: 'Kartu milik staf', total_besar: 'Total di atas Rp500.000', kode_diketik: 'Kode kartu diketik', nomor_dicari: 'Kartu dicari lewat nomor WhatsApp', staf_sama_sering: 'Staf yang sama sering memberi stempel ke kartu ini', banyak_stempel_sehari: 'Banyak stempel dalam sehari' };
const PROBLEM = { tidak_ada_struk_cocok: 'Tidak ada struk dengan total dan jam yang sama', nama_beda: 'Nama pelanggan di VireoPOS beda' };
const LABEL = { perempuan: 'Perempuan', 'laki-laki': 'Laki-laki', tidak_disebut: 'Tidak disebut', kosong: 'Tidak diisi', '<17': 'Di bawah 17' };
// Ringkasan range: the shared control (js/owner-range.js, 13 Nov 2026), 30 hari at first.
// ?rentang=hari|kemarin|7|30|bulan|bulan-lalu, or ?dari=&sampai=; the old ?hari=7|30 still works.
const qs0 = new URLSearchParams(location.search);
const sumRange = (() => {
  if (qs0.get('dari') && qs0.get('sampai')) return { preset: 'custom', from: qs0.get('dari'), to: qs0.get('sampai') };
  const k = qs0.get('rentang') || qs0.get('hari');
  const preset = KEYS.includes(k) && k !== 'custom' ? k : '30';
  const [from, to] = presetRange(preset, null);
  return { preset, from, to };
})();
const isoFmt = (opts) => (iso) => (iso ? new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', ...opts }).format(new Date(iso + 'T00:00:00Z')) : '');
const dayLong = isoFmt({ day: 'numeric', month: 'long', year: 'numeric' });
const dayShort = isoFmt({ weekday: 'short', day: 'numeric', month: 'short' });

async function start() {
  if (!configured) return setupMissing(app);
  if (!(await session())) return mountLogin(app, { staff: true, title: 'Dasbor pemilik', lead: 'Masuk dengan username atau nomor WhatsApp dan password pemilik.', onDone: boot });
  boot();
}

async function boot() {
  $('#logout').hidden = false;
  const who = await rpc('whoami').catch(() => null);
  if (!who || (who.role !== 'owner' && who.role !== 'manager')) {
    app.innerHTML = `<section class="panel stack"><h1>Tidak ada akses</h1></section>`;
    return;
  }
  READ_ONLY = who.role === 'manager';
  const MENU_NOW = menuFor(who.role);
  VIEWS = viewsOf(MENU_NOW);
  // The search lists each view once, under the group that owns it (a Stok shortcut is found as its Transaksi view).
  const SEARCH_ITEMS = VIEWS.map(({ hash, label, group }) => ({ hash, label, group }));
  if (READ_ONLY) {
    const roleTag = $('header.bar .role');
    if (roleTag) roleTag.textContent = 'Manajer';
    document.title = 'Laporan Hanashuya';
  }
  $('#to-staff').hidden = false;
  // Sidebar grouped like the VireoPOS back office (Glenn, 11 Nov 2026), one feature per
  // item (Glenn, 12 Nov: "one feature per view"). Each row: [tab id, #hash, label]; the
  // panel id is the tab id with p- in front. Markup contract for js/side-rail.js: one
  // .side-g[data-group][data-icon] per group, labels inside .side-t.
  const shell = MENU_NOW.map(([key, icon, title, items]) => `<div class="side-g" data-group="${key}" data-icon="${icon}">
      ${title ? `<p class="side-h" id="sh-${key}">${title}</p>` : ''}
      <div role="tablist" aria-orientation="vertical" ${title ? `aria-labelledby="sh-${key}"` : 'aria-label="Beranda"'}>${items.filter((i) => !isLink(i)).map(([id, hash, label]) =>
        `<button role="tab" id="${id}" aria-controls="p${id.slice(1)}" data-tab="${hash}"><span class="side-t">${label}</span></button>`).join('')}</div>
      ${items.some(isLink) ? `<div class="side-links">${items.filter(isLink).map(([id, , label, target]) =>
        `<button type="button" class="side-link" id="${id}" data-link="${target}"><span class="side-t">${label}</span></button>`).join('')}</div>` : ''}</div>`).join('\n      ');
  const panels = VIEWS.map(({ id }, i) => `<section id="p${id.slice(1)}" role="tabpanel" aria-labelledby="${id}" class="stack-lg"${i ? ' hidden' : ''}></section>`).join('\n    ');
  app.classList.add('has-side');
  $('header.bar').classList.add('has-side');
  app.innerHTML = `
  <div class="owner-shell">
    <nav class="side" aria-label="${READ_ONLY ? 'Menu laporan' : 'Menu pemilik'}">
      ${shell}
    </nav>
    <div class="owner-main">
    ${panels}
    </div>
  </div>`;
  const P = (id) => $('#' + id);
  const loaders = {
    ringkasan: summary, 'laporan-pos': () => mountOwnerReports(P('p-rep'), { rpc }), 'laba-kotor': () => mountOwnerReports(P('p-profit'), { rpc, part: 'laba' }),
    'laporan-pembelian': () => mountLaporan(P('p-lbuy'), { rpc, part: 'pembelian' }), 'laporan-lainnya': () => mountLaporan(P('p-lother'), { rpc, part: 'lainnya' }),
    'purchase-order': () => mountTransaksi(P('p-po'), { rpc, part: 'po', readOnly: READ_ONLY }), 'penerimaan-barang': () => mountTransaksi(P('p-recv'), { rpc, part: 'penerimaan', readOnly: READ_ONLY }),
    'stok-masuk': () => mountTransaksi(P('p-in'), { rpc, part: 'stok-masuk', readOnly: READ_ONLY }), 'stok-keluar': () => mountTransaksi(P('p-out'), { rpc, part: 'stok-keluar', readOnly: READ_ONLY }),
    'opname-transaksi': () => mountTransaksi(P('p-op2'), { rpc, part: 'opname', readOnly: READ_ONLY }), 'penyesuaian-stok': () => mountTransaksi(P('p-adj'), { rpc, part: 'adjustment', readOnly: READ_ONLY }),
    ...Object.fromEntries([['lokasi-stok', 'p-loc', 'lokasi'], ['stok-transfer', 'p-st', 'stok-transfer'], ['transfer-order', 'p-to', 'transfer-order'],
      ['surat-jalan', 'p-sj', 'surat-jalan'], ['penerimaan-transfer', 'p-pt', 'penerimaan'], ['dalam-perjalanan', 'p-transit', 'perjalanan'], ['produksi', 'p-mk', 'produksi'],
      ['bongkar-produksi', 'p-unkit', 'bongkar'], ['resep-produksi', 'p-precipe', 'resep'], ['kartu-stok', 'p-card', 'kartu']]
      .map(([h, id, part]) => [h, () => mountProduksi(P(id), { rpc, part, readOnly: READ_ONLY })])),
    'proses-komisi': () => mountTransaksi(P('p-kp'), { rpc, part: 'komisi-proses', readOnly: READ_ONLY }), pembatalan: () => mountTransaksi(P('p-void'), { rpc, part: 'pembatalan', readOnly: READ_ONLY }),
    'pesanan-di-muka': () => mountReservasi(P('p-rsv'), { rpc, part: 'pesanan' }), 'mutasi-deposito': () => dpHistory(P('p-dmut'), 'mutasi'),
    'deposit-reservasi': () => dpHistory(P('p-dres'), 'deposit'), 'koreksi-stempel': () => mountReservasi(P('p-stamp'), { rpc, part: 'stempel' }),
    'akun-buku-besar': () => mountAkunting(P('p-acc'), { rpc, part: 'akun' }), 'buat-jurnal': () => mountAkunting(P('p-jurnal'), { rpc, part: 'jurnal' }),
    'laporan-akunting': () => mountAkunting(P('p-lacc'), { rpc, part: 'laporan' }),
    pesanan: () => mountOrders(P('p-ord'), { rpc }), penjualan: sales, 'rekap-kas': () => mountCashRekap(P('p-kas'), { rpc }),
    promo: () => mountPromos(P('p-promo'), { rpc }), 'promo-member': campaigns, 'voucher-kertas': () => { P('p-codes').innerHTML = ''; codePanel(P('p-codes')); },
    produk: () => mountProducts(P('p-prod'), { rpc }), kategori: () => mountProducts(P('p-cat'), { rpc, part: 'kategori' }),
    rasa: () => mountProducts(P('p-flav'), { rpc, part: 'rasa' }), 'target-harian': () => mountProducts(P('p-target'), { rpc, part: 'target' }),
    saluran: () => mountProducts(P('p-chan'), { rpc, part: 'saluran' }),
    stok: () => ownerStock(P('p-stock'), { part: 'now' }), 'stok-laporan': () => ownerStock(P('p-stock-rep'), { part: 'report' }),
    permintaan: () => ownerStock(P('p-stock-req'), { part: 'requests' }),
    resep: () => ownerStock(P('p-recipe'), { part: 'recipe' }),
    barang: () => ownerStock(P('p-items'), { part: 'items' }),
    pemasok: () => ownerStock(P('p-supp'), { part: 'pemasok' }),
    'analitik-member': () => mountMemberInsights(P('p-mem-an'), { rpc }),
    'laporan-sampel': () => mountSamples(P('p-sample'), { rpc }),
    member: () => mountMembers(P('p-mem'), { rpc }), bantuan: help, 'aturan-kartu': cardRules, 'qr-daftar': joinQr,
    staf: staff, absensi: () => mountOwnerAbsensi(P('p-att'), { part: 'hari' }),
    lembur: () => mountOwnerAbsensi(P('p-att-ot'), { part: 'lembur' }), 'absen-staf': () => mountOwnerAbsensi(P('p-att-one'), { part: 'staf' }),
    jadwal: () => mountOwnerAbsensi(P('p-att-plan'), { part: 'jadwal' }),
    'bonus-stempel': () => mountStampBoosts(P('p-boost'), { rpc }), 'template-wa': () => mountWaTemplates(P('p-wa'), { rpc }),
    komisi: () => mountCommission(P('p-komisi'), { rpc }),
    cadangan: backupView, 'nota-antrian': queueSlipView, 'pajak-service': chargesView,
  };
  // Laporan hubs (13 Nov 2026): each Laporan item lists its sub-reports; the old views are its last item.
  for (const [h, hub, id] of [['stok-laporan', 'stok', 'p-stock-rep'], ['laporan-pembelian', 'pembelian', 'p-lbuy'], ['laporan-pos', 'penjualan', 'p-rep'],
    ['laba-kotor', 'laba', 'p-profit'], ['laporan-lainnya', 'lainnya', 'p-lother']]) loaders[h] = () => mountReportHub(P(id), { rpc, hub });
  // Old links (before the 12 Nov split) land on the first view of their feature.
  const alias = ALIAS[location.hash.slice(1)];
  if (alias) history.replaceState(null, '', '#' + alias);
  // Shortcut items (Stok masuk and Stok opname under Stok) show as open while their Transaksi view is.
  const links = $$('.side-link');
  const syncLinks = () => links.forEach((l) => {
    if ($('#' + l.dataset.link)?.getAttribute('aria-selected') === 'true') l.setAttribute('aria-current', 'page'); else l.removeAttribute('aria-current');
  });
  const go = tabs(app, (t) => {
    const done = loaders[t]();
    syncLinks();
    // On a phone the menu is one scrolling row: keep the open item in view. On wide screens the side
    // menu is left alone, so its collapse button never scrolls away (12 Nov 2026).
    if (matchMedia('(max-width: 56rem)').matches) $('.side [aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return done;
  });
  links.forEach((l) => l.addEventListener('click', () => $('#' + l.dataset.link).click()));
  if (typeof sideRail === 'function') sideRail($('.side'));

  // Global search (13 Nov 2026): any view by name, or an order by its HS- or L- number.
  const host = document.createElement('div');
  host.className = 'os-host';
  $('header.bar .bar-inner').insertBefore(host, $('header.bar .bar-inner > .row'));
  const openReceipt = async (q) => {
    const key = q.trim().toUpperCase().replace(/\s+/g, '-');
    const today = presetRange('hari', null)[0];
    const d = await rpc('owner_pos_orders', { p_from: '2026-01-01', p_to: today, p_q: q.trim(), p_status: 'semua' });
    const rows = d.rows || [];
    if (!rows.length) return `Struk ${key} tidak ditemukan. Periksa nomornya, atau cari nama member di Pesanan.`;
    const exact = rows.find((o) => [o.receipt_no, o.local_no].some((x) => x && x.toUpperCase() === key)) || (rows.length === 1 ? rows[0] : null);
    P('p-ord')._ord = { preset: 'custom', from: '2026-01-01', to: today, status: 'semua', q: q.trim(), openId: exact ? exact.id : null };
    go('pesanan');
    return null;
  };
  // A manager has no Pesanan view, so the search finds views only.
  ownerSearch(host, { items: SEARCH_ITEMS, go: (h) => go(h), openReceipt: READ_ONLY ? null : openReceipt });

  // Other views send people to a record (Kartu stok document numbers): { view, q } fills that
  // list's search; { receipt } opens the order.
  document.addEventListener('hs-owner-go', async (e) => {
    const { view, q, receipt } = e.detail || {};
    if (receipt) { if (READ_ONLY) return; const m = await openReceipt(receipt).catch((err) => err.message); if (m) toast(m); return; }
    const v = VIEWS.find((x) => x.hash === view);
    if (!v) return;
    go(view);
    if (!q) return;
    const panel = P('p' + v.id.slice(1));
    for (let i = 0; i < 50; i++) {
      const box = panel.querySelector('[data-q]');
      if (box && !panel.querySelector('[aria-busy="true"]')) { box.value = q; box.dispatchEvent(new Event('input', { bubbles: true })); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  });
}

// No DP any more (Glenn, 13 Nov 2026): these two views keep only the old DP history, and say so.
async function dpHistory(panel, part) {
  await mountReservasi(panel, { rpc, part });
  if (panel.querySelector('[data-dp-note]')) return;
  panel.insertAdjacentHTML('afterbegin', '<p class="notice" data-dp-note>Pesanan di muka tidak memakai DP lagi. Halaman ini hanya menampilkan riwayat DP lama.</p>');
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
  if (sumRange.preset !== 'custom') [sumRange.from, sumRange.to] = presetRange(sumRange.preset, null);
  const byDays = { 7: 7, 30: 30 }[sumRange.preset];
  // report_dashboard (pos-reports.sql, 13 Nov 2026): the same figures for the owner and a manager, with
  // undone sales and rewards taken off on the day they were approved; personal data only for the owner.
  try { d = await rpc('report_dashboard', byDays ? { p_days: byDays } : { p_days: null, p_from: sumRange.from, p_to: sumRange.to }); } catch (e) { return failed(p, e, summary); }
  const isOwner = d.role !== 'manager';
  const t = d.totals;
  const backupDays = d.last_backup ? Math.floor((Date.now() - Date.parse(d.last_backup)) / 864e5) : null;
  p.innerHTML = `
  ${isOwner && (backupDays === null || backupDays >= 7) ? `<p class="notice notice-warn">${backupDays === null ? 'Data member belum pernah dicadangkan.' : `Cadangan data terakhir ${backupDays} hari lalu.`}
    <a href="#cadangan" data-goto="t-set">Unduh cadangan di Pengaturan, Cadangan data</a>.</p>` : ''}
  <div class="row-between">
    <div class="stack-sm"><h1>Ringkasan</h1><p class="muted small">${esc(dayLong(d.from))}${d.from !== d.to ? ` sampai ${esc(dayLong(d.to))}` : ''} · ${d.days} hari</p>
      <p class="muted small">${esc(d.rule || 'Penjualan dihitung di tanggal transaksi. Batal dan refund mengurangi di tanggal disetujui.')}${isOwner ? '' : ' Hanya untuk dilihat.'}</p></div>
  </div>
  ${rangeHtml({ preset: sumRange.preset, from: sumRange.from, to: sumRange.to })}
  <div id="sum-pos" class="stack-lg" aria-busy="true"><div class="kp-tiles">${'<div class="kp-tile"><div class="skeleton"></div></div>'.repeat(4)}</div></div>
  ${d.undo.length ? `<section class="panel stack" aria-labelledby="undo-title">
    <h2 id="undo-title">Permintaan pembatalan (${d.undo.length})</h2>
    <ul class="list">${d.undo.map((u) => `<li><span class="grow"><strong>${esc(u.kind === 'penjualan' ? `${u.receipt_no ? 'Struk ' + u.receipt_no : 'Penjualan ' + rupiah(u.total || 0)}, ${u.stamps} stempel` : u.reward_label)}</strong> untuk ${esc(u.member)}<br>
      <span class="muted small">${esc(u.requested_by || 'Staf')}, ${esc(when(u.created_at))}: ${esc(u.reason)}</span></span>
      <span class="row"><button class="btn" type="button" data-undo="${u.id}" data-ok="1">Setujui</button><button class="btn btn-quiet" type="button" data-undo="${u.id}" data-ok="0">Tolak</button></span></li>`).join('')}</ul>
  </section>` : ''}
  ${t.sales === 0 ? `<div class="panel stack"><h2>Belum ada penjualan ${d.days === 1 ? 'di tanggal ini' : 'di rentang ini'}</h2><p class="muted">Angka di sini terisi begitu kasir mencatat penjualan di halaman kasir.</p><a class="btn" href="kasir">Buka halaman kasir</a></div>` : `
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
  ${d.daily ? `<section class="panel stack" aria-labelledby="daily-title">
    <h2 id="daily-title">Per hari</h2>
    <div class="table-wrap"><table><thead><tr><th>Tanggal</th><th class="num">Penjualan</th><th class="num">Oleh member</th><th class="num">Total belanja</th><th class="num">Stempel</th><th class="num">Hadiah</th><th class="num">Member baru</th></tr></thead><tbody>
      ${d.daily.map((r) => `<tr${r.sales ? '' : ' class="muted"'}><td>${esc(dayShort(r.date))}</td><td class="num">${r.sales}</td><td class="num">${r.member_sales}</td><td class="num">${rupiah(r.revenue)}</td><td class="num">${r.stamps}</td><td class="num">${r.redemptions}</td><td class="num">${r.new_members}</td></tr>`).join('')}
    </tbody><tfoot><tr><th scope="row">Jumlah</th><td class="num">${t.sales}</td><td class="num">${t.member_sales}</td><td class="num">${rupiah(t.revenue)}</td><td class="num">${t.stamps}</td><td class="num">${t.redemptions}</td><td class="num">${t.new_members}</td></tr></tfoot></table></div>
  </section>` : ''}
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
    <h2 id="staff-title">Penjualan per staf</h2>
    <p class="muted small">Dihitung untuk staf yang melayani, bukan akun tablet kasir.</p>
    <div class="table-wrap"><table><thead><tr><th>Nama</th><th class="num">Nota</th><th class="num">Penjualan</th><th class="num">Produk terjual</th><th class="num">Stempel</th><th class="num">Hadiah</th><th class="num">Ditandai</th></tr></thead><tbody>
      ${d.staff.map((s) => `<tr><td>${esc(s.full_name || prettyPhone(s.whatsapp))}</td><td class="num">${s.sales}</td><td class="num">${s.revenue == null ? '–' : rupiah(s.revenue)}</td><td class="num">${s.items == null ? '–' : s.items}</td><td class="num">${s.stamps}</td><td class="num">${s.redemptions}</td><td class="num">${s.flagged ? `<span class="tag tag-warn">${s.flagged}</span>` : 0}</td></tr>`).join('')}
    </tbody></table></div>
  </section>`}
  <section class="panel stack" aria-labelledby="flag-title">
    <h2 id="flag-title">Perlu dicek</h2>
    ${d.flags.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Struk</th><th>Member</th><th>Kasir</th><th class="num">Stempel</th><th>Catatan</th></tr></thead><tbody>
      ${d.flags.map((f) => `<tr><td class="tnum">${esc(when(f.created_at))}</td><td>${esc(f.receipt_no || '–')}</td><td>${esc(f.member)}</td><td>${esc(f.staff || '')}</td><td class="num">${f.stamps}</td><td>${f.flags.map((x) => esc(FLAG[x] || x)).join('<br>')}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">Tidak ada stempel yang ditandai. Kode kartu yang diketik manual dan pola stempel yang aneh muncul di sini.</p>'}
  </section>
  ${isOwner ? `<section class="panel stack" aria-labelledby="lapse-title">
    <h2 id="lapse-title">Member yang lama tidak datang</h2>
    ${d.lapsed.length ? `<ul class="list">${d.lapsed.map((l) => `<li><span class="grow"><strong>${esc(l.full_name || 'Member')}</strong><br>
      <span class="muted small">Terakhir ${esc(day(l.last_at))}, ${l.visits} kunjungan</span></span>
      ${l.whatsapp ? `<a class="btn btn-quiet" href="https://wa.me/${esc(l.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a>` : '<span class="muted small">Tidak mau info promo</span>'}</li>`).join('')}</ul>`
      : '<p class="muted">Tidak ada member yang absen 30 sampai 120 hari.</p>'}
    ${d.lapsed.length ? '<p class="muted small">Tombol WhatsApp hanya muncul untuk member yang mau menerima info promo.</p>' : ''}
  </section>` : ''}`;
  $$('[data-goto]', p).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); $('#' + a.dataset.goto).click(); }));
  const setUrl = () => {
    const u = new URL(location.href);
    ['hari', 'rentang', 'dari', 'sampai'].forEach((k) => u.searchParams.delete(k));
    if (sumRange.preset === 'custom') { u.searchParams.set('dari', sumRange.from); u.searchParams.set('sampai', sumRange.to); } else u.searchParams.set('rentang', sumRange.preset);
    history.replaceState(null, '', u);
  };
  wireRange(p, { onChange: (v) => { Object.assign(sumRange, v); setUrl(); summary(); } });
  posHighlights($('#sum-pos', p), d.from, d.to);
  $$('[data-undo]', p).forEach((b) => b.addEventListener('click', async () => {
    busy(b, true);
    try { await rpc('owner_decide_undo', { p_id: Number(b.dataset.undo), p_approve: b.dataset.ok === '1' }); toast(b.dataset.ok === '1' ? 'Dibatalkan' : 'Ditolak'); summary(); }
    catch (e) { toast(e.message); busy(b, false); }
  }));
}

/* ---------------- Ringkasan: KPI tiles and Grafik penjualan (Glenn, 13 Nov 2026) */
// The POS figures by the one rule (owner_pos_stats, pos-reports.sql): Penjualan, Jumlah nota, Rata-rata
// and Produk terjual, each against the period of the same length just before it, then a line chart
// with a Jam / Hari / Minggu / Bulan switch and Omzet / Jumlah nota. Hanashuya charges no PB1/PPN,
// so the fourth tile is Produk terjual instead of VireoPOS's "Penjualan - Pajak".
const chartPref = { grain: null, measure: 'sales' };
const ymdShift = (ymd, n) => { const t = new Date(ymd + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const spanDays = (f, t) => Math.round((Date.parse(t) - Date.parse(f)) / 864e5) + 1;
const autoGrain = (f, t) => (f === t ? 'jam' : spanDays(f, t) > 92 ? 'bulan' : 'hari');
const shortRp = (n) => { const a = Math.abs(n), s = n < 0 ? '−' : ''; return a >= 1e6 ? `${s}${(a / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })}jt` : a >= 1000 ? `${s}${Math.round(a / 1000)}rb` : `${s}${a}`; };
function niceTicks(max, whole) {
  if (max <= 0) max = whole ? 4 : 100000;
  const raw = max / 4, pow = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((v) => v >= raw);
  if (whole) step = Math.max(1, Math.ceil(step));
  const out = [];
  for (let v = 0; v < max + step / 2; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}
function deltaHtml(now, before, prevLabel) {
  if (before == null) return '';
  if (!before) return now ? `<span class="kp-d">Baru ada ${prevLabel === 'kemarin' ? 'hari ini' : 'di periode ini'}</span>` : `<span class="kp-d">Sama dengan ${prevLabel}</span>`;
  const p = Math.round(((now - before) / Math.abs(before)) * 100);
  if (p === 0) return `<span class="kp-d">Sama dengan ${prevLabel}</span>`;
  return `<span class="kp-d ${p > 0 ? 'is-up' : 'is-down'}"><span aria-hidden="true">${p > 0 ? '▲' : '▼'}</span> ${p > 0 ? 'Naik' : 'Turun'} ${Math.abs(p)}% <span class="kp-dl">dari ${prevLabel}</span></span>`;
}
async function posHighlights(host, from, to) {
  if (!host) return;
  const n = spanDays(from, to), pf = ymdShift(from, -n), pt = ymdShift(from, -1);
  const prevLabel = n === 1 ? (to === new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date()) ? 'kemarin' : 'hari sebelumnya') : `${n} hari sebelumnya`;
  const grain = chartPref.grain && chartPref.range === `${from}|${to}` ? chartPref.grain : autoGrain(from, to);
  let s, prev;
  try {
    [s, prev] = await Promise.all([
      rpc('owner_pos_stats', { p_from: from, p_to: to, p_grain: grain }),
      rpc('owner_pos_stats', { p_from: pf, p_to: pt }).catch(() => null),
    ]);
  } catch (e) {
    host.removeAttribute('aria-busy');
    host.innerHTML = `<p class="notice notice-warn">Angka penjualan kasir belum bisa dimuat: ${esc(e.message)}</p>`;
    return;
  }
  if (!host.isConnected) return;
  const avg = s.average ?? (s.receipts ? Math.round(s.sales / s.receipts) : 0);
  const before = s.sales_before_refunds;
  const tile = (label, value, sub, delta) => `<div class="kp-tile"><span class="kp-l">${label}</span><b class="kp-v num">${value}</b>${sub ? `<span class="kp-s num">${sub}</span>` : ''}${delta}</div>`;
  host.removeAttribute('aria-busy');
  host.innerHTML = `
  <section aria-labelledby="kp-title"><h2 id="kp-title" class="visually-hidden">Penjualan kasir</h2>
    <div class="kp-tiles">
      ${tile('Penjualan', rupiah(s.sales), before != null && before !== s.sales ? `sebelum batal/refund ${rupiah(before)}` : 'setelah batal dan refund', deltaHtml(s.sales, prev?.sales, prevLabel))}
      ${tile('Jumlah nota transaksi', (s.receipts || 0).toLocaleString('id-ID'), '', deltaHtml(s.receipts || 0, prev?.receipts, prevLabel))}
      ${tile('Rata-rata per nota', rupiah(avg), 'penjualan ÷ jumlah nota', deltaHtml(avg, prev ? (prev.average ?? (prev.receipts ? Math.round(prev.sales / prev.receipts) : 0)) : null, prevLabel))}
      ${tile('Produk terjual', `${(s.items || 0).toLocaleString('id-ID')} <small>pcs</small>`, '', deltaHtml(s.items || 0, prev?.items, prevLabel))}
    </div>
  </section>
  <section class="panel stack" aria-labelledby="kp-chart-t" data-kp-chart></section>`;
  drawSalesChart($('[data-kp-chart]', host), s, { from, to, grain: s.grain || grain });
}
const GRAINS = [['jam', 'Jam'], ['hari', 'Hari'], ['minggu', 'Minggu'], ['bulan', 'Bulan']];
const GRAIN_TITLE = { jam: 'per jam', hari: 'per hari', minggu: 'per minggu', bulan: 'per bulan' };
function drawSalesChart(box, s, { from, to, grain }) {
  const m = chartPref.measure === 'receipts' ? 'receipts' : 'sales';
  const series = s.series || [];
  const fmt = (v) => (m === 'sales' ? rupiah(v) : `${v} nota`);
  const seg = (attr, v, l, on) => `<button type="button" data-${attr}="${v}" aria-pressed="${on}" class="${on ? 'is-on' : ''}">${l}</button>`;
  const period = `${dayLong(from)}${from !== to ? ` sampai ${dayLong(to)}` : ''}`;
  const total = series.reduce((a, x) => a + (Number(x[m]) || 0), 0);
  const peak = series.reduce((a, x) => ((Number(x[m]) || 0) > (Number(a?.[m]) || 0) ? x : a), null);
  box.innerHTML = `
    <div class="kp-ch-head">
      <div><h2 id="kp-chart-t">Grafik penjualan</h2><p class="muted small">Periode ${esc(period)} · ${GRAIN_TITLE[grain] || ''}</p></div>
      <div class="kp-ch-ctl">
        <span class="hm-seg" role="group" aria-label="Satuan waktu">${GRAINS.map(([v, l]) => seg('grain', v, l, v === grain)).join('')}</span>
        <span class="hm-seg" role="group" aria-label="Isi grafik">${seg('measure', 'sales', 'Omzet', m === 'sales')}${seg('measure', 'receipts', 'Jumlah nota', m === 'receipts')}</span>
      </div>
    </div>
    ${series.length ? `<div class="kp-plot" role="img" aria-label="${esc(`${m === 'sales' ? 'Omzet' : 'Jumlah nota'} ${GRAIN_TITLE[grain] || ''}, total ${fmt(total)}${peak && peak[m] ? `, tertinggi ${peak.label}: ${fmt(peak[m])}` : ''}`)}" data-plot></div>
    <div class="kp-tip" data-tip hidden></div>
    <table class="visually-hidden"><caption>Grafik penjualan ${esc(GRAIN_TITLE[grain] || '')}</caption><thead><tr><th scope="col">Waktu</th><th scope="col">Omzet</th><th scope="col">Jumlah nota</th></tr></thead>
      <tbody>${series.map((x) => `<tr><th scope="row">${esc(x.label)}</th><td>${rupiah(x.sales || 0)}</td><td>${x.receipts || 0}</td></tr>`).join('')}</tbody></table>`
      : '<p class="muted">Belum ada penjualan di periode ini.</p>'}`;
  box.querySelectorAll('[data-grain]').forEach((b) => b.addEventListener('click', async () => {
    chartPref.grain = b.dataset.grain; chartPref.range = `${from}|${to}`;
    box.setAttribute('aria-busy', 'true');
    try { const d = await rpc('owner_pos_stats', { p_from: from, p_to: to, p_grain: b.dataset.grain }); drawSalesChart(box, d, { from, to, grain: d.grain || b.dataset.grain }); }
    catch (e) { toast(e.message); }
    finally { box.removeAttribute('aria-busy'); }
    box.querySelector(`[data-grain="${chartPref.grain}"]`)?.focus();
  }));
  box.querySelectorAll('[data-measure]').forEach((b) => b.addEventListener('click', () => {
    chartPref.measure = b.dataset.measure; drawSalesChart(box, s, { from, to, grain });
    box.querySelector(`[data-measure="${chartPref.measure}"]`)?.focus();
  }));
  const plot = box.querySelector('[data-plot]');
  if (!plot) return;
  const render = () => {
    const W = Math.max(280, plot.clientWidth), H = W < 520 ? 200 : 260;
    const padL = 52, padR = 12, padT = 12, padB = 28, iw = W - padL - padR, ih = H - padT - padB;
    const vals = series.map((x) => Number(x[m]) || 0);
    const tk = niceTicks(Math.max(0, ...vals), m === 'receipts'), top = tk[tk.length - 1] || 1;
    const X = (i) => padL + (series.length === 1 ? iw / 2 : (i * iw) / (series.length - 1));
    const Y = (v) => padT + ih - (v / top) * ih;
    const pts = vals.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
    const every = Math.max(1, Math.ceil(series.length / Math.floor(iw / 56)));
    const last = series.length - 1;
    // Every nth label, and the last one only when it does not crowd the one before it.
    const showX = (i) => i % every === 0 || (i === last && last % every >= every / 2);
    const ylab = (v) => (m === 'sales' ? shortRp(v) : String(v));
    plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">
      ${tk.map((v) => `<line class="kp-grid" x1="${padL}" x2="${W - padR}" y1="${Y(v)}" y2="${Y(v)}"></line><text class="kp-ax" x="${padL - 8}" y="${Y(v) + 4}" text-anchor="end">${ylab(v)}</text>`).join('')}
      ${series.map((x, i) => showX(i) ? `<text class="kp-ax" x="${X(i)}" y="${H - 8}" text-anchor="${series.length > 1 && i === 0 ? 'start' : i === series.length - 1 && series.length > 1 ? 'end' : 'middle'}">${esc(x.label)}</text>` : '').join('')}
      ${series.length > 1 ? `<polygon class="kp-area" points="${X(0)},${Y(0)} ${pts.join(' ')} ${X(series.length - 1)},${Y(0)}"></polygon>
      <polyline class="kp-line" points="${pts.join(' ')}"></polyline>` : `<circle class="kp-dot" cx="${X(0)}" cy="${Y(vals[0])}" r="5"></circle>`}
      <line class="kp-cross" data-cross x1="0" x2="0" y1="${padT}" y2="${padT + ih}" visibility="hidden"></line>
      <circle class="kp-dot" data-hdot r="5" cx="0" cy="0" visibility="hidden"></circle>
    </svg>`;
    const svg = plot.querySelector('svg'), cross = plot.querySelector('[data-cross]'), hdot = plot.querySelector('[data-hdot]'), tip = box.querySelector('[data-tip]');
    const hide = () => { cross.setAttribute('visibility', 'hidden'); hdot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
      const i = series.length === 1 ? 0 : Math.max(0, Math.min(series.length - 1, Math.round(((x - padL) / iw) * (series.length - 1))));
      const cx = X(i), cy = Y(vals[i]);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      hdot.setAttribute('cx', cx); hdot.setAttribute('cy', cy); hdot.setAttribute('visibility', 'visible');
      const it = series[i];
      tip.innerHTML = `<b>${esc(it.label)}</b><span class="num">${rupiah(it.sales || 0)}</span><span class="num">${it.receipts || 0} nota</span>`;
      tip.hidden = false;
      const pr = plot.getBoundingClientRect(), br = box.getBoundingClientRect();
      const left = Math.min(pr.left - br.left + cx + 12, br.width - tip.offsetWidth - 8);
      tip.style.left = `${cx > iw * 0.7 + padL ? pr.left - br.left + cx - tip.offsetWidth - 12 : left}px`;
      tip.style.top = `${pr.top - br.top + Math.max(0, cy - tip.offsetHeight - 8)}px`;
    });
    svg.addEventListener('pointerleave', hide);
  };
  render();
  if (plot._ro) plot._ro.disconnect();
  let w0 = plot.clientWidth;
  plot._ro = new ResizeObserver(() => { if (Math.abs(plot.clientWidth - w0) > 4) { w0 = plot.clientWidth; render(); } });
  plot._ro.observe(plot);
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
  p.innerHTML = `<div class="panel stack"><div class="stack-sm"><h1>Penjualan member</h1><p class="muted small">300 penjualan terakhir</p></div>
  ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Struk</th><th>Member</th><th>Kasir</th><th class="num">Total</th><th class="num">Stempel</th><th>Produk</th><th>Catatan</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="${r.reversed_at ? 'is-reversed' : ''}"><td class="tnum">${esc(when(r.created_at))}</td><td>${esc(r.receipt_no || '–')}</td><td>${esc(r.member || '–')}</td><td>${esc(r.staff || '')}</td>
    <td class="num">${rupiah(r.total)}</td><td class="num">${r.stamps}</td><td>${esc((r.items || []).map((i) => i.qty + '× ' + i.name).join(', '))}</td>
    <td>${r.reversed_at ? 'Dibatalkan' : r.flags.map((x) => esc(FLAG[x] || x)).join(', ')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Belum ada penjualan.</p>'}</div>`;
}

// SheetJS (jsDelivr, allowed by the CSP), for Cadangan data.
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembaca file Excel gagal dimuat. Periksa internet, atau simpan file sebagai CSV.'));
    document.head.append(s);
  });
}






/* ---------------- staff access */
async function staff() {
  const p = $('#p-staff');
  loading(p);
  let people, tablets;
  try { [people, tablets] = await Promise.all([rpc('owner_people'), rpc('owner_kasir_accounts')]); } catch (e) { return failed(p, e, staff); }
  const tablet = tablets[0];
  p.innerHTML = `
  <div class="panel stack">
    <div class="row-between"><h1>Staf</h1><span class="muted small">${people.length} akun aktif</span></div>
    <p class="muted small">Akun pribadi staf: untuk presensi di ${esc(location.host)}/staf dari HP masing-masing, dipilih sebagai yang melayani di kasir, dan sekaligus kartu member staf itu.</p>
    <ul class="list">${people.map((x) => `<li>
      <span class="grow"><strong>${esc(x.full_name || 'Tanpa nama')}</strong>${x.is_me ? ' <span class="muted small">(Anda)</span>' : ''}<br><span class="muted small num">${x.username ? esc(x.username) + ', ' : ''}${esc(prettyPhone(x.whatsapp))}${x.employer ? ', ' + esc(x.employer) : ''}</span></span>
      ${x.start_password && x.role !== 'owner' ? '<span class="tag tag-warn">Belum ganti password awal</span>' : ''}
      <span class="tag">${x.role === 'owner' ? 'Pemilik' : x.role === 'manager' ? 'Manajer' : 'Staf'}</span>
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
  <section class="panel stack" id="kt" aria-labelledby="kt-title">
    <h2 id="kt-title">Akun kasir tablet</h2>
    <p class="muted small">Akun khusus tablet kasir di booth. Dipakai untuk mencatat penjualan, mendaftarkan member, dan menampilkan QR presensi. Akun ini tidak bisa presensi, tidak masuk daftar staf, dan tidak bisa menyetujui apa pun. Setiap pesanan tetap mencatat staf yang melayani.</p>
    ${tablet ? `<ul class="list"><li>
      <span class="grow"><strong>${esc(tablet.full_name || 'Kasir tablet')}</strong><br><span class="muted small num">@${esc(tablet.username)}</span></span>
      <span class="tag">Kasir tablet</span>
      <span class="row"><button class="btn btn-text" type="button" id="kt-reset">Ganti password</button><button class="btn btn-text" type="button" id="kt-remove">Hapus</button></span></li></ul>
    <div class="panel-sunk stack-sm" id="kt-del" hidden>
      <p>Hapus akun kasir tablet @${esc(tablet.username)}? Tablet yang masih masuk dengan akun ini tidak bisa dipakai lagi sampai masuk dengan akun baru. Penjualan yang sudah tercatat tetap tersimpan.</p>
      <div class="row"><button class="btn btn-danger" type="button" id="kt-del-yes">Ya, hapus akun</button><button class="btn btn-quiet" type="button" id="kt-del-no">Batal</button></div>
      <div class="notice" id="kt-del-msg" hidden></div>
    </div>
    <form class="panel-sunk stack-sm" id="kt-pw" hidden novalidate>
      <div class="form-grid">
        <label class="field"><span>Password baru, minimal 8 karakter</span><input type="text" id="kt-pw-new" autocomplete="off" spellcheck="false"></label>
        <button class="btn" type="submit">Simpan password</button>
        <button class="btn btn-quiet" type="button" id="kt-pw-no">Batal</button>
      </div>
      <p class="muted small">Setelah diganti, masuk lagi di tablet dengan password baru.</p>
      <div class="notice" id="kt-pw-msg" hidden></div>
    </form>`
    : `<form class="stack-sm" id="kt-add" novalidate aria-label="Tambah akun kasir tablet">
      <div class="form-grid">
        <label class="field"><span>Username</span><input type="text" id="kt-username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="kasir.booth" required></label>
        <label class="field"><span>Password, minimal 8 karakter</span><input type="text" id="kt-pin" autocomplete="off" spellcheck="false" required></label>
      </div>
      <p class="muted small">Tanpa nomor WhatsApp. Masukkan username dan password ini sekali di tablet kasir, lalu tablet tetap masuk.</p>
      <div class="notice" id="kt-msg" hidden></div>
      <button class="btn" type="submit" style="justify-self:start">Tambah akun kasir tablet</button>
    </form>`}
  </section>
  <form class="panel stack" id="add" novalidate aria-labelledby="add-title">
    <h2 id="add-title">Tambah staf</h2>
    <div class="form-grid">
      <label class="field"><span>Nama lengkap</span><input type="text" id="add-name" autocomplete="off" required></label>
      <label class="field"><span>Username <span class="hint">nama depan + nama belakang</span></span><input type="text" id="add-username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="20" placeholder="KevinHadiyan" required></label>
      <label class="field"><span>Nomor WhatsApp</span><input type="tel" id="add-phone" inputmode="tel" placeholder="0812 3456 7890" required></label>
      <label class="field"><span>Bekerja untuk</span><select id="add-employer"><option>Hanashuya</option><option>Kaaramel Juice</option></select></label>
      <label class="field"><span>Peran</span><select id="add-role"><option value="staff">Staf</option><option value="manager">Manajer</option><option value="owner">Pemilik</option></select></label>
      <label class="field" id="add-pin-f" hidden><span>Password pemilik, minimal 8 karakter</span><input type="text" id="add-pin" autocomplete="off" spellcheck="false"></label>
    </div>
    <p class="muted small" id="add-note">Password awal staf dan manajer: 123456. Saat pertama masuk di ${esc(location.host)}/staf, mereka wajib membuat password sendiri. Akun ini juga jadi kartu member mereka; kalau nomornya sudah punya kartu member, kartu itu dipakai dan stempelnya tetap.</p>
    <div class="notice" id="add-msg" hidden></div>
    <button class="btn" type="submit" style="justify-self:start">Tambah staf</button>
  </form>`;

  // Username FrontLastname from the full name (Glenn, 13 Nov 2026), filled in until the owner types one.
  const autoUser = (name) => { const w = name.replace(/[^A-Za-z ]/g, '').trim().split(/\s+/).filter(Boolean);
    return w.length > 1 ? (w[0] + w[w.length - 1]).slice(0, 20) : (w[0] || ''); };
  let userTyped = false;
  $('#add-username').addEventListener('input', () => { userTyped = !!$('#add-username').value; });
  $('#add-name').addEventListener('input', () => { if (!userTyped) $('#add-username').value = autoUser($('#add-name').value); });
  $('#add-role').addEventListener('change', () => { $('#add-pin-f').hidden = $('#add-role').value !== 'owner'; });
  $('#add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), msg = $('#add-msg'), role = $('#add-role').value;
    const pin = $('#add-pin').value, username = $('#add-username').value.trim();
    if (!$('#add-name').value.trim()) { notice(msg, 'Isi nama lengkap staf.'); $('#add-name').focus(); return; }
    if (!/^[A-Za-z0-9._]{3,20}$/.test(username)) { notice(msg, 'Username 3 sampai 20 karakter: huruf, angka, titik, atau garis bawah.'); $('#add-username').focus(); return; }
    if (role === 'owner' && pin.length < 8) { notice(msg, 'Password minimal 8 karakter.'); $('#add-pin').focus(); return; }
    busy(btn, true, 'Menyimpan…');
    try {
      const r = await rpc('owner_add_staff', { p_name: $('#add-name').value, p_username: username, p_phone: $('#add-phone').value,
        p_password: role === 'owner' ? pin : null, p_role: role, p_employer: $('#add-employer').value });
      toast(r.start_password ? `Dibuat. Username ${username}, password awal 123456` : `${$('#add-name').value.trim()} bisa masuk dengan akunnya`);
      staff();
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });

  // Kasir tablet account (13 Nov 2026): one at a time, username and password only.
  $('#kt-add')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), msg = $('#kt-msg');
    const username = $('#kt-username').value.trim().toLowerCase(), pin = $('#kt-pin').value;
    if (!/^[a-z0-9._]{3,20}$/.test(username)) { notice(msg, 'Username 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.'); $('#kt-username').focus(); return; }
    if (pin.length < 8) { notice(msg, 'Password minimal 8 karakter.'); $('#kt-pin').focus(); return; }
    busy(btn, true, 'Menyimpan…');
    try { await rpc('owner_add_kasir', { p_username: username, p_password: pin }); toast('Akun kasir tablet dibuat'); staff(); }
    catch (err) { notice(msg, err.message); busy(btn, false); }
  });
  $('#kt-reset')?.addEventListener('click', () => { $('#kt-del').hidden = true; $('#kt-pw').hidden = false; $('#kt-pw-new').value = ''; notice($('#kt-pw-msg'), ''); $('#kt-pw-new').focus(); });
  $('#kt-pw-no')?.addEventListener('click', () => { $('#kt-pw').hidden = true; });
  $('#kt-pw')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), pin = $('#kt-pw-new').value;
    if (pin.length < 8) { notice($('#kt-pw-msg'), 'Password minimal 8 karakter.'); return; }
    busy(btn, true, 'Menyimpan…');
    try { await rpc('owner_kasir_password', { p_id: tablet.id, p_password: pin }); $('#kt-pw').hidden = true; toast('Password baru tersimpan'); }
    catch (err) { notice($('#kt-pw-msg'), err.message); }
    busy(btn, false);
  });
  $('#kt-remove')?.addEventListener('click', () => { $('#kt-pw').hidden = true; $('#kt-del').hidden = false; notice($('#kt-del-msg'), ''); $('#kt-del-no').focus(); });
  $('#kt-del-no')?.addEventListener('click', () => { $('#kt-del').hidden = true; });
  $('#kt-del-yes')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; // currentTarget is null after the first await
    busy(btn, true, 'Menghapus…');
    try { await rpc('owner_remove_kasir', { p_id: tablet.id }); toast('Akun kasir tablet dihapus'); staff(); }
    catch (err) { notice($('#kt-del-msg'), err.message); busy(btn, false); }
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
    const btn = e.currentTarget; // currentTarget is null after the first await
    busy(btn, true, 'Menghapus…');
    try { await rpc('owner_remove_staff', { p_phone: removeFor }); toast('Akses dihapus'); staff(); }
    catch (err) { notice($('#remove-msg'), err.message); busy(btn, false); }
  });
}

/* ---------------- account help: reset codes sent by hand on WhatsApp */
/* Paper voucher codes (voucher_codes): per print run, how many are printed, saved to a
   card and used. "Dipakai" should match the VireoPOS count of the batch's code (MANIS). A
   code someone else claimed first can be moved to the right member, or freed. */
async function codePanel(p) {
  p.insertAdjacentHTML('beforeend', `
  <section class="panel stack" aria-labelledby="codes-title">
    <h1 id="codes-title">Voucher kertas</h1>
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
    const form = e.currentTarget, btn = $('button[type="submit"]', form), msg = $('#mv-msg');
    busy(btn, true, 'Memindahkan…');
    try {
      const r = await rpc('owner_move_code', { p_code: $('#mv-code').value, p_login: $('#mv-to').value.trim() || null });
      notice(msg, r.member ? `Voucher ${r.code} sekarang di kartu ${r.member}.` : `Kode ${r.code} dilepas. Bisa disimpan lagi oleh siapa saja.`, 'ok');
      form.reset();
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
  $('#find').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#found'), q = $('#find-q').value.trim();
    if (q.length < 3) { box.innerHTML = '<p class="muted">Tulis minimal 3 huruf atau angka.</p>'; return; }
    box.innerHTML = '<div class="skeleton"></div>';
    let rows;
    try { rows = await rpc('owner_find_account', { p_query: q }); } catch (err) { box.innerHTML = `<div class="notice notice-error">${esc(err.message)}</div>`; return; }
    box.innerHTML = rows.length ? `<ul class="list">${rows.map((r) => `<li>
      <span class="grow"><strong>${esc(r.full_name || 'Tanpa nama')}</strong> <span class="tag">${r.role === 'member' ? 'Member' : r.role === 'owner' ? 'Pemilik' : r.role === 'manager' ? 'Manajer' : 'Kasir'}</span><br>
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

/* ---------------- settings, one view each (Glenn, 12 Nov: one feature per view).
   Promo member, Aturan kartu, Produk kasir lama and Cadangan data read owner_settings. */
async function withSettings(p, again) {
  loading(p);
  try { return await rpc('owner_settings'); } catch (e) { failed(p, e, again); return null; }
}
const ymdJakarta = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(ms));

function joinQr() {
  $('#p-join').innerHTML = `
  <section class="panel stack" aria-labelledby="join-title">
    <h1 id="join-title">QR pendaftaran member</h1>
    <div class="join-row">
      <div class="join-qr" role="img" aria-label="QR pendaftaran member">${qrSvg(signupUrl())}</div>
      <div class="stack-sm">
        <p>Pembeli scan QR ini dengan HP-nya dan langsung masuk ke formulir daftar, tanpa membuka situs dulu. Alamatnya <span class="num">${esc(signupUrl().replace(/^https?:\/\//, ''))}</span>.</p>
        <p class="muted small">Cetak posternya untuk meja kasir. Kasir juga bisa menampilkan QR ini di tablet lewat tombol "Belum member? Tunjukkan QR daftar".</p>
        <div class="row"><a class="btn" href="qr-daftar">Buka poster untuk dicetak</a></div>
      </div>
    </div>
  </section>`;
}


async function backupView() {
  const p = $('#p-set');
  const s = await withSettings(p, backupView);
  if (!s) return;
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="backup-title">
    <h1 id="backup-title">Cadangan data</h1>
    <p>${s.last_backup ? `Terakhir diunduh ${esc(when(s.last_backup))}.` : 'Belum pernah diunduh.'}</p>
    <p class="muted small">Supabase versi gratis tidak menyimpan cadangan otomatis. Unduh seminggu sekali dan simpan di Google Drive atau iCloud pribadi. File ini berisi data pribadi member, jadi jangan dibagikan.</p>
    <div class="notice" id="backup-msg" hidden></div>
    <button class="btn" type="button" id="backup" style="justify-self:start">Unduh cadangan</button>
  </section>`;
  $('#backup').addEventListener('click', downloadBackup);
}

// Nota antrian (Glenn, 14 Nov 2026): on or off for the booth. Each till tablet can also turn it
// off for itself on its Printer screen; it prints only when both are on (nota-antrian.sql).
async function queueSlipView() {
  const p = $('#p-queue');
  p.innerHTML = '<div class="panel" aria-busy="true"><div class="skeleton"></div></div>';
  let on;
  try { on = await rpc('pos_queue_slip'); } catch (e) { p.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; return; }
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="queue-title">
    <h1 id="queue-title">Nota antrian</h1>
    <p>Setelah pembayaran, kasir mencetak nota kecil berisi nama pembeli ("Pesanan atas nama Kak …"), nomor invoice dan isi pesanan, supaya staf bisa memanggil pembeli saat pesanannya siap.</p>
    <label class="check"><input type="checkbox" id="queue-on"${on ? ' checked' : ''}><span>Cetak nota antrian di kasir</span></label>
    <p class="muted small">Tiap tablet kasir juga bisa mematikannya sendiri di Printer. Nama pembeli hanya tersimpan di pesanan, tidak menjadi data member.</p>
    <div class="notice" id="queue-msg" hidden></div>
  </section>`;
  $('#queue-on').addEventListener('change', async (e) => {
    const box = e.target; box.disabled = true;
    try {
      const v = await rpc('owner_set_queue_slip', { p_on: box.checked });
      box.checked = !!v;
      notice($('#queue-msg'), v ? 'Nota antrian aktif di kasir.' : 'Nota antrian dimatikan.', 'ok');
    } catch (err) { box.checked = !box.checked; notice($('#queue-msg'), err.message); }
    finally { box.disabled = false; }
  });
}

// Service charge and PBJT (Glenn, 14 Nov 2026). Both off until switched on here; pos.sql (_pos_charges) does the maths.
async function chargesView() {
  const p = $('#p-tax');
  p.innerHTML = '<div class="panel" aria-busy="true"><div class="skeleton"></div></div>';
  let c;
  try { c = await rpc('owner_charges'); } catch (e) { p.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; return; }
  const pct = (v) => String(Number(v)).replace('.', ',');
  p.innerHTML = `
  <form class="panel stack" id="tax-form" novalidate aria-labelledby="tax-title">
    <h1 id="tax-title">Pajak dan service</h1>
    <p>Berlaku untuk pesanan baru di kasir. Pesanan yang sudah ada tetap memakai angka saat dijual.</p>
    <fieldset class="stack-sm"><legend><b>Service charge</b></legend>
      <label class="check"><input type="checkbox" name="service_on"${c.service_on ? ' checked' : ''}><span>Tambahkan service charge di booth</span></label>
      <label class="field" style="max-width:12rem"><span>Persen</span><input name="service_pct" inputmode="decimal" value="${pct(c.service_pct)}"></label>
      <p class="muted small">Dihitung dari harga setelah diskon. Tidak berlaku untuk pesanan platform pesan-antar. Uang service dibukukan sebagai utang kepada karyawan (Utang uang service), bukan pendapatan.</p>
    </fieldset>
    <fieldset class="stack-sm"><legend><b>PBJT makanan dan minuman</b></legend>
      <label class="check"><input type="checkbox" name="pbjt_on"${c.pbjt_on ? ' checked' : ''}><span>Pungut PBJT</span></label>
      <label class="field" style="max-width:12rem"><span>Tarif (paling tinggi 10%)</span><input name="pbjt_pct" inputmode="decimal" value="${pct(c.pbjt_pct)}"></label>
      <label class="check"><input type="radio" name="pbjt_included" value="false"${c.pbjt_included ? '' : ' checked'}><span>Ditambahkan di atas harga (harga Rp20.000 jadi Rp22.000)</span></label>
      <label class="check"><input type="radio" name="pbjt_included" value="true"${c.pbjt_included ? ' checked' : ''}><span>Sudah termasuk dalam harga (harga tetap, struk menulis "termasuk PBJT")</span></label>
      <p class="muted small">PBJT adalah pajak daerah (UU 1/2022 tentang HKPD, Perda Kota Bandung), dihitung dari harga setelah diskon ditambah service charge. Makanan dan minuman dari restoran tidak dikenai PPN. Aktifkan hanya setelah usaha terdaftar sebagai wajib pajak PBJT di Bapenda Kota Bandung. PBJT yang dipungut masuk ke akun Utang PBJT dan disetor ke Bapenda.</p>
    </fieldset>
    <div class="notice" id="tax-msg" hidden></div>
    <button class="btn" type="submit" style="justify-self:start">Simpan</button>
  </form>`;
  $('#tax-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget, btn = $('button[type="submit"]', f);
    const num = (n) => f.elements[n].value.trim().replace(',', '.');
    busy(btn, true, 'Menyimpan…');
    try {
      const r = await rpc('owner_set_charges', { p: { service_on: f.elements.service_on.checked, service_pct: num('service_pct'),
        pbjt_on: f.elements.pbjt_on.checked, pbjt_pct: num('pbjt_pct'), pbjt_included: f.elements.pbjt_included.value === 'true' } });
      f.elements.service_pct.value = pct(r.service_pct); f.elements.pbjt_pct.value = pct(r.pbjt_pct);
      notice($('#tax-msg'), 'Tersimpan. Kasir memakai angka baru setelah katalognya dimuat ulang.', 'ok');
    } catch (err) { notice($('#tax-msg'), err.message); }
    busy(btn, false);
  });
}

async function cardRules() {
  const p = $('#p-rules');
  const s = await withSettings(p, cardRules);
  if (!s) return;
  p.innerHTML = `
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
    <button class="btn" type="submit" style="justify-self:start">Simpan aturan</button>
  </form>`;
  $('#rules').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('owner_save_settings', { p_open: $('#open').value, p_close: $('#close').value, p_rupiah: +$('#rupiah').value, p_max: +$('#max').value, p_late: +$('#late').value });
      toast('Aturan tersimpan'); busy(btn, false); notice($('#rules-msg'), '');
    } catch (err) { notice($('#rules-msg'), err.message); busy(btn, false); }
  });
}


// Promo untuk member: news shown on the member card (POS discounts live in Promo POS).
async function campaigns() {
  const p = $('#p-camp');
  const s = await withSettings(p, campaigns);
  if (!s) return;
  p.innerHTML = `
  <section class="panel stack" aria-labelledby="camp-title">
    <h1 id="camp-title">Promo member</h1>
    <p class="muted small">Kabar promo yang tampil di kartu member. Potongan harga di kasir diatur di Promo, Promo POS.</p>
    ${s.campaigns.length ? `<ul class="list">${s.campaigns.map((c) => `<li><span class="grow"><strong>${esc(c.title)}</strong><br>
      <span class="muted small">${esc(day(c.starts_on))} sampai ${esc(day(c.ends_on))}</span></span>
      <span class="tag ${c.active ? 'tag-ok' : ''}">${c.active ? 'Aktif' : 'Nonaktif'}</span>
      <button class="btn btn-text" type="button" data-camp='${esc(JSON.stringify(c))}'>Ubah</button></li>`).join('')}</ul>` : '<p class="muted">Belum ada promo.</p>'}
    <form class="stack" id="camp" novalidate aria-labelledby="camp-form-t">
      <h2 id="camp-form-t">Promo baru</h2>
      <input type="hidden" id="camp-id">
      <label class="field"><span>Judul</span><input type="text" id="camp-title-in" maxlength="80" placeholder="Contoh: Mini choux isi 8 lebih hemat tiap Selasa"></label>
      <label class="field"><span>Isi</span><textarea id="camp-body" maxlength="300"></textarea></label>
      <div class="form-grid">
        <label class="field"><span>Mulai</span><input type="date" id="camp-start"></label>
        <label class="field"><span>Selesai</span><input type="date" id="camp-end"></label>
        <label class="check"><input type="checkbox" id="camp-active" checked><span>Tampilkan ke member</span></label>
      </div>
      <div class="notice" id="camp-msg" hidden></div>
      <div class="row"><button class="btn" type="submit" id="camp-save">Simpan promo</button>
        <button class="btn btn-quiet" type="button" id="camp-cancel" hidden>Batal ubah</button></div>
    </form>
  </section>`;
  // Ubah fills the form; Batal ubah (Glenn, 12 Nov 2026) empties it back to a new promo.
  const fresh = () => {
    $('#camp-id').value = ''; $('#camp-title-in').value = ''; $('#camp-body').value = ''; $('#camp-active').checked = true;
    $('#camp-start').value = ymdJakarta(Date.now()); $('#camp-end').value = ymdJakarta(Date.now() + 14 * 864e5);
    $('#camp-form-t').textContent = 'Promo baru'; $('#camp-save').textContent = 'Simpan promo'; $('#camp-cancel').hidden = true;
    notice($('#camp-msg'), '');
  };
  fresh();
  $('#camp-cancel').addEventListener('click', () => { fresh(); $('#camp-title-in').focus(); });
  $$('[data-camp]', p).forEach((b) => b.addEventListener('click', () => {
    const c = JSON.parse(b.dataset.camp);
    $('#camp-id').value = c.id; $('#camp-title-in').value = c.title; $('#camp-body').value = c.body;
    $('#camp-start').value = c.starts_on; $('#camp-end').value = c.ends_on; $('#camp-active').checked = c.active;
    $('#camp-form-t').textContent = 'Ubah promo: ' + c.title; $('#camp-save').textContent = 'Simpan perubahan'; $('#camp-cancel').hidden = false;
    $('#camp-title-in').focus();
  }));
  $('#camp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('owner_save_campaign', { p_id: $('#camp-id').value ? Number($('#camp-id').value) : null, p_title: $('#camp-title-in').value, p_body: $('#camp-body').value,
        p_starts: $('#camp-start').value, p_ends: $('#camp-end').value, p_active: $('#camp-active').checked });
      toast('Promo tersimpan'); campaigns();
    } catch (err) { notice($('#camp-msg'), err.message); busy(btn, false); }
  });
}

$('#logout').addEventListener('click', signOut);
start();
