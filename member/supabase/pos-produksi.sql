-- Hanashuya POS: stock locations, transfers, production and the Kartu stok (owner back office,
-- Transaksi group, 12 Nov 2026; modelled on VireoPOS Stok Transfer, Transfer Order, Surat Jalan
-- Transfer, Penerimaan Transfer, Produksi, Bongkar Produksi and Laporan Stok > Kartu Stok).
-- Run in the Supabase SQL Editor LAST, after akunting.sql. Safe to run again.
--
-- Locations. Hanashuya has the booth (inside Papaya) and the kitchen (Dapur) where the choux are
-- baked. "Booth" (code 'booth') is the stock everything else already uses: its balance is still
-- the ledger stock_moves of stock.sql, so sales, samples, goods in, opname, adjustments and the
-- reports work exactly as before. Every other location keeps its own append-only ledger,
-- stock_loc_moves. A move that touches the Booth (a transfer in or out, production at the booth)
-- is written into stock_moves with a new kind:
--   pindah     stock moved between locations (minus at the source, plus at the destination)
--   produksi   Produksi: components minus, the made item plus
--   bongkar    Bongkar produksi: the made item minus, components plus
-- Other locations also have penyesuaian (a correction, e.g. the opening stock of the Dapur).
-- stock_move_docs links a Booth move to its document number (the Booth ledger is not changed).
--
-- Transfers:
--   stock_transfer_create         Stok transfer: one step, moves the stock at once (ST-YYMMDD-NN)
--   stock_transfer_order_create   Transfer order: a request (TO-), nothing moves yet
--   stock_shipment_create         Surat jalan (SJ-), from an open transfer order, partial allowed;
--                                 the stock leaves the source and is "dalam perjalanan"
--   stock_transfer_receive        Penerimaan transfer (PT-), from a surat jalan; the stock arrives,
--                                 a difference is recorded per line with a reason
-- Production:
--   stock_production_recipe_save  the owner sets what one unit of an item is made from
--   stock_production_create       Produksi (PR-) or Bongkar produksi (BP-) at one location
-- Kartu stok: stock_card_summary (per item, per location) and stock_card (every move of one item).
--
-- Accounting (akunting.sql): acc_sync only posts stock moves of kinds sampel, promo, buang and rusak,
-- so transfers and production create no journals. That is intended: Persediaan is one account for
-- every location (a transfer does not change its value) and production is treated as value-neutral.
-- A transfer difference (lost on the way) and a penyesuaian at another location are not journaled;
-- like an accepted opname at the booth, they show only in the stock. Nothing in akunting.sql is changed.
--
-- Rights: managers and the owner do transfers, production and adjustments at other locations and
-- read the Kartu stok; only the owner adds, renames or switches off locations and sets production recipes.

-- ---------------------------------------------------------------- the Booth ledger accepts the new kinds
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'stock_moves_kind_check' and conrelid = 'public.stock_moves'::regclass
                   and pg_get_constraintdef(oid) like '%bongkar%') then
    alter table public.stock_moves drop constraint if exists stock_moves_kind_check;
    alter table public.stock_moves add constraint stock_moves_kind_check check (kind in ('masuk', 'penjualan', 'batal_penjualan',
      'sampel', 'buang', 'rusak', 'promo', 'potong_liner', 'koreksi', 'pindah', 'produksi', 'bongkar'));
  end if;
end $$;

