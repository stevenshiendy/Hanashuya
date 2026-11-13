// Owner menu group "Transaksi" (12 Nov 2026): what moves in and out, as data tables
// (js/data-table.js). The maths is in supabase/stock.sql and supabase/pos-transaksi.sql.
//   mountTransaksi(panel, { rpc, part, readOnly })
//   readOnly (a manager, Glenn 13 Nov 2026): the lists only, no + Tambah, edit, Hapus or Proses.
//   part: 'po' (Purchase Order), 'penerimaan' (Penerimaan barang), 'stok-masuk', 'stok-keluar',
//         'opname' (Stok opname), 'adjustment' (Penyesuaian stok), 'komisi-proses', 'pembatalan'
import { $, $$, esc, rupiah, when, day, toast } from './lib.js';
import { dataTable, formDialog, infoDialog, confirmDialog, warnFirst } from './data-table.js';
import { rangeHtml, wireRange } from './owner-range.js';

const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const qtyText = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const withUnit = (n, u) => `${qtyText(n)} ${u || ''}`.trim();
const signed = (n) => `${Number(n) > 0 ? '+' : ''}${qtyText(n)}`;
const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorHtml = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;
const REQ = '<span class="hint is-req">wajib</span>';
// "1.000", "1000", "1,5" and "1.5" all work; empty is null, junk is NaN.
function parseNum(raw) {
  let s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return Number(s.replace(',', '.'));
}
const need = (n, msg) => { if (n == null || !Number.isFinite(n)) throw new Error(msg); return n; };

const PO_TAG = { dikirim: ['Dikirim', 'tag-warn'], sebagian: ['Diterima sebagian', 'tag-warn'], selesai: ['Selesai', 'tag-ok'], batal: ['Batal', 'tag-bad'] };
const GI_TAG = { aktif: null, diubah: ['Diubah', 'tag-warn'], dibatalkan: ['Dibatalkan', 'tag-bad'] };
const OUT_LABEL = { penjualan: 'Penjualan', batal_penjualan: 'Batal penjualan', sampel: 'Sampel', buang: 'Dibuang', rusak: 'Rusak', promo: 'Promo' };
const OP_TAG = { menunggu: ['Menunggu', 'tag-warn'], diterima: ['Diterima', 'tag-ok'], ditolak: ['Ditolak', 'tag-bad'], diganti: ['Diganti', ''] };
const PAY_TAG = { diproses: ['Diproses', 'tag-warn'], dibayar: ['Dibayar', 'tag-ok'], batal: ['Dibatalkan', 'tag-bad'] };
const VOID_TAG = { menunggu: ['Menunggu', 'tag-warn'], disetujui: ['Disetujui', 'tag-ok'], ditolak: ['Ditolak', 'tag-bad'], selesai: ['Selesai', ''] };
const tagOf = (map, k) => (map[k] ? tag(map[k][0], map[k][1]) : esc(k || '–'));

// Read-only (manager): the lists stay, every write is taken out. onEdit stays only where it just shows a record.
let RO = false;
const readOnlyOptions = (o) => {
  if (!RO) return o;
  const { onAdd, onDelete, onImport, extraActions, selectable, onAction, ...rest } = o;
  if (!rest.viewOnly) delete rest.onEdit;
  return { ...rest, emptyHint: rest.emptyHint || 'Pilih rentang tanggal lain.' };
};

