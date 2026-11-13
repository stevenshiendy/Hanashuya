-- Staff accounts and weekly schedule (Glenn, 13 Nov 2026). Run once in the Supabase SQL
-- Editor, after staff-akun.sql. Safe to run again: it updates the same four accounts.
--
-- For each person it uses, in this order: the account that already has their WhatsApp
-- number (a member card becomes their staff account, stamps kept), else the staff account
-- already made under their first name or nickname (Kevin, Ranny, Fajar, Yuya), else a new
-- account. Then it sets the full name, the username FrontLastname (logins ignore case),
-- the starting password 123456 (changed on first sign-in at /staf), who they work for,
-- and replaces their weekly schedule with "SHIFT KJ 2" (the same every week). One-off
-- date changes and approved leave are kept.
--
-- The last select lists what happened to each person.

drop table if exists _seed_staff;
create temporary table _seed_staff (
  ord int, full_name text, username text, phone text, employer text, aliases text[], week jsonb, result text
);

-- week: Senin (1) .. Minggu (7); each day a list of blocks [kind, start, end, shift].
insert into _seed_staff values
(1, 'Rany Marlina', 'RanyMarlina', '089659420233', 'Hanashuya', array['rany', 'ranny'], '{
  "1": [["kerja","11:00","21:00","Fulltime 2"]], "2": [["kerja","08:00","18:00","Fulltime 1"]], "3": [["libur"]],
  "4": [["kerja","11:00","21:00","Fulltime 2"]], "5": [["kerja","08:00","18:00","Fulltime 1"]],
  "6": [["kerja","08:00","18:00","Fulltime 1"]], "7": [["kerja","11:00","21:00","Fulltime 2"]]}', null),
(2, 'Fajar Prihantoro', 'FajarPrihantoro', '082264203643', 'Hanashuya', array['fajar'], '{
  "1": [["libur"]], "2": [["kerja","11:00","21:00","Fulltime 2"]], "3": [["kerja","08:00","18:00","Fulltime 1"]],
  "4": [["kerja","11:00","21:00","Fulltime 2"]], "5": [["kerja","08:00","18:00","Fulltime 1"]],
  "6": [["kerja","11:00","21:00","Fulltime 2"]], "7": [["kerja","08:00","18:00","Fulltime 1"]]}', null),
(3, 'Kevin Hadiyan', 'KevinHadiyan', '081222722344', 'Kaaramel Juice', array['kevin'], '{
  "1": [["kerja","18:00","21:00",null], ["kuliah","08:00","18:00",null]],
  "2": [["kerja","15:00","21:00","Parttime 2"], ["kuliah","08:00","12:00",null]],
  "3": [["kerja","08:00","11:00",null], ["kerja","18:00","21:00",null], ["kuliah","12:00","16:00",null]],
  "4": [["libur"]],
  "5": [["kerja","15:00","21:00","Parttime 2"], ["kuliah","08:00","11:00",null]],
  "6": [["kerja","08:00","14:00","Parttime 1"]], "7": [["kerja","15:00","21:00","Parttime 2"]]}', null),
(4, 'Eoudia Samulla Vidiani', 'EoudiaVidiani', '081255661811', 'Kaaramel Juice', array['eoudia', 'yuya'], '{
  "1": [["kerja","08:00","18:00","Fulltime 1"]], "2": [["libur"]], "3": [["kerja","11:00","21:00","Fulltime 2"]],
  "4": [["kerja","08:00","18:00","Fulltime 1"]], "5": [["kerja","11:00","21:00","Fulltime 2"]],
  "6": [["kerja","11:00","21:00","Fulltime 2"]], "7": [["kerja","08:00","18:00","Fulltime 1"]]}', null);

do $$
declare
  r record; wa text; un text; by_phone profiles; by_name profiles; n int; uid uuid; note text; d text; b jsonb;
begin
  for r in select * from _seed_staff order by ord loop
    wa := public._wa(r.phone); un := public._clean_username(r.username); note := '';
    by_phone := null; by_name := null; uid := null;
    select * into by_phone from profiles where whatsapp = wa and deleted_at is null;
    select count(*) into n from profiles
     where role in ('staff', 'manager') and deleted_at is null and lower(public._first_name(full_name)) = any (r.aliases);
    if n = 1 then
      select * into by_name from profiles
       where role in ('staff', 'manager') and deleted_at is null and lower(public._first_name(full_name)) = any (r.aliases);
    end if;

    if by_phone.id is not null then
      if by_phone.role in ('owner', 'kasir') then
        update _seed_staff set result = 'DILEWATI: nomor ini dipakai akun pemilik atau kasir tablet' where ord = r.ord;
        continue;
      end if;
      uid := by_phone.id;
      note := case by_phone.role when 'member' then 'kartu member dijadikan akun staf (stempel tetap)' else 'akun staf yang ada diperbarui' end;
      if by_name.id is not null and by_name.id <> uid then
        note := note || format('; PERIKSA: ada akun staf lain bernama %s (username %s) yang tidak diubah', by_name.full_name, by_name.username);
      end if;
    elsif by_name.id is not null then
      uid := by_name.id;
      -- A work account that was never a customer's card gets no new-member 50%.
      update profiles set whatsapp = wa, welcome_voucher = false where id = uid;
      note := 'akun staf ' || coalesce(by_name.username, by_name.full_name) || ' diperbarui';
    else
      if n > 1 then note := 'PERIKSA: lebih dari satu staf dengan nama depan ini; '; end if;
      uid := public._create_login(wa, '12345678', un, r.full_name);
      update profiles set welcome_voucher = false where id = uid;
      note := note || 'akun baru';
    end if;

    if exists (select 1 from profiles where username = un and id <> uid and deleted_at is null) then
      update _seed_staff set result = 'GAGAL: username ' || r.username || ' sudah dipakai akun lain' where ord = r.ord;
      continue;
    end if;
    update profiles
       set full_name = r.full_name, username = un, employer = r.employer, adult_confirmed = true,
           role = case when role = 'manager' then 'manager' else 'staff' end
     where id = uid;
    perform public._set_start_password(uid);

    delete from att_schedule where staff_id = uid and weekday is not null;
    for d in select jsonb_object_keys(r.week) loop
      for b in select * from jsonb_array_elements(r.week -> d) loop
        insert into att_schedule (staff_id, weekday, kind, start_time, end_time, shift, note)
        values (uid, d::smallint, b->>0, (b->>1)::time, (b->>2)::time, nullif(b->>3, ''), '');
      end loop;
    end loop;

    perform public._log('tambah_staf', jsonb_build_object('whatsapp', wa, 'username', un, 'employer', r.employer, 'via', 'staff-13nov.sql'));
    update _seed_staff set result = note where ord = r.ord;
  end loop;
end $$;

select s.full_name as "Nama", s.username as "Username", '123456' as "Password awal", s.employer as "Bekerja untuk",
       s.result as "Hasil",
       (select count(*) from att_schedule a join profiles p on p.id = a.staff_id
         where p.username = lower(s.username) and a.weekday is not null) as "Baris jadwal"
  from _seed_staff s order by s.ord;
