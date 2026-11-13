-- Hanashuya POS: owner's Produk page. Run after schema.sql and pos.sql. Safe to re-run.
-- Categories, new products, prices, extra charge per flavour, delivery-channel prices, flavours and channels on/off.
-- Everything here is owner-only (one check: _pos_product_admin in pos.sql) and goes into audit_log.

-- Everything the Produk page shows: all products (also the ones switched off), the
-- delivery price of each per channel, all channels and all flavours.
create or replace function public.owner_pos_products() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin();
begin
  return json_build_object(
    'categories', coalesce((select json_agg(json_build_object('id', c.id, 'name', c.name, 'active', c.active,
        'products', (select count(*) from menu_items m where m.category_id = c.id and m.code is not null),
        'active_products', (select count(*) from menu_items m where m.category_id = c.id and m.code is not null and m.active))
        order by c.sort, c.id) from pos_categories c), '[]'),
    'products', coalesce((select json_agg(json_build_object('code', m.code, 'pos_name', coalesce(m.pos_name, m.name), 'name', m.name,
        'category_id', m.category_id,
        'price', m.price, 'flavour_surcharge', m.flavour_surcharge, 'active', m.active, 'is_box', m.is_box, 'needs_flavour', m.needs_flavour,
        'on_till', m.on_till, 'archived', m.archived_at is not null, 'archived_at', m.archived_at,
        'sold', exists (select 1 from pos_order_items i where i.product_id = m.id),
        'channel_prices', coalesce((select json_object_agg(cp.channel_id, cp.price) from pos_channel_prices cp where cp.product_id = m.id), '{}'::json))
        order by c.sort nulls last, c.id, m.sort, m.id)
        from menu_items m left join pos_categories c on c.id = m.category_id where m.code is not null), '[]'),
    'channels', coalesce((select json_agg(json_build_object('id', c.id, 'label', c.label, 'delivery', c.delivery, 'active', c.active) order by c.sort) from pos_channels c), '[]'),
    'flavours', coalesce((select json_agg(json_build_object('id', f.id, 'label', f.label, 'surcharge', f.surcharge, 'active', f.active) order by f.sort) from pos_flavours f), '[]'));
end $$;

-- A different price for one product on a delivery channel. A null price removes it
-- (the channel then charges the menu price).
create or replace function public.owner_save_channel_price(p_channel text, p_code text, p_price int) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); ch pos_channels; pr menu_items; old int;
begin
  select * into ch from pos_channels where id = p_channel;
  if ch.id is null then raise exception 'Saluran penjualan tidak dikenal.'; end if;
  if not ch.delivery then raise exception 'Harga khusus hanya untuk saluran pesan-antar. Di booth berlaku harga menu.'; end if;
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  select price into old from pos_channel_prices where channel_id = ch.id and product_id = pr.id;
  if p_price is null then
    delete from pos_channel_prices where channel_id = ch.id and product_id = pr.id;
  else
    if p_price < 0 then raise exception 'Harga tidak valid.'; end if;
    insert into pos_channel_prices (channel_id, product_id, price) values (ch.id, pr.id, p_price)
    on conflict (channel_id, product_id) do update set price = excluded.price;
  end if;
  perform public._log('pos_ubah_harga_saluran', jsonb_build_object('channel', ch.id, 'code', p_code, 'dari', old, 'jadi', p_price));
end $$;

-- Delivery channels are switched on when the owner is ready to sell through them.
create or replace function public.owner_set_channel(p_channel text, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); ch pos_channels;
begin
  select * into ch from pos_channels where id = p_channel;
  if ch.id is null then raise exception 'Saluran penjualan tidak dikenal.'; end if;
  if p_active is null then raise exception 'Pilihan aktif atau tidak harus diisi.'; end if;
  if not ch.delivery and not p_active then raise exception 'Penjualan di booth tidak bisa dimatikan.'; end if;
  update pos_channels set active = p_active where id = ch.id;
  perform public._log('pos_atur_saluran', jsonb_build_object('channel', ch.id, 'dari', ch.active, 'jadi', p_active));
