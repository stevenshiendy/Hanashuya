// Owner menu group "Transaksi" (12 Nov 2026): Pesanan di muka, deposit (DP) and koreksi stempel, as
// VireoPOS Reservasi, Adjustment Deposito, Adjustment Poin and the reports Deposit Reservasi and
// Mutasi Deposito. The maths is in supabase/pos-reservasi.sql.
// No DP (Glenn, 13 Nov 2026): Hanashuya doesn't take down payments, so a pre-order is paid in full
// at pickup. New DPs can't be recorded; the deposit views stay as history, and an older balance can
// still be given back, declared hangus or corrected.
//   mountReservasi(panel, { rpc, part })
//   part: 'pesanan' (Pesanan di muka), 'mutasi' (Mutasi deposito), 'deposit' (Deposit reservasi),
//         'stempel' (Koreksi stempel and Riwayat stempel)
import { $, $$, esc, rupiah, when, day, toast } from './lib.js';
import { dataTable, formDialog, infoDialog } from './data-table.js';
import { rangeHtml, wireRange } from './owner-range.js';

const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorHtml = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;
const REQ = '<span class="hint is-req">wajib</span>';
const money = (raw) => { const d = String(raw ?? '').replace(/[^\d-]/g, ''); return d && d !== '-' ? Number(d) : null; };
const phone = (wa) => (wa ? String(wa).replace(/^62/, '0').replace(/(\d{4})(\d{4})(\d+)/, '$1-$2-$3') : '');
// Non-breaking hyphens keep PM-261112-01 and 0812-3456-7890 on one line in the table.
const nb = (v) => String(v ?? '').replace(/-/g, '\u2011');
const signedRp = (n) => (Number(n) > 0 ? '+' : Number(n) < 0 ? '-' : '') + rupiah(Math.abs(Number(n || 0)));

const STATUS = { baru: ['Baru', 'tag-warn'], dikonfirmasi: ['Dikonfirmasi', ''], siap: ['Siap diambil', 'tag-ok'], diambil: ['Diambil', 'tag-ok'], batal: ['Batal', 'tag-bad'] };
const KIND = { dp: 'DP masuk', pakai: 'Dipakai', refund: 'Dikembalikan', hangus: 'Hangus', koreksi: 'Koreksi' };
const METHOD = { tunai: 'Tunai', qris: 'QRIS' };
const statusTag = (s) => (STATUS[s] ? tag(STATUS[s][0], STATUS[s][1]) : esc(s || '–'));
const pickupText = (r) => `${day(r.pickup_at)}, ${r.pickup_time}`;

const sel = (name, opts, pick, label, extra = '') => `<label class="field"><span>${label}</span><select data-f="${name}" ${extra}>${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(pick ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const inp = (name, label, extra = '', value = '') => `<label class="field"><span>${label}</span><input type="text" data-f="${name}" autocomplete="off" value="${esc(value)}" ${extra}></label>`;
const F = (form, k) => form.querySelector(`[data-f="${k}"]`);

// One screen: heading, a date range, optional filters, and the table (same shape as owner-transaksi.js).
async function screen(panel, { title, intro, from, to, controls = '', head = '', load, options, onLoaded }) {
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>${esc(title)}</h1>${intro ? `<p class="muted small">${esc(intro)}</p>` : ''}</div>
    ${rangeHtml({ from, to, max: addDays(ymd(), 366) })}
    ${controls ? `<div class="dt-range">${controls}</div>` : ''}
    <div data-head>${head}</div><div data-t>${loadingHtml}</div></div>`;
  const host = $('[data-t]', panel);
  const ctx = () => ({ from: $('[data-from]', panel).value, to: $('[data-to]', panel).value,
    c: Object.fromEntries($$('[data-c]', panel).map((e) => [e.dataset.c, e.value])) });
  const fetchRows = async () => { const res = await load(ctx()); if (res) onLoaded?.(res, $('[data-head]', panel)); return res?.rows ?? res ?? []; };
  let rows;
  try { rows = await fetchRows(); } catch (e) { host.innerHTML = errorHtml(e).replace('class="panel"', ''); return null; }
  host.innerHTML = '';
  const t = dataTable(host, { ...options, rows, reload: fetchRows });
  $$('[data-from], [data-to], [data-c]', panel).forEach((e) => e.addEventListener('change', () => {
    const { from: f, to: tt } = ctx();
    if (f && tt && f > tt) return;
    t.refresh();
  }));
  wireRange(panel);
  return t;
}

