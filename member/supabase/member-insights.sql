-- Member analytics for the owner (Glenn, 14 Nov 2026: draft C3 "Aksi minggu ini").
-- Run after schema.sql and pos.sql. Safe to run again.
--
-- Every member falls in one of five groups, judged from their visits (sales that were not
-- reversed) and the day they joined. "Last activity" is the last visit, or the sign-up day
-- for a member who never bought anything.
--   hilang        last activity more than 60 days ago
--   mulai_hilang  last activity 30 to 60 days ago
--   setia         5+ visits, or at least one full card
--   aktif         2+ visits
--   baru          everyone else (0 or 1 visit, active in the last 30 days)
-- The order matters: a loyal member who stops coming shows up as mulai_hilang, then hilang.
--
-- owner_member_groups(p_days)        the groups, this week's actions and how members moved
--                                    between groups over the last p_days days
-- owner_member_action_list(p_key)    the members behind one action, only those who agreed
--                                    to WhatsApp promos (UU PDP; the rest are only counted)
-- owner_member_overview(p_from, p_to) the "Semua member" charts
-- All three are owner-only. The pages show a group under 5 people as "<5".

-- One row per member as things stood at p_at.
create or replace function public._member_groups_at(p_at timestamptz)
returns table (id uuid, joined timestamptz, visits int, spent int, last_visit timestamptz, stamps int, grp text)
language sql stable security definer set search_path = public
as $$
  with m as (
    select p.id, p.created_at as joined,
           count(s.id)::int as visits, coalesce(sum(s.total), 0)::int as spent,
           max(s.created_at) as last_visit, coalesce(sum(s.stamps), 0)::int as stamps
      from profiles p
      left join sales s on s.member_id = p.id and s.reversed_at is null and s.created_at <= p_at
     where p.role = 'member' and p.deleted_at is null and p.created_at <= p_at
     group by p.id, p.created_at)
  select m.id, m.joined, m.visits, m.spent, m.last_visit, m.stamps,
    case
      when p_at - coalesce(m.last_visit, m.joined) > interval '60 days' then 'hilang'
      when p_at - coalesce(m.last_visit, m.joined) > interval '30 days' then 'mulai_hilang'
      when m.visits >= 5 or m.stamps >= (select card_size from settings where id = 1) then 'setia'
      when m.visits >= 2 then 'aktif'
      else 'baru'
    end
  from m
$$;

-- Which member each action of the week is about. A member can be in more than one action.
--   diskon_50          welcome 50% still open and ending within 7 days
--   satu_stempel       one stamp away from a card reward (not counting hilang members)
--   baru_belum_kembali joined 7 to 30 days ago and has not been back (0 or 1 visit)
--   ulang_tahun        birthday within the next 14 days, birthday box not used yet
--   mulai_hilang       the whole mulai_hilang group
--   hilang             the whole hilang group
create or replace function public._member_actions()
returns table (key text, member_id uuid, note text)
language sql stable security definer set search_path = public
as $$
  with g as (select * from public._member_groups_at(now())),
  t as (select public._local(now())::date as today, (select card_size from settings where id = 1) as size)
  select 'diskon_50', g.id, 'Berakhir ' || to_char(v.ends_on, 'DD/MM')
    from g cross join t cross join lateral public._vouchers(g.id) v
   where v.kind = 'welcome' and v.status = 'tersedia' and v.ends_on - t.today <= 7
  union all
  select 'satu_stempel', g.id, r.label
    from g cross join t cross join lateral public._card_view(g.id) cv
    join rewards r on r.slot = cv.card_position + 1
   where g.grp <> 'hilang' and cv.card_position < t.size
  union all
  select 'baru_belum_kembali', g.id, 'Daftar ' || to_char(public._local(g.joined), 'DD/MM')
    from g cross join t
   where g.grp = 'baru' and g.visits <= 1
     and public._local(g.joined)::date between t.today - 30 and t.today - 7
  union all
  select 'ulang_tahun', g.id, 'Ulang tahun ' || to_char(v.starts_on + 7, 'DD/MM')
    from g cross join t cross join lateral public._vouchers(g.id) v
   where v.kind = 'ulang_tahun' and v.status in ('belum', 'tersedia') and v.starts_on + 7 between t.today and t.today + 14
  union all
  select g.grp, g.id, null from g where g.grp in ('mulai_hilang', 'hilang')
$$;

