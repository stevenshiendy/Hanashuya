-- Campur rasa (Glenn, 19 Nov 2026): more than one flavour in one box, in equal portions.
-- Each box is cut into portions the kitchen fills evenly; the customer picks a flavour per portion.
--   Signature Box isi 6   3 portions of 2   up to 3 flavours   6 / 4+2 / 2+2+2
--   Mini Box isi 8        2 portions of 4   up to 2 flavours   8 / 4+4
--   Mini Box isi 15       3 portions of 5   up to 3 flavours   15 / 10+5 / 5+5+5
-- The flavour charge stays once per box: a mix pays it when any of its flavours has one.
-- The till sends a mixed box as { product, mix: [{ flavour: 'vanilla', parts: 1 }, { flavour: 'choco', parts: 2 }], qty };
-- one flavour is an ordinary { product, flavour, qty }. The line keeps flavour_id null and the
-- pieces in pos_order_items.mix ([{ flavour, pcs }], in the order chosen).
-- Stock: each flavour's recipe by its share of the pieces (Choco 10 of 15 = two thirds of the Choco vla).
--
-- Run after every other POS file (last in the run order: after staff-akun.sql, nota-antrian.sql
-- and komisi-switch.sql). Safe to re-run. It replaces these functions, so re-run it after
-- re-running any of these files:
--   pos.sql        _pos_price, _pos_receipt, pos_catalog, _pos_stock_return_lines
--   staff-akun.sql _pos_create
--   stock.sql      _stock_apply_order
--   pos-home.sql   pos_home
-- Not covered yet: pre-orders (pos-reservasi.sql) stay one flavour per box, and the
-- per-flavour reports list a mixed box as "Tanpa rasa".

-- How many pieces a box holds, how many equal portions it is cut into, and how many flavours
-- it may mix (1 = no mixing).
alter table public.menu_items add column if not exists box_pieces int check (box_pieces is null or box_pieces between 2 and 50);
alter table public.menu_items add column if not exists mix_parts int check (mix_parts is null or mix_parts between 2 and 10);
alter table public.menu_items add column if not exists mix_max int not null default 1 check (mix_max between 1 and 4);
update public.menu_items m set box_pieces = x.pieces, mix_parts = x.parts, mix_max = x.mx
  from (values ('sig6', 6, 3, 3), ('mini8', 8, 2, 2), ('mini15', 15, 3, 3)) as x(code, pieces, parts, mx)
 where m.code = x.code and m.mix_parts is null;

alter table public.pos_order_items add column if not exists mix jsonb;

-- Checks a mix and turns portions into pieces. p_mix: [{ flavour, parts }], 2 or more different
-- flavours, at least 1 portion each, all portions used. Returns [{ flavour, pcs }].
create or replace function public._pos_mix(pr menu_items, p_mix jsonb) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  nm text := coalesce(pr.pos_name, pr.name); n int := jsonb_array_length(p_mix);
  e jsonb; fl pos_flavours; res jsonb := '[]'; seen text[] := '{}'; k int; total int := 0; per int;
begin
  if pr.box_pieces is null or pr.mix_parts is null or coalesce(pr.mix_max, 1) < 2 or pr.box_pieces % pr.mix_parts <> 0 then
    raise exception '% tidak bisa campur rasa. Pilih 1 rasa.', nm;
  end if;
  if n > pr.mix_max then raise exception '% paling banyak % rasa.', nm, pr.mix_max; end if;
  per := pr.box_pieces / pr.mix_parts;
  for e in select * from jsonb_array_elements(p_mix) loop
    fl := null; k := null;
    if jsonb_typeof(e) = 'object' then
      select * into fl from pos_flavours where id = e->>'flavour' and active;
      begin k := (e->>'parts')::int; exception when others then k := null; end;
    end if;
    if fl.id is null then raise exception 'Pilih rasa untuk %.', nm; end if;
    if fl.id = any (seen) then raise exception 'Rasa % dipilih dua kali.', fl.label; end if;
    if k is null or k < 1 then raise exception 'Pembagian rasa % tidak valid.', nm; end if;
    seen := seen || fl.id; total := total + k;
    res := res || jsonb_build_array(jsonb_build_object('flavour', fl.id, 'pcs', k * per));
  end loop;
  if total <> pr.mix_parts then
    raise exception '% dibagi % bagian isi %. Pembagian rasanya belum pas.', nm, pr.mix_parts, per;
  end if;
  return res;
end $$;

