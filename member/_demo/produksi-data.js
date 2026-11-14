// Demo only (_demo-produksi.html and _demo-owner.html): fake replies for js/owner-produksi.js (lokasi, transfer, surat jalan,
// penerimaan, produksi, kartu stok), a small in-memory ledger on the shared sample stock. Then the page:
// one screen at a time, picked by #hash.
import * as V from './sample-views.js';

const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const today = ymd(new Date());
const dayAgo = (n) => ymd(new Date(Date.now() - n * 864e5));
const iso = (d, h = 9) => new Date(`${d}T${String(h).padStart(2, '0')}:15:00+07:00`).toISOString();
const r2 = (n) => Math.round(n * 100) / 100;

const base0 = V.stockItems();
export const EXTRA = [{ id: 901, code: null, name: 'Gula pasir', unit: 'g' }, { id: 902, code: null, name: 'Susu UHT', unit: 'ml' }, { id: 903, code: null, name: 'Kuning telur', unit: 'butir' },
  { id: 904, code: null, name: 'Bubuk matcha', unit: 'g' }];
const ITEMS = [...base0.map(({ id, code, name, unit }) => ({ id, code, name, unit })), ...EXTRA];
const item = (id) => ITEMS.find((i) => i.id === Number(id));
const byCode = (c) => ITEMS.find((i) => i.code === c);
const LOCS = [{ id: 1, code: 'booth', name: 'Booth', note: 'Di dalam Papaya Fresh Gallery', active: true }, { id: 2, code: 'dapur', name: 'Dapur', note: 'Tempat choux dipanggang', active: true }];
const moves = []; // { loc, item, col, qty, day, at, doc, reason, by }
const put = (loc, it, col, qty, day, doc, reason, by = 'Glenn', h = 9) => { if (qty) moves.push({ loc, item: it, col, qty: r2(qty), day, at: iso(day, h), doc, reason, by }); };
const bal = (loc, it, upto = '9999') => r2(moves.filter((m) => m.loc === Number(loc) && m.item === Number(it) && m.day <= upto).reduce((s, m) => s + m.qty, 0));
let n = 0; const no = (p, d) => `${p}-${d.slice(2).replace(/-/g, '')}-${String(++n % 90 + 1).padStart(2, '0')}`;

// opening: Booth = sample stock 20 days ago (as masuk / penjualan spread), Dapur via penyesuaian
base0.forEach((i) => { put(1, i.id, 'pembelian', Number(i.qty) + (i.unit === 'pcs' && i.code !== 'bag' ? 140 : 900), dayAgo(20), 'PB-261023-01', 'Stok awal'); });
base0.filter((i) => ['mini', 'sig'].includes(i.code)).forEach((i) => { for (let d = 14; d >= 1; d--) put(1, i.id, 'penjualan', -(i.code === 'mini' ? 9 : 3), dayAgo(d), `HS-${dayAgo(d).slice(2).replace(/-/g, '')}-0${d % 9 + 1}`, null, 'Ranny', 14); });
[[byCode('mini'), 600], [byCode('sig'), 120], [byCode('vla_vanilla'), 2500], [byCode('vla_matcha'), 1200], [EXTRA[0], 4000], [EXTRA[1], 6000], [EXTRA[2], 300], [EXTRA[3], 500]]
  .forEach(([i, q]) => put(2, i.id, 'penyesuaian', q, dayAgo(18), null, 'Stok awal dapur'));

const recipes = { [byCode('vla_vanilla').id]: [[901, 0.18], [902, 0.7], [903, 0.02]], [byCode('vla_matcha').id]: [[901, 0.18], [902, 0.68], [903, 0.02], [904, 0.03]] };
const transfers = [], shipments = [], receipts = [], productions = [];
const locName = (id) => LOCS.find((l) => l.id === Number(id)).name;
const lineOut = (l) => ({ item_id: l.item, item: item(l.item).name, unit: item(l.item).unit, qty: l.qty });

