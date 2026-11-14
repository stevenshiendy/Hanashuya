-- Hanashuya Member Card: tables, rules and functions for Supabase.
-- Run the whole file once in Supabase > SQL Editor. Re-running is safe:
-- tables are only created when missing and functions are replaced.
--
-- Every write goes through a function below. The tables allow members to read
-- only their own rows, and nobody can insert, update or delete them directly,
-- so the stamping rules cannot be skipped from the browser.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- settings
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  open_time time not null default '09:00',
  close_time time not null default '22:00',
  rupiah_per_stamp int not null default 50000 check (rupiah_per_stamp > 0),
  card_size int not null default 10 check (card_size between 1 and 50),
  max_stamps_per_day int not null default 6 check (max_stamps_per_day > 0),
  late_minutes int not null default 15 check (late_minutes > 0),
  tz text not null default 'Asia/Jakarta',
  token_secret text not null default encode(extensions.gen_random_bytes(32), 'hex')
);
insert into public.settings (id) values (1) on conflict do nothing;
-- Logins are <whatsapp number>@auth_domain. Keep it equal to AUTH_EMAIL_DOMAIN in js/config.js.
alter table public.settings add column if not exists auth_domain text not null default 'member.hanashuya.id';
-- Current versions of syarat-ketentuan.html and kebijakan-privasi.html. Change these
-- when you publish a new version, so new acceptances are recorded against it.
alter table public.settings add column if not exists terms_version text not null default '2026-11-06';
alter table public.settings add column if not exists privacy_version text not null default '2026-11-06';
-- Version of 6 November 2026 (standard layout, kasir redeems, card cycles, VireoPOS
-- import, backups). Moving forward only, so re-running never undoes a later version.
update public.settings set terms_version = '2026-11-06' where id = 1 and terms_version < '2026-11-06';
-- Terms of 7 November 2026: no daily stamp cap, 50% new-member voucher for 30 days,
-- birthday voucher shown in the app, birth date fixed once set. Members accept it once
-- the next time they open their card. The privacy policy did not change.
update public.settings set terms_version = '2026-11-07' where id = 1 and terms_version < '2026-11-07';
update public.settings set privacy_version = '2026-11-06' where id = 1 and privacy_version < '2026-11-06';

-- Rewards printed on the card: slot 3, slot 7 and slot 10.
create table if not exists public.rewards (
  slot int primary key check (slot > 0),
  label text not null
);
insert into public.rewards (slot, label) values
  (3, 'Diskon 10%'), (7, 'Diskon 20%'), (10, 'Gratis 1 produk')
on conflict do nothing;

create table if not exists public.menu_items (
  id serial primary key,
  name text not null unique,
  price int not null check (price >= 0),
  sort int not null default 0,
  active boolean not null default true
);
insert into public.menu_items (name, price, sort) values
  ('Signature 1 pc', 20000, 1),
  ('Signature box isi 6', 120000, 2),
  ('Mini choux box isi 8', 68000, 3),
  ('Mini choux box isi 15', 99000, 4)
on conflict do nothing;
-- The first seed had Mini choux box isi 15 at Rp120.000; the printed menu says Rp99.000.
update public.menu_items set price = 99000 where name = 'Mini choux box isi 15' and price = 120000;

-- ---------------------------------------------------------------- people
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'staff', 'owner')),
  email text,
  full_name text,
  whatsapp text,
  gender text check (gender in ('perempuan', 'laki-laki', 'tidak_disebut')),
  age_range text check (age_range in ('17-24', '25-34', '35-44', '45+', 'tidak_disebut')),
  adult_confirmed boolean not null default false,
  card_code text not null unique,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Empty until WhatsApp verification is switched on later.
alter table public.profiles add column if not exists whatsapp_verified_at timestamptz;
create unique index if not exists profiles_whatsapp_once on public.profiles (whatsapp) where deleted_at is null;
-- Manager (11 Nov 2026): between staff and owner. Works the till like staff, and may
-- approve voids, refunds and undo requests, change goods-in entries, approve leave and
-- overtime, correct attendance and see staff bank accounts. Only the owner adds or removes
-- accounts, changes settings and prices, and downloads the backup.
alter table public.profiles drop constraint if exists profiles_role_check;
-- Kasir tablet (Glenn, 13 Nov 2026): the till device's own login. It is not a person: it
-- sells (passes every staff check in _require, and each order still names the staff who
-- served), shows the attendance QR (att_qr_token accepts only this role) and signs up
-- members, but has no WhatsApp number, schedule or HR profile, can't clock in, decide
-- approvals or open the owner page, and is left out of every staff list (those name the
-- roles 'staff' and 'manager'). whoami() reports it as role 'staff' with kasir_tablet = true,
-- so the pages' staff gates need no change. Made from the owner's Staf view (owner_add_kasir).
alter table public.profiles add constraint profiles_role_check check (role in ('member', 'staff', 'manager', 'owner', 'kasir'));
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists birth_date date;
-- When the birth date was first saved (14 Nov 2026). The birthday voucher needs it set 30+
-- days before the birthday, so nobody can leave it empty and later pick today's date.
-- Older rows count from sign-up.
alter table public.profiles add column if not exists birth_date_set_at timestamptz;
update public.profiles set birth_date_set_at = created_at where birth_date is not null and birth_date_set_at is null;
create unique index if not exists profiles_username_once on public.profiles (username) where deleted_at is null;
-- A card made by the cashier starts with the password 12345; the
-- member must choose their own password on first sign-in (set_first_password).
alter table public.profiles add column if not exists must_set_password boolean not null default false;
-- Who a staff member works for at the shared booth (Glenn, 13 Nov 2026): Hanashuya or
-- Kaaramel Juice. Set by the owner (owner_add_staff); shown on the staff page and Per staf.
alter table public.profiles add column if not exists employer text;
-- WhatsApp promos only go to members who ticked the separate promo box.
alter table public.profiles add column if not exists marketing_opt_in boolean not null default false;

-- One welcome voucher per WhatsApp number (security review, 13 Nov 2026). Numbers are not
-- verified, so deleting the account and signing up again would give a new 50% voucher.
-- When a member deletes their account, only a keyed hash of the number is kept here
-- (HMAC-SHA256 with settings.wa_pepper, never the number itself, UU PDP); a new account
-- with that number starts with welcome_voucher = false, so _vouchers lists no welcome.
alter table public.settings add column if not exists wa_pepper text not null default encode(extensions.gen_random_bytes(32), 'hex');
alter table public.profiles add column if not exists welcome_voucher boolean not null default true;
create table if not exists public.welcome_given (
  wa_hash text primary key,
  created_at timestamptz not null default now()
);
alter table public.welcome_given enable row level security;

-- Which version of the terms and privacy policy each member accepted, and every
-- promo opt-in or opt-out, with time and where it happened. Rows are only ever
-- added. user_id has no foreign key on purpose, so the record outlives a deleted
-- account (it then holds only an id, no name or number).
create table if not exists public.consent_log (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  document text not null check (document in ('syarat', 'privasi', 'promo_whatsapp')),
  version text not null,
  accepted boolean not null,
  method text not null,
  created_at timestamptz not null default now()
);
alter table public.consent_log enable row level security;
create index if not exists consent_log_user on public.consent_log (user_id, created_at);
create or replace function public._consent_log_append_only() returns trigger
language plpgsql as $$ begin raise exception 'Catatan persetujuan tidak bisa diubah atau dihapus.'; end $$;
drop trigger if exists consent_log_append_only on public.consent_log;
create trigger consent_log_append_only before update or delete on public.consent_log
  for each row execute function public._consent_log_append_only();

-- ---------------------------------------------------------------- activity
create table if not exists public.sales (
  id bigint generated always as identity primary key,
  receipt_no text,
  receipt_key text generated always as (upper(regexp_replace(receipt_no, '[^A-Za-z0-9]', '', 'g'))) stored,
  total int not null check (total > 0),
  member_id uuid references public.profiles (id) on delete set null,
  staff_id uuid references public.profiles (id) on delete set null,
  stamps int not null default 0 check (stamps >= 0),
  items jsonb not null default '[]',
  gender text check (gender in ('perempuan', 'laki-laki', 'tidak_disebut')),
  age_range text check (age_range in ('<17', '17-24', '25-34', '35-44', '45+', 'tidak_disebut')),
  via text check (via in ('qr', 'kode', 'nomor', 'daftar')),
  flags text[] not null default '{}',
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references public.profiles (id) on delete set null
);
create index if not exists sales_member_idx on public.sales (member_id, created_at);
create index if not exists sales_created_idx on public.sales (created_at);
-- Cashiers no longer type the VireoPOS number: each stamp is matched to an imported
-- VireoPOS receipt by day, total, time and customer name (_match_stamps). receipt_no
-- stays for sales recorded with one; it is unique per day when present.
alter table public.sales alter column receipt_no drop not null;
alter table public.sales add column if not exists sale_day date;
update public.sales set sale_day = (created_at at time zone 'Asia/Jakarta')::date where sale_day is null;
alter table public.sales alter column sale_day set default ((now() at time zone 'Asia/Jakarta')::date);
alter table public.sales alter column sale_day set not null;
alter table public.sales drop constraint if exists sales_receipt_key_key;
create unique index if not exists sales_receipt_day_once on public.sales (receipt_key, sale_day);

create table if not exists public.redemptions (
  id bigint generated always as identity primary key,
  member_id uuid references public.profiles (id) on delete set null,
  staff_id uuid references public.profiles (id) on delete set null,
  cycle int not null,
  slot int not null,
  reward_label text not null,
  created_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references public.profiles (id) on delete set null
);
-- kind: 'stempel' for the card rewards (slot 3, 7, 10), 'welcome' for the new-member
-- voucher (cycle 0, slot 0) and 'ulang_tahun' for the birthday voucher (cycle = the
-- year of that birthday, slot 0). Vouchers share this table so undo, Hari ini, the
-- dashboard and backups treat them like any other used reward.
alter table public.redemptions add column if not exists kind text not null default 'stempel';
alter table public.redemptions drop constraint if exists redemptions_kind_check;
alter table public.redemptions add constraint redemptions_kind_check check (kind in ('stempel', 'welcome', 'ulang_tahun', 'kode', 'tebus_murah'));

