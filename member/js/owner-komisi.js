// Tim > Dashboard komisi (Glenn's pick: draft A, 14 Nov 2026) and the Jadwal komisi settings.
// Commission closes per period (monthly cut-off), becomes "Belum dibayar" by itself when Proses
// otomatis is on, and stays there until the owner or a manager taps Tandai dibayar. The maths is in
// supabase/komisi-switch.sql (commission_dashboard, commission_set_schedule, _commission_autoprocess).
//   mountCommissionDashboard(panel, { rpc })   owner and managers
//   scheduleHtml(settings) / bindSchedule(panel, rpc, again)   the Jadwal komisi section in Tim > Komisi
import { $, $$, esc, rupiah, toast, notice, busy } from './lib.js';
import { formDialog, infoDialog } from './data-table.js';

const fmt = (opts) => (iso) => (iso ? new Intl.DateTimeFormat('id-ID', { timeZone: 'UTC', ...opts }).format(new Date(iso + 'T00:00:00Z')) : '');
const dShort = fmt({ day: 'numeric', month: 'short' });
const dLong = fmt({ day: 'numeric', month: 'short', year: 'numeric' });
const dDay = fmt({ weekday: 'short', day: 'numeric', month: 'short' });
const span = (a, b) => {
  if (!a || !b) return '';
  if (a.slice(0, 7) === b.slice(0, 7)) return `${Number(a.slice(8))}–${dShort(b)}`;
  return `${dShort(a)} – ${dShort(b)}`;
};
const pct = (a, b) => (b > 0 ? (a / b * 100).toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%' : '–');
const loading = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errorBox = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;

// The period maths of komisi-switch.sql, for the schedule preview. Dates are 'YYYY-MM-DD'.
const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const cutoffIn = (day, cut) => { const y = +day.slice(0, 4), m = +day.slice(5, 7) - 1; return cut ? iso(y, m, cut) : iso(y, m + 1, 0); };
const nextMonth = (day) => iso(+day.slice(0, 4), +day.slice(5, 7), 1);
const plus1 = (day) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const periodEnd = (day, cut) => (cutoffIn(day, cut) >= day ? cutoffIn(day, cut) : cutoffIn(nextMonth(day), cut));
const periodStart = (day, cut) => { const e = periodEnd(day, cut); const prev = iso(+e.slice(0, 4), +e.slice(5, 7) - 2, 1); return plus1(cutoffIn(prev, cut)); };
const dueOf = (to, pay) => { const n = nextMonth(to); return iso(+n.slice(0, 4), +n.slice(5, 7) - 1, pay); };
const cutLabel = (c) => (c ? `tanggal ${c}` : 'akhir bulan');

/* ---------------------------------------------------------------- Jadwal komisi (Tim > Komisi) */
export function scheduleHtml(c) {
  const opt = (v, cur, label) => `<option value="${v}"${Number(cur) === v ? ' selected' : ''}>${label}</option>`;
  const days = Array.from({ length: 28 }, (_, i) => i + 1);
  return `<section class="panel stack" aria-labelledby="kmj-t">
    <h1 id="kmj-t">Jadwal komisi</h1>
    <form class="stack" novalidate data-km-sched>
      <label class="check"><input type="checkbox" name="auto"${c.auto ? ' checked' : ''}><span><strong>Proses otomatis</strong></span></label>
      <p class="muted small">Begitu periode ditutup, komisi tiap staf langsung tercatat sebagai Belum dibayar. Kalau dimatikan, pemilik menekan Proses komisi di Dashboard komisi.</p>
      <div class="form-grid">
        <label class="field"><span>Tanggal tutup buku</span><select name="cutoff">${opt(0, c.cutoff_day, 'Akhir bulan')}${days.map((d) => opt(d, c.cutoff_day, `Tanggal ${d}`)).join('')}</select></label>
        <label class="field"><span>Tanggal bayar <span class="hint">di bulan berikutnya</span></span><select name="pay">${days.map((d) => opt(d, c.pay_day, `Tanggal ${d}`)).join('')}</select></label>
      </div>
      <p class="km-preview" data-km-preview aria-live="polite"></p>
      <p class="muted small">Mengubah jadwal tidak mengubah pesanan yang sudah diproses. Periode yang sedang berjalan ditutup di tanggal tutup buku baru yang pertama, jadi bisa lebih pendek dari sebulan. Tidak ada pesanan yang terlewat atau dibayar dua kali.</p>
      <div class="notice" data-msg hidden></div>
      <div><button class="btn" type="submit">Simpan jadwal</button></div>
    </form>
  </section>`;
}

export function bindSchedule(p, rpc, c, again) {
  const f = $('[data-km-sched]', p);
  if (!f) return;
  const today = c.today;
  const preview = () => {
    const cut = Number(f.elements.cutoff.value), pay = Number(f.elements.pay.value), auto = f.elements.auto.checked;
    let a = c.anchor || periodStart(today, cut), e = periodEnd(a, cut);
    const closed = [];
    while (e < today && closed.length < 36) { closed.push(span(a, e)); a = plus1(e); e = periodEnd(a, cut); }
    const lead = closed.length ? `Periode ${closed.join(', ')} sudah lewat dan ${auto ? 'langsung diproses' : 'menunggu Proses komisi'}. ` : '';
    $('[data-km-preview]', f).textContent = `${lead}Periode berjalan: ${span(a, e)} ${e.slice(0, 4)}, ditutup ${cutLabel(cut)}, dibayar ${dLong(dueOf(e, pay))}.`;
  };
  f.addEventListener('change', preview);
  preview();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', f);
    busy(btn, true, 'Menyimpan…');
    try {
      await rpc('commission_set_schedule', { p_auto: f.elements.auto.checked, p_cutoff: Number(f.elements.cutoff.value), p_pay_day: Number(f.elements.pay.value) });
      toast('Jadwal komisi tersimpan');
      again();
    } catch (err) { busy(btn, false); notice($('[data-msg]', f), err.message); }
  });
}

