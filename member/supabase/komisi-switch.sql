-- Komisi on/off (Glenn, 14 Nov 2026): "komisi will only be tracked when owner/manager enables it
-- inside the settings for each staff or enabling commission system". Run after pos.sql,
-- pos-reports.sql, pos-transaksi.sql, akunting.sql and pos-home.sql (last in the live order). Safe to re-run.
--   settings.commission_enabled  the whole commission system (off by default)
--   profiles.commission_enabled  per staff member (off by default)
-- An order earns commission only when both were on for the staff member who served it at the
-- moment of the sale (Glenn, 14 Nov 2026: "count per day"). Every switch change is a row in
-- commission_switches, so switching someone on on the 20th counts only their sales from then,
-- and switching off keeps what they earned before. Orders with no staff (served_by null, e.g.
-- the VireoPOS import) never earn any. Payouts already processed keep their amounts.
-- The owner or a manager switches it in Tim > Komisi; a manager can't switch their own.

alter table public.settings add column if not exists commission_enabled boolean not null default false;
alter table public.profiles add column if not exists commission_enabled boolean not null default false;

-- Switch history: staff_id null = the whole commission system. The last row at or before a moment
-- tells whether it was on then. No row = off.
create table if not exists public.commission_switches (
  id bigint generated always as identity primary key,
  staff_id uuid references public.profiles (id) on delete cascade,
  enabled boolean not null,
  at timestamptz not null default now(),
  changed_by uuid references public.profiles (id) on delete set null
);
create index if not exists commission_switches_staff on public.commission_switches (staff_id, at);
alter table public.commission_switches enable row level security;
revoke all on public.commission_switches from anon, authenticated;
-- First run: whatever is switched on now counts from the day the system was first switched on
-- (or now). Only when the history is still empty, so a re-run changes nothing.
do $$
declare t0 timestamptz;
begin
  if exists (select 1 from public.commission_switches) then return; end if;
  if (select commission_enabled from public.settings where id = 1) then
    -- commission_enabled_at is added further down this file, so it may not exist yet on a first run.
    begin
      execute 'select coalesce((select commission_enabled_at::timestamp at time zone ''Asia/Jakarta'' from public.settings where id = 1), now())' into t0;
    exception when undefined_column then t0 := now();
    end;
    insert into public.commission_switches (staff_id, enabled, at) values (null, true, t0);
    insert into public.commission_switches (staff_id, enabled, at)
      select id, true, t0 from public.profiles where commission_enabled;
  end if;
end $$;

