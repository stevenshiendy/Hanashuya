// Renders the fast receipt preview for sample sales (no sign-in needed).
import { fastReceipt, fastPreview } from '../js/receipt-fast.js';
import { SAMPLES } from '../js/print-samples.js';
const out = document.getElementById('out');
for (const key of ['member', 'reward', 'walk']) {
  for (const dots of [384, 576]) {
    const r = { ...SAMPLES[key], sold_at: '2026-11-12T09:30:00Z' };
    const f = await fastReceipt(r, { dots });
    const c = fastPreview(f.receipt, f.header, dots, f.card);
    const fig = document.createElement('figure');
    fig.innerHTML = `<figcaption>${key} · ${dots === 384 ? 58 : 80} mm · ${(f.bytes.length / 1024).toFixed(1)} KB</figcaption>`;
    fig.append(c); out.append(fig);
  }
}
document.title = 'done';
