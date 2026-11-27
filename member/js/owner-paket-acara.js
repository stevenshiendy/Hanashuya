// Owner menu group "Paket Acara" (Glenn, 27 Nov 2026): bulk orders for events, from the printed A4 Paket
// Acara document. Invoices (client, address, WhatsApp, items with prices and quantity, the package
// discount, bonus boxes, delivery fee, an extra promo), leads from the website form, the products sold
// this way, and the package settings (tiers, delivery, payment, terms). The maths is in
// supabase/paket-acara.sql (_bulk_calc); this page only shows what the database works out.
//   mountPaketAcara(panel, { rpc, part })   part: 'invoice' | 'peminat' | 'produk' | 'pengaturan'
import { $, $$, esc, rupiah, toast, prettyPhone } from './lib.js';
import { dataTable, formDialog, infoDialog } from './data-table.js';
import { rangeHtml, wireRange, ymdToday } from './owner-range.js';
import { pdfBlob, sharePdf } from './pdf.js';

const tag = (text, kind = '') => `<span class="tag ${kind}">${esc(text)}</span>`;
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorHtml = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;
const REQ = '<span class="hint is-req">wajib</span>';
const num = (raw) => { const d = String(raw ?? '').replace(/[^\d]/g, ''); return d ? Number(d) : null; };
const km = (raw) => { const v = Number(String(raw ?? '').replace(',', '.')); return Number.isFinite(v) ? v : null; };
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayText = (iso) => (iso ? new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(String(iso).slice(0, 10) + 'T00:00:00Z')) : '–');
const nb = (v) => String(v ?? '').replace(/-/g, '‑');
const F = (form, k) => form.querySelector(`[data-f="${k}"]`);
const inp = (name, label, extra = '', value = '') => `<label class="field"><span>${label}</span><input type="text" data-f="${name}" autocomplete="off" value="${esc(value)}" ${extra}></label>`;
const sel = (name, opts, pick, label) => `<label class="field"><span>${label}</span><select data-f="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(pick ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;

const STATUS = { draft: ['Draft', ''], terkirim: ['Terkirim', 'tag-warn'], lunas: ['Lunas', 'tag-ok'], batal: ['Batal', 'tag-bad'] };
const LEAD = { baru: ['Baru', 'tag-warn'], dihubungi: ['Dihubungi', ''], invoice: ['Sudah invoice', 'tag-ok'], batal: ['Batal', 'tag-bad'] };
const statusTag = (map, s) => (map[s] ? tag(map[s][0], map[s][1]) : esc(s));
const PAY = { qris: 'QRIS', transfer: 'Transfer' };

export async function mountPaketAcara(panel, { rpc, part }) {
  panel.innerHTML = loadingHtml;
  try {
    if (part === 'invoice') await invoices(panel, rpc);
    else if (part === 'peminat') await leads(panel, rpc);
    else if (part === 'produk') await products(panel, rpc);
    else await settings(panel, rpc);
  } catch (e) { panel.innerHTML = errorHtml(e); }
}

/* ================================================================ invoice: what the client sees
   Simple on purpose (Glenn, 27 Nov 2026: "simplify the invoice with information hierarchy"): the amount
   to pay first, then where it goes, the items (the bonus box is an item line), then four summary rows.
   A waived flavour charge doesn't show as two lines that cancel out; it counts in "Kakak hemat". */
const charged = (q) => !q.surcharge_waived;
function itemRows(q) {
  const rows = q.lines.map((l) => {
    const sc = charged(q) ? (l.surcharge || 0) : 0;
    return { name: l.name, flavour: l.flavour, qty: l.qty, price: l.price + sc, amount: (l.price + sc) * l.qty };
  });
  if (q.bonus_boxes) rows.push({ name: `Bonus ${q.bonus_name}`, flavour: '', qty: q.bonus_boxes, price: 0, amount: 0, bonus: true });
  return rows;
}
function summaryRows(q) {
  const rows = [['Subtotal', rupiah(itemRows(q).reduce((t, r) => t + r.amount, 0))]];
  if (q.discount) rows.push([`Diskon Paket Acara ${Number(q.pct)}%`, '-' + rupiah(q.discount)]);
  if (q.promo_amount) rows.push([q.promo_label || 'Potongan promo', '-' + rupiah(q.promo_amount)]);
  rows.push(['Ongkir', q.delivery_fee ? rupiah(q.delivery_fee) : 'Gratis']);
  return rows;
}
// What the package saves against normal prices: discount, waived flavour charge, promo and the bonus boxes.
const savedOf = (q) => (q.discount || 0) + (q.surcharge_waived || 0) + (q.promo_amount || 0) + (q.bonus_value || 0);
const savedText = (q) => (savedOf(q) ? `Kakak hemat ${rupiah(savedOf(q))} dari harga normal${q.surcharge_waived ? ', termasuk biaya rasa yang digratiskan' : ''}${q.bonus_boxes ? ' dan bonus box' : ''}.` : '');

function quoteHtml(q) {
  return `<div class="pa-quote stack-sm">
    ${summaryRows(q).map(([k, v]) => `<div class="pa-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}
    <div class="pa-row pa-total"><span>Total</span><span>${esc(rupiah(q.total))}</span></div>
    ${savedOf(q) ? `<p class="small muted">${esc(savedText(q))}</p>` : ''}
    ${(q.warnings || []).map((w) => `<p class="notice notice-warn small">${esc(w)}</p>`).join('')}</div>`;
}

/* ================================================================ invoice: new / change */
async function invoiceDialog(rpc, inv, lead) {
  const [prods, cfg] = await Promise.all([rpc('bulk_product_list'), rpc('bulk_config_get')]);
  const live = prods.filter((p) => p.active || inv?.quote.lines.some((l) => l.product === p.id));
  if (!live.length) throw new Error('Belum ada produk. Tambahkan di Paket Acara > Produk dan harga.');
  const flavours = cfg.flavours || ['Vanilla'];
  const lineHtml = (l = {}) => `<div class="dt-line" data-line>
    ${sel('l-prod', live.map((p) => [p.id, `${p.name} (${rupiah(p.price)})`]), l.product, 'Produk')}
    ${sel('l-flav', flavours.map((f) => [f, f]), l.flavour || cfg.base_flavour, 'Rasa')}
    <label class="field"><span>Jumlah box</span><input type="text" inputmode="numeric" data-f="l-qty" autocomplete="off" value="${esc(l.qty ?? 10)}"></label>
    <button class="btn btn-text" type="button" data-rm>Hapus baris</button></div>`;
  const lines = inv ? inv.quote.lines : [{}];
  const v = inv || { client_name: lead?.name || '', company: lead?.company || '', whatsapp: lead?.whatsapp || '', event_date: lead?.event_date || '' };
  const minDay = addDays(ymdToday(), Number(cfg.lead_days || 2));
  const payload = (form) => ({
    client_name: F(form, 'name').value, company: F(form, 'co').value, address: F(form, 'addr').value, whatsapp: F(form, 'wa').value,
    event_date: F(form, 'event').value || null, delivery_date: F(form, 'deliv').value, distance_km: km(F(form, 'km').value) ?? 0,
    delivery_fee: num(F(form, 'fee').value), delivery_override: F(form, 'fee-own').checked,
    promo_label: F(form, 'promo-l').value, promo_amount: num(F(form, 'promo').value) ?? 0, note: F(form, 'note').value, lead_id: lead?.id || inv?.lead_id || null,
    items: $$('[data-line]', form).map((row) => ({ product: row.querySelector('[data-f="l-prod"]').value, flavour: row.querySelector('[data-f="l-flav"]').value,
      qty: Number(row.querySelector('[data-f="l-qty"]').value) })),
  });
  let saved = null;
  const ok = await formDialog({
    title: inv ? `Ubah ${inv.no}` : 'Invoice Paket Acara baru', wide: true, submitLabel: inv ? 'Simpan perubahan' : 'Simpan invoice',
    html: `<div class="dt-fields">${inp('name', `Nama klien ${REQ}`, 'maxlength="80"', v.client_name)}
        ${inp('co', 'Perusahaan atau acara', 'maxlength="80"', v.company || '')}
        ${inp('wa', `Nomor WhatsApp ${REQ}`, 'inputmode="tel"', v.whatsapp ? prettyPhone(v.whatsapp) : '')}</div>
      <label class="field"><span>Alamat pengiriman ${REQ}</span><textarea data-f="addr" rows="2" maxlength="300">${esc(v.address || '')}</textarea></label>
      <div class="dt-fields">
        <label class="field"><span>Tanggal kirim ${REQ}</span><input type="date" data-f="deliv" value="${esc(v.delivery_date || minDay)}"></label>
        <label class="field"><span>Tanggal acara</span><input type="date" data-f="event" value="${esc(v.event_date || '')}"></label>
        ${inp('km', 'Jarak dari booth (km)', 'inputmode="decimal"', v.distance_km ?? '')}</div>
      <div class="dt-lines" data-lines>${lines.map(lineHtml).join('')}</div>
      <button class="btn btn-quiet" type="button" data-addline>+ Tambah produk</button>
      <div class="dt-fields">${inp('promo-l', 'Promo tambahan (nama)', 'maxlength="60"', inv?.quote.promo_label || '')}
        ${inp('promo', 'Potongan promo (Rp)', 'inputmode="numeric"', inv?.quote.promo_amount || '')}
        ${inp('fee', 'Ongkir manual (Rp)', 'inputmode="numeric"', '')}</div>
      <label class="check"><input type="checkbox" data-f="fee-own"> Pakai ongkir manual, bukan hitungan otomatis</label>
      <label class="field"><span>Catatan di invoice</span><textarea data-f="note" rows="2" maxlength="500">${esc(inv?.note || lead?.note || '')}</textarea></label>
      <div data-quote aria-live="polite"></div>`,
    onOpen: (form) => {
      let seq = 0, timer;
      const box = form.querySelector('[data-quote]');
      const refresh = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const n = ++seq;
          try { const q = await rpc('bulk_quote', { p: payload(form) }); if (n === seq) box.innerHTML = quoteHtml(q); }
          catch (e) { if (n === seq) box.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; }
        }, 300);
      };
      refresh();
      form.addEventListener('input', refresh); form.addEventListener('change', refresh);
      form.addEventListener('click', (e) => {
        if (e.target.closest('[data-addline]')) { form.querySelector('[data-lines]').insertAdjacentHTML('beforeend', lineHtml()); refresh(); }
        const rm = e.target.closest('[data-rm]');
        if (rm && $$('[data-line]', form).length > 1) { rm.closest('[data-line]').remove(); refresh(); }
      });
    },
    onSubmit: async (form) => {
      const p = payload(form);
      if (p.items.some((i) => !Number.isInteger(i.qty) || i.qty < 1)) throw new Error('Isi jumlah box di setiap baris (angka 1 atau lebih).');
      saved = await rpc('bulk_invoice_save', { p_id: inv?.id || null, p });
      toast(inv ? `${saved.no} diubah` : `${saved.no} dibuat`);
    },
  });
  return ok ? saved : null;
}

