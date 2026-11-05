-- Removes everything seed-demo.sql added.
delete from public.undo_requests where sale_id in (select id from public.sales where receipt_no like 'DEMO-%');
delete from public.sales where receipt_no like 'DEMO-%';
delete from public.redemptions where member_id in (select id from public.profiles where whatsapp like '628000000%');
delete from public.pos_receipts where receipt_no like 'DEMO-%';
delete from auth.users where email like '628000000%@member.hanashuya.id';
