// Demo only: taps through js/till.js to the screen named in ?s= (for screenshots).
// s1 s2a s2b s3 s4 s5 s6 pick find join today close closed cash void (add &rasa=inplace for s2b).
const s = new URLSearchParams(location.search).get('s') || '';
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function el(sel) { for (let i = 0; i < 100; i++) { const e = document.querySelector(sel); if (e) return e; await wait(50); } throw new Error('demo: ' + sel); }
const tap = async (sel) => { (await el(sel)).click(); await wait(450); };
const act = (a, extra = '') => tap(`[data-act="${a}"]${extra}`);
async function member() {
  await act('find');
  (await el('#tl-code')).value = 'K7PX-3MQ9';
  (await el('#tl-code-form')).requestSubmit(); await wait(500);
}
async function add(code, fl) {
  await act('tile', `[data-code="${code}"]`);
  await act('flavour', `[data-v="${fl}"]`);
  if (document.querySelector('[data-act="pick-add"]')) await act('pick-add');
  else if (document.querySelector('[data-act="pick-close"]')) await act('pick-close');
}
async function order() { await member(); await add('mini15', 'matcha'); await add('sig1', 'vanilla'); }
async function placed() { await order(); await act('promo'); await act('promo-line', '[data-i="1"]'); await act('confirm'); await wait(300); }
(async () => {
  await el('.hm-tools, #tl-open');
  await wait(400);
  // The till opens on the home screen; ?s=home, home-orders and stock stay there.
  if (s === 'home-orders') await act('chart', '[data-v="orders"]');
  if (s === 'stock') await act('stock');
  if (s === 'approve') await act('approve');
  if (s && !['home', 'home-orders', 'stock', 'approve', 'close', 'closed', 'closed-80'].includes(s) && document.querySelector('[data-act="sell"]')) await act('sell');
  if (s === 's1') await order();
  if (s === 's2a' || s === 's2b') {
    await member(); await add('sig1', 'vanilla');
    await act('tile', '[data-code="mini15"]'); await act('flavour', '[data-v="matcha"]');
  }
  if (s === 'pick') { await order(); await act('promo'); }
  if (s === 'promo') { await add('mini15', 'vanilla'); await act('promo', '[data-key="promo:1"]'); }
  if (s === 'today-q') { await tap('#tl-today'); const i = await el('#tl-today-q'); i.value = 'rina'; i.dispatchEvent(new Event('input', { bubbles: true })); await wait(200); }
  if (s === 'find') await act('find');
  if (s === 'join') { await act('find'); await act('join'); }
  if (s === 's3') await placed();
  if (s === 's4') { await placed(); await act('to-qris'); }
  if (s === 's5' || s === 's6') { await placed(); await act('to-cash'); await act('cash', '[data-v="150000"]'); }
  if (s === 's6') await act('pay-cash');
  if (s === 'void') { await placed(); await act(document.querySelector('[data-act="cancel-order"]') ? 'cancel-order' : 'ask-void'); }
  if (s === 'today') await tap('#tl-today');
  // Tutup shift: count the drawer with the steppers (blind for staff), then close.
  if (s === 'close' || s.startsWith('closed')) {
    await act('home-close');
    const plus = async (d, n) => { for (let i = 0; i < n; i++) { (await el(`[data-act="den"][data-v="${d}"][data-d="1"]`)).click(); } };
    // Count what the sample drawer should hold (a little under, so the demo shows a small selisih).
    const { shiftJson, currentShift } = await import('./sample-views.js');
    let left = Math.floor((shiftJson(currentShift(), true).expected_cash - 2000) / 1000) * 1000;
    for (const d of [100000, 50000, 20000, 10000, 5000, 2000, 1000]) { const n = Math.min(Math.floor(left / d), d === 100000 ? 8 : d === 1000 ? 4 : 5); await plus(String(d), n); left -= n * d; }
    await wait(200);
    if (s.startsWith('closed')) {
      if (s === 'closed-80') localStorage.setItem('hs-till-paper', '80');
      (await el('#tl-close-form')).requestSubmit(); await wait(900);
    }
  }
  if (s === 'cash') await tap('#tl-cash');
  document.body.dataset.ready = '1';
})();
