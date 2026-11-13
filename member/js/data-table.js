// A reusable data table for the owner's back office (12 Nov 2026), modelled on the VireoPOS
// list page: "+ Tambah" top left; Ekspor and Hapus top right; a search bar with a column
// picker; a table with a checkbox column, sortable headers and pagination. Also three small
// dialog helpers (confirmDialog, formDialog, infoDialog) the screens share.
//
//   const t = dataTable(el, {
//     columns: [{ key, label, sort, format, html, align, export }],
//        key     field of the row
//        sort    true (compare the field) or a function(row) returning the sort value
//        format  function(value, row) returning text; with html: true it returns trusted HTML,
//                so the function must escape every value itself (use esc from lib.js)
//        align   'num' for right-aligned figures
//        export  function(row) returning the cell for Ekspor (default: the raw field)
//     rows, rowKey,                       rowKey: field (or function) that is unique per row
//     onAdd(), onEdit(row), editLabel,    onEdit also runs when the row is clicked
//     onDelete(rows),                     only when given: checkboxes and the Hapus button
//     onImport(),                         only when given: an Impor button left of Ekspor
//     onAction(name, row, el),            elements with data-act inside a cell (switches, buttons)
//     searchKeys, pageSize = 20, exportName, emptyText, extraActions, rowName(row), deleteHelp,
//     selectable,                         true = checkboxes without Hapus (for extraActions)
//     extraActions: [{ label, onClick(selectedRows), needsSelection, primary }],
//     reload: async () => rows,           called after Hapus or onAction so the table refreshes
//     defaultSort: { key, dir } })
//     foot(rows),                         optional Jumlah row: an array with one cell per column, each null or
//                                         [text, exportValue], from the rows that match the search (13 Nov 2026)
//     emptyHint                           what to do next when the list is empty (default: + Tambah, or the dates)
//   returns { setRows(rows), selected(), refresh() }
//
// Saving with a warning (13 Nov 2026): in a formDialog onSubmit, `if (warnFirst(form, text)) return false;`
// shows the warning in the dialog and turns Simpan into "Tetap simpan"; the next press saves. Editing a
// field takes the warning back. One question, no second "berhasil" pop-up (success is a toast).
import { esc } from './lib.js';

