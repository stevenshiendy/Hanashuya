-- Pesanan di muka, deposit (DP) and koreksi stempel (owner back office "Transaksi", 12 Nov 2026,
-- modelled on VireoPOS Reservasi, Adjustment Deposito and Adjustment Poin).
--
-- NO DP (Glenn, 13 Nov 2026): Hanashuya doesn't take down payments. A pre-order is recorded and is
-- paid in full when it is picked up. pos_reservation_save refuses a dp, pos_deposit_add refuses
-- every call, and pickup no longer credits a balance. The deposit table, its reports and the
-- manager's Dikembalikan / Hangus / Koreksi stay so any older rows stay readable and can be
-- settled; nothing new is written to pos_deposits.
-- Run in the Supabase SQL Editor after akunting.sql (it also works without akunting.sql: then no
-- journals are posted). Safe to run again. Every write is logged in audit_log.
--
-- Pesanan di muka (pre-orders for a later pickup: arisan, office, events; SOP "Pesanan banyak")
--   pos_reservation_save(id, p)            new (id null) or change, while Baru or Dikonfirmasi
--   pos_reservation_list(from, to, status) by pickup day
--   pos_reservation_today()                for the till: today's and overdue open pre-orders
--   pos_reservation_get(id)                one, with items and the deposit ledger
--   pos_reservation_set_status(id, status, reason)   dikonfirmasi, siap, batal (reason), or back to dikonfirmasi
--   pos_reservation_checkout(id, order)    pickup: becomes a paid POS order with the DP credited
-- Deposit (DP): every rupiah paid ahead is a row in pos_deposits; the balance is their sum.
--   pos_deposit_add(id, amount, method, note)           DP masuk (staff)
--   pos_deposit_refund(id, amount, method, reason)      Dikembalikan (manager / owner)
--   pos_deposit_forfeit(id, reason)                     Hangus, for a cancelled pre-order (manager / owner)
--   pos_deposit_adjust(id, amount, reason)              Koreksi +/-, no money moves (manager / owner)
--   pos_deposit_moves(from, to, kind)                   report "Mutasi deposito"
--   pos_deposit_report(from, to)                        report "Deposit reservasi" (balance per pre-order)
--   acc_sync_deposits(from, to)                         re-posts the deposit journals (owner)
-- Koreksi stempel (instead of VireoPOS Adjustment Poin; points come later):
--   pos_member_search(q), pos_stamp_adjust(member, delta, reason), pos_stamp_adjust_cancel(id, reason),
--   pos_stamp_history(from, to, member)   "Riwayat stempel"
--
-- Money and the drawer: a Tunai DP is a kas masuk in the open shift; a Tunai refund is a kas keluar.
-- At pickup the order is a normal paid order for the full total. Because pos_orders allows one
-- payment method, a Tunai pickup records "received" = cash given + DP (so change = received - total
-- still holds) and a kas keluar of the DP in the same shift, so the drawer only grows by the cash
-- really given. These cash moves carry the pre-order's id in order_id, so acc_sync skips them and the
-- deposit journals below book them instead:
--   DP masuk     Dr Kas laci / Kas QRIS        Cr 2-1400 Uang muka pelanggan
--   Dipakai      Dr 2-1400                     Cr the pickup order's cash account (its journal debits the full total)
--   Dikembalikan Dr 2-1400                     Cr Kas laci / Kas QRIS
--   Hangus       Dr 2-1400                     Cr 4-1300 Pendapatan lain-lain
--   Koreksi +    Dr 6-9000 Beban lain-lain     Cr 2-1400;   Koreksi -  Dr 2-1400  Cr 4-1300
--
-- Koreksi stempel: stamps live in sales.stamps (sum of rows not reversed), which _total, _rewards,
-- _sync_cycles and the member's history read. A correction is a sales row with total 0, flag
-- 'koreksi_stempel' and stamps +n or -n, so every existing function counts it unchanged. The two
-- sales checks are widened for these rows only (schema.sql never re-adds them).

-- ---------------------------------------------------------------- tables
-- Links to orders, shifts, cash moves and sales let go (set null / cascade) so reset-after-testing.sql still runs.
create table if not exists public.pos_reservations (
  id uuid primary key default gen_random_uuid(),
  no text not null unique,
  status text not null default 'baru' check (status in ('baru', 'dikonfirmasi', 'siap', 'diambil', 'batal')),
  customer_name text not null check (length(trim(customer_name)) between 2 and 80),
  whatsapp text not null,
  member_id uuid references public.profiles (id) on delete set null,
  pickup_at timestamptz not null,
  pickup_day date not null,
  note text check (length(note) <= 300),
  free_bags int not null default 0 check (free_bags >= 0),
  subtotal int not null default 0 check (subtotal >= 0),
  total int not null default 0 check (total >= 0),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  ready_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancel_reason text,
  order_id uuid references public.pos_orders (id) on delete set null,
  picked_at timestamptz,
  picked_by uuid references public.profiles (id) on delete set null
);
create index if not exists pos_reservations_day on public.pos_reservations (pickup_day);
create unique index if not exists pos_reservations_order on public.pos_reservations (order_id) where order_id is not null;

create table if not exists public.pos_reservation_items (
  reservation_id uuid not null references public.pos_reservations (id) on delete cascade,
  line int not null,
  product_code text not null,
  name text not null,
  flavour_id text,
  flavour_label text,
  qty int not null check (qty > 0),
  unit_price int not null check (unit_price >= 0),
  line_total int not null check (line_total >= 0),
  primary key (reservation_id, line)
);

create table if not exists public.pos_reservation_counters (
  day date primary key,
  last int not null
);

