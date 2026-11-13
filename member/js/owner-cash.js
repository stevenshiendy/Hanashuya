// Owner page, Penjualan > Rekap kas (Glenn, 11 Nov 2026). Staff count the drawer blind on the
// till; here the owner sees every shift with the modal, what the drawer should hold, what was
// counted and the selisih, opens one for the full rekap (items, payments, kas moves, change,
// denomination count, the drawer ledger), prints it again (CETAK ULANG), saves the picture or
// shares the PDF. Also: Modal standar laci and the selisih that gets flagged, and Setor.
// Database: supabase/pos.sql (pos_shift_rekap, pos_rekap_printed, pos_rekap_exported,
// pos_cash_move 'setor') and supabase/pos-cash.sql (owner_cash_shifts, owner_save_cash_settings).
import { $, esc, busy, notice, toast, rupiah, when } from './lib.js';
import { presetRange, rangeHtml, wireRange } from './owner-range.js';
import { rekapReceipt, rekapPreview, rekapPdf, rekapFile, denomText, ledgerLabel, DENOMS } from './receipt-rekap.js';
import { sharePdf } from './pdf.js';
import * as printer from './printer.js';

const TZ = 'Asia/Jakarta';
const ymdToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const FLAG = { selisih_kas: 'Selisih di atas batas', modal_diubah: 'Modal diubah saat buka' };
const REQ = '<span class="hint is-req">wajib</span>';
const errBox = (e) => `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`;
const loadingHtml = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + rupiah(Math.abs(n));
const paper = () => { try { return localStorage.getItem('hs-till-paper') === '80' ? '80' : '58'; } catch { return '58'; } };
const money = (el) => { const d = String(el?.value || '').replace(/\D/g, ''); return d ? Number(d) : null; };

// Selisih tag: 0 green, within the owner's limit amber, beyond it red.
function diffTag(d, limit) {
  if (d == null) return '<span class="muted">–</span>';
  const cls = d === 0 ? 'tag-ok' : Math.abs(d) > limit ? 'tag-bad' : 'tag-warn';
  return `<span class="tag ${cls} num">${signed(d)}</span>`;
}

export function mountCashRekap(panel, { rpc }) {
  const st = panel._kas || (panel._kas = { preset: '7', from: ymdToday(), to: ymdToday(), open: null });
  if (st.open) return detail(panel, rpc, st.open);
  const [from, to] = presetRange(st.preset, [st.from, st.to]);
  panel.innerHTML = `
  <div class="panel stack">
    <h1>Rekap kas</h1>
    <p class="muted small">Staf menghitung laci tanpa melihat uang modal atau selisih. Di sini terlihat semuanya: modal, seharusnya di laci, yang dihitung, dan selisihnya. Shift berjalan dari rekap ke rekap, jadi setiap penjualan masuk ke satu shift.</p>
    ${rangeHtml({ preset: st.preset, from: st.from, to: st.to })}
  </div>
  <div id="kas-body">${loadingHtml}</div>`;
  wireRange(panel, { onChange: ({ preset, from: f, to: t }) => { st.preset = preset; st.from = f; st.to = t; mountCashRekap(panel, { rpc }); } });
  list(panel, rpc, from, to);
}

