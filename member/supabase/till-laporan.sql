-- Laporan on the till (Glenn, 24 Nov 2026, draft A): Rekap kas, Penjualan, Stok, Presensi and Member
-- for one day, on the tablet, for everyone signed in there. Staff work blind as before: modal, uang
-- seharusnya, selisih, setor and the drawer ledger come only to managers and the owner
-- (_pos_cash_full), and harga beli only to whoever _stock_sees_cost allows.
--
-- Run after every other SQL file (last of all, after campur-rasa.sql and ubah-pesanan.sql). It
-- replaces _pos_rekap_shift and pos_rekap_printed from pos.sql, so run it again after re-running pos.sql.
-- Read-only except pos_rekap_printed. Re-runnable.

-- ---------------------------------------------------------------- rekap access
-- Who may open a shift's rekap. p_shift null: the caller's last close today, else the open shift
-- (unchanged). A given shift: managers and the owner any; since 24 Nov 2026 staff any shift too,
-- for Laporan > Rekap kas on the till. Staff still get the blind rekap (_pos_rekap with p_full false).
create or replace function public._pos_rekap_shift(me uuid, v_full boolean, p_shift bigint) returns bigint
language plpgsql stable security definer set search_path = public
as $$
declare sh pos_shifts; sid bigint; v_today date := public._local(now())::date;
begin
  if p_shift is null then
    select * into sh from pos_shifts where closed_at is not null and (v_full or closed_by = me)
       and public._local(closed_at)::date = v_today order by closed_at desc limit 1;
    if sh.id is null then select * into sh from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null; end if;
    return sh.id;
  end if;
  select id into sid from pos_shifts where id = p_shift;
  return sid;
end $$;

-- Same as pos.sql, but the "already printed" message names the shift instead of "hari ini": a shift
-- closed after midnight counts as the new day, which read as "today's rekap is already printed"
-- (Glenn, 24 Nov 2026).
create or replace function public.pos_rekap_printed(p_shift bigint) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  v_full boolean := public._pos_cash_full(); sh pos_shifts; sid bigint := public._pos_rekap_shift(me, v_full, p_shift);
begin
  select * into sh from pos_shifts where id = sid for update;
  if sh.id is null then raise exception 'Rekap shift tidak ditemukan.'; end if;
  if sh.closed_at is null then raise exception 'Rekap dicetak saat tutup shift.'; end if;
  if sh.printed_at is not null then
    if not v_full then
      raise exception 'Rekap shift % sampai % sudah dicetak jam %. Minta manajer atau pemilik kalau perlu cetak ulang.',
        to_char(public._local(sh.opened_at), 'DD/MM HH24.MI'), to_char(public._local(sh.closed_at), 'DD/MM HH24.MI'),
        to_char(public._local(sh.printed_at), 'HH24.MI');
    end if;
    update pos_shifts set reprints = reprints + 1 where id = sh.id;
    perform public._log('pos_rekap_cetak_ulang', jsonb_build_object('shift', sh.id, 'at', now(), 'copy', sh.reprints + 1));
    return json_build_object('printed_at', sh.printed_at, 'reprint', true, 'reprints', sh.reprints + 1, 'at', now());
  end if;
  update pos_shifts set printed_at = now(), printed_by = me where id = sh.id;
  perform public._log('pos_rekap_cetak', jsonb_build_object('shift', sh.id));
  return json_build_object('printed_at', now(), 'reprint', false, 'reprints', 0, 'at', now());
end $$;

-- The day asked for: today when null; never a day in the future.
create or replace function public._till_day(p_date date) returns date
language plpgsql stable security definer set search_path = public
as $$
declare d date := coalesce(p_date, public._local(now())::date);
begin
  if d > public._local(now())::date then raise exception 'Pilih hari ini atau tanggal sebelumnya.'; end if;
  return d;
end $$;

