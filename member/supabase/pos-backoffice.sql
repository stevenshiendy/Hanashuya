-- Hanashuya POS: back-office additions (Glenn, 11 Nov 2026, after the VireoPOS comparison in
-- POSDEVELOPMENT.md, gaps 1, 2, 5 and 6). Run after pos-home.sql (order: schema, pos, stock,
-- attendance, pos-owner, pos-approvals, pos-reports, pos-home, pos-backoffice). Re-running is safe.
--
--   owner_pos_orders / owner_pos_order   find any past sale and open it (gap 1)
--   owner_stock_save_cost / owner_pos_profit   harga pokok per item and the profit report (gap 2)
--   owner_pos_promos / owner_save_pos_promo / owner_set_pos_promo   promos the owner sets up (gap 5)
--   owner_members / owner_member   the member list (gap 6)
-- Owner only. The tables they read are in pos.sql, stock.sql and schema.sql.

-- ---------------------------------------------------------------- gap 1: sales lookup
-- Sales in a date range (Jakarta days), newest first, at most 300. p_q matches the invoice
-- number, the member's name or number, who served, or the promo. p_status: null or 'semua',
-- 'dibayar', 'menunggu', 'batal' (batal and refund).
create or replace function public.owner_pos_orders(p_from date, p_to date, p_q text default null, p_status text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  d1 date := coalesce(p_from, public._local(now())::date); d2 date := coalesce(p_to, public._local(now())::date);
  q text := nullif(lower(trim(coalesce(p_q, ''))), ''); st text := nullif(nullif(coalesce(p_status, ''), ''), 'semua'); digits text;
begin
  if d2 < d1 then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  if d2 - d1 > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
  if st is not null and st not in ('dibayar', 'menunggu', 'batal') then raise exception 'Status tidak dikenal.'; end if;
  digits := nullif(regexp_replace(coalesce(q, ''), '\D', '', 'g'), '');
  return json_build_object(
    'rows', coalesce((select json_agg(x order by x.sold_at desc) from (
      select o.id, o.receipt_no, o.local_no, o.sold_at, o.status, o.total, o.discount, o.payment_method, o.promo_label, o.stamps,
             -- Service charge and PBJT apart from the goods (14 Nov 2026); total is what the buyer paid.
             o.subtotal - o.discount as sales, o.service_charge, o.tax, o.tax_included,
             public._first_name(mb.full_name) as member, public._first_name(sv.full_name) as served_by,
             (select string_agg(i.qty || '× ' || i.name || coalesce(' ' || f.label, ''), ', ' order by i.line)
                from pos_order_items i left join pos_flavours f on f.id = i.flavour_id where i.order_id = o.id and not i.free_bag) as items,
             exists (select 1 from pos_void_requests v where v.order_id = o.id and v.status = 'menunggu') as void_pending
        from pos_orders o
        left join profiles mb on mb.id = o.member_id
        left join profiles sv on sv.id = o.served_by
       where o.sale_day between d1 and d2
         and (st is null or (st = 'batal' and o.status in ('batal', 'refund')) or o.status = st)
         and (q is null or lower(o.receipt_no) like '%' || q || '%' or lower(coalesce(o.local_no, '')) like '%' || q || '%' or lower(coalesce(mb.full_name, '')) like '%' || q || '%'
              or lower(coalesce(sv.full_name, '')) like '%' || q || '%' or lower(coalesce(o.promo_label, '')) like '%' || q || '%'
              or (digits is not null and length(digits) >= 4 and regexp_replace(coalesce(mb.whatsapp, ''), '\D', '', 'g') like '%' || digits || '%'))
       order by o.sold_at desc limit 300) x), '[]'),
    'total_rows', (select count(*) from pos_orders o
        left join profiles mb on mb.id = o.member_id left join profiles sv on sv.id = o.served_by
       where o.sale_day between d1 and d2
         and (st is null or (st = 'batal' and o.status in ('batal', 'refund')) or o.status = st)
         and (q is null or lower(o.receipt_no) like '%' || q || '%' or lower(coalesce(o.local_no, '')) like '%' || q || '%' or lower(coalesce(mb.full_name, '')) like '%' || q || '%'
              or lower(coalesce(sv.full_name, '')) like '%' || q || '%' or lower(coalesce(o.promo_label, '')) like '%' || q || '%'
              or (digits is not null and length(digits) >= 4 and regexp_replace(coalesce(mb.whatsapp, ''), '\D', '', 'g') like '%' || digits || '%'))),
    'paid_total', (select coalesce(sum(total), 0) from pos_orders where sale_day between d1 and d2 and status = 'dibayar'),
    -- The same paid orders split (14 Nov 2026): goods sales, service charge, PBJT on top and PBJT inside the price.
    'paid_split', (select json_build_object('sales', coalesce(sum(subtotal - discount), 0), 'service_charge', coalesce(sum(service_charge), 0),
        'tax', coalesce(sum(tax) filter (where not tax_included), 0), 'tax_in', coalesce(sum(tax) filter (where tax_included), 0))
      from pos_orders where sale_day between d1 and d2 and status = 'dibayar'));
end $$;

-- One sale in full: the receipt data plus who rang it, the member's full name and number,
-- flags, cost and the void and refund requests with their outcome.
create or replace function public.owner_pos_order(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); o pos_orders;
begin
  select * into o from pos_orders where id = p_id;
  if o.id is null then raise exception 'Pesanan tidak ditemukan.'; end if;
  return json_build_object(
    'receipt', public._pos_receipt(o.id),
    'cashier', (select full_name from profiles where id = o.cashier_id),
    'served_by_full', (select full_name from profiles where id = o.served_by),
    'member_full', (select full_name from profiles where id = o.member_id),
    'member_whatsapp', (select whatsapp from profiles where id = o.member_id),
    'via', o.via, 'flags', o.flags, 'gender', o.gender, 'age_range', o.age_range,
    'client_at', o.client_at, 'created_at', o.created_at, 'shift_id', o.shift_id,
    'cost', (select sum(coalesce(i.cost, round(i.qty * public._stock_unit_cost(i.product_id, i.flavour_id))::int)) from pos_order_items i where i.order_id = o.id),
    'voids', coalesce((select json_agg(json_build_object('kind', v.kind, 'reason', v.reason, 'status', v.status,
        'requested_by', (select public._first_name(full_name) from profiles where id = v.requested_by), 'created_at', v.created_at,
        'decided_by', (select public._first_name(full_name) from profiles where id = v.decided_by), 'decided_at', v.decided_at) order by v.created_at)
      from pos_void_requests v where v.order_id = o.id), '[]'));
end $$;

-- ---------------------------------------------------------------- gap 2: cost and profit
create or replace function public.owner_stock_save_cost(p_item int, p_cost numeric) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); i stock_items := public._stock_item(p_item);
begin
  if p_cost is null or p_cost < 0 then raise exception 'Isi harga pokok, 0 atau lebih.'; end if;
  if p_cost > 10000000 then raise exception 'Harga pokok terlalu besar.'; end if;
  update stock_items set unit_cost = round(p_cost, 2) where id = i.id;
  perform public._log('stok_ubah_harga_pokok', jsonb_build_object('item', i.name, 'dari', i.unit_cost, 'jadi', round(p_cost, 2)));
  return json_build_object('id', i.id, 'unit_cost', round(p_cost, 2));
