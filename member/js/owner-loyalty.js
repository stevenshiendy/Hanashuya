// Owner page: Bonus stempel and Komisi (12 Nov 2026, Glenn's picks from the VireoPOS comparison).
// Bonus stempel: periods in which a member's stamps on a paid till order are multiplied
// (owner_stamp_boosts / owner_save_stamp_boost, pos.sql). Komisi: the rules behind the staff
// commission in Laporan POS and Laba kotor (owner_commission_rules / owner_save_commission_rule).
import { $, $$, esc, rupiah, busy, toast, notice } from './lib.js';
import { scheduleHtml, bindSchedule } from './owner-komisi.js';

const DAYS = [[1, 'Sen'], [2, 'Sel'], [3, 'Rab'], [4, 'Kam'], [5, 'Jum'], [6, 'Sab'], [7, 'Min']];
const fmtDay = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
const loading = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorBox = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;

/* ---------------------------------------------------------------- Bonus stempel */
export async function mountStampBoosts(p, { rpc }) {
  const again = () => mountStampBoosts(p, { rpc });
  p.innerHTML = loading;
  let list;
  try { list = await rpc('owner_stamp_boosts'); } catch (e) { p.innerHTML = errorBox(e); return; }
  const days = (b) => (b.days?.length ? b.days.map((d) => DAYS.find(([n]) => n === d)?.[1]).join(', ') : 'Setiap hari');
  p.innerHTML = `<section class="panel stack" aria-labelledby="bs-t">
      <h1 id="bs-t">Bonus stempel</h1>
      <p class="muted small">Selama periode bonus berjalan, stempel member dari setiap pembelian di kasir dikali 2 atau 3. Kasir menampilkan "bonus 2x" di samping jumlah stempel. Pembeli tanpa kartu tidak terpengaruh.</p>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Nama</th><th>Periode</th><th>Hari</th><th>Bonus</th><th class="num">Pesanan</th><th class="num">Stempel tambahan</th><th>Status</th><th></th></tr></thead><tbody>
        ${list.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(fmtDay(b.starts_on))} sampai ${esc(fmtDay(b.ends_on))}</td><td>${esc(days(b))}</td>
          <td>${b.multiplier}x</td><td class="num">${b.orders}</td><td class="num">${b.extra_stamps}</td>
          <td>${!b.active ? '<span class="tag">Mati</span>' : b.running ? '<span class="tag tag-ok">Berjalan</span>' : b.ends_on < today() ? '<span class="tag">Selesai</span>' : '<span class="tag">Terjadwal</span>'}</td>
          <td><button class="btn btn-quiet" type="button" data-edit="${b.id}">Ubah</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Belum ada periode bonus.</p>'}
      <div><button class="btn" type="button" id="bs-new">Tambah periode bonus</button></div>
    </section><div id="bs-form"></div>`;
  const open = (b) => {
    const box = $('#bs-form', p);
    box.innerHTML = `<section class="panel stack" aria-labelledby="bsf-t"><h2 id="bsf-t">${b ? 'Ubah periode bonus' : 'Periode bonus baru'}</h2>
      <form class="stack" novalidate>
        <div class="form-grid">
          <label class="field"><span>Nama</span><input name="name" type="text" maxlength="60" required value="${esc(b?.name || '')}" placeholder="Contoh: Minggu ganda"></label>
          <label class="field"><span>Mulai</span><input name="starts_on" type="date" required value="${esc(b?.starts_on || today())}"></label>
          <label class="field"><span>Selesai</span><input name="ends_on" type="date" required value="${esc(b?.ends_on || today())}"></label>
        </div>
        <fieldset class="field"><legend>Bonus</legend><div class="choices">${[2, 3].map((m) => `<label class="choice"><input type="radio" name="multiplier" value="${m}"${(b?.multiplier || 2) === m ? ' checked' : ''}><span>${m}x stempel</span></label>`).join('')}</div></fieldset>
        <fieldset class="field"><legend>Hari <span class="hint">kosongkan untuk setiap hari</span></legend><div class="choices">${DAYS.map(([n, l]) => `<label class="choice"><input type="checkbox" name="days" value="${n}"${b?.days?.includes(n) ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
        <label class="check"><input type="checkbox" name="active"${b ? (b.active ? ' checked' : '') : ' checked'}><span>Aktif</span></label>
        <label class="field"><span>Catatan <span class="hint">boleh dikosongkan</span></span><input name="note" type="text" maxlength="200" value="${esc(b?.note || '')}"></label>
        <div class="notice" data-msg hidden></div>
        <div class="row"><button class="btn" type="submit">Simpan</button><button class="btn btn-quiet" type="button" data-cancel>Batal</button></div>
      </form></section>`;
    const f = $('form', box);
    $('[data-cancel]', box).addEventListener('click', () => { box.innerHTML = ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', f);
      const data = { name: f.elements.name.value, starts_on: f.elements.starts_on.value, ends_on: f.elements.ends_on.value,
        multiplier: Number(f.elements.multiplier.value), days: $$('input[name="days"]:checked', f).map((x) => Number(x.value)),
        active: f.elements.active.checked, note: f.elements.note.value };
      busy(btn, true, 'Menyimpan…');
      try { await rpc('owner_save_stamp_boost', { p_id: b?.id ?? null, p: data }); toast('Periode bonus tersimpan'); again(); }
      catch (err) { busy(btn, false); notice($('[data-msg]', f), err.message); }
    });
    f.elements.name.focus();
  };
  $('#bs-new', p).addEventListener('click', () => open(null));
  $$('[data-edit]', p).forEach((x) => x.addEventListener('click', () => open(list.find((b) => b.id === Number(x.dataset.edit)))));
}

/* ---------------------------------------------------------------- Komisi */
// Komisi on/off (Glenn, 14 Nov 2026): nothing is counted until the commission system is on and the
// staff member is switched on (komisi-switch.sql). The owner or a manager switches; the rules
// below stay owner-only. A manager can't switch their own.
function switchesHtml(c) {
  return `<section class="panel stack" aria-labelledby="kms-t">
    <h2 id="kms-t">Komisi per staf</h2>
    <label class="check"><input type="checkbox" data-km-all${c.enabled ? ' checked' : ''}><span><strong>Sistem komisi aktif</strong></span></label>
    <p class="muted small">${c.enabled ? 'Komisi dihitung hanya untuk staf yang dicentang di bawah. Komisi dihitung dari saat staf dicentang sampai saat dimatikan; penjualan di luar waktu itu tidak mendapat komisi.' : 'Mati: tidak ada komisi yang dihitung untuk siapa pun.'}</p>
    <fieldset class="field"${c.enabled ? '' : ' disabled'}><legend>Staf yang mendapat komisi</legend>
      <div class="stack">${c.staff.map((s) => `<label class="check"><input type="checkbox" data-km-staff="${esc(s.id)}"${s.enabled ? ' checked' : ''}${s.self && s.role !== 'owner' ? ' disabled' : ''}>
        <span>${esc(s.name)}${s.employer ? ` <span class="muted small">${esc(s.employer)}</span>` : ''}${s.self && s.role !== 'owner' ? ' <span class="muted small">diatur pemilik</span>' : ''}</span></label>`).join('')}</div>
    </fieldset>
    <div class="notice" data-km-msg hidden></div>
  </section>`;
}
function bindSwitches(p, rpc, again) {
  const msg = $('[data-km-msg]', p);
  const send = async (box, fn, args) => {
    box.disabled = true;
    try { await rpc(fn, args); toast('Komisi tersimpan'); again(); }
    catch (e) { box.checked = !box.checked; box.disabled = false; notice(msg, e.message); }
  };
  $('[data-km-all]', p).addEventListener('change', (e) => send(e.target, 'commission_set_enabled', { p_enabled: e.target.checked }));
  $$('[data-km-staff]', p).forEach((x) => x.addEventListener('change', () => send(x, 'commission_set_staff', { p_staff: x.dataset.kmStaff, p_enabled: x.checked })));
}

export async function mountCommission(p, { rpc, owner = true }) {
  const again = () => mountCommission(p, { rpc, owner });
  p.innerHTML = loading;
  let rules, prods, sw;
  try {
    [sw, rules, prods] = await Promise.all([rpc('commission_settings'),
      owner ? rpc('owner_commission_rules') : [], owner ? rpc('owner_pos_products').then((d) => d.products.filter((m) => !m.archived)) : []]);
  } catch (e) { p.innerHTML = errorBox(e); return; }
  if (!owner) { p.innerHTML = scheduleHtml(sw) + switchesHtml(sw); bindSchedule(p, rpc, sw, again); bindSwitches(p, rpc, again); return; }
  const val = (r) => (r.kind === 'persen' ? `${Number(r.value).toLocaleString('id-ID')}% dari harga dibayar` : `${rupiah(Number(r.value))} per produk`);
  p.innerHTML = `${scheduleHtml(sw)}${switchesHtml(sw)}<section class="panel stack" aria-labelledby="km-t">
      <h2 id="km-t">Aturan komisi</h2>
      <p class="muted small">Komisi masuk ke staf yang melayani pesanan. Untuk setiap produk, aturan khusus produk itu dipakai lebih dulu daripada aturan "Semua produk". Paper bag gratis tidak dihitung. Hasilnya ada di Laporan POS dan Laba kotor.</p>
      <div class="table-wrap"><table><thead><tr><th>Nama</th><th>Produk</th><th>Komisi</th><th>Berlaku</th><th>Status</th><th></th></tr></thead><tbody>
        ${rules.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.product || 'Semua produk')}</td><td>${esc(val(r))}</td>
          <td>${esc(fmtDay(r.starts_on))}${r.ends_on ? ` sampai ${esc(fmtDay(r.ends_on))}` : ', tanpa batas'}</td>
          <td>${r.active ? '<span class="tag tag-ok">Aktif</span>' : '<span class="tag">Mati</span>'}</td>
          <td><button class="btn btn-quiet" type="button" data-edit="${r.id}">Ubah</button></td></tr>`).join('')}</tbody></table></div>
      <div><button class="btn" type="button" id="km-new">Tambah aturan</button></div>
    </section><div id="km-form"></div>`;
  const open = (r) => {
    const box = $('#km-form', p);
    box.innerHTML = `<section class="panel stack" aria-labelledby="kmf-t"><h2 id="kmf-t">${r ? 'Ubah aturan komisi' : 'Aturan komisi baru'}</h2>
      <form class="stack" novalidate>
        <div class="form-grid">
          <label class="field"><span>Nama</span><input name="name" type="text" maxlength="60" required value="${esc(r?.name || '')}"></label>
          <label class="field"><span>Produk</span><select name="product_code"><option value="">Semua produk</option>
            ${prods.map((m) => `<option value="${esc(m.code)}"${r?.product_code === m.code ? ' selected' : ''}>${esc(m.pos_name)}</option>`).join('')}</select></label>
        </div>
        <fieldset class="field"><legend>Hitung dari</legend><div class="choices">${[['persen', 'Persen dari harga dibayar'], ['rupiah', 'Rupiah per produk']].map(([v, l]) => `<label class="choice"><input type="radio" name="kind" value="${v}"${(r?.kind || 'persen') === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
        <div class="form-grid">
          <label class="field"><span data-vlabel></span><input name="value" type="number" inputmode="decimal" min="0" step="0.5" required value="${r ? Number(r.value) : ''}"></label>
          <label class="field"><span>Mulai</span><input name="starts_on" type="date" required value="${esc(r?.starts_on || today())}"></label>
          <label class="field"><span>Selesai <span class="hint">kosongkan kalau tanpa batas</span></span><input name="ends_on" type="date" value="${esc(r?.ends_on || '')}"></label>
        </div>
        <label class="check"><input type="checkbox" name="active"${r ? (r.active ? ' checked' : '') : ' checked'}><span>Aktif</span></label>
        <div class="notice" data-msg hidden></div>
        <div class="row"><button class="btn" type="submit">Simpan</button><button class="btn btn-quiet" type="button" data-cancel>Batal</button></div>
      </form></section>`;
    const f = $('form', box);
    const sync = () => { $('[data-vlabel]', f).textContent = f.elements.kind.value === 'persen' ? 'Persen (%)' : 'Rupiah per produk'; f.elements.value.step = f.elements.kind.value === 'persen' ? '0.5' : '500'; };
    $$('input[name="kind"]', f).forEach((x) => x.addEventListener('change', sync)); sync();
    $('[data-cancel]', box).addEventListener('click', () => { box.innerHTML = ''; });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', f);
      const data = { name: f.elements.name.value, product_code: f.elements.product_code.value || null, kind: f.elements.kind.value,
        value: f.elements.value.value === '' ? null : Number(f.elements.value.value), starts_on: f.elements.starts_on.value,
        ends_on: f.elements.ends_on.value || null, active: f.elements.active.checked };
      busy(btn, true, 'Menyimpan…');
      try { await rpc('owner_save_commission_rule', { p_id: r?.id ?? null, p: data }); toast('Aturan komisi tersimpan'); again(); }
      catch (err) { busy(btn, false); notice($('[data-msg]', f), err.message); }
    });
    f.elements.name.focus();
  };
  bindSchedule(p, rpc, sw, again);
  bindSwitches(p, rpc, again);
  $('#km-new', p).addEventListener('click', () => open(null));
  $$('[data-edit]', p).forEach((x) => x.addEventListener('click', () => open(rules.find((r) => r.id === Number(x.dataset.edit)))));
}
