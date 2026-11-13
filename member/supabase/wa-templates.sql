-- Hanashuya: WhatsApp message templates (12 Nov 2026, Glenn). Run AFTER pos-cash.sql
-- (it needs schema.sql; the other POS files are not required). Re-running is safe and
-- never overwrites templates the owner has edited.
--
-- There is no WhatsApp API. The owner keeps reusable texts here; the back office fills in
-- the member's details and opens a wa.me link, and the owner presses send in WhatsApp.
-- Placeholders: {nama} first name, {stempel} stamps on the current card, {hadiah} the next
-- card reward, {voucher} vouchers ready to use, {link_kartu} the member app address.
--   owner_wa_templates(p_only_active)   the list
--   owner_save_wa_template(...)         add (p_id null) or edit
--   owner_set_wa_template(p_id, p_active)
--   owner_wa_preview(p_template, p_member)  filled text + the member's number, logged
-- Owner only.

create table if not exists public.wa_templates (
  id int generated always as identity primary key,
  name text not null check (char_length(name) between 1 and 60),
  category text not null default 'umum' check (category in ('ulang_tahun', 'voucher', 'kartu', 'umum')),
  body text not null check (char_length(body) between 1 and 1000),
  active boolean not null default false,
  sort int not null default 100,
  updated_at timestamptz not null default now()
);
alter table public.wa_templates enable row level security;
revoke all on public.wa_templates from anon, authenticated;

-- Three drafts for Glenn to read and edit. Inactive until he switches them on. Only seeded
-- into an empty table, so edits and a later re-run never collide.
insert into public.wa_templates (name, category, body, active, sort)
select * from (values
  ('DRAFT Pengingat voucher ulang tahun', 'ulang_tahun',
   'Halo Kak {nama}, ada hadiah ulang tahun dari Hanashuya: 1 box Mini Choux isi 8. Bisa diambil di booth mulai 7 hari sebelum sampai 7 hari sesudah ulang tahun Kakak. Tinggal tunjukkan kartu member di {link_kartu} ke kasir. Ditunggu mampirnya.', false, 10),
  ('DRAFT Pengingat voucher member baru', 'voucher',
   'Halo Kak {nama}, hadiah member baru Kakak masih ada: diskon 50% untuk 1 produk, berlaku 30 hari sejak Kakak daftar. Tunjukkan kartu member ke kasir di booth Hanashuya, Papaya Fresh Gallery. Silahkan cobain Kak.', false, 20),
  ('DRAFT Link kartu member', 'kartu',
   'Halo Kak {nama}, stempel di kartu member Hanashuya Kakak sekarang {stempel}. Hadiah berikutnya: {hadiah}. Kartunya bisa dibuka di {link_kartu}', false, 30)
) as v(name, category, body, active, sort)
where not exists (select 1 from public.wa_templates);

-- ---------------------------------------------------------------- owner
create or replace function public.owner_wa_templates(p_only_active boolean default false) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
begin
  return coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name, 'category', t.category, 'body', t.body,
      'active', t.active, 'sort', t.sort, 'updated_at', t.updated_at) order by t.sort, t.id)
    from wa_templates t where t.active or not coalesce(p_only_active, false)), '[]');
end $$;

create or replace function public.owner_save_wa_template(p_id int, p_name text, p_category text, p_body text, p_sort int default null) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengubah template.'); n text := trim(coalesce(p_name, '')); b text := trim(coalesce(p_body, '')); r wa_templates;
begin
  if n = '' or char_length(n) > 60 then raise exception 'Isi nama template, paling banyak 60 huruf.'; end if;
  if b = '' then raise exception 'Isi teks pesannya.'; end if;
  if char_length(b) > 1000 then raise exception 'Teks paling banyak 1000 huruf.'; end if;
  if p_category is null or p_category not in ('ulang_tahun', 'voucher', 'kartu', 'umum') then raise exception 'Pilih kategori.'; end if;
  if p_id is null then
    insert into wa_templates (name, category, body, sort) values (n, p_category, b, coalesce(p_sort, 100)) returning * into r;
  else
    update wa_templates set name = n, category = p_category, body = b, sort = coalesce(p_sort, sort), updated_at = now() where id = p_id returning * into r;
    if r.id is null then raise exception 'Template tidak ditemukan.'; end if;
  end if;
  perform public._log('wa_template_simpan', jsonb_build_object('id', r.id, 'name', r.name, 'new', p_id is null));
  return json_build_object('id', r.id, 'name', r.name, 'category', r.category, 'body', r.body, 'active', r.active, 'sort', r.sort);
end $$;

create or replace function public.owner_set_wa_template(p_id int, p_active boolean) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengubah template.'); r wa_templates;
begin
  update wa_templates set active = coalesce(p_active, false), updated_at = now() where id = p_id returning * into r;
  if r.id is null then raise exception 'Template tidak ditemukan.'; end if;
  perform public._log('wa_template_aktif', jsonb_build_object('id', r.id, 'active', r.active));
  return json_build_object('id', r.id, 'active', r.active);
end $$;

-- The text for one member, ready to send. The member's number comes back with it.
create or replace function public.owner_wa_preview(p_template int, p_member uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  t wa_templates; p profiles; txt text; cv record; nxt text; vch text; num text;
begin
  select * into t from wa_templates where id = p_template;
  if t.id is null then raise exception 'Template tidak ditemukan.'; end if;
  select * into p from profiles where id = p_member and role = 'member' and deleted_at is null;
  if p.id is null then raise exception 'Member tidak ditemukan.'; end if;
  num := regexp_replace(coalesce(p.whatsapp, ''), '\D', '', 'g');
  if num = '' then raise exception 'Member ini belum punya nomor WhatsApp.'; end if;
  select * into cv from public._card_view(p.id);
  select r.label || ' di stempel ke-' || r.slot into nxt from public._rewards(p.id) r where r.status = 'terkunci' order by r.cycle, r.slot limit 1;
  select string_agg(v.label, ', ' order by v.ends_on nulls last) into vch from public._vouchers(p.id) v where v.status = 'tersedia';
  txt := t.body;
  txt := replace(txt, '{nama}', public._first_name(p.full_name));
  txt := replace(txt, '{stempel}', coalesce(cv.card_position, 0)::text);
  txt := replace(txt, '{hadiah}', coalesce(nxt, 'semua hadiah di kartu ini sudah terbuka'));
  txt := replace(txt, '{voucher}', coalesce(vch, 'belum ada voucher'));
  txt := replace(txt, '{link_kartu}', 'https://hanashuya.vercel.app/member/');
  perform public._log('wa_template_dipakai', jsonb_build_object('template', t.id, 'member', p.id));
  return json_build_object('text', txt, 'whatsapp', num, 'name', public._first_name(p.full_name), 'template', t.name);
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('owner_wa_templates', 'owner_save_wa_template', 'owner_set_wa_template', 'owner_wa_preview')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
