// Owner menu group "Transaksi", stock side (12 Nov 2026, like VireoPOS): stock locations, Stok transfer,
// Transfer order > Surat jalan > Penerimaan transfer, Dalam perjalanan, Produksi, Bongkar produksi,
// Resep produksi and the Kartu stok. Lists are data tables (js/data-table.js); clicking a row opens it.
// The maths is in supabase/pos-produksi.sql.
//   mountProduksi(panel, { rpc, part })
//   part: 'lokasi', 'stok-transfer', 'transfer-order', 'surat-jalan', 'penerimaan', 'perjalanan',
//         'produksi', 'bongkar', 'resep', 'kartu'
import { $, $$, esc, when, day, toast } from './lib.js';
import { dataTable, formDialog, infoDialog, confirmDialog, loadSheetJS } from './data-table.js';
import { rangeHtml, wireRange } from './owner-range.js';

const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const qtyText = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 4 });
const withUnit = (n, u) => `${qtyText(n)} ${u || ''}`.trim();
const signed = (n) => (Number(n) ? `${Number(n) > 0 ? '+' : ''}${qtyText(n)}` : '0');
const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorHtml = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;
const REQ = '<span class="hint is-req">wajib</span>';
function parseNum(raw) {
  let s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s.replace(',', '.'));
}
const need = (n, msg) => { if (n == null || !Number.isFinite(n)) throw new Error(msg); return n; };
const sel = (name, opts, pick, label, extra = '') => `<label class="field"><span>${label}</span><select data-f="${name}" ${extra}>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(pick) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const inp = (name, label, extra = '', value = '') => `<label class="field"><span>${label}</span><input type="text" data-f="${name}" autocomplete="off" value="${esc(value)}" ${extra}></label>`;
const dateInp = (name, label, value = ymd(), extra = '') => `<label class="field"><span>${label}</span><input type="date" data-f="${name}" value="${esc(value)}" ${extra}></label>`;
const F = (form, k) => form.querySelector(`[data-f="${k}"]`);

const TR_TAG = { selesai: ['Selesai', 'tag-ok'], dibuka: ['Dibuka', 'tag-warn'], sebagian: ['Dikirim sebagian', 'tag-warn'], terkirim: ['Terkirim', ''], batal: ['Batal', 'tag-bad'] };
const SJ_TAG = { dalam_perjalanan: ['Dalam perjalanan', 'tag-warn'], diterima: ['Diterima', 'tag-ok'], batal: ['Batal', 'tag-bad'] };
const tagOf = (map, k) => (map[k] ? tag(map[k][0], map[k][1]) : esc(k || '–'));
const tagText = (map, k) => (map[k] || [k])[0];
const COLS = [['pembelian', 'Pembelian'], ['masuk', 'Masuk'], ['keluar', 'Keluar'], ['pindah', 'Pindah'], ['penyesuaian', 'Penyesuaian'],
  ['penjualan', 'Penjualan'], ['produksi', 'Produksi'], ['bongkar', 'Bongkar']];
const COL_LABEL = Object.fromEntries(COLS);

// One screen: heading, optional date range (30 days at first) and filters, then the table.
async function screen(panel, { title, intro, noRange, controls = '', load, options }) {
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>${esc(title)}</h1>${intro ? `<p class="muted small">${esc(intro)}</p>` : ''}</div>
    ${noRange ? '' : rangeHtml({ preset: '30' })}
    <div class="dt-range"${!controls ? ' hidden' : ''}>${controls}</div>
    <div data-t>${loadingHtml}</div></div>`;
  const host = $('[data-t]', panel);
  const ctx = () => ({ from: $('[data-from]', panel)?.value, to: $('[data-to]', panel)?.value,
    c: Object.fromEntries($$('[data-c]', panel).map((e) => [e.dataset.c, e.type === 'checkbox' ? e.checked : e.value])) });
  const fetchRows = () => load(ctx());
  let rows;
  try { rows = await fetchRows(); } catch (e) { host.innerHTML = errorHtml(e).replace('class="panel"', ''); return null; }
  host.innerHTML = '';
  const t = dataTable(host, { ...options, rows, reload: fetchRows });
  $$('[data-from], [data-to], [data-c]', panel).forEach((e) => e.addEventListener('change', () => {
    const { from, to } = ctx();
    if (from && to && from > to) return;
    t.refresh();
  }));
  wireRange(panel);
  return { t, ctx };
}

export async function mountProduksi(panel, { rpc, part }) {
  const run = PARTS[part];
  if (!run) { panel.innerHTML = errorHtml(new Error('Halaman ini belum ada.')); return; }
  panel.innerHTML = loadingHtml;
  let cat, locs;
  try { [cat, locs] = await Promise.all([rpc('stock_catalog'), rpc('stock_location_list')]); } catch (e) { panel.innerHTML = errorHtml(e); return; }
  await run(panel, rpc, { cat, locs });
}

const activeLocs = (locs) => locs.filter((l) => l.active);
const locOpts = (locs) => activeLocs(locs).map((l) => [l.id, l.name]);
const itemOpts = (cat) => (cat.items || []).map((i) => [i.id, `${i.name} (${i.unit})`]);

