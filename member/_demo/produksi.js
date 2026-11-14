// Demo only (_demo-produksi.html): the page; the fakes live in produksi-data.js (shared with _demo-owner.html).
import { rpc as base } from './owner-lib.js';
import { mountProduksi } from '../js/owner-produksi.js';
import { produksiFake, EXTRA } from './produksi-data.js';

async function rpc(name, args = {}) {
  const mine = produksiFake(name, args);
  if (mine !== undefined) return mine;
  const r = await base(name, args);
  if (name === 'stock_catalog') return { ...r, items: [...(r.items || []), ...EXTRA.map((i) => ({ ...i, low_level: null, closes_at_zero: false }))] };
  return r;
}

// the page
const PARTS = [['lokasi', 'Lokasi stok'], ['stok-transfer', 'Stok transfer'], ['transfer-order', 'Transfer order'], ['surat-jalan', 'Surat jalan'],
  ['penerimaan', 'Penerimaan transfer'], ['perjalanan', 'Dalam perjalanan'], ['produksi', 'Produksi'], ['bongkar', 'Bongkar produksi'], ['resep', 'Resep produksi'], ['kartu', 'Kartu stok']];
const cur = () => location.hash.slice(1).split('/')[0] || 'kartu';
function show() {
  document.getElementById('tabs').innerHTML = PARTS.map(([k, l]) => `<a class="btn ${k === cur() ? '' : 'btn-quiet'}" href="#${k}">${l}</a>`).join('');
  const panel = document.getElementById('panel'); panel.replaceChildren();
  // Demo-only helpers for headless screenshots: #part/add opens + Tambah, #part/open opens the first row.
  const act = location.hash.split('/')[1];
  mountProduksi(panel, { rpc, part: cur() }).then(() => setTimeout(() => {
    if (act === 'add') panel.querySelector('[data-add]')?.click();
    if (act === 'open') panel.querySelector('tbody tr td')?.click();
    setTimeout(() => { const q = document.querySelector('dialog [data-f="qty"]'); if (q) { q.value = '5000'; q.dispatchEvent(new Event('input')); } }, 500);
  }, 300));
}
addEventListener('hashchange', show); show();
