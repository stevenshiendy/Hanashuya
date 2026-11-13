// One date-range control for the whole owner back office (13 Nov 2026, VireoPOS comparison:
// "every date range looks and behaves the same"). Quick buttons, then two date fields that
// only show for "Pilih tanggal". The fields keep data-from / data-to, so a screen that already
// reads those (owner-transaksi.js, owner-produksi.js, ...) keeps working unchanged.
//
//   rangeHtml({ preset, from, to, keys, max })   markup; preset wins over from/to
//   wireRange(root, { onChange })                 onChange({ preset, from, to }) after a quick button
//                                                 or a valid custom range; without onChange a quick
//                                                 button fires 'change' on [data-to] (bubbling)
//   presetRange(key, [from, to])                  the dates of a quick button
// Defaults: Hari ini for daily operations (Pesanan), 7 hari for reports, 30 hari for lists.
import { esc } from './lib.js';

const TZ = 'Asia/Jakarta';
export const ymdToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const shift = (ymd, days) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

export const LABELS = { hari: 'Hari ini', kemarin: 'Kemarin', 7: '7 hari', 30: '30 hari', bulan: 'Bulan ini', 'bulan-lalu': 'Bulan lalu',
  tahun: 'Tahun ini', semua: 'Semua', custom: 'Pilih tanggal' };
export const KEYS = ['hari', 'kemarin', '7', '30', 'bulan', 'bulan-lalu', 'custom'];
// Reports and the books also offer the year.
export const KEYS_YEAR = ['hari', 'kemarin', '7', '30', 'bulan', 'bulan-lalu', 'tahun', 'custom'];

export function presetRange(key, custom, today = ymdToday()) {
  if (key === 'hari') return [today, today];
  if (key === 'kemarin') { const y = shift(today, -1); return [y, y]; }
  if (key === '7') return [shift(today, -6), today];
  if (key === '30') return [shift(today, -29), today];
  if (key === 'bulan') return [today.slice(0, 8) + '01', today];
  if (key === 'bulan-lalu' || key === 'lalu') { const end = shift(today.slice(0, 8) + '01', -1); return [end.slice(0, 8) + '01', end]; }
  if (key === 'tahun') return [today.slice(0, 5) + '01-01', today];
  if (key === 'semua') return ['2026-01-01', today];
  return custom && custom[0] && custom[1] ? custom : [today, today];
}

// The quick button that gives exactly these dates, else 'custom'.
export function presetOf(from, to, keys = KEYS, today = ymdToday()) {
  return keys.find((k) => k !== 'custom' && String(presetRange(k, null, today)) === String([from, to])) || 'custom';
}

export function rangeHtml({ preset, from, to, keys = KEYS, max = ymdToday(), label = 'Rentang tanggal' } = {}) {
  const p = preset || (from && to ? presetOf(from, to, keys) : '30');
  const [f, t] = p === 'custom' ? [from || max, to || max] : presetRange(p, null);
  return `<div class="dr" data-dr>
    <div class="dr-chips" role="group" aria-label="${esc(label)}">${keys.map((k) =>
      `<button class="btn btn-quiet dr-chip" type="button" data-pre="${k}" aria-pressed="${k === p}">${LABELS[k]}</button>`).join('')}</div>
    <div class="dr-dates" data-dr-dates${p === 'custom' ? '' : ' hidden'}>
      <label class="field"><span>Dari</span><input type="date" data-from value="${esc(f)}" max="${esc(max)}"></label>
      <label class="field"><span>Sampai</span><input type="date" data-to value="${esc(t)}" max="${esc(max)}"></label>
      <p class="small dr-msg" data-dr-msg role="alert" hidden></p>
    </div>
  </div>`;
}

export function wireRange(root, { onChange } = {}) {
  const box = root.querySelector('[data-dr]');
  if (!box) return null;
  const from = box.querySelector('[data-from]'), to = box.querySelector('[data-to]'), msg = box.querySelector('[data-dr-msg]');
  const dates = box.querySelector('[data-dr-dates]');
  const chips = [...box.querySelectorAll('[data-pre]')];
  const value = () => ({ preset: chips.find((c) => c.getAttribute('aria-pressed') === 'true')?.dataset.pre || 'custom', from: from.value, to: to.value });
  const say = (m) => { msg.textContent = m || ''; msg.hidden = !m; };
  chips.forEach((c) => c.addEventListener('click', () => {
    chips.forEach((x) => x.setAttribute('aria-pressed', String(x === c)));
    say('');
    if (c.dataset.pre === 'custom') { dates.hidden = false; from.focus(); return; }
    dates.hidden = true;
    [from.value, to.value] = presetRange(c.dataset.pre, null);
    if (onChange) onChange(value());
    else to.dispatchEvent(new Event('change', { bubbles: true }));
  }));
  // Typed dates: say what is wrong right under the fields (no pop-up).
  [from, to].forEach((i) => i.addEventListener('change', (e) => {
    if (!e.isTrusted) return;
    if (from.value && to.value && from.value > to.value) { say('Tanggal Dari harus sama atau sebelum tanggal Sampai.'); return; }
    say('');
    if (onChange && from.value && to.value) onChange(value());
  }));
  return { value };
}
