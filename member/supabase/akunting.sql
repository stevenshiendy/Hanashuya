-- Hanashuya POS: Akunting (owner back office, 12 Nov 2026, Glenn: modelled on VireoPOS Akunting).
-- Run LAST, after pos-laporan.sql (it reads pos.sql, stock.sql and, when it exists, pos-transaksi.sql).
-- Safe to run again. Writes are owner only and go into audit_log; the reports and acc_sync are owner and
-- manager (read-only for the manager, Glenn 13 Nov 2026). It edits no other file's functions.
--
-- Simple booth bookkeeping (SAK EMKM style, accrual light):
--   acc_accounts / acc_save_account / acc_delete_account   Akun Buku Besar: the chart of accounts (the owner adds,
--                           renames, switches off; a used account can never be deleted)
--   acc_journals / acc_lines   the journal. Debit must equal kredit (checked when posting and again by a trigger)
--   acc_sync(from, to)      builds the automatic journals from the POS tables. Safe to run again: one live journal
--                           per source row, and when a source row changes the old journal is reversed and a new one posted
--   acc_post_manual / acc_reverse_journal   Buat Jurnal (manual) and Batalkan (a reversing journal, never a delete)
--   acc_ledger / acc_trial / acc_pnl / acc_balance_sheet   Laporan Akunting
--
-- Automatic journals (source): penjualan (each paid order), batal (void or refund of a paid order), pembelian
-- (goods in with a harga beli), kas (cash moves and the drawer selisih at shift close), stok (sampel, promo,
-- buang, rusak at harga pokok), komisi (payouts of pos-transaksi.sql). Opening balances are entered by hand
-- in Buat jurnal, for example Dr Kas laci / Cr Modal pemilik for the drawer float.

