-- Hanashuya stock: items, recipes, goods in, automatic deduction per sale, other ways
-- out, counts and the difference (selisih). Task 15 of POSDEVELOPMENT.md.
-- Run schema.sql, then pos.sql, then this file, in the Supabase SQL Editor.
-- Re-running is safe: tables are only created when missing, functions are replaced,
-- and the starting items and recipes are only added the first time.
--
-- How stock is kept: every change is one row in stock_moves, an append-only ledger
-- (rows are never changed or removed; a mistake is put right with a new row). Stock now
-- for an item is the sum of its rows. Kinds:
--   masuk            goods in (staff)
--   penjualan        a paid POS order, from the recipe of each line (automatic)
--   batal_penjualan  a void or refund puts the recipe back (automatic)
--   sampel, buang, rusak, promo   other ways out, recorded by staff with a reason
--   potong_liner     1 Paper liner besar out, 2 Paper liner kecil in
--   koreksi          a goods-in entry changed or cancelled by a manager or the owner
--                    (goods_in_id set), or an accepted count (count_id set: the selisih)
--
-- Open (POSDEVELOPMENT.md question 10): whether staff must record stock that leaves
-- without a sale. The reasons are built (sampel, buang, rusak, promo); nothing forces
-- staff to use them, but anything not recorded shows up as selisih at the count.

-- ---------------------------------------------------------------- items
create table if not exists public.stock_items (
  id int generated always as identity primary key,
  code text unique,            -- fixed key for the starting items, null for items the owner adds
  name text not null unique,
  unit text not null check (length(trim(unit)) between 1 and 10),
  low_level numeric(12, 2) check (low_level >= 0),   -- warn at or below; null = no warning
  closes_at_zero boolean not null default false,     -- choux: not sold the next day
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Glenn's starting items (11 Nov 2026). Low-stock levels are a first guess; the owner
-- changes them in the owner page, Stok > Barang.
insert into public.stock_items (code, name, unit, low_level, closes_at_zero, sort) values
  ('mini', 'Mini Choux', 'pcs', null, true, 1),
  ('sig', 'Signature Choux', 'pcs', null, true, 2),
  ('vla_vanilla', 'Vla Vanilla', 'g', 1000, false, 3),
  ('vla_choco', 'Vla Chocolate', 'g', 1000, false, 4),
  ('jam_strawberry', 'Selai strawberry', 'g', 200, false, 5),
  ('vla_matcha', 'Vla Matcha', 'g', 1000, false, 6),
  ('dus_besar', 'Dus besar', 'pcs', 20, false, 7),
  ('dus_kecil', 'Dus kecil', 'pcs', 20, false, 8),
  ('bag', 'Paper bag', 'pcs', 20, false, 9),
  ('liner_besar', 'Paper liner besar', 'pcs', 20, false, 10),
  ('liner_kecil', 'Paper liner kecil', 'pcs', 20, false, 11),
  ('pouch', 'Paper pouch (untuk 1 pcs)', 'pcs', 20, false, 12)
on conflict do nothing;

-- Cost per unit (harga pokok, Rp per pcs or per gram), for the profit report (Glenn, 11 Nov
-- 2026). First values from the COGS workbook of 5 Nov 2026: shells from the production house,
-- cream Rp85.000 a kg, boxes, wraps and the pouch; paper bag Rp6.000 (task 15). Set once, when
-- the column is added, so the owner's changes survive a re-run. Selai strawberry has no
-- figure yet, and the workbook's Rp2.000 per box for other flavours is not in these.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stock_items' and column_name = 'unit_cost') then
    alter table public.stock_items add column unit_cost numeric(12, 2) not null default 0 check (unit_cost >= 0);
    update public.stock_items s set unit_cost = v.c from (values ('mini', 726), ('sig', 1940), ('vla_vanilla', 85), ('vla_choco', 85),
      ('vla_matcha', 85), ('dus_besar', 2650), ('dus_kecil', 1700), ('bag', 6000), ('liner_besar', 300), ('liner_kecil', 150),
      ('pouch', 750)) v(code, c) where s.code = v.code;
  end if;
end $$;

-- ---------------------------------------------------------------- recipes
-- How much of each item one unit of a product uses. flavour_id null = every flavour.
-- A row for a flavour replaces the "every flavour" row of the same item (qty 0 = that
-- flavour does not use the item).
create table if not exists public.stock_recipes (
  id int generated always as identity primary key,
  product_id int not null references public.menu_items (id),
  flavour_id text references public.pos_flavours (id),
  item_id int not null references public.stock_items (id),
  qty numeric(12, 2) not null check (qty >= 0)
);
create unique index if not exists stock_recipes_once on public.stock_recipes (product_id, coalesce(flavour_id, ''), item_id);

-- Starting recipes (Glenn, 11 Nov 2026), only when there are none yet, so the owner's
-- changes survive a re-run. Cream includes the 5 g safety cream: 15 g per mini choux,
-- 35 g per Signature, from the Vla of the chosen flavour. Matcha Strawberry uses the full
-- Vla Matcha amount plus 2 g Selai strawberry per piece.
do $$
declare
  p record; fl record;
  vla_for jsonb := '{"vanilla": "vla_vanilla", "choco": "vla_choco", "matcha": "vla_matcha", "matcha_strawberry": "vla_matcha"}';
begin
  if exists (select 1 from stock_recipes) then return; end if;
  for p in
    select m.id, x.* from (values
      ('mini8', 'mini', 8, 120, 'dus_kecil', 'liner_kecil', null::text),
      ('mini15', 'mini', 15, 225, 'dus_besar', 'liner_besar', null),
      ('sig6', 'sig', 6, 210, 'dus_besar', 'liner_besar', null),
      ('sig1', 'sig', 1, 35, null, null, 'pouch')
    ) as x(code, choux, pieces, vla, box, liner, pouch)
    join menu_items m on m.code = x.code
  loop
    insert into stock_recipes (product_id, flavour_id, item_id, qty)
    select p.id, null, i.id, v.q from (values (p.choux, p.pieces), (p.box, 1), (p.liner, 1), (p.pouch, 1)) as v(c, q)
    join stock_items i on i.code = v.c;
    for fl in select id from pos_flavours loop
      insert into stock_recipes (product_id, flavour_id, item_id, qty)
      select p.id, fl.id, i.id, p.vla from stock_items i where i.code = vla_for->>fl.id;
      if fl.id = 'matcha_strawberry' then
        insert into stock_recipes (product_id, flavour_id, item_id, qty)
        select p.id, fl.id, i.id, 2 * p.pieces from stock_items i where i.code = 'jam_strawberry';
      end if;
    end loop;
  end loop;
  -- Paper bag line (sold or free): 1 Paper bag.
  insert into stock_recipes (product_id, flavour_id, item_id, qty)
  select m.id, null, i.id, 1 from menu_items m, stock_items i where m.code = 'bag' and i.code = 'bag';
end $$;

