-- Start the shop's data fresh but KEEP every member (Glenn, 13 Nov 2026).
-- Run once in Supabase > SQL Editor. This cannot be undone: download a backup first
-- (back office > Pengaturan > Cadangan data).
--
-- Keeps: every account and its login (members, staff, managers, the owner, the kasir tablet
-- account), member profiles, promo consent records, saved voucher codes, settings, menu,
-- products, flavours, categories, channels and their prices, promos, rewards, campaigns,
-- stamp bonus periods, commission rules, stock items, recipes, suppliers, locations, the
-- chart of accounts, WhatsApp templates, shifts, staff schedules and staff profiles.
--
-- Clears (Glenn's picks):
--   * Members back to zero: all stamps, visit history, used rewards and used vouchers, so the
--     welcome voucher (within its 30 days) and birthday voucher can be used again. Saved paper
--     voucher codes stay saved on the member who saved them, and become usable again.
--   * Stock at 0: every stock move, goods in, count (opname), sample, request, transfer and
--     production. Stock levels are worked out from the moves, so they all start at 0; record a
--     Stok masuk or a stock opname with the real counts afterwards.
--   * Till and money: orders, payments, receipts numbers, shifts and drawer moves, cancellations
--     and refunds, pre-orders, commission payouts, BOGO days, all journals (Akunting).
--   * HR activity: attendance scans, leave, overtime and profile change requests.
--   * Scan tickets, undo requests, reset codes and the activity log.
--
-- Everything runs as one block: it either all happens or nothing does.

do $$
begin
  if not exists (select 1 from public.profiles where role = 'owner' and deleted_at is null) then
    raise exception 'Tidak ada akun pemilik. Jalankan _setup_owner dulu, lalu ulangi.';
  end if;

  -- Pre-orders, deposits and stamp corrections.
  if to_regclass('public.pos_reservations') is not null then
    delete from public.pos_deposits;
    delete from public.pos_reservation_items;
    delete from public.pos_reservations;
    delete from public.pos_reservation_counters;
    delete from public.stamp_adjustments;
  end if;

  -- Transfers between locations and production.
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

  -- Akunting: journals and their numbers. The chart of accounts stays.
  if to_regclass('public.acc_journals') is not null then
    delete from public.acc_lines;
    delete from public.acc_journals;
    delete from public.acc_counters;
  end if;

  -- Till: orders point at sales and redemptions, so they go first.
  if to_regclass('public.pos_orders') is not null then
    if to_regclass('public.pos_commission_payouts') is not null then delete from public.pos_commission_payouts; end if;
    if to_regclass('public.pos_order_payments') is not null then delete from public.pos_order_payments; end if;
    delete from public.pos_void_requests;
    delete from public.pos_cash_moves;
    delete from public.pos_order_items;
    delete from public.pos_orders;
    delete from public.pos_shifts;
    delete from public.pos_receipt_counters;
    delete from public.pos_bogo_days;
  end if;

  -- Stock ledger (append-only; a reset is the one exception), counts, goods in, samples.
  if to_regclass('public.stock_moves') is not null then
    alter table public.stock_moves disable trigger stock_moves_locked;
    delete from public.stock_moves;
    alter table public.stock_moves enable trigger stock_moves_locked;
    delete from public.stock_count_lines;
    delete from public.stock_counts;
    delete from public.stock_goods_in_changes;
    delete from public.stock_goods_in;
    if to_regclass('public.stock_samples') is not null then delete from public.stock_samples; end if;
    if to_regclass('public.stock_requests') is not null then
      delete from public.stock_request_lines;
      delete from public.stock_requests;
    end if;
  end if;

  -- HR activity. Schedules, shifts, staff profiles and registered phones stay.
  if to_regclass('public.att_events') is not null then
    if to_regclass('public.att_profile_requests') is not null then delete from public.att_profile_requests; end if;
    delete from public.att_overtime;
    delete from public.att_leave;
    delete from public.att_events;
  end if;

  -- Members back to zero: stamps, visits, rewards and vouchers used.
  delete from public.undo_requests;
  delete from public.scan_tickets;
  delete from public.redeem_codes;
  delete from public.redemptions;
  delete from public.card_cycles;
  delete from public.sales;
  delete from public.pos_receipts;
  delete from public.password_resets;
  delete from public.audit_log;

end $$;

-- What is left: accounts per role (members kept) and the activity tables (all should be 0).
select role, count(*) as akun from public.profiles where deleted_at is null group by role order by role;
select (select count(*) from public.sales) as penjualan,
       (select count(*) from public.redemptions) as hadiah_dipakai,
       (select count(*) from public.card_cycles) as kartu_penuh,
       (select count(*) from public.voucher_codes where claimed_by is not null) as kode_voucher_tersimpan;
