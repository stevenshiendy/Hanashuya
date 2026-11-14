-- Hanashuya POS (the till): products, orders, payments, shifts, voids and refunds.
-- Task 4 of POSDEVELOPMENT.md. Run schema.sql first, then this file, in the Supabase
-- SQL Editor. Re-running is safe: tables are only created when missing and functions
-- are replaced. Kept apart from schema.sql so the member card can keep being updated
-- while the till is switched on later, one part at a time.
--
-- Same rules as schema.sql: every write goes through a security-definer function,
-- every table has row security and no direct access from the browser, and prices,
-- discounts and totals are always worked out here, never trusted from the tablet.
-- A paid POS order also writes its row in `sales` in the same transaction, so stamps,
-- card cycles, rewards and vouchers keep working through the existing functions.
--
-- Not decided yet (POSDEVELOPMENT.md, open questions), and how this file handles it:
--   3  Flavour surcharge on Signature 1 pcs: menu_items.flavour_surcharge is 0 for it
--      and Rp3.000 for the boxes. The owner can change it. One box = one flavour.
--   4  Which product gets a "1 produk" promo: the cashier picks the line; with only one
--      product line it is picked by itself.
--   5  BOGO after 19.00: not in the till. Staff keep doing it by hand for now.
--   11 Staff PIN: the order records who served (a name tap). No PIN yet.

-- ---------------------------------------------------------------- outlets and channels
create table if not exists public.pos_outlets (
  id text primary key,
  name text not null,
  active boolean not null default true
);
insert into public.pos_outlets (id, name) values ('papaya-bdg', 'Papaya Fresh Gallery Bandung')
on conflict (id) do nothing;

