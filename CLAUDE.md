# Hanashuya site and member card

Landing page and digital loyalty card for Hanashuya, a choux pastry booth at Papaya Fresh Gallery, Bandung (owner: Glenn, `stevenshiendy`). Copy on every page is Indonesian. The site addresses customers as "Kakak"; the member app uses "Anda" in forms.

## Working rules

- Don't commit or push unless Glenn asks. Commits go to `main` on `stevenshiendy/Hanashuya`; Vercel deploys from there.
- Don't delete files without asking.
- Design work follows the Hallmark, Hue and better-typography skills and the App Launch checklist (`~/Documents/Hanashuya/App Launch Prep.pdf`). Lint the member app with
  `node ~/.agents/skills/hallmark/scripts/sloplint.mjs member/css/*.css member/js/*.js member/*.html --scope app` (0 FAIL expected; the 4 WARN are accepted).
- Plain HTML, CSS and ES modules. No build step, no framework. Keep it that way.

## Layout

- `index.html`, `styles.css`: landing page. The nav and member section read `localStorage['hs-member']` (written by the member app) to show "Kartu saya" and a hello line.
- `syarat-ketentuan.html`, `kebijakan-privasi.html`: terms and privacy, version 5 November 2026.
- `member/`: the loyalty app. Read `member/README.md` for setup, login, rules the database enforces, and what isn't built.
  - `index.html` + `js/member.js`: member card with Kartu, Hadiah, Riwayat, Akun tabs.
  - `staf.html` + `js/staff.js`: cashier in three steps: find the card (scan QR, photo or typed code) and see its stamps and ready rewards with their VireoPOS codes, enter the total, then a done screen. Tabs: Kasir and Hari ini (today's sales and redemptions, undo requests). No separate redeem tab: rewards are applied in VireoPOS by hand.
  - `pemilik.html` + `js/owner.js`: owner dashboard (Ringkasan, Penjualan, Cocokkan struk, Staf, Bantuan akun, Pengaturan).
  - `js/lib.js`: Supabase client, login/sign-up/forgot-password forms, helpers. `js/config.js`: project URL and publishable key (public by design).
  - `css/tokens.css` holds every colour and size; other CSS uses tokens only.
  - `supabase/schema.sql`: the whole database (tables, RLS, security-definer functions). Re-runnable; run it again after any change.
  - `supabase/cleanup-keep-owner.sql`: one-time pre-launch cleanup plus the demo account.
  - `supabase/functions/wa-reset/`: WhatsApp Cloud API sender, parked (not deployed).
- `vercel.json` sets headers; `.vercelignore` keeps `member/supabase` and `member/README.md` off the live site.

## How it works

- Supabase project `jjdsoqpdiksosfotghwi`. All app logic lives in Postgres functions called by RPC; tables have RLS with no direct access.
- Everyone logs in with username or WhatsApp number plus password. Each account has a hidden email `u-<hex>@member.hanashuya.id`; `login_handle()` maps username/number to it. Supabase Auth "Confirm email" must be off.
- Owner account is created once with `select public._setup_owner(name, username, phone, password);` in the SQL Editor. Staff are added from the owner dashboard.
- Forgot password: `RESET_VIA = 'manual'`. The member messages Hanashuya on WhatsApp; the owner makes a 6-digit code in Bantuan akun and sends it with a wa.me link. The automatic WhatsApp Cloud API route is parked for later.
- Card QR is a 30-second signed token (`card_token()`); the cashier scans it. Rules: 1 stamp per Rp50.000, no receipt number at the counter (the cashier enters only the total; the same card and total again within 10 minutes is refused as a double tap; Cocokkan struk pairs each stamp with one VireoPOS receipt of the same total within 15 minutes and flags leftovers and different customer names, see `_match_stamps`), max 6 stamps a day, staff can't stamp their own card, typed codes are flagged, undo needs owner approval, everything is in `audit_log`. Purchase time is the stamp time.
- Rewards: stamp 3 diskon 10%, stamp 7 diskon 20%, stamp 10 gratis 1 produk. Members redeem with Tukar, confirm "Ya, tukar", then show the red voucher screen with a live clock.
- 20% first-purchase discount and the birthday Mini Choux box are program rules (on the landing page and in the terms) that staff handle by hand; the app stores birth dates but doesn't track either yet.
- Sign-up asks for full name, birth date (17+), WhatsApp number, username, password, optional gender, a required terms/privacy box and a separate optional WhatsApp promo box. `consent_log` records every acceptance and promo choice (append-only). Bumping `settings.terms_version` / `privacy_version` makes members re-accept on next open.
- Cashiers tap gender and age range for walk-ins; members fill in their own.
- Standalone from VireoPOS. Cocokkan struk imports the VireoPOS Laporan Penjualan Rinci (.xls via SheetJS, or .csv) to check stamps against receipts. Importing VireoPOS members is a later, one-time job.

## Status (5 November 2026)

Done and pushed. Glenn has run an earlier schema and created his owner account (`glenn`).

Next:
1. Re-run `member/supabase/schema.sql` in Supabase (adds `consent_log`, `marketing_opt_in`, `terms_ok`).
2. Run `member/supabase/cleanup-keep-owner.sql` once: removes test data, keeps the owner, creates the demo member `hanashuya` / `testingmantap88`.
3. After Vercel deploys, test login with the publishable key. If it fails with an API key or JWT error, switch `config.js` to the legacy anon key.
4. Glenn to review two rules in the terms: stamps are for booth purchases only, and rewards stay redeemable until an announced date if the program ends. Sign Supabase's DPA; check Vercel Hobby vs Pro (Hobby is non-commercial).
5. Possible next features: birthday reward in the Hadiah tab and cashier view, first-purchase discount tracking, WhatsApp number verification, sign-up bot check, VireoPOS member import.

A clickable demo with sample data (browser-only backend) exists as a claude.ai artifact; it isn't part of this repo.
