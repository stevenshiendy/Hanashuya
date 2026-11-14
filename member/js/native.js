// The Kasir Hanashuya Android app (Capacitor, 14 Nov 2026) loads this site in a WebView, where
// navigator.share and file downloads do nothing. Inside the app, files go through the native
// Filesystem and Share plugins instead; in a browser these helpers report "not native".

export const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());
const plugin = (name) => (isNative() && window.Capacitor.Plugins?.[name]) || null;

const toBase64 = (blob) => new Promise((ok, bad) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] || '');
  r.onerror = () => bad(r.error);
  r.readAsDataURL(blob);
});

// Writes the file to the app's cache and opens Android's share sheet (WhatsApp, Drive, …).
// Returns 'shared', 'cancelled', or null when the app has no Share plugin (use the web path).
export async function shareNative(blob, filename, title = '') {
  const fs = plugin('Filesystem'), share = plugin('Share');
  if (!fs || !share) return null;
  const { uri } = await fs.writeFile({ path: filename, data: await toBase64(blob), directory: 'CACHE' });
  try { await share.share({ title: title || filename, files: [uri], dialogTitle: 'Kirim lewat' }); return 'shared'; }
  catch (e) { if (/cancel/i.test(String(e?.message || e))) return 'cancelled'; throw e; }
}
