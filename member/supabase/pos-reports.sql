-- Hanashuya POS: reports and live statistics (task 8a + first part of task 8).
-- Run AFTER schema.sql and pos.sql, in the Supabase SQL Editor. Re-running is safe.
--
-- What it adds (all read-only, no tables):
--   owner_pos_stats(from, to)   numbers for the "Laporan POS" tab: sales, receipts, average,
--                               by hour / day / month, last 7 days, top products, product groups,
--                               payment methods, channels, staff with 1% commission, promos, voids,
--                               cards made on the tablet per cashier (audit_log 'daftar_lewat_kasir').
--   owner_pos_report(from, to)  rows for the four VireoPOS-style sheets, with the same column names:
--                               Rangkuman, Rincian, Penjualan per Produk, Rekapitulasi Kas.
--   staff_daily_summary()       today's Daily Sales Report text for the team WhatsApp group (SOP Bab 14).
--
-- Who may call: the owner and the manager (statistics and reports, read-only; Glenn, 13 Nov 2026).
-- There is no staff bank data here; member WhatsApp numbers are shown whole to the owner only.
-- staff_daily_summary() may also be called by staff.
--
-- One rule for every sales figure (Glenn, 13 Nov 2026), here and in pos-home, pos-backoffice,
-- pos-laporan, pos-laporan2, pos-transaksi and akunting:
--   * A paid order counts on its sale_day (the local date at the booth), whatever happened to it later.
--   * A batal or refund of a paid order counts as a minus on the day it was approved
--     (pos_void_requests.decided_at in booth time), for the amount refunded. A cancelled paid order
--     with no approved request (older data) takes its minus on its sale day.
--   * So a refund approved today lowers today's figures, not the original sale day's.
--   * Money is the price paid (pos_orders.total; line_total - discount per line). Free orders
--     (payment 'gratis') count as receipts with Rp0.
--   * Tunai / QRIS splits use pos_order_payments when that table exists (one row per method), else the
--     order's payment_method. A refund goes out by its refund_method when set, else by the order's split.
--   * Partial refunds (pos_void_requests.amount and lines, when those columns exist): the amount comes off
--     on the approval day and returned lines lower the product counts; the receipt still counts. A
--     whole-order batal or refund also takes the receipt off (-1).
-- The helpers _rep_orders, _rep_lines, _rep_pay and _rep_voids give those signed rows; the reports sum them.
-- They read the till's newer columns only when they exist (to_regclass / pg_attribute), so this file runs
-- before or after the till's changes.

-- ---------------------------------------------------------------- helpers
-- Product group = the product's category in Produk (pos_categories, 12 Nov 2026), so a
-- category the owner adds shows up in the reports by itself. Products without one: 'Lainnya'.
create or replace function public._pos_group(code text) returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((select c.name from menu_items m join pos_categories c on c.id = m.category_id where m.code = $1), 'Lainnya')
$$;

create or replace function public._pos_stamp(ts timestamptz) returns text
language sql stable security definer set search_path = public
as $$ select case when ts is null then '' else to_char(public._local(ts), 'YYYY-MM-DD HH24:MI:SS') end $$;

create or replace function public._pos_pay_label(m text) returns text
language sql immutable
as $$ select case m when 'tunai' then 'Tunai' when 'qris' then 'QRIS' when 'platform' then 'Platform' when 'gratis' then 'Gratis' when 'transfer' then 'Transfer' when 'campur' then 'Tunai + QRIS' else coalesce(m, '') end $$;

create or replace function public._pos_status_label(s text) returns text
language sql immutable
as $$ select case s when 'dibayar' then 'Selesai' when 'batal' then 'Dibatalkan' when 'refund' then 'Pengembalian' when 'menunggu' then 'Menunggu pembayaran' else coalesce(s, '') end $$;

create or replace function public._pos_month_name(m int) returns text
language sql immutable
as $$ select (array['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'])[m] $$;

-- ---------------------------------------------------------------- one rule for every report (13 Nov 2026)
-- Reading the back-office reports: the owner and the manager (Glenn, 13 Nov 2026).
create or replace function public._rep_reader() returns uuid
language plpgsql stable security definer set search_path = public
as $$ begin return public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); end $$;

create or replace function public._rep_is_owner() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from profiles where id = auth.uid() and role = 'owner' and deleted_at is null) $$;

-- A member's WhatsApp number in a report: whole for the owner, masked for a manager (0815••••1234).
create or replace function public._rep_phone(w text) returns text
language sql stable security definer set search_path = public
as $$ select case when coalesce(w, '') = '' then '' when public._rep_is_owner() then w
  else '0' || substr(w, 3, 3) || '••••' || right(w, 4) end $$;

-- Does a table (or one of its columns) exist? The till's newer pieces are read only when they do.
create or replace function public._rep_has(p_table text, p_col text default null) returns boolean
language sql stable security definer set search_path = public
as $$ select case when to_regclass('public.' || p_table) is null then false when p_col is null then true
  else exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || p_table) and a.attname = p_col and a.attnum > 0 and not a.attisdropped) end $$;

-- Promo kinds, as the reports name them. 'malam50' (50% malam) and 'instruksi50' (50% atas instruksi) come from the till.
create or replace function public._rep_promo_label(k text) returns text
language sql immutable
as $$ select case k when 'bogo' then 'BOGO Deals' when 'malam50' then 'Diskon 50% malam' when 'instruksi50' then 'Diskon 50% instruksi'
  when 'tebus_murah' then 'Tebus Murah Rp1' when 'welcome' then 'Diskon member baru 50%' when 'ulang_tahun' then 'Hadiah ulang tahun'
  when 'kode' then 'Voucher kertas' when 'stempel' then 'Hadiah stempel' when 'promo' then 'Promo POS' else coalesce(k, '') end $$;

create or replace function public._rep_promo_sort(k text) returns int
language sql immutable
as $$ select coalesce(array_position(array['bogo', 'malam50', 'instruksi50', 'tebus_murah', 'welcome', 'ulang_tahun', 'kode', 'stempel', 'promo'], k), 99) $$;

