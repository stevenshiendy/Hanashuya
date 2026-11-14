// Service worker for the till only (scope ./kasir, which covers /member/kasir and the old
// /member/kasir.html), so the till opens with no internet
// (POSDEVELOPMENT.md task 7). Same-site files are fetched from the network first and kept;
// when the network fails the kept copy is used. Supabase calls are never touched: the till
// queues offline sales itself (js/till-offline.js).
//
// The scripts from cdn.jsdelivr.net have their version in the address, so they never change:
// they are kept at install and served from the cache first. That includes every module the
// Supabase client imports (13 Nov 2026): supabase-js@2.45.4/+esm loads the six @supabase
// modules below. Before, only the top file was kept, so a fresh install (or a new cache
// version) left the till stuck on its loading screen offline. When supabase-js is upgraded in
// js/lib.js, list its imports again (open its +esm file and copy every "/npm/..." it names)
// and bump CACHE.
// Addresses have no .html (cleanUrls, 14 Nov 2026). The kept page is 'kasir' (a direct 200): a
// redirected answer, such as kasir.html is now, cannot be used for a navigation. The offline
// fallback below serves it for both addresses.
const CACHE = 'hs-kasir-v12';
const CDN = 'https://cdn.jsdelivr.net';
const SB = `${CDN}/npm/@supabase`;
const VENDOR = [
  `${SB}/supabase-js@2.45.4/+esm`,
  `${SB}/functions-js@2.4.1/+esm`, `${SB}/postgrest-js@1.16.1/+esm`, `${SB}/realtime-js@2.10.2/+esm`,
  `${SB}/storage-js@2.7.0/+esm`, `${SB}/auth-js@2.65.0/+esm`, `${SB}/node-fetch@2.6.15/+esm`,
  `${CDN}/npm/jsqr@1.4.0/dist/jsQR.min.js`, `${CDN}/npm/qrcode-generator@1.4.4/qrcode.min.js`,
  `${CDN}/npm/jspdf@2.5.1/dist/jspdf.umd.min.js`,
];
const SHELL = [
  'kasir', 'kasir.webmanifest', 'css/app.css', 'css/tokens.css', 'css/base.css', 'fonts/fonts.css',
  'js/till.js', 'js/till-offline.js', 'js/lib.js', 'js/config.js', 'js/receipt.js', 'js/receipt-fast.js', 'js/escpos.js',
  'js/printer.js', 'js/native.js', 'js/stock.js', 'js/approvals.js', 'js/receipt-rekap.js', 'js/pdf.js', 'js/print-samples.js', 'js/till-reservasi.js', 'js/data-table.js',
  'img/qris-hanashuya.jpg', 'img/receipt-logo-58.png', 'img/receipt-logo-80.png', 'img/receipt-logo-red.svg',
  'fonts/dmsans.woff2', 'fonts/cinzel.woff2',
  ...VENDOR,
];

self.addEventListener('install', (e) => {
  // One missing file must not stop the rest being kept.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('hs-kasir-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || (u.origin !== location.origin && u.origin !== CDN) || u.pathname.startsWith('/api/')) return;
  // Versioned CDN files: the kept copy first, the network only when it is missing.
  if (u.origin === CDN) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))).catch(() => Response.error()));
    return;
  }
  e.respondWith(fetch(req).then((res) => keep(req, res))
    .catch(() => caches.match(req, { ignoreSearch: true })
      .then((hit) => hit || (req.mode === 'navigate' ? caches.match('kasir') : null))
      .then((hit) => hit || Response.error())));
});
