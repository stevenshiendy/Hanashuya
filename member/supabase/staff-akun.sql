-- Staff accounts with their own member card, starting password 123456, and who each
-- person works for (Glenn, 13 Nov 2026). Run once in the Supabase SQL Editor, then run
-- staff-13nov.sql. Every function here is the same as in schema.sql, pos.sql,
-- pos-reservasi.sql and attendance.sql (those files carry the change for future full runs),
-- so this file only saves re-running them all. Safe to run again.

alter table public.profiles add column if not exists employer text;

drop function if exists public.owner_add_staff(text, text, text, text);
drop function if exists public.owner_add_staff(text, text, text, text, text);

-- from schema.sql
create or replace function public._staff_conflict(p uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from profiles where id = p and role in ('owner', 'kasir'))
      or exists (
        select 1 from profiles m join profiles s
          on s.role in ('staff', 'manager', 'owner') and s.id <> m.id and s.deleted_at is null
         and ((m.whatsapp is not null and m.whatsapp = s.whatsapp)
           or (m.email is not null and lower(m.email) = lower(s.email)))
        where m.id = p)
$$;

-- from schema.sql
create or replace function public._vouchers(p uuid)
returns table (kind text, period int, title text, label text, starts_on date, ends_on date, status text, pos_code text)
language sql stable security definer set search_path = public
as $$
  with me as (
    select pr.id, public._local(pr.created_at)::date as joined, pr.birth_date, pr.welcome_voucher
    from profiles pr where pr.id = p and pr.role in ('member', 'staff', 'manager') and pr.deleted_at is null),
  t as (select public._local(now())::date as today),
  welcome as (
    select 'welcome'::text as kind, 0 as period, 'Hadiah member baru'::text as title,
           'Diskon 50% untuk 1 produk'::text as label, me.joined as starts_on, me.joined + 30 as ends_on,
           'NEWMEMBER50'::text as pos_code
    from me where me.welcome_voucher),
  bday as (
    select 'ulang_tahun'::text as kind, y as period, 'Hadiah ulang tahun'::text as title,
           '1 box Mini Choux isi 8 gratis'::text as label,
           public._birthday_in(me.birth_date, y) - 7 as starts_on, public._birthday_in(me.birth_date, y) + 7 as ends_on,
           'BIRTHDAYGIFT'::text as pos_code
    from me, t, generate_series(extract(year from t.today)::int - 1, extract(year from t.today)::int + 1) y
    where me.birth_date is not null
      and public._birthday_in(me.birth_date, y) + 7 >= t.today
      and me.joined <= public._birthday_in(me.birth_date, y) - 30
    order by y limit 1),
  codes as (
    -- The code is in the title so the cashier can match it with the paper voucher, which
    -- must be handed over at the booth (Glenn, 10 Nov 2026).
    select 'kode'::text as kind, c.id as period, b.title || ' ' || substr(c.code, 1, 4) || '-' || substr(c.code, 5, 4), b.label,
           public._local(c.claimed_at)::date as starts_on, b.ends_on, b.pos_code
    from me join voucher_codes c on c.claimed_by = me.id join voucher_batches b on b.id = c.batch_id),
  v as (select * from welcome union all select * from bday union all select * from codes)
  select v.kind, v.period, v.title, v.label, v.starts_on, v.ends_on,
    case
      when exists (select 1 from redemptions d where d.member_id = p and d.kind = v.kind
                   and d.cycle = v.period and d.reversed_at is null) then 'dipakai'
      when t.today < v.starts_on then 'belum'
      when t.today > v.ends_on then 'kedaluwarsa'
      else 'tersedia'
    end,
    v.pos_code
  from v, t
$$;

-- from schema.sql
create or replace function public.claim_voucher_code(p_code text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = me and role in ('member', 'staff', 'manager') and deleted_at is null) then
    return json_build_object('status', 'bukan_member', 'message', 'Voucher hanya untuk akun member.');
  end if;
  return public._claim_code(me, p_code, 'app');
end $$;

-- from schema.sql
create or replace function public.owner_move_code(p_code text, p_login text) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  k text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  c voucher_codes; to_p profiles;
begin
  select * into c from voucher_codes where code = k;
  if c.id is null then raise exception 'Kode voucher tidak dikenal.'; end if;
  if exists (select 1 from redemptions where kind = 'kode' and cycle = c.id and reversed_at is null) then
    raise exception 'Voucher ini sudah dipakai di booth, jadi tidak bisa dipindah.';
  end if;
  if nullif(trim(coalesce(p_login, '')), '') is null then
    update voucher_codes set claimed_by = null, claimed_at = null, claimed_via = null where id = c.id;
  else
    to_p := public._find_login(p_login);
    if to_p.id is null or to_p.role not in ('member', 'staff', 'manager') then raise exception 'Akun member tidak ditemukan.'; end if;
    if exists (select 1 from voucher_codes x join voucher_batches b on b.id = x.batch_id
               where x.batch_id = c.batch_id and x.claimed_by = to_p.id and b.one_per_member and x.id <> c.id) then
      raise exception 'Member itu sudah punya voucher dari kelompok ini.';
    end if;
    update voucher_codes set claimed_by = to_p.id, claimed_at = now(), claimed_via = 'pemilik' where id = c.id;
  end if;
  perform public._log('pindah_kode', jsonb_build_object('code_id', c.id, 'from', c.claimed_by, 'to', to_p.id));
  return json_build_object('code', c.code, 'member', to_p.full_name);