end $$;

-- A flavour that is off can no longer be chosen at the till. At least one stays on.
create or replace function public.owner_set_flavour(p_flavour text, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); fl pos_flavours;
begin
  select * into fl from pos_flavours where id = p_flavour;
  if fl.id is null then raise exception 'Rasa tidak dikenal.'; end if;
  if p_active is null then raise exception 'Pilihan aktif atau tidak harus diisi.'; end if;
  if not p_active and not exists (select 1 from pos_flavours where active and id <> fl.id) then
    raise exception 'Minimal satu rasa harus tetap aktif.';
  end if;
  update pos_flavours set active = p_active where id = fl.id;
  perform public._log('pos_atur_rasa', jsonb_build_object('flavour', fl.id, 'dari', fl.active, 'jadi', p_active));
end $$;

-- The name on the till and the receipt.
create or replace function public.owner_rename_pos_product(p_code text, p_pos_name text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); pr menu_items; nm text := btrim(coalesce(p_pos_name, ''));
begin
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  if nm = '' or char_length(nm) > 40 then raise exception 'Nama produk harus 1 sampai 40 huruf.'; end if;
  perform public._pos_name_free(nm, pr.id);
  update menu_items set pos_name = nm where id = pr.id;
  perform public._log('pos_ubah_nama_produk', jsonb_build_object('code', p_code, 'dari', coalesce(pr.pos_name, pr.name), 'jadi', nm));
end $$;

-- ---------------------------------------------------------------- categories and new products
-- (Glenn, 12 Nov 2026) The owner adds categories and products here, like VireoPOS's back office.

-- Refuses a product name another product already has (till name or menu name, any case).
create or replace function public._pos_name_free(p_name text, p_except int) returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if exists (select 1 from menu_items m where m.id is distinct from p_except
              and (lower(m.name) = lower(p_name) or lower(coalesce(m.pos_name, m.name)) = lower(p_name))) then
    raise exception 'Sudah ada produk bernama %. Pakai nama lain.', p_name;
  end if;
end $$;

create or replace function public._pos_category_name(p_name text, p_except int) returns text
language plpgsql stable security definer set search_path = public
as $$
declare nm text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
begin
  if nm = '' or char_length(nm) > 30 then raise exception 'Nama kategori harus 1 sampai 30 huruf.'; end if;
  if exists (select 1 from pos_categories where lower(name) = lower(nm) and id is distinct from p_except) then
    raise exception 'Kategori % sudah ada.', nm;
  end if;
  return nm;
end $$;

-- Gives every category 1, 2, 3 ... in its current order, so moving up and down is a swap.
create or replace function public._pos_category_renumber() returns void
language sql volatile security definer set search_path = public
as $$
  update pos_categories c set sort = x.n from (select id, row_number() over (order by sort, id) as n from pos_categories) x
   where c.id = x.id and c.sort <> x.n
$$;

create or replace function public._pos_product_renumber(p_category int) returns void
language sql volatile security definer set search_path = public
as $$
  update menu_items m set sort = x.n from (select id, row_number() over (order by sort, id) as n from menu_items
    where category_id = p_category and code is not null) x
   where m.id = x.id and m.sort <> x.n
$$;

create or replace function public.owner_add_pos_category(p_name text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); nm text := public._pos_category_name(p_name, null); c pos_categories;
begin
  insert into pos_categories (name, sort) values (nm, coalesce((select max(sort) from pos_categories), 0) + 1) returning * into c;
  perform public._log('pos_tambah_kategori', jsonb_build_object('id', c.id, 'name', nm));
  return json_build_object('id', c.id, 'name', c.name);
end $$;

create or replace function public.owner_rename_pos_category(p_id int, p_name text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); c pos_categories; nm text;
begin
  select * into c from pos_categories where id = p_id;
  if c.id is null then raise exception 'Kategori tidak dikenal.'; end if;
  nm := public._pos_category_name(p_name, c.id);
  update pos_categories set name = nm where id = c.id;
  perform public._log('pos_ubah_nama_kategori', jsonb_build_object('id', c.id, 'dari', c.name, 'jadi', nm));
