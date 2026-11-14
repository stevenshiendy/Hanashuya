// Demo only (_demo-rekap.html): the Rekap kas thermal print (text only) at 58 and 80 mm,
// staff copy (blind) and the owner's copy. ?who=staff|owner&dots=384|576 shows one.
import { rekapPreview, rekapReceipt } from '../js/receipt-rekap.js';
import { ownerFake } from './owner-data.js';
const q = new URLSearchParams(location.search);
const full = ownerFake('pos_shift_rekap');
const staff = { ...full, blind: true, staff: 'Fajar, Ranny', printed_at: null };
for (const f of ['opening_cash', 'float_source', 'setor', 'expected_cash', 'difference', 'flags', 'cash_float', 'flag_at', 'ledger']) delete staff[f];
const out = document.getElementById('out');
const whos = q.get('who') ? [q.get('who')] : ['staff', 'owner'];
const dotsList = q.get('dots') ? [Number(q.get('dots'))] : [384, 576];
for (const who of whos) {
  for (const dots of dotsList) {
    const k = who === 'owner' ? full : staff;
    const c = rekapPreview(k, { dots, reprint: who === 'owner' });
    const fig = document.createElement('figure');
    const kb = (rekapReceipt(k, { dots }).bytes().length / 1024).toFixed(1);
    fig.innerHTML = `<figcaption>${who === 'owner' ? 'Pemilik (cetak ulang)' : 'Staf'} · ${dots === 384 ? 58 : 80} mm · ${kb} KB teks</figcaption>`;
    fig.append(c); out.append(fig);
  }
}
document.title = 'done';
