-- Hanashuya attendance (absensi): staff profiles, shifts, schedule, clock-in scans,
-- leave requests, overtime, corrections and the monthly recap.
-- Task 14 of POSDEVELOPMENT.md. Run schema.sql, then pos.sql, then this file, in the
-- Supabase SQL Editor. Re-running is safe: tables are only created when missing and
-- functions are replaced. It does not need the till and can be switched on before it.
--
-- Same rules as schema.sql: every table has row security and no direct access from the
-- browser, every write goes through a security-definer function, and every important
-- write is in audit_log. Times always come from the server (now()), never the phone.
--
-- How it works:
--   * The kasir tablet shows a QR (att_qr_token) that changes every 20 seconds
--     (settings.att_qr_seconds): an HMAC of the window number with settings.token_secret,
--     like the member card QR. The current and the previous window scan, so a photo of the
--     QR sent home stops working within 40 seconds. A QR that checks out gives the phone a
--     2-minute ticket (HST1, bound to the person and the phone) for the button tap.
--   * One phone per account (att_devices): the phone keeps a random id; the first scan
--     binds it, another phone is refused until a manager or the owner resets it
--     (att_reset_device). One phone cannot be bound to two accounts.
--   * Location: once the booth location is set (att_set_location), every scan must send
--     the phone's location, and a phone further than att_radius_m (minus its accuracy)
--     is refused. Accuracy worse than 300 m is accepted and flagged lokasi_kurang_akurat.
--   * Each staff member scans it with their own phone, signed in with their own staff
--     account (absen.html). att_scan only allows the action that makes sense next:
--     Masuk, then Istirahat or Pulang, after Istirahat only Kembali.
--   * Lateness, breaks, missing scans and overtime are worked out from the scans against
--     the schedule (_att_day); nothing is stored twice. Only overtime decisions are stored.
--   * Times only, no pay maths (open question 13: is the break paid, is lateness deducted).
--
-- Rules (Glenn, 11 Nov 2026):
--   late       clock-in more than 10 minutes after the scheduled start (late minutes are
--              counted from the start)
--   clock-out  expected within 10 minutes after the scheduled end
--   overtime   still clocked in 20 minutes after the scheduled end: counted from the
--              scheduled end, counts only once a manager or the owner approves it
--   break      1 hour per shift; a longer break is flagged
--   leave      requested at the latest 7 days before the day; manager or owner decides
--   corrections only by a manager or the owner, with a reason, logged; never your own
--
-- Testing: the functions take the time from now(). The underscore helpers that do the
-- work take the time as a parameter (_att_next, _att_day); the browser cannot call them.
-- Tests insert past scans straight into att_events. There is no time override setting.

-- ---------------------------------------------------------------- settings
alter table public.settings add column if not exists att_late_minutes int not null default 10 check (att_late_minutes >= 0);
alter table public.settings add column if not exists att_out_minutes int not null default 10 check (att_out_minutes >= 0);
alter table public.settings add column if not exists att_overtime_after int not null default 20 check (att_overtime_after >= 0);
alter table public.settings add column if not exists att_qr_seconds int not null default 20 check (att_qr_seconds between 15 and 600);
-- 20 seconds since 11 Nov 2026 (Glenn, to stop staff clocking in for each other). A
-- database that still has the old 60 is moved to 20 once.
alter table public.settings alter column att_qr_seconds set default 20;
update public.settings set att_qr_seconds = 20 where id = 1 and att_qr_seconds = 60;
-- The booth's location (set from the kasir tablet, att_set_location). Null = not set yet,
-- and then scans are accepted without a location. A scan whose distance minus the
-- phone's accuracy is more than att_radius_m is refused.
alter table public.settings add column if not exists att_lat double precision check (att_lat between -90 and 90);
alter table public.settings add column if not exists att_lng double precision check (att_lng between -180 and 180);
alter table public.settings add column if not exists att_radius_m int not null default 200 check (att_radius_m between 50 and 2000);
alter table public.settings add column if not exists att_location_at timestamptz;
alter table public.settings add column if not exists att_location_by uuid;
-- The session after a scan: a Masuk older than this with no Pulang counts as forgotten,
-- so the next scan is a new Masuk and the old shift is flagged for a correction.
alter table public.settings add column if not exists att_stale_hours int not null default 16 check (att_stale_hours between 4 and 24);