create or replace function public._commission_on(p_staff uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public
as $$
  select p_staff is not null
     and coalesce((select w.enabled from commission_switches w where w.staff_id is null and w.at <= p_at order by w.at desc, w.id desc limit 1), false)
     and coalesce((select w.enabled from commission_switches w where w.staff_id = p_staff and w.at <= p_at order by w.at desc, w.id desc limit 1), false)
$$;
-- On right now (the switches on the page).
create or replace function public._commission_on(p_staff uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select public._commission_on(p_staff, now()) $$;

-- Record a change (only when the value really changes).
create or replace function public._commission_switch(p_staff uuid, p_enabled boolean, p_by uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  if coalesce((select w.enabled from commission_switches w where w.staff_id is not distinct from p_staff
      order by w.at desc, w.id desc limit 1), false) = coalesce(p_enabled, false) then return; end if;
  insert into commission_switches (staff_id, enabled, changed_by) values (p_staff, coalesce(p_enabled, false), p_by);
end $$;

create or replace function public._pos_order_commission(p_order uuid) returns int
language plpgsql stable security definer set search_path = public
as $$
begin
  return (select coalesce(round(sum(case when r.kind = 'persen' then (i.line_total - i.discount) * r.value / 100.0 else i.qty * r.value end)), 0)::int
    from pos_order_items i join pos_orders o on o.id = i.order_id
    cross join lateral (select * from pos_commission_rules x
       where x.active and o.sale_day between x.starts_on and coalesce(x.ends_on, date '9999-12-31')
         and (x.product_code = i.product_code or x.product_code is null)
       order by (x.product_code is null), x.starts_on desc, x.id desc limit 1) r
   where i.order_id = p_order and not i.free_bag and o.status = 'dibayar' and public._commission_on(o.served_by, o.sold_at));
end $$;

create or replace function public._rep_commission(p_order uuid) returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(round(sum(case when r.kind = 'persen' then (i.line_total - i.discount) * r.value / 100.0 else i.qty * r.value end)), 0)::int
    from pos_order_items i join pos_orders o on o.id = i.order_id
    cross join lateral (select * from pos_commission_rules x
       where x.active and o.sale_day between x.starts_on and coalesce(x.ends_on, date '9999-12-31')
         and (x.product_code = i.product_code or x.product_code is null)
       order by (x.product_code is null), x.starts_on desc, x.id desc limit 1) r
   where i.order_id = p_order and not i.free_bag and public._commission_on(o.served_by, o.sold_at)
$$;



create or replace function public.commission_set_staff(p_staff uuid, p_enabled boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); t profiles;
begin
  select * into t from profiles where id = p_staff and role in ('staff', 'manager', 'owner') and deleted_at is null;
  if t.id is null then raise exception 'Staf tidak ditemukan.'; end if;
  if t.id = me and not exists (select 1 from profiles where id = me and role = 'owner') then
    raise exception 'Komisi Anda sendiri diatur oleh pemilik.';
  end if;
  update profiles set commission_enabled = coalesce(p_enabled, false) where id = t.id;
  perform public._commission_switch(t.id, p_enabled, me);
  perform public._log('komisi_staf', jsonb_build_object('staf', t.id, 'nama', t.full_name, 'aktif', coalesce(p_enabled, false)));
  return public.commission_settings();
end $$;

revoke all on function public._commission_on(uuid) from public, anon, authenticated;
revoke all on function public._commission_on(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public._commission_switch(uuid, boolean, uuid) from public, anon, authenticated;
revoke all on function public._pos_order_commission(uuid) from public, anon, authenticated;
revoke all on function public._rep_commission(uuid) from public, anon, authenticated;

-- ================================================================ Jadwal komisi (Glenn, 14 Nov 2026)
-- "Commissions is automatically processed and requires payment. Create a setting for this also in case
-- of change of program. Data cutout is usually monthly, processed and paid next month in the middle of it."
--   settings.commission_auto        Proses otomatis (on): a closed period becomes payouts by itself
--   settings.commission_cutoff_day  Tanggal tutup buku: 1-28, or 0 = akhir bulan (default)
--   settings.commission_pay_day     Tanggal bayar in the month after the period ends (1-28, default 15)
--   settings.commission_enabled_at  the day the commission system was first switched on
-- A period runs from the day after one cut-off to the next cut-off. pos_commission_periods holds every
-- closed period, so the next period always starts the day after the last one closed: changing the
-- schedule never moves orders that are already processed. The open period then ends on the first new
-- cut-off on or after its start day (it can come out shorter, never longer than a month; if that day has
-- already passed it closes on the next check). Each staff member's payout covers only days that no
-- earlier payout of theirs covers (also the free-range Transaksi > Proses komisi), so nothing is paid
-- twice and no day is skipped. There is no cron: _commission_autoprocess() runs when the Dashboard
-- komisi, the payout list or the till's dashboard (pos_home) opens.
-- The switches are read when a period is closed: a staff member (or the whole system) switched off on
-- that day gets no payout for that period.

alter table public.settings add column if not exists commission_enabled_at date;
alter table public.settings add column if not exists commission_auto boolean not null default true;
alter table public.settings add column if not exists commission_cutoff_day smallint not null default 0;
alter table public.settings add column if not exists commission_pay_day smallint not null default 15;
alter table public.settings drop constraint if exists settings_commission_cutoff_check;
alter table public.settings add constraint settings_commission_cutoff_check check (commission_cutoff_day between 0 and 28);
alter table public.settings drop constraint if exists settings_commission_pay_check;
alter table public.settings add constraint settings_commission_pay_check check (commission_pay_day between 1 and 28);
update public.settings set commission_enabled_at = public._local(now())::date where commission_enabled and commission_enabled_at is null;

alter table public.pos_commission_payouts add column if not exists due_on date;
alter table public.pos_commission_payouts add column if not exists auto boolean not null default false;

create table if not exists public.pos_commission_periods (
  period_from date primary key,
  period_to date not null unique,
  due_on date not null,
  closed_at timestamptz not null default now(),
  closed_by uuid references public.profiles (id) on delete set null,  -- null = closed automatically
  auto boolean not null default true,
  payouts int not null default 0,
  total int not null default 0,
  check (period_to >= period_from)
);
alter table public.pos_commission_periods enable row level security;
revoke all on public.pos_commission_periods from anon, authenticated;

-- The cut-off day in the month of p_month (0 = the last day of that month).
create or replace function public._commission_cutoff_in(p_month date, p_cut int) returns date
language sql immutable
as $$
  select case when p_cut between 1 and 28 then make_date(extract(year from p_month)::int, extract(month from p_month)::int, p_cut)
    else (date_trunc('month', p_month) + interval '1 month - 1 day')::date end
$$;

-- The end of a period that starts (or is open) on p_day: the first cut-off on or after it.
create or replace function public._commission_period_end(p_day date, p_cut int) returns date
language sql immutable
as $$
  select case when public._commission_cutoff_in(p_day, p_cut) >= p_day then public._commission_cutoff_in(p_day, p_cut)
    else public._commission_cutoff_in((date_trunc('month', p_day) + interval '1 month')::date, p_cut) end
$$;

-- The first day of the period that holds p_day: the day after the cut-off before its end.
create or replace function public._commission_period_start(p_day date, p_cut int) returns date
language sql immutable
as $$
  select public._commission_cutoff_in((date_trunc('month', public._commission_period_end(p_day, p_cut)) - interval '1 month')::date, p_cut) + 1
$$;

-- Payment due: Tanggal bayar in the month after the period ends.
create or replace function public._commission_due(p_to date, p_pay int) returns date
language sql immutable
as $$
  select make_date(extract(year from d)::int, extract(month from d)::int, greatest(1, least(28, coalesce(p_pay, 15))))
  from (select (date_trunc('month', p_to) + interval '1 month')::date as d) x
$$;

-- Where the next period to close starts: the day after the last closed period, else the start of the
-- period that holds the day the system was first switched on. Null while it was never on.
create or replace function public._commission_anchor() returns date
language sql stable security definer set search_path = public
as $$
  select coalesce((select max(period_to) + 1 from pos_commission_periods),
    (select public._commission_period_start(s.commission_enabled_at, s.commission_cutoff_day) from settings s where s.id = 1))
$$;

-- Payouts made outside the schedule (Transaksi > Proses komisi) also get a due date.
create or replace function public._commission_payout_due() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.due_on is null then
    new.due_on := public._commission_due(new.period_to, (select commission_pay_day from settings where id = 1));
  end if;
  return new;
end $$;
drop trigger if exists pos_commission_payouts_due on public.pos_commission_payouts;
create trigger pos_commission_payouts_due before insert on public.pos_commission_payouts
  for each row execute function public._commission_payout_due();
update public.pos_commission_payouts y set due_on = public._commission_due(y.period_to, s.commission_pay_day)
  from public.settings s where s.id = 1 and y.due_on is null;

-- One staff member's paid orders on p_from..p_to, with commission by the current rules and switches.
create or replace function public._commission_sum(p_staff uuid, p_from date, p_to date)
returns table (n_orders int, n_sales int, n_commission int)
language sql stable security definer set search_path = public
as $$
  select count(*)::int, coalesce(sum(o.subtotal - o.discount), 0)::int, coalesce(sum(public._pos_order_commission(o.id)), 0)::int
  from pos_orders o where o.served_by = p_staff and o.sale_day between p_from and p_to and o.status = 'dibayar'
$$;

-- What is still open in p_from..p_to: per staff member, each stretch of days no live payout of theirs
-- covers, with its figures. Closing a period turns these into payouts.
create or replace function public._commission_gaps(p_from date, p_to date)
returns table (g_staff uuid, g_from date, g_to date, g_orders int, g_sales int, g_commission int)
language plpgsql stable security definer set search_path = public
as $$
declare r record; y record; cur date;
begin
  for r in select distinct o.served_by as sid from pos_orders o
           where o.sale_day between p_from and p_to and o.status = 'dibayar' and o.served_by is not null loop
    cur := p_from;
    for y in select p.period_from as pf, p.period_to as pt from pos_commission_payouts p
             where p.staff_id = r.sid and p.cancelled_at is null and p.period_from <= p_to and p.period_to >= p_from
             order by p.period_from loop
      if y.pf > cur then
        return query select r.sid, cur, y.pf - 1, x.n_orders, x.n_sales, x.n_commission from public._commission_sum(r.sid, cur, y.pf - 1) x;
      end if;
      cur := greatest(cur, y.pt + 1);
    end loop;
    if cur <= p_to then
      return query select r.sid, cur, p_to, x.n_orders, x.n_sales, x.n_commission from public._commission_sum(r.sid, cur, p_to) x;
    end if;
  end loop;
end $$;

-- Close one period: a payout (Belum dibayar) per open stretch above Rp0, then the period row. The
-- caller holds the 'pos_commission_process' lock. The accrual journal follows like a manual process.
create or replace function public._commission_close_period(p_from date, p_to date, p_by uuid, p_auto boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare g record; due date := public._commission_due(p_to, (select commission_pay_day from settings where id = 1)); n int := 0; tot int := 0;
begin
  for g in select * from public._commission_gaps(p_from, p_to) where g_commission > 0 loop
    insert into pos_commission_payouts (period_from, period_to, staff_id, orders, sales, commission, processed_by, due_on, auto)
    values (g.g_from, g.g_to, g.g_staff, g.g_orders, g.g_sales, g.g_commission, p_by, due, p_auto);
    n := n + 1; tot := tot + g.g_commission;
  end loop;
  insert into pos_commission_periods (period_from, period_to, due_on, closed_by, auto, payouts, total)
  values (p_from, p_to, due, p_by, p_auto, n, tot);
  perform public._log('komisi_tutup_periode', jsonb_build_object('dari', p_from, 'sampai', p_to, 'staf', n, 'total', tot, 'otomatis', p_auto, 'jatuh_tempo', due));
  if to_regprocedure('public._pos_acc_post(date,uuid)') is not null then perform public._pos_acc_post(p_to, null); end if;
  return json_build_object('from', p_from, 'to', p_to, 'due', due, 'payouts', n, 'total', tot);
end $$;

-- Close every period that has ended and is not closed yet (Proses otomatis on). Idempotent: the
-- advisory lock is the one pos_commission_process takes, and the next period is read again after it.
-- p_today is for tests; the app never passes it.
create or replace function public._commission_autoprocess(p_today date default null) returns int
language plpgsql volatile security definer set search_path = public
as $$
declare s settings; d date := coalesce(p_today, public._local(now())::date); a date; e date; n int := 0;
begin
  select * into s from settings where id = 1;
  if not s.commission_auto or s.commission_enabled_at is null then return 0; end if;
  a := public._commission_anchor();
  if a is null or public._commission_period_end(a, s.commission_cutoff_day) >= d then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('pos_commission_process'));
  loop
    select * into s from settings where id = 1;
    exit when not s.commission_auto or n >= 36;
    a := public._commission_anchor();
    e := public._commission_period_end(a, s.commission_cutoff_day);
    exit when e >= d;
    perform public._commission_close_period(a, e, null, true);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The same, for the page and the till: a failure is logged and never stops the caller.
create or replace function public._commission_autoprocess_safe() returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._commission_autoprocess();
exception when others then
  begin perform public._log('komisi_otomatis_gagal', jsonb_build_object('error', sqlerrm)); exception when others then null; end;
end $$;

-- The open period and the closed ones not processed yet (Proses otomatis off), from the anchor on.
create or replace function public._commission_open_periods(p_today date default null)
returns table (p_from date, p_to date, p_due date, p_current boolean)
language plpgsql stable security definer set search_path = public
as $$
declare s settings; d date := coalesce(p_today, public._local(now())::date); a date; e date; i int := 0;
begin
  select * into s from settings where id = 1;
  a := coalesce(public._commission_anchor(), public._commission_period_start(d, s.commission_cutoff_day));
  loop
    e := public._commission_period_end(a, s.commission_cutoff_day);
    p_from := a; p_to := e; p_due := public._commission_due(e, s.commission_pay_day); p_current := e >= d;
    return next;
    exit when e >= d or i >= 36;
    a := e + 1; i := i + 1;
  end loop;
end $$;

-- Owner or manager: the schedule. Logged.
create or replace function public.commission_set_schedule(p_auto boolean, p_cutoff int, p_pay_day int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); old settings;
begin
  if p_cutoff is null or p_cutoff < 0 or p_cutoff > 28 then raise exception 'Pilih tanggal tutup buku 1 sampai 28, atau akhir bulan.'; end if;
  if p_pay_day is null or p_pay_day < 1 or p_pay_day > 28 then raise exception 'Pilih tanggal bayar 1 sampai 28.'; end if;
  perform pg_advisory_xact_lock(hashtext('pos_commission_process'));
  select * into old from settings where id = 1;
  update settings set commission_auto = coalesce(p_auto, true), commission_cutoff_day = p_cutoff, commission_pay_day = p_pay_day where id = 1;
  perform public._log('komisi_jadwal', jsonb_build_object('otomatis', coalesce(p_auto, true), 'tutup_buku', p_cutoff, 'tanggal_bayar', p_pay_day,
    'sebelumnya', jsonb_build_object('otomatis', old.commission_auto, 'tutup_buku', old.commission_cutoff_day, 'tanggal_bayar', old.commission_pay_day)));
  return public.commission_settings();
end $$;

-- Owner: close the next ended period by hand (Proses otomatis off). p_from/p_to are what the page showed.
create or replace function public.commission_process_period(p_from date, p_to date) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang memproses komisi.'); s settings; a date; e date;
begin
  perform pg_advisory_xact_lock(hashtext('pos_commission_process'));
  select * into s from settings where id = 1;
  if s.commission_enabled_at is null then raise exception 'Sistem komisi belum pernah dinyalakan.'; end if;
  a := public._commission_anchor(); e := public._commission_period_end(a, s.commission_cutoff_day);
  if p_to < a then raise exception 'Periode ini sudah diproses.'; end if;
  if a is distinct from p_from or e is distinct from p_to then raise exception 'Periodenya sudah berubah. Muat ulang halamannya.'; end if;
  if e >= public._local(now())::date then raise exception 'Periode ini belum ditutup.'; end if;
  return public._commission_close_period(a, e, me, false);
end $$;

-- Switching the system on records the first day (the start of the first period).
create or replace function public.commission_set_enabled(p_enabled boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  update settings set commission_enabled = coalesce(p_enabled, false),
    commission_enabled_at = case when coalesce(p_enabled, false) then coalesce(commission_enabled_at, public._local(now())::date) else commission_enabled_at end
  where id = 1;
  perform public._commission_switch(null, p_enabled, me);
  perform public._log('komisi_sistem', jsonb_build_object('aktif', coalesce(p_enabled, false)));
  return public.commission_settings();
end $$;

-- The switches plus the schedule and the open period.
create or replace function public.commission_settings() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); s settings; cur record;
begin
  select * into s from settings where id = 1;
  select * into cur from public._commission_open_periods() x where x.p_current;
  return json_build_object('enabled', s.commission_enabled, 'enabled_at', s.commission_enabled_at,
    'auto', s.commission_auto, 'cutoff_day', s.commission_cutoff_day, 'pay_day', s.commission_pay_day,
    'is_owner', exists (select 1 from profiles where id = me and role = 'owner'),
    'today', public._local(now())::date, 'anchor', public._commission_anchor(),
    'current', json_build_object('from', cur.p_from, 'to', cur.p_to, 'due', cur.p_due),
    'staff', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.full_name, 'role', p.role,
        'employer', p.employer, 'enabled', p.commission_enabled, 'self', p.id = me) order by p.role = 'owner', p.full_name)
      from profiles p where p.role in ('staff', 'manager', 'owner') and p.deleted_at is null), '[]'));