function tJson(t) {
  const sh = shipments.filter((s) => s.transfer_id === t.id);
  const lines = t.lines.map((l) => ({ ...lineOut(l), stock_at: l.stock_at,
    shipped: t.kind === 'langsung' ? l.qty : sh.filter((s) => s.status !== 'batal').reduce((a, s) => a + (s.lines.find((x) => x.item === l.item)?.qty || 0), 0),
    received: t.kind === 'langsung' ? l.qty : receipts.filter((r) => sh.some((s) => s.id === r.shipment_id)).reduce((a, r) => a + (r.lines.find((x) => x.item === l.item)?.received || 0), 0),
    source_now: bal(t.from_id, l.item) }));
  return { ...t, from: locName(t.from_id), to: locName(t.to_id), lines, lines_count: lines.length, shipments: sh.map(({ id, no: x, status, day }) => ({ id, no: x, status, day })) };
}
function refresh(t) {
  if (t.kind !== 'order' || t.status === 'batal') return;
  const j = tJson(t), full = j.lines.every((l) => l.shipped >= l.qty), some = j.lines.some((l) => l.shipped > 0);
  const open = shipments.some((s) => s.transfer_id === t.id && s.status === 'dalam_perjalanan');
  t.status = full && !open ? 'selesai' : full ? 'terkirim' : some ? 'sebagian' : 'dibuka';
}
function sJson(s) {
  const t = transfers.find((x) => x.id === s.transfer_id), r = receipts.find((x) => x.shipment_id === s.id);
  return { ...s, transfer_no: t.no, from_id: t.from_id, to_id: t.to_id, from: locName(t.from_id), to: locName(t.to_id), receipt_id: r?.id, receipt_no: r?.no, received_day: r?.day,
    lines_count: s.lines.length, lines: s.lines.map((l) => ({ ...lineOut(l), received: r ? r.lines.find((x) => x.item === l.item).received : null, reason: r ? r.lines.find((x) => x.item === l.item).reason : null })),
    days: Math.round((new Date(today) - new Date(s.day)) / 864e5) };
}
function rJson(r) {
  const s = shipments.find((x) => x.id === r.shipment_id), t = transfers.find((x) => x.id === s.transfer_id);
  return { ...r, shipment_no: s.no, transfer_no: t.no, from: locName(t.from_id), to: locName(t.to_id), lines_count: r.lines.length, lines_off: r.lines.filter((l) => l.received !== l.shipped).length,
    lines: r.lines.map((l) => ({ ...lineOut({ item: l.item, qty: l.shipped }), shipped: l.shipped, received: l.received, diff: r2(l.received - l.shipped), reason: l.reason })) };
}
const pJson = (p) => ({ ...p, item: item(p.item_id).name, unit: item(p.item_id).unit, location: locName(p.location_id), components_count: p.lines.length,
  lines: p.lines.map((l) => ({ component_id: l.c, component: item(l.c).name, unit: item(l.c).unit, per_unit: l.per, qty: l.qty, stock_at: l.stock_at })) });
const enough = (loc, it, q) => { if (bal(loc, it) < q) throw new Error(`Stok ${item(it).name} di ${locName(loc)} hanya ${bal(loc, it)} ${item(it).unit}. Catat barang masuk, produksi atau penyesuaian dulu.`); };

