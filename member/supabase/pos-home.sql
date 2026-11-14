-- Hanashuya POS: the tablet's main screen (design A, Glenn, 12 Nov 2026).
-- Run after pos-reports.sql (order: schema, pos, stock, attendance, pos-owner,
-- pos-approvals, pos-reports, pos-home). Re-running is safe.
--
-- pos_home() gives staff today's figures for the dashboard: revenue, orders, products
-- sold, an hourly series from opening to closing, best sellers, per flavour, the cash in
-- the drawer, orders waiting for payment, and progress toward the owner's daily target.
-- Figures follow the rule in pos-reports.sql (13 Nov 2026): today's sales minus every batal
-- and refund approved today, whatever day the order was sold; 'cancelled' counts those.

-- The daily target: a number of products (paper bags not counted) or a revenue amount.
-- Glenn's first target: 10 products a day.
alter table public.settings add column if not exists target_kind text not null default 'produk';
alter table public.settings add column if not exists target_value int not null default 10;
alter table public.settings drop constraint if exists settings_target_kind_check;
alter table public.settings add constraint settings_target_kind_check check (target_kind in ('produk', 'omzet'));
alter table public.settings drop constraint if exists settings_target_value_check;
alter table public.settings add constraint settings_target_value_check check (target_value > 0);

create or replace function public.owner_save_target(p_kind text, p_value int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  if p_kind not in ('produk', 'omzet') then raise exception 'Pilih target produk atau omzet.'; end if;
  if p_value is null or p_value <= 0 then raise exception 'Isi angka target lebih dari 0.'; end if;
  if p_kind = 'produk' and p_value > 10000 then raise exception 'Target produk terlalu besar.'; end if;
  update settings set target_kind = p_kind, target_value = p_value where id = 1;
  perform public._log('ubah_target', jsonb_build_object('kind', p_kind, 'value', p_value));
  return json_build_object('kind', p_kind, 'value', p_value);
end $$;

create or replace function public.pos_home() returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan akun Anda.');
  s settings := public._cfg();
  d date := public._local(now())::date;
  h0 int := extract(hour from s.open_time)::int;
  h1 int := greatest(h0, extract(hour from s.close_time - interval '1 second')::int);
  v_rev int; v_orders int; v_units int; v_current int; shift bigint;
begin
  -- Today's figures by the rule in pos-reports.sql: today's sales minus the batal and refund approved today.
  select coalesce(sum(o.total), 0), coalesce(sum(o.receipts), 0) into v_rev, v_orders from public._rep_orders(d, d) o;
  select coalesce(sum(l.qty), 0) into v_units from public._rep_lines(d, d) l where coalesce(l.product_code, '') <> 'bag';
  v_current := case when s.target_kind = 'omzet' then v_rev else v_units end;
  select id into shift from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null;

  return (with l as (select * from public._rep_lines(d, d) x where coalesce(x.product_code, '') <> 'bag'),
    o as (select x.*, extract(hour from public._local(x.at))::int as hr from public._rep_orders(d, d) x),
    p as (select * from public._rep_pay(d, d))
  select json_build_object(
    'day', d,
    'revenue', v_rev,
    -- Omzet is goods only; service charge and PBJT apart (14 Nov 2026). by_method below is the money in.
    'service_charge', coalesce((select sum(o.service) from o), 0),
    'pbjt', coalesce((select sum(o.tax) from o), 0),
    'pbjt_included', coalesce((select sum(o.tax_in) from o), 0),
    'orders', v_orders,
    'average', case when v_orders > 0 then round(v_rev::numeric / v_orders)::int else 0 end,
    'cancelled', (select count(*) from public._rep_voids(d, d)),
    'waiting', (select count(*) from pos_orders where sale_day = d and status = 'menunggu'),
    -- Dashboard tiles (Glenn, 13 Nov 2026): Pesanan dibatalkan = batal and refund approved today (the rule
    -- in pos-reports.sql), Tagihan gantung = orders confirmed today and not paid yet.
    'cancelled_count', (select count(*) from public._rep_voids(d, d)),
    'cancelled_amount', coalesce((select sum(v.amount) from public._rep_voids(d, d) v), 0),
    'pending_count', (select count(*) from pos_orders where sale_day = d and status = 'menunggu'),
    'pending_amount', coalesce((select sum(total) from pos_orders where sale_day = d and status = 'menunggu'), 0),
    'by_method', json_build_object(
      'tunai', coalesce((select sum(p.amount) from p where p.method = 'tunai'), 0),
      'qris', coalesce((select sum(p.amount) from p where p.method = 'qris'), 0)),
    'products_sold', v_units,
    'by_category', coalesce((select json_agg(json_build_object('name', x.name, 'qty', x.qty) order by x.sort, x.name) from (
        select c.name, c.sort, sum(l.qty)::int as qty
        from l join menu_items m on m.id = l.product_id join pos_categories c on c.id = m.category_id
        group by c.name, c.sort having sum(l.qty) <> 0) x), '[]'),
    'hourly', coalesce((select json_agg(json_build_object('hour', g.h, 'revenue', coalesce(x.rev, 0), 'orders', coalesce(x.n, 0)) order by g.h)
        from generate_series(h0, h1) g(h)
        left join (select o.hr, sum(o.total)::int as rev, sum(o.receipts)::int as n from o group by 1) x on x.hr = g.h), '[]'),
    'top_products', coalesce((select json_agg(json_build_object('name', x.name, 'qty', x.qty, 'unit', x.unit) order by x.qty desc, x.name) from (
        select l.name, sum(l.qty)::int as qty,
               case when coalesce(m.is_box, false) then 'box' else 'pcs' end as unit
        from l join menu_items m on m.id = l.product_id
        group by l.name, m.is_box having sum(l.qty) > 0
        order by 2 desc, 1 limit 5) x), '[]'),
    'by_flavour', coalesce((select json_agg(json_build_object('label', f.label, 'qty', coalesce(x.qty, 0)) order by f.sort)
        from pos_flavours f
        left join (select l.flavour_id, sum(l.qty)::int as qty from l where l.flavour_id is not null group by l.flavour_id) x on x.flavour_id = f.id
        where f.active), '[]'),
    -- Staff work blind (Glenn, 11 Nov 2026): the drawer figure is for managers and the owner.
    'drawer', case when shift is not null and public._pos_cash_full() then public._pos_expected_cash(shift) end,
    -- Managers and the owner: the drawer has dropped below the owner's Modal standar laci.
    'drawer_low', case when shift is not null and public._pos_cash_full() then public._pos_expected_cash(shift) < s.cash_float end,
    'target', json_build_object('kind', s.target_kind, 'value', s.target_value, 'current', v_current,
      'percent', round(v_current * 100.0 / s.target_value)::int,
      'remaining', greatest(0, s.target_value - v_current))));
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in ('pos_home', 'owner_save_target')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