-- Every order carries a channel from the start, so delivery apps need no rebuild later.
create table if not exists public.pos_channels (
  id text primary key,
  label text not null,
  delivery boolean not null default false,
  sort int not null default 0,
  active boolean not null default true
);
insert into public.pos_channels (id, label, delivery, sort, active) values
  ('toko', 'Di booth', false, 1, true),
  ('grabfood', 'GrabFood', true, 2, false),
  ('gofood', 'GoFood', true, 3, false),
  ('shopeefood', 'ShopeeFood', true, 4, false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- products
-- The till uses menu_items, the same list the owner already edits, with a short code
-- and what each product is. Promos are never products.
alter table public.menu_items add column if not exists code text;
alter table public.menu_items add column if not exists is_box boolean not null default false;
alter table public.menu_items add column if not exists needs_flavour boolean not null default true;
alter table public.menu_items add column if not exists flavour_surcharge int not null default 0 check (flavour_surcharge >= 0);
-- pos_only products (the paper bag) stay out of the old cashier page's item list.
alter table public.menu_items add column if not exists pos_only boolean not null default false;
-- The name on the till and the receipt, as on the printed menu ("Signature 1 pcs").
alter table public.menu_items add column if not exists pos_name text;
-- 12 Nov 2026 (Glenn, from the VireoPOS comparison): on_till hides a product's tile on the
-- till without switching it off; archived_at keeps old products out of the owner's list.
-- An archived product is never active. Its past sales stay as they are.
alter table public.menu_items add column if not exists on_till boolean not null default true;
alter table public.menu_items add column if not exists archived_at timestamptz;
create unique index if not exists menu_items_code_once on public.menu_items (code) where code is not null;

update public.menu_items set code = 'sig1' where name = 'Signature 1 pc' and code is null;
update public.menu_items set code = 'sig6', is_box = true where name = 'Signature box isi 6' and code is null;
update public.menu_items set code = 'mini8', is_box = true where name = 'Mini choux box isi 8' and code is null;
update public.menu_items set code = 'mini15', is_box = true where name = 'Mini choux box isi 15' and code is null;
update public.menu_items set pos_name = case code when 'sig1' then 'Signature 1 pcs' when 'sig6' then 'Signature Box isi 6'
  when 'mini8' then 'Mini Box isi 8' when 'mini15' then 'Mini Box isi 15' end
 where pos_name is null and code in ('sig1', 'sig6', 'mini8', 'mini15');
-- Menu order as on the printed menu (Signature first, then Mini isi 15, then Mini isi 8).
-- Only swaps the first seed's order, so a later change by the owner stays.
update public.menu_items set sort = 3 where code = 'mini15' and sort = 4
  and exists (select 1 from public.menu_items where code = 'mini8' and sort = 3);
update public.menu_items set sort = 4 where code = 'mini8' and sort = 3
  and exists (select 1 from public.menu_items where code = 'mini15' and sort = 3);
-- "Selain Vanilla: +Rp3.000 per box" (printed menu). Set once; the owner changes it after.
update public.menu_items set flavour_surcharge = 3000 where code in ('sig6', 'mini8', 'mini15') and flavour_surcharge = 0
  and not exists (select 1 from audit_log where action = 'pos_ubah_produk');
-- Paper bag (Glenn, 11 Nov 2026): sold for Rp5.000, free with every 2 boxes, free but
-- always entered for delivery orders.
insert into public.menu_items (name, price, sort, active, code, is_box, needs_flavour, pos_only)
values ('Paper bag', 5000, 90, true, 'bag', false, false, true)
on conflict (name) do nothing;

-- Categories (Glenn, 12 Nov 2026): the till shows them as tabs above the products, like
-- VireoPOS. The owner adds, renames, orders and switches them off in Produk. Products are
-- ordered by their category's sort, then their own sort (menu_items.sort, within the category).
create table if not exists public.pos_categories (
  id serial primary key,
  name text not null unique,
  sort int not null default 0,
  active boolean not null default true
);
create unique index if not exists pos_categories_name_once on public.pos_categories (lower(name));
alter table public.pos_categories enable row level security;
revoke all on public.pos_categories from anon, authenticated;
-- The first three, only on the first run, so the owner's renames survive a re-run.
insert into public.pos_categories (name, sort)
select x.name, x.sort from (values ('Signature', 1), ('Mini Choux', 2), ('Lainnya', 3)) as x(name, sort)
 where not exists (select 1 from public.pos_categories);
alter table public.menu_items add column if not exists category_id int references public.pos_categories (id);
-- Only products without a category, so a product the owner moved stays where it is.
update public.menu_items m set category_id = c.id
  from (values ('sig1', 'Signature'), ('sig6', 'Signature'), ('mini15', 'Mini Choux'), ('mini8', 'Mini Choux'), ('bag', 'Lainnya')) as x(code, cat)
  join public.pos_categories c on c.name = x.cat
 where m.code = x.code and m.category_id is null;

drop policy if exists "read menu" on public.menu_items;
create policy "read menu" on public.menu_items for select to authenticated using (active and not pos_only);

create table if not exists public.pos_flavours (
  id text primary key,
  label text not null,
  surcharge boolean not null default true,
  sort int not null default 0,
  active boolean not null default true
);
insert into public.pos_flavours (id, label, surcharge, sort) values
  ('vanilla', 'Vanilla', false, 1),
  ('choco', 'Choco', true, 2),
  ('matcha', 'Matcha', true, 3),
  ('matcha_strawberry', 'Matcha Strawberry', true, 4)
on conflict (id) do nothing;

-- A different price on a delivery channel. No row = the menu price.
create table if not exists public.pos_channel_prices (
  channel_id text not null references public.pos_channels (id),
  product_id int not null references public.menu_items (id),
  price int not null check (price >= 0),
  primary key (channel_id, product_id)
);
-- ShopeeFood menu prices from the COGS workbook (5 Nov 2026). The channel is off until
-- delivery orders go through the till; the owner changes these in Produk.
insert into public.pos_channel_prices (channel_id, product_id, price)
select 'shopeefood', m.id, x.price
from (values ('sig1', 30000), ('sig6', 139000), ('mini15', 119000), ('mini8', 89000)) as x(code, price)
join public.menu_items m on m.code = x.code
on conflict do nothing;

-- ---------------------------------------------------------------- promo rules
-- How each reward and voucher works at the till.
--   persen         percent off every product in the order (paper bags excluded)
--   persen_satu    percent off one unit of one product line
--   gratis_produk  one unit of one product line free; pos_product limits which product
alter table public.rewards add column if not exists pos_rule text;
alter table public.rewards add column if not exists pos_value int;
update public.rewards set pos_rule = 'persen', pos_value = 10 where slot = 3 and pos_rule is null;
update public.rewards set pos_rule = 'persen', pos_value = 20 where slot = 7 and pos_rule is null;
update public.rewards set pos_rule = 'gratis_produk', pos_value = 100 where slot = 10 and pos_rule is null;
-- The product a printed voucher gives for free (Voucher Papaya: 1 Signature).
alter table public.voucher_batches add column if not exists pos_product text;
update public.voucher_batches set pos_product = 'sig1' where id = 'papaya-1' and pos_product is null;
-- Which POS order used a reward or voucher, so a void gives it back.
alter table public.redemptions add column if not exists order_id uuid;

-- ---------------------------------------------------------------- shifts and cash
create table if not exists public.pos_shifts (
  id bigint generated always as identity primary key,
  outlet_id text not null default 'papaya-bdg' references public.pos_outlets (id),
  opened_by uuid references public.profiles (id) on delete set null,
  opened_at timestamptz not null default now(),
  opening_cash int not null check (opening_cash >= 0),
  closed_by uuid references public.profiles (id) on delete set null,
  closed_at timestamptz,
  expected_cash int,
  counted_cash int,
  note text
);
create unique index if not exists pos_shifts_one_open on public.pos_shifts (outlet_id) where closed_at is null;

create table if not exists public.pos_cash_moves (
  id bigint generated always as identity primary key,
  shift_id bigint not null references public.pos_shifts (id),
  kind text not null check (kind in ('masuk', 'keluar')),
  amount int not null check (amount > 0),
  reason text not null,
  order_id uuid,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Blind cash (Glenn, 11 Nov 2026): staff never see the uang modal, what the drawer should
-- hold, or the difference. The owner sets the standard float; pos_open_shift uses it.
-- A difference beyond cash_flag_at is flagged 'selisih_kas' for the owner.
alter table public.settings add column if not exists cash_float int not null default 200000 check (cash_float between 0 and 10000000);
alter table public.settings add column if not exists cash_flag_at int not null default 10000 check (cash_flag_at >= 0);
alter table public.pos_shifts add column if not exists device text;
alter table public.pos_shifts add column if not exists float_source text not null default 'standar';
alter table public.pos_shifts add column if not exists denominations jsonb;
alter table public.pos_shifts add column if not exists flags text[] not null default '{}';
-- The rekap prints once per close from a staff account (Glenn, 11 Nov 2026); reprints are counted.
alter table public.pos_shifts add column if not exists printed_at timestamptz;
alter table public.pos_shifts add column if not exists printed_by uuid references public.profiles (id) on delete set null;
alter table public.pos_shifts add column if not exists reprints int not null default 0;
-- Setor: cash taken out of the drawer to the owner (managers and the owner only).
alter table public.pos_cash_moves drop constraint if exists pos_cash_moves_kind_check;
alter table public.pos_cash_moves add constraint pos_cash_moves_kind_check check (kind in ('masuk', 'keluar', 'setor'));

-- ---------------------------------------------------------------- orders
-- Receipt numbers: HS-YYMMDD-NNNN, the day's running number per outlet.
create table if not exists public.pos_receipt_counters (
  outlet_id text not null references public.pos_outlets (id),
  day date not null,
  last int not null,
  primary key (outlet_id, day)
);

-- id is made on the tablet, so an order sent twice (dropped connection) is stored once.
create table if not exists public.pos_orders (
  id uuid primary key,
  outlet_id text not null default 'papaya-bdg' references public.pos_outlets (id),
  channel_id text not null default 'toko' references public.pos_channels (id),
  receipt_no text not null unique,
  sale_day date not null,
  status text not null default 'dibayar',
  -- The account signed in on the tablet, and the person who served (picked by name).
  cashier_id uuid references public.profiles (id) on delete set null,
  served_by uuid references public.profiles (id) on delete set null,
  member_id uuid references public.profiles (id) on delete set null,
  via text check (via in ('qr', 'kode', 'nomor', 'daftar')),
  shift_id bigint references public.pos_shifts (id),
  subtotal int not null check (subtotal >= 0),
  discount int not null default 0 check (discount >= 0),
  total int not null check (total >= 0),
  promo_kind text,
  promo_label text,
  redemption_id bigint references public.redemptions (id),
  payment_method text check (payment_method in ('tunai', 'qris', 'platform', 'gratis')),
  cash_received int check (cash_received >= 0),
  change_given int check (change_given >= 0),
  sale_id bigint references public.sales (id),
  stamps int not null default 0,
  gender text,
  age_range text,
  flags text[] not null default '{}',
  sold_at timestamptz not null,
  client_at timestamptz,
  created_at timestamptz not null default now(),
  check (total = subtotal - discount)
);
-- Every Tunai payment keeps the cash received and the change given (change = received - total).
alter table public.pos_orders drop constraint if exists pos_orders_tunai_cash_check;
alter table public.pos_orders add constraint pos_orders_tunai_cash_check
  check (payment_method is distinct from 'tunai' or (cash_received is not null and change_given = cash_received - total));
-- Promo kinds (12 Nov 2026: SOP Bab 6 promo B Tebus Murah Rp1 and C BOGO Deals added).
alter table public.pos_orders drop constraint if exists pos_orders_promo_kind_check;
alter table public.pos_orders add constraint pos_orders_promo_kind_check
  check (promo_kind in ('stempel', 'welcome', 'ulang_tahun', 'kode', 'tebus_murah', 'bogo', 'promo', 'malam50', 'instruksi50'));
alter table public.redemptions drop constraint if exists redemptions_kind_check;
alter table public.redemptions add constraint redemptions_kind_check
  check (kind in ('stempel', 'welcome', 'ulang_tahun', 'kode', 'tebus_murah'));


-- Service charge and PBJT (Glenn, 14 Nov 2026: "for restaurants to enable or disable service charge and PBJT 10%").
-- PBJT makanan dan minuman is the regional tax of UU 1/2022 (HKPD), at most 10%, set by Perda Kota Bandung; food
-- served by a restaurant is not subject to PPN. Both are off until the owner turns them on (Pengaturan > Pajak dan
-- service, owner_set_charges). Service charge applies at the booth only, never to delivery-platform orders. PBJT is
-- worked out on the price after discount plus the service charge, either added on top of the price or already
-- inside it (pbjt_included). Each order keeps the amounts and rates it was sold with.
alter table public.settings add column if not exists service_on boolean not null default false;
alter table public.settings add column if not exists service_pct numeric(4,2) not null default 5;
alter table public.settings add column if not exists pbjt_on boolean not null default false;
alter table public.settings add column if not exists pbjt_pct numeric(4,2) not null default 10;
alter table public.settings add column if not exists pbjt_included boolean not null default false;
alter table public.settings drop constraint if exists settings_charges_check;
alter table public.settings add constraint settings_charges_check check (service_pct between 0 and 20 and pbjt_pct between 0 and 10);
alter table public.pos_orders add column if not exists service_charge int not null default 0 check (service_charge >= 0);
alter table public.pos_orders add column if not exists tax int not null default 0 check (tax >= 0);
alter table public.pos_orders add column if not exists tax_included boolean not null default false;
alter table public.pos_orders add column if not exists service_pct numeric(4,2);
alter table public.pos_orders add column if not exists tax_pct numeric(4,2);
alter table public.pos_orders drop constraint if exists pos_orders_check;
alter table public.pos_orders drop constraint if exists pos_orders_total_check;
alter table public.pos_orders add constraint pos_orders_total_check
  check (total = subtotal - discount + service_charge + case when tax_included then 0 else tax end);

-- BOGO Deals (SOP Bab 6 C): from 19.00, or earlier on a day a manager or the owner starts it.
alter table public.settings add column if not exists bogo_from time not null default '19:00';
create table if not exists public.pos_bogo_days (
  outlet_id text not null default 'papaya-bdg' references public.pos_outlets (id),
  day date not null,
  started_by uuid references public.profiles (id) on delete set null,
  started_at timestamptz not null default now(),
  primary key (outlet_id, day)
);
alter table public.pos_bogo_days enable row level security;
revoke all on public.pos_bogo_days from anon, authenticated;

-- Promos the owner sets up in the owner page, Promo tab (Glenn, 11 Nov 2026: VireoPOS has a
-- promo module; ours were all written into this file). One promo per order still holds.
-- kind 'persen' takes value % off the products it covers; 'rupiah' takes value rupiah off
-- them (never more than they cost). products null = every product except the paper bag.
-- days: ISO weekdays 1 (Senin) to 7 (Minggu), null = every day. time_from/time_to: the
-- hours it shows on the till, null = all day. per_member and quota count paid and waiting
-- orders; a cancelled order gives its use back.
create table if not exists public.pos_promos (
  id int generated always as identity primary key,
  name text not null check (length(trim(name)) between 2 and 40),
  kind text not null check (kind in ('persen', 'rupiah')),
  value int not null check (value > 0),
  products text[],
  min_spend int not null default 0 check (min_spend >= 0),
  days int[],
  time_from time,
  time_to time,
  starts_on date,
  ends_on date,
  member_only boolean not null default false,
  per_member int check (per_member > 0),
  quota int check (quota > 0),
  active boolean not null default true,
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (kind <> 'persen' or value <= 100),
  check (ends_on is null or starts_on is null or ends_on >= starts_on),
  check ((time_from is null) = (time_to is null) and (time_from is null or time_to > time_from))
);
alter table public.pos_promos enable row level security;
revoke all on public.pos_promos from anon, authenticated;
alter table public.pos_orders add column if not exists promo_id int references public.pos_promos (id);
-- Working offline (task 7, 11 Nov 2026): the number the tablet printed while the internet
-- was down (L + date + device + running number). The order gets its HS number when sent.
alter table public.pos_orders add column if not exists local_no text;
create index if not exists pos_orders_local_no on public.pos_orders (local_no) where local_no is not null;

-- QRIS reference (12 Nov 2026, from the VireoPOS comparison): optional, typed from GoPay Merchant.
alter table public.pos_orders add column if not exists payment_ref text;

-- Stamp bonus periods (12 Nov 2026, like VireoPOS Program Loyalti's "special period"):
-- between two dates, optionally only on some weekdays (1 = Monday ... 7 = Sunday), a
-- member's stamps on a paid POS order are multiplied (2x or 3x). The owner sets them up.
-- When two overlap, the higher multiplier wins.
create table if not exists public.stamp_boosts (
  id int generated always as identity primary key,
  name text not null check (length(trim(name)) between 1 and 60),
  starts_on date not null,
  ends_on date not null,
  days int[],
  multiplier int not null default 2 check (multiplier between 2 and 3),
  active boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
alter table public.stamp_boosts enable row level security;
revoke all on public.stamp_boosts from anon, authenticated;
alter table public.pos_orders add column if not exists stamp_boost_id int references public.stamp_boosts (id);

-- Komisi (12 Nov 2026, Glenn, like VireoPOS Komisi): rules the owner sets instead of the
-- fixed 1%. A rule covers one product (product_code) or all products (null), as a percent
-- of what the line was paid or as rupiah per unit, between two dates (ends_on null = open).
-- For each paid line the product's own rule wins over the all-products rule; the newest
-- wins among equals. Free paper bags never earn commission. It goes to the staff member
-- who served (served_by). Starts with one rule: 1% on everything, as before.
create table if not exists public.pos_commission_rules (
  id int generated always as identity primary key,
  name text not null check (length(trim(name)) between 1 and 60),
  product_code text,
  kind text not null check (kind in ('persen', 'rupiah')),
  value numeric(10, 2) not null check (value >= 0),
  starts_on date not null,
  ends_on date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
alter table public.pos_commission_rules enable row level security;
revoke all on public.pos_commission_rules from anon, authenticated;
insert into public.pos_commission_rules (name, product_code, kind, value, starts_on)
select 'Komisi standar 1%', null, 'persen', 1, date '2026-01-01'
 where not exists (select 1 from public.pos_commission_rules);

-- plpgsql, not sql: pos_order_items is created further down this file.
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
   where i.order_id = p_order and not i.free_bag and o.status = 'dibayar');
end $$;

create or replace function public.owner_commission_rules() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(json_build_object('id', r.id, 'name', r.name, 'product_code', r.product_code,
      'product', (select coalesce(m.pos_name, m.name) from menu_items m where m.code = r.product_code),
      'kind', r.kind, 'value', r.value, 'starts_on', r.starts_on, 'ends_on', r.ends_on, 'active', r.active)
    order by r.active desc, r.starts_on desc, r.id desc) from pos_commission_rules r), '[]');
end $$;

-- Add (p_id null) or change a rule. p: {name, product_code (null = semua), kind, value, starts_on, ends_on, active}.
create or replace function public.owner_save_commission_rule(p_id int, p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  n text := nullif(trim(coalesce(p->>'name', '')), ''); k text := p->>'kind'; v numeric; d1 date; d2 date;
  pc text := nullif(p->>'product_code', ''); rid int;
begin
  if n is null then raise exception 'Isi nama aturan komisi.'; end if;
  if k not in ('persen', 'rupiah') then raise exception 'Pilih persen atau rupiah per produk.'; end if;
  begin v := (p->>'value')::numeric; exception when others then v := null; end;
  if v is null or v < 0 or (k = 'persen' and v > 50) or (k = 'rupiah' and v > 100000) then raise exception 'Nilai komisi tidak valid.'; end if;
  begin d1 := (p->>'starts_on')::date; d2 := nullif(p->>'ends_on', '')::date; exception when others then raise exception 'Tanggal tidak valid.'; end;
  if d1 is null then raise exception 'Isi tanggal mulai.'; end if;
  if d2 is not null and d2 < d1 then raise exception 'Tanggal selesai harus sesudah tanggal mulai.'; end if;
  if pc is not null and not exists (select 1 from menu_items where code = pc) then raise exception 'Produk tidak dikenal.'; end if;
  if p_id is null then
    insert into pos_commission_rules (name, product_code, kind, value, starts_on, ends_on, active)
    values (n, pc, k, v, d1, d2, coalesce((p->>'active')::boolean, true)) returning id into rid;
  else
    update pos_commission_rules set name = n, product_code = pc, kind = k, value = v, starts_on = d1, ends_on = d2,
      active = coalesce((p->>'active')::boolean, active) where id = p_id returning id into rid;
    if rid is null then raise exception 'Aturan komisi tidak ditemukan.'; end if;
  end if;
  perform public._log('komisi_aturan_simpan', jsonb_build_object('id', rid, 'data', p));
  return json_build_object('id', rid);
end $$;

create or replace function public._stamp_boost_at(p_at timestamptz) returns stamp_boosts
language sql stable security definer set search_path = public
as $$
  select b.* from stamp_boosts b
   where b.active and public._local(p_at)::date between b.starts_on and b.ends_on
     and (b.days is null or cardinality(b.days) = 0 or extract(isodow from public._local(p_at))::int = any (b.days))
   order by b.multiplier desc, b.id limit 1
$$;

create or replace function public.owner_stamp_boosts() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(json_build_object('id', b.id, 'name', b.name, 'starts_on', b.starts_on, 'ends_on', b.ends_on,
      'days', b.days, 'multiplier', b.multiplier, 'active', b.active, 'note', b.note,
      'running', b.active and public._local(now())::date between b.starts_on and b.ends_on,
      'orders', (select count(*) from pos_orders o where o.stamp_boost_id = b.id and o.status = 'dibayar'),
      'extra_stamps', (select coalesce(sum(o.stamps - o.stamps / b.multiplier), 0) from pos_orders o where o.stamp_boost_id = b.id and o.status = 'dibayar'))
    order by b.starts_on desc, b.id desc) from stamp_boosts b), '[]');
end $$;

-- Add (p_id null) or change a bonus period. p: {name, starts_on, ends_on, days, multiplier, active, note}.
create or replace function public.owner_save_stamp_boost(p_id int, p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  n text := nullif(trim(coalesce(p->>'name', '')), ''); d1 date; d2 date; m int; dd int[]; bid int;
begin
  if n is null then raise exception 'Isi nama periode bonus.'; end if;
  begin d1 := (p->>'starts_on')::date; d2 := (p->>'ends_on')::date; exception when others then raise exception 'Tanggal tidak valid.'; end;
  if d1 is null or d2 is null or d2 < d1 then raise exception 'Tanggal selesai harus sama atau sesudah tanggal mulai.'; end if;
  if d2 - d1 > 366 then raise exception 'Periode bonus paling lama satu tahun.'; end if;
  m := coalesce((p->>'multiplier')::int, 2);
  if m not in (2, 3) then raise exception 'Pilih 2x atau 3x stempel.'; end if;
  if jsonb_typeof(p->'days') = 'array' then
    select array_agg(distinct x::int order by x::int) into dd from jsonb_array_elements_text(p->'days') x;
    if exists (select 1 from unnest(dd) v where v not between 1 and 7) then raise exception 'Hari tidak valid.'; end if;
  end if;
  if p_id is null then
    insert into stamp_boosts (name, starts_on, ends_on, days, multiplier, active, note)
    values (n, d1, d2, dd, m, coalesce((p->>'active')::boolean, true), nullif(trim(coalesce(p->>'note', '')), ''))
    returning id into bid;
  else
    update stamp_boosts set name = n, starts_on = d1, ends_on = d2, days = dd, multiplier = m,
      active = coalesce((p->>'active')::boolean, active), note = nullif(trim(coalesce(p->>'note', '')), '')
     where id = p_id returning id into bid;
    if bid is null then raise exception 'Periode bonus tidak ditemukan.'; end if;
  end if;
  perform public._log('bonus_stempel_simpan', jsonb_build_object('id', bid, 'data', p));
  return json_build_object('id', bid);
end $$;

-- 'menunggu' (11 Nov 2026): confirmed, waiting for payment; only manager or owner can cancel.
alter table public.pos_orders drop constraint if exists pos_orders_status_check;
alter table public.pos_orders add constraint pos_orders_status_check check (status in ('menunggu', 'dibayar', 'batal', 'refund'));
alter table public.pos_orders alter column payment_method drop not null;
alter table public.pos_orders drop constraint if exists pos_orders_paid_has_method;
alter table public.pos_orders add constraint pos_orders_paid_has_method check (status in ('menunggu', 'batal') or payment_method is not null);
create index if not exists pos_orders_day on public.pos_orders (outlet_id, sale_day);
create index if not exists pos_orders_shift on public.pos_orders (shift_id);
create index if not exists pos_orders_member on public.pos_orders (member_id, sold_at);
-- Looking an order up from its sales row (stamp history, stamp corrections), 12 Nov 2026.
create index if not exists pos_orders_sale on public.pos_orders (sale_id) where sale_id is not null;

create table if not exists public.pos_order_items (
  order_id uuid not null references public.pos_orders (id) on delete cascade,
  line int not null,
  product_id int not null references public.menu_items (id),
  product_code text,
  name text not null,
  flavour_id text references public.pos_flavours (id),
  qty int not null check (qty > 0),
  unit_price int not null check (unit_price >= 0),
  surcharge int not null default 0,
  line_total int not null check (line_total >= 0),
  discount int not null default 0 check (discount >= 0),
  free_bag boolean not null default false,
  primary key (order_id, line)
);

-- A void (batal, same visit) or refund (money back later) needs a manager or the owner.
create table if not exists public.pos_void_requests (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.pos_orders (id),
  kind text not null check (kind in ('batal', 'refund')),
  reason text not null,
  requested_by uuid references public.profiles (id) on delete set null,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak')),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists pos_void_one_open on public.pos_void_requests (order_id) where status = 'menunggu';

-- ---------------------------------------------------------------- till v2 (Glenn, 13 Nov 2026)
-- Order note: free text typed at Konfirmasi pesanan, shown in the order detail and on the receipt.
alter table public.pos_orders add column if not exists note text;
alter table public.pos_orders drop constraint if exists pos_orders_note_check;
alter table public.pos_orders add constraint pos_orders_note_check check (note is null or length(note) <= 200);
-- Pesanan atas nama (Glenn, 14 Nov 2026): the name staff type so they can call the customer
-- instead of a queue number. Kept on the order only (invoice, receipt, order history); it never
-- makes or changes a member.
alter table public.pos_orders add column if not exists customer_name text;
alter table public.pos_orders drop constraint if exists pos_orders_customer_name_check;
alter table public.pos_orders add constraint pos_orders_customer_name_check check (customer_name is null or length(customer_name) <= 40);
-- Diskon 50% instruksi: the manager or owner who told staff to give it (flagged for the owner).
alter table public.pos_orders add column if not exists promo_by uuid references public.profiles (id) on delete set null;
-- Partial refunds: what has gone back so far (rupiah) and per line (pieces).
alter table public.pos_orders add column if not exists refunded int not null default 0;
alter table public.pos_orders drop constraint if exists pos_orders_refunded_check;
alter table public.pos_orders add constraint pos_orders_refunded_check check (refunded between 0 and total);
alter table public.pos_order_items add column if not exists refunded_qty int not null default 0;
alter table public.pos_order_items drop constraint if exists pos_order_items_refunded_qty_check;
alter table public.pos_order_items add constraint pos_order_items_refunded_qty_check check (refunded_qty between 0 and qty);
-- Bayar 2 cara: a split order has payment_method 'campur'; cash_received and change_given are the
-- Tunai part's (change = received - Tunai part).
alter table public.pos_orders drop constraint if exists pos_orders_payment_method_check;
alter table public.pos_orders add constraint pos_orders_payment_method_check
  check (payment_method in ('tunai', 'qris', 'campur', 'platform', 'gratis'));
alter table public.pos_orders drop constraint if exists pos_orders_campur_cash_check;
alter table public.pos_orders add constraint pos_orders_campur_cash_check
  check (payment_method is distinct from 'campur' or (cash_received is not null and change_given >= 0));
-- One row per method for every paid Tunai / QRIS / split order (platform and gratis have none).
-- Rekap kas, the expected drawer and the reports split Tunai and QRIS from here.
create table if not exists public.pos_order_payments (
  order_id uuid not null references public.pos_orders (id) on delete cascade,
  method text not null check (method in ('tunai', 'qris')),
  amount int not null check (amount > 0),
  primary key (order_id, method)
);
alter table public.pos_order_payments enable row level security;
revoke all on public.pos_order_payments from anon, authenticated;
-- Orders paid before this table: their single method carries the whole total.
insert into public.pos_order_payments (order_id, method, amount)
select o.id, o.payment_method, o.total from public.pos_orders o
 where o.status in ('dibayar', 'refund') and o.payment_method in ('tunai', 'qris') and o.total > 0
   and not exists (select 1 from public.pos_order_payments p where p.order_id = o.id);
-- Refund requests: lines [{line, qty}] (null = the whole order), where the money goes back and how much.
alter table public.pos_void_requests add column if not exists lines jsonb;
alter table public.pos_void_requests add column if not exists refund_method text;
alter table public.pos_void_requests add column if not exists amount int;
alter table public.pos_void_requests drop constraint if exists pos_void_requests_refund_method_check;
alter table public.pos_void_requests add constraint pos_void_requests_refund_method_check
  check (refund_method is null or refund_method in ('tunai', 'transfer', 'qris'));
-- Diskon 50% malam on the box products starts at this time (like BOGO's bogo_from).
alter table public.settings add column if not exists half_from time not null default '19:00';

-- ---------------------------------------------------------------- row security
alter table public.pos_outlets enable row level security;
alter table public.pos_channels enable row level security;
alter table public.pos_flavours enable row level security;
alter table public.pos_channel_prices enable row level security;
alter table public.pos_shifts enable row level security;
alter table public.pos_cash_moves enable row level security;
alter table public.pos_receipt_counters enable row level security;
alter table public.pos_orders enable row level security;
alter table public.pos_order_items enable row level security;
alter table public.pos_void_requests enable row level security;
revoke all on public.pos_outlets, public.pos_channels, public.pos_flavours, public.pos_channel_prices,
  public.pos_shifts, public.pos_cash_moves, public.pos_receipt_counters, public.pos_orders,
  public.pos_order_items, public.pos_void_requests from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public._rp(n int) returns text
language sql immutable
as $$ select 'Rp' || replace(to_char(coalesce(n, 0), 'FM999,999,999'), ',', '.') $$;

create or replace function public._pos_staff_msg() returns text
language sql immutable
as $$ select 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan akun Anda.'::text $$;

-- Which KTP Tebus Murah Rp1 needs today, or null when it doesn't apply (SOP Bab 6 B).
create or replace function public._pos_tebus_ktp() returns text
language sql stable security definer set search_path = public
as $$
  select case extract(isodow from public._local(now()))::int
    when 2 then 'KTP Bandung' when 4 then 'KTP Bandung'
    when 6 then 'KTP luar Bandung' when 7 then 'KTP luar Bandung' end
$$;

-- BOGO Deals runs from settings.bogo_from (19.00), or from when a manager starts it today.
create or replace function public._pos_bogo_active() returns boolean
language sql stable security definer set search_path = public
as $$
  select public._local(now())::time >= (select bogo_from from settings where id = 1)
      or exists (select 1 from pos_bogo_days where outlet_id = 'papaya-bdg' and day = public._local(now())::date)
$$;

-- Diskon 50% malam (Glenn, 13 Nov 2026): the box products at half price from settings.half_from
-- (19.00). Before that staff may only give Diskon 50% when a manager or the owner says so (instruksi50).
create or replace function public._pos_half_active() returns boolean
language sql stable security definer set search_path = public
as $$ select public._local(now())::time >= (select half_from from settings where id = 1) $$;

-- Why an owner promo can't be used right now, or null when it can. p_member null skips the
-- member checks (the till lists promos before a card is scanned).
create or replace function public._pos_promo_block(cp pos_promos, p_member uuid, p_check_member boolean) returns text
language plpgsql stable security definer set search_path = public
as $$
declare t timestamp := public._local(now()); used int;
begin
  if cp.id is null then return 'Promo tidak dikenal.'; end if;
  if not cp.active then return 'Promo ' || cp.name || ' sedang dimatikan.'; end if;
  if cp.starts_on is not null and t::date < cp.starts_on then return 'Promo ' || cp.name || ' mulai ' || to_char(cp.starts_on, 'DD-MM-YYYY') || '.'; end if;
  if cp.ends_on is not null and t::date > cp.ends_on then return 'Promo ' || cp.name || ' sudah berakhir.'; end if;
  if cp.days is not null and not (extract(isodow from t)::int = any (cp.days)) then return 'Promo ' || cp.name || ' tidak berlaku hari ini.'; end if;
  if cp.time_from is not null and not (t::time >= cp.time_from and t::time < cp.time_to) then
    return 'Promo ' || cp.name || ' berlaku pukul ' || to_char(cp.time_from, 'HH24.MI') || ' sampai ' || to_char(cp.time_to, 'HH24.MI') || '.';
  end if;
  if cp.quota is not null then
    select count(*) into used from pos_orders where promo_id = cp.id and status in ('menunggu', 'dibayar');
    if used >= cp.quota then return 'Kuota promo ' || cp.name || ' sudah habis.'; end if;
  end if;
  if p_check_member then
    if cp.member_only and p_member is null then return 'Promo ' || cp.name || ' khusus member. Scan kartu member dulu.'; end if;
    if cp.per_member is not null and p_member is not null then
      select count(*) into used from pos_orders where promo_id = cp.id and member_id = p_member and status in ('menunggu', 'dibayar');
      if used >= cp.per_member then return 'Member ini sudah memakai promo ' || cp.name || ' ' || used || ' kali.'; end if;
    end if;
  end if;
  return null;
end $$;

-- Prices an order without saving it. p: {channel, items: [{product, flavour, qty}],
-- free_bags, promo: {kind, cycle, slot, period, line}}. m: the member, or null.
-- Returns {lines, subtotal, discount, total, promo, boxes, free_bags}.
-- Service charge and PBJT for an order whose price after discount is p_net (see the settings above).
create or replace function public._pos_charges(p_net int, p_delivery boolean) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare s settings := public._cfg(); sv int := 0; tx int := 0; base int; svc_on boolean; tax_add boolean;
begin
  svc_on := coalesce(s.service_on, false) and not coalesce(p_delivery, false);
  if svc_on and p_net > 0 then sv := round(p_net * s.service_pct / 100); end if;
  base := greatest(p_net, 0) + sv;
  tax_add := coalesce(s.pbjt_on, false) and not coalesce(s.pbjt_included, false);
  if coalesce(s.pbjt_on, false) and base > 0 then
    tx := case when tax_add then round(base * s.pbjt_pct / 100) else round(base * s.pbjt_pct / (100 + s.pbjt_pct)) end;
  end if;
  return jsonb_build_object('net', greatest(p_net, 0), 'service_charge', sv, 'service_pct', case when svc_on then s.service_pct end,
    'tax', tx, 'tax_pct', case when coalesce(s.pbjt_on, false) then s.pbjt_pct end,
    'tax_included', coalesce(s.pbjt_on, false) and coalesce(s.pbjt_included, false),
    'total', base + case when tax_add then tx else 0 end);
end $$;

-- Owner: read and change the service charge and PBJT settings.
create or replace function public.owner_charges() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa membuka pengaturan ini.'); s settings := public._cfg();
begin
  return json_build_object('service_on', s.service_on, 'service_pct', s.service_pct,
    'pbjt_on', s.pbjt_on, 'pbjt_pct', s.pbjt_pct, 'pbjt_included', s.pbjt_included);
end $$;

create or replace function public.owner_set_charges(p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengubah pengaturan ini.');
  s settings := public._cfg(); sp numeric; tp numeric;
begin
  begin sp := coalesce(nullif(p->>'service_pct', '')::numeric, s.service_pct); tp := coalesce(nullif(p->>'pbjt_pct', '')::numeric, s.pbjt_pct);
  exception when others then raise exception 'Isi persen dengan angka, contoh 5 atau 10.'; end;
  if sp < 0 or sp > 20 then raise exception 'Service charge 0 sampai 20 persen.'; end if;
  if tp < 0 or tp > 10 then raise exception 'PBJT paling tinggi 10 persen (UU 1/2022).'; end if;
  update settings set service_on = coalesce((p->>'service_on')::boolean, service_on), service_pct = round(sp, 2),
    pbjt_on = coalesce((p->>'pbjt_on')::boolean, pbjt_on), pbjt_pct = round(tp, 2),
    pbjt_included = coalesce((p->>'pbjt_included')::boolean, pbjt_included) where id = 1;
  perform public._log('pajak_service', p);
  return public.owner_charges();
end $$;

create or replace function public._pos_price(p jsonb, m uuid) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  ch pos_channels; it jsonb; pr menu_items; fl pos_flavours;
  lines jsonb := '[]'; n int := 0; q int; unit int; sur int;
  subtotal int := 0; goods int := 0; boxes int := 0; bags int; bag menu_items;
  promo jsonb := p->'promo'; pk text; disc int := 0; target int; rule text; val int; only_code text;
  lbl text; ln jsonb; cands int[]; r record; v record; i int; op pos_promos; why text; left_ int; d int; elig int;
  boss profiles;
begin
  select * into ch from pos_channels where id = coalesce(nullif(p->>'channel', ''), 'toko') and active;
  if ch.id is null then raise exception 'Saluran penjualan tidak dikenal.'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Pesanan masih kosong.';
  end if;
  if jsonb_array_length(p->'items') > 30 then raise exception 'Pesanan terlalu panjang.'; end if;

  for it in select * from jsonb_array_elements(p->'items') loop
    select * into pr from menu_items where code = it->>'product' and active;
    if pr.id is null then raise exception 'Produk tidak dikenal atau sedang tidak dijual.'; end if;
    begin q := (it->>'qty')::int; exception when others then q := null; end;
    if q is null or q < 1 or q > 50 then raise exception 'Jumlah % harus 1 sampai 50.', pr.name; end if;
    fl := null;
    if pr.needs_flavour then
      select * into fl from pos_flavours where id = it->>'flavour' and active;
      if fl.id is null then raise exception 'Pilih rasa untuk %.', pr.name; end if;
    elsif nullif(it->>'flavour', '') is not null then
      raise exception '% tidak punya pilihan rasa.', pr.name;
    end if;
    unit := coalesce((select cp.price from pos_channel_prices cp where cp.channel_id = ch.id and cp.product_id = pr.id), pr.price);
    sur := case when fl.surcharge then pr.flavour_surcharge else 0 end;
    n := n + 1;
    lines := lines || jsonb_build_object('line', n, 'product_id', pr.id, 'code', pr.code, 'name', coalesce(pr.pos_name, pr.name),
      'flavour', fl.id, 'flavour_label', fl.label, 'qty', q, 'unit_price', unit + sur, 'surcharge', sur,
      'line_total', (unit + sur) * q, 'discount', 0, 'free_bag', false, 'is_box', pr.is_box);
    subtotal := subtotal + (unit + sur) * q;
    if pr.code <> 'bag' then goods := goods + (unit + sur) * q; end if;
    if pr.is_box then boxes := boxes + q; end if;
  end loop;

  -- Free paper bags: one for every 2 boxes at the booth; on delivery orders the cashier
  -- confirms one (or more) so stock still goes down. Never counts as a promo.
  begin bags := coalesce((p->>'free_bags')::int, 0); exception when others then bags := -1; end;
  if bags < 0 then raise exception 'Jumlah paper bag gratis tidak valid.'; end if;
  if not ch.delivery and bags > boxes / 2 then
    raise exception 'Paper bag gratis hanya 1 untuk setiap 2 box (pesanan ini: %).', boxes / 2;
  end if;
  if ch.delivery and bags > greatest(1, boxes) then raise exception 'Paper bag gratis terlalu banyak untuk pesanan ini.'; end if;
  if bags > 0 then
    select * into bag from menu_items where code = 'bag';
    n := n + 1;
    lines := lines || jsonb_build_object('line', n, 'product_id', bag.id, 'code', 'bag', 'name', coalesce(bag.pos_name, bag.name),
      'flavour', null, 'flavour_label', null, 'qty', bags, 'unit_price', 0, 'surcharge', 0,
      'line_total', 0, 'discount', 0, 'free_bag', true, 'is_box', false);
  end if;

  -- One promo per order (SOP). Every promo needs a member card open, except BOGO Deals.
  if promo is not null and jsonb_typeof(promo) = 'object' then
    pk := promo->>'kind';
    if m is null and pk not in ('bogo', 'promo', 'malam50', 'instruksi50') then raise exception 'Promo member hanya bisa dipakai setelah kartu member discan.'; end if;
    begin target := nullif(promo->>'line', '')::int; exception when others then target := null; end;
    if pk = 'stempel' then
      select * into r from public._rewards(m) x where x.cycle = (promo->>'cycle')::int and x.slot = (promo->>'slot')::int;
      if r.status is distinct from 'tersedia' then raise exception 'Hadiah ini sudah dipakai atau belum terbuka.'; end if;
      select rw.pos_rule, rw.pos_value into rule, val from rewards rw where rw.slot = r.slot;
      lbl := r.label;
    elsif pk in ('welcome', 'ulang_tahun', 'kode') then
      select * into v from public._vouchers(m) x where x.kind = pk and x.period = (promo->>'period')::int;
      if v.status is distinct from 'tersedia' then raise exception 'Voucher ini sudah dipakai atau sedang tidak berlaku.'; end if;
      lbl := v.label;
      if pk = 'welcome' then rule := 'persen_satu'; val := 50;
      elsif pk = 'ulang_tahun' then rule := 'gratis_produk'; val := 100; only_code := 'mini8';
      else
        rule := 'gratis_produk'; val := 100;
        select b.pos_product into only_code from voucher_codes c join voucher_batches b on b.id = c.batch_id
         where c.id = (promo->>'period')::int;
        if only_code is null then raise exception 'Voucher ini belum diatur untuk kasir. Hubungi pemilik.'; end if;
      end if;
    elsif pk = 'tebus_murah' then
      -- SOP Bab 6 B: a member buying Mini isi 15 pays Rp1 for a Mini isi 8. Tuesday and
      -- Thursday with a Bandung KTP, Saturday and Sunday with a KTP from outside Bandung,
      -- after a Google Maps review, once per member. Staff check the KTP and the review.
      if public._pos_tebus_ktp() is null then
        raise exception 'Tebus Murah Rp1 hanya berlaku Selasa, Kamis, Sabtu dan Minggu.';
      end if;
      if exists (select 1 from redemptions d where d.member_id = m and d.kind = 'tebus_murah' and d.reversed_at is null) then
        raise exception 'Member ini sudah pernah memakai Tebus Murah Rp1.';
      end if;
      if coalesce((promo->>'confirm')::boolean, false) is not true then
        raise exception 'Cek dulu KTP asli (%) dan bukti ulasan Google Maps.', public._pos_tebus_ktp();
      end if;
      if not exists (select 1 from jsonb_array_elements(lines) l where l->>'code' = 'mini15') then
        raise exception 'Tebus Murah Rp1 perlu Mini Box isi 15 di pesanan.';
      end if;
      rule := 'tebus'; val := 0; only_code := 'mini8'; lbl := 'Tebus Murah Rp1';
    elsif pk = 'bogo' then
      if not public._pos_bogo_active() then
        raise exception 'BOGO Deals belum berlaku. Mulai pukul % atau saat diinstruksikan manajer.',
          to_char((select bogo_from from settings where id = 1), 'HH24.MI');
      end if;
      rule := 'bogo'; val := 0; lbl := 'BOGO Deals beli 1 gratis 1';
    elsif pk = 'malam50' then
      -- Diskon 50% malam: every box product at half price, from 19.00 (13 Nov 2026).
      if not public._pos_half_active() then
        raise exception 'Diskon 50%% malam mulai pukul %. Sebelum itu hanya Diskon 50%% atas instruksi manajer atau pemilik.',
          to_char((select half_from from settings where id = 1), 'HH24.MI');
      end if;
      rule := 'half_box'; val := 50; lbl := 'Diskon 50% flash sale';
    elsif pk = 'instruksi50' then
      -- Diskon 50% any time, when a manager or the owner says so. Who said it is stored and the
      -- order is flagged diskon_instruksi for the owner (13 Nov 2026).
      begin select * into boss from profiles where id = nullif(promo->>'by', '')::uuid and role in ('manager', 'owner') and deleted_at is null;
      exception when others then boss := null; end;
      if boss.id is null then raise exception 'Pilih manajer atau pemilik yang menginstruksikan Diskon 50%%.'; end if;
      rule := 'half_all'; val := 50; lbl := 'Diskon 50% instruksi ' || public._first_name(boss.full_name);
    elsif pk = 'promo' then
      -- An owner promo (Promo tab). Its id travels as "period".
      begin select * into op from pos_promos where id = nullif(promo->>'period', '')::int; exception when others then op := null; end;
      why := public._pos_promo_block(op, m, true);
      if why is not null then raise exception '%', why; end if;
      if goods < op.min_spend then
        raise exception 'Promo % perlu belanja minimal % (sekarang %).', op.name, public._rp(op.min_spend), public._rp(goods);
      end if;
      rule := 'promo'; val := op.value; lbl := op.name;
    else
      raise exception 'Jenis promo tidak dikenal.';
    end if;
    if rule is null then raise exception 'Hadiah ini belum diatur untuk kasir. Hubungi pemilik.'; end if;

    if rule = 'promo' then
      -- Spread over the products it covers, line by line: a percentage of each line, or the
      -- rupiah amount taken from the first lines until it is used up.
      select coalesce(sum((l->>'line_total')::int), 0) into elig from jsonb_array_elements(lines) l
       where l->>'code' <> 'bag' and (op.products is null or l->>'code' = any (op.products));
      if elig <= 0 then
        raise exception 'Promo % berlaku untuk: %.', op.name,
          (select string_agg(coalesce(pos_name, name), ', ' order by sort, id) from menu_items where code = any (op.products));
      end if;
      left_ := least(val, elig);
      for i in 0 .. jsonb_array_length(lines) - 1 loop
        ln := lines -> i;
        continue when ln->>'code' = 'bag' or not (op.products is null or ln->>'code' = any (op.products));
        d := case when op.kind = 'persen' then (ln->>'line_total')::int * val / 100 else least(left_, (ln->>'line_total')::int) end;
        if op.kind = 'rupiah' then left_ := left_ - d; end if;
        if d > 0 then lines := jsonb_set(lines, array[i::text, 'discount'], to_jsonb(d)); disc := disc + d; end if;
      end loop;
      if disc <= 0 then raise exception 'Promo % tidak memberi potongan untuk pesanan ini.', op.name; end if;
    elsif rule in ('half_box', 'half_all') then
      -- Half price per item: each box line (malam) or each product line (instruksi).
      for i in 0 .. jsonb_array_length(lines) - 1 loop
        ln := lines -> i;
        continue when ln->>'code' = 'bag' or (rule = 'half_box' and not (ln->>'is_box')::boolean);
        d := (ln->>'line_total')::int * val / 100;
        if d > 0 then lines := jsonb_set(lines, array[i::text, 'discount'], to_jsonb(d)); disc := disc + d; end if;
      end loop;
      if disc <= 0 then
        raise exception '%', case when rule = 'half_box' then 'Diskon 50% flash sale hanya untuk produk box. Tambahkan box ke pesanan.'
                                  else 'Diskon 50% perlu minimal 1 produk di pesanan.' end;
      end if;
    elsif rule = 'bogo' then
      -- Buy 1 get 1: every second unit of the same product and flavour is free.
      for i in 0 .. jsonb_array_length(lines) - 1 loop
        ln := lines -> i;
        if ln->>'code' <> 'bag' and (ln->>'qty')::int >= 2 then
          lines := jsonb_set(lines, array[i::text, 'discount'], to_jsonb(((ln->>'qty')::int / 2) * (ln->>'unit_price')::int));
          disc := disc + ((ln->>'qty')::int / 2) * (ln->>'unit_price')::int;
        end if;
      end loop;
      if disc <= 0 then raise exception 'BOGO Deals: ambil 2 produk yang sama, yang kedua gratis.'; end if;
    elsif rule = 'persen' then
      disc := goods * val / 100;
      if disc <= 0 then raise exception 'Promo ini perlu minimal 1 produk di pesanan.'; end if;
      -- Spread the order discount over the product lines (13 Nov 2026), so per-product,
      -- per-flavour, profit and commission reports see the real price. The rounding
      -- remainder goes on the last product line, so the lines add up to disc exactly.
      declare left_p int := disc; last_i int := -1; dl int;
      begin
        for i in 0 .. jsonb_array_length(lines) - 1 loop
          if lines -> i ->> 'code' <> 'bag' then last_i := i; end if;
        end loop;
        for i in 0 .. jsonb_array_length(lines) - 1 loop
          ln := lines -> i;
          continue when ln->>'code' = 'bag';
          dl := case when i = last_i then left_p else (ln->>'line_total')::int * val / 100 end;
          dl := least(dl, left_p);
          if dl > 0 then lines := jsonb_set(lines, array[i::text, 'discount'], to_jsonb(dl)); left_p := left_p - dl; end if;
        end loop;
      end;
    else
      select array_agg((l->>'line')::int order by (l->>'line')::int) into cands
        from jsonb_array_elements(lines) l
       where l->>'code' <> 'bag' and (only_code is null or l->>'code' = only_code);
      if cands is null then
        raise exception 'Tambahkan % ke pesanan dulu untuk voucher ini.',
          (select coalesce(pos_name, name) from menu_items where code = only_code);
      end if;
      if target is null then
        if cardinality(cands) > 1 then raise exception 'Pilih produk yang mendapat promo.'; end if;
        target := cands[1];
      elsif not (target = any (cands)) then
        raise exception 'Promo ini tidak berlaku untuk produk yang dipilih.';
      end if;
      ln := lines -> (target - 1);
      disc := case when rule = 'tebus' then (ln->>'unit_price')::int - 1 else (ln->>'unit_price')::int * val / 100 end;
      lines := jsonb_set(lines, array[(target - 1)::text, 'discount'], to_jsonb(disc));
    end if;
    promo := jsonb_build_object('kind', pk, 'cycle', case when pk = 'stempel' then (promo->>'cycle')::int when pk = 'tebus_murah' then 0 else (promo->>'period')::int end,
      -- Tebus Murah is once per member, ever: cycle 0, slot 0 (the unique index on redemptions holds it).
     
      'slot', case when pk = 'stempel' then (promo->>'slot')::int else 0 end,
      'label', lbl, 'line', target, 'discount', disc, 'by', boss.id);
  else
    promo := null;
  end if;

  -- total = subtotal - discount + service charge (+ PBJT when it is added on top), from _pos_charges.
  return jsonb_build_object('channel', ch.id, 'delivery', ch.delivery, 'lines', lines, 'subtotal', subtotal,
    'discount', disc, 'promo', promo, 'boxes', boxes,
    'free_bags', bags, 'free_bags_max', case when ch.delivery then greatest(1, boxes) else boxes / 2 end)
    || public._pos_charges(subtotal - disc, ch.delivery);
end $$;

-- The open member ticket for this cashier, or nothing. Raises when it has run out.
create or replace function public._pos_ticket(staff uuid, p_ticket uuid) returns scan_tickets
language plpgsql stable security definer set search_path = public
as $$
declare tk scan_tickets;
begin
  if p_ticket is null then return null; end if;
  select * into tk from scan_tickets where id = p_ticket and staff_id = staff and used_at is null and expires_at > now();
  if tk.id is null then raise exception 'Scan kartu sudah lewat 10 menit. Scan ulang kartunya.'; end if;
  return tk;
end $$;

-- Everything the printed and WhatsApp receipt needs.
create or replace function public._pos_receipt(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  o pos_orders; s settings := public._cfg(); mem profiles;
  c_pos int; c_wait int; n_slot int; n_label text;
begin
  select * into o from pos_orders where id = p_id;
  if o.id is null then return null; end if;
  if o.member_id is not null then
    select * into mem from profiles where id = o.member_id;
    select cv.card_position, cv.waiting into c_pos, c_wait from public._card_view(o.member_id) cv;
    select r.slot, r.label into n_slot, n_label from rewards r where r.slot > c_pos and r.slot <= s.card_size order by r.slot limit 1;
  end if;
  return json_build_object(
    'id', o.id, 'receipt_no', o.receipt_no, 'local_no', o.local_no, 'status', o.status,
    'outlet', (select name from pos_outlets where id = o.outlet_id),
    'channel', o.channel_id, 'channel_label', (select label from pos_channels where id = o.channel_id),
    'sold_at', o.sold_at, 'date', to_char(public._local(o.sold_at), 'DD Mon YYYY'), 'time', to_char(public._local(o.sold_at), 'HH24.MI'),
    'served_by', (select public._first_name(full_name) from profiles where id = o.served_by),
    'member', case when o.member_id is not null then public._first_name(mem.full_name) end,
    'lines', coalesce((select json_agg(json_build_object('line', i.line, 'code', i.product_code, 'name', i.name, 'flavour', f.label, 'qty', i.qty,
      'unit_price', i.unit_price, 'line_total', i.line_total, 'discount', i.discount, 'free_bag', i.free_bag,
      'refunded_qty', i.refunded_qty) order by i.line)
      from pos_order_items i left join pos_flavours f on f.id = i.flavour_id where i.order_id = o.id), '[]'),
    'subtotal', o.subtotal, 'discount', o.discount, 'promo_label', o.promo_label,
    'promo_product', (select i.name from pos_order_items i where i.order_id = o.id and i.discount > 0 and o.promo_label is not null
                       and (select count(*) from pos_order_items j where j.order_id = o.id and j.discount > 0) = 1 limit 1),
    'service_charge', o.service_charge, 'service_pct', o.service_pct, 'tax', o.tax, 'tax_pct', o.tax_pct, 'tax_included', o.tax_included,
    'total', o.total, 'payment_method', o.payment_method, 'cash_received', o.cash_received, 'change', o.change_given,
    'payment_ref', o.payment_ref,
    -- Till v2 (13 Nov 2026): the split per method, the order note, Diskon 50% instruksi and refunds.
    'payments', coalesce((select json_agg(json_build_object('method', p.method, 'amount', p.amount)
      order by array_position(array['qris', 'tunai'], p.method)) from pos_order_payments p where p.order_id = o.id), '[]'),
    'note', o.note, 'customer_name', o.customer_name, 'promo_kind', o.promo_kind,
    'promo_by', (select public._first_name(full_name) from profiles where id = o.promo_by),
    'refunded', o.refunded,
    'refunds', coalesce((select json_agg(json_build_object('id', v.id, 'amount', coalesce(v.amount, o.total), 'method', v.refund_method,
        'lines', v.lines, 'at', v.decided_at, 'reason', v.reason) order by v.decided_at)
      from pos_void_requests v where v.order_id = o.id and v.kind = 'refund' and v.status = 'disetujui'), '[]'),
    'stamp_boost', (select json_build_object('name', b.name, 'multiplier', b.multiplier) from stamp_boosts b where b.id = o.stamp_boost_id),
    'stamps', o.stamps,
    'card', case when o.member_id is not null then json_build_object('position', c_pos, 'size', s.card_size,
      'waiting', c_wait, 'next_label', n_label, 'next_in', n_slot - c_pos) end,
    -- Rewards this order's stamps opened (for the "Hadiah baru" line on the receipt).
    'new_rewards', case when o.member_id is not null and o.stamps > 0 then coalesce((select json_agg(r.label order by r.slot)
      from rewards r where r.slot > c_pos - o.stamps and r.slot <= c_pos), '[]') end,
    'rewards_ready', case when o.member_id is not null then coalesce((select json_agg(x.label) from public._rewards(o.member_id) x
      where x.status = 'tersedia'), '[]') end);
end $$;

-- ---------------------------------------------------------------- till functions
-- What the till loads once: products with today's prices per channel, flavours,
-- channels, the people who can be picked as "served by", and the open shift.
create or replace function public.pos_catalog() returns json
language plpgsql stable security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
begin
  return json_build_object(
    -- Tabs above the product grid, in the owner's order.
    'categories', coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name) order by c.sort, c.id)
        from pos_categories c where c.active), '[]'),
    'products', coalesce((select json_agg(json_build_object('code', m.code, 'name', coalesce(m.pos_name, m.name), 'price', m.price,
        'category_id', m.category_id, 'is_box', m.is_box, 'needs_flavour', m.needs_flavour, 'flavour_surcharge', m.flavour_surcharge,
        'channel_prices', (select json_object_agg(cp.channel_id, cp.price) from pos_channel_prices cp where cp.product_id = m.id))
        order by c.sort nulls last, c.id, m.sort, m.id)
        from menu_items m left join pos_categories c on c.id = m.category_id
       where m.active and m.on_till and m.archived_at is null and m.code is not null and (c.id is null or c.active)), '[]'),
    'flavours', coalesce((select json_agg(json_build_object('id', f.id, 'label', f.label, 'surcharge', f.surcharge) order by f.sort)
        from pos_flavours f where f.active), '[]'),
    'channels', coalesce((select json_agg(json_build_object('id', c.id, 'label', c.label, 'delivery', c.delivery) order by c.sort)
        from pos_channels c where c.active), '[]'),
    -- Until attendance exists (task 14) everyone active is listed; after it, only staff who are clocked in.
    'staff', coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'full_name', p.full_name,
        'role', p.role, 'is_me', p.id = staff) order by p.full_name)
        from profiles p where p.role in ('staff', 'manager') and p.deleted_at is null), '[]'),
    'shift', (select json_build_object('id', sh.id, 'opened_at', sh.opened_at,
          'opening_cash', case when public._pos_cash_full() then sh.opening_cash end)
        from pos_shifts sh where sh.outlet_id = 'papaya-bdg' and sh.closed_at is null),
    'rupiah_per_stamp', (select rupiah_per_stamp from settings where id = 1),
    -- Service charge and PBJT (14 Nov 2026), so an offline sale is priced the same way.
    'charges', (select json_build_object('service_on', s.service_on, 'service_pct', s.service_pct, 'pbjt_on', s.pbjt_on,
        'pbjt_pct', s.pbjt_pct, 'pbjt_included', s.pbjt_included) from settings s where s.id = 1),
    -- The stamp bonus period running now, if any (12 Nov 2026).
    'stamp_boost', (select json_build_object('name', b.name, 'multiplier', b.multiplier, 'ends_on', b.ends_on)
        from public._stamp_boost_at(now()) b where b.id is not null),
    'promos', json_build_object('bogo_active', public._pos_bogo_active(),
      'bogo_from', to_char((select bogo_from from settings where id = 1), 'HH24.MI'),
      'tebus_murah_ktp', public._pos_tebus_ktp(),
      -- Diskon 50% malam from half_from; Diskon 50% instruksi needs one of these names (13 Nov 2026).
      'malam50_active', public._pos_half_active(),
      'malam50_from', to_char((select half_from from settings where id = 1), 'HH24.MI'),
      'instructors', coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'role', p.role)
          order by p.role desc, p.full_name) from profiles p where p.role in ('manager', 'owner') and p.deleted_at is null), '[]'),
      -- Owner promos that can be used right now (member checks happen when it is used).
      'custom', coalesce((select json_agg(json_build_object('id', cp.id, 'name', cp.name, 'kind', cp.kind, 'value', cp.value,
          'products', cp.products, 'min_spend', cp.min_spend, 'member_only', cp.member_only, 'note', cp.note,
          'time_to', to_char(cp.time_to, 'HH24.MI'), 'ends_on', cp.ends_on) order by cp.id)
        from pos_promos cp where public._pos_promo_block(cp, null, false) is null), '[]')));