export async function mountReservasi(panel, { rpc, part }) {
  const run = PARTS[part];
  if (!run) { panel.innerHTML = errorHtml(new Error('Halaman ini belum ada.')); return; }
  panel.innerHTML = loadingHtml;
  await run(panel, rpc);
}

/* ================================================================ shared: the pre-order dialogs */
let catalog = null;
async function cat(rpc) { if (!catalog) catalog = await rpc('pos_catalog'); return catalog; }

// Message for the customer, opened in WhatsApp by the owner.
function waText(r) {
  const parts = [`Halo Kak ${r.customer_name}, pesanan Hanashuya ${r.no} untuk ${day(r.pickup_at)} pukul ${r.pickup_time.replace(':', '.')} sudah kami catat.`,
    `Total ${rupiah(r.total)}, dibayar saat ambil di booth Hanashuya, Papaya Fresh Gallery.`,
    'Terima kasih Kak.'];
  return parts.join(' ');
}
const waHref = (r) => `https://wa.me/${encodeURIComponent(r.whatsapp)}?text=${encodeURIComponent(waText(r))}`;

async function memberPicker(rpc, form, current) {
  const box = form.querySelector('[data-member]');
  const show = (m) => {
    form.querySelector('[data-f="member_id"]').value = m ? m.id : '';
    box.querySelector('[data-picked]').innerHTML = m ? `Member: ${esc(m.name)}${m.card_code ? ` (${esc(m.card_code)})` : ''}. <button class="btn btn-text" type="button" data-unlink>Lepas</button>` : 'Belum ada member yang dipilih.';
  };
  show(current);
  let seq = 0;
  box.addEventListener('input', async (e) => {
    if (!e.target.matches('[data-msearch]')) return;
    const n = ++seq, q = e.target.value.trim(), list = box.querySelector('[data-mlist]');
    if (q.length < 3) { list.innerHTML = ''; return; }
    try {
      const rows = await rpc('pos_member_search', { p_q: q });
      if (n !== seq) return;
      list.innerHTML = rows.length ? rows.map((m, i) => `<li><button class="btn btn-text" type="button" data-mpick="${i}">${esc(m.name)} · ${esc(phone(m.whatsapp))} · ${m.stamps} stempel</button></li>`).join('') : '<li class="muted small">Tidak ada member yang cocok.</li>';
      list._rows = rows;
    } catch (err) { list.innerHTML = `<li class="notice notice-error">${esc(err.message)}</li>`; }
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mpick]');
    if (b) { const list = box.querySelector('[data-mlist]'); show(list._rows[Number(b.dataset.mpick)]); list.innerHTML = ''; box.querySelector('[data-msearch]').value = ''; }
    if (e.target.closest('[data-unlink]')) show(null);
  });
}
const memberBlock = () => `<div class="stack-sm" data-member><input type="hidden" data-f="member_id">
  <label class="field"><span>Member (tidak wajib)</span><input type="search" data-msearch autocomplete="off" placeholder="Cari nama, kode kartu atau nomor WhatsApp"></label>
  <ul class="dt-list" data-mlist></ul><p class="small muted" data-picked></p>
  <p class="small muted">Kalau terhubung, stempelnya masuk ke kartu member saat pesanan diambil.</p></div>`;

