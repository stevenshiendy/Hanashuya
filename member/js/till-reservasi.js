// Till: "Pesanan di muka" (12 Nov 2026). Lists today's and overdue pre-orders; the cashier picks one,
// takes the whole total in Tunai or QRIS (no DP since 13 Nov 2026, Glenn), and it becomes a normal paid order
// (pos_reservation_checkout in supabase/pos-reservasi.sql). The receipt goes back to the till's
// done screen through onPaid, so printing and WhatsApp work as for any sale.
//   openReservations({ rpc, staff, qrisImg, onPaid })
import { esc, rupiah } from './lib.js';
import { formDialog, infoDialog } from './data-table.js';

const STATUS = { baru: ['Baru', 'tag-warn'], dikonfirmasi: ['Dikonfirmasi', ''], siap: ['Siap', 'tag-ok'] };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const digits = (v) => { const d = String(v || '').replace(/\D/g, ''); return d ? Number(d) : null; };
const dayShort = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' }).format(new Date(iso));
const isToday = (iso) => dayShort(iso) === dayShort(new Date().toISOString());

export async function openReservations({ rpc, staff = [], qrisImg, onPaid }) {
  const list = await rpc('pos_reservation_today');
  let chosen = null;
  await infoDialog({
    title: 'Pesanan di muka hari ini', wide: true,
    html: list.length ? `<ul style="list-style:none;padding:0;margin:0;display:grid;gap:var(--space-xs)">${list.map((r, i) => `<li><button class="hm-tool" type="button" data-pick="${i}" style="width:100%">
        <span class="hm-tt"><b>${esc(r.customer_name)} · ${esc(r.pickup_time.replace(':', '.'))}${isToday(r.pickup_at) ? '' : `, ${esc(dayShort(r.pickup_at))}`}</b>
        <small>${esc(r.no)} · ${esc(r.items_text || '')}</small>
        <small class="num">Total ${esc(rupiah(r.total))}</small></span>
        <span class="tag ${STATUS[r.status]?.[1] || ''}">${esc(STATUS[r.status]?.[0] || r.status)}</span></button></li>`).join('')}</ul>`
      : '<p class="muted">Tidak ada pesanan di muka untuk hari ini.</p>',
    onOpen: (form, dlg) => form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) { chosen = list[Number(b.dataset.pick)]; dlg.close(); }
    }),
  });
  if (chosen) await pickup({ rpc, staff, qrisImg, onPaid, id: chosen.id });
}

async function pickup({ rpc, staff, qrisImg, onPaid, id }) {
  const r = await rpc('pos_reservation_get', { p_id: id });
  const orderId = uuid();       // one id per attempt, so a retry after a dropped line is stored once
  const me = staff.find((s) => s.is_me)?.id;
  let paid = null;
  const items = r.items.map((i) => `<tr><td>${i.qty} ${esc(i.name)}${i.flavour_label ? ` · ${esc(i.flavour_label)}` : ''}</td><td class="num">${esc(rupiah(i.line_total))}</td></tr>`).join('');
  await formDialog({
    title: `${r.customer_name} · ${r.no}`, wide: true, submitLabel: r.due > 0 ? 'Terima pembayaran' : 'Serahkan pesanan', cancelLabel: 'Kembali',
    html: `<div class="table-wrap"><table><tbody>${items}</tbody></table></div>
      ${r.free_bags ? `<p class="small muted">Paper bag gratis: ${r.free_bags}</p>` : ''}
      ${r.note ? `<p class="small">Catatan: ${esc(r.note)}</p>` : ''}
      <dl class="kv"><dt><b>Total dibayar sekarang</b></dt><dd class="num"><b>${esc(rupiah(r.due))}</b></dd>
        ${r.member ? `<dt>Member</dt><dd>${esc(r.member.name)}, stempel masuk ke kartunya</dd>` : ''}</dl>
      ${r.status !== 'siap' ? '<p class="notice notice-warn">Pesanan ini belum ditandai siap. Pastikan isinya sudah lengkap.</p>' : ''}
      <label class="field"><span>Dilayani oleh</span><select name="served">${staff.map((s) => `<option value="${esc(s.id)}"${s.id === me ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      ${r.due > 0 ? `<label class="field"><span>Dibayar lewat</span><select name="method"><option value="tunai">Tunai</option><option value="qris">QRIS</option></select></label>
        <label class="field" data-cash><span>Uang diterima dari pembeli (Rp)</span><input type="text" inputmode="numeric" name="cash" autocomplete="off"></label>
        <p class="small num" data-change aria-live="polite"></p>
        <div data-qris hidden><img src="${esc(qrisImg)}" alt="QRIS Hanashuya" style="display:block;max-height:50vh;margin-inline:auto"></div>`
      : '<p class="notice notice-ok">Total Rp0. Tinggal serahkan pesanannya.</p>'}
      <p class="muted small">Harga mengikuti daftar produk hari ini. Kalau berubah sejak pesanan dicatat, totalnya ikut harga hari ini.</p>`,
    onOpen: (form) => {
      // Money fields take digits only, like the till's own Tunai field.
      form.elements.cash?.addEventListener('input', (e) => { const v = e.target.value.replace(/\D/g, ''); if (v !== e.target.value) e.target.value = v; });
      const m = form.elements.method;
      if (!m) return;
      const sync = () => {
        const tunai = m.value === 'tunai', cash = digits(form.elements.cash.value);
        form.querySelector('[data-cash]').hidden = !tunai;
        form.querySelector('[data-qris]').hidden = tunai;
        form.querySelector('[data-change]').textContent = !tunai || cash == null ? ''
          : cash < r.due ? `Kurang ${rupiah(r.due - cash)}` : `Kembalian ${rupiah(cash - r.due)}`;
      };
      form.addEventListener('input', sync); form.addEventListener('change', sync); sync();
    },
    onSubmit: async (form) => {
      const method = form.elements.method?.value || 'tunai';
      const cash = digits(form.elements.cash?.value);
      if (r.due > 0 && method === 'tunai' && (cash == null || cash < r.due)) throw new Error(`Isi uang diterima, paling sedikit ${rupiah(r.due)}.`);
      paid = await rpc('pos_reservation_checkout', { p_id: r.id, p_order: { id: orderId, served_by: form.elements.served.value,
        payment: { method, cash: cash ?? 0 }, client_at: new Date().toISOString() } });
    },
  });
  if (!paid) return;
  onPaid(paid);
}