-- ---------------------------------------------------------------- goods in
-- qty is what staff wrote and is never changed. current_qty and status show the audit
-- outcome; every change is a row in stock_goods_in_changes plus a koreksi in the ledger.
create table if not exists public.stock_goods_in (
  id bigint generated always as identity primary key,
  item_id int not null references public.stock_items (id),
  qty numeric(12, 2) not null check (qty > 0),
  current_qty numeric(12, 2) not null check (current_qty >= 0),
  status text not null default 'aktif' check (status in ('aktif', 'diubah', 'dibatalkan')),
  note text,
  slip_note text,
  day date not null,
  received_by uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stock_goods_in_day on public.stock_goods_in (day);

create table if not exists public.stock_goods_in_changes (
  id bigint generated always as identity primary key,
  goods_in_id bigint not null references public.stock_goods_in (id),
  kind text not null check (kind in ('ubah', 'batal')),
  old_qty numeric(12, 2) not null,
  new_qty numeric(12, 2) not null,
  reason text not null,
  changed_by uuid references public.profiles (id) on delete set null,
  changed_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- counts
-- Staff count at closing; a manager or the owner accepts it. On acceptance the
-- difference with the ledger (as it stood when the count was sent) is written as a
-- koreksi, so the counted amount becomes the next opening stock.
create table if not exists public.stock_counts (
  id bigint generated always as identity primary key,
  day date not null,
  status text not null default 'menunggu' check (status in ('menunggu', 'diterima', 'ditolak', 'diganti')),
  last_move_id bigint not null default 0,
  note text,
  submitted_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text
);
create unique index if not exists stock_counts_one_open on public.stock_counts ((true)) where status = 'menunggu';

create table if not exists public.stock_count_lines (
  count_id bigint not null references public.stock_counts (id),
  item_id int not null references public.stock_items (id),
  expected numeric(12, 2) not null,
  counted numeric(12, 2) not null check (counted >= 0),
  thrown numeric(12, 2) not null default 0 check (thrown >= 0),
  primary key (count_id, item_id)
);

-- ---------------------------------------------------------------- the ledger
create table if not exists public.stock_moves (
  id bigint generated always as identity primary key,
  item_id int not null references public.stock_items (id),
  kind text not null check (kind in ('masuk', 'penjualan', 'batal_penjualan', 'sampel', 'buang', 'rusak', 'promo',
    'potong_liner', 'koreksi')),
  qty numeric(12, 2) not null check (qty <> 0),
  day date not null,
  order_id uuid,
  goods_in_id bigint references public.stock_goods_in (id),
  count_id bigint references public.stock_counts (id),
  reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists stock_moves_item on public.stock_moves (item_id, day);

-- Who is responsible for each report (Glenn, 11 Nov 2026): goods in, stock out and stok
-- opname each name the staff member responsible, picked on the tablet. It is kept apart
-- from the signed-in account that sent it (created_by / submitted_by). Old rows have null.
alter table public.stock_goods_in add column if not exists responsible_id uuid references public.profiles (id) on delete set null;
alter table public.stock_moves add column if not exists responsible_id uuid references public.profiles (id) on delete set null;
alter table public.stock_counts add column if not exists responsible_id uuid references public.profiles (id) on delete set null;
-- Stok opname can be done any time; closing = the count at closing (choux left are thrown away).
alter table public.stock_counts add column if not exists closing boolean not null default false;
create index if not exists stock_counts_day on public.stock_counts (day);

-- ---------------------------------------------------------------- permintaan barang
-- A stock request to the kitchen or a supplier (Glenn, 11 Nov 2026), numbered PB-YYMMDD-NN.
-- Staff share it as a PDF to the WhatsApp group. Goods in can name the request it came
-- from; what has arrived is the sum of those goods-in entries (current quantity), and the
-- status follows: dikirim, sebagian (diterima sebagian), selesai. A manager or the owner
-- can cancel (batal).
create table if not exists public.stock_requests (
  id bigint generated always as identity primary key,
  no text not null unique,
  day date not null,
  needed_by date,
  note text,
  status text not null default 'dikirim' check (status in ('dikirim', 'sebagian', 'selesai', 'batal')),
  responsible_id uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancelled_at timestamptz,
  cancel_reason text
);
create index if not exists stock_requests_day on public.stock_requests (day);
create table if not exists public.stock_request_lines (
  request_id bigint not null references public.stock_requests (id),
  item_id int not null references public.stock_items (id),
  qty numeric(12, 2) not null check (qty > 0),
  stock_at numeric(12, 2) not null default 0,   -- stok sistem when the request was made
  primary key (request_id, item_id)
);
alter table public.stock_goods_in add column if not exists request_id bigint references public.stock_requests (id);
alter table public.stock_requests enable row level security;
alter table public.stock_request_lines enable row level security;
revoke all on public.stock_requests, public.stock_request_lines from anon, authenticated;

-- Pemasok (suppliers), 12 Nov 2026: who goods come from. Added by the owner or a manager (Glenn
-- adds his own; nothing is seeded). A supplier is never deleted, only switched off (active),
-- so goods-in and requests that name it keep it. Goods in and a request can name one, optional.
create table if not exists public.stock_suppliers (
  id bigint generated always as identity primary key,
  name text not null check (length(trim(name)) between 1 and 60),
  phone text check (length(phone) <= 30),
  address text check (length(address) <= 200),
  note text check (length(note) <= 200),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists stock_suppliers_name on public.stock_suppliers (lower(name));
alter table public.stock_suppliers enable row level security;
revoke all on public.stock_suppliers from anon, authenticated;
alter table public.stock_goods_in add column if not exists supplier_id bigint references public.stock_suppliers (id);
alter table public.stock_requests add column if not exists supplier_id bigint references public.stock_suppliers (id);
-- Harga beli (cost) on goods in, optional: unit_cost per satuan and total_cost in rupiah (whole).
alter table public.stock_goods_in add column if not exists unit_cost numeric(14, 4) check (unit_cost > 0);
alter table public.stock_goods_in add column if not exists total_cost int check (total_cost > 0);
alter table public.stock_goods_in_changes add column if not exists old_cost int;
alter table public.stock_goods_in_changes add column if not exists new_cost int;
create index if not exists stock_moves_order on public.stock_moves (order_id) where order_id is not null;

create or replace function public._stock_moves_locked() returns trigger
language plpgsql
as $$ begin raise exception 'Catatan stok tidak bisa diubah atau dihapus. Catat koreksi.'; end $$;
drop trigger if exists stock_moves_locked on public.stock_moves;
create trigger stock_moves_locked before update or delete on public.stock_moves
  for each row execute function public._stock_moves_locked();

-- ---------------------------------------------------------------- row security
alter table public.stock_items enable row level security;
alter table public.stock_recipes enable row level security;
alter table public.stock_goods_in enable row level security;
alter table public.stock_goods_in_changes enable row level security;
alter table public.stock_counts enable row level security;
alter table public.stock_count_lines enable row level security;
alter table public.stock_moves enable row level security;
revoke all on public.stock_items, public.stock_recipes, public.stock_goods_in, public.stock_goods_in_changes,
  public.stock_counts, public.stock_count_lines, public.stock_moves from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create or replace function public._stock_staff_msg() returns text
language sql immutable
as $$ select 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan akun Anda.'::text $$;

create or replace function public._stock_today() returns date
language sql stable
as $$ select public._local(now())::date $$;

-- Stock of an item, optionally only up to a ledger row (for counts).
create or replace function public._stock_balance(p_item int, p_upto bigint default null) returns numeric
language sql stable security definer set search_path = public
as $$ select coalesce(sum(qty), 0) from stock_moves where item_id = p_item and (p_upto is null or id <= p_upto) $$;

-- The recipe of one product and flavour: a flavour row replaces the every-flavour row.
create or replace function public._stock_recipe(p_product int, p_flavour text)
returns table (item_id int, qty numeric)
language sql stable security definer set search_path = public
as $$
  select x.item_id, x.qty from (
    select distinct on (r.item_id) r.item_id, r.qty from stock_recipes r
     where r.product_id = p_product and (r.flavour_id is null or r.flavour_id = p_flavour)
     order by r.item_id, (r.flavour_id is null)
  ) x where x.qty > 0
$$;

create or replace function public._stock_item(p_item int) returns stock_items
language plpgsql stable security definer set search_path = public
as $$
declare i stock_items;
begin
  select * into i from stock_items where id = p_item;
  if i.id is null then raise exception 'Barang tidak dikenal.'; end if;
  return i;
end $$;

-- A quantity typed by staff: more than 0, at most 2 decimals, not absurd.
create or replace function public._stock_qty(p numeric, p_zero_ok boolean default false) returns numeric
language plpgsql immutable
as $$
begin
  if p is null or p < 0 or (p = 0 and not p_zero_ok) then raise exception 'Isi jumlahnya.'; end if;
  if p > 1000000 then raise exception 'Jumlah terlalu besar. Periksa lagi angkanya.'; end if;
  if p <> round(p, 2) then raise exception 'Jumlah paling banyak 2 angka di belakang koma.'; end if;
  return p;
end $$;

-- The staff member responsible for a report: required, and must be an active staff account.
create or replace function public._stock_responsible(p uuid) returns uuid
language plpgsql stable security definer set search_path = public
as $$
begin
  if p is null or not exists (select 1 from profiles where id = p and role in ('staff', 'manager', 'owner') and deleted_at is null) then
    raise exception 'Pilih staf yang bertanggung jawab.';
  end if;
  return p;
end $$;

-- An active supplier, or an Indonesian error.
create or replace function public._stock_supplier(p_id bigint) returns stock_suppliers
language plpgsql stable security definer set search_path = public
as $$
declare s stock_suppliers;
begin
  select * into s from stock_suppliers where id = p_id;
  if s.id is null then raise exception 'Pemasok tidak ditemukan.'; end if;
  if not s.active then raise exception 'Pemasok % sedang tidak dipakai.', s.name; end if;
  return s;
end $$;

-- Harga beli: the cashier gives either the total paid ('total') or the price per satuan ('unit').
-- Returns both; null when no price was given.
create or replace function public._stock_cost(p_qty numeric, p_mode text, p_cost numeric, out unit_cost numeric, out total_cost int)
language plpgsql immutable
as $$
begin
  if p_cost is null then return; end if;
  if p_mode is null or p_mode not in ('total', 'unit') then raise exception 'Pilih Total atau Per satuan untuk harga beli.'; end if;
  if p_cost <= 0 then raise exception 'Harga beli harus lebih dari 0.'; end if;
  if p_cost > 2000000000 then raise exception 'Harga beli terlalu besar.'; end if;
  if p_mode = 'total' then
    total_cost := round(p_cost)::int; unit_cost := round(p_cost / p_qty, 4);
  else
    unit_cost := round(p_cost, 4); total_cost := round(p_cost * p_qty)::int;
  end if;
  if total_cost > 2000000000 or total_cost <= 0 then raise exception 'Harga beli tidak masuk akal. Periksa angkanya.'; end if;
end $$;

-- Harga beli and harga pokok are for the owner and managers only (Glenn, 14 Nov 2026).
create or replace function public._stock_sees_cost() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from profiles where id = auth.uid() and role in ('manager', 'owner') and deleted_at is null) $$;

-- Every delivery so far came from Hanashuya's own kitchen (Glenn, 14 Nov 2026): it is the pemasok
-- for current stock and the default when none is picked. Safe to re-run.
insert into public.stock_suppliers (name, note) select 'Hanashuya', 'Dapur Hanashuya'
 where not exists (select 1 from public.stock_suppliers where lower(name) = 'hanashuya');
update public.stock_goods_in set supplier_id = (select id from public.stock_suppliers where lower(name) = 'hanashuya')
 where supplier_id is null;

create or replace function public._stock_goods_in_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', g.id, 'item_id', g.item_id, 'item', i.name, 'unit', i.unit, 'qty', g.qty,
    'current_qty', g.current_qty, 'status', g.status, 'note', g.note, 'slip_note', g.slip_note, 'day', g.day,
    'at', g.created_at,
    'received_by', (select public._first_name(full_name) from profiles where id = g.received_by),
    'recorded_by', (select public._first_name(full_name) from profiles where id = g.created_by),
    'responsible', (select public._first_name(full_name) from profiles where id = coalesce(g.responsible_id, g.received_by)),
    'request_id', g.request_id, 'request_no', (select r.no from stock_requests r where r.id = g.request_id),
    'supplier_id', g.supplier_id, 'supplier', (select s.name from stock_suppliers s where s.id = g.supplier_id),
    'unit_cost', case when public._stock_sees_cost() then g.unit_cost end,
    'total_cost', case when public._stock_sees_cost() then g.total_cost end,
    'changes', coalesce((select json_agg(json_build_object('kind', c.kind, 'old_qty', c.old_qty, 'new_qty', c.new_qty,
        'reason', c.reason, 'at', c.changed_at,
        'old_cost', case when public._stock_sees_cost() then c.old_cost end, 'new_cost', case when public._stock_sees_cost() then c.new_cost end,
        'by', (select public._first_name(full_name) from profiles where id = c.changed_by)) order by c.id)
      from stock_goods_in_changes c where c.goods_in_id = g.id), '[]'))
  from stock_goods_in g join stock_items i on i.id = g.item_id where g.id = p_id
$$;

create or replace function public._stock_count_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  -- Per line (stok opname, Glenn 11 Nov 2026): system = what the system expected, physical =
  -- what staff counted, selisih = physical - system, actual = the stock after the decision
  -- (accepted: the physical count; rejected or replaced: the system stock stays; waiting: null).
  -- expected, counted and difference are the same numbers under their first names.
  select json_build_object('id', c.id, 'day', c.day, 'status', c.status, 'note', c.note, 'at', c.submitted_at,
    'closing', c.closing,
    'by', (select public._first_name(full_name) from profiles where id = c.submitted_by),
    'responsible', (select public._first_name(full_name) from profiles where id = coalesce(c.responsible_id, c.submitted_by)),
    'decided_by', (select public._first_name(full_name) from profiles where id = c.decided_by),
    'decided_at', c.decided_at, 'decision_note', c.decision_note,
    'lines', coalesce((select json_agg(json_build_object('item_id', l.item_id, 'item', i.name, 'unit', i.unit,
        'expected', l.expected, 'counted', l.counted, 'thrown', l.thrown, 'difference', l.counted - l.expected,
        'system', l.expected, 'physical', l.counted, 'selisih', l.counted - l.expected,
        'actual', case c.status when 'diterima' then l.counted when 'menunggu' then null else l.expected end)
        order by i.sort, i.id)
      from stock_count_lines l join stock_items i on i.id = l.item_id where l.count_id = c.id), '[]'))
  from stock_counts c where c.id = p_id
$$;

-- ---------------------------------------------------------------- sales (called by pos.sql)
-- Harga pokok of one unit of a product and flavour, from its recipe and today's item costs.
alter table public.pos_order_items add column if not exists cost int;
create or replace function public._stock_unit_cost(p_product int, p_flavour text) returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(r.qty * i.unit_cost), 0) from public._stock_recipe(p_product, p_flavour) r join stock_items i on i.id = r.item_id
$$;

-- Deducts every line of a paid POS order from its recipe, free paper bags included.
-- One ledger row per item per order. Safe to call twice.
create or replace function public._stock_apply_order(p_order uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare o pos_orders;
begin
  select * into o from pos_orders where id = p_order;
  if o.id is null or o.status <> 'dibayar' then return; end if;
  if exists (select 1 from stock_moves where order_id = o.id and kind = 'penjualan') then return; end if;
  insert into stock_moves (item_id, kind, qty, day, order_id, reason, created_by)
  select x.item_id, 'penjualan', -sum(x.q), o.sale_day, o.id, o.receipt_no, auth.uid()
    from (select r.item_id, i.qty * r.qty as q from pos_order_items i
           cross join lateral public._stock_recipe(i.product_id, i.flavour_id) r
          where i.order_id = o.id) x
   group by x.item_id having sum(x.q) <> 0;
  -- What each line cost at today's harga pokok, kept for the profit report.
  update pos_order_items i set cost = round(i.qty * public._stock_unit_cost(i.product_id, i.flavour_id))::int where i.order_id = o.id;
end $$;

-- A void or refund puts back exactly what the sale took. Safe to call twice.
create or replace function public._stock_reverse_order(p_order uuid) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare o pos_orders;
begin
  select * into o from pos_orders where id = p_order;
  if o.id is null then return; end if;
  if exists (select 1 from stock_moves where order_id = o.id and kind = 'batal_penjualan') then return; end if;
  insert into stock_moves (item_id, kind, qty, day, order_id, reason, created_by)
  select m.item_id, 'batal_penjualan', -m.qty, public._stock_today(), o.id,
         case when o.status = 'refund' then 'Refund ' else 'Batal ' end || o.receipt_no, auth.uid()
    from stock_moves m where m.order_id = o.id and m.kind = 'penjualan';
end $$;

-- ---------------------------------------------------------------- staff
-- Items, people who can receive goods, and whether there is an open count.
create or replace function public.stock_catalog() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg()); duty uuid[] := '{}';
begin
  -- Staff clocked in now (attendance.sql, run after this file): listed first on the tablet.
  if to_regprocedure('public._att_last(uuid, timestamptz)') is not null then
    execute $q$select coalesce(array_agg(p.id), '{}') from profiles p cross join lateral (select * from public._att_last(p.id, now())) e
      where p.role in ('staff', 'manager') and p.deleted_at is null and e.id is not null and e.action <> 'pulang'$q$ into duty;
  end if;
  return json_build_object(
    'role', (select role from profiles where id = me),
    'suppliers', coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name) order by lower(s.name))
      from stock_suppliers s where s.active), '[]'),
    'items', coalesce((select json_agg(json_build_object('id', i.id, 'code', i.code, 'name', i.name, 'unit', i.unit,
        'low_level', i.low_level, 'closes_at_zero', i.closes_at_zero) order by i.sort, i.id)
      from stock_items i where i.active), '[]'),
    'staff', coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'is_me', p.id = me,
        'role', p.role, 'on_duty', p.id = any (duty))
        order by p.id = any (duty) desc, p.full_name)
      from profiles p where p.role in ('staff', 'manager', 'owner') and p.deleted_at is null), '[]'));