-- ---------------------------------------------------------------- staff profile
-- Full name and WhatsApp stay in profiles (the WhatsApp number is the login, so only the
-- owner changes it). Bank details for payroll live here, apart from profiles, and are
-- read only by the person, managers and the owner (att_my_profile, att_staff_list,
-- att_recap). They are not in owner_backup or audit_log. UU PDP: only what payroll needs.
create table if not exists public.att_profiles (
  staff_id uuid primary key references public.profiles (id) on delete cascade,
  bank_name text,
  bank_account text,
  bank_holder text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
-- ---------------------------------------------------------------- shifts
create table if not exists public.att_shifts (
  id int generated by default as identity primary key,
  name text not null,
  start_time time not null,
  end_time time not null,
  break_minutes int not null default 60 check (break_minutes between 0 and 240),
  sort int not null default 0,
  active boolean not null default true,
  check (end_time > start_time)
);
create unique index if not exists att_shifts_name_once on public.att_shifts (lower(name));
-- Glenn's shift options (11 Nov 2026, schedule "SHIFT KJ 2"). Added only when missing,
-- so the owner's later changes are kept.
insert into public.att_shifts (name, start_time, end_time, break_minutes, sort)
select v.name, v.s::time, v.e::time, 60, v.sort from (values
  ('Fulltime 1', '08:00', '18:00', 1), ('Fulltime 2', '11:00', '21:00', 2),
  ('Parttime 1', '08:00', '14:00', 3), ('Parttime 2', '15:00', '21:00', 4)) v(name, s, e, sort)
where not exists (select 1 from public.att_shifts x where lower(x.name) = lower(v.name));

-- ---------------------------------------------------------------- schedule
-- The same shape as the schedule parser (Hanashuya Drafts/pos-schedule/schedule.js):
-- one row per person and block. weekday (1 = Senin) repeats every week; on_date is a
-- one-off day that replaces that person's weekly pattern for that date. Several blocks a
-- day are several rows; kuliah and tidak_bisa mark hours the person is not available.
create table if not exists public.att_schedule (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.profiles (id) on delete cascade,
  weekday smallint check (weekday between 1 and 7),
  on_date date,
  kind text not null check (kind in ('kerja', 'kuliah', 'tidak_bisa', 'libur')),
  start_time time,
  end_time time,
  shift text,
  note text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((weekday is null) <> (on_date is null)),
  check ((kind = 'libur' and start_time is null and end_time is null)
      or (kind <> 'libur' and start_time is not null and end_time is not null and end_time > start_time))
);
create index if not exists att_schedule_week on public.att_schedule (staff_id, weekday);
create index if not exists att_schedule_date on public.att_schedule (staff_id, on_date);

-- ---------------------------------------------------------------- scans
-- One row per scan. Corrections add a row (via 'koreksi') or void one; nothing is ever
-- deleted. staff_id has no foreign key on purpose, so payroll history outlives an account.
create table if not exists public.att_events (
  id bigint generated always as identity primary key,
  staff_id uuid not null,
  action text not null check (action in ('masuk', 'istirahat', 'kembali', 'pulang')),
  at timestamptz not null default now(),
  via text not null default 'qr' check (via in ('qr', 'koreksi')),
  reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text
);
create index if not exists att_events_staff_at on public.att_events (staff_id, at);
-- Where the scan came from (11 Nov 2026): the phone's hashed id and, when the booth
-- location is set, the phone's location, accuracy and distance to the booth.
alter table public.att_events add column if not exists device_hash text;
alter table public.att_events add column if not exists lat double precision;
alter table public.att_events add column if not exists lng double precision;
alter table public.att_events add column if not exists acc_m int;
alter table public.att_events add column if not exists distance_m int;
alter table public.att_events add column if not exists flags text[] not null default '{}';

-- ---------------------------------------------------------------- one phone per account
-- Daily working-time target in minutes (Glenn, 12 Nov 2026): null = 9 hours (full-timers);
-- Kevin 5 hours. Set by a manager or the owner in Per staf (att_set_work_target).
alter table public.profiles add column if not exists work_target_min int check (work_target_min between 60 and 720);

create or replace function public.att_set_work_target(p_staff uuid, p_min int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); old int;
begin
  perform public._att_not_own(me, p_staff, 'Jam kerja Anda sendiri diatur oleh pemilik atau manajer lain.');
  if p_min is not null and (p_min < 60 or p_min > 720) then raise exception 'Jam kerja per hari antara 1 dan 12 jam.'; end if;
  select work_target_min into old from profiles where id = p_staff and role in ('staff', 'manager') and deleted_at is null;
  if not found then raise exception 'Staf tidak ditemukan.'; end if;
  update profiles set work_target_min = p_min where id = p_staff;
  perform public._log('absen_target_jam', jsonb_build_object('staff', p_staff, 'dari', old, 'jadi', p_min));
  return json_build_object('staff', p_staff, 'work_target_min', coalesce(p_min, 540));
end $$;

-- The phone's random id is never stored, only its sha256. One row per person; a phone id
-- can belong to one person only. Reset by a manager or the owner (att_reset_device).
create table if not exists public.att_devices (
  staff_id uuid primary key references public.profiles (id) on delete cascade,
  device_hash text not null unique,
  label text,
  bound_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- leave (perizinan)
create table if not exists public.att_leave (
  id bigint generated always as identity primary key,
  staff_id uuid not null,
  start_date date not null,
  end_date date not null,
  reason text not null,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak', 'dibatalkan')),
  requested_by uuid,
  created_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  check (end_date >= start_date)
);
create index if not exists att_leave_staff on public.att_leave (staff_id, start_date);

-- ---------------------------------------------------------------- overtime decisions
-- Overtime candidates are worked out from the scans; a row here is the decision on one.
create table if not exists public.att_overtime (
  id bigint generated always as identity primary key,
  staff_id uuid not null,
  work_date date not null,
  block_start time not null,
  scheduled_end timestamptz not null,
  clock_out timestamptz not null,
  minutes int not null check (minutes >= 0),
  status text not null check (status in ('disetujui', 'ditolak')),
  note text,
  decided_by uuid,
  decided_at timestamptz not null default now(),
  unique (staff_id, work_date, block_start)
);

alter table public.att_profiles enable row level security;
alter table public.att_shifts enable row level security;
alter table public.att_schedule enable row level security;
alter table public.att_events enable row level security;
alter table public.att_leave enable row level security;
alter table public.att_overtime enable row level security;
alter table public.att_devices enable row level security;
revoke all on public.att_profiles, public.att_shifts, public.att_schedule, public.att_events,
  public.att_leave, public.att_overtime, public.att_devices from anon, authenticated;

-- Profile filled once, then changed by request (Glenn, 12 Nov 2026). locked_at is set when the
-- profile is complete (name, bank, account, holder); after that staff ask for a change and a
-- manager or the owner approves it.
alter table public.att_profiles add column if not exists locked_at timestamptz;
update public.att_profiles set locked_at = coalesce(updated_at, now())
  where locked_at is null and bank_name is not null and bank_account is not null and bank_holder is not null;
create table if not exists public.att_profile_requests (
  id bigint generated always as identity primary key,
  staff_id uuid not null references public.profiles (id) on delete cascade,
  changes jsonb not null,
  reason text not null,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak', 'dibatalkan')),
  created_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text
);
create unique index if not exists att_profile_requests_one_open on public.att_profile_requests (staff_id) where status = 'menunggu';
alter table public.att_profile_requests enable row level security;
revoke all on public.att_profile_requests from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public._att_today() returns date
language sql stable security definer set search_path = public
as $$ select public._local(now())::date $$;

-- The signed-in person for the staff's own attendance pages: a staff or manager account.
-- The kasir tablet account (role 'kasir', schema.sql) passes _require's staff checks for
-- selling, but it is a device, not a person: it can't clock in, keep a schedule, ask for
-- leave or hold a profile (Glenn, 13 Nov 2026).
create or replace function public._att_me(msg text) returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare r text;
begin
  select role into r from profiles where id = auth.uid() and deleted_at is null;
  if r = 'kasir' then
    raise exception 'Akun kasir tablet tidak bisa presensi. Masuk dengan akun staf Anda sendiri.' using errcode = '42501';
  end if;
  if r is null or r not in ('staff', 'manager') then raise exception '%', msg using errcode = '42501'; end if;
  return auth.uid();
end $$;

-- A staff or manager account that is still active (the people attendance tracks).
create or replace function public._att_staff(p uuid) returns profiles
language plpgsql stable security definer set search_path = public
as $$
declare r profiles;
begin
  select * into r from profiles where id = p and role in ('staff', 'manager') and deleted_at is null;
  if r.id is null then raise exception 'Staf tidak ditemukan.'; end if;
  return r;
end $$;

create or replace function public._att_sig(win bigint) returns text
language sql stable security definer set search_path = public, extensions
as $$
  select left(encode(extensions.hmac('absen.papaya-bdg.' || win::text, (select token_secret from settings where id = 1), 'sha256'), 'hex'), 16)
$$;

-- The day's blocks for one person: the one-off date rows if there are any, else the
-- weekly rows for that weekday. break_minutes comes from the named shift (60 otherwise).
create or replace function public._att_blocks(p_staff uuid, d date)
returns table (kind text, start_time time, end_time time, shift text, break_minutes int, note text, one_off boolean)
language sql stable security definer set search_path = public
as $$
  with pick as (
    select s.*, s.on_date is not null as one_off from att_schedule s
    where s.staff_id = p_staff and (
      s.on_date = d or (s.weekday = extract(isodow from d)::int
        and not exists (select 1 from att_schedule x where x.staff_id = p_staff and x.on_date = d)))
  )
  select p.kind, p.start_time, p.end_time, p.shift,
    coalesce((select sh.break_minutes from att_shifts sh where lower(sh.name) = lower(p.shift)), 60), p.note, p.one_off
  from pick p order by p.start_time nulls first
$$;

create or replace function public._att_on_leave(p_staff uuid, d date) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from att_leave where staff_id = p_staff and status = 'disetujui' and d between start_date and end_date) $$;

-- The last scan that counts (not voided, not older than att_stale_hours) before p_at.
create or replace function public._att_last(p_staff uuid, p_at timestamptz) returns att_events
language sql stable security definer set search_path = public
as $$
  select e.* from att_events e
  where e.staff_id = p_staff and e.voided_at is null and e.at <= p_at
    and e.at > p_at - make_interval(hours => (select att_stale_hours from settings where id = 1))
  order by e.at desc, e.id desc limit 1
$$;

-- What the person may scan next.
create or replace function public._att_next(p_staff uuid, p_at timestamptz) returns text[]
language plpgsql stable security definer set search_path = public
as $$
declare e att_events := public._att_last(p_staff, p_at);
begin
  return case
    when e.id is null or e.action = 'pulang' then array['masuk']
    when e.action in ('masuk', 'kembali') then array['istirahat', 'pulang']
    else array['kembali'] end;
end $$;

-- One person's day, one row per scheduled work block (kind 'jadwal'), plus a row for
-- any work outside the schedule ('di_luar_jadwal'), or one 'izin' row on approved leave.
-- Scans are grouped into sessions (Masuk to Pulang); each session goes to the block it
-- overlaps most (or the nearest block starting within 2 hours). p_now decides whether a
-- missing scan is already missing or simply has not happened yet.
-- flags: terlambat, tidak_hadir, tidak_scan_pulang, tidak_scan_kembali, istirahat_lebih,
--        pulang_awal, pulang_lewat (10 to 20 minutes after the end), lembur, di_luar_jadwal,
--        sedang_bekerja, sedang_istirahat.
create or replace function public._att_day(p_staff uuid, d date, p_now timestamptz)
returns table (work_date date, kind text, block_start time, block_end time, shift text, masuk timestamptz, pulang timestamptz,
  worked_min int, break_min int, break_limit int, late_min int, early_min int, overtime_min int, flags text[])
language plpgsql stable security definer set search_path = public
as $$
declare st settings := public._cfg(); r record; f text[];
begin
  if public._att_on_leave(p_staff, d) then
    work_date := d; kind := 'izin'; worked_min := 0; break_min := 0; late_min := 0; early_min := 0; overtime_min := 0; flags := '{}';
    return next; return;
  end if;
  for r in
    with ev as (
      select e.action, e.at, e.id from att_events e
      where e.staff_id = p_staff and e.voided_at is null and (e.at at time zone st.tz)::date = d
    ),
    g as (select ev.*, sum((ev.action = 'masuk')::int) over (order by ev.at, ev.id) as grp from ev),
    l as (
      select g.*, lead(g.action) over w as la, lead(g.at) over w as lt,
        -- events after the session's first Pulang do not count
        sum((g.action = 'pulang')::int) over (partition by g.grp order by g.at, g.id rows between unbounded preceding and 1 preceding) as outs_before
      from g where g.grp > 0
      window w as (partition by g.grp order by g.at, g.id)
    ),
    ses as (
      select l.grp, min(l.at) filter (where l.action = 'masuk') as s_in,
        min(l.at) filter (where l.action = 'pulang') as s_out,
        coalesce(sum(extract(epoch from (l.lt - l.at)) / 60) filter (where l.action = 'istirahat' and l.la in ('kembali', 'pulang')), 0)::int as brk,
        bool_or(l.action = 'istirahat' and l.la is null) as on_break,
        bool_or(l.action = 'istirahat' and l.la = 'pulang') as no_back
      from l where coalesce(l.outs_before, 0) = 0 group by l.grp
    ),
    b as (
      select row_number() over (order by x.start_time) as bi, x.start_time, x.end_time, x.shift, x.break_minutes,
        (d + x.start_time) at time zone st.tz as bs, (d + x.end_time) at time zone st.tz as be
      from public._att_blocks(p_staff, d) x where x.kind = 'kerja'
    ),
    m as (
      select ses.*, (
        select b.bi from b
        where least(coalesce(ses.s_out, greatest(b.be, ses.s_in)), b.be) > greatest(ses.s_in, b.bs)
           or abs(extract(epoch from (ses.s_in - b.bs))) <= 7200
        order by greatest(0, extract(epoch from (least(coalesce(ses.s_out, greatest(b.be, ses.s_in)), b.be) - greatest(ses.s_in, b.bs)))) desc,
                 abs(extract(epoch from (ses.s_in - b.bs)))
        limit 1) as bi
      from ses
    )
    select b.bi, b.start_time, b.end_time, b.shift, b.break_minutes, b.bs, b.be,
      min(m.s_in) as s_in, (array_agg(m.s_out order by m.s_in desc))[1] as s_out,
      count(m.grp) as n, bool_or(m.s_out is null and not m.on_break) as open_work,
      bool_or(m.on_break) as on_break, bool_or(m.no_back) as no_back, coalesce(sum(m.brk), 0)::int as brk,
      coalesce(sum(extract(epoch from (m.s_out - m.s_in)) / 60 - m.brk) filter (where m.s_out is not null), 0)::int as worked
    from b left join m on m.bi = b.bi
    group by b.bi, b.start_time, b.end_time, b.shift, b.break_minutes, b.bs, b.be
    union all
    select null, null, null, null, 60, null, null, m.s_in, m.s_out, 1, m.s_out is null and not m.on_break, m.on_break, m.no_back, m.brk,
      coalesce((extract(epoch from (m.s_out - m.s_in)) / 60 - m.brk)::int, 0)
    from m where m.bi is null
    order by 8 nulls last
  loop
    f := '{}';
    work_date := d; block_start := r.start_time; block_end := r.end_time; shift := r.shift;
    masuk := r.s_in; pulang := r.s_out; worked_min := greatest(r.worked, 0); break_min := r.brk; break_limit := r.break_minutes;
    late_min := 0; early_min := 0; overtime_min := 0;
    kind := case when r.bi is null then 'di_luar_jadwal' else 'jadwal' end;
    if r.bi is null then f := f || 'di_luar_jadwal'::text; end if;
    if r.n = 0 then
      if p_now > r.be then f := f || 'tidak_hadir'::text; end if;
    else
      if r.bs is not null and r.s_in > r.bs + make_interval(mins => st.att_late_minutes) then
        late_min := floor(extract(epoch from (r.s_in - r.bs)) / 60)::int; f := f || 'terlambat'::text;
      end if;
      if r.on_break then
        f := f || case when p_now - r.s_in > make_interval(hours => st.att_stale_hours) or d < public._local(p_now)::date
                    then 'tidak_scan_kembali' else 'sedang_istirahat' end;
      elsif r.open_work then
        f := f || case when p_now - r.s_in > make_interval(hours => st.att_stale_hours) or d < public._local(p_now)::date
                         or (r.be is not null and p_now > r.be + interval '3 hours')
                    then 'tidak_scan_pulang' else 'sedang_bekerja' end;
      end if;
      if r.no_back then f := f || 'tidak_scan_kembali'::text; end if;
      -- Break QR (Glenn, 12 Nov 2026): 1 hour, late only after 5 minutes over.
      if r.brk > r.break_minutes + 5 then f := f || 'istirahat_lebih'::text; end if;
      if r.be is not null and r.s_out is not null and not r.open_work and not r.on_break then
        if r.s_out < r.be then
          early_min := floor(extract(epoch from (r.be - r.s_out)) / 60)::int;
          if early_min > 0 then f := f || 'pulang_awal'::text; end if;
        elsif r.s_out >= r.be + make_interval(mins => st.att_overtime_after) then
          overtime_min := floor(extract(epoch from (r.s_out - r.be)) / 60)::int; f := f || 'lembur'::text;
        elsif r.s_out > r.be + make_interval(mins => st.att_out_minutes) then
          f := f || 'pulang_lewat'::text;
        end if;
      end if;
    end if;
    flags := f;
    return next;
  end loop;
end $$;

-- One scheduled block, checked. Raises in Indonesian with the row number.
create or replace function public._att_entry(e jsonb, n int, p_staff uuid, p_weekday int, p_date date, me uuid) returns att_schedule
language plpgsql stable security definer set search_path = public
as $$
declare r att_schedule; k text := lower(coalesce(e->>'kind', 'kerja'));
begin
  if k not in ('kerja', 'kuliah', 'tidak_bisa', 'libur') then raise exception 'Baris %: jenis "%" tidak dikenal.', n, e->>'kind'; end if;
  r.staff_id := p_staff; r.weekday := p_weekday; r.on_date := p_date; r.kind := k;
  r.note := left(coalesce(e->>'note', ''), 200); r.created_by := me;
  if k = 'libur' then return r; end if;
  begin
    r.start_time := nullif(e->>'start', '')::time; r.end_time := nullif(e->>'end', '')::time;
  exception when others then raise exception 'Baris %: jam tidak terbaca.', n;
  end;
  if r.start_time is null or r.end_time is null then raise exception 'Baris %: isi jam mulai dan selesai.', n; end if;
  if r.end_time <= r.start_time then raise exception 'Baris %: jam selesai harus setelah jam mulai.', n; end if;
  if k = 'kerja' then r.shift := nullif(trim(coalesce(e->>'shift', '')), ''); end if;
  return r;
end $$;

-- After a person's day changed: no Libur next to work, no overlapping work blocks.
create or replace function public._att_check_day(p_staff uuid, p_weekday int, p_date date) returns void
language plpgsql stable security definer set search_path = public
as $$
declare nm text := public._first_name((select full_name from profiles where id = p_staff));
  dl text := coalesce(to_char(p_date, 'DD/MM/YYYY'), (array['Senin','Selasa','Rabu','Kamis','Jumat','Sabtu','Minggu'])[p_weekday]);
begin
  if exists (select 1 from att_schedule where staff_id = p_staff and weekday is not distinct from p_weekday::smallint
               and on_date is not distinct from p_date and kind = 'libur')
     and exists (select 1 from att_schedule where staff_id = p_staff and weekday is not distinct from p_weekday::smallint
               and on_date is not distinct from p_date and kind <> 'libur' and kind = 'kerja') then
    raise exception '% (%): Libur dan jam kerja di hari yang sama.', nm, dl;
  end if;
  if exists (select 1 from att_schedule a join att_schedule b on a.id < b.id
             where a.staff_id = p_staff and b.staff_id = p_staff and a.kind = 'kerja' and b.kind = 'kerja'
               and a.weekday is not distinct from p_weekday::smallint and b.weekday is not distinct from p_weekday::smallint
               and a.on_date is not distinct from p_date and b.on_date is not distinct from p_date
               and a.start_time < b.end_time and b.start_time < a.end_time) then
    raise exception '% (%): jam kerja bertumpuk.', nm, dl;
  end if;
end $$;

-- Finds the staff account an uploaded row means: staff_id, or the name matched to the
-- full name or the first name (ignoring case and spaces), when exactly one fits.
create or replace function public._att_resolve(e jsonb, n int) returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare id uuid; nm text := lower(regexp_replace(trim(coalesce(e->>'name', '')), '\s+', ' ', 'g')); c int;
begin
  if coalesce(e->>'staff_id', '') <> '' then
    select p.id into id from profiles p where p.id = (e->>'staff_id')::uuid and p.role in ('staff', 'manager') and p.deleted_at is null;
    if id is null then raise exception 'Baris %: staf tidak ditemukan.', n; end if;
    return id;
  end if;
  select count(*), min(p.id::text)::uuid into c, id from profiles p
   where p.role in ('staff', 'manager') and p.deleted_at is null
     and (lower(regexp_replace(trim(p.full_name), '\s+', ' ', 'g')) = nm or lower(public._first_name(p.full_name)) = nm);
  if c = 0 then raise exception 'Baris %: nama "%" tidak ada di daftar staf.', n, e->>'name'; end if;
  if c > 1 then raise exception 'Baris %: nama "%" cocok dengan lebih dari satu staf. Tulis nama lengkap.', n, e->>'name'; end if;
  return id;
end $$;

create or replace function public._att_entry_json(s att_schedule) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_strip_nulls(jsonb_build_object('id', s.id, 'staff_id', s.staff_id,
    'name', (select public._first_name(full_name) from profiles where id = s.staff_id),
    'weekday', s.weekday, 'date', s.on_date, 'kind', s.kind,
    'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'), 'shift', s.shift, 'note', s.note))
