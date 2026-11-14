// Web Bluetooth (BLE GATT) printing to the booth's thermal printer, shared by the print
// test page (cetak-uji.html) and the till (kasir.html). Moved out of print-test.js on
// 12 Nov 2026 without changing how it connects or sends.
//
//   connect(onStatus)          pick the printer once (Chrome's list), then connect with retries
//   send(bytes, onProgress)    paced sending to the connected printer
//   print(bytes, onStatus)     connect when needed, then send, with progress messages
//   forget()                   disconnect and pick another printer next time
//   current()                  { ch, name, svc, uuid } while connected, else null
//
// Inside the Kasir Hanashuya Android app (Capacitor, 14 Nov 2026) Web Bluetooth does not exist:
// Chrome and the TWA never opened the printer list on the booth tablet. There the same calls go
// to the native plugin @capacitor-community/bluetooth-le (window.Capacitor.Plugins.BluetoothLe),
// which shows its own list, and the picked printer is remembered on the tablet so it reconnects
// by itself after the app restarts.

// Common thermal-printer services; the booth's PANDA printer answers on one of them.
const SERVICES = [
  0x18f0, 0xff00, 0xffe0, 0xfee7, 0xae30,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
];
let device = null;  // the printer picked in Chrome's Bluetooth list (kept, so a retry needs no new pick)
let printer = null; // { ch, name, svc, uuid }: the writable characteristic while connected
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---- Native (Android app) ----
const BLE = () => (window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins?.BluetoothLe) || null;
const NATIVE_KEY = 'hs-printer-native'; // { id, name } of the picked printer, kept on this tablet
const full = (id) => (typeof id === 'number' ? `0000${id.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb` : id.toLowerCase());
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
let nat = (() => { try { return JSON.parse(localStorage.getItem(NATIVE_KEY) || 'null'); } catch { return null; } })();
let natOn = false;  // connected right now
let natReady = null; // initialize() once per app start (asks for Nearby devices permission)
const natInit = (ble) => natReady || (natReady = (async () => {
  await ble.initialize({ androidNeverForLocation: true });
  try { await ble.setDisplayStrings({ scanning: 'Mencari printer...', cancel: 'Batal', availableDevices: 'Pilih printer', noDeviceFound: 'Printer tidak ditemukan' }); } catch { /* older plugin */ }
  ble.addListener('onEnabledChanged', () => {}).catch(() => {});
})().catch((e) => { natReady = null; throw e; }));

export const supported = () => Boolean(BLE() || navigator.bluetooth);
export const hasDevice = () => Boolean(BLE() ? nat : device);
export const isConnected = () => Boolean(printer && (BLE() ? natOn : device && device.gatt.connected));
export const current = () => (isConnected() ? printer : null);