create or replace function public.owner_member_groups(p_days int default 30) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  days int := least(greatest(coalesce(p_days, 30), 1), 365);
begin
  return (with now_g as (select * from public._member_groups_at(now())),
    then_g as (select * from public._member_groups_at(now() - make_interval(days => days))),
    prof as (select p.id, p.gender, p.age_range, p.marketing_opt_in from profiles p where p.role = 'member' and p.deleted_at is null),
    welcome_open as (select g.id from now_g g cross join lateral public._vouchers(g.id) v where v.kind = 'welcome' and v.status = 'tersedia'),
    per_group as (
      select g.grp, count(*)::int as n,
             round(avg(g.visits)::numeric, 1) as visits_avg,
             coalesce(sum(g.spent), 0)::bigint as spent,
             sum(g.visits)::int as receipts,
             count(*) filter (where g.id in (select id from welcome_open))::int as welcome_open,
             count(*) filter (where p.gender = 'perempuan')::int as female,
             count(*) filter (where p.gender in ('perempuan', 'laki-laki'))::int as gender_known,
             count(*) filter (where p.marketing_opt_in)::int as wa,
             (select p2.age_range from now_g g2 join prof p2 on p2.id = g2.id
               where g2.grp = g.grp and p2.age_range is not null and p2.age_range <> 'tidak_disebut'
               group by p2.age_range order by count(*) desc, p2.age_range limit 1) as top_age
        from now_g g join prof p on p.id = g.id group by g.grp),
    acts as (select a.key, count(distinct a.member_id)::int as n,
                    count(distinct a.member_id) filter (where p.marketing_opt_in)::int as wa
               from public._member_actions() a join prof p on p.id = a.member_id group by a.key)
  select json_build_object(
    'days', days,
    'total', (select count(*) from now_g),
    'groups', coalesce((select json_agg(json_build_object('key', k.key, 'n', coalesce(pg.n, 0), 'visits_avg', coalesce(pg.visits_avg, 0),
        'per_receipt', case when coalesce(pg.receipts, 0) > 0 then round(pg.spent::numeric / pg.receipts) else null end,
        'spent', coalesce(pg.spent, 0), 'welcome_open', coalesce(pg.welcome_open, 0), 'female', coalesce(pg.female, 0),
        'gender_known', coalesce(pg.gender_known, 0), 'top_age', pg.top_age, 'wa', coalesce(pg.wa, 0)) order by k.ord)
      from (values ('baru', 1), ('aktif', 2), ('setia', 3), ('mulai_hilang', 4), ('hilang', 5)) k(key, ord)
      left join per_group pg on pg.grp = k.key), '[]'),
    'actions', coalesce((select json_agg(json_build_object('key', k.key, 'n', coalesce(a.n, 0), 'wa', coalesce(a.wa, 0)) order by k.ord)
      from (values ('diskon_50', 1), ('satu_stempel', 2), ('baru_belum_kembali', 3), ('ulang_tahun', 4), ('mulai_hilang', 5), ('hilang', 6)) k(key, ord)
      left join acts a on a.key = k.key), '[]'),
    -- From the group days ago ('belum' = joined since) to the group now.
    'moves', coalesce((select json_agg(json_build_object('from', x.f, 'to', x.t, 'n', x.n)) from (
        select coalesce(o.grp, 'belum') as f, n.grp as t, count(*)::int as n
          from now_g n left join then_g o on o.id = n.id group by 1, 2) x), '[]')));
end $$;

create or replace function public.owner_member_action_list(p_key text) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  if p_key not in ('diskon_50', 'satu_stempel', 'baru_belum_kembali', 'ulang_tahun', 'mulai_hilang', 'hilang') then
    raise exception 'Daftar tidak dikenal.';
  end if;
  return (with a as (select distinct on (member_id) member_id, note from public._member_actions() where key = p_key),
    g as (select * from public._member_groups_at(now()))
  select json_build_object(
    'hidden', (select count(*) from a join profiles p on p.id = a.member_id where not p.marketing_opt_in),
    'rows', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.full_name, 'whatsapp', p.whatsapp,
        'visits', g.visits, 'spent', g.spent, 'last_visit', g.last_visit, 'joined', g.joined,
        'position', cv.card_position, 'note', a.note) order by g.spent desc, g.last_visit desc nulls last)
      from a join profiles p on p.id = a.member_id and p.marketing_opt_in
      join g on g.id = a.member_id cross join lateral public._card_view(p.id) cv), '[]')));
end $$;

