// Persetujuan in the owner page (Glenn, 20 Nov 2026: "why are cancels, permintaan barang and requests
// that need my or a manager's permission not on the dashboard?"). The same decisions as the till's
// Persetujuan (approvals.js: batal and refund, undo stempel or hadiah, batal catatan stok, stok opname),
// plus the open Permintaan barang to read (they need no decision). Ringkasan shows a bar while anything
// waits and a pop-up once for each new item on this device.
import { $, esc, rupiah, when } from './lib.js';
import { mountApprovals } from './approvals.js';

const OUT = { buang: 'dibuang', rusak: 'rusak', promo: 'promo' };
const fmtQty = (n) => Math.abs(Number(n) || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });
const by = (who, at, why) => [who || 'Kasir', at ? when(at) : '', why].filter(Boolean).join(' · ');

// Everything waiting. A database without one of the functions just shows none of that kind.
export async function loadPending(rpc) {
  const [voids, undo, stock, count, reqs] = await Promise.all([
    rpc('pos_void_list').catch(() => []), rpc('manager_pending_undo').catch(() => []),
    rpc('stock_cancel_pending').catch(() => []), rpc('stock_count_pending').catch(() => null),
    rpc('stock_request_open').catch(() => [])]);
  return { voids: voids || [], undo: undo || [], stock: stock || [], count: count || null, reqs: reqs || [] };
}

// One entry per item: key (for the pop-up), title, sub, decide (true: needs Setujui or Tolak).
export function pendingItems(d) {
  return [
    ...(d.count ? [{ key: `c${d.count.id}`, decide: true, title: `Stok opname menunggu dicek${d.count.closing ? ' (tutup booth)' : ''}`, sub: by(d.count.responsible || d.count.by, d.count.at, 'Terima atau tolak') }] : []),
    ...d.voids.map((v) => ({ key: `v${v.id}`, decide: true, title: `${v.kind === 'refund' ? 'Refund' : 'Batal'} struk ${v.receipt_no} · ${rupiah(v.total)}`, sub: by(v.requested_by, v.created_at, v.reason) })),
    ...d.stock.map((c) => ({ key: `s${c.id}`, decide: true,
      title: c.kind === 'opname' ? `Batal ${c.item}` : `Batal barang ${c.kind === 'masuk' ? 'masuk' : `keluar${OUT[c.out_kind] ? ' (' + OUT[c.out_kind] + ')' : ''}`}: ${c.item} ${fmtQty(c.qty)} ${c.unit || ''}`.trim(),
      sub: by(c.requested_by, c.at, c.reason) })),
    ...d.undo.map((u) => ({ key: `u${u.id}`, decide: true, title: `Batal ${u.kind === 'penjualan' ? 'stempel' : 'hadiah'} untuk ${u.member || 'member'}`, sub: by(u.requested_by, u.created_at, u.reason) })),
    ...d.reqs.map((r) => ({ key: `r${r.id}`, decide: false, title: `Permintaan barang ${r.no}${r.status === 'sebagian' ? ' · sebagian datang' : ''}`,
      sub: by(r.by, r.at, [r.supplier, `${r.lines.length} barang`].filter(Boolean).join(', ')) })),
  ];
}

const listHtml = (items) => `<ul class="list">${items.map((x) => `<li><span class="grow"><strong>${esc(x.title)}</strong>${x.sub ? `<br><span class="muted small">${esc(x.sub)}</span>` : ''}</span></li>`).join('')}</ul>`;

// The bar on Ringkasan: decisions first; open Permintaan barang only when nothing waits for a decision.
export function askBarHtml(items) {
  const n = items.filter((x) => x.decide).length, r = items.length - n;
  if (!items.length) return '';
  const line = n ? `${n} permintaan menunggu keputusan${r ? ` · ${r} permintaan barang belum selesai` : ''}` : `${r} permintaan barang belum selesai`;
  return `<button class="hm-lowbar hm-askbar ap-bar" type="button" data-ap-open><span><b class="num">${esc(line)}</b></span><span class="hm-lowgo">Buka persetujuan <span aria-hidden="true">›</span></span></button>`;
}

