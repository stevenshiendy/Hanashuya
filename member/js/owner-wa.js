// WhatsApp templates (12 Nov 2026). No WhatsApp API: the owner keeps texts here, the back office
// fills in a member's details and opens a wa.me link; sending is always the owner's tap in WhatsApp.
//   mountWaTemplates(panel, { rpc })      Template WhatsApp tab: list, active switch, add/edit, live preview
//   openWaDialog(member, { rpc })         "Kirim WhatsApp" on a member: pick, check, edit, open WhatsApp
// Database side: supabase/wa-templates.sql.
import { $, $$, esc, busy, notice, toast } from './lib.js';

export const WA_CATS = { ulang_tahun: 'Ulang tahun', voucher: 'Voucher', kartu: 'Kartu member', umum: 'Umum' };
export const WA_FIELDS = [['{nama}', 'Nama depan member'], ['{stempel}', 'Stempel di kartu'], ['{hadiah}', 'Hadiah berikutnya'], ['{voucher}', 'Voucher siap pakai'], ['{link_kartu}', 'Link kartu member']];
const SAMPLE = { '{nama}': 'Desi', '{stempel}': '4', '{hadiah}': 'Diskon 20% di stempel ke-7', '{voucher}': 'Diskon 50% untuk 1 produk', '{link_kartu}': 'https://hanashuya.vercel.app/member/' };
export const fillSample = (body) => Object.entries(SAMPLE).reduce((t, [k, v]) => t.split(k).join(v), String(body || ''));
export const waOpenLink = (number, text) => `https://wa.me/${String(number || '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
const errBox = (e) => `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`;

export async function mountWaTemplates(panel, { rpc }) {
  const again = () => mountWaTemplates(panel, { rpc });
  panel.innerHTML = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
  let list;
  try { list = await rpc('owner_wa_templates', { p_only_active: false }); } catch (e) { panel.innerHTML = errBox(e); return; }
  panel.innerHTML = `
  <section class="panel stack" aria-labelledby="wa-t">
    <h1 id="wa-t">Template WhatsApp</h1>
    <p class="muted small">Teks yang bisa dipakai lagi. Di halaman member, tombol Kirim WhatsApp mengisi nama dan datanya, lalu membuka WhatsApp dengan teks siap kirim. Pesan baru terkirim saat Anda menekan kirim di WhatsApp. Hanya template yang aktif muncul di sana.</p>
    ${list.length ? `<ul class="list">${list.map((t) => `<li data-id="${t.id}"><span class="grow"><strong>${esc(t.name)}</strong>
        <span class="tag">${esc(WA_CATS[t.category] || t.category)}</span><br><span class="muted small">${esc(t.body.length > 110 ? t.body.slice(0, 110) + '…' : t.body)}</span></span>
        <span class="row"><label class="check"><input type="checkbox" data-on ${t.active ? 'checked' : ''}><span>Aktif</span></label>
          <button class="btn btn-quiet" type="button" data-edit>Ubah</button></span></li>`).join('')}</ul>` : '<p class="muted">Belum ada template.</p>'}
    <div class="notice" id="wa-msg" hidden></div>
    <div><button class="btn" type="button" id="wa-new">Tambah template</button></div>
  </section>
  <div id="wa-form"></div>`;

  $$('li[data-id]', panel).forEach((li) => {
    const t = list.find((x) => x.id === Number(li.dataset.id));
    const box = $('[data-on]', li);
    box.addEventListener('change', async () => {
      box.disabled = true;
      try { await rpc('owner_set_wa_template', { p_id: t.id, p_active: box.checked }); toast(box.checked ? 'Template diaktifkan' : 'Template dimatikan'); again(); }
      catch (e) { box.checked = !box.checked; box.disabled = false; notice($('#wa-msg', panel), e.message); }
    });
    $('[data-edit]', li).addEventListener('click', () => form(t));
  });
  $('#wa-new', panel).addEventListener('click', () => form(null));

  function form(t) {
    const box = $('#wa-form', panel);
    const v = t || { name: '', category: 'umum', body: '' };
    box.innerHTML = `<form class="panel stack" id="wf" novalidate aria-labelledby="wf-t">
      <h2 id="wf-t">${t ? 'Ubah template' : 'Template baru'}</h2>
      <div class="form-grid">
        <label class="field"><span>Nama template</span><input name="name" maxlength="60" required value="${esc(v.name)}" placeholder="Misalnya Pengingat voucher"></label>
        <label class="field"><span>Kategori</span><select name="category">${Object.entries(WA_CATS).map(([k, l]) => `<option value="${k}"${v.category === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Teks pesan <span class="hint" id="wf-count"></span></span><textarea name="body" rows="6" maxlength="1000" required>${esc(v.body)}</textarea></label>
      <div class="stack"><span class="small">Ketuk untuk menyisipkan data member</span>
        <div class="row" role="group" aria-label="Sisipkan data">${WA_FIELDS.map(([k, l]) => `<button class="btn btn-quiet" type="button" data-ph="${esc(k)}" title="${esc(l)}">${esc(k)}</button>`).join('')}</div></div>
      <div class="stack"><span class="small">Contoh hasilnya, untuk member bernama Desi</span><p class="notice" id="wf-prev"></p></div>
      <div class="notice" id="wf-msg" hidden></div>
      <div class="row"><button class="btn" type="submit">Simpan</button><button class="btn btn-quiet" type="button" id="wf-cancel">Batal</button></div>
    </form>`;
    const f = $('#wf', box), ta = f.elements.body;
    const refresh = () => { $('#wf-prev', f).textContent = fillSample(ta.value) || '–'; $('#wf-count', f).textContent = `${ta.value.length}/1000`; };
    ta.addEventListener('input', refresh); refresh();
    $$('[data-ph]', f).forEach((b) => b.addEventListener('click', () => {
      const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
      ta.setRangeText(b.dataset.ph, s, e, 'end'); ta.focus(); refresh();
    }));
    $('#wf-cancel', f).addEventListener('click', () => { box.innerHTML = ''; });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const msg = $('#wf-msg', f), btn = $('button[type=submit]', f);
      if (!f.elements.name.value.trim() || !ta.value.trim()) { notice(msg, 'Isi nama dan teks pesannya.'); return; }
      busy(btn, true, 'Menyimpan…');
      try {
        await rpc('owner_save_wa_template', { p_id: t ? t.id : null, p_name: f.elements.name.value, p_category: f.elements.category.value, p_body: ta.value, p_sort: null });
        toast('Template disimpan'); again();
      } catch (e) { busy(btn, false); notice(msg, e.message); }
    });
    f.scrollIntoView({ block: 'start' });
  }
}