-- Commission of one order by the rules in Tim > Komisi, whatever its status now (the minus row of a
-- refund takes the same share back).
create or replace function public._rep_commission(p_order uuid) returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(round(sum(case when r.kind = 'persen' then (i.line_total - i.discount) * r.value / 100.0 else i.qty * r.value end)), 0)::int
    from pos_order_items i join pos_orders o on o.id = i.order_id
    cross join lateral (select * from pos_commission_rules x
       where x.active and o.sale_day between x.starts_on and coalesce(x.ends_on, date '9999-12-31')
         and (x.product_code = i.product_code or x.product_code is null)
       order by (x.product_code is null), x.starts_on desc, x.id desc limit 1) r
   where i.order_id = p_order and not i.free_bag
$$;

-- Approved batal and refund requests of paid orders, on the day they were approved (booth time).
--   amount  what came off (pos_void_requests.amount when the till sends it, else the returned lines, else the whole order)
--   whole   the whole order went back (the receipt counts -1)
--   frac    amount / order total, used to share the discount and the commission
--   lines   [{line, qty}] of a partial refund, null for the whole order or a money-only refund
create or replace function public._rep_voids(d1 date, d2 date)
returns table (request_id bigint, order_id uuid, kind text, day date, at timestamptz, amount int, whole boolean, frac numeric,
               lines jsonb, refund_method text, reason text, requested_by uuid, decided_by uuid)
language plpgsql stable security definer set search_path = public
as $$
declare
  c_amt text := case when public._rep_has('pos_void_requests', 'amount') then 'v.amount::int' else 'null::int' end;
  c_lin text := case when public._rep_has('pos_void_requests', 'lines') then 'v.lines' else 'null::jsonb' end;
  c_met text := case when public._rep_has('pos_void_requests', 'refund_method') then 'v.refund_method::text' else 'null::text' end;
begin
  return query execute format($q$
    with v as (
      select v.id, v.order_id, v.kind, public._local(v.decided_at)::date as day, v.decided_at as at, v.reason, v.requested_by, v.decided_by,
             %1$s as amt, case when jsonb_typeof(%2$s) = 'array' and jsonb_array_length(%2$s) > 0 then %2$s end as lns, %3$s as met
        from pos_void_requests v
       where v.status = 'disetujui' and v.decided_at is not null and public._local(v.decided_at)::date between $1 and $2),
    x as (
      select v.*, o.total,
             least(coalesce(v.amt, case when v.lns is null then o.total else (
               select coalesce(sum(round((i.line_total - i.discount) * least(coalesce((e ->> 'qty')::numeric, i.qty), i.qty) / i.qty)), 0)
                 from jsonb_array_elements(v.lns) e join pos_order_items i on i.order_id = o.id and i.line = (e ->> 'line')::int) end), o.total) as amount0
        from v join pos_orders o on o.id = v.order_id
       where o.payment_method is not null)
    select x.id, x.order_id, x.kind, x.day, x.at, x.amount0::int, (x.lns is null and x.amount0 >= x.total),
           case when x.total > 0 then x.amount0::numeric / x.total else 1 end, x.lns, x.met, x.reason, x.requested_by, x.decided_by
      from x
    union all
    select null::bigint, o.id, o.status, o.sale_day, o.sold_at, o.total, true, 1::numeric, null::jsonb, null::text, null::text, null::uuid, null::uuid
      from pos_orders o
     where o.payment_method is not null and o.status in ('batal', 'refund') and o.sale_day between $1 and $2
       and not exists (select 1 from pos_void_requests w where w.order_id = o.id and w.status = 'disetujui')
  $q$, c_amt, c_lin, c_met) using d1, d2;
end $$;

-- One request (any status): the amount it asks back, whether it is the whole order, and where the money goes.
create or replace function public._rep_request(p_id bigint)
returns table (amount int, whole boolean, method text)
language plpgsql stable security definer set search_path = public
as $$
declare
  c_amt text := case when public._rep_has('pos_void_requests', 'amount') then 'v.amount::int' else 'null::int' end;
  c_lin text := case when public._rep_has('pos_void_requests', 'lines') then 'v.lines' else 'null::jsonb' end;
  c_met text := case when public._rep_has('pos_void_requests', 'refund_method') then 'v.refund_method::text' else 'null::text' end;
begin
  return query execute format($q$
    select least(coalesce(%1$s, case when jsonb_typeof(%2$s) = 'array' and jsonb_array_length(%2$s) > 0 then (
             select coalesce(sum(round((i.line_total - i.discount) * least(coalesce((e ->> 'qty')::numeric, i.qty), i.qty) / i.qty)), 0)
               from jsonb_array_elements(%2$s) e join pos_order_items i on i.order_id = o.id and i.line = (e ->> 'line')::int) end, o.total), o.total)::int,
           (coalesce(jsonb_array_length(case when jsonb_typeof(%2$s) = 'array' then %2$s end), 0) = 0 and coalesce(%1$s, o.total) >= o.total),
           %3$s
      from pos_void_requests v join pos_orders o on o.id = v.order_id where v.id = $1
  $q$, c_amt, c_lin, c_met) using p_id;
end $$;

-- Signed order rows: +1 per paid order on its sale day, a minus row per approved batal or refund on its
-- approval day. ev: 'jual', 'batal' or 'refund'. receipts: 1, -1 (whole order back) or 0 (partial).
create or replace function public._rep_orders(d1 date, d2 date)
returns table (ev text, day date, at timestamptz, order_id uuid, request_id bigint, receipts int, subtotal int, discount int, total int,
               commission int, receipt_no text, channel_id text, served_by uuid, member_id uuid, promo_kind text, promo_label text,
               payment_method text, stamps int, flags text[], sold_at timestamptz, sale_day date)
language sql stable security definer set search_path = public
as $$
  select 'jual'::text, o.sale_day, o.sold_at, o.id, null::bigint, 1, o.subtotal, o.discount, o.total, public._rep_commission(o.id),
         o.receipt_no, o.channel_id, o.served_by, o.member_id, o.promo_kind, o.promo_label, o.payment_method, o.stamps, o.flags, o.sold_at, o.sale_day
    from pos_orders o
   where o.sale_day between d1 and d2 and o.payment_method is not null and o.status in ('dibayar', 'batal', 'refund')
  union all
  select v.kind, v.day, v.at, o.id, v.request_id, case when v.whole then -1 else 0 end,
         -(v.amount + round(o.discount * v.frac))::int, -round(o.discount * v.frac)::int, -v.amount,
         -round(public._rep_commission(o.id) * v.frac)::int,
         o.receipt_no, o.channel_id, o.served_by, o.member_id, o.promo_kind, o.promo_label, o.payment_method,
         case when v.whole then -o.stamps else 0 end, o.flags, o.sold_at, o.sale_day
    from public._rep_voids(d1, d2) v join pos_orders o on o.id = v.order_id