end $$;

-- from schema.sql
create or replace function public.set_first_password(p_password text) returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare me uuid := auth.uid(); p profiles;
begin
  select * into p from profiles where id = me and deleted_at is null;
  if p.id is null then raise exception 'Silakan masuk dulu.'; end if;
  if not p.must_set_password then raise exception 'Password sudah dibuat. Untuk menggantinya, buka Akun.'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Password minimal 8 karakter.'; end if;
  if exists (select 1 from auth.users where id = me and encrypted_password = extensions.crypt(p_password, encrypted_password)) then
    raise exception 'Buat password baru, jangan pakai password awal.';
  end if;
  perform public._set_password(me, p_password);
  update profiles set must_set_password = false where id = me;
  perform public._log('buat_password_pertama', jsonb_build_object('member', me));
  return public.whoami();
end $$;

-- from schema.sql
create or replace function public.owner_people() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(x order by x.role desc, x.full_name) from (
    select pr.id, pr.role, pr.full_name, pr.username, pr.email, pr.whatsapp, pr.created_at, pr.id = me as is_me,
      pr.must_set_password as start_password, pr.employer
    from profiles pr where pr.role in ('staff', 'manager', 'owner') and pr.deleted_at is null) x), '[]');
end $$;

-- from schema.sql
create or replace function public.owner_set_role(p_phone text, p_role text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles;
begin
  if p_role not in ('member', 'staff', 'manager', 'owner') then raise exception 'Peran tidak dikenal.'; end if;
  select * into p from profiles where whatsapp = public._wa(p_phone) and deleted_at is null;
  if p.id is null then
    raise exception 'Nomor % belum pernah masuk. Minta orangnya masuk sekali di halaman kasir, lalu coba lagi.', trim(p_phone);
  end if;
  if p.id = me and p_role <> 'owner' then raise exception 'Anda tidak bisa mencabut akses pemilik dari akun sendiri.'; end if;
  -- Staff and managers keep their member card; only owner accounts can't hold stamps.
  if p_role = 'owner' and public._total(p.id) > 0 then
    raise exception 'Nomor ini punya stempel member. Akun pemilik perlu memakai nomor lain.';
  end if;
  update profiles set role = p_role where id = p.id;
  perform public._log('ubah_peran', jsonb_build_object('whatsapp', p.whatsapp, 'role', p_role));
end $$;

-- from schema.sql
create or replace function public._staff_username(p_name text) returns text
language sql immutable
as $$
  select left(case when array_length(w, 1) > 1 then w[1] || w[array_length(w, 1)] else w[1] end, 20)
  from (select regexp_split_to_array(lower(regexp_replace(trim(coalesce(p_name, '')), '[^A-Za-z ]', '', 'g')), '\s+') w) x
$$;

-- from schema.sql
create or replace function public._set_start_password(p_user uuid) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
begin
  update auth.users set encrypted_password = extensions.crypt('123456', extensions.gen_salt('bf')), updated_at = now()
  where id = p_user;
  update profiles set must_set_password = true where id = p_user;
end $$;

-- from schema.sql
create or replace function public.owner_add_staff(p_name text, p_username text, p_phone text, p_password text default null,
  p_role text default 'staff', p_employer text default 'Hanashuya') returns json
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  wa text := public._wa(p_phone); un text := public._clean_username(coalesce(nullif(trim(p_username), ''), public._staff_username(p_name)));
  emp text := coalesce(nullif(trim(p_employer), ''), 'Hanashuya'); p profiles; uid uuid; was_member boolean := false;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Isi nama lengkap staf.'; end if;
  if un is null or un !~ '^[a-z0-9._]{3,20}$' then raise exception 'Username 3 sampai 20 karakter: huruf, angka, titik, atau garis bawah.'; end if;
  if wa is null or wa !~ '^628[0-9]{8,12}$' then raise exception 'Nomor WhatsApp tidak valid. Contoh: 0812 3456 7890.'; end if;
  if p_role not in ('staff', 'manager', 'owner') then raise exception 'Peran tidak dikenal.'; end if;
  -- Staff and managers start with 123456; an owner account needs its own password.
  if p_role = 'owner' and length(coalesce(p_password, '')) < 8 then raise exception 'Akun pemilik perlu password minimal 8 karakter.'; end if;
  select * into p from profiles where whatsapp = wa order by deleted_at nulls first limit 1;
  if p.id is not null and p.deleted_at is null and p.role <> 'member' then raise exception 'Nomor ini sudah terdaftar sebagai staf.'; end if;
  if exists (select 1 from profiles where username = un and deleted_at is null and id is distinct from p.id) then
    raise exception 'Username % sudah dipakai. Tulis username lain.', un;
  end if;
  if p.id is not null then
    was_member := p.deleted_at is null;
    if p_role = 'owner' and was_member and public._total(p.id) > 0 then raise exception 'Nomor ini punya stempel member. Akun pemilik perlu memakai nomor lain.'; end if;
    update profiles set deleted_at = null, role = p_role, full_name = trim(p_name), username = un, adult_confirmed = true,
      employer = emp where id = p.id;
    update auth.users set banned_until = null where id = p.id;
    uid := p.id;
  else
    uid := public._create_login(wa, coalesce(p_password, '12345678'), un, trim(p_name));
    -- A staff card gets no new-member 50%; that voucher is for customers.
    update profiles set role = p_role, adult_confirmed = true, welcome_voucher = false, employer = emp where id = uid;
  end if;
  if p_role = 'owner' then perform public._set_password(uid, p_password);
  else perform public._set_start_password(uid); end if;
  perform public._log('tambah_staf', jsonb_build_object('whatsapp', wa, 'username', un, 'role', p_role, 'employer', emp, 'dari_kartu_member', was_member));
  return json_build_object('id', uid, 'whatsapp', wa, 'username', un, 'start_password', case when p_role <> 'owner' then '123456' end,
    'from_member', was_member);
end $$;

-- from schema.sql
create or replace function public.owner_set_birth_date(p_login text, p_birth_date date) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.'); p profiles := public._find_login(p_login);
begin
  if p.id is null or p.role not in ('member', 'staff', 'manager') then raise exception 'Akun member tidak ditemukan.'; end if;
  if p_birth_date is null then raise exception 'Isi tanggal lahir.'; end if;
  if age(current_date, p_birth_date) < interval '17 years' then raise exception 'Kartu member hanya untuk usia 17 tahun ke atas.'; end if;
  update profiles set birth_date = p_birth_date, age_range = public._age_range(p_birth_date) where id = p.id;
  perform public._log('ubah_tanggal_lahir', jsonb_build_object('member', p.id, 'dari', p.birth_date, 'jadi', p_birth_date));
end $$;

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

-- Pesanan atas nama (Glenn, 14 Nov 2026): the name staff type so they can call the customer
-- instead of a queue number. Kept on the order only (invoice, receipt, order history); it never
-- makes or changes a member.
alter table public.pos_orders add column if not exists customer_name text;
alter table public.pos_orders drop constraint if exists pos_orders_customer_name_check;
alter table public.pos_orders add constraint pos_orders_customer_name_check check (customer_name is null or length(customer_name) <= 40);

-- from pos.sql
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
    subtotal, discount, total, promo_kind, promo_label, payment_method, gender, age_range, flags, sold_at)
  values (oid, q->>'channel', rno, v_day, 'menunggu', staff, srv.id, m.id, tk.via,
    (q->>'subtotal')::int, (q->>'discount')::int, (q->>'total')::int, q#>>'{promo,kind}', q#>>'{promo,label}', null, g, a, f, now());
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

-- from pos-reservasi.sql
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

-- from attendance.sql
create or replace function public.att_my_profile() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._att_me('Halaman ini untuk akun staf.'); p profiles := public._att_staff(me); b att_profiles;
begin
  select * into b from att_profiles where staff_id = me;
  return json_build_object('full_name', p.full_name, 'whatsapp', p.whatsapp, 'username', p.username, 'role', p.role,
    'employer', p.employer, 'bank_name', b.bank_name, 'bank_account', b.bank_account, 'bank_holder', b.bank_holder, 'updated_at', b.updated_at,
    'locked', b.locked_at is not null,
    'request', (select json_build_object('id', r.id, 'changes', r.changes, 'reason', r.reason, 'status', r.status,
        'created_at', r.created_at, 'decided_at', r.decided_at, 'note', r.decision_note)
      from att_profile_requests r where r.staff_id = me and r.status <> 'dibatalkan'
        and (r.status = 'menunggu' or r.decided_at > now() - interval '14 days')
      order by r.created_at desc limit 1));
end $$;

-- from attendance.sql
create or replace function public.att_staff_list() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(json_build_object('id', p.id, 'name', public._first_name(p.full_name), 'full_name', p.full_name,
      'role', p.role, 'whatsapp', p.whatsapp, 'employer', p.employer, 'bank_name', b.bank_name, 'bank_account', b.bank_account, 'bank_holder', b.bank_holder,
      'is_me', p.id = me, 'device_bound', dv.staff_id is not null, 'device_label', dv.label,
      'device_bound_at', dv.bound_at, 'device_last_seen_at', dv.last_seen_at)
      order by p.full_name)
    from profiles p left join att_profiles b on b.staff_id = p.id left join att_devices dv on dv.staff_id = p.id
    where p.role in ('staff', 'manager') and p.deleted_at is null), '[]');
end $$;

-- Browsers may call the public functions, never the helpers.
revoke all on function public._staff_username(text), public._set_start_password(uuid), public._pos_create(uuid, jsonb),
  public._staff_conflict(uuid), public._vouchers(uuid) from public, anon, authenticated;
revoke all on function public.owner_add_staff(text, text, text, text, text, text) from public, anon;
grant execute on function public.owner_add_staff(text, text, text, text, text, text) to authenticated;