async function editDialog(rpc, r) {
  const c = await cat(rpc);
  const prods = c.products.filter((p) => p.code !== 'bag');
  const flavOpts = [['', 'Tanpa rasa'], ...c.flavours.map((f) => [f.id, f.label])];
  const lineHtml = (l = {}) => `<div class="dt-line" data-line>
    ${sel('l-prod', prods.map((p) => [p.code, `${p.name} (${rupiah(p.price)})`]), l.product, 'Produk')}
    ${sel('l-flav', flavOpts, l.flavour || '', 'Rasa')}
    <label class="field"><span>Jumlah</span><input type="text" inputmode="numeric" data-f="l-qty" autocomplete="off" value="${esc(l.qty ?? 1)}"></label>
    <button class="btn btn-text" type="button" data-rm>Hapus baris</button></div>`;
  const estimate = (form) => $$('[data-line]', form).reduce((sum, row) => {
    const p = prods.find((x) => x.code === row.querySelector('[data-f="l-prod"]').value);
    const f = c.flavours.find((x) => x.id === row.querySelector('[data-f="l-flav"]').value);
    const q = Number(row.querySelector('[data-f="l-qty"]').value) || 0;
    return sum + (p ? (p.price + (p.needs_flavour && f && f.surcharge ? p.flavour_surcharge : 0)) * q : 0);
  }, 0);
  const syncFlav = (row) => {
    const p = prods.find((x) => x.code === row.querySelector('[data-f="l-prod"]').value);
    const s = row.querySelector('[data-f="l-flav"]');
    s.disabled = !p?.needs_flavour;
    if (!p?.needs_flavour) s.value = ''; else if (!s.value) s.value = c.flavours[0]?.id || '';
  };
  const lines = r ? r.items.map((i) => ({ product: i.product, flavour: i.flavour, qty: i.qty })) : [{}];
  return formDialog({
    title: r ? `Ubah ${r.no}` : 'Pesanan di muka baru', wide: true, submitLabel: r ? 'Simpan perubahan' : 'Simpan pesanan',
    html: `<div class="dt-fields">${inp('name', `Nama pemesan ${REQ}`, 'maxlength="80"', r?.customer_name || '')}
        ${inp('wa', `Nomor WhatsApp ${REQ}`, 'inputmode="tel"', r ? phone(r.whatsapp) : '')}
        <label class="field"><span>Tanggal ambil ${REQ}</span><input type="date" data-f="day" min="${ymd()}" value="${esc(r?.pickup_day || addDays(ymd(), 1))}"></label>
        <label class="field"><span>Jam ambil ${REQ}</span><input type="time" data-f="time" min="08:00" max="21:00" value="${esc(r?.pickup_time || '10:00')}"></label></div>
      ${memberBlock()}
      <div class="dt-lines" data-lines>${lines.map(lineHtml).join('')}</div>
      <div class="row"><button class="btn btn-quiet" type="button" data-addline>+ Tambah produk</button>
        <span class="muted small" data-est></span></div>
      <div class="dt-fields">${inp('bags', 'Paper bag gratis', 'inputmode="numeric"', r?.free_bags ?? 0)}${inp('note', 'Catatan', 'maxlength="300"', r?.note || '')}</div>
      <p class="muted small">Harga mengikuti daftar produk di kasir. Dibayar penuh saat diambil, tanpa DP. Paper bag gratis paling banyak 1 untuk setiap 2 box.</p>`,
    onOpen: (form) => {
      memberPicker(rpc, form, r?.member || null);
      const est = () => { form.querySelector('[data-est]').textContent = `Perkiraan total ${rupiah(estimate(form))}`; };
      $$('[data-line]', form).forEach(syncFlav); est();
      form.addEventListener('change', (e) => { const row = e.target.closest('[data-line]'); if (row && e.target.matches('[data-f="l-prod"]')) syncFlav(row); est(); });
      form.addEventListener('input', est);
      form.addEventListener('click', (e) => {
        if (e.target.closest('[data-addline]')) { form.querySelector('[data-lines]').insertAdjacentHTML('beforeend', lineHtml()); syncFlav($$('[data-line]', form).at(-1)); est(); }
        const rm = e.target.closest('[data-rm]');
        if (rm && $$('[data-line]', form).length > 1) { rm.closest('[data-line]').remove(); est(); }
      });
    },
    onSubmit: async (form) => {
      const items = $$('[data-line]', form).map((row) => {
        const q = Number(row.querySelector('[data-f="l-qty"]').value);
        if (!Number.isInteger(q) || q < 1) throw new Error('Isi jumlah di setiap baris produk (angka 1 atau lebih).');
        return { product: row.querySelector('[data-f="l-prod"]').value, flavour: row.querySelector('[data-f="l-flav"]').value || null, qty: q };
      });
      const p = { customer_name: F(form, 'name').value, whatsapp: F(form, 'wa').value, member_id: F(form, 'member_id').value || null,
        pickup_day: F(form, 'day').value, pickup_time: F(form, 'time').value, items, free_bags: money(F(form, 'bags').value) ?? 0, note: F(form, 'note').value };
      const res = await rpc('pos_reservation_save', { p_id: r?.id || null, p });
      toast(r ? `${res.no} diubah` : `${res.no} dicatat`);
    },
  });
}

