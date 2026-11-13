-- Nota antrian (Glenn, 14 Nov 2026): a small slip the till prints after payment with the name
-- staff typed ("Pesanan atas nama Kak …"), so they can call the customer when the order is ready.
-- The owner turns it on or off for the booth (Pengaturan > Nota antrian); each till tablet can
-- also turn it off for itself (Printer screen, kept on the tablet). It prints only when both are on.
-- Run after pos.sql (and staff-akun.sql). Re-runnable.

alter table public.settings add column if not exists queue_slip boolean not null default false;

-- For the till: is the nota antrian on for the booth?
create or replace function public.pos_queue_slip() returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
begin
  return coalesce((select queue_slip from settings where id = 1), false);
end $$;

-- Owner only: turn it on or off.
create or replace function public.owner_set_queue_slip(p_on boolean) returns boolean
language plpgsql volatile security definer set search_path = public
as $$
declare me uuid := public._require(array['owner'], 'Hanya pemilik yang bisa mengubah pengaturan ini.');
begin
  update settings set queue_slip = coalesce(p_on, false) where id = 1;
  perform public._log('nota_antrian', jsonb_build_object('aktif', coalesce(p_on, false)));
  return coalesce(p_on, false);
end $$;

revoke all on function public.pos_queue_slip() from public, anon;
revoke all on function public.owner_set_queue_slip(boolean) from public, anon;
grant execute on function public.pos_queue_slip() to authenticated;
grant execute on function public.owner_set_queue_slip(boolean) to authenticated;
