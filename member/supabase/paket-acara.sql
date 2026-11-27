-- Paket Acara: bulk orders for events (Glenn, 27 Nov 2026). Run in the Supabase SQL Editor after
-- schema.sql (it only needs profiles, settings, audit_log and the helpers _require, _log, _wa, _local).
-- Safe to run again. Owner only, except the website interest form (bulk_lead_submit), which anyone may send.
--
-- The package (the printed A4 "Paket Acara" document, 27 Nov 2026), kept in bulk_config so the owner can change it:
--   minimum 10 boxes, order H-2, paid in full (QRIS or transfer) before delivery
--   10-19 box 10%, no flavour surcharge, delivery free up to 5 km, Rp20.000 for 5-15 km
--   20-39 box 15% + free delivery up to 15 km + 1 Mini Box of 8 per 20 boxes
--   40-79 box 20%, 80+ box 25% (same bonus, every 20 boxes)
--   over 15 km: the owner types the fee
--
--   bulk_config_get() / bulk_config_save(p)          the package, payment details and terms
--   bulk_product_list() / bulk_product_save(p)       the products sold this way (own list, not the till's)
--   bulk_quote(p)                                    works out an invoice without saving it
--   bulk_invoice_save(id, p)                         new (id null) or change while Draft or Terkirim
--   bulk_invoice_list(from, to, status)              by invoice date
--   bulk_invoice_get(id)
--   bulk_invoice_set_status(id, status, method, note)   terkirim, lunas (QRIS / transfer), batal, or back to draft
--   bulk_lead_submit(p)                              website form (anon), max 3 per number per day
--   bulk_lead_list(status) / bulk_lead_set_status(id, status, note)
-- Every write is in audit_log. Invoices are not booked in Akunting yet.

-- ---------------------------------------------------------------- tables
create table if not exists public.bulk_config (
  id int primary key default 1 check (id = 1),
  config jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.bulk_products (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 60),
  description text check (length(description) <= 120),
  price int not null check (price >= 0),
  flavour_surcharge int not null default 0 check (flavour_surcharge >= 0),
  counts_as_box boolean not null default true,
  active boolean not null default true,
  sort int not null default 0,
  seed_key text unique,
  updated_at timestamptz not null default now()
);

create table if not exists public.bulk_invoice_counters (day date primary key, last int not null);

create table if not exists public.bulk_invoices (
  id uuid primary key default gen_random_uuid(),
  no text not null unique,
  status text not null default 'draft' check (status in ('draft', 'terkirim', 'lunas', 'batal')),
  client_name text not null,
  company text,
  address text not null,
  whatsapp text not null,
  event_date date,
  delivery_date date not null,
  distance_km numeric(6, 1) not null default 0,
  quote jsonb not null,            -- the worked-out lines, tier, bonus, delivery and totals at save time
  total int not null check (total >= 0),
  note text check (length(note) <= 500),
  lead_id uuid,
  pay_method text check (pay_method in ('qris', 'transfer')),
  paid_at timestamptz,
  sent_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bulk_invoices_created on public.bulk_invoices (created_at);

create table if not exists public.bulk_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  whatsapp text not null,
  event_date date,
  boxes int,
  note text,
  source text not null default 'web',
  status text not null default 'baru' check (status in ('baru', 'dihubungi', 'invoice', 'batal')),
  owner_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists bulk_leads_wa on public.bulk_leads (whatsapp, created_at);

alter table public.bulk_config enable row level security;
alter table public.bulk_products enable row level security;
alter table public.bulk_invoice_counters enable row level security;
alter table public.bulk_invoices enable row level security;
alter table public.bulk_leads enable row level security;
revoke all on public.bulk_config, public.bulk_products, public.bulk_invoice_counters, public.bulk_invoices, public.bulk_leads from anon, authenticated;

-- ---------------------------------------------------------------- seed (only when empty)
insert into public.bulk_config (id, config) values (1, jsonb_build_object(
  'min_boxes', 10,
  'lead_days', 2,
  'base_free_km', 5,
  'delivery_fee', 20000,
  'max_km', 15,
  'bonus_every', 20,
  'bonus_name', 'Mini Box of 8',
  'bonus_value', 68000,
  'tiers', jsonb_build_array(
    jsonb_build_object('min', 10, 'pct', 10, 'free_flavour', true, 'free_km', 5,  'bonus', false),
    jsonb_build_object('min', 20, 'pct', 15, 'free_flavour', true, 'free_km', 15, 'bonus', true),
    jsonb_build_object('min', 40, 'pct', 20, 'free_flavour', true, 'free_km', 15, 'bonus', true),
    jsonb_build_object('min', 80, 'pct', 25, 'free_flavour', true, 'free_km', 15, 'bonus', true)),
  'bank', 'Blu by BCA',
  'account_no', '090148040461',
  'account_name', 'Steven Glenn Shiendy',
  'qris', true,
  'flavours', jsonb_build_array('Vanilla', 'Choco', 'Matcha', 'Matcha Strawberry'),
  'base_flavour', 'Vanilla',
  'terms', jsonb_build_array(
    'Minimal 10 box per pesanan, pesan paling lambat H-2 sebelum acara.',
    'Pembayaran lunas sebelum pengiriman, lewat QRIS Hanashuya atau transfer.',
    'Pesanan dikunci setelah pembayaran masuk.',
    'Harga paket tidak bisa digabung promo lain dan tidak mendapat stempel member.',
    'Choux paling enak dinikmati di hari pengiriman.')))
on conflict (id) do nothing;

insert into public.bulk_products (name, description, price, flavour_surcharge, sort, seed_key) values
  ('Signature Box of 6', '6 choux besar', 120000, 3000, 1, 'sig6'),
  ('Mini Box of 15', '15 mini choux', 99000, 3000, 2, 'mini15'),
  ('Mini Box of 8', '8 mini choux', 68000, 3000, 3, 'mini8')
on conflict (seed_key) do nothing;

-- ---------------------------------------------------------------- helpers
create or replace function public._bulk_owner() returns uuid
language sql stable security definer set search_path = public
as $$ select public._require(array['owner'], 'Hanya pemilik yang bisa membuka Paket Acara.') $$;

create or replace function public._bulk_cfg() returns jsonb
language sql stable security definer set search_path = public
as $$ select config from bulk_config where id = 1 $$;

-- Works out an invoice from p: { items: [{ product, flavour, qty }], distance_km, delivery_fee (only used
-- past max_km, or when delivery_override is true), promo_label, promo_amount }.
create or replace function public._bulk_calc(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  c jsonb := public._bulk_cfg(); it jsonb; pr bulk_products; q int; fl text;
  lines jsonb := '[]'; boxes int := 0; goods int := 0; surcharge int := 0; waived int := 0;
  tier jsonb; t jsonb; pct numeric := 0; disc int; bonus int := 0; km numeric; free_km numeric; fee int;
  promo int; promo_label text; total int; warn jsonb := '[]';
  base text := coalesce(c->>'base_flavour', 'Vanilla');
begin
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'Tambahkan paling sedikit 1 produk.';
  end if;
  for it in select * from jsonb_array_elements(p->'items') loop
    begin q := (it->>'qty')::int; exception when others then q := null; end;
    if q is null or q < 1 or q > 2000 then raise exception 'Isi jumlah di setiap baris (1 sampai 2000).'; end if;
    begin select * into pr from bulk_products where id = (it->>'product')::uuid; exception when others then pr := null; end;
    if pr.id is null then raise exception 'Produk tidak ditemukan. Muat ulang halaman.'; end if;
    fl := nullif(trim(coalesce(it->>'flavour', '')), '');
    if fl is null then fl := base; end if;
    if length(fl) > 60 then raise exception 'Nama rasa terlalu panjang.'; end if;
    goods := goods + pr.price * q;
    if fl <> base and pr.flavour_surcharge > 0 then surcharge := surcharge + pr.flavour_surcharge * q; end if;
    if pr.counts_as_box then boxes := boxes + q; end if;
    lines := lines || jsonb_build_object('product', pr.id, 'name', pr.name, 'flavour', fl, 'qty', q, 'price', pr.price,
      'surcharge', case when fl <> base then pr.flavour_surcharge else 0 end,
      'amount', pr.price * q + case when fl <> base then pr.flavour_surcharge * q else 0 end);
  end loop;

  for t in select * from jsonb_array_elements(coalesce(c->'tiers', '[]')) order by (value->>'min')::int loop
    if boxes >= (t->>'min')::int then tier := t; end if;
  end loop;
  if tier is not null then pct := (tier->>'pct')::numeric; end if;
  if boxes < coalesce((c->>'min_boxes')::int, 10) then
    warn := warn || to_jsonb(format('Di bawah minimal %s box, jadi tanpa harga paket.', c->>'min_boxes'));
  end if;
  if tier is not null and coalesce((tier->>'free_flavour')::boolean, false) then waived := surcharge; end if;
  disc := round(goods * pct / 100);
  if tier is not null and coalesce((tier->>'bonus')::boolean, false) then
    bonus := boxes / greatest(coalesce((c->>'bonus_every')::int, 20), 1);
  end if;

  km := coalesce(nullif(p->>'distance_km', '')::numeric, 0);
  if km < 0 or km > 200 then raise exception 'Jarak pengiriman tidak valid.'; end if;
  free_km := coalesce((tier->>'free_km')::numeric, (c->>'base_free_km')::numeric, 5);
  if coalesce((p->>'delivery_override')::boolean, false) then
    fee := coalesce(nullif(p->>'delivery_fee', '')::int, 0);
  elsif km <= free_km then fee := 0;
  elsif km <= coalesce((c->>'max_km')::numeric, 15) then fee := coalesce((c->>'delivery_fee')::int, 20000);
  else
    fee := nullif(p->>'delivery_fee', '')::int;
    if fee is null then warn := warn || to_jsonb(format('Lebih dari %s km: isi ongkir sesuai kesepakatan.', c->>'max_km')); fee := 0; end if;
  end if;
  if fee < 0 then raise exception 'Ongkir tidak boleh minus.'; end if;

  promo := coalesce(nullif(p->>'promo_amount', '')::int, 0);
  promo_label := nullif(trim(coalesce(p->>'promo_label', '')), '');
  if promo < 0 then raise exception 'Potongan promo tidak boleh minus.'; end if;
  if promo > 0 and promo_label is null then promo_label := 'Potongan promo'; end if;
  total := goods + surcharge - waived - disc - promo + fee;
  if total < 0 then raise exception 'Potongan promo lebih besar dari total.'; end if;

  return jsonb_build_object('lines', lines, 'boxes', boxes, 'goods', goods, 'surcharge', surcharge, 'surcharge_waived', waived,
    'tier', tier, 'pct', pct, 'discount', disc, 'bonus_boxes', bonus, 'bonus_name', c->>'bonus_name',
    'bonus_value', bonus * coalesce((c->>'bonus_value')::int, 0),
    'distance_km', km, 'free_km', free_km, 'delivery_fee', fee, 'promo_label', promo_label, 'promo_amount', promo,
    'total', total, 'warnings', warn);
end $$;

create or replace function public._bulk_json(p_id uuid) returns json
language sql stable security definer set search_path = public
as $$
  select json_build_object('id', i.id, 'no', i.no, 'status', i.status, 'client_name', i.client_name, 'company', i.company,
    'address', i.address, 'whatsapp', i.whatsapp, 'event_date', i.event_date, 'delivery_date', i.delivery_date,
    'distance_km', i.distance_km, 'quote', i.quote, 'total', i.total, 'note', i.note, 'lead_id', i.lead_id,
    'pay_method', i.pay_method, 'paid_at', i.paid_at, 'sent_at', i.sent_at, 'cancelled_at', i.cancelled_at,
    'cancel_reason', i.cancel_reason, 'created_at', i.created_at, 'issued_on', public._local(i.created_at)::date,
    'config', (select config from bulk_config where id = 1))
  from bulk_invoices i where i.id = p_id
$$;

-- ---------------------------------------------------------------- settings and products
create or replace function public.bulk_config_get() returns json
language plpgsql stable security definer set search_path = public
as $$ begin perform public._bulk_owner(); return public._bulk_cfg()::json; end $$;

create or replace function public.bulk_config_save(p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare c jsonb := public._bulk_cfg(); t jsonb; prev int := 0; k text;
begin
  perform public._bulk_owner();
  if jsonb_typeof(p) <> 'object' then raise exception 'Data tidak valid.'; end if;
  if p ? 'tiers' then
    if jsonb_typeof(p->'tiers') <> 'array' or jsonb_array_length(p->'tiers') = 0 then raise exception 'Isi paling sedikit 1 tingkat harga.'; end if;
    for t in select * from jsonb_array_elements(p->'tiers') loop
      if (t->>'min')::int is null or (t->>'min')::int <= prev then raise exception 'Jumlah box tiap tingkat harus naik (misalnya 10, 20, 40, 80).'; end if;
      if (t->>'pct')::numeric is null or (t->>'pct')::numeric < 0 or (t->>'pct')::numeric > 60 then raise exception 'Diskon tiap tingkat 0 sampai 60%%.'; end if;
      if (t->>'free_km')::numeric is null or (t->>'free_km')::numeric < 0 then raise exception 'Isi gratis ongkir (km) tiap tingkat, 0 kalau tidak ada.'; end if;
      prev := (t->>'min')::int;
    end loop;
  end if;
  foreach k in array array['min_boxes', 'lead_days', 'base_free_km', 'delivery_fee', 'max_km', 'bonus_every', 'bonus_value'] loop
    if p ? k and ((p->>k)::numeric is null or (p->>k)::numeric < 0) then raise exception 'Angka % tidak valid.', k; end if;
  end loop;
  if p ? 'terms' and jsonb_typeof(p->'terms') <> 'array' then raise exception 'Syarat dan ketentuan tidak valid.'; end if;
  c := c || (p - 'id');
  update bulk_config set config = c, updated_at = now() where id = 1;
  perform public._log('paket_acara_pengaturan', p);
  return c::json;
end $$;

create or replace function public.bulk_product_list() returns json
language plpgsql stable security definer set search_path = public
as $$ begin perform public._bulk_owner();
  return coalesce((select json_agg(row_to_json(x) order by x.active desc, x.sort, x.name) from
    (select id, name, description, price, flavour_surcharge, counts_as_box, active, sort from bulk_products) x), '[]'); end $$;

create or replace function public.bulk_product_save(p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare rid uuid; nm text := trim(coalesce(p->>'name', '')); pr int; sc int;
begin
  perform public._bulk_owner();
  if length(nm) < 2 or length(nm) > 60 then raise exception 'Isi nama produk (2 sampai 60 huruf).'; end if;
  begin pr := (p->>'price')::int; sc := coalesce(nullif(p->>'flavour_surcharge', '')::int, 0); exception when others then pr := null; end;
  if pr is null or pr < 0 or sc < 0 then raise exception 'Isi harga dalam rupiah.'; end if;
  if nullif(p->>'id', '') is null then
    insert into bulk_products (name, description, price, flavour_surcharge, counts_as_box, active, sort)
    values (nm, nullif(trim(coalesce(p->>'description', '')), ''), pr, sc, coalesce((p->>'counts_as_box')::boolean, true),
      coalesce((p->>'active')::boolean, true), coalesce((p->>'sort')::int, 99)) returning id into rid;
  else
    update bulk_products set name = nm, description = nullif(trim(coalesce(p->>'description', '')), ''), price = pr, flavour_surcharge = sc,
      counts_as_box = coalesce((p->>'counts_as_box')::boolean, counts_as_box), active = coalesce((p->>'active')::boolean, active),
      sort = coalesce((p->>'sort')::int, sort), updated_at = now()
     where id = (p->>'id')::uuid returning id into rid;
    if rid is null then raise exception 'Produk tidak ditemukan.'; end if;
  end if;
  perform public._log('paket_acara_produk', jsonb_build_object('produk', rid, 'nama', nm, 'harga', pr));
  return json_build_object('id', rid);
end $$;

-- ---------------------------------------------------------------- invoices
create or replace function public.bulk_quote(p jsonb) returns json
language plpgsql stable security definer set search_path = public
as $$ begin perform public._bulk_owner(); return public._bulk_calc(p)::json; end $$;

create or replace function public.bulk_invoice_save(p_id uuid, p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._bulk_owner(); r bulk_invoices; q jsonb; nm text := trim(coalesce(p->>'client_name', ''));
  addr text := trim(coalesce(p->>'address', '')); wa text := public._wa(p->>'whatsapp'); co text := nullif(trim(coalesce(p->>'company', '')), '');
  dd date; ed date; nt text := nullif(trim(coalesce(p->>'note', '')), ''); today date := public._local(now())::date; seq int; rid uuid; lead uuid;
begin
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Isi nama klien (2 sampai 80 huruf).'; end if;
  if length(addr) < 5 or length(addr) > 300 then raise exception 'Isi alamat pengiriman.'; end if;
  if wa is null or length(wa) < 10 or length(wa) > 15 then raise exception 'Isi nomor WhatsApp klien yang benar.'; end if;
  if co is not null and length(co) > 80 then raise exception 'Nama perusahaan terlalu panjang.'; end if;
  if nt is not null and length(nt) > 500 then raise exception 'Catatan terlalu panjang (paling panjang 500 huruf).'; end if;
  begin dd := (p->>'delivery_date')::date; exception when others then dd := null; end;
  begin ed := nullif(p->>'event_date', '')::date; exception when others then ed := null; end;
  if dd is null then raise exception 'Pilih tanggal kirim.'; end if;
  begin lead := nullif(p->>'lead_id', '')::uuid; exception when others then lead := null; end;
  q := public._bulk_calc(p);

  if p_id is null then
    insert into bulk_invoice_counters (day, last) values (today, 1)
    on conflict (day) do update set last = bulk_invoice_counters.last + 1 returning last into seq;
    insert into bulk_invoices (no, client_name, company, address, whatsapp, event_date, delivery_date, distance_km, quote, total, note, lead_id, created_by)
    values ('PA-' || to_char(today, 'YYMMDD') || '-' || lpad(seq::text, 2, '0'), nm, co, addr, wa, ed, dd, (q->>'distance_km')::numeric,
      q, (q->>'total')::int, nt, lead, me)
    returning id into rid;
    if lead is not null then update bulk_leads set status = 'invoice', updated_at = now() where id = lead and status <> 'batal'; end if;
    perform public._log('paket_acara_invoice_baru', jsonb_build_object('invoice', rid, 'total', q->>'total'));
    return public._bulk_json(rid);
  end if;

  select * into r from bulk_invoices where id = p_id for update;
  if r.id is null then raise exception 'Invoice tidak ditemukan.'; end if;
  if r.status not in ('draft', 'terkirim') then raise exception 'Invoice % sudah %, jadi isinya tidak bisa diubah.', r.no, case r.status when 'lunas' then 'lunas' else 'dibatalkan' end; end if;
  update bulk_invoices set client_name = nm, company = co, address = addr, whatsapp = wa, event_date = ed, delivery_date = dd,
    distance_km = (q->>'distance_km')::numeric, quote = q, total = (q->>'total')::int, note = nt, updated_at = now()
   where id = r.id;
  perform public._log('paket_acara_invoice_ubah', jsonb_build_object('invoice', r.id, 'no', r.no, 'total', q->>'total'));
  return public._bulk_json(r.id);
end $$;

create or replace function public.bulk_invoice_list(p_from date, p_to date, p_status text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._bulk_owner();
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select id, no, status, client_name, company, whatsapp, delivery_date, event_date, total, created_at,
      public._local(created_at)::date as issued_on, (quote->>'boxes')::int as boxes, pay_method, paid_at
      from bulk_invoices
     where public._local(created_at)::date between p_from and p_to
       and (nullif(p_status, '') is null or status = p_status)
     limit 2000) x), '[]');
end $$;

create or replace function public.bulk_invoice_get(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare j json;
begin
  perform public._bulk_owner();
  j := public._bulk_json(p_id);
  if j is null then raise exception 'Invoice tidak ditemukan.'; end if;
  return j;
end $$;

create or replace function public.bulk_invoice_set_status(p_id uuid, p_status text, p_method text default null, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare r bulk_invoices;
begin
  perform public._bulk_owner();
  select * into r from bulk_invoices where id = p_id for update;
  if r.id is null then raise exception 'Invoice tidak ditemukan.'; end if;
  if r.status in ('lunas', 'batal') and p_status <> 'draft' then raise exception 'Invoice % sudah %.', r.no, case r.status when 'lunas' then 'lunas' else 'dibatalkan' end; end if;
  if p_status = 'terkirim' then
    update bulk_invoices set status = 'terkirim', sent_at = coalesce(sent_at, now()), updated_at = now() where id = r.id;
  elsif p_status = 'lunas' then
    if p_method not in ('qris', 'transfer') then raise exception 'Pilih cara bayar: QRIS atau transfer.'; end if;
    update bulk_invoices set status = 'lunas', pay_method = p_method, paid_at = now(), updated_at = now() where id = r.id;
  elsif p_status = 'batal' then
    if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Tulis alasan pembatalan.'; end if;
    update bulk_invoices set status = 'batal', cancelled_at = now(), cancel_reason = trim(p_note), updated_at = now() where id = r.id;
  elsif p_status = 'draft' then
    if r.status = 'lunas' then raise exception 'Invoice yang sudah lunas tidak bisa dikembalikan ke draft.'; end if;
    update bulk_invoices set status = 'draft', cancelled_at = null, cancel_reason = null, updated_at = now() where id = r.id;
  else raise exception 'Status tidak dikenal.';
  end if;
  perform public._log('paket_acara_status', jsonb_build_object('invoice', r.id, 'no', r.no, 'dari', r.status, 'ke', p_status, 'cara', p_method, 'catatan', p_note));
  return public._bulk_json(r.id);
end $$;

-- ---------------------------------------------------------------- leads from the website form
create or replace function public.bulk_lead_submit(p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare nm text := trim(coalesce(p->>'name', '')); wa text := public._wa(p->>'whatsapp'); co text := nullif(trim(coalesce(p->>'company', '')), '');
  nt text := nullif(trim(coalesce(p->>'note', '')), ''); ed date; bx int; rid uuid;
begin
  if coalesce(p->>'website', '') <> '' then return json_build_object('ok', true); end if;  -- honeypot field filled by bots
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Isi nama lengkap Kakak.'; end if;
  if wa is null or length(wa) < 10 or length(wa) > 15 then raise exception 'Isi nomor WhatsApp yang benar.'; end if;
  if co is not null and length(co) > 80 then raise exception 'Nama perusahaan atau acara terlalu panjang.'; end if;
  if nt is not null and length(nt) > 500 then raise exception 'Catatan terlalu panjang (paling panjang 500 huruf).'; end if;
  begin ed := nullif(p->>'event_date', '')::date; exception when others then raise exception 'Tanggal acara tidak valid.'; end;
  if ed is not null and (ed < public._local(now())::date or ed > public._local(now())::date + 365) then raise exception 'Pilih tanggal acara mulai hari ini.'; end if;
  begin bx := nullif(p->>'boxes', '')::int; exception when others then raise exception 'Isi jumlah box dengan angka.'; end;
  if bx is not null and (bx < 1 or bx > 5000) then raise exception 'Isi jumlah box dengan angka.'; end if;
  if (select count(*) from bulk_leads where whatsapp = wa and created_at > now() - interval '1 day') >= 3 then
    raise exception 'Pesan Kakak sudah kami terima. Kami hubungi lewat WhatsApp ya Kak.';
  end if;
  if (select count(*) from bulk_leads where created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Sedang ramai. Coba lagi sebentar lagi atau chat kami di WhatsApp.';
  end if;
  insert into bulk_leads (name, company, whatsapp, event_date, boxes, note) values (nm, co, wa, ed, bx, nt) returning id into rid;
  return json_build_object('ok', true);
end $$;

create or replace function public.bulk_lead_list(p_status text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
begin
  perform public._bulk_owner();
  return coalesce((select json_agg(x order by x.created_at desc) from (
    select id, name, company, whatsapp, event_date, boxes, note, source, status, owner_note, created_at from bulk_leads
     where nullif(p_status, '') is null or status = p_status limit 2000) x), '[]');
end $$;

create or replace function public.bulk_lead_set_status(p_id uuid, p_status text, p_note text default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public._bulk_owner();
  if p_status not in ('baru', 'dihubungi', 'invoice', 'batal') then raise exception 'Status tidak dikenal.'; end if;
  update bulk_leads set status = p_status, owner_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), owner_note), updated_at = now() where id = p_id;
  if not found then raise exception 'Peminat tidak ditemukan.'; end if;
  perform public._log('paket_acara_peminat', jsonb_build_object('peminat', p_id, 'status', p_status));
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and (p.proname like '\_bulk\_%' or p.proname like 'bulk\_%')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
-- The website interest form is sent before anyone signs in.
grant execute on function public.bulk_lead_submit(jsonb) to anon;
