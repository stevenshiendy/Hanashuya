// Demo replies for Laporan > Laporan sampel (sample data, untracked, skipped by the build).
const HRS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BASEC = [.06, .08, .11, .17, .21, .19, .24, .32, .35, .29, .26, .17, .13], DAYF = [.9, .85, .7, .95, 1.05, 1.25, 1.3];
const BASES = [3, 3, 4, 5, 7, 6, 6, 8, 8, 7, 6, 4, 3], DAYS2 = [1, 1, .9, 1, 1.1, 1.45, 1.5];
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
const quotas = {};
export function sampleFake(name, a = {}) {
  if (name === 'owner_sample_set_quota') { a.p_hours.forEach((h) => { quotas[a.p_dow + ':' + h.hour] = h.qty; }); return { dow: a.p_dow }; }
  if (name !== 'owner_sample_dashboard') return undefined;
  const now = new Date(), today = ymd(now), tmr = ymd(new Date(now.getTime() + 864e5));
  const dow = ((now.getDay() + 6) % 7) + 1, dm = (dow % 7) + 1, nowh = 15;
  const cells = [];
  for (let d = 1; d <= 7; d++) HRS.forEach((h, i) => { const s = Math.round(BASES[i] * DAYS2[d - 1] * 1.6 * (1 + ((d * 3 + i) % 3 - 1) * .08));
    cells.push({ dow: d, hour: h, pcs: s + Math.round(s / 4), samples: s, converted: Math.round(s * Math.min(.48, BASEC[i] * DAYF[d - 1])) }); });
  const cell = (d, h) => cells.find((c) => c.dow === d && c.hour === h);
  const advice = HRS.map((h) => { const c = cell(dm, h), v = c.converted / c.samples, q = quotas[dm + ':' + h] || Math.max(1, Math.round(c.pcs / 8));
    const k = quotas[dm + ':' + h] ? 'baru_diubah' : v >= .25 ? 'naik' : v < .10 && q > 1 ? 'turun' : 'tetap';
    return { hour: h, q, nq: k === 'baru_diubah' ? q : k === 'naik' ? q + 1 : k === 'turun' ? q - 1 : q, k, conv: v, roi: v * 30, pcs: c.pcs, pooled: c.pcs < 20, set: !!quotas[dm + ':' + h] }; });
  return { from: a.p_from, to: a.p_to, today, tomorrow: tmr, today_dow: dow, tomorrow_dow: dm, now_hour: nowh, hours: HRS,
    kpi: { pcs: 614, samples: 492, converted: 118, orders: 131, cost: 706100, revenue: 8908000, gp: 4899400, days: 30 },
    cells,
    today_hours: HRS.map((h) => { const q = Math.max(1, Math.round(cell(dow, h).pcs / 8)); return { hour: h, quota: q, pcs: h < nowh ? q : h === nowh ? 1 : 0, converted: h < nowh ? [0, 0, 0, 0, 1, 0, 1][h - 8] ?? 0 : 0 }; }),
    advice,
    days: [0, 1, 2, 3, 4, 5, 6].map((i) => { const s = [17, 15, 13, 14, 15, 21, 20][i], c = [5, 4, 2, 3, 3, 7, 6][i]; return { day: ymd(new Date(now.getTime() - (i + 1) * 864e5)), pcs: s + 3, samples: s, converted: c, cost: (s + 3) * 1150 }; }),
    flavours: [['vanilla', 'Vanilla', 238, 190, 46], ['choco', 'Choco', 166, 133, 29], ['matcha', 'Matcha', 126, 101, 24], ['matcha_strawberry', 'Matcha Strawberry', 84, 68, 11]]
      .map(([flavour, label, pcs, samples, converted]) => ({ flavour, label, pcs, samples, converted })),
    accounts: [{ code: '6-2400', name: 'Beban pemasaran', parent: false, amount: 1250000 }, { code: '6-2410', name: 'Beban sampel produk', parent: true, amount: 706100 }],
    can_set: true };
}
