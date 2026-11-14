-- Sampel: hourly quota and conversion (Glenn, 14 Nov 2026: draft C1 "Kuota harian per jam", warn only).
-- Run after stock.sql, pos.sql and akunting.sql. Safe to run again.
--
-- A sample is one stock_samples row (rung up in Mode penjualan > Sampel). Its cost is the harga pokok
-- of its stock moves, which akunting.sql books to 6-2410 Beban sampel produk under 6-2400 Beban pemasaran.
--
-- Jadi beli (Glenn, 14 Nov 2026: "can go up to 1 hour"): a paid booth order (channel toko) within 1 hour
-- after a sample. Each order counts for one sample only, the last one before it. A sample with at least
-- one such order is converted. Conversion = converted samples / samples (people who tasted), quota and
-- cost are in pieces.
--
-- Quota: one number of pieces per weekday and opening hour (sample_quotas). The till shows the current
-- hour's quota and how many pieces were given in it; going over only warns (Glenn, 14 Nov 2026).
-- Advice per weekday and hour, from the last 8 weeks of that weekday and hour; under 20 pieces there,
-- the same hour over all days is used instead:
--   naik     conversion >= 25% and gross profit >= 3x the sample cost: quota + 1
--   turun    conversion < 10% or gross profit < 1x the sample cost:    quota - 1
--   tetap    otherwise
--   baru_diubah  the quota of that hour was changed in the last 7 days: no new advice until there is
--                a week of data under it (else every Pakai would add 1 again on the same data)
-- The quota never goes below 1 (SOP: staff always offer samples). With no quota set, the current
-- quota is the hour's average over those 8 weeks.
--
-- sample_quota_now()                     till: this hour's quota and pieces given (staff, manager, owner)
-- owner_sample_dashboard(p_from, p_to)   owner page Laporan sampel (owner and manager, read-only)
-- owner_sample_set_quota(p_dow, p_hours) owner: save a weekday's hourly quotas ("Pakai n pcs")

create table if not exists public.sample_quotas (
  dow smallint not null check (dow between 1 and 7),          -- ISO weekday: 1 Senin ... 7 Minggu
  hour smallint not null check (hour between 0 and 23),
  qty int not null check (qty between 1 and 30),
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (dow, hour)
);
alter table public.sample_quotas enable row level security;
revoke all on public.sample_quotas from anon, authenticated;

-- Opening hours of the booth (08.00-21.00): one slot per hour, 8 ... 20.
create or replace function public._sample_hours() returns int[]
language sql immutable as $$ select array[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20] $$;

-- Every sample in [p_from, p_to] with its cost and the paid orders matched to it.
create or replace function public._sample_matches(p_from date, p_to date)
returns table (sample_id uuid, at timestamptz, day date, dow int, hour int, pcs int, cost bigint, items jsonb,
               orders int, revenue bigint, gp bigint)
language sql stable security definer set search_path = public
as $$
  with s as (
    select x.id, x.created_at as at, x.day,
           extract(isodow from public._local(x.created_at))::int as dow,
           extract(hour from public._local(x.created_at))::int as hour, x.items,
           (select coalesce(sum((e->>'qty')::int), 0) from jsonb_array_elements(x.items) e)::int as pcs,
           (select coalesce(round(sum(-m.qty * i.unit_cost)), 0) from stock_moves m join stock_items i on i.id = m.item_id
             where m.order_id = x.id and m.kind = 'sampel')::bigint as cost
      from stock_samples x where x.day between p_from and p_to),
  o as (
    select o.id, o.total,
           (select s2.id from s s2 where s2.at <= o.sold_at and s2.at > o.sold_at - interval '1 hour' order by s2.at desc limit 1) as sid
      from pos_orders o
     where o.status = 'dibayar' and o.channel_id = 'toko' and o.sale_day between p_from and p_to + 1),
  g as (
    select o.sid, count(*)::int as n, sum(o.total)::bigint as rev,
           sum(o.total - coalesce((select round(sum(-m.qty * i.unit_cost)) from stock_moves m join stock_items i on i.id = m.item_id
                                    where m.order_id = o.id and m.kind = 'penjualan'), 0))::bigint as gp
      from o where o.sid is not null group by o.sid)
  select s.id, s.at, s.day, s.dow, s.hour, s.pcs, s.cost, s.items, coalesce(g.n, 0), coalesce(g.rev, 0), coalesce(g.gp, 0)
    from s left join g on g.sid = s.id
$$;