/* ================================================================ invoice: PDF and WhatsApp */
export async function invoicePdf(inv) {
  const q = inv.quote, c = inv.config || {};
  const paid = inv.status === 'lunas';
  const blocks = [
    { kv: [paid ? `Lunas (${PAY[inv.pay_method] || ''})` : 'Total tagihan', rupiah(q.total)], bold: true },
    ...(paid ? [] : [{ kv: ['Bayar sebelum', dayText(inv.delivery_date)] }]),
    ...(savedOf(q) ? [{ p: savedText(q), muted: true }] : []),
    { h: 'Kirim ke' },
    { p: [inv.client_name, inv.company].filter(Boolean).join(', ') }, { p: inv.address },
    { p: `WhatsApp ${prettyPhone(inv.whatsapp)} · Dikirim ${dayText(inv.delivery_date)}` },
    { h: 'Pesanan' },
    { table: { head: ['Produk', 'Rasa', 'Qty', 'Harga', 'Jumlah'], align: ['l', 'l', 'r', 'r', 'r'], widths: [60, 40, 14, 32, 32],
      rows: itemRows(q).map((r) => [r.name, r.flavour, String(r.qty), r.bonus ? 'Gratis' : rupiah(r.price), rupiah(r.amount)]) } },
    ...summaryRows(q).map(([k, v]) => ({ kv: [k, v] })),
    { kv: ['Total', rupiah(q.total)], bold: true },
    ...(paid ? [] : [{ h: 'Cara bayar' },
      { p: `${c.qris ? 'QRIS Hanashuya, atau transfer' : 'Transfer'} ke ${c.bank} ${c.account_no} a.n. ${c.account_name}. Tulis ${inv.no} di berita transfer.` }]),
    ...(inv.note ? [{ h: 'Catatan' }, { p: inv.note }] : []),
    { h: 'Syarat dan ketentuan' }, ...(c.terms || []).map((t) => ({ p: `– ${t}`, muted: true })),
  ];
  return pdfBlob({ title: `Invoice ${inv.no}`, subtitle: `Paket Acara Hanashuya · ${dayText(inv.issued_on)}`, blocks,
    footer: 'Hanashuya · Papaya Fresh Gallery Bandung · WhatsApp 0858-9012-0577 · Instagram Hanashuya.id' });
}

