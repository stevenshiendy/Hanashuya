// Demo only: fake owner data shared by _demo/backoffice.js and _demo/owner-lib.js.
// Demo only (_demo-backoffice.html): the owner's Pesanan, Member, Promo tabs and the Laba panel
// with the shared sample data (sample-data.js). ?tab=pesanan|pesanan-buka|member|member-buka|promo|promo-baru|laba
import * as V from './sample-views.js';
import { data } from './sample-data.js';
export const t = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const WA = [
  { id: 1, name: 'DRAFT Pengingat voucher ulang tahun', category: 'ulang_tahun', body: 'Halo Kak {nama}, ada hadiah ulang tahun dari Hanashuya: 1 box Mini Choux isi 8. Bisa diambil di booth mulai 7 hari sebelum sampai 7 hari sesudah ulang tahun Kakak. Tinggal tunjukkan kartu member di {link_kartu} ke kasir. Ditunggu mampirnya.', active: true },
  { id: 2, name: 'DRAFT Pengingat voucher member baru', category: 'voucher', body: 'Halo Kak {nama}, hadiah member baru Kakak masih ada: diskon 50% untuk 1 produk, berlaku 30 hari sejak Kakak daftar. Tunjukkan kartu member ke kasir di booth Hanashuya, Papaya Fresh Gallery. Silahkan cobain Kak.', active: false },
  { id: 3, name: 'DRAFT Link kartu member', category: 'kartu', body: 'Halo Kak {nama}, stempel di kartu member Hanashuya Kakak sekarang {stempel}. Hadiah berikutnya: {hadiah}. Kartunya bisa dibuka di {link_kartu}', active: false },
];
export async function rpc(n, a = {}) {
  switch (n) {
    case 'owner_pos_orders': return V.ownerOrders(a);
    case 'owner_pos_order': return V.ownerOrder(a);
    case 'owner_members': return V.ownerMembers(a);
    case 'owner_member': return V.ownerMember(a);
    case 'owner_wa_templates': return WA.filter((x) => x.active || !a.p_only_active);
    case 'owner_set_wa_template': WA.find((x) => x.id === a.p_id).active = a.p_active; return { id: a.p_id, active: a.p_active };
    case 'owner_save_wa_template': { const r = a.p_id ? WA.find((x) => x.id === a.p_id) : (WA.push({ id: WA.length + 1, active: false }), WA[WA.length - 1]); Object.assign(r, { name: a.p_name, category: a.p_category, body: a.p_body }); return r; }
    case 'owner_wa_preview': { const t = WA.find((x) => x.id === a.p_template); return { text: t.body.replace('{nama}', 'Desi').replace('{stempel}', '4').replace('{hadiah}', 'Diskon 20% di stempel ke-7').replace('{voucher}', 'Diskon 50% untuk 1 produk').replace('{link_kartu}', 'https://hanashuya.vercel.app/member/'), whatsapp: '6281234567890', name: 'Desi', template: t.name }; }
    case 'owner_pos_promos': return V.ownerPromos();
    case 'whoami': return { id: 'o-glenn', role: 'owner', full_name: 'Glenn' };
    default: return null;
  }
}
// Rina's order today, with a cancel request waiting: the one the "pesanan-buka" state opens.
export const pendingVoidId = () => (data().orders.find((o) => o.void && o.void.status === 'menunggu') || data().orders[0]).id;