const moneyDialog = ({ title, intro = '', amountLabel, method, reasonLabel, reasonRequired = true, submit, run, signed }) => formDialog({
  title, submitLabel: submit,
  html: `${intro ? `<p class="muted small">${esc(intro)}</p>` : ''}${amountLabel ? inp('amt', `${amountLabel} ${REQ}`, `inputmode="${signed ? 'text' : 'numeric'}"`) : ''}
    ${method ? sel('m', [['tunai', 'Tunai (laci booth)'], ['qris', 'QRIS']], 'qris', 'Lewat') : ''}
    ${inp('why', `${reasonLabel} ${reasonRequired ? REQ : ''}`, 'maxlength="200"')}`,
  onSubmit: async (form) => {
    const amt = amountLabel ? money(F(form, 'amt').value) : null;
    if (amountLabel && amt == null) throw new Error('Isi jumlahnya.');
    await run({ amount: amt, method: method ? F(form, 'm').value : null, reason: F(form, 'why').value });
  },
});

// The detail, with the actions that fit its status. Resolves after an action or Tutup.
async function detailDialog(rpc, id) {
  const r = await rpc('pos_reservation_get', { p_id: id });
  const open = ['baru', 'dikonfirmasi', 'siap'].includes(r.status);
  const after = (msg) => (res) => { toast(msg); return res; };
  const setStatus = (s, msg) => async () => { await rpc('pos_reservation_set_status', { p_id: r.id, p_status: s, p_reason: null }).then(after(msg)); };
  const buttons = [];
  if (['baru', 'dikonfirmasi'].includes(r.status)) buttons.push({ label: 'Ubah', onClick: async () => ((await editDialog(rpc, r)) ? undefined : false) });
  if (r.status === 'baru') buttons.push({ label: 'Konfirmasi', onClick: setStatus('dikonfirmasi', `${r.no} dikonfirmasi`) });
  if (['baru', 'dikonfirmasi'].includes(r.status)) buttons.push({ label: 'Tandai siap', onClick: setStatus('siap', `${r.no} siap diambil`) });
  if (r.status === 'siap') buttons.push({ label: 'Belum siap', onClick: setStatus('dikonfirmasi', `${r.no} kembali ke Dikonfirmasi`) });
  // Older DP balances only (no new DP since 13 Nov 2026): give back, hangus, or correct.
  if (r.deposit > 0) buttons.push({ label: 'Kembalikan DP', onClick: async () => ((await moneyDialog({ title: `Kembalikan DP ${r.no}`, intro: `Saldo DP ${rupiah(r.deposit)}. Tunai keluar dari laci booth di shift yang sedang berjalan.`,
    amountLabel: 'Jumlah dikembalikan (Rp)', method: true, reasonLabel: 'Alasan', submit: 'Catat pengembalian',
    run: async (v) => { await rpc('pos_deposit_refund', { p_id: r.id, p_amount: v.amount, p_method: v.method, p_reason: v.reason }); toast('Pengembalian DP dicatat'); } })) ? undefined : false) });
  if (r.status === 'batal' && r.deposit > 0) buttons.push({ label: 'DP hangus', onClick: async () => ((await moneyDialog({ title: `DP ${r.no} hangus?`, intro: `Saldo DP ${rupiah(r.deposit)} dicatat sebagai pendapatan lain-lain dan tidak dikembalikan.`,
    reasonLabel: 'Alasan', submit: 'Nyatakan hangus',
    run: async (v) => { await rpc('pos_deposit_forfeit', { p_id: r.id, p_reason: v.reason }); toast('DP dinyatakan hangus'); } })) ? undefined : false) });
  if (r.deposits.length) buttons.push({ label: 'Koreksi DP', onClick: async () => ((await moneyDialog({ title: `Koreksi saldo DP ${r.no}`, intro: 'Untuk membetulkan catatan. Tidak ada uang yang masuk atau keluar. Tulis plus untuk menambah, minus untuk mengurangi, misalnya -5000.',
    amountLabel: 'Koreksi (Rp)', signed: true, reasonLabel: 'Alasan', submit: 'Simpan koreksi',
    run: async (v) => { await rpc('pos_deposit_adjust', { p_id: r.id, p_amount: v.amount, p_reason: v.reason }); toast('Saldo DP dikoreksi'); } })) ? undefined : false) });
  if (open) buttons.push({ label: 'Batalkan pesanan', danger: true, onClick: async () => ((await moneyDialog({ title: `Batalkan ${r.no}?`,
    intro: r.deposit > 0 ? `Saldo DP ${rupiah(r.deposit)} tetap tercatat sampai dikembalikan atau dinyatakan hangus.` : 'Pesanan yang dibatalkan tetap tercatat.',
    reasonLabel: 'Alasan', submit: 'Batalkan pesanan',
    run: async (v) => { await rpc('pos_reservation_set_status', { p_id: r.id, p_status: 'batal', p_reason: v.reason }); toast(`${r.no} dibatalkan`); } })) ? undefined : false) });

  const items = r.items.map((i) => `<tr><td>${esc(i.name)}${i.flavour_label ? `<br><span class="muted small">${esc(i.flavour_label)}</span>` : ''}</td><td class="num">${i.qty}</td><td class="num">${esc(rupiah(i.unit_price))}</td><td class="num">${esc(rupiah(i.line_total))}</td></tr>`).join('');
  const deps = r.deposits.map((d) => `<tr><td>${esc(when(d.at))}</td><td>${esc(d.label)}${d.receipt_no ? ` (${esc(d.receipt_no)})` : ''}</td><td>${esc(METHOD[d.method] || '–')}</td><td class="num">${esc(signedRp(d.amount))}</td><td>${esc(d.by || '–')}${d.note ? `<br><span class="muted small">${esc(d.note)}</span>` : ''}</td></tr>`).join('');
  return infoDialog({
    title: `${r.no} · ${r.customer_name}`, wide: true, buttons,
    html: `<p>${statusTag(r.status)} · Ambil ${esc(pickupText(r))}</p>
      <dl class="kv"><dt>WhatsApp</dt><dd>${esc(phone(r.whatsapp))}${open ? ` · <a href="${esc(waHref(r))}" target="_blank" rel="noopener">Kirim WhatsApp</a>` : ''}</dd>
        <dt>Member</dt><dd>${r.member ? esc(r.member.name) : 'Tidak terhubung'}</dd>
        <dt>Total</dt><dd class="num">${esc(rupiah(r.total))}${open ? ', dibayar penuh saat diambil' : ''}</dd>
        ${r.deposit ? `<dt>Saldo DP lama</dt><dd class="num">${esc(rupiah(r.deposit))}</dd>` : ''}${r.over > 0 ? `<dt>Perlu dikembalikan</dt><dd class="num">${esc(rupiah(r.over))}</dd>` : ''}
        ${r.note ? `<dt>Catatan</dt><dd>${esc(r.note)}</dd>` : ''}
        ${r.receipt_no ? `<dt>Struk</dt><dd>${esc(r.receipt_no)}, diambil ${esc(when(r.picked_at))}</dd>` : ''}
        ${r.cancel_reason ? `<dt>Alasan batal</dt><dd>${esc(r.cancel_reason)}</dd>` : ''}
        <dt>Dicatat</dt><dd>${esc(when(r.created_at))} oleh ${esc(r.created_by || '–')}</dd></dl>
      <div class="table-wrap"><table><thead><tr><th>Produk</th><th class="num">Jumlah</th><th class="num">Harga</th><th class="num">Subtotal</th></tr></thead><tbody>${items}</tbody></table></div>
      ${r.free_bags ? `<p class="small muted">Paper bag gratis: ${r.free_bags}</p>` : ''}
      ${deps ? `<h3>Riwayat DP lama</h3><div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Jenis</th><th>Lewat</th><th class="num">Jumlah</th><th>Oleh</th></tr></thead><tbody>${deps}</tbody></table></div>` : ''}
      ${open ? '<p class="muted small">Saat pelanggan datang, kasir menyelesaikannya di tablet: Dashboard > Pesanan di muka. Totalnya dibayar penuh saat itu.</p>' : ''}`,
  });
}