$$;

-- Signed item rows, by the same rule. A whole-order batal or refund takes every line back (qty, money and
-- harga pokok, as the stock goes back too). A partial refund takes its lines' pieces, money and harga
-- pokok back (the till returns those pieces to stock); a refund with no lines and less than the total
-- (none made by the till) shares the amount over the lines with qty 0. The money of a minus row adds up
-- to the request's amount exactly (the biggest line takes the rounding).
create or replace function public._rep_lines(d1 date, d2 date)
returns table (ev text, day date, at timestamptz, order_id uuid, request_id bigint, line int, product_id int, product_code text, name text,
               flavour_id text, free_bag boolean, qty int, gross int, discount int, net int, cost int, est boolean,
               promo_kind text, channel_id text, served_by uuid, member_id uuid, payment_method text, receipt_no text)
language plpgsql stable security definer set search_path = public
as $$
declare
  -- The cost a line kept (pos-backoffice.sql) and today's harga pokok (stock.sql), when those files have run.
  c_cost text := case when public._rep_has('pos_order_items', 'cost') then 'i.cost' else 'null::int' end;
  c_unit text := case when to_regprocedure('public._stock_unit_cost(integer,text)') is not null
                      then 'public._stock_unit_cost(i.product_id, i.flavour_id)' else '0' end;
begin
  return query execute format($q$
  with s as (
    select 'jual'::text as ev, o.sale_day as day, o.sold_at as at, o.id as order_id, null::bigint as request_id, 1::numeric as f, true as with_qty, true as with_cost,
           null::jsonb as lns, null::int as target, o.promo_kind, o.channel_id, o.served_by, o.member_id, o.payment_method, o.receipt_no
      from pos_orders o
     where o.sale_day between $1 and $2 and o.payment_method is not null and o.status in ('dibayar', 'batal', 'refund')
    union all
    select v.kind, v.day, v.at, o.id, v.request_id, -v.frac, v.whole, v.whole or v.lines is not null, v.lines, -v.amount,
           o.promo_kind, o.channel_id, o.served_by, o.member_id, o.payment_method, o.receipt_no
      from public._rep_voids($1, $2) v join pos_orders o on o.id = v.order_id),
  l as (
    -- Sales and whole or money-only voids: every line with factor f.
    select s.*, i.line, i.product_id, i.product_code, i.name, i.flavour_id, i.free_bag, i.qty as iqty, i.line_total, i.discount as idisc,
           %1$s as icost, (%2$s)::numeric as iunit, case when s.with_qty then i.qty * sign(s.f) else 0 end::numeric as q, s.f as lf
      from s join pos_order_items i on i.order_id = s.order_id
     where s.lns is null
    union all
    -- Partial refund with lines: only those lines, for the qty given.
    select s.*, i.line, i.product_id, i.product_code, i.name, i.flavour_id, i.free_bag, i.qty, i.line_total, i.discount, %1$s, (%2$s)::numeric,
           -least(coalesce((e ->> 'qty')::numeric, i.qty), i.qty), -least(coalesce((e ->> 'qty')::numeric, i.qty), i.qty) / i.qty
      from s cross join lateral jsonb_array_elements(s.lns) e join pos_order_items i on i.order_id = s.order_id and i.line = (e ->> 'line')::int
     where s.lns is not null),
  m as (
    select l.*, round((l.line_total - l.idisc) * l.lf) as net0, round(l.idisc * l.lf) as disc0,
           row_number() over (partition by l.ev, l.order_id, l.request_id order by abs(round((l.line_total - l.idisc) * l.lf)) desc, l.line) as rn,
           sum(round((l.line_total - l.idisc) * l.lf)) over (partition by l.ev, l.order_id, l.request_id) as tot
      from l)
  select m.ev, m.day, m.at, m.order_id, m.request_id, m.line, m.product_id, m.product_code, m.name, m.flavour_id, m.free_bag,
         m.q::int, (m.disc0 + case when m.target is not null and m.rn = 1 then m.net0 + m.target - m.tot else m.net0 end)::int, m.disc0::int,
         (case when m.target is not null and m.rn = 1 then m.net0 + m.target - m.tot else m.net0 end)::int,
         case when m.with_cost then round(m.lf * coalesce(m.icost, round(m.iqty * m.iunit)))::int else 0 end,
         m.icost is null, m.promo_kind, m.channel_id, m.served_by, m.member_id, m.payment_method, m.receipt_no
    from m
  $q$, c_cost, c_unit) using d1, d2;
end $$;

-- Signed money rows per payment method: the order's split (pos_order_payments when it exists) on its sale
-- day, and each refund on its approval day by its refund_method, else shared over the order's split.
create or replace function public._rep_pay(d1 date, d2 date)
returns table (ev text, day date, at timestamptz, order_id uuid, method text, amount int)
language plpgsql stable security definer set search_path = public
as $$
declare src text := case when public._rep_has('pos_order_payments') then 'select p.order_id, p.method::text, p.amount::int from pos_order_payments p'
                         else 'select null::uuid, null::text, null::int where false' end;
begin
  return query execute format($q$
    with ps as (%s),
    vv as (select * from public._rep_voids($1, $2)),
    sp as (
      select o.id as order_id, coalesce(p.method, o.payment_method) as method, coalesce(p.amount, o.total) as amount, o.total
        from pos_orders o left join ps p (order_id, method, amount) on p.order_id = o.id
       where o.payment_method is not null and (o.sale_day between $1 and $2 or o.id in (select vv.order_id from vv)))
    select 'jual'::text, o.sale_day, o.sold_at, o.id, sp.method, sp.amount::int
      from pos_orders o join sp on sp.order_id = o.id
     where o.sale_day between $1 and $2 and o.status in ('dibayar', 'batal', 'refund')
    union all
    select v.kind, v.day, v.at, v.order_id, v.refund_method, -v.amount from vv v where v.refund_method is not null
    union all
    select v.kind, v.day, v.at, v.order_id, y.method, -(case when y.rn = 1 then v.amount - (y.tot - y.prop) else y.prop end)::int
      from vv v cross join lateral (
        select s.method, coalesce(round(v.amount * s.amount::numeric / nullif(s.total, 0)), 0) as prop,
               row_number() over (order by s.amount desc, s.method) as rn,
               sum(coalesce(round(v.amount * s.amount::numeric / nullif(s.total, 0)), 0)) over () as tot
          from sp s where s.order_id = v.order_id) y
     where v.refund_method is null
  $q$, src) using d1, d2;
