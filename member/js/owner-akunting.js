// Owner page, Akunting (12 Nov 2026): Akun buku besar, Buat jurnal and Laporan akunting.
// mountAkunting(panel, { rpc, part }) with part 'akun' | 'jurnal' | 'laporan'. Database: supabase/akunting.sql.
// The automatic journals are built by acc_sync from the POS tables; this page runs it quietly when a view opens
// and has a button to run it again.
import { $, $$, esc, notice, busy, toast } from './lib.js';
import { dataTable, formDialog, confirmDialog, infoDialog, loadSheetJS } from './data-table.js';
import { accExtraView } from './owner-laporan2.js';
import { rangeHtml, wireRange as wireShared, presetRange as sharedRange } from './owner-range.js';

const TZ = 'Asia/Jakarta';
const ymdToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const dmy = (s) => String(s || '').slice(0, 10).split('-').reverse().join('/');
// Money with a minus sign for negatives (rupiah() in lib.js has no sign handling).
export const money = (n) => (Number(n) < 0 ? '-' : '') + 'Rp' + Math.abs(Number(n) || 0).toLocaleString('id-ID');
const TYPES = { aset: 'Aset', kewajiban: 'Kewajiban', ekuitas: 'Ekuitas', pendapatan: 'Pendapatan', beban: 'Beban' };
const SOURCES = { manual: 'Manual', penjualan: 'Penjualan', batal: 'Batal / refund', pembelian: 'Pembelian', kas: 'Kas', stok: 'Stok', komisi: 'Komisi' };
const ACC_KEYS = ['hari', 'kemarin', '7', '30', 'bulan', 'bulan-lalu', 'tahun', 'semua', 'custom'];
const presetRange = (k) => sharedRange(k, null);
// The shared range control (js/owner-range.js) with the year and "Semua" for the books.
const rangeBar = (st) => rangeHtml({ from: st.from, to: st.to, keys: ACC_KEYS });
function wireRange(panel, st, reload) {
  wireShared(panel, { onChange: ({ from, to }) => { st.from = from; st.to = to; reload(); } });
}

// Opening a view only refreshes the last 60 days (fast); the "Perbarui jurnal" button still syncs everything.
async function syncQuiet(rpc) {
  const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date(Date.now() - 60 * 864e5));
  try { return await rpc('acc_sync', { p_from: from, p_to: null }); } catch { return null; }
}

