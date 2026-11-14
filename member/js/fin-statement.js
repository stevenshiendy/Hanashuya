// Formal financial statements (Glenn, 14 Nov 2026: "make the accounting view like industry standard accounting
// report representation formally"). Layout follows SAK EMKM / PSAK 1 and IFRS practice:
//   * a heading block: entity, statement title (Indonesian, English), the period or date, "Dinyatakan dalam Rupiah";
//   * a comparative column (the period before of the same length; for the balance sheet 31 Desember last year);
//   * sections in bold, accounts indented, subtotals under a single rule, totals over a double rule;
//   * amounts without "Rp", negatives and deductions in brackets, zero as a dash.
// Each statement is built as rows first, so the page and the .xlsx download show the same thing.
// Sections come from the account code (akunting.sql): 1-1xxx aset lancar, 1-2xxx+ aset tidak lancar, 2-1xxx/2-2xxx
// liabilitas jangka pendek, 2-3xxx+ jangka panjang, 4-13xx pendapatan lain-lain, 5-xxxx beban pokok penjualan,
// 6-9xxx beban lain-lain, 8-xxxx beban pajak penghasilan.
import { esc } from './lib.js';

export const ENTITY = 'Hanashuya';
const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const parts = (ymd) => String(ymd).slice(0, 10).split('-').map(Number);
export const longDate = (ymd) => { const [y, m, d] = parts(ymd); return `${d} ${MONTHS[m - 1]} ${y}`; };
const longDateEn = (ymd) => { const [y, m, d] = parts(ymd); return `${MONTHS_EN[m - 1]} ${d}, ${y}`; };
const shortDate = (ymd) => { const [y, m, d] = parts(ymd); return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`; };
const addDays = (ymd, n) => { const t = new Date(String(ymd).slice(0, 10) + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;

// The comparative period: the same number of days right before; for a balance sheet, 31 Desember of last year.
export const priorRange = (from, to) => { const n = days(from, to); return [addDays(from, -n), addDays(from, -1)]; };
export const priorYearEnd = (at) => `${parts(at)[0] - 1}-12-31`;

// 1.234.567, (1.234.567), and a dash for zero.
export const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  if (v === 0) return '–';
  const s = Math.abs(v).toLocaleString('id-ID');
  return v < 0 ? `(${s})` : s;
};

/* ---------------------------------------------------------------- rows
   { k: 'h' section heading | 'g' group heading | 'i' account | 's' subtotal | 't' total, id, en, code, v: [cur, prev], lv } */
const val = (list, code) => Number((list || []).find((r) => r.code === code)?.amount || 0);
const codesOf = (...lists) => [...new Set(lists.flatMap((l) => (l || []).map((r) => r.code)))].sort();
const meta = (lists, code) => { for (const l of lists) { const r = (l || []).find((x) => x.code === code); if (r) return r; } return {}; };
const sum = (rows, i) => rows.reduce((t, r) => t + r.v[i], 0);

// Account rows over both periods; sign -1 shows a cost as a deduction. Sub-accounts (parent_code, e.g. Beban pemasaran >
// Beban sampel produk) sit under their parent's name with a group subtotal.
function accountRows(cur, prev, en, sign = 1, keep = () => true) {
  const codes = codesOf(cur, prev).filter(keep);
  const rows = codes.map((c) => { const m = meta([cur, prev], c);
    return { k: 'i', code: c, id: m.name, en: en[c], parent: m.parent_code || null, parentName: m.parent_name || null, v: [sign * val(cur, c), sign * val(prev, c)] }; });
  const out = [], done = new Set();
  for (const r of rows) {
    const key = r.parent || r.code; if (done.has(key)) continue; done.add(key);
    const grp = rows.filter((x) => (x.parent || x.code) === key);
    if (grp.length === 1 && !grp[0].parent) { out.push(r); continue; }
    const name = grp.find((x) => x.parentName)?.parentName || r.id;
    // The parent's own line only when it has postings of its own.
    out.push({ k: 'g', id: name, en: en[key], code: key }, ...grp.filter((x) => x.parent || x.v.some(Boolean)).map((x) => ({ ...x, lv: 2 })),
      { k: 's', id: 'Jumlah ' + name.toLowerCase(), en: en[key] ? 'Total ' + en[key].toLowerCase() : '', v: [sum(grp, 0), sum(grp, 1)], lv: 2, part: true });
  }
  return out;
}
const leaves = (rows) => rows.filter((r) => r.k === 'i');

export function profitLossRows(cur, prev, en) {
  const P = (d, k) => (d && d[k]) || [];
  const isOther = (c) => c.startsWith('4-13');
  const rev = accountRows(P(cur, 'pendapatan'), P(prev, 'pendapatan'), en, 1, (c) => !isOther(c));
  const net = [sum(leaves(rev), 0), sum(leaves(rev), 1)];
  const cogs = accountRows(P(cur, 'hpp'), P(prev, 'hpp'), en, -1);
  const gross = [net[0] + sum(leaves(cogs), 0), net[1] + sum(leaves(cogs), 1)];
  const opex = accountRows(P(cur, 'beban'), P(prev, 'beban'), en, -1, (c) => !c.startsWith('6-9'));
  const opTot = [sum(leaves(opex), 0), sum(leaves(opex), 1)];
  const op = [gross[0] + opTot[0], gross[1] + opTot[1]];
  const other = [...accountRows(P(cur, 'pendapatan'), P(prev, 'pendapatan'), en, 1, isOther),
    ...accountRows(P(cur, 'beban'), P(prev, 'beban'), en, -1, (c) => c.startsWith('6-9'))];
  const othTot = [sum(leaves(other), 0), sum(leaves(other), 1)];
  const pbt = [op[0] + othTot[0], op[1] + othTot[1]];
  const tax = accountRows(P(cur, 'pajak'), P(prev, 'pajak'), en, -1);
  const np = [pbt[0] + sum(leaves(tax), 0), pbt[1] + sum(leaves(tax), 1)];
  const out = [{ k: 'h', id: 'Pendapatan usaha', en: 'Revenue' }, ...rev,
    { k: 's', id: 'Pendapatan neto', en: 'Net revenue', v: net }];
  if (cogs.length) out.push(...cogs.map((r) => ({ ...r, lv: 0 })));
  out.push({ k: 's', id: 'Laba bruto', en: 'Gross profit', v: gross, strong: true });
  if (opex.length) out.push({ k: 'h', id: 'Beban usaha', en: 'Operating expenses' }, ...opex, { k: 's', id: 'Jumlah beban usaha', en: 'Total operating expenses', v: opTot });
  out.push({ k: 's', id: 'Laba (rugi) usaha', en: 'Operating profit (loss)', v: op, strong: true });
  if (other.length) out.push({ k: 'h', id: 'Pendapatan (beban) lain-lain', en: 'Other income (expenses)' }, ...other,
    { k: 's', id: 'Jumlah pendapatan (beban) lain-lain', en: 'Total other income (expenses)', v: othTot });
  out.push({ k: 's', id: 'Laba (rugi) sebelum pajak penghasilan', en: 'Profit (loss) before income tax', v: pbt, strong: true });
  if (tax.length) out.push(...tax.map((r) => ({ ...r, lv: 0 })));
  out.push({ k: 't', id: 'Laba (rugi) periode berjalan', en: 'Profit (loss) for the period', v: np });
  return out;
}

export function balanceSheetRows(cur, prev, en) {
  const L = (d, k) => (d && d[k]) || [];
  const ret = (d) => (d ? (d.retained_earnings != null ? Number(d.retained_earnings) : 0) + val(d.ekuitas, '3-1300') : 0);
  const yr = (d) => (d ? (d.profit_year != null ? Number(d.profit_year) : Number(d.profit || 0)) : 0);
  const block = (rows, head, total) => (rows.length ? [{ k: 'g', lv: 0, ...head }, ...rows.map((r) => ({ ...r, lv: r.lv || 1 })),
    { k: 's', ...total, v: [sum(leaves(rows), 0), sum(leaves(rows), 1)] }] : []);
  const curA = accountRows(L(cur, 'aset'), L(prev, 'aset'), en, 1, (c) => c.startsWith('1-1'));
  const nonA = accountRows(L(cur, 'aset'), L(prev, 'aset'), en, 1, (c) => !c.startsWith('1-1'));
  const isShort = (c) => c.startsWith('2-1') || c.startsWith('2-2');
  const curL = accountRows(L(cur, 'kewajiban'), L(prev, 'kewajiban'), en, 1, isShort);
  const nonL = accountRows(L(cur, 'kewajiban'), L(prev, 'kewajiban'), en, 1, (c) => !isShort(c));
  const eq = accountRows(L(cur, 'ekuitas'), L(prev, 'ekuitas'), en, 1, (c) => c !== '3-1300');
  eq.push({ k: 'i', id: 'Saldo laba', en: 'Retained earnings', v: [ret(cur), ret(prev)] },
    { k: 'i', id: 'Laba (rugi) tahun berjalan', en: 'Profit (loss) for the current year', v: [yr(cur), yr(prev)] });
  const tA = [sum(leaves([...curA, ...nonA]), 0), sum(leaves([...curA, ...nonA]), 1)];
  const tL = [sum(leaves([...curL, ...nonL]), 0), sum(leaves([...curL, ...nonL]), 1)];
  const tE = [sum(leaves(eq), 0), sum(leaves(eq), 1)];
  return [
    { k: 'h', id: 'Aset', en: 'Assets' },
    ...block(curA, { id: 'Aset lancar', en: 'Current assets' }, { id: 'Jumlah aset lancar', en: 'Total current assets' }),
    ...block(nonA, { id: 'Aset tidak lancar', en: 'Non-current assets' }, { id: 'Jumlah aset tidak lancar', en: 'Total non-current assets' }),
    { k: 't', id: 'Jumlah aset', en: 'Total assets', v: tA },
    { k: 'h', id: 'Liabilitas dan ekuitas', en: 'Liabilities and equity' },
    ...block(curL, { id: 'Liabilitas jangka pendek', en: 'Current liabilities' }, { id: 'Jumlah liabilitas jangka pendek', en: 'Total current liabilities' }),
    ...block(nonL, { id: 'Liabilitas jangka panjang', en: 'Non-current liabilities' }, { id: 'Jumlah liabilitas jangka panjang', en: 'Total non-current liabilities' }),
    { k: 's', id: 'Jumlah liabilitas', en: 'Total liabilities', v: tL, strong: true },
    { k: 'g', lv: 0, id: 'Ekuitas', en: 'Equity' }, ...eq.map((r) => ({ ...r, lv: r.lv || 1 })),
    { k: 's', id: 'Jumlah ekuitas', en: 'Total equity', v: tE, strong: true },
    { k: 't', id: 'Jumlah liabilitas dan ekuitas', en: 'Total liabilities and equity', v: [tL[0] + tE[0], tL[1] + tE[1]] },
  ];
}

/* ---------------------------------------------------------------- drawing */
const label = (r) => `${esc(r.id)}${r.en ? `<span class="fs-en" lang="en">${esc(r.en)}</span>` : ''}`;

// The heading block every statement opens with.
export function headHtml({ title, titleEn, period, periodEn }) {
  return `<header class="fs-head">
    <p class="fs-entity">${esc(ENTITY)}</p>
    <h2 class="fs-title">${esc(title)}<span class="fs-en" lang="en">${esc(titleEn)}</span></h2>
    <p class="fs-period">${esc(period)}<span class="fs-en" lang="en">${esc(periodEn)}</span></p>
    <p class="fs-unit">(Dinyatakan dalam Rupiah)<span class="fs-en" lang="en">(Expressed in Rupiah)</span></p>
  </header>`;
}

// rows → the statement table. cols: column headings for the amounts, e.g. ['14 Nov 2026', '31 Des 2025'].
export function tableHtml(rows, cols) {
  const n = cols.length;
  const tr = (r) => {
    const cls = `fs-${r.k}${r.strong ? ' is-strong' : ''}${r.part ? ' is-part' : ''}`;
    const lv = r.lv ?? 1, pad = (r.k === 'i' || r.k === 'g' || r.part) && lv > 0 ? ` style="padding-left:calc(${lv} * var(--space-lg))"` : '';
    if (r.k === 'h' || r.k === 'g') return `<tr class="${cls}"><th scope="rowgroup" colspan="${n + 1}"${pad}>${label(r)}</th></tr>`;
    const tag = r.k === 'i' ? 'td' : 'th';
    return `<tr class="${cls}"><${tag} scope="row"${pad}>${label(r)}</${tag}>${r.v.slice(0, n).map((v) => `<td class="num">${fmt(v)}</td>`).join('')}</tr>`;
  };
  return `<div class="table-wrap"><table class="fs-table">
    <colgroup><col>${cols.map(() => '<col class="fs-amt">').join('')}</colgroup>
    <thead><tr><th scope="col"><span class="visually-hidden">Keterangan</span></th>${cols.map((c) => `<th scope="col" class="num">${c}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(tr).join('')}</tbody></table></div>`;
}

// rows → spreadsheet rows (numbers stay numbers; deductions negative).
export function rowsAoa(rows, cols, headLines) {
  const a = headLines.map((l) => [l]);
  a.push([], ['Keterangan', 'Description', ...cols]);
  for (const r of rows) {
    const ind = r.k === 'i' || r.k === 'g' || r.part ? '  '.repeat(r.lv ?? 1) : '';
    const id = r.k === 'h' ? r.id.toUpperCase() : ind + r.id;
    a.push(r.v ? [id, r.en || '', ...r.v.slice(0, cols.length).map((v) => Math.round(v))] : [id, r.en || '']);
  }
  return a;
}

// Statement headings for one view.
export const plHead = (from, to) => ({ title: 'Laporan laba rugi', titleEn: 'Statement of profit or loss',
  period: `Untuk periode ${longDate(from)} sampai ${longDate(to)}`, periodEn: `For the period from ${longDateEn(from)} to ${longDateEn(to)}` });
export const bsHead = (at) => ({ title: 'Laporan posisi keuangan', titleEn: 'Statement of financial position',
  period: `Per ${longDate(at)}`, periodEn: `As at ${longDateEn(at)}` });
export const tbHead = (from, to) => ({ title: 'Neraca saldo', titleEn: 'Trial balance',
  period: `Untuk periode ${longDate(from)} sampai ${longDate(to)}`, periodEn: `For the period from ${longDateEn(from)} to ${longDateEn(to)}` });
export const glHead = (acc, from, to) => ({ title: `Buku besar: ${acc.code} ${acc.name}`, titleEn: acc.name_en ? `General ledger: ${acc.name_en}` : 'General ledger',
  period: `Untuk periode ${longDate(from)} sampai ${longDate(to)}`, periodEn: `For the period from ${longDateEn(from)} to ${longDateEn(to)}` });
export const rangeCol = (from, to) => (from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`);
export const dateCol = (ymd) => shortDate(ymd);
export { shortDate };
