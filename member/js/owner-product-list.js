// Owner "Daftar produk" (Glenn, 12 Nov 2026): the product list as one VireoPOS-style table.
// Top: + Tambah on the left; Impor, Ekspor and Hapus on the right. Search with a column picker,
// sortable headers. Clicking a row opens the product with every detail and action (price,
// flavour surcharge, category, on/off, Di kasir, delivery prices, order, recipe, archive).
// Hapus never deletes: it archives, so the sales history stays (Kembalikan under "Arsip").
// Impor reads the same columns Ekspor writes: rows with a known Kode update that product,
// rows without one add a new product. Everything is shown first and only saved on "Simpan".
import { $, $$, esc, rupiah, toast } from './lib.js';
import { dataTable, formDialog, confirmDialog, loadSheetJS, warnFirst } from './data-table.js';

// Empty is null; text without a digit ("abc") is NaN, so it is refused instead of saved as Rp0.
const intOrNull = (v) => (String(v ?? '').trim() === '' ? null : /\d/.test(String(v)) ? Math.round(Number(String(v).replace(/[^\d-]/g, ''))) : NaN);
const yes = (v) => /^(y|ya|yes|1|true|aktif)$/i.test(String(v ?? '').trim());
const yn = (b) => (b ? 'Ya' : 'Tidak');
let justAdded = null; // name of the product added last, for the note about its recipe

