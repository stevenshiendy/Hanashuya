import { mountOrders, mountMembers, mountPromos } from '../js/owner-backoffice.js';
import { mountWaTemplates } from '../js/owner-wa.js';
import { profitHtml } from '../js/owner-reports.js';
import { rpc, pendingVoidId } from './backoffice-data.js';
import { profit } from './sample-views.js';
import { data, addD } from './sample-data.js';
const tab = new URLSearchParams(location.search).get('tab') || 'pesanan';
const p = document.getElementById('p');
const later = (fn) => setTimeout(fn, 400);
if (tab.startsWith('pesanan')) { mountOrders(p, { rpc }); if (tab === 'pesanan-buka') later(() => p.querySelector(`[data-open="${pendingVoidId()}"]`).click()); }
if (tab.startsWith('member')) { mountMembers(p, { rpc }); if (tab === 'member-buka') later(() => p.querySelector('[data-m="desi"]').click()); }
if (tab.startsWith('promo')) { await mountPromos(p, { rpc }); if (tab === 'promo-baru') p.querySelector('[data-edit]').click(); }
if (tab === 'wa') await mountWaTemplates(p, { rpc });
if (tab === 'laba') p.innerHTML = profitHtml(profit({ p_from: addD(data().today, -6), p_to: data().today }));
document.body.dataset.ready = '1';