// Finds a characteristic the printer accepts data on. Tries the list of all services
// first, then each known printer service one by one (some printers only answer that way).
export async function findWritable(gatt) {
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
async function connectNative(ble, onStatus) {
  await natInit(ble);
  if (!nat) {
    const d = await ble.requestDevice({ optionalServices: SERVICES.map(full) }).catch((e) => {
      const m = String(e?.message || e);
      if (/cancel/i.test(m)) { const err = new Error('Tidak ada printer yang dipilih.'); err.name = 'NotFoundError'; throw err; }
      throw new Error(/enabled|disabled|off/i.test(m) ? 'Bluetooth tablet mati. Nyalakan Bluetooth, lalu coba lagi.' : m);
    });
    nat = { id: d.deviceId, name: d.name || 'printer' };
    try { localStorage.setItem(NATIVE_KEY, JSON.stringify(nat)); } catch { /* private mode */ }
  }
  const { id, name } = nat;
  let found = null, last = null;
  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    try {
      onStatus(`Menyambung ke ${name} (percobaan ${attempt} dari 3)...`);
      const key = `disconnected|${id}`;
      await ble.addListener(key, () => { natOn = false; printer = null; });
      await ble.connect({ deviceId: id, timeout: 10000 });
      natOn = true;
      const { services = [] } = await ble.getServices({ deviceId: id });
      for (const svc of services) {
        const ch = (svc.characteristics || []).find((c) => c.properties.writeWithoutResponse || c.properties.write);
        if (ch) { found = { svc: svc.uuid, uuid: ch.uuid, props: ch.properties }; break; }
      }
      if (!found) { last = new Error('tanpa jalur tulis'); break; }
    } catch (e) {
      last = e; natOn = false;
      try { await ble.disconnect({ deviceId: id }); } catch { /* already closed */ }
      await wait(1000);
    }
  }
  if (!found) {
    if (last && last.message === 'tanpa jalur tulis') throw new Error(`${name} tersambung, tapi tidak menerima data lewat Bluetooth LE. Kirim nama dan tipe printernya ke Claude.`);
    throw new Error(`${name} tidak bisa disambung. Pastikan printer menyala dan tidak sedang tersambung ke aplikasi lain (misalnya VireoPOS), lalu coba lagi. Detail: ${last ? last.message || last : '-'}`);
  }
  let mtu = 23;
  try { mtu = (await ble.getMtu({ deviceId: id })).value || 23; } catch { /* keep the BLE minimum */ }
  // The ch stand-in keeps the web shape ({ ch: { properties } }) so callers see no difference.
  printer = { ch: { properties: found.props }, name, svc: found.svc, uuid: found.uuid, mtu, native: true };
  return printer;
}

export async function connect(onStatus = () => {}) {
  const ble = BLE();
  if (ble) return connectNative(ble, onStatus);
  if (!navigator.bluetooth) throw new Error('Browser ini tidak bisa Bluetooth. Pakai Chrome di tablet Android, atau cetak lewat Chrome / gambar PNG.');
  if (!device) {
    device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: SERVICES });
    device.addEventListener('gattserverdisconnected', () => { printer = null; });
  }
  const name = device.name || 'printer';
  let found = null, last = null;
  for (let attempt = 1; attempt <= 3 && !found; attempt++) {
    try {
      onStatus(`Menyambung ke ${name} (percobaan ${attempt} dari 3)...`);
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
export async function send(bytes, onProgress) {
  if (printer && printer.native) return sendNative(bytes, onProgress);
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

// Native sending: same pacing as the web path; chunks also stay inside the negotiated MTU.
async function sendNative(bytes, onProgress) {
  const ble = BLE(), { svc, uuid, ch, mtu } = printer;
  const chunk = Math.max(20, Math.min(100, (mtu || 23) - 3));
  const withResponse = ch.properties.write;
  const base = { deviceId: nat.id, service: svc, characteristic: uuid };
  for (let i = 0; i < bytes.length; i += chunk) {
    const value = hex(bytes.slice(i, i + chunk));
    if (withResponse) await ble.write({ ...base, value });
    else { await ble.writeWithoutResponse({ ...base, value }); await wait(40); }
    if (onProgress && Math.floor(i / chunk) % 20 === 0) onProgress(Math.round((i / bytes.length) * 100));
  }
}

// Connects when needed, then sends. onStatus gets each step as an Indonesian sentence.
// A cancelled pick (NotFoundError) comes back as an error with that name.
export async function print(bytes, onStatus = () => {}) {
  if (!hasDevice()) onStatus('Pilih printer di jendela Bluetooth.');
  if (!isConnected()) await connect(onStatus);
  onStatus(`Mengirim ke ${printer.name}...`);
  await send(bytes, (pct) => onStatus(`Mengirim ke ${printer.name}... ${pct}%`));
  return printer;
}

// Pick a different printer next time.
export function forget() {
  const ble = BLE();
  if (ble) {
    if (nat) ble.disconnect({ deviceId: nat.id }).catch(() => {});
    nat = null; natOn = false;
    try { localStorage.removeItem(NATIVE_KEY); } catch { /* private mode */ }
  }
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch { /* ignore */ }
  device = null; printer = null;
}