-- ---------------------------------------------------------------- locations
create table if not exists public.stock_locations (
  id int generated always as identity primary key,
  code text unique,                 -- 'booth' and 'dapur' for the starting two, null for ones the owner adds
  name text not null check (length(trim(name)) between 1 and 40),
  note text check (length(note) <= 200),
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists stock_locations_name on public.stock_locations (lower(name));
insert into public.stock_locations (code, name, sort) values ('booth', 'Booth', 1), ('dapur', 'Dapur', 2) on conflict do nothing;

-- The ledger of every location except the Booth (append-only, like stock_moves).
create table if not exists public.stock_loc_moves (
  id bigint generated always as identity primary key,
  location_id int not null references public.stock_locations (id),
  item_id int not null references public.stock_items (id),
  kind text not null check (kind in ('pindah', 'produksi', 'bongkar', 'penyesuaian')),
  qty numeric(12, 2) not null check (qty <> 0),
  day date not null,
  doc_type text,
  doc_id bigint,
  doc_no text,
  reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stock_loc_moves_item on public.stock_loc_moves (location_id, item_id, day);

-- Document of a Booth move written by this file (no foreign key, so clearing test data in stock_moves still works).
create table if not exists public.stock_move_docs (
  move_id bigint primary key,
  doc_type text not null,
  doc_id bigint not null,
  doc_no text not null
);

create table if not exists public.stock_doc_counters (
  prefix text not null,
  day date not null,
  n int not null,
  primary key (prefix, day)
);

-- ---------------------------------------------------------------- transfers
create table if not exists public.stock_transfers (
  id bigint generated always as identity primary key,
  no text not null unique,
  kind text not null check (kind in ('langsung', 'order')),
  from_location int not null references public.stock_locations (id),
  to_location int not null references public.stock_locations (id),
  day date not null,
  needed_by date,
  note text,
  status text not null check (status in ('selesai', 'dibuka', 'sebagian', 'terkirim', 'batal')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text,
  check (from_location <> to_location)
);
create index if not exists stock_transfers_day on public.stock_transfers (day);
create table if not exists public.stock_transfer_lines (
  transfer_id bigint not null references public.stock_transfers (id),
  item_id int not null references public.stock_items (id),
  qty numeric(12, 2) not null check (qty > 0),
  stock_at numeric(12, 2) not null default 0,     -- stock at the source when it was written
  primary key (transfer_id, item_id)
);
create table if not exists public.stock_shipments (
  id bigint generated always as identity primary key,
  no text not null unique,
  transfer_id bigint not null references public.stock_transfers (id),
  day date not null,
  note text,
  status text not null default 'dalam_perjalanan' check (status in ('dalam_perjalanan', 'diterima', 'batal')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text
);
create index if not exists stock_shipments_transfer on public.stock_shipments (transfer_id);
create table if not exists public.stock_shipment_lines (
  shipment_id bigint not null references public.stock_shipments (id),
  item_id int not null references public.stock_items (id),
  qty numeric(12, 2) not null check (qty > 0),
  primary key (shipment_id, item_id)
);
create table if not exists public.stock_transfer_receipts (
  id bigint generated always as identity primary key,
  no text not null unique,
  shipment_id bigint not null unique references public.stock_shipments (id),
  day date not null,
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.stock_transfer_receipt_lines (
  receipt_id bigint not null references public.stock_transfer_receipts (id),
  item_id int not null references public.stock_items (id),
  shipped numeric(12, 2) not null,
  received numeric(12, 2) not null check (received >= 0),
  reason text,
  primary key (receipt_id, item_id),
  check (received <= shipped)
);

-- ---------------------------------------------------------------- production
-- What one unit of an item is made from (Komponen in VireoPOS), e.g. 1 g Vla Vanilla from its ingredients.
create table if not exists public.stock_production_recipes (
  item_id int not null references public.stock_items (id),
  component_id int not null references public.stock_items (id),
  qty numeric(12, 4) not null check (qty > 0),
  primary key (item_id, component_id),
  check (item_id <> component_id)
);
create table if not exists public.stock_productions (
  id bigint generated always as identity primary key,
  no text not null unique,
  kind text not null check (kind in ('produksi', 'bongkar')),
  item_id int not null references public.stock_items (id),
  qty numeric(12, 2) not null check (qty > 0),
  location_id int not null references public.stock_locations (id),
  day date not null,
  note text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stock_productions_day on public.stock_productions (day);
create table if not exists public.stock_production_lines (
  production_id bigint not null references public.stock_productions (id),
  component_id int not null references public.stock_items (id),
  per_unit numeric(12, 4) not null,
  qty numeric(12, 2) not null,          -- used (produksi) or given back (bongkar)
  stock_at numeric(12, 2) not null,     -- stock of the component at the location before
  primary key (production_id, component_id)
);

create or replace function public._stock_loc_locked() returns trigger
language plpgsql
as $$ begin raise exception 'Catatan stok tidak bisa diubah atau dihapus. Catat penyesuaian.'; end $$;
drop trigger if exists stock_loc_moves_locked on public.stock_loc_moves;
create trigger stock_loc_moves_locked before update or delete on public.stock_loc_moves
  for each row execute function public._stock_loc_locked();

-- ---------------------------------------------------------------- row security
alter table public.stock_locations enable row level security;
alter table public.stock_loc_moves enable row level security;
alter table public.stock_move_docs enable row level security;
alter table public.stock_doc_counters enable row level security;
alter table public.stock_transfers enable row level security;
alter table public.stock_transfer_lines enable row level security;
alter table public.stock_shipments enable row level security;
alter table public.stock_shipment_lines enable row level security;
alter table public.stock_transfer_receipts enable row level security;
alter table public.stock_transfer_receipt_lines enable row level security;
alter table public.stock_production_recipes enable row level security;
alter table public.stock_productions enable row level security;
alter table public.stock_production_lines enable row level security;
revoke all on public.stock_locations, public.stock_loc_moves, public.stock_move_docs, public.stock_doc_counters,
  public.stock_transfers, public.stock_transfer_lines, public.stock_shipments, public.stock_shipment_lines,
  public.stock_transfer_receipts, public.stock_transfer_receipt_lines, public.stock_production_recipes,
  public.stock_productions, public.stock_production_lines from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public._stock_booth_id() returns int
language sql stable security definer set search_path = public
as $$ select id from stock_locations where code = 'booth' $$;

create or replace function public._stock_location(p_id int) returns stock_locations
language plpgsql stable security definer set search_path = public
as $$
declare l stock_locations;
begin
  select * into l from stock_locations where id = p_id;
  if l.id is null then raise exception 'Pilih lokasi.'; end if;
  return l;
end $$;

-- Stock of an item at a location (the Booth = stock_moves, as everywhere else).
create or replace function public._stock_loc_balance(p_location int, p_item int) returns numeric
language sql stable security definer set search_path = public
as $$
  select case when p_location = public._stock_booth_id() then public._stock_balance(p_item)
    else (select coalesce(sum(qty), 0) from stock_loc_moves where location_id = p_location and item_id = p_item) end
$$;

-- Next document number: PREFIX-YYMMDD-NN, counted per prefix and day.
create or replace function public._stock_doc_no(p_prefix text, p_day date) returns text
language plpgsql volatile security definer set search_path = public
as $$
declare n int;
begin
  insert into stock_doc_counters (prefix, day, n) values (p_prefix, p_day, 1)
  on conflict (prefix, day) do update set n = stock_doc_counters.n + 1 returning stock_doc_counters.n into n;
  return p_prefix || '-' || to_char(p_day, 'YYMMDD') || '-' || lpad(n::text, 2, '0');
end $$;

-- Write one move at a location. The Booth goes into stock_moves (with its document in stock_move_docs).
create or replace function public._stock_loc_put(p_location int, p_item int, p_kind text, p_qty numeric, p_day date, p_reason text,
  p_doc_type text, p_doc_id bigint, p_doc_no text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare mid bigint;
begin
  if p_qty = 0 then return; end if;
  if p_location = public._stock_booth_id() then
    if p_kind not in ('pindah', 'produksi', 'bongkar') then raise exception 'Jenis catatan stok tidak dikenal.'; end if;
    insert into stock_moves (item_id, kind, qty, day, reason, responsible_id, created_by)
    values (p_item, p_kind, p_qty, p_day, p_reason, auth.uid(), auth.uid()) returning id into mid;
    insert into stock_move_docs (move_id, doc_type, doc_id, doc_no) values (mid, p_doc_type, p_doc_id, p_doc_no);
  else
    insert into stock_loc_moves (location_id, item_id, kind, qty, day, doc_type, doc_id, doc_no, reason, created_by)
    values (p_location, p_item, p_kind, p_qty, p_day, p_doc_type, p_doc_id, p_doc_no, p_reason, auth.uid());
  end if;
end $$;

-- A document date: today when empty, never in the future, at most 31 days back.
create or replace function public._stock_doc_day(p_day date) returns date
language plpgsql stable
as $$
declare t date := public._stock_today();
begin
  if p_day is null then return t; end if;
  if p_day > t then raise exception 'Tanggal tidak boleh setelah hari ini.'; end if;
  if p_day < t - 31 then raise exception 'Tanggal paling lama 31 hari ke belakang.'; end if;
  return p_day;
end $$;

-- Item lines [{item, qty}]: known, active, once each, a sensible quantity.
create or replace function public._stock_doc_lines(p_lines jsonb) returns table (item_id int, qty numeric)
language plpgsql stable security definer set search_path = public
as $$
declare ln jsonb; i stock_items; q numeric; seen int[] := '{}';
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Isi minimal satu barang.'; end if;
  for ln in select * from jsonb_array_elements(p_lines) loop
    begin
      i := public._stock_item((ln ->> 'item')::int); q := public._stock_qty((ln ->> 'qty')::numeric);
    exception when invalid_text_representation then raise exception 'Angka tidak valid.';
    end;
    if not i.active then raise exception '% sedang tidak dipakai.', i.name; end if;
    if i.id = any (seen) then raise exception '% tertulis dua kali.', i.name; end if;
    seen := seen || i.id;
    item_id := i.id; qty := q; return next;
  end loop;
end $$;

-- Two different, active locations.
create or replace function public._stock_loc_pair(p_from int, p_to int) returns void
language plpgsql stable security definer set search_path = public
as $$
declare a stock_locations; b stock_locations;
begin
  if p_from is null then raise exception 'Pilih lokasi asal.'; end if;
  if p_to is null then raise exception 'Pilih lokasi tujuan.'; end if;
  a := public._stock_location(p_from); b := public._stock_location(p_to);
  if a.id = b.id then raise exception 'Lokasi asal dan tujuan harus berbeda.'; end if;
  if not a.active then raise exception 'Lokasi % sedang tidak dipakai.', a.name; end if;
  if not b.active then raise exception 'Lokasi % sedang tidak dipakai.', b.name; end if;
end $$;

-- Refuse taking more than a location has.
create or replace function public._stock_loc_enough(p_location int, p_item int, p_qty numeric) returns void
language plpgsql stable security definer set search_path = public
as $$
declare have numeric := public._stock_loc_balance(p_location, p_item); i stock_items := public._stock_item(p_item);
begin
  if have < p_qty then
    raise exception 'Stok % di % hanya % %. Catat barang masuk, produksi atau penyesuaian dulu.',
      i.name, (select name from stock_locations where id = p_location), trim(to_char(have, 'FM999999990.##')), i.unit;
  end if;
end $$;

create or replace function public._stock_name(p uuid) returns text
language sql stable security definer set search_path = public
as $$ select public._first_name(full_name) from profiles where id = p $$;

-- ---------------------------------------------------------------- locations: functions
create or replace function public.stock_location_list() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', l.id, 'code', l.code, 'name', l.name, 'note', l.note, 'active', l.active,
      'is_booth', l.code = 'booth',
      'items_in_stock', (select count(*) from stock_items i where i.active and public._stock_loc_balance(l.id, i.id) <> 0),
      'in_transit_out', (select count(*) from stock_shipments s join stock_transfers t on t.id = s.transfer_id
                          where s.status = 'dalam_perjalanan' and t.from_location = l.id),
      'in_transit_in', (select count(*) from stock_shipments s join stock_transfers t on t.id = s.transfer_id
                          where s.status = 'dalam_perjalanan' and t.to_location = l.id))
    order by l.sort, l.id) from stock_locations l), '[]');
end $$;

-- Add (p_id null) or rename a location. Owner only.
create or replace function public.stock_location_save(p_id int, p_name text, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengatur lokasi stok.');
  n text := nullif(trim(coalesce(p_name, '')), ''); nt text := nullif(trim(coalesce(p_note, '')), ''); lid int; old stock_locations;
begin
  if n is null or length(n) > 40 then raise exception 'Isi nama lokasi (paling panjang 40 huruf).'; end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan paling panjang 200 huruf.'; end if;
  if exists (select 1 from stock_locations where lower(name) = lower(n) and id is distinct from p_id) then raise exception 'Nama lokasi ini sudah ada.'; end if;
  if p_id is null then
    insert into stock_locations (name, note, sort) values (n, nt, coalesce((select max(sort) from stock_locations), 0) + 1) returning id into lid;
    perform public._log('stok_tambah_lokasi', jsonb_build_object('location', lid, 'name', n));
  else
    old := public._stock_location(p_id);
    update stock_locations set name = n, note = nt where id = p_id;
    lid := p_id;
    perform public._log('stok_ubah_lokasi', jsonb_build_object('location', lid, 'dari', old.name, 'jadi', n));
  end if;
  return (select row_to_json(l) from stock_locations l where id = lid);
end $$;

-- Switch a location off or on. The Booth stays on; a location with stock or goods on the way can't be switched off.
create or replace function public.stock_location_set_active(p_id int, p_active boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengatur lokasi stok.'); l stock_locations := public._stock_location(p_id);
begin
  if p_active is null then raise exception 'Pilih aktif atau tidak.'; end if;
  if not p_active then
    if l.code = 'booth' then raise exception 'Booth adalah lokasi utama dan tidak bisa dimatikan.'; end if;
    if exists (select 1 from stock_items i where public._stock_loc_balance(l.id, i.id) <> 0) then
      raise exception 'Masih ada stok di %. Pindahkan atau sesuaikan dulu sampai kosong.', l.name;
    end if;
    if exists (select 1 from stock_transfers t where (t.from_location = l.id or t.to_location = l.id) and t.status in ('dibuka', 'sebagian'))
       or exists (select 1 from stock_shipments s join stock_transfers t on t.id = s.transfer_id
                   where s.status = 'dalam_perjalanan' and (t.from_location = l.id or t.to_location = l.id)) then
      raise exception 'Masih ada transfer order atau surat jalan yang terbuka untuk %.', l.name;
    end if;
  end if;
  update stock_locations set active = p_active where id = l.id;
  perform public._log(case when p_active then 'stok_lokasi_aktif' else 'stok_lokasi_nonaktif' end, jsonb_build_object('location', l.id, 'name', l.name));
  return json_build_object('id', l.id, 'name', l.name, 'active', p_active);
end $$;

-- Stock of every active item at one location.
create or replace function public.stock_location_stock(p_location int) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); l stock_locations := public._stock_location(p_location);
begin
  return json_build_object('location', json_build_object('id', l.id, 'name', l.name, 'is_booth', l.code = 'booth'),
    'items', coalesce((select json_agg(json_build_object('id', i.id, 'name', i.name, 'unit', i.unit, 'qty', public._stock_loc_balance(l.id, i.id),
        'has_recipe', exists (select 1 from stock_production_recipes r where r.item_id = i.id)) order by i.sort, i.id)
      from stock_items i where i.active), '[]'));
end $$;

-- Correct stock at a location: 'set' to a counted number or 'delta' plus/minus, with a reason.
-- At the Booth this is the same as stock_adjust (stock.sql), so it shows in Penyesuaian stok.
create or replace function public.stock_location_adjust(p_location int, p_item int, p_mode text, p_qty numeric, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menyesuaikan stok.');
  l stock_locations := public._stock_location(p_location); i stock_items := public._stock_item(p_item);
  r text := nullif(trim(coalesce(p_reason, '')), ''); before numeric; d numeric;
begin
  if l.code = 'booth' then return public.stock_adjust(p_item, p_mode, p_qty, p_reason); end if;
  if not l.active then raise exception 'Lokasi % sedang tidak dipakai.', l.name; end if;
  if r is null then raise exception 'Tulis alasan penyesuaiannya.'; end if;
  if length(r) > 200 then raise exception 'Alasan paling panjang 200 huruf.'; end if;
  if p_mode is null or p_mode not in ('set', 'delta') then raise exception 'Pilih: ubah jadi jumlah tertentu atau tambah/kurangi.'; end if;
  if p_qty is null or abs(p_qty) > 1000000 or p_qty <> round(p_qty, 2) then raise exception 'Isi jumlah yang masuk akal (paling banyak 2 angka di belakang koma).'; end if;
  before := public._stock_loc_balance(l.id, i.id);
  if p_mode = 'set' then
    if p_qty < 0 then raise exception 'Jumlah hitungan tidak boleh negatif.'; end if;
    d := p_qty - before;
  else d := p_qty; end if;
  if d = 0 then raise exception 'Stok sudah sama dengan jumlah itu.'; end if;
  if before + d < 0 then raise exception 'Stok tidak boleh jadi negatif (sekarang % %).', before, i.unit; end if;
  perform public._stock_loc_put(l.id, i.id, 'penyesuaian', d, public._stock_today(), r, null, null, null);
  perform public._log('stok_penyesuaian_lokasi', jsonb_build_object('location', l.name, 'item', i.name, 'dari', before, 'jadi', before + d, 'reason', r));
  return json_build_object('location', l.name, 'item', i.name, 'unit', i.unit, 'before', before, 'after', before + d, 'delta', d);
end $$;

-- ---------------------------------------------------------------- transfers: json and status
create or replace function public._stock_transfer_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', t.id, 'no', t.no, 'kind', t.kind, 'day', t.day, 'at', t.created_at, 'needed_by', t.needed_by,
    'note', t.note, 'status', t.status,
    'from_id', t.from_location, 'from', (select name from stock_locations where id = t.from_location),
    'to_id', t.to_location, 'to', (select name from stock_locations where id = t.to_location),
    'by', public._stock_name(t.created_by), 'cancelled_by', public._stock_name(t.cancelled_by), 'cancelled_at', t.cancelled_at,
    'cancel_reason', t.cancel_reason,
    'shipments', coalesce((select json_agg(json_build_object('id', s.id, 'no', s.no, 'status', s.status, 'day', s.day) order by s.id)
      from stock_shipments s where s.transfer_id = t.id), '[]'),
    'lines_count', (select count(*) from stock_transfer_lines where transfer_id = t.id),
    'qty_total', (select coalesce(sum(qty), 0) from stock_transfer_lines where transfer_id = t.id),
    'lines', coalesce((select json_agg(json_build_object('item_id', l.item_id, 'item', i.name, 'unit', i.unit, 'qty', l.qty, 'stock_at', l.stock_at,
        'shipped', case when t.kind = 'langsung' then l.qty else coalesce((select sum(sl.qty) from stock_shipment_lines sl join stock_shipments s on s.id = sl.shipment_id
          where s.transfer_id = t.id and s.status <> 'batal' and sl.item_id = l.item_id), 0) end,
        'received', case when t.kind = 'langsung' then l.qty else coalesce((select sum(rl.received) from stock_transfer_receipt_lines rl
          join stock_transfer_receipts r on r.id = rl.receipt_id join stock_shipments s on s.id = r.shipment_id
          where s.transfer_id = t.id and rl.item_id = l.item_id), 0) end,
        'source_now', public._stock_loc_balance(t.from_location, l.item_id))
        order by i.sort, i.id)
      from stock_transfer_lines l join stock_items i on i.id = l.item_id where l.transfer_id = t.id), '[]'))
  from stock_transfers t where t.id = p_id
$$;

-- Transfer order status from its surat jalan: nothing shipped = dibuka, some = sebagian, every line in full =
-- terkirim, and once every surat jalan is received too = selesai. A cancelled order stays batal.
create or replace function public._stock_transfer_refresh(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare got numeric; full_lines int; n int; open_sj int;
begin
  select coalesce(sum(x.sh), 0), count(*) filter (where x.sh >= x.qty), count(*) into got, full_lines, n from (
    select l.qty, coalesce((select sum(sl.qty) from stock_shipment_lines sl join stock_shipments s on s.id = sl.shipment_id
      where s.transfer_id = p_id and s.status <> 'batal' and sl.item_id = l.item_id), 0) as sh
    from stock_transfer_lines l where l.transfer_id = p_id) x;
  select count(*) into open_sj from stock_shipments where transfer_id = p_id and status = 'dalam_perjalanan';
  update stock_transfers set status = case
      when n > 0 and full_lines = n and open_sj = 0 then 'selesai'
      when n > 0 and full_lines = n then 'terkirim'
      when got > 0 then 'sebagian' else 'dibuka' end
   where id = p_id and kind = 'order' and status <> 'batal';
end $$;

create or replace function public._stock_shipment_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', s.id, 'no', s.no, 'day', s.day, 'at', s.created_at, 'note', s.note, 'status', s.status,
    'transfer_id', t.id, 'transfer_no', t.no,
    'from_id', t.from_location, 'from', (select name from stock_locations where id = t.from_location),
    'to_id', t.to_location, 'to', (select name from stock_locations where id = t.to_location),
    'by', public._stock_name(s.created_by), 'cancelled_by', public._stock_name(s.cancelled_by), 'cancelled_at', s.cancelled_at,
    'cancel_reason', s.cancel_reason,
    'receipt_id', r.id, 'receipt_no', r.no, 'received_day', r.day,
    'lines_count', (select count(*) from stock_shipment_lines where shipment_id = s.id),
    'qty_total', (select coalesce(sum(qty), 0) from stock_shipment_lines where shipment_id = s.id),
    'lines', coalesce((select json_agg(json_build_object('item_id', sl.item_id, 'item', i.name, 'unit', i.unit, 'qty', sl.qty,
        'received', rl.received, 'reason', rl.reason) order by i.sort, i.id)
      from stock_shipment_lines sl join stock_items i on i.id = sl.item_id
      left join stock_transfer_receipt_lines rl on rl.receipt_id = r.id and rl.item_id = sl.item_id
      where sl.shipment_id = s.id), '[]'))
  from stock_shipments s join stock_transfers t on t.id = s.transfer_id
  left join stock_transfer_receipts r on r.shipment_id = s.id
  where s.id = p_id
$$;

create or replace function public._stock_receipt_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', r.id, 'no', r.no, 'day', r.day, 'at', r.created_at, 'note', r.note,
    'shipment_id', s.id, 'shipment_no', s.no, 'transfer_id', t.id, 'transfer_no', t.no,
    'from_id', t.from_location, 'from', (select name from stock_locations where id = t.from_location),
    'to_id', t.to_location, 'to', (select name from stock_locations where id = t.to_location),
    'by', public._stock_name(r.created_by),
    'lines_count', (select count(*) from stock_transfer_receipt_lines where receipt_id = r.id),
    'lines_off', (select count(*) from stock_transfer_receipt_lines where receipt_id = r.id and received <> shipped),
    'lines', coalesce((select json_agg(json_build_object('item_id', rl.item_id, 'item', i.name, 'unit', i.unit, 'shipped', rl.shipped,
        'received', rl.received, 'diff', rl.received - rl.shipped, 'reason', rl.reason) order by i.sort, i.id)
      from stock_transfer_receipt_lines rl join stock_items i on i.id = rl.item_id where rl.receipt_id = r.id), '[]'))
  from stock_transfer_receipts r join stock_shipments s on s.id = r.shipment_id join stock_transfers t on t.id = s.transfer_id
  where r.id = p_id
$$;

create or replace function public._stock_range(p_from date, p_to date) returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
end $$;

-- ---------------------------------------------------------------- Stok transfer (one step)
-- p_lines: [{item, qty}]. The stock leaves the source and arrives at the destination at once.
create or replace function public.stock_transfer_create(p_from int, p_to int, p_lines jsonb, p_day date, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa memindahkan stok.');
  d date := public._stock_doc_day(p_day); tid bigint; no text; ln record; nt text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform public._stock_loc_pair(p_from, p_to);
  if nt is not null and length(nt) > 200 then raise exception 'Catatan paling panjang 200 huruf.'; end if;
  perform pg_advisory_xact_lock(hashtext('stock_location_moves'));
  no := public._stock_doc_no('ST', d);
  insert into stock_transfers (no, kind, from_location, to_location, day, note, status, created_by)
  values (no, 'langsung', p_from, p_to, d, nt, 'selesai', me) returning id into tid;
  for ln in select * from public._stock_doc_lines(p_lines) loop
    perform public._stock_loc_enough(p_from, ln.item_id, ln.qty);
    insert into stock_transfer_lines (transfer_id, item_id, qty, stock_at) values (tid, ln.item_id, ln.qty, public._stock_loc_balance(p_from, ln.item_id));
    perform public._stock_loc_put(p_from, ln.item_id, 'pindah', -ln.qty, d, 'Stok transfer ' || no, 'transfer', tid, no);
    perform public._stock_loc_put(p_to, ln.item_id, 'pindah', ln.qty, d, 'Stok transfer ' || no, 'transfer', tid, no);
  end loop;
  perform public._log('stok_transfer', jsonb_build_object('transfer', tid, 'no', no, 'from', p_from, 'to', p_to,
    'lines', (select count(*) from stock_transfer_lines where transfer_id = tid)));
  return public._stock_transfer_json(tid);
end $$;

-- ---------------------------------------------------------------- Transfer order (step 1)
create or replace function public.stock_transfer_order_create(p_from int, p_to int, p_lines jsonb, p_needed_by date, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membuat transfer order.');
  d date := public._stock_today(); tid bigint; no text; ln record; nt text := nullif(trim(coalesce(p_note, '')), '');
begin
  perform public._stock_loc_pair(p_from, p_to);
  if p_needed_by is not null and p_needed_by < d then raise exception 'Tanggal dibutuhkan tidak boleh sebelum hari ini.'; end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan paling panjang 200 huruf.'; end if;
  no := public._stock_doc_no('TO', d);
  insert into stock_transfers (no, kind, from_location, to_location, day, needed_by, note, status, created_by)
  values (no, 'order', p_from, p_to, d, p_needed_by, nt, 'dibuka', me) returning id into tid;
  for ln in select * from public._stock_doc_lines(p_lines) loop
    insert into stock_transfer_lines (transfer_id, item_id, qty, stock_at) values (tid, ln.item_id, ln.qty, public._stock_loc_balance(p_from, ln.item_id));
  end loop;
  perform public._log('stok_transfer_order', jsonb_build_object('transfer', tid, 'no', no, 'from', p_from, 'to', p_to,
    'lines', (select count(*) from stock_transfer_lines where transfer_id = tid)));
  return public._stock_transfer_json(tid);
end $$;

-- Cancel a transfer order: what is not shipped yet won't be. Surat jalan already made stay as they are.
create or replace function public.stock_transfer_order_cancel(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membatalkan transfer order.');
  t stock_transfers; r text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into t from stock_transfers where id = p_id for update;
  if t.id is null or t.kind <> 'order' then raise exception 'Transfer order tidak ditemukan.'; end if;
  if t.status not in ('dibuka', 'sebagian') then raise exception 'Transfer order % sudah %, tidak bisa dibatalkan.', t.no, t.status; end if;
  if r is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  update stock_transfers set status = 'batal', cancelled_by = me, cancelled_at = now(), cancel_reason = r where id = t.id;
  perform public._log('stok_batal_transfer_order', jsonb_build_object('transfer', t.id, 'no', t.no, 'reason', r));
  return public._stock_transfer_json(t.id);
end $$;

-- Transfers in a date range; p_kind 'langsung', 'order' or null for both. Newest first.
create or replace function public.stock_transfer_list(p_from date, p_to date, p_kind text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); k text := nullif(p_kind, '');
begin
  perform public._stock_range(p_from, p_to);
  if k is not null and k not in ('langsung', 'order') then raise exception 'Jenis transfer tidak dikenal.'; end if;
  return coalesce((select json_agg(public._stock_transfer_json(t.id) order by t.id desc)
    from stock_transfers t where t.day between p_from and p_to and (k is null or t.kind = k)), '[]');
end $$;

create or replace function public.stock_transfer_detail(p_id bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); j json := public._stock_transfer_json(p_id);
begin
  if j is null then raise exception 'Transfer tidak ditemukan.'; end if;
  return j;
end $$;

-- Transfer orders that still have something to ship (for Surat jalan).
create or replace function public.stock_transfer_open() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(public._stock_transfer_json(t.id) order by t.id)
    from stock_transfers t where t.kind = 'order' and t.status in ('dibuka', 'sebagian')), '[]');
end $$;

-- ---------------------------------------------------------------- Surat jalan (step 2)
-- p_lines: [{item, qty}] from the transfer order, at most what is left to ship. The stock leaves the source now.
create or replace function public.stock_shipment_create(p_transfer bigint, p_lines jsonb, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membuat surat jalan.');
  t stock_transfers; d date := public._stock_today(); sid bigint; no text; ln record; ordered numeric; shipped numeric;
  nt text := nullif(trim(coalesce(p_note, '')), ''); nm text;
begin
  if p_transfer is null then raise exception 'Pilih transfer order terlebih dahulu.'; end if;
  select * into t from stock_transfers where id = p_transfer for update;
  if t.id is null or t.kind <> 'order' then raise exception 'Transfer order tidak ditemukan.'; end if;
  if t.status not in ('dibuka', 'sebagian') then raise exception 'Transfer order % sudah %, tidak ada yang bisa dikirim.', t.no, t.status; end if;
  perform public._stock_loc_pair(t.from_location, t.to_location);
  if nt is not null and length(nt) > 200 then raise exception 'Catatan paling panjang 200 huruf.'; end if;
  perform pg_advisory_xact_lock(hashtext('stock_location_moves'));
  no := public._stock_doc_no('SJ', d);
  insert into stock_shipments (no, transfer_id, day, note, created_by) values (no, t.id, d, nt, me) returning id into sid;
  for ln in select * from public._stock_doc_lines(p_lines) loop
    select l.qty into ordered from stock_transfer_lines l where l.transfer_id = t.id and l.item_id = ln.item_id;
    select name into nm from stock_items where id = ln.item_id;
    if ordered is null then raise exception '% tidak ada di transfer order %.', nm, t.no; end if;
    select coalesce(sum(sl.qty), 0) into shipped from stock_shipment_lines sl join stock_shipments s on s.id = sl.shipment_id
     where s.transfer_id = t.id and s.status <> 'batal' and sl.item_id = ln.item_id;
    if shipped + ln.qty > ordered then
      raise exception '% melebihi transfer order: diminta %, sudah dikirim %, sisa %.', nm, ordered, shipped, ordered - shipped;
    end if;
    perform public._stock_loc_enough(t.from_location, ln.item_id, ln.qty);
    insert into stock_shipment_lines (shipment_id, item_id, qty) values (sid, ln.item_id, ln.qty);
    perform public._stock_loc_put(t.from_location, ln.item_id, 'pindah', -ln.qty, d, 'Surat jalan ' || no, 'surat_jalan', sid, no);
  end loop;
  perform public._stock_transfer_refresh(t.id);
  perform public._log('stok_surat_jalan', jsonb_build_object('shipment', sid, 'no', no, 'transfer', t.no,
    'lines', (select count(*) from stock_shipment_lines where shipment_id = sid)));
  return public._stock_shipment_json(sid);
end $$;

-- Cancel a surat jalan that has not arrived: the stock goes back to the source.
create or replace function public.stock_shipment_cancel(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membatalkan surat jalan.');
  s stock_shipments; t stock_transfers; r text := nullif(trim(coalesce(p_reason, '')), ''); ln record;
begin
  select * into s from stock_shipments where id = p_id for update;
  if s.id is null then raise exception 'Surat jalan tidak ditemukan.'; end if;
  if s.status <> 'dalam_perjalanan' then raise exception 'Surat jalan % sudah %, tidak bisa dibatalkan.', s.no, replace(s.status, '_', ' '); end if;
  if r is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  select * into t from stock_transfers where id = s.transfer_id;
  update stock_shipments set status = 'batal', cancelled_by = me, cancelled_at = now(), cancel_reason = r where id = s.id;
  for ln in select * from stock_shipment_lines where shipment_id = s.id loop
    perform public._stock_loc_put(t.from_location, ln.item_id, 'pindah', ln.qty, public._stock_today(), 'Batal surat jalan ' || s.no, 'surat_jalan', s.id, s.no);
  end loop;
  perform public._stock_transfer_refresh(t.id);
  perform public._log('stok_batal_surat_jalan', jsonb_build_object('shipment', s.id, 'no', s.no, 'reason', r));
  return public._stock_shipment_json(s.id);
end $$;

create or replace function public.stock_shipment_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  perform public._stock_range(p_from, p_to);
  return coalesce((select json_agg(public._stock_shipment_json(s.id) order by s.id desc) from stock_shipments s where s.day between p_from and p_to), '[]');
end $$;

create or replace function public.stock_shipment_detail(p_id bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); j json := public._stock_shipment_json(p_id);
begin
  if j is null then raise exception 'Surat jalan tidak ditemukan.'; end if;
  return j;
end $$;

-- Dalam perjalanan: shipped, not received yet (any date). Like VireoPOS "Stok Transfer Menggantung".
create or replace function public.stock_in_transit() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(public._stock_shipment_json(s.id)::jsonb || jsonb_build_object('days', public._stock_today() - s.day) order by s.id)
    from stock_shipments s where s.status = 'dalam_perjalanan'), '[]');
end $$;

-- ---------------------------------------------------------------- Penerimaan transfer (step 3)
-- p_lines: [{item, received, reason}]. A line left out is received in full. A difference needs a reason.
create or replace function public.stock_transfer_receive(p_shipment bigint, p_lines jsonb, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mencatat penerimaan transfer.');
  s stock_shipments; t stock_transfers; d date := public._stock_today(); rid bigint; no text; sl record; ln jsonb;
  got numeric; why text; nt text := nullif(trim(coalesce(p_note, '')), ''); nm text; off int := 0;
begin
  if p_shipment is null then raise exception 'Pilih surat jalan terlebih dahulu.'; end if;
  select * into s from stock_shipments where id = p_shipment for update;
  if s.id is null then raise exception 'Surat jalan tidak ditemukan.'; end if;
  if s.status <> 'dalam_perjalanan' then raise exception 'Surat jalan % sudah %.', s.no, replace(s.status, '_', ' '); end if;
  select * into t from stock_transfers where id = s.transfer_id;
  if not (select active from stock_locations where id = t.to_location) then raise exception 'Lokasi tujuan sedang tidak dipakai.'; end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then raise exception 'Daftar barang tidak valid.'; end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan paling panjang 200 huruf.'; end if;
  -- every line must be on the surat jalan
  for ln in select * from jsonb_array_elements(coalesce(p_lines, '[]')) loop
    if not exists (select 1 from stock_shipment_lines x where x.shipment_id = s.id and x.item_id = nullif(ln ->> 'item', '')::int) then
      raise exception 'Barang itu tidak ada di surat jalan %.', s.no;
    end if;
  end loop;
  no := public._stock_doc_no('PT', d);
  insert into stock_transfer_receipts (no, shipment_id, day, note, created_by) values (no, s.id, d, nt, me) returning id into rid;
  for sl in select x.item_id, x.qty, i.name from stock_shipment_lines x join stock_items i on i.id = x.item_id where x.shipment_id = s.id loop
    select e into ln from jsonb_array_elements(coalesce(p_lines, '[]')) e where (e ->> 'item')::int = sl.item_id limit 1;
    begin
      got := coalesce(nullif(ln ->> 'received', '')::numeric, sl.qty);
    exception when invalid_text_representation then raise exception 'Angka tidak valid.';
    end;
    perform public._stock_qty(got, true);
    if got > sl.qty then raise exception '% diterima % lebih banyak dari yang dikirim (%).', sl.name, got, sl.qty; end if;
    why := nullif(trim(coalesce(ln ->> 'reason', '')), '');
    if got <> sl.qty and why is null then raise exception 'Tulis alasan selisih untuk %.', sl.name; end if;
    if why is not null and length(why) > 200 then raise exception 'Alasan paling panjang 200 huruf.'; end if;
    if got <> sl.qty then off := off + 1; end if;
    insert into stock_transfer_receipt_lines (receipt_id, item_id, shipped, received, reason) values (rid, sl.item_id, sl.qty, got, why);
    if got > 0 then
      perform public._stock_loc_put(t.to_location, sl.item_id, 'pindah', got, d, 'Penerimaan transfer ' || no, 'penerimaan_transfer', rid, no);
    end if;
  end loop;
  update stock_shipments set status = 'diterima' where id = s.id;
  perform public._stock_transfer_refresh(t.id);
  perform public._log('stok_terima_transfer', jsonb_build_object('receipt', rid, 'no', no, 'shipment', s.no, 'lines_off', off));
  return public._stock_receipt_json(rid);
end $$;

create or replace function public.stock_receipt_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  perform public._stock_range(p_from, p_to);
  return coalesce((select json_agg(public._stock_receipt_json(r.id) order by r.id desc) from stock_transfer_receipts r where r.day between p_from and p_to), '[]');
end $$;

create or replace function public.stock_receipt_detail(p_id bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); j json := public._stock_receipt_json(p_id);
begin
  if j is null then raise exception 'Penerimaan transfer tidak ditemukan.'; end if;
  return j;
end $$;

-- ---------------------------------------------------------------- production recipes
create or replace function public.stock_production_recipes() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return json_build_object(
    'items', coalesce((select json_agg(json_build_object('id', i.id, 'name', i.name, 'unit', i.unit, 'active', i.active) order by i.sort, i.id)
      from stock_items i), '[]'),
    'recipes', coalesce((select json_agg(x order by x.sort, x.item_id) from (
      select i.id as item_id, i.name as item, i.unit, i.sort, count(*)::int as components_count,
        json_agg(json_build_object('component_id', c.id, 'component', c.name, 'unit', c.unit, 'qty', r.qty) order by c.sort, c.id) as components
      from stock_production_recipes r join stock_items i on i.id = r.item_id join stock_items c on c.id = r.component_id
      group by i.id, i.name, i.unit, i.sort) x), '[]'));
end $$;

-- Replace the production recipe of an item. p_lines: [{item, qty}] per 1 unit made; an empty array removes it. Owner only.
create or replace function public.stock_production_recipe_save(p_item int, p_lines jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengatur resep produksi.');
  i stock_items := public._stock_item(p_item); ln jsonb; c stock_items; q numeric; seen int[] := '{}'; old jsonb;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Daftar bahan tidak valid.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('item', component_id, 'qty', qty)), '[]') into old from stock_production_recipes where item_id = i.id;
  delete from stock_production_recipes where item_id = i.id;
  for ln in select * from jsonb_array_elements(p_lines) loop
    begin
      c := public._stock_item((ln ->> 'item')::int); q := (ln ->> 'qty')::numeric;
    exception when invalid_text_representation then raise exception 'Angka tidak valid.';
    end;
    if q is null or q <= 0 then raise exception 'Isi jumlah % untuk 1 % %.', c.name, i.unit, i.name; end if;
    if q > 1000000 or q <> round(q, 4) then raise exception 'Jumlah % paling banyak 4 angka di belakang koma.', c.name; end if;
    if c.id = i.id then raise exception 'Barang tidak bisa menjadi bahan untuk dirinya sendiri.'; end if;
    if c.id = any (seen) then raise exception '% tertulis dua kali.', c.name; end if;
    if exists (select 1 from stock_production_recipes r where r.item_id = c.id and r.component_id = i.id) then
      raise exception '% sudah dibuat dari %, jadi tidak bisa dipakai sebagai bahannya.', c.name, i.name;
    end if;
    seen := seen || c.id;
    insert into stock_production_recipes (item_id, component_id, qty) values (i.id, c.id, q);
  end loop;
  perform public._log('stok_resep_produksi', jsonb_build_object('item', i.name, 'dari', old,
    'jadi', (select coalesce(jsonb_agg(jsonb_build_object('item', component_id, 'qty', qty)), '[]') from stock_production_recipes where item_id = i.id)));
  return json_build_object('item_id', i.id, 'item', i.name, 'components', (select count(*) from stock_production_recipes where item_id = i.id));
end $$;

-- ---------------------------------------------------------------- Produksi and Bongkar produksi
-- The components needed (produksi) or given back (bongkar) for p_qty units at a location, with the stock there.
create or replace function public.stock_production_preview(p_kind text, p_item int, p_qty numeric, p_location int) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
  i stock_items := public._stock_item(p_item); l stock_locations := public._stock_location(p_location); q numeric := coalesce(p_qty, 0);
begin
  if p_kind is null or p_kind not in ('produksi', 'bongkar') then raise exception 'Pilih produksi atau bongkar produksi.'; end if;
  return json_build_object('kind', p_kind, 'item_id', i.id, 'item', i.name, 'unit', i.unit, 'qty', q, 'location', l.name,
    'item_stock', public._stock_loc_balance(l.id, i.id),
    'has_recipe', exists (select 1 from stock_production_recipes where item_id = i.id),
    'enough', case when p_kind = 'bongkar' then public._stock_loc_balance(l.id, i.id) >= q
      else not exists (select 1 from stock_production_recipes r where r.item_id = i.id and public._stock_loc_balance(l.id, r.component_id) < round(r.qty * q, 2)) end,
    'components', coalesce((select json_agg(json_build_object('component_id', c.id, 'component', c.name, 'unit', c.unit, 'per_unit', r.qty,
        'qty', round(r.qty * q, 2), 'stock', public._stock_loc_balance(l.id, c.id),
        'enough', p_kind = 'bongkar' or public._stock_loc_balance(l.id, c.id) >= round(r.qty * q, 2)) order by c.sort, c.id)
      from stock_production_recipes r join stock_items c on c.id = r.component_id where r.item_id = i.id), '[]'));
end $$;

create or replace function public._stock_production_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', p.id, 'no', p.no, 'kind', p.kind, 'day', p.day, 'at', p.created_at, 'note', p.note,
    'item_id', p.item_id, 'item', i.name, 'unit', i.unit, 'qty', p.qty,
    'location_id', p.location_id, 'location', (select name from stock_locations where id = p.location_id),
    'by', public._stock_name(p.created_by),
    'components_count', (select count(*) from stock_production_lines where production_id = p.id),
    'lines', coalesce((select json_agg(json_build_object('component_id', c.id, 'component', c.name, 'unit', c.unit, 'per_unit', pl.per_unit,
        'qty', pl.qty, 'stock_at', pl.stock_at) order by c.sort, c.id)
      from stock_production_lines pl join stock_items c on c.id = pl.component_id where pl.production_id = p.id), '[]'))
  from stock_productions p join stock_items i on i.id = p.item_id where p.id = p_id
$$;

-- Produksi: components minus, the item plus. Bongkar produksi: the item minus, components plus.
-- Refused when the location does not have enough of what goes out.
create or replace function public.stock_production_create(p_kind text, p_item int, p_qty numeric, p_location int, p_day date, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mencatat produksi.');
  i stock_items := public._stock_item(p_item); l stock_locations; q numeric; d date := public._stock_doc_day(p_day);
  pid bigint; no text; r record; use numeric; nt text := nullif(trim(coalesce(p_note, '')), ''); sign int;
begin
  if p_kind is null or p_kind not in ('produksi', 'bongkar') then raise exception 'Pilih produksi atau bongkar produksi.'; end if;
  if p_location is null then raise exception 'Pilih lokasi.'; end if;
  l := public._stock_location(p_location);
  if not l.active then raise exception 'Lokasi % sedang tidak dipakai.', l.name; end if;
  q := public._stock_qty(p_qty);
  if not i.active then raise exception '% sedang tidak dipakai.', i.name; end if;
  if not exists (select 1 from stock_production_recipes where item_id = i.id) then
    raise exception '% belum punya resep produksi. Atur dulu di Resep produksi.', i.name;
  end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan paling panjang 200 huruf.'; end if;
  perform pg_advisory_xact_lock(hashtext('stock_location_moves'));
  sign := case when p_kind = 'produksi' then -1 else 1 end;
  if p_kind = 'bongkar' then perform public._stock_loc_enough(l.id, i.id, q); end if;
  no := public._stock_doc_no(case when p_kind = 'produksi' then 'PR' else 'BP' end, d);
  insert into stock_productions (no, kind, item_id, qty, location_id, day, note, created_by)
  values (no, p_kind, i.id, q, l.id, d, nt, me) returning id into pid;
  for r in select x.component_id, x.qty as per from stock_production_recipes x join stock_items c on c.id = x.component_id
           where x.item_id = i.id order by c.sort, c.id loop
    use := round(r.per * q, 2);
    if p_kind = 'produksi' then perform public._stock_loc_enough(l.id, r.component_id, use); end if;
    insert into stock_production_lines (production_id, component_id, per_unit, qty, stock_at)
    values (pid, r.component_id, r.per, use, public._stock_loc_balance(l.id, r.component_id));
    perform public._stock_loc_put(l.id, r.component_id, p_kind, sign * use, d, case when p_kind = 'produksi' then 'Produksi ' else 'Bongkar produksi ' end || no, 'produksi', pid, no);
  end loop;
  perform public._stock_loc_put(l.id, i.id, p_kind, -sign * q, d, case when p_kind = 'produksi' then 'Produksi ' else 'Bongkar produksi ' end || no, 'produksi', pid, no);
  perform public._log(case when p_kind = 'produksi' then 'stok_produksi' else 'stok_bongkar_produksi' end,
    jsonb_build_object('production', pid, 'no', no, 'item', i.name, 'qty', q, 'location', l.name));
  return public._stock_production_json(pid);
end $$;

create or replace function public.stock_production_list(p_from date, p_to date, p_kind text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); k text := nullif(p_kind, '');
begin
  perform public._stock_range(p_from, p_to);
  if k is not null and k not in ('produksi', 'bongkar') then raise exception 'Jenis produksi tidak dikenal.'; end if;
  return coalesce((select json_agg(public._stock_production_json(p.id) order by p.id desc)
    from stock_productions p where p.day between p_from and p_to and (k is null or p.kind = k)), '[]');
end $$;

create or replace function public.stock_production_detail(p_id bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); j json := public._stock_production_json(p_id);
begin
  if j is null then raise exception 'Produksi tidak ditemukan.'; end if;
  return j;
end $$;

-- ---------------------------------------------------------------- Kartu stok
-- Every move at a location up to a day, with the Kartu stok column it belongs to:
-- pembelian (goods in from a purchase order / permintaan, and their corrections), masuk (other goods in),
-- keluar (sampel, buang, rusak, promo), pindah, penyesuaian (opname, Penyesuaian stok, potong liner),
-- penjualan (sales and their voids), produksi, bongkar. p_item null = every item.
create or replace function public._stock_card_rows(p_location int, p_item int, p_to date)
returns table (src text, move_id bigint, at timestamptz, day date, item_id int, kind text, col text, qty numeric, doc_no text, reason text, by_id uuid)
language sql stable security definer set search_path = public
as $$
  select 'b', m.id, m.created_at, m.day, m.item_id, m.kind,
    case when m.kind = 'masuk' or (m.kind = 'koreksi' and m.goods_in_id is not null) then case when g.request_id is not null then 'pembelian' else 'masuk' end
         when m.kind in ('penjualan', 'batal_penjualan') then 'penjualan'
         when m.kind in ('sampel', 'buang', 'rusak', 'promo') then 'keluar'
         when m.kind in ('pindah', 'produksi', 'bongkar') then m.kind
         else 'penyesuaian' end,
    m.qty,
    coalesce(dc.doc_no, case when m.kind in ('penjualan', 'batal_penjualan') then (select o.receipt_no from pos_orders o where o.id = m.order_id) end,
      case when g.request_id is not null then (select r.no from stock_requests r where r.id = g.request_id) end),
    m.reason, coalesce(m.responsible_id, m.created_by)
  from stock_moves m left join stock_goods_in g on g.id = m.goods_in_id left join stock_move_docs dc on dc.move_id = m.id
  where p_location = public._stock_booth_id() and (p_item is null or m.item_id = p_item) and m.day <= p_to
  union all
  select 'l', x.id, x.created_at, x.day, x.item_id, x.kind, x.kind, x.qty, x.doc_no, x.reason, x.created_by
  from stock_loc_moves x
  where x.location_id = p_location and p_location <> public._stock_booth_id() and (p_item is null or x.item_id = p_item) and x.day <= p_to
$$;

-- Kartu stok for every item at a location (VireoPOS columns). p_all = also items with no stock and no moves.
create or replace function public.stock_card_summary(p_location int, p_from date, p_to date, p_all boolean default false) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); l stock_locations := public._stock_location(p_location);
begin
  perform public._stock_range(p_from, p_to);
  return json_build_object('location', json_build_object('id', l.id, 'name', l.name, 'is_booth', l.code = 'booth'), 'from', p_from, 'to', p_to,
    'rows', coalesce((select json_agg(x order by x.sort, x.item_id) from (
      select i.id as item_id, i.name as item, i.unit, i.sort, i.unit_cost,
        coalesce(sum(r.qty) filter (where r.day < p_from), 0) as opening,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'pembelian'), 0) as pembelian,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'masuk'), 0) as masuk,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'keluar'), 0) as keluar,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'pindah'), 0) as pindah,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'penyesuaian'), 0) as penyesuaian,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'penjualan'), 0) as penjualan,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'produksi'), 0) as produksi,
        coalesce(sum(r.qty) filter (where r.day >= p_from and r.col = 'bongkar'), 0) as bongkar,
        coalesce(sum(r.qty), 0) as closing,
        round(coalesce(sum(r.qty), 0) * i.unit_cost)::bigint as value,
        count(r.move_id) filter (where r.day >= p_from)::int as moves
      from stock_items i left join public._stock_card_rows(l.id, null, p_to) r on r.item_id = i.id
      where i.active or exists (select 1 from public._stock_card_rows(l.id, i.id, p_to))
      group by i.id, i.name, i.unit, i.sort, i.unit_cost) x
      where p_all or x.closing <> 0 or x.opening <> 0 or x.moves > 0), '[]'));
