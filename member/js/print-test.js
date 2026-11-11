// cetak-uji.html: test the approved receipt design on the booth printer, apart from the till.
// Draws a sample receipt with receipt.js, shows it as the thermal printer will (1-bit),
// and prints it by Bluetooth (ESC/POS raster), through Chrome's print dialog, or as a PNG.
import { receiptCanvas } from './receipt.js';
import { renderFull, toBits } from './escpos.js';
import { SAMPLES } from './print-samples.js';
import { configured, rpc, esc, prettyPhone, mountLogin, setupMissing, session, signOut } from './lib.js';

const $ = (s) => document.querySelector(s);
let current = null; // { canvas, mode, dots }

function sample(key) {
  const S = structuredClone(SAMPLES);
  if (key === 'qris') return { ...S.walk, payment_method: 'qris', cash_received: null, change: null };
  if (key === 'grab') {
    return { ...S.walk, channel: 'grabfood', channel_label: 'GrabFood', payment_method: 'platform', cash_received: null, change: null,
      lines: [...S.walk.lines, { name: 'Paper bag', flavour: null, qty: 1, line_total: 0, free_bag: true }] };
  }
  if (key === 'long') {
    const r = S.member;
    r.lines = [{ name: 'Mini Box isi 15', flavour: 'Matcha Strawberry', qty: 2, line_total: 204000 }, ...r.lines];
    r.subtotal += 204000; r.total += 204000;
    return r;
  }
  return S[key];
}

function readOpts() {
  const paper = new FormData($('#opts')).get('paper');
  const r = sample($('#sample').value);
  const m = $('#member').value.trim(), k = $('#kasir').value.trim();
  if (r.member && m) r.member = m;
  if (k) r.served_by = k;
  r.sold_at = new Date().toISOString();
  return { r, mode: paper === 'wa' ? 'wa' : 'print', dots: paper === 'wa' ? 384 : +paper };
}

// What the thermal head prints: every pixel black or white.
function monoCanvas(src, dither) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  const im = src.getContext('2d').getImageData(0, 0, src.width, src.height);
  const bits = toBits({ width: im.width, height: im.height, data: im.data }, { dither });
  const out = ctx.createImageData(c.width, c.height);
  for (let p = 0; p < bits.length; p++) { // toBits: one entry per pixel, 1 = black
    const i = p * 4;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = bits[p] ? 0 : 255; out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return c;
}

async function draw() {
  const { r, mode, dots } = readOpts();
  const canvas = await receiptCanvas(r, { mode, dots });
  current = { canvas, mode, dots };
  const showMono = mode === 'print' && $('#mono').checked;
  const shown = showMono ? monoCanvas(canvas, $('#dither').checked) : canvas;
  const view = $('#view');
  view.width = shown.width; view.height = shown.height;
  view.getContext('2d').drawImage(shown, 0, 0);
  view.style.width = mode === 'wa' ? '480px' : shown.width + 'px';
  const mm = mode === 'wa' ? null : Math.round(canvas.height / 8);
  $('#facts').innerHTML = mode === 'wa'
    ? `<span>Gambar WhatsApp ${canvas.width} × ${canvas.height} px</span>`
    : `<span>Lebar cetak ${dots} titik (${dots / 8} mm)</span><span>Panjang kira-kira ${mm} mm kertas</span><span>Printer 203 dpi = 8 titik per mm</span>`;
  for (const id of ['#bt', '#print', '#cut', '#drawer', '#mono', '#dither']) $(id).disabled = mode === 'wa';
}

function say(text, kind = 'ok') {
  const s = $('#status');
  s.hidden = false; s.className = `notice notice-${kind}`; s.textContent = text;
}

// ---- Bluetooth (BLE GATT). Common thermal-printer services; none verified on the booth printer yet.
const SERVICES = [
  0x18f0, 0xff00, 0xffe0, 0xfee7, 0xae30,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
];
let device = null;  // the printer picked in Chrome's Bluetooth list (kept, so a retry needs no new pick)
let printer = null; // { ch, name, svc, uuid }: the writable characteristic while connected
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Finds a characteristic the printer accepts data on. Tries the list of all services
// first, then each known printer service one by one (some printers only answer that way).
async function findWritable(gatt) {
  let services = [];
  try { services = await gatt.getPrimaryServices(); } catch { services = []; }
  if (!services.length) {
    for (const id of SERVICES) {
      try { services.push(await gatt.getPrimaryService(id)); } catch { /* not on this printer */ }
    }
  }
  for (const svc of services) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch { continue; }
    for (const ch of chars) {
      if (ch.properties.writeWithoutResponse || ch.properties.write) return { ch, svc: svc.uuid, uuid: ch.uuid };
    }
  }
  return null;
}

// Android often drops the first GATT connection; try three times with a short pause.
async function connect() {
  if (!navigator.bluetooth) throw new Error('Browser ini tidak bisa Bluetooth. Pakai Chrome di tablet Android, atau cetak lewat Chrome / gambar PNG.');
  if (!device) {
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    device.addEventListener('gattserverdisconnected', () => { printer = null; });
  }
  const name = device.name || 'printer';
  let found = null, last = null;
  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    try {
      say(`Menyambung ke ${name} (percobaan ${attempt} dari 3)...`);
      const gatt = await device.gatt.connect();
      await wait(600); // let the printer settle before asking for its services
      if (!gatt.connected) throw new Error('terputus');
      found = await findWritable(gatt);
      if (!found) { last = new Error('tanpa jalur tulis'); break; }
    } catch (e) {
      last = e;
      try { device.gatt.disconnect(); } catch { /* already closed */ }
      await wait(1000);
    }
  }
  if (!found) {
    if (last && last.message === 'tanpa jalur tulis') {
      throw new Error(`${name} tersambung, tapi tidak menerima data lewat Bluetooth LE. Kemungkinan printer ini memakai Bluetooth klasik. Kirim nama dan tipe printernya ke Claude.`);
    }
    throw new Error(`${name} memutus sambungan. Biasanya karena printer masih tersambung ke aplikasi lain (misalnya VireoPOS) atau ke Bluetooth tablet. Putuskan sambungan itu, matikan lalu nyalakan printer, lalu tekan Cetak lagi. Detail: ${last ? last.message : '-'}`);
  }
  printer = { ...found, name };
  return printer;
}

