-- Sakusaku Choux (Glenn, 27 Nov 2026): 25 dried Mini Choux shells in a standing bag with a chromo
-- sticker, Rp35.000 at the booth. The shells come from waste, after Glenn's QC.
-- Run in the Supabase SQL Editor after every other file (after till-laporan.sql). Safe to run again.
-- It replaces stock_catalog, _stock_count_json, stock_submit_count and _stock_cancel_out; the same
-- changes are in stock.sql, so re-running stock.sql keeps them.
--
-- How the waste becomes Sakusaku (everything at the Booth):
--   1. Into Kulit afkir Mini, the reject-shell stock (harga pokok 0):
--      - leftovers at closing: in Stok opname tutup booth, the Mini Choux row has "Untuk Sakusaku".
--        Those shells leave Mini Choux as buang ("Disimpan untuk Sakusaku", so their harga pokok is
--        still booked as waste) and come into Kulit afkir Mini as masuk. The rest is thrown as before.
--      - kitchen rejects: Barang masuk > Kulit afkir Mini, pemasok Hanashuya, no price.
--   2. QC: shells that don't pass go out with Barang keluar > Kulit afkir Mini > Dibuang.
--   3. Packing: owner page > Transaksi > Produksi, Sakusaku Choux, n pack. Its production recipe takes
--      25 Kulit afkir Mini, 1 Standing bag Sakusaku and 1 Stiker Sakusaku per pack.
--   4. Selling: the till product Sakusaku Choux isi 25 (category Lainnya) takes 1 pack per sale.
-- Harga pokok of a pack = bag + sticker (Rp1.876); the owner changes it in Stok > Barang.

-- ---------------------------------------------------------------- columns
alter table public.stock_items add column if not exists afkir_of int references public.stock_items (id);
alter table public.stock_count_lines add column if not exists kept numeric(12, 2) not null default 0 check (kept >= 0);

-- ---------------------------------------------------------------- stock items (first run only)
insert into public.stock_items (code, name, unit, low_level, closes_at_zero, sort, unit_cost) values
  ('kulit_afkir', 'Kulit afkir Mini', 'pcs', null, false, 13, 0),
  ('standing_bag', 'Standing bag Sakusaku', 'pcs', 20, false, 14, 876),
  ('stiker_sakusaku', 'Stiker Sakusaku 8x10', 'pcs', 20, false, 15, 1000),
  ('sakusaku', 'Sakusaku Choux', 'pack', 3, false, 16, 1876)
on conflict do nothing;
update public.stock_items a set afkir_of = m.id from public.stock_items m
 where a.code = 'kulit_afkir' and m.code = 'mini' and a.afkir_of is null;

-- Production recipe of 1 pack, only when it has none (the owner changes it in Resep produksi).
insert into public.stock_production_recipes (item_id, component_id, qty)
select p.id, c.id, x.q from (values ('kulit_afkir', 25), ('standing_bag', 1), ('stiker_sakusaku', 1)) as x(code, q)
  join public.stock_items c on c.code = x.code
  join public.stock_items p on p.code = 'sakusaku'
 where not exists (select 1 from public.stock_production_recipes r where r.item_id = p.id);

-- ---------------------------------------------------------------- the till product
insert into public.menu_items (name, price, sort, active, code, is_box, needs_flavour, pos_only, pos_name, category_id)
select 'Sakusaku Choux isi 25', 35000, 80, true, 'saku25', false, false, true, 'Sakusaku Choux isi 25',
  (select id from public.pos_categories where name = 'Lainnya')
 where not exists (select 1 from public.menu_items where code = 'saku25')
on conflict (name) do nothing;

-- Sales recipe: 1 pack per sale, only when it has none.
insert into public.stock_recipes (product_id, flavour_id, item_id, qty)
select m.id, null, i.id, 1 from public.menu_items m, public.stock_items i
 where m.code = 'saku25' and i.code = 'sakusaku'
   and not exists (select 1 from public.stock_recipes r where r.product_id = m.id);

-- ---------------------------------------------------------------- functions (same as stock.sql)
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
        'expected', l.expected, 'counted', l.counted, 'thrown', l.thrown, 'kept', l.kept, 'difference', l.counted - l.expected,
        'system', l.expected, 'physical', l.counted, 'selisih', l.counted - l.expected,
        'actual', case c.status when 'diterima' then l.counted when 'menunggu' then null else l.expected end)
        order by i.sort, i.id)
      from stock_count_lines l join stock_items i on i.id = l.item_id where l.count_id = c.id), '[]'))
  from stock_counts c where c.id = p_id