async function list(panel, rpc, from, to) {
  const body = $('#kas-body', panel);
  let d;
  try { d = await rpc('owner_cash_shifts', { p_from: from, p_to: to }); } catch (e) { body.innerHTML = errBox(e); return; }
  const lim = d.settings.cash_flag_at;
  const flagged = d.shifts.filter((s) => (s.flags || []).includes('selisih_kas')).length;
  body.innerHTML = `
  <div class="panel stack">
    <div class="row-between"><h3>Shift</h3><span class="muted small num">${d.shifts.length} shift${flagged ? ` · <span class="tag tag-bad">${flagged} selisih di atas batas</span>` : ''}</span></div>
    ${d.shifts.length ? `<div class="table-wrap"><table><thead><tr><th>Mulai</th><th>Selesai</th><th>Staf</th><th class="num">Pesanan</th><th class="num">Penjualan</th>
      <th class="num">QRIS</th><th class="num">Tunai</th><th class="num">Modal</th><th class="num">Seharusnya</th><th class="num">Dihitung</th><th class="num">Selisih</th><th>Tanda</th><th></th></tr></thead><tbody>
      ${d.shifts.map((s) => `<tr>
        <td class="num" style="white-space: nowrap">${esc(when(s.opened_at))}</td><td class="num" style="white-space: nowrap">${s.closed_at ? esc(when(s.closed_at)) : '<span class="tag tag-ok">Berjalan</span>'}</td>
        <td>${esc([s.opened_by, s.closed_by].filter((x, i, a) => x && a.indexOf(x) === i).join(' → ') || '–')}</td>
        <td class="num">${s.orders}</td><td class="num">${rupiah(s.sales_total)}</td><td class="num">${rupiah(s.qris)}</td><td class="num">${rupiah(s.tunai)}</td>
        <td class="num">${rupiah(s.opening_cash)}</td><td class="num">${rupiah(s.expected_cash)}</td>
        <td class="num">${s.counted_cash == null ? '–' : rupiah(s.counted_cash)}</td><td class="num">${diffTag(s.difference, lim)}</td>
        <td class="small">${[...(s.flags || []).map((f) => FLAG[f] || f), s.setor ? `Setor ${rupiah(s.setor)}` : '',
          s.printed_at ? (s.reprints ? `Dicetak, ${s.reprints}× ulang` : 'Dicetak') : (s.closed_at ? 'Belum dicetak' : '')].filter(Boolean).map(esc).join('<br>')}</td>
        <td><button class="btn btn-quiet" type="button" data-open="${s.id}">Buka</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Belum ada shift di rentang ini.</p>'}
  </div>
  <form class="panel stack" id="kas-set" novalidate>
    <h3>Uang modal laci</h3>
    <p class="muted small">Shift pertama memakai modal standar. Setelah itu, modal shift berikutnya adalah uang laci yang dihitung saat tutup shift. Kalau laci turun di bawah modal standar, beranda kasir manajer dan pemilik memberi tanda.</p>
    <div class="form-grid">
      <label class="field"><span>Modal standar laci ${REQ}</span><span class="tl-money"><span aria-hidden="true">Rp</span><input type="text" inputmode="numeric" id="kas-float" value="${d.settings.cash_float.toLocaleString('id-ID')}" required></span></label>
      <label class="field"><span>Tandai selisih lebih dari ${REQ}</span><span class="tl-money"><span aria-hidden="true">Rp</span><input type="text" inputmode="numeric" id="kas-flag" value="${d.settings.cash_flag_at.toLocaleString('id-ID')}" required></span></label>
    </div>
    <div class="notice" id="kas-set-msg" hidden></div>
    <div><button class="btn" type="submit">Simpan</button></div>
  </form>`;
  body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { panel._kas.open = Number(b.dataset.open); detail(panel, rpc, panel._kas.open); }));
  $('#kas-set', body).addEventListener('input', (e) => { const n = money(e.target); e.target.value = n == null ? '' : n.toLocaleString('id-ID'); });
  $('#kas-set', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', e.currentTarget), msg = $('#kas-set-msg', body);
    const f = money($('#kas-float', body)), l = money($('#kas-flag', body));
    if (f == null || l == null) { notice(msg, 'Isi kedua angka.'); return; }
    busy(btn, true, 'Menyimpan…');
    try { await rpc('owner_save_cash_settings', { p_float: f, p_flag_at: l }); notice(msg, 'Tersimpan.', 'ok'); }
    catch (err) { notice(msg, err.message); } finally { busy(btn, false); }
  });
}

