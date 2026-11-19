-- ubah-pesanan.sql (19 Nov 2026, Glenn: "a change in order doesn't need to be flagged").
-- Ubah pesanan closes the unpaid invoice as batal and the till confirms the changed order under a new
-- number. Those closed invoices no longer show as "Dibatalkan" on the till's Hari ini list, in the
-- owner's Pesanan list or in Pembatalan penjualan. They stay in pos_orders and in audit_log
-- (pos_ubah_pesanan). Real cancellations and refunds still show.
-- Run once in the SQL Editor after the other POS files. pos.sql, pos-backoffice.sql and
-- pos-transaksi.sql hold the same changes, so re-running those later keeps them.

alter table public.pos_orders add column if not exists replaced_at timestamptz;

-- Orders already edited before today's change, found in the log.
update public.pos_orders o set replaced_at = a.created_at
  from public.audit_log a
 where a.action = 'pos_ubah_pesanan' and a.detail->>'order' = o.id::text
   and o.status = 'batal' and o.replaced_at is null;

create or replace function public.pos_edit_order(p_id uuid) returns json
language plpgsql volatile security definer set search_path = public
as $$
declare
  me uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
  o pos_orders;
begin
  select * into o from pos_orders where id = p_id for update;
  if o.id is null then raise exception 'Pesanan tidak ditemukan.'; end if;
  if o.status <> 'menunggu' then raise exception 'Pesanan % sudah dibayar, jadi tidak bisa diubah.', o.receipt_no; end if;
  if o.cashier_id is distinct from me
     and not exists (select 1 from profiles where id = me and role in ('manager', 'owner')) then
    raise exception 'Pesanan ini dikonfirmasi kasir lain.';
  end if;
  if exists (select 1 from pos_void_requests v where v.order_id = o.id and v.status = 'menunggu') then
    raise exception 'Pesanan ini sedang menunggu keputusan batal dari manajer.';
  end if;
  update pos_orders set status = 'batal', replaced_at = now() where id = o.id;
  update redemptions set reversed_at = now(), reversed_by = me where order_id = o.id and reversed_at is null;
  if o.member_id is not null then perform public._sync_cycles(o.member_id); end if;
  perform public._log('pos_ubah_pesanan', jsonb_build_object('order', o.id, 'receipt', o.receipt_no, 'reason', 'Diubah sebelum dibayar'));
  return json_build_object('ok', true, 'receipt_no', o.receipt_no);
end $$;

create or replace function public.pos_today() returns json
language plpgsql stable security definer set search_path = public
as $$
declare staff uuid := public._require(array['staff', 'owner'], public._pos_staff_msg());
begin
  return coalesce((select json_agg(x order by x.sold_at desc) from (
    select o.id, o.receipt_no, o.sold_at, o.total, o.payment_method, o.status, o.stamps, o.promo_label, o.note, o.refunded, o.customer_name,
      public._first_name(sp.full_name) as served_by,
      case when o.member_id is not null then public._first_name(mp.full_name) end as member,
      exists (select 1 from pos_void_requests v where v.order_id = o.id and v.status = 'menunggu') as void_pending
    from pos_orders o left join profiles sp on sp.id = o.served_by left join profiles mp on mp.id = o.member_id
    where o.outlet_id = 'papaya-bdg' and o.sale_day = public._local(now())::date and o.replaced_at is null) x), '[]');
end $$;

create or replace function public.owner_pos_orders(p_from date, p_to date, p_q text default null, p_status text default null) returns json
language plpgsql stable security definer set search_path = public
as $$
declare
  me uuid := public._require(array['owner'], 'Halaman ini hanya untuk pemilik.');
  d1 date := coalesce(p_from, public._local(now())::date); d2 date := coalesce(p_to, public._local(now())::date);
  q text := nullif(lower(trim(coalesce(p_q, ''))), ''); st text := nullif(nullif(coalesce(p_status, ''), ''), 'semua'); digits text;