function transfer(a, kind, d = today, by = 'Glenn') {
  const t = { id: transfers.length + 1, no: no(kind === 'langsung' ? 'ST' : 'TO', d), kind, from_id: Number(a.p_from), to_id: Number(a.p_to), day: d, needed_by: a.p_needed_by || null, note: a.p_note || null,
    status: kind === 'langsung' ? 'selesai' : 'dibuka', by, lines: a.p_lines.map((l) => ({ item: Number(l.item), qty: Number(l.qty), stock_at: bal(a.p_from, l.item) })) };
  if (t.from_id === t.to_id) throw new Error('Lokasi asal dan tujuan harus berbeda.');
  if (kind === 'langsung') t.lines.forEach((l) => { enough(t.from_id, l.item, l.qty); put(t.from_id, l.item, 'pindah', -l.qty, d, t.no, `Stok transfer ${t.no}`, by, 7); put(t.to_id, l.item, 'pindah', l.qty, d, t.no, `Stok transfer ${t.no}`, by, 7); });
  transfers.push(t); return t;
}
function ship(tid, lines, d = today, note = null) {
  const t = transfers.find((x) => x.id === Number(tid));
  const s = { id: shipments.length + 1, no: no('SJ', d), transfer_id: t.id, day: d, at: iso(d, 8), note, status: 'dalam_perjalanan', by: 'Glenn', lines: lines.map((l) => ({ item: Number(l.item), qty: Number(l.qty) })) };
  s.lines.forEach((l) => { enough(t.from_id, l.item, l.qty); put(t.from_id, l.item, 'pindah', -l.qty, d, s.no, `Surat jalan ${s.no}`, 'Glenn', 8); });
  shipments.push(s); refresh(t); return s;
}
function receive(sid, lines, d = today, note = null) {
  const s = shipments.find((x) => x.id === Number(sid)), t = transfers.find((x) => x.id === s.transfer_id);
  const r = { id: receipts.length + 1, no: no('PT', d), shipment_id: s.id, day: d, at: iso(d, 10), note, by: 'Ranny',
    lines: s.lines.map((l) => { const g = (lines || []).find((x) => Number(x.item) === l.item); const got = g ? Number(g.received) : l.qty;
      if (got !== l.qty && !(g?.reason || '').trim()) throw new Error(`Tulis alasan selisih untuk ${item(l.item).name}.`);
      return { item: l.item, shipped: l.qty, received: got, reason: g?.reason || null }; }) };
  r.lines.forEach((l) => put(t.to_id, l.item, 'pindah', l.received, d, r.no, `Penerimaan transfer ${r.no}`, 'Ranny', 10));
  s.status = 'diterima'; receipts.push(r); refresh(t); return r;
}
function produce(a, d = today) {
  const comp = recipes[a.p_item]; if (!comp) throw new Error(`${item(a.p_item).name} belum punya resep produksi. Atur dulu di Resep produksi.`);
  const q = Number(a.p_qty), loc = Number(a.p_location), prod = a.p_kind === 'produksi';
  if (prod) comp.forEach(([c, per]) => enough(loc, c, r2(per * q))); else enough(loc, a.p_item, q);
  const p = { id: productions.length + 1, no: no(prod ? 'PR' : 'BP', d), kind: a.p_kind, item_id: Number(a.p_item), qty: q, location_id: loc, day: d, at: iso(d, 6), note: a.p_note || null, by: 'Glenn',
    lines: comp.map(([c, per]) => ({ c, per, qty: r2(per * q), stock_at: bal(loc, c) })) };
  p.lines.forEach((l) => put(loc, l.c, a.p_kind, prod ? -l.qty : l.qty, d, p.no, `${prod ? 'Produksi' : 'Bongkar produksi'} ${p.no}`, 'Glenn', 6));
  put(loc, p.item_id, a.p_kind, prod ? q : -q, d, p.no, `${prod ? 'Produksi' : 'Bongkar produksi'} ${p.no}`, 'Glenn', 6);
  productions.push(p); return p;
}

// a believable history
const VAN = byCode('vla_vanilla').id, MAT = byCode('vla_matcha').id, MINI = byCode('mini').id, SIG = byCode('sig').id;
produce({ p_kind: 'produksi', p_item: VAN, p_qty: 3000, p_location: 2 }, dayAgo(9));
produce({ p_kind: 'produksi', p_item: MAT, p_qty: 1500, p_location: 2, p_note: 'Batch matcha' }, dayAgo(6));
produce({ p_kind: 'bongkar', p_item: MAT, p_qty: 200, p_location: 2, p_note: 'Salah takar, diulang' }, dayAgo(6));
produce({ p_kind: 'produksi', p_item: VAN, p_qty: 2000, p_location: 2 }, dayAgo(2));
[8, 6, 4, 3, 1].forEach((d, i) => transfer({ p_from: 2, p_to: 1, p_lines: [{ item: MINI, qty: 60 + i * 5 }, { item: SIG, qty: 12 }], p_note: i === 0 ? 'Pagi' : null }, 'langsung', dayAgo(d)));
transfer({ p_from: 2, p_to: 1, p_lines: [{ item: VAN, qty: 1500 }] }, 'langsung', dayAgo(2));
const to1 = transfer({ p_from: 2, p_to: 1, p_lines: [{ item: MINI, qty: 150 }, { item: VAN, qty: 1000 }, { item: MAT, qty: 600 }], p_note: 'Untuk akhir pekan' }, 'order', dayAgo(5));
receive(ship(to1.id, [{ item: MINI, qty: 90 }, { item: VAN, qty: 1000 }], dayAgo(5), 'Motor Fajar').id, [{ item: MINI, received: 87, reason: '3 pecah di jalan' }], dayAgo(5));
ship(to1.id, [{ item: MINI, qty: 60 }, { item: MAT, qty: 400 }], dayAgo(1), 'Motor Fajar');
const to2 = transfer({ p_from: 2, p_to: 1, p_lines: [{ item: SIG, qty: 30 }], p_needed_by: today }, 'order', today);
ship(to2.id, [{ item: SIG, qty: 18 }], today);
transfer({ p_from: 1, p_to: 2, p_lines: [{ item: byCode('dus_besar').id, qty: 20 }], p_note: 'Dus untuk kirim pesanan dari dapur' }, 'order', today);
const to4 = transfer({ p_from: 2, p_to: 1, p_lines: [{ item: MINI, qty: 40 }] }, 'order', dayAgo(3));
to4.status = 'batal'; to4.cancelled_by = 'Glenn'; to4.cancel_reason = 'Diganti stok transfer langsung';