/* ================================================================ a. Pesanan di muka */
async function pesananPart(panel, rpc) {
  await screen(panel, {
    title: 'Pesanan di muka', intro: 'Pesanan untuk diambil nanti (arisan, kantor, acara), dibayar penuh saat diambil. Klik satu baris untuk detail, konfirmasi dan pembatalan.',
    from: addDays(ymd(), -7), to: addDays(ymd(), 30),
    controls: `<label class="field"><span>Status</span><select data-c="status"><option value="">Semua</option><option value="aktif">Belum diambil</option>
      ${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>`,
    load: ({ from, to, c }) => rpc('pos_reservation_list', { p_from: from, p_to: to, p_status: c.status || null }),
    options: {
      rowKey: 'id', exportName: 'pesanan-di-muka', emptyText: 'Belum ada pesanan di muka di rentang ini.', editLabel: 'Buka',
      defaultSort: { key: 'pickup_at', dir: 'asc' }, searchKeys: ['no', 'customer_name', 'whatsapp', 'items_text', 'note'],
      columns: [
        { key: 'no', label: 'No.', sort: true, format: nb, export: (r) => r.no },
        { key: 'pickup_at', label: 'Ambil', sort: true, format: (v, r) => pickupText(r), export: (r) => `${r.pickup_day} ${r.pickup_time}` },
        { key: 'customer_name', label: 'Pemesan', sort: true },
        { key: 'whatsapp', label: 'WhatsApp', format: (v) => nb(phone(v)), export: (r) => phone(r.whatsapp) },
        { key: 'items_text', label: 'Isi', format: (v) => v || '–' },
        { key: 'total', label: 'Total', sort: true, align: 'num', format: (v) => rupiah(v) },
        { key: 'status', label: 'Status', sort: true, html: true, format: (v) => statusTag(v), export: (r) => (STATUS[r.status] || [r.status])[0] },
      ],
      onAdd: () => editDialog(rpc, null), onEdit: (r) => detailDialog(rpc, r.id),
    },
  });
}

