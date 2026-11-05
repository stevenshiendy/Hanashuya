// From Supabase > Project Settings > API Keys. The publishable key (or the legacy
// anon key) is meant to be public: the database rules decide what it can do.
// Never put the secret or service_role key here.
export const SUPABASE_URL = 'https://jjdsoqpdiksosfotghwi.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_2zhVFsxWlHGRnWDNRf6gjA_c6pXspmE';

// Each account has a hidden login address, u-xxxx@<this domain>; people only ever
// see their username and number, and no email is sent to it. Keep it the same as
// auth_domain in supabase/schema.sql, and never change it after people sign up.
export const AUTH_EMAIL_DOMAIN = 'member.hanashuya.id';

// How "Lupa password" delivers the 6-digit code:
// 'manual'       the member messages Hanashuya on WhatsApp and the owner sends the
//                code from the dashboard (Bantuan akun). Free.
// 'whatsapp-api' the wa-reset Edge Function sends it through the WhatsApp Cloud API.
//                Not set up yet; parked for a later update (see README).
export const RESET_VIA = 'manual';
export const HANASHUYA_WHATSAPP = '6285890120577';
