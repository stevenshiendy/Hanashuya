// Stock (task 15): the Stok screens of the till and the cashier page, and the owner's Stok views.
// All maths is in supabase/stock.sql; this file only shows forms and lists.
//   staffStock(panel, role)              cashier page: every stock form on one page (old layout)
//   staffStock(panel, { part, role })    till: part 'menu' is the Stok chooser (Glenn, 11 Nov 2026):
//                                        Barang masuk, Barang keluar, Stok opname, Permintaan barang,
//                                        Riwayat stok opname, each with Kembali to the chooser. A part
//                                        'masuk', 'keluar', 'opname' (or 'hitung'), 'liner', 'permintaan'
//                                        or 'riwayat' opens that screen straight away.
//   ownerStock(panel, { part })          owner page: now, report, audit, opname, requests, recipe, items, pemasok
// Pemasok (suppliers) and Harga beli on goods in: 12 Nov 2026 (stock.sql).
// Every report names the staff member responsible (chips, none picked at first).
import { $, $$, esc, rpc, busy, notice, toast, time, day, when } from './lib.js';
import { pdfBlob, sharePdf } from './pdf.js';
import { dataTable, formDialog } from './data-table.js';

const KIND = { masuk: 'Masuk', penjualan: 'Terjual', sampel: 'Sampel', buang: 'Dibuang', rusak: 'Rusak', promo: 'Promo' };
// Sampel is rung up in Mode penjualan on the till (stock_sample), per product and flavour (Glenn, 12 Nov 2026).
const OUT_KINDS = [['buang', 'Dibuang'], ['rusak', 'Rusak'], ['promo', 'Promo']];
const STATUS = { aktif: '', diubah: '<span class="tag tag-warn">Diubah</span>', dibatalkan: '<span class="tag tag-bad">Dibatalkan</span>' };
const OPNAME_STATUS = { menunggu: '<span class="tag tag-warn">Menunggu</span>', diterima: '<span class="tag tag-ok">Diterima</span>',
  ditolak: '<span class="tag tag-bad">Ditolak</span>', diganti: '<span class="tag">Diganti</span>' };
const REQ_LABEL = { dikirim: 'Dikirim', sebagian: 'Diterima sebagian', selesai: 'Selesai', batal: 'Batal' };
const REQ_STATUS = { dikirim: '<span class="tag tag-warn">Dikirim</span>', sebagian: '<span class="tag tag-warn">Diterima sebagian</span>',
  selesai: '<span class="tag tag-ok">Selesai</span>', batal: '<span class="tag tag-bad">Batal</span>' };
const REQ = '<span class="hint is-req">wajib</span>';