$$;

create or replace function public._att_day_json(p_staff uuid, d date, p_now timestamptz) returns json
language sql stable security definer set search_path = public
as $$
  select coalesce(json_agg(json_build_object('date', x.work_date, 'kind', x.kind,
    'start', to_char(x.block_start, 'HH24:MI'), 'end', to_char(x.block_end, 'HH24:MI'), 'shift', x.shift,
    'masuk', x.masuk, 'pulang', x.pulang, 'worked_min', x.worked_min, 'break_min', x.break_min,
    'break_limit', x.break_limit, 'late_min', x.late_min, 'early_min', x.early_min,
    'overtime_min', x.overtime_min, 'flags', x.flags)), '[]')
  from public._att_day(p_staff, d, p_now) x
$$;

-- Distance in metres between two points (haversine).
create or replace function public._att_distance(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable set search_path = public
as $$
  select 2 * 6371000 * asin(least(1, sqrt(sin(radians(lat2 - lat1) / 2) ^ 2
    + cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2)))
$$;

-- The phone id, hashed. Null when the phone sent nothing usable.
create or replace function public._att_dev_hash(p text) returns text
language sql stable security definer set search_path = public, extensions
as $$
  select case when p ~ '^[A-Za-z0-9-]{16,64}$' then encode(extensions.digest('absen-hp.' || p, 'sha256'), 'hex') end
$$;

-- The 2-minute ticket a checked QR gives the phone for the button tap.
create or replace function public._att_tsig(p_staff uuid, h text, t bigint) returns text
language sql stable security definer set search_path = public, extensions
as $$
  select left(encode(extensions.hmac('absen-tiket.' || p_staff || '.' || coalesce(h, '') || '.' || t, (select token_secret from settings where id = 1), 'sha256'), 'hex'), 16)
$$;

-- ---------------------------------------------------------------- kasir tablet
-- The QR the tablet shows. Only the kasir tablet account may show it (Glenn, 13 Nov 2026):
-- personal staff, managers and the owner are refused, so nobody can show a QR on their own
-- phone and scan it from another. The tablet refreshes it after expires_in and shows the
-- change every `seconds`.
-- Two QRs on the till (Glenn, 12 Nov 2026): p_kind 'absen' (Masuk and Pulang, HSA1) or
-- 'istirahat' (Istirahat and Kembali, HSB1). The break QR signs the negative window, so
-- one kind can never pass as the other.
drop function if exists public.att_qr_token();
create or replace function public.att_qr_token(p_kind text default 'absen') returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], 'Masuk dengan akun kasir tablet untuk menampilkan QR presensi.');
  st settings := public._cfg();
  sec int := st.att_qr_seconds;
  win bigint := floor(extract(epoch from now()) / sec);
  brk boolean := p_kind = 'istirahat';
begin
  if not exists (select 1 from profiles where id = me and role = 'kasir' and deleted_at is null) then
    raise exception 'QR presensi hanya tampil di akun kasir tablet. Keluar, lalu masuk dengan akun kasir tablet dari pemilik.' using errcode = '42501';
  end if;
  if coalesce(p_kind, 'absen') not in ('absen', 'istirahat') then raise exception 'Jenis QR tidak dikenal.'; end if;
  return json_build_object('kind', coalesce(p_kind, 'absen'),
    'token', case when brk then 'HSB1.' || win || '.' || public._att_sig(-win) else 'HSA1.' || win || '.' || public._att_sig(win) end,
    'expires_in', sec - (floor(extract(epoch from now()))::bigint % sec), 'seconds', sec, 'server_time', now(),
    'location_set', st.att_lat is not null and st.att_lng is not null, 'radius_m', st.att_radius_m,
    'location_at', st.att_location_at);
end $$;

-- The booth location, saved by the owner or a manager from a device at the booth (Absen
-- harian; since 13 Nov 2026 the tablet is signed in as the kasir tablet account, which may
-- not move the location). Both null clears it.
-- att_location() tells that view whether a location is saved.
create or replace function public.att_location() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); st settings := public._cfg();
begin
  return json_build_object('location_set', st.att_lat is not null and st.att_lng is not null,
    'radius_m', st.att_radius_m, 'location_at', st.att_location_at);
end $$;