end $$;

-- ---------------------------------------------------------------- statistics
-- p_grain (13 Nov 2026, the Ringkasan chart switch): 'jam' | 'hari' | 'minggu' | 'bulan'; null = by the range
-- (one day by hour, up to 3 months by day, longer by month). 'jam' over several days sums each hour.
drop function if exists public.owner_pos_stats(date, date);
create or replace function public.owner_pos_stats(p_from date default null, p_to date default null, p_grain text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();
  today date := public._local(now())::date;
  d1 date; d2 date; grain text; res json;
begin
  d1 := coalesce(p_from, today);
  d2 := coalesce(p_to, d1);
  if d2 < d1 then raise exception 'Tanggal akhir tidak boleh sebelum tanggal awal.'; end if;
  if d2 - d1 > 800 then raise exception 'Rentang terlalu panjang. Pilih paling lama sekitar 2 tahun.'; end if;
  if p_grain is not null and p_grain not in ('jam', 'hari', 'minggu', 'bulan') then raise exception 'Pilih Jam, Hari, Minggu atau Bulan.'; end if;
  grain := coalesce(p_grain, case when d1 = d2 then 'jam' when d2 - d1 > 92 then 'bulan' else 'hari' end);
  if grain = 'hari' and d2 - d1 > 400 then raise exception 'Tampilan per hari paling lama sekitar 1 tahun. Pilih Minggu atau Bulan.'; end if;

  -- Signed rows (see the rule at the top): sales on their sale day, batal and refund on their approval day.
  with o as (select *, extract(hour from public._local(x.at))::int as hr from public._rep_orders(d1, d2) x),
    l as (select * from public._rep_lines(d1, d2)),
    p as (select * from public._rep_pay(d1, d2)),
    v as (select * from public._rep_voids(d1, d2)),
    w as (select * from public._rep_orders(today - 6, today)),
    -- Promo items of each signed order row: the lines that got a promo price.
    pi as (select l.order_id, l.ev, l.request_id, sum(l.qty) filter (where l.discount <> 0) as items from l group by 1, 2, 3),
    t as (select coalesce(sum(total), 0)::bigint as sales, coalesce(sum(receipts), 0)::bigint as receipts,
                 coalesce(sum(total) filter (where ev = 'jual'), 0)::bigint as gross, coalesce(-sum(total) filter (where ev <> 'jual'), 0)::bigint as reduced from o)
  select json_build_object(
    'from', d1, 'to', d2, 'grain', grain,
    'sales', t.sales,
    'sales_before_refunds', t.gross,
    'refunds_value', t.reduced,
    'receipts', t.receipts,
    'average', case when t.receipts > 0 then round(t.sales::numeric / t.receipts) else 0 end,
    'items', coalesce((select sum(l.qty) from l), 0),
    'discount', coalesce((select sum(discount) filter (where ev = 'jual') from o), 0),
    'gross_before_discount', coalesce((select sum(subtotal) filter (where ev = 'jual') from o), 0),
    'series', case grain
      when 'jam' then coalesce((
        select json_agg(json_build_object('label', lpad(h::text, 2, '0') || '.00', 'sales', coalesce(x.s, 0), 'receipts', coalesce(x.n, 0)) order by h)
        from generate_series(least(8, coalesce((select min(hr) from o), 8)), greatest(21, coalesce((select max(hr) from o), 21))) h
        left join (select hr, sum(total) as s, sum(receipts) as n from o group by 1) x on x.hr = h), '[]'::json)
      when 'minggu' then coalesce((
        select json_agg(json_build_object('label', to_char(g.w, 'DD/MM'), 'sales', coalesce(x.s, 0), 'receipts', coalesce(x.n, 0)) order by g.w)
        from generate_series(date_trunc('week', d1::timestamp), date_trunc('week', d2::timestamp), interval '1 week') g(w)
        left join (select date_trunc('week', day::timestamp) as ww, sum(total) as s, sum(receipts) as n from o group by 1) x on x.ww = g.w), '[]'::json)
      when 'hari' then coalesce((
        select json_agg(json_build_object('label', to_char(g.d, 'DD/MM'), 'sales', coalesce(x.s, 0), 'receipts', coalesce(x.n, 0)) order by g.d)
        from generate_series(d1, d2, interval '1 day') g(d)
        left join (select day, sum(total) as s, sum(receipts) as n from o group by 1) x on x.day = g.d::date), '[]'::json)
      else coalesce((
        select json_agg(json_build_object('label', to_char(g.m, 'MM/YYYY'), 'sales', coalesce(x.s, 0), 'receipts', coalesce(x.n, 0)) order by g.m)
        from generate_series(date_trunc('month', d1::timestamp), date_trunc('month', d2::timestamp), interval '1 month') g(m)
        left join (select date_trunc('month', day::timestamp) as mm, sum(total) as s, sum(receipts) as n from o group by 1) x on x.mm = g.m), '[]'::json)
    end,
    'last7', coalesce((
      select json_agg(json_build_object('label', to_char(g.d, 'DD/MM'), 'sales', coalesce(x.s, 0), 'receipts', coalesce(x.n, 0)) order by g.d)
      from generate_series(today - 6, today, interval '1 day') g(d)
      left join (select day, sum(total) as s, sum(receipts) as n from w group by 1) x on x.day = g.d::date), '[]'::json),
    'top_products', coalesce((select json_agg(y order by y.qty desc, y.name) from (
        select l.name, sum(l.qty)::int as qty, sum(l.net)::int as net from l
        group by l.name having sum(l.qty) <> 0 or sum(l.net) <> 0 order by sum(l.qty) desc, l.name limit 10) y), '[]'::json),
    'groups', coalesce((select json_agg(y order by y.net desc) from (
        select public._pos_group(l.product_code) as name, sum(l.qty)::int as qty, sum(l.net)::int as net from l group by 1) y), '[]'::json),
    'by_method', coalesce((select json_agg(y order by y.sales desc) from (
        select public._pos_pay_label(p.method) as name, count(distinct p.order_id) filter (where p.ev = 'jual')::int as receipts, sum(p.amount)::int as sales
        from p group by p.method) y), '[]'::json),
    'by_channel', coalesce((select json_agg(y order by y.sales desc) from (
        select c.label as name, sum(o.receipts)::int as receipts, sum(o.total)::int as sales
        from o join pos_channels c on c.id = o.channel_id group by c.label) y), '[]'::json),
    'by_staff', coalesce((select json_agg(y order by y.sales desc) from (
        select coalesce(public._first_name(pr.full_name), 'Tidak dicatat') as name, sum(o.receipts)::int as receipts, sum(o.total)::int as sales,
          sum(o.commission)::int as commission
        from o left join profiles pr on pr.id = o.served_by group by o.served_by, pr.full_name) y), '[]'::json),
    'cards_by_cashier', coalesce((select json_agg(y order by y.cards desc, y.name) from (
        select coalesce(public._first_name(pr.full_name), 'Tidak dicatat') as name, count(*)::int as cards
        from audit_log a left join profiles pr on pr.id = a.actor
        where a.action = 'daftar_lewat_kasir' and public._local(a.created_at)::date between d1 and d2
        group by a.actor, pr.full_name) y), '[]'::json),
    -- Promo items per kind (Glenn, 13 Nov 2026): uses, items that got the promo price, and the rupiah discount.
    'promos', coalesce((select json_agg(y order by y.sort, y.name) from (
        select public._rep_promo_sort(o.promo_kind) as sort, o.promo_kind as kind, coalesce(o.promo_label, public._rep_promo_label(o.promo_kind)) as name,
          public._rep_promo_label(o.promo_kind) as kind_label,
          sum(o.receipts)::int as used, sum(o.discount)::int as discount, coalesce(sum(pi.items), 0)::int as items
        from o left join pi on pi.order_id = o.order_id and pi.ev = o.ev and pi.request_id is not distinct from o.request_id
        where o.promo_kind is not null
        group by o.promo_kind, coalesce(o.promo_label, public._rep_promo_label(o.promo_kind))) y), '[]'::json),
    'voids', json_build_object(
      'batal', (select count(*) from v where v.kind = 'batal'),
      'batal_value', coalesce((select sum(v.amount) from v where v.kind = 'batal'), 0),
      'refund', (select count(*) from v where v.kind = 'refund'),
      'refund_value', coalesce((select sum(v.amount) from v where v.kind = 'refund'), 0)),
    'free_orders', (select count(*) from o where o.ev = 'jual' and o.payment_method = 'gratis'),
    'flagged', (select count(*) from o where o.ev = 'jual' and cardinality(o.flags) > 0),
    'rule', 'Penjualan dihitung di tanggal transaksi. Batal dan refund mengurangi di tanggal disetujui.'
  ) into res from t;
  return res;
end $$;

-- ---------------------------------------------------------------- reports (VireoPOS column names)
-- Returns { rangkuman: [...], rincian: [...], per_produk: [...], kas: [...] }. Each row is an object whose keys
-- are the VireoPOS column titles in the same order. Columns that do not apply are empty or 0.
create or replace function public.owner_pos_report(p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();
  today date := public._local(now())::date;
  d1 date; d2 date;
begin
  d1 := coalesce(p_from, today);
  d2 := coalesce(p_to, d1);
  if d2 < d1 then raise exception 'Tanggal akhir tidak boleh sebelum tanggal awal.'; end if;
  if d2 - d1 > 800 then raise exception 'Rentang terlalu panjang. Pilih paling lama sekitar 2 tahun.'; end if;

  return json_build_object(
    'from', d1, 'to', d2,
    -- Penjualan Rinci, sheet Rangkuman: one row per receipt (cancelled ones too, with their Status).
    'rangkuman', coalesce((select json_agg(t.r order by t.sold_at, t.rno) from (
      select o.sold_at, o.receipt_no as rno, json_build_object(
        'No', row_number() over (order by o.sold_at, o.receipt_no),
        'Gerai', ou.name,
        'Channel', ch.label,
        'Tanggal', public._pos_stamp(o.sold_at),
        'Nomor Struk', o.receipt_no,
        'Staff', coalesce(sp.full_name, ''),
        'Kasir', coalesce(cp.full_name, ''),
        'Pelanggan', case when o.member_id is not null then public._first_name(mp.full_name) else '' end,
        'Fasilitas', '',
        'Status', public._pos_status_label(o.status),
        'Metode Pembayaran', public._pos_pay_label(o.payment_method),
        'Tanggal Pembayaran', public._pos_stamp(o.sold_at),
        'Catatan', coalesce(o.promo_label, ''),
        'Kasbon', 0,
        'Jatuh Tempo', '',
        'Referensi', '',
        'Tipe Kalkulasi Pajak', '',
        'Subtotal', o.subtotal,
        'Diskon', 0,
        'Diskon Loyalti', 0,
        'Diskon Kupon', o.discount,
        'Biaya Layanan', 0,
        'PB1', 0,
        'PPN', 0,
        'Pembulatan', 0,
        'Total', o.total,
        'Platform Fee', 0,
        'Total Bersih', o.total,
        'Pembayaran', coalesce(o.cash_received, o.total),
        'Kembalian', coalesce(o.change_given, 0)) as r
      from pos_orders o
        join pos_outlets ou on ou.id = o.outlet_id
        join pos_channels ch on ch.id = o.channel_id
        left join profiles sp on sp.id = o.served_by
        left join profiles cp on cp.id = o.cashier_id
        left join profiles mp on mp.id = o.member_id
      where o.sale_day between d1 and d2) t), '[]'::json),
    -- Penjualan Rinci, sheet Rincian: one row per item.
    'rincian', coalesce((select json_agg(x.r order by x.sold_at, x.rno, x.line) from (
      select o.sold_at, o.receipt_no as rno, i.line, json_build_object(
        'No', row_number() over (order by o.sold_at, o.receipt_no, i.line),
        'Gerai', ou.name,
        'Tanggal', public._pos_stamp(o.sold_at),
        'Nomor Struk', o.receipt_no,
        'Metode Pembayaran', public._pos_pay_label(o.payment_method),
        'Staff', coalesce(sp.full_name, ''),
        'Kasir', coalesce(cp.full_name, ''),
        'Pelanggan', case when o.member_id is not null then public._first_name(mp.full_name) else '' end,
        'Fasilitas', '',
        'Status', public._pos_status_label(o.status),
        'Nama Barang', i.name,
        'Grup Harga', ch.label,
        'Catatan', trim(coalesce('Rasa ' || fl.label, '') || case when i.free_bag then ' (paper bag gratis)' else '' end),
        'Harga', round(i.line_total::numeric / i.qty)::int,
        'Qty', i.qty,
        'Diskon', i.discount,
        'Total', i.line_total - i.discount) as r
      from pos_order_items i
        join pos_orders o on o.id = i.order_id
        join pos_outlets ou on ou.id = o.outlet_id
        join pos_channels ch on ch.id = o.channel_id
        left join pos_flavours fl on fl.id = i.flavour_id
        left join profiles sp on sp.id = o.served_by
        left join profiles cp on cp.id = o.cashier_id
        left join profiles mp on mp.id = o.member_id
      where o.sale_day between d1 and d2) x), '[]'::json),
    -- Penjualan per Produk: per channel and product, sales on their sale day minus batal and refund on their approval day.
    'per_produk', coalesce((select json_agg(x.r order by x.ch_sort, x.grp, x.name) from (
      select c.sort as ch_sort, public._pos_group(l.product_code) as grp, l.name,
        json_build_object(
          'No', row_number() over (order by c.sort, public._pos_group(l.product_code), l.name),
          'Gerai', (select name from pos_outlets order by id limit 1),
          'Channel', c.label,
          'Kategori', public._pos_group(l.product_code),
          'Nama Barang', l.name,
          'Kode Barang', coalesce(l.product_code, ''),
          'Kuantitas Terjual', sum(l.qty)::int,
          'Penjualan Bersih', sum(l.net)::int,
          'Penjualan Rata-Rata', case when sum(l.qty) > 0 then round(sum(l.net)::numeric / sum(l.qty))::int else 0 end) as r
      from public._rep_lines(d1, d2) l
        join pos_channels c on c.id = l.channel_id
      group by c.sort, c.label, public._pos_group(l.product_code), l.name, l.product_code
      having sum(l.qty) <> 0 or sum(l.net) <> 0) x), '[]'::json),
    -- Laporan Rekapitulasi Kas: one row per shift that opened in the range.
    'kas', coalesce((select json_agg(x.r order by x.opened_at) from (
      select sh.opened_at, json_build_object(
        'No', row_number() over (order by sh.opened_at),
        'Tanggal Mulai', public._pos_stamp(sh.opened_at),
        'Tanggal Berakhir', public._pos_stamp(sh.closed_at),
        'Gerai', ou.name,
        'Perangkat', coalesce(sh.device, ''),
        'Staff', coalesce(op.full_name, ''),
        'Kas Masuk', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'masuk'), 0),
        'Kas Keluar', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'keluar'), 0),
        'Penjualan', coalesce((select sum(o.total) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0),
        'Kembalian', coalesce((select sum(o.change_given) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0),
        'Kas Awal', sh.opening_cash,
        'Kas Seharusnya', coalesce(sh.expected_cash, public._pos_expected_cash(sh.id)),
        'Kas Dihitung', coalesce(sh.counted_cash::text, ''),
        'Selisih', case when sh.counted_cash is null then '' else (sh.counted_cash - coalesce(sh.expected_cash, 0))::text end,
        'Catatan', coalesce(sh.note, ''),
        -- Blind cash (11 Nov 2026): cash handed over by buyers, the drawer ledger's modal source,
        -- the per-note count staff entered, and the owner's flags.
        'Uang Diterima', coalesce((select sum(o.cash_received) from pos_orders o where o.shift_id = sh.id and o.payment_method = 'tunai' and o.status = 'dibayar'), 0),
        'Modal', case when sh.float_source = 'diubah' then 'diubah saat buka' else 'standar' end,
        'Pecahan', coalesce((select string_agg(case when d.key = 'koin' then 'koin ' || public._rp(d.value::int) else public._rp(d.key::int) || ' x' || d.value end, ', '
                               order by case when d.key = 'koin' then 0 else d.key::int end desc)
                             from jsonb_each_text(coalesce(sh.denominations, '{}')) d where d.value::bigint > 0), ''),
        'Tanda', array_to_string(sh.flags, ', ')) as r
      from pos_shifts sh
        join pos_outlets ou on ou.id = sh.outlet_id
        left join profiles op on op.id = sh.opened_by
      where public._local(sh.opened_at)::date between d1 and d2) x), '[]'::json)
  );
