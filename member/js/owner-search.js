// Global search in the owner header (13 Nov 2026, VireoPOS comparison: "Cari menu, transaksi,
// atau laporan"). Type part of a menu name to jump to that view, or a receipt number
// (HS-261113-0007, or an offline L… number) to open that order in Pesanan.
//   ownerSearch(host, { items: [{ hash, label, group }], go(hash), openReceipt(text) })
//   openReceipt null (a manager, 13 Nov 2026): the field finds menu items only.
// openReceipt resolves to a message when nothing is found, so the field says it right there.
import { esc } from './lib.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
// HS-261113-0007, hs261113, L-… or just the digits of one.
export const looksLikeReceipt = (q) => /^(hs|l)[\s-]?\d/i.test(q.trim()) || /^\d{6}[\s-]?\d{1,4}$/.test(q.trim());

export function ownerSearch(host, { items, go, openReceipt }) {
  const what = openReceipt ? 'Cari menu atau nomor struk' : 'Cari menu';
  host.innerHTML = `<form class="os" role="search" novalidate>
    <label class="visually-hidden" for="os-q">${what}</label>
    <input id="os-q" type="search" autocomplete="off" spellcheck="false" placeholder="${what}" role="combobox"
      aria-expanded="false" aria-controls="os-list" aria-autocomplete="list" aria-describedby="os-msg">
    <ul id="os-list" class="os-list" role="listbox" aria-label="Hasil pencarian" hidden></ul>
    <p id="os-msg" class="os-msg small" role="status" hidden></p>
  </form>`;
  const form = host.querySelector('form'), input = host.querySelector('#os-q'), list = host.querySelector('#os-list'), msg = host.querySelector('#os-msg');
  let results = [], active = -1;
  const say = (m) => { msg.textContent = m || ''; msg.hidden = !m; };

  function search(q) {
    const n = norm(q);
    if (!n) return [];
    const out = [];
    if (openReceipt && looksLikeReceipt(q)) out.push({ kind: 'receipt', label: `Buka struk ${q.trim().toUpperCase()}`, sub: 'Pesanan' });
    const words = n.split(' ');
    const scored = items.map((it) => {
      const hay = norm(`${it.label} ${it.group}`), lab = norm(it.label);
      if (!words.every((w) => hay.includes(w))) return null;
      return { it, s: lab.startsWith(n) ? 0 : lab.includes(n) ? 1 : 2 };
    }).filter(Boolean).sort((a, b) => a.s - b.s || a.it.label.localeCompare(b.it.label, 'id'));
    scored.slice(0, 8).forEach(({ it }) => out.push({ kind: 'view', label: it.label, sub: it.group, hash: it.hash }));
    return out;
  }
  function render() {
    list.innerHTML = results.map((r, i) => `<li id="os-o${i}" role="option" aria-selected="${i === active}" data-i="${i}">
      <span>${esc(r.label)}</span>${r.sub ? `<span class="os-sub">${esc(r.sub)}</span>` : ''}</li>`).join('');
    const open = results.length > 0;
    list.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    if (active >= 0) input.setAttribute('aria-activedescendant', `os-o${active}`); else input.removeAttribute('aria-activedescendant');
  }
  const close = () => { results = []; active = -1; render(); };
  async function pick(r) {
    if (!r) return;
    say('');
    if (r.kind === 'view') { close(); input.value = ''; go(r.hash); return; }
    const q = input.value.trim();
    close();
    input.setAttribute('aria-busy', 'true');
    let m = null;
    try { m = await openReceipt(q); } catch (e) { m = e.message; }
    input.removeAttribute('aria-busy');
    if (m) say(m); else input.value = '';
  }
  input.addEventListener('input', () => { say(''); results = search(input.value); active = results.length ? 0 : -1; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Escape') { if (results.length) { e.preventDefault(); close(); } else { input.value = ''; say(''); } }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    if (!results.length) { say(openReceipt ? 'Tidak ada menu dengan nama itu. Untuk struk, ketik nomornya, misalnya HS-261113-0007.' : 'Tidak ada menu dengan nama itu.'); return; }
    pick(results[Math.max(0, active)]);
  });
  list.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the field
  list.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li) pick(results[Number(li.dataset.i)]); });
  input.addEventListener('blur', () => setTimeout(close, 0));
  // "/" anywhere on the page (outside a field) jumps to the search.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable], dialog')) return;
    e.preventDefault(); input.focus();
  });
  return { focus: () => input.focus() };
}