create or replace function public.att_set_location(p_lat double precision, p_lng double precision,
  p_radius int default null, p_acc double precision default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menyimpan lokasi booth.');
  r int := coalesce(p_radius, (select att_radius_m from settings where id = 1));
begin
  if (p_lat is null) <> (p_lng is null) then raise exception 'Lokasi tidak lengkap.'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then raise exception 'Lokasi tidak terbaca.'; end if;
  if r not between 50 and 2000 then raise exception 'Jarak presensi antara 50 dan 2.000 meter.'; end if;
  if p_acc is not null and p_acc > 500 then
    raise exception 'Lokasi tablet kurang akurat (± % m). Coba lagi di dekat jendela atau nyalakan Wi-Fi.', round(p_acc)::int;
  end if;
  update settings set att_lat = p_lat, att_lng = p_lng, att_radius_m = r,
    att_location_at = case when p_lat is null then null else now() end, att_location_by = me where id = 1;
  perform public._log(case when p_lat is null then 'hapus_lokasi_absen' else 'simpan_lokasi_absen' end,
    jsonb_build_object('lat', p_lat, 'lng', p_lng, 'radius_m', r, 'acc_m', round(p_acc)));
  return json_build_object('location_set', p_lat is not null, 'radius_m', r);
end $$;

-- The booth location comes from the till tablet's own GPS (Glenn, 14 Nov 2026: the booth is in
-- Papaya Fresh Gallery Bandung, Jl. Sukaasih No.1, Gegerkalong, Sukajadi). Each time the tablet
-- shows QR presensi or QR istirahat it sends its position; staff phones are checked against it.
-- Only the kasir tablet account; a reading worse than 200 m is ignored so a bad fix never moves it.
create or replace function public.att_tablet_location(p_lat double precision, p_lng double precision,
  p_acc double precision default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], 'Masuk dengan akun kasir tablet.');
  st settings := public._cfg(); moved double precision;
begin
  if not exists (select 1 from profiles where id = me and role = 'kasir' and deleted_at is null) then
    raise exception 'Lokasi booth hanya diambil dari tablet kasir.' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Lokasi tablet tidak terbaca.';
  end if;
  if p_acc is null or p_acc > 200 then
    return json_build_object('saved', false, 'acc_m', round(p_acc), 'location_set', st.att_lat is not null);
  end if;
  moved := case when st.att_lat is null then null else public._att_distance(st.att_lat, st.att_lng, p_lat, p_lng) end;
  update settings set att_lat = p_lat, att_lng = p_lng, att_location_at = now(), att_location_by = me where id = 1;
  -- Logged when first set or moved more than 50 m, not on every QR screen.
  if moved is null or moved > 50 then
    perform public._log('lokasi_booth_dari_tablet', jsonb_build_object('lat', p_lat, 'lng', p_lng, 'acc_m', round(p_acc), 'pindah_m', round(moved)));
  end if;
  return json_build_object('saved', true, 'acc_m', round(p_acc), 'location_set', true);
end $$;
grant execute on function public.att_tablet_location(double precision, double precision, double precision) to authenticated;

-- Reset a person's absen phone, so their next scan binds a new one. Manager or owner;
-- never your own.
create or replace function public.att_reset_device(p_staff uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa reset HP presensi.'); n int;
begin
  if p_staff = me then raise exception 'HP presensi Anda sendiri direset oleh pemilik atau manajer lain.'; end if;
  perform public._att_staff(p_staff);
  delete from att_devices where staff_id = p_staff;
  get diagnostics n = row_count;
  perform public._log('reset_hp_absen', jsonb_build_object('staff', p_staff, 'ada_hp', n > 0));
  return json_build_object('reset', n > 0);
end $$;

-- Who is clocked in right now (for the till's staff picker, task 5). No bank details.
-- status: 'kerja' or 'istirahat'.
create or replace function public.att_on_duty() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf.');
begin
  return coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'full_name', p.full_name,
      'role', p.role, 'status', case when e.action = 'istirahat' then 'istirahat' else 'kerja' end,
      'since', (select max(x.at) from att_events x where x.staff_id = p.id and x.voided_at is null and x.action = 'masuk' and x.at <= now())
    ) order by p.full_name)
    from profiles p cross join lateral (select * from public._att_last(p.id, now())) e
    where p.role in ('staff', 'manager') and p.deleted_at is null and e.id is not null and e.action <> 'pulang'), '[]');
end $$;

-- ---------------------------------------------------------------- staff phone
-- The signed-in staff member's own state: next actions, today's schedule and scans,
-- the coming 14 days, and their leave requests.
create or replace function public.att_status() returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._att_me('Halaman presensi untuk akun staf. Masuk dengan akun staf Anda sendiri.');
  p profiles := public._att_staff(me); today date := public._att_today(); last att_events := public._att_last(me, now());
  st settings := public._cfg();
begin
  return json_build_object(
    'name', public._first_name(p.full_name), 'full_name', p.full_name, 'role', p.role, 'today', today, 'server_time', now(),
    -- For the confirmation after a scan (14 Nov 2026): the same thresholds _att_day uses.
    'rules', json_build_object('late', st.att_late_minutes, 'out', st.att_out_minutes, 'overtime', st.att_overtime_after),
    'next', public._att_next(me, now()),
    'last', case when last.id is null then null else json_build_object('action', last.action, 'at', last.at) end,
    'today_scans', coalesce((select json_agg(json_build_object('action', e.action, 'at', e.at, 'via', e.via) order by e.at)
      from att_events e where e.staff_id = me and e.voided_at is null and public._local(e.at)::date = today), '[]'),
    'today_report', public._att_day_json(me, today, now()),
    'week', (select json_agg(json_build_object('date', d::date, 'leave', public._att_on_leave(me, d::date),
        'blocks', coalesce((select json_agg(json_build_object('kind', b.kind, 'start', to_char(b.start_time, 'HH24:MI'),
          'end', to_char(b.end_time, 'HH24:MI'), 'shift', b.shift, 'note', b.note, 'break_minutes', b.break_minutes)) from public._att_blocks(me, d::date) b), '[]'))
        order by d)
      from generate_series(today, today + 13, interval '1 day') d),
    'leave', coalesce((select json_agg(json_build_object('id', l.id, 'start', l.start_date, 'end', l.end_date, 'reason', l.reason,
        'status', l.status, 'note', l.decision_note, 'created_at', l.created_at) order by l.start_date desc)
      from att_leave l where l.staff_id = me and l.end_date >= today - 60), '[]'),
    'leave_from', today + 7,
    -- Every scan needs the phone's location (Glenn, 14 Nov 2026), set booth location or not.
    'location_required', true);
end $$;

-- The phone scans the tablet QR. With p_action null it only checks the QR, the phone and
-- the location, and returns what may be scanned next plus a 2-minute ticket for the tap
-- (so a 20-second QR does not run out while the person chooses). With an action it
-- records it at the server's time. p_device is the phone's random id (absen.html keeps
-- it); p_lat / p_lng / p_acc the phone's location, needed once the booth location is set.
drop function if exists public.att_scan(text, text);
create or replace function public.att_scan(p_token text, p_action text default null, p_device text default null,
  p_lat double precision default null, p_lng double precision default null, p_acc double precision default null,
  p_label text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._att_me('Halaman presensi untuk akun staf. Masuk dengan akun staf Anda sendiri.');
  p profiles := public._att_staff(me);
  st settings := public._cfg();
  sec int := st.att_qr_seconds;
  now_win bigint := floor(extract(epoch from now()) / sec);
  now_s bigint := floor(extract(epoch from now()));
  raw text := trim(coalesce(p_token, '')); parts text[]; win bigint; nx text[];
  label text; h text := public._att_dev_hash(p_device); dv att_devices; dist double precision; acc double precision;
  fl text[] := '{}'; first_bind boolean := false;
  brk boolean; allowed text[];
begin
  -- The QR holds a link to absen.html#t=HSA1...; a pasted token works too.
  -- HSA1 = attendance QR, HSB1 = break QR (12 Nov 2026); HST1 / HSU1 = their check-step tickets.
  if raw ~ '#t=' then raw := split_part(raw, '#t=', 2); end if;
  parts := string_to_array(raw, '.');
  if coalesce(array_length(parts, 1), 0) <> 3 or parts[1] not in ('HSA1', 'HSB1', 'HST1', 'HSU1') then raise exception 'Ini bukan QR presensi. Scan QR di tablet kasir.'; end if;
  begin win := parts[2]::bigint; exception when others then raise exception 'Ini bukan QR presensi. Scan QR di tablet kasir.'; end;
  brk := parts[1] in ('HSB1', 'HSU1');
  if parts[1] in ('HSA1', 'HSB1') then
    -- The current or previous window only, so a photo sent home stops working.
    if win < now_win - 1 or win > now_win then
      raise exception 'QR presensi sudah kedaluwarsa. Scan ulang QR yang tampil di tablet kasir sekarang.';
    end if;
    if lower(parts[3]) <> public._att_sig(case when brk then -win else win end) then raise exception 'QR presensi tidak valid.'; end if;
  else
    -- A ticket from the check step: this person, this phone, at most 2 minutes old.
    if lower(parts[3]) <> public._att_tsig(me, h, case when brk then -win else win end) then raise exception 'QR presensi tidak valid. Scan ulang QR di tablet kasir.'; end if;
    if now_s - win > 120 or win > now_s + 5 then
      raise exception 'QR presensi sudah kedaluwarsa. Scan ulang QR yang tampil di tablet kasir sekarang.';
    end if;
  end if;

  -- One phone per account.
  if h is null then raise exception 'HP ini belum bisa dikenali. Buka halaman presensi di browser HP Anda (bukan mode samaran), lalu scan ulang.'; end if;
  select * into dv from att_devices where staff_id = me;
  if dv.staff_id is not null and dv.device_hash <> h then
    raise exception 'HP ini belum terdaftar untuk presensi akun Anda. Minta manajer atau pemilik reset HP presensi.';
  end if;
  if exists (select 1 from att_devices where device_hash = h and staff_id <> me) then
    raise exception 'HP ini sudah dipakai presensi akun lain.';
  end if;

  -- Location (Glenn, 14 Nov 2026): every scan needs the phone's location, so staff must turn it on.
  -- The distance to the booth is checked once the booth location is set; until then the scan is
  -- kept with its location and flagged lokasi_booth_belum_diatur for the owner.
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Lokasi HP tidak terbaca. Presensi perlu lokasi untuk memastikan Anda ada di booth. Izinkan lokasi untuk browser ini (iPhone: Pengaturan > Privasi & Keamanan > Layanan Lokasi > Safari > Saat Menggunakan App; Android: ketuk ikon di samping alamat > Izin > Lokasi), nyalakan lokasi HP, lalu scan ulang.';
  end if;
  if st.att_lat is null or st.att_lng is null then
    fl := fl || 'lokasi_booth_belum_diatur'::text;
  else
    acc := greatest(coalesce(p_acc, 0), 0);
    dist := public._att_distance(st.att_lat, st.att_lng, p_lat, p_lng);
    if dist - acc > st.att_radius_m then
      raise exception 'Lokasi Anda terlalu jauh dari booth (± %). Presensi hanya bisa di booth.',
        case when dist >= 1000 then replace(to_char(dist / 1000, 'FM999990.0'), '.', ',') || ' km' else round(dist)::int || ' m' end;
    end if;
    if p_acc is null or acc > 300 then fl := fl || 'lokasi_kurang_akurat'::text; end if;
  end if;

  -- Each QR only offers its own actions.
  allowed := case when brk then array['istirahat', 'kembali'] else array['masuk', 'pulang'] end;
  nx := array(select a from unnest(public._att_next(me, now())) a where a = any (allowed));
  if coalesce(array_length(nx, 1), 0) = 0 then
    if brk and public._att_next(me, now()) = array['masuk'] then raise exception 'Anda belum masuk. Scan QR presensi dulu untuk masuk.'; end if;
    if not brk and public._att_next(me, now()) = array['kembali'] then raise exception 'Anda sedang istirahat. Scan QR istirahat dulu untuk kembali.'; end if;
    raise exception 'QR ini tidak bisa dipakai sekarang. Buka ulang halaman presensi.';
  end if;
  if p_action is null then
    return json_build_object('ok', true, 'next', nx, 'name', public._first_name(p.full_name), 'kind', case when brk then 'istirahat' else 'absen' end,
      'ticket', case when brk then 'HSU1.' || now_s || '.' || public._att_tsig(me, h, -now_s) else 'HST1.' || now_s || '.' || public._att_tsig(me, h, now_s) end,
      'flags', fl);
  end if;
  if not (p_action = any (nx)) then
    label := case p_action when 'masuk' then 'Masuk' when 'istirahat' then 'Istirahat' when 'kembali' then 'Kembali' when 'pulang' then 'Pulang' else p_action end;
    raise exception 'Tidak bisa scan % sekarang. Buka ulang halaman presensi.', label;
  end if;
  if dv.staff_id is null then
    insert into att_devices (staff_id, device_hash, label) values (me, h, nullif(left(trim(coalesce(p_label, '')), 60), ''));
    first_bind := true;
    perform public._log('hp_absen_terdaftar', jsonb_build_object('staff', me, 'label', nullif(left(trim(coalesce(p_label, '')), 60), '')));
  else
    update att_devices set last_seen_at = now(), label = coalesce(nullif(left(trim(coalesce(p_label, '')), 60), ''), att_devices.label) where staff_id = me;
  end if;
  insert into att_events (staff_id, action, via, created_by, device_hash, lat, lng, acc_m, distance_m, flags)
  values (me, p_action, 'qr', me, h, p_lat, p_lng, round(p_acc)::int, round(dist)::int, fl);
  perform public._log('absen_' || p_action, jsonb_build_object('staff', me, 'jarak_m', round(dist)::int, 'flags', fl));
  return json_build_object('ok', true, 'action', p_action, 'at', now(), 'next', public._att_next(me, now()),
    'phone_bound', first_bind, 'flags', fl);
end $$;

-- The signed-in staff member's schedule: the weekly Mon-Sun pattern, date-specific days
-- in the coming 14 days, and approved leave in those 14 days.
create or replace function public.att_my_schedule() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman presensi untuk akun staf. Masuk dengan akun staf Anda sendiri.');
  today date := public._att_today();
begin
  perform public._att_staff(me);
  return json_build_object('today', today, 'weekday', extract(isodow from today)::int,
    'weekly', coalesce((select json_agg(public._att_entry_json(s) order by s.weekday, s.start_time nulls first)
      from att_schedule s where s.staff_id = me and s.weekday is not null), '[]'),
    'dates', coalesce((select json_agg(json_build_object('date', d.on_date,
        'blocks', (select json_agg(public._att_entry_json(x) order by x.start_time nulls first) from att_schedule x
                   where x.staff_id = me and x.on_date = d.on_date)) order by d.on_date)
      from (select distinct s.on_date from att_schedule s where s.staff_id = me and s.on_date between today and today + 13) d), '[]'),
    'leave', coalesce((select json_agg(json_build_object('start', l.start_date, 'end', l.end_date, 'reason', l.reason) order by l.start_date)
      from att_leave l where l.staff_id = me and l.status = 'disetujui' and l.end_date >= today and l.start_date <= today + 13), '[]'));
end $$;

-- ---------------------------------------------------------------- profile
create or replace function public._att_is_owner(p uuid) returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from profiles where id = p and role = 'owner' and deleted_at is null) $$;