function waText(inv) {
  const q = inv.quote, c = inv.config || {};
  const lines = q.lines.map((l) => `- ${l.name} ${l.flavour}: ${l.qty} box`);
  if (q.bonus_boxes) lines.push(`- Bonus ${q.bonus_name}: ${q.bonus_boxes} box (gratis)`);
  return [`Halo Kak ${inv.client_name}, ini invoice Paket Acara Hanashuya ${inv.no}.`, '', '*Pesanan*', ...lines, '',
    `Dikirim ${dayText(inv.delivery_date)} ke ${inv.address}.`,
    `*Total ${rupiah(q.total)}*${q.discount ? ` (sudah termasuk diskon ${Number(q.pct)}%)` : ''}.`, '',
    `Pembayaran lunas sebelum pengiriman${c.qris ? ' lewat QRIS Hanashuya atau' : ' lewat'} transfer ke ${c.bank} ${c.account_no} a.n. ${c.account_name}. Pesanan kami kunci setelah pembayaran masuk.`,
    '', 'Terima kasih Kak.'].join('\n');
}
const waHref = (inv) => `https://api.whatsapp.com/send?phone=${encodeURIComponent(inv.whatsapp)}&text=${encodeURIComponent(waText(inv))}`;

async function detailDialog(rpc, id) {
  const inv = await rpc('bulk_invoice_get', { p_id: id });
  const open = ['draft', 'terkirim'].includes(inv.status);
  const set = (status, msg, method = null, note = null) => rpc('bulk_invoice_set_status', { p_id: inv.id, p_status: status, p_method: method, p_note: note }).then(() => toast(msg));
  const buttons = [
    { label: 'Unduh PDF', onClick: async () => { await sharePdf(await invoicePdf(inv), `Invoice ${inv.no}.pdf`, `Invoice ${inv.no}`, { download: true }); return false; } },
  ];
  if (open) buttons.push({ label: 'Kirim WhatsApp', onClick: async () => { window.open(waHref(inv), '_blank', 'noopener'); if (inv.status === 'draft') await set('terkirim', `${inv.no} ditandai terkirim`); } });
  if (open) buttons.push({ label: 'Ubah', onClick: async () => ((await invoiceDialog(rpc, inv)) ? undefined : false) });
  if (open) buttons.push({ label: 'Tandai lunas', onClick: async () => {
    const done = await formDialog({ title: `${inv.no} lunas`, submitLabel: 'Tandai lunas', html: `<p class="muted small">Total ${esc(rupiah(inv.total))}. Cek dulu uangnya sudah masuk.</p>${sel('m', [['qris', 'QRIS'], ['transfer', 'Transfer']], 'transfer', 'Dibayar lewat')}`,
      onSubmit: async (form) => set('lunas', `${inv.no} lunas`, F(form, 'm').value) });
    return done ? undefined : false;
  } });
  if (open) buttons.push({ label: 'Batalkan', danger: true, onClick: async () => {
    const done = await formDialog({ title: `Batalkan ${inv.no}?`, submitLabel: 'Batalkan invoice', html: inp('why', `Alasan ${REQ}`, 'maxlength="200"'),
      onSubmit: async (form) => set('batal', `${inv.no} dibatalkan`, null, F(form, 'why').value) });
    return done ? undefined : false;
  } });
  if (inv.status === 'batal') buttons.push({ label: 'Kembalikan ke draft', onClick: async () => { await set('draft', `${inv.no} kembali ke draft`); } });
  const q = inv.quote;
  return infoDialog({ title: `${inv.no} · ${inv.client_name}`, wide: true, buttons,
    html: `<div class="pa-head"><p class="pa-amount">${esc(rupiah(q.total))}</p>
        <p>${statusTag(STATUS, inv.status)}${inv.pay_method ? ` ${esc(PAY[inv.pay_method])}` : ''}${inv.cancel_reason ? ` <span class="muted small">${esc(inv.cancel_reason)}</span>` : ''}</p></div>
      <p>${esc([inv.client_name, inv.company].filter(Boolean).join(', '))} · ${esc(prettyPhone(inv.whatsapp))}<br>
        <span class="muted">${esc(inv.address)} · dikirim ${esc(dayText(inv.delivery_date))}</span></p>
      <div class="table-wrap"><table class="dt-table"><thead><tr><th scope="col">Produk</th><th scope="col">Rasa</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Jumlah</th></tr></thead>
        <tbody>${itemRows(q).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.flavour)}</td><td class="num">${r.qty}</td><td class="num">${r.bonus ? 'Gratis' : esc(rupiah(r.amount))}</td></tr>`).join('')}</tbody></table></div>
      ${quoteHtml({ ...q, warnings: [] })}${inv.note ? `<p class="small">${esc(inv.note)}</p>` : ''}`,
  });
}

/* ================================================================ invoice list */
async function invoices(panel, rpc) {
  const today = ymdToday();
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Invoice Paket Acara</h1>
      <p class="muted small">Pesanan box untuk acara. Harga paket, bonus dan ongkir dihitung otomatis dari Pengaturan paket.</p></div>
    ${rangeHtml({ preset: '30', max: addDays(today, 366) })}
    <div class="dt-range"><label class="field"><span>Status</span><select data-st><option value="">Semua</option>${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select></label></div>
    <div data-t></div></div>`;
  const load = () => rpc('bulk_invoice_list', { p_from: $('[data-from]', panel).value, p_to: $('[data-to]', panel).value, p_status: $('[data-st]', panel).value || null });
  const t = dataTable($('[data-t]', panel), {
    rows: await load(), reload: load, exportName: 'invoice-paket-acara', emptyText: 'Belum ada invoice di rentang ini.', editLabel: 'Buka',
    columns: [
      { key: 'no', label: 'No.', format: (v) => nb(v), sort: true },
      { key: 'issued_on', label: 'Tanggal', format: (v) => dayText(v), sort: (r) => r.created_at },
      { key: 'client_name', label: 'Klien', format: (v, r) => [v, r.company].filter(Boolean).join(' · '), sort: true },
      { key: 'boxes', label: 'Box', align: 'num', sort: true },
      { key: 'delivery_date', label: 'Kirim', format: (v) => dayText(v), sort: true },
      { key: 'total', label: 'Total', align: 'num', format: (v) => rupiah(v), sort: true },
      { key: 'status', label: 'Status', html: true, format: (v) => statusTag(STATUS, v), sort: true },
    ],
    defaultSort: { key: 'issued_on', dir: 'desc' },
    onAdd: async () => { if (await invoiceDialog(rpc, null)) t.refresh(); },
    onEdit: async (r) => { await detailDialog(rpc, r.id); t.refresh(); },
  });
  wireRange(panel);
  $$('[data-from], [data-to], [data-st]', panel).forEach((e) => e.addEventListener('change', () => t.refresh()));
}