async function detail(panel, rpc, id) {
  panel.innerHTML = loadingHtml;
  let k;
  try { k = await rpc('pos_shift_rekap', { p_shift: id }); }
  catch (e) { panel._kas.open = null; panel.innerHTML = errBox(e); return; }
  const kv = (a, b, cls = '') => `<div class="tl-kv${cls}"><span>${a}</span><b class="num">${b}</b></div>`;
  const pay = (m) => (k.payments.find((x) => x.method === m) || {}).amount || 0;
  const den = k.denominations || {};
  panel.innerHTML = `
  <div class="panel stack">
    <div><button class="btn btn-quiet" type="button" id="kas-back">← Semua shift</button></div>
    <div class="row-between"><h1>Rekap kas</h1>${k.closed ? (k.printed_at ? `<span class="tag tag-ok">Dicetak ${esc(k.printed_time)}${k.reprints ? ` · ${k.reprints}× ulang` : ''}</span>` : '<span class="tag tag-warn">Belum dicetak</span>') : '<span class="tag tag-ok">Shift berjalan</span>'}</div>
    <p class="muted">${esc(k.start)} sampai ${esc(k.end || 'sekarang')} · ${esc(k.staff || '–')} · ${esc(k.device || 'Tablet kasir')}</p>
    <div class="form-grid" style="align-items: start">
      <div>
        ${kv('Uang modal', rupiah(k.opening_cash))}
        ${kv('Uang diterima dari pembeli', '+' + rupiah(k.cash_received))}
        ${kv('Kembalian diberikan', '−' + rupiah(k.change_given))}
        ${kv('Kas masuk', '+' + rupiah(k.cash_in))}
        ${kv('Kas keluar', '−' + rupiah(k.cash_out))}
        ${k.setor ? kv('Setor ke pemilik', '−' + rupiah(k.setor)) : ''}
        ${kv('Seharusnya di laci', rupiah(k.expected_cash), ' is-total')}
        ${kv('Dihitung staf', k.counted_cash == null ? '–' : rupiah(k.counted_cash))}
        <div class="tl-kv is-total"><span>Selisih</span>${diffTag(k.difference, k.flag_at)}</div>
        ${k.note ? `<p class="small">Catatan staf: ${esc(k.note)}</p>` : ''}
      </div>
      <div>
        ${kv('Total penjualan', rupiah(k.total))}
        ${kv('QRIS', rupiah(pay('qris')))}
        ${kv('Tunai', rupiah(pay('tunai')))}
        ${kv('Pesanan dibayar', k.orders)}
        ${kv(`Batal (${k.voids.batal_count})`, rupiah(k.voids.batal_amount))}
        ${kv(`Refund (${k.voids.refund_count})`, rupiah(k.voids.refund_amount))}
        ${(k.flags || []).length ? `<p>${k.flags.map((f) => `<span class="tag tag-bad">${esc(FLAG[f] || f)}</span>`).join(' ')}</p>` : ''}
      </div>
    </div>
    <div class="row">
      ${k.closed ? '<button class="btn" type="button" id="kas-print">Cetak ulang rekap</button>' : ''}
      <button class="btn btn-quiet" type="button" id="kas-pdf">Unduh PDF</button>
      <button class="btn btn-quiet" type="button" id="kas-png">Unduh gambar struk</button>
      ${k.closed ? '' : '<button class="btn btn-quiet" type="button" id="kas-setor">Catat setor</button>'}
    </div>
    <div class="notice" id="kas-msg" hidden></div>
  </div>
  <div class="panel stack">
    <h3>Catatan laci</h3>
    <p class="muted small">Modal, setiap penjualan tunai (uang diterima dan kembalian), kas masuk, keluar dan setor, lalu hitungan staf. Kolom Laci adalah isi laci yang seharusnya setelah kejadian itu.</p>
    <div class="table-wrap"><table><thead><tr><th>Jam</th><th>Kejadian</th><th class="num">Diterima</th><th class="num">Kembalian</th><th class="num">Masuk/keluar</th><th class="num">Laci</th></tr></thead><tbody>
      ${(k.ledger || []).map((e) => `<tr><td class="num">${esc(e.time)}</td><td>${esc(ledgerLabel(e))}</td>
        <td class="num">${e.received != null ? rupiah(e.received) : ''}</td><td class="num">${e.change != null ? rupiah(e.change) : ''}</td>
        <td class="num">${e.kind === 'hitung' ? '' : signed(e.amount)}</td>
        <td class="num"><b>${e.kind === 'hitung' ? rupiah(e.counted) : rupiah(e.balance)}</b></td></tr>`).join('')}
    </tbody></table></div>
  </div>
  <div class="form-grid">
    <div class="panel stack">
      <h3>Hitungan per pecahan</h3>
      ${k.denominations ? `<div class="table-wrap"><table><thead><tr><th>Pecahan</th><th class="num">Lembar</th><th class="num">Jumlah</th></tr></thead><tbody>
        ${DENOMS.map((d) => `<tr><td class="num">${rupiah(Number(d))}</td><td class="num">${den[d] || 0}</td><td class="num">${rupiah(Number(d) * (den[d] || 0))}</td></tr>`).join('')}
        <tr><td>Koin</td><td></td><td class="num">${rupiah(den.koin || 0)}</td></tr>
        <tr><td><b>Total</b></td><td></td><td class="num"><b>${rupiah(k.counted_cash)}</b></td></tr></tbody></table></div>`
        : `<p class="muted">${k.closed ? 'Ditutup tanpa hitungan per pecahan.' : 'Dihitung saat tutup shift.'}</p>`}
    </div>
    <div class="panel stack">
      <h3>Barang terjual</h3>
      ${k.items.length ? `<div class="table-wrap"><table><thead><tr><th>Barang</th><th class="num">Qty</th><th class="num">Harga</th><th class="num">Total</th></tr></thead><tbody>
        ${k.items.map((i) => `<tr><td>${esc([i.name, i.flavour].filter(Boolean).join(' · '))}${i.promo ? ' <span class="tag tag-warn">promo</span>' : ''}</td>
          <td class="num">${i.qty}</td><td class="num">${i.unit != null ? rupiah(i.unit) : '–'}</td><td class="num">${rupiah(i.total)}</td></tr>`).join('')}
        <tr><td>Subtotal</td><td></td><td></td><td class="num">${rupiah(k.subtotal)}</td></tr>
        ${k.discount ? `<tr><td>Diskon</td><td></td><td></td><td class="num">−${rupiah(k.discount)}</td></tr>` : ''}
        <tr><td><b>Total akhir</b></td><td class="num"><b>${k.items.filter((i) => !i.free_bag).reduce((t, i) => t + i.qty, 0)}</b></td><td></td><td class="num"><b>${rupiah(k.total)}</b></td></tr></tbody></table></div>` : '<p class="muted">Belum ada penjualan.</p>'}
    </div>
  </div>
  <div class="panel stack">
    <h3>Kas masuk, keluar dan setor</h3>
    ${k.moves.length ? `<ul style="list-style: none; margin: 0; padding: 0">${k.moves.map((m) => `<li class="tl-kv"><span>${esc(m.time)} · ${esc({ masuk: 'Masuk', keluar: 'Keluar', setor: 'Setor' }[m.kind])}: ${esc(m.reason)}${m.by ? ` (${esc(m.by)})` : ''}</span>
      <b class="num">${m.kind === 'masuk' ? '+' : '−'}${rupiah(m.amount)}</b></li>`).join('')}</ul>` : '<p class="muted">Tidak ada.</p>'}
    ${k.denominations ? `<p class="muted small">Pecahan: ${esc(denomText(k.denominations))}</p>` : ''}
  </div>`;
  $('#kas-back', panel).addEventListener('click', () => { panel._kas.open = null; mountCashRekap(panel, { rpc }); });
  const msg = $('#kas-msg', panel);
  $('#kas-print', panel)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Mencetak…');
    try {
      const at = new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).replace(/\./g, ':').replace(',', '');
      // The owner's copy carries the owner figures; a first print is a normal one, any later one CETAK ULANG.
      const p = await printer.print(rekapReceipt(k, { dots: paper() === '80' ? 576 : 384, reprint: !!k.printed_at, at }).bytes(), (t) => notice(msg, t, 'ok'));
      const m = await rpc('pos_rekap_printed', { p_shift: k.id });
      notice(msg, `${m.reprint ? 'Cetak ulang' : 'Rekap'} terkirim ke ${p.name}.`, 'ok');
    } catch (err) {
      if (err?.name === 'NotFoundError') { printer.forget(); notice(msg, 'Tidak ada printer yang dipilih.', 'warn'); }
      else notice(msg, err.message || String(err));
    } finally { busy(btn, false); }
  });
  $('#kas-pdf', panel).addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    busy(btn, true, 'Menyiapkan…');
    try {
      const blob = await rekapPdf(k);
      rpc('pos_rekap_exported', { p_shift: k.id }).catch(() => {});
      const how = await sharePdf(blob, rekapFile(k), `Rekap kas Hanashuya ${k.start} sampai ${k.end || 'sekarang'}`, { download: true });
      if (how === 'downloaded') notice(msg, 'PDF tersimpan di unduhan.', 'ok');
    } catch (err) { notice(msg, err.message); } finally { busy(btn, false); }
  });
  $('#kas-png', panel).addEventListener('click', () => {
    const c = rekapPreview(k, { dots: paper() === '80' ? 576 : 384 });
    c.toBlob((b) => {
      const url = URL.createObjectURL(b);
      const a = Object.assign(document.createElement('a'), { href: url, download: rekapFile(k).replace('.pdf', '.png') });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  });
  $('#kas-setor', panel)?.addEventListener('click', () => setorForm(panel, rpc, k));
}

// Setor: cash the owner takes out of the drawer. Staff never see it.
function setorForm(panel, rpc, k) {
  const box = document.createElement('form');
  box.className = 'panel stack'; box.noValidate = true;
  box.innerHTML = `<h3>Catat setor</h3>
    <p class="muted small">Uang yang diambil dari laci untuk pemilik. Staf tidak melihat catatan ini; laci yang seharusnya berkurang sebanyak setor.</p>
    <div class="form-grid">
      <label class="field"><span>Jumlah ${REQ}</span><span class="tl-money"><span aria-hidden="true">Rp</span><input type="text" inputmode="numeric" name="amount" required></span></label>
      <label class="field"><span>Keterangan ${REQ}</span><input type="text" name="reason" maxlength="200" value="Setor ke pemilik" required></label>
    </div>
    <div class="notice" hidden></div>
    <div class="row"><button class="btn" type="submit">Simpan setor</button><button class="btn btn-quiet" type="button" data-x>Batal</button></div>`;
  $('#kas-msg', panel).after(box);
  box.addEventListener('input', (e) => { if (e.target.name === 'amount') { const n = money(e.target); e.target.value = n == null ? '' : n.toLocaleString('id-ID'); } });
  $('[data-x]', box).addEventListener('click', () => box.remove());
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', box);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('pos_cash_move', { p_kind: 'setor', p_amount: money(box.elements.amount) || 0, p_reason: box.elements.reason.value });
      toast('Setor tercatat.');
      detail(panel, rpc, k.id);
    } catch (err) { busy(btn, false); notice($('.notice', box), err.message); }
  });
}