-- A manager never edits their own schedule or work target; the owner (or another manager) does.
create or replace function public._att_not_own(me uuid, p_staff uuid, msg text) returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_staff = me and not public._att_is_owner(me) then raise exception '%', msg using errcode = '42501'; end if;
end $$;

create or replace function public.att_my_profile() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman ini untuk akun staf.'); p profiles := public._att_staff(me); b att_profiles;
begin
  select * into b from att_profiles where staff_id = me;
  return json_build_object('full_name', p.full_name, 'whatsapp', p.whatsapp, 'username', p.username, 'role', p.role,
    'employer', p.employer, 'bank_name', b.bank_name, 'bank_account', b.bank_account, 'bank_holder', b.bank_holder, 'updated_at', b.updated_at,
    'locked', b.locked_at is not null,
    'request', (select json_build_object('id', r.id, 'changes', r.changes, 'reason', r.reason, 'status', r.status,
        'created_at', r.created_at, 'decided_at', r.decided_at, 'note', r.decision_note)
      from att_profile_requests r where r.staff_id = me and r.status <> 'dibatalkan'
        and (r.status = 'menunggu' or r.decided_at > now() - interval '14 days')
      order by r.created_at desc limit 1));
end $$;

-- p_staff null = your own profile, typed once; after that it is locked and changes go
-- through att_request_profile_change. Someone else's: the owner may type every field;
-- a manager may only fill in the name of a profile that is not saved yet, never bank
-- details (security review, 13 Nov 2026: a manager could redirect someone's pay).
-- The account number is never written to audit_log (it goes into the backup).
create or replace function public.att_save_profile(p_staff uuid, p_full_name text, p_bank_name text, p_bank_account text, p_bank_holder text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := auth.uid(); target uuid := coalesce(p_staff, auth.uid()); acct text := regexp_replace(coalesce(p_bank_account, ''), '[\s.-]', '', 'g');
  p profiles;
begin
  if target = me then perform public._att_me('Halaman ini untuk akun staf.');
  else perform public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengubah profil staf lain.'); end if;
  p := public._att_staff(target);
  if target <> me and not public._att_is_owner(me) then
    if exists (select 1 from att_profiles where staff_id = target and locked_at is not null) then
      raise exception 'Profil ini sudah tersimpan. Perubahan diajukan oleh stafnya lewat Minta perubahan.';
    end if;
    if coalesce(trim(p_bank_name), '') <> '' or acct <> '' or coalesce(trim(p_bank_holder), '') <> '' then
      raise exception 'Data rekening staf lain hanya bisa diisi oleh pemilik. Minta stafnya mengisi sendiri.';
    end if;
    if coalesce(trim(p_full_name), '') = '' then raise exception 'Isi nama lengkap.'; end if;
    if length(trim(p_full_name)) > 80 then raise exception 'Nama lengkap terlalu panjang.'; end if;
    update profiles set full_name = trim(p_full_name) where id = target;
    perform public._log('ubah_profil_staf', jsonb_build_object('staff', target, 'oleh_sendiri', false, 'rekening_diisi', false));
    return;
  end if;
  if target = me and exists (select 1 from att_profiles where staff_id = me and locked_at is not null) then
    raise exception 'Profil sudah tersimpan. Untuk mengubahnya, tekan Minta perubahan.';
  end if;
  if target = me and (coalesce(trim(p_bank_name), '') = '' or acct = '' or coalesce(trim(p_bank_holder), '') = '') then
    raise exception 'Isi semua data: nama lengkap, nama bank, nomor rekening dan nama pemilik rekening.';
  end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Isi nama lengkap.'; end if;
  if length(trim(p_full_name)) > 80 then raise exception 'Nama lengkap terlalu panjang.'; end if;
  if acct <> '' and acct !~ '^[0-9]{5,20}$' then raise exception 'Nomor rekening hanya angka, 5 sampai 20 digit.'; end if;
  if acct <> '' and (coalesce(trim(p_bank_name), '') = '' or coalesce(trim(p_bank_holder), '') = '') then
    raise exception 'Isi nama bank dan nama pemilik rekening.';
  end if;
  if length(coalesce(p_bank_name, '')) > 40 or length(coalesce(p_bank_holder, '')) > 80 then raise exception 'Isian terlalu panjang.'; end if;
  update profiles set full_name = trim(p_full_name) where id = target;
  insert into att_profiles (staff_id, bank_name, bank_account, bank_holder, updated_at, updated_by)
  values (target, nullif(trim(p_bank_name), ''), nullif(acct, ''), nullif(trim(p_bank_holder), ''), now(), me)
  on conflict (staff_id) do update set bank_name = excluded.bank_name, bank_account = excluded.bank_account,
    bank_holder = excluded.bank_holder, updated_at = now(), updated_by = me;
  update att_profiles set locked_at = coalesce(locked_at, now())
    where staff_id = target and bank_name is not null and bank_account is not null and bank_holder is not null;
  perform public._log('ubah_profil_staf', jsonb_build_object('staff', target, 'oleh_sendiri', target = me, 'rekening_diisi', acct <> ''));
end $$;

-- Staff with bank details, for managers and the owner only.
create or replace function public.att_staff_list() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'full_name', p.full_name,
      'role', p.role, 'whatsapp', p.whatsapp, 'employer', p.employer, 'bank_name', b.bank_name, 'bank_account', b.bank_account, 'bank_holder', b.bank_holder,
      'is_me', p.id = me, 'device_bound', dv.staff_id is not null, 'device_label', dv.label,
      'device_bound_at', dv.bound_at, 'device_last_seen_at', dv.last_seen_at)
      order by p.full_name)
    from profiles p left join att_profiles b on b.staff_id = p.id left join att_devices dv on dv.staff_id = p.id
    where p.role in ('staff', 'manager') and p.deleted_at is null), '[]');
end $$;