const qtyText = (n) => Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const withUnit = (n, unit) => `${qtyText(n)} ${esc(unit || '')}`.trim();
const signed = (n) => `${Number(n) > 0 ? '+' : ''}${qtyText(n)}`;
const diffTag = (n) => (Number(n) ? `<span class="tag ${Number(n) < 0 ? 'tag-bad' : 'tag-warn'}">${signed(n)}</span>` : '0');
// Accepts "1.000", "1000", "1,5" and "1.5".
function parseQty(raw) {
  let s = String(raw ?? '').trim().replace(/\s/g, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const ymd = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorHtml = (e) => `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`;
const itemOptions = (items, pick) => items.map((i) => `<option value="${i.id}"${i.id === pick ? ' selected' : ''}>${esc(i.name)} (${esc(i.unit)})</option>`).join('');
const qtyInput = (id, label, extra = '') => `<label class="field"><span>${label} ${REQ}</span><input type="text" inputmode="decimal" id="${id}" autocomplete="off" ${extra}></label>`;

// Staff chips for "Penanggung jawab": staff clocked in first, nobody picked, so staff must tap one.
// The owner account ("Hanashuya") is left out on the till and staff page (Glenn, 13 Nov 2026);
// the owner's back office (owner-transaksi.js) still lists it.
let chipSeq = 0;
function staffChips(all) {
  const staff = (all || []).filter((s) => s.role !== 'owner');
  const name = `sk-who-${++chipSeq}`;
  const onDuty = staff.some((s) => s.on_duty);
  return `<fieldset class="field" data-who><legend>Penanggung jawab ${REQ}</legend>
    ${onDuty ? '<p class="muted small">Yang sedang kerja tampil paling depan.</p>' : ''}
    <div class="choices">${staff.map((s) => `<label class="choice"><input type="radio" name="${name}" value="${esc(s.id)}"><span>${esc(s.name)}</span></label>`).join('')}</div>
  </fieldset>`;
}
const pickedStaff = (form) => $('[data-who] input:checked', form)?.value || null;
const needStaff = 'Pilih staf yang bertanggung jawab.';
const rp = (n) => 'Rp' + Math.round(Number(n || 0)).toLocaleString('id-ID');
const supplierOptions = (list) => `<option value="">Tanpa pemasok</option>${(list || []).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}`;
const supplierField = (list) => `<label class="field"><span>Pemasok</span><select data-supplier>${supplierOptions(list)}</select></label>`;
// Barang masuk (Glenn, 14 Nov 2026): Hanashuya's own kitchen is the default pemasok.
const goodsSupplierField = (list) => {
  const own = (list || []).find((x) => x.name.trim().toLowerCase() === 'hanashuya');
  const opts = (list || []).map((x) => `<option value="${x.id}"${x === own ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
  return `<label class="field"><span>Pemasok</span><select data-supplier>${own ? '' : '<option value="">Tanpa pemasok</option>'}${opts}</select></label>`;
};
// Barang masuk: staff never see harga beli; the server costs the delivery at the item's harga
// pokok (COGS). A manager or the owner may type the total paid instead (Glenn, 14 Nov 2026).
const goodsCostField = () => `<fieldset class="field" data-cost><legend>Total harga beli <span class="hint">boleh dikosongkan</span></legend>
    <input type="radio" value="total" checked hidden>
    <input type="text" inputmode="numeric" autocomplete="off" data-cost-amount placeholder="Rp" aria-label="Total harga beli dalam rupiah">
    <p class="muted small">Kosongkan: otomatis harga pokok (COGS) x jumlah. Diisi: harga pokok barang ini ikut dihitung ulang.</p>
  </fieldset>`;
// Harga beli: one amount, Total or Per satuan (optional).
let costSeq = 0;
function costField(prefix = '') {
  const name = 'sk-cost-' + (++costSeq);
  return `<fieldset class="field" data-cost><legend>${prefix}Harga beli</legend>
    <div class="choices"><label class="choice"><input type="radio" name="${name}" value="total" checked><span>Total</span></label>
      <label class="choice"><input type="radio" name="${name}" value="unit"><span>Per satuan</span></label></div>
    <input type="text" inputmode="numeric" autocomplete="off" data-cost-amount placeholder="Rp, boleh dikosongkan" aria-label="Harga beli dalam rupiah">
  </fieldset>`;
}
// { mode, cost } for the rpc, or {} when empty; throws Error on a bad amount.
function readCost(form) {
  const raw = $('[data-cost-amount]', form).value;
  const v = parseQty(raw);
  if (v === null) return {};
  if (!(v > 0)) throw new Error('Harga beli harus lebih dari 0.');
  return { mode: $('[data-cost] input:checked', form).value, cost: v };
}
const backBtn = '<div><button class="btn btn-quiet" type="button" data-back>Kembali</button></div>';

/* ================================================================ cashier page and till */
export async function staffStock(panel, opts) {
  const o = typeof opts === 'string' || opts == null ? { role: opts } : opts;
  const part = o.part === 'hitung' ? 'opname' : o.part;
  panel.innerHTML = loadingHtml;
  let cat, now, today, open;
  try {
    [cat, now, today, open] = await Promise.all([rpc('stock_catalog'), rpc('stock_now'), rpc('stock_today'),
      rpc('stock_request_open').catch(() => [])]);
  } catch (e) { panel.innerHTML = errorHtml(e); return; }
  const ctx = { cat, now, today, open: open || [], items: cat.items, lead: ['manager', 'owner'].includes(o.role || cat.role) };
  if (part) return stockScreen(panel, part, ctx, o);
  return stockPage(panel, ctx, () => staffStock(panel, opts));
}

// The till: one screen at a time. Kembali (and every saved form) goes to the chooser.
function stockScreen(panel, part, ctx, o) {
  const toMenu = () => staffStock(panel, { ...o, part: 'menu' });
  const show = (p) => stockScreen(panel, p, ctx, o);
  if (part === 'menu') return stockMenu(panel, ctx, show, toMenu);
  panel.innerHTML = `${backBtn}<div class="stack-lg" data-body></div>`;
  $('[data-back]', panel).addEventListener('click', toMenu);
  const body = $('[data-body]', panel);
  const wrap = (title, inner) => { body.innerHTML = `<div class="panel stack"><h1 class="tl-title">${title}</h1>${inner}</div>`; return body.firstElementChild; };
  if (part === 'masuk') return goodsInForm(wrap('Barang masuk', ''), ctx, toMenu);
  if (part === 'keluar') return stockOutForm(wrap('Barang keluar', ''), ctx, toMenu);
  if (part === 'liner') return linerForm(wrap('Potong liner', ''), ctx, toMenu);
  if (part === 'opname') return opnameForm(wrap('Stok opname', ''), ctx, toMenu);
  if (part === 'permintaan') return requestScreen(body, ctx, toMenu);
  if (part === 'minimum' && ctx.lead) return minimumForm(wrap('Stok minimum', ''), ctx);
  if (part === 'riwayat') {
    body.innerHTML = '<h1 class="tl-title">Riwayat stok opname</h1><div class="panel stack" data-h></div>';
    return opnameHistory($('[data-h]', body), ymd(new Date(Date.now() - 29 * 864e5)), ymd(), '30 hari terakhir');
  }
  body.innerHTML = errorHtml(new Error('Bagian stok tidak dikenal.'));
}

function stockMenu(panel, ctx, show, toMenu) {
  const pend = ctx.today.count && ctx.today.count.status === 'menunggu';
  const openReq = ctx.open.length;
  const entries = [
    ['masuk', 'Barang masuk', 'Catat kiriman dapur atau supplier.'],
    ['keluar', 'Barang keluar', 'Dibuang, rusak atau promo. Sampel dicatat di Mode penjualan.'],
    ['opname', 'Stok opname', 'Hitung stok fisik dan bandingkan dengan stok sistem.'],
    ['permintaan', 'Permintaan barang', openReq ? `${openReq} permintaan belum selesai.` : 'Minta barang ke dapur atau supplier, lalu bagikan PDF-nya.'],
    ['riwayat', 'Riwayat stok opname', pend ? 'Ada stok opname yang menunggu dicek.' : 'Hasil stok opname 30 hari terakhir.'],
    ...(ctx.lead ? [['minimum', 'Stok minimum', 'Atur batas peringatan stok menipis.']] : []),
  ];
  panel.innerHTML = `${ctx.lead ? '<div id="sk-pending"></div>' : ''}
  <div class="panel stack">
    <h1 class="tl-title">Stok</h1>
    <ul class="list">${entries.map(([k, t, d]) => `<li><span class="grow"><strong>${t}</strong><br><span class="muted small">${esc(d)}</span></span>
      <button class="btn" type="button" data-go="${k}">Buka</button></li>`).join('')}</ul>
    <div class="row"><button class="btn btn-quiet" type="button" data-go="liner">Potong liner</button>
      <button class="btn btn-quiet" type="button" id="sk-wa">Salin laporan stok hari ini</button></div>
    <div class="notice" id="sk-wa-msg" hidden></div>
  </div>`;
  $$('[data-go]', panel).forEach((b) => b.addEventListener('click', () => show(b.dataset.go)));
  waButton(panel);
  if (ctx.lead) countReview($('#sk-pending', panel), toMenu);
}

// The cashier page (staff.js): every form on one page with a switch, as before.
function stockPage(panel, ctx, reload) {
  const { lead, today, now } = ctx;
  panel.innerHTML = `
  ${lead ? '<div id="sk-pending"></div>' : ''}
  <div class="panel stack">
    <h2>Stok</h2>
    <fieldset class="field"><legend>Mau catat apa?</legend>
      <div class="choices" id="sk-mode">${[['masuk', 'Barang masuk'], ['keluar', 'Barang keluar'], ['liner', 'Potong liner'], ['hitung', 'Stok opname'], ['permintaan', 'Permintaan barang']]
        .map(([v, l], i) => `<label class="choice"><input type="radio" name="sk-mode" value="${v}"${i ? '' : ' checked'}><span>${l}</span></label>`).join('')}</div>
    </fieldset>
    <div class="stack" data-mode="masuk"></div>
    <div class="stack" data-mode="keluar" hidden></div>
    <div class="stack" data-mode="liner" hidden></div>
    <div class="stack" data-mode="hitung" hidden></div>
    <div class="stack-lg" data-mode="permintaan" hidden></div>
  </div>

  <div class="panel stack">
    <h2>Hari ini</h2>
    ${todayHtml(today)}
  </div>

  <div class="panel stack">
    <h2>Stok sekarang</h2>
    ${nowTable(now)}
  </div>

  <div class="panel stack" id="sk-hist"></div>

  <div class="panel stack">
    <h2>Laporan ke grup WhatsApp</h2>
    <p class="muted small">Setelah tutup booth, salin laporan ini dan tempel di grup Penerimaan Barang Hanashuya.</p>
    <div class="notice" id="sk-wa-msg" hidden></div>
    <button class="btn btn-quiet btn-big" type="button" id="sk-wa">Salin laporan stok hari ini</button>
  </div>
  ${lead ? '<div class="panel stack" id="sk-audit"></div>' : ''}`;
  const box = (m) => $(`[data-mode="${m}"]`, panel);
  goodsInForm(box('masuk'), ctx, reload);
  stockOutForm(box('keluar'), ctx, reload);
  linerForm(box('liner'), ctx, reload);
  opnameForm(box('hitung'), ctx, reload);
  requestScreen(box('permintaan'), ctx, reload, true);
  $$('input[name="sk-mode"]', panel).forEach((r) => r.addEventListener('change', () => {
    $$('[data-mode]', panel).forEach((b) => { b.hidden = b.dataset.mode !== r.value; });
  }));
  waButton(panel);
  opnameHistory($('#sk-hist', panel), ymd(new Date(Date.now() - 29 * 864e5)), ymd(), 'Riwayat stok opname, 30 hari terakhir');
  if (lead) {
    countReview($('#sk-pending', panel), reload);
    goodsInAudit($('#sk-audit', panel), ymd(new Date(Date.now() - 6 * 864e5)), ymd(), true, 'Barang masuk 7 hari terakhir (cek manajer)');
  }
}

function waButton(root) {
  $('#sk-wa', root).addEventListener('click', async (e) => {
    const btn = e.currentTarget, msg = $('#sk-wa-msg', root);
    notice(msg, '');
    busy(btn, true, 'Menyiapkan…');
    try {
      const text = await rpc('stock_daily_whatsapp');
      await navigator.clipboard.writeText(text);
      notice(msg, 'Tersalin. Tempel di grup Penerimaan Barang Hanashuya.', 'ok');
    } catch (err) { notice(msg, err.message || 'Laporan tidak bisa disalin. Coba lagi.'); }
    busy(btn, false);
  });
}

/* ---------------------------------------------------------------- forms */
function goodsInForm(box, { items, cat, open, lead }, done) {
  const form = document.createElement('form');
  form.className = 'stack'; form.noValidate = true;
  form.innerHTML = `
    ${open.length ? `<label class="field"><span>Dari permintaan</span><select data-req>
      <option value="">Bukan dari permintaan</option>
      ${open.map((r) => `<option value="${r.id}">${esc(r.no)}${r.needed_by ? ', dibutuhkan ' + esc(day(r.needed_by)) : ''}</option>`).join('')}</select></label>` : ''}
    <label class="field"><span>Barang ${REQ}</span><select data-item>${itemOptions(items)}</select></label>
    <p class="muted small" data-req-left hidden></p>
    ${qtyInput('sk-in-qty-' + (++chipSeq), 'Jumlah', 'data-qty')}
    ${goodsSupplierField(cat.suppliers)}
    ${lead ? goodsCostField() : ''}
    ${staffChips(cat.staff)}
    <label class="field"><span>Catatan</span><input type="text" data-note maxlength="200" placeholder="Contoh: kiriman dapur pagi"></label>
    <label class="field"><span>Surat jalan</span><input type="text" data-slip maxlength="200" placeholder="Nomor atau isi surat jalan"></label>
    <div class="notice" data-msg hidden></div>
    <button class="btn btn-big" type="submit">Catat barang masuk</button>`;
  box.append(form);
  const reqSel = $('[data-req]', form), itemSel = $('[data-item]', form), left = $('[data-req-left]', form);
  const reqOf = () => open.find((r) => String(r.id) === reqSel?.value);
  const supSel = $('[data-supplier]', form);
  const showLeft = () => {
    const r = reqOf();
    const l = r?.lines.find((x) => String(x.item_id) === itemSel.value);
    left.hidden = !l;
    if (l) {
      left.textContent = `Diminta ${qtyText(l.qty)} ${l.unit}, sudah datang ${qtyText(l.received)} ${l.unit}.`;
      const rest = Number(l.qty) - Number(l.received);
      if (rest > 0) $('[data-qty]', form).value = qtyText(rest);
    }
  };
  reqSel?.addEventListener('change', () => {
    const r = reqOf();
    itemSel.innerHTML = itemOptions(r ? items.filter((i) => r.lines.some((l) => l.item_id === i.id)) : items);
    if (r?.supplier_id && [...supSel.options].some((o) => o.value === String(r.supplier_id))) supSel.value = String(r.supplier_id);
    showLeft();
  });
  itemSel.addEventListener('change', showLeft);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form), msg = $('[data-msg]', form);
    const q = parseQty($('[data-qty]', form).value), who = pickedStaff(form);
    if (!(q > 0)) return notice(msg, 'Isi jumlahnya.');
    if (!who) return notice(msg, needStaff);
    let c;
    try { c = lead ? readCost(form) : {}; } catch (err) { return notice(msg, err.message); }
    busy(btn, true, 'Menyimpan…');
    try {
      const args = { p_item: Number(itemSel.value), p_qty: q, p_note: $('[data-note]', form).value,
        p_slip: $('[data-slip]', form).value, p_responsible: who, p_request: reqSel?.value ? Number(reqSel.value) : null };
      // New arguments are sent only when used, so a database without the update still works.
      if (supSel.value) args.p_supplier = Number(supSel.value);
      if (c.cost) { args.p_cost_mode = c.mode; args.p_cost = c.cost; }
      const g = await rpc('stock_goods_in', args);
      toast(`Tercatat: ${g.item} ${qtyText(g.qty)} ${g.unit}${g.request_no ? ', dari ' + g.request_no : ''}`);
      done();
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
}

function stockOutForm(box, { items, cat }, done) {
  const form = document.createElement('form');
  form.className = 'stack'; form.noValidate = true;
  const kindName = 'sk-out-kind-' + (++chipSeq);
  form.innerHTML = `
    <label class="field"><span>Barang ${REQ}</span><select data-item>${itemOptions(items)}</select></label>
    <fieldset class="field"><legend>Alasan ${REQ}</legend>
      <div class="choices">${OUT_KINDS.map(([v, l], i) => `<label class="choice"><input type="radio" name="${kindName}" value="${v}"${i ? '' : ' checked'}><span>${l}</span></label>`).join('')}</div>
    </fieldset>
    ${qtyInput('sk-out-qty-' + chipSeq, 'Jumlah', 'data-qty')}
    ${staffChips(cat.staff)}
    <label class="field"><span>Keterangan <span class="hint is-req" data-hint hidden>wajib untuk rusak dan promo</span></span><input type="text" data-note maxlength="200" placeholder="Contoh: dus penyok"></label>
    <div class="notice" data-msg hidden></div>
    <button class="btn btn-big" type="submit">Catat barang keluar</button>`;
  box.append(form);
  const kind = () => $(`input[name="${kindName}"]:checked`, form).value;
  $$(`input[name="${kindName}"]`, form).forEach((r) => r.addEventListener('change', () => { $('[data-hint]', form).hidden = !['rusak', 'promo'].includes(kind()); }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form), msg = $('[data-msg]', form);
    const q = parseQty($('[data-qty]', form).value), who = pickedStaff(form);
    if (!(q > 0)) return notice(msg, 'Isi jumlahnya.');
    if (['rusak', 'promo'].includes(kind()) && !$('[data-note]', form).value.trim()) return notice(msg, 'Tulis keterangannya.');
    if (!who) return notice(msg, needStaff);
    busy(btn, true, 'Menyimpan…');
    try {
      const r = await rpc('stock_out', { p_item: Number($('[data-item]', form).value), p_kind: kind(), p_qty: q,
        p_reason: $('[data-note]', form).value, p_responsible: who });
      toast(`Tercatat: ${r.item} ${qtyText(r.qty)} ${KIND[r.kind].toLowerCase()}`);
      done();
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
}

function linerForm(box, { items, now }, done) {
  const liner = (code) => now.find((n) => items.find((i) => i.id === n.id)?.code === code);
  const lb = liner('liner_besar'), lk = liner('liner_kecil');
  const form = document.createElement('form');
  form.className = 'stack'; form.noValidate = true;
  form.innerHTML = `
    <p class="small">1 Paper liner besar dipotong jadi 2 Paper liner kecil.</p>
    ${lb && lk ? `<p class="muted small num">Sekarang: ${qtyText(lb.qty)} besar, ${qtyText(lk.qty)} kecil</p>` : ''}
    <label class="field"><span>Liner besar yang dipotong ${REQ}</span><input type="number" data-qty min="1" max="500" step="1" value="1" inputmode="numeric"></label>
    <div class="notice" data-msg hidden></div>
    <button class="btn btn-big" type="submit">Potong liner</button>`;
  box.append(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    busy(btn, true, 'Menyimpan…');
    try {
      const r = await rpc('stock_cut_liner', { p_qty: Number($('[data-qty]', form).value) });
      toast(`Liner sekarang: ${qtyText(r.besar)} besar, ${qtyText(r.kecil)} kecil`);
      done();
    } catch (err) { notice($('[data-msg]', form), err.message); busy(btn, false); }
  });
}

// Stok opname, any time of day. Stok sistem comes from stock_now; staff write the stok fisik.
// At closing, the choux rows ask for what is left, which is recorded as thrown away.
function opnameForm(box, { items, now, cat }, done) {
  const sys = Object.fromEntries(now.map((n) => [n.id, Number(n.qty)]));
  const form = document.createElement('form');
  form.className = 'stack'; form.noValidate = true;
  form.innerHTML = `
    <p class="small">Hitung stok fisik di booth, lalu tulis jumlahnya. Barang yang tidak dihitung boleh dikosongkan. Hasilnya dicek manajer atau pemilik; kalau diterima, stok fisik menjadi stok sistem yang baru.</p>
    <label class="check"><input type="checkbox" data-close${hourNow() >= 20 ? ' checked' : ''}><span>Stok opname tutup booth: choux yang tersisa dicatat sebagai dibuang</span></label>
    <div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Stok sistem</th><th>Stok fisik</th><th class="num">Selisih</th></tr></thead><tbody>
    ${items.map((i) => `<tr data-item="${i.id}" data-zero="${i.closes_at_zero ? 1 : 0}"><td>${esc(i.name)}
        <span class="muted small" data-lbl></span></td>
      <td class="num">${withUnit(sys[i.id] ?? 0, i.unit)}</td>
      <td><input type="text" inputmode="decimal" autocomplete="off" aria-label="Stok fisik ${esc(i.name)}"></td>
      <td class="num" data-diff></td></tr>`).join('')}
    </tbody></table></div>
    ${staffChips(cat.staff)}
    <label class="field"><span>Catatan</span><input type="text" data-note maxlength="200"></label>
    <div class="notice" data-msg hidden></div>
    <button class="btn btn-big" type="submit">Kirim stok opname</button>`;
  box.append(form);
  const closeBox = $('[data-close]', form);
  const rows = $$('tbody tr', form);
  // Selisih = stok fisik - stok sistem; at closing a choux row is "left, thrown away" (fisik 0).
  const refresh = () => rows.forEach((tr) => {
    const zero = closeBox.checked && tr.dataset.zero === '1';
    $('[data-lbl]', tr).textContent = zero ? '(sisa, dibuang)' : '';
    const q = parseQty($('input', tr).value), s = sys[tr.dataset.item] ?? 0;
    $('[data-diff]', tr).innerHTML = q === null || Number.isNaN(q) ? '' : diffTag(zero ? q - s : q - s);
  });
  closeBox.addEventListener('change', refresh);
  rows.forEach((tr) => $('input', tr).addEventListener('input', refresh));
  refresh();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form), msg = $('[data-msg]', form);
    const lines = [];
    for (const tr of rows) {
      const input = $('input', tr), q = parseQty(input.value);
      if (q === null) continue;
      if (!(q >= 0)) { input.setAttribute('aria-invalid', 'true'); input.focus(); return notice(msg, 'Ada angka yang tidak valid.'); }
      input.removeAttribute('aria-invalid');
      const thrownAway = closeBox.checked && tr.dataset.zero === '1';
      lines.push({ item: Number(tr.dataset.item), counted: thrownAway ? 0 : q, thrown: thrownAway ? q : 0 });
    }
    if (!lines.length) return notice(msg, 'Isi minimal satu barang.');
    const who = pickedStaff(form);
    if (!who) return notice(msg, needStaff);
    busy(btn, true, 'Mengirim…');
    try {
      await rpc('stock_submit_count', { p_lines: lines, p_note: $('[data-note]', form).value, p_responsible: who, p_closing: closeBox.checked });
      toast('Stok opname terkirim');
      done();
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
}

/* ---------------------------------------------------------------- permintaan barang */
// Suggested amount when the stock is at or below its low-stock level: up to twice that level.
const suggest = (n) => (n && n.low_level != null && Number(n.qty) <= Number(n.low_level)
  ? Math.max(0, Math.ceil(2 * Number(n.low_level) - Math.max(0, Number(n.qty)))) : null);

function requestScreen(box, ctx, done, inline = false) {
  box.innerHTML = `<div class="${inline ? 'stack' : 'panel stack'}" data-new>${inline ? '' : '<h1 class="tl-title">Permintaan barang</h1>'}</div>
    <div class="${inline ? 'stack' : 'panel stack'}" data-list></div>`;
  requestForm($('[data-new]', box), ctx, (r) => {
    // Saved: show the number with Bagikan PDF before going back.
    $('[data-new]', box).innerHTML = `${inline ? '' : '<h1 class="tl-title">Permintaan barang</h1>'}
      <div class="notice notice-ok" role="status">Tersimpan sebagai ${esc(r.no)}. Bagikan PDF-nya ke grup WhatsApp.</div>
      <div class="notice" data-msg hidden></div>
      <div class="row"><button class="btn btn-big" type="button" data-pdf>Bagikan PDF</button>
        <button class="btn btn-quiet btn-big" type="button" data-done>Selesai</button></div>`;
    $('[data-pdf]', box).addEventListener('click', (e) => requestPdf(r, e.currentTarget, $('[data-msg]', box)));
    $('[data-done]', box).addEventListener('click', done);
  });
  requestList($('[data-list]', box), ymd(new Date(Date.now() - 29 * 864e5)), ymd(), ctx.lead, 'Permintaan 30 hari terakhir');
}

function requestForm(box, { items, now, cat }, saved) {
  const byId = Object.fromEntries(now.map((n) => [n.id, n]));
  const anySuggest = items.some((i) => suggest(byId[i.id]) > 0);
  const form = document.createElement('form');
  form.className = 'stack'; form.noValidate = true;
  form.innerHTML = `
    <p class="small">Tulis jumlah yang diminta untuk barang yang perlu ditambah; kosongkan yang tidak. Saran muncul kalau stok sudah di bawah batas menipis.</p>
    ${anySuggest ? '<div><button class="btn btn-quiet" type="button" data-fill>Isi sesuai saran</button></div>' : ''}
    <div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Stok sistem</th><th class="num">Saran</th><th>Diminta</th></tr></thead><tbody>
    ${items.map((i) => { const s = suggest(byId[i.id]); return `<tr data-item="${i.id}" data-suggest="${s ?? ''}"><td>${esc(i.name)} <span class="muted">${esc(i.unit)}</span></td>
      <td class="num">${qtyText(byId[i.id]?.qty)}</td><td class="num">${s ? qtyText(s) : ''}</td>
      <td><input type="text" inputmode="decimal" autocomplete="off" aria-label="Diminta ${esc(i.name)}"></td></tr>`; }).join('')}
    </tbody></table></div>
    <label class="field"><span>Dibutuhkan tanggal ${REQ}</span><input type="date" data-need min="${ymd()}" value="${ymd(new Date(Date.now() + 864e5))}"></label>
    ${supplierField(cat.suppliers)}
    ${staffChips(cat.staff)}
    <label class="field"><span>Catatan</span><input type="text" data-note maxlength="300" placeholder="Contoh: untuk akhir pekan"></label>
    <div class="notice" data-msg hidden></div>
    <button class="btn btn-big" type="submit">Simpan permintaan</button>`;
  box.append(form);
  $('[data-fill]', form)?.addEventListener('click', () => $$('tbody tr', form).forEach((tr) => {
    if (tr.dataset.suggest && !$('input', tr).value) $('input', tr).value = qtyText(tr.dataset.suggest);
  }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form), msg = $('[data-msg]', form);
    const lines = [];
    for (const tr of $$('tbody tr', form)) {
      const input = $('input', tr), q = parseQty(input.value);
      if (q === null) continue;
      if (!(q > 0)) { input.setAttribute('aria-invalid', 'true'); input.focus(); return notice(msg, 'Ada angka yang tidak valid.'); }
      input.removeAttribute('aria-invalid');
      lines.push({ item: Number(tr.dataset.item), qty: q });
    }
    if (!lines.length) return notice(msg, 'Isi minimal satu barang yang diminta.');
    const need = $('[data-need]', form).value;
    if (!need) return notice(msg, 'Isi tanggal barang dibutuhkan.');
    const who = pickedStaff(form);
    if (!who) return notice(msg, needStaff);
    busy(btn, true, 'Menyimpan…');
    try {
      const args = { p_lines: lines, p_needed_by: need, p_note: $('[data-note]', form).value, p_responsible: who };
      if ($('[data-supplier]', form).value) args.p_supplier = Number($('[data-supplier]', form).value);
      const r = await rpc('stock_request_create', args);
      toast(`Permintaan ${r.no} tersimpan`);
      saved(r);
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
}

async function requestPdf(r, btn, msg, download = false) {
  busy(btn, true, 'Menyiapkan…');
  notice(msg, '');
  try {
    const got = r.lines.some((l) => Number(l.received) > 0);
    const blob = await pdfBlob({ title: `Permintaan barang ${r.no}`, subtitle: `${day(r.at)}${r.needed_by ? ', dibutuhkan ' + day(r.needed_by) : ''}`, blocks: [
      { kv: ['Nomor', r.no], bold: true },
      { kv: ['Tanggal', `${day(r.at)} ${time(r.at)}`] },
      { kv: ['Diminta oleh', r.responsible || '-'] },
      ...(r.supplier ? [{ kv: ['Pemasok', r.supplier] }] : []),
      { kv: ['Dibutuhkan', r.needed_by ? day(r.needed_by) : '-'] },
      { kv: ['Status', REQ_LABEL[r.status] || r.status] },
      { h: 'Barang' },
      { table: { head: ['Barang', 'Satuan', 'Stok sekarang', 'Diminta', ...(got ? ['Sudah datang'] : [])],
        rows: r.lines.map((l) => [l.item, l.unit, qtyText(l.stock_at), qtyText(l.qty), ...(got ? [qtyText(l.received)] : [])]),
        align: ['l', 'l', 'r', 'r', 'r'], widths: got ? [62, 20, 32, 32, 32] : [78, 22, 39, 39] } },
      ...(r.note ? [{ rule: true }, { h: 'Catatan' }, { p: r.note }] : []),
    ] });
    const how = await sharePdf(blob, `${r.no}.pdf`, `Permintaan barang ${r.no}`, { download });
    if (how === 'downloaded') notice(msg, 'PDF terunduh.', 'ok');
  } catch (err) { notice(msg, err.message); }
  busy(btn, false);
}

// Requests in a date range, newest first, each with Bagikan PDF; a manager or the owner can cancel one.
async function requestList(box, from, to, canCancel, title, pdfLabel = 'Bagikan PDF') {
  box.innerHTML = `<h2>${esc(title)}</h2><div aria-busy="true" class="skeleton"></div>`;
  let rows;
  try { rows = await rpc('stock_request_list', { p_from: from, p_to: to }); }
  catch (e) { box.innerHTML = `<h2>${esc(title)}</h2>${errorHtml(e)}`; return; }
  box.innerHTML = `<h2>${esc(title)}</h2>
    ${rows.length ? `<ul class="list">${rows.map((r) => `<li data-r="${r.id}"><span class="grow"><strong>${esc(r.no)}</strong> ${REQ_STATUS[r.status] || ''}
        <br><span class="muted small">${esc(when(r.at))}, diminta ${esc(r.responsible || '-')}${r.needed_by ? ', dibutuhkan ' + esc(day(r.needed_by)) : ''}${r.supplier ? ', pemasok ' + esc(r.supplier) : ''}</span>
        <br><span class="small">${r.lines.map((l) => `${esc(l.item)} ${withUnit(l.qty, l.unit)}${Number(l.received) ? ` (datang ${qtyText(l.received)})` : ''}`).join(', ')}</span>
        ${r.note ? `<br><span class="muted small">${esc(r.note)}</span>` : ''}
        ${r.status === 'batal' ? `<br><span class="small">Dibatalkan ${esc(r.cancelled_by || '-')}: ${esc(r.cancel_reason || '')}</span>` : ''}
        <span class="notice" data-msg hidden></span></span>
        <span class="row"><button class="btn btn-quiet" type="button" data-pdf>${pdfLabel}</button>
        ${canCancel && ['dikirim', 'sebagian'].includes(r.status) ? '<button class="btn btn-text" type="button" data-cancel>Batalkan</button>' : ''}</span>
      </li>`).join('')}</ul>` : '<p class="muted">Belum ada permintaan barang di tanggal ini.</p>'}
    <form class="stack" hidden novalidate data-form>
      <h3 data-form-title></h3>
      <label class="field"><span>Alasan ${REQ}</span><input type="text" maxlength="200" data-reason></label>
      <div class="notice" hidden data-msg></div>
      <div class="row"><button class="btn" type="submit">Batalkan permintaan</button><button class="btn btn-quiet" type="button" data-close>Tutup</button></div>
    </form>`;
  const form = $('[data-form]', box);
  let target = null;
  $$('li[data-r]', box).forEach((li) => {
    const r = rows.find((x) => String(x.id) === li.dataset.r);
    $('[data-pdf]', li).addEventListener('click', (e) => requestPdf(r, e.currentTarget, $('[data-msg]', li), pdfLabel === 'Unduh PDF'));
    $('[data-cancel]', li)?.addEventListener('click', () => {
      target = r; $('[data-form-title]', form).textContent = `Batalkan ${r.no}`;
      $('[data-reason]', form).value = ''; notice($('[data-msg]', form), ''); form.hidden = false; $('[data-reason]', form).focus();
    });
  });
  $('[data-close]', form).addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('stock_request_cancel', { p_id: target.id, p_reason: $('[data-reason]', form).value });
      toast(`${target.no} dibatalkan`);
      requestList(box, from, to, canCancel, title, pdfLabel);
    } catch (err) { notice($('[data-msg]', form), err.message); busy(btn, false); }
  });
}

// Stok minimum (Glenn, 12 Nov 2026): a manager or the owner sets, per item, the level at which
// the till Dashboard warns. Empty = no warning.
function minimumForm(box, ctx) {
  const rows = ctx.now.items || ctx.now;
  box.insertAdjacentHTML('beforeend', `<p class="muted small">Peringatan muncul di Dashboard kasir kalau stok sama dengan atau di bawah angka ini. Kosongkan kalau tidak perlu.</p>
    <div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Stok sekarang</th><th>Stok minimum</th><th>Satuan</th><th></th></tr></thead><tbody>
    ${rows.map((i) => `<tr data-id="${i.id}"><td>${esc(i.name)}</td><td class="num">${withUnit(i.qty, i.unit)}</td>
      <td><input type="text" inputmode="decimal" value="${i.low_level != null ? qtyText(i.low_level) : ''}" aria-label="Stok minimum ${esc(i.name)} dalam ${esc(i.unit)}" data-min></td>
      <td class="muted">${esc(i.unit)}</td>
      <td><button class="btn btn-quiet" type="button" data-save>Simpan</button></td></tr>`).join('')}</tbody></table></div>
    <div class="notice" data-msg hidden></div>`);
  const msg = $('[data-msg]', box);
  $$('[data-save]', box).forEach((b) => b.addEventListener('click', async () => {
    const tr = b.closest('tr'), raw = $('[data-min]', tr).value.trim().split('.').join('').replace(',', '.');
    const v = raw === '' ? null : Number(raw);
    if (v !== null && (Number.isNaN(v) || v < 0)) return notice(msg, 'Stok minimum tidak valid.');
    busy(b, true, 'Menyimpan…');
    try {
      const r = await rpc('stock_set_minimum', { p_item: Number(tr.dataset.id), p_min: v });
      notice(msg, v === null ? `Peringatan ${r.name} dimatikan.` : `Stok minimum ${r.name}: ${withUnit(v, r.unit)}.`, 'ok');
    } catch (e) { notice(msg, e.message); }
    busy(b, false);
  }));
}

/* ---------------------------------------------------------------- lists */
function todayHtml(t) {
  const gi = t.goods_in.length ? `<ul class="list">${t.goods_in.map((g) => `<li><span class="grow"><strong>${esc(g.item)}</strong> ${withUnit(g.current_qty, g.unit)}
      <br><span class="muted small">${esc(time(g.at))}, penanggung jawab ${esc(g.responsible || g.received_by || '-')}${g.request_no ? ', dari ' + esc(g.request_no) : ''}${g.supplier ? ', pemasok ' + esc(g.supplier) : ''}${g.note ? ', ' + esc(g.note) : ''}</span></span>${STATUS[g.status] || ''}</li>`).join('')}</ul>`
    : '<p class="muted small">Belum ada barang masuk hari ini.</p>';
  const outs = t.outs.length ? `<ul class="list">${t.outs.map((o) => `<li><span class="grow"><strong>${esc(o.item)}</strong> ${withUnit(o.qty, o.unit)}
      <br><span class="muted small">${esc(time(o.at))}, ${esc(KIND[o.kind] || o.kind)}${o.reason && o.reason !== KIND[o.kind] ? ': ' + esc(o.reason) : ''}, penanggung jawab ${esc(o.responsible || o.by || '-')}</span></span></li>`).join('')}</ul>`
    : '<p class="muted small">Belum ada barang keluar selain penjualan.</p>';
  // What left through sales today, per item, from the recipes (Glenn, 12 Nov 2026).
  const sold = (t.sold || []).length ? `<ul class="list">${t.sold.map((x) => `<li><span class="grow">${esc(x.item)}</span><b class="num">${withUnit(x.qty, x.unit)}</b></li>`).join('')}</ul>`
    : '<p class="muted small">Belum ada penjualan hari ini.</p>';
  const c = t.count;
  const count = c ? `<p class="small">Stok opname ${esc(time(c.at))}, penanggung jawab ${esc(c.responsible || c.by || '-')}: ${c.status === 'diterima'
      ? '<span class="tag tag-ok">Diterima</span>' : '<span class="tag tag-warn">Menunggu dicek</span>'}</p>` : '<p class="muted small">Belum ada stok opname hari ini.</p>';
  return `<h3>Barang masuk</h3>${gi}<h3>Keluar karena penjualan</h3>${sold}<h3>Barang keluar lain</h3>${outs}
    ${Number(t.liner_cut) ? `<p class="small">Liner besar dipotong: ${qtyText(t.liner_cut)}</p>` : ''}<h3>Stok opname</h3>${count}`;
}

function nowTable(rows) {
  if (!rows.length) return '<p class="muted">Belum ada barang.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Stok</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${withUnit(r.qty, r.unit)}</td>
      <td>${r.low ? '<span class="tag tag-bad">Menipis</span>' : Number(r.qty) < 0 ? '<span class="tag tag-warn">Minus</span>' : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// The lines of one stok opname: stok sistem, stok fisik, selisih, stok aktual (and dibuang at closing).
function opnameTable(c) {
  const thrown = c.lines.some((l) => Number(l.thrown));
  const v = (l, k, old) => l[k] ?? l[old];
  return `<div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Stok sistem</th><th class="num">Stok fisik</th>
      ${thrown ? '<th class="num">Dibuang</th>' : ''}<th class="num">Selisih</th><th class="num">Stok aktual</th></tr></thead><tbody>
    ${c.lines.map((l) => { const a = l.actual !== undefined ? l.actual : (c.status === 'diterima' ? l.counted : null);
      return `<tr><td>${esc(l.item)}</td><td class="num">${withUnit(v(l, 'system', 'expected'), l.unit)}</td><td class="num">${withUnit(v(l, 'physical', 'counted'), l.unit)}</td>
      ${thrown ? `<td class="num">${Number(l.thrown) ? withUnit(l.thrown, l.unit) : ''}</td>` : ''}
      <td class="num">${diffTag(v(l, 'selisih', 'difference'))}</td>
      <td class="num">${a === null ? '<span class="muted">menunggu</span>' : withUnit(a, l.unit)}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

const selisihText = (c) => (Number(c.items_off) ? `${qtyText(c.items_off)} barang selisih: ${c.selisih.map((s) => `${signed(s.qty)} ${esc(s.unit)}`).join(', ')}` : 'Tanpa selisih');

// Riwayat stok opname: one row per opname; Lihat opens every line.
async function opnameHistory(box, from, to, title) {
  box.innerHTML = `<h2>${esc(title)}</h2><div aria-busy="true" class="skeleton"></div>`;
  let rows;
  try { rows = await rpc('stock_opname_list', { p_from: from, p_to: to }); }
  catch (e) { box.innerHTML = `<h2>${esc(title)}</h2>${errorHtml(e)}`; return; }
  box.innerHTML = `<h2>${esc(title)}</h2>
    ${rows.length ? `<ul class="list">${rows.map((c) => `<li data-c="${c.id}"><div class="grow"><strong>${esc(when(c.at))}</strong> ${OPNAME_STATUS[c.status] || ''}${c.closing ? ' <span class="tag">Tutup booth</span>' : ''}
        <br><span class="muted small">Penanggung jawab ${esc(c.responsible || '-')}, dikirim ${esc(c.by || '-')}${c.decided_by && c.status !== 'diganti' ? `, dicek ${esc(c.decided_by)}` : ''}</span>
        <br><span class="small">${selisihText(c)}</span>
        <div class="stack" data-detail hidden></div></div>
        <button class="btn btn-quiet" type="button" data-open aria-expanded="false">Lihat</button></li>`).join('')}</ul>`
      : '<p class="muted">Belum ada stok opname di tanggal ini.</p>'}`;
  $$('li[data-c]', box).forEach((li) => $('[data-open]', li).addEventListener('click', async (e) => {
    const btn = e.currentTarget, det = $('[data-detail]', li);
    if (!det.hidden) { det.hidden = true; btn.textContent = 'Lihat'; btn.setAttribute('aria-expanded', 'false'); return; }
    busy(btn, true, 'Memuat…');
    try {
      const c = await rpc('stock_opname_detail', { p_id: Number(li.dataset.c) });
      det.innerHTML = `${opnameTable(c)}
        ${c.note ? `<p class="small">Catatan: ${esc(c.note)}</p>` : ''}
        ${c.decided_by && c.status !== 'diganti' ? `<p class="muted small">${c.status === 'diterima' ? 'Diterima' : 'Ditolak'} ${esc(c.decided_by)}, ${esc(when(c.decided_at))}${c.decision_note ? ': ' + esc(c.decision_note) : ''}</p>` : ''}
        ${c.status === 'diganti' ? '<p class="muted small">Diganti stok opname yang dikirim sesudahnya.</p>' : ''}`;
      det.hidden = false;
      busy(btn, false); btn.textContent = 'Tutup'; btn.setAttribute('aria-expanded', 'true');
    } catch (err) { det.innerHTML = errorHtml(err); det.hidden = false; busy(btn, false); }
  }));
}

/* ================================================================ manager and owner */
// The stok opname waiting for a decision, with Terima and Tolak.
async function countReview(box, after) {
  let c;
  try { c = await rpc('stock_count_pending'); } catch (e) { box.innerHTML = errorHtml(e); return; }
  if (!c) { box.innerHTML = ''; return; }
  box.innerHTML = `<form class="panel stack" novalidate>
    <h2>Stok opname menunggu dicek</h2>
    <p class="muted small">${esc(day(c.at))} ${esc(time(c.at))}, penanggung jawab ${esc(c.responsible || c.by || '-')}, dikirim ${esc(c.by || '-')}${c.closing ? ', tutup booth' : ''}${c.note ? '. ' + esc(c.note) : ''}</p>
    ${opnameTable(c)}
    <p class="muted small">Kalau diterima, stok fisik menjadi stok sistem yang baru (stok aktual) dan selisihnya tercatat.</p>
    <label class="field"><span>Catatan <span class="hint is-req">wajib kalau ditolak</span></span><input type="text" maxlength="200" data-note></label>
    <div class="notice" hidden data-msg></div>
    <div class="row"><button class="btn" type="button" data-yes>Terima stok opname</button><button class="btn btn-quiet" type="button" data-no>Tolak</button></div>
  </form>`;
  const decide = async (accept, btn) => {
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('stock_decide_count', { p_id: c.id, p_accept: accept, p_note: $('[data-note]', box).value });
      toast(accept ? 'Stok opname diterima' : 'Stok opname ditolak');
      after ? after() : countReview(box);
    } catch (err) { notice($('[data-msg]', box), err.message); busy(btn, false); }
  };
  $('[data-yes]', box).addEventListener('click', (e) => decide(true, e.currentTarget));
  $('[data-no]', box).addEventListener('click', (e) => decide(false, e.currentTarget));
}

// Goods-in audit list. canEdit: show Ubah and Batalkan (manager and owner).
async function goodsInAudit(box, from, to, canEdit, title = 'Barang masuk') {
  box.innerHTML = `<h2>${esc(title)}</h2><div aria-busy="true" class="skeleton"></div>`;
  let rows;
  try { rows = await rpc('stock_goods_in_list', { p_from: from, p_to: to }); }
  catch (e) { box.innerHTML = `<h2>${esc(title)}</h2>${errorHtml(e)}`; return; }
  box.innerHTML = `<h2>${esc(title)}</h2>
    ${rows.length ? `<ul class="list">${rows.map((g) => `<li data-g="${g.id}"><span class="grow"><strong>${esc(g.item)}</strong>
        ${g.status === 'aktif' ? withUnit(g.qty, g.unit) : `${withUnit(g.current_qty, g.unit)} <span class="muted small">(awalnya ${withUnit(g.qty, g.unit)})</span>`}
        <br><span class="muted small">${esc(when(g.at))}, penanggung jawab ${esc(g.responsible || g.received_by || '-')}, dicatat ${esc(g.recorded_by || '-')}${g.request_no ? ', dari ' + esc(g.request_no) : ''}${g.supplier ? ', pemasok ' + esc(g.supplier) : ''}${g.note ? '. ' + esc(g.note) : ''}${g.slip_note ? '. Surat jalan: ' + esc(g.slip_note) : ''}</span>
        ${g.total_cost ? `<br><span class="small">Harga beli ${rp(g.total_cost)} (${rp(g.unit_cost)} per ${esc(g.unit)})</span>` : ''}
        ${g.changes.map((c) => `<br><span class="small">${c.kind === 'batal' ? 'Dibatalkan' : `Diubah ${qtyText(c.old_qty)} jadi ${qtyText(c.new_qty)}${c.old_cost !== c.new_cost ? `, harga beli ${c.old_cost ? rp(c.old_cost) : 'kosong'} jadi ${c.new_cost ? rp(c.new_cost) : 'kosong'}` : ''}`} oleh ${esc(c.by || '-')}, ${esc(when(c.at))}: ${esc(c.reason)}</span>`).join('')}</span>
        ${STATUS[g.status] || ''}
        ${canEdit && g.status !== 'dibatalkan' ? `<span class="row"><button class="btn btn-text" type="button" data-edit>Ubah</button><button class="btn btn-text" type="button" data-cancel>Batalkan</button></span>` : ''}
      </li>`).join('')}</ul>` : '<p class="muted">Tidak ada barang masuk di tanggal ini.</p>'}
    <form class="stack" hidden novalidate data-form>
      <h3 data-form-title></h3>
      <label class="field" data-qty-field><span>Jumlah yang benar</span><input type="text" inputmode="decimal" autocomplete="off" data-qty></label>
      <div data-cost-field>${costField('Koreksi ')}<p class="muted small">Kosongkan kalau harga beli tidak berubah. Harga pokok rata-rata barang tidak dihitung ulang; atur di bagian Barang kalau perlu.</p></div>
      <label class="field"><span>Alasan</span><input type="text" maxlength="200" data-reason required></label>
      <div class="notice" hidden data-msg></div>
      <div class="row"><button class="btn" type="submit">Simpan</button><button class="btn btn-quiet" type="button" data-close>Batal</button></div>
    </form>`;
  if (!canEdit) return;
  const form = $('[data-form]', box);
  let target = null;
  const open = (g, mode) => {
    target = { g, mode };
    $('[data-form-title]', form).textContent = mode === 'edit' ? `Ubah jumlah ${g.item}` : `Batalkan ${g.item} ${qtyText(g.current_qty)} ${g.unit}`;
    $('[data-qty-field]', form).hidden = mode !== 'edit';
    $('[data-cost-field]', form).hidden = mode !== 'edit';
    $('[data-cost-amount]', form).value = '';
    $('[data-qty]', form).value = mode === 'edit' ? qtyText(g.current_qty) : '';
    $('[data-reason]', form).value = '';
    notice($('[data-msg]', form), '');
    form.hidden = false;
    $(mode === 'edit' ? '[data-qty]' : '[data-reason]', form).focus();
  };
  $$('li[data-g]', box).forEach((li) => {
    const g = rows.find((r) => String(r.id) === li.dataset.g);
    $('[data-edit]', li)?.addEventListener('click', () => open(g, 'edit'));
    $('[data-cancel]', li)?.addEventListener('click', () => open(g, 'cancel'));
  });
  $('[data-close]', form).addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form), msg = $('[data-msg]', form);
    const reason = $('[data-reason]', form).value;
    busy(btn, true, 'Menyimpan…');
    try {
      if (target.mode === 'edit') {
        const q = parseQty($('[data-qty]', form).value);
        if (!(q > 0)) throw new Error('Isi jumlah yang benar. Untuk menghapus, pakai Batalkan.');
        const c = readCost(form);
        const args = { p_id: target.g.id, p_qty: q, p_reason: reason };
        if (c.cost) { args.p_cost_mode = c.mode; args.p_cost = c.cost; }
        await rpc('stock_change_goods_in', args);
        toast('Barang masuk diubah');
      } else {
        await rpc('stock_cancel_goods_in', { p_id: target.g.id, p_reason: reason });
        toast('Barang masuk dibatalkan');
      }
      goodsInAudit(box, from, to, canEdit, title);
    } catch (err) { notice(msg, err.message); busy(btn, false); }
  });
}

/* ================================================================ owner page */
// With { part } (owner menu, one feature per view, Glenn 12 Nov) it shows only that part:
// 'now', 'report', 'audit', 'opname', 'requests', 'recipe', 'items' or 'pemasok'. Without it, the old page with a switch.
const OS_PARTS = { now: osNow, report: osReport, audit: osAudit, opname: osOpname, requests: osRequests, recipe: osRecipe, items: osItems, pemasok: osPemasok };
// In the owner menu each part is the whole view, so its title is the page h1 (Glenn, 12 Nov 2026:
// "titles must be the same size wherever"); under the old Stok switch it stays an h2.
const hx = (el) => (el.closest('[data-top]') ? 'h1' : 'h2');
export async function ownerStock(panel, { part } = {}) {
  if (OS_PARTS[part]) { panel.innerHTML = '<div class="stack-lg" data-top></div>'; return OS_PARTS[part](panel.firstElementChild); }
  panel.innerHTML = `
  <div class="panel stack">
    <h1>Stok</h1>
    <div class="choices" id="os-mode" role="radiogroup" aria-label="Bagian stok">${[['now', 'Stok sekarang'], ['report', 'Masuk, keluar, selisih'],
      ['audit', 'Barang masuk'], ['opname', 'Riwayat stok opname'], ['requests', 'Permintaan barang'], ['recipe', 'Resep'], ['items', 'Barang'], ['pemasok', 'Pemasok']]
      .map(([v, l], i) => `<label class="choice"><input type="radio" name="os-mode" value="${v}"${i ? '' : ' checked'}><span>${l}</span></label>`).join('')}</div>
  </div>
  <div id="os-body" class="stack-lg"></div>`;
  const body = $('#os-body', panel);
  const show = (m) => OS_PARTS[m](body);
  $$('input[name="os-mode"]', panel).forEach((r) => r.addEventListener('change', () => show(r.value)));
  show('now');
}

async function osNow(body) {
  const top = hx(body) === 'h1';
  body.innerHTML = `${top ? '<h1>Stok sekarang</h1>' : ''}<div id="os-pending"></div><div class="panel stack" id="os-now"></div>`;
  countReview($('#os-pending', body), () => osNow(body));
  const box = $('#os-now', body);
  box.innerHTML = loadingHtml;
  try {
    const now = await rpc('stock_now');
    const low = now.filter((r) => r.low);
    box.innerHTML = `${top ? '' : '<h2>Stok sekarang</h2>'}
      ${low.length ? `<div class="notice notice-warn" role="status">Stok menipis: ${low.map((r) => `${esc(r.name)} (${withUnit(r.qty, r.unit)})`).join(', ')}.</div>` : ''}
      ${nowTable(now)}
      <p class="muted small">Stok menipis kalau sama dengan atau di bawah batas di bagian Barang. Stok minus berarti ada barang keluar yang belum tercatat masuk; lakukan stok opname untuk membetulkannya.</p>`;
  } catch (e) { box.innerHTML = errorHtml(e); }
}

const REPORT_COLS = [['opening', 'Stok awal'], ['masuk', 'Masuk'], ['terjual', 'Terjual'], ['sampel', 'Sampel'], ['buang', 'Dibuang'],
  ['rusak', 'Rusak'], ['promo', 'Promo'], ['potong_liner', 'Potong liner'], ['expected', 'Stok sistem'], ['counted', 'Stok fisik (opname)'],
  ['selisih', 'Selisih'], ['closing', 'Stok akhir']];

async function osReport(body) {
  const t = ymd();
  body.innerHTML = `<form class="panel stack" id="os-range" novalidate>
      <${hx(body)}>Masuk, keluar, selisih</${hx(body)}>
      <div class="form-grid">
        <label class="field"><span>Dari</span><input type="date" id="os-from" value="${t}" max="${t}"></label>
        <label class="field"><span>Sampai</span><input type="date" id="os-to" value="${t}" max="${t}"></label>
      </div>
      <div class="row"><button class="btn" type="submit">Tampilkan</button><button class="btn btn-quiet" type="button" id="os-xlsx" disabled>Unduh .xlsx</button></div>
      <div class="notice" id="os-range-msg" hidden></div>
    </form>
    <div class="panel stack" id="os-report"></div>`;
  let data = null;
  const box = $('#os-report', body);
  const load = async () => {
    box.innerHTML = loadingHtml;
    notice($('#os-range-msg', body), '');
    try { data = await rpc('stock_report', { p_from: $('#os-from', body).value, p_to: $('#os-to', body).value }); }
    catch (e) { box.innerHTML = errorHtml(e); $('#os-xlsx', body).disabled = true; return; }
    $('#os-xlsx', body).disabled = false;
    box.innerHTML = `<p class="muted small">${esc(day(data.from))}${data.from !== data.to ? ' sampai ' + esc(day(data.to)) : ''}. Selisih minus berarti barang kurang dari catatan.</p>
      <div class="table-wrap"><table><thead><tr><th>Barang</th>${REPORT_COLS.map(([, l]) => `<th class="num">${l}</th>`).join('')}</tr></thead><tbody>
      ${data.items.map((r) => `<tr><td>${esc(r.name)} <span class="muted">${esc(r.unit)}</span></td>
        ${REPORT_COLS.map(([k]) => {
          const v = r[k];
          if (k === 'counted' && v === null) return '<td class="num muted">-</td>';
          if (k === 'selisih' && Number(v)) return `<td class="num"><span class="tag ${Number(v) < 0 ? 'tag-bad' : 'tag-warn'}">${Number(v) > 0 ? '+' : ''}${qtyText(v)}</span></td>`;
          return `<td class="num">${qtyText(v)}</td>`;
        }).join('')}</tr>`).join('')}
      </tbody></table></div>`;
  };
  $('#os-range', body).addEventListener('submit', (e) => { e.preventDefault(); load(); });
  $('#os-xlsx', body).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Menyiapkan…');
    try {
      await loadSheetJS();
      const X = window.XLSX, book = X.utils.book_new();
      const rows = data.items.map((r) => Object.fromEntries([['Barang', r.name], ['Satuan', r.unit],
        ...REPORT_COLS.map(([k, l]) => [l, r[k] === null ? '' : Number(r[k])])]));
      X.utils.book_append_sheet(book, X.utils.json_to_sheet(rows), 'Stok');
      const audit = await rpc('stock_goods_in_list', { p_from: data.from, p_to: data.to });
      const arows = audit.map((g) => ({ Waktu: when(g.at), Barang: g.item, Satuan: g.unit, 'Jumlah dicatat': Number(g.qty),
        'Jumlah sekarang': Number(g.current_qty), Status: g.status, 'Diterima oleh': g.received_by || '', 'Dicatat oleh': g.recorded_by || '',
        'Penanggung jawab': g.responsible || g.received_by || '', 'Dari permintaan': g.request_no || '',
        Catatan: g.note || '', 'Surat jalan': g.slip_note || '',
        Perubahan: g.changes.map((c) => `${c.kind === 'batal' ? 'Batal' : `${c.old_qty} jadi ${c.new_qty}`} oleh ${c.by || '-'}: ${c.reason}`).join('; ') }));
      X.utils.book_append_sheet(book, arows.length ? X.utils.json_to_sheet(arows) : X.utils.aoa_to_sheet([['Kosong']]), 'Barang masuk');
      X.writeFile(book, `hanashuya-stok-${data.from}${data.from !== data.to ? '-sd-' + data.to : ''}.xlsx`);
    } catch (err) { notice($('#os-range-msg', body), err.message); }
    busy(btn, false);
  });
  load();
}

// A date range form above a list; load(from, to) fills the list box.
function rangeView(body, days, title, load) {
  const t = ymd(), f = ymd(new Date(Date.now() - (days - 1) * 864e5));
  body.innerHTML = `<form class="panel stack" novalidate data-range>
      ${title ? `<${hx(body)}>${esc(title)}</${hx(body)}>` : ''}
      <div class="form-grid">
        <label class="field"><span>Dari</span><input type="date" data-from value="${f}" max="${t}"></label>
        <label class="field"><span>Sampai</span><input type="date" data-to value="${t}" max="${t}"></label>
      </div>
      <button class="btn" type="submit">Tampilkan</button>
    </form>
    <div class="panel stack" data-list></div>`;
  const go = () => load($('[data-list]', body), $('[data-from]', body).value, $('[data-to]', body).value);
  $('[data-range]', body).addEventListener('submit', (e) => { e.preventDefault(); go(); });
  go();
}

// Riwayat stok opname (#stok-opname): any date range, with the pending one to decide on top.
function osOpname(body) {
  body.innerHTML = `${hx(body) === 'h1' ? '<h1>Riwayat stok opname</h1>' : ''}<div data-pend></div><div class="stack-lg" data-view></div>`;
  const view = $('[data-view]', body);
  const list = (box, f, t) => opnameHistory(box, f, t, hx(body) === 'h1' ? 'Daftar stok opname' : 'Riwayat stok opname');
  countReview($('[data-pend]', body), () => osOpname(body));
  rangeView(view, 30, '', list);
}

// Permintaan barang (#permintaan): every request with its status and the PDF.
function osRequests(body) {
  rangeView(body, 30, 'Permintaan barang', (box, f, t) => requestList(box, f, t, true, 'Daftar permintaan', 'Unduh PDF'));
}

async function osAudit(body) {
  const t = ymd(), f = ymd(new Date(Date.now() - 29 * 864e5));
  body.innerHTML = `<form class="panel stack" id="oa-range" novalidate>
      <${hx(body)}>Barang masuk</${hx(body)}>
      <div class="form-grid">
        <label class="field"><span>Dari</span><input type="date" id="oa-from" value="${f}" max="${t}"></label>
        <label class="field"><span>Sampai</span><input type="date" id="oa-to" value="${t}" max="${t}"></label>
      </div>
      <button class="btn" type="submit">Tampilkan</button>
    </form>
    <div class="panel stack" id="oa-list"></div>`;
  const load = () => goodsInAudit($('#oa-list', body), $('#oa-from', body).value, $('#oa-to', body).value, true, 'Daftar barang masuk');
  $('#oa-range', body).addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
}

// Recipe editor: one product at a time; a row per item, a column for "every flavour"
// and one per flavour. A flavour cell replaces the every-flavour amount; empty = not set.
async function osRecipe(body, pick) {
  body.innerHTML = loadingHtml;
  let d;
  try { d = await rpc('owner_stock_recipes'); } catch (e) { body.innerHTML = errorHtml(e); return; }
  const code = pick || d.products[0]?.code;
  const p = d.products.find((x) => x.code === code);
  const cols = [{ id: null, label: 'Semua rasa' }, ...(p?.needs_flavour ? d.flavours : [])];
  const lines = d.lines.filter((l) => l.product === code);
  const used = d.items.filter((i) => lines.some((l) => l.item_id === i.id));
  const cell = (item, fl) => lines.find((l) => l.item_id === item && (l.flavour || null) === fl.id);
  const unused = d.items.filter((i) => i.active && !used.includes(i));
  body.innerHTML = `<div class="panel stack">
    <${hx(body)}>Resep</${hx(body)}>
    <p class="muted small">Berapa banyak setiap barang yang dipakai untuk 1 produk. Kolom rasa menggantikan "Semua rasa" untuk barang itu; isi 0 kalau rasa itu tidak memakai barangnya. Kosongkan sel untuk menghapus. Perubahan berlaku untuk penjualan berikutnya.</p>
    <label class="field"><span>Produk</span><select id="or-product">${d.products.map((x) => `<option value="${esc(x.code)}"${x.code === code ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <div class="table-wrap"><table><thead><tr><th>Barang</th>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>
    ${used.map((i) => `<tr><td>${esc(i.name)} <span class="muted">${esc(i.unit)}</span></td>
      ${cols.map((c) => { const l = cell(i.id, c); return `<td><input type="text" inputmode="decimal" autocomplete="off" value="${l ? qtyText(l.qty) : ''}"
        data-item="${i.id}" data-flavour="${esc(c.id || '')}" data-was="${l ? qtyText(l.qty) : ''}" aria-label="${esc(i.name)}, ${esc(c.label)}"></td>`; }).join('')}</tr>`).join('')}
    </tbody></table></div>
    ${unused.length ? `<form class="row" id="or-add" novalidate>
      <label class="field"><span>Tambah barang ke resep</span><select id="or-add-item">${itemOptions(unused)}</select></label>
      <label class="field"><span>Jumlah (semua rasa)</span><input type="text" inputmode="decimal" id="or-add-qty" autocomplete="off"></label>
      <button class="btn" type="submit">Tambah</button></form>` : ''}
    <div class="notice" id="or-msg" hidden></div>
  </div>`;
  $('#or-product', body).addEventListener('change', (e) => osRecipe(body, e.currentTarget.value));
  const save = async (item, flavour, raw) => {
    const q = parseQty(raw);
    if (Number.isNaN(q) || (q !== null && q < 0)) throw new Error('Angka tidak valid.');
    await rpc('owner_stock_save_recipe', { p_product: code, p_flavour: flavour || null, p_item: item, p_qty: q });
  };
  $$('input[data-item]', body).forEach((inp) => inp.addEventListener('change', async () => {
    try {
      await save(Number(inp.dataset.item), inp.dataset.flavour, inp.value);
      inp.dataset.was = inp.value; inp.removeAttribute('aria-invalid');
      notice($('#or-msg', body), '');
      toast('Resep tersimpan');
    } catch (err) { inp.setAttribute('aria-invalid', 'true'); notice($('#or-msg', body), err.message); }
  }));
  $('#or-add', body)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget);
    busy(btn, true, 'Menyimpan…');
    try {
      if (!(parseQty($('#or-add-qty', body).value) >= 0)) throw new Error('Isi jumlahnya.');
      await save(Number($('#or-add-item', body).value), null, $('#or-add-qty', body).value);
      toast('Resep tersimpan');
      osRecipe(body, code);
    } catch (err) { notice($('#or-msg', body), err.message); busy(btn, false); }
  });
}

async function osItems(body) {
  body.innerHTML = loadingHtml;
  let d;
  try { d = await rpc('owner_stock_recipes'); } catch (e) { body.innerHTML = errorHtml(e); return; }
  const row = (i) => `<tr data-id="${i ? i.id : ''}">
    <td><input type="text" value="${esc(i?.name || '')}" maxlength="60" ${i ? '' : 'placeholder="Barang baru"'} aria-label="Nama barang" data-f="name"></td>
    <td><input type="text" value="${esc(i?.unit || '')}" maxlength="10" placeholder="pcs" aria-label="Satuan" data-f="unit"></td>
    <td><input type="text" inputmode="decimal" value="${i && i.low_level !== null ? qtyText(i.low_level) : ''}" aria-label="Batas stok menipis" data-f="low"></td>
    <td><input type="text" inputmode="decimal" value="${i && i.unit_cost != null ? qtyText(i.unit_cost) : ''}" aria-label="Harga pokok per satuan" data-f="cost" placeholder="0"></td>
    <td><label class="check"><input type="checkbox" data-f="zero" ${i?.closes_at_zero ? 'checked' : ''}><span>Habis tiap tutup</span></label></td>
    <td><label class="check"><input type="checkbox" data-f="active" ${!i || i.active ? 'checked' : ''}><span>Dipakai</span></label></td>
    <td><button class="btn ${i ? 'btn-quiet' : ''}" type="button">${i ? 'Simpan' : 'Tambah'}</button></td></tr>`;
  body.innerHTML = `<div class="panel stack">
    <${hx(body)}>Barang dan harga pokok</${hx(body)}>
    <p class="muted small">Batas stok menipis: peringatan muncul kalau stok sama dengan atau di bawah angka ini. Kosongkan kalau tidak perlu. "Habis tiap tutup" untuk choux: sisanya dicatat dibuang saat stok opname tutup booth. Harga pokok: rupiah per satuan (per pcs, atau per gram untuk vla dan selai), untuk laporan laba.</p>
    <div class="table-wrap"><table><thead><tr><th>Nama</th><th>Satuan</th><th>Batas menipis</th><th>Harga pokok (Rp)</th><th></th><th></th><th></th></tr></thead><tbody>
    ${d.items.map(row).join('')}${row(null)}
    </tbody></table></div>
    <div class="notice" id="oi-msg" hidden></div>
  </div>`;
  $$('tbody tr', body).forEach((tr) => $('button', tr).addEventListener('click', async (e) => {
    const btn = e.currentTarget, f = (k) => $(`[data-f="${k}"]`, tr);
    const low = parseQty(f('low').value);
    if (Number.isNaN(low)) return notice($('#oi-msg', body), 'Batas stok menipis tidak valid.');
    const cost = parseQty(f('cost').value) ?? 0;
    if (Number.isNaN(cost) || cost < 0) return notice($('#oi-msg', body), 'Harga pokok tidak valid.');
    // 13 Nov 2026: warn once before an active item is saved with harga pokok Rp0 (laba would look too high).
    if (cost === 0 && f('active').checked && tr.dataset.warned !== '1') {
      tr.dataset.warned = '1'; btn.textContent = 'Tetap simpan';
      return notice($('#oi-msg', body), `Harga pokok ${f('name').value || 'barang ini'} masih Rp0, jadi laporan laba akan terlihat lebih besar. Isi harga pokok, atau tekan Tetap simpan.`, 'warn');
    }
    busy(btn, true, 'Menyimpan…');
    try {
      const saved = await rpc('owner_stock_save_item', { p_id: tr.dataset.id ? Number(tr.dataset.id) : null, p_name: f('name').value, p_unit: f('unit').value,
        p_low: low, p_active: f('active').checked, p_closes_at_zero: f('zero').checked });
      // Harga pokok is saved apart (pos-backoffice.sql); skipped quietly before that file has run.
      const old = d.items.find((x) => x.id === saved.id);
      if (!old || Number(old.unit_cost || 0) !== cost) await rpc('owner_stock_save_cost', { p_item: saved.id, p_cost: cost }).catch((e) => { if (!/function|does not exist/i.test(e.message)) throw e; });
      toast('Barang tersimpan');
      if (!tr.dataset.id) return osItems(body);
      notice($('#oi-msg', body), '');
    } catch (err) { notice($('#oi-msg', body), err.message); }
    busy(btn, false);
  }));
}

// Pemasok (12 Nov 2026): a data table (js/data-table.js). Tambah and Ubah in a dialog, the Aktif switch
// in the table, Hapus only for a supplier that was never used (the server decides; a used one is
// switched off instead). Owner and manager.
async function osPemasok(body) {
  body.innerHTML = loadingHtml;
  let rows;
  try { rows = await rpc('stock_supplier_list'); } catch (e) { body.innerHTML = errorHtml(e); return; }
  body.innerHTML = `<div class="panel stack"><${hx(body)}>Pemasok</${hx(body)}>
    <p class="muted small">Tempat barang datang. Pemasok yang dinonaktifkan hilang dari pilihan di formulir, tapi tetap tertulis di catatan lama. Hapus hanya bisa untuk pemasok yang belum pernah dipakai.</p>
    <div data-table></div></div>`;
  const form = (x) => `<label class="field"><span>Nama ${REQ}</span><input type="text" maxlength="60" data-f="name" autocomplete="off" value="${esc(x?.name || '')}"></label>
    <label class="field"><span>Telepon</span><input type="tel" maxlength="30" data-f="phone" autocomplete="off" placeholder="0812-3456-7890" value="${esc(x?.phone || '')}"></label>
    <label class="field"><span>Alamat</span><input type="text" maxlength="200" data-f="address" autocomplete="off" value="${esc(x?.address || '')}"></label>
    <label class="field"><span>Catatan</span><input type="text" maxlength="200" data-f="note" autocomplete="off" placeholder="Contoh: dus dan liner" value="${esc(x?.note || '')}"></label>
    <label class="check"><input type="checkbox" data-f="active"${x && !x.active ? '' : ' checked'}><span>Aktif</span></label>`;
  const edit = (x) => formDialog({
    title: x ? `Ubah ${x.name}` : 'Tambah pemasok', html: form(x), submitLabel: 'Simpan pemasok',
    onSubmit: async (f) => {
      const v = (k) => f.querySelector(`[data-f="${k}"]`);
      await rpc('stock_supplier_save', { p_id: x ? x.id : null, p_name: v('name').value, p_phone: v('phone').value,
        p_address: v('address').value, p_note: v('note').value, p_active: v('active').checked });
      toast('Pemasok tersimpan');
    },
  });
  const t = dataTable($('[data-table]', body), {
    rows, rowKey: 'id', exportName: 'pemasok', emptyText: 'Belum ada pemasok. Tekan Tambah untuk yang pertama.',
    defaultSort: { key: 'name', dir: 'asc' },
    columns: [
      { key: 'name', label: 'Nama', sort: true },
      { key: 'phone', label: 'Telepon', sort: true, format: (v) => v || '–' },
      { key: 'address', label: 'Alamat', format: (v) => v || '–' },
      { key: 'note', label: 'Catatan', format: (v) => v || '–' },
      { key: 'used', label: 'Dipakai', sort: true, align: 'num', format: (v) => (v ? `${v} catatan` : 'Belum') },
      { key: 'active', label: 'Aktif', sort: (r) => (r.active ? 1 : 0), export: (r) => (r.active ? 'Ya' : 'Tidak'), html: true,
        format: (v, r) => `<label class="check"><input type="checkbox" data-act="aktif" aria-label="Aktif: ${esc(r.name)}"${v ? ' checked' : ''}><span>${v ? 'Aktif' : 'Nonaktif'}</span></label>` },
    ],
    reload: () => rpc('stock_supplier_list'),
    onAdd: () => edit(null),
    onEdit: (x) => edit(x),
    onAction: async (act, x, el) => {
      if (act !== 'aktif') return;
      await rpc('stock_supplier_set_active', { p_id: x.id, p_active: el.checked });
      toast(el.checked ? `${x.name} aktif` : `${x.name} dinonaktifkan`);
    },
    onDelete: async (list) => {
      const bad = [];
      for (const x of list) {
        try { await rpc('stock_supplier_delete', { p_id: x.id }); } catch (e) { bad.push(`${x.name}: ${e.message}`); }
      }
      if (bad.length) throw new Error(bad.join(' '));
      toast(list.length === 1 ? 'Pemasok dihapus' : `${list.length} pemasok dihapus`);
    },
    deleteHelp: 'Hapus hanya untuk pemasok yang belum pernah dipakai. Pemasok yang sudah punya catatan barang masuk atau permintaan tidak dihapus: pakai saklar Aktif untuk menonaktifkannya.',
  });
}

// Same loader as owner.js (SheetJS from jsDelivr, allowed by the CSP).
function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembuat file Excel gagal dimuat. Periksa internet lalu coba lagi.'));
    document.head.append(s);
  });
}