// Paced sending (12 Nov 2026): at 180 bytes every 15 ms the printer's buffer overflowed,
// bytes were lost, and the rest of the picture printed as garbage text. Send small chunks,
// wait for the printer's answer when it offers one, and pause between chunks otherwise.
async function send(bytes, onProgress) {
  const { ch } = printer;
  const chunk = 100;
  const withResponse = ch.properties.write;
  for (let i = 0; i < bytes.length; i += chunk) {
    const part = bytes.slice(i, i + chunk);
    if (withResponse) await ch.writeValueWithResponse(part);
    else { await ch.writeValueWithoutResponse(part); await wait(40); }
    if (onProgress && (i / chunk) % 20 === 0) onProgress(Math.round((i / bytes.length) * 100));
  }
}

async function printBluetooth() {
  const btn = $('#bt'); btn.setAttribute('aria-busy', 'true');
  try {
    if (!device) say('Pilih printer di jendela Bluetooth.');
    if (!printer || !device.gatt.connected) await connect();
    const { canvas } = current;
    const im = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const bytes = renderFull({ width: im.width, height: im.height, data: im.data },
      { dither: $('#dither').checked, cut: $('#cut').checked, drawer: $('#drawer').checked });
    const t = performance.now();
    say(`Mengirim ke ${printer.name}...`);
    await send(bytes, (pct) => say(`Mengirim ke ${printer.name}... ${pct}%`));
    say(`Terkirim ke ${printer.name}: ${Math.round(bytes.length / 1024)} KB dalam ${((performance.now() - t) / 1000).toFixed(1)} detik. Jalur ${printer.svc} / ${printer.uuid}.`);
  } catch (e) {
    if (e && e.name === 'NotFoundError') { device = null; say('Tidak ada printer yang dipilih.', 'warn'); }
    else say(e.message || String(e), 'error');
  } finally { btn.removeAttribute('aria-busy'); }
}

// Pick a different printer next time.
function forgetPrinter() {
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch { /* ignore */ }
  device = null; printer = null;
  say('Printer dilupakan. Tekan Cetak ke printer Bluetooth untuk memilih lagi.');
}

// ---- Chrome print dialog: the page prints only the receipt image, at the paper's width.
function printChrome() {
  const { canvas, dots } = current;
  const paperMm = dots === 576 ? 80 : 58, printMm = dots / 8;
  let img = $('#printimg');
  if (!img) { img = document.createElement('img'); img.id = 'printimg'; img.className = 'pt-print'; img.alt = 'Struk'; document.body.append(img); }
  img.src = canvas.toDataURL('image/png');
  img.style.width = printMm + 'mm';
  let st = document.getElementById('page-size');
  if (!st) { st = document.createElement('style'); st.id = 'page-size'; document.head.append(st); }
  st.textContent = `@page { size: ${paperMm}mm ${Math.ceil(canvas.height / 8) + 6}mm; margin: 0 }`;
  img.decode().then(() => window.print());
}

function savePng() {
  const { canvas, mode, dots } = current;
  canvas.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = mode === 'wa' ? 'struk-hanashuya-whatsapp.png' : `struk-hanashuya-${dots === 576 ? 80 : 58}mm.png`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    say('Gambar disimpan.');
  }, 'image/png');
}

// Owner only (Glenn, 11 Nov 2026): the page opens from Pengaturan in the owner dashboard.
const app = $('#app');
async function start() {
  if (!configured) return setupMissing(app);
  if (!(await session())) return mountLogin(app, { staff: true, title: 'Uji cetak struk', lead: 'Masuk dengan username atau nomor WhatsApp dan password pemilik.', onDone: boot });
  boot();
}
async function boot() {
  $('#logout').hidden = false;
  const who = await rpc('whoami').catch(() => null);
  if (!who || who.role !== 'owner') {
    app.innerHTML = `<section class="panel stack"><h1>Khusus pemilik</h1><p>Akun ${esc(prettyPhone(who?.whatsapp) || 'ini')} bukan akun pemilik. Halaman uji cetak hanya untuk pemilik.</p></section>`;
    return;
  }
  app.hidden = true;
  $('#tool').hidden = false;
  $('#to-owner').hidden = false;
  $('#opts').addEventListener('input', () => { draw().catch((e) => say(e.message, 'error')); });
  $('#opts').addEventListener('submit', (e) => e.preventDefault());
  $('#bt').addEventListener('click', printBluetooth);
  $('#bt-forget').addEventListener('click', forgetPrinter);
  $('#print').addEventListener('click', printChrome);
  $('#png').addEventListener('click', savePng);
  $('#member').value = 'Desi';
  $('#kasir').value = 'Ranny';
  draw().catch((e) => say(e.message, 'error'));
}
$('#logout').addEventListener('click', signOut);
start();