end $$;

-- Kartu stok of one item at a location: opening balance, every move in the range with its running balance, the totals.
create or replace function public.stock_card(p_location int, p_item int, p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
  l stock_locations := public._stock_location(p_location); i stock_items := public._stock_item(p_item); op numeric;
begin
  perform public._stock_range(p_from, p_to);
  select coalesce(sum(qty), 0) into op from public._stock_card_rows(l.id, i.id, p_from - 1);
  return json_build_object('location', json_build_object('id', l.id, 'name', l.name), 'item', json_build_object('id', i.id, 'name', i.name, 'unit', i.unit),
    'from', p_from, 'to', p_to, 'opening', op,
    'closing', op + (select coalesce(sum(qty), 0) from public._stock_card_rows(l.id, i.id, p_to) where day >= p_from),
    'totals', (select json_object_agg(c, t) from (select col as c, sum(qty) as t from public._stock_card_rows(l.id, i.id, p_to) where day >= p_from group by col) y),
    'rows', coalesce((select json_agg(json_build_object('key', z.src || z.move_id, 'at', z.at, 'day', z.day, 'kind', z.kind, 'col', z.col, 'qty', z.qty,
        'doc_no', z.doc_no, 'reason', z.reason, 'by', public._stock_name(z.by_id), 'balance', z.bal) order by z.day, z.at, z.src, z.move_id)
      from (select r.*, op + sum(r.qty) over (order by r.day, r.at, r.src, r.move_id) as bal
            from public._stock_card_rows(l.id, i.id, p_to) r where r.day >= p_from) z), '[]'));
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in (
      '_stock_loc_locked', '_stock_booth_id', '_stock_location', '_stock_loc_balance', '_stock_doc_no', '_stock_loc_put', '_stock_doc_day',
      '_stock_doc_lines', '_stock_loc_pair', '_stock_loc_enough', '_stock_name', '_stock_transfer_json', '_stock_transfer_refresh',
      '_stock_shipment_json', '_stock_receipt_json', '_stock_range', '_stock_production_json', '_stock_card_rows',
      'stock_location_list', 'stock_location_save', 'stock_location_set_active', 'stock_location_stock', 'stock_location_adjust',
      'stock_transfer_create', 'stock_transfer_order_create', 'stock_transfer_order_cancel', 'stock_transfer_list', 'stock_transfer_detail',
      'stock_transfer_open', 'stock_shipment_create', 'stock_shipment_cancel', 'stock_shipment_list', 'stock_shipment_detail',
      'stock_in_transit', 'stock_transfer_receive', 'stock_receipt_list', 'stock_receipt_detail',
      'stock_production_recipes', 'stock_production_recipe_save', 'stock_production_preview', 'stock_production_create',
      'stock_production_list', 'stock_production_detail', 'stock_card_summary', 'stock_card')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