const plain = (v) => (v == null ? '' : String(v));
const strip = (html) => String(html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// Same loader as owner.js (SheetJS from jsDelivr, allowed by the CSP).
export function loadSheetJS() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = res; s.onerror = () => rej(new Error('Pembuat file Excel gagal dimuat. Periksa internet lalu coba lagi.'));
    document.head.append(s);
  });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csvCell = (v) => { const s = plain(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

/* ------------------------------------------------------------------ dialogs */
let dlgSeq = 0;
function makeDialog(title, wide) {
  const dlg = document.createElement('dialog');
  const id = `dt-dlg-${++dlgSeq}`;
  dlg.className = 'tl-dlg dt-dlg' + (wide ? ' dt-dlg-wide' : '');
  dlg.setAttribute('aria-labelledby', id);
  dlg.innerHTML = `<div class="stack"><h2 id="${id}">${esc(title)}</h2><div data-body class="stack"></div></div>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  return dlg;
}
const errBox = (dlg) => dlg.querySelector('[data-err]');
function showErr(dlg, msg) { const b = errBox(dlg); if (!b) return; b.textContent = msg || ''; b.hidden = !msg; }

// Yes / no question. Resolves true when confirmed.
export function confirmDialog({ title, text, confirmLabel = 'Ya', cancelLabel = 'Batal', danger = false, html = '' }) {
  return new Promise((resolve) => {
    const dlg = makeDialog(title);
    dlg.querySelector('[data-body]').innerHTML = `${text ? `<p>${esc(text)}</p>` : ''}${html}
      <div class="row"><button class="btn ${danger ? 'btn-danger' : ''}" type="button" data-yes>${esc(confirmLabel)}</button>
      <button class="btn btn-quiet" type="button" data-no>${esc(cancelLabel)}</button></div>`;
    let answer = false;
    dlg.querySelector('[data-yes]').addEventListener('click', () => { answer = true; dlg.close(); });
    dlg.querySelector('[data-no]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(answer));
    dlg.showModal();
  });
}

// A form in a dialog. html is trusted markup (escape values yourself). onOpen(form, dlg) wires it up;
// onSubmit(form, dlg) may throw: the message shows in the dialog and it stays open. buttons: extra
// buttons [{ label, danger, onClick(form, dlg) }] next to Simpan (they may throw too; returning false keeps the dialog open).
export function formDialog({ title, html, submitLabel = 'Simpan', cancelLabel = 'Batal', wide = false, onOpen, onSubmit, buttons = [] }) {
  return new Promise((resolve) => {
    const dlg = makeDialog(title, wide);
    dlg.querySelector('[data-body]').innerHTML = `<form class="stack" novalidate data-form>${html}
      <div class="notice notice-warn" data-warn role="alert" hidden></div>
      <div class="notice notice-error" data-err role="alert" hidden></div>
      <div class="row">${onSubmit ? `<button class="btn" type="submit">${esc(submitLabel)}</button>` : ''}
      ${buttons.map((b, i) => `<button class="btn ${b.danger ? 'btn-danger' : 'btn-quiet'}" type="button" data-extra="${i}">${esc(b.label)}</button>`).join('')}
      <button class="btn btn-quiet" type="button" data-no>${esc(onSubmit ? cancelLabel : 'Tutup')}</button></div></form>`;
    const form = dlg.querySelector('[data-form]');
    let done = false;
    const run = async (fn, btn) => {
      showErr(dlg, '');
      if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
      try {
        if ((await fn(form, dlg)) === false) { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } return; }
        done = true; dlg.close();
      }
      catch (e) { showErr(dlg, e.message || String(e)); if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); if (onSubmit) run(onSubmit, form.querySelector('button[type="submit"]')); });
    const unwarn = () => {
      if (!form.dataset.warned) return;
      delete form.dataset.warned;
      const w = form.querySelector('[data-warn]'); w.hidden = true; w.textContent = '';
      const b = form.querySelector('button[type="submit"]'); if (b) b.textContent = submitLabel;
    };
    form.addEventListener('input', unwarn); form.addEventListener('change', unwarn);
    buttons.forEach((b, i) => form.querySelector(`[data-extra="${i}"]`).addEventListener('click', (e) => run(b.onClick, e.currentTarget)));
    form.querySelector('[data-no]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(done));
    dlg.showModal();
    onOpen?.(form, dlg);
    (form.querySelector('input:not([type="hidden"]), select, textarea') || form.querySelector('button'))?.focus();
  });
}

// See the header: warn once, then "Tetap simpan" saves. Returns true when the caller should stop.
export function warnFirst(form, text) {
  if (!text || form.dataset.warned === text) return false;
  form.dataset.warned = text;
  const w = form.querySelector('[data-warn]');
  if (w) { w.textContent = text; w.hidden = false; }
  const b = form.querySelector('button[type="submit"]');
  if (b) b.textContent = 'Tetap simpan';
  return true;
}

// Read-only details with a Tutup button (and optional extra buttons).
export const infoDialog = (opts) => formDialog({ ...opts, onSubmit: null });

/* ------------------------------------------------------------------ the table */
export function dataTable(el, opts) {
  const o = { pageSize: 20, emptyText: 'Belum ada data.', editLabel: 'Ubah', exportName: 'data', ...opts };
  // Empty states say what to do next (13 Nov 2026), the same way on every list.
  const hint = o.emptyHint ?? (/tekan \+ tambah|dengan \+ tambah/i.test(o.emptyText) ? ''
    : o.onAdd ? 'Tekan + Tambah untuk membuat yang pertama.'
      : /rentang/i.test(o.emptyText) ? 'Pilih rentang lain di atas, misalnya 30 hari atau Bulan lalu.' : '');
  const cols = o.columns;
  const keyOf = typeof o.rowKey === 'function' ? o.rowKey : (r) => r[o.rowKey || 'id'];
  const selectable = !!(o.onDelete || o.selectable);
  const searchKeys = o.searchKeys || cols.map((c) => c.key);
  const uid = `dt${++dlgSeq}`;
  const st = { rows: o.rows || [], q: '', qKey: '', sort: o.defaultSort ? { ...o.defaultSort } : null, page: 1, picked: new Set() };

  const cellText = (c, r) => (c.format ? (c.html ? strip(c.format(r[c.key], r)) : plain(c.format(r[c.key], r))) : plain(r[c.key]));
  const cellHtml = (c, r) => (c.format ? (c.html ? plain(c.format(r[c.key], r)) : esc(c.format(r[c.key], r))) : esc(r[c.key]));
  const nameOf = (r) => (o.rowName ? o.rowName(r) : cellText(cols[0], r) || String(keyOf(r)));

  el.classList.add('dt');
  el.innerHTML = `<div class="dt-bar">
      <div class="dt-left" data-left>${o.onAdd ? '<button class="btn" type="button" data-add>+ Tambah</button>' : ''}
        ${(o.extraActions || []).map((a, i) => `<button class="btn ${a.primary ? '' : 'btn-quiet'}" type="button" data-extra="${i}">${esc(a.label)}</button>`).join('')}</div>
      <div class="dt-right">
        ${o.onImport ? '<button class="btn btn-quiet" type="button" data-import>Impor</button>' : ''}
        <button class="btn btn-quiet" type="button" data-export>Ekspor</button>
        ${o.onDelete ? '<button class="btn btn-quiet" type="button" data-del disabled>Hapus</button>' : ''}</div>
    </div>
    <form class="dt-search" role="search" novalidate data-search>
      <label class="field dt-col"><span>Kolom</span><select data-qkey><option value="">Semua kolom</option>
        ${cols.filter((c) => searchKeys.includes(c.key)).map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join('')}</select></label>
      <label class="field dt-q"><span>Cari</span><input type="search" data-q autocomplete="off" placeholder="Ketik untuk mencari"></label>
    </form>
    <div class="notice notice-error" data-msg role="alert" hidden></div>
    <div class="table-wrap"><table class="dt-table" aria-describedby="${uid}-count"><thead></thead><tbody></tbody></table></div>
    <div class="dt-foot"><p class="muted small" id="${uid}-count" aria-live="polite"></p><nav class="dt-pages" aria-label="Halaman" data-pages></nav></div>`;
  const $ = (s) => el.querySelector(s);
  const thead = $('thead'), tbody = $('tbody'), msg = $('[data-msg]');
  const say = (m) => { msg.className = 'notice notice-error'; msg.setAttribute('role', 'alert'); msg.textContent = m || ''; msg.hidden = !m; };
  const sayOk = (m) => { msg.className = 'notice notice-ok'; msg.setAttribute('role', 'status'); msg.textContent = m; msg.hidden = false; };

  const filtered = () => {
    let rows = st.rows;
    const q = st.q.trim().toLowerCase();
    if (q) {
      const use = st.qKey ? cols.filter((c) => c.key === st.qKey) : cols.filter((c) => searchKeys.includes(c.key));
      rows = rows.filter((r) => use.some((c) => cellText(c, r).toLowerCase().includes(q)));
    }
    if (st.sort) {
      const c = cols.find((x) => x.key === st.sort.key);
      if (c) {
        const val = typeof c.sort === 'function' ? c.sort : (r) => r[c.key];
        const dir = st.sort.dir === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => {
          const x = val(a), y = val(b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
          return String(x).localeCompare(String(y), 'id', { numeric: true, sensitivity: 'base' }) * dir;
        });
      }
    }
    return rows;
  };

  function render() {
    const rows = filtered();
    const pages = Math.max(1, Math.ceil(rows.length / o.pageSize));
    st.page = Math.min(st.page, pages);
    const view = rows.slice((st.page - 1) * o.pageSize, st.page * o.pageSize);
    const live = new Set(st.rows.map((r) => String(keyOf(r))));
    st.picked = new Set([...st.picked].filter((k) => live.has(k)));
    const allOn = view.length > 0 && view.every((r) => st.picked.has(String(keyOf(r))));
    thead.innerHTML = `<tr>${selectable ? `<th class="dt-chk"><input type="checkbox" data-all aria-label="Pilih semua baris di halaman ini"${allOn ? ' checked' : ''}></th>` : ''}
      ${cols.map((c) => {
    const sortable = !!c.sort, on = st.sort && st.sort.key === c.key;
    return `<th scope="col" class="${c.align === 'num' ? 'num' : ''}"${sortable ? ` aria-sort="${on ? (st.sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}"` : ''}>${sortable
      ? `<button type="button" class="dt-sort" data-sort="${esc(c.key)}">${esc(c.label)} <span aria-hidden="true">${on ? (st.sort.dir === 'desc' ? '↓' : '↑') : '⇅'}</span></button>` : esc(c.label)}</th>`;
  }).join('')}${o.onEdit ? '<th scope="col" class="dt-act"><span class="visually-hidden">Aksi</span></th>' : ''}</tr>`;
    tbody.innerHTML = view.length ? view.map((r) => {
      const k = String(keyOf(r));
      return `<tr data-k="${esc(k)}"${o.onEdit ? ' class="dt-click"' : ''}>${selectable ? `<td class="dt-chk"><input type="checkbox" data-pick aria-label="Pilih ${esc(nameOf(r))}"${st.picked.has(k) ? ' checked' : ''}></td>` : ''}
        ${cols.map((c) => `<td class="${c.align === 'num' ? 'num' : ''}">${cellHtml(c, r)}</td>`).join('')}
        ${o.onEdit ? `<td class="dt-act"><button class="btn btn-text" type="button" data-edit aria-label="${esc(o.editLabel)} ${esc(nameOf(r))}">${esc(o.editLabel)}</button></td>` : ''}</tr>`;
    }).join('') : `<tr><td colspan="${cols.length + (selectable ? 1 : 0) + (o.onEdit ? 1 : 0)}" class="dt-empty"><p class="dt-empty-t">${esc(st.rows.length ? 'Tidak ada yang cocok dengan pencarian.' : o.emptyText)}</p>
      ${st.rows.length ? '<p class="muted small">Ubah kata pencarian, atau pilih Semua kolom.</p>' : hint ? `<p class="muted small">${esc(hint)}</p>` : ''}</td></tr>`;
    if (o.foot) {
      const tf = $('tfoot') || $('table').appendChild(document.createElement('tfoot'));
      const cells = rows.length ? o.foot(rows) : null;
      tf.innerHTML = cells ? `<tr>${selectable ? '<td></td>' : ''}${cols.map((c, i) => `<th scope="${i ? 'col' : 'row'}" class="${c.align === 'num' ? 'num' : ''}">${esc(cells[i] ? cells[i][0] : '')}</th>`).join('')}${o.onEdit ? '<td></td>' : ''}</tr>` : '';
    }
    $(`#${uid}-count`).textContent = rows.length
      ? `Menampilkan ${(st.page - 1) * o.pageSize + 1}–${(st.page - 1) * o.pageSize + view.length} dari ${rows.length}${st.picked.size ? `, ${st.picked.size} dipilih` : ''}` : '';
    const del = $('[data-del]');
    if (del) { del.disabled = !st.picked.size; del.textContent = st.picked.size ? `Hapus (${st.picked.size})` : 'Hapus'; }
    (o.extraActions || []).forEach((a, i) => { const b = $(`[data-extra="${i}"]`); if (b && a.needsSelection) b.disabled = !st.picked.size; });
    const nav = $('[data-pages]');
    if (pages <= 1) nav.innerHTML = '';
    else {
      const from = Math.max(1, Math.min(st.page - 2, pages - 4)), to = Math.min(pages, from + 4), btn = (p, label, aria, dis) =>
        `<button type="button" class="btn btn-quiet dt-pg" data-page="${p}" ${dis ? 'disabled' : ''} ${aria ? `aria-label="${aria}"` : ''}${p === st.page && !aria ? ' aria-current="page"' : ''}>${label}</button>`;
      nav.innerHTML = btn(1, '«', 'Halaman pertama', st.page === 1) + btn(st.page - 1, '‹', 'Halaman sebelumnya', st.page === 1)
        + Array.from({ length: to - from + 1 }, (_, i) => btn(from + i, from + i)).join('')
        + btn(st.page + 1, '›', 'Halaman berikutnya', st.page === pages) + btn(pages, '»', 'Halaman terakhir', st.page === pages);
    }
  }

  const rowOf = (tr) => st.rows.find((r) => String(keyOf(r)) === tr.dataset.k);
  const selectedRows = () => st.rows.filter((r) => st.picked.has(String(keyOf(r))));
  async function refresh() {
    if (!o.reload) return;
    try { st.rows = await o.reload(); } catch (e) { say(e.message); }
    render();
  }

  // One dialog at a time: a second click while the first one is still loading (slow internet) is ignored.
  let opening = false;
  const once = async (fn) => {
    if (opening) return;
    opening = true; say('');
    try { await fn(); await refresh(); } catch (e) { say(e.message); } finally { opening = false; }
  };
  $('[data-import]')?.addEventListener('click', () => once(() => o.onImport()));
  $('[data-add]')?.addEventListener('click', () => once(() => o.onAdd()));
  (o.extraActions || []).forEach((a, i) => $(`[data-extra="${i}"]`).addEventListener('click', () => once(() => a.onClick(selectedRows()))));
  $('[data-search]').addEventListener('submit', (e) => e.preventDefault());
  $('[data-q]').addEventListener('input', (e) => { st.q = e.target.value; st.page = 1; render(); });
  $('[data-qkey]').addEventListener('change', (e) => { st.qKey = e.target.value; st.page = 1; render(); });
  thead.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sort]');
    if (!b) return;
    const key = b.dataset.sort;
    st.sort = st.sort && st.sort.key === key ? { key, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
    render();
    el.querySelector(`[data-sort="${CSS.escape(key)}"]`)?.focus();
  });
  thead.addEventListener('change', (e) => {
    if (!e.target.matches('[data-all]')) return;
    const rows = filtered().slice((st.page - 1) * o.pageSize, st.page * o.pageSize);
    rows.forEach((r) => (e.target.checked ? st.picked.add(String(keyOf(r))) : st.picked.delete(String(keyOf(r)))));
    render();
  });
  tbody.addEventListener('change', async (e) => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr) return;
    if (e.target.matches('[data-pick]')) {
      if (e.target.checked) st.picked.add(tr.dataset.k); else st.picked.delete(tr.dataset.k);
      render();
      el.querySelector(`tr[data-k="${CSS.escape(tr.dataset.k)}"] [data-pick]`)?.focus();
    } else if (e.target.matches('[data-act]') && o.onAction) {
      say('');
      try { await o.onAction(e.target.dataset.act, rowOf(tr), e.target, e); await refresh(); } catch (err) { say(err.message); e.target.checked = !e.target.checked; }
    }
  });
  tbody.addEventListener('click', async (e) => {
    const tr = e.target.closest('tr[data-k]');
    if (!tr) return;
    const act = e.target.closest('button[data-act], a[data-act]');
    if (act && o.onAction) {
      say('');
      try { await o.onAction(act.dataset.act, rowOf(tr), act, e); await refresh(); } catch (err) { say(err.message); }
      return;
    }
    if (e.target.closest('input, label, a, button:not([data-edit])')) return;
    if (o.onEdit) once(() => o.onEdit(rowOf(tr)));
  });
  $('[data-pages]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-page]');
    if (!b || b.disabled) return;
    st.page = Number(b.dataset.page); render();
    el.querySelector('[data-pages] [aria-current="page"]')?.focus();
  });

  $('[data-del]')?.addEventListener('click', async () => {
    const rows = selectedRows();
    if (!rows.length) return;
    const list = rows.slice(0, 8).map((r) => `<li>${esc(nameOf(r))}</li>`).join('') + (rows.length > 8 ? `<li>dan ${rows.length - 8} lainnya</li>` : '');
    const yes = await confirmDialog({
      title: rows.length === 1 ? 'Hapus data ini?' : `Hapus ${rows.length} data ini?`, danger: true, confirmLabel: 'Hapus',
      html: `<ul class="dt-list">${list}</ul><p class="muted small">${esc(o.deleteHelp || 'Hapus menghilangkan data selamanya, dan hanya bisa untuk data yang belum pernah dipakai. Data yang sudah punya catatan tidak dihapus: nonaktifkan saja, supaya hilang dari pilihan tapi catatan lamanya tetap utuh.')}</p>`,
    });
    if (!yes) return;
    say('');
    let ok = false;
    try { await o.onDelete(rows); st.picked.clear(); ok = true; } catch (e) { say(e.message); }
    await refresh();
    if (ok) sayOk(rows.length === 1 ? `${nameOf(rows[0])} dihapus.` : `${rows.length} data dihapus.`);
  });

  // Ekspor: the selected rows, or every row that matches the search.
  const exportRows = () => {
    const rows = st.picked.size ? selectedRows() : filtered();
    const out = [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => (c.export ? c.export(r) : (c.format ? cellText(c, r) : r[c.key]) ?? '')))];
    const ft = o.foot && rows.length ? o.foot(rows) : null;
    if (ft) out.push(ft.map((x) => (x ? x[1] : '')));
    return out;
  };
  // Ekspor (Glenn, 12 Nov 2026): one click saves the Excel file straight to the computer's
  // Downloads folder. If the Excel maker can't load (no internet), a .csv is saved instead.
  $('[data-export]').addEventListener('click', async (e) => {
    say('');
    const btn = e.currentTarget; btn.disabled = true;
    try {
      await loadSheetJS();
      const ws = window.XLSX.utils.aoa_to_sheet(exportRows()), wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Data');
      window.XLSX.writeFile(wb, `${o.exportName}.xlsx`);
    } catch {
      const text = '\ufeff' + exportRows().map((r) => r.map(csvCell).join(',')).join('\r\n');
      download(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${o.exportName}.csv`);
    } finally { btn.disabled = false; }
  });

  render();
  return { setRows(rows) { st.rows = rows || []; render(); }, selected: selectedRows, refresh };
}
