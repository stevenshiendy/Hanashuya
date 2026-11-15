-- Hari member (Glenn, 15 Nov 2026). Run after pos.sql and wa-templates.sql. Re-running is safe.
--   Selasa Member      every Tuesday, diskon 15% for the whole purchase (paper bag excluded),
--                      members only. One promo per order (SOP): it is one of the promos on the
--                      till, picked by itself when the card has no other reward or voucher ready.
--   Rabu Akhir Bulan   the last Wednesday of each month, member stamps 2x (a stamp bonus period
--                      with last_week on).
-- Both are ordinary rows the owner can switch off or change in the owner page (Promo POS,
-- Bonus stempel). member_days() lets the member card show them.

insert into public.pos_promos (name, kind, value, products, days, member_only, note, seed_key)
values ('Selasa Member', 'persen', 15, null, array[2], true, 'Hari member: setiap Selasa, semua belanja', 'selasa_member')
on conflict (seed_key) where seed_key is not null do nothing;

-- A bonus period is at most a year (owner_save_stamp_boost); the owner extends it from Bonus stempel.
insert into public.stamp_boosts (name, starts_on, ends_on, days, multiplier, active, note, last_week, seed_key)
values ('Rabu Akhir Bulan', public._local(now())::date, public._local(now())::date + 365, array[3], 2, true,
        'Hari member: Rabu terakhir setiap bulan', true, 'rabu_akhir_bulan')
on conflict (seed_key) where seed_key is not null do nothing;

-- The member days a signed-in member sees on the card: each running member promo with set weekdays
-- and each running stamp bonus, with the next day it applies (today included) within 6 weeks.
create or replace function public.member_days() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['member', 'staff', 'manager', 'owner'], 'Masuk dulu untuk melihat hari member.');
  t date := public._local(now())::date;
begin
  return coalesce((select json_agg(x order by x.next_on, x.name) from (
    select 'promo' as kind, cp.name,
           case when cp.kind = 'persen' then 'Diskon ' || cp.value || '%' else 'Potongan ' || public._rp(cp.value) end
             || case when cp.products is null or cardinality(cp.products) = 0 then ' untuk semua belanja' else '' end as label,
           (select min(d)::date from generate_series(t, t + 42, interval '1 day') d
             where extract(isodow from d)::int = any (cp.days)
               and (cp.starts_on is null or d >= cp.starts_on) and (cp.ends_on is null or d <= cp.ends_on)) as next_on
      from pos_promos cp
     where cp.active and cp.member_only and cp.code is null and cp.days is not null and cardinality(cp.days) > 0
       and cp.time_from is null and cp.quota is null and cp.per_member is null
    union all
    select 'stempel', b.name, 'Stempel ' || b.multiplier || 'x',
           (select min(d)::date from generate_series(greatest(t, b.starts_on), least(b.ends_on, t + 42), interval '1 day') d
             where (b.days is null or cardinality(b.days) = 0 or extract(isodow from d)::int = any (b.days))
               and (not b.last_week or extract(month from d::date + 7) <> extract(month from d::date)))
      from stamp_boosts b
     where b.active and b.ends_on >= t) x
    where x.next_on is not null), '[]');
end $$;

revoke all on function public.member_days() from public, anon;
grant execute on function public.member_days() to authenticated;

-- WhatsApp templates (Glenn's picks, 15 Nov 2026). Saved as active; the owner can edit them in
-- Member > Template WhatsApp. "kak" is lowercase when it stands alone and capital before a name.
alter table public.wa_templates add column if not exists seed_key text;
create unique index if not exists wa_templates_seed_key on public.wa_templates (seed_key) where seed_key is not null;
insert into public.wa_templates (name, category, body, active, sort, seed_key) values
  ('Kangen mampir', 'umum',
   E'Kak {nama}, kami kangen nih.\n\nSudah lama Kakak nggak mampir ke booth Hanashuya, dan kartu member Kakak juga kangen distempel. Sekarang di *{stempel}* stempel, hadiah berikutnya _{hadiah}_.\n\nChoux kami masih dibuat baru setiap hari, di Papaya Fresh Gallery area sushi, 08.00–21.00.\n\nSampai bertemu kembali kak!', true, 1, 'wa_kangen'),
  ('Selamat datang member', 'kartu',
   E'Makasih sudah jadi member Hanashuya Kak {nama}!\n\nKartu Kakak: {link_kartu}\n\n*Cara kerjanya*\n- Setiap belanja Rp50.000 dapat 1 stempel\n- Stempel ke-3: diskon 10%\n- Stempel ke-7: diskon 20%\n- Stempel ke-10: gratis 1 produk\n\nSimpan kartunya ke layar utama HP biar tinggal buka di kasir.\n\nSampai bertemu kembali kak!', true, 2, 'wa_welcome'),
  ('Voucher nganggur', 'voucher',
   E'Kak {nama}, voucher Kakak masih nganggur nih.\n\n*{voucher}*\nBerlaku sampai _{voucher_sampai}_. Sayang kalau sampai hangus.\n\nTunjukkan kartu member di kasir: {link_kartu}\n\nSampai bertemu kembali kak!', true, 3, 'wa_voucher'),
  ('Besok Selasa Member', 'umum',
   E'Besok *Selasa Member* Kak {nama}!\n\nDiskon 15% untuk semua belanja, khusus member. Otomatis terpasang di kartu Kakak, tinggal tunjukkan QR di kasir.\n\nKartu Kakak: {link_kartu}\n\nSampai bertemu kembali kak!', true, 4, 'wa_selasa'),
  ('Besok Rabu Akhir Bulan', 'umum',
   E'Besok *Rabu Akhir Bulan* Kak {nama}!\n\nSetiap belanja member dapat stempel 2x. Kartu Kakak sekarang di *{stempel}* stempel, hadiah berikutnya _{hadiah}_.\n\nKartu Kakak: {link_kartu}\n\nSampai bertemu kembali kak!', true, 5, 'wa_rabu'),
  ('Ulang tahun', 'ulang_tahun',
   E'Selamat ulang tahun Kak {nama}!\n\nTerima kasih sudah jadi bagian dari cerita kecil Hanashuya. Di hari spesial Kakak, kami siapkan *1 box Mini Choux isi 8*, gratis, untuk dinikmati bareng orang-orang tersayang.\n\nBisa diambil di booth sampai _{voucher_sampai}_. Tinggal tunjukkan kartu member di kasir: {link_kartu}\n\nSemoga tahun ini penuh hal manis.\nSampai bertemu kembali kak!', true, 6, 'wa_ultah'),
  ('Link kartu member', 'kartu',
   E'Halo Kak {nama}, ini kartu member Hanashuya Kakak:\n{link_kartu}\n\n*Biar nggak dicari-cari*\n1. Buka link di atas\n2. Pilih _Tambahkan ke Layar Utama_\n3. Di kasir, tunjukkan QR-nya\n\nStempel sekarang: *{stempel}*', true, 7, 'wa_link')
on conflict (seed_key) where seed_key is not null do nothing;