-- ---------------------------------------------------------------- tables
create table if not exists public.acc_accounts (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[0-9]-[0-9]{4}$'),
  name text not null check (length(trim(name)) between 2 and 80),
  type text not null check (type in ('aset', 'kewajiban', 'ekuitas', 'pendapatan', 'beban')),
  normal text not null check (normal in ('debit', 'kredit')),
  parent_id bigint references public.acc_accounts (id),
  active boolean not null default true,
  system boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists acc_accounts_name on public.acc_accounts (lower(name));

create table if not exists public.acc_journals (
  id bigint generated always as identity primary key,
  day date not null,
  no text not null unique,
  description text not null check (length(trim(description)) between 1 and 200),
  source text not null check (source in ('manual', 'penjualan', 'batal', 'pembelian', 'kas', 'stok', 'komisi')),
  source_id text,
  posted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  reversed_by bigint,           -- the journal that reverses this one
  reverses bigint,              -- the journal this one reverses
  reason text
);
create index if not exists acc_journals_day on public.acc_journals (day);
-- One live journal per source row (a reversed journal and a reversing journal are not live).
create unique index if not exists acc_journals_live on public.acc_journals (source, source_id)
  where source <> 'manual' and reversed_by is null and reverses is null;

create table if not exists public.acc_lines (
  id bigint generated always as identity primary key,
  journal_id bigint not null references public.acc_journals (id) on delete cascade,
  account_id bigint not null references public.acc_accounts (id),
  debit bigint not null default 0 check (debit >= 0),
  credit bigint not null default 0 check (credit >= 0),
  memo text check (length(memo) <= 200),
  check ((debit > 0) <> (credit > 0))
);
create index if not exists acc_lines_journal on public.acc_lines (journal_id);
create index if not exists acc_lines_account on public.acc_lines (account_id);

create table if not exists public.acc_counters (
  day date primary key,
  last int not null
);

alter table public.acc_accounts enable row level security;
alter table public.acc_journals enable row level security;
alter table public.acc_lines enable row level security;
alter table public.acc_counters enable row level security;
revoke all on public.acc_accounts, public.acc_journals, public.acc_lines, public.acc_counters from anon, authenticated;

-- Backup guard: debit = kredit per journal, checked at the end of the statement.
-- security definer: the trigger is deferred, so it runs at commit as the signed-in user (the till),
-- who has no access to acc_lines. Without this every paid order failed with "permission denied".
create or replace function public._acc_check_balance() returns trigger
language plpgsql security definer set search_path = public
as $$
declare d bigint; k bigint;
begin
  select coalesce(sum(debit), 0), coalesce(sum(credit), 0) into d, k from acc_lines where journal_id = new.journal_id;
  if d <> k then raise exception 'Jurnal tidak seimbang: debit % dan kredit %.', d, k; end if;
  return null;
end $$;
drop trigger if exists acc_lines_balance on public.acc_lines;
create constraint trigger acc_lines_balance after insert on public.acc_lines
  deferrable initially deferred for each row execute function public._acc_check_balance();

-- ---------------------------------------------------------------- chart of accounts
-- System accounts are the ones the automatic journals use: the owner can rename them but not
-- switch them off or change their code or type.
insert into public.acc_accounts (code, name, type, normal, system) values
  ('1-1100', 'Kas laci', 'aset', 'debit', true),
  ('1-1200', 'Kas QRIS (GoPay Merchant)', 'aset', 'debit', true),
  ('1-1300', 'Bank', 'aset', 'debit', true),
  ('1-1400', 'Piutang platform pesan-antar', 'aset', 'debit', true),
  ('1-1500', 'Persediaan bahan (choux, vla, kemasan)', 'aset', 'debit', true),
  ('2-1100', 'Hutang usaha (pemasok)', 'kewajiban', 'kredit', true),
  ('2-1200', 'Hutang komisi', 'kewajiban', 'kredit', true),
  ('2-1300', 'Hutang lain-lain', 'kewajiban', 'kredit', false),
  ('3-1100', 'Modal pemilik', 'ekuitas', 'kredit', true),
  ('3-1200', 'Prive / setor ke pemilik', 'ekuitas', 'debit', true),
  ('4-1100', 'Pendapatan penjualan booth', 'pendapatan', 'kredit', true),
  ('4-1200', 'Pendapatan pesan-antar', 'pendapatan', 'kredit', true),
  ('4-1300', 'Pendapatan lain-lain', 'pendapatan', 'kredit', false),
  ('4-2000', 'Diskon penjualan', 'pendapatan', 'debit', true),
  ('5-1100', 'Harga pokok penjualan (HPP)', 'beban', 'debit', true),
  ('6-1100', 'Beban komisi', 'beban', 'debit', true),
  ('6-1200', 'Beban sampel', 'beban', 'debit', true),
  ('6-1300', 'Beban promosi', 'beban', 'debit', true),
  ('6-1400', 'Beban barang rusak / dibuang', 'beban', 'debit', true),
  ('6-1500', 'Selisih kas', 'beban', 'debit', true),
  ('6-2100', 'Beban sewa', 'beban', 'debit', false),
  ('6-2200', 'Beban gaji', 'beban', 'debit', false),
  ('6-2300', 'Beban listrik dan air', 'beban', 'debit', false),
  ('6-2400', 'Beban pemasaran', 'beban', 'debit', false),
  ('6-9000', 'Beban lain-lain', 'beban', 'debit', true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------- posting helpers
create or replace function public._acc_next_no(p_day date) returns text
language plpgsql volatile security definer set search_path = public
as $$
declare n int;
begin
  insert into acc_counters (day, last) values (p_day, 1)
  on conflict (day) do update set last = acc_counters.last + 1 returning last into n;
  return 'JU-' || to_char(p_day, 'YYMMDD') || '-' || lpad(n::text, 2, '0');
end $$;

-- Post one journal. p_lines: [{code | account_id, debit, credit, memo}]. Zero lines are dropped.
create or replace function public._acc_post(p_day date, p_desc text, p_source text, p_source_id text, p_lines jsonb,
  p_reverses bigint default null, p_reason text default null) returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare jid bigint; norm jsonb; d bigint; k bigint; n int;
begin
  norm := coalesce((select jsonb_agg(jsonb_build_object('account_id', coalesce(nullif(e.v->>'account_id', '')::bigint, (select a.id from acc_accounts a where a.code = e.v->>'code')),
            'debit', coalesce(nullif(e.v->>'debit', '')::bigint, 0), 'credit', coalesce(nullif(e.v->>'credit', '')::bigint, 0),
            'memo', nullif(trim(coalesce(e.v->>'memo', '')), '')) order by e.ord)
       from jsonb_array_elements(p_lines) with ordinality as e(v, ord)
      where coalesce(nullif(e.v->>'debit', '')::bigint, 0) + coalesce(nullif(e.v->>'credit', '')::bigint, 0) > 0), '[]');
  if exists (select 1 from jsonb_array_elements(norm) e where e->>'account_id' is null) then raise exception 'Ada baris jurnal tanpa akun yang dikenal.'; end if;
  if exists (select 1 from jsonb_array_elements(norm) e where (e->>'debit')::bigint > 0 and (e->>'credit')::bigint > 0) then
    raise exception 'Satu baris hanya boleh debit atau kredit, tidak keduanya.'; end if;
  select count(*), coalesce(sum((e->>'debit')::bigint), 0), coalesce(sum((e->>'credit')::bigint), 0) into n, d, k from jsonb_array_elements(norm) e;
  if n < 2 then raise exception 'Jurnal butuh paling sedikit dua baris.'; end if;
  if d <> k then raise exception 'Jurnal tidak seimbang: debit % dan kredit %.', d, k; end if;
  if p_source = 'manual' and exists (select 1 from jsonb_array_elements(norm) e join acc_accounts a on a.id = (e->>'account_id')::bigint where not a.active) then
    raise exception 'Ada akun yang sedang dimatikan. Nyalakan dulu di Akun buku besar.';
  end if;
  insert into acc_journals (day, no, description, source, source_id, posted_by, reverses, reason)
  values (p_day, public._acc_next_no(p_day), left(trim(p_desc), 200), p_source, p_source_id, auth.uid(), p_reverses, p_reason)
  returning id into jid;
  insert into acc_lines (journal_id, account_id, debit, credit, memo)
  select jid, (e->>'account_id')::bigint, (e->>'debit')::bigint, (e->>'credit')::bigint, e->>'memo' from jsonb_array_elements(norm) e;
  return jid;
end $$;

-- A reversing journal: the same lines with debit and kredit swapped. The original keeps its lines.
create or replace function public._acc_reverse(p_id bigint, p_day date, p_desc text, p_reason text default null) returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare j acc_journals; rid bigint;
begin
  select * into j from acc_journals where id = p_id for update;
  if j.id is null then raise exception 'Jurnal tidak ditemukan.'; end if;
  if j.reversed_by is not null then raise exception 'Jurnal % sudah dibatalkan.', j.no; end if;
  if j.reverses is not null then raise exception 'Jurnal pembatal tidak bisa dibatalkan lagi.'; end if;
  rid := public._acc_post(p_day, p_desc, j.source, j.source_id,
    (select coalesce(jsonb_agg(jsonb_build_object('account_id', l.account_id, 'debit', l.credit, 'credit', l.debit, 'memo', l.memo) order by l.id), '[]')
       from acc_lines l where l.journal_id = j.id), j.id, p_reason);
  update acc_journals set reversed_by = rid where id = j.id;
  return rid;
end $$;

-- Make the live journal of one source row match p_lines (null = no journal). Returns what happened.
create or replace function public._acc_restate(p_source text, p_id text, p_day date, p_desc text, p_lines jsonb) returns text
language plpgsql volatile security definer set search_path = public
as $$
declare j acc_journals; same boolean;
begin
  select * into j from acc_journals where source = p_source and source_id = p_id and reverses is null and reversed_by is null;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    if j.id is null then return 'tetap'; end if;
    perform public._acc_reverse(j.id, j.day, 'Pembatalan otomatis: ' || j.description, 'Sumber berubah');
    return 'dibatalkan';
  end if;
  if j.id is not null then
    with want as (
      select a.id as account_id, sum(coalesce(x.debit, 0))::bigint as debit, sum(coalesce(x.credit, 0))::bigint as credit
        from jsonb_to_recordset(p_lines) as x(code text, debit bigint, credit bigint) join acc_accounts a on a.code = x.code
       where coalesce(x.debit, 0) + coalesce(x.credit, 0) > 0 group by a.id),
    have as (
      select account_id, sum(debit)::bigint as debit, sum(credit)::bigint as credit from acc_lines where journal_id = j.id group by account_id)
    select j.day = p_day and not exists (select * from want except select * from have)
                         and not exists (select * from have except select * from want) into same;
    if same then return 'tetap'; end if;
    perform public._acc_reverse(j.id, j.day, 'Koreksi otomatis: ' || j.description, 'Sumber berubah');
    perform public._acc_post(p_day, p_desc, p_source, p_id, p_lines);
    return 'diubah';
  end if;
  perform public._acc_post(p_day, p_desc, p_source, p_id, p_lines);
  return 'baru';
end $$;

-- The account money comes in or goes out of, per payment method (transfer: a refund paid from the bank).
create or replace function public._acc_cash_code(m text) returns text
language sql immutable
as $$ select case m when 'tunai' then '1-1100' when 'qris' then '1-1200' when 'platform' then '1-1400' when 'transfer' then '1-1300' end $$;

-- How one paid order was paid: [{method, amount}] from pos_order_payments (a split order has two rows,
-- 13 Nov 2026) when that table exists, else the order's one method for the whole total.
create or replace function public._acc_order_pays(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare r jsonb; o pos_orders;
begin
  if public._rep_has('pos_order_payments') then
    execute 'select jsonb_agg(jsonb_build_object(''method'', p.method, ''amount'', p.amount) order by p.amount desc, p.method)
               from pos_order_payments p where p.order_id = $1' into r using p_order;
  end if;
  if r is null then
    select * into o from pos_orders where id = p_order;
    r := case when o.total > 0 and public._acc_cash_code(o.payment_method) is not null
              then jsonb_build_array(jsonb_build_object('method', o.payment_method, 'amount', o.total)) else '[]'::jsonb end;
  end if;
  return r;
end $$;

-- Lines of one paid order: cash, QRIS or platform in, discount and revenue, HPP out of stock.
create or replace function public._acc_order_lines(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o pos_orders; rev text; cost bigint; r jsonb := '[]'; pay jsonb;
begin
  select * into o from pos_orders where id = p_order;
  if o.id is null then return '[]'; end if;
  rev := case when exists (select 1 from pos_channels c where c.id = o.channel_id and c.delivery) then '4-1200' else '4-1100' end;
  select coalesce(sum(coalesce(i.cost, round(i.qty * public._stock_unit_cost(i.product_id, i.flavour_id))::int)), 0) into cost
    from pos_order_items i where i.order_id = o.id;
  for pay in select * from jsonb_array_elements(public._acc_order_pays(o.id)) loop
    if (pay->>'amount')::bigint > 0 and public._acc_cash_code(pay->>'method') is not null then
      r := r || jsonb_build_array(jsonb_build_object('code', public._acc_cash_code(pay->>'method'), 'debit', (pay->>'amount')::bigint));
    end if;
  end loop;
  if o.discount > 0 then r := r || jsonb_build_array(jsonb_build_object('code', '4-2000', 'debit', o.discount)); end if;
  if o.subtotal > 0 then r := r || jsonb_build_array(jsonb_build_object('code', rev, 'credit', o.subtotal)); end if;
  if cost > 0 then
    r := r || jsonb_build_array(jsonb_build_object('code', '5-1100', 'debit', cost), jsonb_build_object('code', '1-1500', 'credit', cost));
  end if;
  return r;
end $$;

-- Lines of one approved batal or refund (13 Nov 2026), dated the day it was approved.
--   whole order: the sale's journal flipped (harga pokok back, as the stock goes back); with a
--     refund_method the money leaves that account instead of the order's own.
--   partial: Dr revenue and Cr discount for the share refunded, Cr the refund account (or the order's
--     own split) for the amount, and the harga pokok of the returned pieces back into Persediaan (the
--     till puts those pieces back into stock).
drop function if exists public._acc_void_lines(uuid, int, boolean, text);
create or replace function public._acc_void_lines(p_order uuid, p_amount int, p_whole boolean, p_method text, p_lines jsonb default null) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare o pos_orders; rev text; f numeric; disc bigint; r jsonb := '[]'; pay jsonb; pays jsonb; left_amt bigint; part bigint; n int; i int := 0; cost bigint := 0;
begin
  select * into o from pos_orders where id = p_order;
  if o.id is null or p_amount <= 0 and not p_whole then return null; end if;
  if p_whole and p_method is null then return public._acc_flip(public._acc_order_lines(o.id)); end if;
  if p_whole then
    select coalesce(jsonb_agg(x), '[]') into r from jsonb_array_elements(public._acc_flip(public._acc_order_lines(o.id))) x
     where x->>'code' not in ('1-1100', '1-1200', '1-1300', '1-1400');
    if o.total > 0 then r := r || jsonb_build_array(jsonb_build_object('code', public._acc_cash_code(p_method), 'credit', o.total)); end if;
    return r;
  end if;
  rev := case when exists (select 1 from pos_channels c where c.id = o.channel_id and c.delivery) then '4-1200' else '4-1100' end;
  f := case when o.total > 0 then p_amount::numeric / o.total else 0 end;
  disc := round(o.discount * f);
  r := jsonb_build_array(jsonb_build_object('code', rev, 'debit', p_amount + disc));
  if disc > 0 then r := r || jsonb_build_array(jsonb_build_object('code', '4-2000', 'credit', disc)); end if;
  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    select coalesce(round(sum(coalesce(it.cost, round(it.qty * public._stock_unit_cost(it.product_id, it.flavour_id)))
                              * least(coalesce((e ->> 'qty')::numeric, it.qty), it.qty) / it.qty)), 0) into cost
      from jsonb_array_elements(p_lines) e join pos_order_items it on it.order_id = o.id and it.line = (e ->> 'line')::int;
  end if;
  if cost > 0 then
    r := r || jsonb_build_array(jsonb_build_object('code', '1-1500', 'debit', cost), jsonb_build_object('code', '5-1100', 'credit', cost));
  end if;
  if p_method is not null then
    return r || jsonb_build_array(jsonb_build_object('code', public._acc_cash_code(p_method), 'credit', p_amount));
  end if;
  pays := public._acc_order_pays(o.id); n := jsonb_array_length(pays); left_amt := p_amount;
  for pay in select * from jsonb_array_elements(pays) loop
    i := i + 1;
    part := case when i = n then left_amt else least(left_amt, round(p_amount * (pay->>'amount')::numeric / nullif(o.total, 0))) end;
    left_amt := left_amt - part;
    if part > 0 then r := r || jsonb_build_array(jsonb_build_object('code', public._acc_cash_code(pay->>'method'), 'credit', part)); end if;
  end loop;
  return r;
end $$;

create or replace function public._acc_flip(p_lines jsonb) returns jsonb
language sql immutable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'debit', coalesce(x.credit, 0), 'credit', coalesce(x.debit, 0))), '[]')
    from jsonb_to_recordset(p_lines) as x(code text, debit bigint, credit bigint)
$$;

create or replace function public._acc_tally(v text, c jsonb) returns jsonb
language sql immutable
as $$ select jsonb_set(c, array[v], to_jsonb(coalesce((c->>v)::int, 0) + 1)) $$;

-- ---------------------------------------------------------------- automatic journals
-- acc_sync checks who is asking, then runs _acc_sync_core. The till calls _acc_sync_core for the sale day
-- when an order is paid or a batal/refund is approved (pos.sql _pos_acc_post, 13 Nov 2026), so the books are
-- up to date without opening Akunting.
create or replace function public.acc_sync(p_from date default null, p_to date default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  -- Managers run it too: it only rebuilds the automatic journals from the POS tables (13 Nov 2026).
  me uuid := public._rep_reader();
begin
  return public._acc_sync_core(p_from, p_to);
end $$;

create or replace function public._acc_sync_core(p_from date default null, p_to date default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  f date := coalesce(p_from, date '2000-01-01'); t date := coalesce(p_to, public._local(now())::date);
  r record; res text; lines jsonb; c jsonb := '{}'; acct text; amt bigint;
begin
  if t < f then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  perform pg_advisory_xact_lock(hashtext('acc_sync'));

  -- Paid orders: one journal each, dated the sale day.
  for r in select * from pos_orders o where o.sale_day between f and t and o.payment_method is not null
                and o.status in ('dibayar', 'batal', 'refund') order by o.sale_day, o.sold_at loop
    res := public._acc_restate('penjualan', r.id::text, r.sale_day, 'Penjualan ' || r.receipt_no, public._acc_order_lines(r.id));
    c := public._acc_tally(res, c);
  end loop;

  -- A batal or refund of a paid order reverses the sale, dated when it was approved (the rule in
  -- pos-reports.sql). A whole-order one keeps the order's id as its key; each partial refund is its own
  -- journal ('v:' and the request id).
  for r in select v.*, o.receipt_no from public._rep_voids(f, t) v join pos_orders o on o.id = v.order_id order by v.at loop
    res := public._acc_restate('batal', case when r.whole then r.order_id::text else 'v:' || r.request_id end, r.day,
      (case when r.kind = 'refund' then 'Refund ' else 'Pembatalan ' end) || case when r.whole then '' else 'sebagian ' end || r.receipt_no,
      public._acc_void_lines(r.order_id, r.amount, r.whole, r.refund_method, r.lines));
    c := public._acc_tally(res, c);
  end loop;

  -- Goods in with a harga beli: Persediaan against Hutang usaha. Cancelled goods in are reversed.
  for r in select g.*, i.name as item, s.name as supplier from stock_goods_in g join stock_items i on i.id = g.item_id
             left join stock_suppliers s on s.id = g.supplier_id where g.day between f and t order by g.day, g.id loop
    lines := case when r.status = 'dibatalkan' or r.total_cost is null then null
      else jsonb_build_array(jsonb_build_object('code', '1-1500', 'debit', r.total_cost, 'memo', r.item),
                             jsonb_build_object('code', '2-1100', 'credit', r.total_cost, 'memo', coalesce(r.supplier, 'Pemasok'))) end;
    res := public._acc_restate('pembelian', r.id::text, r.day, 'Barang masuk ' || r.item || coalesce(' dari ' || r.supplier, ''), lines);
    c := public._acc_tally(res, c);
  end loop;

  -- Cash moves not tied to an order (a refund's kas keluar is already part of its batal journal).
  for r in select m.*, public._local(m.created_at)::date as d from pos_cash_moves m where m.order_id is null
             and public._local(m.created_at)::date between f and t order by m.id loop
    lines := case r.kind
      when 'masuk' then jsonb_build_array(jsonb_build_object('code', '1-1100', 'debit', r.amount), jsonb_build_object('code', '3-1100', 'credit', r.amount, 'memo', r.reason))
      when 'keluar' then jsonb_build_array(jsonb_build_object('code', '6-9000', 'debit', r.amount, 'memo', r.reason), jsonb_build_object('code', '1-1100', 'credit', r.amount))
      else jsonb_build_array(jsonb_build_object('code', '3-1200', 'debit', r.amount, 'memo', r.reason), jsonb_build_object('code', '1-1100', 'credit', r.amount)) end;
    res := public._acc_restate('kas', 'gerak:' || r.id, r.d, (case r.kind when 'masuk' then 'Kas masuk: ' when 'keluar' then 'Kas keluar: ' else 'Setor ke pemilik: ' end) || r.reason, lines);
    c := public._acc_tally(res, c);
  end loop;

  -- Drawer selisih at shift close (counted minus expected).
  for r in select s.*, public._local(s.closed_at)::date as d from pos_shifts s where s.closed_at is not null
             and s.counted_cash is not null and s.expected_cash is not null and public._local(s.closed_at)::date between f and t order by s.id loop
    amt := r.counted_cash - r.expected_cash;
    lines := case when amt < 0 then jsonb_build_array(jsonb_build_object('code', '6-1500', 'debit', -amt), jsonb_build_object('code', '1-1100', 'credit', -amt))
                  when amt > 0 then jsonb_build_array(jsonb_build_object('code', '1-1100', 'debit', amt), jsonb_build_object('code', '6-1500', 'credit', amt)) end;
    res := public._acc_restate('kas', 'shift:' || r.id, r.d, 'Selisih kas shift #' || r.id || (case when amt < 0 then ' (kurang)' else ' (lebih)' end), lines);
    c := public._acc_tally(res, c);
  end loop;

  -- Stock out at harga pokok: one journal per day and kind.
  for r in select m.day, m.kind, round(sum(-m.qty * i.unit_cost))::bigint as cost from stock_moves m join stock_items i on i.id = m.item_id
            where m.day between f and t and m.kind in ('sampel', 'promo', 'buang', 'rusak') group by m.day, m.kind order by m.day, m.kind loop
    acct := case r.kind when 'sampel' then '6-1200' when 'promo' then '6-1300' else '6-1400' end;
    lines := case when r.cost > 0 then jsonb_build_array(jsonb_build_object('code', acct, 'debit', r.cost), jsonb_build_object('code', '1-1500', 'credit', r.cost)) end;
    res := public._acc_restate('stok', r.day::text || '|' || r.kind, r.day, (case r.kind when 'sampel' then 'Sampel' when 'promo' then 'Barang promo' when 'buang' then 'Barang dibuang' else 'Barang rusak' end) || ' (harga pokok)', lines);
    c := public._acc_tally(res, c);
  end loop;
  -- A day and kind that no longer has any stock-out row: close its journal.
  for r in select j.* from acc_journals j where j.source = 'stok' and j.reverses is null and j.reversed_by is null and j.day between f and t
            and not exists (select 1 from stock_moves m where m.day = j.day and m.day::text || '|' || m.kind = j.source_id
                              and m.kind in ('sampel', 'promo', 'buang', 'rusak')) loop
    res := public._acc_restate('stok', r.source_id, r.day, r.description, null);
    c := public._acc_tally(res, c);
  end loop;

  -- Commission payouts (pos-transaksi.sql): accrual when processed, payment when marked paid.
  if to_regclass('public.pos_commission_payouts') is not null then
    for r in execute 'select y.*, public._first_name(p.full_name) as staff_name from pos_commission_payouts y join profiles p on p.id = y.staff_id order by y.id' loop
      if r.period_to between f and t or exists (select 1 from acc_journals where source = 'komisi' and source_id = 'hitung:' || r.id and day between f and t) then
        lines := case when r.cancelled_at is null and r.commission > 0 then
          jsonb_build_array(jsonb_build_object('code', '6-1100', 'debit', r.commission, 'memo', r.staff_name), jsonb_build_object('code', '2-1200', 'credit', r.commission, 'memo', r.staff_name)) end;
        res := public._acc_restate('komisi', 'hitung:' || r.id, r.period_to, 'Komisi ' || r.staff_name || ' ' || to_char(r.period_from, 'DD/MM') || ' - ' || to_char(r.period_to, 'DD/MM/YYYY'), lines);
        c := public._acc_tally(res, c);
      end if;
      if (r.paid_at is not null and public._local(r.paid_at)::date between f and t)
         or exists (select 1 from acc_journals where source = 'komisi' and source_id = 'bayar:' || r.id and day between f and t) then
        lines := case when r.cancelled_at is null and r.paid_at is not null and r.commission > 0 then
          jsonb_build_array(jsonb_build_object('code', '2-1200', 'debit', r.commission, 'memo', r.staff_name), jsonb_build_object('code', '1-1300', 'credit', r.commission, 'memo', r.staff_name)) end;
        res := public._acc_restate('komisi', 'bayar:' || r.id, coalesce(public._local(r.paid_at)::date, r.period_to), 'Pembayaran komisi ' || r.staff_name, lines);
        c := public._acc_tally(res, c);
      end if;
    end loop;
  end if;

  if c <> '{}'::jsonb then perform public._log('akunting_sinkron', jsonb_build_object('dari', f, 'sampai', t, 'hasil', c)); end if;
  return json_build_object('from', f, 'to', t, 'result', c,
    'changed', coalesce((c->>'baru')::int, 0) + coalesce((c->>'diubah')::int, 0) + coalesce((c->>'dibatalkan')::int, 0));
end $$;

-- ---------------------------------------------------------------- Akun Buku Besar
-- Every account with its balance (all time, in the account's normal side) and how many journal lines use it.
create or replace function public.acc_accounts() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();
begin
  return coalesce((select json_agg(x order by x.code) from (
    select a.id, a.code, a.name, a.type, a.normal, a.parent_id, a.active, a.system,
           coalesce(u.n, 0)::int as used,
           (case when a.normal = 'debit' then coalesce(u.d, 0) - coalesce(u.k, 0) else coalesce(u.k, 0) - coalesce(u.d, 0) end)::bigint as balance
      from acc_accounts a
      left join (select account_id, count(*) as n, sum(debit) as d, sum(credit) as k from acc_lines group by account_id) u on u.account_id = a.id) x), '[]');
end $$;

-- Add (p_id null) or change an account. p: {code, name, type, normal, parent_id, active}.
create or replace function public.acc_save_account(p_id bigint, p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  a acc_accounts; nm text := trim(coalesce(p->>'name', '')); cd text := trim(coalesce(p->>'code', ''));
  tp text := p->>'type'; nr text := p->>'normal'; used boolean; par bigint := nullif(p->>'parent_id', '')::bigint; act boolean;
  rid bigint;
begin
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Nama akun 2 sampai 80 huruf.'; end if;
  if p_id is null then
    if cd !~ '^[0-9]-[0-9]{4}$' then raise exception 'Kode akun seperti 6-2500: satu angka, tanda minus, empat angka.'; end if;
    if tp not in ('aset', 'kewajiban', 'ekuitas', 'pendapatan', 'beban') then raise exception 'Pilih jenis akun.'; end if;
    if nr is null then nr := case when tp in ('aset', 'beban') then 'debit' else 'kredit' end; end if;
    if nr not in ('debit', 'kredit') then raise exception 'Sisi normal harus debit atau kredit.'; end if;
    if exists (select 1 from acc_accounts where code = cd) then raise exception 'Kode % sudah dipakai.', cd; end if;
    if exists (select 1 from acc_accounts where lower(name) = lower(nm)) then raise exception 'Nama akun ini sudah ada.'; end if;
    insert into acc_accounts (code, name, type, normal, parent_id) values (cd, nm, tp, nr, par) returning id into rid;
    perform public._log('akun_tambah', jsonb_build_object('akun', rid, 'kode', cd, 'nama', nm));
    return json_build_object('id', rid);
  end if;
  select * into a from acc_accounts where id = p_id for update;
  if a.id is null then raise exception 'Akun tidak ditemukan.'; end if;
  used := exists (select 1 from acc_lines where account_id = a.id);
  act := coalesce((p->>'active')::boolean, a.active);
  if exists (select 1 from acc_accounts where lower(name) = lower(nm) and id <> a.id) then raise exception 'Nama akun ini sudah ada.'; end if;
  if cd <> '' and cd <> a.code then
    if a.system or used then raise exception 'Kode akun yang dipakai jurnal atau sistem tidak bisa diganti.'; end if;
    if cd !~ '^[0-9]-[0-9]{4}$' then raise exception 'Kode akun seperti 6-2500: satu angka, tanda minus, empat angka.'; end if;
    if exists (select 1 from acc_accounts where code = cd) then raise exception 'Kode % sudah dipakai.', cd; end if;
  else cd := a.code; end if;
  if tp is not null and tp <> a.type and (a.system or used) then raise exception 'Jenis akun yang dipakai jurnal atau sistem tidak bisa diganti.'; end if;
  if nr is not null and nr <> a.normal and (a.system or used) then raise exception 'Sisi normal akun yang dipakai jurnal atau sistem tidak bisa diganti.'; end if;
  if not act and a.system then raise exception 'Akun sistem dipakai jurnal otomatis, jadi tidak bisa dimatikan.'; end if;
  if par = a.id then raise exception 'Akun tidak bisa menjadi induk dirinya sendiri.'; end if;
  update acc_accounts set code = cd, name = nm, type = coalesce(tp, type), normal = coalesce(nr, normal), parent_id = par, active = act where id = a.id;
  perform public._log('akun_ubah', jsonb_build_object('akun', a.id, 'kode', cd, 'nama', nm, 'aktif', act));
  return json_build_object('id', a.id);
end $$;

-- Only an account no journal line uses, and that is not a system account, can be deleted.
create or replace function public.acc_delete_account(p_id bigint) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); a acc_accounts;
begin
  select * into a from acc_accounts where id = p_id for update;
  if a.id is null then raise exception 'Akun tidak ditemukan.'; end if;
  if a.system then raise exception 'Akun sistem tidak bisa dihapus.'; end if;
  if exists (select 1 from acc_lines where account_id = a.id) then raise exception 'Akun ini sudah dipakai jurnal, jadi tidak bisa dihapus. Matikan saja.'; end if;
  update acc_accounts set parent_id = null where parent_id = a.id;
  delete from acc_accounts where id = a.id;
  perform public._log('akun_hapus', jsonb_build_object('kode', a.code, 'nama', a.name));
  return json_build_object('deleted', true);
end $$;

-- ---------------------------------------------------------------- Buat Jurnal
-- The journals of a range with their lines. p_source filters (manual, penjualan, ...); p_q matches no, description or memo.
create or replace function public.acc_journals(p_from date, p_to date, p_source text default null, p_q text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader(); q text := nullif(lower(trim(coalesce(p_q, ''))), '');
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
  return coalesce((select json_agg(x order by x.day desc, x.id desc) from (
    select j.id, j.day, j.no, j.description, j.source, j.source_id, j.reversed_by, j.reverses, j.reason, j.created_at,
           public._first_name(p.full_name) as posted_by,
           (select sum(l.debit) from acc_lines l where l.journal_id = j.id)::bigint as amount,
           (select json_agg(json_build_object('account_id', a.id, 'code', a.code, 'name', a.name, 'debit', l.debit, 'credit', l.credit, 'memo', l.memo) order by l.id)
              from acc_lines l join acc_accounts a on a.id = l.account_id where l.journal_id = j.id) as lines
      from acc_journals j left join profiles p on p.id = j.posted_by
     where j.day between p_from and p_to and (p_source is null or j.source = p_source)
       and (q is null or lower(j.no) like '%' || q || '%' or lower(j.description) like '%' || q || '%'
            or exists (select 1 from acc_lines l where l.journal_id = j.id and lower(coalesce(l.memo, '')) like '%' || q || '%'))
     limit 2000) x), '[]');
end $$;

-- A manual journal. p_lines: [{account_id, debit, credit, memo}], any number of lines, must balance.
create or replace function public.acc_post_manual(p_day date, p_desc text, p_lines jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); jid bigint; no text;
begin
  if p_day is null then raise exception 'Isi tanggal jurnal.'; end if;
  if p_day > public._local(now())::date then raise exception 'Tanggal jurnal tidak boleh di masa depan.'; end if;
  if coalesce(trim(p_desc), '') = '' then raise exception 'Isi keterangan jurnal.'; end if;
  if jsonb_typeof(p_lines) <> 'array' then raise exception 'Isi baris jurnal.'; end if;
  jid := public._acc_post(p_day, p_desc, 'manual', null, p_lines);
  select j.no into no from acc_journals j where j.id = jid;
  perform public._log('jurnal_manual', jsonb_build_object('jurnal', jid, 'no', no, 'keterangan', left(trim(p_desc), 200)));
  return json_build_object('id', jid, 'no', no);
end $$;

-- Batalkan: post a reversing journal. Only manual journals; an automatic one is corrected where it comes from.
create or replace function public.acc_reverse_journal(p_id bigint, p_reason text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); j acc_journals; rid bigint; no text; rs text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if rs is null then raise exception 'Tulis alasan pembatalan.'; end if;
  select * into j from acc_journals where id = p_id;
  if j.id is null then raise exception 'Jurnal tidak ditemukan.'; end if;
  if j.source <> 'manual' then raise exception 'Jurnal otomatis tidak dibatalkan di sini. Koreksi di sumbernya (penjualan, barang masuk, kas) lalu perbarui jurnal.'; end if;
  rid := public._acc_reverse(j.id, greatest(j.day, public._local(now())::date), 'Pembatalan ' || j.no || ': ' || rs, rs);
  select x.no into no from acc_journals x where x.id = rid;
  perform public._log('jurnal_batal', jsonb_build_object('jurnal', j.id, 'no', j.no, 'pembatal', no, 'alasan', rs));
  return json_build_object('id', rid, 'no', no);
end $$;

-- ---------------------------------------------------------------- Laporan Akunting
create or replace function public._acc_range(p_from date, p_to date) returns void
language plpgsql immutable
as $$
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
end $$;

-- Buku besar: one account, opening balance, every line, running balance (in the account's normal side).
create or replace function public.acc_ledger(p_account bigint, p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader(); a acc_accounts; sg int; op bigint;
begin
  perform public._acc_range(p_from, p_to);
  select * into a from acc_accounts where id = p_account;
  if a.id is null then raise exception 'Pilih akun.'; end if;
  sg := case when a.normal = 'debit' then 1 else -1 end;
  select coalesce(sum(l.debit - l.credit), 0) * sg into op from acc_lines l join acc_journals j on j.id = l.journal_id where l.account_id = a.id and j.day < p_from;
  return (with r as (
      select j.id as journal_id, j.day, j.no, j.description, l.memo, l.debit, l.credit, l.id as lid,
             op + sum((l.debit - l.credit) * sg) over (order by j.day, j.id, l.id) as balance
        from acc_lines l join acc_journals j on j.id = l.journal_id where l.account_id = a.id and j.day between p_from and p_to)
    select json_build_object('account', json_build_object('id', a.id, 'code', a.code, 'name', a.name, 'type', a.type, 'normal', a.normal),
      'from', p_from, 'to', p_to, 'opening', op,
      'rows', coalesce((select json_agg(json_build_object('journal_id', journal_id, 'day', day, 'no', no, 'description', description, 'memo', memo,
                 'debit', debit, 'credit', credit, 'balance', balance) order by day, journal_id, lid) from r), '[]'),
      'debit_total', coalesce((select sum(debit) from r), 0), 'credit_total', coalesce((select sum(credit) from r), 0),
      'closing', coalesce((select balance from r order by day desc, journal_id desc, lid desc limit 1), op)));
end $$;

-- Neraca saldo: per account, saldo awal (before p_from), mutasi in the range, saldo akhir. Net figures are debit minus kredit.
create or replace function public.acc_trial(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();
begin
  perform public._acc_range(p_from, p_to);
  return (with s as (
      select a.id, a.code, a.name, a.type, a.normal,
             coalesce(sum(l.debit - l.credit) filter (where j.day < p_from), 0)::bigint as opening,
             coalesce(sum(l.debit) filter (where j.day between p_from and p_to), 0)::bigint as debit,
             coalesce(sum(l.credit) filter (where j.day between p_from and p_to), 0)::bigint as credit
        from acc_accounts a left join acc_lines l on l.account_id = a.id left join acc_journals j on j.id = l.journal_id and j.day <= p_to
       group by a.id),
    r as (select s.*, (opening + debit - credit)::bigint as closing from s where opening <> 0 or debit <> 0 or credit <> 0)
    select json_build_object('from', p_from, 'to', p_to,
      'rows', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'type', type, 'opening', opening, 'debit', debit, 'credit', credit,
                 'closing', closing, 'closing_debit', greatest(closing, 0), 'closing_credit', greatest(-closing, 0)) order by code) from r), '[]'),
      'total_debit', coalesce((select sum(debit) from r), 0), 'total_credit', coalesce((select sum(credit) from r), 0),
      'closing_debit', coalesce((select sum(greatest(closing, 0)) from r), 0), 'closing_credit', coalesce((select sum(greatest(-closing, 0)) from r), 0),
      'balanced', coalesce((select sum(closing) from r), 0) = 0 and coalesce((select sum(debit) from r), 0) = coalesce((select sum(credit) from r), 0)));
end $$;

-- Laba rugi: pendapatan (after discount), HPP (accounts 5-xxxx), beban (other expense accounts).
create or replace function public.acc_pnl(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();
begin
  perform public._acc_range(p_from, p_to);
  return (with r as (
      select a.id, a.code, a.name,
             case when a.type = 'pendapatan' then 'pendapatan' when left(a.code, 1) = '5' then 'hpp' else 'beban' end as grp,
             (case when a.type = 'pendapatan' then coalesce(sum(l.credit - l.debit), 0) else coalesce(sum(l.debit - l.credit), 0) end)::bigint as amount
        from acc_accounts a join acc_lines l on l.account_id = a.id join acc_journals j on j.id = l.journal_id
       where a.type in ('pendapatan', 'beban') and j.day between p_from and p_to group by a.id),
    f as (select * from r where amount <> 0),
    t as (select coalesce(sum(amount) filter (where grp = 'pendapatan'), 0) as rev, coalesce(sum(amount) filter (where grp = 'hpp'), 0) as hpp,
                 coalesce(sum(amount) filter (where grp = 'beban'), 0) as exp from f)
    select json_build_object('from', p_from, 'to', p_to,
      'pendapatan', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'amount', amount) order by code) from f where grp = 'pendapatan'), '[]'),
      'hpp', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'amount', amount) order by code) from f where grp = 'hpp'), '[]'),
      'beban', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'amount', amount) order by code) from f where grp = 'beban'), '[]'),
      'revenue', t.rev, 'hpp_total', t.hpp, 'gross_profit', t.rev - t.hpp, 'expenses', t.exp, 'net_profit', t.rev - t.hpp - t.exp) from t);