end $$;

-- Laba kotor (sales after discount minus harga pokok) per product, per day and in total, for
-- paid orders. A line keeps the cost it had when it was paid; lines paid before costs were
-- set use today's costs and are counted in 'estimated'. Commission (1%) is shown apart.
create or replace function public.owner_pos_profit(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._rep_reader();  -- owner and manager, read-only (13 Nov 2026)
  d1 date := coalesce(p_from, public._local(now())::date); d2 date := coalesce(p_to, public._local(now())::date);
begin
  if d2 < d1 then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  -- Signed rows (pos-reports.sql): sales on their sale day, a batal or refund off on its approval day.
  return (with l as (
      select x.day as sale_day, x.name, x.product_code, x.qty, x.net as revenue, x.cost, x.est
        from public._rep_lines(d1, d2) x)
    select json_build_object(
      'from', d1, 'to', d2,
      'revenue', coalesce((select sum(revenue) from l), 0),
      'cost', coalesce((select sum(cost) from l), 0),
      'profit', coalesce((select sum(revenue - cost) from l), 0),
      'commission', coalesce((select sum(o.commission)::int from public._rep_orders(d1, d2) o), 0),
      'estimated', (select count(*) from l where est),
      'products', coalesce((select json_agg(x order by x.revenue desc, x.name) from (
          select name, sum(qty)::int as qty, sum(revenue)::int as revenue, sum(cost)::int as cost, sum(revenue - cost)::int as profit
            from l group by name having sum(qty) <> 0 or sum(revenue) <> 0) x), '[]'),
      'days', coalesce((select json_agg(x order by x.day) from (
          select sale_day as day, sum(revenue)::int as revenue, sum(cost)::int as cost, sum(revenue - cost)::int as profit
            from l group by sale_day) x), '[]'),
      -- Items used by a recipe that still cost Rp0, so the owner knows the profit is too high.
      'missing_costs', coalesce((select json_agg(distinct si.name) from stock_recipes r join stock_items si on si.id = r.item_id
          where si.active and si.unit_cost = 0 and r.qty > 0), '[]')));
end $$;

-- ---------------------------------------------------------------- gap 5: owner promos
create or replace function public.owner_pos_promos() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return json_build_object(
    'promos', coalesce((select json_agg(json_build_object('id', p.id, 'name', p.name, 'kind', p.kind, 'value', p.value,
        'products', p.products, 'min_spend', p.min_spend, 'days', p.days,
        'time_from', to_char(p.time_from, 'HH24:MI'), 'time_to', to_char(p.time_to, 'HH24:MI'),
        'starts_on', p.starts_on, 'ends_on', p.ends_on, 'member_only', p.member_only, 'per_member', p.per_member,
        'quota', p.quota, 'active', p.active, 'note', p.note, 'code', p.code,
        'used', (select count(*) from pos_orders o where o.promo_id = p.id and o.status = 'dibayar'),
        'discount_given', (select coalesce(sum(o.discount), 0) from pos_orders o where o.promo_id = p.id and o.status = 'dibayar'),
        'live_now', public._pos_promo_block(p, null, false) is null) order by p.active desc, p.id desc)
      from pos_promos p), '[]'),
    'products', coalesce((select json_agg(json_build_object('code', m.code, 'name', coalesce(m.pos_name, m.name)) order by m.sort, m.id)
      from menu_items m where m.code is not null and m.code <> 'bag'), '[]'));
end $$;

-- Add (p_id null) or change a promo. p: {name, kind, value, products, min_spend, days,
-- time_from, time_to, starts_on, ends_on, member_only, per_member, quota, active, note}.
create or replace function public.owner_save_pos_promo(p_id int, p jsonb) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  n text := nullif(trim(coalesce(p->>'name', '')), ''); k text := p->>'kind'; v int; ms int; pm int; qu int;
  prods text[]; dys int[]; tf time; tt time; sd date; ed date; pid int; old pos_promos; cd text;
begin
  if n is null or length(n) < 2 or length(n) > 40 then raise exception 'Isi nama promo (2 sampai 40 huruf). Nama ini tercetak di struk.'; end if;
  if k not in ('persen', 'rupiah') then raise exception 'Pilih potongan persen atau rupiah.'; end if;
  begin
    v := (p->>'value')::int; ms := coalesce(nullif(p->>'min_spend', '')::int, 0);
    pm := nullif(p->>'per_member', '')::int; qu := nullif(p->>'quota', '')::int;
    tf := nullif(p->>'time_from', '')::time; tt := nullif(p->>'time_to', '')::time;
    sd := nullif(p->>'starts_on', '')::date; ed := nullif(p->>'ends_on', '')::date;
  exception when others then raise exception 'Ada isian promo yang tidak valid. Periksa angka, jam dan tanggal.';
  end;
  if v is null or v <= 0 then raise exception 'Isi besar potongan lebih dari 0.'; end if;
  if k = 'persen' and v > 100 then raise exception 'Potongan persen paling besar 100.'; end if;
  if ms < 0 then raise exception 'Minimal belanja tidak boleh minus.'; end if;
  if (tf is null) <> (tt is null) then raise exception 'Isi jam mulai dan jam selesai, atau kosongkan keduanya.'; end if;
  if tf is not null and tt <= tf then raise exception 'Jam selesai harus sesudah jam mulai.'; end if;
  if sd is not null and ed is not null and ed < sd then raise exception 'Tanggal selesai harus sesudah tanggal mulai.'; end if;
  if pm is not null and pm < 1 then raise exception 'Batas per member paling sedikit 1.'; end if;
  if qu is not null and qu < 1 then raise exception 'Kuota paling sedikit 1.'; end if;
  if jsonb_typeof(p->'products') = 'array' and jsonb_array_length(p->'products') > 0 then
    select array_agg(x) into prods from jsonb_array_elements_text(p->'products') x;
    if exists (select 1 from unnest(prods) c where not exists (select 1 from menu_items m where m.code = c and c <> 'bag')) then
      raise exception 'Ada produk yang tidak dikenal.';
    end if;
  end if;
  if jsonb_typeof(p->'days') = 'array' and jsonb_array_length(p->'days') between 1 and 6 then
    select array_agg(x::int order by x::int) into dys from jsonb_array_elements_text(p->'days') x;
    if exists (select 1 from unnest(dys) d where d < 1 or d > 7) then raise exception 'Hari tidak valid.'; end if;
  elsif jsonb_typeof(p->'days') = 'array' and jsonb_array_length(p->'days') = 0 then
    raise exception 'Pilih minimal satu hari.';
  end if;
  if exists (select 1 from pos_promos where lower(name) = lower(n) and id is distinct from p_id) then
    raise exception 'Sudah ada promo bernama %. Pakai nama lain.', n;
  end if;
  cd := nullif(upper(regexp_replace(coalesce(p->>'code', ''), '[^A-Za-z0-9]', '', 'g')), '');
  if cd is not null and length(cd) not between 3 and 20 then raise exception 'Kode voucher 3 sampai 20 huruf atau angka.'; end if;
  if cd is not null and exists (select 1 from pos_promos where upper(code) = cd and id is distinct from p_id) then
    raise exception 'Kode % sudah dipakai promo lain.', cd;
  end if;
  if p_id is null then
    insert into pos_promos (name, kind, value, products, min_spend, days, time_from, time_to, starts_on, ends_on,
      member_only, per_member, quota, active, note, code, created_by)
    values (n, k, v, prods, ms, dys, tf, tt, sd, ed, coalesce((p->>'member_only')::boolean, false), pm, qu,
      coalesce((p->>'active')::boolean, true), nullif(trim(coalesce(p->>'note', '')), ''), cd, me)
    returning id into pid;
    perform public._log('promo_tambah', jsonb_build_object('promo', pid, 'name', n));
  else
    select * into old from pos_promos where id = p_id;
    if old.id is null then raise exception 'Promo tidak dikenal.'; end if;
    update pos_promos set name = n, kind = k, value = v, products = prods, min_spend = ms, days = dys, time_from = tf, time_to = tt,
      starts_on = sd, ends_on = ed, member_only = coalesce((p->>'member_only')::boolean, false), per_member = pm, quota = qu,
      active = coalesce((p->>'active')::boolean, true), note = nullif(trim(coalesce(p->>'note', '')), ''), code = cd
     where id = p_id;
    pid := p_id;
    perform public._log('promo_ubah', jsonb_build_object('promo', pid, 'dari', to_jsonb(old) - 'created_at', 'jadi', p));
  end if;
  return json_build_object('id', pid);
end $$;

create or replace function public.owner_set_pos_promo(p_id int, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  update pos_promos set active = coalesce(p_active, false) where id = p_id;
  if not found then raise exception 'Promo tidak dikenal.'; end if;
  perform public._log(case when p_active then 'promo_aktif' else 'promo_mati' end, jsonb_build_object('promo', p_id));
end $$;

-- ---------------------------------------------------------------- gap 6: member list
-- Members, 50 a page. p_q matches the name, the WhatsApp number or the card code.
-- p_sort: 'baru' (joined, newest first), 'kunjungan' (most visits), 'belanja' (most spent),
-- 'terakhir' (last visit), 'nama'.
create or replace function public.owner_members(p_q text default null, p_sort text default 'baru', p_page int default 0) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  q text := nullif(lower(trim(coalesce(p_q, ''))), ''); digits text := nullif(regexp_replace(coalesce(p_q, ''), '\D', '', 'g'), '');
  pg int := greatest(0, coalesce(p_page, 0));
begin
  if coalesce(p_sort, 'baru') not in ('baru', 'kunjungan', 'belanja', 'terakhir', 'nama') then raise exception 'Urutan tidak dikenal.'; end if;
  return (with base as (
      select p.id, p.full_name, p.whatsapp, p.card_code, p.created_at, p.birth_date, p.gender,
             s.visits, s.spent, s.last_visit
        from profiles p
        cross join lateral (select count(*)::int as visits, coalesce(sum(total), 0)::int as spent, max(created_at) as last_visit
                              from sales x where x.member_id = p.id and x.reversed_at is null) s
       where p.role = 'member' and p.deleted_at is null
         and (q is null or lower(coalesce(p.full_name, '')) like '%' || q || '%' or upper(p.card_code) like '%' || upper(q) || '%'
              or (digits is not null and length(digits) >= 4 and regexp_replace(coalesce(p.whatsapp, ''), '\D', '', 'g') like '%' || digits || '%')))
    select json_build_object(
      'total', (select count(*) from base),
      'all_members', (select count(*) from profiles where role = 'member' and deleted_at is null),
      'page', pg, 'page_size', 50,
      'rows', coalesce((select json_agg(json_build_object('id', b.id, 'name', b.full_name, 'whatsapp', b.whatsapp, 'card_code', b.card_code,
          'joined', b.created_at, 'birth_date', b.birth_date, 'visits', b.visits, 'spent', b.spent, 'last_visit', b.last_visit,
          'position', cv.card_position, 'cards_done', cv.cards_done,
          'ready', (select count(*) from public._rewards(b.id) r where r.status = 'tersedia')
                 + (select count(*) from public._vouchers(b.id) v where v.status = 'tersedia')) order by b.rn)
        from (select *, row_number() over (order by
                case when p_sort = 'nama' then lower(full_name) end,
                case when p_sort = 'kunjungan' then visits end desc,
                case when p_sort = 'belanja' then spent end desc,
                case when p_sort = 'terakhir' then last_visit end desc nulls last,
                created_at desc) as rn
                from base) b
        cross join lateral public._card_view(b.id) cv
       where b.rn > pg * 50 and b.rn <= (pg + 1) * 50), '[]')));
end $$;

-- One member: profile, card, rewards and vouchers with their status, and the last 20 visits.
create or replace function public.owner_member(p_id uuid) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  select * into p from profiles where id = p_id and role = 'member' and deleted_at is null;
  if p.id is null then raise exception 'Member tidak ditemukan.'; end if;
  return json_build_object(
    'id', p.id, 'name', p.full_name, 'username', p.username, 'whatsapp', p.whatsapp, 'card_code', p.card_code,
    'joined', p.created_at, 'birth_date', p.birth_date, 'gender', p.gender, 'age_range', p.age_range,
    'marketing', p.marketing_opt_in, 'stamps', public._total(p.id),
    'card', (select row_to_json(cv) from public._card_view(p.id) cv),
    'rewards', coalesce((select json_agg(json_build_object('label', r.label, 'slot', r.slot, 'cycle', r.cycle, 'status', r.status) order by r.cycle, r.slot)
        from public._rewards(p.id) r), '[]'),
    'vouchers', coalesce((select json_agg(json_build_object('title', v.title, 'label', v.label, 'ends_on', v.ends_on, 'status', v.status))
        from public._vouchers(p.id) v), '[]'),
    'visits', coalesce((select json_agg(x order by x.at desc) from (
        select s.created_at as at, s.total, s.stamps, s.receipt_no, s.reversed_at is not null as reversed,
               (select o.id from pos_orders o where o.sale_id = s.id) as order_id
          from sales s where s.member_id = p.id order by s.created_at desc limit 20) x), '[]'));
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.proname in ('owner_pos_orders', 'owner_pos_order', 'owner_stock_save_cost',
      'owner_pos_profit', 'owner_pos_promos', 'owner_save_pos_promo', 'owner_set_pos_promo', 'owner_members', 'owner_member')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