end $$;

-- The running total while the cashier builds the order. Same maths as pos_checkout.
create or replace function public.pos_quote(p_order jsonb) returns json
language plpgsql stable security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); tk scan_tickets;
begin
  tk := public._pos_ticket(staff, nullif(p_order->>'ticket', '')::uuid);
  return public._pos_price(p_order, tk.member_id)::json;
end $$;

-- An order goes through two steps (Glenn, 11 Nov 2026):
--   1. pos_place_order: the cashier confirms the order. It gets its invoice number, the
--      promo is held, and it waits for payment (status 'menunggu'). From here on only a
--      manager or the owner can cancel it (pos_cancel_order).
--   2. pos_pay: Tunai with cash received, or QRIS after the Hanashuya QRIS is shown. Stamps,
--      the sales row and stock are written now.
-- pos_checkout does both at once (for orders sent late after being offline).
--
-- p_order adds to the _pos_price input:
--   id          uuid made on the tablet (required; the same id again returns the same order)
--   ticket      member scan ticket, or null for a walk-in
--   served_by   the staff member who served
--   gender, age_range   for walk-ins, as on the cashier page today
-- and for pos_checkout also payment {method, cash} and client_at.

-- Invoice numbers (Glenn, 14 Nov 2026): the last 4 digits are random, not a running count, so
-- customers can't read the day's sales from their receipt. Unique per day; the running count
-- stays in pos_receipt_counters for the owner.
create or replace function public._pos_receipt_no(v_day date) returns text
language plpgsql volatile security definer set search_path = public
as $$
declare rno text; tries int := 0;
begin
  loop
    rno := 'HS-' || to_char(v_day, 'YYMMDD') || '-' || lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    exit when not exists (select 1 from pos_orders where receipt_no = rno);
    tries := tries + 1;
    if tries > 200 then raise exception 'Nomor invoice hari ini habis. Hubungi pemilik.'; end if;
  end loop;
  return rno;
