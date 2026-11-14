// Demo only: the helpers of js/lib.js plus a fake rpc with sample stock data.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TZ = 'Asia/Jakarta';
export const rupiah = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
export const when = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export const day = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
export const time = (iso) => new Intl.DateTimeFormat('id-ID', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
export function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; if (label) btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
}

export function notice(el, msg, kind = 'error') {
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.className = 'notice notice-' + kind;
  el.textContent = msg;
  el.hidden = false;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

let toastTimer;
export function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}


import * as V from './sample-views.js';
import { data, STAFF } from './sample-data.js';

// Everything below comes from the shared sample data set (sample-data.js): 60 days of orders feed the
// deductions, so stock in/out agrees with the sales reports.
const q = new URLSearchParams(location.search);
const T = new Date().toISOString();
const duty = V.onDuty();
const meId = duty.some((x) => x.id === 's-ranny') ? 's-ranny' : 's-fajar';
const suppliers = V.SUPPLIERS;
const catalog = () => ({ role: q.get('role') || 'manager', items: V.stockItems(), suppliers: [{ id: 99, name: 'Hanashuya' }, ...suppliers.filter((x) => x.active).map(({ id, name }) => ({ id, name }))],
  staff: [...STAFF.map((s) => ({ id: s.id, name: s.name, is_me: s.id === meId, on_duty: duty.some((d) => d.id === s.id) })), { id: 'o-glenn', name: 'Glenn', on_duty: false }] });
export async function rpc(name, args = {}) {
  switch (name) {
    case 'stock_catalog': return catalog();
    case 'stock_now': return V.stockItems();
    case 'stock_today': return V.stockToday();
    case 'stock_goods_in_list': return V.goodsInList(args);
    case 'stock_opname_list': return V.opnameList(args);
    case 'stock_opname_detail': return V.opnameDetail(args);
    case 'stock_count_pending': return V.countPending();
    case 'stock_request_list': return V.requestsIn(args);
    case 'stock_request_open': return V.requestsOpen();
    case 'stock_report': return V.stockReport(args);
    case 'owner_stock_recipes': return V.recipes();
    case 'stock_low': return V.stockItems().filter((i) => i.low);
    case 'stock_supplier_list': return suppliers.map((x) => ({ ...x, used: x.id === 2 ? 14 : 31 }));
    case 'stock_supplier_save': {
      if (!String(args.p_name || '').trim()) throw new Error('Isi nama pemasok (paling panjang 60 huruf).');
      if (suppliers.some((x) => x.name.toLowerCase() === args.p_name.trim().toLowerCase() && x.id !== args.p_id)) throw new Error('Nama pemasok ini sudah ada.');
      const row = { id: args.p_id || Math.max(...suppliers.map((x) => x.id)) + 1, name: args.p_name.trim(), phone: args.p_phone || null, address: args.p_address || null, note: args.p_note || null, active: args.p_active !== false };
      const at = suppliers.findIndex((x) => x.id === row.id);
      if (at >= 0) suppliers[at] = row; else suppliers.push(row);
      return row;
    }
    case 'stock_supplier_set_active': { const x = suppliers.find((y) => y.id === args.p_id); x.active = !!args.p_active; return { id: x.id, name: x.name, active: x.active }; }
    case 'stock_goods_in_batch': {
      const items = V.stockItems();
      return args.p_lines.map((l, n) => { const i = items.find((x) => x.id === l.item); return { id: 900 + n, item: i.name, unit: i.unit, qty: l.qty }; });
    }
    case 'stock_cancel_request': return { id: 1, status: 'menunggu' };
    case 'stock_cancel_goods_in': case 'stock_cancel_out': return { id: args.p_id };
    case 'stock_request_create': {
      const items = V.stockItems(), d = data();
      const lines = args.p_lines.map((l) => { const i = items.find((x) => x.id === l.item); return { item_id: i.id, item: i.name, unit: i.unit, qty: l.qty, stock_at: i.qty, received: 0 }; });
      return { id: 9, no: 'PB-' + d.today.slice(2).replace(/-/g, '') + '-02', day: d.today, at: new Date().toISOString(), needed_by: args.p_needed_by, supplier_id: args.p_supplier || null, supplier: (suppliers.find((x) => x.id === args.p_supplier) || {}).name || null, status: 'dikirim', by: 'Ranny', responsible: 'Ranny', note: args.p_note, lines };
    }
  }
  return { item: 'Mini Choux', unit: 'pcs', qty: 1, kind: 'sampel', besar: 13, kecil: 28 };
}
