// Laporan > Laporan sampel (Glenn, 14 Nov 2026: draft C1 "Kuota harian per jam").
//   mountSamples(panel, { rpc })
// Today's sample quota per opening hour, tomorrow's suggested quota (Pakai saves it for that weekday,
// owner only), % jadi beli per hour for all 7 days (one line chart, one axis, plus a day x hour heat
// map), the period figures, the last 7 days, flavours and the marketing accounts.
// Jadi beli = a paid booth order within 1 hour after a sample, each order counted for the last sample
// before it. SQL: supabase/sample-insights.sql. The till warns when a quota is passed (never blocks).
import { $, $$, esc, rupiah, day } from './lib.js';
import { rangeHtml, wireRange, presetRange } from './owner-range.js';

const DN = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const DS = DN.map((d) => d.slice(0, 3));
const HH = (h) => String(h).padStart(2, '0') + '.00';
const pct = (n, t) => (t ? Math.round((n / t) * 100) : 0);
const x1 = (n) => (n == null ? '–' : Number(n).toFixed(1).replace('.', ',') + '×');
const REC = { naik: ['up', 'Tambah'], turun: ['down', 'Kurangi'], tetap: ['keep', 'Pertahankan'], kurang_data: ['wait', 'Data belum cukup'], baru_diubah: ['wait', 'Baru diubah'] };
const chip = (k, extra = '') => `<span class="sp-rec is-${REC[k][0]}">${REC[k][1]}${extra}</span>`;
const loading = '<div class="panel stack" aria-busy="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
const panelHtml = (title, body, note = '') => `<section class="panel stack"><h2>${title}</h2>${body}${note ? `<p class="muted small">${note}</p>` : ''}</section>`;
const FEW = 5; // a day x hour cell with fewer samples is hatched and left out of the lines

// Contiguous hours as "14.00–17.00 dan 19.00–20.00".
function spans(hs) {
  const out = []; let s = null, p = null;
  [...hs, null].forEach((h) => { if (h !== null && h === p + 1) { p = h; return; } if (s !== null) out.push(`${HH(s)}–${HH(p + 1)}`); s = p = h; });
  return out.join(' dan ');
}
const hgrid = (hours, rows) => `<div class="table-wrap"><div class="sp-hgrid" style="--n:${hours.length}"><span></span>${hours.map((h) => `<span class="sp-hh">${String(h).padStart(2, '0')}</span>`).join('')}${rows.join('')}</div></div>`;

function rulesHtml() {
  return `<ol class="sp-rules">
    <li><strong>Jadi beli</strong> = ada pesanan dibayar di kasir dalam 1 jam setelah sampel dicatat. Satu pesanan dihitung untuk satu sampel saja, yaitu sampel terakhir sebelum pesanan itu.</li>
    <li><strong>Hasil</strong> = laba kotor dari pesanan itu dibagi biaya sampel (harga pokok).</li>
    <li>Saran dihitung <strong>per jam untuk tiap hari</strong>, dari 8 minggu terakhir hari yang sama (misalnya 8 Minggu terakhir, jam 15.00).</li>
    <li>Jika jam itu punya kurang dari 20 pcs sampel, saran memakai jam yang sama di semua hari.</li>
    <li>${chip('naik')} jika jadi beli 25% atau lebih <em>dan</em> hasil 3× atau lebih: kuota jam itu naik 1 pcs.</li>
    <li>${chip('turun')} jika jadi beli di bawah 10% <em>atau</em> hasil di bawah 1×: kuota jam itu turun 1 pcs.</li>
    <li>${chip('tetap')} untuk yang di antaranya. ${chip('kurang_data')} jika jam itu belum punya 20 pcs sampel sama sekali.</li>
    <li>${chip('baru_diubah')} jika kuota jam itu diubah dalam 7 hari terakhir: saran baru muncul setelah ada data seminggu dengan kuota itu.</li>
    <li>Kuota tidak pernah 0: staf tetap menawarkan sampel sesuai SOP, minimal 1 pcs per jam. Di kasir, kuota yang terlewati hanya diberi peringatan.</li></ol>`;
}

