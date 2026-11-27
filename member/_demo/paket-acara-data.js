// Demo only: Paket Acara fakes for _demo-owner.html (#paket-acara, #peminat-acara, #produk-acara, #pengaturan-acara).
// The maths copies _bulk_calc in supabase/paket-acara.sql.
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const addDays = (n) => ymd(new Date(Date.now() + n * 864e5));
const cfg = { min_boxes: 10, lead_days: 2, base_free_km: 5, delivery_fee: 20000, max_km: 15, bonus_every: 20, bonus_name: 'Mini Box of 8', bonus_value: 68000,
  tiers: [{ min: 10, pct: 10, free_flavour: true, free_km: 5, bonus: false }, { min: 20, pct: 15, free_flavour: true, free_km: 15, bonus: true },
    { min: 40, pct: 20, free_flavour: true, free_km: 15, bonus: true }, { min: 80, pct: 25, free_flavour: true, free_km: 15, bonus: true }],
  bank: 'Blu by BCA', account_no: '090148040461', account_name: 'Steven Glenn Shiendy', qris: true,
  flavours: ['Vanilla', 'Choco', 'Matcha', 'Matcha Strawberry'], base_flavour: 'Vanilla',
  terms: ['Minimal 10 box per pesanan, pesan paling lambat H-2 sebelum acara.', 'Pembayaran lunas sebelum pengiriman, lewat QRIS Hanashuya atau transfer.',
    'Pesanan dikunci setelah pembayaran masuk.', 'Harga paket tidak bisa digabung promo lain dan tidak mendapat stempel member.', 'Choux paling enak dinikmati di hari pengiriman.'] };
const prods = [
  { id: 'p1', name: 'Signature Box of 6', description: '6 choux besar', price: 120000, flavour_surcharge: 3000, counts_as_box: true, active: true, sort: 1 },
  { id: 'p2', name: 'Mini Box of 15', description: '15 mini choux', price: 99000, flavour_surcharge: 3000, counts_as_box: true, active: true, sort: 2 },
  { id: 'p3', name: 'Mini Box of 8', description: '8 mini choux', price: 68000, flavour_surcharge: 3000, counts_as_box: true, active: true, sort: 3 }];

function calc(p) {
  if (!p.items?.length) throw new Error('Tambahkan paling sedikit 1 produk.');
  let boxes = 0, goods = 0, surcharge = 0; const lines = [];
  for (const it of p.items) {
    if (!Number.isInteger(it.qty) || it.qty < 1) throw new Error('Isi jumlah di setiap baris (1 sampai 2000).');
    const pr = prods.find((x) => x.id === it.product), fl = it.flavour || cfg.base_flavour, sc = fl !== cfg.base_flavour ? pr.flavour_surcharge : 0;
    goods += pr.price * it.qty; surcharge += sc * it.qty; if (pr.counts_as_box) boxes += it.qty;
    lines.push({ product: pr.id, name: pr.name, flavour: fl, qty: it.qty, price: pr.price, surcharge: sc, amount: (pr.price + sc) * it.qty });
  }
  const tier = [...cfg.tiers].reverse().find((t) => boxes >= t.min) || null, pct = tier?.pct || 0, warnings = [];
  if (boxes < cfg.min_boxes) warnings.push(`Di bawah minimal ${cfg.min_boxes} box, jadi tanpa harga paket.`);
  const waived = tier?.free_flavour ? surcharge : 0, discount = Math.round(goods * pct / 100), bonus = tier?.bonus ? Math.floor(boxes / cfg.bonus_every) : 0;
  const km = Number(p.distance_km) || 0, freeKm = tier ? tier.free_km : cfg.base_free_km;
  let fee;
  if (p.delivery_override) fee = p.delivery_fee || 0;
  else if (km <= freeKm) fee = 0;
  else if (km <= cfg.max_km) fee = cfg.delivery_fee;
  else { fee = p.delivery_fee ?? 0; if (p.delivery_fee == null) warnings.push(`Lebih dari ${cfg.max_km} km: isi ongkir sesuai kesepakatan.`); }
  const promo = p.promo_amount || 0;
  return { lines, boxes, goods, surcharge, surcharge_waived: waived, tier, pct, discount, bonus_boxes: bonus, bonus_name: cfg.bonus_name, bonus_value: bonus * cfg.bonus_value,
    distance_km: km, free_km: freeKm, delivery_fee: fee, promo_label: promo ? (p.promo_label || 'Potongan promo') : null, promo_amount: promo,
    total: goods + surcharge - waived - discount - promo + fee, warnings };
}