end $$;
revoke all on function public._pos_receipt_no(date) from public, anon, authenticated;

-- Step 1. Creates the order as 'menunggu'. Returns its id.
create or replace function public._pos_create(staff uuid, p_order jsonb) returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
  oid uuid; tk scan_tickets; m profiles; srv profiles; q jsonb;
  v_day date := public._local(now())::date; seq int; rno text; rid bigint; f text[] := '{}';
  g text := nullif(p_order->>'gender', ''); a text := nullif(p_order->>'age_range', ''); ln jsonb;
  nt text := nullif(trim(coalesce(p_order->>'note', '')), '');
  cn text := nullif(left(regexp_replace(trim(coalesce(p_order->>'customer_name', '')), '\s+', ' ', 'g'), 40), '');
begin
  begin oid := (p_order->>'id')::uuid; exception when others then oid := null; end;
  if oid is null then raise exception 'Pesanan tanpa nomor. Muat ulang halaman kasir.'; end if;
  -- Catatan pesanan (13 Nov 2026): at most 200 characters.
  if nt is not null and length(nt) > 200 then raise exception 'Catatan pesanan paling panjang 200 huruf (sekarang %).', length(nt); end if;

  begin select * into srv from profiles where id = (p_order->>'served_by')::uuid
    and role in ('staff', 'manager', 'owner') and deleted_at is null;
  exception when others then srv := null; end;
  if srv.id is null then raise exception 'Pilih siapa yang melayani.'; end if;

  tk := public._pos_ticket(staff, nullif(p_order->>'ticket', '')::uuid);
  if tk.id is not null then
    select * into m from profiles where id = tk.member_id and deleted_at is null;
    if m.id is null then raise exception 'Kartu tidak ditemukan.'; end if;
    if m.id in (staff, srv.id) then
      raise exception 'Tidak bisa memakai kartu sendiri. Minta staf lain yang melayani.';
    end if;
    if public._staff_conflict(m.id) then
      raise exception 'Kartu ini terhubung dengan akun staf, jadi tidak bisa diberi stempel atau hadiah.';
    end if;
    -- A staff member's own card, used by a colleague: allowed, shown to the owner.
    if m.role in ('staff', 'manager') then f := array_append(f, 'kartu_staf'); end if;
    if tk.via = 'kode' then f := array_append(f, 'kode_diketik'); end if;
    if tk.via = 'nomor' then f := array_append(f, 'nomor_dicari'); end if;
    if m.gender is not null then g := m.gender; end if;
    if m.age_range is not null then a := m.age_range; end if;
  end if;
  if g is not null and g not in ('perempuan', 'laki-laki', 'tidak_disebut') then raise exception 'Jenis kelamin tidak valid.'; end if;
  if a is not null and a not in ('<17', '17-24', '25-34', '35-44', '45+', 'tidak_disebut') then raise exception 'Rentang usia tidak valid.'; end if;

  q := public._pos_price(p_order, m.id);

  insert into pos_receipt_counters (outlet_id, day, last) values ('papaya-bdg', v_day, 1)
  on conflict (outlet_id, day) do update set last = pos_receipt_counters.last + 1
  returning last into seq;
  rno := public._pos_receipt_no(v_day);

  insert into pos_orders (id, channel_id, receipt_no, sale_day, status, cashier_id, served_by, member_id, via,
    subtotal, discount, total, service_charge, tax, tax_included, service_pct, tax_pct,
    promo_kind, promo_label, payment_method, gender, age_range, flags, sold_at)
  values (oid, q->>'channel', rno, v_day, 'menunggu', staff, srv.id, m.id, tk.via,
    (q->>'subtotal')::int, (q->>'discount')::int, (q->>'total')::int, coalesce((q->>'service_charge')::int, 0), coalesce((q->>'tax')::int, 0),
    coalesce((q->>'tax_included')::boolean, false), (q->>'service_pct')::numeric, (q->>'tax_pct')::numeric,
    q#>>'{promo,kind}', q#>>'{promo,label}', null, g, a, f, now());
  if q#>>'{promo,kind}' = 'promo' then update pos_orders set promo_id = (q#>>'{promo,cycle}')::int where id = oid; end if;
  update pos_orders set note = nt where id = oid and nt is not null;
  update pos_orders set customer_name = cn where id = oid and cn is not null;
  if q#>>'{promo,kind}' = 'instruksi50' then
    update pos_orders set promo_by = (q#>>'{promo,by}')::uuid, flags = flags || array['diskon_instruksi'] where id = oid;
  end if;

  -- The promo is held now; the unique index on redemptions stops it being used twice,
  -- even by two tablets at once. A cancelled order gives it back.
  if q->'promo' is not null and jsonb_typeof(q->'promo') = 'object' and q#>>'{promo,kind}' not in ('bogo', 'promo', 'malam50', 'instruksi50') then
    insert into redemptions (member_id, staff_id, cycle, slot, reward_label, kind, order_id)
    values (m.id, srv.id, (q#>>'{promo,cycle}')::int, (q#>>'{promo,slot}')::int, q#>>'{promo,label}', q#>>'{promo,kind}', oid)
    returning id into rid;
    update pos_orders set redemption_id = rid where id = oid;
  end if;

  for ln in select * from jsonb_array_elements(q->'lines') loop
    insert into pos_order_items (order_id, line, product_id, product_code, name, flavour_id, qty, unit_price, surcharge,
      line_total, discount, free_bag)
    values (oid, (ln->>'line')::int, (ln->>'product_id')::int, ln->>'code', ln->>'name', ln->>'flavour', (ln->>'qty')::int,
      (ln->>'unit_price')::int, (ln->>'surcharge')::int, (ln->>'line_total')::int, (ln->>'discount')::int, (ln->>'free_bag')::boolean);
  end loop;
  if tk.id is not null then update scan_tickets set used_at = now() where id = tk.id; end if;
  perform public._log('pos_pesanan', jsonb_build_object('order', oid, 'receipt', rno, 'total', (q->>'total')::int,
    'member', m.id, 'served_by', srv.id, 'promo', q->'promo'));
  return oid;
end $$;

-- Step 2. Takes the payment for a 'menunggu' order and writes stamps, the sales row and stock.
-- Automatic journals (13 Nov 2026, like VireoPOS: a sale posts to the books when it closes). When
-- akunting.sql has run, rebuild that day's automatic journals right away. Accounting never blocks a sale:
-- any error is written to audit_log ('akunting_gagal') and the owner's Akunting page syncs again on open.
create or replace function public._pos_acc_post(p_day date, p_order uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  if p_day is null or to_regprocedure('public._acc_sync_core(date,date)') is null then return; end if;
  begin
    execute 'select public._acc_sync_core($1, $1)' using p_day;
  exception when others then
    perform public._log('akunting_gagal', jsonb_build_object('error', sqlerrm, 'order', p_order, 'day', p_day));
  end;
end $$;

create or replace function public._pos_settle(staff uuid, p_id uuid, p_payment jsonb, p_client_at text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  s settings := public._cfg(); o pos_orders; method text := coalesce(p_payment->>'method', ''); cash int; chg int;
  cl timestamptz; sold timestamptz; v_day date; shift bigint; f text[] := '{}'; v_stamps int := 0; today int;
  sid bigint; items jsonb; delivery boolean; ref text; boost stamp_boosts; p_tunai int; p_qris int;
begin
  select * into o from pos_orders where id = p_id for update;
  if o.id is null then raise exception 'Pesanan tidak ditemukan.'; end if;
  if o.status = 'batal' then raise exception 'Pesanan % sudah dibatalkan.', o.receipt_no; end if;
  if o.status <> 'menunggu' then raise exception 'Pesanan % sudah dibayar.', o.receipt_no; end if;
  select c.delivery into delivery from pos_channels c where c.id = o.channel_id;

  if o.total = 0 then
    method := 'gratis'; cash := null; chg := null;
  elsif method = 'tunai' then
    begin cash := (p_payment->>'cash')::int; exception when others then cash := null; end;
    if cash is null then raise exception 'Isi uang diterima dari pembeli.'; end if;
    if cash < o.total then raise exception 'Uang diterima kurang dari total %.', public._rp(o.total); end if;
    if cash > o.total + 1000000 then raise exception 'Uang diterima terlalu besar. Periksa lagi angkanya.'; end if;
    chg := cash - o.total;
  elsif method = 'campur' then
    -- Bayar 2 cara (13 Nov 2026): part Tunai, part QRIS. The parts add up to the total, and the
    -- change comes only from the Tunai part (cash = what the buyer handed over for that part).
    begin p_tunai := (p_payment->>'tunai')::int; p_qris := (p_payment->>'qris')::int; exception when others then p_tunai := null; end;
    if p_tunai is null or p_qris is null or p_tunai <= 0 or p_qris <= 0 then
      raise exception 'Isi bagian Tunai dan bagian QRIS, masing-masing lebih dari Rp0.';
    end if;
    if p_tunai + p_qris <> o.total then
      raise exception 'Tunai % ditambah QRIS % harus sama dengan total %.', public._rp(p_tunai), public._rp(p_qris), public._rp(o.total);
    end if;
    begin cash := coalesce((p_payment->>'cash')::int, p_tunai); exception when others then cash := null; end;
    if cash is null or cash < p_tunai then raise exception 'Uang tunai diterima kurang dari bagian Tunai %.', public._rp(p_tunai); end if;
    if cash > p_tunai + 1000000 then raise exception 'Uang diterima terlalu besar. Periksa lagi angkanya.'; end if;
    chg := cash - p_tunai;
    ref := nullif(left(trim(coalesce(p_payment->>'ref', '')), 40), '');
  elsif method = 'qris' then
    cash := null; chg := null;
    -- Optional reference from GoPay Merchant (12 Nov 2026), to match a disputed payment.
    ref := nullif(left(trim(coalesce(p_payment->>'ref', '')), 40), '');
  elsif method = 'platform' then
    if not delivery then raise exception 'Pembayaran lewat aplikasi hanya untuk pesanan online.'; end if;
    cash := null; chg := null;
  else
    raise exception 'Pilih Tunai atau QRIS.';
  end if;
  if method = 'tunai' then p_tunai := o.total; p_qris := 0;
  elsif method = 'qris' then p_tunai := 0; p_qris := o.total;
  elsif method <> 'campur' then p_tunai := 0; p_qris := 0; end if;

  -- Sale time: when it was paid on the tablet, if that is within the last 3 days (offline sales).
  begin cl := p_client_at::timestamptz; exception when others then cl := null; end;
  sold := case when cl between now() - interval '3 days' and now() + interval '2 minutes' then least(cl, now()) else now() end;
  -- An order confirmed online (no L number, not marked offline) can't be paid before it was
  -- confirmed (14 Nov 2026): the tablet time is never earlier than the order. Real offline
  -- sales keep their tablet time.
  if o.local_no is null and not ('offline' = any (coalesce(o.flags, '{}'))) then sold := greatest(sold, o.created_at); end if;
  if cl is not null and sold < now() - interval '15 minutes' then f := array_append(f, 'dikirim_terlambat'); end if;
  v_day := public._local(sold)::date;

  -- Shifts run back to back (11 Nov 2026), so every sale lands in one; the first opens here.
  shift := public._pos_open_shift_id(staff);

  if o.member_id is not null then
    if public._local(sold)::time between s.open_time and s.close_time then
      v_stamps := (o.subtotal - o.discount) / s.rupiah_per_stamp;  -- goods only, never service charge or PBJT
      -- Stamp bonus period (12 Nov 2026): the stamps are multiplied while one runs.
      boost := public._stamp_boost_at(sold);
      if boost.id is not null and v_stamps > 0 then
        v_stamps := v_stamps * boost.multiplier;
        f := array_append(f, 'bonus_stempel');
      end if;
    elsif o.subtotal - o.discount >= s.rupiah_per_stamp then
      f := array_append(f, 'di_luar_jam');
    end if;
    select coalesce(sum(x.stamps), 0) into today from sales x
     where x.member_id = o.member_id and x.reversed_at is null and x.sale_day = v_day;
    if today + v_stamps > s.max_stamps_per_day then f := array_append(f, 'banyak_stempel_sehari'); end if;
    if (select count(*) from pos_orders x where x.member_id = o.member_id and x.served_by = o.served_by and x.status = 'dibayar'
          and x.sold_at > now() - interval '7 days') >= 3 then
      f := array_append(f, 'staf_sama_sering');
    end if;
  end if;

  -- The sales row keeps the dashboard, stamps and card cycles working unchanged.
  if o.total > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'qty', i.qty, 'flavour', fl.label) order by i.line)
           filter (where coalesce(i.product_code, '') <> 'bag'), '[]')
      into items from pos_order_items i left join pos_flavours fl on fl.id = i.flavour_id where i.order_id = o.id;
    insert into sales (receipt_no, sale_day, total, member_id, staff_id, stamps, items, gender, age_range, via, flags, created_at)
    -- Who served, not the signed-in account (the tablet's kasir account), so Ringkasan credits the staff (13 Nov 2026).
    values (null, v_day, o.total, o.member_id, coalesce(o.served_by, staff), v_stamps, items, o.gender, o.age_range, o.via, o.flags || f, sold)
    returning id into sid;
  end if;

  update pos_orders set status = 'dibayar', payment_method = method, cash_received = cash, change_given = chg,
    sale_id = sid, stamps = v_stamps, shift_id = shift, flags = o.flags || f, sold_at = sold, sale_day = v_day,
    client_at = cl, payment_ref = ref, stamp_boost_id = boost.id
  where id = o.id;
  -- One row per method (13 Nov 2026): Rekap kas, the drawer and the reports read the split here.
  insert into pos_order_payments (order_id, method, amount)
  select o.id, x.m, x.a from (values ('tunai', p_tunai), ('qris', p_qris)) x (m, a) where x.a > 0
  on conflict on constraint pos_order_payments_pkey do update set amount = excluded.amount;

  -- Task 15 (stock) deducts each line's recipe here, in this same transaction.
  -- Only when stock.sql has been run, so this file still works on its own.
  if to_regproc('public._stock_apply_order') is not null then
    execute 'select public._stock_apply_order($1)' using o.id;
  end if;

  if o.member_id is not null then perform public._sync_cycles(o.member_id); end if;
  perform public._log('pos_penjualan', jsonb_build_object('order', o.id, 'receipt', o.receipt_no, 'total', o.total,
    'member', o.member_id, 'served_by', o.served_by, 'method', method, 'flags', o.flags || f));
  perform public._pos_acc_post(v_day, o.id);
end $$;

-- Konfirmasi pesanan: the order gets its invoice number and waits for payment.
create or replace function public.pos_place_order(p_order jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  oid uuid; prev pos_orders;
begin
  begin oid := (p_order->>'id')::uuid; exception when others then oid := null; end;
  select * into prev from pos_orders where id = oid;
  if prev.id is not null then
    if prev.cashier_id is distinct from staff then raise exception 'Nomor pesanan ini sudah dipakai.'; end if;
    return (public._pos_receipt(oid)::jsonb || '{"repeat": true}')::json;
  end if;
  oid := public._pos_create(staff, p_order);
  return public._pos_receipt(oid);
end $$;

-- Bayar: Tunai {method: 'tunai', cash} or QRIS {method: 'qris'} for a confirmed order.
-- Sending it again for a paid order returns the same receipt.
create or replace function public.pos_pay(p_id uuid, p_payment jsonb, p_client_at text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  o pos_orders;
begin
  -- Locked, so a manager's decision on a Minta batal can't slip in between the check and the payment.
  select * into o from pos_orders where id = p_id for update;
  if o.id is not null and o.status in ('dibayar', 'refund') then
    return (public._pos_receipt(p_id)::jsonb || '{"repeat": true}')::json;
  end if;
  -- A waiting order with a Minta batal request is not paid until a manager decides (12 Nov 2026).
  if exists (select 1 from pos_void_requests v where v.order_id = p_id and v.status = 'menunggu') then
    raise exception 'Pesanan ini sedang menunggu keputusan batal dari manajer. Tunggu keputusannya dulu.';
  end if;
  perform public._pos_settle(staff, p_id, coalesce(p_payment, '{}'), p_client_at);
  return public._pos_receipt(p_id);
end $$;

-- An order that reached payment can only be cancelled by a manager or the owner (Glenn,
-- 11 Nov 2026). Staff ask with pos_request_void. The held promo goes back to the member.
create or replace function public.pos_cancel_order(p_id uuid, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Pesanan yang sudah masuk pembayaran hanya bisa dibatalkan manajer atau pemilik.');
  o pos_orders;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'Tulis alasannya.'; end if;
  select * into o from pos_orders where id = p_id for update;
  if o.id is null then raise exception 'Pesanan tidak ditemukan.'; end if;
  if o.status <> 'menunggu' then
    raise exception 'Pesanan % sudah dibayar. Pakai batal atau refund di Persetujuan.', o.receipt_no;
  end if;
  update pos_orders set status = 'batal' where id = o.id;
  update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
  update pos_void_requests set status = 'disetujui', decided_by = me, decided_at = now()
   where order_id = o.id and status = 'menunggu';
  if o.member_id is not null then perform public._sync_cycles(o.member_id); end if;
  perform public._log('pos_batal_pesanan', jsonb_build_object('order', o.id, 'receipt', o.receipt_no, 'reason', trim(p_reason)));
  return public._pos_receipt(o.id);
end $$;

-- Ubah pesanan (Glenn, 14 Nov 2026): from the payment screens the cashier may go back and change an
-- order that is not paid yet. The confirmed order is closed as batal (kept, with the reason
-- "Diubah sebelum dibayar" in the log), its held promo goes back to the member, and the till
-- confirms the changed order again under a new invoice number. Only the cashier who confirmed it,
-- only while it is waiting, and never once a Minta batal is pending.
create or replace function public.pos_edit_order(p_id uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  o pos_orders;
begin
  select * into o from pos_orders where id = p_id for update;
  if o.id is null then raise exception 'Pesanan tidak ditemukan.'; end if;
  if o.status <> 'menunggu' then raise exception 'Pesanan % sudah dibayar, jadi tidak bisa diubah.', o.receipt_no; end if;
  if o.cashier_id is distinct from me
     and not exists (select 1 from profiles where id = me and role in ('manager', 'owner')) then
    raise exception 'Pesanan ini dikonfirmasi kasir lain.';
  end if;
  if exists (select 1 from pos_void_requests v where v.order_id = o.id and v.status = 'menunggu') then
    raise exception 'Pesanan ini sedang menunggu keputusan batal dari manajer.';
  end if;
  update pos_orders set status = 'batal' where id = o.id;
  update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
  if o.member_id is not null then perform public._sync_cycles(o.member_id); end if;
  perform public._log('pos_ubah_pesanan', jsonb_build_object('order', o.id, 'receipt', o.receipt_no, 'reason', 'Diubah sebelum dibayar'));
  return json_build_object('ok', true, 'receipt_no', o.receipt_no);
end $$;

-- A split payment whose parts no longer add up to the server total (a price changed while the
-- tablet was offline): the difference goes on the Tunai part and the cash handed over, so the
-- change the cashier really gave stays and the drawer selisih shows it (13 Nov 2026).
create or replace function public._pos_campur_fix(pay jsonb, p_total int) returns jsonb
language plpgsql immutable
as $$
declare t int; qr int; c int; d int;
begin
  if coalesce(pay->>'method', '') <> 'campur' then return pay; end if;
  begin t := (pay->>'tunai')::int; qr := (pay->>'qris')::int; c := coalesce((pay->>'cash')::int, t); exception when others then return pay; end;
  if t is null or qr is null then return pay; end if;
  d := p_total - (t + qr);
  if d = 0 then return pay; end if;
  if t + d <= 0 then return jsonb_build_object('method', 'qris', 'ref', pay->>'ref'); end if;
  return pay || jsonb_build_object('tunai', t + d, 'cash', greatest(t + d, c + d));
end $$;

-- Both steps at once, for an order rung up offline and sent later.
-- An offline order (task 7) carries local_no (the number printed on its receipt) and
-- expect_total (what the tablet charged). Offline sales are walk-ins only: no card and no
-- promo, because those must be checked live so they can't be used twice. When the server
-- total differs from what the tablet charged (a price changed meanwhile) the order keeps
-- the server prices, is flagged harga_offline_beda for the owner, and a Tunai payment is
-- recorded so the sale still goes through: received is raised by the difference, so the
-- drawer selisih shows it.
create or replace function public.pos_checkout(p_order jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  oid uuid; prev pos_orders; o pos_orders; pay jsonb := coalesce(p_order->'payment', '{}');
  lno text := nullif(trim(coalesce(p_order->>'local_no', '')), ''); expect int; cash int;
  has_pay boolean := coalesce(p_order->'payment'->>'method', '') <> ''; v_state text;
begin
  begin oid := (p_order->>'id')::uuid; exception when others then oid := null; end;
  if lno is not null and length(lno) > 30 then raise exception 'Nomor struk offline tidak valid.'; end if;
  begin expect := (p_order->>'expect_total')::int; exception when others then expect := null; end;
  select * into prev from pos_orders where id = oid for update;
  if prev.id is not null then
    if prev.cashier_id is distinct from staff then raise exception 'Nomor pesanan ini sudah dipakai.'; end if;
    -- A payment taken on the tablet for an order that was cancelled meanwhile, or that has a
    -- Minta batal waiting (13 Nov 2026). The money is in the drawer but the sale is not
    -- recorded, so it is never settled here: the reply says why, the till keeps the sale in
    -- its "Perlu dicek" list, and the owner sees it in audit_log (logged once per order).
    if has_pay and (prev.status = 'batal' or (prev.status = 'menunggu'
        and exists (select 1 from pos_void_requests v where v.order_id = oid and v.status = 'menunggu'))) then
      v_state := case when prev.status = 'batal' then 'batal' else 'menunggu_batal' end;
      if not exists (select 1 from audit_log a where a.action = 'pos_bayar_offline_ditolak'
                       and a.detail->>'order' = oid::text and a.detail->>'state' = v_state) then
        update pos_orders set flags = flags || array['bayar_setelah_batal'] where id = oid and not ('bayar_setelah_batal' = any(flags));
        perform public._log('pos_bayar_offline_ditolak', jsonb_build_object('order', oid, 'receipt', prev.receipt_no,
          'local_no', lno, 'state', v_state, 'method', pay->>'method', 'cash', pay->>'cash', 'total', prev.total,
          'client_at', p_order->>'client_at', 'flag', true));
      end if;
      return (public._pos_receipt(oid)::jsonb || jsonb_build_object('repeat', true, 'rejected', v_state))::json;
    end if;
    if prev.status = 'menunggu' then
      -- Confirmed online, paid while the line was down. When the line dropped at Konfirmasi
      -- the tablet printed an L number: keep it on the order, and check the total the tablet
      -- charged, the same as a sale rung up offline (13 Nov 2026).
      update pos_orders set flags = flags || array['offline'] where id = oid and not ('offline' = any(flags));
      if lno is not null then
        update pos_orders set local_no = coalesce(local_no, lno) where id = oid;
        if expect is distinct from prev.total then
          update pos_orders set flags = flags || array['harga_offline_beda'] where id = oid and not ('harga_offline_beda' = any(flags));
          perform public._log('pos_harga_offline_beda', jsonb_build_object('order', oid, 'local_no', lno, 'tablet', expect, 'server', prev.total));
          begin cash := (pay->>'cash')::int; exception when others then cash := null; end;
          if pay->>'method' = 'tunai' and cash is not null then
            pay := pay || jsonb_build_object('cash', greatest(prev.total, cash + (prev.total - coalesce(expect, cash))));
          end if;
          pay := public._pos_campur_fix(pay, prev.total);
        end if;
      end if;
      perform public._pos_settle(staff, oid, pay, p_order->>'client_at');
      return public._pos_receipt(oid);
    end if;
    return (public._pos_receipt(oid)::jsonb || '{"repeat": true}')::json;
  end if;
  if lno is not null then
    if nullif(p_order->>'ticket', '') is not null or jsonb_typeof(p_order->'promo') = 'object' then
      raise exception 'Penjualan offline tidak bisa memakai kartu member atau promo.';
    end if;
  end if;
  oid := public._pos_create(staff, p_order);
  if lno is not null then
    select * into o from pos_orders where id = oid;
    update pos_orders set local_no = lno,
      flags = flags || array['offline'] || case when expect is distinct from o.total then array['harga_offline_beda'] else '{}'::text[] end
     where id = oid;
    if expect is distinct from o.total then
      perform public._log('pos_harga_offline_beda', jsonb_build_object('order', oid, 'local_no', lno, 'tablet', expect, 'server', o.total));
      begin cash := (pay->>'cash')::int; exception when others then cash := null; end;
      -- Keep the change the cashier really gave (received - what the tablet charged).
      if pay->>'method' = 'tunai' and cash is not null then
        pay := pay || jsonb_build_object('cash', greatest(o.total, cash + (o.total - coalesce(expect, cash))));
      end if;
      pay := public._pos_campur_fix(pay, o.total);
    end if;
  end if;
  perform public._pos_settle(staff, oid, pay, p_order->>'client_at');
  return public._pos_receipt(oid);
end $$;

-- A receipt again (reprint or WhatsApp). Staff see today's; managers and the owner any.
create or replace function public.pos_receipt(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  o pos_orders; r text := (select role from profiles where id = staff);
begin
  select * into o from pos_orders where id = p_id;
  if o.id is null or (r = 'staff' and o.sale_day <> public._local(now())::date) then
    raise exception 'Struk tidak ditemukan.';
  end if;
  return public._pos_receipt(p_id);
end $$;

-- Today's orders at the booth, newest first, for the till's Hari ini list.
create or replace function public.pos_today() returns json
language plpgsql stable security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
begin
  return coalesce((select json_agg(x order by x.sold_at desc) from (
    select o.id, o.receipt_no, o.sold_at, o.total, o.payment_method, o.status, o.stamps, o.promo_label, o.note, o.refunded, o.customer_name,
      public._first_name(sp.full_name) as served_by,
      case when o.member_id is not null then public._first_name(mp.full_name) end as member,
      exists (select 1 from pos_void_requests v where v.order_id = o.id and v.status = 'menunggu') as void_pending
    from pos_orders o left join profiles sp on sp.id = o.served_by left join profiles mp on mp.id = o.member_id
    where o.outlet_id = 'papaya-bdg' and o.sale_day = public._local(now())::date) x), '[]');
end $$;

-- ---------------------------------------------------------------- shifts
-- Blind cash and continuous shifts (Glenn, 11 Nov 2026).
--   * Staff never see the uang modal, what the drawer should hold, or the difference. The owner
--     and managers see everything; every function below gives those figures only to them.
--   * There is always exactly one open shift. Tutup shift (count the drawer, print the rekap)
--     closes it and opens the next one at the very same timestamp, so shifts run from rekap to
--     rekap with no gap and every sale lands in a shift. The next shift's modal is the counted
--     drawer (carry-over). Cash the owner takes out is a 'setor' move (manager/owner only).
--   * settings.cash_float (Modal standar laci) is the first shift's modal and the level the
--     drawer is checked against ("laci di bawah modal standar" on the manager's home screen).
--   * The rekap prints once per close from a staff account; managers and the owner reprint,
--     marked CETAK ULANG and logged.
create or replace function public._pos_cash_full() returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce((select role in ('manager', 'owner') from profiles where id = auth.uid() and deleted_at is null), false) $$;

-- The open shift's id. When there is none (the very first shift, or after an old-style
-- close) one opens now with the last counted drawer, or the standard float.
create or replace function public._pos_open_shift_id(p_staff uuid, p_cash int default null, p_device text default null) returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare sid bigint; cash int; src text := 'standar';
begin
  select id into sid from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null;
  if sid is not null then return sid; end if;
  select counted_cash into cash from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is not null and counted_cash is not null
   order by closed_at desc limit 1;
  if cash is not null then src := 'bawaan'; else cash := (select cash_float from settings where id = 1); end if;
  if p_cash is not null and p_cash <> cash then cash := p_cash; src := 'diubah'; end if;
  insert into pos_shifts (opened_by, opening_cash, device, float_source, flags)
  values (p_staff, cash, nullif(left(trim(coalesce(p_device, '')), 60), ''), src,
          case when src = 'diubah' then array['modal_diubah'] else '{}'::text[] end)
  on conflict (outlet_id) where closed_at is null do nothing
  returning id into sid;
  if sid is null then select id into sid from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null; end if;
  perform public._log('pos_buka_shift', jsonb_build_object('shift', sid, 'cash', cash, 'source', src));
  return sid;
end $$;

-- Drawer = modal + cash received from buyers - change given + kas masuk - kas keluar - setor.
-- Received - change is the Tunai part of each order (pos_order_payments, 13 Nov 2026), so a split
-- Tunai + QRIS order only adds its Tunai part. A refunded order still counts here: a Tunai refund
-- is a kas keluar row; a Transfer or QRIS refund doesn't touch the drawer.
create or replace function public._pos_expected_cash(p_shift bigint) returns int
language sql stable security definer set search_path = public
as $$
  select sh.opening_cash
    + coalesce((select sum(p.amount) from pos_order_payments p join pos_orders o on o.id = p.order_id
                 where o.shift_id = sh.id and p.method = 'tunai' and o.status in ('dibayar', 'refund')), 0)::int
    + coalesce((select sum(case when c.kind = 'masuk' then c.amount else -c.amount end) from pos_cash_moves c where c.shift_id = sh.id), 0)::int
  from pos_shifts sh where sh.id = p_shift
$$;

-- What a shift's paid orders brought in per method: Tunai and QRIS from pos_order_payments (a split
-- order counts in both), platform and gratis from the order. {method: {count, amount}}.
create or replace function public._pos_shift_pay(p_shift bigint) returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_object_agg(x.m, jsonb_build_object('count', x.n, 'amount', x.a)), '{}') from (
    select p.method as m, count(*)::int as n, sum(p.amount)::int as a from pos_order_payments p join pos_orders o on o.id = p.order_id
     where o.shift_id = p_shift and o.status = 'dibayar' group by p.method
    union all
    select o.payment_method, count(*)::int, sum(o.total)::int from pos_orders o
     where o.shift_id = p_shift and o.status = 'dibayar' and o.payment_method in ('platform', 'gratis') group by o.payment_method) x
$$;

create or replace function public._pos_shift_json(p_shift bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare sh pos_shifts; v_full boolean := public._pos_cash_full(); j jsonb;
begin
  select * into sh from pos_shifts where id = p_shift;
  if sh.id is null then return null; end if;
  j := jsonb_build_object('id', sh.id, 'opened_at', sh.opened_at, 'closed_at', sh.closed_at,
    'opened_by', (select public._first_name(full_name) from profiles where id = sh.opened_by),
    'closed_by', (select public._first_name(full_name) from profiles where id = sh.closed_by),
    'device', sh.device,
    'orders', (select count(*) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'),
    'sales_total', coalesce((select sum(o.total) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0),
    'by_method', coalesce((select jsonb_object_agg(k, (v->>'amount')::int) from jsonb_each(public._pos_shift_pay(sh.id)) e (k, v)), '{}'),
    'split_count', (select count(*) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar' and o.payment_method = 'campur'),
    'voided', (select count(*) from pos_orders o where o.shift_id = sh.id and o.status <> 'dibayar'),
    'cash_in', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'masuk'), 0),
    'cash_out', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'keluar'), 0),
    -- Setor (cash the owner took) is left out for staff.
    'moves', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'amount', c.amount, 'reason', c.reason, 'at', c.created_at)
        order by c.created_at) from pos_cash_moves c where c.shift_id = sh.id and (v_full or c.kind <> 'setor')), '[]'),
    'cash_received', coalesce((select sum(o.cash_received) from pos_orders o where o.shift_id = sh.id and o.payment_method in ('tunai', 'campur') and o.status = 'dibayar'), 0),
    'change_given', coalesce((select sum(o.change_given) from pos_orders o where o.shift_id = sh.id and o.payment_method in ('tunai', 'campur') and o.status = 'dibayar'), 0),
    'counted_cash', sh.counted_cash, 'denominations', sh.denominations, 'note', sh.note,
    'printed_at', sh.printed_at, 'blind', not v_full);
  if v_full then
    j := j || jsonb_build_object('opening_cash', sh.opening_cash, 'float_source', sh.float_source,
      'setor', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'setor'), 0),
      'expected_cash', coalesce(sh.expected_cash, public._pos_expected_cash(sh.id)),
      'difference', sh.counted_cash - sh.expected_cash, 'flags', to_jsonb(sh.flags));
  end if;
  return j::json;
end $$;

-- Kept for the till and old callers: returns the open shift, opening one when there is none
-- (the very first shift). Staff can't choose the modal; a manager or the owner may give one
-- for a shift that opens here. A number sent by a staff account (an old till) is ignored.
drop function if exists public.pos_open_shift(int);
create or replace function public.pos_open_shift(p_opening_cash int default null, p_device text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  v_full boolean := public._pos_cash_full(); sid bigint;
begin
  if p_opening_cash is not null and v_full and (p_opening_cash < 0 or p_opening_cash > 10000000) then
    raise exception 'Isi uang modal di laci.';
  end if;
  -- Two statements: the stable _pos_shift_json must see the row the first one may insert.
  sid := public._pos_open_shift_id(staff, case when v_full then p_opening_cash end, p_device);
  return public._pos_shift_json(sid);
end $$;

-- Kas masuk / keluar (anyone on the till), and setor: cash taken out to the owner (managers and
-- the owner only; staff never see it).
create or replace function public.pos_cash_move(p_kind text, p_amount int, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); sid bigint;
begin
  if p_kind not in ('masuk', 'keluar', 'setor') then raise exception 'Pilih uang masuk atau uang keluar.'; end if;
  if p_kind = 'setor' and not public._pos_cash_full() then raise exception 'Setor hanya bisa dicatat manajer atau pemilik.'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000000 then raise exception 'Isi jumlah uang.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Tulis alasannya.'; end if;
  sid := public._pos_open_shift_id(staff);
  insert into pos_cash_moves (shift_id, kind, amount, reason, created_by) values (sid, p_kind, p_amount, trim(p_reason), staff);
  perform public._log('pos_kas_' || p_kind, jsonb_build_object('shift', sid, 'amount', p_amount, 'reason', trim(p_reason)));
  return public._pos_shift_json(sid);
end $$;

create or replace function public.pos_shift_now() returns json
language plpgsql stable security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
begin
  return public._pos_shift_json((select id from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null));
end $$;

-- ---------------------------------------------------------------- rekap kas
-- The shift's cash recap: the VireoPOS "Rekap Kas" layout plus orders, batal/refund, kas
-- moves, cash received and change, and the count. p_full adds the modal, the expected drawer,
-- the difference, flags and the drawer ledger (managers and the owner).
create or replace function public._pos_rekap(p_shift bigint, p_full boolean) returns json
language plpgsql stable security definer set search_path = public
as $$
declare sh pos_shifts; j jsonb; fmt text := 'DD/MM/YYYY HH24:MI'; t_end timestamptz;
begin
  select * into sh from pos_shifts where id = p_shift;
  if sh.id is null then return null; end if;
  t_end := coalesce(sh.closed_at, now());
  j := jsonb_build_object(
    'id', sh.id, 'closed', sh.closed_at is not null, 'opened_at', sh.opened_at, 'closed_at', sh.closed_at,
    'start', to_char(public._local(sh.opened_at), fmt),
    'end', case when sh.closed_at is not null then to_char(public._local(sh.closed_at), fmt) end,
    'now', to_char(public._local(now()), fmt),
    'outlet', 'Hanashuya ' || (select name from pos_outlets where id = sh.outlet_id),
    'device', sh.device,
    'opened_by', (select public._first_name(full_name) from profiles where id = sh.opened_by),
    'closed_by', (select public._first_name(full_name) from profiles where id = sh.closed_by),
    'staff', (select string_agg(distinct public._first_name(p.full_name), ', ') from profiles p where p.id in (sh.opened_by, sh.closed_by)),
    'printed_at', sh.printed_at, 'printed_time', to_char(public._local(sh.printed_at), 'HH24.MI'),
    'printed_by', (select public._first_name(full_name) from profiles where id = sh.printed_by), 'reprints', sh.reprints,
    -- Each product + flavour at the price it was sold for. Promo lines get their own row at the
    -- paid price, so the rows add up to Total; Subtotal is the same goods at the normal price.
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'flavour', x.flavour, 'qty', x.qty,
        'unit', case when x.net % x.qty = 0 then x.net / x.qty end, 'total', x.net, 'promo', x.promo, 'free_bag', x.free_bag)
        order by x.sort1, x.name, x.sort2, x.promo)
      from (select i.name, f.label as flavour, sum(i.qty)::int as qty, sum(i.line_total - i.discount)::int as net,
                   i.discount > 0 as promo, i.free_bag, min(coalesce(m.sort, 999)) as sort1, min(coalesce(f.sort, 999)) as sort2
              from pos_order_items i join pos_orders o on o.id = i.order_id
              left join pos_flavours f on f.id = i.flavour_id left join menu_items m on m.id = i.product_id
             where o.shift_id = sh.id and o.status = 'dibayar'
             group by i.name, f.label, i.discount > 0, i.free_bag,
                      case when i.discount > 0 then (i.line_total - i.discount) / i.qty else i.unit_price end) x), '[]'),
    'orders', (select count(*) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'),
    'subtotal', coalesce((select sum(o.subtotal) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0),
    'discount', coalesce((select sum(o.discount) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0),
    'total', coalesce((select sum(o.total) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0),
    -- Per method from pos_order_payments (13 Nov 2026): a Bayar 2 cara order counts in Tunai and
    -- in QRIS with its two parts, so the rows add up to Total; split_count says how many.
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', e.k, 'count', (e.v->>'count')::int, 'amount', (e.v->>'amount')::int)
        order by array_position(array['qris', 'tunai', 'platform', 'gratis'], e.k))
      from jsonb_each(public._pos_shift_pay(sh.id)) e (k, v)), '[]'),
    'split_count', (select count(*) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar' and o.payment_method = 'campur'),
    -- Promo items taken per promo (Glenn, 13 Nov 2026): orders, pieces with a discount and the rupiah
    -- discount, for BOGO, 50% malam, 50% instruksi, Tebus murah, member vouchers, stamp rewards and
    -- the owner's promos (one row per promo name).
    'promos', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'label', x.label, 'orders', x.orders, 'items', x.items,
        'discount', x.discount, 'by', x.who) order by x.ord, x.label)
      from (select case when o.promo_kind in ('welcome', 'ulang_tahun', 'kode') then 'voucher' else o.promo_kind end as kind,
                   case o.promo_kind when 'bogo' then 'BOGO' when 'malam50' then '50% malam' when 'instruksi50' then '50% instruksi'
                     when 'tebus_murah' then 'Tebus murah' when 'stempel' then 'Hadiah stempel' when 'promo' then coalesce(o.promo_label, 'Promo')
                     else 'Voucher member' end as label,
                   min(array_position(array['bogo', 'malam50', 'instruksi50', 'tebus_murah', 'welcome', 'ulang_tahun', 'kode', 'stempel', 'promo'], o.promo_kind)) as ord,
                   count(distinct o.id)::int as orders,
                   coalesce(sum((select sum(i.qty) from pos_order_items i where i.order_id = o.id and i.discount > 0)), 0)::int as items,
                   sum(o.discount)::int as discount,
                   string_agg(distinct (select public._first_name(full_name) from profiles where id = o.promo_by), ', ') as who
              from pos_orders o
             where o.shift_id = sh.id and o.status = 'dibayar' and o.promo_kind is not null and o.discount > 0
             group by 1, 2) x), '[]'),
    -- Cancelled before payment have no shift: they count by when they were made.
    'voids', jsonb_build_object(
      'batal_count', (select count(*) from pos_orders o where o.status = 'batal' and (o.shift_id = sh.id
          or (o.shift_id is null and o.outlet_id = sh.outlet_id and o.created_at >= sh.opened_at and o.created_at < t_end))),
      'batal_amount', coalesce((select sum(o.total) from pos_orders o where o.status = 'batal' and (o.shift_id = sh.id
          or (o.shift_id is null and o.outlet_id = sh.outlet_id and o.created_at >= sh.opened_at and o.created_at < t_end))), 0),
      -- Every approved refund of this shift's orders, whole or partial (13 Nov 2026), and where the money went.
      'refund_count', (select count(*) from pos_void_requests v join pos_orders o on o.id = v.order_id
          where o.shift_id = sh.id and v.kind = 'refund' and v.status = 'disetujui'),
      'refund_amount', coalesce((select sum(coalesce(v.amount, o.total)) from pos_void_requests v join pos_orders o on o.id = v.order_id
          where o.shift_id = sh.id and v.kind = 'refund' and v.status = 'disetujui'), 0)),
    'refunds', jsonb_build_object(
      'partial_count', (select count(*) from pos_void_requests v join pos_orders o on o.id = v.order_id
          where o.shift_id = sh.id and v.kind = 'refund' and v.status = 'disetujui' and v.lines is not null),
      'by_method', coalesce((select jsonb_object_agg(x.m, x.a) from (
          select coalesce(v.refund_method, case when o.payment_method = 'tunai' then 'tunai' else o.payment_method end) as m,
                 sum(coalesce(v.amount, o.total))::int as a
            from pos_void_requests v join pos_orders o on o.id = v.order_id
           where o.shift_id = sh.id and v.kind = 'refund' and v.status = 'disetujui' group by 1) x), '{}')),
    'moves', coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'amount', c.amount, 'reason', c.reason,
        'at', c.created_at, 'time', to_char(public._local(c.created_at), 'HH24.MI'),
        'by', (select public._first_name(full_name) from profiles where id = c.created_by)) order by c.created_at)
      from pos_cash_moves c where c.shift_id = sh.id and (p_full or c.kind <> 'setor')), '[]'),
    'cash_in', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'masuk'), 0),
    'cash_out', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'keluar'), 0),
    'cash_received', coalesce((select sum(o.cash_received) from pos_orders o where o.shift_id = sh.id and o.payment_method in ('tunai', 'campur') and o.status = 'dibayar'), 0),
    'change_given', coalesce((select sum(o.change_given) from pos_orders o where o.shift_id = sh.id and o.payment_method in ('tunai', 'campur') and o.status = 'dibayar'), 0),
    'tunai_count', (select count(*) from pos_orders o where o.shift_id = sh.id and o.payment_method in ('tunai', 'campur') and o.status = 'dibayar'),
    'counted_cash', sh.counted_cash, 'denominations', sh.denominations, 'note', sh.note,
    'blind', not p_full);
  if p_full then
    j := j || jsonb_build_object(
      'opening_cash', sh.opening_cash, 'float_source', sh.float_source,
      'setor', coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'setor'), 0),
      'expected_cash', coalesce(sh.expected_cash, public._pos_expected_cash(sh.id)),
      'difference', sh.counted_cash - sh.expected_cash, 'flags', to_jsonb(sh.flags),
      'cash_float', (select cash_float from settings where id = 1),
      'flag_at', (select cash_flag_at from settings where id = 1),
      -- The drawer ledger: modal, then every Tunai sale (+received, -change), kas masuk, keluar
      -- and setor, then the count, with the running balance the drawer should hold.
      'ledger', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'time', to_char(public._local(e.at), 'HH24.MI'),
          'kind', e.kind, 'label', e.label, 'received', e.received, 'change', e.chg, 'amount', e.amount,
          'balance', case when e.kind = 'hitung' then null else e.balance end,
          'counted', e.counted) order by e.at, e.ord)
        from (select u.*, sum(u.amount) over (order by u.at, u.ord rows unbounded preceding)::int as balance from (
          select sh.opened_at as at, 0 as ord, 'modal' as kind, 'Uang modal' as label, null::int as received, null::int as chg,
                 sh.opening_cash as amount, null::int as counted
          union all
          select o.sold_at, 1, case when o.status = 'refund' then 'jual_refund' else 'jual' end,
                 o.receipt_no || case when o.payment_method = 'campur' then ' (tunai + QRIS)' else '' end,
                 coalesce(o.cash_received, o.total), coalesce(o.change_given, 0), coalesce(o.cash_received, o.total) - coalesce(o.change_given, 0), null
            from pos_orders o where o.shift_id = sh.id and o.payment_method in ('tunai', 'campur') and o.status in ('dibayar', 'refund')
          union all
          select c.created_at, 2, c.kind, c.reason, null, null, case when c.kind = 'masuk' then c.amount else -c.amount end, null
            from pos_cash_moves c where c.shift_id = sh.id
          union all
          select sh.closed_at, 3, 'hitung', 'Uang laci dihitung', null, null, 0, sh.counted_cash where sh.closed_at is not null
        ) u) e), '[]'));
  end if;
  return j::json;