export async function productList(p, { call, d, again }) {
  const cats = d.categories || [];
  const live = d.channels.filter((c) => c.delivery && c.active);
  // The recipe column ("Komponen" in VireoPOS) is a bonus: the page works without it.
  let recipe = null;
  try { recipe = await call('owner_stock_recipes'); } catch { recipe = null; }
  const itemName = (id) => recipe?.items.find((i) => i.id === id);
  const linesOf = (code) => (recipe?.lines || []).filter((l) => l.product === code);
  // Harga pokok of one unit, plain flavour (Vanilla) or no flavour: recipe lines x harga pokok per barang.
  const costOf = (m) => {
    if (!recipe) return null;
    const ls = linesOf(m.code), base = ls.filter((l) => !l.flavour || l.flavour === 'vanilla');
    return Math.round((base.length ? base : ls).reduce((s, l) => s + Number(l.qty) * (Number(itemName(l.item_id)?.unit_cost) || 0), 0));
  };

  const shown = d.products.filter((m) => !m.archived), archived = d.products.filter((m) => m.archived);
  const catName = (id) => cats.find((c) => c.id === id)?.name || 'Tanpa kategori';
  const rows = shown.map((m) => {
    const inCat = shown.filter((x) => x.category_id === m.category_id);
    return { ...m, cat: catName(m.category_id), order: inCat.indexOf(m) + 1, of: inCat.length,
      parts: recipe ? new Set(linesOf(m.code).map((l) => l.item_id)).size : null, cost: costOf(m) };
  });
  const catOptions = (sel) => cats.map((c) => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}${c.active ? '' : ' (mati)'}</option>`).join('');

  p.innerHTML = `<section class="panel stack" aria-labelledby="pr-title">
    <h1 id="pr-title">Daftar produk</h1>
    <p class="muted small">Harga ini yang dipakai kasir dan tercetak di struk. Klik produk untuk mengubah harga, kategori, urutan, harga per saluran, atau mengarsipkannya.</p>
    ${justAdded ? `<div class="notice notice-ok" role="status">${esc(justAdded)} sudah ditambahkan. Atur resepnya di Stok, Resep produk supaya stok berkurang setiap kali terjual. Selama resepnya kosong, penjualannya tidak mengurangi stok.</div>` : ''}
    <div id="pl"></div>
    ${archived.length ? `<details class="stack-sm"><summary>Arsip (${archived.length})</summary>
      <ul class="list">${archived.map((m) => `<li><span class="grow">${esc(m.pos_name)} <span class="muted small">${m.archived_at ? `diarsipkan ${esc(new Date(m.archived_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }))}` : ''}</span></span>
        <button class="btn btn-quiet" type="button" data-unarchive="${esc(m.code)}">Kembalikan</button></li>`).join('')}</ul></details>` : ''}
  </section>`;
  justAdded = null;

  dataTable($('#pl', p), {
    rows, rowKey: 'code', exportName: 'daftar-produk', pageSize: 25, editLabel: 'Detail',
    emptyText: 'Belum ada produk. Tambah produk pertama dengan + Tambah.',
    rowName: (r) => r.pos_name,
    columns: [
      { key: 'pos_name', label: 'Nama', sort: true },
      { key: 'code', label: 'Kode', sort: true },
      { key: 'price', label: 'Harga', sort: true, align: 'num', format: (v) => rupiah(v), export: (r) => r.price },
      { key: 'cat', label: 'Kategori', sort: true },
      { key: 'flavour_surcharge', label: 'Tambahan rasa', sort: true, align: 'num',
        format: (v, r) => (r.needs_flavour ? rupiah(v || 0) : 'Tanpa rasa'), export: (r) => (r.needs_flavour ? r.flavour_surcharge || 0 : '') },
      ...(recipe ? [{ key: 'parts', label: 'Resep', sort: true, format: (v) => (v ? `${v} barang` : 'Belum ada'), export: (r) => r.parts },
        { key: 'cost', label: 'Harga pokok', sort: true, align: 'num', html: true, format: (v) => (v ? esc(rupiah(v)) : '<span class="tag tag-warn">Rp0</span>'), export: (r) => r.cost }] : []),
      { key: 'active', label: 'Dijual', sort: (r) => (r.active ? 0 : 1), format: (v) => yn(v), export: (r) => yn(r.active) },
      { key: 'on_till', label: 'Di kasir', sort: (r) => (r.on_till !== false ? 0 : 1), format: (v) => yn(v !== false), export: (r) => yn(r.on_till !== false) },
      { key: 'order', label: 'Urutan', sort: (r) => `${String(cats.findIndex((c) => c.id === r.category_id) + 1).padStart(3, '0')}-${String(r.order).padStart(3, '0')}`, align: 'num' },
    ],
    searchKeys: ['pos_name', 'code', 'cat'],
    onAdd: addProduct,
    onEdit: openProduct,
    onImport: importFile,
    onDelete: archiveMany,
    deleteHelp: 'Produk tidak benar-benar dihapus: produk diarsipkan, dimatikan dan keluar dari daftar ini serta kasir. Riwayat penjualannya tetap, dan bisa dikembalikan dari Arsip di bawah tabel. Paper bag tidak bisa diarsipkan.',
  });

  $$('[data-unarchive]', p).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await call('owner_archive_pos_product', { p_code: b.dataset.unarchive, p_archive: false }); toast('Produk kembali di daftar, masih nonaktif'); again(); }
    catch (err) { b.disabled = false; toast(err.message); }
  }));

  /* ------------------------------------------------------------ Tambah */
  async function addProduct() {
    const ok = await formDialog({
      title: 'Tambah produk', submitLabel: 'Tambah produk',
      html: `<p class="muted small">Produk baru langsung muncul di kasir, paling akhir di kategorinya.</p>
        <div class="form-grid">
          <label class="field"><span>Nama produk</span><input name="name" type="text" maxlength="40" required placeholder="Misalnya Pistachoux 1 pcs"></label>
          <label class="field"><span>Kategori</span><select name="cat" required>${catOptions(cats.find((c) => c.active)?.id)}</select></label>
          <label class="field"><span>Harga (Rp)</span><input name="price" type="number" inputmode="numeric" min="0" step="500" required></label>
        </div>
        <label class="check"><input type="checkbox" name="flavour" checked><span>Perlu pilih rasa</span></label>
        <div class="form-grid" data-sur><label class="field"><span>Tambahan rasa selain Vanilla (Rp)</span><input name="sur" type="number" inputmode="numeric" min="0" step="500" value="0"></label></div>
        <label class="check"><input type="checkbox" name="box"><span>Produk box <span class="muted">(dihitung untuk paper bag gratis, 1 untuk setiap 2 box)</span></span></label>
        <label class="check"><input type="checkbox" name="active" checked><span>Aktif, langsung dijual di kasir</span></label>`,
      onOpen: (f) => { const sync = () => { $('[data-sur]', f).hidden = !f.flavour.checked; }; f.flavour.addEventListener('change', sync); sync(); },
      onSubmit: async (f) => {
        const name = f.name.value.trim(), price = intOrNull(f.price.value), cat = intOrNull(f.cat.value);
        const sur = f.flavour.checked ? intOrNull(f.sur.value) ?? 0 : 0;
        if (!name) throw new Error('Isi nama produk.');
        if (cat == null) throw new Error('Pilih kategori. Tambahkan kategori dulu di menu Kategori.');
        if (!(price >= 0)) throw new Error('Isi harga dengan angka.');
        if (!(sur >= 0)) throw new Error('Tambahan rasa diisi angka, tidak boleh minus.');
        await call('owner_add_pos_product', { p_name: name, p_category_id: cat, p_price: price, p_needs_flavour: f.flavour.checked,
          p_flavour_surcharge: sur, p_is_box: f.box.checked, p_active: f.active.checked });
        justAdded = name;
      },
    });
    if (ok) { toast(`${justAdded} ditambahkan`); again(); }
  }

  /* ------------------------------------------------------------ Detail */
  async function openProduct(m) {
    const recipeHtml = !recipe ? '' : (() => {
      const ls = linesOf(m.code);
      if (!ls.length) return '<p class="muted small">Belum ada resep. Penjualannya tidak mengurangi stok sampai resepnya diatur di Stok, Resep produk.</p>';
      const label = (fid) => (fid ? recipe.flavours.find((f) => f.id === fid)?.label || fid : 'Semua rasa');
      return `<div class="table-wrap"><table><thead><tr><th>Barang</th><th>Untuk</th><th class="num">Jumlah</th></tr></thead><tbody>
        ${ls.map((l) => { const it = itemName(l.item_id); return `<tr><td>${esc(it?.name || l.item_id)}</td><td>${esc(label(l.flavour))}</td><td class="num">${esc(l.qty)} ${esc(it?.unit || '')}</td></tr>`; }).join('')}
        </tbody></table></div><p class="muted small">Resep diubah di Stok, Resep produk.</p>`;
    })();
    let moved = false;
    const ok = await formDialog({
      title: m.pos_name, wide: true,
      html: `<p class="muted small">Kode ${esc(m.code)} · ${m.needs_flavour ? 'pakai pilihan rasa' : 'tanpa rasa'} · ${m.is_box ? 'produk box' : 'bukan box'} · ${m.sold ? 'sudah pernah terjual' : 'belum pernah terjual'}</p>
        <div class="form-grid">
          <label class="field"><span>Nama di kasir</span><input name="name" type="text" maxlength="40" required value="${esc(m.pos_name)}"></label>
          <label class="field"><span>Kategori</span><select name="cat">${m.category_id == null ? '<option value="" selected>Pilih kategori</option>' : ''}${catOptions(m.category_id)}</select></label>
          <label class="field"><span>Harga (Rp)</span><input name="price" type="number" inputmode="numeric" min="0" step="500" value="${m.price}"></label>
          ${m.needs_flavour ? `<label class="field"><span>Tambahan rasa selain Vanilla (Rp)</span><input name="sur" type="number" inputmode="numeric" min="0" step="500" value="${m.flavour_surcharge ?? 0}"></label>` : ''}
          ${live.map((c) => `<label class="field"><span>Harga di ${esc(c.label)} (Rp)</span><input data-ch="${esc(c.id)}" type="number" inputmode="numeric" min="0" step="500" value="${m.channel_prices[c.id] ?? ''}" placeholder="${m.price}"></label>`).join('')}
        </div>
        ${live.length ? '<p class="muted small">Harga saluran yang dikosongkan berarti harga menu.</p>' : ''}
        <label class="check"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}><span>Dijual (aktif)</span></label>
        <label class="check"><input type="checkbox" name="till" ${m.on_till !== false ? 'checked' : ''}><span>Tampil di kasir <span class="muted">(matikan untuk menyembunyikan dari kasir tanpa mematikan produknya)</span></span></label>
        <div class="row"><span class="muted small">Urutan di kasir: ${m.order} dari ${m.of} di ${esc(m.cat)}</span>
          <button class="btn btn-quiet" type="button" data-dir="-1" ${m.order === 1 ? 'disabled' : ''}>Naikkan</button>
          <button class="btn btn-quiet" type="button" data-dir="1" ${m.order === m.of ? 'disabled' : ''}>Turunkan</button></div>
        ${recipe ? `<h3>Resep</h3>${recipeHtml}` : ''}`,
      onOpen: (f) => $$('[data-dir]', f).forEach((b) => b.addEventListener('click', async () => {
        b.disabled = true;
        try { await call('owner_move_pos_product', { p_code: m.code, p_dir: Number(b.dataset.dir) }); moved = true; toast('Urutan diubah'); f.closest('dialog').close(); }
        catch (err) { b.disabled = false; toast(err.message); }
      })),
      buttons: m.code === 'bag' ? [] : [{ label: 'Arsipkan', danger: true, onClick: async () => {
        const sure = await confirmDialog({ title: `Arsipkan ${m.pos_name}?`, confirmLabel: 'Arsipkan', danger: true,
          text: 'Produk dimatikan dan keluar dari daftar. Riwayat penjualannya tetap, dan bisa dikembalikan dari Arsip.' });
        if (!sure) return false;
        await call('owner_archive_pos_product', { p_code: m.code, p_archive: true });
        toast(`${m.pos_name} diarsipkan`);
      } }],
      onSubmit: async (f) => {
        const price = intOrNull(f.price.value), sur = f.sur ? intOrNull(f.sur.value) : m.flavour_surcharge;
        const name = f.name.value.trim(), cat = intOrNull(f.cat.value);
        if (!name) throw new Error('Isi nama produk.');
        if (!(price >= 0)) throw new Error('Isi harga dengan angka.');
        if (sur != null && !(sur >= 0)) throw new Error('Tambahan rasa diisi angka, tidak boleh minus.');
        if (cat == null) throw new Error('Pilih kategori.');
        // Harga pokok Rp0 on a product that is sold (13 Nov 2026): warn once, then Tetap simpan.
        if (f.active.checked && costOf(m) === 0 && m.code !== 'bag'
          && warnFirst(f, `Harga pokok ${name} masih Rp0${linesOf(m.code).length ? ', karena barang di resepnya belum punya harga pokok' : ', karena resepnya belum diisi'}. Laba produk ini akan terlihat 100%. Isi di Stok, Resep produk dan Barang dan harga pokok, atau tekan Tetap simpan.`)) return false;
        await saveProduct(m, { name, cat, price, sur, active: f.active.checked, till: f.till.checked,
          channels: $$('[data-ch]', f).map((i) => [i.dataset.ch, intOrNull(i.value)]) });
        toast(`${name} tersimpan`);
      },
    });
    if (ok || moved) again();
  }

  // One save path for the detail dialog and Impor. Move the category first, so a product
  // switched on lands in its new (active) category.
  async function saveProduct(m, v) {
    if (v.cat != null && v.cat !== m.category_id) await call('owner_set_product_category', { p_code: m.code, p_category_id: v.cat });
    if (v.price !== m.price || (v.sur ?? 0) !== (m.flavour_surcharge ?? 0) || v.active !== m.active)
      await call('owner_save_pos_product', { p_code: m.code, p_price: v.price, p_flavour_surcharge: v.sur ?? 0, p_active: v.active });
    if (v.name && v.name !== m.pos_name) await call('owner_rename_pos_product', { p_code: m.code, p_pos_name: v.name });
    if (v.till !== (m.on_till !== false)) await call('owner_set_product_till', { p_code: m.code, p_on: v.till });
    for (const [ch, price] of v.channels || []) {
      if ((price ?? null) !== (m.channel_prices[ch] ?? null)) await call('owner_save_channel_price', { p_channel: ch, p_code: m.code, p_price: price });
    }
  }

  /* ------------------------------------------------------------ Hapus = arsip */
  async function archiveMany(list) {
    const errs = [];
    for (const m of list) {
      try { await call('owner_archive_pos_product', { p_code: m.code, p_archive: true }); }
      catch (err) { errs.push(`${m.pos_name}: ${err.message}`); }
    }
    if (list.length > errs.length) toast(`${list.length - errs.length} produk diarsipkan`);
    again();
    if (errs.length) throw new Error(errs.join(' '));
  }

  /* ------------------------------------------------------------ Impor */
  function pickFile() {
    return new Promise((resolve) => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = '.xlsx,.xls,.csv';
      i.addEventListener('change', () => resolve(i.files[0] || null));
      i.addEventListener('cancel', () => resolve(null)); // closing the file picker without a file
      i.click();
    });
  }
  async function importFile() {
    const file = await pickFile();
    if (!file) return;
    await loadSheetJS();
    const wb = window.XLSX.read(await file.arrayBuffer());
    const table = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    const head = (table[0] || []).map((h) => String(h).trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    if (col('nama') < 0 || col('harga') < 0) throw new Error('File tidak dikenali. Pakai file dari Ekspor: kolom Nama dan Harga wajib ada.');
    const get = (r, name) => (col(name) < 0 ? undefined : r[col(name)]);
    const plan = [], skipped = [];
    table.slice(1).forEach((r, n) => {
      const line = n + 2, name = String(get(r, 'nama') ?? '').trim(), code = String(get(r, 'kode') ?? '').trim();
      if (!name && !code) return;
      const price = intOrNull(get(r, 'harga'));
      const catTxt = String(get(r, 'kategori') ?? '').trim();
      const cat = catTxt ? cats.find((c) => c.name.toLowerCase() === catTxt.toLowerCase()) : null;
      if (catTxt && !cat) return skipped.push(`Baris ${line}: kategori "${catTxt}" belum ada. Tambahkan dulu di menu Kategori.`);
      if (price == null || Number.isNaN(price) || price < 0) return skipped.push(`Baris ${line}: harga tidak valid.`);
      const surRaw = get(r, 'tambahan rasa'), sur = intOrNull(surRaw);
      if (sur != null && !(sur >= 0)) return skipped.push(`Baris ${line}: tambahan rasa tidak valid.`);
      const m = code ? d.products.find((x) => x.code === code) : null;
      if (code && !m) return skipped.push(`Baris ${line}: kode ${code} tidak dikenal. Kosongkan kodenya untuk menambah produk baru.`);
      if (m) {
        const v = { name: name || m.pos_name, cat: cat?.id ?? m.category_id, price, sur: m.needs_flavour ? (sur ?? m.flavour_surcharge) : m.flavour_surcharge,
          active: get(r, 'dijual') === undefined ? m.active : yes(get(r, 'dijual')),
          till: get(r, 'di kasir') === undefined ? m.on_till !== false : yes(get(r, 'di kasir')) };
        const diff = [];
        if (v.name !== m.pos_name) diff.push(`nama jadi ${v.name}`);
        if (v.price !== m.price) diff.push(`harga ${rupiah(m.price)} → ${rupiah(v.price)}`);
        if ((v.sur ?? 0) !== (m.flavour_surcharge ?? 0)) diff.push(`tambahan rasa ${rupiah(m.flavour_surcharge || 0)} → ${rupiah(v.sur || 0)}`);
        if (v.cat !== m.category_id) diff.push(`kategori jadi ${catName(v.cat)}`);
        if (v.active !== m.active) diff.push(v.active ? 'dijual' : 'tidak dijual');
        if (v.till !== (m.on_till !== false)) diff.push(v.till ? 'tampil di kasir' : 'disembunyikan dari kasir');
        if (diff.length) plan.push({ kind: 'ubah', label: `${m.pos_name}: ${diff.join(', ')}`, run: () => saveProduct(m, v) });
      } else {
        if (!name) return skipped.push(`Baris ${line}: nama kosong.`);
        if (!cat) return skipped.push(`Baris ${line}: isi kategori untuk produk baru.`);
        const flavour = String(surRaw ?? '').trim() !== '';
        plan.push({ kind: 'baru', label: `${name}, ${catName(cat.id)}, ${rupiah(price)}${flavour ? `, rasa +${rupiah(sur || 0)}` : ', tanpa rasa'}`,
          run: () => call('owner_add_pos_product', { p_name: name, p_category_id: cat.id, p_price: price, p_needs_flavour: flavour,
            p_flavour_surcharge: flavour ? sur || 0 : 0, p_is_box: false, p_active: get(r, 'dijual') === undefined ? true : yes(get(r, 'dijual')) }) });
      }
    });
    const list = (arr) => `<ul class="dt-list">${arr.slice(0, 30).map((t) => `<li>${esc(t)}</li>`).join('')}${arr.length > 30 ? `<li>dan ${arr.length - 30} lainnya</li>` : ''}</ul>`;
    const ubah = plan.filter((x) => x.kind === 'ubah'), baru = plan.filter((x) => x.kind === 'baru');
    let done = 0;
    const ok = await formDialog({
      title: `Impor ${file.name}`, wide: true, submitLabel: plan.length ? `Simpan ${plan.length} perubahan` : 'Tutup',
      html: `${!plan.length ? '<p>Tidak ada perubahan: isi file sama dengan daftar produk sekarang.</p>' : ''}
        ${ubah.length ? `<h3>Diubah (${ubah.length})</h3>${list(ubah.map((x) => x.label))}` : ''}
        ${baru.length ? `<h3>Produk baru (${baru.length})</h3>${list(baru.map((x) => x.label))}<p class="muted small">Produk baru dibuat sebagai produk bukan box. Atur resepnya di Stok, Resep produk.</p>` : ''}
        ${skipped.length ? `<h3>Dilewati (${skipped.length})</h3>${list(skipped)}` : ''}`,
      onSubmit: async () => {
        for (const x of plan.slice(done)) { await x.run(); done += 1; }
      },
    });
    if (ok && done) { toast(`${done} perubahan dari file tersimpan`); again(); }
  }
}