-- "Choco 3, Matcha 3" for receipts and lists.
create or replace function public._pos_mix_label(p_mix jsonb) returns text
language sql stable security definer set search_path = public
as $$
  select string_agg(coalesce(f.label, e.v->>'flavour') || ' ' || (e.v->>'pcs'), ', ' order by e.n)
    from jsonb_array_elements(case when jsonb_typeof(p_mix) = 'array' then p_mix else '[]'::jsonb end) with ordinality as e(v, n)
    left join pos_flavours f on f.id = e.v->>'flavour'
$$;

-- The recipe of one sold line: the product and flavour, or for a mix each flavour's recipe by
-- its share of the pieces. Items every flavour uses (choux, box, liner) still add up to one.
create or replace function public._stock_line_recipe(p_product int, p_flavour text, p_mix jsonb)
returns table (item_id int, qty numeric)
language sql stable security definer set search_path = public
as $$
  select r.item_id, r.qty from public._stock_recipe(p_product, p_flavour) r
   where jsonb_typeof(p_mix) is distinct from 'array'
  union all
  select r.item_id, round(sum(r.qty * (e->>'pcs')::numeric) / max(t.pcs), 2)
    from jsonb_array_elements(case when jsonb_typeof(p_mix) = 'array' then p_mix else '[]'::jsonb end) e
    cross join (select sum((z->>'pcs')::numeric) as pcs
                  from jsonb_array_elements(case when jsonb_typeof(p_mix) = 'array' then p_mix else '[]'::jsonb end) z) t
    cross join lateral public._stock_recipe(p_product, e->>'flavour') r
   group by r.item_id
  having max(t.pcs) > 0
$$;

-- Harga pokok of one unit of a sold line (a mix included).
create or replace function public._stock_unit_cost(p_product int, p_flavour text, p_mix jsonb) returns numeric
language sql stable security definer set search_path = public
as $$
  select coalesce(sum(r.qty * i.unit_cost), 0) from public._stock_line_recipe(p_product, p_flavour, p_mix) r
    join stock_items i on i.id = r.item_id
$$;

-- ---------------------------------------------------------------- from pos.sql, with the mix
create or replace function public._pos_price(p jsonb, m uuid) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  ch pos_channels; it jsonb; pr menu_items; fl pos_flavours; mx jsonb;
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
    fl := null; mx := null;
    if pr.needs_flavour then
      -- Campur rasa: 2 or more flavours in one box, in portions ("mix": [{ flavour, parts }], _pos_mix).
      -- A mix of one flavour is the same as "flavour".
      if jsonb_typeof(it->'mix') = 'array' and jsonb_array_length(it->'mix') > 1 then
        mx := public._pos_mix(pr, it->'mix');
      else
        select * into fl from pos_flavours where id = coalesce(nullif(it->>'flavour', ''), it->'mix'->0->>'flavour') and active;
        if fl.id is null then raise exception 'Pilih rasa untuk %.', pr.name; end if;
      end if;
    elsif nullif(it->>'flavour', '') is not null or jsonb_typeof(it->'mix') = 'array' then
      raise exception '% tidak punya pilihan rasa.', pr.name;
    end if;
    unit := coalesce((select cp.price from pos_channel_prices cp where cp.channel_id = ch.id and cp.product_id = pr.id), pr.price);
    -- The flavour charge is once per box: a mix pays it when any of its flavours has one.
    sur := case when fl.surcharge or (mx is not null and exists (select 1 from jsonb_array_elements(mx) e
                  join pos_flavours f on f.id = e->>'flavour' where f.surcharge)) then pr.flavour_surcharge else 0 end;
    n := n + 1;
    lines := lines || jsonb_build_object('line', n, 'product_id', pr.id, 'code', pr.code, 'name', coalesce(pr.pos_name, pr.name),
      'flavour', fl.id, 'flavour_label', coalesce(fl.label, public._pos_mix_label(mx)), 'mix', mx, 'qty', q, 'unit_price', unit + sur, 'surcharge', sur,
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
    'lines', coalesce((select json_agg(json_build_object('line', i.line, 'code', i.product_code, 'name', i.name, 'flavour', coalesce(f.label, public._pos_mix_label(i.mix)), 'qty', i.qty,
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
        'box_pieces', m.box_pieces, 'mix_parts', m.mix_parts,
        'mix_max', case when m.needs_flavour and m.box_pieces is not null and m.mix_parts is not null then m.mix_max else 1 end,
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
          'time_to', to_char(cp.time_to, 'HH24.MI'), 'ends_on', cp.ends_on, 'code', cp.code, 'auto', cp.seed_key is not null) order by cp.id)
        from pos_promos cp where public._pos_promo_block(cp, null, false) is null), '[]')));
end $$;