-- ---------------------------------------------------------------- Rekap kas
-- Every shift of the day, each with its full rekap (blind for staff). A shift belongs to the day its
-- rekap closed, the running shift to today: the rule of owner_cash_shifts in pos-cash.sql.
create or replace function public.till_report_rekap(p_date date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  v_full boolean := public._pos_cash_full(); d date := public._till_day(p_date);
begin
  return json_build_object('date', d, 'full', v_full,
    'shifts', coalesce((select json_agg(public._pos_rekap(sh.id, v_full) order by sh.opened_at)
      from pos_shifts sh where sh.outlet_id = 'papaya-bdg'
       and public._local(coalesce(sh.closed_at, now()))::date = d), '[]'));
end $$;

-- ---------------------------------------------------------------- Penjualan
-- One day by the rule in pos-reports.sql (that day's sales minus the batal and refund approved that
-- day), like pos_home: totals, every product, flavours, hours, categories and payment methods.
create or replace function public.till_report_sales(p_date date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  s settings := public._cfg(); d date := public._till_day(p_date);
  h0 int := extract(hour from s.open_time)::int;
  h1 int := greatest(h0, extract(hour from s.close_time - interval '1 second')::int);
  v_rev int; v_orders int;
begin
  select coalesce(sum(o.total), 0), coalesce(sum(o.receipts), 0) into v_rev, v_orders from public._rep_orders(d, d) o;
  return (with l as (select * from public._rep_lines(d, d) x where coalesce(x.product_code, '') <> 'bag'),
    o as (select x.*, extract(hour from public._local(x.at))::int as hr from public._rep_orders(d, d) x),
    p as (select * from public._rep_pay(d, d))
  select json_build_object(
    'date', d,
    'revenue', v_rev,
    'orders', v_orders,
    'average', case when v_orders > 0 then round(v_rev::numeric / v_orders)::int else 0 end,
    'service_charge', coalesce((select sum(o.service) from o), 0),
    'pbjt', coalesce((select sum(o.tax) from o), 0),
    'discount', coalesce((select sum(o.discount) from o), 0),
    'units', coalesce((select sum(l.qty) from l), 0),
    'cancelled_count', (select count(*) from public._rep_voids(d, d)),
    'cancelled_amount', coalesce((select sum(v.amount) from public._rep_voids(d, d) v), 0),
    'pending_count', (select count(*) from pos_orders where sale_day = d and status = 'menunggu'),
    'pending_amount', coalesce((select sum(total) from pos_orders where sale_day = d and status = 'menunggu'), 0),
    'by_method', json_build_object(
      'tunai', coalesce((select sum(p.amount) from p where p.method = 'tunai'), 0),
      'qris', coalesce((select sum(p.amount) from p where p.method = 'qris'), 0),
      'lain', coalesce((select sum(p.amount) from p where p.method not in ('tunai', 'qris')), 0)),
    'products', coalesce((select json_agg(json_build_object('name', x.name, 'qty', x.qty, 'unit', x.unit, 'net', x.net) order by x.qty desc, x.name) from (
        select l.name, sum(l.qty)::int as qty, sum(l.net)::int as net,
               case when coalesce(m.is_box, false) then 'box' else 'pcs' end as unit
        from l left join menu_items m on m.id = l.product_id
        group by l.name, m.is_box having sum(l.qty) <> 0) x), '[]'),
    'by_category', coalesce((select json_agg(json_build_object('name', x.name, 'qty', x.qty, 'net', x.net) order by x.sort, x.name) from (
        select c.name, c.sort, sum(l.qty)::int as qty, sum(l.net)::int as net
        from l join menu_items m on m.id = l.product_id join pos_categories c on c.id = m.category_id
        group by c.name, c.sort having sum(l.qty) <> 0) x), '[]'),
    'hourly', coalesce((select json_agg(json_build_object('hour', g.h, 'revenue', coalesce(x.rev, 0), 'orders', coalesce(x.n, 0)) order by g.h)
        from generate_series(h0, h1) g(h)
        left join (select o.hr, sum(o.total)::int as rev, sum(o.receipts)::int as n from o group by 1) x on x.hr = g.h), '[]'),
    'by_flavour', coalesce((select json_agg(json_build_object('label', f.label, 'qty', coalesce(x.qty, 0)) order by f.sort)
        from pos_flavours f
        left join (select y.flavour_id, round(sum(y.q), 1) as qty from (
            select l.flavour_id, l.qty::numeric as q from l where l.flavour_id is not null
            union all
            select e->>'flavour', l.qty * (e->>'pcs')::numeric / nullif((select sum((z->>'pcs')::numeric) from jsonb_array_elements(i.mix) z), 0)
              from l join pos_order_items i on i.order_id = l.order_id and i.line = l.line
              cross join lateral jsonb_array_elements(i.mix) e
             where l.flavour_id is null and jsonb_typeof(i.mix) = 'array') y
          group by y.flavour_id) x on x.flavour_id = f.id
        where f.active or x.qty is not null), '[]')));
end $$;

-- ---------------------------------------------------------------- Stok
-- One day: per item what came in, went out and the count (the columns of stock_report in stock.sql,
-- only items that moved), every Barang masuk and Barang keluar entry (as stock_today), and the stok
-- opname of the day. Harga beli only for whoever _stock_sees_cost allows (inside _stock_goods_in_json).
create or replace function public.till_report_stock(p_date date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg()); d date := public._till_day(p_date);
begin
  return json_build_object('date', d,
    'items', coalesce((select json_agg(row_to_json(x) order by x.sort, x.id) from (
      select i.id, i.name, i.unit, i.sort,
        coalesce(sum(m.qty) filter (where m.day = d and (m.kind = 'masuk' or (m.kind = 'koreksi' and m.goods_in_id is not null))), 0) as masuk,
        coalesce(-sum(m.qty) filter (where m.day = d and m.kind in ('penjualan', 'batal_penjualan')), 0) as terjual,
        coalesce(-sum(m.qty) filter (where m.day = d and m.kind = 'sampel'), 0) as sampel,
        coalesce(-sum(m.qty) filter (where m.day = d and m.kind in ('buang', 'rusak', 'promo')), 0) as keluar,
        coalesce(sum(m.qty) filter (where m.day = d and m.kind = 'koreksi' and m.count_id is not null), 0) as selisih,
        coalesce(sum(m.qty) filter (where m.day <= d), 0) as closing
      from stock_items i join stock_moves m on m.item_id = i.id
      where m.day <= d
      group by i.id
      having count(*) filter (where m.day = d) > 0) x), '[]'),
    'goods_in', coalesce((select json_agg(public._stock_goods_in_json(g.id) order by g.id desc)
      from stock_goods_in g where g.day = d), '[]'),
    'outs', coalesce((select json_agg(json_build_object('id', m.id, 'item', i.name, 'unit', i.unit, 'kind', m.kind,
        'qty', -m.qty, 'reason', m.reason, 'at', m.created_at,
        'cancelled', exists (select 1 from stock_moves x where x.reverses_id = m.id),
        'by', (select public._first_name(full_name) from profiles where id = m.created_by)) order by m.id desc)
      from stock_moves m join stock_items i on i.id = m.item_id
      where m.day = d and m.kind in ('sampel', 'buang', 'rusak', 'promo') and m.reverses_id is null), '[]'),
    'count', (select json_build_object('status', c.status, 'at', c.submitted_at,
        'by', (select public._first_name(full_name) from profiles where id = c.submitted_by))
      from stock_counts c where c.day = d order by c.id desc limit 1));
end $$;

-- ---------------------------------------------------------------- Presensi
-- One day for every staff member: schedule report (_att_day_json) and the scans that count. Without
-- the ids, the correction trail or the location data that att_day_report gives managers.
create or replace function public.till_report_att(p_date date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); d date := public._till_day(p_date);
begin
  return json_build_object('date', d, 'people', coalesce((select json_agg(json_build_object(
      'name', public._first_name(p.full_name), 'full_name', p.full_name,
      'report', public._att_day_json(p.id, d, now()),
      'scans', coalesce((select json_agg(json_build_object('action', e.action, 'at', e.at, 'koreksi', e.via = 'koreksi') order by e.at)
        from att_events e where e.staff_id = p.id and e.voided_at is null and public._local(e.at)::date = d), '[]'))
      order by p.full_name)
    from profiles p where p.role in ('staff', 'manager') and p.deleted_at is null), '[]'));
end $$;

-- ---------------------------------------------------------------- Member
-- One day of member cards: purchases with a card (stamps), rewards and vouchers used, new members.
-- First names only, like the cashier's Hari ini list.
create or replace function public.till_report_member(p_date date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); d date := public._till_day(p_date);
begin
  return json_build_object('date', d,
    'sales', coalesce((select json_agg(json_build_object('at', s.created_at, 'member', public._first_name(p.full_name),
        'total', s.total, 'stamps', s.stamps, 'reversed', s.reversed_at is not null,
        'by', (select public._first_name(full_name) from profiles where id = s.staff_id)) order by s.created_at desc)
      from sales s left join profiles p on p.id = s.member_id
      where s.member_id is not null and coalesce(s.sale_day, public._local(s.created_at)::date) = d), '[]'),
    'redemptions', coalesce((select json_agg(json_build_object('at', r.created_at, 'member', public._first_name(p.full_name),
        'label', r.reward_label, 'kind', r.kind, 'reversed', r.reversed_at is not null,
        'by', (select public._first_name(full_name) from profiles where id = r.staff_id)) order by r.created_at desc)
      from redemptions r left join profiles p on p.id = r.member_id
      where public._local(r.created_at)::date = d), '[]'),
    'new_members', (select count(*) from profiles p where p.role = 'member' and p.deleted_at is null
      and public._local(p.created_at)::date = d));
end $$;

-- ---------------------------------------------------------------- permissions
revoke all on function public._pos_rekap_shift(uuid, boolean, bigint), public._till_day(date) from public, anon, authenticated;
revoke all on function public.pos_rekap_printed(bigint), public.till_report_rekap(date), public.till_report_sales(date),
  public.till_report_stock(date), public.till_report_att(date), public.till_report_member(date) from public, anon;
grant execute on function public.pos_rekap_printed(bigint), public.till_report_rekap(date), public.till_report_sales(date),
  public.till_report_stock(date), public.till_report_att(date), public.till_report_member(date) to authenticated;
