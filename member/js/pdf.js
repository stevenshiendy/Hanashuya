import { shareNative } from './native.js';
// Small PDF builder for reports that staff send to the WhatsApp group (Glenn, 11 Nov 2026):
// the shift rekap and the stock request (permintaan barang). Text and tables only, A4 portrait.
// jsPDF loads from jsDelivr on first use (allowed by the CSP), so pages that never export
// don't pay for it.
//
//   const blob = await pdfBlob({ title: 'Rekap kas', subtitle: 'Shift 11 Nov 2026', blocks: [
//     { h: 'Barang terjual' },
//     { table: { head: ['Produk', 'Qty', 'Total'], rows: [['Signature 1 pcs', '4', 'Rp80.000']], align: ['l', 'r', 'r'] } },
//     { kv: ['Total', 'Rp247.001'], bold: true }, { rule: true }, { p: 'Catatan …' } ] });
//   await sharePdf(blob, 'rekap-2026-11-11.pdf', 'Rekap kas 11 Nov 2026');

const SRC = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
const INK = [93, 33, 12], MUTED = [122, 74, 56], RED = [163, 0, 7], RULE = [228, 211, 187];
let loading;

function loadJsPDF() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC; s.async = true;
    s.onload = () => (window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('PDF gagal dimuat.')));
    s.onerror = () => { loading = null; reject(new Error('PDF gagal dimuat. Periksa internet lalu coba lagi.')); };
    document.head.append(s);
  });
  return loading;
}

// blocks: { h } heading, { p } paragraph, { kv: [k, v], bold } key/value row,
// { table: { head, rows, align, widths } } with align 'l' | 'r' per column, { rule: true }, { gap: mm }.
export async function pdfBlob({ title, subtitle = '', blocks = [], footer = 'Hanashuya · Papaya Fresh Gallery Bandung' }) {
  const JsPDF = await loadJsPDF();
  const doc = new JsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297, M = 16, CW = W - 2 * M;
  let y = M;
  const color = (c) => doc.setTextColor(...c);
  const font = (style = 'normal', size = 10) => { doc.setFont('helvetica', style); doc.setFontSize(size); };
  const line = (yy) => { doc.setDrawColor(...RULE); doc.setLineWidth(0.3); doc.line(M, yy, W - M, yy); };
  const room = (need) => { if (y + need > H - M - 8) { doc.addPage(); y = M; } };

  font('bold', 9); color(RED); doc.text('HANASHUYA', M, y); y += 7;
  font('bold', 16); color(INK); doc.text(String(title), M, y); y += 6;
  if (subtitle) { font('normal', 10); color(MUTED); doc.splitTextToSize(String(subtitle), CW).forEach((t) => { doc.text(t, M, y); y += 5; }); }
  y += 2; line(y); y += 6;

  for (const b of blocks) {
    if (b.gap) { y += b.gap; continue; }
    if (b.rule) { room(4); line(y); y += 5; continue; }
    if (b.h) { room(12); y += 2; font('bold', 11); color(INK); doc.text(String(b.h), M, y); y += 6; continue; }
    if (b.p) {
      font('normal', 10); color(b.muted ? MUTED : INK);
      for (const t of doc.splitTextToSize(String(b.p), CW)) { room(6); doc.text(t, M, y); y += 5; }
      y += 1; continue;
    }
    if (b.kv) {
      room(6); font(b.bold ? 'bold' : 'normal', 10); color(INK);
      doc.text(String(b.kv[0]), M, y); doc.text(String(b.kv[1] ?? ''), W - M, y, { align: 'right' }); y += 5.5; continue;
    }
    if (b.table) {
      const { head = [], rows = [], align = [] } = b.table;
      const n = Math.max(head.length, ...rows.map((r) => r.length), 1);
      const widths = b.table.widths || [CW * 0.5, ...Array(n - 1).fill((CW * 0.5) / Math.max(n - 1, 1))];
      const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((s, w) => s + w, 0));
      const cell = (txt, i, yy) => {
        const t = String(txt ?? '');
        if (align[i] === 'r') doc.text(t, xs[i] + widths[i] - 1, yy, { align: 'right' });
        else doc.text(doc.splitTextToSize(t, widths[i] - 2)[0] || '', xs[i], yy);
      };
      if (head.length) { room(8); font('bold', 9); color(MUTED); head.forEach((t, i) => cell(t, i, y)); y += 2; line(y); y += 5; }
      font('normal', 10); color(INK);
      for (const r of rows) {
        // Long first-column text wraps; the other columns sit on the first line.
        const first = doc.splitTextToSize(String(r[0] ?? ''), widths[0] - 2);
        room(5 * first.length + 1);
        first.forEach((t, k) => doc.text(t, xs[0], y + k * 5));
        r.slice(1).forEach((t, i) => cell(t, i + 1, y));
        y += 5 * first.length + 1;
      }
      y += 2; continue;
    }
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i); font('normal', 8); color(MUTED);
    doc.text(footer, M, H - 10);
    doc.text(`Halaman ${i} dari ${pages}`, W - M, H - 10, { align: 'right' });
  }
  return doc.output('blob');
}

// Share to WhatsApp (the tablet's share sheet) when the browser can share files, otherwise
// download. { download: true } always downloads: the owner page on a computer (Glenn,
// 12 Nov 2026: the Mac share sheet popped up instead of a download). Returns 'shared',
// 'downloaded' or 'cancelled'.
export async function sharePdf(blob, filename, text = '', { download = false } = {}) {
  const viaApp = await shareNative(blob, filename, text || filename);
  if (viaApp) return viaApp;
  const file = new File([blob], filename, { type: 'application/pdf' });
  if (!download && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename, text }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}