end $$;

-- p_dir -1 moves the category one place up (left on the till), 1 one place down.
create or replace function public.owner_move_pos_category(p_id int, p_dir int) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); c pos_categories; other pos_categories;
begin
  if p_dir is null or p_dir not in (-1, 1) then raise exception 'Arah urutan tidak valid.'; end if;
  perform public._pos_category_renumber();
  select * into c from pos_categories where id = p_id;
  if c.id is null then raise exception 'Kategori tidak dikenal.'; end if;
  select * into other from pos_categories where sort = c.sort + p_dir;
  if other.id is null then return; end if;
  update pos_categories set sort = c.sort where id = other.id;
  update pos_categories set sort = other.sort where id = c.id;
  perform public._log('pos_urutkan_kategori', jsonb_build_object('id', c.id, 'name', c.name, 'dari', c.sort, 'jadi', other.sort));
end $$;

-- A category that is off disappears from the till. Refused while it still has products on.
create or replace function public.owner_set_pos_category(p_id int, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); c pos_categories; n int;
begin
  select * into c from pos_categories where id = p_id;
  if c.id is null then raise exception 'Kategori tidak dikenal.'; end if;
  if p_active is null then raise exception 'Pilihan aktif atau tidak harus diisi.'; end if;
  if not p_active then
    select count(*) into n from menu_items where category_id = c.id and active and code is not null;
    if n > 0 then
      raise exception 'Kategori % masih punya % produk aktif. Matikan atau pindahkan produknya dulu.', c.name, n;
    end if;
  end if;
  update pos_categories set active = p_active where id = c.id;
  perform public._log('pos_atur_kategori', jsonb_build_object('id', c.id, 'name', c.name, 'dari', c.active, 'jadi', p_active));
end $$;

-- A new till product. Its code is made from the name (lowercase, letters and digits,
-- "_" between words) and made unique with _2, _3 ... It goes last in its category.
-- It has no stock recipe yet: a sale deducts nothing until the owner sets one in Stok.
create or replace function public.owner_add_pos_product(p_name text, p_category_id int, p_price int, p_needs_flavour boolean,
  p_flavour_surcharge int, p_is_box boolean, p_active boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._pos_product_admin();
  nm text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  base text; v_code text; i int := 1; c pos_categories; flv boolean := coalesce(p_needs_flavour, false);
  sur int := case when coalesce(p_needs_flavour, false) then coalesce(p_flavour_surcharge, 0) else 0 end;
  new_id int;
begin
  if nm = '' or char_length(nm) > 40 then raise exception 'Nama produk harus 1 sampai 40 huruf.'; end if;
  perform public._pos_name_free(nm, null);
  select * into c from pos_categories where id = p_category_id;
  if c.id is null then raise exception 'Pilih kategori produk.'; end if;
  if coalesce(p_active, true) then perform public._pos_category_live(c.id); end if;
  if p_price is null or p_price < 0 then raise exception 'Isi harga dengan angka, minimal 0.'; end if;
  if sur < 0 then raise exception 'Tambahan rasa tidak boleh minus.'; end if;
  base := left(btrim(regexp_replace(lower(nm), '[^a-z0-9]+', '_', 'g'), '_'), 20);
  if base = '' then base := 'produk'; end if;
  v_code := base;
  while exists (select 1 from menu_items m where m.code = v_code) loop
    i := i + 1; v_code := base || '_' || i;
  end loop;
  insert into menu_items (name, pos_name, price, sort, active, code, is_box, needs_flavour, flavour_surcharge, pos_only, category_id)
  values (nm, nm, p_price, coalesce((select max(sort) from menu_items where category_id = c.id and code is not null), 0) + 1,
          coalesce(p_active, true), v_code, coalesce(p_is_box, false), flv, sur, false, c.id)
  returning id into new_id;
  perform public._log('pos_tambah_produk', jsonb_build_object('code', v_code, 'name', nm, 'category', c.name, 'price', p_price,
    'needs_flavour', flv, 'surcharge', sur, 'is_box', coalesce(p_is_box, false), 'active', coalesce(p_active, true)));
  return json_build_object('id', new_id, 'code', v_code, 'name', nm);
end $$;

-- Moves a product to another category, as the last one there.
create or replace function public.owner_set_product_category(p_code text, p_category_id int) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); pr menu_items; c pos_categories;
begin
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  select * into c from pos_categories where id = p_category_id;
  if c.id is null then raise exception 'Kategori tidak dikenal.'; end if;
  if pr.category_id is not distinct from c.id then return; end if;
  if pr.active then perform public._pos_category_live(c.id); end if;
  update menu_items set category_id = c.id,
    sort = coalesce((select max(sort) from menu_items where category_id = c.id and code is not null), 0) + 1
   where id = pr.id;
  perform public._log('pos_pindah_kategori', jsonb_build_object('code', p_code,
    'dari', (select name from pos_categories where id = pr.category_id), 'jadi', c.name));