end $$;

-- Stock now for every active item, with a low-stock mark.
create or replace function public.stock_now() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
begin
  return coalesce((select json_agg(x order by x.sort, x.id) from (
    select i.id, i.name, i.unit, i.sort, i.low_level, i.closes_at_zero, b.qty,
      (i.low_level is not null and b.qty <= i.low_level) as low
    from stock_items i cross join lateral (select public._stock_balance(i.id) as qty) b
    where i.active) x), '[]');
end $$;

-- A request with its lines: diminta, stok sistem at the time, and what has arrived so far.
create or replace function public._stock_request_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', r.id, 'no', r.no, 'day', r.day, 'at', r.created_at, 'needed_by', r.needed_by,
    'note', r.note, 'status', r.status,
    'supplier_id', r.supplier_id, 'supplier', (select s.name from stock_suppliers s where s.id = r.supplier_id),
    'by', (select public._first_name(full_name) from profiles where id = r.created_by),
    'responsible', (select public._first_name(full_name) from profiles where id = coalesce(r.responsible_id, r.created_by)),
    'cancelled_by', (select public._first_name(full_name) from profiles where id = r.cancelled_by),
    'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'lines', coalesce((select json_agg(json_build_object('item_id', l.item_id, 'item', i.name, 'unit', i.unit,
        'qty', l.qty, 'stock_at', l.stock_at,
        'received', coalesce((select sum(g.current_qty) from stock_goods_in g
          where g.request_id = r.id and g.item_id = l.item_id and g.status <> 'dibatalkan'), 0))
        order by i.sort, i.id)
      from stock_request_lines l join stock_items i on i.id = l.item_id where l.request_id = r.id), '[]'))
  from stock_requests r where r.id = p_id
$$;