end $$;

-- Tandai dibayar: the owner or a manager (Glenn, 14 Nov 2026); a manager can't mark their own.
create or replace function public.pos_commission_mark_paid(p_id bigint, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); y pos_commission_payouts; nt text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into y from pos_commission_payouts where id = p_id for update;
  if y.id is null then raise exception 'Komisi ini tidak ditemukan.'; end if;
  if y.cancelled_at is not null then raise exception 'Komisi ini sudah dibatalkan.'; end if;
  if y.paid_at is not null then raise exception 'Komisi ini sudah ditandai dibayar.'; end if;
  if y.staff_id = me and not exists (select 1 from profiles where id = me and role = 'owner') then
    raise exception 'Komisi Anda sendiri ditandai dibayar oleh pemilik.';
  end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan terlalu panjang (paling panjang 200 huruf).'; end if;
  update pos_commission_payouts set paid_at = now(), paid_by = me, note = coalesce(nt, note) where id = y.id;
  perform public._log('komisi_dibayar', jsonb_build_object('payout', y.id, 'staff', y.staff_id, 'commission', y.commission));
  if to_regprocedure('public._pos_acc_post(date,uuid)') is not null then perform public._pos_acc_post(public._local(now())::date, null); end if;
  return json_build_object('id', y.id, 'status', 'dibayar');