const inRange = (x, a) => x.day >= a.p_from && x.day <= a.p_to;
const ROWS = ['pembelian', 'masuk', 'keluar', 'pindah', 'penyesuaian', 'penjualan', 'produksi', 'bongkar'];

export function produksiFake(name, a = {}) {
  switch (name) {
    case 'stock_location_list': return LOCS.map((l) => ({ ...l, is_booth: l.code === 'booth', items_in_stock: ITEMS.filter((i) => bal(l.id, i.id)).length,
      in_transit_out: shipments.filter((s) => s.status === 'dalam_perjalanan' && transfers.find((t) => t.id === s.transfer_id).from_id === l.id).length,
      in_transit_in: shipments.filter((s) => s.status === 'dalam_perjalanan' && transfers.find((t) => t.id === s.transfer_id).to_id === l.id).length }));
    case 'stock_location_stock': { const l = LOCS.find((x) => x.id === Number(a.p_location)); return { location: { id: l.id, name: l.name, is_booth: l.code === 'booth' }, items: ITEMS.map((i) => ({ ...i, qty: bal(l.id, i.id), has_recipe: !!recipes[i.id] })) }; }
    case 'stock_location_save': { if (a.p_id) Object.assign(LOCS.find((l) => l.id === a.p_id), { name: a.p_name, note: a.p_note }); else LOCS.push({ id: LOCS.length + 1, code: null, name: a.p_name, note: a.p_note, active: true }); return { ok: true }; }
    case 'stock_location_set_active': { const l = LOCS.find((x) => x.id === a.p_id); if (l.code === 'booth') throw new Error('Booth adalah lokasi utama dan tidak bisa dimatikan.'); l.active = a.p_active; return l; }
    case 'stock_location_adjust': { const before = bal(a.p_location, a.p_item), d = a.p_mode === 'set' ? a.p_qty - before : a.p_qty; put(Number(a.p_location), Number(a.p_item), 'penyesuaian', d, today, null, a.p_reason); return { item: item(a.p_item).name, unit: item(a.p_item).unit, before, after: before + d, delta: d }; }
    case 'stock_transfer_list': return transfers.filter((t) => inRange(t, a) && (!a.p_kind || t.kind === a.p_kind)).map(tJson).reverse();
    case 'stock_transfer_detail': return tJson(transfers.find((t) => t.id === a.p_id));
    case 'stock_transfer_open': return transfers.filter((t) => t.kind === 'order' && ['dibuka', 'sebagian'].includes(t.status)).map(tJson);
    case 'stock_transfer_create': return tJson(transfer(a, 'langsung', a.p_day || today));
    case 'stock_transfer_order_create': return tJson(transfer(a, 'order'));
    case 'stock_transfer_order_cancel': { const t = transfers.find((x) => x.id === a.p_id); if (!a.p_reason) throw new Error('Tulis alasan pembatalannya.'); Object.assign(t, { status: 'batal', cancelled_by: 'Glenn', cancel_reason: a.p_reason }); return tJson(t); }
    case 'stock_shipment_create': return sJson(ship(a.p_transfer, a.p_lines, today, a.p_note));
    case 'stock_shipment_cancel': { const s = shipments.find((x) => x.id === a.p_id), t = transfers.find((x) => x.id === s.transfer_id); if (!a.p_reason) throw new Error('Tulis alasan pembatalannya.');
      Object.assign(s, { status: 'batal', cancelled_by: 'Glenn', cancel_reason: a.p_reason }); s.lines.forEach((l) => put(t.from_id, l.item, 'pindah', l.qty, today, s.no, `Batal surat jalan ${s.no}`)); refresh(t); return sJson(s); }
    case 'stock_shipment_list': return shipments.filter((s) => inRange(s, a)).map(sJson).reverse();
    case 'stock_in_transit': return shipments.filter((s) => s.status === 'dalam_perjalanan').map(sJson);
    case 'stock_transfer_receive': return rJson(receive(a.p_shipment, a.p_lines, today, a.p_note));
    case 'stock_receipt_list': return receipts.filter((r) => inRange(r, a)).map(rJson).reverse();
    case 'stock_production_recipes': return { items: ITEMS.map((i) => ({ ...i, active: true })),
      recipes: Object.entries(recipes).map(([id, comp]) => ({ item_id: Number(id), item: item(id).name, unit: item(id).unit, components_count: comp.length,
        components: comp.map(([c, q]) => ({ component_id: c, component: item(c).name, unit: item(c).unit, qty: q })) })) };
    case 'stock_production_recipe_save': { if (!a.p_lines.length) delete recipes[a.p_item]; else recipes[a.p_item] = a.p_lines.map((l) => [Number(l.item), Number(l.qty)]); return { ok: true }; }
    case 'stock_production_preview': { const comp = recipes[a.p_item] || [], q = Number(a.p_qty) || 0, loc = Number(a.p_location), prod = a.p_kind === 'produksi';
      const cs = comp.map(([c, per]) => ({ component_id: c, component: item(c).name, unit: item(c).unit, per_unit: per, qty: r2(per * q), stock: bal(loc, c), enough: !prod || bal(loc, c) >= r2(per * q) }));
      return { kind: a.p_kind, item: item(a.p_item).name, unit: item(a.p_item).unit, qty: q, location: locName(loc), item_stock: bal(loc, a.p_item), has_recipe: !!comp.length,
        enough: prod ? cs.every((c) => c.enough) : bal(loc, a.p_item) >= q, components: cs }; }
    case 'stock_production_create': return pJson(produce(a, a.p_day || today));
    case 'stock_production_list': return productions.filter((p) => inRange(p, a) && (!a.p_kind || p.kind === a.p_kind)).map(pJson).reverse();
    case 'stock_card_summary': { const loc = Number(a.p_location);
      return { rows: ITEMS.map((i) => { const ms = moves.filter((m) => m.loc === loc && m.item === i.id && m.day <= a.p_to); const r = { item_id: i.id, item: i.name, unit: i.unit,
        opening: r2(ms.filter((m) => m.day < a.p_from).reduce((s, m) => s + m.qty, 0)), closing: r2(ms.reduce((s, m) => s + m.qty, 0)), moves: ms.filter((m) => m.day >= a.p_from).length };
        ROWS.forEach((k) => { r[k] = r2(ms.filter((m) => m.day >= a.p_from && m.col === k).reduce((s, m) => s + m.qty, 0)); }); return r; })
        .filter((r) => a.p_all || r.opening || r.closing || r.moves) }; }
    case 'stock_card': { const loc = Number(a.p_location), it = Number(a.p_item); const op = bal(loc, it, dayAgoStr(a.p_from)); let run = op; const totals = {};
      const rows = moves.filter((m) => m.loc === loc && m.item === it && m.day >= a.p_from && m.day <= a.p_to).sort((x, y) => x.at.localeCompare(y.at))
        .map((m, k) => { run = r2(run + m.qty); totals[m.col] = r2((totals[m.col] || 0) + m.qty); return { key: 'd' + k, at: m.at, day: m.day, col: m.col, qty: m.qty, doc_no: m.doc, reason: m.reason, by: m.by, balance: run }; });
      return { location: { id: loc, name: locName(loc) }, item: { id: it, name: item(it).name, unit: item(it).unit }, from: a.p_from, to: a.p_to, opening: op, closing: run, totals, rows }; }
    default: return undefined;
  }
}
function dayAgoStr(from) { const d = new Date(from + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }

