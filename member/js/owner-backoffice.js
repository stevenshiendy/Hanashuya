// Owner page tabs added after the VireoPOS comparison (11 Nov 2026, POSDEVELOPMENT.md gaps 1, 5, 6):
//   mountOrders(panel, { rpc })    Pesanan: find any past sale, open it, download its receipt image
//   mountMembers(panel, { rpc })   Member: browse and search members, open one
//   mountPromos(panel, { rpc })    Promo: promos the owner sets up; the till shows them as Pakai buttons
// Database side: supabase/pos-backoffice.sql. Gap 2 (cost and profit) lives in owner-reports.js and stock.js.
import { $, $$, esc, busy, notice, toast, rupiah, when, day, prettyPhone } from './lib.js';
import { presetRange, rangeHtml, wireRange } from './owner-range.js';
import { openWaDialog } from './owner-wa.js';

const TZ = 'Asia/Jakarta';
const ymdToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const STATUS = { menunggu: ['Menunggu bayar', 'tag-warn'], dibayar: ['Dibayar', 'tag-ok'], batal: ['Dibatalkan', 'tag-bad'], refund: ['Refund', 'tag-bad'] };
const METHOD = { tunai: 'Tunai', qris: 'QRIS', campur: 'Tunai + QRIS', platform: 'Aplikasi', gratis: 'Gratis' };
const FLAG = { kartu_staf: 'Kartu milik staf', kode_diketik: 'Kode kartu diketik', nomor_dicari: 'Kartu dicari lewat nomor', luar_jam: 'Di luar jam buka', tanpa_shift: 'Tanpa shift', terlambat: 'Dikirim terlambat',
  diskon_instruksi: 'Diskon 50% atas instruksi' };
// Order detail (13 Nov 2026): Tunai with change, QRIS, or Bayar 2 cara with both parts; refunds by where the money went.
const REFUND_TO = { tunai: 'tunai', transfer: 'transfer', qris: 'QRIS' };
const payText = (r) => {
  const part = (m) => ((r.payments || []).find((p) => p.method === m) || {}).amount || 0;
  if (r.payment_method === 'tunai') return `Tunai, diterima ${rupiah(r.cash_received)}, kembali ${rupiah(r.change)}`;
  if (r.payment_method === 'campur') return `QRIS ${rupiah(part('qris'))} + Tunai ${rupiah(part('tunai'))} (diterima ${rupiah(r.cash_received)}, kembali ${rupiah(r.change)})`;
  return METHOD[r.payment_method] || 'Belum dibayar';
};
const pctText = (n) => Number(n).toLocaleString('id-ID', { maximumFractionDigits: 2 }) + '%';
// The paid total split (14 Nov 2026): shown only when service charge or PBJT was taken.
const paidSplit = (x) => (!x || (!x.service_charge && !x.tax && !x.tax_in) ? ''
  : ` (penjualan ${rupiah(x.sales)}${x.service_charge ? `, service charge ${rupiah(x.service_charge)}` : ''}${x.tax ? `, PBJT ${rupiah(x.tax)}` : ''}${x.tax_in ? `, PBJT termasuk ${rupiah(x.tax_in)}` : ''})`);
const VIA = { qr: 'scan QR', kode: 'kode diketik', nomor: 'nomor WhatsApp', daftar: 'daftar di tablet' };
const DAYS = [[1, 'Sen'], [2, 'Sel'], [3, 'Rab'], [4, 'Kam'], [5, 'Jum'], [6, 'Sab'], [7, 'Min']];
const errBox = (e) => `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`;
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ================================================================ Pesanan (gap 1) */
export function mountOrders(panel, { rpc }) {
  const st = panel._ord || (panel._ord = { preset: 'hari', from: ymdToday(), to: ymdToday(), status: 'semua', q: '' });
  panel.innerHTML = `
  <div class="panel stack">
    <h1>Pesanan</h1>
    <p class="muted small">Semua pesanan dari kasir baru. Cari nomor invoice, nama atau nomor member, staf yang melayani, atau nama promo. Ketuk pesanan untuk melihat isinya.</p>
    ${rangeHtml({ preset: st.preset, from: st.from, to: st.to })}
    <div class="form-grid">
      <label class="field"><span>Cari</span><input type="search" id="or-q" value="${esc(st.q)}" placeholder="HS-261111-0007, Desi, 0812…" autocomplete="off"></label>
      <label class="field"><span>Status</span><select id="or-st">${[['semua', 'Semua'], ['dibayar', 'Dibayar'], ['menunggu', 'Menunggu bayar'], ['batal', 'Batal dan refund']]
        .map(([v, l]) => `<option value="${v}"${st.status === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
  </div>
  <div id="or-detail"></div>
  <div id="or-list" aria-live="polite"></div>`;

  let seq = 0;
  async function load() {
    const n = ++seq, box = $('#or-list', panel);
    box.innerHTML = loadingHtml;
    if (st.preset !== 'custom') [st.from, st.to] = presetRange(st.preset, [st.from, st.to]);
    let d;
    try { d = await rpc('owner_pos_orders', { p_from: st.from, p_to: st.to, p_q: st.q || null, p_status: st.status }); }
    catch (e) { if (n === seq) box.innerHTML = errBox(e); return; }
    if (n !== seq) return;
    // Service charge and PBJT columns (14 Nov 2026) only once some order in the list has them.
    const withCharges = d.rows.some((o) => o.service_charge || o.tax);
    box.innerHTML = `<div class="panel stack">
      <p class="muted small num">${d.total_rows} pesanan${d.total_rows > d.rows.length ? `, ${d.rows.length} terbaru ditampilkan` : ''} · dibayar di rentang ini ${esc(rupiah(d.paid_total))}${esc(paidSplit(d.paid_split))}</p>
      ${d.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Waktu</th><th>Invoice</th><th>Isi</th><th>Member</th><th>Dilayani</th>${withCharges ? '<th class="num">Penjualan</th><th class="num">Service charge</th><th class="num">PBJT</th>' : ''}<th class="num">Total</th><th>Bayar</th><th>Status</th></tr></thead><tbody>
        ${d.rows.map((o) => { const [l, c] = STATUS[o.status] || [o.status, '']; return `<tr>
          <td>${esc(when(o.sold_at))}</td>
          <td><button class="btn btn-text num" type="button" data-open="${esc(o.id)}">${esc(o.receipt_no)}</button>${o.local_no ? `<br><span class="small muted num">offline ${esc(o.local_no)}</span>` : ''}</td>
          <td class="small">${esc(o.items || '')}${o.promo_label ? `<br><span class="muted">${esc(o.promo_label)}</span>` : ''}</td>
          <td>${esc(o.member || '–')}</td><td>${esc(o.served_by || '–')}</td>
          ${withCharges ? `<td class="num">${esc(rupiah(o.sales ?? o.total))}</td><td class="num">${o.service_charge ? esc(rupiah(o.service_charge)) : '–'}</td>
          <td class="num">${o.tax ? esc(rupiah(o.tax)) + (o.tax_included ? '<br><span class="small muted">termasuk</span>' : '') : '–'}</td>` : ''}
          <td class="num">${esc(rupiah(o.total))}</td><td>${esc(METHOD[o.payment_method] || '–')}</td>
          <td><span class="tag ${c}">${esc(l)}</span>${o.void_pending ? ' <span class="tag tag-warn">Minta batal</span>' : ''}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<p class="muted">Tidak ada pesanan yang cocok.</p>'}</div>`;
    $$('[data-open]', box).forEach((b) => b.addEventListener('click', () => open(b.dataset.open)));
    // Opened from the header search: show that order straight away.
    if (st.openId) { const id = st.openId; st.openId = null; open(id); }
  }

  async function open(id) {
    const box = $('#or-detail', panel);
    box.innerHTML = loadingHtml;
    box.scrollIntoView({ block: 'start' });
    let d;
    try { d = await rpc('owner_pos_order', { p_id: id }); } catch (e) { box.innerHTML = errBox(e); return; }
    const r = d.receipt, [l, c] = STATUS[r.status] || [r.status, ''];
    // Laba kotor from the goods only: service charge and PBJT are not sales (14 Nov 2026).
    const goods = r.subtotal - (r.discount || 0) - (r.tax_included ? r.tax || 0 : 0);
    const profit = d.cost != null && r.status === 'dibayar' ? goods - d.cost : null;
    box.innerHTML = `<section class="panel stack" aria-labelledby="od-t">
      <div class="row-between"><h2 id="od-t" class="num">${esc(r.receipt_no)} <span class="tag ${c}">${esc(l)}</span></h2>
        <button class="btn btn-quiet" type="button" id="od-close">Tutup</button></div>
      <p class="small">${esc(r.date)} pukul ${esc(r.time)} · ${esc(r.channel_label || 'Di booth')} · dilayani ${esc(d.served_by_full || '–')} · akun kasir ${esc(d.cashier || '–')}</p>
      <p class="small">${d.member_full ? `Member ${esc(d.member_full)} (${esc(prettyPhone(d.member_whatsapp))}), lewat ${esc(VIA[d.via] || d.via || '–')}, ${r.stamps} stempel` : 'Tanpa kartu member'}
        ${(d.flags || []).length ? `<br><span class="muted">Catatan: ${esc(d.flags.map((f) => FLAG[f] || f).join(', '))}</span>` : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>Produk</th><th>Rasa</th><th class="num">Jumlah</th><th class="num">Harga</th><th class="num">Diskon</th><th class="num">Subtotal</th></tr></thead><tbody>
        ${r.lines.map((x) => `<tr><td>${esc(x.name)}${x.free_bag ? ' (gratis)' : ''}${x.refunded_qty ? ` <span class="tag tag-bad num">${x.refunded_qty} direfund</span>` : ''}</td><td>${esc(x.flavour || '–')}</td><td class="num">${x.qty}</td>
          <td class="num">${esc(rupiah(x.unit_price))}</td><td class="num">${x.discount ? '−' + esc(rupiah(x.discount)) : '–'}</td><td class="num">${esc(rupiah(x.line_total - (x.discount || 0)))}</td></tr>`).join('')}
      </tbody></table></div>
      <dl class="kv">
        <dt>Subtotal</dt><dd class="num">${esc(rupiah(r.subtotal))}</dd>
        ${r.discount ? `<dt>Diskon${r.promo_label ? ` (${esc(r.promo_label)})` : ''}</dt><dd class="num">−${esc(rupiah(r.discount))}</dd>` : ''}
        ${r.service_charge ? `<dt>Service charge${r.service_pct ? ` ${esc(pctText(r.service_pct))}` : ''}</dt><dd class="num">${esc(rupiah(r.service_charge))}</dd>` : ''}
        ${r.tax ? `<dt>PBJT${r.tax_pct ? ` ${esc(pctText(r.tax_pct))}` : ''}${r.tax_included ? ' (termasuk)' : ''}</dt><dd class="num">${esc(rupiah(r.tax))}</dd>` : ''}
        <dt>Total</dt><dd class="num"><b>${esc(rupiah(r.total))}</b></dd>
        <dt>Bayar</dt><dd class="num">${esc(payText(r))}</dd>
        ${(r.refunds || []).map((f) => `<dt>Refund ${esc(REFUND_TO[f.method] || '')}</dt><dd class="num">−${esc(rupiah(f.amount))}${f.at ? `, ${esc(when(f.at))}` : ''}</dd>`).join('')}
        ${r.refunded ? `<dt>Tetap dibayar</dt><dd class="num">${esc(rupiah(r.total - r.refunded))}</dd>` : ''}
        ${r.promo_by ? `<dt>Diskon 50% atas instruksi</dt><dd>${esc(r.promo_by)}</dd>` : ''}
        ${r.note ? `<dt>Catatan pesanan</dt><dd>${esc(r.note)}</dd>` : ''}
        ${profit != null ? `<dt>Harga pokok</dt><dd class="num">${esc(rupiah(d.cost))} · laba kotor ${esc(rupiah(profit))}</dd>` : ''}
      </dl>
      ${d.voids.length ? `<h3>Permintaan batal</h3><ul class="list">${d.voids.map((v) => `<li><span class="grow">${v.kind === 'refund' ? 'Refund' : 'Batal'}: ${esc(v.reason)}<br>
        <span class="muted small">${esc(v.requested_by || 'Kasir')}, ${esc(when(v.created_at))}${v.decided_by ? ` · ${v.status === 'disetujui' ? 'disetujui' : 'ditolak'} ${esc(v.decided_by)}, ${esc(when(v.decided_at))}` : ''}</span></span>
        <span class="tag ${v.status === 'menunggu' ? 'tag-warn' : v.status === 'disetujui' ? 'tag-ok' : 'tag-bad'}">${v.status === 'menunggu' ? 'Menunggu' : v.status === 'disetujui' ? 'Disetujui' : 'Ditolak'}</span></li>`).join('')}</ul>` : ''}
      <div class="row">${r.status === 'dibayar' ? '<button class="btn btn-quiet" type="button" id="od-img">Unduh struk (gambar)</button>' : ''}</div>
      <div class="notice" id="od-msg" hidden></div>
    </section>`;
    $('#od-close', box).addEventListener('click', () => { box.innerHTML = ''; });
    $('#od-img', box)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      busy(btn, true, 'Menyiapkan…');
      try {
        const { receiptBlob } = await import('./receipt.js');
        const blob = await receiptBlob(r);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = `struk-${r.receipt_no}.png`;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (err) { notice($('#od-msg', box), err.message || 'Struk gagal dibuat.'); }
      busy(btn, false);
    });
  }

  wireRange(panel, { onChange: ({ preset, from, to }) => { st.preset = preset; st.from = from; st.to = to; load(); } });
  $('#or-q', panel).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); load(); }));
  $('#or-st', panel).addEventListener('change', (e) => { st.status = e.target.value; load(); });
  load();
}

