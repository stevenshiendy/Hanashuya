// cetak-uji.html: test the approved receipt design on the booth printer, apart from the till.
// Draws a sample receipt with receipt.js, shows it as the thermal printer will (1-bit),
// and prints it by Bluetooth (ESC/POS raster), through Chrome's print dialog, or as a PNG.
import { receiptCanvas } from './receipt.js';
import { renderFull, toBits } from './escpos.js';
import { SAMPLES } from './print-samples.js';
import { fastReceipt, fastPreview } from './receipt-fast.js';
import * as printer from './printer.js';
import { configured, rpc, esc, prettyPhone, mountLogin, setupMissing, session, signOut } from './lib.js';

const $ = (s) => document.querySelector(s);
let current = null; // { canvas, mode, dots, fast: { bytes, preview } | null }

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
  const fast = new FormData($('#opts')).get('speed') === 'fast';
  return { r, mode: paper === 'wa' ? 'wa' : 'print', dots: paper === 'wa' ? 384 : +paper, fast };
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
  const { r, mode, dots, fast } = readOpts();
  const canvas = await receiptCanvas(r, { mode, dots });
  current = { canvas, mode, dots, fast: null };
  let shown;
  if (mode === 'print' && fast) {
    const f = await fastReceipt(r, { dots, cut: $('#cut').checked, drawer: $('#drawer').checked });
    current.fast = f;
    shown = fastPreview(f.receipt, f.header, dots, f.card);
  } else {
    const showMono = mode === 'print' && $('#mono').checked;
    shown = showMono ? monoCanvas(canvas, $('#dither').checked) : canvas;
  }
  const view = $('#view');
  view.width = shown.width; view.height = shown.height;
  view.getContext('2d').drawImage(shown, 0, 0);
  view.style.width = mode === 'wa' ? '480px' : shown.width + 'px';
  const fullKb = Math.round((canvas.width / 8) * canvas.height / 1024);
  const kb = current.fast ? Math.round(current.fast.bytes.length / 1024) : fullKb;
  $('#facts').innerHTML = mode === 'wa'
    ? `<span>Gambar WhatsApp ${canvas.width} × ${canvas.height} px</span>`
    : `<span>Lebar cetak ${dots} titik (${dots / 8} mm)</span><span>Data ke printer kira-kira ${kb} KB${current.fast ? ` (desain penuh ${fullKb} KB)` : ''}</span><span>${current.fast ? 'Pratinjau kira-kira; huruf asli dari printer' : 'Printer 203 dpi = 8 titik per mm'}</span>`;
  for (const id of ['#bt', '#print', '#cut', '#drawer', '#mono', '#dither']) $(id).disabled = mode === 'wa';
}

function say(text, kind = 'ok') {
  const s = $('#status');
  s.hidden = false; s.className = `notice notice-${kind}`; s.textContent = text;
}

// ---- Bluetooth (BLE GATT): connecting and paced sending live in printer.js, shared with the till.
async function printBluetooth() {
  const btn = $('#bt'); btn.setAttribute('aria-busy', 'true');
  try {
    if (!printer.hasDevice()) say('Pilih printer di jendela Bluetooth.');
    if (!printer.isConnected()) await printer.connect(say);
    const { canvas } = current;
    let bytes;
    if (current.fast) {
      bytes = current.fast.bytes;
    } else {
      const im = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      bytes = renderFull({ width: im.width, height: im.height, data: im.data },
        { dither: $('#dither').checked, cut: $('#cut').checked, drawer: $('#drawer').checked });
    }
    const p = printer.current();
    const t = performance.now();
    say(`Mengirim ke ${p.name}...`);
    await printer.send(bytes, (pct) => say(`Mengirim ke ${p.name}... ${pct}%`));
    say(`Terkirim ke ${p.name} (${current.fast ? 'cepat' : 'desain penuh'}): ${Math.round(bytes.length / 1024)} KB dalam ${((performance.now() - t) / 1000).toFixed(1)} detik. Jalur ${p.svc} / ${p.uuid}.`);
  } catch (e) {
    if (e && e.name === 'NotFoundError') { printer.forget(); say('Tidak ada printer yang dipilih.', 'warn'); }
    else say(e.message || String(e), 'error');
  } finally { btn.removeAttribute('aria-busy'); }
}

// Pick a different printer next time.
function forgetPrinter() {
  printer.forget();
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
    app.innerHTML = `<section class="panel stack"><h1>Tidak ada akses</h1></section>`;
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