-- Advice for one weekday from the 8 weeks before p_day: one row per opening hour.
create or replace function public._sample_advice(p_dow int, p_day date)
returns table (hour int, q int, nq int, k text, conv numeric, roi numeric, pcs int, pooled boolean, is_set boolean)
language sql stable security definer set search_path = public
as $$
  with m as (select * from public._sample_matches(p_day - 56, p_day - 1)),
  h as (select unnest(public._sample_hours()) as hour),
  cell as (
    select h.hour,
           coalesce(sum(m.pcs) filter (where m.dow = p_dow), 0)::int as pcs,
           count(m.sample_id) filter (where m.dow = p_dow)::int as n,
           count(m.sample_id) filter (where m.dow = p_dow and m.orders > 0)::int as conv_n,
           coalesce(sum(m.cost) filter (where m.dow = p_dow), 0) as cost, coalesce(sum(m.gp) filter (where m.dow = p_dow), 0) as gp,
           coalesce(sum(m.pcs), 0)::int as all_pcs, count(m.sample_id)::int as all_n,
           count(m.sample_id) filter (where m.orders > 0)::int as all_conv, coalesce(sum(m.cost), 0) as all_cost, coalesce(sum(m.gp), 0) as all_gp
      from h left join m on m.hour = h.hour group by h.hour),
  r as (
    select c.hour, c.pcs, c.pcs < 20 as pooled,
           case when c.pcs >= 20 then c.conv_n::numeric / nullif(c.n, 0) else c.all_conv::numeric / nullif(c.all_n, 0) end as conv,
           case when c.pcs >= 20 then c.gp / nullif(c.cost, 0) else c.all_gp / nullif(c.all_cost, 0) end as roi,
           c.all_pcs,
           coalesce(sq.qty, greatest(1, round(c.pcs / 8.0)::int)) as q, sq.qty is not null as is_set,
           coalesce(sq.updated_at > now() - interval '7 days', false) as fresh
      from cell c left join sample_quotas sq on sq.dow = p_dow and sq.hour = c.hour)
  select r.hour, r.q,
         case when r.fresh or r.all_pcs < 20 then r.q
              when r.conv >= 0.25 and coalesce(r.roi, 0) >= 3 then least(30, r.q + 1)
              when coalesce(r.conv, 0) < 0.10 or coalesce(r.roi, 0) < 1 then greatest(1, r.q - 1)
              else r.q end,
         case when r.fresh then 'baru_diubah'
              when r.all_pcs < 20 then 'kurang_data'
              when r.conv >= 0.25 and coalesce(r.roi, 0) >= 3 then 'naik'
              when (coalesce(r.conv, 0) < 0.10 or coalesce(r.roi, 0) < 1) and r.q > 1 then 'turun'
              else 'tetap' end,
         round(r.conv, 4), round(r.roi, 2), r.pcs, r.pooled, r.is_set
    from r order by r.hour
$$;

-- Till: the quota of the current hour and the pieces given in it today.
create or replace function public.sample_quota_now() returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], 'Hanya staf, manajer atau pemilik.');
  t timestamp := public._local(now()); h int := extract(hour from t)::int; d int := extract(isodow from t)::int;
  q int; given int;
begin
  select qty into q from sample_quotas where dow = d and hour = h;
  select coalesce(sum((e->>'qty')::int), 0) into given
    from stock_samples x cross join jsonb_array_elements(x.items) e
   where x.day = t::date and extract(hour from public._local(x.created_at)) = h;
  return json_build_object('hour', h, 'quota', q, 'given', given);
end $$;