// The pop-up: once per new item on this device. The bar stays until the item is decided or done.
const SEEN = 'hs-owner-seen-req';
const seen = () => { try { return new Set(JSON.parse(localStorage.getItem(SEEN) || '[]')); } catch { return new Set(); } };
const markSeen = (items) => { try { localStorage.setItem(SEEN, JSON.stringify(items.map((x) => x.key))); } catch { /* private window */ } };
export function popNew(items, open) {
  if (document.querySelector('dialog[open]')) return;
  const old = seen(), fresh = items.filter((x) => !old.has(x.key));
  markSeen(items);
  if (!fresh.length) return;
  const dec = fresh.filter((x) => x.decide), info = fresh.filter((x) => !x.decide);
  const dlg = document.createElement('dialog');
  dlg.className = 'tl-dlg dt-dlg stack';
  dlg.setAttribute('aria-labelledby', 'ap-pop-t');
  dlg.innerHTML = `<h2 id="ap-pop-t">${fresh.length === 1 ? 'Permintaan baru' : `${fresh.length} permintaan baru`}</h2>
    ${dec.length ? `${info.length ? '<h3 class="small">Perlu keputusan</h3>' : ''}${listHtml(dec)}` : ''}
    ${info.length ? `${dec.length ? '<h3 class="small">Permintaan barang</h3>' : ''}${listHtml(info)}` : ''}
    <p class="muted small">${dec.length ? 'Permintaan ini tetap ada di Ringkasan sampai diputuskan.' : 'Permintaan barang tetap ada di Ringkasan sampai barangnya datang.'}</p>
    <div class="row"><button class="btn" type="button" data-go>Buka persetujuan</button><button class="btn btn-quiet" type="button" data-x>Nanti</button></div>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  $('[data-x]', dlg).addEventListener('click', () => dlg.close());
  $('[data-go]', dlg).addEventListener('click', () => { dlg.close(); open(); });
  dlg.showModal();
}

// The Persetujuan view: the till's decision list, then the open Permintaan barang to read.
export async function mountOwnerApprovals(panel, { rpc, onChange }) {
  panel.innerHTML = `<div class="stack-sm"><h1>Persetujuan</h1>
      <p class="muted small">Permintaan dari kasir yang perlu keputusan pemilik atau manajer. Manajer tidak bisa memutuskan permintaannya sendiri.</p></div>
    <div class="stack-lg" data-ap></div>
    <section class="panel stack" aria-labelledby="ap-req"><h2 id="ap-req">Permintaan barang belum selesai</h2><div data-req><div class="skeleton"></div></div>
      <p class="muted small">Tidak perlu disetujui. Dikirim kasir ke dapur atau pemasok; selesai sendiri saat barangnya dicatat di Penerimaan barang.</p></section>`;
  mountApprovals($('[data-ap]', panel), { onDecide: onChange });
  const reqs = await rpc('stock_request_open').catch(() => null);
  const box = $('[data-req]', panel);
  if (!reqs) { box.innerHTML = '<p class="muted">Daftar permintaan barang tidak bisa dimuat.</p>'; return; }
  box.innerHTML = reqs.length ? `<ul class="list">${reqs.map((r) => `<li><span class="grow"><strong>${esc(r.no)}</strong>${r.status === 'sebagian' ? ' <span class="tag tag-warn">Sebagian datang</span>' : ''}${r.supplier ? ` · ${esc(r.supplier)}` : ''}<br>
      <span class="muted small">${esc(r.lines.map((l) => `${l.item} ${fmtQty(l.qty)} ${l.unit || ''}`.trim()).join(', '))}</span><br>
      <span class="muted small">${esc(by(r.by, r.at, r.needed_by ? `perlu ${r.needed_by}` : r.note))}</span></span></li>`).join('')}</ul>`
    : '<p class="muted">Tidak ada permintaan barang yang terbuka.</p>';
}