/* ================================================================ b. Mutasi deposito */
async function mutasiPart(panel, rpc) {
  const pickReservation = async () => {
    const open = await rpc('pos_reservation_list', { p_from: addDays(ymd(), -120), p_to: addDays(ymd(), 120), p_status: null });
    const withDp = open.filter((r) => r.deposit !== 0);
    if (!withDp.length) throw new Error('Tidak ada saldo DP lama yang perlu dikoreksi. Hanashuya tidak menerima DP sejak 13 Nov 2026.');
    let chosen = null;
    const ok = await formDialog({
      title: 'Koreksi saldo DP', submitLabel: 'Lanjut',
      html: `${sel('res', withDp.map((r) => [r.id, `${r.no} · ${r.customer_name} · saldo ${rupiah(r.deposit)}`]), withDp[0].id, `Pesanan ${REQ}`)}`,
      onSubmit: async (form) => { chosen = F(form, 'res').value; },
    });
    if (ok && chosen) await detailDialog(rpc, chosen);
  };
  await screen(panel, {
    title: 'Mutasi deposito', intro: 'Riwayat DP lama: masuk, dipakai, dikembalikan, hangus atau dikoreksi. Hanashuya tidak menerima DP sejak 13 Nov 2026.',
    from: addDays(ymd(), -29), to: ymd(),
    controls: `<label class="field"><span>Jenis</span><select data-c="kind"><option value="">Semua</option>${Object.entries(KIND).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>`,
    load: ({ from, to, c }) => rpc('pos_deposit_moves', { p_from: from, p_to: to, p_kind: c.kind || null }),
    options: {
      rowKey: 'id', exportName: 'mutasi-deposito', emptyText: 'Tidak ada mutasi deposito di rentang ini.', editLabel: 'Buka pesanan',
      defaultSort: { key: 'at', dir: 'desc' }, searchKeys: ['no', 'customer_name', 'label', 'note', 'by', 'receipt_no'],
      columns: [
        { key: 'at', label: 'Waktu', sort: true, format: (v) => when(v), export: (r) => r.at },
        { key: 'no', label: 'No. pesanan', sort: true, format: nb, export: (r) => r.no },
        { key: 'customer_name', label: 'Pemesan', sort: true },
        { key: 'label', label: 'Jenis', sort: true, format: (v, r) => v + (r.receipt_no ? ` (${r.receipt_no})` : '') },
        { key: 'method', label: 'Lewat', format: (v) => METHOD[v] || '–' },
        { key: 'amount', label: 'Jumlah', sort: true, align: 'num', format: (v) => signedRp(v), export: (r) => r.amount },
        { key: 'balance_after', label: 'Saldo sesudahnya', align: 'num', format: (v) => rupiah(v), export: (r) => r.balance_after },
        { key: 'note', label: 'Alasan / catatan', format: (v) => v || '–' },
        { key: 'by', label: 'Oleh', sort: true, format: (v) => v || '–' },
      ],
      onAdd: pickReservation, onEdit: (r) => detailDialog(rpc, r.reservation_id),
    },
  });
}