// Item lines with the stock at the source next to each line ("Sisa stok", like VireoPOS).
function lineEditor(cat) {
  let stock = {};
  const lineHtml = (l = {}) => `<div class="dt-line" data-line>
    ${sel('l-item', itemOpts(cat), l.item_id, 'Barang')}
    <label class="field"><span>Jumlah</span><input type="text" inputmode="decimal" data-f="l-qty" autocomplete="off" value="${esc(l.qty ?? '')}"></label>
    <p class="muted small" data-left aria-live="polite"></p>
    <button class="btn btn-text" type="button" data-rm>Hapus baris</button></div>`;
  const paint = (form) => $$('[data-line]', form).forEach((r) => {
    const id = r.querySelector('[data-f="l-item"]').value, i = (cat.items || []).find((x) => String(x.id) === id);
    r.querySelector('[data-left]').textContent = id in stock ? `Sisa stok ${withUnit(stock[id], i?.unit)}` : '';
  });
  return {
    html: (lines) => `<div class="dt-lines" data-lines>${(lines?.length ? lines : [{}]).map(lineHtml).join('')}</div>
      <div class="row"><button class="btn btn-quiet" type="button" data-addline>+ Tambah barang</button></div>`,
    wire: (form) => {
      form.addEventListener('click', (e) => {
        if (e.target.closest('[data-addline]')) { form.querySelector('[data-lines]').insertAdjacentHTML('beforeend', lineHtml()); paint(form); }
        const rm = e.target.closest('[data-rm]');
        if (rm && $$('[data-line]', form).length > 1) rm.closest('[data-line]').remove();
      });
      form.addEventListener('change', (e) => { if (e.target.matches('[data-f="l-item"]')) paint(form); });
    },
    setStock: (form, s) => { stock = s; paint(form); },
    read: (form) => $$('[data-line]', form).map((r) => ({
      item: Number(r.querySelector('[data-f="l-item"]').value), qty: need(parseNum(r.querySelector('[data-f="l-qty"]').value), 'Isi jumlah di setiap baris barang.'),
    })),
  };
}
const stockMap = async (rpc, loc) => Object.fromEntries((await rpc('stock_location_stock', { p_location: Number(loc) })).items.map((i) => [String(i.id), i.qty]));

const linesTable = (head, rows) => `<div class="table-wrap"><table><thead><tr>${head.map(([l, n]) => `<th${n ? ' class="num"' : ''}>${esc(l)}</th>`).join('')}</tr></thead>
  <tbody>${rows.join('')}</tbody></table></div>`;
const td = (v, n) => `<td${n ? ' class="num"' : ''}>${v}</td>`;

/* ================================================================ Lokasi stok */
async function lokasiPart(panel, rpc, { cat, locs }) {
  const open = async (l) => {
    const s = await rpc('stock_location_stock', { p_location: l.id });
    const items = s.items.filter((i) => Number(i.qty));
    return formDialog({
      title: l ? l.name : 'Lokasi baru', wide: true, submitLabel: 'Simpan nama',
      html: `${l.is_booth ? '<p class="muted small">Booth adalah lokasi utama: penjualan, sampel, barang masuk dan stok opname di kasir memakai stok ini.</p>' : ''}
        <div class="dt-fields">${inp('name', `Nama ${REQ}`, 'maxlength="40"', l.name)}${inp('note', 'Catatan', 'maxlength="200"', l.note || '')}</div>
        <h3>Stok di ${esc(l.name)}</h3>
        ${items.length ? linesTable([['Barang'], ['Stok', 1]], items.map((i) => `<tr>${td(esc(i.name))}${td(esc(withUnit(i.qty, i.unit)), 1)}</tr>`)) : '<p class="muted">Belum ada stok di lokasi ini.</p>'}
        <h3>Penyesuaian stok</h3>
        <p class="muted small">Untuk stok awal atau koreksi hitungan. Alasannya tercatat di Kartu stok.</p>
        <div class="dt-fields">${sel('a-item', itemOpts(cat), '', 'Barang')}${sel('a-mode', [['set', 'Ubah jadi'], ['delta', 'Tambah / kurangi']], 'set', 'Cara')}
          ${inp('a-qty', 'Jumlah', 'inputmode="decimal"')}${inp('a-reason', 'Alasan', 'maxlength="200"')}</div>`,
      onSubmit: async (f) => { await rpc('stock_location_save', { p_id: l.id, p_name: F(f, 'name').value, p_note: F(f, 'note').value }); toast('Lokasi disimpan'); },
      buttons: [
        { label: 'Simpan penyesuaian', onClick: async (f) => {
          const r = await rpc('stock_location_adjust', { p_location: l.id, p_item: Number(F(f, 'a-item').value), p_mode: F(f, 'a-mode').value,
            p_qty: need(parseNum(F(f, 'a-qty').value), 'Isi jumlahnya.'), p_reason: F(f, 'a-reason').value });
          toast(`${r.item}: ${qtyText(r.before)} jadi ${qtyText(r.after)} ${r.unit}`);
        } },
        ...(l.is_booth ? [] : [{ label: l.active ? 'Matikan lokasi' : 'Aktifkan lagi', danger: l.active, onClick: async () => {
          if (l.active && !(await confirmDialog({ title: `Matikan ${l.name}?`, text: 'Lokasi yang dimatikan tidak bisa dipilih untuk transfer atau produksi. Riwayatnya tetap ada.', confirmLabel: 'Matikan', danger: true }))) return false;
          await rpc('stock_location_set_active', { p_id: l.id, p_active: !l.active }); toast(l.active ? 'Lokasi dimatikan' : 'Lokasi aktif lagi');
          return undefined;
        } }]),
      ],
    });
  };
  const add = () => formDialog({
    title: 'Tambah lokasi', submitLabel: 'Simpan lokasi',
    html: `${inp('name', `Nama ${REQ}`, 'maxlength="40" placeholder="Misalnya Gudang"')}${inp('note', 'Catatan', 'maxlength="200"')}`,
    onSubmit: async (f) => { await rpc('stock_location_save', { p_id: null, p_name: F(f, 'name').value, p_note: F(f, 'note').value }); toast('Lokasi ditambah'); },
  });
  await screen(panel, {
    title: 'Lokasi stok', noRange: true, intro: 'Tempat stok disimpan. Booth adalah stok kasir; lokasi lain (misalnya Dapur) punya stoknya sendiri dan diisi lewat transfer, produksi atau penyesuaian. Buka satu lokasi untuk melihat stoknya.',
    load: () => rpc('stock_location_list'),
    options: { rowKey: 'id', exportName: 'lokasi-stok', editLabel: 'Buka', searchKeys: ['name', 'note'],
      columns: [
        { key: 'name', label: 'Lokasi', sort: true, html: true, format: (v, r) => `${esc(v)}${r.is_booth ? ` ${tag('Utama')}` : ''}`, export: (r) => r.name },
        { key: 'items_in_stock', label: 'Barang berstok', sort: true, align: 'num' },
        { key: 'in_transit_out', label: 'Sedang dikirim', sort: true, align: 'num' },
        { key: 'in_transit_in', label: 'Akan datang', sort: true, align: 'num' },
        { key: 'active', label: 'Status', sort: true, html: true, format: (v) => (v ? tag('Aktif', 'tag-ok') : tag('Tidak dipakai')), export: (r) => (r.active ? 'Aktif' : 'Tidak dipakai') },
        { key: 'note', label: 'Catatan', format: (v) => v || '–' },
      ],
      onAdd: add, onEdit: open },
  });
}

