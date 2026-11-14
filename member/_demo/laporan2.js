// Demo only (_demo-laporan2.html): the Laporan hubs and the two new Akunting tabs with real output.
// laporan2-data.json is written by pos-tests/laporan2.test.mjs (DUMP=...): every sub-report run on the
// test's seeded orders in PGlite, so the shapes are exactly what pos-laporan2.sql returns.
//   ?hub=penjualan            a hub's list          ?hub=penjualan&r=jual_produk   one sub-report
//   ?akun=bulanan | jurnal    Laporan akunting on that tab
import { mountReportHub } from '../js/owner-laporan2.js';
import { mountAkunting } from '../js/owner-akunting.js';
import { rpc as base } from './owner-lib.js';
import { laporan2Fake } from './laporan2-data.js';

async function rpc(name, a = {}) { const r = await laporan2Fake(name, a); return r === undefined ? base(name, a) : r; }
const q = new URLSearchParams(location.search), panel = document.getElementById('panel');
if (q.get('akun')) {
  mountAkunting(panel, { rpc, part: 'laporan' });
  const pick = () => { const b = panel.querySelector(`[data-tab="${q.get('akun')}"]`); if (b) b.click(); else setTimeout(pick, 50); };
  setTimeout(pick, 300);
} else mountReportHub(panel, { rpc, hub: q.get('hub') || 'penjualan', open: q.get('r') });