create or replace function public.owner_sample_dashboard(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();
  today date := public._local(now())::date; tmr date := today + 1;
  dt int := extract(isodow from today)::int; dm int := extract(isodow from tmr)::int;
  nowh int := extract(hour from public._local(now()))::int;
  acc json := null;
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Rentang tanggal tidak valid.'; end if;
  if p_to - p_from > 366 then raise exception 'Rentang paling lama 1 tahun.'; end if;
  -- Beban pemasaran and its sub-accounts in the range (akunting.sql). Read straight from the journal,
  -- so run Laporan keuangan (it syncs) to bring the latest samples in.
  if to_regclass('public.acc_lines') is not null then
    select json_agg(json_build_object('code', a.code, 'name', a.name, 'parent', a.parent_id is not null,
             'amount', coalesce((select sum(l.debit - l.credit) from acc_lines l join acc_journals j on j.id = l.journal_id
                                  where l.account_id = a.id and j.day between p_from and p_to), 0)) order by a.code)
      into acc from acc_accounts a
     where a.code = '6-2400' or a.parent_id = (select id from acc_accounts where code = '6-2400');
  end if;
  return (with m as (select * from public._sample_matches(p_from, p_to)),
    w as (select * from public._sample_matches(today - 56, today - 1)),
    td as (select * from public._sample_matches(today, today)),
    hrs as (select unnest(public._sample_hours()) as hour),
    fl as (select e->>'flavour' as flavour, m.sample_id, (e->>'qty')::int as qty, m.orders from m cross join jsonb_array_elements(m.items) e)
  select json_build_object(
    'from', p_from, 'to', p_to, 'today', today, 'tomorrow', tmr, 'today_dow', dt, 'tomorrow_dow', dm, 'now_hour', nowh,
    'hours', to_json(public._sample_hours()),
    'kpi', (select json_build_object('pcs', coalesce(sum(pcs), 0), 'samples', count(*), 'converted', count(*) filter (where orders > 0),
              'orders', coalesce(sum(orders), 0), 'cost', coalesce(sum(cost), 0), 'revenue', coalesce(sum(revenue), 0), 'gp', coalesce(sum(gp), 0),
              'days', p_to - p_from + 1) from m),
    -- 8 weeks before today, per weekday and hour (chart and heat map).
    'cells', (select coalesce(json_agg(json_build_object('dow', d.dow, 'hour', h.hour,
                 'pcs', coalesce((select sum(pcs) from w where w.dow = d.dow and w.hour = h.hour), 0),
                 'samples', (select count(*) from w where w.dow = d.dow and w.hour = h.hour),
                 'converted', (select count(*) from w where w.dow = d.dow and w.hour = h.hour and w.orders > 0)) order by d.dow, h.hour), '[]')
              from generate_series(1, 7) d(dow) cross join hrs h),
    'today_hours', (select json_agg(json_build_object('hour', h.hour,
                 'quota', coalesce((select qty from sample_quotas where dow = dt and hour = h.hour), (select a.q from public._sample_advice(dt, today) a where a.hour = h.hour)),
                 'pcs', coalesce((select sum(pcs) from td where td.hour = h.hour), 0),
                 'converted', (select count(*) from td where td.hour = h.hour and td.orders > 0)) order by h.hour) from hrs h),
    'advice', (select json_agg(json_build_object('hour', a.hour, 'q', a.q, 'nq', a.nq, 'k', a.k, 'conv', a.conv, 'roi', a.roi,
                 'pcs', a.pcs, 'pooled', a.pooled, 'set', a.is_set) order by a.hour) from public._sample_advice(dm, tmr) a),
    'days', (select coalesce(json_agg(json_build_object('day', x.day, 'pcs', x.pcs, 'samples', x.n, 'converted', x.c, 'cost', x.cost) order by x.day desc), '[]')
               from (select day, sum(pcs)::int as pcs, count(*)::int as n, count(*) filter (where orders > 0)::int as c, sum(cost)::bigint as cost
                       from m where day > p_to - 7 group by day) x),
    'flavours', (select coalesce(json_agg(json_build_object('flavour', f.flavour, 'label', coalesce(pf.label, f.flavour), 'pcs', f.pcs, 'samples', f.n, 'converted', f.c) order by f.pcs desc), '[]')
               from (select coalesce(flavour, '') as flavour, sum(qty)::int as pcs, count(distinct sample_id)::int as n,
                            count(distinct sample_id) filter (where orders > 0)::int as c from fl group by 1) f
               left join pos_flavours pf on pf.id = f.flavour),
    'accounts', acc,
    'can_set', public._rep_is_owner()));
end $$;

-- p_hours: [{hour, qty}] for one weekday. Hours left out keep their quota.
create or replace function public.owner_sample_set_quota(p_dow int, p_hours jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengubah kuota sampel.'); h jsonb; hr int; q int; n int := 0;
begin
  if p_dow is null or p_dow not between 1 and 7 then raise exception 'Pilih hari.'; end if;
  if jsonb_typeof(p_hours) is distinct from 'array' then raise exception 'Kuota per jam tidak terbaca.'; end if;
  for h in select * from jsonb_array_elements(p_hours) loop
    begin hr := (h->>'hour')::int; q := (h->>'qty')::int; exception when others then raise exception 'Kuota per jam tidak terbaca.'; end;
    if hr is null or not (hr = any (public._sample_hours())) then raise exception 'Jam % di luar jam buka.', hr; end if;
    if q is null or q < 1 or q > 30 then raise exception 'Kuota sampel 1 sampai 30 pcs per jam.'; end if;
    insert into sample_quotas (dow, hour, qty, updated_by) values (p_dow, hr, q, me)
      on conflict (dow, hour) do update set qty = excluded.qty, updated_by = me, updated_at = now();
    n := n + q;
  end loop;
  perform public._log('sampel_kuota', jsonb_build_object('hari', p_dow, 'jam', p_hours));
  return json_build_object('dow', p_dow, 'total', n);
end $$;

revoke all on function public._sample_matches(date, date), public._sample_advice(int, date), public._sample_hours() from public, anon, authenticated;
grant execute on function public.sample_quota_now(), public.owner_sample_dashboard(date, date), public.owner_sample_set_quota(int, jsonb) to authenticated;