end $$;

-- Who may see a shift's rekap: managers and the owner any; staff the open shift or one they
-- closed today. Returns null when not allowed.
create or replace function public._pos_rekap_shift(me uuid, v_full boolean, p_shift bigint) returns bigint
language plpgsql stable security definer set search_path = public
as $$
declare sh pos_shifts; v_today date := public._local(now())::date;
begin
  if p_shift is null then
    -- The caller's last close today, else the open shift.
    select * into sh from pos_shifts where closed_at is not null and (v_full or closed_by = me)
       and public._local(closed_at)::date = v_today order by closed_at desc limit 1;
    if sh.id is null then select * into sh from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null; end if;
    return sh.id;
  end if;
  select * into sh from pos_shifts where id = p_shift;
  if sh.id is null then return null; end if;
  if v_full or sh.closed_at is null or (sh.closed_by = me and public._local(sh.closed_at)::date = v_today) then return sh.id; end if;
  return null;
end $$;

create or replace function public.pos_shift_rekap(p_shift bigint default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  v_full boolean := public._pos_cash_full(); sid bigint := public._pos_rekap_shift(me, v_full, p_shift);
begin
  if sid is null then raise exception 'Rekap shift tidak ditemukan.'; end if;
  return public._pos_rekap(sid, v_full);
end $$;

-- Tutup shift = count + rekap. Blind: the cashier counts the drawer per note (p_denominations,
-- e.g. {"100000": 2, "50000": 1, ..., "koin": 3500}; koin is a rupiah amount) and sends the
-- total. The server stores expected, counted and difference; staff only get the blind rekap,
-- and their note is optional. A difference beyond settings.cash_flag_at is flagged
-- 'selisih_kas'. A manager or the owner sees the difference, so they write a note when it
-- isn't zero. In the same transaction the next shift opens at the same timestamp with the
-- counted drawer as its modal. Returns the closed shift's rekap plus next_shift.
drop function if exists public.pos_close_shift(int, text);
drop function if exists public.pos_close_shift(int, text, jsonb);
create or replace function public.pos_close_shift(p_counted_cash int, p_note text default null, p_denominations jsonb default null,
  p_device text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); sh pos_shifts; exp int; diff int;
  v_full boolean := public._pos_cash_full(); f text[] := '{}'; den jsonb; k text; v text; n bigint; tot bigint := 0;
  t timestamptz := now(); nid bigint; pid bigint;
begin
  select * into sh from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null for update;
  if sh.id is null then raise exception 'Tidak ada shift yang terbuka.'; end if;
  if p_counted_cash is null or p_counted_cash < 0 or p_counted_cash > 100000000 then raise exception 'Isi jumlah uang di laci.'; end if;
  -- The same close sent twice (a double tap, 13 Nov 2026): the shift open now began less than
  -- a minute ago from this cashier's close with the same count, and nothing has happened in
  -- it. Give back that close's rekap instead of closing the new, empty shift too.
  if sh.opened_at > t - interval '1 minute' and sh.opening_cash = p_counted_cash and sh.float_source = 'bawaan'
     and not exists (select 1 from pos_orders x where x.shift_id = sh.id)
     and not exists (select 1 from pos_cash_moves c where c.shift_id = sh.id) then
    -- Only a true repeat: the same count, the same pecahan and the same note as that close.
    select id into pid from pos_shifts where outlet_id = sh.outlet_id and closed_at = sh.opened_at and closed_by = staff
       and denominations is not distinct from case when jsonb_typeof(p_denominations) = 'object' then p_denominations end
       and note is not distinct from nullif(trim(coalesce(p_note, '')), '')
     order by id desc limit 1;
    if pid is not null then
      return (public._pos_rekap(pid, v_full)::jsonb || jsonb_build_object('next_shift', public._pos_shift_json(sh.id), 'repeat', true))::json;
    end if;
  end if;
  if exists (select 1 from pos_orders where outlet_id = sh.outlet_id and status = 'menunggu') then
    raise exception 'Masih ada pesanan yang menunggu pembayaran. Selesaikan atau minta manajer membatalkannya dulu.';
  end if;
  if p_denominations is not null and jsonb_typeof(p_denominations) <> 'null' then
    if jsonb_typeof(p_denominations) <> 'object' then raise exception 'Hitungan pecahan uang tidak terbaca.'; end if;
    den := '{}';
    for k, v in select key, value from jsonb_each_text(p_denominations) loop
      if k not in ('100000', '50000', '20000', '10000', '5000', '2000', '1000', 'koin') then
        raise exception 'Pecahan % tidak dikenal.', k;
      end if;
      begin n := v::bigint; exception when others then n := null; end;
      if n is null or n < 0 or n > 100000000 then raise exception 'Jumlah untuk pecahan % tidak benar.', k; end if;
      den := den || jsonb_build_object(k, n);
      tot := tot + case when k = 'koin' then n else k::bigint * n end;
    end loop;
    if tot <> p_counted_cash then
      raise exception 'Jumlah per pecahan (%) tidak sama dengan total uang di laci (%).', public._rp(tot::int), public._rp(p_counted_cash);
    end if;
  end if;
  exp := public._pos_expected_cash(sh.id);
  diff := p_counted_cash - exp;
  if v_full and diff <> 0 and coalesce(trim(p_note), '') = '' then
    raise exception 'Uang di laci beda % dari catatan. Tulis catatan sebelum menutup shift.', public._rp(diff);
  end if;
  if abs(diff) > (select cash_flag_at from settings where id = 1) then f := array['selisih_kas']; end if;
  update pos_shifts set closed_at = t, closed_by = staff, expected_cash = exp, counted_cash = p_counted_cash,
    note = nullif(trim(coalesce(p_note, '')), ''), denominations = den, flags = sh.flags || f where id = sh.id;
  -- The next shift, from the same second, with the counted drawer as its modal.
  insert into pos_shifts (outlet_id, opened_by, opened_at, opening_cash, device, float_source)
  values (sh.outlet_id, staff, t, p_counted_cash, coalesce(nullif(left(trim(coalesce(p_device, '')), 60), ''), sh.device), 'bawaan')
  returning id into nid;
  perform public._log('pos_tutup_shift', jsonb_build_object('shift', sh.id, 'expected', exp, 'counted', p_counted_cash,
    'difference', diff, 'flagged', cardinality(f) > 0, 'next_shift', nid));
  return (public._pos_rekap(sh.id, v_full)::jsonb || jsonb_build_object('next_shift', public._pos_shift_json(nid)))::json;
end $$;

-- After the rekap went to the printer. A staff account prints once per close; a second try
-- is refused. A manager or the owner may print again: the copy says CETAK ULANG and each
-- reprint is logged with its time.
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
      raise exception 'Rekap hari ini sudah dicetak jam %. Minta manajer atau pemilik kalau perlu cetak ulang.',
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

-- A PDF of the rekap (to send to the team WhatsApp group). Any number of times, but each
-- export is logged with who and when. Same access as the rekap itself.
create or replace function public.pos_rekap_exported(p_shift bigint) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  sid bigint := public._pos_rekap_shift(me, public._pos_cash_full(), p_shift);
begin
  if sid is null then raise exception 'Rekap shift tidak ditemukan.'; end if;
  perform public._log('pos_rekap_pdf', jsonb_build_object('shift', sid, 'at', now(), 'full', public._pos_cash_full()));
  return json_build_object('at', now());
end $$;

-- ---------------------------------------------------------------- voids and refunds
-- Batal (same visit, the whole order) or refund (money back later). Since 13 Nov 2026 (Glenn) a
-- refund can be partial: p_lines [{line, qty}] picks lines and pieces (null = everything still
-- not refunded), and p_refund_method says where the money goes: 'tunai' (out of the drawer),
-- 'transfer' or 'qris' (refund through the QRIS app). The amount is the price paid for those
-- pieces (line_total - discount, shared per piece so the whole line adds up exactly).
-- The request stores lines (null = the whole order), refund_method and amount.
drop function if exists public.pos_request_void(uuid, text, text);
create or replace function public._pos_refund_lines(o pos_orders, p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare e jsonb; i pos_order_items; q int; seen int[] := '{}'; out_ jsonb := '[]';
begin
  if p_lines is null or jsonb_typeof(p_lines) = 'null' then
    -- Everything not refunded yet.
    return coalesce((select jsonb_agg(jsonb_build_object('line', x.line, 'qty', x.qty - x.refunded_qty) order by x.line)
      from pos_order_items x where x.order_id = o.id and x.qty > x.refunded_qty), '[]');
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Pilih barang yang dikembalikan.'; end if;
  for e in select * from jsonb_array_elements(p_lines) loop
    begin select * into i from pos_order_items where order_id = o.id and line = (e->>'line')::int; exception when others then i := null; end;
    if i.order_id is null then raise exception 'Baris pesanan tidak dikenal.'; end if;
    if i.line = any (seen) then raise exception 'Baris % dipilih dua kali.', i.name; end if;
    seen := seen || i.line;
    begin q := (e->>'qty')::int; exception when others then q := null; end;
    if q is null or q < 1 then raise exception 'Isi jumlah % yang dikembalikan.', i.name; end if;
    if q > i.qty - i.refunded_qty then
      raise exception '% hanya tersisa % yang bisa dikembalikan.', i.name, i.qty - i.refunded_qty;
    end if;
    out_ := out_ || jsonb_build_object('line', i.line, 'qty', q);
  end loop;
  return out_;
end $$;

-- The price paid for these pieces: per line, net * (done + q) / qty - net * done / qty, plus their share of the
-- service charge and of PBJT added on top (14 Nov 2026). Refunding everything still left returns exactly what is left.
drop function if exists public._pos_refund_amount(uuid, jsonb);
create or replace function public._pos_refund_amount(p_order uuid, p_lines jsonb) returns int
language plpgsql stable security definer set search_path = public
as $$
declare o pos_orders; net int; extra int; rest boolean;
begin
  select * into o from pos_orders where id = p_order;
  select coalesce(sum(((i.line_total - i.discount) * (i.refunded_qty + (e->>'qty')::int)) / i.qty
                      - ((i.line_total - i.discount) * i.refunded_qty) / i.qty), 0)::int into net
    from jsonb_array_elements(coalesce(p_lines, '[]')) e join pos_order_items i on i.order_id = p_order and i.line = (e->>'line')::int;
  extra := o.service_charge + case when o.tax_included then 0 else o.tax end;
  if extra = 0 or o.subtotal - o.discount <= 0 then return net; end if;
  select not exists (select 1 from pos_order_items i left join (select (e->>'line')::int as line, (e->>'qty')::int as qty
           from jsonb_array_elements(coalesce(p_lines, '[]')) e) x on x.line = i.line
          where i.order_id = p_order and i.qty - i.refunded_qty - coalesce(x.qty, 0) > 0) into rest;
  if rest then return o.total - o.refunded; end if;
  return net + round(net::numeric * extra / (o.subtotal - o.discount))::int;
end $$;

create or replace function public.pos_request_void(p_order uuid, p_kind text, p_reason text,
  p_lines jsonb default null, p_refund_method text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); o pos_orders;
  ls jsonb; amt int; met text := nullif(p_refund_method, ''); whole boolean; rid bigint;
begin
  if p_kind not in ('batal', 'refund') then raise exception 'Pilih batal atau refund.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Tulis alasannya.'; end if;
  if length(trim(p_reason)) > 200 then raise exception 'Alasan paling panjang 200 huruf.'; end if;
  select * into o from pos_orders where id = p_order;
  if o.id is null or o.status not in ('dibayar', 'menunggu') then raise exception 'Pesanan ini tidak bisa dibatalkan.'; end if;
  if o.status = 'menunggu' and p_kind <> 'batal' then raise exception 'Pesanan ini belum dibayar, jadi pilih batal.'; end if;
  if exists (select 1 from pos_void_requests where order_id = o.id and status = 'menunggu') then
    raise exception 'Permintaan untuk pesanan ini sudah dikirim.';
  end if;
  if p_kind = 'batal' then
    if p_lines is not null and jsonb_typeof(p_lines) <> 'null' then raise exception 'Batal selalu untuk seluruh pesanan. Pilih refund untuk sebagian.'; end if;
    if o.refunded > 0 then raise exception 'Pesanan ini sudah direfund sebagian. Pilih refund untuk sisanya.'; end if;
    met := null; amt := case when o.status = 'dibayar' then o.total end;
  else
    if met is null then met := case when o.payment_method = 'tunai' then 'tunai' when o.payment_method = 'qris' then 'qris' else 'transfer' end; end if;
    if met not in ('tunai', 'transfer', 'qris') then raise exception 'Pilih uang dikembalikan lewat Tunai, Transfer atau QRIS.'; end if;
    ls := public._pos_refund_lines(o, p_lines);
    if jsonb_array_length(ls) = 0 then raise exception 'Semua barang di pesanan ini sudah direfund.'; end if;
    amt := public._pos_refund_amount(o.id, ls);
    if amt <= 0 then raise exception 'Barang yang dipilih tidak punya nilai uang (gratis atau promo). Pilih barang lain.'; end if;
    -- The whole order, never refunded before: stored as lines null, like before partial refunds.
    whole := o.refunded = 0 and not exists (
      select 1 from pos_order_items x where x.order_id = o.id
         and x.qty <> coalesce((select (e->>'qty')::int from jsonb_array_elements(ls) e where (e->>'line')::int = x.line), 0));
    if whole then ls := null; end if;
  end if;
  insert into pos_void_requests (order_id, kind, reason, requested_by, lines, refund_method, amount)
  values (o.id, p_kind, trim(p_reason), staff, ls, met, amt) returning id into rid;
  perform public._log('pos_minta_' || p_kind, jsonb_build_object('order', o.id, 'receipt', o.receipt_no, 'reason', trim(p_reason),
    'lines', ls, 'refund_method', met, 'amount', amt));
  return json_build_object('id', rid, 'kind', p_kind, 'amount', amt, 'refund_method', met, 'lines', ls);
end $$;

-- Puts the recipe of the given lines back into stock (a partial refund). Needs stock.sql.
create or replace function public._pos_stock_return_lines(p_order uuid, p_lines jsonb, p_reason text) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  if to_regproc('public._stock_recipe') is null or to_regclass('public.stock_moves') is null then return; end if;
  execute $q$
    insert into stock_moves (item_id, kind, qty, day, order_id, reason, created_by)
    select r.item_id, 'batal_penjualan', sum(x.q * r.qty), public._local(now())::date, $1, $2, auth.uid()
      from (select i.product_id, i.flavour_id, (e->>'qty')::int as q from jsonb_array_elements($3) e
              join pos_order_items i on i.order_id = $1 and i.line = (e->>'line')::int) x
      cross join lateral public._stock_recipe(x.product_id, x.flavour_id) r
     group by r.item_id having sum(x.q * r.qty) <> 0 $q$ using p_order, p_reason, p_lines;
end $$;

-- A manager or the owner decides (never their own request, unless the owner). Approving a batal
-- gives back the stamps, the promo and the stock. Approving a refund (13 Nov 2026):
--   * the chosen pieces go back into stock, and refunded_qty / refunded record them;
--   * Tunai takes the money out of the open shift's drawer (kas keluar); Transfer and QRIS don't;
--   * stamps are worked out again from what is left paid (never more than the order gave, never
--     below 0), and the sales row follows; a member voucher or reward comes back once every
--     discounted line is refunded;
--   * when nothing paid is left the order becomes 'refund' (the whole order), as before.
create or replace function public.pos_decide_void(p_id bigint, p_approve boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menyetujui pembatalan.');
  v pos_void_requests; o pos_orders; sid bigint; ls jsonb; amt int; met text; left_ int; per int; mult int; st int; part boolean;
begin
  select * into v from pos_void_requests where id = p_id and status = 'menunggu' for update;
  if v.id is null then raise exception 'Permintaan ini sudah diputuskan.'; end if;
  -- 13 Nov 2026: a manager can't approve their own batal or refund; the owner decides it.
  if v.requested_by = me and (select role from profiles where id = me) <> 'owner' then
    raise exception 'Permintaan Anda sendiri diputuskan oleh pemilik.';
  end if;
  select * into o from pos_orders where id = v.order_id for update;
  if p_approve then
    if o.status = 'menunggu' then
      -- Not paid yet: cancel it and give the held promo back; there are no stamps or stock to undo.
      update pos_orders set status = 'batal' where id = o.id;
      update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
      if o.member_id is not null then perform public._sync_cycles(o.member_id); end if;
      update pos_void_requests set status = 'disetujui', decided_by = me, decided_at = now() where id = v.id;
      perform public._log('pos_setujui_batal', jsonb_build_object('request', v.id, 'order', o.id, 'receipt', o.receipt_no));
      return json_build_object('receipt_no', o.receipt_no, 'status', 'batal');
    end if;
    if o.status <> 'dibayar' then raise exception 'Pesanan ini sudah dibatalkan.'; end if;

    if v.kind = 'batal' then
      update pos_orders set status = 'batal' where id = o.id;
      update sales set reversed_at = now(), reversed_by = me where id = o.sale_id and reversed_at is null;
      update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
      if o.payment_method in ('tunai', 'campur') and o.total > 0 then
        -- A batal drops the order from its own shift's expected drawer. When that shift is
        -- already closed (Tutup shift came between the sale and the approval), the closed shift
        -- keeps the cash it counted and the money goes back out of today's drawer: record it as
        -- Kas keluar in the shift open now, as a refund does (parity B2, 13 Nov 2026).
        sid := public._pos_open_shift_id(me);
        if o.shift_id is distinct from sid then
          insert into pos_cash_moves (shift_id, kind, amount, reason, order_id, created_by)
          values (sid, 'keluar', coalesce((select amount from pos_order_payments where order_id = o.id and method = 'tunai'), 0),
                  'Batal ' || o.receipt_no, o.id, me);
        end if;
      end if;
      -- Task 15 (stock) puts the recipe back here (only when stock.sql has been run).
      if to_regproc('public._stock_reverse_order') is not null then
        execute 'select public._stock_reverse_order($1)' using o.id;
      end if;
    else
      -- Refund, whole or partial. Old requests (before 13 Nov 2026) have no lines: the whole order.
      ls := public._pos_refund_lines(o, v.lines);
      if jsonb_array_length(ls) = 0 then raise exception 'Semua barang di pesanan ini sudah direfund.'; end if;
      amt := least(coalesce(v.amount, public._pos_refund_amount(o.id, ls)), o.total - o.refunded);
      met := coalesce(v.refund_method, case when o.payment_method = 'tunai' then 'tunai' end);
      update pos_order_items i set refunded_qty = i.refunded_qty + (e->>'qty')::int
        from jsonb_array_elements(ls) e where i.order_id = o.id and i.line = (e->>'line')::int;
      update pos_orders set refunded = refunded + amt where id = o.id;
      left_ := o.total - o.refunded - amt;
      part := left_ > 0;
      if met = 'tunai' and amt > 0 then
        sid := public._pos_open_shift_id(me);
        insert into pos_cash_moves (shift_id, kind, amount, reason, order_id, created_by)
        values (sid, 'keluar', amt, case when part or o.refunded > 0 then 'Refund sebagian ' else 'Refund ' end || o.receipt_no, o.id, me);
      end if;
      if v.lines is null and o.refunded = 0 and to_regproc('public._stock_reverse_order') is not null then
        -- The whole order at once: put back exactly what the sale took, as before.
        update pos_orders set status = 'refund' where id = o.id;
        execute 'select public._stock_reverse_order($1)' using o.id;
      else
        perform public._pos_stock_return_lines(o.id, ls, case when part or o.refunded > 0 then 'Refund sebagian ' else 'Refund ' end || o.receipt_no);
      end if;
      -- A member voucher or reward comes back once every line that carried its discount is refunded.
      if not exists (select 1 from pos_order_items i where i.order_id = o.id and i.discount > 0 and i.refunded_qty < i.qty) then
        update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
      end if;
      if part then
        -- Stamps from what is still paid: never more than the order gave, never below 0.
        per := greatest(1, (select rupiah_per_stamp from settings where id = 1));
        mult := coalesce((select b.multiplier from stamp_boosts b where b.id = o.stamp_boost_id), 1);
        st := greatest(0, least(o.stamps, ((left_::bigint * (o.subtotal - o.discount) / nullif(o.total, 0)) / per) * mult));
        update pos_orders set stamps = st where id = o.id;
        update sales set total = left_, stamps = st where id = o.sale_id and reversed_at is null;
      else
        update pos_orders set status = 'refund' where id = o.id;
        update sales set reversed_at = now(), reversed_by = me where id = o.sale_id and reversed_at is null;
        update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
      end if;
    end if;
    if o.member_id is not null then perform public._sync_cycles(o.member_id); end if;
  end if;
  update pos_void_requests set status = case when p_approve then 'disetujui' else 'ditolak' end,
    decided_by = me, decided_at = now() where id = v.id;
  perform public._log(case when p_approve then 'pos_setujui_' else 'pos_tolak_' end || v.kind,
    jsonb_build_object('request', v.id, 'order', o.id, 'receipt', o.receipt_no, 'amount', amt, 'refund_method', met,
      'lines', v.lines, 'partial', coalesce(part, false)));
  if p_approve then perform public._pos_acc_post(public._local(now())::date, o.id); end if;
  return json_build_object('receipt_no', o.receipt_no,
    'status', case when not p_approve then o.status when v.kind = 'refund' and part then 'dibayar' else v.kind end,
    'amount', amt, 'refund_method', met, 'partial', coalesce(part, false));
end $$;

-- Waiting requests for Persetujuan. For a refund, total is the amount to give back and
-- payment_method where it goes (Tunai / Transfer / QRIS), so the manager sees what they approve;
-- order_total and order_method keep the order's own figures. detail lists the pieces of a partial refund.
create or replace function public.pos_void_list() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(x order by x.created_at) from (
    select v.id, v.kind, v.created_at, o.receipt_no, o.sold_at,
      case when v.kind = 'refund' then coalesce(v.amount, o.total) else o.total end as total,
      case when v.kind = 'refund' then coalesce(v.refund_method, o.payment_method) else o.payment_method end as payment_method,
      o.total as order_total, o.payment_method as order_method, v.amount, v.refund_method, v.lines,
      d.detail,
      v.reason || case when d.detail is not null then ' · Dikembalikan: ' || d.detail else '' end as reason,
      v.reason as reason_only,
      public._first_name(p.full_name) as requested_by
    from pos_void_requests v join pos_orders o on o.id = v.order_id left join profiles p on p.id = v.requested_by
    left join lateral (select string_agg((e->>'qty') || ' ' || i.name || coalesce(' ' || f.label, ''), ', ' order by i.line) as detail
                         from jsonb_array_elements(case when jsonb_typeof(v.lines) = 'array' then v.lines else '[]' end) e
                         join pos_order_items i on i.order_id = o.id and i.line = (e->>'line')::int
                         left join pos_flavours f on f.id = i.flavour_id) d on true
    where v.status = 'menunggu') x), '[]');
end $$;

-- ---------------------------------------------------------------- owner: products
-- Who may change products, categories and prices: the ONE place for this check. Owner only
-- (Glenn, 11 Nov 2026). To let managers in later, change array['owner'] below to
-- array['manager', 'owner'] (and the message). Every owner_* function of Produk calls it.
create or replace function public._pos_product_admin() returns uuid
language plpgsql stable security definer set search_path = public
as $$
begin
  return public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
end $$;

-- A product can be on only while its category is on.
create or replace function public._pos_category_live(p_category int) returns void
language plpgsql stable security definer set search_path = public
as $$
declare c pos_categories;
begin
  select * into c from pos_categories where id = p_category;
  if c.id is null then raise exception 'Kategori tidak dikenal.'; end if;
  if not c.active then raise exception 'Kategori % sedang dimatikan. Aktifkan kategorinya dulu.', c.name; end if;
end $$;

-- Prices and surcharges are owner-only (Glenn, 11 Nov 2026).
create or replace function public.owner_save_pos_product(p_code text, p_price int, p_flavour_surcharge int, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); pr menu_items;
begin
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  if p_price is null or p_price < 0 or coalesce(p_flavour_surcharge, 0) < 0 then raise exception 'Harga tidak valid.'; end if;
  if coalesce(p_active, true) and pr.archived_at is not null then raise exception '% ada di arsip. Kembalikan dulu dari arsip.', coalesce(pr.pos_name, pr.name); end if;
  if coalesce(p_active, true) and not pr.active and pr.category_id is not null then perform public._pos_category_live(pr.category_id); end if;
  update menu_items set price = p_price, flavour_surcharge = coalesce(p_flavour_surcharge, 0), active = coalesce(p_active, true)
   where id = pr.id;
  perform public._log('pos_ubah_produk', jsonb_build_object('code', p_code, 'dari', pr.price, 'jadi', p_price,
    'surcharge', p_flavour_surcharge, 'active', p_active));
end $$;

-- A manager or the owner starts BOGO Deals before 19.00 (SOP: "atau saat diinstruksikan manager").
create or replace function public.pos_start_bogo() returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya manajer atau pemilik yang bisa memulai BOGO Deals lebih awal.');
begin
  insert into pos_bogo_days (outlet_id, day, started_by) values ('papaya-bdg', public._local(now())::date, me)
  on conflict do nothing;
  perform public._log('pos_mulai_bogo', jsonb_build_object('day', public._local(now())::date));
  return json_build_object('bogo_active', true);
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and (p.proname like 'pos\_%' or p.proname like '\_pos\_%'
      or p.proname in ('_rp', 'owner_charges', 'owner_set_charges', 'owner_save_pos_product', 'owner_stamp_boosts', 'owner_save_stamp_boost', '_stamp_boost_at',
        'owner_commission_rules', 'owner_save_commission_rule'))
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;

-- Backfill (13 Nov 2026, safe to re-run): sales and rewards from the till belong to who served, not to the
-- signed-in account. Before this, a sale made on the tablet's kasir account showed 0 for the staff in Ringkasan.
update sales x set staff_id = o.served_by from pos_orders o
 where o.sale_id = x.id and o.served_by is not null and x.staff_id is distinct from o.served_by;
update redemptions x set staff_id = o.served_by from pos_orders o
 where o.redemption_id = x.id and o.served_by is not null and x.staff_id is distinct from o.served_by;