$$;

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
        'low_level', i.low_level, 'closes_at_zero', i.closes_at_zero,
        -- Sakusaku (sakusaku.sql, 27 Nov 2026): afkir_of = the choux this reject-shell item is kept from,
        -- afkir_to = the reject-shell item this choux's leftovers can be kept in at closing.
        'afkir_of', i.afkir_of, 'afkir_to', (select a.id from stock_items a where a.afkir_of = i.id and a.active order by a.id limit 1))
        order by i.sort, i.id)
      from stock_items i where i.active), '[]'),
    'staff', coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'is_me', p.id = me,
        'role', p.role, 'on_duty', p.id = any (duty))
        order by p.id = any (duty) desc, p.full_name)
      from profiles p where p.role in ('staff', 'manager', 'owner') and p.deleted_at is null), '[]'));
end $$;

drop function if exists public.stock_submit_count(jsonb, text);
create or replace function public.stock_submit_count(p_lines jsonb, p_note text, p_responsible uuid, p_closing boolean default false) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._stock_staff_msg());
  ln jsonb; i stock_items; c numeric; t numeric; k numeric; ak stock_items; cid bigint; seen int[] := '{}'; v_day date := public._stock_today();
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
      k := coalesce(nullif(ln->>'kept', '')::numeric, 0);
    exception when invalid_text_representation then raise exception 'Angka stok opname tidak valid.';
    end;
    if i.id = any (seen) then raise exception '% tertulis dua kali.', i.name; end if;
    seen := seen || i.id;
    c := public._stock_qty(c, true); t := public._stock_qty(t, true); k := public._stock_qty(k, true);
    if t > 0 then
      insert into stock_moves (item_id, kind, qty, day, count_id, reason, responsible_id, created_by)
      values (i.id, 'buang', -t, v_day, cid, 'Sisa saat tutup', rb, me);
    end if;
    if k > 0 then
      if not coalesce(p_closing, false) then raise exception 'Choux untuk Sakusaku hanya dicatat di stok opname tutup booth.'; end if;
      select * into ak from stock_items a where a.afkir_of = i.id and a.active order by a.id limit 1;
      if ak.id is null then raise exception '% tidak bisa disimpan untuk Sakusaku.', i.name; end if;
      insert into stock_moves (item_id, kind, qty, day, count_id, reason, responsible_id, created_by) values
        (i.id, 'buang', -k, v_day, cid, 'Disimpan untuk Sakusaku', rb, me),
        (ak.id, 'masuk', k, v_day, cid, 'Sisa ' || i.name || ' saat tutup', rb, me);
    end if;
    insert into stock_count_lines (count_id, item_id, expected, counted, thrown, kept) values (cid, i.id, 0, c, t, k);
  end loop;
  update stock_counts set last_move_id = coalesce((select max(id) from stock_moves), 0) where id = cid;
  update stock_count_lines l set expected = public._stock_balance(l.item_id, (select last_move_id from stock_counts where id = cid))
   where l.count_id = cid;
  perform public._log('stok_hitung', jsonb_build_object('count', cid, 'items', jsonb_array_length(p_lines)));
  return public._stock_count_json(cid);
end $$;

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
  -- Choux kept for Sakusaku at closing went into Kulit afkir too: only cancelling the opname undoes both.
  if m.count_id is not null and m.reason = 'Disimpan untuk Sakusaku' then
    raise exception 'Choux ini disimpan untuk Sakusaku dari stok opname tutup. Batalkan stok opname-nya.';
  end if;
  select * into i from stock_items where id = m.item_id;
  insert into stock_moves (item_id, kind, qty, day, reason, responsible_id, created_by, reverses_id)
  values (m.item_id, m.kind, -m.qty, m.day, 'Batal barang keluar: ' || r, m.responsible_id, p_by, m.id) returning id into rid;
  perform public._log('stok_batal_keluar', jsonb_build_object('move', m.id, 'item', i.name, 'kind', m.kind, 'qty', -m.qty, 'reason', r));
  return json_build_object('id', m.id, 'item', i.name, 'unit', i.unit, 'kind', m.kind, 'qty', -m.qty, 'stock', public._stock_balance(m.item_id));
end $$;