/* ================================================================ c. Deposit reservasi */
async function depositPart(panel, rpc) {
  await screen(panel, {
    title: 'Deposit reservasi', intro: 'Saldo DP lama per pesanan di muka. Hanashuya tidak menerima DP sejak 13 Nov 2026; yang masih bersaldo dikembalikan atau dinyatakan hangus.',
    from: addDays(ymd(), -30), to: addDays(ymd(), 30),
    load: ({ from, to }) => rpc('pos_deposit_report', { p_from: from, p_to: to }),
    onLoaded: (res, el) => {
      el.innerHTML = `<dl class="kv"><dt>DP pelanggan yang dipegang sekarang</dt><dd class="num"><b>${esc(rupiah(res.held_now))}</b></dd>
        <dt>Perlu dikembalikan atau dinyatakan hangus</dt><dd class="num">${res.to_return ? `<b>${esc(rupiah(res.to_return))}</b> (pesanan batal atau sudah diambil yang masih punya saldo)` : 'Tidak ada'}</dd></dl>`;
    },
    options: {
      rowKey: 'id', exportName: 'deposit-reservasi', emptyText: 'Tidak ada pesanan di muka di rentang ini.', editLabel: 'Buka',
      defaultSort: { key: 'pickup_at', dir: 'desc' }, searchKeys: ['no', 'customer_name', 'receipt_no'],
      columns: [
        { key: 'no', label: 'No.', sort: true, format: nb, export: (r) => r.no },
        { key: 'pickup_at', label: 'Ambil', sort: true, format: (v) => day(v), export: (r) => r.pickup_day },
        { key: 'customer_name', label: 'Pemesan', sort: true },
        { key: 'status', label: 'Status', sort: true, html: true, format: (v) => statusTag(v), export: (r) => (STATUS[r.status] || [r.status])[0] },
        { key: 'total', label: 'Total', sort: true, align: 'num', format: (v) => rupiah(v) },
        { key: 'dp', label: 'DP masuk', sort: true, align: 'num', format: (v) => rupiah(v) },
        { key: 'used', label: 'Dipakai', sort: true, align: 'num', format: (v) => rupiah(v) },
        { key: 'refunded', label: 'Dikembalikan', sort: true, align: 'num', format: (v) => rupiah(v) },
        { key: 'forfeited', label: 'Hangus', sort: true, align: 'num', format: (v) => rupiah(v) },
        { key: 'adjusted', label: 'Koreksi', sort: true, align: 'num', format: (v) => (v ? signedRp(v) : '–'), export: (r) => r.adjusted },
        { key: 'balance', label: 'Saldo', sort: true, align: 'num', html: true, format: (v) => (v > 0 ? `<b>${esc(rupiah(v))}</b>` : esc(rupiah(v))), export: (r) => r.balance },
      ],
      onEdit: (r) => detailDialog(rpc, r.id),
    },
  });
}

