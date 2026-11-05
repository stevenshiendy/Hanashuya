-- Clears all test data before launch and keeps only the owner account(s).
-- Run once in the Supabase SQL Editor, after schema.sql.
--
-- Removes: every member and staff account (including demo ones), all sales,
-- redemptions, scan tickets, undo requests, imported POS receipts, reset codes,
-- consent records of removed accounts, and the audit log.
-- Keeps: the owner account, settings, rewards, menu and campaigns.
-- Then creates the demo member account: username hanashuya, password testingmantap88.
--
-- This cannot be undone. Do not run it after real members have signed up.

begin;

create temp table keep_ids on commit drop as
  select id from public.profiles where role = 'owner' and deleted_at is null;

do $$
begin
  if not exists (select 1 from keep_ids) then
    raise exception 'Tidak ada akun pemilik. Jalankan _setup_owner dulu, lalu ulangi.';
  end if;
end $$;

delete from public.undo_requests;
delete from public.scan_tickets;
delete from public.redeem_codes;
delete from public.redemptions;
delete from public.sales;
delete from public.pos_receipts;
delete from public.password_resets where user_id not in (select id from keep_ids);
delete from public.audit_log;

-- Consent records are normally append-only; this pre-launch cleanup is the one exception.
alter table public.consent_log disable trigger consent_log_append_only;
delete from public.consent_log where user_id not in (select id from keep_ids);
alter table public.consent_log enable trigger consent_log_append_only;

-- Removing the logins also removes their profiles.
delete from auth.users where id not in (select id from keep_ids);

-- Demo member account for showing the card. Sign in with "hanashuya" (or
-- 0800 0000 0088) and the password below. Its WhatsApp number is a placeholder.
do $$
declare uid uuid;
begin
  uid := public._create_login('6280000000088', 'testingmantap88', 'hanashuya', 'Hanashuya Demo');
  update public.profiles
     set birth_date = '2000-01-01', age_range = public._age_range('2000-01-01'), adult_confirmed = true
   where id = uid;
  perform public._record_consent(uid, 'dibuat pemilik', false);
end $$;

commit;

-- What is left: the owner(s) and the demo account.
select username, full_name, role, whatsapp from public.profiles order by role desc, username;