create or replace function public._pos_stock_return_lines(p_order uuid, p_lines jsonb, p_reason text) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  if to_regproc('public._stock_recipe') is null or to_regclass('public.stock_moves') is null then return; end if;
  execute $q$
    insert into stock_moves (item_id, kind, qty, day, order_id, reason, created_by)
    select r.item_id, 'batal_penjualan', sum(x.q * r.qty), public._local(now())::date, $1, $2, auth.uid()
      from (select i.product_id, i.flavour_id, i.mix, (e->>'qty')::int as q from jsonb_array_elements($3) e
              join pos_order_items i on i.order_id = $1 and i.line = (e->>'line')::int) x
      cross join lateral public._stock_line_recipe(x.product_id, x.flavour_id, x.mix) r
     group by r.item_id having sum(x.q * r.qty) <> 0 $q$ using p_order, p_reason, p_lines;
end $$;

-- ---------------------------------------------------------------- from staff-akun.sql, with the mix
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
    insert into pos_order_items (order_id, line, product_id, product_code, name, flavour_id, mix, qty, unit_price, surcharge,
      line_total, discount, free_bag)
    values (oid, (ln->>'line')::int, (ln->>'product_id')::int, ln->>'code', ln->>'name', ln->>'flavour',
      case when jsonb_typeof(ln->'mix') = 'array' then ln->'mix' end, (ln->>'qty')::int,
      (ln->>'unit_price')::int, (ln->>'surcharge')::int, (ln->>'line_total')::int, (ln->>'discount')::int, (ln->>'free_bag')::boolean);
  end loop;
  if tk.id is not null then update scan_tickets set used_at = now() where id = tk.id; end if;
  perform public._log('pos_pesanan', jsonb_build_object('order', oid, 'receipt', rno, 'total', (q->>'total')::int,
    'member', m.id, 'served_by', srv.id, 'promo', q->'promo'));
  return oid;
end $$;

-- ---------------------------------------------------------------- from stock.sql, with the mix
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
           cross join lateral public._stock_line_recipe(i.product_id, i.flavour_id, i.mix) r
          where i.order_id = o.id) x
   group by x.item_id having sum(x.q) <> 0;
  -- What each line cost at today's harga pokok, kept for the profit report.
  update pos_order_items i set cost = round(i.qty * public._stock_unit_cost(i.product_id, i.flavour_id, i.mix))::int where i.order_id = o.id;
end $$;

-- ---------------------------------------------------------------- from pos-home.sql, with the mix
create or replace function public.pos_home() returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  staff uuid := public._require(array['staff', 'owner'], 'Akun ini belum terdaftar sebagai staf. Minta pemilik menambahkan akun Anda.');
  s settings := public._cfg();
  d date := public._local(now())::date;
  h0 int := extract(hour from s.open_time)::int;
  h1 int := greatest(h0, extract(hour from s.close_time - interval '1 second')::int);
  v_rev int; v_orders int; v_units int; v_current int; shift bigint;
