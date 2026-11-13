-- Hanashuya POS: Rekap kas for the owner (11 Nov 2026, Glenn). Run AFTER pos-backoffice.sql
-- (it needs schema.sql and pos.sql). Re-running is safe. No new tables.
--
-- The till side (blind cash, continuous shifts, pos_shift_rekap, pos_rekap_printed,
-- pos_rekap_exported, setor) lives in pos.sql. This file adds the owner's list and settings:
--   owner_cash_shifts(p_from, p_to)     every shift with modal, expected, counted, selisih, setor,
--                                       flags and print status, plus the cash settings.
--   owner_save_cash_settings(p_float, p_flag_at)  Modal standar laci (the first shift's modal and
--                                       the level the drawer is checked against) and the selisih
--                                       that gets flagged. Owner only.

-- ---------------------------------------------------------------- owner
create or replace function public.owner_cash_shifts(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.'); s settings := public._cfg();
begin
  if p_from is null or p_to is null or p_to < p_from then raise exception 'Pilih rentang tanggal.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang paling lama 400 hari.'; end if;
  return json_build_object(
    'settings', json_build_object('cash_float', s.cash_float, 'cash_flag_at', s.cash_flag_at),
    'shifts', coalesce((select json_agg(x order by x.opened_at desc) from (
      select sh.id, sh.opened_at, sh.closed_at, sh.device, sh.float_source, sh.flags, sh.note,
        (select public._first_name(full_name) from profiles where id = sh.opened_by) as opened_by,
        (select public._first_name(full_name) from profiles where id = sh.closed_by) as closed_by,
        (select count(*) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar') as orders,
        coalesce((select sum(o.total) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar'), 0) as sales_total,
        -- Tunai and QRIS from pos_order_payments (13 Nov 2026): a Bayar 2 cara order adds each part.
        coalesce((select sum(p.amount) from pos_order_payments p join pos_orders o on o.id = p.order_id
                   where o.shift_id = sh.id and o.status = 'dibayar' and p.method = 'qris'), 0) as qris,
        coalesce((select sum(p.amount) from pos_order_payments p join pos_orders o on o.id = p.order_id
                   where o.shift_id = sh.id and o.status = 'dibayar' and p.method = 'tunai'), 0) as tunai,
        (select count(*) from pos_orders o where o.shift_id = sh.id and o.status = 'dibayar' and o.payment_method = 'campur') as split_count,
        coalesce((select sum(coalesce(v.amount, o.total)) from pos_void_requests v join pos_orders o on o.id = v.order_id
                   where o.shift_id = sh.id and v.kind = 'refund' and v.status = 'disetujui'), 0) as refunded,
        sh.opening_cash, coalesce(sh.expected_cash, public._pos_expected_cash(sh.id)) as expected_cash, sh.counted_cash,
        sh.counted_cash - sh.expected_cash as difference, sh.printed_at, sh.reprints,
        coalesce((select sum(amount) from pos_cash_moves c where c.shift_id = sh.id and c.kind = 'setor'), 0) as setor
      from pos_shifts sh
      where public._local(sh.opened_at)::date between p_from and p_to) x), '[]'));
end $$;

create or replace function public.owner_save_cash_settings(p_float int, p_flag_at int) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengubah uang modal laci.');
begin
  if p_float is null or p_float < 0 or p_float > 10000000 then raise exception 'Isi uang modal laci, paling banyak Rp10.000.000.'; end if;
  if p_flag_at is null or p_flag_at < 0 or p_flag_at > 1000000 then raise exception 'Isi batas selisih yang ditandai.'; end if;
  update settings set cash_float = p_float, cash_flag_at = p_flag_at where id = 1;
  perform public._log('pos_atur_kas', jsonb_build_object('cash_float', p_float, 'cash_flag_at', p_flag_at));
  return json_build_object('cash_float', p_float, 'cash_flag_at', p_flag_at);
end $$;

-- ---------------------------------------------------------------- permissions
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('owner_cash_shifts', 'owner_save_cash_settings')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if left(f.proname, 1) = '_' then
      execute format('revoke all on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
