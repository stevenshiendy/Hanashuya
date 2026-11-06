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
- `syarat-ketentuan.html`, `kebijakan-privasi.html`: terms (version 7 November 2026) and privacy (version 6 November 2026): summary box, table of contents, numbered sections, tables (privacy follows UU PDP: purposes with legal basis, processors, transfers abroad, retention, 3 x 24 hour breach notice, rights). When either changes, bump `terms_version` / `privacy_version` in schema.sql so members re-accept.
- `member/`: the loyalty app. Read `member/README.md` for setup, login, rules the database enforces, and what isn't built.
  - `index.html` + `js/member.js`: member card with Kartu, Hadiah, Riwayat, Akun tabs.
  - `staf.html` + `js/staff.js`: cashier (owner sees a Dasbor link in the header; the owner page has a Kasir link back) in three steps: find the card (scan QR, photo or typed code) and see its stamps and ready rewards, tap Pakai to use a reward (then enter its VireoPOS code), enter the total, then a done screen. Tabs: Kasir and Hari ini (today's sales and redemptions, undo requests). Third tab, Daftar member (`joinTab`): sign-up QR for the customer's phone, Buka formulir daftar, Salin link, and Kirim lewat WhatsApp (sends the link to a typed number). The step-1 button "Belum member? Tunjukkan QR daftar" opens that tab. The form can't be filled on the kasir tablet itself: the member page shares the kasir sign-in and shows "Ini akun staf".
  - `pemilik.html` + `js/owner.js`: owner dashboard (Ringkasan, Penjualan, Cocokkan struk, Staf, Bantuan akun, Pengaturan). Pengaturan > Cadangan data downloads `owner_backup()` as one .xlsx (a sheet per table, no secrets); Ringkasan warns when the last backup is 7+ days old. Supabase Free has no automatic backups.
  - `qr-daftar.html`: printable A5 sign-up poster. Every QR points to `/member/#daftar` (`signupUrl` in lib.js); `/daftar` (`site/daftar/index.html`) is a short typed address that redirects there. Linked from Pengaturan > QR pendaftaran.
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
- Card QR is a 30-second signed token (`card_token()`); the cashier scans it. Rules: 1 stamp per Rp50.000, no receipt number at the counter (the cashier enters only the total; the same card and total again within 10 minutes is refused as a double tap; Cocokkan struk pairs each stamp with one VireoPOS receipt of the same total within 15 minutes and flags leftovers and different customer names, see `_match_stamps`), no daily cap (a card that gets more than `max_stamps_per_day` in a day is only flagged `banyak_stempel_sehari` for the owner), staff can't stamp their own card, typed codes are flagged, undo needs owner approval, everything is in `audit_log`. Purchase time is the stamp time.
- Rewards: stamp 3 diskon 10%, stamp 7 diskon 20%, stamp 10 gratis 1 produk. One QR for everything: the member shows the card QR, the cashier asks and taps Pakai (`staff_redeem_reward`, using the scan ticket), then enters DISKONSTAMP1 / DISKONSTAMP2 or tukar poin in VireoPOS (vouchers: NEWMEMBER50 and BIRTHDAYGIFT, `VOUCHER_STEP` in staff.js). While the QR is open the member app checks every 3 seconds and shows "Hadiah dipakai". `member_redeem` now refuses: members can't use a reward on their own.
- Card cycles: a full card (10 stamps) stays on screen until all its rewards are used; extra stamps wait (`waiting`) and carry over to the next card. `card_cycles` stores one row per filled card (`filled_at`, `closed_at` once all rewards are used), kept up to date by `_sync_cycles` after every sale, redemption and approved undo; `_card_view` gives the card shown (`cycle`, `position`, `waiting`, `cards_done`). Meant as the base for tiered rewards later (for example, cards closed per member).
- Vouchers (`_vouchers`): `welcome` = Diskon 50% untuk 1 produk, valid from sign-up day to +30 days; `ulang_tahun` = 1 box Mini Choux isi 8, valid H-7 to H+7 around the birthday, once a year, only if the member joined 30+ days before that birthday (29 Feb becomes 28 Feb). They show in the member's Kartu and Hadiah tabs and in the cashier's ready list; the cashier taps Pakai (`staff_use_voucher`). Uses are rows in `redemptions` with `kind` = 'welcome' / 'ulang_tahun' (cycle = birthday year, slot 0), so undo, Hari ini and backups cover them. Stamp-reward queries filter `kind = 'stempel'`. Members can't change their birth date once set; the owner fixes it in Bantuan akun (`owner_set_birth_date`).
- Member app header: back arrow + logo link to the landing page. WhatsApp help (`waLink` in lib.js, number in config.js) on the login screen, under the card and in Akun.
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
5. Possible next features: tiered rewards on `card_cycles`, shorter sign-up, WhatsApp number verification, sign-up bot check, VireoPOS member import.

A clickable demo with sample data (browser-only backend) exists as a claude.ai artifact; it isn't part of this repo.