begin
  if d2 < d1 then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  if d2 - d1 > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
  if st is not null and st not in ('dibayar', 'menunggu', 'batal') then raise exception 'Status tidak dikenal.'; end if;
  digits := nullif(regexp_replace(coalesce(q, ''), '\D', '', 'g'), '');
  return json_build_object(
    'rows', coalesce((select json_agg(x order by x.sold_at desc) from (
      select o.id, o.receipt_no, o.local_no, o.sold_at, o.status, o.total, o.discount, o.payment_method, o.promo_label, o.stamps,
             -- Service charge and PBJT apart from the goods (14 Nov 2026); total is what the buyer paid.
             o.subtotal - o.discount as sales, o.service_charge, o.tax, o.tax_included,
             public._first_name(mb.full_name) as member, public._first_name(sv.full_name) as served_by,
             (select string_agg(i.qty || '× ' || i.name || coalesce(' ' || f.label, ''), ', ' order by i.line)
                from pos_order_items i left join pos_flavours f on f.id = i.flavour_id where i.order_id = o.id and not i.free_bag) as items,
             exists (select 1 from pos_void_requests v where v.order_id = o.id and v.status = 'menunggu') as void_pending
        from pos_orders o
        left join profiles mb on mb.id = o.member_id
        left join profiles sv on sv.id = o.served_by
       where o.sale_day between d1 and d2 and o.replaced_at is null
         and (st is null or (st = 'batal' and o.status in ('batal', 'refund')) or o.status = st)
         and (q is null or lower(o.receipt_no) like '%' || q || '%' or lower(coalesce(o.local_no, '')) like '%' || q || '%' or lower(coalesce(mb.full_name, '')) like '%' || q || '%'
              or lower(coalesce(sv.full_name, '')) like '%' || q || '%' or lower(coalesce(o.promo_label, '')) like '%' || q || '%'
              or (digits is not null and length(digits) >= 4 and regexp_replace(coalesce(mb.whatsapp, ''), '\D', '', 'g') like '%' || digits || '%'))
       order by o.sold_at desc limit 300) x), '[]'),
    'total_rows', (select count(*) from pos_orders o
        left join profiles mb on mb.id = o.member_id left join profiles sv on sv.id = o.served_by
       where o.sale_day between d1 and d2 and o.replaced_at is null
         and (st is null or (st = 'batal' and o.status in ('batal', 'refund')) or o.status = st)
         and (q is null or lower(o.receipt_no) like '%' || q || '%' or lower(coalesce(o.local_no, '')) like '%' || q || '%' or lower(coalesce(mb.full_name, '')) like '%' || q || '%'
              or lower(coalesce(sv.full_name, '')) like '%' || q || '%' or lower(coalesce(o.promo_label, '')) like '%' || q || '%'
              or (digits is not null and length(digits) >= 4 and regexp_replace(coalesce(mb.whatsapp, ''), '\D', '', 'g') like '%' || digits || '%'))),
    'paid_total', (select coalesce(sum(total), 0) from pos_orders where sale_day between d1 and d2 and status = 'dibayar'),
    -- The same paid orders split (14 Nov 2026): goods sales, service charge, PBJT on top and PBJT inside the price.
    'paid_split', (select json_build_object('sales', coalesce(sum(subtotal - discount), 0), 'service_charge', coalesce(sum(service_charge), 0),
        'tax', coalesce(sum(tax) filter (where not tax_included), 0), 'tax_in', coalesce(sum(tax) filter (where tax_included), 0))
      from pos_orders where sale_day between d1 and d2 and status = 'dibayar'));
end $$;

create or replace function public.pos_void_overview(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();
begin
  if p_from is null or p_to is null or p_from > p_to then raise exception 'Pilih tanggal dari dan sampai.'; end if;
  if p_to - p_from > 400 then raise exception 'Rentang tanggal paling panjang 400 hari.'; end if;
  return coalesce((select json_agg(x order by x.at desc) from (
    select 'v' || v.id as key, o.id as order_id, o.receipt_no, o.sold_at, coalesce(v.decided_at, v.created_at) as at, v.kind,
      a.amount, a.whole, public._pos_pay_label(coalesce(a.method, o.payment_method)) as method, v.reason,
      case when pr.id is null then null else public._first_name(pr.full_name) end as asked_by, case when pd.id is null then null else public._first_name(pd.full_name) end as decided_by,
      v.created_at as asked_at, v.decided_at, v.status
    from pos_void_requests v join pos_orders o on o.id = v.order_id
    cross join lateral public._rep_request(v.id) a
    left join profiles pr on pr.id = v.requested_by left join profiles pd on pd.id = v.decided_by
    where public._local(coalesce(v.decided_at, v.created_at))::date between p_from and p_to
    union all
    select 'o' || o.id, o.id, o.receipt_no, o.sold_at, o.sold_at, o.status, o.total, true, public._pos_pay_label(o.payment_method), null, null, null, null, null, 'selesai'
    from pos_orders o
    where o.sale_day between p_from and p_to and o.status in ('batal', 'refund') and o.replaced_at is null
      and not exists (select 1 from pos_void_requests v where v.order_id = o.id)) x), '[]');
end $$;