-- ---------------------------------------------------------------- leave
create or replace function public.att_request_leave(p_start date, p_end date, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman ini untuk akun staf.'); p profiles := public._att_staff(me);
  today date := public._att_today(); id bigint; e date := coalesce(p_end, p_start);
begin
  if p_start is null then raise exception 'Pilih tanggal izin.'; end if;
  if p_start < today + 7 then
    raise exception 'Izin paling lambat 7 hari sebelumnya (paling cepat %). Untuk izin mendadak, hubungi pemilik langsung.', to_char(today + 7, 'DD/MM/YYYY');
  end if;
  if e < p_start then raise exception 'Tanggal selesai harus sama atau setelah tanggal mulai.'; end if;
  if e > p_start + 30 then raise exception 'Izin paling lama 31 hari sekali minta.'; end if;
  if length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Tulis alasan izin.'; end if;
  if exists (select 1 from att_leave where staff_id = me and status in ('menunggu', 'disetujui') and start_date <= e and end_date >= p_start) then
    raise exception 'Sudah ada izin di tanggal itu.';
  end if;
  insert into att_leave (staff_id, start_date, end_date, reason, requested_by) values (me, p_start, e, left(trim(p_reason), 300), me)
  returning att_leave.id into id;
  perform public._log('minta_izin', jsonb_build_object('leave', id, 'start', p_start, 'end', e));
  return json_build_object('id', id, 'status', 'menunggu');
end $$;

create or replace function public.att_cancel_leave(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman ini untuk akun staf.'); l att_leave;
begin
  select * into l from att_leave where id = p_id and staff_id = me;
  if l.id is null then raise exception 'Izin tidak ditemukan.'; end if;
  if l.status <> 'menunggu' then raise exception 'Izin ini sudah diputuskan. Hubungi pemilik untuk mengubahnya.'; end if;
  update att_leave set status = 'dibatalkan', decided_at = now(), decided_by = me where id = l.id;
  perform public._log('batal_izin', jsonb_build_object('leave', l.id));
end $$;

create or replace function public.att_leave_list() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', l.id, 'staff_id', l.staff_id, 'name', public._first_name(p.full_name),
      'start', l.start_date, 'end', l.end_date, 'reason', l.reason, 'status', l.status, 'note', l.decision_note,
      'created_at', l.created_at, 'decided_by', public._first_name(d.full_name), 'is_me', l.staff_id = me)
      order by (l.status = 'menunggu') desc, l.start_date desc)
    from att_leave l left join profiles p on p.id = l.staff_id left join profiles d on d.id = l.decided_by
    where l.status = 'menunggu' or l.end_date >= public._att_today() - 60), '[]');
end $$;

create or replace function public.att_decide_leave(p_id bigint, p_approve boolean, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa memutuskan izin.'); l att_leave;
begin
  select * into l from att_leave where id = p_id;
  if l.id is null then raise exception 'Izin tidak ditemukan.'; end if;
  if l.staff_id = me then raise exception 'Izin Anda sendiri diputuskan oleh pemilik atau manajer lain.'; end if;
  if l.status <> 'menunggu' then raise exception 'Izin ini sudah diputuskan.'; end if;
  update att_leave set status = case when p_approve then 'disetujui' else 'ditolak' end, decided_by = me, decided_at = now(),
    decision_note = nullif(left(trim(coalesce(p_note, '')), 300), '') where id = l.id;
  perform public._log(case when p_approve then 'setujui_izin' else 'tolak_izin' end, jsonb_build_object('leave', l.id, 'staff', l.staff_id));
end $$;

-- Leave the owner or a manager records directly (sick, an emergency): any date, approved at once.
create or replace function public.att_add_leave(p_staff uuid, p_start date, p_end date, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); p profiles := public._att_staff(p_staff);
  e date := coalesce(p_end, p_start); id bigint;
begin
  if p_staff = me then raise exception 'Izin Anda sendiri dicatat oleh pemilik atau manajer lain.'; end if;
  if p_start is null or e < p_start then raise exception 'Periksa tanggal izin.'; end if;
  if e > p_start + 30 then raise exception 'Izin paling lama 31 hari sekali catat.'; end if;
  if length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Tulis alasan izin.'; end if;
  if exists (select 1 from att_leave where staff_id = p_staff and status in ('menunggu', 'disetujui') and start_date <= e and end_date >= p_start) then
    raise exception 'Sudah ada izin di tanggal itu.';
  end if;
  insert into att_leave (staff_id, start_date, end_date, reason, status, requested_by, decided_by, decided_at)
  values (p_staff, p_start, e, left(trim(p_reason), 300), 'disetujui', me, me, now()) returning att_leave.id into id;
  perform public._log('catat_izin', jsonb_build_object('leave', id, 'staff', p_staff, 'start', p_start, 'end', e));
  return json_build_object('id', id);
end $$;

-- ---------------------------------------------------------------- corrections
-- A forgotten or wrong scan is fixed by a manager or the owner with a reason. A manager
-- never corrects their own scans. Every correction is in audit_log.
create or replace function public._att_can_correct(me uuid, p_staff uuid) returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_staff = me then raise exception 'Presensi Anda sendiri dikoreksi oleh pemilik atau manajer lain.' using errcode = '42501'; end if;
end $$;

create or replace function public.att_correct_add(p_staff uuid, p_action text, p_at timestamptz, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengoreksi presensi.');
  p profiles; id bigint;
begin
  perform public._att_can_correct(me, p_staff);
  p := public._att_staff(p_staff);
  if p_action not in ('masuk', 'istirahat', 'kembali', 'pulang') then raise exception 'Jenis scan tidak dikenal.'; end if;
  if p_at is null or p_at > now() + interval '1 minute' then raise exception 'Jam koreksi tidak boleh di masa depan.'; end if;
  if p_at < now() - interval '62 days' then raise exception 'Koreksi hanya untuk 2 bulan terakhir.'; end if;
  if length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Tulis alasan koreksi.'; end if;
  insert into att_events (staff_id, action, at, via, reason, created_by)
  values (p_staff, p_action, p_at, 'koreksi', left(trim(p_reason), 300), me) returning att_events.id into id;
  perform public._log('koreksi_absen', jsonb_build_object('event', id, 'staff', p_staff, 'action', p_action, 'at', p_at, 'reason', trim(p_reason)));
  return json_build_object('id', id);
end $$;

create or replace function public.att_correct_void(p_event bigint, p_reason text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengoreksi presensi.'); e att_events;
begin
  select * into e from att_events where id = p_event;
  if e.id is null then raise exception 'Scan tidak ditemukan.'; end if;
  perform public._att_can_correct(me, e.staff_id);
  if e.voided_at is not null then raise exception 'Scan ini sudah dibatalkan.'; end if;
  if length(coalesce(trim(p_reason), '')) < 3 then raise exception 'Tulis alasan koreksi.'; end if;
  update att_events set voided_at = now(), voided_by = me, void_reason = left(trim(p_reason), 300) where id = e.id;
  perform public._log('koreksi_absen_batal', jsonb_build_object('event', e.id, 'staff', e.staff_id, 'action', e.action, 'at', e.at, 'reason', trim(p_reason)));
end $$;

-- One day for everyone (or one person): schedule report and every scan with its id, for
-- the corrections screen and the manager's view on the tablet.
create or replace function public.att_day_report(p_date date default null, p_staff uuid default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); d date := coalesce(p_date, public._att_today());
begin
  return json_build_object('date', d, 'people', coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name),
      'full_name', p.full_name, 'is_me', p.id = me, 'next', public._att_next(p.id, now()),
      'report', public._att_day_json(p.id, d, now()),
      'scans', coalesce((select json_agg(json_build_object('id', e.id, 'action', e.action, 'at', e.at, 'via', e.via, 'reason', e.reason,
          'voided', e.voided_at is not null, 'void_reason', e.void_reason,
          'distance_m', e.distance_m, 'acc_m', e.acc_m, 'flags', e.flags) order by e.at)
        from att_events e where e.staff_id = p.id and public._local(e.at)::date = d), '[]'))
      order by p.full_name)
    from profiles p where p.role in ('staff', 'manager') and p.deleted_at is null and (p_staff is null or p.id = p_staff)), '[]'));
end $$;

-- ---------------------------------------------------------------- overtime
-- Overtime candidates between two dates (default the last 14 days) with any decision.
create or replace function public.att_overtime_list(p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
  t date := coalesce(p_to, public._att_today()); f date := coalesce(p_from, coalesce(p_to, public._att_today()) - 13);
begin
  if t - f > 62 then raise exception 'Rentang paling lama 2 bulan.'; end if;
  return coalesce((select json_agg(json_build_object('staff_id', p.id, 'name', public._first_name(p.full_name), 'is_me', p.id = me,
      'date', x.work_date, 'start', to_char(x.block_start, 'HH24:MI'), 'end', to_char(x.block_end, 'HH24:MI'),
      'pulang', x.pulang, 'minutes', x.overtime_min, 'status', coalesce(o.status, 'menunggu'), 'approved_min', o.minutes,
      'note', o.note, 'decided_by', public._first_name(dp.full_name))
      order by x.work_date desc, p.full_name)
    from profiles p
    cross join generate_series(f, t, interval '1 day') g
    cross join lateral public._att_day(p.id, g::date, now()) x
    left join att_overtime o on o.staff_id = p.id and o.work_date = x.work_date and o.block_start = x.block_start
    left join profiles dp on dp.id = o.decided_by
    where p.role in ('staff', 'manager') and p.deleted_at is null and x.overtime_min > 0), '[]');
end $$;

-- Approve (all or fewer minutes) or decline one overtime candidate. Can be changed later.
create or replace function public.att_decide_overtime(p_staff uuid, p_date date, p_block_start text, p_approve boolean,
  p_minutes int default null, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menyetujui lembur.');
  x record; mins int; st settings := public._cfg();
begin
  if p_staff = me then raise exception 'Lembur Anda sendiri disetujui oleh pemilik atau manajer lain.'; end if;
  perform public._att_staff(p_staff);
  select * into x from public._att_day(p_staff, p_date, now()) d where d.block_start = p_block_start::time and d.overtime_min > 0;
  if x.work_date is null then raise exception 'Tidak ada lembur di jadwal itu.'; end if;
  mins := case when p_approve then least(greatest(coalesce(p_minutes, x.overtime_min), 0), x.overtime_min) else 0 end;
  insert into att_overtime (staff_id, work_date, block_start, scheduled_end, clock_out, minutes, status, note, decided_by, decided_at)
  values (p_staff, p_date, x.block_start, (p_date + x.block_end) at time zone st.tz, x.pulang, mins,
    case when p_approve then 'disetujui' else 'ditolak' end, nullif(left(trim(coalesce(p_note, '')), 300), ''), me, now())
  on conflict (staff_id, work_date, block_start) do update set minutes = excluded.minutes, status = excluded.status,
    clock_out = excluded.clock_out, note = excluded.note, decided_by = me, decided_at = now();
  perform public._log(case when p_approve then 'setujui_lembur' else 'tolak_lembur' end,
    jsonb_build_object('staff', p_staff, 'date', p_date, 'start', p_block_start, 'minutes', mins));
  return json_build_object('minutes', mins);
end $$;

-- ---------------------------------------------------------------- shifts and schedule
create or replace function public.att_setup() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return json_build_object(
    'staff', coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'full_name', p.full_name, 'role', p.role)
        order by p.full_name) from profiles p where p.role in ('staff', 'manager') and p.deleted_at is null), '[]'),
    'shifts', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'start', to_char(s.start_time, 'HH24:MI'),
        'end', to_char(s.end_time, 'HH24:MI'), 'break_minutes', s.break_minutes, 'active', s.active) order by s.sort, s.id) from att_shifts s), '[]'),
    'opening', json_build_object('open', '08:00', 'close', '21:00'),
    'weekly', coalesce((select json_agg(public._att_entry_json(s) order by s.staff_id, s.weekday, s.start_time nulls first)
        from att_schedule s join profiles p on p.id = s.staff_id and p.deleted_at is null where s.weekday is not null), '[]'),
    'dates', coalesce((select json_agg(public._att_entry_json(s) order by s.on_date, s.staff_id, s.start_time nulls first)
        from att_schedule s join profiles p on p.id = s.staff_id and p.deleted_at is null
        where s.on_date >= public._att_today() - 31), '[]'),
    'today', public._att_today());
