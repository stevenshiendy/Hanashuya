// Web Bluetooth (BLE GATT) printing to the booth's thermal printer, shared by the print
// test page (cetak-uji.html) and the till (kasir.html). Moved out of print-test.js on
// 12 Nov 2026 without changing how it connects or sends.
//
//   connect(onStatus)          pick the printer once (Chrome's list), then connect with retries
//   send(bytes, onProgress)    paced sending to the connected printer
//   print(bytes, onStatus)     connect when needed, then send, with progress messages
//   forget()                   disconnect and pick another printer next time
//   current()                  { ch, name, svc, uuid } while connected, else null

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

export const supported = () => Boolean(navigator.bluetooth);
export const hasDevice = () => Boolean(device);
export const isConnected = () => Boolean(printer && device && device.gatt.connected);
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
export async function connect(onStatus = () => {}) {
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

// Connects when needed, then sends. onStatus gets each step as an Indonesian sentence.
// A cancelled pick (NotFoundError) comes back as an error with that name.
export async function print(bytes, onStatus = () => {}) {
  if (!device) onStatus('Pilih printer di jendela Bluetooth.');
  if (!isConnected()) await connect(onStatus);
  onStatus(`Mengirim ke ${printer.name}...`);
  await send(bytes, (pct) => onStatus(`Mengirim ke ${printer.name}... ${pct}%`));
  return printer;
}

// Pick a different printer next time.
export function forget() {
  try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch { /* ignore */ }
  device = null; printer = null;
}
