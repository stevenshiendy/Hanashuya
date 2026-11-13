-- Hanashuya POS: Laporan hubs, second part (13 Nov 2026, Glenn: "cover what VireoPOS offers").
-- Run AFTER akunting.sql (the last file of the handover run order). Safe to re-run. Owner and manager
-- (read-only, Glenn 13 Nov 2026); member WhatsApp numbers are masked for a manager (_rep_phone).
-- No tables; everything here is read-only.
--
--   owner_laporan(report, from, to, filter)  one sub-report of the Laporan hubs (Stok, Pembelian, Penjualan,
--                                            Laba, Lainnya) as { report, from, to, rows: [...] }. The page draws
--                                            the columns and the Jumlah row; see REPORTS in js/owner-laporan2.js.
--   acc_balance_monthly(from, to)            Neraca bulanan: balance sheet per month side by side.
--   acc_journal_lines(from, to, account, source)   Laporan jurnal: every journal line, filtered by account or source.
--
-- Rules, as in pos-reports.sql (13 Nov 2026): a paid order counts on its sale_day; a batal or refund
-- comes off on the day it was approved (the signed rows of _rep_orders / _rep_lines / _rep_pay); money
-- is the price paid (line_total - discount per line, pos_orders.total per receipt). Listings of receipts
-- (Penjualan rinci, Diskon, Transaksi pelanggan) stay one row per receipt on its sale day.
-- Harga pokok is the cost each line kept when it was paid (pos_order_items.cost); older lines use
-- today's harga pokok and are marked "perkiraan".
-- Not here (other agents' tables, follow-ups): stock transfers and produksi (pos-produksi.sql),
-- reservations, deposits and stamp adjustments (pos-reservasi.sql).

create or replace function public._lap2_range(p_from date, p_to date) returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to < p_from then raise exception 'Tanggal akhir tidak boleh sebelum tanggal awal.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
end $$;

-- A filter value from the page: empty and 'semua' mean no filter.
create or replace function public._lap2_f(p jsonb, k text) returns text
language sql immutable
as $$ select nullif(nullif(trim(coalesce(p ->> k, '')), ''), 'semua') $$;

create or replace function public._lap2_day_name(d date) returns text
language sql immutable
as $$ select (array['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'])[extract(isodow from d)::int] $$;

create or replace function public._lap2_kind_label(k text) returns text
language sql immutable
as $$ select case k when 'masuk' then 'Barang masuk' when 'penjualan' then 'Penjualan' when 'batal_penjualan' then 'Penjualan dibatalkan'
  when 'sampel' then 'Sampel' when 'buang' then 'Dibuang' when 'rusak' then 'Rusak' when 'promo' then 'Promo'
  when 'potong_liner' then 'Potong liner' when 'koreksi' then 'Koreksi' else coalesce(k, '') end $$;

create or replace function public._lap2_promo_label(k text) returns text
language sql immutable
as $$ select case k when 'stempel' then 'Hadiah stempel' when 'welcome' then 'Diskon member baru' when 'ulang_tahun' then 'Hadiah ulang tahun'
  when 'kode' then 'Voucher kertas' when 'tebus_murah' then 'Tebus Murah Rp1' when 'bogo' then 'BOGO Deals' when 'promo' then 'Promo POS'
  when 'malam50' then 'Diskon 50% malam' when 'instruksi50' then 'Diskon 50% instruksi' else coalesce(k, '') end $$;

-- The Tunai part of a shift's paid orders (pos_order_payments, 13 Nov 2026). Called only when that table exists.
create or replace function public._rep_shift_tunai(p_shift bigint) returns bigint
language plpgsql stable security definer set search_path = public
as $$
begin
  return (select coalesce(sum(p.amount), 0) from pos_order_payments p join pos_orders o on o.id = p.order_id
           where o.shift_id = p_shift and o.status = 'dibayar' and p.method = 'tunai');
end $$;

-- ---------------------------------------------------------------- the sub-reports
create or replace function public.owner_laporan(p_report text, p_from date, p_to date, p_filter jsonb default '{}') returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();
  f jsonb := coalesce(p_filter, '{}'::jsonb);
  d1 date := p_from; d2 date := p_to;
  v_status text := public._lap2_f(f, 'status');
  v_method text := public._lap2_f(f, 'method');
  v_channel text := public._lap2_f(f, 'channel');
  v_staff text := public._lap2_f(f, 'staff');
  v_item text := public._lap2_f(f, 'item');
  v_supplier text := public._lap2_f(f, 'supplier');
  v_kind text := public._lap2_f(f, 'kind');
  v_group text := public._lap2_f(f, 'group');
  v_q text := lower(coalesce(public._lap2_f(f, 'q'), ''));
  v_empty boolean := coalesce((f ->> 'empty')::boolean, false);
  r json;
begin
  perform public._lap2_range(d1, d2);
  if v_status is not null and v_status not in ('dibayar', 'batal', 'refund', 'menunggu', 'terbuka', 'menunggu_keputusan', 'diterima', 'ditolak', 'diganti') then
    raise exception 'Status tidak dikenal.';
  end if;
  if v_method is not null and v_method not in ('tunai', 'qris', 'campur', 'platform', 'gratis') then raise exception 'Metode bayar tidak dikenal.'; end if;
  if v_staff is not null and v_staff !~ '^[0-9a-f-]{36}$' then raise exception 'Staf tidak dikenal.'; end if;
  if v_item is not null and v_item !~ '^[0-9]+$' then raise exception 'Barang tidak dikenal.'; end if;
  if v_supplier is not null and v_supplier !~ '^([0-9]+|tanpa)$' then raise exception 'Pemasok tidak dikenal.'; end if;

  case p_report
  -- ============================================================ Laporan stok
  -- Kartu stok: per item, stok awal, masuk, keluar per alasan, penyesuaian, stok akhir and its value.
  when 'stok_kartu' then
    select json_agg(x order by x.sort, x.id) into r from (
      select i.id, i.name as barang, i.unit as satuan, i.sort,
        coalesce(sum(m.qty) filter (where m.day < d1), 0) as awal,
        coalesce(sum(m.qty) filter (where m.day between d1 and d2 and (m.kind = 'masuk' or (m.kind = 'koreksi' and m.goods_in_id is not null))), 0) as masuk,
        coalesce(-sum(m.qty) filter (where m.day between d1 and d2 and m.kind in ('penjualan', 'batal_penjualan')), 0) as penjualan,
        coalesce(-sum(m.qty) filter (where m.day between d1 and d2 and m.kind in ('sampel', 'buang', 'rusak', 'promo')), 0) as keluar_lain,
        coalesce(sum(m.qty) filter (where m.day between d1 and d2 and m.kind = 'potong_liner'), 0) as potong_liner,
        coalesce(sum(m.qty) filter (where m.day between d1 and d2 and m.kind = 'koreksi' and m.goods_in_id is null), 0) as penyesuaian,
        coalesce(sum(m.qty) filter (where m.day <= d2), 0) as akhir,
        i.unit_cost as hpp,
        round(coalesce(sum(m.qty) filter (where m.day <= d2), 0) * i.unit_cost)::bigint as nilai
      from stock_items i left join stock_moves m on m.item_id = i.id
      where (v_item is null or i.id = v_item::int)
      group by i.id
      having v_empty or i.active and (coalesce(sum(m.qty) filter (where m.day <= d2), 0) <> 0 or count(m.id) filter (where m.day between d1 and d2) > 0)
    ) x;

  -- Stok terkini: what is on hand now, with harga pokok and the minimum.
  when 'stok_terkini' then
    select json_agg(x order by x.sort, x.id) into r from (
      select i.id, i.name as barang, i.unit as satuan, i.sort, b.qty as stok, i.low_level as minimum, i.unit_cost as hpp,
        round(b.qty * i.unit_cost)::bigint as nilai,
        case when i.low_level is not null and b.qty <= i.low_level then 'Di bawah minimum' when b.qty < 0 then 'Minus' else 'Cukup' end as keadaan
      from stock_items i cross join lateral (select public._stock_balance(i.id) as qty) b
      where i.active and (v_empty or b.qty <> 0 or i.low_level is not null)
    ) x;

  -- Riwayat stok: every move with its document and the running balance of that item.
  when 'stok_riwayat' then
    select json_agg(x order by x.at, x.id) into r from (
      select y.* from (
        select m.id, m.created_at as at, m.day as tanggal, i.name as barang, i.unit as satuan, public._lap2_kind_label(m.kind) as jenis,
          case when m.order_id is not null and m.kind in ('penjualan', 'batal_penjualan') then (select o.receipt_no from pos_orders o where o.id = m.order_id)
               when m.goods_in_id is not null then 'Barang masuk #' || m.goods_in_id
               when m.count_id is not null then 'Stok opname #' || m.count_id
               else coalesce(m.reason, '') end as dokumen,
          greatest(m.qty, 0) as masuk, greatest(-m.qty, 0) as keluar,
          sum(m.qty) over (partition by m.item_id order by m.created_at, m.id) as saldo,
          (select public._first_name(full_name) from profiles where id = coalesce(m.responsible_id, m.created_by)) as oleh
        from stock_moves m join stock_items i on i.id = m.item_id
        where m.day <= d2 and (v_item is null or m.item_id = v_item::int)
          and (v_kind is null or m.kind = v_kind or (v_kind = 'penjualan' and m.kind = 'batal_penjualan'))) y
      where y.tanggal >= d1 order by y.at desc, y.id desc limit 3000
    ) x;

  -- Peringatan stok minimum: items at or under their minimum now.
  when 'stok_minimum' then
    select json_agg(x order by x.kurang desc, x.barang) into r from (
      select i.id, i.name as barang, i.unit as satuan, b.qty as stok, i.low_level as minimum, i.low_level - b.qty as kurang
      from stock_items i cross join lateral (select public._stock_balance(i.id) as qty) b
      where i.active and i.low_level is not null and b.qty <= i.low_level
    ) x;

  -- Laporan stok opname: each count line, sistem vs hitungan, selisih and its value.
  when 'stok_opname' then
    select json_agg(x order by x.tanggal desc, x.count_id desc, x.sort) into r from (
      select c.id as count_id, c.day as tanggal, case c.status when 'menunggu' then 'Menunggu keputusan' when 'diterima' then 'Diterima'
               when 'ditolak' then 'Ditolak' when 'diganti' then 'Diganti' end as status,
        case when c.closing then 'Tutup hari' else 'Biasa' end as jenis, i.name as barang, i.unit as satuan, i.sort,
        l.expected as sistem, l.counted as dihitung, l.counted - l.expected as selisih, l.thrown as dibuang,
        round((l.counted - l.expected) * i.unit_cost)::bigint as nilai_selisih,
        (select public._first_name(full_name) from profiles where id = coalesce(c.responsible_id, c.submitted_by)) as oleh
      from stock_counts c join stock_count_lines l on l.count_id = c.id join stock_items i on i.id = l.item_id
      where c.day between d1 and d2 and (v_status is null or c.status = case v_status when 'menunggu_keputusan' then 'menunggu' else v_status end)
        and (v_item is null or l.item_id = v_item::int)
    ) x;

  -- ============================================================ Laporan pembelian
  -- Pembelian rinci: every goods-in that wasn't cancelled.
  when 'beli_rinci' then
    select json_agg(x order by x.tanggal desc, x.id desc) into r from (
      select g.id, g.day as tanggal, i.name as barang, g.current_qty as jumlah, i.unit as satuan, coalesce(s.name, 'Tanpa pemasok') as pemasok,
        coalesce(q.no, '') as po, coalesce(g.slip_note, '') as surat_jalan,
        case when coalesce(g.total_cost, round(g.unit_cost * g.current_qty)) is not null and g.current_qty > 0
             then round(coalesce(g.total_cost, g.unit_cost * g.current_qty) / g.current_qty) end::bigint as harga_satuan,
        coalesce(g.total_cost, round(g.unit_cost * g.current_qty))::bigint as total,
        case g.status when 'diubah' then 'Diubah' else 'Aktif' end as status,
        (select public._first_name(full_name) from profiles where id = coalesce(g.responsible_id, g.received_by, g.created_by)) as penerima
      from stock_goods_in g join stock_items i on i.id = g.item_id
        left join stock_suppliers s on s.id = g.supplier_id left join stock_requests q on q.id = g.request_id
      where g.day between d1 and d2 and g.status <> 'dibatalkan'
        and (v_supplier is null or (v_supplier = 'tanpa' and g.supplier_id is null) or g.supplier_id::text = v_supplier)
        and (v_item is null or g.item_id = v_item::int)
    ) x;

  when 'beli_pemasok' then
    select json_agg(x order by x.total desc nulls last, x.pemasok) into r from (
      select coalesce(s.name, 'Tanpa pemasok') as pemasok, count(*) as kiriman, count(distinct g.item_id) as jenis_barang,
        count(*) filter (where coalesce(g.total_cost, g.unit_cost) is null) as tanpa_harga,
        sum(coalesce(g.total_cost, round(g.unit_cost * g.current_qty)))::bigint as total
      from stock_goods_in g left join stock_suppliers s on s.id = g.supplier_id
      where g.day between d1 and d2 and g.status <> 'dibatalkan'
      group by coalesce(s.name, 'Tanpa pemasok')
    ) x;

  when 'beli_barang' then
    select json_agg(x order by x.total desc nulls last, x.barang) into r from (
      select i.name as barang, i.unit as satuan, sum(g.current_qty) as jumlah, count(*) as kiriman,
        sum(coalesce(g.total_cost, round(g.unit_cost * g.current_qty)))::bigint as total,
        case when sum(g.current_qty) filter (where coalesce(g.total_cost, g.unit_cost) is not null) > 0
             then round(sum(coalesce(g.total_cost, round(g.unit_cost * g.current_qty))) / sum(g.current_qty) filter (where coalesce(g.total_cost, g.unit_cost) is not null)) end::bigint as rata_rata,
        min(round(coalesce(g.total_cost, g.unit_cost * g.current_qty) / nullif(g.current_qty, 0)))::bigint as termurah,
        max(round(coalesce(g.total_cost, g.unit_cost * g.current_qty) / nullif(g.current_qty, 0)))::bigint as termahal
      from stock_goods_in g join stock_items i on i.id = g.item_id
      where g.day between d1 and d2 and g.status <> 'dibatalkan'
        and (v_supplier is null or (v_supplier = 'tanpa' and g.supplier_id is null) or g.supplier_id::text = v_supplier)
      group by i.id, i.name, i.unit
    ) x;

  -- PO / permintaan barang outstanding: what was asked for and what is still to come.
  when 'beli_po' then
    select json_agg(x order by x.tanggal desc, x.no, x.barang) into r from (
      select q.no, q.day as tanggal, q.needed_by as dibutuhkan, coalesce(s.name, 'Tanpa pemasok') as pemasok,
        case q.status when 'dikirim' then 'Dikirim' when 'sebagian' then 'Diterima sebagian' when 'selesai' then 'Selesai' else 'Batal' end as status,
        i.name as barang, i.unit as satuan, l.qty as dipesan, rc.qty as diterima, greatest(l.qty - rc.qty, 0) as sisa,
        l.est_cost as harga_perkiraan,
        case when l.est_cost is not null then round(greatest(l.qty - rc.qty, 0) * l.est_cost)::bigint end as nilai_sisa
      from stock_requests q join stock_request_lines l on l.request_id = q.id join stock_items i on i.id = l.item_id
        left join stock_suppliers s on s.id = q.supplier_id
        cross join lateral (select coalesce(sum(g.current_qty), 0) as qty from stock_goods_in g
                             where g.request_id = q.id and g.item_id = l.item_id and g.status <> 'dibatalkan') rc
      where q.day between d1 and d2
        and (case when v_status is null or v_status = 'terbuka' then q.status in ('dikirim', 'sebagian') else true end)
        and (v_supplier is null or (v_supplier = 'tanpa' and q.supplier_id is null) or q.supplier_id::text = v_supplier)
    ) x;

  -- ============================================================ Laporan penjualan
  -- Every figure follows the rule in pos-reports.sql: a sale on its sale day, a batal or refund as a
  -- minus on the day it was approved (_rep_orders, _rep_lines, _rep_pay, _rep_voids).
  -- Penjualan ringkas: one figure per row.
  when 'jual_ringkas' then
    with o as (select * from public._rep_orders(d1, d2)), vv as (select * from public._rep_voids(d1, d2)),
      p as (select * from public._rep_pay(d1, d2)), l as (select * from public._rep_lines(d1, d2))
    select json_agg(json_build_object('n', n, 'keterangan', k, 'nilai', v, 'satuan', u) order by n) into r from (values
      -- Kotor and diskon are after batal and refund too, so kotor - diskon = bersih.
      (1, 'Penjualan kotor', (select coalesce(sum(subtotal), 0) from o)::bigint, 'rp'),
      (2, 'Diskon', (select coalesce(sum(discount), 0) from o)::bigint, 'rp'),
      (3, 'Batal dan refund yang sudah dikurangkan', (select coalesce(-sum(total), 0) from o where ev <> 'jual')::bigint, 'rp'),
      (4, 'Penjualan bersih', (select coalesce(sum(total), 0) from o)::bigint, 'rp'),
      (5, 'Struk dibayar', (select coalesce(sum(receipts), 0) from o)::bigint, 'n'),
      (6, 'Rata-rata per struk', (select case when sum(receipts) > 0 then round(sum(total)::numeric / sum(receipts)) else 0 end from o)::bigint, 'rp'),
      (7, 'Produk terjual (tanpa paper bag)', (select coalesce(sum(l.qty), 0) from l where l.product_code is distinct from 'bag')::bigint, 'n'),
      (8, 'Tunai', (select coalesce(sum(amount), 0) from p where method = 'tunai')::bigint, 'rp'),
      (9, 'QRIS', (select coalesce(sum(amount), 0) from p where method = 'qris')::bigint, 'rp'),
      (10, 'Lainnya (platform, gratis, transfer)', (select coalesce(sum(amount), 0) from p where method not in ('tunai', 'qris'))::bigint, 'rp'),
      (11, 'Struk member', (select coalesce(sum(receipts), 0) from o where member_id is not null)::bigint, 'n'),
      (12, 'Dibatalkan', (select count(*) from vv where kind = 'batal')::bigint, 'n'),
      (13, 'Nilai dibatalkan', (select coalesce(sum(amount), 0) from vv where kind = 'batal')::bigint, 'rp'),
      (14, 'Refund', (select count(*) from vv where kind = 'refund')::bigint, 'n'),
      (15, 'Nilai refund', (select coalesce(sum(amount), 0) from vv where kind = 'refund')::bigint, 'rp'),
      (16, 'Item promo', (select coalesce(sum(l.qty), 0) from l where l.promo_kind is not null and l.discount <> 0)::bigint, 'n'),
      (17, 'Pajak dan biaya layanan', 0::bigint, 'rp')) t(n, k, v, u);

  -- Penjualan rinci: one row per receipt on its sale day, cancelled ones too unless a status is chosen.
  -- A partial refund shows in Refund (rupiah) on the receipt; Batal dan refund lists it on its approval day.
  when 'jual_rinci' then
    select json_agg(x order by x.at, x.struk) into r from (
      select o.id, o.sold_at as at, public._pos_stamp(o.sold_at) as waktu, o.receipt_no as struk, coalesce(o.local_no, '') as no_offline,
        ch.label as saluran, coalesce(public._first_name(sp.full_name), '') as staf, coalesce(public._first_name(cp.full_name), '') as kasir,
        coalesce(mp.full_name, '') as pelanggan, public._pos_status_label(o.status) as status, public._pos_pay_label(o.payment_method) as metode,
        coalesce(o.payment_ref, '') as referensi, coalesce(o.promo_label, '') as promo,
        o.subtotal, o.discount as diskon, o.total, coalesce(o.cash_received, case when o.status = 'dibayar' then o.total end, 0) as dibayar,
        coalesce(o.change_given, 0) as kembalian,
        coalesce(rf.amount, 0)::bigint as refund,
        array_to_string(o.flags, ', ') as tanda
      from pos_orders o join pos_channels ch on ch.id = o.channel_id
        left join profiles sp on sp.id = o.served_by left join profiles cp on cp.id = o.cashier_id left join profiles mp on mp.id = o.member_id
        left join (select w.order_id, sum(w.amount) as amount from public._rep_voids(d1, greatest(d2, public._local(now())::date)) w group by w.order_id) rf on rf.order_id = o.id
      where o.sale_day between d1 and d2 and (v_status is null or o.status = v_status)
        and (v_method is null or o.payment_method = v_method) and (v_channel is null or o.channel_id = v_channel)
        and (v_staff is null or o.served_by::text = v_staff)
      limit 5000
    ) x;

  -- Penjualan rinci per barang: one row per item line on its sale day.
  when 'jual_rinci_barang' then
    select json_agg(x order by x.at, x.struk, x.line) into r from (
      select o.sold_at as at, i.line, o.receipt_no || '-' || i.line as id, public._pos_stamp(o.sold_at) as waktu, o.receipt_no as struk,
        public._pos_status_label(o.status) as status, public._pos_pay_label(o.payment_method) as metode,
        public._pos_group(i.product_code) as kategori, i.name as produk, coalesce(fl.label, '') as rasa, i.qty,
        round(i.line_total::numeric / i.qty)::bigint as harga, i.line_total as kotor, i.discount as diskon, i.line_total - i.discount as bersih,
        case when i.free_bag then 'Paper bag gratis' else '' end as catatan
      from pos_order_items i join pos_orders o on o.id = i.order_id left join pos_flavours fl on fl.id = i.flavour_id
      where o.sale_day between d1 and d2 and (v_status is null or o.status = v_status)
        and (v_method is null or o.payment_method = v_method) and (v_channel is null or o.channel_id = v_channel)
      limit 10000
    ) x;

  when 'jual_produk' then
    select json_agg(x order by x.kategori, x.bersih desc, x.produk) into r from (
      select public._pos_group(l.product_code) as kategori, l.name as produk, coalesce(l.product_code, '') as kode,
        sum(l.qty)::bigint as qty, sum(l.gross)::bigint as kotor, sum(l.discount)::bigint as diskon, sum(l.net)::bigint as bersih,
        case when sum(l.qty) > 0 then round(sum(l.net)::numeric / sum(l.qty)) end::bigint as rata_rata
      from public._rep_lines(d1, d2) l
      where (v_channel is null or l.channel_id = v_channel)
      group by public._pos_group(l.product_code), l.name, l.product_code
      having sum(l.qty) <> 0 or sum(l.net) <> 0
    ) x;

  when 'jual_kategori' then
    with l as (select public._pos_group(x.product_code) as kategori, x.order_id, x.ev, x.qty, x.net as bersih
                 from public._rep_lines(d1, d2) x where (v_channel is null or x.channel_id = v_channel))
    select json_agg(x order by x.bersih desc, x.kategori) into r from (
      select kategori, count(distinct order_id) filter (where ev = 'jual') as struk, sum(qty)::bigint as qty, sum(bersih)::bigint as bersih,
        round(100.0 * sum(bersih) / nullif((select sum(bersih) from l), 0), 1) as persen
      from l group by kategori having sum(qty) <> 0 or sum(bersih) <> 0
    ) x;

  -- Per rasa (VireoPOS "per Varian Produk"): product and flavour.
  when 'jual_rasa' then
    select json_agg(x order by x.produk, x.qty desc) into r from (
      select l.name as produk, coalesce(fl.label, 'Tanpa rasa') as rasa, sum(l.qty)::bigint as qty, sum(l.net)::bigint as bersih,
        round(100.0 * sum(l.qty) / nullif(sum(sum(l.qty)) over (partition by l.name), 0), 1) as persen_produk
      from public._rep_lines(d1, d2) l left join pos_flavours fl on fl.id = l.flavour_id
      where l.product_code is distinct from 'bag'
      group by l.name, fl.label, fl.sort having sum(l.qty) <> 0 or sum(l.net) <> 0
    ) x;

  -- Per jam: every hour the booth is open (08.00-21.00) plus any hour with a sale. A batal or refund
  -- counts in the hour it was approved.
  when 'jual_jam' then
    with p as (select o.*, extract(hour from public._local(o.at))::int as hr from public._rep_orders(d1, d2) o),
      q as (select l.*, extract(hour from public._local(l.at))::int as hr from public._rep_lines(d1, d2) l where l.product_code is distinct from 'bag')
    select json_agg(x order by x.h) into r from (
      select h.h, lpad(h.h::text, 2, '0') || '.00-' || lpad(h.h::text, 2, '0') || '.59' as jam,
        coalesce((select sum(receipts) from p where p.hr = h.h), 0)::bigint as struk,
        coalesce((select sum(q.qty) from q where q.hr = h.h), 0)::bigint as qty,
        coalesce((select sum(total) from p where p.hr = h.h), 0)::bigint as bersih,
        coalesce((select case when sum(receipts) > 0 then round(sum(total)::numeric / sum(receipts)) end from p where p.hr = h.h), 0)::bigint as rata_rata
      from (select generate_series(least(8, coalesce((select min(hr) from p), 8)), greatest(20, coalesce((select max(hr) from p), 20))) as h) h
    ) x;

  when 'jual_harian' then
    -- Grouped once per day, then joined to every day of the range.
    with o as (select * from public._rep_orders(d1, d2)),
    od as (
      select o.day as d, sum(o.receipts) as struk,
        coalesce(sum(o.subtotal) filter (where o.ev = 'jual'), 0) as kotor,
        coalesce(sum(o.discount) filter (where o.ev = 'jual'), 0) as diskon,
        coalesce(-sum(o.total) filter (where o.ev <> 'jual'), 0) as refund,
        coalesce(sum(o.total), 0) as bersih,
        case when sum(o.receipts) > 0 then round(sum(o.total)::numeric / sum(o.receipts)) else 0 end as rata_rata,
        count(*) filter (where o.ev <> 'jual') as batal
      from o group by o.day),
    iq as (select l.day as d, sum(l.qty) as qty from public._rep_lines(d1, d2) l where l.product_code is distinct from 'bag' group by l.day)
    select json_agg(x order by x.tanggal) into r from (
      select g.d::date as tanggal, public._lap2_day_name(g.d::date) as hari,
        coalesce(od.struk, 0) as struk, coalesce(iq.qty, 0)::bigint as qty,
        coalesce(od.kotor, 0)::bigint as kotor, coalesce(od.diskon, 0)::bigint as diskon, coalesce(od.refund, 0)::bigint as refund,
        coalesce(od.bersih, 0)::bigint as bersih, coalesce(od.rata_rata, 0)::bigint as rata_rata,
        coalesce(od.batal, 0) as batal
      from generate_series(d1, d2, interval '1 day') g(d)
      left join od on od.d = g.d::date left join iq on iq.d = g.d::date
    ) x;

  when 'jual_staf' then
    with o as (select * from public._rep_orders(d1, d2)),
      q as (select l.served_by, sum(l.qty) as qty from public._rep_lines(d1, d2) l where l.product_code is distinct from 'bag' group by l.served_by)
    select json_agg(x order by x.bersih desc) into r from (
      select coalesce(o.served_by::text, 'kosong') as id, coalesce(p.full_name, 'Tidak dicatat') as staf, sum(o.receipts) as struk,
        coalesce((select q.qty from q where q.served_by is not distinct from o.served_by), 0)::bigint as qty,
        sum(o.total)::bigint as bersih, case when sum(o.receipts) > 0 then round(sum(o.total)::numeric / sum(o.receipts)) end::bigint as rata_rata,
        sum(o.commission)::bigint as komisi
      from o left join profiles p on p.id = o.served_by
      group by o.served_by, p.full_name
    ) x;

  -- Per metode bayar; group 'hari' splits it per day (VireoPOS tab Harian). A split order counts in both
  -- methods (pos_order_payments); a refund comes off its refund method on its approval day.
  when 'jual_metode' then
    select json_agg(x order by x.tanggal nulls first, x.total desc) into r from (
      select case when v_group = 'hari' then p.day end as tanggal, public._pos_pay_label(p.method) as metode,
        count(distinct p.order_id) filter (where p.ev = 'jual') as struk, sum(p.amount)::bigint as total,
        round(100.0 * sum(p.amount) / nullif(sum(sum(p.amount)) over (partition by case when v_group = 'hari' then p.day end), 0), 1) as persen
      from public._rep_pay(d1, d2) p
      group by 1, p.method
    ) x;

  -- Per pelanggan (member); walk-in sales in one row. Managers see the number masked.
  when 'jual_member' then
    select json_agg(x order by x.total desc, x.pelanggan) into r from (
      select coalesce(o.member_id::text, 'tanpa') as id, case when o.member_id is null then 'Tanpa kartu member' else coalesce(m.full_name, 'Member') end as pelanggan,
        public._rep_phone(m.whatsapp) as whatsapp, sum(o.receipts) as struk, sum(o.total)::bigint as total,
        case when sum(o.receipts) > 0 then round(sum(o.total)::numeric / sum(o.receipts)) end::bigint as rata_rata,
        sum(o.stamps)::bigint as stempel, max(o.sale_day) as terakhir
      from public._rep_orders(d1, d2) o left join profiles m on m.id = o.member_id
      where (v_q = '' or lower(coalesce(m.full_name, '')) like '%' || v_q || '%'
             or (public._rep_is_owner() and regexp_replace(v_q, '\D', '', 'g') <> '' and regexp_replace(coalesce(m.whatsapp, ''), '\D', '', 'g') like '%' || regexp_replace(v_q, '\D', '', 'g') || '%'))
      group by o.member_id, m.full_name, m.whatsapp
    ) x;

  when 'jual_saluran' then
    select json_agg(x order by x.bersih desc) into r from (
      select c.label as saluran, sum(o.receipts) as struk, sum(o.subtotal)::bigint as kotor, sum(o.discount)::bigint as diskon, sum(o.total)::bigint as bersih,
        case when sum(o.receipts) > 0 then round(sum(o.total)::numeric / sum(o.receipts)) end::bigint as rata_rata
      from public._rep_orders(d1, d2) o join pos_channels c on c.id = o.channel_id
      group by c.label, c.sort
    ) x;

  -- Promo (Glenn, 13 Nov 2026): per promo kind (BOGO, 50% malam, 50% instruksi, Tebus Murah, vouchers,
  -- hadiah stempel, Promo POS) how many receipts used it, how many items got the promo price, and the
  -- rupiah discount. Group 'jenis' sums every promo of one kind; the default lists each promo name.
  when 'jual_promo' then
    with o as (select * from public._rep_orders(d1, d2) x where x.promo_kind is not null),
      pi as (select l.order_id, l.ev, l.request_id, sum(l.qty) filter (where l.discount <> 0) as items
               from public._rep_lines(d1, d2) l where l.promo_kind is not null group by 1, 2, 3)
    select json_agg(x order by x.urut, x.promo) into r from (
      select public._rep_promo_sort(o.promo_kind) as urut, public._rep_promo_label(o.promo_kind) as jenis,
        case when v_group = 'jenis' then public._rep_promo_label(o.promo_kind) else coalesce(o.promo_label, public._rep_promo_label(o.promo_kind)) end as promo,
        sum(o.receipts) as dipakai, coalesce(sum(pi.items), 0)::bigint as item, sum(o.subtotal)::bigint as kotor, sum(o.discount)::bigint as diskon,
        sum(o.total)::bigint as bersih
      from o left join pi on pi.order_id = o.order_id and pi.ev = o.ev and pi.request_id is not distinct from o.request_id
      group by o.promo_kind, 3
    ) x;

  -- Batal dan refund: every approved batal or refund on the day it was approved, with the amount that went back.
  when 'jual_batal' then
    select json_agg(x order by x.at) into r from (
      select coalesce(v.request_id::text, o.id::text) as id, v.at, public._pos_stamp(v.at) as waktu, public._pos_stamp(o.sold_at) as waktu_jual,
        o.receipt_no as struk, case v.kind when 'batal' then 'Dibatalkan' else 'Pengembalian' end as status,
        case when v.whole then 'Seluruh pesanan' when v.lines is not null then 'Sebagian barang' else 'Sebagian uang' end as bagian,
        public._pos_pay_label(coalesce(v.refund_method, o.payment_method)) as metode, v.amount::bigint as total, coalesce(v.reason, '') as alasan,
        coalesce(public._first_name(rq.full_name), '') as diminta, coalesce(public._first_name(dc.full_name), '') as disetujui,
        public._pos_stamp(v.at) as diputuskan
      from public._rep_voids(d1, d2) v join pos_orders o on o.id = v.order_id
        left join profiles rq on rq.id = v.requested_by left join profiles dc on dc.id = v.decided_by
      where (v_status is null or v.kind = v_status)
    ) x;

  -- ============================================================ Laporan laba
  -- Laba follows the same rule: a refund takes its sales (and, for a whole order, its harga pokok) off on its approval day.
  when 'laba_produk' then
    with l as (select x.day, x.name, x.qty, x.net as rev, x.discount, x.cost, x.est from public._rep_lines(d1, d2) x)
    select json_agg(x order by x.tanggal nulls first, x.laba desc, x.produk) into r from (
      select case when v_group = 'hari' then day end as tanggal, name as produk, sum(qty)::bigint as qty, sum(discount)::bigint as diskon,
        sum(rev)::bigint as penjualan, sum(cost)::bigint as hpp, sum(rev - cost)::bigint as laba,
        round(100.0 * sum(rev - cost) / nullif(sum(rev), 0), 1) as margin, case when bool_or(est) then 'Perkiraan' else '' end as catatan
      from l group by 1, name having sum(qty) <> 0 or sum(rev) <> 0 or sum(cost) <> 0
    ) x;

  when 'laba_hari' then
    with l as (select x.day, x.net as rev, x.discount, x.cost, x.est from public._rep_lines(d1, d2) x)
    select json_agg(x order by x.tanggal) into r from (
      select day as tanggal, public._lap2_day_name(day) as hari, sum(rev)::bigint as penjualan, sum(discount)::bigint as diskon,
        sum(cost)::bigint as hpp, sum(rev - cost)::bigint as laba, round(100.0 * sum(rev - cost) / nullif(sum(rev), 0), 1) as margin,
        case when bool_or(est) then 'Perkiraan' else '' end as catatan
      from l group by day
    ) x;

  -- One row per receipt on its sale day, and one minus row per batal or refund on its approval day.
  when 'laba_transaksi' then
    with l as (select * from public._rep_lines(d1, d2))
    select json_agg(x order by x.at) into r from (
      select o.order_id::text || coalesce(':' || o.request_id, case when o.ev <> 'jual' then ':' || o.ev else '' end) as id, o.at,
        public._pos_stamp(o.at) as waktu, o.receipt_no as struk,
        case o.ev when 'jual' then public._pos_pay_label(o.payment_method) when 'batal' then 'Dibatalkan' else 'Refund' end as metode,
        o.total as penjualan, c.cost::bigint as hpp, (o.total - c.cost)::bigint as laba, round(100.0 * (o.total - c.cost) / nullif(o.total, 0), 1) as margin,
        case when c.est then 'Perkiraan' else '' end as catatan
      from public._rep_orders(d1, d2) o cross join lateral (
        select coalesce(sum(l.cost), 0) as cost, coalesce(bool_or(l.est), false) as est from l
         where l.order_id = o.order_id and l.ev = o.ev and l.request_id is not distinct from o.request_id) c
      limit 5000
    ) x;

  -- ============================================================ Laporan lainnya
  -- Rekapitulasi kas: one row per shift opened in the range.
  when 'kas_rekap' then
    select json_agg(x order by x.at) into r from (
      select sh.id, sh.opened_at as at, public._pos_stamp(sh.opened_at) as mulai, public._pos_stamp(sh.closed_at) as berakhir,
        coalesce(sh.device, '') as perangkat, coalesce(public._first_name(op.full_name), '') as staf, sh.opening_cash as modal,
        coalesce((select sum(o.total) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0)::bigint as penjualan,
        -- Tunai part: pos_order_payments (split orders) when it exists, else Tunai orders.
        coalesce(case when public._rep_has('pos_order_payments') then public._rep_shift_tunai(sh.id)
          else (select sum(o.total) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar' and o.payment_method = 'tunai') end, 0)::bigint as tunai,
        coalesce((select sum(c.amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'masuk'), 0)::bigint as kas_masuk,
        coalesce((select sum(c.amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'keluar'), 0)::bigint as kas_keluar,
        coalesce((select sum(c.amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'setor'), 0)::bigint as setor,
        coalesce(sh.expected_cash, public._pos_expected_cash(sh.id))::bigint as seharusnya, sh.counted_cash::bigint as dihitung,
        case when sh.counted_cash is null then null else sh.counted_cash - coalesce(sh.expected_cash, 0) end::bigint as selisih,
        case when sh.closed_at is null then 'Berjalan' else 'Ditutup' end as status
      from pos_shifts sh left join profiles op on op.id = sh.opened_by
      where public._local(sh.opened_at)::date between d1 and d2
    ) x;

  -- Kas masuk dan kas keluar (setor included), with the shift.
  when 'kas_gerak' then
    select json_agg(x order by x.at) into r from (
      select c.id, c.created_at as at, public._pos_stamp(c.created_at) as waktu,
        case c.kind when 'masuk' then 'Kas masuk' when 'keluar' then 'Kas keluar' else 'Setor ke pemilik' end as jenis,
        case when c.kind = 'masuk' then c.amount else 0 end::bigint as masuk, case when c.kind <> 'masuk' then c.amount else 0 end::bigint as keluar,
        c.reason as alasan, coalesce(public._first_name(p.full_name), '') as oleh, c.shift_id as shift
      from pos_cash_moves c left join profiles p on p.id = c.created_by
      where public._local(c.created_at)::date between d1 and d2 and (v_kind is null or c.kind = v_kind)
    ) x;

  when 'diskon' then
    select json_agg(x order by x.at) into r from (
      select o.id, o.sold_at as at, public._pos_stamp(o.sold_at) as waktu, o.receipt_no as struk, coalesce(m.full_name, '') as pelanggan,
        coalesce(o.promo_label, public._lap2_promo_label(o.promo_kind), '') as promo, o.subtotal, o.discount as diskon, o.total
      from pos_orders o left join profiles m on m.id = o.member_id
      where o.sale_day between d1 and d2 and o.status = 'dibayar' and o.discount > 0
    ) x;

  -- Harga pokok penjualan: per product (the cost each line kept), or per bahan (stock used by sales
  -- at today's harga pokok).
  when 'hpp' then
    if v_group = 'bahan' then
      select json_agg(x order by x.hpp desc, x.barang) into r from (
        select i.name as barang, i.unit as satuan, -sum(m.qty) as qty, i.unit_cost as harga_pokok, round(-sum(m.qty) * i.unit_cost)::bigint as hpp
        from stock_moves m join stock_items i on i.id = m.item_id
        where m.day between d1 and d2 and m.kind in ('penjualan', 'batal_penjualan')
        group by i.id, i.name, i.unit, i.unit_cost having sum(m.qty) <> 0
      ) x;
    else
      select json_agg(x order by x.hpp desc, x.produk) into r from (
        select l.name as produk, sum(l.qty)::bigint as qty, sum(l.cost)::bigint as hpp,
          case when sum(l.qty) > 0 then round(sum(l.cost)::numeric / sum(l.qty)) end::bigint as per_satuan,
          case when bool_or(l.est) then 'Perkiraan' else '' end as catatan
        from public._rep_lines(d1, d2) l
        group by l.name having sum(l.qty) <> 0 or sum(l.cost) <> 0
      ) x;
    end if;

  when 'komisi' then
    select json_agg(x order by x.komisi desc) into r from (
      select coalesce(o.served_by::text, 'kosong') as id, coalesce(p.full_name, 'Tidak dicatat') as staf, sum(o.receipts) as struk,
        sum(o.total)::bigint as penjualan, sum(o.commission)::bigint as komisi
      from public._rep_orders(d1, d2) o left join profiles p on p.id = o.served_by
      where (v_staff is null or o.served_by::text = v_staff)
      group by o.served_by, p.full_name
    ) x;

  -- Proses komisi: payouts recorded in Transaksi > Proses komisi whose period overlaps the range.
  when 'komisi_proses' then
    select json_agg(x order by x.dari desc, x.staf) into r from (
      select y.id, y.period_from as dari, y.period_to as sampai, coalesce(p.full_name, '') as staf, y.orders as struk, y.sales::bigint as penjualan,
        y.commission::bigint as komisi,
        case when y.cancelled_at is not null then 'Dibatalkan' when y.paid_at is not null then 'Dibayar' else 'Diproses' end as status,
        public._pos_stamp(y.processed_at) as diproses, public._pos_stamp(y.paid_at) as dibayar, coalesce(y.note, y.cancel_reason, '') as catatan
      from pos_commission_payouts y join profiles p on p.id = y.staff_id
      where y.period_from <= d2 and y.period_to >= d1 and (v_staff is null or y.staff_id::text = v_staff)
    ) x;

  -- Penggunaan voucher dan hadiah: every reward or voucher used (not undone), from the till and the old cashier page.
  when 'voucher' then
    select json_agg(x order by x.at) into r from (
      select d.id, d.created_at as at, public._pos_stamp(d.created_at) as waktu, coalesce(m.full_name, '') as member,
        public._lap2_promo_label(d.kind) as jenis, d.reward_label as hadiah, coalesce(o.receipt_no, '') as struk,
        coalesce(o.discount, 0)::bigint as diskon, coalesce(public._first_name(s.full_name), '') as kasir,
        case when o.id is null then 'Kasir lama' else 'Kasir baru' end as dari
      from redemptions d left join profiles m on m.id = d.member_id left join profiles s on s.id = d.staff_id
        left join pos_orders o on o.id = d.order_id
      where public._local(d.created_at)::date between d1 and d2 and d.reversed_at is null and (v_kind is null or d.kind = v_kind)
    ) x;

  -- Transaksi pelanggan: every member receipt with what was bought.
  when 'transaksi_pelanggan' then
    select json_agg(x order by x.at) into r from (
      select o.id, o.sold_at as at, public._pos_stamp(o.sold_at) as waktu, o.receipt_no as struk, coalesce(m.full_name, 'Member') as member,
        public._rep_phone(m.whatsapp) as whatsapp,
        (select string_agg(i.qty || 'x ' || i.name || coalesce(' ' || fl.label, ''), ', ' order by i.line)
           from pos_order_items i left join pos_flavours fl on fl.id = i.flavour_id where i.order_id = o.id) as barang,
        coalesce(o.promo_label, '') as promo, o.total, o.stamps as stempel, public._pos_status_label(o.status) as status
      from pos_orders o join profiles m on m.id = o.member_id
      where o.sale_day between d1 and d2 and (v_status is null or o.status = v_status)
        and (v_q = '' or lower(coalesce(m.full_name, '')) like '%' || v_q || '%' or (public._rep_is_owner() and regexp_replace(v_q, '\D', '', 'g') <> '' and regexp_replace(coalesce(m.whatsapp, ''), '\D', '', 'g') like '%' || regexp_replace(v_q, '\D', '', 'g') || '%'))
      limit 5000
    ) x;

  else
    raise exception 'Laporan tidak dikenal.';
  end case;

  return json_build_object('report', p_report, 'from', d1, 'to', d2, 'rows', coalesce(r, '[]'::json));
end $$;

-- ---------------------------------------------------------------- Akunting: Neraca bulanan
-- Balance-sheet accounts per month end, side by side, with the month's debit and kredit.
-- Saldo is on the account's side (aset: debit minus kredit; kewajiban and ekuitas: kredit minus debit).
-- "Laba (rugi) berjalan" is pendapatan minus beban up to that month end, as in acc_balance_sheet.
create or replace function public.acc_balance_monthly(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();
  m1 date; m2 date;
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pilih bulan dari dan sampai.'; end if;
  m1 := date_trunc('month', p_from)::date; m2 := date_trunc('month', p_to)::date;
  if (extract(year from m2) - extract(year from m1)) * 12 + extract(month from m2) - extract(month from m1) > 23 then
    raise exception 'Pilih paling banyak 24 bulan.';
  end if;
  return (with months as (
      select g::date as m, (g + interval '1 month - 1 day')::date as e, row_number() over (order by g) as n
        from generate_series(m1, m2, interval '1 month') g),
    acc as (select * from acc_accounts a where a.type in ('aset', 'kewajiban', 'ekuitas')),
    sg as (select a.id, case when a.type = 'aset' then 1 else -1 end as s from acc a),
    cells as (
      select a.id, mo.n, mo.m,
        coalesce((select sum(l.debit) from acc_lines l join acc_journals j on j.id = l.journal_id where l.account_id = a.id and j.day between mo.m and mo.e), 0)::bigint as debit,
        coalesce((select sum(l.credit) from acc_lines l join acc_journals j on j.id = l.journal_id where l.account_id = a.id and j.day between mo.m and mo.e), 0)::bigint as credit,
        (coalesce((select sum(l.debit - l.credit) from acc_lines l join acc_journals j on j.id = l.journal_id where l.account_id = a.id and j.day <= mo.e), 0)
          * (select s from sg where sg.id = a.id))::bigint as saldo
      from acc a cross join months mo),
    opening as (
      select a.id, (coalesce((select sum(l.debit - l.credit) from acc_lines l join acc_journals j on j.id = l.journal_id where l.account_id = a.id and j.day < m1), 0)
               * (select s from sg where sg.id = a.id))::bigint as saldo from acc a),
    used as (select id from cells group by id having bool_or(debit <> 0 or credit <> 0 or saldo <> 0)
             union select id from opening where saldo <> 0),
    profit as (
      select mo.n, coalesce((select sum(l.credit - l.debit) from acc_lines l join acc_accounts a on a.id = l.account_id join acc_journals j on j.id = l.journal_id
                              where a.type in ('pendapatan', 'beban') and j.day <= mo.e), 0)::bigint as saldo,
        coalesce((select sum(l.credit - l.debit) from acc_lines l join acc_accounts a on a.id = l.account_id join acc_journals j on j.id = l.journal_id
                   where a.type in ('pendapatan', 'beban') and j.day between mo.m and mo.e), 0)::bigint as month_profit
        from months mo),
    tot as (
      select mo.n,
        coalesce(sum(c.saldo) filter (where a.type = 'aset'), 0)::bigint as aset,
        coalesce(sum(c.saldo) filter (where a.type = 'kewajiban'), 0)::bigint as kewajiban,
        coalesce(sum(c.saldo) filter (where a.type = 'ekuitas'), 0)::bigint as ekuitas
        from months mo left join cells c on c.n = mo.n left join acc a on a.id = c.id group by mo.n)
    select json_build_object('from', m1, 'to', (select max(e) from months),
      'months', (select json_agg(json_build_object('key', to_char(m, 'YYYY-MM'), 'label', public._pos_month_name(extract(month from m)::int) || ' ' || extract(year from m)::int,
                   'end', e) order by n) from months),
      'rows', coalesce((select json_agg(json_build_object('id', a.id, 'code', a.code, 'name', a.name, 'type', a.type,
                  'opening', (select saldo from opening o where o.id = a.id),
                  'months', (select json_agg(json_build_object('debit', c.debit, 'credit', c.credit, 'saldo', c.saldo) order by c.n) from cells c where c.id = a.id))
                order by a.code) from acc a where a.id in (select id from used)), '[]'),
      'profit', (select json_agg(json_build_object('saldo', p.saldo, 'month', p.month_profit) order by p.n) from profit p),
      'totals', (select json_agg(json_build_object('aset', t.aset, 'kewajiban', t.kewajiban, 'ekuitas', t.ekuitas + p.saldo,
                   'balanced', t.aset = t.kewajiban + t.ekuitas + p.saldo) order by t.n) from tot t join profit p on p.n = t.n)));
end $$;

-- ---------------------------------------------------------------- Akunting: Laporan jurnal
-- Every journal line in the range, optionally for one account or one source. The page groups by account.
create or replace function public.acc_journal_lines(p_from date, p_to date, p_account bigint default null, p_source text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader(); src text := nullif(nullif(trim(coalesce(p_source, '')), ''), 'semua');
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
  if src is not null and src not in ('manual', 'penjualan', 'batal', 'pembelian', 'kas', 'stok', 'komisi') then raise exception 'Sumber jurnal tidak dikenal.'; end if;
  return json_build_object('from', p_from, 'to', p_to, 'rows', coalesce((select json_agg(x order by x.tanggal, x.journal_id, x.id) from (
    select l.id, j.id as journal_id, j.day as tanggal, j.no, j.description as keterangan, j.source as sumber, coalesce(j.source_id, '') as referensi,
      a.id as account_id, a.code as kode, a.name as akun, a.type as jenis, l.debit, l.credit as kredit, coalesce(l.memo, '') as memo,
      case when j.reversed_by is not null then 'Dibatalkan' when j.reverses is not null then 'Pembatalan' else '' end as status
    from acc_lines l join acc_journals j on j.id = l.journal_id join acc_accounts a on a.id = l.account_id
    where j.day between p_from and p_to and (p_account is null or a.id = p_account) and (src is null or j.source = src)
    limit 20000) x), '[]'));
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
       and p.proname in ('_lap2_range', '_lap2_f', '_lap2_day_name', '_lap2_kind_label', '_lap2_promo_label', '_rep_shift_tunai',
                         'owner_laporan', 'acc_balance_monthly', 'acc_journal_lines')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then execute format('revoke all on function %s from authenticated', f.sig);
    else execute format('grant execute on function %s to authenticated', f.sig); end if;
  end loop;
end $$;