begin
  -- Jadwal komisi (komisi-switch.sql, 14 Nov 2026): turn every ended commission period into payouts.
  -- Cheap when there is nothing to do, and it can never stop the till.
  if to_regprocedure('public._commission_autoprocess_safe()') is not null then
    begin execute 'select public._commission_autoprocess_safe()'; exception when others then null; end;
  end if;
  -- Today's figures by the rule in pos-reports.sql: today's sales minus the batal and refund approved today.
  select coalesce(sum(o.total), 0), coalesce(sum(o.receipts), 0) into v_rev, v_orders from public._rep_orders(d, d) o;
  select coalesce(sum(l.qty), 0) into v_units from public._rep_lines(d, d) l where coalesce(l.product_code, '') <> 'bag';
  v_current := case when s.target_kind = 'omzet' then v_rev else v_units end;
  select id into shift from pos_shifts where outlet_id = 'papaya-bdg' and closed_at is null;

  return (with l as (select * from public._rep_lines(d, d) x where coalesce(x.product_code, '') <> 'bag'),
    o as (select x.*, extract(hour from public._local(x.at))::int as hr from public._rep_orders(d, d) x),
    p as (select * from public._rep_pay(d, d))
  select json_build_object(
    'day', d,
    'revenue', v_rev,
    -- Omzet is goods only; service charge and PBJT apart (14 Nov 2026). by_method below is the money in.
    'service_charge', coalesce((select sum(o.service) from o), 0),
    'pbjt', coalesce((select sum(o.tax) from o), 0),
    'pbjt_included', coalesce((select sum(o.tax_in) from o), 0),
    'orders', v_orders,
    'average', case when v_orders > 0 then round(v_rev::numeric / v_orders)::int else 0 end,
    'cancelled', (select count(*) from public._rep_voids(d, d)),
    'waiting', (select count(*) from pos_orders where sale_day = d and status = 'menunggu'),
    -- Dashboard tiles (Glenn, 13 Nov 2026): Pesanan dibatalkan = batal and refund approved today (the rule
    -- in pos-reports.sql), Tagihan gantung = orders confirmed today and not paid yet.
    'cancelled_count', (select count(*) from public._rep_voids(d, d)),
    'cancelled_amount', coalesce((select sum(v.amount) from public._rep_voids(d, d) v), 0),
    'pending_count', (select count(*) from pos_orders where sale_day = d and status = 'menunggu'),
    'pending_amount', coalesce((select sum(total) from pos_orders where sale_day = d and status = 'menunggu'), 0),
    'by_method', json_build_object(
      'tunai', coalesce((select sum(p.amount) from p where p.method = 'tunai'), 0),
      'qris', coalesce((select sum(p.amount) from p where p.method = 'qris'), 0)),
    'products_sold', v_units,
    'by_category', coalesce((select json_agg(json_build_object('name', x.name, 'qty', x.qty) order by x.sort, x.name) from (
        select c.name, c.sort, sum(l.qty)::int as qty
        from l join menu_items m on m.id = l.product_id join pos_categories c on c.id = m.category_id
        group by c.name, c.sort having sum(l.qty) <> 0) x), '[]'),
    'hourly', coalesce((select json_agg(json_build_object('hour', g.h, 'revenue', coalesce(x.rev, 0), 'orders', coalesce(x.n, 0)) order by g.h)
        from generate_series(h0, h1) g(h)
        left join (select o.hr, sum(o.total)::int as rev, sum(o.receipts)::int as n from o group by 1) x on x.hr = g.h), '[]'),
    'top_products', coalesce((select json_agg(json_build_object('name', x.name, 'qty', x.qty, 'unit', x.unit) order by x.qty desc, x.name) from (
        select l.name, sum(l.qty)::int as qty,
               case when coalesce(m.is_box, false) then 'box' else 'pcs' end as unit
        from l join menu_items m on m.id = l.product_id
        group by l.name, m.is_box having sum(l.qty) > 0
        order by 2 desc, 1 limit 5) x), '[]'),
    'by_flavour', coalesce((select json_agg(json_build_object('label', f.label, 'qty', coalesce(x.qty, 0)) order by f.sort)
        from pos_flavours f
        -- A mixed box counts for each of its flavours by its share of the pieces (Choco 3 of 6 = 0,5 box).
        left join (select y.flavour_id, round(sum(y.q), 1) as qty from (
            select l.flavour_id, l.qty::numeric as q from l where l.flavour_id is not null
            union all
            select e->>'flavour', l.qty * (e->>'pcs')::numeric / nullif((select sum((z->>'pcs')::numeric) from jsonb_array_elements(i.mix) z), 0)
              from l join pos_order_items i on i.order_id = l.order_id and i.line = l.line
              cross join lateral jsonb_array_elements(i.mix) e
             where l.flavour_id is null and jsonb_typeof(i.mix) = 'array') y
          group by y.flavour_id) x on x.flavour_id = f.id
        where f.active), '[]'),
    -- Staff work blind (Glenn, 11 Nov 2026): the drawer figure is for managers and the owner.
    'drawer', case when shift is not null and public._pos_cash_full() then public._pos_expected_cash(shift) end,
    -- Managers and the owner: the drawer has dropped below the owner's Modal standar laci.
    'drawer_low', case when shift is not null and public._pos_cash_full() then public._pos_expected_cash(shift) < s.cash_float end,
    'target', json_build_object('kind', s.target_kind, 'value', s.target_value, 'current', v_current,
      'percent', round(v_current * 100.0 / s.target_value)::int,
      'remaining', greatest(0, s.target_value - v_current))));
end $$;


-- ---------------------------------------------------------------- permissions
revoke all on function public._pos_mix(menu_items, jsonb), public._pos_mix_label(jsonb),
  public._stock_line_recipe(int, text, jsonb), public._stock_unit_cost(int, text, jsonb),
  public._pos_price(jsonb, uuid), public._pos_receipt(uuid), public._pos_create(uuid, jsonb),
  public._pos_stock_return_lines(uuid, jsonb, text), public._stock_apply_order(uuid)
  from public, anon, authenticated;
revoke all on function public.pos_catalog(), public.pos_home() from public, anon;
grant execute on function public.pos_catalog(), public.pos_home() to authenticated;
