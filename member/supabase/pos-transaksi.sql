-- Transaksi (owner back office, 12 Nov 2026): Proses komisi and Pembatalan penjualan.
-- Run in the Supabase SQL Editor after wa-templates.sql (and after stock.sql, which holds the
-- other Transaksi functions). Safe to run again. Owner only; every write is logged.
--   pos_commission_preview(from, to)       per staff: orders, sales and commission of paid orders in a period
--   pos_commission_process(from, to, staff[], note)   record a payout per staff (once per period)
--   pos_commission_payouts(from, to)       the recorded payouts
--   pos_commission_mark_paid(id, note)     "Tandai dibayar"
--   pos_commission_cancel(id, reason)      "Batalkan proses", only while unpaid (the row stays, marked cancelled)
--   pos_void_overview(from, to)            cancelled orders and every batal/refund request, read-only

create table if not exists public.pos_commission_payouts (
  id bigint generated always as identity primary key,
  period_from date not null,
  period_to date not null,
  staff_id uuid not null references public.profiles (id),
  orders int not null check (orders >= 0),
  sales int not null check (sales >= 0),
  commission int not null check (commission >= 0),
  processed_by uuid references public.profiles (id) on delete set null,
  processed_at timestamptz not null default now(),
  paid_at timestamptz,
  paid_by uuid references public.profiles (id) on delete set null,
  note text,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancel_reason text,
  check (period_to >= period_from)
);
-- A period and staff member can be processed once (cancelled rows stay as history).
create unique index if not exists pos_commission_payouts_once on public.pos_commission_payouts (period_from, period_to, staff_id) where cancelled_at is null;
create index if not exists pos_commission_payouts_staff on public.pos_commission_payouts (staff_id, period_from);
alter table public.pos_commission_payouts enable row level security;
revoke all on public.pos_commission_payouts from anon, authenticated;

create or replace function public._pos_commission_range(p_from date, p_to date) returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
end $$;

