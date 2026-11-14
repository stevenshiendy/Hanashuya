// Demo only (_demo-reservasi.html): Pesanan di muka, deposit and koreksi stempel with fake replies.
// #pesanan, #pesanan-baru, #pesanan-detail, #mutasi, #deposit, #stempel, #stempel-baru, #till, #till-ambil
import { mountReservasi } from '../js/owner-reservasi.js';
import { openReservations } from '../js/till-reservasi.js';
import { rupiah } from '../js/lib.js';
import { reservasiFake, STAFF } from './reservasi-data.js';
async function rpc(name, a = {}) { const r = await reservasiFake(name, a); if (r === undefined) throw new Error('Demo: ' + name); return r; }

const PARTS = [['pesanan', 'Pesanan di muka'], ['mutasi', 'Mutasi deposito'], ['deposit', 'Deposit reservasi'], ['stempel', 'Koreksi stempel'], ['till', 'Kasir']];
const cur = () => location.hash.slice(1) || 'pesanan';
const click = (sel, n = 0) => { const el = document.querySelector(sel); if (el) el.click(); else if (n < 50) setTimeout(() => click(sel, n + 1), 100); };
async function show() {
  const [part, sub] = cur().split('-');
  document.getElementById('tabs').innerHTML = PARTS.map(([k, l]) => `<a class="btn ${k === part ? '' : 'btn-quiet'}" href="#${k}">${l}</a>`).join('');
  const panel = document.getElementById('panel');
  if (part === 'till') {
    panel.innerHTML = '<div class="panel stack"><p>Tombol di Dashboard kasir:</p><button class="btn" type="button" id="open">Pesanan di muka</button><p id="paid" class="notice" hidden></p></div>';
    const open = () => openReservations({ rpc, staff: STAFF, qrisImg: 'img/qris-hanashuya.jpg', onPaid: (r) => { const p = document.getElementById('paid'); p.hidden = false; p.textContent = `Dibayar: ${r.receipt_no}, ${rupiah(r.total)}`; } }).catch((e) => { const p = document.getElementById('paid'); p.hidden = false; p.textContent = e.message + ' ' + e.stack; });
    document.getElementById('open').addEventListener('click', open);
    if (sub === 'ambil') { open(); click('[data-pick="0"]'); }
    return;
  }
  await mountReservasi(panel, { rpc, part });
  if (sub === 'baru') click('[data-add]');
  if (sub === 'detail') click('tbody tr[data-k]');
}
addEventListener("error", (e) => console.log("ERR", e.message)); addEventListener("unhandledrejection", (e) => console.log("REJ", e.reason && e.reason.stack)); addEventListener("hashchange", show); show();
