// Demo only: ?v=staff (cashier Stok tab, &role=staff|manager), ?v=till&part=menu|masuk|keluar|opname|permintaan|riwayat
// (the till's Stok screens), or ?v=owner&m=now|report|audit|opname|requests|recipe|items
import { staffStock, ownerStock } from '../js/stock.js';
const q = new URLSearchParams(location.search), app = document.querySelector('#app');
if (q.get('v') === 'owner') {
  document.body.className = 'w-owner'; app.className = 'w-owner stack-lg';
  await ownerStock(app);
  const m = q.get('m');
  if (m) { const r = document.querySelector(`input[name="os-mode"][value="${m}"]`); r.checked = true; r.dispatchEvent(new Event('change')); }
} else if (q.get('v') === 'till') {
  await staffStock(app, { part: q.get('part') || 'menu', role: q.get('role') || 'manager' });
} else {
  await staffStock(app, q.get('role') || 'manager');
  const m = q.get('m');
  if (m) { const r = document.querySelector(`input[name="sk-mode"][value="${m}"]`); r.checked = true; r.dispatchEvent(new Event('change')); }
}