create or replace function public.owner_member_overview(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  size int := (select card_size from settings where id = 1);
  today date := public._local(now())::date;
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Rentang tanggal tidak valid.'; end if;
  return (with g as (select * from public._member_groups_at(now())),
    prof as (select p.* from profiles p where p.role = 'member' and p.deleted_at is null),
    vis as (select s.member_id, s.created_at, s.total, public._local(s.created_at) as lt from sales s
             join prof p on p.id = s.member_id where s.reversed_at is null),
    vis_r as (select * from vis where lt::date between p_from and p_to),
    ord as (select o.* from pos_orders o where o.status = 'dibayar' and o.sale_day between p_from and p_to),
    gaps as (select extract(epoch from created_at - lag(created_at) over (partition by member_id order by created_at)) / 86400 as d from vis),
    vch as (select v.kind, v.status from prof p cross join lateral public._vouchers(p.id) v),
    rew as (select r.status from prof p cross join lateral public._rewards(p.id) r where r.status <> 'terkunci'),
    pos as (select cv.card_position, cv.waiting from prof p cross join lateral public._card_view(p.id) cv),
    src as (select p.id,
        case when (select c.method from consent_log c where c.user_id = p.id order by c.created_at limit 1) = 'daftar kasir' then 'tablet'
             when exists (select 1 from voucher_codes vc where vc.claimed_by = p.id and vc.claimed_at <= p.created_at + interval '1 day') then 'voucher'
             else 'qr' end as how
      from prof p where public._local(p.created_at)::date between p_from and p_to),
    spend_rank as (select g.id, ntile(5) over (order by g.spent desc) as q from g where g.spent > 0)
  select json_build_object(
    'total', (select count(*) from prof),
    'new', (select count(*) from prof where public._local(created_at)::date between p_from and p_to),
    'active', (select count(distinct member_id) from vis_r),
    'visited', (select count(*) from g where visits >= 1),
    'repeat', (select count(*) from g where visits >= 2),
    'gap_days', (select round(percentile_cont(0.5) within group (order by d)::numeric, 0) from gaps where d is not null),
    'wa', (select count(*) from prof where marketing_opt_in),
    'member_orders', (select count(*) from ord where member_id is not null),
    'member_revenue', (select coalesce(sum(total), 0) from ord where member_id is not null),
    'other_orders', (select count(*) from ord where member_id is null),
    'other_revenue', (select coalesce(sum(total), 0) from ord where member_id is null),
    -- Sign-ups in the last 8 weeks, weeks starting Monday.
    'weeks', (select json_agg(json_build_object('week', w, 'n',
        (select count(*) from prof where public._local(created_at)::date between w and w + 6)) order by w)
      from (select (date_trunc('week', today::timestamp)::date - 7 * k) as w from generate_series(0, 7) k) ws),
    'source', json_build_object('qr', (select count(*) from src where how = 'qr'), 'tablet', (select count(*) from src where how = 'tablet'),
      'voucher', (select count(*) from src where how = 'voucher')),
    'visits', json_build_object('v1', (select count(*) from g where visits >= 1), 'v2', (select count(*) from g where visits >= 2),
      'v3', (select count(*) from g where visits >= 3), 'v5', (select count(*) from g where visits >= 5)),
    'stamps', json_build_object('s0', (select count(*) from pos where card_position = 0),
      's1', (select count(*) from pos where card_position between 1 and 2), 's3', (select count(*) from pos where card_position between 3 and 6),
      's7', (select count(*) from pos where card_position between 7 and size - 1), 'full', (select count(*) from pos where card_position >= size)),
    'vouchers', json_build_object(
      'welcome', json_build_object('used', (select count(*) from vch where kind = 'welcome' and status = 'dipakai'),
                                   'given', (select count(*) from vch where kind = 'welcome' and status <> 'belum')),
      'birthday', json_build_object('used', (select count(*) from vch where kind = 'ulang_tahun' and status = 'dipakai'),
                                    'given', (select count(*) from vch where kind = 'ulang_tahun' and status <> 'belum')),
      'reward', json_build_object('used', (select count(*) from rew where status = 'ditukar'), 'given', (select count(*) from rew)),
      'code', json_build_object('used', (select count(*) from vch where kind = 'kode' and status = 'dipakai'),
                                'given', (select count(*) from vch where kind = 'kode'))),
    'heatmap', coalesce((select json_agg(json_build_object('dow', d, 'hour', h, 'n', n)) from (
        select extract(isodow from lt)::int as d, extract(hour from lt)::int as h, count(*)::int as n from vis_r group by 1, 2) hm), '[]'),
    'products', coalesce((select json_agg(x order by x.member_qty desc) from (
        select i.name, sum(i.qty) filter (where o.member_id is not null)::int as member_qty, sum(i.qty)::int as qty,
               (select f.label from pos_order_items i2 join ord o2 on o2.id = i2.order_id join pos_flavours f on f.id = i2.flavour_id
                 where i2.name = i.name and o2.member_id is not null group by f.label order by sum(i2.qty) desc limit 1) as flavour
          from pos_order_items i join ord o on o.id = i.order_id group by i.name
        having sum(i.qty) filter (where o.member_id is not null) > 0) x), '[]'),
    'gender', coalesce((select json_agg(json_build_object('key', coalesce(gender, 'kosong'), 'n', n)) from (
        select gender, count(*)::int as n from prof group by gender) x), '[]'),
    'age', coalesce((select json_agg(json_build_object('key', coalesce(age_range, 'kosong'), 'n', n)) from (
        select age_range, count(*)::int as n from prof group by age_range) x), '[]'),
    'age_top', coalesce((select json_agg(json_build_object('key', coalesce(age_range, 'kosong'), 'n', n)) from (
        select p.age_range, count(*)::int as n from spend_rank r join prof p on p.id = r.id where r.q = 1 group by p.age_range) x), '[]'),
    'birthdays', (select json_agg(json_build_object('month', m, 'n',
        (select count(*) from prof where birth_date is not null and extract(month from birth_date) = m)) order by m)
      from generate_series(1, 12) m)));
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('_member_groups_at', '_member_actions', 'owner_member_groups', 'owner_member_action_list', 'owner_member_overview')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname like 'owner_%' then execute format('grant execute on function %s to authenticated', f.sig); end if;
  end loop;
end $$;