-- Status from what has arrived: nothing = dikirim, some = sebagian, every line in full = selesai.
create or replace function public._stock_request_refresh(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare got numeric; full_lines int; n int;
begin
  if p_id is null then return; end if;
  select coalesce(sum(x.rec), 0), count(*) filter (where x.rec >= x.qty), count(*) into got, full_lines, n from (
    select l.qty, coalesce((select sum(g.current_qty) from stock_goods_in g
      where g.request_id = p_id and g.item_id = l.item_id and g.status <> 'dibatalkan'), 0) as rec
    from stock_request_lines l where l.request_id = p_id) x;
  update stock_requests set status = case when n > 0 and full_lines = n then 'selesai' when got > 0 then 'sebagian' else 'dikirim' end
   where id = p_id and status <> 'batal';
end $$;

-- New request. p_lines: [{item, qty}]. p_responsible required, p_needed_by optional (today or later).
drop function if exists public.stock_request_create(jsonb, date, text, uuid);
create or replace function public.stock_request_create(p_lines jsonb, p_needed_by date, p_note text, p_responsible uuid,
  p_supplier bigint default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  rb uuid := public._stock_responsible(p_responsible); d date := public._stock_today();
  ln jsonb; i stock_items; q numeric; rid bigint; seq int; seen int[] := '{}';
  sp stock_suppliers := case when p_supplier is null then null else public._stock_supplier(p_supplier) end;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Isi minimal satu barang yang diminta.';
  end if;
  if p_needed_by is not null and p_needed_by < d then raise exception 'Tanggal dibutuhkan tidak boleh sebelum hari ini.'; end if;
  perform pg_advisory_xact_lock(hashtext('stock_request_no'));
  seq := coalesce((select count(*) from stock_requests where day = d), 0) + 1;
  insert into stock_requests (no, day, needed_by, note, responsible_id, created_by, supplier_id)
  values ('PB-' || to_char(d, 'YYMMDD') || '-' || lpad(seq::text, 2, '0'), d, p_needed_by,
    nullif(trim(coalesce(p_note, '')), ''), rb, me, sp.id) returning id into rid;
  for ln in select * from jsonb_array_elements(p_lines) loop
    begin
      i := public._stock_item((ln->>'item')::int); q := (ln->>'qty')::numeric;
    exception when invalid_text_representation then raise exception 'Angka permintaan tidak valid.';
    end;
    if not i.active then raise exception '% sedang tidak dipakai.', i.name; end if;
    if i.id = any (seen) then raise exception '% tertulis dua kali.', i.name; end if;
    seen := seen || i.id;
    insert into stock_request_lines (request_id, item_id, qty, stock_at)
    values (rid, i.id, public._stock_qty(q), public._stock_balance(i.id));
  end loop;
  perform public._log('stok_permintaan', jsonb_build_object('request', rid, 'items', jsonb_array_length(p_lines), 'supplier', sp.name));
  return public._stock_request_json(rid);
end $$;

-- Requests made in a date range, newest first. Staff: the last 31 days; manager and owner up to 400 days.
create or replace function public.stock_request_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  lead boolean := exists (select 1 from profiles where id = me and role in ('manager', 'owner'));
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  if not lead and p_from < public._stock_today() - 31 then raise exception 'Riwayat permintaan untuk staf paling lama 30 hari.'; end if;
  return coalesce((select json_agg(public._stock_request_json(r.id) order by r.id desc)
    from stock_requests r where r.day between p_from and p_to), '[]');
end $$;

-- Requests still waiting for goods (dikirim or sebagian), for "Dari permintaan" in Barang masuk.
create or replace function public.stock_request_open() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
begin
  return coalesce((select json_agg(public._stock_request_json(r.id) order by r.id desc)
    from stock_requests r where r.status in ('dikirim', 'sebagian')), '[]');
end $$;

create or replace function public.stock_request_detail(p_id bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg()); j json;
begin
  j := public._stock_request_json(p_id);
  if j is null then raise exception 'Permintaan barang tidak ditemukan.'; end if;
  return j;
end $$;

create or replace function public.stock_request_cancel(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membatalkan permintaan barang.');
  r stock_requests; n text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if n is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  select * into r from stock_requests where id = p_id for update;
  if r.id is null then raise exception 'Permintaan barang tidak ditemukan.'; end if;
  if r.status in ('selesai', 'batal') then raise exception 'Permintaan ini sudah %.', r.status; end if;
  update stock_requests set status = 'batal', cancelled_by = me, cancelled_at = now(), cancel_reason = n where id = r.id;
  perform public._log('stok_batal_permintaan', jsonb_build_object('request', r.id, 'no', r.no, 'reason', n));
  return public._stock_request_json(r.id);
end $$;

-- Goods in. p_responsible: the staff member responsible, who took the delivery (required,
-- picked on the tablet; 11 Nov 2026 this replaced p_received_by, which defaulted to the
-- signed-in account). It is stored as responsible_id and received_by. p_request: the
-- permintaan barang it came from (optional); its status follows what has arrived.
-- p_supplier: the pemasok (optional; a request's supplier is the default). p_cost_mode and
-- p_cost: the harga beli, optional, 'total' = rupiah paid in all, 'unit' = rupiah per satuan.
-- With a price, the item's harga pokok (stock_items.unit_cost) becomes a weighted average of
-- the stock on hand and this delivery (the delivery's price alone when nothing is on hand or
-- no price was set yet).
drop function if exists public.stock_goods_in(int, numeric, text, text, uuid);
drop function if exists public.stock_goods_in(int, numeric, text, text, uuid, bigint);
create or replace function public.stock_goods_in(p_item int, p_qty numeric, p_note text, p_slip text, p_responsible uuid,
  p_request bigint default null, p_supplier bigint default null, p_cost_mode text default null, p_cost numeric default null)
returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  i stock_items := public._stock_item(p_item); q numeric := public._stock_qty(p_qty); gid bigint;
  rb uuid := public._stock_responsible(p_responsible); rq stock_requests; sp stock_suppliers;
  c record; old_qty numeric; new_cost numeric; typed boolean;
begin
  if not i.active then raise exception '% sedang tidak dipakai.', i.name; end if;
  -- Staff never see or type harga beli (Glenn, 14 Nov 2026): only a manager or the owner may
  -- give one. Without one, the delivery is costed at the item's harga pokok (COGS) x jumlah.
  if exists (select 1 from profiles where id = me and role in ('manager', 'owner')) then
    select * into c from public._stock_cost(q, p_cost_mode, p_cost);
  else
    select * into c from public._stock_cost(q, null, null);
  end if;
  typed := c.unit_cost is not null;
  if not typed and i.unit_cost > 0 then
    c.unit_cost := i.unit_cost; c.total_cost := greatest(1, round(i.unit_cost * q))::int;
  end if;
  if p_request is not null then
    select * into rq from stock_requests where id = p_request for update;
    if rq.id is null then raise exception 'Permintaan barang tidak ditemukan.'; end if;
    if rq.status not in ('dikirim', 'sebagian') then raise exception 'Permintaan % sudah %.', rq.no, rq.status; end if;
    if not exists (select 1 from stock_request_lines where request_id = rq.id and item_id = i.id) then
      raise exception '% tidak ada di permintaan %.', i.name, rq.no;
    end if;
  end if;
  if coalesce(p_supplier, rq.supplier_id) is not null then
    sp := public._stock_supplier(coalesce(p_supplier, rq.supplier_id));
  else
    -- No pemasok picked: Hanashuya's own kitchen (Glenn, 14 Nov 2026).
    select * into sp from stock_suppliers where lower(name) = 'hanashuya' and active;
  end if;
  old_qty := public._stock_balance(i.id);
  insert into stock_goods_in (item_id, qty, current_qty, note, slip_note, day, received_by, responsible_id, created_by, request_id,
    supplier_id, unit_cost, total_cost)
  values (i.id, q, q, nullif(trim(coalesce(p_note, '')), ''), nullif(trim(coalesce(p_slip, '')), ''), public._stock_today(), rb, rb, me, rq.id,
    sp.id, c.unit_cost, c.total_cost)
  returning id into gid;
  if typed then
    new_cost := case when old_qty > 0 and i.unit_cost > 0
      then (old_qty * i.unit_cost + q * c.unit_cost) / (old_qty + q) else c.unit_cost end;
    update stock_items set unit_cost = round(new_cost, 2) where id = i.id;
    perform public._log('stok_harga_pokok_rata', jsonb_build_object('item', i.name, 'goods_in', gid, 'dari', i.unit_cost,
      'jadi', round(new_cost, 2), 'stok_lama', old_qty, 'masuk', q, 'harga_satuan', c.unit_cost));
  end if;
  perform public._stock_request_refresh(rq.id);
  insert into stock_moves (item_id, kind, qty, day, goods_in_id, reason, responsible_id, created_by)
  values (i.id, 'masuk', q, public._stock_today(), gid, nullif(trim(coalesce(p_note, '')), ''), rb, me);
  perform public._log('stok_masuk', jsonb_build_object('goods_in', gid, 'item', i.name, 'qty', q, 'supplier', sp.name, 'total', c.total_cost));
  return public._stock_goods_in_json(gid);
end $$;

-- Other ways out: buang, rusak, promo. Rusak and promo need a written reason.
-- Samples are rung up in Mode penjualan on the till (stock_sample, Glenn 12 Nov 2026), per
-- product and flavour, so the right choux, vla and jam come off; not here by raw item.
-- p_responsible: the staff member responsible (required, 11 Nov 2026).
drop function if exists public.stock_out(int, text, numeric, text);
create or replace function public.stock_out(p_item int, p_kind text, p_qty numeric, p_reason text, p_responsible uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  i stock_items := public._stock_item(p_item); q numeric := public._stock_qty(p_qty);
  r text := nullif(trim(coalesce(p_reason, '')), ''); mid bigint; rb uuid;
begin
  if p_kind = 'sampel' then raise exception 'Sampel dicatat dari Mode penjualan: tekan Sampel, pilih produk dan rasa.'; end if;
  if p_kind is null or p_kind not in ('buang', 'rusak', 'promo') then
    raise exception 'Pilih alasan: dibuang, rusak atau promo.';
  end if;
  if r is null and p_kind in ('rusak', 'promo') then raise exception 'Tulis alasannya.'; end if;
  rb := public._stock_responsible(p_responsible);
  r := coalesce(r, case p_kind when 'sampel' then 'Sampel' else 'Dibuang' end);
  insert into stock_moves (item_id, kind, qty, day, reason, responsible_id, created_by)
  values (i.id, p_kind, -q, public._stock_today(), r, rb, me) returning id into mid;
  perform public._log('stok_keluar_' || p_kind, jsonb_build_object('move', mid, 'item', i.name, 'qty', q, 'reason', r));
  return json_build_object('id', mid, 'item', i.name, 'kind', p_kind, 'qty', q, 'stock', public._stock_balance(i.id),
    'responsible', (select public._first_name(full_name) from profiles where id = rb));
end $$;

-- A small liner is half a big one: n besar out, 2n kecil in.
create or replace function public.stock_cut_liner(p_qty int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  big int := (select id from stock_items where code = 'liner_besar');
  small int := (select id from stock_items where code = 'liner_kecil');
begin
  if big is null or small is null then raise exception 'Barang paper liner tidak ditemukan. Hubungi pemilik.'; end if;
  if p_qty is null or p_qty < 1 or p_qty > 500 then raise exception 'Isi jumlah liner besar yang dipotong.'; end if;
  insert into stock_moves (item_id, kind, qty, day, reason, created_by) values
    (big, 'potong_liner', -p_qty, public._stock_today(), 'Potong liner', me),
    (small, 'potong_liner', 2 * p_qty, public._stock_today(), 'Potong liner', me);
  perform public._log('stok_potong_liner', jsonb_build_object('besar', p_qty, 'kecil', 2 * p_qty));
  return json_build_object('besar', public._stock_balance(big), 'kecil', public._stock_balance(small));
end $$;

-- Stok opname (until 11 Nov 2026 "hitung stok"), any time of day. p_lines: [{item, counted,
-- thrown}]. "thrown" is recorded as buang first (choux left at closing), and "counted" is
-- what stays after that. p_responsible: the staff member responsible (required).
-- p_closing: the count at closing. A new opname replaces one that is still waiting.
drop function if exists public.stock_submit_count(jsonb, text);
create or replace function public.stock_submit_count(p_lines jsonb, p_note text, p_responsible uuid, p_closing boolean default false) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  ln jsonb; i stock_items; c numeric; t numeric; cid bigint; seen int[] := '{}'; v_day date := public._stock_today();
  rb uuid := public._stock_responsible(p_responsible);
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Isi hasil stok opname minimal satu barang.';
  end if;
  update stock_counts set status = 'diganti', decided_by = me, decided_at = now(), decision_note = 'Diganti stok opname baru'
   where status = 'menunggu';
  insert into stock_counts (day, note, submitted_by, responsible_id, closing)
  values (v_day, nullif(trim(coalesce(p_note, '')), ''), me, rb, coalesce(p_closing, false)) returning id into cid;
  for ln in select * from jsonb_array_elements(p_lines) loop
    begin
      i := public._stock_item((ln->>'item')::int);
      c := (ln->>'counted')::numeric; t := coalesce(nullif(ln->>'thrown', '')::numeric, 0);
    exception when invalid_text_representation then raise exception 'Angka stok opname tidak valid.';
    end;
    if i.id = any (seen) then raise exception '% tertulis dua kali.', i.name; end if;
    seen := seen || i.id;
    c := public._stock_qty(c, true); t := public._stock_qty(t, true);
    if t > 0 then
      insert into stock_moves (item_id, kind, qty, day, count_id, reason, responsible_id, created_by)
      values (i.id, 'buang', -t, v_day, cid, 'Sisa saat tutup', rb, me);
    end if;
    insert into stock_count_lines (count_id, item_id, expected, counted, thrown) values (cid, i.id, 0, c, t);
  end loop;
  update stock_counts set last_move_id = coalesce((select max(id) from stock_moves), 0) where id = cid;
  update stock_count_lines l set expected = public._stock_balance(l.item_id, (select last_move_id from stock_counts where id = cid))
   where l.count_id = cid;
  perform public._log('stok_hitung', jsonb_build_object('count', cid, 'items', jsonb_array_length(p_lines)));
  return public._stock_count_json(cid);
end $$;

-- Today on the Stok tab: goods in, other ways out, potong liner, and today's count.
create or replace function public.stock_today() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg()); d date := public._stock_today();
begin
  return json_build_object('day', d,
    -- cancel_pending: a staff cancel request waits for a manager (14 Nov 2026).
    'goods_in', coalesce((select json_agg(public._stock_goods_in_json(g.id)::jsonb || jsonb_build_object('cancel_pending',
        exists (select 1 from stock_cancel_requests c where c.goods_in_id = g.id and c.status = 'menunggu')) order by g.id desc)
      from stock_goods_in g where g.day = d), '[]'),
    'outs', coalesce((select json_agg(json_build_object('id', m.id, 'item', i.name, 'unit', i.unit, 'kind', m.kind,
        'qty', -m.qty, 'reason', m.reason, 'at', m.created_at,
        'cancelled', exists (select 1 from stock_moves x where x.reverses_id = m.id),
        'cancel_pending', exists (select 1 from stock_cancel_requests c where c.move_id = m.id and c.status = 'menunggu'),
        'by', (select public._first_name(full_name) from profiles where id = m.created_by),
        'responsible', (select public._first_name(full_name) from profiles where id = coalesce(m.responsible_id, m.created_by))) order by m.id desc)
      from stock_moves m join stock_items i on i.id = m.item_id
      where m.day = d and m.kind in ('sampel', 'buang', 'rusak', 'promo') and m.reverses_id is null), '[]'),
    -- Barang keluar karena penjualan today, per item (sales minus cancelled sales).
    'sold', coalesce((select json_agg(json_build_object('item', x.name, 'unit', x.unit, 'qty', x.q) order by x.sort, x.id) from (
        select i.id, i.name, i.unit, i.sort, -sum(m.qty) as q from stock_moves m join stock_items i on i.id = m.item_id
         where m.day = d and m.kind in ('penjualan', 'batal_penjualan') group by i.id, i.name, i.unit, i.sort having sum(m.qty) <> 0) x), '[]'),
    'liner_cut', coalesce((select -sum(m.qty) from stock_moves m join stock_items i on i.id = m.item_id
      where m.day = d and m.kind = 'potong_liner' and i.code = 'liner_besar'), 0),
    'count', (select public._stock_count_json(c.id) from stock_counts c
      where c.day = d and c.status in ('menunggu', 'diterima') order by c.id desc limit 1));
end $$;

-- ---------------------------------------------------------------- samples from the till
-- Sampel (Glenn, 12 Nov 2026): staff ring samples up in Mode penjualan, per product, flavour
-- and piece. One piece = the product's recipe divided by its number of choux, edible items
-- only (the choux, vla and jam; no box, liner, pouch or bag). p_sample:
--   { id: uuid made on the tablet, served_by: uuid, items: [{ product: 'mini8', flavour: 'matcha', qty: 2 }] }
-- The same id twice is stored once. Each ledger row carries the sample id in order_id.
create table if not exists public.stock_samples (
  id uuid primary key,
  day date not null,
  served_by uuid references public.profiles (id) on delete set null,
  items jsonb not null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.stock_samples enable row level security;
revoke all on public.stock_samples from anon, authenticated;

create or replace function public.stock_sample(p_sample jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  sid uuid; who uuid; it jsonb; pr menu_items; fl pos_flavours; q int; pieces numeric; d date := public._stock_today();
  labels text[] := '{}'; n int := 0;
begin
  begin sid := (p_sample->>'id')::uuid; exception when others then sid := null; end;
  if sid is null then raise exception 'Sampel tanpa nomor. Muat ulang kasir.'; end if;
  if exists (select 1 from stock_samples where id = sid) then
    return json_build_object('id', sid, 'repeat', true);
  end if;
  begin who := public._stock_responsible((p_sample->>'served_by')::uuid);
  exception when others then raise exception 'Pilih siapa yang memberi sampel.'; end;
  if jsonb_typeof(p_sample->'items') is distinct from 'array' or jsonb_array_length(p_sample->'items') = 0 then
    raise exception 'Pilih produk untuk sampel.';
  end if;
  insert into stock_samples (id, day, served_by, items, created_by) values (sid, d, who, p_sample->'items', me);
  for it in select * from jsonb_array_elements(p_sample->'items') loop
    select * into pr from menu_items where code = it->>'product' and active;
    if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
    begin q := (it->>'qty')::int; exception when others then q := null; end;
    if q is null or q < 1 or q > 30 then raise exception 'Jumlah sampel 1 sampai 30 pcs.'; end if;
    fl := null;
    if pr.needs_flavour then
      select * into fl from pos_flavours where id = it->>'flavour' and active;
      if fl.id is null then raise exception 'Pilih rasa untuk sampel %.', pr.name; end if;
    end if;
    -- Pieces in one unit of the product = its choux in the recipe.
    select sum(r.qty) into pieces from public._stock_recipe(pr.id, fl.id) r join stock_items i on i.id = r.item_id where i.closes_at_zero;
    if coalesce(pieces, 0) <= 0 then raise exception '% tidak punya resep choux untuk sampel.', pr.name; end if;
    insert into stock_moves (item_id, kind, qty, day, order_id, reason, responsible_id, created_by)
    select r.item_id, 'sampel', -round(r.qty * q / pieces, 2), d, sid,
           'Sampel ' || q || ' pcs ' || coalesce(pr.pos_name, pr.name) || coalesce(' ' || fl.label, ''), who, me
      from public._stock_recipe(pr.id, fl.id) r join stock_items i on i.id = r.item_id
     where (i.closes_at_zero or i.unit = 'g') and round(r.qty * q / pieces, 2) <> 0;
    labels := labels || (q || ' pcs ' || coalesce(pr.pos_name, pr.name) || coalesce(' ' || fl.label, ''));
    n := n + q;
  end loop;
  perform public._log('stok_sampel', jsonb_build_object('sample', sid, 'items', p_sample->'items', 'served_by', who));
  return json_build_object('id', sid, 'pieces', n, 'items', to_json(labels),
    'served_by', (select public._first_name(full_name) from profiles where id = who));
end $$;

-- ---------------------------------------------------------------- manager and owner
-- p_cost_mode and p_cost (optional): correct the harga beli. The item's average harga pokok
-- is not recalculated; the owner can set it under Barang.
drop function if exists public.stock_change_goods_in(bigint, numeric, text);
create or replace function public.stock_change_goods_in(p_id bigint, p_qty numeric, p_reason text,
  p_cost_mode text default null, p_cost numeric default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengubah barang masuk.');
  g stock_goods_in; q numeric := public._stock_qty(p_qty); r text := nullif(trim(coalesce(p_reason, '')), '');
  c record; nu numeric; nt int;
begin
  if r is null then raise exception 'Tulis alasan perubahannya.'; end if;
  select * into g from stock_goods_in where id = p_id for update;
  if g.id is null then raise exception 'Catatan barang masuk tidak ditemukan.'; end if;
  if g.status = 'dibatalkan' then raise exception 'Catatan ini sudah dibatalkan.'; end if;
  if p_cost is not null then
    select * into c from public._stock_cost(q, p_cost_mode, p_cost); nu := c.unit_cost; nt := c.total_cost;
  elsif g.unit_cost is not null then
    nu := g.unit_cost; nt := greatest(1, round(g.unit_cost * q)::int);   -- same price per satuan, new quantity
  end if;
  if q = g.current_qty and nt is not distinct from g.total_cost then raise exception 'Jumlah dan harga beli sama dengan sekarang.'; end if;
  insert into stock_goods_in_changes (goods_in_id, kind, old_qty, new_qty, reason, changed_by, old_cost, new_cost)
  values (g.id, 'ubah', g.current_qty, q, r, me, g.total_cost, nt);
  if q <> g.current_qty then
    insert into stock_moves (item_id, kind, qty, day, goods_in_id, reason, created_by)
    values (g.item_id, 'koreksi', q - g.current_qty, g.day, g.id, 'Ubah barang masuk: ' || r, me);
  end if;
  update stock_goods_in set current_qty = q, status = 'diubah', unit_cost = nu, total_cost = nt where id = g.id;
  perform public._stock_request_refresh(g.request_id);
  perform public._log('stok_ubah_masuk', jsonb_build_object('goods_in', g.id, 'dari', g.current_qty, 'jadi', q, 'reason', r,
    'harga_dari', g.total_cost, 'harga_jadi', nt));
  return public._stock_goods_in_json(g.id);
end $$;

create or replace function public.stock_cancel_goods_in(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membatalkan barang masuk.');
  g stock_goods_in; r text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if r is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  select * into g from stock_goods_in where id = p_id for update;
  if g.id is null then raise exception 'Catatan barang masuk tidak ditemukan.'; end if;
  if g.status = 'dibatalkan' then raise exception 'Catatan ini sudah dibatalkan.'; end if;
  insert into stock_goods_in_changes (goods_in_id, kind, old_qty, new_qty, reason, changed_by)
  values (g.id, 'batal', g.current_qty, 0, r, me);
  if g.current_qty > 0 then
    insert into stock_moves (item_id, kind, qty, day, goods_in_id, reason, created_by)
    values (g.item_id, 'koreksi', -g.current_qty, g.day, g.id, 'Batal barang masuk: ' || r, me);
  end if;
  update stock_goods_in set current_qty = 0, status = 'dibatalkan' where id = g.id;
  perform public._stock_request_refresh(g.request_id);
  perform public._log('stok_batal_masuk', jsonb_build_object('goods_in', g.id, 'qty', g.current_qty, 'reason', r));
  return public._stock_goods_in_json(g.id);
end $$;

-- The goods-in audit list for a date range, newest first.
create or replace function public.stock_goods_in_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  return coalesce((select json_agg(public._stock_goods_in_json(g.id) order by g.id desc)
    from stock_goods_in g where g.day between p_from and p_to), '[]');
end $$;

-- The count waiting for a decision, or null.
create or replace function public.stock_count_pending() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return (select public._stock_count_json(id) from stock_counts where status = 'menunggu');
end $$;

-- Accepting writes the selisih as koreksi, so the counted amount becomes the opening stock.
create or replace function public.stock_decide_count(p_id bigint, p_accept boolean, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menerima stok opname.');
  c stock_counts; n text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into c from stock_counts where id = p_id and status = 'menunggu' for update;
  if c.id is null then raise exception 'Stok opname ini sudah diputuskan.'; end if;
  if not coalesce(p_accept, false) and n is null then raise exception 'Tulis alasan menolak stok opname ini.'; end if;
  if p_accept then
    insert into stock_moves (item_id, kind, qty, day, count_id, reason, created_by)
    select l.item_id, 'koreksi', l.counted - l.expected, c.day, c.id, 'Selisih stok opname', me
      from stock_count_lines l where l.count_id = c.id and l.counted <> l.expected;
  end if;
  update stock_counts set status = case when p_accept then 'diterima' else 'ditolak' end,
    decided_by = me, decided_at = now(), decision_note = n where id = c.id;
  perform public._log(case when p_accept then 'stok_terima_hitungan' else 'stok_tolak_hitungan' end,
    jsonb_build_object('count', c.id, 'day', c.day, 'note', n));
  return public._stock_count_json(c.id);
end $$;

-- Riwayat stok opname (Glenn, 11 Nov 2026), newest first. Staff see the last 31 days (the
-- till shows 30); a manager or the owner any range up to 400 days. Per opname: who sent
-- it, who is responsible, the status, how many items were off, and the selisih per unit
-- (pcs and grams are never added together).
create or replace function public.stock_opname_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  lead boolean := exists (select 1 from profiles where id = me and role in ('manager', 'owner'));
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  if not lead and p_from < public._stock_today() - 31 then raise exception 'Riwayat stok opname untuk staf paling lama 30 hari.'; end if;
  return coalesce((select json_agg(x order by x.at desc, x.id desc) from (
    select c.id, c.day, c.submitted_at as at, c.status, c.closing, c.note,
      (select public._first_name(full_name) from profiles where id = c.submitted_by) as by,
      (select public._first_name(full_name) from profiles where id = coalesce(c.responsible_id, c.submitted_by)) as responsible,
      (select public._first_name(full_name) from profiles where id = c.decided_by) as decided_by,
      c.decided_at, c.decision_note,
      (select count(*) from stock_count_lines l where l.count_id = c.id) as items,
      (select count(*) from stock_count_lines l where l.count_id = c.id and l.counted <> l.expected) as items_off,
      coalesce((select json_agg(json_build_object('unit', u.unit, 'qty', u.q) order by u.unit desc) from (
        select i.unit, sum(l.counted - l.expected) as q from stock_count_lines l join stock_items i on i.id = l.item_id
         where l.count_id = c.id and l.counted <> l.expected group by i.unit) u), '[]') as selisih
    from stock_counts c where c.day between p_from and p_to) x), '[]');
end $$;

-- One stok opname with every line: stok sistem, stok fisik, selisih, stok aktual.
create or replace function public.stock_opname_detail(p_id bigint) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  lead boolean := exists (select 1 from profiles where id = me and role in ('manager', 'owner'));
  c stock_counts;
begin
  select * into c from stock_counts where id = p_id;
  if c.id is null then raise exception 'Stok opname tidak ditemukan.'; end if;
  if not lead and c.day < public._stock_today() - 31 then raise exception 'Riwayat stok opname untuk staf paling lama 30 hari.'; end if;
  return public._stock_count_json(c.id);
end $$;

-- In, out and selisih per item for a date range (days are booth days, Asia/Jakarta).
--   opening   stock at the start of p_from
--   masuk     goods in, with audit changes
--   terjual   out by sales, net of voids and refunds
--   sampel, buang, rusak, promo   other ways out
--   potong_liner  + for small liners, - for big ones
--   expected  what should be there at the end of p_to
--   counted   the last accepted count in the range, if any
--   selisih   accepted counts minus the ledger (negative = missing)
--   closing   stock at the end of p_to (expected + selisih)
create or replace function public.stock_report(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  return json_build_object('from', p_from, 'to', p_to, 'items', coalesce((select json_agg(row_to_json(x) order by x.sort, x.id) from (
    select i.id, i.name, i.unit, i.sort, i.low_level, i.active,
      coalesce(sum(m.qty) filter (where m.day < p_from), 0) as opening,
      coalesce(sum(m.qty) filter (where m.day between p_from and p_to
        and (m.kind = 'masuk' or (m.kind = 'koreksi' and m.goods_in_id is not null))), 0) as masuk,
      coalesce(-sum(m.qty) filter (where m.day between p_from and p_to and m.kind in ('penjualan', 'batal_penjualan')), 0) as terjual,
      coalesce(-sum(m.qty) filter (where m.day between p_from and p_to and m.kind = 'sampel'), 0) as sampel,
      coalesce(-sum(m.qty) filter (where m.day between p_from and p_to and m.kind = 'buang'), 0) as buang,
      coalesce(-sum(m.qty) filter (where m.day between p_from and p_to and m.kind = 'rusak'), 0) as rusak,
      coalesce(-sum(m.qty) filter (where m.day between p_from and p_to and m.kind = 'promo'), 0) as promo,
      coalesce(sum(m.qty) filter (where m.day between p_from and p_to and m.kind = 'potong_liner'), 0) as potong_liner,
      coalesce(sum(m.qty) filter (where m.day <= p_to and not (m.kind = 'koreksi' and m.count_id is not null and m.day >= p_from)), 0) as expected,
      (select l.counted from stock_count_lines l join stock_counts c on c.id = l.count_id
        where l.item_id = i.id and c.status = 'diterima' and c.day between p_from and p_to
        order by c.day desc, c.id desc limit 1) as counted,
      coalesce(sum(m.qty) filter (where m.day between p_from and p_to and m.kind = 'koreksi' and m.count_id is not null), 0) as selisih,
      coalesce(sum(m.qty) filter (where m.day <= p_to), 0) as closing
    from stock_items i left join stock_moves m on m.item_id = i.id
    where i.active or exists (select 1 from stock_moves z where z.item_id = i.id and z.day between p_from and p_to)
    group by i.id) x), '[]'));
end $$;

-- Items at or below their low-stock level.
-- Items at or under their stok minimum. Everyone at the till sees the warning (Glenn,
-- 12 Nov 2026), so staff know to make a Permintaan barang; managers and the owner set it.
create or replace function public.stock_low() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
begin
  return coalesce((select json_agg(x order by x.sort, x.id) from (
    select i.id, i.name, i.unit, i.sort, i.low_level, b.qty
    from stock_items i cross join lateral (select public._stock_balance(i.id) as qty) b
    where i.active and i.low_level is not null and b.qty <= i.low_level) x), '[]');
end $$;

-- Stok minimum per item, set by a manager or the owner (Glenn, 12 Nov 2026). Null clears it.
create or replace function public.stock_set_minimum(p_item int, p_min numeric) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Stok minimum hanya bisa diatur manajer atau pemilik.');
  i stock_items := public._stock_item(p_item);
begin
  if p_min is not null and (p_min < 0 or p_min > 1000000) then raise exception 'Stok minimum tidak valid.'; end if;
  update stock_items set low_level = p_min where id = i.id;
  perform public._log('stok_minimum', jsonb_build_object('item', i.name, 'dari', i.low_level, 'jadi', p_min));
  return json_build_object('id', i.id, 'name', i.name, 'unit', i.unit, 'min', p_min, 'stock', public._stock_balance(i.id));
end $$;

-- ---------------------------------------------------------------- pemasok
-- Every supplier with how many goods-in entries and requests name it. Owner and manager.
create or replace function public.stock_supplier_list() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'address', s.address,
      'note', s.note, 'active', s.active,
      'used', (select count(*) from stock_goods_in g where g.supplier_id = s.id) + (select count(*) from stock_requests r where r.supplier_id = s.id))
    order by s.active desc, lower(s.name)) from stock_suppliers s), '[]');
end $$;

-- Add (p_id null) or change a supplier. Never deleted: switch it off with p_active false.
create or replace function public.stock_supplier_save(p_id bigint, p_name text, p_phone text, p_address text, p_note text,
  p_active boolean default true) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengatur pemasok.');
  n text := nullif(trim(coalesce(p_name, '')), ''); ph text := nullif(trim(coalesce(p_phone, '')), '');
  ad text := nullif(trim(coalesce(p_address, '')), ''); nt text := nullif(trim(coalesce(p_note, '')), '');
  sid bigint; old stock_suppliers;
begin
  if n is null or length(n) > 60 then raise exception 'Isi nama pemasok (paling panjang 60 huruf).'; end if;
  if ph is not null and (length(ph) > 30 or ph !~ '^[0-9+ ()-]+$') then raise exception 'Nomor telepon hanya boleh angka, spasi, tanda + dan -.'; end if;
  if ad is not null and length(ad) > 200 then raise exception 'Alamat terlalu panjang (paling panjang 200 huruf).'; end if;
  if nt is not null and length(nt) > 200 then raise exception 'Catatan terlalu panjang (paling panjang 200 huruf).'; end if;
  if exists (select 1 from stock_suppliers where lower(name) = lower(n) and id is distinct from p_id) then
    raise exception 'Nama pemasok ini sudah ada.';
  end if;
  if p_id is null then
    insert into stock_suppliers (name, phone, address, note, active) values (n, ph, ad, nt, coalesce(p_active, true)) returning id into sid;
    perform public._log('stok_tambah_pemasok', jsonb_build_object('supplier', sid, 'name', n));
  else
    select * into old from stock_suppliers where id = p_id for update;
    if old.id is null then raise exception 'Pemasok tidak ditemukan.'; end if;
    update stock_suppliers set name = n, phone = ph, address = ad, note = nt, active = coalesce(p_active, true) where id = p_id;
    sid := p_id;
    perform public._log('stok_ubah_pemasok', jsonb_build_object('supplier', sid, 'dari', to_jsonb(old) - 'created_at',
      'jadi', jsonb_build_object('name', n, 'phone', ph, 'address', ad, 'note', nt, 'active', coalesce(p_active, true))));
  end if;
  return (select json_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'address', s.address, 'note', s.note, 'active', s.active)
    from stock_suppliers s where s.id = sid);
end $$;

create or replace function public.stock_supplier_set_active(p_id bigint, p_active boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengatur pemasok.');
  s stock_suppliers;
begin
  select * into s from stock_suppliers where id = p_id for update;
  if s.id is null then raise exception 'Pemasok tidak ditemukan.'; end if;
  update stock_suppliers set active = coalesce(p_active, false) where id = s.id;
  perform public._log('stok_aktif_pemasok', jsonb_build_object('supplier', s.id, 'name', s.name, 'aktif', coalesce(p_active, false)));
  return json_build_object('id', s.id, 'name', s.name, 'active', coalesce(p_active, false));
end $$;

-- ---------------------------------------------------------------- owner
-- Add (p_id null) or change an item.
create or replace function public.owner_stock_save_item(p_id int, p_name text, p_unit text, p_low numeric,
  p_active boolean, p_closes_at_zero boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  n text := nullif(trim(coalesce(p_name, '')), ''); u text := nullif(trim(coalesce(p_unit, '')), ''); iid int; old stock_items;
begin
  if n is null or length(n) > 60 then raise exception 'Isi nama barang (paling panjang 60 huruf).'; end if;
  if u is null or length(u) > 10 then raise exception 'Isi satuan, misalnya pcs atau g.'; end if;
  if p_low is not null and p_low < 0 then raise exception 'Batas stok menipis tidak boleh minus.'; end if;
  if exists (select 1 from stock_items where lower(name) = lower(n) and id is distinct from p_id) then
    raise exception 'Nama barang ini sudah ada.';
  end if;
  if p_id is null then
    insert into stock_items (name, unit, low_level, active, closes_at_zero, sort)
    values (n, u, p_low, coalesce(p_active, true), coalesce(p_closes_at_zero, false),
      coalesce((select max(sort) from stock_items), 0) + 1)
    returning id into iid;
    perform public._log('stok_tambah_barang', jsonb_build_object('item', iid, 'name', n, 'unit', u));
  else
    select * into old from stock_items where id = p_id;
    if old.id is null then raise exception 'Barang tidak dikenal.'; end if;
    update stock_items set name = n, unit = u, low_level = p_low, active = coalesce(p_active, true),
      closes_at_zero = coalesce(p_closes_at_zero, false) where id = p_id;
    iid := p_id;
    perform public._log('stok_ubah_barang', jsonb_build_object('item', iid, 'dari', to_jsonb(old) - 'created_at',
      'jadi', jsonb_build_object('name', n, 'unit', u, 'low_level', p_low, 'active', p_active, 'closes_at_zero', p_closes_at_zero)));
  end if;
  return (select row_to_json(i) from stock_items i where id = iid);
end $$;

-- Set one recipe line. p_flavour null = every flavour. p_qty null removes the line;
-- 0 on a flavour line means that flavour does not use the item.
create or replace function public.owner_stock_save_recipe(p_product text, p_flavour text, p_item int, p_qty numeric) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  pr menu_items; i stock_items := public._stock_item(p_item); f text := nullif(p_flavour, ''); old numeric;
begin
  select * into pr from menu_items where code = p_product;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  if f is not null and not exists (select 1 from pos_flavours where id = f) then raise exception 'Rasa tidak dikenal.'; end if;
  if p_qty is not null then perform public._stock_qty(p_qty, true); end if;
  select qty into old from stock_recipes where product_id = pr.id and coalesce(flavour_id, '') = coalesce(f, '') and item_id = i.id;
  if p_qty is null then
    delete from stock_recipes where product_id = pr.id and coalesce(flavour_id, '') = coalesce(f, '') and item_id = i.id;
  elsif old is null then
    insert into stock_recipes (product_id, flavour_id, item_id, qty) values (pr.id, f, i.id, p_qty);
  else
    update stock_recipes set qty = p_qty where product_id = pr.id and coalesce(flavour_id, '') = coalesce(f, '') and item_id = i.id;
  end if;
  perform public._log('stok_ubah_resep', jsonb_build_object('product', p_product, 'flavour', f, 'item', i.name,
    'dari', old, 'jadi', p_qty));
end $$;

-- Everything the recipe editor needs, including every item (also inactive).
create or replace function public.owner_stock_recipes() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return json_build_object(
    'products', coalesce((select json_agg(json_build_object('code', m.code, 'name', coalesce(m.pos_name, m.name),
        'needs_flavour', m.needs_flavour) order by m.sort, m.id) from menu_items m where m.code is not null), '[]'),
    'flavours', coalesce((select json_agg(json_build_object('id', f.id, 'label', f.label) order by f.sort) from pos_flavours f), '[]'),
    'items', coalesce((select json_agg(json_build_object('id', i.id, 'name', i.name, 'unit', i.unit, 'low_level', i.low_level,
        'active', i.active, 'closes_at_zero', i.closes_at_zero, 'unit_cost', i.unit_cost) order by i.sort, i.id) from stock_items i), '[]'),
    'lines', coalesce((select json_agg(json_build_object('product', m.code, 'flavour', r.flavour_id, 'item_id', r.item_id,
        'qty', r.qty) order by m.sort, r.flavour_id nulls first, r.item_id)
      from stock_recipes r join menu_items m on m.id = r.product_id), '[]'));
end $$;

-- ---------------------------------------------------------------- WhatsApp report
-- The daily message of SOP Bab 13 ("Format laporan"), ready to copy into the group
-- "Penerimaan Barang Hanashuya". Items are found by their fixed codes, so renaming an
-- item in the owner page does not break it. Units: pcs, and grams for fla and selai.
-- Zero is written as 0, never left blank.

-- 12 -> '12', 12.5 -> '12.5', null -> '0'.
create or replace function public._stock_wa_n(n numeric) returns text
language sql immutable
as $$ select coalesce(trim_scale(round(coalesce(n, 0), 2))::text, '0') $$;

-- How much of an item left the booth in a day by the given ledger kinds (positive number).
create or replace function public._stock_wa_out(p_day date, p_kinds text[], p_code text) returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(-sum(m.qty), 0) from stock_moves m join stock_items i on i.id = m.item_id
   where i.code = p_code and m.kind = any (p_kinds) and m.day = p_day
$$;

create or replace function public.stock_daily_whatsapp(p_day date default null) returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'manager', 'owner'], public._stock_staff_msg());
  d date := coalesce(p_day, public._stock_today());
  dt text := to_char(d, 'FMDD/FMMM/YYYY');
  nl text := E'\n';
  -- the six items of the goods-in and selisih blocks, in the SOP's order
  codes text[] := array['sig', 'mini', 'vla_vanilla', 'vla_choco', 'vla_matcha', 'jam_strawberry'];
  labels text[] := array['Signature Choux', 'Mini Choux', 'Fla vanilla', 'Fla coklat', 'Fla matcha', 'Selai strawberry'];
  batches jsonb[] := '{}'; cur jsonb := '{}'; r record; k int; j int;
  cnt bigint; out_txt text := ''; t numeric;
  ms numeric; mm numeric;
begin
  -- batches: a new batch starts when an item that is already in the current one comes in again
  for r in
    select i.code, g.current_qty as qty from stock_goods_in g join stock_items i on i.id = g.item_id
     where g.day = d and g.status <> 'dibatalkan' and i.code = any (codes)
     order by g.created_at, g.id
  loop
    if jsonb_exists(cur, r.code) then batches := batches || cur; cur := '{}'; end if;
    cur := cur || jsonb_build_object(r.code, r.qty);
  end loop;
  if cur <> '{}' or coalesce(array_length(batches, 1), 0) = 0 then batches := batches || cur; end if;

  out_txt := 'Stok Masuk/Keluar ' || dt || nl;
  for k in 1 .. array_length(batches, 1) loop
    out_txt := out_txt || nl || 'BATCH ' || k || nl;
    for j in 1 .. array_length(codes, 1) loop
      out_txt := out_txt || labels[j] || ': ' || public._stock_wa_n((batches[k] ->> codes[j])::numeric) || nl;
    end loop;
  end loop;

  ms := public._stock_wa_out(d, array['sampel'], 'sig');
  mm := public._stock_wa_out(d, array['sampel'], 'mini');
  out_txt := out_txt || nl || 'SAMPLE' || nl
    || 'Signature Choux: ' || public._stock_wa_n(ms) || nl
    || 'Mini Choux: ' || public._stock_wa_n(mm) || nl
    || nl || 'TOTAL SAMPLE' || nl
    || 'Mini Choux: ' || public._stock_wa_n(ms + mm) || nl
    || nl || '___________________________' || nl
    || 'Stok Keluar ' || dt || nl || 'TERJUAL' || nl;

  -- sold: paid orders of the day (voided and refunded orders have another status)
  for j in 1 .. 4 loop
    select coalesce(sum(i.qty), 0) into t
      from pos_order_items i join pos_orders o on o.id = i.order_id
      join menu_items mi on mi.id = i.product_id
     where o.status = 'dibayar' and o.sale_day = d
       and coalesce(i.product_code, mi.code) = (array['sig1', 'sig6', 'mini15', 'mini8'])[j];
    out_txt := out_txt || (array['Signature Choux', 'Box of 6 Signature Choux', 'Mini Choux 15', 'Mini Choux 8'])[j]
      || ': ' || public._stock_wa_n(t) || nl;
  end loop;
  -- fla and selai: ledger sales of the day, net of voids and refunds of those same orders
  for j in 3 .. 6 loop
    select coalesce(-sum(m.qty), 0) into t from stock_moves m join stock_items i on i.id = m.item_id
     where i.code = codes[j] and m.kind in ('penjualan', 'batal_penjualan')
       and m.order_id in (select x.order_id from stock_moves x where x.kind = 'penjualan' and x.day = d);
    out_txt := out_txt || labels[j] || ': ' || public._stock_wa_n(t) || nl;
  end loop;

  -- promos taken today: paid orders by promo kind
  out_txt := out_txt || nl || 'PROMO DIAMBIL HARI INI:' || nl;
  for j in 1 .. 8 loop
    select count(*) into cnt from pos_orders o left join redemptions rd on rd.id = o.redemption_id
     where o.status = 'dibayar' and o.sale_day = d and (case
       when j = 1 then o.promo_kind = 'tebus_murah'
       when j = 2 then o.promo_kind = 'welcome'
       when j = 3 then o.promo_kind = 'stempel' and rd.slot = 3
       when j = 4 then o.promo_kind = 'stempel' and rd.slot = 7
       when j = 5 then o.promo_kind = 'ulang_tahun'
       when j = 6 then o.promo_kind = 'bogo'
       when j = 7 then o.promo_kind = 'stempel' and rd.slot = 10
       else o.promo_kind = 'kode' end);
    out_txt := out_txt || (array['Tebus murah 1 rupiah', 'Member baru 50%', 'Diskon 10%', 'Diskon 20%', 'Birthday treat',
      'BOGO Deals', 'Gratis stamp 10', 'Voucher Papaya'])[j] || ': ' || cnt || nl;
  end loop;

  out_txt := out_txt || nl || 'SAMPLE' || nl
    || 'Signature Choux: ' || public._stock_wa_n(ms) || nl
    || 'Mini Choux: ' || public._stock_wa_n(mm) || nl
    || nl || 'Waste (produk tidak sesuai standar/tidak terjual)' || nl
    || 'Signature Choux: ' || public._stock_wa_n(public._stock_wa_out(d, array['buang', 'rusak'], 'sig')) || nl
    || 'Mini Choux: ' || public._stock_wa_n(public._stock_wa_out(d, array['buang', 'rusak'], 'mini')) || nl
    || 'ALL BOX: ' || public._stock_wa_n(public._stock_wa_out(d, array['buang', 'rusak'], 'dus_besar')
        + public._stock_wa_out(d, array['buang', 'rusak'], 'dus_kecil')) || nl
    || 'FLA: ' || public._stock_wa_n(public._stock_wa_out(d, array['buang', 'rusak'], 'vla_vanilla')
        + public._stock_wa_out(d, array['buang', 'rusak'], 'vla_choco')
        + public._stock_wa_out(d, array['buang', 'rusak'], 'vla_matcha')) || nl
    || nl || 'Selisih Stok (stok awal - akhir, fla digramasi)' || nl;

  -- selisih: the day's latest accepted or waiting count; stok awal - akhir (positive = missing)
  select c.id into cnt from stock_counts c where c.day = d and c.status in ('diterima', 'menunggu') order by c.id desc limit 1;
  for j in 1 .. array_length(codes, 1) loop
    t := coalesce((select l.expected - l.counted from stock_count_lines l join stock_items i on i.id = l.item_id
     where l.count_id = cnt and i.code = codes[j]), 0);
    out_txt := out_txt || labels[j] || ': ' || public._stock_wa_n(t) || case when j < array_length(codes, 1) then nl else '' end;
  end loop;
  return out_txt;
end $$;

-- ---------------------------------------------------------------- Transaksi (owner, 12 Nov 2026)
-- Owner menu group Transaksi: purchase orders (our Permintaan barang), goods received against
-- them, every stock out, and stock adjustments. Screens: js/owner-transaksi.js.

-- Delete a supplier that was never used. A used one is only switched off (history stays).
create or replace function public.stock_supplier_delete(p_id bigint) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menghapus pemasok.');
  s stock_suppliers; n int;
begin
  select * into s from stock_suppliers where id = p_id for update;
  if s.id is null then raise exception 'Pemasok tidak ditemukan.'; end if;
  n := (select count(*) from stock_goods_in where supplier_id = s.id) + (select count(*) from stock_requests where supplier_id = s.id);
  if n > 0 then
    raise exception 'Pemasok ini sudah dipakai di % catatan barang masuk atau permintaan. Nonaktifkan saja.', n;
  end if;
  delete from stock_suppliers where id = s.id;
  perform public._log('stok_hapus_pemasok', jsonb_build_object('supplier', s.id, 'name', s.name));
  return json_build_object('id', s.id, 'name', s.name, 'deleted', true);
end $$;

-- Estimated price per unit on a purchase order line (optional, rupiah).
alter table public.stock_request_lines add column if not exists est_cost int check (est_cost >= 0);

-- A request as a purchase order: the request JSON plus the estimated price per line and in all.
create or replace function public._stock_po_json(p_id bigint) returns json
language sql stable security definer set search_path = public
as $$
  select (j.v - 'lines' || jsonb_build_object(
    'lines', coalesce((select jsonb_agg(l.e || jsonb_build_object('est_cost', rl.est_cost) order by l.n)
        from jsonb_array_elements(j.v -> 'lines') with ordinality as l(e, n)
        left join stock_request_lines rl on rl.request_id = p_id and rl.item_id = (l.e ->> 'item_id')::int), '[]'::jsonb),
    'est_total', (select sum(round(rl.est_cost * rl.qty))::int from stock_request_lines rl where rl.request_id = p_id and rl.est_cost is not null),
    'lines_count', (select count(*) from stock_request_lines where request_id = p_id)))::json
  from (select public._stock_request_json(p_id)::jsonb as v) j
$$;

create or replace function public._stock_po_lines(p_id bigint, p_lines jsonb) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare ln jsonb; i stock_items; q numeric; ec int; seen int[] := '{}';
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Isi minimal satu barang yang diminta.';
  end if;
  for ln in select * from jsonb_array_elements(p_lines) loop
    begin
      i := public._stock_item((ln ->> 'item')::int); q := public._stock_qty((ln ->> 'qty')::numeric);
      ec := nullif(ln ->> 'est_cost', '')::numeric::int;
    exception when invalid_text_representation then raise exception 'Angka tidak valid.';
    end;
    if ec is not null and (ec < 0 or ec > 100000000) then raise exception 'Harga perkiraan tidak masuk akal.'; end if;
    if not i.active then raise exception '% sedang tidak dipakai.', i.name; end if;
    if i.id = any (seen) then raise exception '% tertulis dua kali.', i.name; end if;
    seen := seen || i.id;
    insert into stock_request_lines (request_id, item_id, qty, stock_at, est_cost)
    values (p_id, i.id, q, public._stock_balance(i.id), ec)
    on conflict (request_id, item_id) do update set qty = excluded.qty, stock_at = excluded.stock_at, est_cost = excluded.est_cost;
  end loop;
end $$;

-- New purchase order (owner or manager). p_lines: [{item, qty, est_cost}]. A supplier is required.
create or replace function public.stock_po_create(p_supplier bigint, p_lines jsonb, p_needed_by date, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membuat purchase order.'); r json;
begin
  if p_supplier is null then raise exception 'Pilih pemasok.'; end if;
  r := public.stock_request_create(
    (select coalesce(jsonb_agg(jsonb_build_object('item', x ->> 'item', 'qty', x ->> 'qty')), '[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) x),
    p_needed_by, p_note, me, p_supplier);
  perform public._stock_po_lines((r ->> 'id')::bigint, p_lines);
  return public._stock_po_json((r ->> 'id')::bigint);
end $$;

-- Change a purchase order while nothing has arrived and it is still dikirim.
create or replace function public.stock_po_update(p_id bigint, p_supplier bigint, p_lines jsonb, p_needed_by date, p_note text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mengubah purchase order.');
  r stock_requests; sp stock_suppliers;
begin
  select * into r from stock_requests where id = p_id for update;
  if r.id is null then raise exception 'Purchase order tidak ditemukan.'; end if;
  if r.status <> 'dikirim' or exists (select 1 from stock_goods_in where request_id = r.id) then
    raise exception 'Purchase order % sudah %. Hanya yang masih dikirim dan belum ada barang masuk yang bisa diubah.', r.no, r.status;
  end if;
  if p_supplier is null then raise exception 'Pilih pemasok.'; end if;
  sp := public._stock_supplier(p_supplier);
  if p_needed_by is not null and p_needed_by < public._stock_today() then raise exception 'Tanggal dibutuhkan tidak boleh sebelum hari ini.'; end if;
  delete from stock_request_lines where request_id = r.id;
  perform public._stock_po_lines(r.id, p_lines);
  update stock_requests set supplier_id = sp.id, needed_by = p_needed_by, note = nullif(trim(coalesce(p_note, '')), '') where id = r.id;
  perform public._log('stok_ubah_po', jsonb_build_object('request', r.id, 'no', r.no, 'supplier', sp.name));
  return public._stock_po_json(r.id);
end $$;

create or replace function public.stock_po_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  return coalesce((select json_agg(public._stock_po_json(r.id) order by r.id desc) from stock_requests r where r.day between p_from and p_to), '[]');
end $$;

-- Receive several lines of an open purchase order at once (partial is fine).
-- p_lines: [{item, qty, cost}]; cost is the total paid for that line (optional).
create or replace function public.stock_po_receive(p_request bigint, p_lines jsonb, p_slip text, p_note text, p_responsible uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa mencatat penerimaan barang.');
  ln jsonb; n int := 0; c numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Isi jumlah yang diterima minimal untuk satu barang.'; end if;
  for ln in select * from jsonb_array_elements(p_lines) loop
    c := nullif(ln ->> 'cost', '')::numeric;
    perform public.stock_goods_in((ln ->> 'item')::int, (ln ->> 'qty')::numeric, p_note, p_slip, p_responsible, p_request, null,
      case when c is null then null else 'total' end, c);
    n := n + 1;
  end loop;
  perform public._log('stok_terima_po', jsonb_build_object('request', p_request, 'lines', n));
  return public._stock_po_json(p_request);
end $$;

-- Every stock out in a range: sold (per order), sampel, buang, rusak, promo. Newest first.
-- p_kind: null or 'semua' for all.
create or replace function public.stock_out_list(p_from date, p_to date, p_kind text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); k text := nullif(nullif(coalesce(p_kind, ''), ''), 'semua');
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  if k is not null and k not in ('penjualan', 'sampel', 'buang', 'rusak', 'promo') then raise exception 'Jenis barang keluar tidak dikenal.'; end if;
  return coalesce((select json_agg(x order by x.at desc, x.id desc) from (
    select m.id, m.created_at as at, m.day, m.item_id, i.name as item, i.unit, -m.qty as qty, m.kind, m.reason,
      case when m.kind in ('penjualan', 'batal_penjualan') then (select o.receipt_no from pos_orders o where o.id = m.order_id) end as receipt_no,
      (select public._first_name(full_name) from profiles where id = coalesce(m.responsible_id, m.created_by)) as responsible
    from stock_moves m join stock_items i on i.id = m.item_id
    where m.day between p_from and p_to and m.kind in ('penjualan', 'batal_penjualan', 'sampel', 'buang', 'rusak', 'promo')
      and (k is null or m.kind = k or (k = 'penjualan' and m.kind = 'batal_penjualan'))
      -- A cancelled barang keluar and its cancel row are both left out (14 Nov 2026).
      and m.reverses_id is null and not exists (select 1 from stock_moves x where x.reverses_id = m.id)
    order by m.created_at desc, m.id desc limit 3000) x), '[]');
end $$;

-- Correct an item's stock: p_mode 'set' = to a counted number, 'delta' = plus or minus. A reason is required.
create or replace function public.stock_adjust(p_item int, p_mode text, p_qty numeric, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa menyesuaikan stok.');
  i stock_items := public._stock_item(p_item); r text := nullif(trim(coalesce(p_reason, '')), '');
  before numeric := public._stock_balance(p_item); d numeric; mid bigint;
begin
  if r is null then raise exception 'Tulis alasan penyesuaiannya.'; end if;
  if p_mode is null or p_mode not in ('set', 'delta') then raise exception 'Pilih: ubah jadi jumlah tertentu atau tambah/kurangi.'; end if;
  if p_qty is null or abs(p_qty) > 1000000 or p_qty <> round(p_qty, 2) then raise exception 'Isi jumlah yang masuk akal (paling banyak 2 angka di belakang koma).'; end if;
  if p_mode = 'set' then
    if p_qty < 0 then raise exception 'Jumlah hitungan tidak boleh negatif.'; end if;
    d := p_qty - before;
  else d := p_qty; end if;
  if d = 0 then raise exception 'Stok sudah sama dengan jumlah itu.'; end if;
  if before + d < 0 then raise exception 'Stok tidak boleh jadi negatif (sekarang % %).', before, i.unit; end if;
  insert into stock_moves (item_id, kind, qty, day, reason, responsible_id, created_by)
  values (i.id, 'koreksi', d, public._stock_today(), 'Penyesuaian: ' || r, me, me) returning id into mid;
  perform public._log('stok_penyesuaian', jsonb_build_object('move', mid, 'item', i.name, 'dari', before, 'jadi', before + d, 'reason', r));
  return json_build_object('id', mid, 'item', i.name, 'unit', i.unit, 'before', before, 'after', before + d, 'delta', d);
end $$;

create or replace function public.stock_adjust_list(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  return coalesce((select json_agg(x order by x.at desc, x.id desc) from (
    select m.id, m.created_at as at, m.day, i.name as item, i.unit, m.qty as delta,
      regexp_replace(m.reason, '^Penyesuaian: ', '') as reason,
      (select public._first_name(full_name) from profiles where id = m.created_by) as by
    from stock_moves m join stock_items i on i.id = m.item_id
    where m.kind = 'koreksi' and m.reason like 'Penyesuaian: %' and m.day between p_from and p_to) x), '[]');
end $$;

-- ---------------------------------------------------------------- 14 Nov 2026 (Glenn): many items per goods in, cancel requests
-- Barang masuk with several items in one save (Glenn, 14 Nov 2026): Hanashuya's kitchen sends
-- a table with every item, other pemasok a list with "Tambah barang". p_lines:
--   [{ item: 3, qty: 40, cost_mode: 'total', cost: 120000 }]   (cost only from a manager or the owner)
-- Everything is saved in one go, or nothing when one line is wrong.
create or replace function public.stock_goods_in_batch(p_lines jsonb, p_note text, p_slip text, p_responsible uuid,
  p_request bigint default null, p_supplier bigint default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  ln jsonb; seen int[] := '{}'; it int; res jsonb := '[]';
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Isi jumlah minimal satu barang.';
  end if;
  if jsonb_array_length(p_lines) > 60 then raise exception 'Paling banyak 60 barang sekali catat.'; end if;
  for ln in select * from jsonb_array_elements(p_lines) loop
    begin it := (ln->>'item')::int;
    exception when invalid_text_representation then raise exception 'Barang tidak valid.'; end;
    if it is null then raise exception 'Pilih barangnya.'; end if;
    if it = any (seen) then
      raise exception '% tertulis dua kali. Gabungkan jumlahnya di satu baris.', (select name from stock_items where id = it);
    end if;
    seen := seen || it;
    res := res || jsonb_build_array(public.stock_goods_in(it, (ln->>'qty')::numeric, p_note, p_slip, p_responsible,
      p_request, p_supplier, nullif(ln->>'cost_mode', ''), nullif(ln->>'cost', '')::numeric)::jsonb);
  end loop;
  return res::json;
end $$;

-- Cancelling barang keluar (dibuang, rusak, promo): stock_moves can't be changed, so a cancel
-- is a second row of the same kind with the opposite amount that points at the first
-- (reverses_id). Totals per kind (reports, the harga pokok journals) net to zero; lists hide both.
alter table public.stock_moves add column if not exists reverses_id bigint references public.stock_moves (id);
create unique index if not exists stock_moves_one_reversal on public.stock_moves (reverses_id) where reverses_id is not null;

create or replace function public._stock_cancel_out(p_move bigint, p_reason text, p_by uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare m stock_moves; i stock_items; r text := nullif(trim(coalesce(p_reason, '')), ''); rid bigint;
begin
  if r is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  select * into m from stock_moves where id = p_move for update;
  if m.id is null or m.kind not in ('buang', 'rusak', 'promo') or m.reverses_id is not null then
    raise exception 'Catatan barang keluar tidak ditemukan.';
  end if;
  if exists (select 1 from stock_moves where reverses_id = m.id) then raise exception 'Catatan ini sudah dibatalkan.'; end if;
  select * into i from stock_items where id = m.item_id;
  insert into stock_moves (item_id, kind, qty, day, reason, responsible_id, created_by, reverses_id)
  values (m.item_id, m.kind, -m.qty, m.day, 'Batal barang keluar: ' || r, m.responsible_id, p_by, m.id) returning id into rid;
  perform public._log('stok_batal_keluar', jsonb_build_object('move', m.id, 'item', i.name, 'kind', m.kind, 'qty', -m.qty, 'reason', r));
  return json_build_object('id', m.id, 'item', i.name, 'unit', i.unit, 'kind', m.kind, 'qty', -m.qty, 'stock', public._stock_balance(m.item_id));
end $$;

create or replace function public.stock_cancel_out(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa membatalkan barang keluar.');
begin
  return public._stock_cancel_out(p_id, p_reason, me);
end $$;

-- Staff ask, a manager or the owner decides (Glenn, 14 Nov 2026), like voids on the till.
create table if not exists public.stock_cancel_requests (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('masuk', 'keluar')),
  goods_in_id bigint references public.stock_goods_in (id),
  move_id bigint references public.stock_moves (id),
  reason text not null,
  status text not null default 'menunggu' check (status in ('menunggu', 'disetujui', 'ditolak')),
  requested_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  check ((kind = 'masuk') = (goods_in_id is not null) and (kind = 'keluar') = (move_id is not null))
);
create unique index if not exists stock_cancel_one_open_in on public.stock_cancel_requests (goods_in_id) where status = 'menunggu';
create unique index if not exists stock_cancel_one_open_out on public.stock_cancel_requests (move_id) where status = 'menunggu';
alter table public.stock_cancel_requests enable row level security;
revoke all on public.stock_cancel_requests from anon, authenticated;

-- p_kind 'masuk' (p_id = goods in id) or 'keluar' (p_id = stock_moves id). Today's entries only;
-- older ones are cancelled from the owner page.
create or replace function public.stock_cancel_request(p_kind text, p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  r text := nullif(trim(coalesce(p_reason, '')), ''); g stock_goods_in; m stock_moves; rid bigint; d date := public._stock_today();
begin
  if r is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  if p_kind = 'masuk' then
    select * into g from stock_goods_in where id = p_id;
    if g.id is null then raise exception 'Catatan barang masuk tidak ditemukan.'; end if;
    if g.status = 'dibatalkan' then raise exception 'Catatan ini sudah dibatalkan.'; end if;
    if g.day <> d then raise exception 'Hanya barang masuk hari ini yang bisa diminta batal dari kasir.'; end if;
    if exists (select 1 from stock_cancel_requests where goods_in_id = g.id and status = 'menunggu') then
      raise exception 'Permintaan batal untuk catatan ini sudah menunggu.';
    end if;
    insert into stock_cancel_requests (kind, goods_in_id, reason, requested_by) values ('masuk', g.id, r, me) returning id into rid;
  elsif p_kind = 'keluar' then
    select * into m from stock_moves where id = p_id;
    if m.id is null or m.kind not in ('buang', 'rusak', 'promo') or m.reverses_id is not null then
      raise exception 'Catatan barang keluar tidak ditemukan.';
    end if;
    if exists (select 1 from stock_moves where reverses_id = m.id) then raise exception 'Catatan ini sudah dibatalkan.'; end if;
    if m.day <> d then raise exception 'Hanya barang keluar hari ini yang bisa diminta batal dari kasir.'; end if;
    if exists (select 1 from stock_cancel_requests where move_id = m.id and status = 'menunggu') then
      raise exception 'Permintaan batal untuk catatan ini sudah menunggu.';
    end if;
    insert into stock_cancel_requests (kind, move_id, reason, requested_by) values ('keluar', m.id, r, me) returning id into rid;
  else
    raise exception 'Jenis catatan tidak dikenal.';
  end if;
  perform public._log('stok_minta_batal', jsonb_build_object('request', rid, 'kind', p_kind, 'id', p_id, 'reason', r));
  return json_build_object('id', rid, 'status', 'menunggu');
end $$;

create or replace function public.stock_cancel_pending() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', c.id, 'kind', c.kind, 'reason', c.reason, 'at', c.created_at,
      'requested_by', (select public._first_name(full_name) from profiles where id = c.requested_by),
      'own', c.requested_by = me,
      'item', i.name, 'unit', i.unit,
      'qty', case when c.kind = 'masuk' then g.current_qty else -m.qty end,
      'out_kind', m.kind, 'supplier', (select s.name from stock_suppliers s where s.id = g.supplier_id),
      'entry_at', coalesce(g.created_at, m.created_at)) order by c.id)
    from stock_cancel_requests c
    left join stock_goods_in g on g.id = c.goods_in_id
    left join stock_moves m on m.id = c.move_id
    join stock_items i on i.id = coalesce(g.item_id, m.item_id)
    where c.status = 'menunggu'), '[]');
end $$;

-- A manager can't decide their own request (the owner does), as with voids and undo.
create or replace function public.stock_cancel_decide(p_id bigint, p_approve boolean, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer yang bisa memutuskan.');
  c stock_cancel_requests; who text;
begin
  select * into c from stock_cancel_requests where id = p_id and status = 'menunggu' for update;
  if c.id is null then raise exception 'Permintaan ini sudah diputuskan.'; end if;
  if c.requested_by = me and not exists (select 1 from profiles where id = me and role = 'owner') then
    raise exception 'Permintaan Anda sendiri diputuskan oleh pemilik.';
  end if;
  who := coalesce((select public._first_name(full_name) from profiles where id = c.requested_by), 'staf');
  if coalesce(p_approve, false) then
    if c.kind = 'masuk' then
      if (select status from stock_goods_in where id = c.goods_in_id) <> 'dibatalkan' then
        perform public.stock_cancel_goods_in(c.goods_in_id, 'Diminta ' || who || ': ' || c.reason);
      end if;
    elsif not exists (select 1 from stock_moves where reverses_id = c.move_id) then
      perform public._stock_cancel_out(c.move_id, 'Diminta ' || who || ': ' || c.reason, me);
    end if;
  end if;
  update stock_cancel_requests set status = case when p_approve then 'disetujui' else 'ditolak' end,
    decided_by = me, decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '') where id = c.id;
  perform public._log('stok_putus_batal', jsonb_build_object('request', c.id, 'approve', coalesce(p_approve, false)));
  return json_build_object('id', c.id, 'status', case when p_approve then 'disetujui' else 'ditolak' end);
end $$;

-- Closing reminder on the till home (Glenn, 14 Nov 2026): has today's stok opname been sent?
create or replace function public.stock_count_today() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg()); d date := public._stock_today();
begin
  return json_build_object('day', d,
    'sent', exists (select 1 from stock_counts where day = d and status in ('menunggu', 'diterima')),
    'closing', exists (select 1 from stock_counts where day = d and status in ('menunggu', 'diterima') and closing));
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and (p.proname like 'stock\_%' or p.proname like '\_stock\_%'
      or p.proname like 'owner\_stock\_%')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
