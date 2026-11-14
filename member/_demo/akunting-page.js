// Demo only: the three Akunting views one at a time, picked by #hash (akun, jurnal, laporan).
import { mountAkunting } from '../js/owner-akunting.js';
import { rpc } from './owner-lib.js';
const PARTS = [['akun', 'Akun buku besar'], ['jurnal', 'Buat jurnal'], ['laporan', 'Laporan akunting']];
const cur = () => location.hash.slice(1) || 'akun';
function show() {
  document.getElementById('tabs').innerHTML = PARTS.map(([k, l]) => `<a class="btn ${k === cur() ? '' : 'btn-quiet'}" href="#${k}">${l}</a>`).join('');
  const panel = document.getElementById('panel'); panel.replaceChildren();
  mountAkunting(panel, { rpc, part: cur() });
}
addEventListener('hashchange', show); show();