-- Per staff member who served paid orders in the period. 'processed' names a payout that already
-- overlaps this period (so it cannot be paid twice).
create or replace function public.pos_commission_preview(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  perform public._pos_commission_range(p_from, p_to);
  return json_build_object('from', p_from, 'to', p_to,
    'unassigned', (select count(*) from pos_orders where sale_day between p_from and p_to and status = 'dibayar' and served_by is null),
    'rows', coalesce((select json_agg(x order by x.commission desc, x.name) from (
      select o.served_by as staff_id, public._first_name(p.full_name) as name, count(*)::int as orders, sum(o.subtotal - o.discount)::int as sales,
        coalesce(sum(public._pos_order_commission(o.id)), 0)::int as commission,
        (select y.id from pos_commission_payouts y where y.staff_id = o.served_by and y.cancelled_at is null
            and y.period_from <= p_to and y.period_to >= p_from order by y.id desc limit 1) as payout_id,
        (select y.paid_at is not null from pos_commission_payouts y where y.staff_id = o.served_by and y.cancelled_at is null
            and y.period_from <= p_to and y.period_to >= p_from order by y.id desc limit 1) as payout_paid
      from pos_orders o join profiles p on p.id = o.served_by
      where o.sale_day between p_from and p_to and o.status = 'dibayar'
      group by o.served_by, p.full_name) x), '[]'));
end $$;

-- Record payouts for the period. p_staff null = everyone with commission above 0; staff who already
-- have a payout overlapping the period are skipped. Figures are recomputed here, never trusted from the page.
create or replace function public.pos_commission_process(p_from date, p_to date, p_staff uuid[] default null, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  r record; n int := 0; skipped int := 0; total int := 0; nt text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform public._pos_commission_range(p_from, p_to);
  if nt is not null and length(nt) > 200 then raise exception 'Catatan terlalu panjang (paling panjang 200 huruf).'; end if;
  perform pg_advisory_xact_lock(hashtext('pos_commission_process'));
  for r in
    select o.served_by as staff_id, count(*)::int as orders, sum(o.subtotal - o.discount)::int as sales,
      coalesce(sum(public._pos_order_commission(o.id)), 0)::int as commission
    from pos_orders o
    where o.sale_day between p_from and p_to and o.status = 'dibayar' and o.served_by is not null
      and (p_staff is null or o.served_by = any (p_staff))
    group by o.served_by
  loop
    if r.commission <= 0 then continue; end if;
    if exists (select 1 from pos_commission_payouts y where y.staff_id = r.staff_id and y.cancelled_at is null
        and y.period_from <= p_to and y.period_to >= p_from) then skipped := skipped + 1; continue; end if;
    insert into pos_commission_payouts (period_from, period_to, staff_id, orders, sales, commission, processed_by, note)
    values (p_from, p_to, r.staff_id, r.orders, r.sales, r.commission, me, nt);
    n := n + 1; total := total + r.commission;
  end loop;
  if n = 0 then
    if skipped > 0 then raise exception 'Komisi periode ini sudah diproses.'; end if;
    raise exception 'Tidak ada komisi yang bisa diproses di periode ini.';
  end if;
  perform public._log('komisi_proses', jsonb_build_object('dari', p_from, 'sampai', p_to, 'staf', n, 'total', total));
  return json_build_object('processed', n, 'skipped', skipped, 'total', total);
end $$;

create or replace function public.pos_commission_payouts(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();  -- the list is read-only: managers see it too (13 Nov 2026)
begin
  perform public._pos_commission_range(p_from, p_to);
  return coalesce((select json_agg(x order by x.id desc) from (
    select y.id, y.period_from, y.period_to, y.staff_id, public._first_name(p.full_name) as name, y.orders, y.sales, y.commission,
      case when pb.id is null then null else public._first_name(pb.full_name) end as processed_by, y.processed_at, y.paid_at, case when pd.id is null then null else public._first_name(pd.full_name) end as paid_by, y.note,
      y.cancelled_at, y.cancel_reason,
      case when y.cancelled_at is not null then 'batal' when y.paid_at is not null then 'dibayar' else 'diproses' end as status
    from pos_commission_payouts y join profiles p on p.id = y.staff_id
    left join profiles pb on pb.id = y.processed_by left join profiles pd on pd.id = y.paid_by
    where y.period_from <= p_to and y.period_to >= p_from) x), '[]');
end $$;

create or replace function public.pos_commission_mark_paid(p_id bigint, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); y pos_commission_payouts; nt text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into y from pos_commission_payouts where id = p_id for update;
  if y.id is null then raise exception 'Proses komisi tidak ditemukan.'; end if;
  if y.cancelled_at is not null then raise exception 'Proses ini sudah dibatalkan.'; end if;
  if y.paid_at is not null then raise exception 'Komisi ini sudah ditandai dibayar.'; end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan terlalu panjang (paling panjang 200 huruf).'; end if;
  update pos_commission_payouts set paid_at = now(), paid_by = me, note = coalesce(nt, note) where id = y.id;
  perform public._log('komisi_dibayar', jsonb_build_object('payout', y.id, 'staff', y.staff_id, 'commission', y.commission));
  return json_build_object('id', y.id, 'status', 'dibayar');
end $$;

create or replace function public.pos_commission_cancel(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); y pos_commission_payouts; r text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if r is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  select * into y from pos_commission_payouts where id = p_id for update;
  if y.id is null then raise exception 'Proses komisi tidak ditemukan.'; end if;
  if y.cancelled_at is not null then raise exception 'Proses ini sudah dibatalkan.'; end if;
  if y.paid_at is not null then raise exception 'Komisi ini sudah dibayar, jadi prosesnya tidak bisa dibatalkan.'; end if;
  update pos_commission_payouts set cancelled_at = now(), cancelled_by = me, cancel_reason = r where id = y.id;
  perform public._log('komisi_batal_proses', jsonb_build_object('payout', y.id, 'staff', y.staff_id, 'reason', r));
  return json_build_object('id', y.id, 'status', 'batal');
end $$;

-- Pembatalan penjualan: every batal or refund request, plus cancelled orders that never had one
-- (an order cancelled before payment). Read-only; owner and manager (13 Nov 2026). A decided request
-- is listed on the day it was decided (the day it counts in the reports), an open one on the day it
-- was asked. amount is what went back (a partial refund's amount when the till sent one).
create or replace function public.pos_void_overview(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  return coalesce((select json_agg(x order by x.at desc) from (
    select 'v' || v.id as key, o.id as order_id, o.receipt_no, o.sold_at, coalesce(v.decided_at, v.created_at) as at, v.kind,
      a.amount, a.whole, public._pos_pay_label(coalesce(a.method, o.payment_method)) as method, v.reason,
      case when pr.id is null then null else public._first_name(pr.full_name) end as asked_by, case when pd.id is null then null else public._first_name(pd.full_name) end as decided_by,
      v.created_at as asked_at, v.decided_at, v.status
    from pos_void_requests v join pos_orders o on o.id = v.order_id
    cross join lateral public._rep_request(v.id) a
    left join profiles pr on pr.id = v.requested_by left join profiles pd on pd.id = v.decided_by
    where public._local(coalesce(v.decided_at, v.created_at))::date between p_from and p_to
    union all
    select 'o' || o.id, o.id, o.receipt_no, o.sold_at, o.sold_at, o.status, o.total, true, public._pos_pay_label(o.payment_method), null, null, null, null, null, 'selesai'
    from pos_orders o
    where o.sale_day between p_from and p_to and o.status in ('batal', 'refund')
      and not exists (select 1 from pos_void_requests v where v.order_id = o.id)) x), '[]');
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in ('_pos_commission_range', 'pos_commission_preview',
      'pos_commission_process', 'pos_commission_payouts', 'pos_commission_mark_paid', 'pos_commission_cancel', 'pos_void_overview')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