/* ---------------------------------------------------------------- Dashboard komisi */
const STATE = { bayar: 'Sudah dibayar', belum: 'Belum dibayar', proses: 'Belum diproses', berjalan: 'Periode berjalan' };
const key = (state, label) => `<span class="km-key km-${state}">${esc(label)}</span>`;
const RANGES = [['ini', 'Periode ini'], ['lalu', 'Periode lalu'], ['3', '3 periode']];

// A round top for the y-axis: 1, 2, 2.5 or 5 times a power of ten, in four steps.
function niceMax(v) {
  if (v <= 0) return 4000;
  const raw = v / 4, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
  return step * 4;
}
const rb = (n) => (n >= 1000 ? `Rp${(n / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })}rb` : rupiah(n));

export async function mountCommissionDashboard(p, { rpc }) {
  const st = p._km || (p._km = { range: 'ini' });
  const again = () => mountCommissionDashboard(p, { rpc });
  p.innerHTML = loading;
  let d;
  try { d = await rpc('commission_dashboard', { p_range: st.range }); } catch (e) { p.innerHTML = errorBox(e); return; }
  const s = d.settings;
  const states = [...new Set(d.periods.map((x) => x.state))];
  const order = ['bayar', 'belum', 'proses', 'berjalan'].filter((k) => states.includes(k));
  const legend = `<div class="km-legend">${order.map((k) => key(k, `${STATE[k]} (${d.periods.filter((x) => x.state === k).map((x) => span(x.from, x.to)).join(', ')})`)).join('')}</div>`;
  const stateOf = (day) => (d.periods.find((x) => day >= x.from && day <= x.to) || {}).state || 'berjalan';

  // Cards
  const unpaidTotal = d.unpaid.reduce((n, u) => n + u.commission, 0);
  const late = d.unpaid.filter((u) => u.overdue);
  const firstDue = d.unpaid.map((u) => u.due).sort()[0];
  const todo = d.unprocessed.filter((x) => x.commission > 0);
  const cards = [
    `<div class="stat"><span>${key('berjalan', 'Periode berjalan')}</span><b>${rupiah(d.current.commission)}</b>
      <em>${esc(span(d.current.from, d.current.to))}, ditutup ${esc(dShort(d.current.to))}, dibayar ${esc(dLong(d.current.due))}</em></div>`,
    todo.length ? `<div class="stat"><span>${key('proses', 'Belum diproses')}</span><b>${rupiah(todo.reduce((n, x) => n + x.commission, 0))}</b>
      <em>${todo.map((x) => esc(span(x.from, x.to))).join(', ')}</em>
      ${d.is_owner ? '<button class="btn" type="button" data-km-process>Proses komisi</button>' : '<em>Diproses oleh pemilik.</em>'}</div>` : '',
    `<div class="stat"><span>${key('belum', 'Belum dibayar')}</span><b>${rupiah(unpaidTotal)}</b>
      <em>${d.unpaid.length ? `${d.unpaid.length} pembayaran, jatuh tempo ${esc(dLong(firstDue))}` : 'Tidak ada yang perlu dibayar.'}</em>
      ${late.length ? `<em class="km-late">Terlambat: ${rupiah(late.reduce((n, u) => n + u.commission, 0))}</em>` : ''}
      ${d.unpaid.length ? '<button class="btn btn-quiet" type="button" data-km-pay>Tandai dibayar</button>' : ''}</div>`,
    `<div class="stat"><span>${key('bayar', 'Sudah dibayar')}</span><b>${rupiah(d.paid_year.total)}</b>
      <em>Tahun ${d.paid_year.year}, ${d.paid_year.count} pembayaran</em></div>`,
  ].join('');

  // Per staf
  const on = d.staff.filter((x) => x.on);
  const max = Math.max(1, ...on.flatMap((x) => x.daily));
  const spark = (x) => `<div class="km-spark" role="img" aria-label="Komisi per hari ${esc(x.name)}">${x.daily.map((c, j) => {
    const day = d.days[j].day;
    return `<i class="km-${stateOf(day)}" style="height:${(c / max * 100).toFixed(1)}%" title="${esc(dDay(day))}: ${esc(rupiah(c))}"></i>`;
  }).join('')}</div>`;
  const name = (x) => `${esc(x.name)}${x.employer ? `<small>${esc(x.employer)}</small>` : ''}`;
  const rows = d.staff.map((x) => (x.on
    ? `<tr><td>${name(x)}</td><td class="num">${x.orders}</td><td class="num">${rupiah(x.sales)}</td><td class="num"><b>${rupiah(x.commission)}</b></td>
        <td class="num">${pct(x.commission, x.sales)}</td><td class="num">${rupiah(x.unpaid)}</td><td class="num">${rupiah(x.paid)}</td><td>${spark(x)}</td></tr>`
    : `<tr class="km-off"><td>${name(x)}</td><td class="num">${x.orders}</td><td class="num">${rupiah(x.sales)}</td>
        <td colspan="5">Komisi mati. Penjualannya tidak dihitung untuk komisi.${x.unpaid || x.paid ? ` Belum dibayar ${rupiah(x.unpaid)}, sudah dibayar ${rupiah(x.paid)}.` : ''}</td></tr>`)).join('');
  const T = d.staff.reduce((t, x) => ({ orders: t.orders + x.orders, sales: t.sales + x.sales, kom: t.kom + x.commission, salesOn: t.salesOn + (x.on ? x.sales : 0),
    unpaid: t.unpaid + x.unpaid, paid: t.paid + x.paid }), { orders: 0, sales: 0, kom: 0, salesOn: 0, unpaid: 0, paid: 0 });

  // Daily chart
  const top = niceMax(Math.max(0, ...d.days.map((x) => x.commission)));
  const ticks = [4, 3, 2, 1, 0].map((i) => top * i / 4);
  const labelEvery = d.days.length > 40 ? 14 : 7;
  const chart = d.days.length ? `<div class="km-chart">
      <div class="km-yax" aria-hidden="true">${ticks.map((t) => `<span style="top:${100 - t / top * 100}%">${t ? rb(t) : 'Rp0'}</span>`).join('')}</div>
      <div class="km-plot" role="img" aria-label="Komisi per hari, ${esc(span(d.from, d.to))}">${d.days.map((x) =>
        `<i class="km-${x.state}" style="height:${(x.commission / top * 100).toFixed(1)}%" title="${esc(dDay(x.day))}: ${esc(rupiah(x.commission))}"></i>`).join('')}</div>
      <div class="km-xax" aria-hidden="true">${d.days.map((x, i) => `<span>${i % labelEvery === 0 ? esc(dShort(x.day)) : ''}</span>`).join('')}</div>
    </div>` : '<p class="muted">Belum ada periode yang sudah ditutup.</p>';

  p.innerHTML = `<div class="stack-lg">
    <div class="row-between km-head"><div class="stack-sm"><h1>Dashboard komisi</h1>
        <p class="muted small">Komisi tiap staf dibanding penjualannya, dan berapa yang belum dan sudah dibayar. Tutup buku ${cutLabel(s.cutoff_day)}, dibayar tanggal ${s.pay_day} bulan berikutnya${s.auto ? '' : ', diproses manual'}.</p></div>
      <div class="km-range" role="group" aria-label="Periode">${RANGES.map(([k, l]) => `<button type="button" data-km-range="${k}" aria-pressed="${st.range === k}">${l}</button>`).join('')}</div></div>
    ${s.enabled ? '' : '<p class="notice notice-warn">Sistem komisi mati, jadi tidak ada komisi yang dihitung. Nyalakan di Tim › Komisi.</p>'}
    <div class="stats km-stats">${cards}</div>
    <section class="panel stack" aria-labelledby="km-staff-t"><div class="row-between"><h2 id="km-staff-t">Per staf</h2><span class="small muted">${esc(span(d.from, d.to))}${d.to ? ` ${d.to.slice(0, 4)}` : ''}, diurutkan dari komisi terbesar</span></div>
      ${d.staff.length ? `<div class="table-wrap"><table class="km-table"><thead><tr><th>Staf</th><th class="num">Pesanan</th><th class="num">Penjualan</th><th class="num">Komisi</th><th class="num">% dari penjualan</th>
        <th class="num">Belum dibayar</th><th class="num">Sudah dibayar</th><th>Komisi per hari</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${T.orders}</td><td class="num">${rupiah(T.sales)}</td><td class="num">${rupiah(T.kom)}</td><td class="num">${pct(T.kom, T.salesOn)}</td>
          <td class="num">${rupiah(T.unpaid)}</td><td class="num">${rupiah(T.paid)}</td><td></td></tr></tfoot></table></div>` : '<p class="muted">Belum ada staf.</p>'}
      ${legend}
      <p class="muted small">Komisi masuk ke staf yang melayani pesanan, dihitung dari pesanan yang sudah dibayar. Grafik kecil memakai skala yang sama untuk semua staf, jadi tingginya bisa dibandingkan.</p></section>
    <section class="panel stack" aria-labelledby="km-day-t"><div class="row-between"><h2 id="km-day-t">Komisi per hari, semua staf</h2>${legend}</div>
      ${chart}
      <p class="muted small">Arahkan ke satu batang untuk melihat tanggal dan jumlahnya.</p></section>
  </div>`;

  $$('[data-km-range]', p).forEach((b) => b.addEventListener('click', () => { st.range = b.dataset.kmRange; again(); }));
  $('[data-km-pay]', p)?.addEventListener('click', () => payList(d, rpc, again));
  $('[data-km-process]', p)?.addEventListener('click', async () => {
    const x = d.unprocessed[0];
    const done = await formDialog({
      title: 'Proses komisi', submitLabel: 'Proses',
      html: `<p>Periode ${esc(dLong(x.from))} sampai ${esc(dLong(x.to))}: <strong>${esc(rupiah(x.commission))}</strong>, jatuh tempo ${esc(dLong(x.due))}.</p>
        <p class="muted small">Komisi tiap staf dicatat sebagai Belum dibayar. Hari yang sudah diproses sebelumnya tidak dihitung lagi.</p>`,
      onSubmit: async () => { const r = await rpc('commission_process_period', { p_from: x.from, p_to: x.to }); toast(`${r.payouts} staf diproses, ${rupiah(r.total)}`); },
    });
    if (done) again();
  });
}

