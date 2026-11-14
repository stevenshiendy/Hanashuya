import { mountOwnerReports } from '../js/owner-reports.js';
import * as V from './sample-views.js';
// Demo only (_demo-reports.html): Laporan POS from the shared sample data set (sample-data.js).
window.__calls = 0;
mountOwnerReports(document.getElementById('p-rep'), { rpc: async (n, a) => {
  window.__calls++;
  if (n === 'stock_low') return V.stockItems().filter((i) => i.low).map(({ id, name, unit, qty, low_level }) => ({ id, name, unit, qty, low_level }));
  if (n === 'owner_pos_stats') return V.stats(a || {});
  if (n === 'owner_pos_profit') return V.profit(a || {});
  if (n === 'owner_pos_report') return V.report(a || {});
  return { rangkuman: [], rincian: [], per_produk: [], kas: [] };
} });