/* ================================================================ leads from the website */
async function leads(panel, rpc) {
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Peminat Paket Acara</h1>
      <p class="muted small">Dari formulir di website. Hubungi lewat WhatsApp, lalu buat invoice dari sini.</p></div>
    <div class="dt-range"><label class="field"><span>Status</span><select data-st><option value="">Semua</option>${Object.entries(LEAD).map(([k, [l]]) => `<option value="${k}"${k === 'baru' ? ' selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div data-t></div></div>`;
  const load = () => rpc('bulk_lead_list', { p_status: $('[data-st]', panel).value || null });
  const t = dataTable($('[data-t]', panel), {
    rows: await load(), reload: load, exportName: 'peminat-paket-acara', emptyText: 'Belum ada peminat baru.', emptyHint: 'Formulir ada di halaman Paket Acara di website.', editLabel: 'Buka',
    columns: [
      { key: 'created_at', label: 'Masuk', format: (v) => dayText(v), sort: true },
      { key: 'name', label: 'Nama', format: (v, r) => [v, r.company].filter(Boolean).join(' · '), sort: true },
      { key: 'whatsapp', label: 'WhatsApp', format: (v) => nb(prettyPhone(v)) },
      { key: 'event_date', label: 'Acara', format: (v) => (v ? dayText(v) : '–'), sort: true },
      { key: 'boxes', label: 'Box', align: 'num', format: (v) => v ?? '–', sort: true },
      { key: 'status', label: 'Status', html: true, format: (v) => statusTag(LEAD, v), sort: true },
    ],
    defaultSort: { key: 'created_at', dir: 'desc' },
    onEdit: async (r) => {
      const set = (s, msg) => rpc('bulk_lead_set_status', { p_id: r.id, p_status: s, p_note: null }).then(() => toast(msg));
      const hello = `Halo Kak ${r.name}, terima kasih sudah tertarik dengan Paket Acara Hanashuya. Boleh kami bantu hitung pesanannya Kak?`;
      await infoDialog({ title: r.name, buttons: [
        { label: 'Chat WhatsApp', onClick: async () => { window.open(`https://api.whatsapp.com/send?phone=${encodeURIComponent(r.whatsapp)}&text=${encodeURIComponent(hello)}`, '_blank', 'noopener'); if (r.status === 'baru') await set('dihubungi', 'Ditandai dihubungi'); } },
        { label: 'Buat invoice', onClick: async () => ((await invoiceDialog(rpc, null, r)) ? undefined : false) },
        ...(r.status !== 'batal' ? [{ label: 'Tidak jadi', danger: true, onClick: async () => { await set('batal', 'Ditandai tidak jadi'); } }] : []),
      ],
      html: `<p>${statusTag(LEAD, r.status)}</p><dl class="kv"><dt>WhatsApp</dt><dd>${esc(prettyPhone(r.whatsapp))}</dd>
        ${r.company ? `<dt>Perusahaan atau acara</dt><dd>${esc(r.company)}</dd>` : ''}
        <dt>Tanggal acara</dt><dd>${esc(r.event_date ? dayText(r.event_date) : '–')}</dd><dt>Perkiraan box</dt><dd>${esc(r.boxes ?? '–')}</dd>
        ${r.note ? `<dt>Catatan</dt><dd>${esc(r.note)}</dd>` : ''}<dt>Masuk</dt><dd>${esc(dayText(r.created_at))}</dd></dl>` });
      t.refresh();
    },
  });
  $('[data-st]', panel).addEventListener('change', () => t.refresh());
}

/* ================================================================ products */
async function products(panel, rpc) {
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Produk dan harga</h1>
      <p class="muted small">Produk yang dijual lewat Paket Acara. Terpisah dari daftar produk kasir. Biaya rasa dikenakan untuk rasa selain Vanilla, kecuali tingkat harga menggratiskannya.</p></div><div data-t></div></div>`;
  const edit = (p) => formDialog({
    title: p ? `Ubah ${p.name}` : 'Produk baru',
    html: `${inp('name', `Nama ${REQ}`, 'maxlength="60"', p?.name || '')}${inp('desc', 'Keterangan', 'maxlength="120"', p?.description || '')}
      <div class="dt-fields">${inp('price', `Harga per box (Rp) ${REQ}`, 'inputmode="numeric"', p?.price ?? '')}${inp('sc', 'Biaya rasa per box (Rp)', 'inputmode="numeric"', p?.flavour_surcharge ?? 3000)}
        ${inp('sort', 'Urutan', 'inputmode="numeric"', p?.sort ?? 9)}</div>
      <label class="check"><input type="checkbox" data-f="box"${p?.counts_as_box === false ? '' : ' checked'}> Dihitung sebagai box untuk tingkat harga</label>
      <label class="check"><input type="checkbox" data-f="on"${p?.active === false ? '' : ' checked'}> Aktif (bisa dipilih di invoice)</label>`,
    onSubmit: async (form) => {
      await rpc('bulk_product_save', { p: { id: p?.id || null, name: F(form, 'name').value, description: F(form, 'desc').value, price: num(F(form, 'price').value),
        flavour_surcharge: num(F(form, 'sc').value) ?? 0, sort: num(F(form, 'sort').value) ?? 9, counts_as_box: F(form, 'box').checked, active: F(form, 'on').checked } });
      toast('Produk disimpan');
    },
  });
  const t = dataTable($('[data-t]', panel), {
    rows: await rpc('bulk_product_list'), reload: () => rpc('bulk_product_list'), exportName: 'produk-paket-acara',
    columns: [
      { key: 'name', label: 'Produk', sort: true }, { key: 'description', label: 'Keterangan' },
      { key: 'price', label: 'Harga', align: 'num', format: (v) => rupiah(v), sort: true },
      { key: 'flavour_surcharge', label: 'Biaya rasa', align: 'num', format: (v) => (v ? rupiah(v) : '–') },
      { key: 'active', label: 'Status', html: true, format: (v) => (v ? tag('Aktif', 'tag-ok') : tag('Nonaktif')) },
    ],
    onAdd: async () => { if (await edit(null)) t.refresh(); },
    onEdit: async (r) => { if (await edit(r)) t.refresh(); },
  });
}

/* ================================================================ package settings */
async function settings(panel, rpc) {
  const c = await rpc('bulk_config_get');
  const tierRow = (t = {}) => `<div class="pa-tier" data-tier>
    ${inp('t-min', 'Mulai dari (box)', 'inputmode="numeric"', t.min ?? '')}${inp('t-pct', 'Diskon (%)', 'inputmode="decimal"', t.pct ?? '')}
    ${inp('t-km', 'Gratis ongkir sampai (km)', 'inputmode="decimal"', t.free_km ?? 0)}
    <label class="check"><input type="checkbox" data-f="t-flav"${t.free_flavour ? ' checked' : ''}> Rasa gratis</label>
    <label class="check"><input type="checkbox" data-f="t-bonus"${t.bonus ? ' checked' : ''}> Bonus box</label>
    <button class="btn btn-text" type="button" data-rm>Hapus</button></div>`;
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Pengaturan paket</h1>
      <p class="muted small">Dipakai untuk setiap invoice baru. Invoice yang sudah dibuat tidak berubah, kecuali dibuka dan disimpan lagi.</p></div>
    <form class="stack" novalidate data-form>
      <h2>Tingkat harga</h2>
      <div class="stack-sm" data-tiers>${(c.tiers || []).map(tierRow).join('')}</div>
      <button class="btn btn-quiet" type="button" data-addtier>+ Tambah tingkat</button>
      <h2>Pesanan dan pengiriman</h2>
      <div class="dt-fields">${inp('min', 'Minimal box', 'inputmode="numeric"', c.min_boxes)}${inp('lead', 'Pesan paling lambat (hari sebelum)', 'inputmode="numeric"', c.lead_days)}
        ${inp('fee', 'Ongkir di luar jarak gratis (Rp)', 'inputmode="numeric"', c.delivery_fee)}${inp('max', 'Jarak antar terjauh (km)', 'inputmode="decimal"', c.max_km)}
        ${inp('base', 'Gratis ongkir di bawah tingkat pertama (km)', 'inputmode="decimal"', c.base_free_km)}</div>
      <h2>Bonus box</h2>
      <div class="dt-fields">${inp('every', 'Bonus 1 box setiap (box)', 'inputmode="numeric"', c.bonus_every)}${inp('bname', 'Box bonus', 'maxlength="60"', c.bonus_name)}
        ${inp('bval', 'Nilai box bonus (Rp)', 'inputmode="numeric"', c.bonus_value)}</div>
      <h2>Pembayaran</h2>
      <div class="dt-fields">${inp('bank', 'Bank', 'maxlength="40"', c.bank)}${inp('acc', 'Nomor rekening', 'inputmode="numeric" maxlength="30"', c.account_no)}${inp('accn', 'Atas nama', 'maxlength="60"', c.account_name)}</div>
      <label class="check"><input type="checkbox" data-f="qris"${c.qris ? ' checked' : ''}> Bisa bayar lewat QRIS Hanashuya</label>
      <h2>Rasa</h2>
      ${inp('flav', 'Rasa, dipisah koma (yang pertama tanpa biaya rasa)', 'maxlength="200"', (c.flavours || []).join(', '))}
      <h2>Syarat dan ketentuan</h2>
      <label class="field"><span>Satu baris untuk satu poin. Tercetak di invoice.</span><textarea data-f="terms" rows="6">${esc((c.terms || []).join('\n'))}</textarea></label>
      <div class="notice notice-error" data-err role="alert" hidden></div>
      <div class="row"><button class="btn" type="submit">Simpan pengaturan</button></div>
    </form></div>`;
  const form = $('[data-form]', panel);
  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-addtier]')) $('[data-tiers]', form).insertAdjacentHTML('beforeend', tierRow());
    const rm = e.target.closest('[data-rm]');
    if (rm && $$('[data-tier]', form).length > 1) rm.closest('[data-tier]').remove();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('[data-err]', form); err.hidden = true;
    const btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
    try {
      const flavours = F(form, 'flav').value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!flavours.length) throw new Error('Isi paling sedikit 1 rasa.');
      const tiers = $$('[data-tier]', form).map((row) => ({ min: num(row.querySelector('[data-f="t-min"]').value), pct: km(row.querySelector('[data-f="t-pct"]').value),
        free_km: km(row.querySelector('[data-f="t-km"]').value) ?? 0, free_flavour: row.querySelector('[data-f="t-flav"]').checked, bonus: row.querySelector('[data-f="t-bonus"]').checked }));
      await rpc('bulk_config_save', { p: { tiers, min_boxes: num(F(form, 'min').value), lead_days: num(F(form, 'lead').value), delivery_fee: num(F(form, 'fee').value),
        max_km: km(F(form, 'max').value), base_free_km: km(F(form, 'base').value), bonus_every: num(F(form, 'every').value), bonus_name: F(form, 'bname').value.trim(),
        bonus_value: num(F(form, 'bval').value), bank: F(form, 'bank').value.trim(), account_no: F(form, 'acc').value.trim(), account_name: F(form, 'accn').value.trim(),
        qris: F(form, 'qris').checked, flavours, base_flavour: flavours[0], terms: F(form, 'terms').value.split('\n').map((s) => s.trim()).filter(Boolean) } });
      toast('Pengaturan paket disimpan');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });
}

