// Persetujuan tab on the cashier page: managers and the owner decide POS voids/refunds
// member-app undo requests (stamp or reward) and stock cancel requests (barang masuk or
// keluar or stok opname). Mounted from staff.js and the till's Persetujuan screen. The stok
// opname waiting to be checked shows on top (Terima or Tolak), so every request is in one place.
import { $, $$, esc, rpc, busy, toast, rupiah, when } from './lib.js';
import { countReview } from './stock.js';

const PAY = { tunai: 'Tunai', qris: 'QRIS', debit: 'Debit', transfer: 'Transfer', gratis: 'Gratis' };
let root;

export function mountApprovals(panel) {
  root = panel;
  root.innerHTML = '<p class="muted" role="status">Memuat…</p>';
  load();
}

export async function loadApprovals() { if (root) await load(); }

async function load() {
  let voids, undo, stock;
  // Stock cancel requests (stock.sql, 14 Nov 2026); a database without them just shows none.
  try { [voids, undo, stock] = await Promise.all([rpc('pos_void_list'), rpc('manager_pending_undo'), rpc('stock_cancel_pending').catch(() => [])]); }
  catch (e) { root.innerHTML = `<div class="notice notice-error" role="alert">${esc(e.message)}</div>`; return; }
  voids = voids || []; undo = undo || []; stock = stock || [];
  root.innerHTML = `
  <div data-count></div>
  <section class="panel stack" aria-labelledby="ap-void">
    <h2 id="ap-void">Pembatalan dari kasir${voids.length ? ` (${voids.length})` : ''}</h2>
    ${voids.length ? `<ul class="list">${voids.map(voidRow).join('')}</ul>` : '<p class="muted">Tidak ada permintaan yang menunggu.</p>'}
  </section>
  <section class="panel stack" aria-labelledby="ap-undo">
    <h2 id="ap-undo">Batal stempel atau hadiah${undo.length ? ` (${undo.length})` : ''}</h2>
    ${undo.length ? `<ul class="list">${undo.map(undoRow).join('')}</ul>` : '<p class="muted">Tidak ada permintaan yang menunggu.</p>'}
  </section>
  <section class="panel stack" aria-labelledby="ap-stock">
    <h2 id="ap-stock">Batal catatan stok${stock.length ? ` (${stock.length})` : ''}</h2>
    ${stock.length ? `<ul class="list">${stock.map(stockRow).join('')}</ul>` : '<p class="muted">Tidak ada permintaan yang menunggu.</p>'}
  </section>`;
  bind(root);
  // Stock functions may be missing on an older database: the box then stays empty.
  countReview($('[data-count]', root), () => load()).catch(() => {});
}

const bind = (el) => $$('[data-decide]', el).forEach((b) => b.addEventListener('click', () => ask(b)));

function voidRow(v) {
  const kind = v.kind === 'refund' ? 'Refund' : 'Batal';
  return `<li><span class="grow"><strong>${kind} struk ${esc(v.receipt_no)}</strong>, <span class="num">${esc(rupiah(v.total))}</span> (${esc(PAY[v.payment_method] || v.payment_method || 'belum dibayar')})<br>
    <span class="muted small">${esc(v.requested_by || 'Kasir')}, ${esc(when(v.created_at))}: ${esc(v.reason)}</span></span>
    <span class="row ap-actions">${buttons('pos', v.id)}</span></li>`;
}

function undoRow(u) {
  const what = u.kind === 'penjualan'
    ? `${u.receipt_no ? 'Struk ' + u.receipt_no : 'Penjualan ' + rupiah(u.total || 0)}, ${u.stamps || 0} stempel`
    : (u.reward_label || 'Hadiah');
  return `<li><span class="grow"><strong>${esc(what)}</strong> untuk ${esc(u.member || 'member')}<br>
    <span class="muted small">${esc(u.requested_by || 'Kasir')}, ${esc(when(u.created_at))}: ${esc(u.reason)}</span></span>
    <span class="row ap-actions">${buttons('undo', u.id)}</span></li>`;
}

const OUT = { buang: 'Dibuang', rusak: 'Rusak', promo: 'Promo' };
function stockRow(c) {
  const qty = Math.abs(Number(c.qty) || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
  const what = c.kind === 'masuk' ? 'Batal barang masuk' : `Batal barang keluar${OUT[c.out_kind] ? ` (${OUT[c.out_kind]})` : ''}`;
  const head = c.kind === 'opname' ? `Batal ${esc(c.item)}` : `${esc(what)}: ${esc(c.item)}, ${esc(qty)} ${esc(c.unit || '')}`;
  return `<li><span class="grow"><strong>${head}</strong><br>
    <span class="muted small">${esc(c.requested_by || 'Kasir')}, ${esc(when(c.at))}: ${esc(c.reason)}</span></span>
    <span class="row ap-actions">${buttons('stok', c.id)}</span></li>`;
}

const DECIDE = { pos: 'pos_decide_void', undo: 'owner_decide_undo', stok: 'stock_cancel_decide' };
const buttons = (src, id) => `<button class="btn ap-btn" type="button" data-decide="${src}" data-id="${id}" data-ok="1">Setujui</button>
  <button class="btn btn-quiet ap-btn" type="button" data-decide="${src}" data-id="${id}" data-ok="0">Tolak</button>`;

// First tap swaps the two buttons for a confirm step; nothing is sent until "Ya".
function ask(btn) {
  const { decide: src, id, ok } = btn.dataset;
  const approve = ok === '1';
  const box = btn.closest('.ap-actions');
  const original = box.innerHTML;
  box.innerHTML = `<span class="small">${approve ? 'Yakin setujui?' : 'Yakin tolak?'}</span>
    <button class="btn ap-btn" type="button" data-yes>Ya</button>
    <button class="btn btn-quiet ap-btn" type="button" data-no>Batal</button>`;
  $('[data-no]', box).addEventListener('click', () => { box.innerHTML = original; bind(box); });
  const yes = $('[data-yes]', box);
  yes.addEventListener('click', async () => {
    busy(yes, true);
    try {
      await rpc(DECIDE[src], { p_id: Number(id), p_approve: approve });
      toast(approve ? 'Disetujui' : 'Ditolak');
    } catch (e) { toast(e.message); }
    await load();
  });
}