end $$;

-- The payout list (Transaksi > Proses komisi): runs the automatic step first, adds due date and Terlambat.
create or replace function public.pos_commission_payouts(p_from date, p_to date) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._rep_reader(); d date := public._local(now())::date;
begin
  perform public._pos_commission_range(p_from, p_to);
  perform public._commission_autoprocess_safe();
  return coalesce((select json_agg(x order by x.id desc) from (
    select y.id, y.period_from, y.period_to, y.staff_id, public._first_name(p.full_name) as name, y.orders, y.sales, y.commission,
      case when pb.id is null then null else public._first_name(pb.full_name) end as processed_by, y.processed_at, y.paid_at,
      case when pd.id is null then null else public._first_name(pd.full_name) end as paid_by, y.note,
      y.cancelled_at, y.cancel_reason, y.due_on, y.auto, y.staff_id = me as own,
      (y.cancelled_at is null and y.paid_at is null and y.due_on < d) as overdue,
      case when y.cancelled_at is not null then 'batal' when y.paid_at is not null then 'dibayar' else 'diproses' end as status
    from pos_commission_payouts y join profiles p on p.id = y.staff_id
    left join profiles pb on pb.id = y.processed_by left join profiles pd on pd.id = y.paid_by
    where y.period_from <= p_to and y.period_to >= p_from) x), '[]');