end $$;

-- p_dir -1 moves a product one place earlier within its category, 1 one place later.
create or replace function public.owner_move_pos_product(p_code text, p_dir int) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); pr menu_items; other menu_items;
begin
  if p_dir is null or p_dir not in (-1, 1) then raise exception 'Arah urutan tidak valid.'; end if;
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  if pr.category_id is null then raise exception 'Pilih kategori produk ini dulu.'; end if;
  perform public._pos_product_renumber(pr.category_id);
  select * into pr from menu_items where id = pr.id;
  select * into other from menu_items where category_id = pr.category_id and code is not null and sort = pr.sort + p_dir;
  if other.id is null then return; end if;
  update menu_items set sort = pr.sort where id = other.id;
  update menu_items set sort = other.sort where id = pr.id;
  perform public._log('pos_urutkan_produk', jsonb_build_object('code', p_code, 'dari', pr.sort, 'jadi', other.sort));
end $$;

-- Show or hide a product's tile on the till, without switching it off (Glenn, 12 Nov 2026).
create or replace function public.owner_set_product_till(p_code text, p_on boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); pr menu_items;
begin
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  update menu_items set on_till = coalesce(p_on, true) where id = pr.id;
  perform public._log('pos_produk_di_kasir', jsonb_build_object('code', p_code, 'on_till', coalesce(p_on, true)));
end $$;

-- Archive an old product (Glenn, 12 Nov 2026): it is switched off and leaves the product
-- list; its sales history stays. p_archive false brings it back, still switched off.
create or replace function public.owner_archive_pos_product(p_code text, p_archive boolean) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._pos_product_admin(); pr menu_items;
begin
  select * into pr from menu_items where code = p_code;
  if pr.id is null then raise exception 'Produk tidak dikenal.'; end if;
  if pr.code = 'bag' and coalesce(p_archive, true) then raise exception 'Paper bag dipakai untuk paper bag gratis, jadi tidak bisa diarsipkan.'; end if;
  if coalesce(p_archive, true) then
    update menu_items set active = false, archived_at = coalesce(archived_at, now()) where id = pr.id;
  else
    update menu_items set archived_at = null where id = pr.id;
  end if;
  perform public._log(case when coalesce(p_archive, true) then 'pos_arsip_produk' else 'pos_kembalikan_produk' end,
    jsonb_build_object('code', p_code, 'name', coalesce(pr.pos_name, pr.name)));
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('owner_pos_products', 'owner_save_channel_price', 'owner_set_channel', 'owner_set_flavour', 'owner_rename_pos_product',
        'owner_add_pos_category', 'owner_rename_pos_category', 'owner_move_pos_category', 'owner_set_pos_category',
        'owner_add_pos_product', 'owner_set_product_category', 'owner_move_pos_product', 'owner_set_product_till', 'owner_archive_pos_product',
        '_pos_name_free', '_pos_category_name', '_pos_category_renumber', '_pos_product_renumber')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