export function mountSamples(panel, { rpc }) {
  const st = { preset: '30', from: null, to: null, sel: null, editing: false, data: null };
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Laporan sampel</h1>
      <p class="muted small">Kuota sampel per jam, berapa yang jadi beli, dan saran kuota besok. Biaya sampel dibukukan di 6-2410 Beban sampel produk, bagian dari Beban pemasaran.</p></div></div>
    <div data-sp-body class="stack-lg">${loading}</div>`;
  const body = $('[data-sp-body]', panel);

  const load = async () => {
    const [from, to] = st.preset === 'custom' ? [st.from, st.to] : presetRange(st.preset);
    try { st.data = await rpc('owner_sample_dashboard', { p_from: from, p_to: to }); }
    catch (e) { body.innerHTML = `<div class="panel"><div class="notice notice-error" role="alert">${esc(e.message)}</div></div>`; return; }
    if (st.sel == null) st.sel = st.data.tomorrow_dow - 1;
    render(from, to);
  };

  function render(from, to) {
    const d = st.data, hours = d.hours;
    // Today
    const th = d.today_hours, qTot = th.reduce((n, x) => n + Number(x.quota || 0), 0), gTot = th.reduce((n, x) => n + Number(x.pcs), 0);
    const nowCls = (h) => (h === d.now_hour ? ' class="is-now"' : '');
    const todayRows = [
      `<span class="sp-hl">Kuota</span>` + th.map((x) => `<span${nowCls(x.hour)}>${x.quota ?? '–'}</span>`).join(''),
      `<span class="sp-hl">Sudah</span>` + th.map((x) => `<span${nowCls(x.hour)}${x.pcs > (x.quota ?? Infinity) ? ' data-over' : ''}>${x.hour > d.now_hour ? '' : x.pcs}</span>`).join(''),
      `<span class="sp-hl">Jadi beli</span>` + th.map((x) => `<span>${x.hour > d.now_hour ? '' : x.hour === d.now_hour ? '…' : x.converted}</span>`).join('')];
    // Tomorrow
    const adv = d.advice, q0 = adv.reduce((n, a) => n + a.q, 0), q1 = adv.reduce((n, a) => n + a.nq, 0);
    const ups = adv.filter((a) => a.k === 'naik'), downs = adv.filter((a) => a.k === 'turun');
    const mark = (a) => (a.k === 'naik' ? '+1' : a.k === 'turun' ? '−1' : '=');
    const tmrRows = [
      `<span class="sp-hl">Kuota sekarang</span>` + adv.map((a) => `<span>${a.q}</span>`).join(''),
      `<span class="sp-hl">Saran</span>` + adv.map((a, i) => st.editing
        ? `<span><input class="sp-q" type="number" min="1" max="30" inputmode="numeric" value="${a.nq}" data-hour="${a.hour}" aria-label="Kuota jam ${HH(a.hour)}"></span>`
        : `<span class="is-${REC[a.k][0]}">${a.nq}</span>`).join(''),
      `<span class="sp-hl"></span>` + adv.map((a) => `<span class="is-${REC[a.k][0]} sp-small">${mark(a)}</span>`).join('')];
    const why = [ups.length ? `Tambah di ${spans(ups.map((a) => a.hour))}: di jam itu ${pct(Math.min(...ups.map((a) => a.conv)), 1)}% sampai ${pct(Math.max(...ups.map((a) => a.conv)), 1)}% yang mencicipi jadi beli.` : '',
      downs.length ? `Kurangi di ${spans(downs.map((a) => a.hour))}: ${pct(Math.max(...downs.map((a) => a.conv || 0)), 1)}% atau kurang yang jadi beli.` : '',
      adv.every((a) => a.k === 'kurang_data') ? 'Belum ada cukup data sampel untuk hari ini. Kuota tetap seperti sekarang.' : '',
      adv.some((a) => a.k === 'baru_diubah') ? 'Kuota hari ini baru diubah, jadi saran berikutnya menunggu data seminggu.' : ''].filter(Boolean).join(' ');
    const k = d.kpi;

    body.innerHTML = `
      <div class="grid-2">
        <section class="panel stack"><span class="small muted">Hari ini, ${esc(DN[d.today_dow - 1])} ${esc(day(d.today + 'T12:00:00+07:00'))}</span><h2>Kuota sampel</h2>
          <div class="row-between"><span class="sp-big num">${gTot} dari ${qTot} pcs</span><span class="small muted">sampel diberikan</span></div>
          <div class="sp-meter" role="img" aria-label="${gTot} dari ${qTot} sampel diberikan"><i style="width:${Math.min(100, pct(gTot, qTot))}%"></i></div>
          ${hgrid(hours, todayRows)}
          <p class="muted small">Kuota per jam juga muncul di kasir (Mode penjualan › Catat sampel). Jadi beli jam ini masih dihitung sampai 1 jam setelah sampel terakhir.</p></section>
        <section class="panel stack"><span class="small muted">Untuk besok, ${esc(DN[d.tomorrow_dow - 1])} ${esc(day(d.tomorrow + 'T12:00:00+07:00'))}</span><h2>Kuota disarankan: ${q1} pcs</h2>
          <p>${chip(q1 > q0 ? 'naik' : q1 < q0 ? 'turun' : 'tetap', `: ${q0} → ${q1} pcs`)}</p>
          ${hgrid(hours, tmrRows)}
          ${why ? `<p class="small">${esc(why)}</p>` : ''}
          ${d.can_set ? `<div class="row">${st.editing
            ? `<button class="btn btn-primary" type="button" data-save>Simpan kuota ${esc(DN[d.tomorrow_dow - 1])}</button><button class="btn btn-quiet" type="button" data-cancel>Batal</button>`
            : `<button class="btn btn-primary" type="button" data-use>Pakai ${q1} pcs</button><button class="btn btn-quiet" type="button" data-edit>Ubah sendiri</button>`}</div>
            <p class="muted small">Disimpan untuk setiap hari ${esc(DN[d.tomorrow_dow - 1])} sampai diubah lagi.</p>` : '<p class="muted small">Hanya pemilik yang bisa mengubah kuota.</p>'}
          <p class="notice" data-sp-msg role="status" hidden></p></section></div>
      <section class="panel stack"><div class="row-between"><h2>Jadi beli per jam, 7 hari</h2><span class="small muted">8 minggu terakhir</span></div>
        ${chartHtml(d)}${heatHtml(d)}</section>
      <div class="panel">${rangeHtml({ preset: st.preset, from, to, keys: ['7', '30', 'bulan', 'bulan-lalu', 'tahun', 'custom'] })}</div>
      <div class="stats">
        <div class="stat"><span>Sampel diberikan</span><b>${k.pcs} pcs</b><em class="muted small">${k.samples} kali, rata-rata ${Math.round(k.pcs / Math.max(1, k.days))} pcs per hari</em></div>
        <div class="stat"><span>Jadi beli</span><b>${pct(k.converted, k.samples)}%</b><em class="muted small">${k.converted} dari ${k.samples} yang mencicipi, ${k.orders} pesanan</em></div>
        <div class="stat"><span>Biaya sampel</span><b>${rupiah(k.cost)}</b><em class="muted small">harga pokok</em></div>
        <div class="stat"><span>Penjualan dari pembeli sampel</span><b>${rupiah(k.revenue)}</b><em class="muted small">laba kotor ${rupiah(k.gp)}</em></div>
        <div class="stat"><span>Biaya per pembeli</span><b>${k.converted ? rupiah(Math.round(k.cost / k.converted)) : '–'}</b><em class="muted small">biaya sampel dibagi yang jadi beli</em></div>
        <div class="stat"><span>Hasil</span><b>${k.cost ? x1(k.gp / k.cost) : '–'}</b><em class="muted small">laba kotor dibagi biaya sampel</em></div></div>
      <div class="grid-2">${panelHtml('Riwayat 7 hari', d.days.length ? `<div class="table-wrap"><table><thead><tr><th>Tanggal</th><th class="num">Sampel</th><th class="num">Mencicipi</th><th class="num">Jadi beli</th><th class="num">Konversi</th><th class="num">Biaya</th></tr></thead><tbody>
          ${d.days.map((r) => `<tr><td>${esc(day(r.day + 'T12:00:00+07:00'))}</td><td class="num">${r.pcs} pcs</td><td class="num">${r.samples}</td><td class="num">${r.converted}</td><td class="num">${pct(r.converted, r.samples)}%</td><td class="num">${rupiah(r.cost)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Belum ada sampel di 7 hari terakhir rentang ini.</p>')}
        ${panelHtml('Masuk pembukuan', accHtml(d.accounts), 'Sama seperti di Laporan keuangan › Laba rugi, untuk rentang di atas. Sampel dibukukan otomatis pada harga pokok: Dr 6-2410 Beban sampel produk, Cr 1-1500 Persediaan. Buka Laporan keuangan untuk memperbarui jurnal.')}</div>
      <div class="grid-2">${panelHtml('Per rasa sampel', flavHtml(d.flavours), 'Persentase jadi beli setelah mencicipi rasa itu.')}${panelHtml('Cara saran dihitung', rulesHtml())}</div>`;

    wireRange(body, { onChange: ({ preset, from: f, to: t }) => { Object.assign(st, { preset, from: f, to: t }); load(); } });
    wireChart(d);
    const msg = $('[data-sp-msg]', body);
    const save = async (btn, hoursQty) => {
      btn.disabled = true;
      try { await rpc('owner_sample_set_quota', { p_dow: d.tomorrow_dow, p_hours: hoursQty }); st.editing = false; await load(); }
      catch (e) { btn.disabled = false; msg.hidden = false; msg.className = 'notice notice-error'; msg.textContent = e.message; }
    };
    $('[data-use]', body)?.addEventListener('click', (e) => save(e.currentTarget, adv.map((a) => ({ hour: a.hour, qty: a.nq }))));
    $('[data-edit]', body)?.addEventListener('click', () => { st.editing = true; render(from, to); });
    $('[data-cancel]', body)?.addEventListener('click', () => { st.editing = false; render(from, to); });
    $('[data-save]', body)?.addEventListener('click', (e) => save(e.currentTarget, $$('.sp-q', body).map((i) => ({ hour: Number(i.dataset.hour), qty: Number(i.value) }))));
  }

  // One axis (% jadi beli). The chosen day in red, the 7-day average dashed, the other days grey.
  const cellOf = (d, dow, h) => d.cells.find((c) => c.dow === dow && c.hour === h);
  function chartHtml(d) {
    return `<div class="row-between"><div class="sp-days" role="group" aria-label="Hari yang disorot">${DN.map((n, i) => `<button type="button" data-day="${i}" aria-pressed="${i === st.sel}">${n}</button>`).join('')}</div>
      <div class="sp-legend"><span><i style="border-color:var(--color-accent)"></i><span data-day-name>${DN[st.sel]}</span></span><span><i style="border-color:var(--color-ink);border-top-style:dashed"></i>Rata-rata 7 hari</span><span><i style="border-color:var(--color-line)"></i>Hari lain</span></div></div>
      <div class="sp-lc"><div class="sp-yax">${[50, 40, 30, 20, 10, 0].map((v) => `<span style="top:${100 - v * 2}%">${v}%</span>`).join('')}</div>
        <div class="sp-plot" data-plot><svg viewBox="0 0 ${d.hours.length * 100} 240" preserveAspectRatio="none" role="img" aria-label="Persentase jadi beli per jam untuk 7 hari"></svg><div class="sp-tip" hidden></div></div>
        <div class="sp-xax" style="--n:${d.hours.length}">${d.hours.map((h) => `<span>${String(h).padStart(2, '0')}</span>`).join('')}</div></div>
      <p class="muted small">Garis = berapa persen yang jadi beli dalam 1 jam setelah mencicipi, per jam sampel diberikan. Jam dengan kurang dari ${FEW} sampel tidak digambar. Arahkan ke grafik untuk melihat angka semua hari di jam itu.</p>`;
  }
  function heatHtml(d) {
    const max = 0.45;
    return `<div class="row-between"><h3>Peta jam dan hari</h3><div class="sp-scale"><span>0%</span><i></i><span>45%+</span><span class="sp-few-key">kurang dari ${FEW} sampel</span></div></div>
      <div class="table-wrap"><div class="sp-hm" style="--n:${d.hours.length}"><span></span>${d.hours.map((h) => `<span>${String(h).padStart(2, '0')}</span>`).join('')}
      ${DN.map((_, i) => `<span class="sp-d">${DS[i]}</span>` + d.hours.map((h) => { const c = cellOf(d, i + 1, h), few = c.samples < FEW, v = c.samples ? c.converted / c.samples : 0;
        return `<span class="sp-c${few ? ' is-few' : ''}${!few && v / max > 0.55 ? ' is-hot' : ''}${i === st.sel ? ' is-sel' : ''}" style="--v:${Math.min(1, v / max).toFixed(2)}" title="${DN[i]} ${HH(h)}: ${c.samples} kali mencicipi (${c.pcs} pcs), ${c.converted} jadi beli">${few ? '–' : pct(c.converted, c.samples)}</span>`; }).join('')).join('')}</div></div>
      <p class="muted small">Angka = % jadi beli, 8 minggu terakhir. Baris hari yang disorot diberi garis tepi.</p>`;
  }
  function wireChart(d) {
    const plot = $('[data-plot]', body), svg = $('svg', plot), tip = $('.sp-tip', plot), n = d.hours.length;
    const conv = (c) => (c.samples ? c.converted / c.samples : 0);
    const row = (i) => d.hours.map((h) => cellOf(d, i + 1, h));
    const avg = d.hours.map((h) => { const cs = DN.map((_, i) => cellOf(d, i + 1, h)), s = cs.reduce((t, c) => t + c.samples, 0); return { samples: s, converted: cs.reduce((t, c) => t + c.converted, 0) }; });
    const X = (i) => (i + 0.5) * 100, Y = (v) => 240 - (Math.min(0.5, v) / 0.5) * 240;
    const path = (cells) => { let pen = false; return cells.map((c, i) => { if (c.samples < FEW) { pen = false; return ''; } const s = `${pen ? 'L' : 'M'}${X(i)},${Y(conv(c))}`; pen = true; return s; }).join(''); };
    const draw = (hover = -1) => {
      svg.innerHTML = DN.map((_, i) => (i === st.sel ? '' : `<path d="${path(row(i))}" fill="none" stroke="var(--color-line)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`)).join('')
        + `<path d="${path(avg)}" fill="none" stroke="var(--color-ink)" stroke-width="2" stroke-dasharray="6 4" vector-effect="non-scaling-stroke"/>`
        + `<path d="${path(row(st.sel))}" fill="none" stroke="var(--color-accent)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`
        + (hover >= 0 ? `<line x1="${X(hover)}" x2="${X(hover)}" y1="0" y2="240" stroke="var(--color-muted)" stroke-width="1" vector-effect="non-scaling-stroke"/>` : '');
      $$('.sp-mk', plot).forEach((m) => m.remove());
      row(st.sel).forEach((c, i) => { if (c.samples < FEW) return; const m = document.createElement('i'); m.className = 'sp-mk';
        m.style.left = ((i + 0.5) / n) * 100 + '%'; m.style.top = (Y(conv(c)) / 240) * 100 + '%'; plot.appendChild(m); });
      $('[data-day-name]', body).textContent = DN[st.sel];
      $$('.sp-hm .sp-c', body).forEach((c, i) => c.classList.toggle('is-sel', Math.floor(i / n) === st.sel));
    };
    draw();
    $$('[data-day]', body).forEach((b) => b.addEventListener('click', () => { st.sel = Number(b.dataset.day);
      $$('[data-day]', body).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(); }));
    plot.addEventListener('pointermove', (e) => {
      const r = plot.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))), h = d.hours[i];
      draw(i); tip.hidden = false;
      tip.innerHTML = `<strong>${HH(h)}–${HH(h + 1)}</strong>` + DN.map((_, j) => { const c = cellOf(d, j + 1, h);
        return `<div${j === st.sel ? ' class="is-on"' : ''}><span>${DS[j]}</span><span>${c.samples < FEW ? '–' : pct(c.converted, c.samples) + '%'} · ${c.samples} kali</span></div>`; }).join('')
        + `<div><span>Rata-rata</span><span>${pct(avg[i].converted, avg[i].samples)}%</span></div>`;
      const left = ((i + 0.5) / n) * r.width; tip.style.left = (left > r.width - 210 ? left - 200 : left + 12) + 'px';
    });
    plot.addEventListener('pointerleave', () => { tip.hidden = true; draw(); });
  }

  load();
}