end $$;

-- Neraca at a date: aset, kewajiban, ekuitas, and the profit so far (no year-end closing entries are made).
create or replace function public.acc_balance_sheet(p_at date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();
begin
  if p_at is null then raise exception 'Pilih tanggal neraca.'; end if;
  return (with r as (
      select a.id, a.code, a.name, a.type,
             (case when a.type in ('aset') then coalesce(sum(l.debit - l.credit), 0) else coalesce(sum(l.credit - l.debit), 0) end)::bigint as amount
        from acc_accounts a join acc_lines l on l.account_id = a.id join acc_journals j on j.id = l.journal_id
       where j.day <= p_at and a.type in ('aset', 'kewajiban', 'ekuitas') group by a.id),
    f as (select * from r where amount <> 0),
    pl as (select coalesce(sum(case when a.type = 'pendapatan' then l.credit - l.debit else l.debit * -1 + l.credit end), 0)::bigint as profit
             from acc_lines l join acc_accounts a on a.id = l.account_id join acc_journals j on j.id = l.journal_id
            where j.day <= p_at and a.type in ('pendapatan', 'beban')),
    t as (select coalesce(sum(amount) filter (where type = 'aset'), 0) as aset, coalesce(sum(amount) filter (where type = 'kewajiban'), 0) as kew,
                 coalesce(sum(amount) filter (where type = 'ekuitas'), 0) as eku from f)
    select json_build_object('at', p_at,
      'aset', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'amount', amount) order by code) from f where type = 'aset'), '[]'),
      'kewajiban', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'amount', amount) order by code) from f where type = 'kewajiban'), '[]'),
      'ekuitas', coalesce((select json_agg(json_build_object('id', id, 'code', code, 'name', name, 'amount', amount) order by code) from f where type = 'ekuitas'), '[]'),
      'profit', pl.profit, 'total_aset', t.aset, 'total_kewajiban', t.kew, 'total_ekuitas', t.eku + pl.profit,
      'balanced', t.aset = t.kew + t.eku + pl.profit) from t, pl);
end $$;

-- ---------------------------------------------------------------- permissions
-- Same shape as the end of pos.sql: _ functions are not callable from the app, the rest are.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and (p.proname like '\_acc\_%' or p.proname in (
       'acc_sync', 'acc_accounts', 'acc_save_account', 'acc_delete_account', 'acc_journals', 'acc_post_manual', 'acc_reverse_journal',
       'acc_ledger', 'acc_trial', 'acc_pnl', 'acc_balance_sheet'))
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname like '\_%' then execute format('revoke all on function %s from authenticated', f.sig);
    else execute format('grant execute on function %s to authenticated', f.sig); end if;
  end loop;
end $$;
