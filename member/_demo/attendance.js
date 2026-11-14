import { mountKasirAbsen, mountOwnerAbsensi } from '/member/js/attendance.js';
const P = new URLSearchParams(location.search), root = document.getElementById('app');
const panel = document.createElement('section'); panel.className = 'stack-lg'; root.append(panel);
if (P.get('v') === 'owner') { mountOwnerAbsensi(panel); const part = P.get('part'); if (part) setTimeout(() => document.querySelector(`[data-part="${part}"]`).click(), 150); }
else mountKasirAbsen(panel);
