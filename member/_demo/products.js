import { mountProducts } from '../js/owner-products.js';
import * as V from './sample-views.js';
// Demo only (_demo-products.html): a fake rpc for the owner's Produk tab with categories.
const d = {
  categories: [
    { id: 1, name: 'Signature', active: true, products: 2, active_products: 2 },
    { id: 2, name: 'Mini Choux', active: true, products: 2, active_products: 2 },
    { id: 3, name: 'Lainnya', active: true, products: 1, active_products: 0 },
    { id: 4, name: 'Pistachoux', active: true, products: 1, active_products: 1 }],
  products: [
    { code: 'sig1', pos_name: 'Signature 1 pcs', category_id: 1, price: 20000, flavour_surcharge: 0, active: true, needs_flavour: true, channel_prices: { shopeefood: 30000 } },
    { code: 'sig6', pos_name: 'Signature Box isi 6', category_id: 1, price: 120000, flavour_surcharge: 3000, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'mini15', pos_name: 'Mini Box isi 15', category_id: 2, price: 99000, flavour_surcharge: 3000, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'mini8', pos_name: 'Mini Box isi 8', category_id: 2, price: 68000, flavour_surcharge: 3000, active: true, needs_flavour: true, channel_prices: {} },
    { code: 'bag', pos_name: 'Paper bag', category_id: 3, price: 5000, flavour_surcharge: 0, active: false, needs_flavour: false, channel_prices: {} },
    { code: 'pistachoux_1_pcs', pos_name: 'Pistachoux 1 pcs', category_id: 4, price: 35000, flavour_surcharge: 0, active: true, needs_flavour: false, channel_prices: {} }],
  channels: [{ id: 'toko', label: 'Di booth', delivery: false, active: true }, { id: 'shopeefood', label: 'ShopeeFood', delivery: true, active: false }, { id: 'grabfood', label: 'GrabFood', delivery: true, active: false }],
  flavours: [{ id: 'vanilla', label: 'Vanilla', surcharge: false, active: true }, { id: 'choco', label: 'Choco', surcharge: true, active: true },
    { id: 'matcha', label: 'Matcha', surcharge: true, active: true }, { id: 'matcha_strawberry', label: 'Matcha Strawberry', surcharge: true, active: true }],
};
let target = { kind: 'produk', value: 10 };
const fail = (m) => { throw new Error(m); };
async function rpc(n, a = {}) {
  switch (n) {
    case 'owner_pos_products': return structuredClone(d);
    case 'pos_home': { const cur = target.kind === 'omzet' ? V.posHome().revenue : V.posHome().products_sold; return { target: { ...target, current: cur, percent: Math.round(cur * 100 / target.value), remaining: Math.max(0, target.value - cur) } }; }
    case 'owner_save_target': target = { kind: a.p_kind, value: a.p_value }; return target;
    case 'owner_set_pos_category': {
      const c = d.categories.find((x) => x.id === a.p_id);
      if (!a.p_active && d.products.some((m) => m.category_id === c.id && m.active)) fail(`Kategori ${c.name} masih punya produk aktif. Matikan atau pindahkan produknya dulu.`);
      c.active = a.p_active; return null;
    }
    case 'owner_add_pos_category': d.categories.push({ id: d.categories.length + 1, name: a.p_name, active: true, products: 0, active_products: 0 }); return null;
    case 'owner_add_pos_product': {
      if (d.products.some((m) => m.pos_name.toLowerCase() === a.p_name.toLowerCase())) fail(`Sudah ada produk bernama ${a.p_name}. Pakai nama lain.`);
      d.products.push({ code: a.p_name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), pos_name: a.p_name, category_id: a.p_category_id, price: a.p_price,
        flavour_surcharge: a.p_flavour_surcharge, active: a.p_active, needs_flavour: a.p_needs_flavour, channel_prices: {} });
      return null;
    }
    default: return null;
  }
}
mountProducts(document.getElementById('p'), { rpc });