// Belum dibayar: every unpaid payout, oldest due first, each with its own Tandai dibayar.
async function payList(d, rpc, again) {
  let picked = null;
  await infoDialog({
    title: 'Belum dibayar', wide: true,
    html: `<div class="table-wrap"><table class="km-table"><thead><tr><th>Staf</th><th>Periode</th><th>Jatuh tempo</th><th class="num">Komisi</th><th></th></tr></thead><tbody>
      ${d.unpaid.map((u, i) => `<tr><td>${esc(u.name)}</td><td>${esc(span(u.from, u.to))} ${u.to.slice(0, 4)}</td>
        <td>${esc(dLong(u.due))}${u.overdue ? ' <span class="km-late">Terlambat</span>' : ''}</td><td class="num">${rupiah(u.commission)}</td>
        <td class="num">${u.own && !d.is_owner ? '<span class="muted small">Dibayar oleh pemilik</span>' : `<button class="btn btn-quiet" type="button" data-km-one="${i}">Tandai dibayar</button>`}</td></tr>`).join('')}
      </tbody></table></div>`,
    onOpen: (form, dlg) => $$('[data-km-one]', form).forEach((b) => b.addEventListener('click', () => { picked = d.unpaid[Number(b.dataset.kmOne)]; dlg.close(); })),
  });
  if (!picked) return;
  const u = picked;
  const done = await formDialog({
    title: `Komisi ${u.name}`, submitLabel: 'Tandai dibayar',
    html: `<dl class="kv"><dt>Periode</dt><dd>${esc(dLong(u.from))} sampai ${esc(dLong(u.to))}</dd><dt>Pesanan</dt><dd>${u.orders}</dd>
        <dt>Komisi</dt><dd><strong>${esc(rupiah(u.commission))}</strong></dd><dt>Jatuh tempo</dt><dd>${esc(dLong(u.due))}${u.overdue ? ' <span class="km-late">Terlambat</span>' : ''}</dd></dl>
      <label class="field"><span>${d.is_owner ? 'Catatan pembayaran / alasan batal' : 'Catatan pembayaran'} <span class="hint">boleh dikosongkan</span></span>
        <input name="note" type="text" maxlength="200" placeholder="Contoh: transfer BCA"></label>`,
    onSubmit: async (f) => { await rpc('pos_commission_mark_paid', { p_id: u.id, p_note: f.elements.note.value }); toast('Ditandai dibayar'); },
    buttons: d.is_owner ? [{ label: 'Batalkan', danger: true, onClick: async (f) => {
      if (!f.elements.note.value.trim()) throw new Error('Tulis alasan pembatalan di kolom catatan.');
      await rpc('pos_commission_cancel', { p_id: u.id, p_reason: f.elements.note.value }); toast('Komisi dibatalkan');
    } }] : [],
  });
  if (done) again();
}