end $$;

-- ---------------------------------------------------------------- Ringkasan (owner and manager)
-- The owner page's Ringkasan (13 Nov 2026: managers see it too). Same figures as owner_dashboard in
-- schema.sql, by the rule at the top of this file: a sale counts when it was made, and a sale or reward
-- that was undone, cancelled or refunded comes off on the day that was approved (sales.reversed_at,
-- redemptions.reversed_at). Personal data stays with the owner: lapsed members' WhatsApp numbers, the
-- staff's numbers, backups and the undo requests are in the reply only for the owner.
create or replace function public.report_dashboard(p_days int default 30, p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();
  is_owner boolean := public._rep_is_owner();
  s settings := public._cfg();
  since timestamptz; until timestamptz := now();
  d_from date; d_to date;
begin
  if p_from is not null or p_to is not null then
    if p_from is null or p_to is null or p_to < p_from then raise exception 'Pilih tanggal mulai dan sampai yang benar.'; end if;
    if p_to - p_from > 365 then raise exception 'Rentang paling lama 1 tahun.'; end if;
    d_from := p_from; d_to := p_to;
    since := p_from::timestamp at time zone s.tz;
    until := (p_to + 1)::timestamp at time zone s.tz;
  else
    d_to := public._local(now())::date;
    d_from := d_to - (greatest(1, least(coalesce(p_days, 30), 366)) - 1);
    since := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)));
  end if;
  return (
  with sl as (
    select x.*, 1 as sg, x.created_at as at, public._local(x.created_at) as lt from sales x where x.created_at >= since and x.created_at < until
    union all
    select x.*, -1, x.reversed_at, public._local(x.reversed_at) from sales x where x.reversed_at >= since and x.reversed_at < until
  ),
  -- Who gets the credit (13 Nov 2026): the till's "dilayani oleh", else whoever recorded it. Sales made on the
  -- tablet's kasir account used to land on that account, so the staff showed 0.
  slw as (
    select sl.*, coalesce((select o.served_by from pos_orders o where o.sale_id = sl.id limit 1), sl.staff_id) as who,
      sl.sg * coalesce((select sum(greatest(coalesce((e->>'qty')::int, 1), 1)) from jsonb_array_elements(coalesce(sl.items, '[]'::jsonb)) e), 0) as pcs
    from sl
  ),
  rd as (
    select r.*, 1 as sg, public._local(r.created_at)::date as ld from redemptions r where r.created_at >= since and r.created_at < until
    union all
    select r.*, -1, public._local(r.reversed_at)::date from redemptions r where r.reversed_at >= since and r.reversed_at < until
  ),
  rdw as (select rd.*, coalesce((select o.served_by from pos_orders o where o.redemption_id = rd.id limit 1), rd.staff_id) as who from rd),
  item_rows as (
    select sl.member_id, sl.sg, e->>'name' as name, greatest(coalesce((e->>'qty')::int, 1), 1) * sl.sg as qty
    from sl cross join lateral jsonb_array_elements(coalesce(sl.items, '[]'::jsonb)) e
  ),
  visits as (
    select member_id, created_at, created_at - lag(created_at) over (partition by member_id order by created_at) as gap
    from sales where member_id is not null and reversed_at is null
  ),
  last_visit as (
    select member_id, max(created_at) as last_at, count(*) as n from sales where member_id is not null and reversed_at is null group by member_id
  ),
  sd as (select sl.lt::date as d, sum(sl.sg) as sales, coalesce(sum(sl.sg) filter (where sl.member_id is not null), 0) as member_sales,
           coalesce(sum(sl.sg * sl.total), 0) as revenue, coalesce(sum(sl.sg * sl.stamps), 0) as stamps from sl group by 1),
  rdd as (select rd.ld as d, sum(rd.sg) as n from rd group by 1),
  nmd as (select public._local(pr.created_at)::date as d, count(*) as n from profiles pr
           where pr.role = 'member' and pr.deleted_at is null and pr.created_at >= since - interval '1 day' and pr.created_at < until + interval '1 day'
           group by 1)
  select json_build_object(
    'days', (d_to - d_from) + 1, 'from', d_from, 'to', d_to, 'custom', p_from is not null,
    'role', case when is_owner then 'owner' else 'manager' end,
    'rule', 'Penjualan dihitung di tanggal transaksi. Batal, refund dan pembatalan stempel mengurangi di tanggal disetujui.',
    'daily', (select json_agg(json_build_object('date', g.d::date,
        'sales', coalesce(sd.sales, 0), 'member_sales', coalesce(sd.member_sales, 0),
        'revenue', coalesce(sd.revenue, 0), 'stamps', coalesce(sd.stamps, 0),
        'redemptions', coalesce(rdd.n, 0), 'new_members', coalesce(nmd.n, 0)) order by g.d desc)
      from generate_series(d_from, d_to, interval '1 day') g(d)
      left join sd on sd.d = g.d::date left join rdd on rdd.d = g.d::date left join nmd on nmd.d = g.d::date),
    'settings', json_build_object('rupiah_per_stamp', s.rupiah_per_stamp, 'late_minutes', s.late_minutes),
    'totals', json_build_object(
      'sales', coalesce((select sum(sg) from sl), 0),
      'member_sales', coalesce((select sum(sg) from sl where member_id is not null), 0),
      'revenue', coalesce((select sum(sg * total) from sl), 0),
      'stamps', coalesce((select sum(sg * stamps) from sl), 0),
      'redemptions', coalesce((select sum(sg) from rd), 0),
      'welcome_used', coalesce((select sum(sg) from rd where kind = 'welcome'), 0),
      'birthday_used', coalesce((select sum(sg) from rd where kind = 'ulang_tahun'), 0),
      'new_members', (select count(*) from profiles where role = 'member' and deleted_at is null and created_at >= since and created_at < until),
      'members', (select count(*) from profiles where role = 'member' and deleted_at is null),
      'active_members', (select count(distinct member_id) from sl where member_id is not null and sg = 1 and reversed_at is null),
      'avg_days_between_visits', (select round((extract(epoch from avg(gap)) / 86400)::numeric, 1) from visits where gap is not null and created_at >= since)
    ),
    'heatmap', coalesce((select json_agg(json_build_object('dow', d, 'hour', h, 'n', n)) from (
      select extract(isodow from lt)::int as d, extract(hour from lt)::int as h, sum(sg) as n
      from sl group by 1, 2 having sum(sg) > 0) hm), '[]'),
    'top_items', coalesce((select json_agg(t order by t.qty desc) from (
      select name, sum(qty) as qty,
        (select count(*) from (select member_id from item_rows i2 where i2.name = i.name and i2.member_id is not null
                               group by member_id having sum(i2.sg) >= 2) rr) as regulars
      from item_rows i group by name having sum(qty) > 0) t), '[]'),
    'gender', coalesce((select json_agg(json_build_object('key', coalesce(gender, 'kosong'), 'n', n)) from (
      select gender, sum(sg) as n from sl group by gender having sum(sg) > 0) g), '[]'),
    'age', coalesce((select json_agg(json_build_object('key', coalesce(age_range, 'kosong'), 'n', n)) from (
      select age_range, sum(sg) as n from sl group by age_range having sum(sg) > 0) a), '[]'),
    'staff', coalesce((select json_agg(st order by st.sales desc) from (
      select p.full_name, case when is_owner then p.whatsapp end as whatsapp,
        coalesce((select sum(sg) from slw where slw.who = p.id), 0) as sales,
        coalesce((select sum(sg * total) from slw where slw.who = p.id), 0) as revenue,
        coalesce((select sum(pcs) from slw where slw.who = p.id), 0) as items,
        coalesce((select sum(sg * stamps) from slw where slw.who = p.id), 0) as stamps,
        coalesce((select sum(sg) from rdw where rdw.who = p.id), 0) as redemptions,
        (select count(*) from slw where slw.who = p.id and slw.sg = 1 and slw.reversed_at is null and cardinality(slw.flags) > 0) as flagged
      from profiles p where p.role in ('staff', 'manager', 'owner') and p.deleted_at is null) st), '[]'),
    'flags', coalesce((select json_agg(fl order by fl.created_at desc) from (
      select sl.id, sl.receipt_no, sl.total, sl.stamps, sl.created_at, sl.flags,
             public._first_name(m.full_name) as member, st.full_name as staff
      from slw sl left join profiles m on m.id = sl.member_id left join profiles st on st.id = sl.who
      where sl.sg = 1 and sl.reversed_at is null and cardinality(sl.flags) > 0 order by sl.created_at desc limit 50) fl), '[]'),
    -- Owner only from here: WhatsApp numbers of lapsed members, backups and the undo requests.
    'lapsed', case when is_owner then coalesce((select json_agg(l order by l.last_at) from (
      select p.full_name, case when p.marketing_opt_in then p.whatsapp end as whatsapp, lv.last_at, lv.n as visits
      from last_visit lv join profiles p on p.id = lv.member_id
      where p.deleted_at is null and lv.last_at < now() - interval '30 days' and lv.last_at >= now() - interval '120 days'
      limit 50) l), '[]') else '[]' end,
    'last_backup', case when is_owner then (select max(created_at) from audit_log where action = 'unduh_cadangan') end,
    'undo', case when is_owner then coalesce((select json_agg(u order by u.created_at) from (
      select u.id, u.reason, u.created_at, rq.full_name as requested_by,
        case when u.sale_id is not null then 'penjualan' else 'penukaran' end as kind,
        coalesce(sa.receipt_no, '') as receipt_no, sa.total, sa.stamps, d.reward_label,
        public._first_name(coalesce(ms.full_name, md.full_name)) as member
      from undo_requests u
      left join profiles rq on rq.id = u.requested_by
      left join sales sa on sa.id = u.sale_id left join profiles ms on ms.id = sa.member_id
      left join redemptions d on d.id = u.redemption_id left join profiles md on md.id = d.member_id
      where u.status = 'menunggu') u), '[]') else '[]' end
  ));
