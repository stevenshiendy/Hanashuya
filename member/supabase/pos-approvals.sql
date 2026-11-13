-- Hanashuya POS: manager approvals (task 6a). Run after schema.sql and pos.sql. Safe to re-run.
-- The cashier page's "Persetujuan" tab lists member-app undo requests here (manager_pending_undo)
-- and POS voids/refunds through pos_void_list (pos.sql). Deciding goes through owner_decide_undo
-- (schema.sql) and pos_decide_void (pos.sql), both of which already accept manager and owner.

create or replace function public.manager_pending_undo() returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._require(array['manager', 'owner'], 'Hanya pemilik atau manajer.');
begin
  return coalesce((select json_agg(u order by u.created_at) from (
    select u.id, u.reason, u.created_at, rq.full_name as requested_by,
      case when u.sale_id is not null then 'penjualan' else 'penukaran' end as kind,
      coalesce(sa.receipt_no, '') as receipt_no, sa.total, sa.stamps, d.reward_label,
      public._first_name(coalesce(ms.full_name, md.full_name)) as member
    from undo_requests u
    left join profiles rq on rq.id = u.requested_by
    left join sales sa on sa.id = u.sale_id left join profiles ms on ms.id = sa.member_id
    left join redemptions d on d.id = u.redemption_id left join profiles md on md.id = d.member_id
    where u.status = 'menunggu') u), '[]');
end $$;

-- ---------------------------------------------------------------- permissions
revoke all on function public.manager_pending_undo() from public, anon;
grant execute on function public.manager_pending_undo() to authenticated;