/* ================================================================ d. Koreksi stempel / Riwayat stempel */
async function stempelPart(panel, rpc) {
  const addDialog = () => formDialog({
    title: 'Koreksi stempel', submitLabel: 'Simpan koreksi',
    html: `${memberBlock().replace('Member (tidak wajib)', `Member ${REQ}`).replace(/<p class="small muted">Kalau terhubung[^<]*<\/p>/, '')}
      <div class="dt-fields">${sel('dir', [['1', 'Tambah stempel'], ['-1', 'Kurangi stempel']], '1', 'Koreksi')}
        ${inp('n', `Jumlah stempel ${REQ}`, 'inputmode="numeric"', '1')}</div>
      ${inp('why', `Alasan ${REQ}`, 'maxlength="200" placeholder="Misalnya: kemarin lupa scan kartu, struk HS-…"')}
      <p class="muted small">Stempel yang sudah dipakai untuk hadiah kartu tidak bisa dikurangi. Koreksi tampil di riwayat member dan bisa dibatalkan.</p>`,
    onOpen: (form) => memberPicker(rpc, form, null),
    onSubmit: async (form) => {
      const id = F(form, 'member_id').value;
      if (!id) throw new Error('Pilih membernya dulu.');
      const n = Number(F(form, 'n').value);
      if (!Number.isInteger(n) || n < 1) throw new Error('Isi jumlah stempel, angka 1 atau lebih.');
      const res = await rpc('pos_stamp_adjust', { p_member: id, p_delta: n * Number(F(form, 'dir').value), p_reason: F(form, 'why').value });
      toast(`Stempel Kak ${res.member} sekarang ${res.total_stamps}`);
    },
  });
  const detail = (r) => {
    const head = `<dl class="kv"><dt>Member</dt><dd>${esc(r.member)}${r.card_code ? ` (${esc(r.card_code)})` : ''}</dd>
      <dt>Perubahan</dt><dd class="num">${r.delta > 0 ? '+' : ''}${r.delta} stempel</dd><dt>Waktu</dt><dd>${esc(when(r.at))}</dd>
      <dt>Sumber</dt><dd>${r.kind === 'koreksi' ? 'Koreksi stempel' : `Penjualan ${esc(r.receipt_no || '')}`}</dd><dt>Oleh</dt><dd>${esc(r.by || '–')}</dd>
      ${r.reason ? `<dt>Alasan</dt><dd>${esc(r.reason)}</dd>` : ''}${r.reversed ? `<dt>Status</dt><dd>Dibatalkan${r.cancel_reason ? `: ${esc(r.cancel_reason)}` : ''}</dd>` : ''}</dl>`;
    if (r.kind !== 'koreksi' || r.reversed) return infoDialog({ title: 'Riwayat stempel', html: head });
    return formDialog({
      title: 'Koreksi stempel', submitLabel: 'Batalkan koreksi', cancelLabel: 'Tutup',
      html: `${head}<h3>Batalkan koreksi ini?</h3>${inp('why', `Alasan ${REQ}`, 'maxlength="200"')}`,
      onSubmit: async (form) => { await rpc('pos_stamp_adjust_cancel', { p_id: r.adjustment_id, p_reason: F(form, 'why').value }); toast('Koreksi dibatalkan'); },
    });
  };
  await screen(panel, {
    title: 'Koreksi stempel', intro: 'Riwayat stempel semua member: dari penjualan dan dari koreksi. Tambah atau kurangi stempel dengan alasan lewat + Tambah.',
    from: addDays(ymd(), -29), to: ymd(),
    controls: `<label class="field"><span>Tampilkan</span><select data-c="kind"><option value="">Semua</option><option value="koreksi">Koreksi saja</option><option value="penjualan">Penjualan saja</option></select></label>`,
    load: async ({ from, to, c }) => (await rpc('pos_stamp_history', { p_from: from, p_to: to, p_member: null })).filter((r) => !c.kind || r.kind === c.kind),
    options: {
      rowKey: 'sale_id', exportName: 'riwayat-stempel', emptyText: 'Tidak ada perubahan stempel di rentang ini.', editLabel: 'Buka',
      defaultSort: { key: 'at', dir: 'desc' }, searchKeys: ['member', 'card_code', 'receipt_no', 'reason', 'by'],
      columns: [
        { key: 'at', label: 'Waktu', sort: true, format: (v) => when(v), export: (r) => r.at },
        { key: 'member', label: 'Member', sort: true },
        { key: 'delta', label: 'Stempel', sort: true, align: 'num', format: (v) => `${v > 0 ? '+' : ''}${v}` },
        { key: 'kind', label: 'Sumber', sort: true, format: (v, r) => (v === 'koreksi' ? 'Koreksi' : `Penjualan ${r.receipt_no || ''}`.trim()) },
        { key: 'reason', label: 'Alasan', format: (v) => v || '–' },
        { key: 'by', label: 'Oleh', sort: true, format: (v) => v || '–' },
        { key: 'reversed', label: 'Status', sort: true, html: true, format: (v) => (v ? tag('Dibatalkan', 'tag-bad') : ''), export: (r) => (r.reversed ? 'Dibatalkan' : '') },
      ],
      onAdd: addDialog, onEdit: detail,
    },
  });
}

const PARTS = { pesanan: pesananPart, mutasi: mutasiPart, deposit: depositPart, stempel: stempelPart };
