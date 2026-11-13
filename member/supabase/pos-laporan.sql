-- Hanashuya POS: Laporan group (Glenn, 12 Nov 2026, like VireoPOS Laporan).
-- Run after pos-transaksi.sql (or after wa-templates.sql when that file is not there yet).
-- Safe to re-run. Owner and manager (read-only). Two new reports; the others reuse what exists:
--   Laporan stok      -> stock_report (stock.sql)
--   Laporan penjualan -> owner_pos_report (pos-reports.sql)
--   Laporan laba      -> owner_pos_profit (pos-backoffice.sql)
--   Laporan pembelian -> owner_purchase_report (here): goods in with supplier and cost
--   Laporan lainnya   -> owner_other_report (here): drawer, commission, promos, samples and waste, cards

-- Purchases: every goods-in in the range that wasn't cancelled, with its supplier and what
-- it cost (harga beli, when entered), totals per supplier and per item.
create or replace function public.owner_purchase_report(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();  -- owner and manager, read-only (13 Nov 2026)
  d1 date := coalesce(p_from, public._local(now())::date); d2 date := coalesce(p_to, public._local(now())::date);
begin
  if d2 < d1 then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  if d2 - d1 > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
  return (
    with g as (
      select g.id, g.day, g.current_qty as qty, g.unit_cost, g.total_cost, g.status, g.note,
             i.name as item, i.unit, s.name as supplier, r.no as po,
             coalesce(g.total_cost, round(g.unit_cost * g.current_qty)::int) as cost
        from stock_goods_in g
        join stock_items i on i.id = g.item_id
        left join stock_suppliers s on s.id = g.supplier_id
        left join stock_requests r on r.id = g.request_id
       where g.day between d1 and d2 and g.status <> 'dibatalkan'
    )
    select json_build_object('from', d1, 'to', d2,
      'deliveries', (select count(*) from g),
      'total_cost', (select coalesce(sum(cost), 0) from g),
      'without_cost', (select count(*) from g where cost is null),
      'by_supplier', coalesce((select json_agg(x order by x.cost desc nulls last, x.supplier) from (
          select coalesce(supplier, 'Tanpa pemasok') as supplier, count(*) as deliveries, sum(cost) as cost
            from g group by coalesce(supplier, 'Tanpa pemasok')) x), '[]'),
      'by_item', coalesce((select json_agg(x order by x.cost desc nulls last, x.item) from (
          select item, unit, sum(qty) as qty, sum(cost) as cost,
                 case when sum(qty) filter (where cost is not null) > 0
                      then round(sum(cost)::numeric / sum(qty) filter (where cost is not null), 2) end as avg_unit_cost
            from g group by item, unit) x), '[]'),
      'rows', coalesce((select json_agg(json_build_object('id', id, 'day', day, 'item', item, 'unit', unit, 'qty', qty,
          'supplier', supplier, 'po', po, 'cost', cost, 'unit_cost', unit_cost, 'note', note) order by day desc, id desc) from g), '[]'))
  );
end $$;

-- Everything else the owner checks: the drawer per shift, commission per staff, promos and
-- vouchers used, samples and waste, member cards made on the tablet, and flagged sales.
create or replace function public.owner_other_report(p_from date, p_to date) returns json
language plpgsql stable security definer set search_path = public
as $$
declare me uuid := public._rep_reader();  -- owner and manager, read-only (13 Nov 2026)
  d1 date := coalesce(p_from, public._local(now())::date); d2 date := coalesce(p_to, public._local(now())::date);
begin
  if d2 < d1 then raise exception 'Tanggal akhir harus sesudah tanggal awal.'; end if;
  if d2 - d1 > 366 then raise exception 'Pilih rentang paling lama satu tahun.'; end if;
  return json_build_object('from', d1, 'to', d2,
    'cash', (select json_build_object('shifts', count(*), 'difference', coalesce(sum(sh.counted_cash - sh.expected_cash), 0),
        'over_limit', count(*) filter (where 'selisih_kas' = any (sh.flags)))
      from pos_shifts sh where sh.closed_at is not null and public._local(sh.closed_at)::date between d1 and d2),
    'commission', coalesce((select json_agg(x order by x.commission desc) from (
        -- Signed rows (pos-reports.sql): a refund takes its commission back on the day it was approved.
        select coalesce(public._first_name(p.full_name), 'Tidak dicatat') as name, sum(o.receipts) as orders,
               sum(o.commission)::int as commission
          from public._rep_orders(d1, d2) o left join profiles p on p.id = o.served_by group by p.full_name) x), '[]'),
    'promos', coalesce((select json_agg(x order by x.sort, x.uses desc) from (
        with o as (select * from public._rep_orders(d1, d2) y where y.promo_kind is not null),
          pi as (select l.order_id, l.ev, l.request_id, sum(l.qty) filter (where l.discount <> 0) as items
                   from public._rep_lines(d1, d2) l where l.promo_kind is not null group by 1, 2, 3)
        select public._rep_promo_sort(o.promo_kind) as sort, public._rep_promo_label(o.promo_kind) as kind,
               coalesce(o.promo_label, public._rep_promo_label(o.promo_kind)) as name, sum(o.receipts) as uses, sum(o.discount)::int as discount,
               coalesce(sum(pi.items), 0)::int as items
          from o left join pi on pi.order_id = o.order_id and pi.ev = o.ev and pi.request_id is not distinct from o.request_id
         group by o.promo_kind, coalesce(o.promo_label, public._rep_promo_label(o.promo_kind))) x), '[]'),
    'stock_out', coalesce((select json_agg(x order by x.kind, x.item) from (
        select m.kind, i.name as item, i.unit, -sum(m.qty) as qty,
               round(-sum(m.qty) * coalesce(max(i.unit_cost), 0))::int as cost
          from stock_moves m join stock_items i on i.id = m.item_id
         where m.day between d1 and d2 and m.kind in ('sampel', 'buang', 'rusak', 'promo')
         group by m.kind, i.name, i.unit) x), '[]'),
    'cards_made', (select count(*) from audit_log a where a.action = 'daftar_lewat_kasir' and public._local(a.created_at)::date between d1 and d2),
    'flags', coalesce((select json_agg(x order by x.count desc) from (
        select f as flag, count(*) as count from pos_orders o, unnest(o.flags) f
         where o.sale_day between d1 and d2 group by f) x), '[]'));
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f' and p.proname in ('owner_purchase_report', 'owner_other_report')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