end $$;

create or replace function public.att_save_shift(p_id int, p_name text, p_start text, p_end text, p_break int, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); s time; e time;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Isi nama shift.'; end if;
  if lower(trim(p_name)) in ('libur', 'custom') then raise exception 'Nama "%" sudah dipakai di template. Pilih nama lain.', trim(p_name); end if;
  begin s := p_start::time; e := p_end::time; exception when others then raise exception 'Jam tidak terbaca. Contoh: 08:00.'; end;
  if e <= s then raise exception 'Jam selesai harus setelah jam mulai.'; end if;
  if coalesce(p_break, 0) not between 0 and 240 then raise exception 'Istirahat 0 sampai 240 menit.'; end if;
  if exists (select 1 from att_shifts where lower(name) = lower(trim(p_name)) and id is distinct from p_id) then
    raise exception 'Nama shift sudah ada.';
  end if;
  if p_id is null then
    insert into att_shifts (name, start_time, end_time, break_minutes, sort, active)
    values (trim(p_name), s, e, coalesce(p_break, 60), coalesce((select max(sort) + 1 from att_shifts), 1), coalesce(p_active, true));
  else
    update att_shifts set name = trim(p_name), start_time = s, end_time = e, break_minutes = coalesce(p_break, 60),
      active = coalesce(p_active, true) where id = p_id;
    if not found then raise exception 'Shift tidak ditemukan.'; end if;
  end if;
  perform public._log('ubah_shift', jsonb_build_object('id', p_id, 'name', trim(p_name), 'start', p_start, 'end', p_end, 'break', p_break, 'active', p_active));
end $$;

