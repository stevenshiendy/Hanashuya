-- DEMO DATA ONLY. Fills the owner dashboard with 60 days of made-up sales so you
-- can see how it looks. Every demo row is marked: numbers start with
-- 628000000 and receipts start with DEMO-.
-- Remove it all with supabase/seed-demo-remove.sql before real use.

do $$
declare
  staff_id uuid := gen_random_uuid();
  ids uuid[] := '{}';
  uid uuid;
  i int; d int; k int; n int;
  t timestamptz;
  items text[] := array['Signature 1 pc', 'Signature box isi 6', 'Mini choux box isi 8', 'Mini choux box isi 15'];
  prices int[] := array[20000, 120000, 68000, 120000];
  genders text[] := array['perempuan', 'perempuan', 'perempuan', 'laki-laki', 'laki-laki'];
  ages text[] := array['17-24', '17-24', '25-34', '25-34', '25-34', '35-44', '45+'];
  hours int[] := array[11, 12, 13, 15, 16, 16, 17, 18, 18, 19, 19, 19, 20, 20, 21];
  pick int; qty int; total int; mem uuid; rno int := 1;
begin
  insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', staff_id, 'authenticated', 'authenticated',
          '6280000000000@member.hanashuya.id', '6280000000000', '', now(), '{"provider":"phone","providers":["phone"]}', '{}', now(), now());
  update public.profiles set role = 'staff', full_name = 'Demo Staf', username = 'demostaf' where id = staff_id;

  for i in 1..40 loop
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
            '62800000001' || lpad(i::text, 2, '0') || '@member.hanashuya.id', '62800000001' || lpad(i::text, 2, '0'), '', now(), '{"provider":"phone","providers":["phone"]}', '{}',
            now() - make_interval(days => 60 - i), now());
    update public.profiles set
      full_name = 'Demo Member ' || lpad(i::text, 2, '0'), username = 'demo' || lpad(i::text, 2, '0'),
      birth_date = current_date - make_interval(years => 18 + (i * 7) % 35, days => i * 11),
      gender = genders[1 + (i % 5)], age_range = ages[1 + (i % 7)], adult_confirmed = true,
      created_at = now() - make_interval(days => 60 - i)
    where id = uid;
    ids := ids || uid;
  end loop;

  for d in 0..59 loop
    -- Weekends are busier.
    n := case when extract(isodow from now() - make_interval(days => d)) in (6, 7) then 9 else 5 end;
    for k in 1..n loop
      t := date_trunc('day', (now() - make_interval(days => d)) at time zone 'Asia/Jakarta')
           + make_interval(hours => hours[1 + floor(random() * 15)::int], mins => floor(random() * 60)::int);
      t := t at time zone 'Asia/Jakarta';
      continue when t > now();
      pick := case when random() < 0.45 then 1 when random() < 0.6 then 3 when random() < 0.8 then 2 else 4 end;
      qty := case when pick = 1 then 1 + floor(random() * 3)::int else 1 end;
      total := prices[pick] * qty;
      mem := case when random() < 0.55 then ids[1 + floor(random() * 40)::int] end;
      insert into public.sales (receipt_no, total, member_id, staff_id, stamps, items, gender, age_range, via, flags, created_at)
      values ('DEMO-' || lpad(rno::text, 5, '0'), total, mem, staff_id,
              case when mem is null then 0 else total / 50000 end,
              jsonb_build_array(jsonb_build_object('name', items[pick], 'qty', qty)),
              case when mem is null then genders[1 + floor(random() * 5)::int] end,
              case when mem is null then ages[1 + floor(random() * 7)::int] end,
              case when mem is null then null when random() < 0.9 then 'qr' else 'kode' end,
              case when mem is not null and random() < 0.06 then array['kode_diketik'] else '{}' end,
              t);
      rno := rno + 1;
    end loop;
  end loop;

  -- Member profiles hold gender and age, so copy them onto their sales.
  update public.sales s set gender = p.gender, age_range = p.age_range
  from public.profiles p where s.member_id = p.id and s.receipt_no like 'DEMO-%';
end $$;