const invoices = [];
const leads = [
  { id: 'l1', name: 'Sari Wulandari', company: 'Arisan RW 05', whatsapp: '6281311112222', event_date: addDays(9), boxes: 25, note: 'Campur Vanilla dan Matcha', source: 'web', status: 'baru', created_at: new Date(Date.now() - 3 * 36e5).toISOString() },
  { id: 'l2', name: 'Dimas Pratama', company: 'PT Contoh Sejahtera', whatsapp: '6281299998888', event_date: addDays(14), boxes: 60, note: null, source: 'web', status: 'dihubungi', created_at: new Date(Date.now() - 2 * 864e5).toISOString() }];
let seq = 0;
const save = (id, p) => {
  const q = calc(p), now = new Date().toISOString();
  if (!id) {
    const inv = { id: 'i' + (++seq), no: `PA-${addDays(0).slice(2).replace(/-/g, '')}-${String(seq).padStart(2, '0')}`, status: 'draft', created_at: now, issued_on: addDays(0) };
    invoices.unshift(inv); id = inv.id;
    if (p.lead_id) { const l = leads.find((x) => x.id === p.lead_id); if (l) l.status = 'invoice'; }
  }
  const inv = invoices.find((x) => x.id === id);
  Object.assign(inv, { client_name: p.client_name, company: p.company || null, address: p.address, whatsapp: '62' + String(p.whatsapp).replace(/\D/g, '').replace(/^(62|0)/, ''),
    event_date: p.event_date, delivery_date: p.delivery_date, distance_km: q.distance_km, quote: q, total: q.total, note: p.note || null, lead_id: p.lead_id, config: cfg });
  return inv;
};
save(null, { client_name: 'Bu Rina', company: 'Syukuran rumah baru', address: 'Jl. Setiabudi No. 12, Bandung', whatsapp: '081234567890', delivery_date: addDays(5), event_date: addDays(5),
  distance_km: 4, items: [{ product: 'p2', flavour: 'Vanilla', qty: 12 }, { product: 'p2', flavour: 'Matcha', qty: 8 }] });

export function paketAcaraFake(name, a) {
  if (name === 'bulk_config_get') return cfg;
  if (name === 'bulk_config_save') return Object.assign(cfg, a.p);
  if (name === 'bulk_product_list') return prods;
  if (name === 'bulk_product_save') { const p = a.p.id && prods.find((x) => x.id === a.p.id); if (p) Object.assign(p, a.p); else prods.push({ ...a.p, id: 'p' + (prods.length + 1) }); return { ok: true }; }
  if (name === 'bulk_quote') return calc(a.p);
  if (name === 'bulk_invoice_save') return save(a.p_id, a.p);
  if (name === 'bulk_invoice_list') return invoices.map((i) => ({ ...i, boxes: i.quote.boxes })).filter((i) => !a.p_status || i.status === a.p_status);
  if (name === 'bulk_invoice_get') return invoices.find((x) => x.id === a.p_id);
  if (name === 'bulk_invoice_set_status') {
    const i = invoices.find((x) => x.id === a.p_id);
    if (a.p_status === 'batal' && !(a.p_note || '').trim()) throw new Error('Tulis alasan pembatalan.');
    Object.assign(i, { status: a.p_status, pay_method: a.p_method || i.pay_method, cancel_reason: a.p_note || null });
    return i;
  }
  if (name === 'bulk_lead_list') return leads.filter((l) => !a.p_status || l.status === a.p_status);
  if (name === 'bulk_lead_set_status') { leads.find((l) => l.id === a.p_id).status = a.p_status; return { ok: true }; }
  return undefined;
}
