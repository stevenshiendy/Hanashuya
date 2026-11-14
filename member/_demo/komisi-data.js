// Demo only: Dashboard komisi and Jadwal komisi fakes (14 Nov 2026), kept in memory for the visit.
// Periods follow the saved schedule: the open one and the two before it (one unpaid, one paid).
const ymd = (d) => d.toISOString().slice(0, 10);
const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
const D = (s) => new Date(s + 'T00:00:00Z');
const add = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const iso = (y, m, d) => ymd(new Date(Date.UTC(y, m, d)));
const cutIn = (s, c) => (c ? iso(+s.slice(0, 4), +s.slice(5, 7) - 1, c) : iso(+s.slice(0, 4), +s.slice(5, 7), 0));
const nextM = (s) => iso(+s.slice(0, 4), +s.slice(5, 7), 1);
const pEnd = (s, c) => (cutIn(s, c) >= s ? cutIn(s, c) : cutIn(nextM(s), c));
const pStart = (s, c) => { const e = pEnd(s, c); return add(cutIn(iso(+e.slice(0, 4), +e.slice(5, 7) - 2, 1), c), 1); };
const due = (to, pay) => { const n = nextM(to); return iso(+n.slice(0, 4), +n.slice(5, 7) - 1, pay); };

export const schedule = { auto: true, cutoff_day: 0, pay_day: 15 };
const STAFF = [
  { id: 's-rany', name: 'Rany Marlina', employer: 'Hanashuya', on: true, w: 1.25, off: [2] },
  { id: 's-fajar', name: 'Fajar Prihantoro', employer: 'Hanashuya', on: true, w: 1, off: [0] },
  { id: 's-kevin', name: 'Kevin Hadiyan', employer: 'Kaaramel Juice', on: true, w: 0.45, off: [0, 1, 2] },
  { id: 's-yuya', name: 'Eoudia Samulla Vidiani', employer: 'Kaaramel Juice', on: false, w: 0.35, off: [3, 4] }];
const WF = [1.5, 1, 0.95, 0.75, 1, 1.1, 1.45]; // Sun..Sat
const noise = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return 0.8 + 0.4 * (x - Math.floor(x)); };
const dayIdx = (s) => Math.round(D(s) / 864e5);
const cell = (s, k) => { const st = STAFF[k], wd = D(s).getUTCDay(); if (st.off.includes((wd + 6) % 7)) return { o: 0, sales: 0, kom: 0 };
  const o = Math.max(1, Math.round(3 * st.w * WF[wd] * noise(dayIdx(s), k + 1))); const sales = o * 78500; return { o, sales, kom: Math.round(sales * 0.0168) }; };
const paidIds = new Set();
let cancelled = new Set();

function periods() {
  const c = schedule.cutoff_day, curFrom = pStart(todayStr, c), cur = { from: curFrom, to: pEnd(curFrom, c) };
  const p1 = { from: pStart(add(curFrom, -1), c), to: add(curFrom, -1) };
  const p2 = { from: pStart(add(p1.from, -1), c), to: add(p1.from, -1) };
  return [p2, p1, cur].map((p) => ({ ...p, due: due(p.to, schedule.pay_day) }));
}
function payouts() {
  const [p2, p1] = periods();
  let id = 500;
  return [p2, p1].flatMap((p) => STAFF.map((s, k) => {
    id++;
    if (!s.on) return null;
    let o = 0, sales = 0, kom = 0;
    for (let d = p.from; d <= p.to; d = add(d, 1)) { const x = cell(d, k); o += x.o; sales += x.sales; kom += x.kom; }
    return { id, staff_id: s.id, name: s.name, from: p.from, to: p.to, orders: o, sales, commission: kom, due: p.due, paid: paidIds.has(id) || p === p2, auto: true };
  })).filter((x) => x && !cancelled.has(x.id));
}

export function komisiFake(name, a = {}, isOwner = true) {
  if (name === 'commission_set_schedule') { Object.assign(schedule, { auto: !!a.p_auto, cutoff_day: Number(a.p_cutoff), pay_day: Number(a.p_pay_day) }); return null; }
  if (name === 'pos_commission_mark_paid' && a.p_id > 500) { paidIds.add(a.p_id); return { id: a.p_id, status: 'dibayar' }; }
  if (name === 'pos_commission_cancel' && a.p_id > 500) { cancelled.add(a.p_id); return { id: a.p_id, status: 'batal' }; }
  if (name === 'commission_process_period') return { payouts: 0, total: 0 };
  if (name !== 'commission_dashboard') return undefined;
  const all = periods(), cur = all[2], pays = payouts();
  const state = (p) => (p === cur ? 'berjalan' : pays.some((y) => y.from === p.from && !y.paid) ? 'belum' : 'bayar');
  const picked = (a.p_range === 'lalu' ? [all[1]] : a.p_range === '3' ? all : [cur]).map((p) => ({ from: p.from, to: p.to, due: p.due, state: state(p) }));
  const f = picked[0].from, t = picked[picked.length - 1].to < todayStr ? picked[picked.length - 1].to : todayStr;
  const days = []; for (let d = f; d <= t; d = add(d, 1)) days.push(d);
  const curKom = (() => { let n = 0; for (let d = cur.from; d <= todayStr; d = add(d, 1)) STAFF.forEach((s, k) => { if (s.on) n += cell(d, k).kom; }); return n; })();
  const inRange = (y) => y.from <= t && y.to >= f;
  const staff = STAFF.map((s, k) => {
    const cells = days.map((d) => cell(d, k));
    return { id: s.id, name: s.name, employer: s.employer, on: s.on, orders: cells.reduce((n, x) => n + x.o, 0), sales: cells.reduce((n, x) => n + x.sales, 0),
      commission: s.on ? cells.reduce((n, x) => n + x.kom, 0) : 0, daily: cells.map((x) => (s.on ? x.kom : 0)),
      unpaid: pays.filter((y) => y.staff_id === s.id && inRange(y) && !y.paid).reduce((n, y) => n + y.commission, 0),
      paid: pays.filter((y) => y.staff_id === s.id && inRange(y) && y.paid).reduce((n, y) => n + y.commission, 0) };
  }).sort((x, y) => (y.on - x.on) || (y.commission - x.commission));
  const paidYear = pays.filter((y) => y.paid);
  return {
    today: todayStr, range: a.p_range || 'ini', from: f, to: t, periods: picked, is_owner: isOwner, me: isOwner ? 'o-glenn' : 'm-ranny',
    settings: { enabled: true, enabled_at: all[0].from, ...schedule },
    current: { from: cur.from, to: cur.to, due: cur.due, commission: curKom },
    unprocessed: [],
    unpaid: pays.filter((y) => !y.paid).map((y) => ({ id: y.id, staff_id: y.staff_id, name: y.name, from: y.from, to: y.to, commission: y.commission, orders: y.orders,
      due: y.due, overdue: y.due < todayStr, own: false, auto: true })),
    paid_year: { year: Number(todayStr.slice(0, 4)), total: paidYear.reduce((n, y) => n + y.commission, 0), count: paidYear.length },
    staff, days: days.map((d) => ({ day: d, state: state(all.find((p) => d >= p.from && d <= p.to) || cur), commission: STAFF.reduce((n, s, k) => n + (s.on ? cell(d, k).kom : 0), 0) })),
  };
}
export const komisiAnchor = () => periods()[2].from;
export const komisiToday = todayStr;
export const komisiDue = (to) => due(to, schedule.pay_day);
export const komisiEnd = (from) => pEnd(from, schedule.cutoff_day);