-- ---------------------------------------------------------------- printed voucher codes (10 Nov 2026)
-- Each printed voucher (first: the Papaya cashier voucher) carries its own random code,
-- inside its QR (/v/<code>) and printed under it. Scanning only opens sign-up; the code
-- is claimed onto a member's card at the very end, by the member in the app
-- (claim_voucher_code) or by the cashier from a card scan (staff_claim_code). Claimed
-- codes show as vouchers (kind 'kode', period = code id) and are used by the cashier
-- like the welcome voucher. One code = one member; one_per_member allows one code per
-- batch per member. Codes are added with the SQL file made for each print run.
create table if not exists public.voucher_batches (
  id text primary key,
  title text not null,
  label text not null,
  pos_code text,
  ends_on date not null,
  one_per_member boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.voucher_codes (
  id int generated always as identity primary key,
  code text not null unique check (code ~ '^[2-9A-HJ-NP-Z]{8}$'),
  batch_id text not null references public.voucher_batches (id),
  sheet int,
  claimed_by uuid references public.profiles (id) on delete set null,
  claimed_at timestamptz,
  claimed_via text check (claimed_via in ('app', 'kasir', 'pemilik')),
  created_at timestamptz not null default now()
);
create unique index if not exists voucher_codes_one_per_member on public.voucher_codes (batch_id, claimed_by)
  where claimed_by is not null;
alter table public.voucher_batches enable row level security;
alter table public.voucher_codes enable row level security;
-- The Papaya cashier voucher (Glenn, 8 Nov): 1 Signature, VireoPOS code MANIS, until 31 Jan 2027.
insert into public.voucher_batches (id, title, label, pos_code, ends_on)
values ('papaya-1', 'Voucher Papaya', '1 Signature choux gratis', 'MANIS', '2027-01-31')
on conflict (id) do nothing;
drop index if exists public.redemptions_once;
create unique index if not exists redemptions_once_kind
  on public.redemptions (member_id, kind, cycle, slot) where reversed_at is null;

-- One row per card a member has filled (cycle 0 is the first card). closed_at is set
-- once every reward on that card has been used; only then does the member see a new
-- card. Kept as rows, not worked out on the fly, so future tiers ("3 cards done")
-- stay true even if card_size changes. Rebuilt by _sync_cycles after every change.
create table if not exists public.card_cycles (
  member_id uuid not null references public.profiles (id) on delete cascade,
  cycle int not null check (cycle >= 0),
  card_size int not null,
  filled_at timestamptz not null,
  closed_at timestamptz,
  primary key (member_id, cycle)
);
alter table public.card_cycles enable row level security;

create table if not exists public.redeem_codes (
  id bigint generated always as identity primary key,
  code text not null,
  member_id uuid not null references public.profiles (id) on delete cascade,
  cycle int not null,
  slot int not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.scan_tickets (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.profiles (id) on delete cascade,
  member_id uuid not null references public.profiles (id) on delete cascade,
  via text not null check (via in ('qr', 'kode', 'nomor', 'daftar')),
  expires_at timestamptz not null,
  used_at timestamptz
);

-- How the cashier found the card: QR scan, typed card code, WhatsApp number search
-- (nomor), or a card the cashier just made on the tablet (daftar). Widened 10 Nov 2026.
alter table public.sales drop constraint if exists sales_via_check;
alter table public.sales add constraint sales_via_check check (via in ('qr', 'kode', 'nomor', 'daftar'));
alter table public.scan_tickets drop constraint if exists scan_tickets_via_check;
alter table public.scan_tickets add constraint scan_tickets_via_check check (via in ('qr', 'kode', 'nomor', 'daftar'));

create table if not exists public.undo_requests (
  id bigint generated always as identity primary key,
  sale_id bigint references public.sales (id) on delete cascade,
  redemption_id bigint references public.redemptions (id) on delete cascade,
  requested_by uuid references public.profiles (id) on delete set null,
  reason text not null,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check ((sale_id is null) <> (redemption_id is null))
);

-- Receipts imported from the VireoPOS sales export, for the nightly check.
create table if not exists public.pos_receipts (
  receipt_key text primary key,
  receipt_no text not null,
  sold_at timestamptz not null,
  total int,
  imported_at timestamptz not null default now()
);
alter table public.pos_receipts add column if not exists customer text;
create index if not exists pos_receipts_total_idx on public.pos_receipts (total, sold_at);

create table if not exists public.campaigns (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null default '',
  starts_on date not null default current_date,
  ends_on date not null default (current_date + 30),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- row security
alter table public.settings enable row level security;
alter table public.rewards enable row level security;
alter table public.menu_items enable row level security;
alter table public.profiles enable row level security;
alter table public.sales enable row level security;
alter table public.redemptions enable row level security;
alter table public.redeem_codes enable row level security;
alter table public.scan_tickets enable row level security;
alter table public.undo_requests enable row level security;
alter table public.pos_receipts enable row level security;
alter table public.campaigns enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists "read rewards" on public.rewards;
create policy "read rewards" on public.rewards for select to authenticated using (true);
drop policy if exists "read menu" on public.menu_items;
-- Once pos.sql has added pos_only, keep the till-only products (Paper bag) hidden here too,
-- so running schema.sql alone again does not show them on the old cashier page (12 Nov 2026).
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menu_items' and column_name = 'pos_only') then
    create policy "read menu" on public.menu_items for select to authenticated using (active and not pos_only);
  else
    create policy "read menu" on public.menu_items for select to authenticated using (active);
  end if;
end $$;
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists "read own sales" on public.sales;
create policy "read own sales" on public.sales for select to authenticated
  using (member_id = auth.uid() and reversed_at is null);
drop policy if exists "read own redemptions" on public.redemptions;
create policy "read own redemptions" on public.redemptions for select to authenticated
  using (member_id = auth.uid() and reversed_at is null);
drop policy if exists "read live campaigns" on public.campaigns;
create policy "read live campaigns" on public.campaigns for select to authenticated
  using (active and current_date between starts_on and ends_on);

-- ---------------------------------------------------------------- helpers
create or replace function public._cfg() returns public.settings
language sql stable security definer set search_path = public
as $$ select * from settings where id = 1 $$;

create or replace function public._local(ts timestamptz) returns timestamp
language sql stable security definer set search_path = public
as $$ select ts at time zone (select tz from settings where id = 1) $$;

create or replace function public._require(roles text[], msg text) returns uuid
language plpgsql stable security definer set search_path = public
as $$
declare r text;
begin
  select role into r from profiles where id = auth.uid() and deleted_at is null;
  -- A manager may do everything staff may do; so may the kasir tablet account (personal
  -- staff functions refuse it on their own, see _att_me in attendance.sql).
  if r in ('manager', 'kasir') and 'staff' = any (roles) then return auth.uid(); end if;
  if r is null or not (r = any (roles)) then
    raise exception '%', msg using errcode = '42501';
  end if;
  return auth.uid();
end $$;

create or replace function public._log(action text, detail jsonb) returns void
language sql security definer set search_path = public
as $$ insert into audit_log (actor, action, detail) values (auth.uid(), action, detail) $$;

create or replace function public._wa(raw text) returns text
language sql immutable
as $$
  select case
    when d is null or d = '' then null
    when d like '62%' then d
    when d like '0%' then '62' || substr(d, 2)
    when d like '8%' then '62' || d
    else d end
  from (select regexp_replace(coalesce(raw, ''), '\D', '', 'g') as d) x
$$;

create or replace function public._first_name(n text) returns text
language sql immutable
as $$ select coalesce(nullif(split_part(trim(coalesce(n, '')), ' ', 1), ''), 'Member') $$;

create or replace function public._new_card_code() returns text
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  a constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  b bytea; c text; i int;
begin
  loop
    b := extensions.gen_random_bytes(8);
    c := '';
    for i in 0..7 loop
      c := c || substr(a, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    c := substr(c, 1, 4) || '-' || substr(c, 5, 4);
    exit when not exists (select 1 from profiles where card_code = c);
  end loop;
  return c;
end $$;

create or replace function public._token_sig(code text, win bigint) returns text
language sql stable security definer set search_path = public, extensions
as $$
  select left(encode(extensions.hmac(code || '.' || win::text, (select token_secret from settings where id = 1), 'sha256'), 'hex'), 12)
$$;

create or replace function public._total(p uuid) returns int
language sql stable security definer set search_path = public
as $$ select coalesce(sum(stamps), 0)::int from sales where member_id = p and reversed_at is null $$;

-- Every reward the member has passed, on this card and earlier ones.
create or replace function public._rewards(p uuid)
returns table (cycle int, slot int, label text, status text)
language sql stable security definer set search_path = public
as $$
  with t as (select public._total(p) as total, (select card_size from settings where id = 1) as size),
  cyc as (select generate_series(0, t.total / t.size) as c from t)
  select cyc.c, r.slot, r.label,
    case
      when exists (select 1 from redemptions d where d.member_id = p and d.kind = 'stempel' and d.cycle = cyc.c
                   and d.slot = r.slot and d.reversed_at is null) then 'ditukar'
      when cyc.c * t.size + r.slot <= t.total then 'tersedia'
      else 'terkunci'
    end
  from cyc cross join t cross join rewards r
  where r.slot <= t.size
  order by cyc.c, r.slot
$$;

-- Brings card_cycles up to date for one member: a row for every full card, with the
-- time its last stamp landed and, once all its rewards are used, the time it closed.
create or replace function public._sync_cycles(p uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  size int := (select card_size from settings where id = 1);
  full_cards int; n int; filled timestamptz; done timestamptz;
begin
  if p is null then return; end if;
  full_cards := public._total(p) / size;
  -- An approved undo can take a card back below full.
  delete from card_cycles where member_id = p and cycle >= full_cards;
  for n in 0 .. full_cards - 1 loop
    select x.created_at into filled from (
      select created_at, sum(stamps) over (order by created_at, id) as run
      from sales where member_id = p and reversed_at is null) x
    where x.run >= (n + 1) * size order by x.created_at limit 1;
    if exists (select 1 from public._rewards(p) r where r.cycle = n and r.status <> 'ditukar') then
      done := null;
    else
      select max(d.created_at) into done from redemptions d
       where d.member_id = p and d.kind = 'stempel' and d.cycle = n and d.reversed_at is null;
      done := coalesce(done, filled);
    end if;
    insert into card_cycles (member_id, cycle, card_size, filled_at, closed_at)
    values (p, n, size, coalesce(filled, now()), done)
    on conflict (member_id, cycle) do update set filled_at = excluded.filled_at, closed_at = excluded.closed_at;
  end loop;
end $$;

-- The card the member sees: the oldest one not closed yet. A full card stays on screen
-- until its rewards are used; stamps beyond it wait for the next card.
create or replace function public._card_view(p uuid)
returns table (cycle int, card_position int, waiting int, cards_done int)
language sql stable security definer set search_path = public
as $$
  with t as (select public._total(p) as total, (select card_size from settings where id = 1) as size),
  o as (
    select coalesce(min(g), 0) as c from t, generate_series(0, t.total / t.size) g
    where not exists (select 1 from card_cycles cc where cc.member_id = p and cc.cycle = g and cc.closed_at is not null))
  select o.c, least(t.size, greatest(0, t.total - o.c * t.size)), greatest(0, t.total - (o.c + 1) * t.size),
         (select count(*)::int from card_cycles cc where cc.member_id = p and cc.closed_at is not null)
  from t, o
$$;

-- The member's birthday in a given year. 29 February becomes 28 February in other years.
create or replace function public._birthday_in(b date, y int) returns date
language sql immutable
as $$
  select make_date(y, extract(month from b)::int, 1)
       + (least(extract(day from b)::int,
                extract(day from (make_date(y, extract(month from b)::int, 1) + interval '1 month - 1 day'))::int) - 1)
$$;

-- Vouchers that come with the account rather than with stamps:
--   welcome      Diskon 50% untuk 1 produk, from the day the account is made until 30 days later.
--   ulang_tahun  1 box Mini Choux isi 8, from 7 days before to 7 days after the birthday,
--                once a year, for members who joined at least 30 days before that birthday
--                (syarat dan ketentuan 7.2). Only the next birthday that qualifies is listed.
-- status: 'belum' (not open yet), 'tersedia', 'dipakai', 'kedaluwarsa'.
-- The birth date must also have been saved 30+ days before that birthday (14 Nov 2026), so
-- a member can't leave it empty at sign-up and set it to today later (bday_from).
drop function if exists public._vouchers(uuid);
create or replace function public._vouchers(p uuid)
returns table (kind text, period int, title text, label text, starts_on date, ends_on date, status text, pos_code text)
language sql stable security definer set search_path = public
as $$
  with me as (
    select pr.id, public._local(pr.created_at)::date as joined, pr.birth_date, pr.welcome_voucher,
           greatest(public._local(pr.created_at)::date, public._local(pr.birth_date_set_at)::date) as bday_from
    from profiles pr where pr.id = p and pr.role in ('member', 'staff', 'manager') and pr.deleted_at is null),
  t as (select public._local(now())::date as today),
  welcome as (
    select 'welcome'::text as kind, 0 as period, 'Hadiah member baru'::text as title,
           'Diskon 50% untuk 1 produk'::text as label, me.joined as starts_on, me.joined + 30 as ends_on,
           'NEWMEMBER50'::text as pos_code
    from me where me.welcome_voucher),
  bday as (
    select 'ulang_tahun'::text as kind, y as period, 'Hadiah ulang tahun'::text as title,
           '1 box Mini Choux isi 8 gratis'::text as label,
           public._birthday_in(me.birth_date, y) - 7 as starts_on, public._birthday_in(me.birth_date, y) + 7 as ends_on,
           'BIRTHDAYGIFT'::text as pos_code
    from me, t, generate_series(extract(year from t.today)::int - 1, extract(year from t.today)::int + 1) y
    where me.birth_date is not null
      and public._birthday_in(me.birth_date, y) + 7 >= t.today
      and me.bday_from <= public._birthday_in(me.birth_date, y) - 30
    order by y limit 1),
  codes as (
    -- The code is in the title so the cashier can match it with the paper voucher, which
    -- must be handed over at the booth (Glenn, 10 Nov 2026).
    select 'kode'::text as kind, c.id as period, b.title || ' ' || substr(c.code, 1, 4) || '-' || substr(c.code, 5, 4), b.label,
           public._local(c.claimed_at)::date as starts_on, b.ends_on, b.pos_code
    from me join voucher_codes c on c.claimed_by = me.id join voucher_batches b on b.id = c.batch_id),
  v as (select * from welcome union all select * from bday union all select * from codes)
  select v.kind, v.period, v.title, v.label, v.starts_on, v.ends_on,
    case
      when exists (select 1 from redemptions d where d.member_id = p and d.kind = v.kind
                   and d.cycle = v.period and d.reversed_at is null) then 'dipakai'
      when t.today < v.starts_on then 'belum'
      when t.today > v.ends_on then 'kedaluwarsa'
      else 'tersedia'
    end,
    v.pos_code
  from v, t
$$;

-- True when the card can't take stamps or rewards: the owner's or the kasir tablet's
-- account, or a second account that shares a staff member's WhatsApp or email.
-- Staff and managers have their own member card on their staff account (Glenn, 13 Nov
-- 2026: "staff can have member card also with the same data"). The callers still refuse
-- the signed-in account's own card and, on the till, the card of the person serving; a
-- sale on a staff card is flagged kartu_staf for the owner (pos_checkout).
create or replace function public._staff_conflict(p uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p and role in ('owner', 'kasir'))
      or exists (
        select 1 from profiles m join profiles s
          on s.role in ('staff', 'manager', 'owner') and s.id <> m.id and s.deleted_at is null
         and ((m.whatsapp is not null and m.whatsapp = s.whatsapp)
           or (m.email is not null and lower(m.email) = lower(s.email)))
        where m.id = p)
$$;

-- ---------------------------------------------------------------- sign-up and login
-- Everyone signs in with a username or WhatsApp number plus a password. Behind the
-- scenes each account has a random login address, u-xxxx@auth_domain, which no one
-- sees and no email is sent to. login_handle() turns a username or number into it.

-- Age range for the dashboard, worked out from the birth date.
create or replace function public._age_range(b date) returns text
language sql stable
as $$
  select case
    when b is null then null
    when age(current_date, b) < interval '25 years' then '17-24'
    when age(current_date, b) < interval '35 years' then '25-34'
    when age(current_date, b) < interval '45 years' then '35-44'
    else '45+' end
$$;

create or replace function public._clean_username(u text) returns text
language sql immutable
as $$ select nullif(lower(trim(coalesce(u, ''))), '') $$;

-- Saves acceptance of the current terms and privacy versions, and the promo choice.
create or replace function public._record_consent(p_user uuid, p_method text, p_marketing boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare st settings := (select s from settings s where id = 1);
begin
  insert into consent_log (user_id, document, version, accepted, method) values
    (p_user, 'syarat', st.terms_version, true, p_method),
    (p_user, 'privasi', st.privacy_version, true, p_method);
  if p_marketing is not null then
    insert into consent_log (user_id, document, version, accepted, method)
    values (p_user, 'promo_whatsapp', st.privacy_version, p_marketing, p_method);
  end if;
end $$;

-- Keyed hash of a WhatsApp number for welcome_given. The pepper lives in settings,
-- which no browser can read, so the hashes can't be reversed by guessing numbers.
create or replace function public._wa_hash(wa text) returns text
language sql stable security definer set search_path = public, extensions
as $$ select encode(extensions.hmac('welcome.' || wa, (select wa_pepper from settings where id = 1), 'sha256'), 'hex') $$;

create or replace function public._handle_new_user() returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}');
  wa text := coalesce(public._wa(meta->>'whatsapp'), public._wa(new.phone));
  un text := public._clean_username(meta->>'username');
  bd date;
  nm text := nullif(trim(coalesce(meta->>'full_name', '')), '');
begin
  if wa is null and split_part(new.email, '@', 1) ~ '^[0-9]+$' then wa := public._wa(split_part(new.email, '@', 1)); end if;
  -- owner_add_kasir sets hanashuya.kasir_account for its own transaction: the kasir tablet
  -- login has no WhatsApp number. Browsers can't set it (sign-up metadata can't skip this).
  if wa is null and current_setting('hanashuya.kasir_account', true) = 'on' then
    null;
  elsif wa is null or wa !~ '^628[0-9]{8,12}$' then raise exception 'Nomor WhatsApp tidak valid.';
  end if;
  if exists (select 1 from profiles where whatsapp = wa and deleted_at is null) then raise exception 'Nomor WhatsApp sudah terdaftar.'; end if;
  if un is not null then
    -- Digits only could be someone else's WhatsApp number at login (14 Nov 2026).
    if un ~ '^[0-9]+$' then raise exception 'Username tidak boleh hanya angka.'; end if;
    if un !~ '^[a-z0-9._]{3,20}$' then raise exception 'Username tidak valid.'; end if;
    if exists (select 1 from profiles where username = un and deleted_at is null) then raise exception 'Username sudah dipakai.'; end if;
  end if;
  begin bd := nullif(meta->>'birth_date', '')::date; exception when others then raise exception 'Tanggal lahir tidak valid.'; end;
  if bd is not null and age(current_date, bd) < interval '17 years' then raise exception 'Kartu member hanya untuk usia 17 tahun ke atas.'; end if;
  insert into profiles (id, email, whatsapp, username, full_name, birth_date, birth_date_set_at, age_range, gender, adult_confirmed, marketing_opt_in, card_code,
                        welcome_voucher)
  values (new.id, lower(new.email), wa, un, nm, bd, case when bd is not null then now() end, public._age_range(bd),
          nullif(meta->>'gender', ''), bd is not null,
          coalesce((meta->>'marketing')::boolean, false), public._new_card_code(),
          -- A number whose earlier account was deleted already had its welcome voucher.
          not exists (select 1 from welcome_given where wa_hash = public._wa_hash(wa)))
  on conflict (id) do nothing;
  -- No terms checkbox while the legal pages are offline (Glenn, 7 Nov 2026); only the
  -- promo choice is recorded.
  insert into consent_log (user_id, document, version, accepted, method)
  -- staff_create_member sets hanashuya.signup_method for its own transaction, so a
  -- card made by the cashier is recorded as 'daftar kasir'. Browsers can't set it.
  select new.id, 'promo_whatsapp', s.privacy_version, coalesce((meta->>'marketing')::boolean, false),
         coalesce(nullif(current_setting('hanashuya.signup_method', true), ''), 'daftar')
  from settings s where s.id = 1;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public._handle_new_user();

-- A WhatsApp match wins over a username of the same digits (14 Nov 2026), so an older
-- digits-only username can never take over another member's number login.
create or replace function public._find_login(p_login text) returns profiles
language sql stable security definer set search_path = public
as $$
  select * from profiles
  where deleted_at is null
    and (username = public._clean_username(p_login)
      or (public._wa(p_login) ~ '^628[0-9]{8,12}$' and whatsapp = public._wa(p_login)))
  order by (whatsapp = public._wa(p_login)) desc nulls last
  limit 1
$$;

-- Turns a username or WhatsApp number into the hidden login address, for the login form.
create or replace function public.login_handle(p_login text) returns text
language sql stable security definer set search_path = public
as $$ select (public._find_login(p_login)).email $$;

-- Tells the sign-up form which fields are already taken, before the account is made.
-- A username of digits only is refused here with the same message as at sign-up, so the
-- form shows it before the account is made (14 Nov 2026).
create or replace function public.signup_check(p_username text, p_phone text) returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  if public._clean_username(p_username) ~ '^[0-9]+$' then raise exception 'Username tidak boleh hanya angka.'; end if;
  return json_build_object(
    'username_taken', exists (select 1 from profiles where username = public._clean_username(p_username) and deleted_at is null),
    'phone_taken', exists (select 1 from profiles where whatsapp = public._wa(p_phone) and deleted_at is null));
end $$;

-- Creates a login with a hidden address and the given password. Used for staff
-- accounts, the first owner, and member cards the cashier makes on the tablet
-- (p_meta carries birth_date, gender and marketing for _handle_new_user).
drop function if exists public._create_login(text, text, text, text);
create or replace function public._create_login(p_wa text, p_password text, p_username text, p_name text, p_meta jsonb default '{}') returns uuid
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  uid uuid := gen_random_uuid();
  em text := 'u-' || substr(replace(uid::text, '-', ''), 1, 16) || '@' || (select auth_domain from settings where id = 1);
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('whatsapp', p_wa, 'username', p_username, 'full_name', p_name) || coalesce(p_meta, '{}'), now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text,
    jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true), 'email', now(), now(), now());
  return uid;
end $$;

create or replace function public._set_password(p_user uuid, p_password text) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
begin
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password minimal 8 karakter.'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = p_user;
end $$;

-- Signs an account out everywhere after its password changes (14 Nov 2026). Without it a
-- refresh token (kept 400 days in the login cookie) outlives the old password, so whoever
-- signed in with a starting password stays in after the real person sets their own.
-- p_keep_current keeps the caller's own session (set_first_password, the owner changing
-- their own password). Deleting a session deletes its refresh tokens (foreign key cascade);
-- refresh tokens without a session are removed too. auth.refresh_tokens.user_id is varchar.
-- An access token already issued stays valid until it expires (Supabase default: 1 hour).
-- Skipped where auth has no sessions table (the PGlite tests).
create or replace function public._end_sessions(p_user uuid, p_keep_current boolean default false) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare keep uuid;
begin
  if p_user is null or to_regclass('auth.sessions') is null then return; end if;
  if p_keep_current then
    -- The session id of the signed-in caller, as auth.jwt() reads it.
    begin
      keep := nullif(coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                              nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb->>'session_id', '')::uuid;
    exception when others then keep := null; end;
  end if;
  delete from auth.sessions where user_id = p_user and (keep is null or id <> keep);
  if to_regclass('auth.refresh_tokens') is not null then
    delete from auth.refresh_tokens where user_id = p_user::text and (keep is null or session_id is distinct from keep);
  end if;
end $$;

-- Run once in the SQL Editor to create the first owner account:
--   select public._setup_owner('Glenn', 'glenn', '0812 3456 7890', 'password-anda');
create or replace function public._setup_owner(p_name text, p_username text, p_phone text, p_password text) returns text
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare wa text := public._wa(p_phone); un text := public._clean_username(p_username); uid uuid;
begin
  if exists (select 1 from profiles where role = 'owner' and deleted_at is null) then
    raise exception 'Akun pemilik sudah ada. Tambah staf dari dasbor pemilik.';
  end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password minimal 8 karakter.'; end if;
  uid := public._create_login(wa, p_password, un, trim(p_name));
  update profiles set role = 'owner', adult_confirmed = true where id = uid;
  return 'Akun pemilik dibuat. Masuk di /member/pemilik.html dengan username ' || un || ' atau nomor ' || wa || '.';
end $$;

-- ---------------------------------------------------------------- password reset by WhatsApp
-- "Lupa password" sends a 6-digit code to the account's WhatsApp number. The code is
-- made here and sent by the wa-reset Edge Function through the WhatsApp Cloud API
-- (an authentication template; Meta does not allow links in those). The owner can
-- also make a code from the dashboard and send it by hand. Only a hash is stored.
create table if not exists public.password_resets (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null,
  attempts int not null default 0,
  created_by uuid references public.profiles (id) on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.password_resets enable row level security;

-- Makes a new code for an account: at most 3 an hour, each valid 15 minutes.
-- Returns the number to send it to, or nothing when the account does not exist.
create or replace function public._issue_reset_code(p_login text, p_by uuid default null) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare p profiles := public._find_login(p_login); code text;
begin
  if p.id is null then return null; end if;
  if (select count(*) from password_resets where user_id = p.id and created_at > now() - interval '1 hour') >= 3 then
    raise exception 'Sudah 3 kode dalam 1 jam terakhir. Coba lagi nanti.';
  end if;
  code := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  update password_resets set expires_at = now() where user_id = p.id and used_at is null and expires_at > now();
  insert into password_resets (user_id, code_hash, created_by, expires_at)
  values (p.id, encode(extensions.digest(p.id::text || ':' || code, 'sha256'), 'hex'), p_by, now() + interval '15 minutes');
  insert into audit_log (actor, action, detail) values (p_by, 'kode_reset', jsonb_build_object('akun', p.id, 'oleh', case when p_by is null then 'whatsapp' else 'pemilik' end));
  return json_build_object('whatsapp', p.whatsapp, 'code', code, 'full_name', p.full_name, 'username', p.username);
end $$;

-- The member types the code and a new password. Five wrong tries cancel the code.
create or replace function public.reset_with_code(p_login text, p_code text, p_password text) returns text
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare p profiles := public._find_login(p_login); r password_resets;
begin
  if p.id is null then raise exception 'Kode salah atau sudah kedaluwarsa.'; end if;
  select * into r from password_resets
  where user_id = p.id and used_at is null and expires_at > now() order by created_at desc limit 1 for update;
  if r.id is null then raise exception 'Kode sudah kedaluwarsa. Minta kode baru.'; end if;
  if r.attempts >= 5 then raise exception 'Terlalu banyak percobaan. Minta kode baru.'; end if;
  if r.code_hash <> encode(extensions.digest(p.id::text || ':' || trim(coalesce(p_code, '')), 'sha256'), 'hex') then
    update password_resets set attempts = attempts + 1 where id = r.id;
    return null;
  end if;
  perform public._set_password(p.id, p_password);
  -- Lupa password: whoever is still signed in on this account is signed out (14 Nov 2026).
  perform public._end_sessions(p.id);
  update profiles set must_set_password = false where id = p.id;
  update password_resets set used_at = now() where user_id = p.id and used_at is null;
  insert into audit_log (actor, action, detail) values (p.id, 'reset_password', jsonb_build_object('reset', r.id));
  return p.email;
end $$;

-- ---------------------------------------------------------------- member functions
create or replace function public.whoami() returns json
language sql stable security definer set search_path = public
as $$
  -- The kasir tablet account shows as 'staff' to the pages (kasir_tablet tells them apart).
  select json_build_object('id', id, 'role', case when role = 'kasir' then 'staff' else role end,
    'kasir_tablet', role = 'kasir', 'full_name', full_name, 'username', username, 'whatsapp', whatsapp,
    'whatsapp_verified', whatsapp_verified_at is not null,
    -- The username is optional (cards made by the cashier have none); members can always
    -- sign in with their WhatsApp number.
    'profile_complete', (full_name is not null and birth_date is not null and adult_confirmed),
    'must_set_password', must_set_password,
    -- Always true while the legal pages are offline, so nobody is asked to re-accept.
    -- To bring the check back, restore it from git history (commit 86704a7).
    'terms_ok', true)
  from profiles where id = auth.uid() and deleted_at is null
$$;

-- Members change their name, username, birth date and gender here. The WhatsApp
-- number stays fixed; Hanashuya changes it on request.
drop function if exists public.update_my_profile(text, text, text, text, boolean);
drop function if exists public.update_my_profile(text, text, date, text, boolean);
drop function if exists public.update_my_profile(text, text, text, boolean);
create or replace function public.update_my_profile(
  p_full_name text, p_username text, p_birth_date date, p_gender text, p_adult boolean, p_marketing boolean default null
) returns json
language plpgsql security definer set search_path = public
as $$
declare un text := public._clean_username(p_username);
begin
  if auth.uid() is null then raise exception 'Silakan masuk dulu.'; end if;
  if coalesce(trim(p_full_name), '') = '' then raise exception 'Isi nama lengkap.'; end if;
  -- Username is optional; left empty, the current one (or none) is kept.
  -- Digits only could be someone else's WhatsApp number at login (14 Nov 2026). An older
  -- account that already has such a username may keep it (login prefers the number).
  if un ~ '^[0-9]+$' and un is distinct from (select username from profiles where id = auth.uid()) then
    raise exception 'Username tidak boleh hanya angka.';
  end if;
  if un is not null and un !~ '^[a-z0-9._]{3,20}$' then raise exception 'Username 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.'; end if;
  if un is not null and exists (select 1 from profiles where username = un and id <> auth.uid() and deleted_at is null) then raise exception 'Username sudah dipakai.'; end if;
  if p_birth_date is null then raise exception 'Isi tanggal lahir.'; end if;
  if age(current_date, p_birth_date) < interval '17 years' then raise exception 'Kartu member hanya untuk usia 17 tahun ke atas.'; end if;
  -- The birthday voucher depends on it, so once set only Hanashuya changes the birth date
  -- (owner_set_birth_date, from Bantuan akun).
  if (select birth_date from profiles where id = auth.uid()) is not null
     and p_birth_date is distinct from (select birth_date from profiles where id = auth.uid()) then
    raise exception 'Tanggal lahir tidak bisa diubah sendiri. Hubungi Hanashuya lewat WhatsApp untuk menggantinya.';
  end if;
  -- p_adult is no longer checked: there is no terms checkbox while the legal pages are
  -- offline. The age check above still applies. Record the promo choice when it changes.
  if p_marketing is not null and p_marketing is distinct from (select marketing_opt_in from profiles where id = auth.uid()) then
    insert into consent_log (user_id, document, version, accepted, method)
    values (auth.uid(), 'promo_whatsapp', (select privacy_version from settings where id = 1), p_marketing, 'ubah data');
  end if;
  update profiles set
    full_name = trim(p_full_name), username = coalesce(un, username), birth_date = p_birth_date,
    -- First time the birth date is saved: the birthday voucher counts 30 days from here.
    birth_date_set_at = case when birth_date is null then now() else birth_date_set_at end,
    age_range = public._age_range(p_birth_date), gender = nullif(p_gender, ''), adult_confirmed = true,
    marketing_opt_in = coalesce(p_marketing, marketing_opt_in)
  where id = auth.uid() and deleted_at is null;
  return public.whoami();
end $$;

create or replace function public.my_card() returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me profiles; s settings := public._cfg(); v_total int; cv record;
begin
  select * into me from profiles where id = auth.uid() and deleted_at is null;
  if me.id is null then raise exception 'Silakan masuk dulu.'; end if;
  v_total := public._total(me.id);
  select * into cv from public._card_view(me.id);
  return json_build_object(
    'full_name', me.full_name, 'email', me.email, 'whatsapp', me.whatsapp,
    'gender', me.gender, 'age_range', me.age_range, 'card_code', me.card_code, 'member_since', me.created_at,
    'username', me.username, 'birth_date', me.birth_date, 'marketing_opt_in', me.marketing_opt_in,
    'total_stamps', v_total, 'card_size', s.card_size,
    'cycle', cv.cycle, 'position', cv.card_position, 'waiting', cv.waiting, 'cards_done', cv.cards_done,
    'rupiah_per_stamp', s.rupiah_per_stamp,
    'rewards', coalesce((select json_agg(json_build_object('cycle', cycle, 'slot', slot, 'label', label, 'status', status))
                         from public._rewards(me.id)), '[]'),
    'visits', coalesce((select json_agg(v) from (
        select created_at, stamps, total, items from sales
        where member_id = me.id and reversed_at is null
        order by created_at desc limit 20) v), '[]'),
    'vouchers', coalesce((select json_agg(json_build_object('kind', x.kind, 'period', x.period, 'title', x.title, 'label', x.label,
                           'starts_on', x.starts_on, 'ends_on', x.ends_on, 'status', x.status))
                         from public._vouchers(me.id) x where x.status <> 'kedaluwarsa'), '[]'),
    'redeemed', coalesce((select json_agg(r) from (
        select id, created_at, reward_label, slot, kind from redemptions
        where member_id = me.id and reversed_at is null
        order by created_at desc limit 50) r), '[]'),
    'visit_count', (select count(*) from sales where member_id = me.id and reversed_at is null)
  );
end $$;

-- The QR changes every 5 minutes (Glenn, 7 Nov 2026: 30 seconds was stressful at the
-- till) so an old shared screenshot still stops working.
create or replace function public.card_token() returns json
language plpgsql stable security definer set search_path = public
as $$
declare code text; win bigint := floor(extract(epoch from now()) / 300);
begin
  select replace(card_code, '-', '') into code from profiles where id = auth.uid() and deleted_at is null;
  if code is null then raise exception 'Silakan masuk dulu.'; end if;
  return json_build_object(
    'token', 'HS1.' || code || '.' || win || '.' || public._token_sig(code, win),
    'expires_in', 300 - (floor(extract(epoch from now()))::bigint % 300));
end $$;

create or replace function public.create_redeem_code(p_cycle int, p_slot int) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare me uuid := auth.uid(); c text; r record;
begin
  if me is null then raise exception 'Silakan masuk dulu.'; end if;
  select * into r from public._rewards(me) x where x.cycle = p_cycle and x.slot = p_slot;
  if r.status is distinct from 'tersedia' then raise exception 'Hadiah ini belum bisa ditukar.'; end if;
  update redeem_codes set expires_at = now() where member_id = me and used_at is null and expires_at > now();
  loop
    c := lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not exists (select 1 from redeem_codes where code = c and used_at is null and expires_at > now());
  end loop;
  insert into redeem_codes (code, member_id, cycle, slot, expires_at)
  values (c, me, p_cycle, p_slot, now() + interval '2 minutes');
  return json_build_object('code', c, 'label', r.label, 'expires_in', 120);
end $$;

-- The member taps Tukar and confirms; the reward is marked as redeemed at once and
-- the phone shows a live voucher for the cashier. Each reward redeems only once.
create or replace function public.member_redeem(p_cycle int, p_slot int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me profiles; r record; rid bigint; at timestamptz;
begin
  -- Rewards are used at the counter: the cashier scans the card QR and taps Pakai
  -- (staff_redeem_reward). Members can no longer use one up on their own.
  raise exception 'Tunjukkan QR kartu ke kasir. Kasir yang memakai hadiahnya untuk Kakak.';
  select * into me from profiles where id = auth.uid() and deleted_at is null;
  select * into r from public._rewards(me.id) x where x.cycle = p_cycle and x.slot = p_slot;
  if r.status is distinct from 'tersedia' then raise exception 'Hadiah ini sudah ditukar atau belum tersedia.'; end if;
  insert into redemptions (member_id, staff_id, cycle, slot, reward_label)
  values (me.id, null, p_cycle, p_slot, r.label) returning id, created_at into rid, at;
  perform public._log('tukar_hadiah', jsonb_build_object('redemption', rid, 'member', me.id, 'reward', r.label, 'oleh', 'member'));
  return json_build_object('id', rid, 'label', r.label, 'slot', p_slot, 'created_at', at,
    'first_name', public._first_name(me.full_name), 'card_code', me.card_code);
end $$;

-- Removes the member's personal data. Past purchases stay as anonymous sales.
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Silakan masuk dulu.'; end if;
  if (select role from profiles where id = me) <> 'member' then
    raise exception 'Akun staf dihapus oleh pemilik.';
  end if;
  -- Keep only a keyed hash of the number, so signing up again gives no new welcome voucher.
  insert into welcome_given (wa_hash)
  select public._wa_hash(whatsapp) from profiles where id = me and whatsapp is not null
  on conflict (wa_hash) do nothing;
  -- Number searches and cashier sign-ups logged the number; take it out of those rows.
  update audit_log set detail = (detail - 'whatsapp') || jsonb_build_object('whatsapp', 'dihapus')
   where action in ('cari_nomor', 'daftar_lewat_kasir')
     and detail->>'whatsapp' = (select whatsapp from profiles where id = me);
  update sales set member_id = null where member_id = me;
  update redemptions set member_id = null where member_id = me;
  perform public._log('hapus_akun', jsonb_build_object('member', me));
  delete from auth.users where id = me;
end $$;

-- ---------------------------------------------------------------- staff functions
create or replace function public.staff_lookup(p_scan text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  raw text := upper(trim(coalesce(p_scan, '')));
  parts text[]; code text; win bigint; now_win bigint := floor(extract(epoch from now()) / 300);
  m profiles; via text;
begin
  if raw like 'HS1.%' then
    parts := string_to_array(raw, '.');
    if array_length(parts, 1) <> 4 then raise exception 'QR tidak dikenali.'; end if;
    code := parts[2];
    begin win := parts[3]::bigint; exception when others then raise exception 'QR tidak dikenali.'; end;
    -- Current or previous 5-minute window, so a QR shown just before it changed still scans.
    if win < now_win - 1 or win > now_win + 1 then
      raise exception 'QR sudah kedaluwarsa. Minta member membuka ulang kartunya.';
    end if;
    if lower(parts[4]) <> public._token_sig(code, win) then raise exception 'QR tidak valid.'; end if;
    via := 'qr';
  else
    code := regexp_replace(raw, '[^A-Z0-9]', '', 'g');
    if length(code) <> 8 then raise exception 'Kode kartu terdiri dari 8 huruf dan angka.'; end if;
    via := 'kode';
  end if;
  select * into m from profiles where replace(card_code, '-', '') = code and deleted_at is null;
  if m.id is null then raise exception 'Kartu tidak ditemukan.'; end if;
  return public._open_card(staff, m, via);
end $$;

-- Opens a found card for the cashier: checks it isn't a staff card, makes a 10-minute
-- scan ticket and returns what the cashier sees. Shared by the QR/code lookup, the
-- WhatsApp number search and the cashier sign-up.
create or replace function public._open_card(staff uuid, m profiles, via text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare t uuid; v_total int; s settings := public._cfg(); cv record;
begin
  if m.id = staff then raise exception 'Tidak bisa memakai kartu sendiri.'; end if;
  if public._staff_conflict(m.id) then
    raise exception 'Kartu ini terhubung dengan akun staf, jadi tidak bisa diberi stempel atau hadiah di sini.';
  end if;
  insert into scan_tickets (staff_id, member_id, via, expires_at)
  values (staff, m.id, via, now() + interval '10 minutes') returning id into t;
  v_total := public._total(m.id);
  select * into cv from public._card_view(m.id);
  return json_build_object(
    'ticket', t, 'via', via, 'first_name', public._first_name(m.full_name),
    -- The full name only for a number search or a new card, so the cashier can check it.
    'full_name', case when via in ('nomor', 'daftar') then m.full_name end,
    'whatsapp', case when via = 'daftar' then m.whatsapp end,
    'card_code', m.card_code, 'total_stamps', v_total, 'position', cv.card_position,
    'waiting', cv.waiting, 'cycle', cv.cycle, 'cards_done', cv.cards_done,
    'card_size', s.card_size, 'rupiah_per_stamp', s.rupiah_per_stamp,
    'has_demography', (m.gender is not null and m.age_range is not null),
    'rewards', coalesce((select json_agg(json_build_object('label', x.label, 'cycle', x.cycle, 'slot', x.slot))
                         from public._rewards(m.id) x where x.status = 'tersedia'), '[]'),
    'vouchers', coalesce((select json_agg(json_build_object('kind', v.kind, 'period', v.period, 'title', v.title,
                           'label', v.label, 'ends_on', v.ends_on, 'pos_code', v.pos_code))
                         from public._vouchers(m.id) v where v.status = 'tersedia'), '[]'));
end $$;

-- No card and no QR: the cashier asks for the member's WhatsApp number (SOP Bab 7).
-- Only the whole number finds a card, so staff can't browse members by typing part of
-- one. Every search is logged, and sales found this way are flagged for the owner.
create or replace function public.staff_find_phone(p_phone text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  wa text := public._wa(p_phone); m profiles;
begin
  if wa is null or wa !~ '^628[0-9]{8,12}$' then raise exception 'Tulis nomor WhatsApp lengkap, misalnya 0812 3456 7890.'; end if;
  select * into m from profiles where whatsapp = wa and deleted_at is null;
  perform public._log('cari_nomor', jsonb_build_object('whatsapp', wa, 'found', m.id is not null));
  if m.id is null then raise exception 'Nomor ini belum terdaftar sebagai member. Tawarkan daftar member.'; end if;
  return public._open_card(staff, m, 'nomor');
end $$;

-- The cashier makes a member card on the tablet when the customer asks for help.
-- Nobody types a password at the counter: every card starts with the fixed password
-- 12345 (Glenn, 10 Nov 2026, chosen over a random code per card), returned as
-- start_code for the cashier to send by WhatsApp or say aloud, and must_set_password
-- makes the member choose their own on first sign-in. Until they do, anyone who knows
-- the member's number can open the card.
-- The username is left empty (they sign in with their WhatsApp number). The card
-- opens straight away in the Kasir step, so the new-member voucher and today's stamps
-- go on it in the same visit.
drop function if exists public.staff_create_member(text, date, text, text, text, boolean);
create or replace function public.staff_create_member(
  p_name text, p_birth_date date, p_phone text, p_gender text, p_marketing boolean
) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  wa text := public._wa(p_phone); nm text := nullif(trim(coalesce(p_name, '')), ''); uid uuid; m profiles;
  code constant text := '12345';
begin
  if nm is null then raise exception 'Isi nama lengkap.'; end if;
  if p_birth_date is null then raise exception 'Isi tanggal lahir.'; end if;
  if age(current_date, p_birth_date) < interval '17 years' then raise exception 'Kartu member hanya untuk usia 17 tahun ke atas.'; end if;
  if wa is null or wa !~ '^628[0-9]{8,12}$' then raise exception 'Tulis nomor WhatsApp yang aktif, misalnya 0812 3456 7890.'; end if;
  if exists (select 1 from profiles where whatsapp = wa and deleted_at is null) then
    raise exception 'Nomor ini sudah punya kartu member. Cari lewat nomor WhatsApp di langkah 1.';
  end if;
  if nullif(p_gender, '') is not null and p_gender not in ('perempuan', 'laki-laki', 'tidak_disebut') then
    raise exception 'Jenis kelamin tidak valid.';
  end if;
  perform set_config('hanashuya.signup_method', 'daftar kasir', true);
  uid := public._create_login(wa, code, null, nm, jsonb_build_object(
    'birth_date', p_birth_date::text, 'gender', coalesce(p_gender, ''), 'marketing', coalesce(p_marketing, false)));
  perform set_config('hanashuya.signup_method', '', true);
  update profiles set must_set_password = true where id = uid returning * into m;
  perform public._log('daftar_lewat_kasir', jsonb_build_object('member', uid, 'whatsapp', wa));
  return public._open_card(staff, m, 'daftar')::jsonb || jsonb_build_object('start_code', code);
end $$;

-- Claims a printed voucher code for member p. Returns {status, message, ...} and never
-- raises for a wrong code, so the try is logged even when it fails (members get 5 wrong
-- tries an hour). status: tersimpan (saved now), sudah (already on this card), or an
-- error: salah, terlalu_sering, dipakai_lain, kedaluwarsa, sudah_punya.
create or replace function public._claim_code(p uuid, p_code text, p_via text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  k text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  c voucher_codes; b voucher_batches;
begin
  if p_via = 'app' and (select count(*) from audit_log where actor = p and action = 'kode_salah'
                         and created_at > now() - interval '1 hour') >= 5 then
    return json_build_object('status', 'terlalu_sering', 'message', 'Terlalu banyak kode yang salah. Coba lagi 1 jam lagi, atau tunjukkan voucher ke kasir.');
  end if;
  select * into c from voucher_codes where code = k for update;
  if c.id is null then
    insert into audit_log (actor, action, detail) values (auth.uid(), 'kode_salah', jsonb_build_object('member', p, 'via', p_via));
    return json_build_object('status', 'salah', 'message', 'Kode voucher tidak dikenal. Periksa lagi kode di bawah QR voucher.');
  end if;
  select * into b from voucher_batches where id = c.batch_id;
  if c.claimed_by = p then
    return json_build_object('status', 'sudah', 'message', 'Voucher ini sudah tersimpan di kartu Anda.', 'title', b.title, 'label', b.label, 'ends_on', b.ends_on);
  end if;
  if c.claimed_by is not null or c.claimed_at is not null then
    -- claimed_at stays set when the member who saved it deleted their account (13 Nov 2026),
    -- so a deleted and re-made account can't save the same voucher again. The owner frees it.
    return json_build_object('status', 'dipakai_lain', 'message', 'Kode ini sudah dipakai akun lain. Kalau ini voucher Anda, hubungi Hanashuya lewat WhatsApp.');
  end if;
  if public._local(now())::date > b.ends_on then
    return json_build_object('status', 'kedaluwarsa', 'message', 'Voucher ini sudah tidak berlaku.');
  end if;
  if b.one_per_member and exists (select 1 from voucher_codes where batch_id = b.id and claimed_by = p) then
    return json_build_object('status', 'sudah_punya', 'message', b.title || ' hanya 1 per member, dan kartu ini sudah punya.');
  end if;
  update voucher_codes set claimed_by = p, claimed_at = now(), claimed_via = p_via where id = c.id;
  insert into audit_log (actor, action, detail) values (auth.uid(), 'simpan_kode', jsonb_build_object('member', p, 'code_id', c.id, 'via', p_via));
  return json_build_object('status', 'tersimpan', 'message', b.title || ' tersimpan di kartu Anda.', 'title', b.title, 'label', b.label, 'ends_on', b.ends_on);
end $$;

-- The member saves a voucher code to their own card (from the voucher QR, or typed in Hadiah).
create or replace function public.claim_voucher_code(p_code text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = me and role in ('member', 'staff', 'manager') and deleted_at is null) then
    return json_build_object('status', 'bukan_member', 'message', 'Voucher hanya untuk akun member.');
  end if;
  return public._claim_code(me, p_code, 'app');
end $$;

-- The cashier saves a voucher code to the scanned card (the customer shows the paper
-- voucher), then uses it from the ready list. Returns the card again with the voucher.
create or replace function public.staff_claim_code(p_ticket uuid, p_code text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  tk scan_tickets; m profiles; r json;
begin
  select * into tk from scan_tickets where id = p_ticket and staff_id = staff and expires_at > now();
  if tk.id is null then raise exception 'Scan kartu sudah lewat 10 menit. Scan ulang kartunya.'; end if;
  select * into m from profiles where id = tk.member_id and deleted_at is null;
  if m.id is null then raise exception 'Kartu tidak ditemukan.'; end if;
  r := public._claim_code(m.id, p_code, 'kasir');
  if r->>'status' not in ('tersimpan', 'sudah') then
    return json_build_object('status', r->>'status', 'message', replace(replace(r->>'message', 'kartu Anda', 'kartu ini'), 'Kalau ini voucher Anda, hubungi Hanashuya lewat WhatsApp.', 'Minta pembeli menghubungi Hanashuya lewat WhatsApp.'));
  end if;
  return (public._open_card(staff, m, tk.via)::jsonb || jsonb_build_object('status', r->>'status'))::json;
end $$;

-- The owner moves a claimed, unused code to the right member (someone else scanned the
-- voucher first), or frees it with p_login null.
create or replace function public.owner_move_code(p_code text, p_login text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  k text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  c voucher_codes; to_p profiles;
begin
  select * into c from voucher_codes where code = k;
  if c.id is null then raise exception 'Kode voucher tidak dikenal.'; end if;
  if exists (select 1 from redemptions where kind = 'kode' and cycle = c.id and reversed_at is null) then
    raise exception 'Voucher ini sudah dipakai di booth, jadi tidak bisa dipindah.';
  end if;
  if nullif(trim(coalesce(p_login, '')), '') is null then
    update voucher_codes set claimed_by = null, claimed_at = null, claimed_via = null where id = c.id;
  else
    to_p := public._find_login(p_login);
    if to_p.id is null or to_p.role not in ('member', 'staff', 'manager') then raise exception 'Akun member tidak ditemukan.'; end if;
    if exists (select 1 from voucher_codes x join voucher_batches b on b.id = x.batch_id
               where x.batch_id = c.batch_id and x.claimed_by = to_p.id and b.one_per_member and x.id <> c.id) then
      raise exception 'Member itu sudah punya voucher dari kelompok ini.';
    end if;
    update voucher_codes set claimed_by = to_p.id, claimed_at = now(), claimed_via = 'pemilik' where id = c.id;
  end if;
  perform public._log('pindah_kode', jsonb_build_object('code_id', c.id, 'from', c.claimed_by, 'to', to_p.id));
  return json_build_object('code', c.code, 'member', to_p.full_name);
end $$;

-- Per batch: how many codes are printed, saved to a card, and used at the booth. The
-- weekly check: "dipakai" should equal the number of MANIS uses in VireoPOS.
create or replace function public.owner_code_report() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(x order by x.ends_on desc) from (
    select b.id, b.title, b.label, b.pos_code, b.ends_on,
      (select count(*) from voucher_codes c where c.batch_id = b.id) as printed,
      (select count(*) from voucher_codes c where c.batch_id = b.id and c.claimed_by is not null) as claimed,
      (select count(*) from voucher_codes c join redemptions d on d.kind = 'kode' and d.cycle = c.id and d.reversed_at is null
        where c.batch_id = b.id) as used
    from voucher_batches b) x), '[]');
end $$;

-- First sign-in of a card made by the cashier: the member replaces the starting code
-- with their own password. Lupa password (reset_with_code) also clears the flag.
create or replace function public.set_first_password(p_password text) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare me uuid := auth.uid(); p profiles;
begin
  select * into p from profiles where id = me and deleted_at is null;
  if p.id is null then raise exception 'Silakan masuk dulu.'; end if;
  if not p.must_set_password then raise exception 'Password sudah dibuat. Untuk menggantinya, buka Akun.'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password minimal 8 karakter.'; end if;
  if exists (select 1 from auth.users where id = me and encrypted_password = extensions.crypt(p_password, encrypted_password)) then
    raise exception 'Buat password baru, jangan pakai password awal.';
  end if;
  perform public._set_password(me, p_password);
  -- Anyone else who signed in with the starting password is signed out; this device stays.
  perform public._end_sessions(me, true);
  update profiles set must_set_password = false where id = me;
  perform public._log('buat_password_pertama', jsonb_build_object('member', me));
  return public.whoami();
end $$;

-- The cashier uses the new-member or birthday voucher from the card scan, like a stamp reward.
create or replace function public.staff_use_voucher(p_ticket uuid, p_kind text, p_period int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  tk scan_tickets; m profiles; v record; rid bigint; at timestamptz;
begin
  select * into tk from scan_tickets where id = p_ticket and staff_id = staff and expires_at > now();
  if tk.id is null then raise exception 'Scan kartu sudah lewat 10 menit. Scan ulang kartunya.'; end if;
  select * into m from profiles where id = tk.member_id and deleted_at is null;
  if m.id is null then raise exception 'Kartu tidak ditemukan.'; end if;
  if m.id = staff or public._staff_conflict(m.id) then raise exception 'Hadiah untuk akun staf tidak bisa dipakai di sini.'; end if;
  select * into v from public._vouchers(m.id) x where x.kind = p_kind and x.period = p_period;
  if v.status is distinct from 'tersedia' then raise exception 'Voucher ini sudah dipakai atau sedang tidak berlaku.'; end if;
  insert into redemptions (member_id, staff_id, cycle, slot, reward_label, kind)
  values (m.id, staff, p_period, 0, v.label, p_kind) returning id, created_at into rid, at;
  perform public._log('pakai_voucher', jsonb_build_object('redemption', rid, 'member', m.id, 'kind', p_kind, 'period', p_period, 'via', tk.via));
  return json_build_object('redemption_id', rid, 'label', v.label, 'kind', p_kind, 'created_at', at,
    'first_name', public._first_name(m.full_name));
end $$;

create or replace function public.staff_record_sale(
  p_ticket uuid, p_receipt_no text, p_total int, p_items jsonb, p_gender text, p_age_range text
) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  s settings := public._cfg();
  tk scan_tickets; m profiles; n int := 0; today int; f text[] := '{}'; cv record;
  raw text := replace(upper(regexp_replace(coalesce(p_receipt_no, ''), '[^A-Za-z0-9]', '', 'g')), 'O', '0');
  key text; v_day date := public._local(now())::date;
  lt time := public._local(now())::time; prev sales; sid bigint; v_total int;
  g text := nullif(p_gender, ''); a text := nullif(p_age_range, '');
begin
  -- The receipt number is optional. When one is sent it must look like VireoPOS:
  -- the last 6 characters, or the whole number (TRX- plus 13 characters, 0-9 and A-F).
  if raw = '' then key := null;
  elsif raw ~ '^TRX[0-9A-F]{13}$' then key := right(raw, 6);
  elsif raw ~ '^[0-9A-F]{6}$' then key := raw;
  else raise exception 'Nomor struk tidak sesuai format VireoPOS.';
  end if;
  if p_total is null or p_total <= 0 then raise exception 'Isi total belanja sesuai struk.'; end if;
  -- Booth cap (security review, 13 Nov 2026): the biggest real order is a few boxes.
  if p_total > 2000000 then
    raise exception 'Total belanja lebih dari Rp2.000.000. Periksa lagi angkanya; pesanan sebesar ini dicatat oleh pemilik.';
  end if;
  -- Anything over Rp500.000 in one sale is flagged for the owner.
  if p_total > 500000 then f := array_append(f, 'total_besar'); end if;
  if jsonb_typeof(coalesce(p_items, '[]')) <> 'array' then raise exception 'Daftar produk tidak valid.'; end if;
  if key is not null then
    select * into prev from sales where receipt_key = key and sale_day = v_day;
    if prev.id is not null then
      raise exception 'Struk % sudah dicatat hari ini pukul %.', key, to_char(public._local(prev.created_at), 'HH24:MI');
    end if;
  end if;

  if p_ticket is not null then
    select * into tk from scan_tickets where id = p_ticket and staff_id = staff and used_at is null and expires_at > now();
    if tk.id is null then raise exception 'Scan kartu sudah lewat 10 menit. Scan ulang kartunya.'; end if;
    select * into m from profiles where id = tk.member_id and deleted_at is null;
    if m.id is null then raise exception 'Kartu tidak ditemukan.'; end if;
    if m.id = staff or public._staff_conflict(m.id) then
      raise exception 'Kartu ini terhubung dengan akun staf, jadi tidak bisa diberi stempel.';
    end if;
    if lt < s.open_time or lt > s.close_time then
      raise exception 'Stempel hanya bisa diberikan pada jam buka (% sampai %).',
        to_char(s.open_time, 'HH24:MI'), to_char(s.close_time, 'HH24:MI');
    end if;
    n := p_total / s.rupiah_per_stamp;
    -- No daily cap: every purchase earns its stamps. A card that collects more than
    -- max_stamps_per_day in one day is only flagged for the owner to check.
    select coalesce(sum(stamps), 0) into today from sales
     where member_id = m.id and reversed_at is null
       and public._local(created_at)::date = public._local(now())::date;
    if today + n > s.max_stamps_per_day then f := array_append(f, 'banyak_stempel_sehari'); end if;
    -- A double tap: the same card and the same total again within 10 minutes.
    select * into prev from sales
     where member_id = m.id and total = p_total and reversed_at is null and created_at > now() - interval '10 minutes'
     order by created_at desc limit 1;
    if prev.id is not null then
      raise exception 'Penjualan % untuk kartu ini sudah dicatat pukul %. Kalau ini pembelian baru, minta pemilik mencatatnya.',
        'Rp' || replace(to_char(p_total, 'FM999,999,999'), ',', '.'), to_char(public._local(prev.created_at), 'HH24:MI');
    end if;
    if tk.via = 'kode' then f := array_append(f, 'kode_diketik'); end if;
    if tk.via = 'nomor' then f := array_append(f, 'nomor_dicari'); end if;
    if (select count(*) from sales where member_id = m.id and staff_id = staff
          and created_at > now() - interval '7 days' and reversed_at is null) >= 3 then
      f := array_append(f, 'staf_sama_sering');
    end if;
    -- A member who filled in their own gender and age keeps those values.
    if m.gender is not null then g := m.gender; end if;
    if m.age_range is not null then a := m.age_range; end if;
    update scan_tickets set used_at = now() where id = tk.id;
  end if;

  if g is not null and g not in ('perempuan', 'laki-laki', 'tidak_disebut') then raise exception 'Jenis kelamin tidak valid.'; end if;
  if a is not null and a not in ('<17', '17-24', '25-34', '35-44', '45+', 'tidak_disebut') then raise exception 'Rentang usia tidak valid.'; end if;

  insert into sales (receipt_no, sale_day, total, member_id, staff_id, stamps, items, gender, age_range, via, flags)
  values (key, v_day, p_total, m.id, staff, n, coalesce(p_items, '[]'), g, a, tk.via, f)
  returning id into sid;
  perform public._log('penjualan', jsonb_build_object('sale', sid, 'receipt', key, 'total', p_total,
    'member', m.id, 'stamps', n, 'flags', f));
  if p_total > 500000 then
    perform public._log('penjualan_besar', jsonb_build_object('sale', sid, 'total', p_total, 'member', m.id));
  end if;

  if m.id is null then
    return json_build_object('sale_id', sid, 'member', false);
  end if;
  perform public._sync_cycles(m.id);
  v_total := public._total(m.id);
  select * into cv from public._card_view(m.id);
  return json_build_object('sale_id', sid, 'member', true, 'first_name', public._first_name(m.full_name),
    'stamps', n, 'total_stamps', v_total, 'position', cv.card_position, 'waiting', cv.waiting,
    'cycle', cv.cycle, 'card_size', s.card_size,
    'rewards', coalesce((select json_agg(x.label) from public._rewards(m.id) x where x.status = 'tersedia'), '[]'));
end $$;

create or replace function public.staff_check_code(p_code text) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  rc redeem_codes; m profiles; r record;
begin
  select * into rc from redeem_codes where code = trim(p_code) and used_at is null and expires_at > now()
   order by created_at desc limit 1;
  if rc.id is null then raise exception 'Kode tidak ditemukan atau sudah lewat 2 menit. Minta member membuat kode baru.'; end if;
  select * into m from profiles where id = rc.member_id;
  if m.id = staff or public._staff_conflict(m.id) then raise exception 'Hadiah untuk akun staf tidak bisa ditukar di sini.'; end if;
  select * into r from public._rewards(m.id) x where x.cycle = rc.cycle and x.slot = rc.slot;
  return json_build_object('first_name', public._first_name(m.full_name), 'label', r.label, 'status', r.status);
end $$;

create or replace function public.staff_redeem(p_code text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  rc redeem_codes; m profiles; r record; rid bigint;
begin
  select * into rc from redeem_codes where code = trim(p_code) and used_at is null and expires_at > now()
   order by created_at desc limit 1 for update;
  if rc.id is null then raise exception 'Kode tidak ditemukan atau sudah lewat 2 menit. Minta member membuat kode baru.'; end if;
  select * into m from profiles where id = rc.member_id;
  if m.id = staff or public._staff_conflict(m.id) then raise exception 'Hadiah untuk akun staf tidak bisa ditukar di sini.'; end if;
  select * into r from public._rewards(m.id) x where x.cycle = rc.cycle and x.slot = rc.slot;
  if r.status is distinct from 'tersedia' then raise exception 'Hadiah ini sudah ditukar atau belum tersedia.'; end if;
  insert into redemptions (member_id, staff_id, cycle, slot, reward_label)
  values (m.id, staff, rc.cycle, rc.slot, r.label) returning id into rid;
  update redeem_codes set used_at = now() where id = rc.id;
  perform public._log('tukar_hadiah', jsonb_build_object('redemption', rid, 'member', m.id, 'reward', r.label));
  perform public._sync_cycles(m.id);
  return json_build_object('redemption_id', rid, 'first_name', public._first_name(m.full_name), 'label', r.label);
end $$;

-- The cashier uses a member's reward right after scanning their card (the same scan
-- ticket as the stamp, valid 10 minutes). The member's phone shows it within seconds.
create or replace function public.staff_redeem_reward(p_ticket uuid, p_cycle int, p_slot int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan email Anda.');
  tk scan_tickets; m profiles; r record; rid bigint; at timestamptz; cv record;
begin
  select * into tk from scan_tickets where id = p_ticket and staff_id = staff and expires_at > now();
  if tk.id is null then raise exception 'Scan kartu sudah lewat 10 menit. Scan ulang kartunya.'; end if;
  select * into m from profiles where id = tk.member_id and deleted_at is null;
  if m.id is null then raise exception 'Kartu tidak ditemukan.'; end if;
  if m.id = staff or public._staff_conflict(m.id) then raise exception 'Hadiah untuk akun staf tidak bisa ditukar di sini.'; end if;
  select * into r from public._rewards(m.id) x where x.cycle = p_cycle and x.slot = p_slot;
  if r.status is distinct from 'tersedia' then raise exception 'Hadiah ini sudah dipakai atau belum terbuka.'; end if;
  insert into redemptions (member_id, staff_id, cycle, slot, reward_label)
  values (m.id, staff, p_cycle, p_slot, r.label) returning id, created_at into rid, at;
  perform public._log('tukar_hadiah', jsonb_build_object('redemption', rid, 'member', m.id, 'reward', r.label, 'oleh', 'kasir', 'via', tk.via));
  perform public._sync_cycles(m.id);
  select * into cv from public._card_view(m.id);
  return json_build_object('redemption_id', rid, 'label', r.label, 'slot', p_slot, 'created_at', at,
    'first_name', public._first_name(m.full_name), 'new_card', cv.cycle > p_cycle,
    'position', cv.card_position, 'cycle', cv.cycle);
end $$;

create or replace function public.staff_today() returns json
language plpgsql stable security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf.');
begin
  return json_build_object(
    'sales', coalesce((select json_agg(x order by x.created_at desc) from (
      select s.id, s.receipt_no, s.total, s.stamps, s.created_at, s.reversed_at is not null as reversed,
             case when s.member_id is not null then public._first_name(p.full_name) end as member,
             exists (select 1 from undo_requests u where u.sale_id = s.id and u.status = 'menunggu') as undo_pending
      from sales s left join profiles p on p.id = s.member_id
      where s.staff_id = staff and public._local(s.created_at)::date = public._local(now())::date) x), '[]'),
    'redemptions', coalesce((select json_agg(x order by x.created_at desc) from (
      select d.id, d.reward_label, d.created_at, d.reversed_at is not null as reversed,
             public._first_name(p.full_name) as member, p.card_code, d.staff_id is null as by_member,
             exists (select 1 from undo_requests u where u.redemption_id = d.id and u.status = 'menunggu') as undo_pending
      from redemptions d left join profiles p on p.id = d.member_id
      where (d.staff_id = staff or d.staff_id is null)
        and public._local(d.created_at)::date = public._local(now())::date) x), '[]'));
end $$;

create or replace function public.staff_request_undo(p_kind text, p_id bigint, p_reason text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf.');
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'Tulis alasan pembatalan.'; end if;
  if p_kind = 'sale' then
    if not exists (select 1 from sales where id = p_id and staff_id = staff and reversed_at is null) then
      raise exception 'Penjualan ini tidak bisa dibatalkan.';
    end if;
    if exists (select 1 from undo_requests where sale_id = p_id and status = 'menunggu') then
      raise exception 'Permintaan untuk penjualan ini sudah dikirim.';
    end if;
    insert into undo_requests (sale_id, requested_by, reason) values (p_id, staff, trim(p_reason));
  elsif p_kind = 'redemption' then
    if not exists (select 1 from redemptions where id = p_id and (staff_id = staff or staff_id is null) and reversed_at is null) then
      raise exception 'Penukaran ini tidak bisa dibatalkan.';
    end if;
    if exists (select 1 from undo_requests where redemption_id = p_id and status = 'menunggu') then
      raise exception 'Permintaan untuk penukaran ini sudah dikirim.';
    end if;
    insert into undo_requests (redemption_id, requested_by, reason) values (p_id, staff, trim(p_reason));
  else
    raise exception 'Jenis pembatalan tidak dikenal.';
  end if;
  perform public._log('minta_batal', jsonb_build_object('kind', p_kind, 'id', p_id, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------- owner functions
-- True when both names are filled in and share no word of 3 or more letters, for
-- example "Aliya" on the VireoPOS receipt against member "Steven Glenn" (username steven).
create or replace function public._name_differs(a text, b text) returns boolean
language sql immutable
as $$
  select coalesce(trim(a), '') <> '' and coalesce(trim(b), '') <> '' and not exists (
    select 1 from regexp_split_to_table(lower(a), '[^a-z0-9]+') x
    join regexp_split_to_table(lower(b), '[^a-z0-9]+') y on x = y
    where length(x) >= 3)
$$;

-- Pairs every stamp with one imported VireoPOS receipt: same total, closest time within
-- settings.late_minutes, and each receipt covers one stamp only, so a sale stamped twice
-- leaves one stamp without a receipt. Only days with imported receipts are checked.
create or replace function public._match_stamps(p_since timestamptz)
returns table (sale_id bigint, pos_key text, problem text)
language plpgsql stable security definer set search_path = public
as $$
declare
  st settings := public._cfg(); r record; pk text; pcust text; used text[] := '{}';
begin
  for r in
    select x.id, x.created_at, x.total, coalesce(pf.full_name, '') || ' ' || coalesce(pf.username, '') as names
    from sales x left join profiles pf on pf.id = x.member_id
    where x.member_id is not null and x.reversed_at is null and x.created_at >= p_since
      and public._local(x.created_at)::date in (select distinct public._local(sold_at)::date from pos_receipts)
    order by x.created_at
  loop
    select pr.receipt_key, pr.customer into pk, pcust from pos_receipts pr
     where pr.total = r.total
       and abs(extract(epoch from (pr.sold_at - r.created_at))) <= st.late_minutes * 60
       and not (pr.receipt_key = any (used))
     order by abs(extract(epoch from (pr.sold_at - r.created_at)))
     limit 1;
    sale_id := r.id;
    pos_key := pk;
    if pk is null then
      problem := 'tidak_ada_struk_cocok';
    else
      used := used || pk;
      problem := case when public._name_differs(pcust, r.names) then 'nama_beda' end;
    end if;
    return next;
  end loop;
end $$;

-- Ringkasan (Glenn, 12 Nov 2026): the last p_days days, or a custom range p_from..p_to (whole
-- days in the booth's time zone, at most 366), plus a per-day review ('daily').
drop function if exists public.owner_dashboard(int);
create or replace function public.owner_dashboard(p_days int default 30, p_from date default null, p_to date default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  s settings := public._cfg();
  since timestamptz;
  until timestamptz := now();
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
    select x.*, public._local(x.created_at) as lt from sales x
    where x.created_at >= since and x.created_at < until and x.reversed_at is null
  ),
  rd as (select r.*, public._local(r.created_at)::date as ld from redemptions r where r.created_at >= since and r.created_at < until and r.reversed_at is null),
  item_rows as (
    select sl.member_id, e->>'name' as name, greatest(coalesce((e->>'qty')::int, 1), 1) as qty
    from sl cross join lateral jsonb_array_elements(sl.items) e
  ),
  visits as (
    select member_id, created_at,
           created_at - lag(created_at) over (partition by member_id order by created_at) as gap
    from sales where member_id is not null and reversed_at is null
  ),
  last_visit as (
    select member_id, max(created_at) as last_at, count(*) as n from sales
    where member_id is not null and reversed_at is null group by member_id
  ),
  matched as (
    select sl.id, sl.created_at, sl.total, sl.stamps, pm.full_name as member,
           p.receipt_no as pos_no, p.sold_at, p.total as pos_total, p.customer as pos_customer, mt.problem
    from public._match_stamps(since) mt
    join sl on sl.id = mt.sale_id
    left join pos_receipts p on p.receipt_key = mt.pos_key
    left join profiles pm on pm.id = sl.member_id
  ),
  -- Per-day figures grouped once (12 Nov 2026: per-day subqueries took seconds over a year).
  sd as (select sl.lt::date as d, count(*) as sales, count(*) filter (where sl.member_id is not null) as member_sales,
           coalesce(sum(sl.total), 0) as revenue, coalesce(sum(sl.stamps), 0) as stamps from sl group by 1),
  rdd as (select rd.ld as d, count(*) as n from rd group by 1),
  nmd as (select public._local(pr.created_at)::date as d, count(*) as n from profiles pr
           where pr.role = 'member' and pr.deleted_at is null and pr.created_at >= since - interval '1 day' and pr.created_at < until + interval '1 day'
           group by 1)
  select json_build_object(
    'days', (d_to - d_from) + 1, 'from', d_from, 'to', d_to, 'custom', p_from is not null,
    'daily', (select json_agg(json_build_object('date', g.d::date,
        'sales', coalesce(sd.sales, 0), 'member_sales', coalesce(sd.member_sales, 0),
        'revenue', coalesce(sd.revenue, 0), 'stamps', coalesce(sd.stamps, 0),
        'redemptions', coalesce(rdd.n, 0), 'new_members', coalesce(nmd.n, 0))
        order by g.d desc)
      from generate_series(d_from, d_to, interval '1 day') g(d)
      left join sd on sd.d = g.d::date left join rdd on rdd.d = g.d::date left join nmd on nmd.d = g.d::date),
    'settings', json_build_object('rupiah_per_stamp', s.rupiah_per_stamp, 'late_minutes', s.late_minutes),
    'totals', json_build_object(
      'sales', (select count(*) from sl),
      'member_sales', (select count(*) from sl where member_id is not null),
      'revenue', (select coalesce(sum(total), 0) from sl),
      'stamps', (select coalesce(sum(stamps), 0) from sl),
      'redemptions', (select count(*) from rd),
      'welcome_used', (select count(*) from rd where kind = 'welcome'),
      'birthday_used', (select count(*) from rd where kind = 'ulang_tahun'),
      'new_members', (select count(*) from profiles where role = 'member' and deleted_at is null and created_at >= since and created_at < until),
      'members', (select count(*) from profiles where role = 'member' and deleted_at is null),
      'active_members', (select count(distinct member_id) from sl where member_id is not null),
      'avg_days_between_visits', (select round((extract(epoch from avg(gap)) / 86400)::numeric, 1) from visits where gap is not null and created_at >= since)
    ),
    'heatmap', coalesce((select json_agg(json_build_object('dow', d, 'hour', h, 'n', n)) from (
      select extract(isodow from lt)::int as d, extract(hour from lt)::int as h, count(*) as n
      from sl group by 1, 2) hm), '[]'),
    'top_items', coalesce((select json_agg(t order by t.qty desc) from (
      select name, sum(qty) as qty,
        (select count(*) from (select member_id from item_rows i2 where i2.name = i.name and i2.member_id is not null
                               group by member_id having count(*) >= 2) rr) as regulars
      from item_rows i group by name) t), '[]'),
    'gender', coalesce((select json_agg(json_build_object('key', coalesce(gender, 'kosong'), 'n', n)) from (
      select gender, count(*) as n from sl group by gender) g), '[]'),
    'age', coalesce((select json_agg(json_build_object('key', coalesce(age_range, 'kosong'), 'n', n)) from (
      select age_range, count(*) as n from sl group by age_range) a), '[]'),
    'staff', coalesce((select json_agg(st order by st.sales desc) from (
      select p.full_name, p.email, p.whatsapp,
        (select count(*) from sl where sl.staff_id = p.id) as sales,
        (select coalesce(sum(stamps), 0) from sl where sl.staff_id = p.id) as stamps,
        (select count(*) from rd where rd.staff_id = p.id) as redemptions,
        (select count(*) from sl where sl.staff_id = p.id and cardinality(sl.flags) > 0) as flagged
      from profiles p where p.role in ('staff', 'manager', 'owner') and p.deleted_at is null) st), '[]'),
    'lapsed', coalesce((select json_agg(l order by l.last_at) from (
      select p.full_name, case when p.marketing_opt_in then p.whatsapp end as whatsapp, lv.last_at, lv.n as visits
      from last_visit lv join profiles p on p.id = lv.member_id
      where p.deleted_at is null and lv.last_at < now() - interval '30 days'
        and lv.last_at >= now() - interval '120 days'
      limit 50) l), '[]'),
    'flags', coalesce((select json_agg(fl order by fl.created_at desc) from (
      select sl.id, sl.receipt_no, sl.total, sl.stamps, sl.created_at, sl.flags,
             public._first_name(m.full_name) as member, st.full_name as staff
      from sl left join profiles m on m.id = sl.member_id left join profiles st on st.id = sl.staff_id
      where cardinality(sl.flags) > 0 order by sl.created_at desc limit 50) fl), '[]'),
    'mismatches', coalesce((select json_agg(mm order by mm.created_at desc) from (
      select * from matched where problem is not null limit 100) mm), '[]'),
    'matched_days', (select count(distinct public._local(sold_at)::date) from pos_receipts where sold_at >= since and sold_at < until),
    'last_backup', (select max(created_at) from audit_log where action = 'unduh_cadangan'),
    'undo', coalesce((select json_agg(u order by u.created_at) from (
      select u.id, u.reason, u.created_at, rq.full_name as requested_by,
        case when u.sale_id is not null then 'penjualan' else 'penukaran' end as kind,
        coalesce(sa.receipt_no, '') as receipt_no, sa.total, sa.stamps, d.reward_label,
        public._first_name(coalesce(ms.full_name, md.full_name)) as member
      from undo_requests u
      left join profiles rq on rq.id = u.requested_by
      left join sales sa on sa.id = u.sale_id left join profiles ms on ms.id = sa.member_id
      left join redemptions d on d.id = u.redemption_id left join profiles md on md.id = d.member_id
      where u.status = 'menunggu') u), '[]')
  ));
end $$;

create or replace function public.owner_sales(p_limit int default 100) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select s.id, s.receipt_no, s.total, s.stamps, s.items, s.gender, s.age_range, s.via, s.flags,
           s.created_at, s.reversed_at, m.full_name as member, st.full_name as staff
    from sales s left join profiles m on m.id = s.member_id left join profiles st on st.id = s.staff_id
    order by s.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 1000)) x), '[]');
end $$;

create or replace function public.owner_import_receipts(p_rows jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); n int;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Data struk tidak valid.'; end if;
  insert into pos_receipts (receipt_key, receipt_no, sold_at, total, customer)
  select upper(regexp_replace(e->>'receipt_no', '[^A-Za-z0-9]', '', 'g')), trim(e->>'receipt_no'),
         (e->>'sold_at')::timestamptz, nullif(e->>'total', '')::int, nullif(trim(coalesce(e->>'customer', '')), '')
  from jsonb_array_elements(p_rows) e
  where coalesce(e->>'receipt_no', '') <> '' and coalesce(e->>'sold_at', '') <> ''
  on conflict (receipt_key) do update set sold_at = excluded.sold_at, total = excluded.total,
    customer = excluded.customer, imported_at = now();
  get diagnostics n = row_count;
  perform public._log('impor_struk', jsonb_build_object('rows', n));
  return json_build_object('imported', n);
end $$;

create or replace function public.owner_decide_undo(p_id bigint, p_approve boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa memutuskan pembatalan.'); u undo_requests;
begin
  select * into u from undo_requests where id = p_id and status = 'menunggu' for update;
  if u.id is null then raise exception 'Permintaan ini sudah diputuskan.'; end if;
  -- 13 Nov 2026: a manager can't decide their own request (the owner decides it), and a
  -- sale or reward that belongs to a till order is undone through Batal/Refund pesanan,
  -- so the order, cash and stock are undone with it.
  if u.requested_by = me and (select role from profiles where id = me) <> 'owner' then
    raise exception 'Permintaan Anda sendiri diputuskan oleh pemilik.';
  end if;
  if p_approve and to_regclass('public.pos_orders') is not null then
    if exists (select 1 from pos_orders where u.sale_id is not null and sale_id = u.sale_id)
       or exists (select 1 from pos_orders o join redemptions r on r.order_id = o.id where r.id = u.redemption_id) then
      raise exception 'Ini bagian dari pesanan kasir. Batalkan lewat Batal/Refund pesanan di kasir.';
    end if;
  end if;
  if p_approve then
    if u.sale_id is not null then
      update sales set reversed_at = now(), reversed_by = me where id = u.sale_id and reversed_at is null;
      perform public._sync_cycles((select member_id from sales where id = u.sale_id));
    else
      update redemptions set reversed_at = now(), reversed_by = me where id = u.redemption_id and reversed_at is null;
      perform public._sync_cycles((select member_id from redemptions where id = u.redemption_id));
    end if;
  end if;
  update undo_requests set status = case when p_approve then 'disetujui' else 'ditolak' end,
    decided_by = me, decided_at = now() where id = u.id;
  perform public._log(case when p_approve then 'setujui_batal' else 'tolak_batal' end, jsonb_build_object('request', u.id));
end $$;

create or replace function public.owner_people() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(x order by x.role desc, x.full_name) from (
    select pr.id, pr.role, pr.full_name, pr.username, pr.email, pr.whatsapp, pr.created_at, pr.id = me as is_me,
      pr.must_set_password as start_password, pr.employer
    from profiles pr where pr.role in ('staff', 'manager', 'owner') and pr.deleted_at is null) x), '[]');
end $$;

drop function if exists public.owner_set_role(text, text);
create or replace function public.owner_set_role(p_phone text, p_role text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  if p_role not in ('member', 'staff', 'manager', 'owner') then raise exception 'Peran tidak dikenal.'; end if;
  select * into p from profiles where whatsapp = public._wa(p_phone) and deleted_at is null;
  if p.id is null then
    raise exception 'Nomor % belum pernah masuk. Minta orangnya masuk sekali di halaman kasir, lalu coba lagi.', trim(p_phone);
  end if;
  if p.id = me and p_role <> 'owner' then raise exception 'Anda tidak bisa mencabut akses pemilik dari akun sendiri.'; end if;
  -- Staff and managers keep their member card; only owner accounts can't hold stamps.
  if p_role = 'owner' and public._total(p.id) > 0 then
    raise exception 'Nomor ini punya stempel member. Akun pemilik perlu memakai nomor lain.';
  end if;
  update profiles set role = p_role where id = p.id;
  -- A member card that becomes a work account: whoever is signed in on it is signed out (14 Nov 2026).
  if p.role = 'member' and p_role <> 'member' then perform public._end_sessions(p.id); end if;
  perform public._log('ubah_peran', jsonb_build_object('whatsapp', p.whatsapp, 'role', p_role));
end $$;

-- Staff accounts (Glenn, 13 Nov 2026): the full name, the username FrontLastname (the
-- first and last word of the name; logins ignore case, so KevinHadiyan and kevinhadiyan
-- both work) and the starting password 123456, which the staff member must replace on
-- first sign-in at /staf (must_set_password, set_first_password). The account is also
-- their member card. A number that already has a member card becomes that person's staff
-- account, stamps kept. p_employer: who they work for at the booth (Hanashuya or
-- Kaaramel Juice, profiles.employer). A removed number is switched back on.
create or replace function public._staff_username(p_name text) returns text
language sql immutable
as $$
  select left(case when array_length(w, 1) > 1 then w[1] || w[array_length(w, 1)] else w[1] end, 20)
  from (select regexp_split_to_array(lower(regexp_replace(trim(coalesce(p_name, '')), '[^A-Za-z ]', '', 'g')), '\s+') w) x
$$;

create or replace function public._set_start_password(p_user uuid) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
begin
  update auth.users set encrypted_password = extensions.crypt('123456', extensions.gen_salt('bf')), updated_at = now()
  where id = p_user;
  perform public._end_sessions(p_user);
  update profiles set must_set_password = true where id = p_user;
end $$;

drop function if exists public.owner_add_staff(text, text, text, text);
drop function if exists public.owner_add_staff(text, text, text, text, text);
create or replace function public.owner_add_staff(p_name text, p_username text, p_phone text, p_password text default null,
  p_role text default 'staff', p_employer text default 'Hanashuya') returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  wa text := public._wa(p_phone); un text := public._clean_username(coalesce(nullif(trim(p_username), ''), public._staff_username(p_name)));
  emp text := coalesce(nullif(trim(p_employer), ''), 'Hanashuya'); p profiles; uid uuid; was_member boolean := false;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Isi nama lengkap staf.'; end if;
  if un ~ '^[0-9]+$' then raise exception 'Username tidak boleh hanya angka.'; end if;
  if un is null or un !~ '^[a-z0-9._]{3,20}$' then raise exception 'Username 3 sampai 20 karakter: huruf, angka, titik, atau garis bawah.'; end if;
  if wa is null or wa !~ '^628[0-9]{8,12}$' then raise exception 'Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890.'; end if;
  if p_role not in ('staff', 'manager', 'owner') then raise exception 'Peran tidak dikenal.'; end if;
  -- Staff and managers start with 123456; an owner account needs its own password.
  if p_role = 'owner' and length(coalesce(p_password, '')) < 8 then raise exception 'Akun pemilik perlu password minimal 8 karakter.'; end if;
  select * into p from profiles where whatsapp = wa order by deleted_at nulls first limit 1;
  if p.id is not null and p.deleted_at is null and p.role <> 'member' then raise exception 'Nomor ini sudah terdaftar sebagai staf.'; end if;
  if exists (select 1 from profiles where username = un and deleted_at is null and id is distinct from p.id) then
    raise exception 'Username % sudah dipakai. Tulis username lain.', un;
  end if;
  if p.id is not null then
    was_member := p.deleted_at is null;
    if p_role = 'owner' and was_member and public._total(p.id) > 0 then raise exception 'Nomor ini punya stempel member. Akun pemilik perlu memakai nomor lain.'; end if;
    update profiles set deleted_at = null, role = p_role, full_name = trim(p_name), username = un, adult_confirmed = true,
      employer = emp where id = p.id;
    update auth.users set banned_until = null where id = p.id;
    uid := p.id;
  else
    uid := public._create_login(wa, coalesce(p_password, '12345678'), un, trim(p_name));
    -- A staff card gets no new-member 50%; that voucher is for customers.
    update profiles set role = p_role, adult_confirmed = true, welcome_voucher = false, employer = emp where id = uid;
  end if;
  -- Both end every session on the account, so whoever registered a member card on this
  -- number first is signed out once it becomes a work account (14 Nov 2026).
  if p_role = 'owner' then perform public._set_password(uid, p_password); perform public._end_sessions(uid);
  else perform public._set_start_password(uid); end if;
  perform public._log('tambah_staf', jsonb_build_object('whatsapp', wa, 'username', un, 'role', p_role, 'employer', emp, 'dari_kartu_member', was_member));
  return json_build_object('id', uid, 'whatsapp', wa, 'username', un, 'start_password', case when p_role <> 'owner' then '123456' end,
    'from_member', was_member);
end $$;

-- ---------------------------------------------------------------- kasir tablet account
-- The owner makes the till's own login (Glenn, 13 Nov 2026): a username and a password the
-- owner types, no WhatsApp number. One active kasir tablet account at a time; removing it
-- (owner_remove_kasir) frees the slot. A removed username is switched back on.
create or replace function public.owner_add_kasir(p_username text, p_password text, p_name text default null) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  un text := public._clean_username(p_username); nm text := coalesce(nullif(trim(coalesce(p_name, '')), ''), 'Kasir tablet');
  p profiles; uid uuid;
begin
  if un ~ '^[0-9]+$' then raise exception 'Username tidak boleh hanya angka.'; end if;
  if un is null or un !~ '^[a-z0-9._]{3,20}$' then raise exception 'Username 3 sampai 20 karakter: huruf kecil, angka, titik, atau garis bawah.'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password minimal 8 karakter.'; end if;
  if exists (select 1 from profiles where role = 'kasir' and deleted_at is null) then
    raise exception 'Sudah ada akun kasir tablet. Hapus yang lama dulu kalau mau membuat yang baru.';
  end if;
  if exists (select 1 from profiles where username = un and deleted_at is null) then raise exception 'Username sudah dipakai.'; end if;
  select * into p from profiles where username = un and role = 'kasir' and deleted_at is not null order by deleted_at desc limit 1;
  if p.id is not null then
    update profiles set deleted_at = null, full_name = nm where id = p.id;
    update auth.users set banned_until = null where id = p.id;
    perform public._set_password(p.id, p_password);
    perform public._end_sessions(p.id);
    uid := p.id;
  else
    perform set_config('hanashuya.kasir_account', 'on', true);
    uid := public._create_login(null, p_password, un, nm);
    perform set_config('hanashuya.kasir_account', '', true);
    update profiles set role = 'kasir', adult_confirmed = true where id = uid;
  end if;
  perform public._log('tambah_kasir_tablet', jsonb_build_object('username', un));
  return json_build_object('id', uid, 'username', un, 'full_name', nm);
end $$;

create or replace function public.owner_kasir_accounts() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(json_build_object('id', id, 'username', username, 'full_name', full_name, 'created_at', created_at)
    order by created_at) from profiles where role = 'kasir' and deleted_at is null), '[]');
end $$;

create or replace function public.owner_remove_kasir(p_id uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  select * into p from profiles where id = p_id and role = 'kasir' and deleted_at is null;
  if p.id is null then raise exception 'Akun kasir tablet tidak ditemukan.'; end if;
  update profiles set deleted_at = now() where id = p.id;
  update auth.users set banned_until = now() + interval '100 years' where id = p.id;
  perform public._log('hapus_kasir_tablet', jsonb_build_object('username', p.username));
end $$;

create or replace function public.owner_kasir_password(p_id uuid, p_password text) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  select * into p from profiles where id = p_id and role = 'kasir' and deleted_at is null;
  if p.id is null then raise exception 'Akun kasir tablet tidak ditemukan.'; end if;
  perform public._set_password(p.id, p_password);
  perform public._end_sessions(p.id);
  perform public._log('ganti_password_kasir_tablet', jsonb_build_object('username', p.username));
end $$;

-- Removes a staff account's access. The account is switched off, not deleted, so
-- past sales still show who recorded them.
create or replace function public.owner_remove_staff(p_phone text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  select * into p from profiles where whatsapp = public._wa(p_phone) and deleted_at is null and role in ('staff', 'manager', 'owner');
  if p.id is null then raise exception 'Akun staf dengan nomor itu tidak ditemukan.'; end if;
  if p.id = me then raise exception 'Anda tidak bisa menghapus akun sendiri.'; end if;
  update profiles set deleted_at = now() where id = p.id;
  update auth.users set banned_until = now() + interval '100 years' where id = p.id;
  perform public._log('hapus_staf', jsonb_build_object('whatsapp', p.whatsapp));
end $$;

-- Sets a new password for a staff or owner account.
drop function if exists public.owner_reset_pin(text, text);
create or replace function public.owner_reset_password(p_phone text, p_password text) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  select * into p from profiles where whatsapp = public._wa(p_phone) and deleted_at is null and role in ('staff', 'manager', 'owner');
  if p.id is null then raise exception 'Akun staf dengan nomor itu tidak ditemukan.'; end if;
  perform public._set_password(p.id, p_password);
  -- Signed out everywhere; on the owner's own number this device stays signed in.
  perform public._end_sessions(p.id, p.id = me);
  perform public._log('ganti_password_staf', jsonb_build_object('whatsapp', p.whatsapp));
end $$;

-- Finds accounts by name, username or WhatsApp number, for the "Bantuan akun" tab.
create or replace function public.owner_find_account(p_query text) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); q text := lower(trim(coalesce(p_query, '')));
begin
  if length(q) < 3 then return '[]'; end if;
  return coalesce((select json_agg(x) from (
    select full_name, username, whatsapp, role, created_at, birth_date from profiles
    where deleted_at is null
      and (username like '%' || q || '%' or lower(full_name) like '%' || q || '%'
        or (length(regexp_replace(q, '\D', '', 'g')) >= 4 and whatsapp like '%' || regexp_replace(public._wa(q), '^62', '') || '%'))
    order by full_name limit 10) x), '[]');
end $$;

-- Members can't change their own birth date once it is set (it decides the birthday
-- voucher). The owner corrects it here after checking, for example, an ID card.
create or replace function public.owner_set_birth_date(p_login text, p_birth_date date) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles := public._find_login(p_login);
begin
  if p.id is null or p.role not in ('member', 'staff', 'manager') then raise exception 'Akun member tidak ditemukan.'; end if;
  if p_birth_date is null then raise exception 'Isi tanggal lahir.'; end if;
  if age(current_date, p_birth_date) < interval '17 years' then raise exception 'Kartu member hanya untuk usia 17 tahun ke atas.'; end if;
  -- birth_date_set_at: set the first time only; a correction keeps it (14 Nov 2026).
  update profiles set birth_date = p_birth_date, age_range = public._age_range(p_birth_date),
    birth_date_set_at = coalesce(birth_date_set_at, now()) where id = p.id;
  perform public._log('ubah_tanggal_lahir', jsonb_build_object('member', p.id, 'dari', p.birth_date, 'jadi', p_birth_date));
end $$;

-- The owner makes a reset code to send by hand when the automatic WhatsApp is not set up.
create or replace function public.owner_issue_reset_code(p_login text) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); r json;
begin
  r := public._issue_reset_code(p_login, me);
  if r is null then raise exception 'Akun tidak ditemukan.'; end if;
  return r;
end $$;

-- Everything needed to rebuild the member program, for the owner's weekly download
-- (Pengaturan > Cadangan data). Supabase Free keeps no automatic backups. Leaves out
-- secrets: password hashes live in auth, reset codes and the QR signing key are skipped.
create or replace function public.owner_backup() returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); out json;
begin
  out := json_build_object(
    'dibuat', now(), 'versi', 1,
    'pengaturan', (select json_build_object('card_size', card_size, 'rupiah_per_stamp', rupiah_per_stamp,
      'max_stamps_per_day', max_stamps_per_day, 'open_time', open_time, 'close_time', close_time,
      'late_minutes', late_minutes, 'tz', tz, 'auth_domain', auth_domain,
      'terms_version', terms_version, 'privacy_version', privacy_version) from settings where id = 1),
    'aturan_hadiah', coalesce((select json_agg(r order by r.slot) from rewards r), '[]'),
    'produk', coalesce((select json_agg(m order by m.id) from menu_items m), '[]'),
    'akun', coalesce((select json_agg(json_build_object('id', p.id, 'role', p.role, 'full_name', p.full_name,
      'username', p.username, 'whatsapp', p.whatsapp, 'birth_date', p.birth_date, 'gender', p.gender,
      'age_range', p.age_range, 'card_code', p.card_code, 'marketing_opt_in', p.marketing_opt_in,
      'adult_confirmed', p.adult_confirmed, 'created_at', p.created_at, 'deleted_at', p.deleted_at)
      order by p.created_at) from profiles p), '[]'),
    'penjualan', coalesce((select json_agg(x order by x.id) from sales x), '[]'),
    'hadiah_dipakai', coalesce((select json_agg(x order by x.id) from redemptions x), '[]'),
    'kartu_penuh', coalesce((select json_agg(x order by x.member_id, x.cycle) from card_cycles x), '[]'),
    'persetujuan', coalesce((select json_agg(x order by x.id) from consent_log x), '[]'),
    'pembatalan', coalesce((select json_agg(x order by x.id) from undo_requests x), '[]'),
    'struk_vireopos', coalesce((select json_agg(x order by x.sold_at) from pos_receipts x), '[]'),
    'promo', coalesce((select json_agg(x order by x.id) from campaigns x), '[]'),
    'catatan_aktivitas', coalesce((select json_agg(x order by x.id) from audit_log x), '[]'));
  perform public._log('unduh_cadangan', jsonb_build_object(
    'akun', (select count(*) from profiles), 'penjualan', (select count(*) from sales)));
  return out;
end $$;

create or replace function public.owner_settings() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); s settings := public._cfg();
begin
  return json_build_object('open_time', to_char(s.open_time, 'HH24:MI'), 'close_time', to_char(s.close_time, 'HH24:MI'),
    'rupiah_per_stamp', s.rupiah_per_stamp, 'max_stamps_per_day', s.max_stamps_per_day, 'late_minutes', s.late_minutes,
    'menu', coalesce((select json_agg(m order by m.sort, m.id) from menu_items m), '[]'),
    'campaigns', coalesce((select json_agg(c order by c.starts_on desc) from campaigns c), '[]'),
    'last_backup', (select max(created_at) from audit_log where action = 'unduh_cadangan'));
end $$;

create or replace function public.owner_save_settings(
  p_open text, p_close text, p_rupiah int, p_max int, p_late int
) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  if p_open::time >= p_close::time then raise exception 'Jam tutup harus setelah jam buka.'; end if;
  update settings set open_time = p_open::time, close_time = p_close::time,
    rupiah_per_stamp = p_rupiah, max_stamps_per_day = p_max, late_minutes = p_late where id = 1;
  perform public._log('ubah_pengaturan', jsonb_build_object('open', p_open, 'close', p_close, 'rupiah', p_rupiah, 'max', p_max, 'late', p_late));
end $$;

create or replace function public.owner_save_menu_item(p_id int, p_name text, p_price int, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Isi nama produk.'; end if;
  if p_id is null then
    insert into menu_items (name, price, sort, active)
    values (trim(p_name), p_price, coalesce((select max(sort) + 1 from menu_items), 1), coalesce(p_active, true));
  else
    update menu_items set name = trim(p_name), price = p_price, active = coalesce(p_active, true) where id = p_id;
  end if;
end $$;

create or replace function public.owner_save_campaign(
  p_id bigint, p_title text, p_body text, p_starts date, p_ends date, p_active boolean
) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  if coalesce(trim(p_title), '') = '' then raise exception 'Isi judul kampanye.'; end if;
  if p_ends < p_starts then raise exception 'Tanggal selesai harus setelah tanggal mulai.'; end if;
  if p_id is null then
    insert into campaigns (title, body, starts_on, ends_on, active)
    values (trim(p_title), coalesce(p_body, ''), p_starts, p_ends, coalesce(p_active, true));
  else
    update campaigns set title = trim(p_title), body = coalesce(p_body, ''), starts_on = p_starts,
      ends_on = p_ends, active = coalesce(p_active, true) where id = p_id;
  end if;
end $$;

-- ---------------------------------------------------------------- permissions
-- Helpers are only for the functions above, never for the browser.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- The login, sign-up and reset forms run before anyone is signed in.
grant execute on function public.login_handle(text), public.signup_check(text, text), public.reset_with_code(text, text, text) to anon;
-- The wa-reset Edge Function makes codes with the service role key.
grant execute on function public._issue_reset_code(text, uuid) to service_role;

revoke all on public.settings, public.redeem_codes, public.scan_tickets, public.undo_requests,
  public.pos_receipts, public.audit_log, public.password_resets, public.consent_log, public.welcome_given from anon, authenticated;
revoke all on public.card_cycles, public.voucher_batches, public.voucher_codes from anon, authenticated;

-- Fill card_cycles for every member who already has stamps (safe to repeat).
select public._sync_cycles(id) from public.profiles where role = 'member' and deleted_at is null;
