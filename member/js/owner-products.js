// Owner "Produk" tab, the till's back office: categories, products (add, edit, order),
// prices, flavour surcharge, flavours, delivery channels and the daily target shown on the
// till's home screen.
// Mounted by owner.js: mountProducts(panel, { rpc, part }). Each owner menu item shows one
// part (Glenn, 12 Nov: one feature per view): 'produk' (the table in owner-product-list.js, the default),
// 'kategori', 'rasa', 'target' or 'saluran'.
import { $, $$, esc, rupiah, busy, toast, notice } from './lib.js';
import { productList } from './owner-product-list.js';

const intOrNull = (v) => (String(v).trim() === '' ? null : Math.round(Number(v)));

export async function mountProducts(p, { rpc: call, part = 'produk' }) {
  const again = () => mountProducts(p, { rpc: call, part });
  const is = (k) => part === k;
  p.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton" style="height:96px"></div><div class="skeleton"></div></div>';
  let d;
  try { d = await call('owner_pos_products'); } catch (e) {
    p.innerHTML = `<div class="panel stack"><div class="notice notice-error" role="alert">${esc(e.message)}</div><button class="btn btn-quiet" type="button">Coba lagi</button></div>`;
    $('button', p).addEventListener('click', again);
    return;
  }
  // Daftar produk (Glenn, 12 Nov 2026): a VireoPOS-style table; a row opens the product.
  if (is('produk')) return productList(p, { call, d, again });
  // The daily target lives in pos-home.sql; before that file has run the box stays hidden.
  let target = null;
  if (is('target')) { try { target = (await call('pos_home')).target; } catch { target = null; } }
  const cats = d.categories || [];
  const delivery = d.channels.filter((c) => c.delivery);
  const live = delivery.filter((c) => c.active);

  const orderCell = (label, i, n, attr) => `<td><div class="row" style="flex-wrap:nowrap">
      <button class="btn btn-quiet" type="button" ${attr} data-dir="-1" aria-label="Naikkan ${esc(label)}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn btn-quiet" type="button" ${attr} data-dir="1" aria-label="Turunkan ${esc(label)}" ${i === n - 1 ? 'disabled' : ''}>↓</button></div></td>`;

  const catRows = cats.map((c, i) => `<tr data-cat="${c.id}">
    ${orderCell(c.name, i, cats.length, `data-cmove="${c.id}"`)}
    <td><input type="text" maxlength="30" value="${esc(c.name)}" aria-label="Nama kategori ${esc(c.name)}"></td>
    <td class="num">${c.products}</td>
    <td><label class="check"><input type="checkbox" data-f="cat-active" ${c.active ? 'checked' : ''}><span>Aktif</span></label></td>
    <td><button class="btn btn-quiet" type="button" data-cat-save>Simpan nama</button><div class="small" data-state role="status"></div></td></tr>`).join('');

  const targetBox = !is('target') ? '' : !target ? `<section class="panel stack"><h1>Target harian</h1>
    <p class="muted">Target harian aktif setelah pos-home.sql dijalankan di Supabase.</p></section>` : `
  <section class="panel stack" aria-labelledby="tg-title">
    <h1 id="tg-title">Target harian</h1>
    <p class="muted small">Tampil di layar utama kasir sebagai persen tercapai. Target produk menghitung semua produk terjual, paper bag tidak dihitung.</p>
    <form id="tg" class="stack" novalidate>
      <fieldset class="field"><legend>Hitung target dari</legend>
        <div class="choices">${[['produk', 'Jumlah produk'], ['omzet', 'Omzet (Rp)']].map(([v, l]) => `<label class="choice"><input type="radio" name="kind" value="${v}"${target.kind === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <div class="form-grid"><label class="field"><span id="tg-lbl"></span><input name="value" type="number" inputmode="numeric" min="1" step="1" required value="${target.value}">
        <span class="muted small num" id="tg-fmt"></span></label></div>
      <p class="muted small num">Hari ini: ${target.kind === 'omzet' ? rupiah(target.current) : `${target.current} produk`}, ${target.percent}% dari target.</p>
      <div class="notice" id="tg-msg" hidden></div>
      <div><button class="btn" type="submit">Simpan target</button></div>
    </form>
  </section>`;

  p.innerHTML = `${targetBox}
  ${is('kategori') ? `<section class="panel stack" aria-labelledby="ct-title">
    <h1 id="ct-title">Kategori</h1>
    <p class="muted small">Kategori tampil sebagai tab di atas daftar produk di kasir, dengan urutan ini. Kategori yang dimatikan tidak muncul di kasir. Kategori yang masih punya produk aktif tidak bisa dimatikan.</p>
    <div class="table-wrap"><table><thead><tr><th>Urutan</th><th>Nama</th><th class="num">Produk</th><th>Status</th><th></th></tr></thead><tbody id="cats">${catRows}</tbody></table></div>
    <div class="notice" id="ct-msg" hidden></div>
    <form id="nc" class="row" novalidate>
      <label class="field"><span>Kategori baru</span><input name="name" type="text" maxlength="30" required></label>
      <button class="btn btn-quiet" type="submit" style="align-self:end">Tambah kategori</button>
    </form>
  </section>` : ''}

  ${is('rasa') ? `<section class="panel stack" aria-labelledby="fl-title">
    <h1 id="fl-title">Rasa</h1>
    <p class="muted small">Rasa yang dimatikan tidak muncul lagi di kasir. Minimal satu rasa harus aktif.</p>
    <div class="stack-sm" id="flavours">${d.flavours.map((f) => `<label class="check"><input type="checkbox" data-flavour="${esc(f.id)}" ${f.active ? 'checked' : ''}><span>${esc(f.label)}${f.surcharge ? '' : ' (tanpa tambahan)'}</span></label>`).join('')}</div>
    <div class="notice" id="fl-msg" hidden></div>
  </section>` : ''}

  ${is('saluran') ? `<section class="panel stack" aria-labelledby="ch-title">
    <h1 id="ch-title">Saluran pesan-antar</h1>
    <p class="muted small">Untuk nanti, saat Hanashuya mulai menjual lewat aplikasi pesan-antar. Selama dimatikan, saluran ini tidak muncul di kasir. Penjualan di booth selalu aktif. Setelah saluran diaktifkan, kolom harganya muncul di Daftar produk.</p>
    <div class="stack-sm" id="channels">${delivery.map((c) => `<label class="check"><input type="checkbox" data-channel="${esc(c.id)}" ${c.active ? 'checked' : ''}><span>${esc(c.label)}</span></label>`).join('')}</div>
    <div class="notice" id="ch-msg" hidden></div>
  </section>` : ''}`;

  const fail = (state, msg) => { state.textContent = msg; state.className = 'small'; state.style.color = 'var(--color-error)'; };

  // Daily target.
  const tg = $('#tg', p);
  if (tg) {
    const field = tg.elements.value;
    const sync = () => {
      const omzet = tg.elements.kind.value === 'omzet';
      $('#tg-lbl', p).textContent = omzet ? 'Target omzet per hari (Rp)' : 'Target produk per hari';
      field.step = omzet ? '1000' : '1';
      $('#tg-fmt', p).textContent = omzet && field.value !== '' ? rupiah(Number(field.value)) : '';
    };
    $$('input[name="kind"]', tg).forEach((r) => r.addEventListener('change', () => {
      // Switching the kind clears the number: 10 products is not Rp10.
      field.value = r.value === target.kind ? target.value : '';
      sync();
    }));
    field.addEventListener('input', sync);
    sync();
    tg.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', tg), msg = $('#tg-msg', p), v = intOrNull(field.value);
      if (v == null || !(v > 0)) return notice(msg, 'Isi angka target lebih dari 0.');
      busy(btn, true, 'Menyimpan…'); notice(msg, '');
      try { await call('owner_save_target', { p_kind: tg.elements.kind.value, p_value: v }); toast('Target harian tersimpan'); again(); }
      catch (err) { busy(btn, false); notice(msg, err.message); }
    });
  }

  // Show Rp format next to a number as it is typed.
  $$('input[type="number"]', p).forEach((i) => i.addEventListener('input', () => {
    const f = i.parentElement.querySelector('[data-fmt]');
    if (f) f.textContent = i.value === '' ? '' : rupiah(Number(i.value));
  }));

  // Order: products within their category, and categories.
  const mover = (attr, fn, key) => $$(`[${attr}]`, p).forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try { await call(fn, { [key]: key === 'p_code' ? b.getAttribute(attr) : Number(b.getAttribute(attr)), p_dir: Number(b.dataset.dir) }); again(); }
    catch (err) { b.disabled = false; toast(err.message); }
  }));
  mover('data-cmove', 'owner_move_pos_category', 'p_id');

  // Categories: rename, on/off, add.
  $$('tr[data-cat]', p).forEach((tr) => {
    const id = Number(tr.dataset.cat), c = cats.find((x) => x.id === id), state = $('[data-state]', tr);
    $('[data-cat-save]', tr).addEventListener('click', async (e) => {
      const name = $('input[type="text"]', tr).value.trim();
      if (name === c.name) return;
      const btn = e.currentTarget; // currentTarget is null after the first await
      busy(btn, true, 'Menyimpan…');
      try { await call('owner_rename_pos_category', { p_id: id, p_name: name }); toast('Nama kategori tersimpan'); again(); }
      catch (err) { busy(btn, false); fail(state, err.message); }
    });
    const box = $('[data-f="cat-active"]', tr);
    box.addEventListener('change', async () => {
      const on = box.checked; box.disabled = true;
      try { await call('owner_set_pos_category', { p_id: id, p_active: on }); toast(on ? 'Kategori diaktifkan' : 'Kategori dimatikan'); again(); }
      catch (err) { box.checked = !on; box.disabled = false; notice($('#ct-msg', p), err.message); }
    });
  });
  $('#nc', p)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget, btn = $('button', f), name = f.name.value.trim();
    if (!name) return notice($('#ct-msg', p), 'Isi nama kategori.');
    busy(btn, true, 'Menambah…');
    try { await call('owner_add_pos_category', { p_name: name }); toast(`Kategori ${name} ditambahkan`); again(); }
    catch (err) { busy(btn, false); notice($('#ct-msg', p), err.message); }
  });

  wireToggles();

  function wireToggles() {
  const wire = (sel, attr, fn, msgId) => $$(sel, p).forEach((c) => c.addEventListener('change', async () => {
    const on = c.checked; c.disabled = true;
    try { await call(fn, { [attr]: c.dataset[attr === 'p_flavour' ? 'flavour' : 'channel'], p_active: on }); toast(on ? 'Diaktifkan' : 'Dimatikan'); notice($(msgId, p), ''); if (attr === 'p_channel') again(); else c.disabled = false; }
    catch (err) { c.checked = !on; c.disabled = false; notice($(msgId, p), err.message); }
  }));
  wire('[data-flavour]', 'p_flavour', 'owner_set_flavour', '#fl-msg');
  wire('[data-channel]', 'p_channel', 'owner_set_channel', '#ch-msg');
  }
}
