-- Start fresh after the booth testing phase (written 11 Nov 2026).
-- Run once in Supabase > SQL Editor, after schema.sql. This cannot be undone: download a
-- backup first (owner dashboard > Pengaturan > Cadangan data) if you want to keep a copy.
--
-- Removes: every member account (and its login), all sales and stamps, used rewards and
-- vouchers, filled-card records, scan tickets, undo requests, imported VireoPOS receipts,
-- reset codes, consent records of removed accounts, and the activity log.
-- Resets: every printed voucher code back to unused, so the vouchers already printed
-- (and the extra codes) still work for real customers.
-- Keeps: the owner, manager and staff accounts with their passwords, settings, rewards, menu,
-- campaigns and the voucher batches and codes themselves.
--
-- POS (12 Nov 2026), only when its files have been run: removes test orders, payments,
-- shifts, cash moves, voids and the day's receipt numbers; all stock moves, goods in and
-- counts; attendance scans, leave and overtime. Keeps products, flavours, channels, stock
-- items and recipes, shift options, staff schedules and staff profiles (bank details).
--
-- Everything runs as one block, so it either all happens or nothing does.

do $$
begin
  if not exists (select 1 from public.profiles where role = 'owner' and deleted_at is null) then
    raise exception 'Tidak ada akun pemilik. Jalankan _setup_owner dulu, lalu ulangi.';
  end if;

  -- Pre-orders, their DP ledger and stamp corrections (pos-reservasi.sql, 12 Nov 2026).
  if to_regclass('public.pos_reservations') is not null then
    delete from public.pos_deposits;
    delete from public.pos_reservation_items;
    delete from public.pos_reservations;
    delete from public.pos_reservation_counters;
    delete from public.stamp_adjustments;
  end if;
  -- Transfers between locations and production (pos-produksi.sql, 12 Nov 2026). Locations and
  -- production recipes stay.
  if to_regclass('public.stock_loc_moves') is not null then
    delete from public.stock_move_docs;
    alter table public.stock_loc_moves disable trigger stock_loc_moves_locked;
    delete from public.stock_loc_moves;
    alter table public.stock_loc_moves enable trigger stock_loc_moves_locked;
    delete from public.stock_transfer_receipt_lines;
    delete from public.stock_transfer_receipts;
    delete from public.stock_shipment_lines;
    delete from public.stock_shipments;
    delete from public.stock_transfer_lines;
    delete from public.stock_transfers;
    delete from public.stock_production_lines;
    delete from public.stock_productions;
    delete from public.stock_doc_counters;
  end if;

  -- POS first, because orders point at sales and redemptions.
  if to_regclass('public.pos_orders') is not null then
    delete from public.pos_void_requests;
    delete from public.pos_cash_moves;
    delete from public.pos_order_items;
    delete from public.pos_orders;
    delete from public.pos_shifts;
    delete from public.pos_receipt_counters;
  end if;
  if to_regclass('public.stock_moves') is not null then
    -- The stock ledger is normally append-only; clearing test data is the one exception.
    alter table public.stock_moves disable trigger stock_moves_locked;
    delete from public.stock_moves;
    alter table public.stock_moves enable trigger stock_moves_locked;
    delete from public.stock_count_lines;
    delete from public.stock_counts;
    delete from public.stock_goods_in_changes;
    delete from public.stock_goods_in;
    -- Samples rung up in Mode penjualan (12 Nov 2026). Suppliers, bonus periods and commission rules stay.
    if to_regclass('public.stock_samples') is not null then delete from public.stock_samples; end if;
    if to_regclass('public.stock_requests') is not null then
      delete from public.stock_request_lines;
      delete from public.stock_requests;
    end if;
  end if;
  if to_regclass('public.att_events') is not null then
    if to_regclass('public.att_profile_requests') is not null then delete from public.att_profile_requests; end if;
    delete from public.att_overtime;
    delete from public.att_leave;
    delete from public.att_events;
  end if;

  delete from public.undo_requests;
  delete from public.scan_tickets;
  delete from public.redeem_codes;
  delete from public.redemptions;
  delete from public.card_cycles;
  delete from public.sales;
  delete from public.pos_receipts;
  delete from public.password_resets;
  delete from public.audit_log;
  update public.voucher_codes set claimed_by = null, claimed_at = null, claimed_via = null;

  -- Consent records are normally append-only; clearing test members is the one exception.
  if to_regclass('public.welcome_given') is not null then delete from public.welcome_given; end if;
  alter table public.consent_log disable trigger consent_log_append_only;
  delete from public.consent_log
   where user_id not in (select id from public.profiles where role in ('owner', 'manager', 'staff'));
  alter table public.consent_log enable trigger consent_log_append_only;

  -- Removing the logins also removes their profiles. Staff and manager accounts stay; to
  -- remove them too, change ('owner', 'manager', 'staff') to ('owner') on the next line.
  delete from auth.users
   where id not in (select id from public.profiles where role in ('owner', 'manager', 'staff'));
end $$;

-- What is left: accounts, and the voucher codes (all should show 0 saved and 0 used).
select role, count(*) as accounts from public.profiles group by role order by role;
select (select count(*) from public.sales) as sales,
       (select count(*) from public.redemptions) as rewards_used,
       (select count(*) from public.voucher_codes) as voucher_codes,
       (select count(*) from public.voucher_codes where claimed_by is not null) as codes_saved;