/* ================================================================ Stok transfer and Transfer order */
const trColumns = (withStatus) => [
  { key: 'no', label: 'No. dokumen', sort: true },
  { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
  { key: 'from', label: 'Dari', sort: true },
  { key: 'to', label: 'Ke', sort: true },
  { key: 'lines_count', label: 'Barang', sort: true, align: 'num' },
  ...(withStatus ? [{ key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(TR_TAG, v), export: (r) => tagText(TR_TAG, r.status) }] : []),
  { key: 'by', label: 'Dibuat oleh', sort: true, format: (v) => v || '–' },
  { key: 'note', label: 'Catatan', format: (v) => v || '–' },
];

function transferInfo(t) {
  const order = t.kind === 'order';
  return `<p>${order ? tagOf(TR_TAG, t.status) + ' · ' : ''}${esc(t.from)} ke ${esc(t.to)} · ${esc(day(t.day))}${t.needed_by ? `, dibutuhkan ${esc(day(t.needed_by))}` : ''} · ${esc(t.by || '')}</p>
    ${t.note ? `<p>${esc(t.note)}</p>` : ''}${t.status === 'batal' ? `<p class="muted small">Dibatalkan ${esc(t.cancelled_by || '')}: ${esc(t.cancel_reason || '')}</p>` : ''}
    ${linesTable(order ? [['Barang'], ['Diminta', 1], ['Dikirim', 1], ['Diterima', 1], [`Stok ${t.from} sekarang`, 1]] : [['Barang'], ['Jumlah', 1], [`Stok ${t.from} saat itu`, 1]],
      t.lines.map((l) => `<tr>${td(esc(l.item))}${td(esc(withUnit(l.qty, l.unit)), 1)}${order ? td(esc(qtyText(l.shipped)), 1) + td(esc(qtyText(l.received)), 1) + td(esc(qtyText(l.source_now)), 1) : td(esc(qtyText(l.stock_at)), 1)}</tr>`))}
    ${order && t.shipments.length ? `<h3>Surat jalan</h3><ul class="dt-list">${t.shipments.map((s) => `<li>${esc(s.no)}, ${esc(day(s.day))}: ${esc(tagText(SJ_TAG, s.status))}</li>`).join('')}</ul>` : ''}`;
}

function transferForm(rpc, { cat, locs }, order) {
  const ed = lineEditor(cat);
  const first = activeLocs(locs);
  const dapur = first.find((l) => !l.is_booth) || first[0], booth = first.find((l) => l.is_booth) || first[1] || first[0];
  return formDialog({
    title: order ? 'Transfer order baru' : 'Stok transfer', wide: true, submitLabel: order ? 'Simpan transfer order' : 'Pindahkan stok',
    html: `<p class="muted small">${order ? 'Permintaan stok dari lokasi lain. Belum ada stok yang pindah; kirim lewat Surat jalan, lalu catat Penerimaan transfer.' : 'Stok langsung pindah: berkurang di lokasi asal dan bertambah di lokasi tujuan.'}</p>
      <div class="dt-fields">${sel('from', locOpts(locs), dapur?.id, `Lokasi asal ${REQ}`)}${sel('to', locOpts(locs), booth?.id, `Lokasi tujuan ${REQ}`)}
      ${order ? dateInp('needed', 'Dibutuhkan tanggal', '', `min="${ymd()}"`) : dateInp('day', `Tanggal ${REQ}`, ymd(), `max="${ymd()}"`)}</div>
      ${inp('note', 'Catatan', 'maxlength="200"')}${ed.html()}`,
    onOpen: async (f) => {
      ed.wire(f);
      const refresh = async () => { try { ed.setStock(f, await stockMap(rpc, F(f, 'from').value)); } catch { ed.setStock(f, {}); } };
      F(f, 'from').addEventListener('change', refresh); refresh();
    },
    onSubmit: async (f) => {
      const args = { p_from: Number(F(f, 'from').value), p_to: Number(F(f, 'to').value), p_lines: ed.read(f), p_note: F(f, 'note').value };
      const r = order ? await rpc('stock_transfer_order_create', { ...args, p_needed_by: F(f, 'needed').value || null })
        : await rpc('stock_transfer_create', { ...args, p_day: F(f, 'day').value || null });
      toast(order ? `${r.no} dibuat` : `${r.no}: stok dipindah`);
    },
  });
}

async function stokTransferPart(panel, rpc, ctx) {
  await screen(panel, {
    title: 'Stok transfer', intro: 'Pindah stok satu langkah antar lokasi, misalnya choux dari Dapur ke Booth. Untuk kiriman yang perlu surat jalan, pakai Transfer order.',
    load: ({ from, to }) => rpc('stock_transfer_list', { p_from: from, p_to: to, p_kind: 'langsung' }),
    options: { rowKey: 'id', exportName: 'stok-transfer', editLabel: 'Buka', emptyText: 'Belum ada stok transfer di rentang ini.', defaultSort: { key: 'no', dir: 'desc' },
      searchKeys: ['no', 'from', 'to', 'by', 'note'], columns: trColumns(false),
      onAdd: () => transferForm(rpc, ctx, false), onEdit: (t) => infoDialog({ title: t.no, wide: true, html: transferInfo(t) }) },
  });
}

async function transferOrderPart(panel, rpc, ctx) {
  const open = (t) => {
    const live = ['dibuka', 'sebagian'].includes(t.status);
    return infoDialog({
      title: t.no, wide: true, html: transferInfo(t),
      buttons: live ? [
        { label: 'Buat surat jalan', onClick: async () => ((await shipmentForm(rpc, ctx, t.id)) ? undefined : false) },
        { label: 'Batalkan transfer order', danger: true, onClick: async () => ((await formDialog({
          title: `Batalkan ${t.no}?`, submitLabel: 'Batalkan', cancelLabel: 'Kembali',
          html: `<p class="muted small">Sisa yang belum dikirim tidak akan dikirim. Surat jalan yang sudah dibuat tetap berlaku.</p>${inp('reason', `Alasan ${REQ}`, 'maxlength="200"')}`,
          onSubmit: async (f) => { await rpc('stock_transfer_order_cancel', { p_id: t.id, p_reason: F(f, 'reason').value }); toast('Transfer order dibatalkan'); },
        })) ? undefined : false) },
      ] : [],
    });
  };
  await screen(panel, {
    title: 'Transfer order', intro: 'Langkah 1 dari 3: permintaan stok dari lokasi lain. Lalu Surat jalan (barang dikirim) dan Penerimaan transfer (barang sampai).',
    controls: `<label class="field"><span>Status</span><select data-c="status"><option value="">Semua</option>${Object.entries(TR_TAG).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>`,
    load: async ({ from, to, c }) => (await rpc('stock_transfer_list', { p_from: from, p_to: to, p_kind: 'order' })).filter((t) => !c.status || t.status === c.status),
    options: { rowKey: 'id', exportName: 'transfer-order', editLabel: 'Buka', emptyText: 'Belum ada transfer order di rentang ini.', defaultSort: { key: 'no', dir: 'desc' },
      searchKeys: ['no', 'from', 'to', 'status', 'by', 'note'], columns: trColumns(true),
      onAdd: () => transferForm(rpc, ctx, true), onEdit: open },
  });
}

/* ================================================================ Surat jalan */
async function shipmentForm(rpc, { cat }, pick) {
  const open = await rpc('stock_transfer_open');
  if (!open.length) throw new Error('Belum ada transfer order yang menunggu dikirim. Buat dulu di Transfer order.');
  const linesFor = (t) => t.lines.map((l) => {
    const left = Math.max(0, Number(l.qty) - Number(l.shipped));
    return `<div class="dt-line dt-line-recv" data-line data-item="${l.item_id}">
      <p><strong>${esc(l.item)}</strong><br><span class="muted small">Diminta ${esc(withUnit(l.qty, l.unit))}, sudah dikirim ${esc(qtyText(l.shipped))}</span></p>
      <p class="muted small">Sisa dikirim<br><strong>${esc(qtyText(left))}</strong></p>
      <p class="muted small">Stok ${esc(t.from)}<br><strong>${esc(qtyText(l.source_now))}</strong></p>
      <label class="field"><span>Dikirim</span><input type="text" inputmode="decimal" data-f="s-qty" autocomplete="off" value="${left ? esc(qtyText(left).replace(/\./g, '')) : ''}"${left ? '' : ' disabled'}></label></div>`;
  }).join('');
  const first = open.find((t) => t.id === pick) || open[0];
  return formDialog({
    title: 'Surat jalan baru', wide: true, submitLabel: 'Kirim barang',
    html: `${sel('to', open.map((t) => [t.id, `${t.no}: ${t.from} ke ${t.to}`]), first.id, `Transfer order ${REQ}`)}
      <p class="muted small">Stok berkurang di lokasi asal saat surat jalan disimpan dan berstatus Dalam perjalanan sampai diterima. Kosongkan barang yang belum dikirim.</p>
      <div class="dt-lines" data-lines>${linesFor(first)}</div>${inp('note', 'Catatan (misalnya kurir)', 'maxlength="200"')}`,
    onOpen: (f) => F(f, 'to').addEventListener('change', (e) => { f.querySelector('[data-lines]').innerHTML = linesFor(open.find((t) => String(t.id) === e.target.value)); }),
    onSubmit: async (f) => {
      const lines = $$('[data-line]', f).map((r) => ({ item: Number(r.dataset.item), qty: parseNum(r.querySelector('[data-f="s-qty"]').value) }))
        .filter((l) => l.qty != null && l.qty !== 0).map((l) => ({ item: l.item, qty: need(l.qty, 'Jumlah harus angka.') }));
      if (!lines.length) throw new Error('Isi jumlah yang dikirim minimal untuk satu barang.');
      const r = await rpc('stock_shipment_create', { p_transfer: Number(F(f, 'to').value), p_lines: lines, p_note: F(f, 'note').value });
      toast(`${r.no}: dalam perjalanan`);
    },
  });
}

function shipmentInfo(s) {
  return `<p>${tagOf(SJ_TAG, s.status)} · ${esc(s.from)} ke ${esc(s.to)} · ${esc(day(s.day))} · transfer order ${esc(s.transfer_no)} · ${esc(s.by || '')}</p>
    ${s.note ? `<p>${esc(s.note)}</p>` : ''}${s.status === 'batal' ? `<p class="muted small">Dibatalkan ${esc(s.cancelled_by || '')}: ${esc(s.cancel_reason || '')}</p>` : ''}
    ${s.receipt_no ? `<p class="muted small">Diterima ${esc(day(s.received_day))} dengan ${esc(s.receipt_no)}</p>` : ''}
    ${linesTable([['Barang'], ['Dikirim', 1], ['Diterima', 1], ['Alasan selisih']], s.lines.map((l) => `<tr>${td(esc(l.item))}${td(esc(withUnit(l.qty, l.unit)), 1)}${td(l.received == null ? '–' : esc(qtyText(l.received)), 1)}${td(esc(l.reason || '–'))}</tr>`))}`;
}

const sjColumns = [
  { key: 'no', label: 'No. dokumen', sort: true },
  { key: 'transfer_no', label: 'Transfer order', sort: true },
  { key: 'from', label: 'Dari', sort: true },
  { key: 'to', label: 'Ke', sort: true },
  { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
  { key: 'lines_count', label: 'Barang', sort: true, align: 'num' },
  { key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(SJ_TAG, v), export: (r) => tagText(SJ_TAG, r.status) },
];

function shipmentDialog(rpc, ctx, s) {
  return infoDialog({
    title: s.no, wide: true, html: shipmentInfo(s),
    buttons: s.status === 'dalam_perjalanan' ? [
      { label: 'Terima barang', onClick: async () => ((await receiveForm(rpc, ctx, s.id)) ? undefined : false) },
      { label: 'Batalkan surat jalan', danger: true, onClick: async () => ((await formDialog({
        title: `Batalkan ${s.no}?`, submitLabel: 'Batalkan', cancelLabel: 'Kembali',
        html: `<p class="muted small">Barangnya dikembalikan ke stok ${esc(s.from)}.</p>${inp('reason', `Alasan ${REQ}`, 'maxlength="200"')}`,
        onSubmit: async (f) => { await rpc('stock_shipment_cancel', { p_id: s.id, p_reason: F(f, 'reason').value }); toast('Surat jalan dibatalkan'); },
      })) ? undefined : false) },
    ] : [],
  });
}

async function suratJalanPart(panel, rpc, ctx) {
  await screen(panel, {
    title: 'Surat jalan', intro: 'Langkah 2 dari 3: barang dikirim dari transfer order (boleh sebagian). Stok keluar dari lokasi asal saat disimpan.',
    load: ({ from, to }) => rpc('stock_shipment_list', { p_from: from, p_to: to }),
    options: { rowKey: 'id', exportName: 'surat-jalan', editLabel: 'Buka', emptyText: 'Belum ada surat jalan di rentang ini.', defaultSort: { key: 'no', dir: 'desc' },
      searchKeys: ['no', 'transfer_no', 'from', 'to', 'status'], columns: sjColumns,
      onAdd: () => shipmentForm(rpc, ctx), onEdit: (s) => shipmentDialog(rpc, ctx, s) },
  });
}

/* ================================================================ Penerimaan transfer and Dalam perjalanan */
async function receiveForm(rpc, ctx, pick) {
  const open = await rpc('stock_in_transit');
  if (!open.length) throw new Error('Belum ada barang yang dalam perjalanan. Kirim dulu lewat Surat jalan.');
  const linesFor = (s) => s.lines.map((l) => `<div class="dt-line dt-line-recv" data-line data-item="${l.item_id}" data-shipped="${esc(l.qty)}">
      <p><strong>${esc(l.item)}</strong><br><span class="muted small">Dikirim ${esc(withUnit(l.qty, l.unit))}</span></p>
      <label class="field"><span>Diterima</span><input type="text" inputmode="decimal" data-f="r-qty" autocomplete="off" value="${esc(qtyText(l.qty).replace(/\./g, ''))}"></label>
      <label class="field"><span>Alasan selisih</span><input type="text" data-f="r-why" autocomplete="off" maxlength="200"></label><span></span></div>`).join('');
  const first = open.find((s) => s.id === pick) || open[0];
  return formDialog({
    title: 'Penerimaan transfer', wide: true, submitLabel: 'Simpan penerimaan',
    html: `${sel('sj', open.map((s) => [s.id, `${s.no}: ${s.from} ke ${s.to}`]), first.id, `Surat jalan ${REQ}`)}
      <p class="muted small">Isi yang benar-benar sampai. Kalau beda dengan yang dikirim, tulis alasannya (misalnya pecah di jalan).</p>
      <div class="dt-lines" data-lines>${linesFor(first)}</div>${inp('note', 'Catatan', 'maxlength="200"')}`,
    onOpen: (f) => F(f, 'sj').addEventListener('change', (e) => { f.querySelector('[data-lines]').innerHTML = linesFor(open.find((s) => String(s.id) === e.target.value)); }),
    onSubmit: async (f) => {
      const lines = $$('[data-line]', f).map((r) => ({ item: Number(r.dataset.item), received: need(parseNum(r.querySelector('[data-f="r-qty"]').value), 'Isi jumlah yang diterima (0 kalau tidak ada).'), reason: r.querySelector('[data-f="r-why"]').value }));
      const r = await rpc('stock_transfer_receive', { p_shipment: Number(F(f, 'sj').value), p_lines: lines, p_note: F(f, 'note').value });
      toast(r.lines_off ? `${r.no}: diterima, ${r.lines_off} barang selisih` : `${r.no}: diterima`);
    },
  });
}

async function penerimaanPart(panel, rpc, ctx) {
  const open = (r) => infoDialog({
    title: r.no, wide: true,
    html: `<p>${esc(r.from)} ke ${esc(r.to)} · ${esc(day(r.day))} · surat jalan ${esc(r.shipment_no)}, transfer order ${esc(r.transfer_no)} · ${esc(r.by || '')}</p>${r.note ? `<p>${esc(r.note)}</p>` : ''}
      ${linesTable([['Barang'], ['Dikirim', 1], ['Diterima', 1], ['Selisih', 1], ['Alasan']], r.lines.map((l) => `<tr>${td(esc(l.item))}${td(esc(withUnit(l.shipped, l.unit)), 1)}${td(esc(qtyText(l.received)), 1)}
        ${td(Number(l.diff) ? tag(signed(l.diff), 'tag-bad') : '0', 1)}${td(esc(l.reason || '–'))}</tr>`))}`,
  });
  await screen(panel, {
    title: 'Penerimaan transfer', intro: 'Langkah 3 dari 3: barang dari surat jalan sampai di lokasi tujuan. Selisih dicatat per barang dengan alasannya.',
    load: ({ from, to }) => rpc('stock_receipt_list', { p_from: from, p_to: to }),
    options: { rowKey: 'id', exportName: 'penerimaan-transfer', editLabel: 'Buka', emptyText: 'Belum ada penerimaan transfer di rentang ini.', defaultSort: { key: 'no', dir: 'desc' },
      searchKeys: ['no', 'shipment_no', 'transfer_no', 'from', 'to', 'by'],
      columns: [
        { key: 'no', label: 'No. dokumen', sort: true },
        { key: 'shipment_no', label: 'Surat jalan', sort: true },
        { key: 'from', label: 'Dari', sort: true },
        { key: 'to', label: 'Ke', sort: true },
        { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
        { key: 'lines_off', label: 'Selisih', sort: true, html: true, format: (v, r) => (v ? tag(`${v} dari ${r.lines_count} barang`, 'tag-warn') : 'Tidak ada'), export: (r) => r.lines_off },
        { key: 'by', label: 'Diterima oleh', sort: true, format: (v) => v || '–' },
      ],
      onAdd: () => receiveForm(rpc, ctx), onEdit: open },
  });
}

async function perjalananPart(panel, rpc, ctx) {
  await screen(panel, {
    title: 'Dalam perjalanan', noRange: true, intro: 'Surat jalan yang sudah dikirim tapi belum diterima, dari tanggal berapa pun. Buka satu untuk menerima atau membatalkannya.',
    load: () => rpc('stock_in_transit'),
    options: { rowKey: 'id', exportName: 'dalam-perjalanan', editLabel: 'Buka', emptyText: 'Tidak ada barang yang dalam perjalanan.', defaultSort: { key: 'days', dir: 'desc' },
      searchKeys: ['no', 'transfer_no', 'from', 'to'],
      columns: [...sjColumns.filter((c) => c.key !== 'status'),
        { key: 'days', label: 'Sudah', sort: true, align: 'num', html: true, format: (v) => (v >= 2 ? tag(`${v} hari`, 'tag-warn') : esc(v ? `${v} hari` : 'Hari ini')), export: (r) => r.days }],
      onEdit: (s) => shipmentDialog(rpc, ctx, s) },
  });
}

/* ================================================================ Produksi and Bongkar produksi */
function productionForm(rpc, { locs }, recipes, kind) {
  const made = recipes.recipes;
  if (!made.length) throw new Error('Belum ada barang dengan resep produksi. Pemilik mengaturnya di Resep produksi.');
  const prod = kind === 'produksi';
  const dapur = activeLocs(locs).find((l) => !l.is_booth) || activeLocs(locs)[0];
  return formDialog({
    title: prod ? 'Produksi' : 'Bongkar produksi', wide: true, submitLabel: prod ? 'Simpan produksi' : 'Simpan bongkar',
    html: `<p class="muted small">${prod ? 'Bahan berkurang sesuai resep produksi, barang jadi bertambah, di lokasi yang sama.' : 'Kebalikan produksi: barang jadi berkurang, bahannya kembali ke stok.'}</p>
      <div class="dt-fields">${sel('item', made.map((r) => [r.item_id, `${r.item} (${r.unit})`]), made[0].item_id, `${prod ? 'Barang diproduksi' : 'Barang dibongkar'} ${REQ}`)}
      ${inp('qty', `${prod ? 'Jumlah produksi' : 'Jumlah dibongkar'} ${REQ}`, 'inputmode="decimal"')}
      ${sel('loc', locOpts(locs), dapur?.id, `Lokasi ${REQ}`)}${dateInp('day', `Tanggal ${REQ}`, ymd(), `max="${ymd()}"`)}</div>
      ${inp('note', 'Catatan', 'maxlength="200"')}
      <div data-prev aria-live="polite"></div>`,
    onOpen: (f) => {
      let seq = 0;
      const preview = async () => {
        const n = ++seq, qty = parseNum(F(f, 'qty').value) || 0, box = f.querySelector('[data-prev]');
        try {
          const p = await rpc('stock_production_preview', { p_kind: kind, p_item: Number(F(f, 'item').value), p_qty: Number.isFinite(qty) ? qty : 0, p_location: Number(F(f, 'loc').value) });
          if (n !== seq) return;
          box.innerHTML = `<h3>${prod ? 'Bahan yang dipakai' : 'Bahan yang kembali'}</h3>
            ${linesTable([['Barang'], ['Per 1 ' + p.unit, 1], ['Jumlah', 1], [`Sisa stok ${p.location}`, 1]], p.components.map((c) => `<tr>${td(esc(c.component))}${td(esc(qtyText(c.per_unit)), 1)}
              ${td(esc(withUnit(c.qty, c.unit)), 1)}${td(c.enough ? esc(qtyText(c.stock)) : tag(`${qtyText(c.stock)}, kurang`, 'tag-bad'), 1)}</tr>`))}
            <p class="muted small">Stok ${esc(p.item)} di ${esc(p.location)} sekarang ${esc(withUnit(p.item_stock, p.unit))}.${!p.enough && qty ? ` <strong>${prod ? 'Bahan tidak cukup.' : 'Stok barang tidak cukup.'}</strong>` : ''}</p>`;
        } catch (e) { if (n === seq) box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
      };
      ['item', 'loc'].forEach((k) => F(f, k).addEventListener('change', preview));
      F(f, 'qty').addEventListener('input', preview);
      preview();
    },
    onSubmit: async (f) => {
      const r = await rpc('stock_production_create', { p_kind: kind, p_item: Number(F(f, 'item').value), p_qty: need(parseNum(F(f, 'qty').value), 'Isi jumlahnya.'),
        p_location: Number(F(f, 'loc').value), p_day: F(f, 'day').value || null, p_note: F(f, 'note').value });
      toast(`${r.no}: ${withUnit(r.qty, r.unit)} ${r.item}`);
    },
  });
}

async function productionPart(panel, rpc, ctx, kind) {
  const prod = kind === 'produksi';
  const open = (p) => infoDialog({
    title: p.no, wide: true,
    html: `<p>${prod ? 'Produksi' : 'Bongkar produksi'} ${esc(withUnit(p.qty, p.unit))} ${esc(p.item)} di ${esc(p.location)} · ${esc(day(p.day))} · ${esc(p.by || '')}</p>${p.note ? `<p>${esc(p.note)}</p>` : ''}
      ${linesTable([['Bahan'], ['Per 1 ' + p.unit, 1], [prod ? 'Dipakai' : 'Kembali', 1], ['Stok sebelumnya', 1]], p.lines.map((l) => `<tr>${td(esc(l.component))}${td(esc(qtyText(l.per_unit)), 1)}${td(esc(withUnit(l.qty, l.unit)), 1)}${td(esc(qtyText(l.stock_at)), 1)}</tr>`))}`,
  });
  await screen(panel, {
    title: prod ? 'Produksi' : 'Bongkar produksi',
    intro: prod ? 'Barang yang dibuat dari bahan lain sesuai resep produksi, misalnya vla dari bahannya. Bahan berkurang, barang jadi bertambah.' : 'Membatalkan produksi: barang jadi dikurangi dan bahannya dikembalikan ke stok.',
    load: ({ from, to }) => rpc('stock_production_list', { p_from: from, p_to: to, p_kind: kind }),
    options: { rowKey: 'id', exportName: prod ? 'produksi' : 'bongkar-produksi', editLabel: 'Buka', emptyText: `Belum ada ${prod ? 'produksi' : 'bongkar produksi'} di rentang ini.`, defaultSort: { key: 'no', dir: 'desc' },
      searchKeys: ['no', 'item', 'location', 'by', 'note'],
      columns: [
        { key: 'no', label: 'No. dokumen', sort: true },
        { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
        { key: 'item', label: 'Barang', sort: true },
        { key: 'qty', label: 'Jumlah', sort: true, align: 'num', format: (v, r) => withUnit(v, r.unit), export: (r) => Number(r.qty) },
        { key: 'location', label: 'Lokasi', sort: true },
        { key: 'components_count', label: 'Bahan', sort: true, align: 'num' },
        { key: 'by', label: 'Dicatat oleh', sort: true, format: (v) => v || '–' },
      ],
      onAdd: async () => productionForm(rpc, ctx, await rpc('stock_production_recipes'), kind), onEdit: open },
  });
}

/* ================================================================ Resep produksi (owner) */
async function resepPart(panel, rpc, ctx) {
  const edit = async (row) => {
    const all = await rpc('stock_production_recipes');
    const items = all.items.filter((i) => i.active || (row && i.id === row.item_id));
    const opts = items.map((i) => [i.id, `${i.name} (${i.unit})`]);
    const line = (c = {}) => `<div class="dt-line" data-line>${sel('c-item', opts, c.component_id, 'Bahan')}
      <label class="field"><span>Jumlah per 1 satuan</span><input type="text" inputmode="decimal" data-f="c-qty" autocomplete="off" value="${esc(c.qty != null ? qtyText(c.qty).replace(/\./g, '') : '')}"></label>
      <span></span><button class="btn btn-text" type="button" data-rm>Hapus baris</button></div>`;
    return formDialog({
      title: row ? `Resep produksi: ${row.item}` : 'Resep produksi baru', wide: true, submitLabel: 'Simpan resep',
      html: `${row ? '' : sel('item', opts, '', `Barang yang dibuat ${REQ}`)}
        <p class="muted small">Isi bahan untuk membuat 1 satuan barang (misalnya 1 g vla). Produksi memakai bahan sebanyak jumlah ini dikali jumlah produksi.</p>
        <div class="dt-lines" data-lines>${(row?.components?.length ? row.components : [{}]).map(line).join('')}</div>
        <div class="row"><button class="btn btn-quiet" type="button" data-addline>+ Tambah bahan</button></div>`,
      onOpen: (f) => f.addEventListener('click', (e) => {
        if (e.target.closest('[data-addline]')) f.querySelector('[data-lines]').insertAdjacentHTML('beforeend', line());
        const rm = e.target.closest('[data-rm]');
        if (rm && $$('[data-line]', f).length > 1) rm.closest('[data-line]').remove();
      }),
      onSubmit: async (f) => {
        const lines = $$('[data-line]', f).map((r) => ({ item: Number(r.querySelector('[data-f="c-item"]').value), qty: need(parseNum(r.querySelector('[data-f="c-qty"]').value), 'Isi jumlah setiap bahan.') }));
        await rpc('stock_production_recipe_save', { p_item: row ? row.item_id : Number(F(f, 'item').value), p_lines: lines });
        toast('Resep produksi disimpan');
      },
      buttons: row ? [{ label: 'Hapus resep', danger: true, onClick: async () => {
        if (!(await confirmDialog({ title: `Hapus resep ${row.item}?`, text: 'Produksi yang sudah dicatat tetap ada. Barang ini tidak bisa diproduksi lagi sampai resepnya diisi.', confirmLabel: 'Hapus resep', danger: true }))) return false;
        await rpc('stock_production_recipe_save', { p_item: row.item_id, p_lines: [] }); toast('Resep dihapus');
        return undefined;
      } }] : [],
    });
  };
  await screen(panel, {
    title: 'Resep produksi', noRange: true, intro: 'Bahan untuk membuat satu barang stok dari barang stok lain. Ini berbeda dari Resep produk (yang mengurangi stok saat produk terjual). Hanya pemilik yang bisa mengubahnya.',
    load: async () => (await rpc('stock_production_recipes')).recipes,
    options: { rowKey: 'item_id', exportName: 'resep-produksi', editLabel: 'Ubah', emptyText: 'Belum ada resep produksi. Tekan + Tambah untuk membuat yang pertama.',
      searchKeys: ['item'],
      columns: [
        { key: 'item', label: 'Barang yang dibuat', sort: true, format: (v, r) => `${v} (per 1 ${r.unit})` },
        { key: 'components_count', label: 'Jumlah bahan', sort: true, align: 'num' },
        { key: 'components', label: 'Bahan', format: (v) => (v || []).map((c) => `${qtyText(c.qty)} ${c.unit} ${c.component}`).join(', '), export: (r) => (r.components || []).map((c) => `${qtyText(c.qty)} ${c.unit} ${c.component}`).join(', ') },
      ],
      onAdd: () => edit(null), onEdit: edit },
  });
}

/* ================================================================ Kartu stok */
// Every number on the card leads to its source (13 Nov 2026, like VireoPOS Riwayat stok): a document
// number opens that document's list searched for it (an HS- or L- receipt opens the order itself);
// a row without a document opens the list it was written in, searched for the item.
const DOC_VIEW = { ST: 'stok-transfer', TO: 'transfer-order', SJ: 'surat-jalan', PT: 'penerimaan-transfer', PR: 'produksi', BP: 'bongkar-produksi', PB: 'purchase-order' };
const COL_VIEW = { pembelian: 'penerimaan-barang', masuk: 'stok-masuk', keluar: 'stok-keluar', penyesuaian: 'penyesuaian-stok' };
function sourceOf(r, itemName) {
  const no = String(r.doc_no || '');
  if (/^(HS|L)[-\d]/i.test(no)) return { receipt: no };
  const pre = no.split('-')[0].toUpperCase();
  if (DOC_VIEW[pre]) return { view: DOC_VIEW[pre], q: no };
  if (COL_VIEW[r.col]) return { view: COL_VIEW[r.col], q: itemName };
  return null;
}
const goSource = (dlg, detail) => { dlg.close(); document.dispatchEvent(new CustomEvent('hs-owner-go', { detail })); };
async function kartuPart(panel, rpc, { locs }) {
  const booth = locs.find((l) => l.is_booth) || locs[0];
  const controls = `<label class="field"><span>Lokasi</span><select data-c="loc">${locs.map((l) => `<option value="${l.id}"${l.id === booth.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" data-c="all"><span>Tampilkan barang dengan stok kosong</span></label>`;
  const num = (k, label) => ({ key: k, label, sort: true, align: 'num', format: (v) => (k === 'opening' || k === 'closing' ? qtyText(v) : signed(v)), export: (r) => Number(r[k]) });
  const detail = async (row, ctx) => {
    const c = await rpc('stock_card', { p_location: Number(ctx.c.loc), p_item: row.item_id, p_from: ctx.from, p_to: ctx.to });
    const totals = COLS.filter(([k]) => Number(c.totals?.[k])).map(([k, l]) => `${l} ${signed(c.totals[k])}`).join(' · ');
    const srcs = c.rows.map((r) => sourceOf(r, c.item.name));
    const link = (i, text) => (srcs[i] ? `<button class="btn btn-text dt-src" type="button" data-src="${i}">${esc(text)}</button>` : esc(text));
    const rows = c.rows.map((r, i) => `<tr>${td(esc(when(r.at)))}${td(esc(COL_LABEL[r.col] || r.col))}${td(r.doc_no ? link(i, r.doc_no) : '–')}${td(esc((r.doc_no ? String(r.reason || '').replace(r.doc_no, '') : r.reason || '').trim() || '–'))}
      ${td(Number(r.qty) > 0 ? link(i, qtyText(r.qty)) : '', 1)}${td(Number(r.qty) < 0 ? link(i, qtyText(-r.qty)) : '', 1)}${td(esc(qtyText(r.balance)), 1)}${td(esc(r.by || '–'))}</tr>`);
    return infoDialog({
      title: `Kartu stok: ${c.item.name}`, wide: true,
      html: `<p>${esc(c.location.name)} · ${esc(day(c.from))} sampai ${esc(day(c.to))} · satuan ${esc(c.item.unit)}</p>
        <dl class="kv"><dt>Stok awal</dt><dd>${esc(withUnit(c.opening, c.item.unit))}</dd><dt>Stok akhir</dt><dd>${esc(withUnit(c.closing, c.item.unit))}</dd>${totals ? `<dt>Pergerakan</dt><dd>${esc(totals)}</dd>` : ''}</dl>
        ${c.rows.length ? linesTable([['Waktu'], ['Jenis'], ['Dokumen'], ['Keterangan'], ['Masuk', 1], ['Keluar', 1], ['Saldo', 1], ['Oleh']],
          [`<tr>${td(esc(day(c.from)))}${td('Stok awal')}${td('')}${td('')}${td('', 1)}${td('', 1)}${td(esc(qtyText(c.opening)), 1)}${td('')}</tr>`, ...rows]) : '<p class="muted">Tidak ada pergerakan di rentang ini. Pilih rentang lain di Kartu stok.</p>'}
        ${c.rows.length ? '<p class="muted small">Ketuk nomor dokumen atau angka masuk dan keluar untuk membuka catatan asalnya.</p>' : ''}`,
      onOpen: (f, dlg) => f.addEventListener('click', (e) => { const b = e.target.closest('[data-src]'); if (b) goSource(dlg, srcs[Number(b.dataset.src)]); }),
      buttons: [{ label: 'Ekspor .xlsx', onClick: async () => {
        await loadSheetJS();
        const aoa = [['Waktu', 'Jenis', 'Dokumen', 'Keterangan', 'Masuk', 'Keluar', 'Saldo', 'Oleh'], [c.from, 'Stok awal', '', '', '', '', Number(c.opening), ''],
          ...c.rows.map((r) => [r.at, COL_LABEL[r.col] || r.col, r.doc_no || '', r.reason || '', Number(r.qty) > 0 ? Number(r.qty) : '', Number(r.qty) < 0 ? -Number(r.qty) : '', Number(r.balance), r.by || ''])];
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(aoa), 'Kartu stok');
        window.XLSX.writeFile(wb, `kartu-stok-${c.item.name}-${c.location.name}-${c.from}-${c.to}.xlsx`.replace(/[^\w.-]+/g, '-'));
        return false;
      } }],
    });
  };
  let ctxNow = null;
  const s = await screen(panel, {
    title: 'Kartu stok', controls, intro: 'Per barang dan lokasi: stok awal, semua pergerakan di rentang tanggal, dan stok akhir. Buka satu barang untuk melihat setiap catatan dengan saldo berjalan.',
    load: async (ctx) => { ctxNow = ctx; return (await rpc('stock_card_summary', { p_location: Number(ctx.c.loc), p_from: ctx.from, p_to: ctx.to, p_all: !!ctx.c.all })).rows; },
    options: { rowKey: 'item_id', exportName: 'kartu-stok', editLabel: 'Buka', emptyText: 'Tidak ada stok atau pergerakan di lokasi ini.', pageSize: 25,
      searchKeys: ['item'],
      columns: [
        { key: 'item', label: 'Barang', sort: true },
        num('opening', 'Stok awal'), ...COLS.map(([k, l]) => num(k, l)), num('closing', 'Stok akhir'),
        { key: 'unit', label: 'Satuan' },
      ],
      onEdit: (r) => detail(r, ctxNow || s?.ctx()) },
  });
}

const PARTS = {
  lokasi: lokasiPart, 'stok-transfer': stokTransferPart, 'transfer-order': transferOrderPart, 'surat-jalan': suratJalanPart,
  penerimaan: penerimaanPart, perjalanan: perjalananPart,
  produksi: (p, r, c) => productionPart(p, r, c, 'produksi'), bongkar: (p, r, c) => productionPart(p, r, c, 'bongkar'),
  resep: resepPart, kartu: kartuPart,
};
