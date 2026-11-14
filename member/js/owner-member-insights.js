// Member > Analitik member (Glenn, 14 Nov 2026: draft C3 "Aksi minggu ini").
//   mountMemberInsights(panel, { rpc })
// Two views: Kelompok member (five groups, this week's actions, moves between groups) and
// Semua member (the overall charts). SQL: supabase/member-insights.sql. Names are listed only
// for members who agreed to WhatsApp promos; a demographic or move count under 5 shows "<5".
import { $, $$, esc, rupiah, day } from './lib.js';
import { openWaDialog } from './owner-wa.js';
import { rangeHtml, wireRange, presetRange } from './owner-range.js';

const GROUPS = {
  baru: ['Baru', 'Datang 0–1 kali, aktif dalam 30 hari.'],
  aktif: ['Aktif', 'Datang 2+ kali, terakhir dalam 30 hari.'],
  setia: ['Setia', 'Datang 5+ kali atau kartu penuh.'],
  mulai_hilang: ['Mulai hilang', 'Terakhir datang 30–60 hari lalu.'],
  hilang: ['Hilang', 'Lebih dari 60 hari tidak datang.'],
};
const ORDER = ['baru', 'aktif', 'setia', 'mulai_hilang', 'hilang'];
const SHADE = { baru: 0.35, aktif: 0.6, setia: 1, mulai_hilang: 0.2, hilang: 0.1 };
const ACTIONS = {
  diskon_50: ['diskon 50% member baru berakhir dalam 7 hari', 'Ingatkan lewat WhatsApp sebelum diskonnya berakhir.'],
  satu_stempel: ['tinggal 1 stempel lagi ke hadiah', 'Ingatkan lewat WhatsApp, hadiahnya sudah dekat.'],
  baru_belum_kembali: ['daftar 7–30 hari lalu dan belum datang lagi', 'Sapa lewat WhatsApp, ajak mampir lagi.'],
  ulang_tahun: ['ulang tahun dalam 14 hari', 'Box ulang tahun muncul sendiri di kartu. Siapkan stok Mini Box isi 8.'],
  mulai_hilang: ['terakhir datang 30–60 hari lalu', 'Kirim satu pesan WhatsApp minggu ini.'],
  hilang: ['lebih dari 60 hari tidak datang', 'Satu pesan saja, lalu biarkan.'],
};
// The tag on each action row: the group it is about, or "Semua" when any group can be in it.
const ACTION_TAG = { diskon_50: 'Member baru', satu_stempel: 'Semua', baru_belum_kembali: 'Baru', ulang_tahun: 'Semua', mulai_hilang: 'Mulai hilang', hilang: 'Hilang' };
const LABEL = { perempuan: 'Perempuan', 'laki-laki': 'Laki-laki', tidak_disebut: 'Tidak disebut', kosong: 'Tidak diisi', '<17': 'Di bawah 17' };
const DAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const small = (n) => (n > 0 && n < 5 ? '&lt;5' : String(n));
const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
const loading = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const errBox = (e) => `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`;
const panelHtml = (title, body, note = '') => `<section class="panel stack"><h2>${title}</h2>${body}${note ? `<p class="muted small">${note}</p>` : ''}</section>`;

// One series of bars: rows [label, n, shown text]. Width is relative to the largest bar.
function bars(rows, { red = false, max } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r[1]));
  if (!rows.some((r) => r[1] > 0)) return '<p class="muted">Belum ada data.</p>';
  return `<div class="bars">${rows.map(([l, n, txt]) => `<div class="bar-row" title="${esc(l)}: ${txt ?? n}"><span>${esc(l)}</span>
    <span class="track"><i${red ? ' class="red"' : ''} style="transform:scaleX(${(n / top).toFixed(3)})"></i></span><span class="v">${txt ?? n}</span></div>`).join('')}</div>`;
}
// A share breakdown (gender, age) with small groups masked.
function shares(rows, order) {
  const total = rows.reduce((t, r) => t + r.n, 0);
  const list = order.map((k) => rows.find((r) => r.key === k)).filter(Boolean);
  return bars(list.map((r) => [LABEL[r.key] || r.key.replace('-', '–'), r.n, r.n < 5 ? '&lt;5' : `${pct(r.n, total)}%`]));
}