// member: { id, name }. Opens a dialog over the member detail.
export async function openWaDialog(member, { rpc }) {
  let list;
  const dlg = document.createElement('dialog');
  dlg.className = 'panel stack';
  dlg.setAttribute('aria-labelledby', 'wd-t');
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  const head = `<div class="row-between"><h2 id="wd-t">Kirim WhatsApp ke ${esc(member.name || 'member')}</h2><button class="btn btn-quiet" type="button" id="wd-x">Tutup</button></div>`;
  dlg.innerHTML = head + '<div class="skeleton"></div>';
  dlg.showModal();
  $('#wd-x', dlg).addEventListener('click', () => dlg.close());
  try { list = await rpc('owner_wa_templates', { p_only_active: true }); } catch (e) { dlg.innerHTML = head + errBox(e); $('#wd-x', dlg).addEventListener('click', () => dlg.close()); return; }
  if (!list.length) {
    dlg.innerHTML = head + '<p class="muted">Belum ada template yang aktif. Aktifkan satu di Member &gt; Template WhatsApp.</p>';
    $('#wd-x', dlg).addEventListener('click', () => dlg.close());
    return;
  }
  dlg.innerHTML = head + `
    <label class="field"><span>Template</span><select id="wd-t-sel"><option value="">Pilih template</option>${list.map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(WA_CATS[t.category] || t.category)})</option>`).join('')}</select></label>
    <label class="field"><span>Teks pesan <span class="hint">boleh diubah sebelum dikirim</span></span><textarea id="wd-text" rows="7" disabled></textarea></label>
    <div class="notice" id="wd-msg" hidden></div>
    <div class="row"><a class="btn" id="wd-go" href="#" target="_blank" rel="noopener" aria-disabled="true">Buka WhatsApp</a></div>
    <p class="muted small">WhatsApp terbuka dengan teks sudah terisi. Pesan baru terkirim setelah Anda menekan kirim di sana.</p>`;
  $('#wd-x', dlg).addEventListener('click', () => dlg.close());
  const sel = $('#wd-t-sel', dlg), ta = $('#wd-text', dlg), go = $('#wd-go', dlg), msg = $('#wd-msg', dlg);
  let number = '';
  const link = () => { go.href = number && ta.value.trim() ? waOpenLink(number, ta.value) : '#'; go.setAttribute('aria-disabled', String(!(number && ta.value.trim()))); };
  ta.addEventListener('input', link);
  go.addEventListener('click', (e) => { if (go.getAttribute('aria-disabled') === 'true') e.preventDefault(); });
  sel.addEventListener('change', async () => {
    number = ''; ta.value = ''; ta.disabled = true; link(); notice(msg, '');
    if (!sel.value) return;
    try {
      const r = await rpc('owner_wa_preview', { p_template: Number(sel.value), p_member: member.id });
      number = r.whatsapp; ta.value = r.text; ta.disabled = false; link();
    } catch (e) { notice(msg, e.message); }
  });
}
