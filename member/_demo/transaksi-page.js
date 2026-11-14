// Demo only: the Transaksi screens one at a time, picked by #hash (po, penerimaan, ...).
import { mountTransaksi } from '../js/owner-transaksi.js';
import { rpc } from './owner-lib.js';
const PARTS = [['po', 'Purchase Order'], ['penerimaan', 'Penerimaan barang'], ['stok-masuk', 'Stok masuk'], ['stok-keluar', 'Stok keluar'], ['opname', 'Stok opname'],
  ['adjustment', 'Penyesuaian stok'], ['komisi-proses', 'Proses komisi'], ['pembatalan', 'Pembatalan penjualan'], ['pemasok', 'Pemasok']];
const cur = () => location.hash.slice(1) || 'po';
async function show() {
  document.getElementById('tabs').innerHTML = PARTS.map(([k, l]) => `<a class="btn ${k === cur() ? '' : 'btn-quiet'}" href="#${k}">${l}</a>`).join('');
  const panel = document.getElementById('panel');
  if (cur() === 'pemasok') { const { ownerStock } = await import('../js/stock.js'); await ownerStock(panel, { part: 'pemasok' }); return; }
  await mountTransaksi(panel, { rpc, part: cur() });
}
addEventListener('hashchange', show); show();