// One screen: heading, a date range (30 days at first), optional filters, and the table.
async function screen(panel, { title, intro, noRange, controls = '', load, options: options0 }) {
  const options = readOnlyOptions(options0);
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>${esc(title)}</h1>${intro ? `<p class="muted small">${esc(intro)}</p>` : ''}</div>
    ${noRange ? '' : rangeHtml({ preset: '30' })}
    <div class="dt-range" data-range${!controls ? ' hidden' : ''}>${controls}</div>
    <div data-t>${loadingHtml}</div></div>`;
  const host = $('[data-t]', panel);
  const ctx = () => ({ from: $('[data-from]', panel)?.value, to: $('[data-to]', panel)?.value,
    c: Object.fromEntries($$('[data-c]', panel).map((e) => [e.dataset.c, e.value])) });
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
  return t;
}

const sel = (name, opts, pick, label, extra = '') => `<label class="field"><span>${label}</span><select data-f="${name}" ${extra}>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(pick) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const inp = (name, label, extra = '', value = '') => `<label class="field"><span>${label}</span><input type="text" data-f="${name}" autocomplete="off" value="${esc(value)}" ${extra}></label>`;
const F = (form, k) => form.querySelector(`[data-f="${k}"]`);
const staffOpts = (cat) => (cat.staff || []).map((s) => [s.id, s.name + (s.is_me ? ' (saya)' : '')]);
const mePick = (cat) => (cat.staff || []).find((s) => s.is_me)?.id;
const itemOpts = (cat) => (cat.items || []).map((i) => [i.id, `${i.name} (${i.unit})`]);

export async function mountTransaksi(panel, { rpc, part, readOnly = false }) {
  RO = !!readOnly;
  const run = PARTS[part];
  if (!run) { panel.innerHTML = errorHtml(new Error('Halaman ini belum ada.')); return; }
  panel.innerHTML = loadingHtml;
  let cat;
  try { cat = await rpc('stock_catalog'); } catch (e) { panel.innerHTML = errorHtml(e); return; }
  await run(panel, rpc, cat);
}

/* ================================================================ a. Purchase Order */
async function poPart(panel, rpc, cat) {
  const lineHtml = (l = {}) => `<div class="dt-line" data-line>
    ${sel('l-item', itemOpts(cat), l.item_id, 'Barang')}
    <label class="field"><span>Jumlah</span><input type="text" inputmode="decimal" data-f="l-qty" autocomplete="off" value="${esc(l.qty ?? '')}"></label>
    <label class="field"><span>Harga perkiraan per satuan (Rp)</span><input type="text" inputmode="numeric" data-f="l-est" autocomplete="off" value="${esc(l.est_cost ?? '')}"></label>
    <button class="btn btn-text" type="button" data-rm>Hapus baris</button></div>`;
  const readLines = (form) => $$('[data-line]', form).map((r) => ({
    item: Number(r.querySelector('[data-f="l-item"]').value), qty: need(parseNum(r.querySelector('[data-f="l-qty"]').value), 'Isi jumlah di setiap baris barang.'),
    est_cost: parseNum(r.querySelector('[data-f="l-est"]').value),
  }));
  const supplierOpts = () => [['', 'Pilih pemasok'], ...(cat.suppliers || []).map((s) => [s.id, s.name])];
  const cancelPo = async (po) => formDialog({
    title: `Batalkan ${po.no}?`, submitLabel: 'Batalkan PO', cancelLabel: 'Kembali',
    html: `<p class="muted small">PO yang dibatalkan tetap tercatat. Barang yang sudah masuk tidak ikut hilang.</p>${inp('reason', `Alasan ${REQ}`, 'maxlength="200"')}`,
    onSubmit: async (f) => { await rpc('stock_request_cancel', { p_id: po.id, p_reason: F(f, 'reason').value }); toast('PO dibatalkan'); },
  });
  const dialog = async (po) => {
    const editable = !po || (po.status === 'dikirim' && po.lines.every((l) => !Number(l.received)));
    if (!editable) {
      return infoDialog({
        title: `${po.no}`, wide: true,
        html: `<p>${tagOf(PO_TAG, po.status)} · ${esc(po.supplier || 'Tanpa pemasok')} · ${esc(day(po.day))}${po.needed_by ? `, dibutuhkan ${esc(day(po.needed_by))}` : ''}</p>
          ${po.note ? `<p>${esc(po.note)}</p>` : ''}${po.status === 'batal' ? `<p class="muted small">Dibatalkan: ${esc(po.cancel_reason || '')}</p>` : ''}
          <div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Diminta</th><th class="num">Diterima</th><th class="num">Harga perkiraan</th></tr></thead><tbody>
          ${po.lines.map((l) => `<tr><td>${esc(l.item)}</td><td class="num">${esc(withUnit(l.qty, l.unit))}</td><td class="num">${esc(withUnit(l.received, l.unit))}</td><td class="num">${l.est_cost != null ? esc(rupiah(l.est_cost)) : '–'}</td></tr>`).join('')}
          </tbody></table></div>`,
        buttons: ['dikirim', 'sebagian'].includes(po.status) ? [{ label: 'Batalkan PO', danger: true, onClick: async () => ((await cancelPo(po)) ? undefined : false) }] : [],
      });
    }
    return formDialog({
      title: po ? `Ubah ${po.no}` : 'Purchase order baru', wide: true, submitLabel: po ? 'Simpan perubahan' : 'Simpan PO',
      html: `<div class="dt-fields">${sel('supplier', supplierOpts(), po?.supplier_id, `Pemasok ${REQ}`)}
        <label class="field"><span>Dibutuhkan tanggal</span><input type="date" data-f="needed" min="${ymd()}" value="${esc(po?.needed_by || '')}"></label></div>
        ${inp('note', 'Catatan', 'maxlength="200"', po?.note || '')}
        <div class="dt-lines" data-lines>${(po?.lines || [{}]).map(lineHtml).join('')}</div>
        <div class="row"><button class="btn btn-quiet" type="button" data-addline>+ Tambah barang</button></div>`,
      onOpen: (f) => {
        f.addEventListener('click', (e) => {
          if (e.target.closest('[data-addline]')) f.querySelector('[data-lines]').insertAdjacentHTML('beforeend', lineHtml());
          const rm = e.target.closest('[data-rm]');
          if (rm && $$('[data-line]', f).length > 1) rm.closest('[data-line]').remove();
        });
      },
      onSubmit: async (f) => {
        const supplier = need(parseNum(F(f, 'supplier').value), 'Pilih pemasok.');
        const args = { p_supplier: supplier, p_lines: readLines(f), p_needed_by: F(f, 'needed').value || null, p_note: F(f, 'note').value };
        await rpc(po ? 'stock_po_update' : 'stock_po_create', po ? { p_id: po.id, ...args } : args);
        toast(po ? 'PO diubah' : 'PO dibuat');
      },
      buttons: po ? [{ label: 'Batalkan PO', danger: true, onClick: async () => ((await cancelPo(po)) ? undefined : false) }] : [],
    });
  };
  await screen(panel, {
    title: 'Purchase Order', intro: 'Permintaan barang ke pemasok. PO yang masih "Dikirim" bisa diubah; kalau barangnya sudah datang, catat di Penerimaan barang.',
    load: ({ from, to }) => rpc('stock_po_list', { p_from: from, p_to: to }),
    options: {
      rowKey: 'id', exportName: 'purchase-order', emptyText: 'Belum ada purchase order di rentang ini.', defaultSort: { key: 'no', dir: 'desc' }, editLabel: 'Buka',
      searchKeys: ['no', 'supplier', 'status', 'responsible'],
      columns: [
        { key: 'no', label: 'No. PO', sort: true },
        { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
        { key: 'supplier', label: 'Pemasok', sort: true, format: (v) => v || '–' },
        { key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(PO_TAG, v), export: (r) => (PO_TAG[r.status] || [r.status])[0] },
        { key: 'lines_count', label: 'Barang', sort: true, align: 'num' },
        { key: 'est_total', label: 'Perkiraan harga', sort: (r) => r.est_total ?? -1, align: 'num', format: (v) => (v != null ? rupiah(v) : '–'), export: (r) => r.est_total ?? '' },
        { key: 'responsible', label: 'Dibuat oleh', sort: true, format: (v) => v || '–' },
      ],
      onAdd: () => dialog(null), onEdit: (r) => dialog(r),
    },
  });
}

/* ================================================================ shared: goods-in detail (change / cancel) */
function goodsInDialog(rpc, g) {
  const history = (g.changes || []).map((c) => `<li>${c.kind === 'batal' ? 'Dibatalkan' : 'Diubah'} ${esc(c.by || '')}, ${esc(when(c.at))}: ${esc(qtyText(c.old_qty))} jadi ${esc(qtyText(c.new_qty))}${c.new_cost != null ? `, harga ${esc(rupiah(c.new_cost))}` : ''}. ${esc(c.reason)}</li>`).join('');
  const head = `<dl class="kv"><dt>Barang</dt><dd>${esc(g.item)}</dd><dt>Jumlah</dt><dd>${esc(withUnit(g.current_qty, g.unit))}${Number(g.qty) !== Number(g.current_qty) ? ` (awalnya ${esc(qtyText(g.qty))})` : ''}</dd>
    <dt>Pemasok</dt><dd>${esc(g.supplier || '–')}</dd><dt>PO</dt><dd>${esc(g.request_no || '–')}</dd><dt>Harga beli</dt><dd>${g.total_cost != null ? esc(rupiah(g.total_cost)) : '–'}</dd>
    <dt>Tanggal</dt><dd>${esc(day(g.day))}, penanggung jawab ${esc(g.responsible || '–')}</dd>${g.slip_note ? `<dt>Surat jalan</dt><dd>${esc(g.slip_note)}</dd>` : ''}${g.note ? `<dt>Catatan</dt><dd>${esc(g.note)}</dd>` : ''}</dl>
    ${history ? `<h3>Riwayat</h3><ul class="dt-list">${history}</ul>` : ''}`;
  if (g.status === 'dibatalkan') return infoDialog({ title: `Barang masuk: ${g.item}`, html: head });
  return formDialog({
    title: `Barang masuk: ${g.item}`, submitLabel: 'Simpan perubahan',
    html: `${head}<h3>Ubah atau batalkan</h3><div class="dt-fields">${inp('qty', `Jumlah baru (${esc(g.unit)})`, 'inputmode="decimal"', qtyText(g.current_qty).replace(/\./g, ''))}
      ${inp('cost', 'Harga beli total baru (Rp)', 'inputmode="numeric"')}</div>${inp('reason', `Alasan ${REQ}`, 'maxlength="200"')}`,
    onSubmit: async (f) => {
      const cost = parseNum(F(f, 'cost').value);
      if (cost === 0 && warnFirst(f, 'Harga beli Rp0 membuat harga pokok barang ini turun, jadi laba di laporan terlihat lebih besar. Tekan Tetap simpan kalau barangnya memang gratis.')) return false;
      await rpc('stock_change_goods_in', { p_id: g.id, p_qty: need(parseNum(F(f, 'qty').value), 'Isi jumlahnya.'), p_reason: F(f, 'reason').value,
        p_cost_mode: cost == null ? null : 'total', p_cost: cost });
      toast('Barang masuk diubah');
    },
    buttons: [{ label: 'Batalkan barang masuk', danger: true, onClick: async (f) => {
      const ok = await confirmDialog({ title: 'Batalkan barang masuk ini?', text: `${withUnit(g.current_qty, g.unit)} ${g.item} dikurangi dari stok. Catatannya tetap tersimpan.`, confirmLabel: 'Batalkan', danger: true });
      if (!ok) return false;
      await rpc('stock_cancel_goods_in', { p_id: g.id, p_reason: F(f, 'reason').value });
      toast('Barang masuk dibatalkan');
      return undefined;
    } }],
  });
}
const giColumns = [
  { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
  { key: 'item', label: 'Barang', sort: true },
  { key: 'current_qty', label: 'Jumlah', sort: true, align: 'num', format: (v, r) => withUnit(v, r.unit), export: (r) => Number(r.current_qty) },
  { key: 'supplier', label: 'Pemasok', sort: true, format: (v) => v || '–' },
  { key: 'request_no', label: 'No. PO', sort: true, format: (v) => v || '–' },
  { key: 'total_cost', label: 'Harga beli', sort: (r) => r.total_cost ?? -1, align: 'num', format: (v) => (v != null ? rupiah(v) : '–'), export: (r) => r.total_cost ?? '' },
  { key: 'status', label: 'Status', sort: true, html: true, format: (v) => (GI_TAG[v] ? tag(GI_TAG[v][0], GI_TAG[v][1]) : 'Aktif'), export: (r) => (GI_TAG[r.status] || ['Aktif'])[0] },
  { key: 'responsible', label: 'Penanggung jawab', sort: true, format: (v) => v || '–' },
];

/* ================================================================ b. Penerimaan barang */
async function penerimaanPart(panel, rpc, cat) {
  const receive = async () => {
    const open = await rpc('stock_request_open');
    if (!open.length) throw new Error('Belum ada purchase order yang menunggu barang. Buat dulu di Purchase Order.');
    const linesFor = (po) => po.lines.map((l) => {
      const left = Math.max(0, Number(l.qty) - Number(l.received));
      return `<div class="dt-line dt-line-recv" data-line data-item="${l.item_id}">
        <p><strong>${esc(l.item)}</strong><br><span class="muted small">Diminta ${esc(withUnit(l.qty, l.unit))}, sudah ${esc(qtyText(l.received))}, sisa ${esc(qtyText(left))}</span></p>
        <label class="field"><span>Diterima</span><input type="text" inputmode="decimal" data-f="r-qty" autocomplete="off" placeholder="${esc(qtyText(left))}"></label>
        <label class="field"><span>Harga total (Rp)</span><input type="text" inputmode="numeric" data-f="r-cost" autocomplete="off"></label></div>`;
    }).join('');
    return formDialog({
      title: 'Terima barang dari PO', wide: true, submitLabel: 'Simpan penerimaan',
      html: `${sel('po', open.map((p) => [p.id, `${p.no}, ${p.supplier || 'tanpa pemasok'}`]), open[0].id, `Purchase order ${REQ}`)}
        <p class="muted small">Isi jumlah hanya untuk barang yang datang. Yang kosong dilewati, jadi penerimaan sebagian boleh.</p>
        <div class="dt-lines" data-lines>${linesFor(open[0])}</div>
        <div class="dt-fields">${inp('slip', 'Surat jalan', 'maxlength="100"')}${inp('note', 'Catatan', 'maxlength="200"')}
        ${sel('who', staffOpts(cat), mePick(cat), `Penanggung jawab ${REQ}`)}</div>`,
      onOpen: (f) => F(f, 'po').addEventListener('change', (e) => {
        const po = open.find((p) => String(p.id) === e.target.value);
        f.querySelector('[data-lines]').innerHTML = linesFor(po);
      }),
      onSubmit: async (f) => {
        const lines = $$('[data-line]', f).map((r) => ({ item: Number(r.dataset.item), qty: parseNum(r.querySelector('[data-f="r-qty"]').value), cost: parseNum(r.querySelector('[data-f="r-cost"]').value) }))
          .filter((l) => l.qty != null).map((l) => ({ item: l.item, qty: need(l.qty, 'Jumlah harus angka.'), cost: l.cost }));
        if (!lines.length) throw new Error('Isi jumlah yang diterima minimal untuk satu barang.');
        await rpc('stock_po_receive', { p_request: Number(F(f, 'po').value), p_lines: lines, p_slip: F(f, 'slip').value, p_note: F(f, 'note').value, p_responsible: F(f, 'who').value });
        toast('Penerimaan tersimpan');
      },
    });
  };
  await screen(panel, {
    title: 'Penerimaan barang', intro: 'Barang yang datang dari purchase order: nomor PO, pemasok dan harga beli. Ubah atau batalkan satu catatan dengan membukanya.',
    load: async ({ from, to }) => (await rpc('stock_goods_in_list', { p_from: from, p_to: to })).filter((g) => g.request_id),
    options: { rowKey: 'id', exportName: 'penerimaan-barang', emptyText: 'Belum ada penerimaan dari PO di rentang ini.', columns: giColumns, editLabel: 'Buka',
      searchKeys: ['item', 'supplier', 'request_no', 'responsible'], defaultSort: { key: 'day', dir: 'desc' },
      onAdd: receive, onEdit: (g) => goodsInDialog(rpc, g) },
  });
}

/* ================================================================ c. Stok masuk */
async function stokMasukPart(panel, rpc, cat) {
  // Harga pokok per barang (owner only); without it the warning below is skipped.
  const costOf = async () => { try { return Object.fromEntries((await rpc('owner_stock_recipes')).items.map((i) => [String(i.id), Number(i.unit_cost) || 0])); } catch { return null; } };
  const add = async () => { const costs = await costOf(); return formDialog({
    title: 'Catat barang masuk', submitLabel: 'Simpan barang masuk',
    html: `${sel('item', itemOpts(cat), '', `Barang ${REQ}`)}<div class="dt-fields">${inp('qty', `Jumlah ${REQ}`, 'inputmode="decimal"')}
      ${sel('supplier', [['', 'Tanpa pemasok'], ...(cat.suppliers || []).map((s) => [s.id, s.name])], '', 'Pemasok')}
      ${sel('mode', [['', 'Tanpa harga'], ['total', 'Harga total'], ['unit', 'Harga per satuan']], '', 'Harga beli')}${inp('cost', 'Harga (Rp)', 'inputmode="numeric"')}</div>
      <div class="dt-fields">${inp('slip', 'Surat jalan', 'maxlength="100"')}${inp('note', 'Catatan', 'maxlength="200"')}${sel('who', staffOpts(cat), mePick(cat), `Penanggung jawab ${REQ}`)}</div>`,
    onSubmit: async (f) => {
      const cost = parseNum(F(f, 'cost').value), mode = F(f, 'mode').value || null;
      if ((cost != null) !== (mode != null)) throw new Error('Isi pilihan harga dan angkanya, atau kosongkan keduanya.');
      const it = (cat.items || []).find((x) => String(x.id) === F(f, 'item').value);
      if (cost === 0 && warnFirst(f, 'Harga beli Rp0 membuat harga pokok barang ini turun, jadi laba di laporan terlihat lebih besar. Tekan Tetap simpan kalau barangnya memang gratis.')) return false;
      if (cost == null && costs && it && costs[String(it.id)] === 0
        && warnFirst(f, `Harga pokok ${it.name} masih Rp0 dan harga belinya kosong. Laba produk yang memakai barang ini terlihat terlalu besar. Isi harga beli, atau tekan Tetap simpan.`)) return false;
      await rpc('stock_goods_in', { p_item: Number(F(f, 'item').value), p_qty: need(parseNum(F(f, 'qty').value), 'Isi jumlahnya.'), p_note: F(f, 'note').value, p_slip: F(f, 'slip').value,
        p_responsible: F(f, 'who').value, p_request: null, p_supplier: F(f, 'supplier').value ? Number(F(f, 'supplier').value) : null, p_cost_mode: mode, p_cost: cost });
      toast('Barang masuk tercatat');
    },
  }); };
  await screen(panel, {
    title: 'Stok masuk', intro: 'Semua barang yang masuk, dengan pemasok dan harga beli. Buka satu catatan untuk mengubah jumlah atau harganya, atau membatalkannya (alasannya tercatat).',
    load: ({ from, to }) => rpc('stock_goods_in_list', { p_from: from, p_to: to }),
    options: { rowKey: 'id', exportName: 'stok-masuk', emptyText: 'Belum ada barang masuk di rentang ini.', columns: giColumns, editLabel: 'Buka',
      searchKeys: ['item', 'supplier', 'request_no', 'responsible', 'status'], defaultSort: { key: 'day', dir: 'desc' },
      onAdd: add, onEdit: (g) => goodsInDialog(rpc, g) },
  });
}

/* ================================================================ d. Stok keluar */
async function stokKeluarPart(panel, rpc, cat) {
  const add = () => formDialog({
    title: 'Catat barang keluar', submitLabel: 'Simpan',
    html: `<p class="muted small">Sampel dicatat di kasir, lewat Mode penjualan. Penjualan terhitung sendiri dari setiap pesanan.</p>
      ${sel('item', itemOpts(cat), '', `Barang ${REQ}`)}<div class="dt-fields">${sel('kind', [['buang', 'Dibuang'], ['rusak', 'Rusak'], ['promo', 'Promo']], 'buang', `Alasan ${REQ}`)}
      ${inp('qty', `Jumlah ${REQ}`, 'inputmode="decimal"')}</div>${inp('reason', 'Keterangan (wajib untuk rusak dan promo)', 'maxlength="200"')}
      ${sel('who', staffOpts(cat), mePick(cat), `Penanggung jawab ${REQ}`)}`,
    onSubmit: async (f) => {
      await rpc('stock_out', { p_item: Number(F(f, 'item').value), p_kind: F(f, 'kind').value, p_qty: need(parseNum(F(f, 'qty').value), 'Isi jumlahnya.'), p_reason: F(f, 'reason').value, p_responsible: F(f, 'who').value });
      toast('Barang keluar tercatat');
    },
  });
  await screen(panel, {
    title: 'Stok keluar', intro: 'Semua barang yang keluar: penjualan (per struk), sampel, dibuang, rusak dan promo. Tambah hanya untuk dibuang, rusak dan promo.',
    controls: `<label class="field"><span>Jenis</span><select data-c="kind"><option value="">Semua</option>${Object.entries(OUT_LABEL).filter(([k]) => k !== 'batal_penjualan').map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>`,
    load: ({ from, to, c }) => rpc('stock_out_list', { p_from: from, p_to: to, p_kind: c.kind || null }),
    options: { rowKey: 'id', exportName: 'stok-keluar', emptyText: 'Belum ada barang keluar di rentang ini.', defaultSort: { key: 'at', dir: 'desc' },
      searchKeys: ['item', 'kind', 'reason', 'receipt_no', 'responsible'], pageSize: 25,
      columns: [
        { key: 'at', label: 'Waktu', sort: true, format: (v) => when(v), export: (r) => r.at },
        { key: 'item', label: 'Barang', sort: true },
        { key: 'qty', label: 'Jumlah', sort: true, align: 'num', format: (v, r) => withUnit(v, r.unit), export: (r) => Number(r.qty) },
        { key: 'kind', label: 'Jenis', sort: true, format: (v) => OUT_LABEL[v] || v },
        { key: 'reason', label: 'Keterangan', format: (v, r) => (r.receipt_no ? `Struk ${r.receipt_no}` : v || '–'), export: (r) => r.receipt_no || r.reason || '' },
        { key: 'responsible', label: 'Penanggung jawab', sort: true, format: (v) => v || '–' },
      ],
      onAdd: add },
  });
}

/* ================================================================ e. Stok opname */
async function opnamePart(panel, rpc) {
  const open = async (row) => {
    const d = await rpc('stock_opname_detail', { p_id: row.id });
    const table = `<div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Stok sistem</th><th class="num">Stok fisik</th><th class="num">Selisih</th><th class="num">Stok aktual</th></tr></thead><tbody>
      ${d.lines.map((l) => `<tr><td>${esc(l.item)}</td><td class="num">${esc(withUnit(l.system, l.unit))}</td><td class="num">${esc(withUnit(l.physical, l.unit))}</td>
        <td class="num">${Number(l.selisih) ? tag(signed(l.selisih), Number(l.selisih) < 0 ? 'tag-bad' : 'tag-warn') : '0'}</td><td class="num">${l.actual == null ? '–' : esc(qtyText(l.actual))}</td></tr>`).join('')}</tbody></table></div>`;
    const head = `<p>${tagOf(OP_TAG, d.status)} · ${d.closing ? 'Hitungan penutupan' : 'Stok opname'} ${esc(day(d.day))}, penanggung jawab ${esc(d.responsible || '–')}</p>${d.note ? `<p>${esc(d.note)}</p>` : ''}
      ${d.decided_by ? `<p class="muted small">Diputuskan ${esc(d.decided_by)}${d.decision_note ? `: ${esc(d.decision_note)}` : ''}</p>` : ''}`;
    if (d.status !== 'menunggu' || RO) return infoDialog({ title: `Stok opname ${day(d.day)}`, wide: true, html: head + table });
    return formDialog({
      title: `Stok opname ${day(d.day)}`, wide: true, submitLabel: 'Terima hasil hitungan',
      html: `${head}${table}<p class="muted small">Diterima: selisih ditulis sebagai koreksi, jadi jumlah hitungan menjadi stok berikutnya.</p>${inp('note', 'Alasan (wajib kalau ditolak)', 'maxlength="200"')}`,
      onSubmit: async (f) => { await rpc('stock_decide_count', { p_id: d.id, p_accept: true, p_note: F(f, 'note').value }); toast('Hitungan diterima'); },
      buttons: [{ label: 'Tolak hitungan', danger: true, onClick: async (f) => { await rpc('stock_decide_count', { p_id: d.id, p_accept: false, p_note: F(f, 'note').value }); toast('Hitungan ditolak'); } }],
    });
  };
  await screen(panel, {
    title: 'Stok opname', intro: 'Riwayat hitungan stok. Yang berstatus Menunggu bisa diterima atau ditolak setelah dibuka.',
    load: ({ from, to }) => rpc('stock_opname_list', { p_from: from, p_to: to }),
    options: { rowKey: 'id', exportName: 'stok-opname', emptyText: 'Belum ada stok opname di rentang ini.', editLabel: 'Buka', defaultSort: { key: 'day', dir: 'desc' },
      searchKeys: ['day', 'status', 'responsible', 'note'],
      columns: [
        { key: 'day', label: 'Tanggal', sort: true, format: (v) => day(v), export: (r) => r.day },
        { key: 'closing', label: 'Jenis', sort: true, format: (v) => (v ? 'Penutupan' : 'Biasa') },
        { key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(OP_TAG, v), export: (r) => (OP_TAG[r.status] || [r.status])[0] },
        { key: 'responsible', label: 'Penanggung jawab', sort: true, format: (v) => v || '–' },
        { key: 'items_off', label: 'Barang selisih', sort: true, align: 'num', format: (v, r) => `${v} dari ${r.items}`, export: (r) => r.items_off },
        { key: 'selisih', label: 'Selisih', format: (v) => (v || []).map((x) => `${signed(x.qty)} ${x.unit}`).join(', ') || '0', export: (r) => (r.selisih || []).map((x) => `${signed(x.qty)} ${x.unit}`).join(', ') },
      ],
      onEdit: open, viewOnly: true },
  });
}

/* ================================================================ f. Penyesuaian stok */
async function adjustmentPart(panel, rpc, cat) {
  const add = async () => {
    const now = await rpc('stock_now');
    const qtyOf = (id) => now.find((i) => String(i.id) === String(id));
    return formDialog({
      title: 'Sesuaikan stok', submitLabel: 'Simpan penyesuaian',
      html: `${sel('item', itemOpts(cat), '', `Barang ${REQ}`)}<p class="muted small" data-now></p>
        <fieldset class="field"><legend>Cara</legend><div class="choices">
          <label class="choice"><input type="radio" name="adj-mode" value="set" checked><span>Ubah jadi jumlah hitungan</span></label>
          <label class="choice"><input type="radio" name="adj-mode" value="delta"><span>Tambah atau kurangi</span></label></div></fieldset>
        ${inp('qty', `Jumlah ${REQ}`, 'inputmode="decimal"')}<p class="muted small" data-after></p>${inp('reason', `Alasan ${REQ}`, 'maxlength="200" placeholder="Contoh: hitung ulang di rak"')}`,
      onOpen: (f) => {
        const mode = () => f.querySelector('[name="adj-mode"]:checked').value;
        const sync = () => {
          const i = qtyOf(F(f, 'item').value), q = parseNum(F(f, 'qty').value);
          f.querySelector('[data-now]').textContent = i ? `Stok sistem sekarang: ${withUnit(i.qty, i.unit)}` : '';
          f.querySelector('[data-after]').textContent = i && q != null && Number.isFinite(q) ? `Stok jadi: ${withUnit(mode() === 'set' ? q : Number(i.qty) + q, i.unit)}` : '';
        };
        f.addEventListener('input', sync); f.addEventListener('change', sync); sync();
      },
      onSubmit: async (f) => {
        const i = qtyOf(F(f, 'item').value), q = need(parseNum(F(f, 'qty').value), 'Isi jumlahnya.'), m = f.querySelector('[name="adj-mode"]:checked').value;
        if (!F(f, 'reason').value.trim()) throw new Error('Isi alasannya.');
        const after = i ? (m === 'set' ? q : Number(i.qty) + q) : null;
        if (after != null && after < 0) throw new Error(`Stok ${i.name} tidak bisa di bawah 0. Sekarang ${withUnit(i.qty, i.unit)}.`);
        // Warn before stock goes down (13 Nov 2026): one warning in the dialog, then Tetap simpan.
        if (i && after < Number(i.qty) && warnFirst(f, `Stok ${i.name} berkurang ${withUnit(Number(i.qty) - after, i.unit)}, dari ${qtyText(i.qty)} jadi ${qtyText(after)}. Kalau barangnya dibuang atau rusak, catat di Stok keluar supaya alasannya terlihat. Tekan Tetap simpan kalau sudah benar.`)) return false;
        await rpc('stock_adjust', { p_item: Number(F(f, 'item').value), p_mode: m, p_qty: q, p_reason: F(f, 'reason').value });
        toast('Stok disesuaikan');
      },
    });
  };
  await screen(panel, {
    title: 'Penyesuaian stok', intro: 'Koreksi stok ke jumlah hitungan, atau tambah dan kurangi, dengan alasan. Setiap penyesuaian tercatat di riwayat dan log.',
    load: ({ from, to }) => rpc('stock_adjust_list', { p_from: from, p_to: to }),
    options: { rowKey: 'id', exportName: 'penyesuaian-stok', emptyText: 'Belum ada penyesuaian di rentang ini.', defaultSort: { key: 'at', dir: 'desc' }, searchKeys: ['item', 'reason', 'by'],
      columns: [
        { key: 'at', label: 'Waktu', sort: true, format: (v) => when(v), export: (r) => r.at },
        { key: 'item', label: 'Barang', sort: true },
        { key: 'delta', label: 'Perubahan', sort: true, align: 'num', format: (v, r) => `${signed(v)} ${r.unit}`, export: (r) => Number(r.delta) },
        { key: 'reason', label: 'Alasan' },
        { key: 'by', label: 'Oleh', sort: true, format: (v) => v || '–' },
      ],
      onAdd: add },
  });
}

/* ================================================================ g. Proses komisi */
async function komisiPart(panel, rpc) {
  if (RO) return komisiReadOnly(panel, rpc);
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Proses komisi</h1>
      <p class="muted small">Komisi dari pesanan yang sudah dibayar, per staf yang melayani, memakai aturan di Tim > Komisi. Proses mencatat jumlahnya sekali per periode. Setelah itu tandai dibayar kalau uangnya sudah diberikan.</p></div>
    ${rangeHtml({ preset: 'bulan' })}
    <div class="notice notice-error" data-msg role="alert" hidden></div>
    <p class="muted small" data-unassigned></p><div data-prev></div></div>
    <div class="panel stack"><div class="dt-head"><h2>Riwayat proses</h2><p class="muted small">Yang sudah diproses di rentang tanggal di atas. Buka satu untuk menandai dibayar atau membatalkan prosesnya (hanya selama belum dibayar).</p></div><div data-hist></div></div>`;
  const range = () => ({ from: $('[data-from]', panel).value, to: $('[data-to]', panel).value });
  const say = (m) => { const b = $('[data-msg]', panel); b.textContent = m || ''; b.hidden = !m; };
  const payStatus = (r) => (r.payout_id ? (r.payout_paid ? ['Sudah dibayar', 'tag-ok'] : ['Sudah diproses', 'tag-warn']) : ['Belum diproses', '']);
  const loadPrev = async () => {
    const { from, to } = range();
    const d = await rpc('pos_commission_preview', { p_from: from, p_to: to });
    $('[data-unassigned]', panel).textContent = d.unassigned ? `${d.unassigned} pesanan di rentang ini tanpa staf yang melayani, jadi tidak dihitung.` : '';
    return d.rows;
  };
  const loadHist = async () => { const { from, to } = range(); return rpc('pos_commission_payouts', { p_from: from, p_to: to }); };
  const total = (rows) => rows.reduce((s, r) => s + r.commission, 0);
  const processDialog = (rows, all) => {
    const { from, to } = range();
    const todo = rows.filter((r) => !r.payout_id && r.commission > 0);
    if (!todo.length) throw new Error('Tidak ada komisi yang belum diproses di pilihan ini.');
    return formDialog({
      title: 'Proses komisi', submitLabel: 'Proses',
      html: `<p>Periode ${esc(day(from))} sampai ${esc(day(to))}. Yang diproses:</p><ul class="dt-list">${todo.map((r) => `<li>${esc(r.name)}: ${esc(rupiah(r.commission))}</li>`).join('')}</ul>
        <p><strong>Total ${esc(rupiah(total(todo)))}</strong></p><p class="muted small">Angkanya dihitung ulang oleh server saat diproses. Periode dan staf yang sama hanya bisa diproses sekali.</p>${inp('note', 'Catatan', 'maxlength="200"')}`,
      onSubmit: async (f) => {
        const r = await rpc('pos_commission_process', { p_from: from, p_to: to, p_staff: all ? null : todo.map((x) => x.staff_id), p_note: F(f, 'note').value });
        toast(`${r.processed} staf diproses, ${rupiah(r.total)}`);
      },
    });
  };
  const payout = (p) => {
    const info = `<dl class="kv"><dt>Staf</dt><dd>${esc(p.name)}</dd><dt>Periode</dt><dd>${esc(day(p.period_from))} sampai ${esc(day(p.period_to))}</dd><dt>Pesanan</dt><dd>${esc(p.orders)}</dd>
      <dt>Penjualan</dt><dd>${esc(rupiah(p.sales))}</dd><dt>Komisi</dt><dd><strong>${esc(rupiah(p.commission))}</strong></dd><dt>Diproses</dt><dd>${esc(p.processed_by || '–')}, ${esc(when(p.processed_at))}</dd>
      ${p.paid_at ? `<dt>Dibayar</dt><dd>${esc(when(p.paid_at))}${p.paid_by ? `, ${esc(p.paid_by)}` : ''}</dd>` : ''}${p.note ? `<dt>Catatan</dt><dd>${esc(p.note)}</dd>` : ''}
      ${p.cancelled_at ? `<dt>Dibatalkan</dt><dd>${esc(when(p.cancelled_at))}: ${esc(p.cancel_reason || '')}</dd>` : ''}</dl>`;
    if (p.status !== 'diproses') return infoDialog({ title: `Komisi ${p.name}`, html: info });
    return formDialog({
      title: `Komisi ${p.name}`, submitLabel: 'Tandai dibayar',
      html: `${info}${inp('note', 'Catatan pembayaran / alasan batal', 'maxlength="200" placeholder="Contoh: transfer BCA"')}`,
      onSubmit: async (f) => { await rpc('pos_commission_mark_paid', { p_id: p.id, p_note: F(f, 'note').value }); toast('Ditandai dibayar'); },
      buttons: [{ label: 'Batalkan proses', danger: true, onClick: async (f) => {
        if (!F(f, 'note').value.trim()) throw new Error('Tulis alasan pembatalan di kolom catatan.');
        await rpc('pos_commission_cancel', { p_id: p.id, p_reason: F(f, 'note').value }); toast('Proses dibatalkan');
      } }],
    });
  };
  let prev, hist, prevRows = [];
  const reloadBoth = async () => { say(''); try { prevRows = await loadPrev(); prev.setRows(prevRows); hist.setRows(await loadHist()); } catch (e) { say(e.message); } };
  let rows0, hist0;
  try { [rows0, hist0] = [await loadPrev(), await loadHist()]; } catch (e) { say(e.message); rows0 = []; hist0 = []; }
  prevRows = rows0;
  prev = dataTable($('[data-prev]', panel), {
    rows: rows0, rowKey: 'staff_id', selectable: true, exportName: 'komisi', pageSize: 15, emptyText: 'Tidak ada pesanan yang dibayar di rentang ini.', defaultSort: { key: 'commission', dir: 'desc' },
    columns: [
      { key: 'name', label: 'Staf', sort: true },
      { key: 'orders', label: 'Pesanan', sort: true, align: 'num' },
      { key: 'sales', label: 'Penjualan', sort: true, align: 'num', format: (v) => rupiah(v), export: (r) => r.sales },
      { key: 'commission', label: 'Komisi', sort: true, align: 'num', format: (v) => rupiah(v), export: (r) => r.commission },
      { key: 'payout_id', label: 'Status', sort: (r) => (r.payout_id ? (r.payout_paid ? 2 : 1) : 0), html: true, format: (v, r) => tag(payStatus(r)[0], payStatus(r)[1]), export: (r) => payStatus(r)[0] },
    ],
    extraActions: [
      { label: 'Proses yang dipilih', primary: true, needsSelection: true, onClick: async (sel0) => { await processDialog(sel0, false); await reloadBoth(); } },
      { label: 'Proses semua', onClick: async () => { await processDialog(prevRows, true); await reloadBoth(); } },
    ],
  });
  hist = dataTable($('[data-hist]', panel), {
    rows: hist0, rowKey: 'id', editLabel: 'Buka', exportName: 'riwayat-komisi', pageSize: 15, emptyText: 'Belum ada komisi yang diproses di rentang ini.', defaultSort: { key: 'id', dir: 'desc' },
    columns: [
      { key: 'name', label: 'Staf', sort: true },
      { key: 'period_from', label: 'Periode', sort: true, format: (v, r) => `${day(v)} – ${day(r.period_to)}`, export: (r) => `${r.period_from} – ${r.period_to}` },
      { key: 'orders', label: 'Pesanan', sort: true, align: 'num' },
      { key: 'commission', label: 'Komisi', sort: true, align: 'num', format: (v) => rupiah(v), export: (r) => r.commission },
      { key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(PAY_TAG, v), export: (r) => (PAY_TAG[r.status] || [r.status])[0] },
      { key: 'processed_at', label: 'Diproses', sort: true, format: (v) => when(v), export: (r) => r.processed_at },
    ],
    onEdit: async (p) => { await payout(p); await reloadBoth(); },
  });
  wireRange(panel, { onChange: reloadBoth });
}

// A manager sees what was processed and paid; processing and paying stay with the owner.
async function komisiReadOnly(panel, rpc) {
  await screen(panel, {
    title: 'Proses komisi', intro: 'Komisi yang sudah diproses dan statusnya. Hanya untuk dilihat: pemilik yang memproses dan menandai dibayar.',
    load: ({ from, to }) => rpc('pos_commission_payouts', { p_from: from, p_to: to }),
    options: { rowKey: 'id', exportName: 'riwayat-komisi', pageSize: 15, emptyText: 'Belum ada komisi yang diproses di rentang ini.', defaultSort: { key: 'id', dir: 'desc' },
      columns: [
        { key: 'name', label: 'Staf', sort: true },
        { key: 'period_from', label: 'Periode', sort: true, format: (v, r) => `${day(v)} – ${day(r.period_to)}`, export: (r) => `${r.period_from} – ${r.period_to}` },
        { key: 'orders', label: 'Pesanan', sort: true, align: 'num' },
        { key: 'commission', label: 'Komisi', sort: true, align: 'num', format: (v) => rupiah(v), export: (r) => r.commission },
        { key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(PAY_TAG, v), export: (r) => (PAY_TAG[r.status] || [r.status])[0] },
        { key: 'processed_at', label: 'Diproses', sort: true, format: (v) => when(v), export: (r) => r.processed_at },
      ] },
  });
}

/* ================================================================ h. Pembatalan penjualan */
async function pembatalanPart(panel, rpc) {
  const KIND = { batal: 'Batal', refund: 'Refund' };
  const open = async (v) => {
    let lines = '';
    try {
      const d = await rpc('owner_pos_order', { p_id: v.order_id });
      lines = `<div class="table-wrap"><table><thead><tr><th>Produk</th><th class="num">Jumlah</th><th class="num">Subtotal</th></tr></thead><tbody>
        ${(d.receipt?.lines || []).map((x) => `<tr><td>${esc(x.name)}${x.flavour ? ` ${esc(x.flavour)}` : ''}</td><td class="num">${esc(x.qty)}</td><td class="num">${esc(rupiah(x.line_total - (x.discount || 0)))}</td></tr>`).join('')}</tbody></table></div>`;
    } catch { lines = ''; }
    return infoDialog({
      title: `Struk ${v.receipt_no}`, wide: true,
      html: `<dl class="kv"><dt>Jenis</dt><dd>${esc(KIND[v.kind] || v.kind)}${v.whole === false ? ' sebagian' : ''}</dd><dt>Jumlah</dt><dd>${esc(rupiah(v.amount))}${v.method ? ` · ${esc(v.method)}` : ''}</dd><dt>Dijual</dt><dd>${esc(when(v.sold_at))}</dd>
        <dt>Alasan</dt><dd>${esc(v.reason || '–')}</dd><dt>Diminta</dt><dd>${esc(v.asked_by || '–')}, ${esc(when(v.asked_at || v.at))}</dd>
        <dt>Diputuskan</dt><dd>${v.decided_by ? `${esc(v.decided_by)}, ${esc(when(v.decided_at))}` : '–'}</dd><dt>Status</dt><dd>${tagOf(VOID_TAG, v.status)}</dd></dl>${lines}
        ${RO ? '' : `<p><a href="#pesanan">Buka di Pesanan</a> <span class="muted small">dan cari ${esc(v.receipt_no)} untuk isi lengkap dan struknya.</span></p>`}`,
    });
  };
  await screen(panel, {
    title: 'Pembatalan penjualan', intro: 'Setiap permintaan batal atau refund, dan pesanan yang dibatalkan. Hanya untuk dilihat. Keputusannya ada di Persetujuan di kasir. Yang sudah diputuskan tercatat di tanggal keputusannya, tanggal yang sama dengan pengurangannya di laporan.',
    load: ({ from, to }) => rpc('pos_void_overview', { p_from: from, p_to: to }),
    options: { rowKey: 'key', exportName: 'pembatalan-penjualan', emptyText: 'Tidak ada pembatalan di rentang ini.', editLabel: 'Lihat', defaultSort: { key: 'at', dir: 'desc' },
      searchKeys: ['receipt_no', 'reason', 'asked_by', 'decided_by', 'kind', 'status'],
      columns: [
        { key: 'receipt_no', label: 'No. struk', sort: true },
        { key: 'at', label: 'Tanggal', sort: true, format: (v) => when(v), export: (r) => r.at },
        { key: 'kind', label: 'Jenis', sort: true, format: (v, r) => (KIND[v] || v) + (r.whole === false ? ' sebagian' : '') },
        { key: 'method', label: 'Uang kembali lewat', sort: true, format: (v) => v || '–' },
        { key: 'amount', label: 'Jumlah', sort: true, align: 'num', format: (v) => rupiah(v), export: (r) => r.amount },
        { key: 'reason', label: 'Alasan', format: (v) => v || '–' },
        { key: 'asked_by', label: 'Diminta', sort: true, format: (v) => v || '–' },
        { key: 'decided_by', label: 'Diputuskan', sort: true, format: (v) => v || '–' },
        { key: 'status', label: 'Status', sort: true, html: true, format: (v) => tagOf(VOID_TAG, v), export: (r) => (VOID_TAG[r.status] || [r.status])[0] },
      ],
      onEdit: open, viewOnly: true },
  });
}

const PARTS = { po: poPart, penerimaan: penerimaanPart, 'stok-masuk': stokMasukPart, 'stok-keluar': stokKeluarPart, opname: opnamePart,
  adjustment: adjustmentPart, 'komisi-proses': komisiPart, pembatalan: pembatalanPart };