end $$;

-- Dashboard komisi (design A, Glenn 14 Nov 2026). p_range: 'ini' (the open period), 'lalu' (the last
-- closed one) or '3' (the open period and the two before it). Owner or manager.
create or replace function public.commission_dashboard(p_range text default 'ini') returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
  s settings; d date := public._local(now())::date; f date; t date; cur record; per jsonb;
begin
  if coalesce(p_range, 'ini') not in ('ini', 'lalu', '3') then raise exception 'Pilih periode ini, periode lalu atau 3 periode.'; end if;
  perform public._commission_autoprocess_safe();
  select * into s from settings where id = 1;
  select * into cur from public._commission_open_periods(d) x where x.p_current;

  -- Every period, oldest first: closed (pos_commission_periods), ended but not processed, the open one.
  with ps as (
    select c.period_from as f, c.period_to as t, c.due_on as due,
      case when exists (select 1 from pos_commission_payouts y where y.cancelled_at is null and y.paid_at is null
                          and y.period_from <= c.period_to and y.period_to >= c.period_from) then 'belum' else 'bayar' end as state
    from pos_commission_periods c
    union all
    select x.p_from, x.p_to, x.p_due, case when x.p_current then 'berjalan' else 'proses' end from public._commission_open_periods(d) x),
  picked as (select * from (select ps.*, row_number() over (order by ps.f desc) as k from ps) z
    where case coalesce(p_range, 'ini') when 'ini' then z.k = 1 when 'lalu' then z.k = 2 else z.k <= 3 end)
  select coalesce(jsonb_agg(jsonb_build_object('from', p.f, 'to', p.t, 'due', p.due, 'state', p.state) order by p.f), '[]') into per from picked p;
  f := (per->0->>'from')::date;
  t := least(d, (per->(jsonb_array_length(per) - 1)->>'to')::date);

  return (with days as (select g::date as day from generate_series(f, t, interval '1 day') g where f is not null and f <= t),
    dstate as (select dd.day, coalesce((select pp->>'state' from jsonb_array_elements(per) pp
        where dd.day between (pp->>'from')::date and (pp->>'to')::date limit 1), 'berjalan') as state from days dd),
    ord as (select o.id, o.served_by, o.sale_day, (o.subtotal - o.discount) as sales, public._pos_order_commission(o.id) as kom
            from pos_orders o where f is not null and o.sale_day between f and t and o.status = 'dibayar' and o.served_by is not null),
    st as (select p.id, p.full_name, p.employer, p.role, public._commission_on(p.id) as on_now from profiles p
           where (p.role in ('staff', 'manager') and p.deleted_at is null) or p.id in (select served_by from ord)),
    pay as (select y.* from pos_commission_payouts y where y.cancelled_at is null and f is not null and y.period_from <= t and y.period_to >= f)
  select json_build_object(
    'today', d, 'range', coalesce(p_range, 'ini'), 'from', f, 'to', t, 'periods', per,
    'is_owner', exists (select 1 from profiles where id = me and role = 'owner'), 'me', me,
    'settings', json_build_object('enabled', s.commission_enabled, 'enabled_at', s.commission_enabled_at, 'auto', s.commission_auto,
      'cutoff_day', s.commission_cutoff_day, 'pay_day', s.commission_pay_day),
    'current', json_build_object('from', cur.p_from, 'to', cur.p_to, 'due', cur.p_due,
      'commission', (select coalesce(sum(public._pos_order_commission(o.id)), 0) from pos_orders o
                      where o.sale_day between cur.p_from and least(cur.p_to, d) and o.status = 'dibayar' and o.served_by is not null)),
    -- Ended periods waiting for Proses komisi (Proses otomatis off), with what is still open in each.
    'unprocessed', coalesce((select json_agg(json_build_object('from', x.p_from, 'to', x.p_to, 'due', x.p_due,
        'commission', (select coalesce(sum(g.g_commission), 0) from public._commission_gaps(x.p_from, x.p_to) g)) order by x.p_from)
      from public._commission_open_periods(d) x where not x.p_current), '[]'),
    -- Every payout still to pay, whatever the range.
    'unpaid', coalesce((select json_agg(json_build_object('id', y.id, 'staff_id', y.staff_id, 'name', p.full_name, 'from', y.period_from, 'to', y.period_to,
        'commission', y.commission, 'orders', y.orders, 'due', y.due_on, 'overdue', y.due_on < d, 'own', y.staff_id = me, 'auto', y.auto) order by y.due_on, p.full_name)
      from pos_commission_payouts y join profiles p on p.id = y.staff_id where y.cancelled_at is null and y.paid_at is null), '[]'),
    'paid_year', json_build_object('year', extract(year from d)::int,
      'total', (select coalesce(sum(y.commission), 0) from pos_commission_payouts y where y.cancelled_at is null and y.paid_at is not null
                  and extract(year from public._local(y.paid_at)) = extract(year from d)),
      'count', (select count(*) from pos_commission_payouts y where y.cancelled_at is null and y.paid_at is not null
                  and extract(year from public._local(y.paid_at)) = extract(year from d))),
    'staff', coalesce((select json_agg(json_build_object('id', x.id, 'name', x.full_name, 'employer', x.employer, 'on', x.on_now,
        'orders', x.orders, 'sales', x.sales, 'commission', x.kom, 'unpaid', x.unpaid, 'paid', x.paid, 'daily', x.daily)
        order by x.on_now desc, x.kom desc, x.full_name) from (
      select st.id, st.full_name, st.employer, st.on_now,
        (select count(*) from ord where ord.served_by = st.id)::int as orders,
        (select coalesce(sum(ord.sales), 0) from ord where ord.served_by = st.id)::int as sales,
        (select coalesce(sum(ord.kom), 0) from ord where ord.served_by = st.id)::int as kom,
        (select coalesce(sum(pay.commission), 0) from pay where pay.staff_id = st.id and pay.paid_at is null)::int as unpaid,
        (select coalesce(sum(pay.commission), 0) from pay where pay.staff_id = st.id and pay.paid_at is not null)::int as paid,
        (select coalesce(json_agg(coalesce((select sum(ord.kom) from ord where ord.served_by = st.id and ord.sale_day = dd.day), 0) order by dd.day), '[]') from days dd) as daily
      from st) x), '[]'),
    'days', coalesce((select json_agg(json_build_object('day', ds.day, 'state', ds.state,
        'commission', coalesce((select sum(ord.kom) from ord where ord.sale_day = ds.day), 0)) order by ds.day) from dstate ds), '[]')));
end $$;

revoke all on function public._commission_cutoff_in(date, int), public._commission_period_end(date, int), public._commission_period_start(date, int),
  public._commission_due(date, int), public._commission_anchor(), public._commission_payout_due(), public._commission_sum(uuid, date, date),
  public._commission_gaps(date, date), public._commission_close_period(date, date, uuid, boolean), public._commission_autoprocess(date),
  public._commission_autoprocess_safe(), public._commission_open_periods(date) from public, anon, authenticated;
revoke all on function public.commission_set_schedule(boolean, int, int), public.commission_process_period(date, date), public.commission_dashboard(text),
  public.pos_commission_mark_paid(bigint, text), public.pos_commission_payouts(date, date) from public, anon;
grant execute on function public.commission_set_schedule(boolean, int, int), public.commission_process_period(date, date), public.commission_dashboard(text),
  public.pos_commission_mark_paid(bigint, text), public.pos_commission_payouts(date, date) to authenticated;
revoke all on function public.commission_settings(), public.commission_set_enabled(boolean), public.commission_set_staff(uuid, boolean) from public, anon;
grant execute on function public.commission_settings(), public.commission_set_enabled(boolean), public.commission_set_staff(uuid, boolean) to authenticated;