export function mountMemberInsights(panel, { rpc }) {
  const st = panel._mi || (panel._mi = { view: 'kelompok', days: 30, preset: '30', from: null, to: null });
  panel.innerHTML = `<div class="panel stack">
      <div class="row-between"><h1>Analitik member</h1>
        <div class="dr-chips" role="group" aria-label="Tampilan">${[['kelompok', 'Kelompok member'], ['semua', 'Semua member']].map(([k, l]) =>
          `<button class="btn btn-quiet dr-chip" type="button" data-view="${k}" aria-pressed="${st.view === k}">${l}</button>`).join('')}</div></div>
      <p class="muted small" id="mi-lead"></p>
    </div>
    <div id="mi-body" class="stack-lg" aria-live="polite"></div>`;
  $$('[data-view]', panel).forEach((b) => b.addEventListener('click', () => {
    st.view = b.dataset.view;
    $$('[data-view]', panel).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    show();
  }));
  const body = $('#mi-body', panel);
  const show = () => (st.view === 'kelompok' ? groups() : overview());

  /* ------------------------------------------------ Kelompok member */
  async function groups() {
    $('#mi-lead', panel).textContent = 'Member dibagi menjadi 5 kelompok menurut kebiasaan datang, lalu diubah menjadi hal yang bisa dilakukan minggu ini.';
    body.innerHTML = loading;
    let d;
    try { d = await rpc('owner_member_groups', { p_days: st.days }); } catch (e) { body.innerHTML = errBox(e); return; }
    const g = Object.fromEntries(d.groups.map((x) => [x.key, x]));
    const acts = d.actions.filter((a) => a.n > 0);
    const move = (f, t) => d.moves.find((m) => m.from === f && m.to === t)?.n || 0;
    const maxMove = Math.max(1, ...d.moves.map((m) => m.n));
    body.innerHTML = `
    <section class="panel stack" aria-labelledby="mi-g"><div class="row-between"><h2 id="mi-g">Kelompok member</h2><span class="small muted num">${d.total} member</span></div>
      ${d.total ? `<div class="seg-strip" role="img" aria-label="Pembagian member per kelompok">${ORDER.filter((k) => g[k].n).map((k) =>
        `<i style="flex:${g[k].n};--v:${SHADE[k]}" title="${GROUPS[k][0]}: ${g[k].n} member"></i>`).join('')}</div>` : ''}
      <div class="segs">${ORDER.map((k) => `<div class="seg-card"><h3>${GROUPS[k][0]}</h3><span class="n num">${g[k].n}</span><p>${GROUPS[k][1]}</p></div>`).join('')}</div>
    </section>
    <section class="panel stack" aria-labelledby="mi-a"><h2 id="mi-a">Yang bisa dilakukan minggu ini</h2>
      ${acts.length ? `<div class="table-wrap"><table><thead><tr><th>Kelompok</th><th class="num">Member</th><th>Kenapa</th><th>Saran</th><th></th></tr></thead><tbody>
        ${acts.map((a) => `<tr><td><span class="tag">${ACTION_TAG[a.key]}</span></td><td class="num"><strong>${a.n}</strong></td>
          <td>${ACTIONS[a.key][0]}</td><td>${ACTIONS[a.key][1]}<br><span class="muted small">${a.wa} setuju promo WhatsApp</span></td>
          <td><button class="btn btn-quiet" type="button" data-act="${a.key}" aria-expanded="false">Lihat member</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Belum ada yang perlu dilakukan minggu ini.</p>'}
      <p class="muted small">Saran dihitung dari aturan tetap: voucher, stempel, tanggal datang dan ulang tahun. Nama hanya muncul untuk member yang setuju menerima promo WhatsApp.</p>
      <div id="mi-list"></div>
    </section>
    <section class="panel stack" aria-labelledby="mi-m"><div class="row-between"><h2 id="mi-m">Perpindahan antar kelompok</h2>
        <div class="dr-chips" role="group" aria-label="Periode">${[7, 30, 90].map((n) => `<button class="btn btn-quiet dr-chip" type="button" data-days="${n}" aria-pressed="${st.days === n}">${n} hari</button>`).join('')}</div></div>
      <p class="muted small">Dari kelompok ${st.days} hari lalu (kiri) ke kelompok hari ini (atas). "Belum daftar" adalah member yang daftar dalam ${st.days} hari terakhir.</p>
      <div class="table-wrap"><table class="move"><thead><tr><th>Dari ↓ ke →</th>${ORDER.map((k) => `<th class="num">${GROUPS[k][0]}</th>`).join('')}</tr></thead><tbody>
        ${['belum', ...ORDER].map((f) => `<tr><td>${f === 'belum' ? 'Belum daftar' : GROUPS[f][0]}</td>${ORDER.map((t) => {
          const n = move(f, t), v = n / maxMove;
          return `<td class="num${v > 0.55 ? ' hot' : ''}" style="--v:${v.toFixed(3)}" title="${f === 'belum' ? 'Belum daftar' : GROUPS[f][0]} ke ${GROUPS[t][0]}: ${n}">${n ? small(n) : '–'}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>
    </section>`;
    $$('[data-days]', body).forEach((b) => b.addEventListener('click', () => { st.days = Number(b.dataset.days); groups(); }));
    $$('[data-act]', body).forEach((b) => b.addEventListener('click', () => {
      $$('[data-act]', body).forEach((x) => x.setAttribute('aria-expanded', String(x === b)));
      list(b.dataset.act);
    }));
  }

  async function list(key) {
    const box = $('#mi-list', body);
    box.innerHTML = '<div class="skeleton"></div>';
    let d;
    try { d = await rpc('owner_member_action_list', { p_key: key }); } catch (e) { box.innerHTML = errBox(e); return; }
    const NOTE = { diskon_50: 'Diskon 50%', satu_stempel: 'Hadiah berikutnya', baru_belum_kembali: 'Daftar', ulang_tahun: 'Ulang tahun' };
    box.innerHTML = `<div class="stack panel-sunk"><div class="row-between"><h3>${esc(ACTIONS[key][0][0].toUpperCase() + ACTIONS[key][0].slice(1))}</h3>
        <button class="btn btn-quiet" type="button" id="mi-close">Tutup</button></div>
      ${d.rows.length ? `<div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Kunjungan</th><th class="num">Total belanja</th><th>Terakhir datang</th><th class="num">Kartu</th>${NOTE[key] ? `<th>${NOTE[key]}</th>` : ''}<th></th></tr></thead><tbody>
        ${d.rows.map((m) => `<tr><td>${esc(m.name || '(tanpa nama)')}</td><td class="num">${m.visits}</td><td class="num">${esc(rupiah(m.spent))}</td>
          <td>${m.last_visit ? esc(day(m.last_visit)) : 'Belum pernah'}</td><td class="num">${m.position}/10</td>${NOTE[key] ? `<td>${esc((m.note || '').replace(/^(Berakhir|Daftar|Ulang tahun) /, ''))}</td>` : ''}
          <td><button class="btn btn-quiet" type="button" data-wa="${esc(m.id)}" data-name="${esc(m.name || '')}">Kirim WhatsApp</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Tidak ada member di daftar ini yang setuju menerima promo WhatsApp.</p>'}
      ${d.hidden ? `<p class="muted small">${d.hidden} member lain tidak setuju promo WhatsApp, jadi tidak ditampilkan.</p>` : ''}</div>`;
    $('#mi-close', box).addEventListener('click', () => { box.innerHTML = ''; $$('[data-act]', body).forEach((x) => x.setAttribute('aria-expanded', 'false')); });
    $$('[data-wa]', box).forEach((b) => b.addEventListener('click', () => openWaDialog({ id: b.dataset.wa, name: b.dataset.name }, { rpc })));
    box.scrollIntoView({ block: 'nearest' });
  }

  /* ------------------------------------------------ Semua member */
  async function overview() {
    $('#mi-lead', panel).textContent = 'Gambaran semua member: pertumbuhan, kebiasaan belanja dan siapa mereka.';
    const [from, to] = st.preset === 'custom' ? [st.from, st.to] : presetRange(st.preset);
    body.innerHTML = `<div class="panel">${rangeHtml({ preset: st.preset, from, to, keys: ['7', '30', 'bulan', 'bulan-lalu', 'tahun', 'custom'] })}</div><div id="mi-ov" class="stack-lg">${loading}</div>`;
    wireRange(body, { onChange: ({ preset, from: f, to: t }) => { Object.assign(st, { preset, from: f, to: t }); overview(); } });
    const out = $('#mi-ov', body);
    let d;
    try { d = await rpc('owner_member_overview', { p_from: from, p_to: to }); } catch (e) { out.innerHTML = errBox(e); return; }
    const mOrd = d.member_orders, oOrd = d.other_orders, allRev = d.member_revenue + d.other_revenue;
    const v = d.vouchers;
    const wkMax = Math.max(5, ...d.weeks.map((w) => w.n));
    const top = Math.ceil(wkMax / 5) * 5;
    const bMax = Math.max(1, ...d.birthdays.map((b) => b.n));
    out.innerHTML = `
    <div class="stats">
      <div class="stat"><span>Total member</span><b>${d.total}</b><em>${d.new} baru di periode ini</em></div>
      <div class="stat"><span>Member aktif</span><b>${d.active}</b><em>datang di periode ini</em></div>
      <div class="stat"><span>Datang lagi</span><b>${d.visited ? pct(d.repeat, d.visited) + '%' : '–'}</b><em>dari yang pernah belanja</em></div>
      <div class="stat"><span>Jarak antar kunjungan</span><b>${d.gap_days == null ? '–' : d.gap_days + ' hari'}</b><em>median</em></div>
      <div class="stat"><span>Omzet dari member</span><b>${allRev ? pct(d.member_revenue, allRev) + '%' : '–'}</b><em>${esc(rupiah(d.member_revenue))}</em></div>
      <div class="stat"><span>Setuju promo WhatsApp</span><b>${d.total ? pct(d.wa, d.total) + '%' : '–'}</b><em>${d.wa} member</em></div>
    </div>
    <div class="grid-2">
      ${panelHtml('Member baru per minggu', `<div class="wk"><div class="yax"><span>${top}</span><span>${top / 2}</span><span>0</span></div>
        <div class="plot" role="img" aria-label="Member baru per minggu, 8 minggu terakhir">${d.weeks.map((w) => `<i style="height:${(w.n / top) * 100}%" title="Minggu ${esc(day(w.week))}: ${w.n} member baru"></i>`).join('')}</div>
        <div class="xax">${d.weeks.map((w) => `<span>${esc(day(w.week).replace(/ \d{4}$/, ''))}</span>`).join('')}</div></div>`, 'Minggu dimulai hari Senin.')}
      ${panelHtml('Cara daftar', (() => { const s = d.source, t = s.qr + s.tablet + s.voucher;
        return bars([['QR di HP sendiri', s.qr, t ? pct(s.qr, t) + '%' : '0'], ['Didaftarkan di tablet', s.tablet, t ? pct(s.tablet, t) + '%' : '0'], ['Voucher Papaya', s.voucher, t ? pct(s.voucher, t) + '%' : '0']]); })(),
        'Member yang daftar di periode ini. Voucher Papaya: menyimpan kode voucher kertas di hari daftar.')}
    </div>
    <div class="grid-2">
      ${panelHtml('Datang lagi', bars([['Datang 1 kali', d.visits.v1, `${d.visits.v1}`], ['Datang ke-2', d.visits.v2, `${pct(d.visits.v2, d.visits.v1)}%`],
        ['Datang ke-3', d.visits.v3, `${pct(d.visits.v3, d.visits.v1)}%`], ['Datang 5+ kali', d.visits.v5, `${pct(d.visits.v5, d.visits.v1)}%`]], { red: true }), 'Persen dari member yang pernah belanja, sejak awal.')}
      ${panelHtml('Belanja per nota', `<div class="vs"><div><span class="small muted">Member</span><span class="big num">${mOrd ? esc(rupiah(Math.round(d.member_revenue / mOrd))) : '–'}</span><span class="small muted">${mOrd} nota</span></div>
        <div><span class="small muted">Bukan member</span><span class="big num">${oOrd ? esc(rupiah(Math.round(d.other_revenue / oOrd))) : '–'}</span><span class="small muted">${oOrd} nota</span></div></div>`, 'Pesanan lunas di kasir pada periode ini.')}
    </div>
    <div class="grid-2">
      ${panelHtml('Posisi stempel', bars([['0 stempel', d.stamps.s0, small(d.stamps.s0)], ['1–2 stempel', d.stamps.s1, small(d.stamps.s1)], ['3–6 stempel', d.stamps.s3, small(d.stamps.s3)],
        ['7–9 stempel', d.stamps.s7, small(d.stamps.s7)], ['Kartu penuh', d.stamps.full, small(d.stamps.full)]]), 'Posisi di kartu yang sedang dipakai.')}
      ${panelHtml('Voucher dipakai', bars([['Diskon 50% member baru', pct(v.welcome.used, v.welcome.given), `${v.welcome.used}/${v.welcome.given}`],
        ['Ulang tahun', pct(v.birthday.used, v.birthday.given), `${v.birthday.used}/${v.birthday.given}`], ['Hadiah stempel', pct(v.reward.used, v.reward.given), `${v.reward.used}/${v.reward.given}`],
        ['Voucher kertas', pct(v.code.used, v.code.given), `${v.code.used}/${v.code.given}`]], { red: true, max: 100 }), 'Dipakai dari yang sudah diberikan, sejak awal.')}
    </div>
    ${panelHtml('Kapan member datang', heatmap(d.heatmap), 'Kunjungan member di periode ini.')}
    <div class="grid-2">
      ${panelHtml('Yang dibeli member', d.products.length ? `<div class="table-wrap"><table><thead><tr><th>Produk</th><th>Rasa terlaris</th><th class="num">Dibeli member</th><th class="num">% dari semua</th></tr></thead><tbody>
        ${d.products.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.flavour || '–')}</td><td class="num">${p.member_qty}</td><td class="num">${pct(p.member_qty, p.qty)}%</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Belum ada pesanan member di kasir pada periode ini.</p>')}
      ${panelHtml('Ulang tahun per bulan', `<div class="months">${d.birthdays.map((b) => { const x = b.n / bMax;
        return `<div><span class="c${x > 0.6 ? ' hot' : ''}" style="--v:${x.toFixed(2)}" title="${MONTHS[b.month - 1]}: ${b.n} member">${b.n ? small(b.n) : ''}</span>${MONTHS[b.month - 1]}</div>`; }).join('')}</div>`,
        'Untuk stok box ulang tahun. Hanya member yang mengisi tanggal lahir.')}
    </div>
    <div class="grid-3">
      ${panelHtml('Jenis kelamin', shares(d.gender, ['perempuan', 'laki-laki', 'tidak_disebut', 'kosong']))}
      ${panelHtml('Usia, semua member', shares(d.age, ['17-24', '25-34', '35-44', '45+', 'tidak_disebut', 'kosong']))}
      ${panelHtml('Usia, 20% belanja terbanyak', shares(d.age_top, ['17-24', '25-34', '35-44', '45+', 'tidak_disebut', 'kosong']))}
    </div>
    <p class="muted small">Kelompok di bawah 5 orang ditulis "&lt;5" supaya tidak ada member yang bisa dikenali.</p>`;
  }

  function heatmap(cells) {
    if (!cells.length) return '<p class="muted">Belum ada kunjungan member di periode ini.</p>';
    const lo = Math.min(8, ...cells.map((c) => c.hour)), hi = Math.max(20, ...cells.map((c) => c.hour));
    const max = Math.max(...cells.map((c) => c.n));
    const get = (dw, h) => cells.find((c) => c.dow === dw && c.hour === h)?.n || 0;
    const top = cells.reduce((a, b) => (b.n > a.n ? b : a));
    let html = `<p class="small">Paling sering: <strong>${['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'][top.dow - 1]} jam ${top.hour}.00</strong>.</p>
      <div class="table-wrap"><div class="heat" style="--cols:${hi - lo + 1}" role="img" aria-label="Kunjungan member per hari dan jam"><span></span>${Array.from({ length: hi - lo + 1 }, (_, i) => `<span class="h">${lo + i}</span>`).join('')}`;
    for (let dw = 1; dw <= 7; dw++) {
      html += `<span class="d">${DAYS[dw - 1]}</span>`;
      for (let h = lo; h <= hi; h++) { const n = get(dw, h), x = n / max; html += `<span class="c${x > 0.55 ? ' hot' : ''}" style="--v:${x.toFixed(3)}" title="${DAYS[dw - 1]} jam ${h}: ${n}">${n || ''}</span>`; }
    }
    return html + '</div></div>';
  }

  show();
}