/* ---------------------------------------------------------------- Akun buku besar */
function accountsView(panel, rpc) {
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Akun buku besar</h1>
    <p class="muted small">Daftar akun untuk pembukuan. Akun sistem dipakai jurnal otomatis: namanya boleh diganti, tapi tidak bisa dimatikan. Akun yang sudah dipakai jurnal tidak bisa dihapus, hanya dimatikan.</p></div>
    <div class="notice" data-msg role="status" hidden></div><div data-table></div></div>`;
  const msg = $('[data-msg]', panel);
  let rows = [], table;
  const load = async () => { rows = await rpc('acc_accounts'); return rows; };
  const form = (a) => {
    const used = a && a.used > 0, locked = a && (a.system || used);
    return `<div class="dt-fields">
      <label class="field"><span>Kode</span><input name="code" value="${esc(a?.code || '')}" maxlength="6" placeholder="6-2500" ${a && locked ? 'readonly' : ''} required><span class="hint">Satu angka, minus, empat angka. Angka pertama: 1 aset, 2 kewajiban, 3 ekuitas, 4 pendapatan, 5 HPP, 6 beban.</span></label>
      <label class="field"><span>Nama akun</span><input name="name" value="${esc(a?.name || '')}" maxlength="80" required></label>
      <label class="field"><span>Jenis</span><select name="type" ${a && locked ? 'disabled' : ''}>${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${a?.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="field"><span>Sisi normal</span><select name="normal" ${a && locked ? 'disabled' : ''}><option value="debit" ${a?.normal === 'debit' ? 'selected' : ''}>Debit</option><option value="kredit" ${a?.normal === 'kredit' ? 'selected' : ''}>Kredit</option></select></label>
      ${a ? `<label class="field"><span>Status</span><select name="active" ${a.system ? 'disabled' : ''}><option value="true" ${a.active ? 'selected' : ''}>Aktif</option><option value="false" ${a.active ? '' : 'selected'}>Dimatikan</option></select></label>` : ''}
    </div>`;
  };
  const read = (f, a) => {
    const v = (n) => f.querySelector(`[name="${n}"]`)?.value;
    const p = { code: v('code'), name: v('name') };
    if (!a) { p.type = v('type'); p.normal = v('normal'); } else if (!f.querySelector('[name="type"]').disabled) { p.type = v('type'); p.normal = v('normal'); }
    if (a && v('active') != null && !f.querySelector('[name="active"]').disabled) p.active = v('active') === 'true';
    return p;
  };
  const open = async (a) => {
    const del = a && !a.system && a.used === 0 ? [{ label: 'Hapus akun', danger: true, onClick: async () => {
      if (!(await confirmDialog({ title: 'Hapus akun?', text: `${a.code} ${a.name} belum dipakai jurnal, jadi boleh dihapus.`, confirmLabel: 'Hapus', danger: true }))) return false;
      await rpc('acc_delete_account', { p_id: a.id }); toast('Akun dihapus');
    } }] : [];
    const saved = await formDialog({
      title: a ? `Ubah akun ${a.code}` : 'Tambah akun', html: form(a), submitLabel: 'Simpan', buttons: del,
      onSubmit: async (f) => { await rpc('acc_save_account', { p_id: a ? a.id : null, p: read(f, a) }); toast(a ? 'Akun disimpan' : 'Akun ditambahkan'); },
    });
    if (saved !== undefined) { try { table.setRows(await load()); } catch (e) { notice(msg, e.message); } }
  };
  load().then((r) => {
    table = dataTable($('[data-table]', panel), {
      rows: r, rowKey: 'id', exportName: 'akun-buku-besar', pageSize: 30, searchKeys: ['code', 'name'], emptyText: 'Belum ada akun.',
      defaultSort: { key: 'code', dir: 'asc' }, onAdd: () => open(null), onEdit: (a) => open(a),
      columns: [
        { key: 'code', label: 'Kode', sort: true },
        { key: 'name', label: 'Nama akun', sort: true, html: true, format: (v, a) => esc(v) + (a.system ? ' <span class="muted small">(sistem)</span>' : ''), export: (a) => a.name },
        { key: 'type', label: 'Jenis', sort: true, format: (v) => TYPES[v] || v },
        { key: 'normal', label: 'Sisi normal', format: (v) => (v === 'debit' ? 'Debit' : 'Kredit') },
        { key: 'balance', label: 'Saldo', sort: true, align: 'num', format: (v) => money(v), export: (a) => a.balance },
        { key: 'active', label: 'Status', sort: true, format: (v) => (v ? 'Aktif' : 'Dimatikan'), export: (a) => (a.active ? 'Aktif' : 'Dimatikan') },
      ],
    });
  }).catch((e) => notice(msg, e.message));
}

/* ---------------------------------------------------------------- Buat jurnal */
function journalView(panel, rpc) {
  const st = { from: presetRange('bulan')[0], to: ymdToday(), source: '' };
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Buat jurnal</h1>
    <p class="muted small">Jurnal manual untuk hal yang tidak masuk otomatis: saldo awal, sewa, gaji, bayar pemasok, pindah QRIS ke bank. Jurnal otomatis dari penjualan, pembelian, kas, stok dan komisi ikut tampil di sini. Jurnal tidak dihapus: Batalkan membuat jurnal pembalik.</p></div>
    ${rangeBar(st)}
    <div class="dt-range"><label class="field"><span>Sumber</span><select data-source><option value="">Semua</option>${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
      <button class="btn btn-quiet" type="button" data-sync>Perbarui jurnal otomatis</button></div>
    <div class="notice" data-msg role="status" hidden></div><div data-table></div></div>`;
  const msg = $('[data-msg]', panel);
  let table, accounts = [];
  const fetchRows = async () => rpc('acc_journals', { p_from: st.from, p_to: st.to, p_source: st.source || null, p_q: null });
  const statusOf = (j) => (j.reversed_by ? 'Dibatalkan' : j.reverses ? 'Pembalik' : 'Aktif');
  const reload = async () => { notice(msg, ''); try { table.setRows(await fetchRows()); } catch (e) { notice(msg, e.message); } };

  const detail = async (j) => {
    const dTot = j.lines.reduce((t, l) => t + Number(l.debit), 0);
    const body = `<p><b>${esc(j.no)}</b> &middot; ${esc(dmy(j.day))} &middot; ${esc(SOURCES[j.source] || j.source)} &middot; ${esc(statusOf(j))}</p><p>${esc(j.description)}</p>
      <div class="table-wrap"><table><thead><tr><th>Akun</th><th class="num">Debit</th><th class="num">Kredit</th></tr></thead><tbody>
      ${j.lines.map((l) => `<tr><td>${esc(l.code)} ${esc(l.name)}${l.memo ? `<br><span class="muted small">${esc(l.memo)}</span>` : ''}</td><td class="num">${Number(l.debit) ? esc(money(l.debit)) : ''}</td><td class="num">${Number(l.credit) ? esc(money(l.credit)) : ''}</td></tr>`).join('')}
      <tr><th>Jumlah</th><th class="num">${esc(money(dTot))}</th><th class="num">${esc(money(dTot))}</th></tr></tbody></table></div>
      ${j.reason ? `<p class="muted small">Alasan: ${esc(j.reason)}</p>` : ''}${j.posted_by ? `<p class="muted small">Dicatat oleh ${esc(j.posted_by)}.</p>` : ''}`;
    const canUndo = j.source === 'manual' && !j.reversed_by && !j.reverses;
    await infoDialog({ title: 'Jurnal ' + j.no, html: body, wide: true, buttons: canUndo ? [{ label: 'Batalkan jurnal', danger: true, onClick: async () => {
      const why = await askReason(); if (!why) return false;
      await rpc('acc_reverse_journal', { p_id: j.id, p_reason: why }); toast('Jurnal dibatalkan');
    } }] : [] });
    await reload();
  };
  const askReason = () => new Promise((res) => {
    formDialog({ title: 'Batalkan jurnal', html: '<label class="field"><span>Alasan</span><input name="why" maxlength="150" required></label>',
      submitLabel: 'Batalkan jurnal', onSubmit: async (f) => { const v = f.querySelector('[name="why"]').value.trim(); if (!v) throw new Error('Tulis alasan pembatalan.'); res(v); } })
      .then((ok) => { if (!ok) res(null); });
  });

  const create = async () => {
    if (!accounts.length) accounts = (await rpc('acc_accounts')).filter((a) => a.active);
    const opts = `<option value="">Pilih akun</option>${accounts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join('')}`;
    const lineHtml = () => `<div class="dt-line" data-line style="grid-template-columns:minmax(0,2fr) minmax(5rem,1fr) minmax(5rem,1fr) auto">
      <label class="field"><span>Akun</span><select data-acc>${opts}</select></label>
      <label class="field"><span>Debit</span><input data-d inputmode="numeric" placeholder="0"></label>
      <label class="field"><span>Kredit</span><input data-k inputmode="numeric" placeholder="0"></label>
      <button class="btn btn-quiet" type="button" data-rm aria-label="Hapus baris">Hapus</button></div>`;
    const num = (v) => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
    const sums = (f) => { let d = 0, k = 0; $$('[data-line]', f).forEach((r) => { d += num($('[data-d]', r).value); k += num($('[data-k]', r).value); }); return [d, k]; };
    const total = (f) => { const [d, k] = sums(f); const t = $('[data-total]', f); t.textContent = `Debit ${money(d)}, kredit ${money(k)}${d === k && d ? ', seimbang' : d || k ? `, selisih ${money(Math.abs(d - k))}` : ''}`; };
    const saved = await formDialog({
      title: 'Buat jurnal', wide: true, submitLabel: 'Catat jurnal',
      html: `<div class="dt-fields"><label class="field"><span>Tanggal</span><input type="date" name="day" value="${ymdToday()}" max="${ymdToday()}" required></label>
        <label class="field"><span>Keterangan</span><input name="desc" maxlength="200" placeholder="Contoh: Bayar sewa November" required></label></div>
        <div class="dt-lines" data-lines>${lineHtml()}${lineHtml()}</div>
        <div class="row"><button class="btn btn-quiet" type="button" data-add>Tambah baris</button></div>
        <p class="small" data-total role="status"></p>`,
      onOpen: (f) => {
        const wire = () => {
          $$('[data-d],[data-k]', f).forEach((i) => { i.oninput = () => { const r = i.closest('[data-line]'); if (i.hasAttribute('data-d') && i.value) $('[data-k]', r).value = ''; if (i.hasAttribute('data-k') && i.value) $('[data-d]', r).value = ''; total(f); }; });
          $$('[data-rm]', f).forEach((b) => { b.onclick = () => { if ($$('[data-line]', f).length > 2) { b.closest('[data-line]').remove(); total(f); } }; });
        };
        $('[data-add]', f).onclick = () => { $('[data-lines]', f).insertAdjacentHTML('beforeend', lineHtml()); wire(); };
        wire(); total(f);
      },
      onSubmit: async (f) => {
        const lines = $$('[data-line]', f).map((r) => ({ account_id: Number($('[data-acc]', r).value) || null, debit: num($('[data-d]', r).value), credit: num($('[data-k]', r).value) }))
          .filter((l) => l.debit || l.credit || l.account_id);
        if (lines.some((l) => !l.account_id)) throw new Error('Pilih akun di setiap baris yang berisi angka.');
        const r = await rpc('acc_post_manual', { p_day: f.querySelector('[name="day"]').value, p_desc: f.querySelector('[name="desc"]').value, p_lines: lines });
        toast('Jurnal ' + r.no + ' dicatat');
      },
    });
    if (saved) await reload();
  };

  wireRange(panel, st, reload);
  $('[data-source]', panel).addEventListener('change', (e) => { st.source = e.target.value; reload(); });
  $('[data-sync]', panel).addEventListener('click', async (e) => {
    const btn = e.currentTarget; // currentTarget is null after the first await
    busy(btn, true, 'Memperbarui…');
    try { const r = await rpc('acc_sync', { p_from: null, p_to: null }); toast(r.changed ? `${r.changed} jurnal diperbarui` : 'Jurnal sudah terbaru'); await reload(); }
    catch (err) { notice(msg, err.message); }
    busy(btn, false);
  });
  (async () => {
    await syncQuiet(rpc);
    let rows = []; try { rows = await fetchRows(); } catch (e) { notice(msg, e.message); }
    table = dataTable($('[data-table]', panel), {
      rows, rowKey: 'id', exportName: 'jurnal', pageSize: 20, searchKeys: ['no', 'description'], emptyText: 'Belum ada jurnal di rentang ini.', editLabel: 'Buka',
      defaultSort: { key: 'day', dir: 'desc' }, onAdd: create, onEdit: detail,
      columns: [
        { key: 'no', label: 'No', sort: true },
        { key: 'day', label: 'Tanggal', sort: true, format: (v) => dmy(v), export: (j) => j.day },
        { key: 'description', label: 'Keterangan', sort: true },
        { key: 'source', label: 'Sumber', sort: true, format: (v) => SOURCES[v] || v },
        { key: 'amount', label: 'Jumlah', sort: true, align: 'num', format: (v) => money(v), export: (j) => j.amount },
        { key: 'reversed_by', label: 'Status', sort: (j) => statusOf(j), format: (v, j) => statusOf(j), export: (j) => statusOf(j) },
      ],
    });
  })();
}

/* ---------------------------------------------------------------- Laporan akunting */
const TABS = [['buku', 'Buku besar'], ['saldo', 'Neraca saldo'], ['laba', 'Laba rugi'], ['neraca', 'Neraca'], ['bulanan', 'Neraca bulanan'], ['jurnal', 'Laporan jurnal']];
const tbl = (head, rows, foot = '') => `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th${h.num ? ' class="num"' : ''}>${esc(h.t)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}${foot}</tbody></table></div>`;
const trow = (cells, bold) => `<tr>${cells.map((c) => { const t = bold ? 'th' : 'td'; return `<${t}${c.num ? ' class="num"' : ''}>${c.h ? c.t : esc(c.t)}</${t}>`; }).join('')}</tr>`;

function reportView(panel, rpc) {
  const st = { tab: 'buku', from: presetRange('bulan')[0], to: ymdToday(), account: null, data: null, accounts: [] };
  panel.innerHTML = `<div class="panel stack"><div class="dt-head"><h1>Laporan akunting</h1>
    <p class="muted small">Dihitung dari jurnal. Jurnal otomatis diperbarui saat halaman ini dibuka. Belum ada penutupan tahun: laba rugi berjalan ikut masuk ke Neraca.</p>
    <p class="muted small">Penjualan dibukukan di tanggal transaksi. Batal dan refund dibukukan di tanggal disetujui, sama seperti di laporan penjualan.</p></div>
    <div class="dt-tabs" role="group" aria-label="Jenis laporan">${TABS.map(([k, l]) => `<button class="btn btn-quiet" type="button" data-tab="${k}" aria-pressed="${k === st.tab}">${l}</button>`).join('')}</div>
    ${rangeBar(st)}
    <div class="dt-range" data-acc-row><label class="field"><span>Akun</span><select data-account></select></label></div>
    <div class="row"><button class="btn" type="button" data-xlsx>Unduh .xlsx</button></div>
    <div class="notice" data-msg role="status" hidden></div></div>
    <div class="panel stack" data-body aria-live="off"></div>`;
  const msg = $('[data-msg]', panel), body = $('[data-body]', panel);

  const render = () => {
    const d = st.data; if (!d) return;
    const dr = `${dmy(st.from)} sampai ${dmy(st.to)}`;
    if (st.tab === 'buku') {
      body.innerHTML = `<h2>${esc(d.account.code)} ${esc(d.account.name)}</h2><p class="muted small">${esc(dr)}. Saldo dihitung di sisi ${d.account.normal === 'debit' ? 'debit' : 'kredit'}.</p>
        ${tbl([{ t: 'Tanggal' }, { t: 'No' }, { t: 'Keterangan' }, { t: 'Debit', num: 1 }, { t: 'Kredit', num: 1 }, { t: 'Saldo', num: 1 }],
          [trow([{ t: '' }, { t: '' }, { t: 'Saldo awal' }, { t: '' }, { t: '' }, { t: money(d.opening), num: 1 }]),
           ...d.rows.map((r) => trow([{ t: dmy(r.day) }, { t: r.no }, { t: r.description + (r.memo ? ' (' + r.memo + ')' : '') }, { t: Number(r.debit) ? money(r.debit) : '', num: 1 }, { t: Number(r.credit) ? money(r.credit) : '', num: 1 }, { t: money(r.balance), num: 1 }]))],
          trow([{ t: '' }, { t: '' }, { t: 'Jumlah dan saldo akhir' }, { t: money(d.debit_total), num: 1 }, { t: money(d.credit_total), num: 1 }, { t: money(d.closing), num: 1 }], true))}
        ${d.rows.length ? '' : '<p class="muted">Tidak ada transaksi di rentang ini.</p>'}`;
    } else if (st.tab === 'saldo') {
      body.innerHTML = `<h2>Neraca saldo</h2><p class="muted small">${esc(dr)}. Saldo awal sebelum ${esc(dmy(st.from))}.</p>
        ${d.rows.length ? tbl([{ t: 'Akun' }, { t: 'Saldo awal', num: 1 }, { t: 'Mutasi debit', num: 1 }, { t: 'Mutasi kredit', num: 1 }, { t: 'Saldo debit', num: 1 }, { t: 'Saldo kredit', num: 1 }],
          d.rows.map((r) => trow([{ t: r.code + ' ' + r.name }, { t: money(r.opening), num: 1 }, { t: money(r.debit), num: 1 }, { t: money(r.credit), num: 1 }, { t: Number(r.closing_debit) ? money(r.closing_debit) : '', num: 1 }, { t: Number(r.closing_credit) ? money(r.closing_credit) : '', num: 1 }])),
          trow([{ t: 'Jumlah' }, { t: '' }, { t: money(d.total_debit), num: 1 }, { t: money(d.total_credit), num: 1 }, { t: money(d.closing_debit), num: 1 }, { t: money(d.closing_credit), num: 1 }], true)) : '<p class="muted">Belum ada jurnal.</p>'}
        <p class="${d.balanced ? 'muted small' : 'notice notice-error'}">${d.balanced ? 'Seimbang: total debit sama dengan total kredit.' : 'Tidak seimbang. Hubungi pengembang.'}</p>`;
    } else if (st.tab === 'laba') {
      const sec = (title, list) => list.length ? [trow([{ t: title, h: false }], true), ...list.map((r) => trow([{ t: r.code + ' ' + r.name }, { t: money(r.amount), num: 1 }]))] : [];
      body.innerHTML = `<h2>Laba rugi</h2><p class="muted small">${esc(dr)}.</p>
        ${d.pendapatan.length || d.hpp.length || d.beban.length ? tbl([{ t: 'Keterangan' }, { t: 'Jumlah', num: 1 }], [
          ...sec('Pendapatan', d.pendapatan), trow([{ t: 'Pendapatan bersih' }, { t: money(d.revenue), num: 1 }], true),
          ...sec('Harga pokok penjualan', d.hpp), trow([{ t: 'Laba kotor' }, { t: money(d.gross_profit), num: 1 }], true),
          ...sec('Beban', d.beban), trow([{ t: 'Laba (rugi) bersih' }, { t: money(d.net_profit), num: 1 }], true)]) : '<p class="muted">Belum ada pendapatan atau beban di rentang ini.</p>'}`;
    } else {
      const sec = (title, list, total) => [trow([{ t: title }, { t: '' }], true), ...list.map((r) => trow([{ t: r.code + ' ' + r.name }, { t: money(r.amount), num: 1 }])), trow([{ t: 'Jumlah ' + title.toLowerCase() }, { t: money(total), num: 1 }], true)];
      body.innerHTML = `<h2>Neraca per ${esc(dmy(st.to))}</h2>
        ${tbl([{ t: 'Keterangan' }, { t: 'Jumlah', num: 1 }], [
          ...sec('Aset', d.aset, d.total_aset), ...sec('Kewajiban', d.kewajiban, d.total_kewajiban),
          trow([{ t: 'Ekuitas' }, { t: '' }], true), ...d.ekuitas.map((r) => trow([{ t: r.code + ' ' + r.name }, { t: money(r.amount), num: 1 }])),
          trow([{ t: 'Laba (rugi) berjalan' }, { t: money(d.profit), num: 1 }]), trow([{ t: 'Jumlah ekuitas' }, { t: money(d.total_ekuitas), num: 1 }], true),
          trow([{ t: 'Kewajiban + ekuitas' }, { t: money(d.total_kewajiban + d.total_ekuitas), num: 1 }], true)])}
        <p class="${d.balanced ? 'muted small' : 'notice notice-error'}">${d.balanced ? 'Seimbang: aset sama dengan kewajiban ditambah ekuitas.' : 'Tidak seimbang. Hubungi pengembang.'}</p>`;
    }
  };

  const load = async () => {
    notice(msg, '');
    $('[data-acc-row]', panel).hidden = st.tab !== 'buku';
    $('[data-from]', panel).closest('label').hidden = st.tab === 'neraca';
    // Neraca bulanan and Laporan jurnal (13 Nov 2026) have their own filters and Ekspor: js/owner-laporan2.js.
    $('[data-xlsx]', panel).hidden = st.tab === 'bulanan' || st.tab === 'jurnal';
    if (st.tab === 'bulanan' || st.tab === 'jurnal') { st.data = null; return accExtraView(body, { rpc, tab: st.tab, from: st.from, to: st.to, accounts: st.accounts }); }
    try {
      if (st.tab === 'buku') {
        if (!st.account) { body.innerHTML = '<p class="muted">Pilih akun.</p>'; return; }
        st.data = await rpc('acc_ledger', { p_account: Number(st.account), p_from: st.from, p_to: st.to });
      } else if (st.tab === 'saldo') st.data = await rpc('acc_trial', { p_from: st.from, p_to: st.to });
      else if (st.tab === 'laba') st.data = await rpc('acc_pnl', { p_from: st.from, p_to: st.to });
      else st.data = await rpc('acc_balance_sheet', { p_at: st.to });
      render();
    } catch (e) { notice(msg, e.message); }
  };

  const rowsFor = () => {
    const d = st.data, a = [];
    if (st.tab === 'buku') { a.push(['Tanggal', 'No', 'Keterangan', 'Debit', 'Kredit', 'Saldo'], ['', '', 'Saldo awal', '', '', d.opening]);
      d.rows.forEach((r) => a.push([r.day, r.no, r.description, r.debit, r.credit, r.balance])); a.push(['', '', 'Saldo akhir', d.debit_total, d.credit_total, d.closing]);
    } else if (st.tab === 'saldo') { a.push(['Kode', 'Akun', 'Saldo awal', 'Mutasi debit', 'Mutasi kredit', 'Saldo debit', 'Saldo kredit']);
      d.rows.forEach((r) => a.push([r.code, r.name, r.opening, r.debit, r.credit, r.closing_debit, r.closing_credit])); a.push(['', 'Jumlah', '', d.total_debit, d.total_credit, d.closing_debit, d.closing_credit]);
    } else if (st.tab === 'laba') { a.push(['Kode', 'Keterangan', 'Jumlah']);
      d.pendapatan.forEach((r) => a.push([r.code, r.name, r.amount])); a.push(['', 'Pendapatan bersih', d.revenue]);
      d.hpp.forEach((r) => a.push([r.code, r.name, r.amount])); a.push(['', 'Laba kotor', d.gross_profit]);
      d.beban.forEach((r) => a.push([r.code, r.name, r.amount])); a.push(['', 'Laba (rugi) bersih', d.net_profit]);
    } else { a.push(['Kode', 'Keterangan', 'Jumlah']);
      d.aset.forEach((r) => a.push([r.code, r.name, r.amount])); a.push(['', 'Jumlah aset', d.total_aset]);
      d.kewajiban.forEach((r) => a.push([r.code, r.name, r.amount])); a.push(['', 'Jumlah kewajiban', d.total_kewajiban]);
      d.ekuitas.forEach((r) => a.push([r.code, r.name, r.amount])); a.push(['', 'Laba (rugi) berjalan', d.profit], ['', 'Jumlah ekuitas', d.total_ekuitas]); }
    return a;
  };

  $$('[data-tab]', panel).forEach((b) => b.addEventListener('click', () => {
    st.tab = b.dataset.tab; $$('[data-tab]', panel).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); load();
  }));
  wireRange(panel, st, load);
  $('[data-account]', panel).addEventListener('change', (e) => { st.account = e.target.value; load(); });
  $('[data-xlsx]', panel).addEventListener('click', async (e) => {
    if (!st.data) { notice(msg, 'Tampilkan laporan dulu.'); return; }
    const btn = e.currentTarget; // currentTarget is null after the first await
    busy(btn, true, 'Menyiapkan…');
    try {
      await loadSheetJS();
      const X = window.XLSX, wb = X.utils.book_new();
      X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(rowsFor()), TABS.find(([k]) => k === st.tab)[1]);
      X.writeFile(wb, `hanashuya-akunting-${st.tab}-${st.to}.xlsx`);
      notice(msg, 'File Excel tersimpan.', 'ok');
    } catch (err) { notice(msg, err.message); }
    busy(btn, false);
  });

  (async () => {
    await syncQuiet(rpc);
    try {
      st.accounts = await rpc('acc_accounts');
      const sel = $('[data-account]', panel);
      sel.innerHTML = st.accounts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join('');
      st.account = (st.accounts.find((a) => a.code === '1-1100') || st.accounts[0])?.id; sel.value = st.account;
    } catch (e) { notice(msg, e.message); }
    load();
  })();
}

export function mountAkunting(panel, { rpc, part = 'akun' }) {
  panel.className = 'stack-lg';
  if (part === 'jurnal') return journalView(panel, rpc);
  if (part === 'laporan') return reportView(panel, rpc);
  return accountsView(panel, rpc);
}