-- The deposit ledger. amount is signed: dp +, pakai -, refund -, hangus -, koreksi +/-.
create table if not exists public.pos_deposits (
  id bigint generated always as identity primary key,
  reservation_id uuid not null references public.pos_reservations (id),
  kind text not null check (kind in ('dp', 'pakai', 'refund', 'hangus', 'koreksi')),
  amount int not null check (amount <> 0),
  method text check (method in ('tunai', 'qris')),
  note text check (length(note) <= 200),
  order_id uuid references public.pos_orders (id) on delete set null,
  shift_id bigint references public.pos_shifts (id) on delete set null,
  cash_move_id bigint references public.pos_cash_moves (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  day date not null default ((now() at time zone 'Asia/Jakarta')::date),
  check ((kind = 'dp' and amount > 0) or (kind in ('pakai', 'refund', 'hangus') and amount < 0) or kind = 'koreksi')
);
create index if not exists pos_deposits_res on public.pos_deposits (reservation_id);
create index if not exists pos_deposits_day on public.pos_deposits (day);

-- Koreksi stempel: one row per correction; the stamps themselves are the linked sales row.
create table if not exists public.stamp_adjustments (
  id bigint generated always as identity primary key,
  member_id uuid not null references public.profiles (id) on delete cascade,
  delta int not null check (delta <> 0 and delta between -50 and 50),
  reason text not null check (length(trim(reason)) between 3 and 200),
  sale_id bigint references public.sales (id) on delete cascade,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles (id) on delete set null,
  cancel_reason text
);
create index if not exists stamp_adjustments_member on public.stamp_adjustments (member_id, created_at);

-- A correction row has total 0 and may take stamps away. Only rows flagged koreksi_stempel.
alter table public.sales drop constraint if exists sales_total_check;
alter table public.sales add constraint sales_total_check check (total > 0 or (total = 0 and 'koreksi_stempel' = any (flags)));
alter table public.sales drop constraint if exists sales_stamps_check;
alter table public.sales add constraint sales_stamps_check check (stamps >= 0 or 'koreksi_stempel' = any (flags));

alter table public.pos_reservations enable row level security;
alter table public.pos_reservation_items enable row level security;
alter table public.pos_reservation_counters enable row level security;
alter table public.pos_deposits enable row level security;
alter table public.stamp_adjustments enable row level security;
revoke all on public.pos_reservations, public.pos_reservation_items, public.pos_reservation_counters,
  public.pos_deposits, public.stamp_adjustments from anon, authenticated;

-- The liability account for DP, when akunting.sql has been run.
do $$
begin
  if to_regclass('public.acc_accounts') is not null then
    insert into public.acc_accounts (code, name, type, normal, system)
    values ('2-1400', 'Uang muka pelanggan (DP pesanan)', 'kewajiban', 'kredit', true)
    on conflict (code) do nothing;
  end if;
end $$;

-- ---------------------------------------------------------------- helpers
create or replace function public._rsv_mgr_msg() returns text
language sql immutable as $$ select 'Hanya manajer atau pemilik yang bisa melakukan ini.'::text $$;

create or replace function public._rsv_balance(p_id uuid) returns int
language sql stable security definer set search_path = public
as $$ select coalesce(sum(amount), 0)::int from pos_deposits where reservation_id = p_id $$;

create or replace function public._rsv_label(k text) returns text
language sql immutable
as $$ select case k when 'dp' then 'DP masuk' when 'pakai' then 'Dipakai' when 'refund' then 'Dikembalikan'
                    when 'hangus' then 'Hangus' when 'koreksi' then 'Koreksi' else k end $$;

-- Prices the items with the till's own maths (_pos_price, no promo) and writes them.
create or replace function public._rsv_write_items(p_id uuid, p_items jsonb, p_bags int) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare q jsonb; ln jsonb;
begin
  q := public._pos_price(jsonb_build_object('channel', 'toko', 'items', coalesce(p_items, '[]'), 'free_bags', coalesce(p_bags, 0)), null);
  delete from pos_reservation_items where reservation_id = p_id;
  for ln in select * from jsonb_array_elements(q->'lines') loop
    continue when (ln->>'free_bag')::boolean;
    insert into pos_reservation_items (reservation_id, line, product_code, name, flavour_id, flavour_label, qty, unit_price, line_total)
    values (p_id, (ln->>'line')::int, ln->>'code', ln->>'name', ln->>'flavour', ln->>'flavour_label', (ln->>'qty')::int,
            (ln->>'unit_price')::int, (ln->>'line_total')::int);
  end loop;
  update pos_reservations set subtotal = (q->>'subtotal')::int, total = (q->>'total')::int, free_bags = coalesce(p_bags, 0), updated_at = now()
   where id = p_id;
end $$;

-- Posts (or corrects) the journal of one deposit row. Does nothing without akunting.sql.
create or replace function public._rsv_book(p_dep bigint) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare d pos_deposits; r pos_reservations; cash text; lines jsonb; a int; ordm text;
begin
  if to_regproc('public._acc_restate') is null or not exists (select 1 from acc_accounts where code = '2-1400') then return; end if;
  select * into d from pos_deposits where id = p_dep;
  if d.id is null then return; end if;
  select * into r from pos_reservations where id = d.reservation_id;
  a := abs(d.amount);
  cash := case d.method when 'tunai' then '1-1100' when 'qris' then '1-1200' end;
  if d.kind = 'pakai' then
    select payment_method into ordm from pos_orders where id = d.order_id;
    cash := case ordm when 'tunai' then '1-1100' when 'qris' then '1-1200' when 'platform' then '1-1400' end;
  end if;
  lines := case
    when d.kind = 'dp' and cash is not null then jsonb_build_array(jsonb_build_object('code', cash, 'debit', a, 'memo', r.no),
      jsonb_build_object('code', '2-1400', 'credit', a, 'memo', r.customer_name))
    when d.kind in ('pakai', 'refund') and cash is not null then jsonb_build_array(jsonb_build_object('code', '2-1400', 'debit', a, 'memo', r.customer_name),
      jsonb_build_object('code', cash, 'credit', a, 'memo', r.no))
    when d.kind = 'hangus' or (d.kind = 'koreksi' and d.amount < 0) then jsonb_build_array(jsonb_build_object('code', '2-1400', 'debit', a, 'memo', r.customer_name),
      jsonb_build_object('code', '4-1300', 'credit', a, 'memo', coalesce(d.note, r.no)))
    when d.kind = 'koreksi' then jsonb_build_array(jsonb_build_object('code', '6-9000', 'debit', a, 'memo', coalesce(d.note, r.no)),
      jsonb_build_object('code', '2-1400', 'credit', a, 'memo', r.customer_name))
  end;
  perform public._acc_restate('kas', 'uangmuka:' || d.id, d.day,
    public._rsv_label(d.kind) || ' ' || r.no || ' (' || r.customer_name || ')', lines);
end $$;

-- One deposit row, with the drawer side for Tunai. Returns the row id.
create or replace function public._rsv_deposit(p_res pos_reservations, p_kind text, p_amount int, p_method text, p_note text,
  p_order uuid default null, p_shift bigint default null) returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := auth.uid(); sid bigint := p_shift; cm bigint; did bigint; nt text := nullif(trim(coalesce(p_note, '')), '');
begin
  if p_method = 'tunai' and p_kind in ('dp', 'refund', 'pakai') then
    if sid is null then sid := public._pos_open_shift_id(me); end if;
    insert into pos_cash_moves (shift_id, kind, amount, reason, order_id, created_by)
    values (sid, case when p_kind = 'dp' then 'masuk' else 'keluar' end, abs(p_amount),
      left(case p_kind when 'dp' then 'DP ' || p_res.no || ' a.n. ' || p_res.customer_name
                       when 'refund' then 'DP dikembalikan ' || p_res.no || ' a.n. ' || p_res.customer_name
                       else 'DP ' || p_res.no || ' sudah tercatat, dipakai di ' || coalesce((select receipt_no from pos_orders where id = p_order), 'pesanan') end, 200),
      p_res.id, me)
    returning id into cm;
  end if;
  insert into pos_deposits (reservation_id, kind, amount, method, note, order_id, shift_id, cash_move_id, created_by, day)
  values (p_res.id, p_kind, p_amount, p_method, nt, p_order, sid, cm, me, public._local(now())::date)
  returning id into did;
  perform public._rsv_book(did);
  return did;
end $$;

-- The member's card code only for the owner (14 Nov 2026), as in pos_member_search; staff and
-- managers see the name.
create or replace function public._rsv_json(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare r pos_reservations; bal int;
  is_owner boolean := exists (select 1 from profiles where id = auth.uid() and role = 'owner' and deleted_at is null);
begin
  select * into r from pos_reservations where id = p_id;
  if r.id is null then return null; end if;
  bal := public._rsv_balance(r.id);
  return json_build_object('id', r.id, 'no', r.no, 'status', r.status, 'customer_name', r.customer_name, 'whatsapp', r.whatsapp,
    'member_id', r.member_id, 'member', (select json_build_object('id', p.id, 'name', p.full_name, 'card_code', case when is_owner then p.card_code end) from profiles p where p.id = r.member_id),
    'pickup_at', r.pickup_at, 'pickup_day', r.pickup_day, 'pickup_time', to_char(public._local(r.pickup_at), 'HH24:MI'),
    'note', r.note, 'free_bags', r.free_bags, 'subtotal', r.subtotal, 'total', r.total,
    -- deposit: an older DP balance (none since 13 Nov 2026); over: what is still to give back. due: the whole total.
    'deposit', bal, 'due', case when r.status in ('diambil', 'batal') then 0 else r.total end, 'over', greatest(0, bal),
    'dp_paid', coalesce((select sum(amount) from pos_deposits where reservation_id = r.id and kind = 'dp'), 0),
    'created_at', r.created_at, 'created_by', (select public._first_name(full_name) from profiles where id = r.created_by),
    'confirmed_at', r.confirmed_at, 'ready_at', r.ready_at, 'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
    'order_id', r.order_id, 'receipt_no', (select receipt_no from pos_orders where id = r.order_id), 'picked_at', r.picked_at,
    'items', coalesce((select json_agg(json_build_object('line', i.line, 'product', i.product_code, 'name', i.name, 'flavour', i.flavour_id,
        'flavour_label', i.flavour_label, 'qty', i.qty, 'unit_price', i.unit_price, 'line_total', i.line_total) order by i.line)
        from pos_reservation_items i where i.reservation_id = r.id), '[]'),
    'deposits', coalesce((select json_agg(json_build_object('id', d.id, 'kind', d.kind, 'label', public._rsv_label(d.kind), 'amount', d.amount,
        'method', d.method, 'note', d.note, 'at', d.created_at, 'by', (select public._first_name(full_name) from profiles where id = d.created_by),
        'receipt_no', (select receipt_no from pos_orders where id = d.order_id)) order by d.id)
        from pos_deposits d where d.reservation_id = r.id), '[]'));
end $$;

-- Rows for lists: no items detail, a short text of them instead.
create or replace function public._rsv_row(r pos_reservations) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', r.id, 'no', r.no, 'status', r.status, 'customer_name', r.customer_name, 'whatsapp', r.whatsapp,
    'member', (select p.full_name from profiles p where p.id = r.member_id),
    'pickup_at', r.pickup_at, 'pickup_day', r.pickup_day, 'pickup_time', to_char(public._local(r.pickup_at), 'HH24:MI'),
    'total', r.total, 'deposit', public._rsv_balance(r.id), 'due', case when r.status in ('diambil', 'batal') then 0 else r.total end,
    'items_text', (select string_agg(i.qty || ' ' || i.name || coalesce(' ' || i.flavour_label, ''), ', ' order by i.line)
                     from pos_reservation_items i where i.reservation_id = r.id),
    'boxes', (select coalesce(sum(i.qty), 0) from pos_reservation_items i where i.reservation_id = r.id),
    'note', r.note, 'receipt_no', (select receipt_no from pos_orders where id = r.order_id), 'cancel_reason', r.cancel_reason)
$$;

create or replace function public._rsv_range(p_from date, p_to date) returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
end $$;

-- ---------------------------------------------------------------- pesanan di muka
-- p: {customer_name, whatsapp, member_id, pickup_day 'YYYY-MM-DD', pickup_time 'HH:MM', items [{product, flavour, qty}],
--     free_bags, note}. A dp is refused (no DP since 13 Nov 2026).
create or replace function public.pos_reservation_save(p_id uuid, p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  r pos_reservations; nm text := trim(coalesce(p->>'customer_name', '')); wa text := public._wa(p->>'whatsapp');
  mem uuid; d date; tm time; at timestamptz; nt text := nullif(trim(coalesce(p->>'note', '')), ''); bags int;
  today date := public._local(now())::date; seq int; rid uuid; dpa int; dpm text;
begin
  -- No DP (Glenn, 13 Nov 2026): refused before anything is saved.
  if jsonb_typeof(p->'dp') = 'object' and coalesce(nullif(p#>>'{dp,amount}', ''), '0') <> '0' then
    raise exception 'Hanashuya tidak menerima DP. Pesanan di muka dibayar penuh saat diambil.';
  end if;
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Isi nama pemesan (2 sampai 80 huruf).'; end if;
  if wa is null or length(wa) < 10 or length(wa) > 15 then raise exception 'Isi nomor WhatsApp pemesan yang benar.'; end if;
  begin d := (p->>'pickup_day')::date; exception when others then d := null; end;
  begin tm := (p->>'pickup_time')::time; exception when others then tm := null; end;
  if d is null then raise exception 'Pilih tanggal ambil.'; end if;
  if tm is null then raise exception 'Isi jam ambil.'; end if;
  if d > today + 120 then raise exception 'Tanggal ambil paling lama 120 hari dari sekarang.'; end if;
  at := (d + tm) at time zone (select tz from settings where id = 1);
  if nt is not null and length(nt) > 300 then raise exception 'Catatan terlalu panjang (paling panjang 300 huruf).'; end if;
  begin bags := coalesce(nullif(p->>'free_bags', '')::int, 0); exception when others then bags := -1; end;
  if bags < 0 then raise exception 'Jumlah paper bag gratis tidak valid.'; end if;
  begin mem := nullif(p->>'member_id', '')::uuid; exception when others then mem := null; end;
  if mem is not null and not exists (select 1 from profiles where id = mem and role = 'member' and deleted_at is null) then
    raise exception 'Member tidak ditemukan.';
  end if;

  if p_id is null then
    if d < today then raise exception 'Tanggal ambil sudah lewat.'; end if;
    insert into pos_reservation_counters (day, last) values (today, 1)
    on conflict (day) do update set last = pos_reservation_counters.last + 1 returning last into seq;
    insert into pos_reservations (no, customer_name, whatsapp, member_id, pickup_at, pickup_day, note, created_by)
    values ('PM-' || to_char(today, 'YYMMDD') || '-' || lpad(seq::text, 2, '0'), nm, wa, mem, at, d, nt, me)
    returning id into rid;
    perform public._rsv_write_items(rid, p->'items', bags);
    select * into r from pos_reservations where id = rid;
    perform public._log('pesanan_di_muka_baru', jsonb_build_object('reservasi', r.id, 'no', r.no, 'total', r.total, 'ambil', at));
    return public._rsv_json(rid);
  end if;

  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if r.status not in ('baru', 'dikonfirmasi') then
    raise exception 'Pesanan % sudah %, jadi isinya tidak bisa diubah lagi.', r.no,
      case r.status when 'siap' then 'siap' when 'diambil' then 'diambil' else 'dibatalkan' end;
  end if;
  update pos_reservations set customer_name = nm, whatsapp = wa, member_id = mem, pickup_at = at, pickup_day = d, note = nt, updated_at = now()
   where id = r.id;
  perform public._rsv_write_items(r.id, p->'items', bags);
  perform public._log('pesanan_di_muka_ubah', jsonb_build_object('reservasi', r.id, 'no', r.no,
    'total', (select total from pos_reservations where id = r.id), 'ambil', at));
  return public._rsv_json(r.id);
end $$;

create or replace function public.pos_reservation_list(p_from date, p_to date, p_status text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); st text := nullif(p_status, '');
begin
  perform public._rsv_range(p_from, p_to);
  if st is not null and st not in ('baru', 'dikonfirmasi', 'siap', 'diambil', 'batal', 'aktif') then raise exception 'Status tidak dikenal.'; end if;
  return coalesce((select json_agg(public._rsv_row(r) order by r.pickup_at, r.no) from pos_reservations r
    where r.pickup_day between p_from and p_to
      and (st is null or r.status = st or (st = 'aktif' and r.status in ('baru', 'dikonfirmasi', 'siap')))), '[]');
end $$;

-- The till: open pre-orders for today, and older ones that were never picked up.
create or replace function public.pos_reservation_today() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); today date := public._local(now())::date;
begin
  return coalesce((select json_agg(public._rsv_row(r) order by r.pickup_at) from pos_reservations r
    where r.status in ('baru', 'dikonfirmasi', 'siap') and r.pickup_day <= today), '[]');
end $$;

create or replace function public.pos_reservation_get(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); j json;
begin
  j := public._rsv_json(p_id);
  if j is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  return j;
end $$;

-- Baru -> Dikonfirmasi -> Siap; Siap can go back to Dikonfirmasi; any open one can be cancelled
-- with a reason. A DP on a cancelled pre-order stays as a balance until a manager or the owner
-- records it as Dikembalikan or Hangus.
create or replace function public.pos_reservation_set_status(p_id uuid, p_status text, p_reason text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); r pos_reservations; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if r.status in ('diambil', 'batal') then
    raise exception 'Pesanan % sudah %.', r.no, case r.status when 'diambil' then 'diambil' else 'dibatalkan' end;
  end if;
  if p_status = 'dikonfirmasi' then
    if r.status = 'dikonfirmasi' then raise exception 'Pesanan ini sudah dikonfirmasi.'; end if;
    update pos_reservations set status = 'dikonfirmasi', confirmed_at = coalesce(confirmed_at, now()), ready_at = null, updated_at = now() where id = r.id;
  elsif p_status = 'siap' then
    if r.status = 'siap' then raise exception 'Pesanan ini sudah ditandai siap.'; end if;
    update pos_reservations set status = 'siap', confirmed_at = coalesce(confirmed_at, now()), ready_at = now(), updated_at = now() where id = r.id;
  elsif p_status = 'batal' then
    if why is null then raise exception 'Tulis alasan pembatalannya.'; end if;
    if length(why) > 200 then raise exception 'Alasan terlalu panjang (paling panjang 200 huruf).'; end if;
    update pos_reservations set status = 'batal', cancelled_at = now(), cancelled_by = me, cancel_reason = why, updated_at = now() where id = r.id;
  else
    raise exception 'Status tidak dikenal.';
  end if;
  perform public._log('pesanan_di_muka_status', jsonb_build_object('reservasi', r.id, 'no', r.no, 'dari', r.status, 'jadi', p_status, 'alasan', why));
  return public._rsv_json(r.id);
end $$;

-- Pickup at the till. p_order: {id (made on the tablet), served_by, payment: {method 'tunai'|'qris'|'campur', cash, tunai, qris, ref},
-- client_at}. The whole total is paid now (no DP since 13 Nov 2026; an older DP balance is not used here and
-- stays for a manager to give back). The pre-order's items are priced again with today's prices (flag
-- harga_pesanan_beda when the total changed); its note becomes the order note. A linked member gets the stamps.
create or replace function public.pos_reservation_checkout(p_id uuid, p_order jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  r pos_reservations; oid uuid; o pos_orders; bal int; use int; due int; method text := coalesce(p_order#>>'{payment,method}', '');
  given int; tk uuid; ord jsonb; pay jsonb; f text[] := array['pesanan_di_muka'];
begin
  begin oid := (p_order->>'id')::uuid; exception when others then oid := null; end;
  if oid is null then raise exception 'Pesanan tanpa nomor. Muat ulang halaman kasir.'; end if;
  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if r.order_id is not null then
    if r.order_id = oid then
      return (public._pos_receipt(oid)::jsonb || jsonb_build_object('repeat', true, 'reservation', public._rsv_json(r.id)))::json;
    end if;
    raise exception 'Pesanan % sudah diambil (struk %).', r.no, (select receipt_no from pos_orders where id = r.order_id);
  end if;
  if r.status = 'batal' then raise exception 'Pesanan % sudah dibatalkan.', r.no; end if;
  if exists (select 1 from pos_orders where id = oid) then raise exception 'Nomor pesanan ini sudah dipakai.'; end if;

  if r.member_id is not null then
    -- The same path as a card found by its WhatsApp number (flag nomor_dicari for the owner).
    insert into scan_tickets (staff_id, member_id, via, expires_at) values (staff, r.member_id, 'nomor', now() + interval '10 minutes')
    returning id into tk;
  end if;
  ord := jsonb_build_object('id', oid, 'channel', 'toko', 'served_by', p_order->>'served_by', 'free_bags', r.free_bags,
    'note', left(r.note, 200),
    'ticket', tk, 'items', coalesce((select jsonb_agg(jsonb_build_object('product', i.product_code, 'flavour', i.flavour_id, 'qty', i.qty) order by i.line)
      from pos_reservation_items i where i.reservation_id = r.id), '[]'));
  oid := public._pos_create(staff, ord);
  select * into o from pos_orders where id = oid;

  -- Paid in full now (no DP, 13 Nov 2026).
  use := 0; due := o.total;
  if method = 'tunai' then
    begin given := coalesce(nullif(p_order#>>'{payment,cash}', '')::int, 0); exception when others then given := null; end;
    if given is null or (due > 0 and given < due) then raise exception 'Uang diterima kurang dari total %.', public._rp(due); end if;
    pay := jsonb_build_object('method', 'tunai', 'cash', given);
  elsif method = 'qris' then
    pay := jsonb_build_object('method', 'qris', 'ref', p_order#>>'{payment,ref}');
  elsif method = 'campur' then
    pay := p_order->'payment';
  elsif due = 0 then
    pay := '{}';
  else
    raise exception 'Pilih Tunai atau QRIS.';
  end if;
  perform public._pos_settle(staff, oid, pay, p_order->>'client_at');
  select * into o from pos_orders where id = oid;
  if o.total <> r.total then f := f || array['harga_pesanan_beda']; end if;
  update pos_orders set flags = flags || f where id = oid;
  update pos_reservations set status = 'diambil', order_id = oid, picked_at = now(), picked_by = staff, updated_at = now() where id = r.id;
  perform public._log('pesanan_di_muka_diambil', jsonb_build_object('reservasi', r.id, 'no', r.no, 'order', oid, 'receipt', o.receipt_no,
    'total', o.total, 'total_pesanan', r.total));
  return (public._pos_receipt(oid)::jsonb || jsonb_build_object('reservation', public._rsv_json(r.id),
    'due', due, 'cash_given', case when o.payment_method = 'tunai' then given end))::json;
end $$;

-- ---------------------------------------------------------------- deposit
create or replace function public.pos_deposit_add(p_id uuid, p_amount int, p_method text, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg()); r pos_reservations; bal int;
begin
  -- No DP (Glenn, 13 Nov 2026).
  raise exception 'Hanashuya tidak menerima DP. Pesanan di muka dibayar penuh saat diambil.';
  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if r.status in ('diambil', 'batal') then raise exception 'Pesanan % sudah %, jadi tidak bisa menerima DP.', r.no, case r.status when 'diambil' then 'diambil' else 'dibatalkan' end; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Isi jumlah DP.'; end if;
  if p_method not in ('tunai', 'qris') then raise exception 'Pilih DP lewat Tunai atau QRIS.'; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'Catatan terlalu panjang (paling panjang 200 huruf).'; end if;
  bal := public._rsv_balance(r.id);
  if bal + p_amount > r.total then raise exception 'DP melebihi total pesanan. Sisa yang bisa dibayar %.', public._rp(greatest(0, r.total - bal)); end if;
  perform public._rsv_deposit(r, 'dp', p_amount, p_method, p_note);
  perform public._log('deposit_dp', jsonb_build_object('reservasi', r.id, 'no', r.no, 'jumlah', p_amount, 'metode', p_method));
  return public._rsv_json(r.id);
end $$;

create or replace function public.pos_deposit_refund(p_id uuid, p_amount int, p_method text, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Pengembalian DP hanya bisa dilakukan manajer atau pemilik.');
  r pos_reservations; bal int; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if why is null then raise exception 'Tulis alasan pengembaliannya.'; end if;
  if length(why) > 200 then raise exception 'Alasan terlalu panjang (paling panjang 200 huruf).'; end if;
  if p_method not in ('tunai', 'qris') then raise exception 'Pilih dikembalikan lewat Tunai atau QRIS.'; end if;
  bal := public._rsv_balance(r.id);
  if bal <= 0 then raise exception 'Pesanan ini tidak punya sisa DP.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Isi jumlah yang dikembalikan.'; end if;
  if p_amount > bal then raise exception 'Sisa DP hanya %.', public._rp(bal); end if;
  if r.status in ('baru', 'dikonfirmasi', 'siap') and p_amount = bal and bal > 0 then
    -- Allowed: a customer who wants the DP back but keeps the order (pays everything at pickup).
    null;
  end if;
  perform public._rsv_deposit(r, 'refund', -p_amount, p_method, why);
  perform public._log('deposit_refund', jsonb_build_object('reservasi', r.id, 'no', r.no, 'jumlah', p_amount, 'metode', p_method, 'alasan', why));
  return public._rsv_json(r.id);
end $$;

create or replace function public.pos_deposit_forfeit(p_id uuid, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], public._rsv_mgr_msg());
  r pos_reservations; bal int; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if r.status <> 'batal' then raise exception 'DP hanya bisa dinyatakan hangus untuk pesanan yang dibatalkan.'; end if;
  if why is null then raise exception 'Tulis alasannya.'; end if;
  if length(why) > 200 then raise exception 'Alasan terlalu panjang (paling panjang 200 huruf).'; end if;
  bal := public._rsv_balance(r.id);
  if bal <= 0 then raise exception 'Pesanan ini tidak punya sisa DP.'; end if;
  perform public._rsv_deposit(r, 'hangus', -bal, null, why);
  perform public._log('deposit_hangus', jsonb_build_object('reservasi', r.id, 'no', r.no, 'jumlah', bal, 'alasan', why));
  return public._rsv_json(r.id);
end $$;

-- Adjustment deposito: a correction of the balance with a reason; no money moves.
create or replace function public.pos_deposit_adjust(p_id uuid, p_amount int, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], public._rsv_mgr_msg());
  r pos_reservations; bal int; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into r from pos_reservations where id = p_id for update;
  if r.id is null then raise exception 'Pesanan di muka tidak ditemukan.'; end if;
  if why is null then raise exception 'Tulis alasan koreksinya.'; end if;
  if length(why) > 200 then raise exception 'Alasan terlalu panjang (paling panjang 200 huruf).'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Isi jumlah koreksi, plus untuk menambah atau minus untuk mengurangi.'; end if;
  bal := public._rsv_balance(r.id);
  if bal + p_amount < 0 then raise exception 'Saldo DP tidak bisa di bawah nol (sekarang %).', public._rp(bal); end if;
  if r.status <> 'batal' and r.status <> 'diambil' and bal + p_amount > r.total then
    raise exception 'Saldo DP tidak bisa melebihi total pesanan %.', public._rp(r.total);
  end if;
  perform public._rsv_deposit(r, 'koreksi', p_amount, null, why);
  perform public._log('deposit_koreksi', jsonb_build_object('reservasi', r.id, 'no', r.no, 'jumlah', p_amount, 'alasan', why));
  return public._rsv_json(r.id);
end $$;

-- Mutasi deposito: every deposit row in the period.
create or replace function public.pos_deposit_moves(p_from date, p_to date, p_kind text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], public._rsv_mgr_msg()); k text := nullif(p_kind, '');
begin
  perform public._rsv_range(p_from, p_to);
  return coalesce((select json_agg(x order by x.id desc) from (
    select d.id, d.day, d.created_at as at, d.kind, public._rsv_label(d.kind) as label, d.amount, d.method, d.note,
      r.id as reservation_id, r.no, r.customer_name, r.status,
      (select receipt_no from pos_orders where id = d.order_id) as receipt_no,
      (select public._first_name(full_name) from profiles where id = d.created_by) as by,
      (select sum(x.amount) from pos_deposits x where x.reservation_id = d.reservation_id and x.id <= d.id)::int as balance_after
    from pos_deposits d join pos_reservations r on r.id = d.reservation_id
    where d.day between p_from and p_to and (k is null or d.kind = k)) x), '[]');
end $$;

-- Deposit reservasi: per pre-order picked up, made or moved in the period, its DP totals and balance now.
create or replace function public.pos_deposit_report(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], public._rsv_mgr_msg());
begin
  perform public._rsv_range(p_from, p_to);
  return json_build_object(
    'rows', coalesce((select json_agg(x order by x.pickup_at desc) from (
      select r.id, r.no, r.status, r.customer_name, r.pickup_at, r.pickup_day, r.total,
        coalesce(sum(d.amount) filter (where d.kind = 'dp'), 0)::int as dp,
        coalesce(-sum(d.amount) filter (where d.kind = 'pakai'), 0)::int as used,
        coalesce(-sum(d.amount) filter (where d.kind = 'refund'), 0)::int as refunded,
        coalesce(-sum(d.amount) filter (where d.kind = 'hangus'), 0)::int as forfeited,
        coalesce(sum(d.amount) filter (where d.kind = 'koreksi'), 0)::int as adjusted,
        coalesce(sum(d.amount), 0)::int as balance,
        (select receipt_no from pos_orders where id = r.order_id) as receipt_no
      from pos_reservations r left join pos_deposits d on d.reservation_id = r.id
      where r.pickup_day between p_from and p_to or (public._local(r.created_at))::date between p_from and p_to
         or exists (select 1 from pos_deposits y where y.reservation_id = r.id and y.day between p_from and p_to)
      group by r.id) x), '[]'),
    -- What the business holds for customers right now (all pre-orders, not only this period).
    'held_now', (select coalesce(sum(amount), 0)::int from pos_deposits),
    'to_return', (select coalesce(sum(b), 0)::int from (select r.id, sum(d.amount) as b from pos_reservations r join pos_deposits d on d.reservation_id = r.id
                    where r.status in ('batal', 'diambil') group by r.id having sum(d.amount) > 0) z));
end $$;

-- Re-post the deposit journals (for example after akunting.sql was run later). Owner only, like acc_sync.
create or replace function public.acc_sync_deposits(p_from date default null, p_to date default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); d record; n int := 0;
begin
  if to_regproc('public._acc_restate') is null then raise exception 'Akunting belum dipasang. Jalankan akunting.sql dulu.'; end if;
  insert into acc_accounts (code, name, type, normal, system) values ('2-1400', 'Uang muka pelanggan (DP pesanan)', 'kewajiban', 'kredit', true)
  on conflict (code) do nothing;
  for d in select id from pos_deposits where day between coalesce(p_from, date '2000-01-01') and coalesce(p_to, public._local(now())::date) order by id loop
    perform public._rsv_book(d.id); n := n + 1;
  end loop;
  return json_build_object('rows', n);
end $$;

-- ---------------------------------------------------------------- koreksi stempel
-- Members by name (at least 4 letters), the whole card code or the whole WhatsApp number.
-- Security review, 13 Nov 2026: staff and managers get the number masked (0857••••1234)
-- and no card code, so the search can't be used to collect members' numbers; the owner
-- sees both in full. Keys stay the same (id, name, whatsapp, card_code, stamps, position, cycle).
create or replace function public.pos_member_search(p_q text) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  q text := lower(trim(coalesce(p_q, ''))); digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  wa text := public._wa(digits); code text := upper(regexp_replace(coalesce(p_q, ''), '[^A-Za-z0-9]', '', 'g'));
  is_owner boolean := exists (select 1 from profiles where id = me and role = 'owner');
  by_name boolean := length(regexp_replace(q, '[^[:alpha:]]', '', 'g')) >= 4 and digits = '';
  by_wa boolean := wa ~ '^628[0-9]{8,12}$';
  by_code boolean := length(code) = 8;
begin
  if not (by_name or by_wa or by_code) then return '[]'; end if;
  return coalesce((select json_agg(x) from (
    select p.id, p.full_name as name,
           case when is_owner then p.whatsapp
                when p.whatsapp is null then null
                else '0' || substr(p.whatsapp, 3, 3) || '••••' || right(p.whatsapp, 4) end as whatsapp,
           case when is_owner then p.card_code end as card_code,
           public._total(p.id) as stamps, cv.card_position as position, cv.cycle
      from profiles p cross join lateral public._card_view(p.id) cv
     where p.role in ('member', 'staff', 'manager') and p.deleted_at is null
       and ((by_name and lower(coalesce(p.full_name, '')) like '%' || q || '%')
            or (by_code and replace(upper(coalesce(p.card_code, '')), '-', '') = code)
            or (by_wa and p.whatsapp = wa))
     order by p.full_name limit 10) x), '[]');
end $$;

-- The lowest stamp total a member may have: every card reward already used stays earned.
create or replace function public._stamp_floor(p uuid) returns int
language sql stable security definer set search_path = public
as $$
  select coalesce(max(d.cycle * (select card_size from settings where id = 1) + d.slot), 0)::int
    from redemptions d where d.member_id = p and d.kind = 'stempel' and d.reversed_at is null
$$;

create or replace function public._stamp_write(p_member uuid, p_delta int, p_reason text) returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare sid bigint; now_total int := public._total(p_member); fl int := public._stamp_floor(p_member);
begin
  if now_total + p_delta < 0 then raise exception 'Stempel tidak bisa di bawah nol (sekarang %).', now_total; end if;
  if now_total + p_delta < fl then
    raise exception 'Stempel tidak bisa dikurangi sampai %: % stempel sudah dipakai untuk hadiah kartu.', now_total + p_delta, fl;
  end if;
  insert into sales (receipt_no, sale_day, total, member_id, staff_id, stamps, items, via, flags)
  values (null, public._local(now())::date, 0, p_member, auth.uid(), p_delta, '[]', null, array['koreksi_stempel'])
  returning id into sid;
  perform public._sync_cycles(p_member);
  return sid;
end $$;

create or replace function public.pos_stamp_adjust(p_member uuid, p_delta int, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Koreksi stempel hanya bisa dilakukan manajer atau pemilik.');
  m profiles; why text := nullif(trim(coalesce(p_reason, '')), ''); sid bigint; aid bigint; cv record;
begin
  select * into m from profiles where id = p_member and role = 'member' and deleted_at is null;
  if m.id is null then raise exception 'Member tidak ditemukan.'; end if;
  if p_delta is null or p_delta = 0 then raise exception 'Isi jumlah stempel, plus untuk menambah atau minus untuk mengurangi.'; end if;
  if abs(p_delta) > 50 then raise exception 'Koreksi paling banyak 50 stempel sekali catat.'; end if;
  if why is null or length(why) < 3 then raise exception 'Tulis alasan koreksinya.'; end if;
  if length(why) > 200 then raise exception 'Alasan terlalu panjang (paling panjang 200 huruf).'; end if;
  if m.id = me or public._staff_conflict(m.id) then raise exception 'Kartu ini terhubung dengan akun staf, jadi stempelnya tidak bisa dikoreksi.'; end if;
  perform pg_advisory_xact_lock(hashtext('stamp:' || m.id));
  sid := public._stamp_write(m.id, p_delta, why);
  insert into stamp_adjustments (member_id, delta, reason, sale_id, created_by) values (m.id, p_delta, why, sid, me) returning id into aid;
  perform public._log('koreksi_stempel', jsonb_build_object('member', m.id, 'koreksi', aid, 'jumlah', p_delta, 'alasan', why));
  select * into cv from public._card_view(m.id);
  return json_build_object('id', aid, 'member', public._first_name(m.full_name), 'delta', p_delta, 'total_stamps', public._total(m.id),
    'position', cv.card_position, 'cycle', cv.cycle);
end $$;

-- Undo a correction: its sales row is reversed, the same way an approved undo works.
create or replace function public.pos_stamp_adjust_cancel(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Koreksi stempel hanya bisa dilakukan manajer atau pemilik.');
  a stamp_adjustments; why text := nullif(trim(coalesce(p_reason, '')), ''); t int;
begin
  select * into a from stamp_adjustments where id = p_id for update;
  if a.id is null then raise exception 'Koreksi stempel tidak ditemukan.'; end if;
  if a.cancelled_at is not null then raise exception 'Koreksi ini sudah dibatalkan.'; end if;
  if why is null then raise exception 'Tulis alasan pembatalannya.'; end if;
  if length(why) > 200 then raise exception 'Alasan terlalu panjang (paling panjang 200 huruf).'; end if;
  perform pg_advisory_xact_lock(hashtext('stamp:' || a.member_id));
  t := public._total(a.member_id) - a.delta;
  if t < 0 or t < public._stamp_floor(a.member_id) then
    raise exception 'Koreksi ini tidak bisa dibatalkan: stempelnya sudah dipakai untuk hadiah kartu.';
  end if;
  update sales set reversed_at = now(), reversed_by = me where id = a.sale_id and reversed_at is null;
  update stamp_adjustments set cancelled_at = now(), cancelled_by = me, cancel_reason = why where id = a.id;
  perform public._sync_cycles(a.member_id);
  perform public._log('koreksi_stempel_batal', jsonb_build_object('member', a.member_id, 'koreksi', a.id, 'jumlah', a.delta, 'alasan', why));
  return json_build_object('id', a.id, 'total_stamps', public._total(a.member_id));
end $$;

-- Riwayat stempel: every stamp change in the period (sales with stamps and corrections), newest first.
create or replace function public.pos_stamp_history(p_from date, p_to date, p_member uuid default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], public._rsv_mgr_msg());
  -- Card codes only for the owner (14 Nov 2026); managers see the name.
  is_owner boolean := exists (select 1 from profiles where id = me and role = 'owner');
begin
  perform public._rsv_range(p_from, p_to);
  return coalesce((select json_agg(x order by x.at desc, x.sale_id desc) from (
    select s.id as sale_id, s.created_at as at, s.sale_day as day, s.member_id, m.full_name as member,
      case when is_owner then m.card_code end as card_code,
      s.stamps as delta, s.total,
      case when 'koreksi_stempel' = any (s.flags) then 'koreksi' else 'penjualan' end as kind,
      coalesce((select o.receipt_no from pos_orders o where o.sale_id = s.id), s.receipt_no) as receipt_no,
      a.id as adjustment_id, a.reason, a.cancel_reason,
      case when st.id is null then null else public._first_name(st.full_name) end as by,
      s.reversed_at is not null as reversed
    from sales s join profiles m on m.id = s.member_id
    left join stamp_adjustments a on a.sale_id = s.id
    left join profiles st on st.id = s.staff_id
    where s.sale_day between p_from and p_to and s.stamps <> 0 and (p_member is null or s.member_id = p_member)
    -- Newest first before the cap, so a long range shows the latest 2,000 (12 Nov 2026).
    order by s.created_at desc, s.id desc
    limit 2000) x), '[]');
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in ('_rsv_mgr_msg', '_rsv_balance', '_rsv_label', '_rsv_write_items',
      '_rsv_book', '_rsv_deposit', '_rsv_json', '_rsv_row', '_rsv_range', '_stamp_floor', '_stamp_write',
      'pos_reservation_save', 'pos_reservation_list', 'pos_reservation_today', 'pos_reservation_get', 'pos_reservation_set_status',
      'pos_reservation_checkout', 'pos_deposit_add', 'pos_deposit_refund', 'pos_deposit_forfeit', 'pos_deposit_adjust',
      'pos_deposit_moves', 'pos_deposit_report', 'acc_sync_deposits', 'pos_member_search', 'pos_stamp_adjust',
      'pos_stamp_adjust_cancel', 'pos_stamp_history')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
