// Demo only: the Laporan hubs and akunting extras from laporan2-data.json (used by _demo-laporan2.html and _demo-owner.html).
const data = await (await fetch(new URL('./laporan2-data.json', import.meta.url))).json();
const accounts = [...new Map(data.reports.acc_journal_lines.rows.map((r) => [r.account_id, { id: r.account_id, code: r.kode, name: r.akun, type: r.jenis, active: true, system: true }])).values()]
  .sort((a, b) => a.code.localeCompare(b.code));
export async function laporan2Fake(name, a = {}) {
  if (name === 'owner_laporan') {
    const f = Object.fromEntries(Object.entries(a.p_filter || {}).filter(([, v]) => v !== '' && v != null));
    const hit = data.reports[a.p_report + ':' + JSON.stringify(f)] || data.reports[a.p_report];
    if (!hit) throw new Error('Laporan tidak dikenal.');
    return { ...hit, from: a.p_from, to: a.p_to };
  }
  if (name === 'stock_catalog') return { staff: [{ id: data.staff.ranny, name: 'Ranny' }, { id: data.staff.fajar, name: 'Fajar' }],
    items: Object.entries(data.items).map(([code, id]) => ({ id, code, name: code })), suppliers: [{ id: data.supplier, name: 'Toko Sejati' }] };
  if (name === 'acc_balance_monthly') return data.reports.acc_balance_monthly;
  if (name === 'acc_journal_lines') {
    const j = data.reports.acc_journal_lines;
    return { ...j, rows: j.rows.filter((r) => (!a.p_account || r.account_id === a.p_account) && (!a.p_source || r.sumber === a.p_source)) };
  }
  if (name === 'acc_accounts') return accounts;
  // Rekapitulasi kas drill-down (13 Nov 2026): the shift dumped by laporan2.test.mjs, for any shift id.
  if (name === 'owner_shift_detail') {
    if (!data.reports.owner_shift_detail) throw new Error('Shift tidak ditemukan.');
    return { ...data.reports.owner_shift_detail, id: a.p_shift };
  }
  return undefined;
}