end $$;

-- ---------------------------------------------------------------- Daily Sales Report text (SOP Bab 14)
-- The same format as the SOP, plus the count of receipts, cancelled orders and what was sold.
-- Staff, manager and owner may call it.
create or replace function public.staff_daily_summary() returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan akun Anda.');
  v_today date := public._local(now())::date;
  v_total int; v_n int; v_qris int; v_cash int; v_other int; v_voided int; v_voided_v int; v_mtd int;
  txt text; items text;
begin
  -- Today's sales minus the batal and refund approved today (the rule at the top of this file).
  select coalesce(sum(o.total), 0), coalesce(sum(o.receipts), 0)
    into v_total, v_n from public._rep_orders(v_today, v_today) o;
  select coalesce(sum(p.amount) filter (where p.method = 'qris'), 0), coalesce(sum(p.amount) filter (where p.method = 'tunai'), 0),
         coalesce(sum(p.amount) filter (where p.method not in ('qris', 'tunai')), 0)
    into v_qris, v_cash, v_other from public._rep_pay(v_today, v_today) p;
  select count(*), coalesce(sum(v.amount), 0) into v_voided, v_voided_v from public._rep_voids(v_today, v_today) v;
  select coalesce(sum(o.total), 0) into v_mtd from public._rep_orders(date_trunc('month', v_today::timestamp)::date, v_today) o;

  select string_agg('- ' || t.name || ': ' || t.qty || case when t.fl <> '' then ' (' || t.fl || ')' else '' end, E'\n' order by t.srt, t.name)
    into items from (
      select x.name, min(x.srt) as srt, sum(x.q)::int as qty,
             string_agg(x.flv || ' ' || x.q, ', ' order by x.flv) filter (where x.flv is not null) as fl
      from (select l.name, min(m.id) as srt, fl.label as flv, sum(l.qty)::int as q
            from public._rep_lines(v_today, v_today) l
              join menu_items m on m.id = l.product_id
              left join pos_flavours fl on fl.id = l.flavour_id
            where l.product_code is distinct from 'bag'
            group by l.name, fl.label having sum(l.qty) <> 0) x
      group by x.name) t;

  txt := 'Daily Sales Report HANASHUYA' || E'\n' ||
    'Cut Off : ' || extract(day from v_today)::int || '/' || extract(month from v_today)::int || '/' || extract(year from v_today)::int || E'\n\n' ||
    'Total Omset' || E'\n' || 'Rp ' || replace(to_char(v_total, 'FM999,999,999'), ',', '.') || E'\n\n' ||
    'Rekap Payment:' || E'\n' ||
    '- QRIS : Rp ' || replace(to_char(v_qris, 'FM999,999,999'), ',', '.') || E'\n' ||
    '- Cash : Rp ' || replace(to_char(v_cash, 'FM999,999,999'), ',', '.') ||
    case when v_other > 0 then E'\n- Lainnya : Rp ' || replace(to_char(v_other, 'FM999,999,999'), ',', '.') else '' end || E'\n\n' ||
    'Struk: ' || v_n || case when v_voided > 0 then ' (dibatalkan ' || v_voided || ', Rp ' || replace(to_char(v_voided_v, 'FM999,999,999'), ',', '.') || ')' else '' end || E'\n\n' ||
    'Terjual:' || E'\n' || coalesce(items, '- belum ada penjualan') || E'\n\n' ||
    'Akumulasi omzet ' || public._pos_month_name(extract(month from v_today)::int) || ' per tanggal ' ||
      extract(day from v_today)::int || ' ' || public._pos_month_name(extract(month from v_today)::int) || ' ' || extract(year from v_today)::int || E'\n' ||
    'Rp ' || replace(to_char(v_mtd, 'FM999,999,999'), ',', '.');
  return txt;
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('_pos_group', '_pos_stamp', '_pos_pay_label', '_pos_status_label', '_pos_month_name',
                        'owner_pos_stats', 'owner_pos_report', 'staff_daily_summary', 'report_dashboard',
                        '_rep_reader', '_rep_is_owner', '_rep_phone', '_rep_has', '_rep_promo_label', '_rep_promo_sort', '_rep_commission',
                        '_rep_voids', '_rep_request', '_rep_orders', '_rep_lines', '_rep_pay')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