/* ================================================================ Member (gap 6) */
export function mountMembers(panel, { rpc }) {
  const st = panel._mem || (panel._mem = { q: '', sort: 'baru', page: 0 });
  const SORTS = [['baru', 'Baru daftar'], ['terakhir', 'Terakhir datang'], ['kunjungan', 'Paling sering'], ['belanja', 'Belanja terbanyak'], ['nama', 'Nama']];
  panel.innerHTML = `
  <div class="panel stack">
    <h1>Member</h1>
    <p class="muted small">Cari nama, nomor WhatsApp atau kode kartu. Kunjungan dan belanja dihitung dari penjualan yang tidak dibatalkan.</p>
    <div class="form-grid">
      <label class="field"><span>Cari</span><input type="search" id="mb-q" value="${esc(st.q)}" placeholder="Nama, 0812… atau kode kartu" autocomplete="off"></label>
      <label class="field"><span>Urutkan</span><select id="mb-sort">${SORTS.map(([v, l]) => `<option value="${v}"${st.sort === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
  </div>
  <div id="mb-detail"></div>
  <div id="mb-list" aria-live="polite"></div>`;

  let seq = 0;
  async function load() {
    const n = ++seq, box = $('#mb-list', panel);
    box.innerHTML = loadingHtml;
    let d;
    try { d = await rpc('owner_members', { p_q: st.q || null, p_sort: st.sort, p_page: st.page }); }
    catch (e) { if (n === seq) box.innerHTML = errBox(e); return; }
    if (n !== seq) return;
    const pages = Math.max(1, Math.ceil(d.total / d.page_size));
    box.innerHTML = `<div class="panel stack">
      <p class="muted small num">${d.total} dari ${d.all_members} member${pages > 1 ? ` · halaman ${d.page + 1} dari ${pages}` : ''}</p>
      ${d.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Nama</th><th>WhatsApp</th><th>Daftar</th><th class="num">Kunjungan</th><th class="num">Belanja</th><th>Terakhir</th><th class="num">Kartu</th><th class="num">Hadiah siap</th></tr></thead><tbody>
        ${d.rows.map((m) => `<tr><td><button class="btn btn-text" type="button" data-m="${esc(m.id)}">${esc(m.name || '(tanpa nama)')}</button></td>
          <td>${esc(prettyPhone(m.whatsapp))}</td><td>${esc(day(m.joined))}</td>
          <td class="num">${m.visits}</td><td class="num">${esc(rupiah(m.spent))}</td><td>${m.last_visit ? esc(day(m.last_visit)) : '–'}</td>
          <td class="num">${m.position}/10${m.cards_done ? ` · ${m.cards_done} penuh` : ''}</td><td class="num">${m.ready || '–'}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Tidak ada member yang cocok.</p>'}
      ${pages > 1 ? `<div class="row"><button class="btn btn-quiet" type="button" id="mb-prev" ${d.page === 0 ? 'disabled' : ''}>Sebelumnya</button>
        <button class="btn btn-quiet" type="button" id="mb-next" ${d.page + 1 >= pages ? 'disabled' : ''}>Berikutnya</button></div>` : ''}</div>`;
    $$('[data-m]', box).forEach((b) => b.addEventListener('click', () => open(b.dataset.m)));
    $('#mb-prev', box)?.addEventListener('click', () => { st.page -= 1; load(); });
    $('#mb-next', box)?.addEventListener('click', () => { st.page += 1; load(); });
  }

  async function open(id) {
    const box = $('#mb-detail', panel);
    box.innerHTML = loadingHtml;
    box.scrollIntoView({ block: 'start' });
    let m;
    try { m = await rpc('owner_member', { p_id: id }); } catch (e) { box.innerHTML = errBox(e); return; }
    const RST = { tersedia: ['Siap dipakai', 'tag-ok'], dipakai: ['Dipakai', 'tag'], terkunci: ['Belum terbuka', 'tag'], kedaluwarsa: ['Lewat', 'tag'] };
    const tag = (s) => { const [l, c] = RST[s] || [s, 'tag']; return `<span class="tag ${c}">${esc(l)}</span>`; };
    box.innerHTML = `<section class="panel stack" aria-labelledby="md-t">
      <div class="row-between"><h2 id="md-t">${esc(m.name || '(tanpa nama)')}</h2><button class="btn btn-quiet" type="button" id="md-close">Tutup</button></div>
      <dl class="kv">
        <dt>WhatsApp</dt><dd class="num">${esc(prettyPhone(m.whatsapp))}</dd>
        <dt>Kode kartu</dt><dd class="num">${esc(m.card_code)}</dd>
        <dt>Daftar</dt><dd class="num">${esc(day(m.joined))}</dd>
        <dt>Tanggal lahir</dt><dd class="num">${m.birth_date ? esc(m.birth_date.split('-').reverse().join('/')) : '–'}</dd>
        <dt>Stempel</dt><dd class="num">${m.stamps} total · kartu ${m.card.card_position}/10${m.card.waiting ? `, ${m.card.waiting} menunggu kartu baru` : ''}</dd>
        <dt>Info promo WhatsApp</dt><dd>${m.marketing ? 'Mau' : 'Tidak'}</dd>
      </dl>
      <div><button class="btn btn-quiet" type="button" id="md-wa"${m.whatsapp ? '' : ' disabled'}>Kirim WhatsApp</button></div>
      <h3>Hadiah dan voucher</h3>
      <ul class="list">${[...m.rewards.filter((r) => r.status !== 'terkunci').map((r) => `<li><span class="grow">${esc(r.label)} <span class="muted small">stempel ke-${r.slot}, kartu ${r.cycle + 1}</span></span>${tag(r.status)}</li>`),
        ...m.vouchers.map((v) => `<li><span class="grow">${esc(v.label)} <span class="muted small">${esc(v.title)}${v.ends_on ? `, sampai ${esc(v.ends_on.split('-').reverse().join('/'))}` : ''}</span></span>${tag(v.status)}</li>`)].join('') || '<li class="muted">Belum ada.</li>'}</ul>
      <h3>Kunjungan terakhir</h3>
      ${m.visits.length ? `<ul class="list">${m.visits.map((v) => `<li><span class="grow num">${esc(when(v.at))}${v.receipt_no ? ` · ${esc(v.receipt_no)}` : ''}</span>
        <span class="num">${esc(rupiah(v.total))} · ${v.stamps} stempel</span>${v.reversed ? ' <span class="tag tag-bad">Dibatalkan</span>' : ''}</li>`).join('')}</ul>` : '<p class="muted">Belum pernah belanja.</p>'}
    </section>`;
    $('#md-close', box).addEventListener('click', () => { box.innerHTML = ''; });
    $('#md-wa', box).addEventListener('click', () => openWaDialog({ id, name: m.name }, { rpc }));
  }

  $('#mb-q', panel).addEventListener('input', debounce((e) => { st.q = e.target.value.trim(); st.page = 0; load(); }));
  $('#mb-sort', panel).addEventListener('change', (e) => { st.sort = e.target.value; st.page = 0; load(); });
  load();
}

/* ================================================================ Promo (gap 5) */
const promoRule = (p, names) => {
  const what = p.kind === 'persen' ? `Diskon ${p.value}%` : `Potongan ${rupiah(p.value)}`;
  const on = p.products && p.products.length ? names(p.products) : 'semua produk';
  const bits = [`${what} untuk ${on}`];
  if (p.min_spend) bits.push(`minimal belanja ${rupiah(p.min_spend)}`);
  if (p.days && p.days.length < 7) bits.push(DAYS.filter(([d]) => p.days.includes(d)).map(([, l]) => l).join(', '));
  if (p.time_from) bits.push(`pukul ${p.time_from.replace(':', '.')}–${p.time_to.replace(':', '.')}`);
  if (p.starts_on || p.ends_on) bits.push([p.starts_on && `mulai ${p.starts_on.split('-').reverse().join('/')}`, p.ends_on && `sampai ${p.ends_on.split('-').reverse().join('/')}`].filter(Boolean).join(' '));
  if (p.member_only) bits.push('khusus member');
  if (p.per_member) bits.push(`${p.per_member}× per member`);
  if (p.quota) bits.push(`kuota ${p.quota}`);
  return bits.join(' · ');
};

export async function mountPromos(panel, { rpc }) {
  const again = () => mountPromos(panel, { rpc });
  panel.innerHTML = loadingHtml;
  let d;
  try { d = await rpc('owner_pos_promos'); } catch (e) { panel.innerHTML = errBox(e); return; }
  const names = (codes) => codes.map((c) => (d.products.find((p) => p.code === c) || { name: c }).name).join(', ');
  panel.innerHTML = `
  <section class="panel stack" aria-labelledby="pm-t">
    <h1 id="pm-t">Promo POS</h1>
    <p class="muted small">Promo di sini muncul di kasir sebagai tombol Pakai selama berlaku (hari, jam dan tanggalnya cocok, kuotanya masih ada). Satu pesanan tetap hanya satu promo. Nama promo tercetak di struk. Hadiah stempel, voucher member, Tebus Murah dan BOGO tetap diatur seperti sekarang.</p>
    ${d.promos.length ? `<ul class="list">${d.promos.map((p) => `<li data-id="${p.id}"><span class="grow"><strong>${esc(p.name)}</strong>
        ${p.active ? (p.live_now ? ' <span class="tag tag-ok">Tampil di kasir sekarang</span>' : ' <span class="tag">Aktif, belum waktunya</span>') : ' <span class="tag">Mati</span>'}<br>
        <span class="small">${esc(promoRule(p, names))}</span><br>
        <span class="muted small num">Dipakai ${p.used}× · potongan ${esc(rupiah(p.discount_given))}${p.note ? ` · ${esc(p.note)}` : ''}</span></span>
        <span class="row"><label class="check"><input type="checkbox" data-on ${p.active ? 'checked' : ''}><span>Aktif</span></label>
          <button class="btn btn-quiet" type="button" data-edit>Ubah</button></span></li>`).join('')}</ul>` : '<p class="muted">Belum ada promo.</p>'}
    <div class="notice" id="pm-msg" hidden></div>
    <div><button class="btn" type="button" id="pm-new">Tambah promo</button></div>
  </section>
  <div id="pm-form"></div>`;

  $$('li[data-id]', panel).forEach((li) => {
    const p = d.promos.find((x) => x.id === Number(li.dataset.id));
    const box = $('[data-on]', li);
    box.addEventListener('change', async () => {
      box.disabled = true;
      try { await rpc('owner_set_pos_promo', { p_id: p.id, p_active: box.checked }); toast(box.checked ? 'Promo diaktifkan' : 'Promo dimatikan'); again(); }
      catch (e) { box.checked = !box.checked; box.disabled = false; notice($('#pm-msg', panel), e.message); }
    });
    $('[data-edit]', li).addEventListener('click', () => form(p));
  });
  $('#pm-new', panel).addEventListener('click', () => form(null));

  function form(p) {
    const box = $('#pm-form', panel);
    const v = p || { kind: 'persen', value: '', products: null, min_spend: 0, days: null, member_only: false, active: true };
    const days = v.days || DAYS.map(([n]) => n);
    box.innerHTML = `<form class="panel stack" id="pf" novalidate aria-labelledby="pf-t">
      <h2 id="pf-t">${p ? 'Ubah promo' : 'Promo baru'}</h2>
      <div class="form-grid">
        <label class="field"><span>Nama promo <span class="hint">tercetak di struk</span></span><input name="name" maxlength="40" required value="${esc(v.name || '')}" placeholder="Misalnya Diskon Akhir Pekan"></label>
        <label class="field"><span>Jenis potongan</span><select name="kind"><option value="persen"${v.kind === 'persen' ? ' selected' : ''}>Persen (%)</option><option value="rupiah"${v.kind === 'rupiah' ? ' selected' : ''}>Rupiah (Rp)</option></select></label>
        <label class="field"><span id="pf-vl">Besar potongan</span><input name="value" type="number" inputmode="numeric" min="1" required value="${esc(v.value)}"></label>
        <label class="field"><span>Minimal belanja (Rp) <span class="hint">0 = tanpa minimal</span></span><input name="min_spend" type="number" inputmode="numeric" min="0" step="1000" value="${esc(v.min_spend || 0)}"></label>
      </div>
      <fieldset class="field"><legend>Berlaku untuk produk <span class="hint">tidak dipilih = semua produk, paper bag tidak termasuk</span></legend>
        <div class="choices">${d.products.map((x) => `<label class="choice"><input type="checkbox" name="prod" value="${esc(x.code)}"${(v.products || []).includes(x.code) ? ' checked' : ''}><span>${esc(x.name)}</span></label>`).join('')}</div></fieldset>
      <fieldset class="field"><legend>Hari</legend>
        <div class="choices">${DAYS.map(([n, l]) => `<label class="choice"><input type="checkbox" name="day" value="${n}"${days.includes(n) ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div></fieldset>
      <div class="form-grid">
        <label class="field"><span>Jam mulai <span class="hint">kosong = sepanjang hari</span></span><input name="time_from" type="time" value="${esc(v.time_from || '')}"></label>
        <label class="field"><span>Jam selesai</span><input name="time_to" type="time" value="${esc(v.time_to || '')}"></label>
        <label class="field"><span>Tanggal mulai</span><input name="starts_on" type="date" value="${esc(v.starts_on || '')}"></label>
        <label class="field"><span>Tanggal selesai</span><input name="ends_on" type="date" value="${esc(v.ends_on || '')}"></label>
        <label class="field"><span>Batas per member <span class="hint">kosong = tanpa batas</span></span><input name="per_member" type="number" inputmode="numeric" min="1" value="${esc(v.per_member || '')}"></label>
        <label class="field"><span>Kuota total <span class="hint">kosong = tanpa batas</span></span><input name="quota" type="number" inputmode="numeric" min="1" value="${esc(v.quota || '')}"></label>
      </div>
      <label class="check"><input type="checkbox" name="member_only"${v.member_only ? ' checked' : ''}><span>Khusus member (kasir harus scan kartu dulu)</span></label>
      <label class="field"><span>Catatan untuk kasir <span class="hint">tampil di bawah tombol Pakai</span></span><input name="note" maxlength="120" value="${esc(v.note || '')}" placeholder="Misalnya: tunjukkan postingan Instagram"></label>
      <label class="check"><input type="checkbox" name="active"${v.active ? ' checked' : ''}><span>Aktif</span></label>
      <div class="notice" id="pf-msg" hidden></div>
      <div class="row"><button class="btn" type="submit">Simpan promo</button><button class="btn btn-quiet" type="button" id="pf-cancel">Batal</button></div>
    </form>`;
    const f = $('#pf', box);
    const syncKind = () => { $('#pf-vl', box).textContent = f.kind.value === 'persen' ? 'Besar potongan (%)' : 'Besar potongan (Rp)'; f.value.max = f.kind.value === 'persen' ? '100' : ''; };
    f.kind.addEventListener('change', syncKind); syncKind();
    $('#pf-cancel', box).addEventListener('click', () => { box.innerHTML = ''; });
    f.scrollIntoView({ block: 'start' });
    f.name.focus({ preventScroll: true });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', f), msg = $('#pf-msg', box);
      const checked = (n) => $$(`input[name="${n}"]:checked`, f).map((x) => x.value);
      const dayList = checked('day').map(Number);
      const body = {
        name: f.name.value, kind: f.kind.value, value: f.value.value, min_spend: f.min_spend.value || 0,
        products: checked('prod'), days: dayList.length === 7 ? null : dayList,
        time_from: f.time_from.value, time_to: f.time_to.value, starts_on: f.starts_on.value, ends_on: f.ends_on.value,
        per_member: f.per_member.value, quota: f.quota.value, member_only: f.member_only.checked, active: f.active.checked, note: f.note.value,
      };
      busy(btn, true, 'Menyimpan…'); notice(msg, '');
      try { await rpc('owner_save_pos_promo', { p_id: p ? p.id : null, p: body }); toast('Promo tersimpan'); again(); }
      catch (err) { busy(btn, false); notice(msg, err.message); }
    });
  }
}