-- Saves an uploaded schedule in one go, from the parser's entries:
--   [{name | staff_id, weekday 1..7 | date 'YYYY-MM-DD', kind, start, end, shift, note}]
-- For every person in the upload, their weekly pattern is replaced by the weekly rows in
-- it (if it has any), and each date in it replaces that person's rows on that date.
-- People not in the upload keep their schedule. Any error saves nothing.
create or replace function public.att_replace_schedule(p_entries jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengubah jadwal.');
  e jsonb; n int := 0; sid uuid; wd int; dt date; rows att_schedule[] := '{}'; r att_schedule;
  weekly uuid[] := '{}'; dated text[] := '{}'; k record;
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then raise exception 'Jadwal kosong. Tidak ada yang disimpan.'; end if;
  if jsonb_array_length(p_entries) > 2000 then raise exception 'Jadwal terlalu banyak baris.'; end if;
  for e in select * from jsonb_array_elements(p_entries) loop
    n := n + 1;
    sid := public._att_resolve(e, n);
    wd := null; dt := null;
    if coalesce(e->>'date', '') <> '' then
      begin dt := (e->>'date')::date; exception when others then raise exception 'Baris %: tanggal tidak terbaca.', n; end;
      if coalesce(e->>'weekday', '') <> '' then raise exception 'Baris %: isi hari atau tanggal, jangan dua-duanya.', n; end if;
      dated := dated || (sid::text || '|' || dt::text);
    else
      begin wd := (e->>'weekday')::int; exception when others then wd := null; end;
      if wd is null or wd not between 1 and 7 then raise exception 'Baris %: hari tidak dikenal.', n; end if;
      weekly := weekly || sid;
    end if;
    perform public._att_not_own(me, sid, format('Baris %s: jadwal Anda sendiri diubah oleh pemilik atau manajer lain.', n));
    rows := rows || public._att_entry(e, n, sid, wd, dt, me);
  end loop;
  delete from att_schedule where weekday is not null and staff_id = any (weekly);
  delete from att_schedule where on_date is not null and (staff_id::text || '|' || on_date::text) = any (dated);
  foreach r in array rows loop
    insert into att_schedule (staff_id, weekday, on_date, kind, start_time, end_time, shift, note, created_by)
    values (r.staff_id, r.weekday, r.on_date, r.kind, r.start_time, r.end_time, r.shift, r.note, me);
  end loop;
  for k in select distinct x.staff_id, x.weekday, x.on_date from unnest(rows) x loop
    perform public._att_check_day(k.staff_id, k.weekday, k.on_date);
  end loop;
  perform public._log('unggah_jadwal', jsonb_build_object('rows', n, 'staff', (select count(distinct x) from unnest(weekly || '{}'::uuid[]) x),
    'tanggal', coalesce(array_length(dated, 1), 0)));
  return json_build_object('saved', n);
end $$;

-- Edits one person's day by hand: the weekly day (p_weekday) or one date (p_date).
-- p_blocks [] clears it (for a date: back to the weekly pattern).
create or replace function public.att_set_day(p_staff uuid, p_weekday int, p_date date, p_blocks jsonb) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengubah jadwal.');
  e jsonb; n int := 0; r att_schedule;
begin
  perform public._att_not_own(me, p_staff, 'Jadwal Anda sendiri diubah oleh pemilik atau manajer lain.');
  perform public._att_staff(p_staff);
  if (p_weekday is null) = (p_date is null) then raise exception 'Pilih hari atau tanggal.'; end if;
  if p_weekday is not null and p_weekday not between 1 and 7 then raise exception 'Hari tidak dikenal.'; end if;
  delete from att_schedule where staff_id = p_staff and weekday is not distinct from p_weekday::smallint and on_date is not distinct from p_date;
  for e in select * from jsonb_array_elements(coalesce(p_blocks, '[]')) loop
    n := n + 1;
    r := public._att_entry(e, n, p_staff, p_weekday, p_date, me);
    insert into att_schedule (staff_id, weekday, on_date, kind, start_time, end_time, shift, note, created_by)
    values (r.staff_id, r.weekday, r.on_date, r.kind, r.start_time, r.end_time, r.shift, r.note, me);
  end loop;
  perform public._att_check_day(p_staff, p_weekday, p_date);
  perform public._log('ubah_jadwal', jsonb_build_object('staff', p_staff, 'weekday', p_weekday, 'date', p_date, 'blocks', n));
end $$;

-- ---------------------------------------------------------------- monthly recap
-- Per person for one month (p_month = any day in it), with each day's detail and the
-- bank details for payroll. Managers and the owner only. Times only, no pay.
-- Recap for any period (Glenn, 11 Nov: monthly, weekly or custom), optionally one staff member.
-- m0 / m1 are the first and last day, both inclusive.
create or replace function public.att_recap_range(p_from date, p_to date, p_staff uuid default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
  m0 date := p_from; m1 date := p_to;
begin
  if m0 is null or m1 is null then raise exception 'Pilih tanggal awal dan akhir.'; end if;
  if m1 < m0 then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  if m1 - m0 > 366 then raise exception 'Rentang paling lama 1 tahun.'; end if;
  return (
  with dd as (
    select sp.id as sid, x.* from profiles sp
    cross join generate_series(m0, m1, interval '1 day') g
    cross join lateral public._att_day(sp.id, g::date, now()) x
    where sp.role in ('staff', 'manager') and sp.deleted_at is null and (p_staff is null or sp.id = p_staff)
  )
  select json_build_object('month', to_char(m0, 'YYYY-MM'), 'from', m0, 'to', m1, 'days_in_range', m1 - m0 + 1, 'people', coalesce((
    select json_agg(x order by x.full_name) from (
      select p.id, public._first_name(p.full_name) as name, p.full_name, p.whatsapp, p.role,
        b.bank_name, b.bank_account, b.bank_holder,
        (select count(distinct d.work_date) from dd d where d.sid = p.id and d.masuk is not null) as days_worked,
        (select coalesce(sum(d.worked_min), 0) from dd d where d.sid = p.id) as worked_min,
        -- Daily working-time target (Glenn, 12 Nov 2026): 9 hours unless set per person (Kevin 5).
        coalesce(p.work_target_min, 540) as work_target_min,
        (select count(distinct d.work_date) from dd d where d.sid = p.id and d.masuk is not null) * coalesce(p.work_target_min, 540) as target_total_min,
        (select coalesce(sum(greatest(coalesce(p.work_target_min, 540) - t.w, 0)), 0) from (
            select sum(d.worked_min) as w from dd d where d.sid = p.id and d.masuk is not null group by d.work_date) t) as short_min,
        (select count(*) from dd d where d.sid = p.id and 'terlambat' = any (d.flags)) as late_count,
        (select coalesce(sum(d.late_min), 0) from dd d where d.sid = p.id) as late_min,
        (select coalesce(sum(d.break_min), 0) from dd d where d.sid = p.id) as break_min,
        (select count(*) from dd d where d.sid = p.id and 'istirahat_lebih' = any (d.flags)) as break_over_count,
        (select coalesce(sum(d.early_min), 0) from dd d where d.sid = p.id) as early_min,
        (select coalesce(sum(d.overtime_min), 0) from dd d where d.sid = p.id) as overtime_candidate_min,
        (select coalesce(sum(o.minutes), 0) from att_overtime o where o.staff_id = p.id and o.status = 'disetujui' and o.work_date between m0 and m1) as overtime_approved_min,
        (select count(*) from generate_series(m0, m1, interval '1 day') g where public._att_on_leave(p.id, g::date)) as leave_days,
        (select count(*) from dd d where d.sid = p.id and 'tidak_hadir' = any (d.flags)) as absent_count,
        (select count(*) from dd d where d.sid = p.id and (d.flags && array['tidak_scan_pulang', 'tidak_scan_kembali'])) as missing_scans,
        (select coalesce(json_agg(json_build_object('date', d.work_date, 'kind', d.kind, 'start', to_char(d.block_start, 'HH24:MI'),
            'end', to_char(d.block_end, 'HH24:MI'), 'shift', d.shift, 'masuk', d.masuk, 'pulang', d.pulang, 'worked_min', d.worked_min,
            'break_min', d.break_min, 'late_min', d.late_min, 'early_min', d.early_min, 'overtime_min', d.overtime_min, 'flags', d.flags)
            order by d.work_date, d.block_start nulls last), '[]') from dd d where d.sid = p.id) as days,
        (select coalesce(json_agg(json_build_object('id', l.id, 'start', l.start_date, 'end', l.end_date, 'reason', l.reason,
            'status', l.status, 'note', l.decision_note, 'created_at', l.created_at) order by l.start_date), '[]')
          from att_leave l where l.staff_id = p.id and l.start_date <= m1 and l.end_date >= m0) as leaves
      from profiles p left join att_profiles b on b.staff_id = p.id
      where p.role in ('staff', 'manager') and p.deleted_at is null and (p_staff is null or p.id = p_staff)
    ) x), '[]')));
end $$;

-- Monthly recap, kept for older callers: the whole month around p_month.
create or replace function public.att_recap(p_month date default null) returns json
language sql stable security definer set search_path = public
as $$
  select public.att_recap_range(date_trunc('month', coalesce(p_month, public._att_today()))::date,
    (date_trunc('month', coalesce(p_month, public._att_today())) + interval '1 month' - interval '1 day')::date, null);
$$;

-- One week (Mon..Sun around p_start) for the owner's Jadwal overview and the per-staff
-- view: each person's blocks per day, date-specific rows applied, approved leave marked.
create or replace function public.att_week(p_start date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
  w0 date := coalesce(p_start, public._att_today());
begin
  w0 := w0 - (extract(isodow from w0)::int - 1);
  return json_build_object('start', w0, 'end', w0 + 6, 'today', public._att_today(), 'people', coalesce((
    select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'full_name', p.full_name, 'role', p.role,
      'days', (select json_agg(json_build_object('date', g.d, 'leave', public._att_on_leave(p.id, g.d),
          'one_off', exists (select 1 from att_schedule s where s.staff_id = p.id and s.on_date = g.d),
          'blocks', coalesce((select json_agg(json_build_object('kind', b.kind, 'start', to_char(b.start_time, 'HH24:MI'),
              'end', to_char(b.end_time, 'HH24:MI'), 'shift', b.shift, 'note', b.note) order by b.start_time nulls first)
            from public._att_blocks(p.id, g.d) b), '[]')) order by g.d)
        from (select w0 + i as d from generate_series(0, 6) i) g)) order by p.full_name)
    from profiles p where p.role in ('staff', 'manager') and p.deleted_at is null), '[]'));
end $$;

-- ---------------------------------------------------------------- my schedule, day by day
-- The days as they really are (weekly pattern with the owner's or manager's one-off changes
-- and approved leave), for Jadwal saya: this week, 14 days and 1 month (Glenn, 12 Nov 2026).
create or replace function public.att_my_days(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman presensi untuk akun staf. Masuk dengan akun staf Anda sendiri.');
  today date := public._att_today();
begin
  perform public._att_staff(me);
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Rentang tanggal tidak valid.'; end if;
  if p_from < today - 7 or p_to > today + 62 then raise exception 'Jadwal hanya bisa dilihat sampai 2 bulan ke depan.'; end if;
  return json_build_object('today', today,
    'days', (select json_agg(json_build_object('date', d::date, 'leave', public._att_on_leave(me, d::date),
        'blocks', coalesce((select json_agg(json_build_object('kind', b.kind, 'start', to_char(b.start_time, 'HH24:MI'),
          'end', to_char(b.end_time, 'HH24:MI'), 'shift', b.shift, 'note', b.note, 'changed', b.one_off)) from public._att_blocks(me, d::date) b), '[]'))
        order by d)
      from generate_series(p_from, p_to, interval '1 day') d));
end $$;

-- ---------------------------------------------------------------- profile change requests
-- Allowed fields: full_name, bank_name, bank_account, bank_holder. Values are checked here and
-- again when approved.
create or replace function public._att_check_changes(c jsonb) returns jsonb
language plpgsql immutable security definer set search_path = public
as $$
declare k text; out jsonb := '{}'; v text;
begin
  if c is null or jsonb_typeof(c) <> 'object' or c = '{}'::jsonb then raise exception 'Pilih data yang mau diubah.'; end if;
  for k in select jsonb_object_keys(c) loop
    if k not in ('full_name', 'bank_name', 'bank_account', 'bank_holder') then raise exception 'Data ini tidak bisa diubah lewat permintaan.'; end if;
    v := trim(coalesce(c ->> k, ''));
    if v = '' then raise exception 'Isi data baru untuk setiap pilihan.'; end if;
    if k = 'bank_account' then
      v := regexp_replace(v, '[\s.-]', '', 'g');
      if v !~ '^[0-9]{5,20}$' then raise exception 'Nomor rekening hanya angka, 5 sampai 20 digit.'; end if;
    end if;
    if length(v) > 80 or (k = 'bank_name' and length(v) > 40) then raise exception 'Isian terlalu panjang.'; end if;
    out := out || jsonb_build_object(k, v);
  end loop;
  return out;
end $$;

create or replace function public.att_request_profile_change(p_changes jsonb, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman ini untuk akun staf.'); c jsonb; r att_profile_requests;
begin
  perform public._att_staff(me);
  if not exists (select 1 from att_profiles where staff_id = me and locked_at is not null) then
    raise exception 'Profil belum tersimpan. Isi dan simpan profil dulu.';
  end if;
  if exists (select 1 from att_profile_requests where staff_id = me and status = 'menunggu') then
    raise exception 'Masih ada permintaan yang menunggu. Batalkan dulu kalau mau mengganti isinya.';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Isi alasan perubahan.'; end if;
  if length(p_reason) > 300 then raise exception 'Alasan terlalu panjang.'; end if;
  c := public._att_check_changes(p_changes);
  begin
    insert into att_profile_requests (staff_id, changes, reason) values (me, c, trim(p_reason)) returning * into r;
  exception when unique_violation then -- two sends at the same moment (two tabs): the index keeps one open request
    raise exception 'Masih ada permintaan yang menunggu. Batalkan dulu kalau mau mengganti isinya.';
  end;
  perform public._log('minta_ubah_profil', jsonb_build_object('id', r.id, 'data', (select jsonb_agg(k) from jsonb_object_keys(c) k)));
  return json_build_object('id', r.id);
end $$;

create or replace function public.att_cancel_profile_request(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman ini untuk akun staf.');
begin
  update att_profile_requests set status = 'dibatalkan', decided_at = now(), decided_by = me
    where id = p_id and staff_id = me and status = 'menunggu';
  if not found then raise exception 'Permintaan tidak ditemukan atau sudah diputuskan.'; end if;
  perform public._log('batal_ubah_profil', jsonb_build_object('id', p_id));
end $$;

-- Waiting requests (and the last 30 days) with the current values, for a manager or the owner.
create or replace function public.att_profile_requests() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', r.id, 'staff_id', r.staff_id, 'name', public._first_name(p.full_name),
      'changes', r.changes, 'reason', r.reason, 'status', r.status, 'created_at', r.created_at, 'decided_at', r.decided_at,
      'note', r.decision_note, 'decided_by', public._first_name(d.full_name),
      'current', json_build_object('full_name', p.full_name, 'bank_name', b.bank_name, 'bank_account', b.bank_account, 'bank_holder', b.bank_holder))
      order by (r.status = 'menunggu') desc, r.created_at desc)
    from att_profile_requests r join profiles p on p.id = r.staff_id
      left join att_profiles b on b.staff_id = r.staff_id left join profiles d on d.id = r.decided_by
    where r.status = 'menunggu' or (r.status in ('disetujui', 'ditolak') and r.decided_at > now() - interval '30 days')), '[]');
end $$;

-- Approve applies the changes; a manager can't decide their own request.
create or replace function public.att_decide_profile_request(p_id bigint, p_approve boolean, p_note text default null) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); r att_profile_requests; c jsonb;
begin
  select * into r from att_profile_requests where id = p_id for update;
  if r.id is null or r.status <> 'menunggu' then raise exception 'Permintaan tidak ditemukan atau sudah diputuskan.'; end if;
  if r.staff_id = me then raise exception 'Permintaan Anda sendiri diputuskan oleh pemilik.'; end if;
  if p_approve is null then raise exception 'Pilih setujui atau tolak.'; end if;
  if not p_approve and coalesce(trim(p_note), '') = '' then raise exception 'Tulis alasan penolakan.'; end if;
  if p_approve then
    c := public._att_check_changes(r.changes);
    if c ? 'full_name' then update profiles set full_name = c ->> 'full_name' where id = r.staff_id; end if;
    insert into att_profiles (staff_id, updated_at, updated_by, locked_at) values (r.staff_id, now(), me, now())
    on conflict (staff_id) do nothing;
    update att_profiles set
      bank_name = coalesce(c ->> 'bank_name', bank_name), bank_account = coalesce(c ->> 'bank_account', bank_account),
      bank_holder = coalesce(c ->> 'bank_holder', bank_holder), updated_at = now(), updated_by = me
      where staff_id = r.staff_id;
  end if;
  update att_profile_requests set status = case when p_approve then 'disetujui' else 'ditolak' end,
    decided_at = now(), decided_by = me, decision_note = nullif(trim(coalesce(p_note, '')), '') where id = p_id;
  perform public._log(case when p_approve then 'setujui_ubah_profil' else 'tolak_ubah_profil' end,
    jsonb_build_object('id', p_id, 'staff', r.staff_id));
end $$;

-- ---------------------------------------------------------------- permissions
-- Only this file's functions: helpers (_att_*) are revoked, the rest granted.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and (p.proname like 'att\_%' or p.proname like '\_att\_%')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