function accHtml(list) {
  if (!list || !list.length) return '<p class="muted">Akun Beban pemasaran belum ada. Jalankan akunting.sql.</p>';
  const parent = list.find((a) => !a.parent), subs = list.filter((a) => a.parent), total = list.reduce((t, a) => t + Number(a.amount), 0);
  return `<div class="sp-acc"><span>${esc(parent?.code || '6-2400')} ${esc(parent?.name || 'Beban pemasaran')}</span><span></span>
    <span class="is-sub">${esc(parent?.code || '6-2400')} ${esc(parent?.name || 'Beban pemasaran')} (lainnya)</span><span class="num">${rupiah(parent?.amount || 0)}</span>
    ${subs.map((a) => `<span class="is-sub">${esc(a.code)} ${esc(a.name)}</span><span class="num">${rupiah(a.amount)}</span>`).join('')}
    <span class="is-sub is-tot">Jumlah ${esc((parent?.name || 'Beban pemasaran').toLowerCase())}</span><span class="num is-tot">${rupiah(total)}</span></div>`;
}

function flavHtml(list) {
  if (!list.length) return '<p class="muted">Belum ada sampel di rentang ini.</p>';
  const max = Math.max(...list.map((f) => (f.samples ? f.converted / f.samples : 0)), 0.01);
  return `<div class="bars">${list.map((f) => { const v = f.samples ? f.converted / f.samples : 0;
    return `<div class="bar-row"><span>${esc(f.label || 'Tanpa rasa')}</span><span class="track"><i style="transform:scaleX(${(v / max).toFixed(3)})"></i></span><span class="v">${pct(f.converted, f.samples)}% · ${f.pcs} pcs</span></div>`; }).join('')}</div>`;
}
