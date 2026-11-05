# Hanashuya member card

Lives inside the landing site at `/member/`. The landing page links to it from the nav, the member section and the footer, and both share `../kebijakan-privasi.html`.

Digital version of the Hanashuya loyalty card: 1 stamp per Rp50.000, 10% off at stamp 3, 20% off at stamp 7, a free product at stamp 10.

| Page | Who | What |
| --- | --- | --- |
| `/member/` | Members | Sign up or sign in (username or WhatsApp number + password), forgot password by WhatsApp code; four tabs: Kartu (card, stamps, QR), Hadiah (redeem with Ya/Tidak, voucher), Riwayat (visits), Akun (details, password, delete) |
| `/member/staf.html` | Cashiers | Scan QR (camera, photo or typed code), record a sale with receipt number and items, tag walk-ins, check today's redemptions, request undo |
| `/member/pemilik.html` | Owner | Busy-hours heatmap, top items, customer mix, staff activity, flagged stamps, VireoPOS receipt matching, undo approvals, add and remove staff, reset codes (Bantuan akun), rules, menu, promos |

Plain HTML, CSS and JavaScript with no build step. Supabase holds the data, login and every rule (`supabase/schema.sql`).

## 1. Set up Supabase (once)

1. Create a free project at supabase.com. Region: Singapore.
2. **SQL Editor**: paste all of `supabase/schema.sql` and run it. Re-run the whole file after every update; it is safe to run again.
3. **Project Settings > API Keys**: copy the Project URL and the **publishable** key (`sb_publishable_…`) into `js/config.js`. It is safe to commit. If sign-in fails with an "Invalid API key" or JWT error, use the legacy `anon` key from the *Legacy API Keys* tab instead. Never put the secret or `service_role` key in this repo.
4. **Authentication > Sign In / Providers > Email**: keep Email on and turn **Confirm email off**. People never see an email address: each account has a hidden login address (`u-…@member.hanashuya.id`) and signs in with its username or WhatsApp number plus a password. No email is ever sent.
5. **Authentication > Sign In / Providers > Email**: set the minimum password length to 8, the same as the forms.
6. **Authentication > URL Configuration**: Site URL `http://localhost:5173/member/` for now. Add your live URL later.

## 2. Run it on your Mac

Serve the whole landing site, not just this folder:

```bash
cd ~/Documents/Hanashuya/landing-page/site
python3 -m http.server 5173
```

Open http://localhost:5173 for the landing page and http://localhost:5173/member/ for the card. The camera scanner works on `localhost`. A phone on the same Wi-Fi can open `http://<your-mac-ip>:5173/member/`, but phones only allow the camera over https, so use *Foto QR* or *Ketik kode* there until the site is deployed.

## 3. Make yourself the owner

Run this once in the SQL Editor with your own details (password at least 8 characters):

```sql
select public._setup_owner('Glenn', 'glenn', '0812 3456 7890', 'password-anda');
```

Then open `/member/pemilik.html` and sign in with that username or number and password. Add cashiers in the **Staf** tab with a name, username, WhatsApp number and starting password, and give those to them in person. **Hapus** removes a cashier's access; their past sales keep their name. **Ganti password** sets a new password for a staff account.

Use a different WhatsApp number for your own member card: staff and owner accounts can't collect stamps.

## 4. Demo data (optional)

Run `supabase/seed-demo.sql` to fill the dashboard with 60 days of made-up sales. Every demo row is marked (numbers starting `628000000`, receipts `DEMO-…`). Remove it with `supabase/seed-demo-remove.sql` before real use.

## 5. Deploy

The member card ships with the landing site from the same `stevenshiendy/Hanashuya` repo. Commit and push the site folder as usual, and the host deploys both. `vercel.json` at the site root sets the security headers and keeps the cashier and owner pages out of search results; `.vercelignore` keeps this README and the `supabase/` folder off the live site.

After the first deploy, add `https://<your-domain>/member/` to Supabase **Authentication > URL Configuration** (Site URL and Redirect URLs).

Vercel's free Hobby plan is for personal, non-commercial use. For the live business site either upgrade to Pro or deploy the same repo to Cloudflare Pages, which is free for commercial use.

## How login works

- **Members** sign up on the card page with full name, birth date (17 or older), active WhatsApp number, username and password, plus gender if they want. They sign in with their username or number and password. The landing page's **Daftar jadi member** button opens the sign-up form directly.
- **Cashiers and the owner** sign in the same way. Only the owner creates staff accounts.
- A WhatsApp number or username belongs to one account at a time.
- Members can change their password under **Akun**. The owner changes staff passwords in the **Staf** tab.

## Forgot password by WhatsApp

*Lupa password* sends a 6-digit code to the account's WhatsApp number. The member types the code and a new password. A code works once, lasts 15 minutes, allows 5 tries, and each account can request 3 codes an hour.

For now codes are sent by hand (`RESET_VIA = 'manual'` in `js/config.js`):

**`'manual'` (free, in use now).** The member taps *Minta kode lewat WhatsApp*, which opens a ready message to Hanashuya from their own number. In the owner dashboard, open **Bantuan akun**, search for the account, tap **Buat kode**, then **Kirim lewat WhatsApp**. That opens a chat with the number on the account, with the code already typed. Only send codes to the number shown on the account.

### Later: automatic sending (not set up yet)

The WhatsApp Cloud API setup is parked for a future update. The code is ready and does nothing until these steps are done. **`'whatsapp-api'` (automatic, paid per message).** The `wa-reset` Edge Function sends the code through Meta's WhatsApp Cloud API. Meta charges per delivered authentication message (roughly Rp360 to Rp440 in Indonesia; check the current rate card), and there is no provider fee when you use the Cloud API directly. Setup:

1. In Meta Business Suite, create a WhatsApp Business account and add a phone number. Meta's *coexistence* option lets Hanashuya keep using the same number in the WhatsApp Business app; otherwise use a separate number.
2. In WhatsApp Manager, create an **Authentication** template named `hanashuya_reset`, language Indonesian, with a **Copy code** button. Meta writes the text itself; authentication templates can't contain links.
3. Create a System User with a permanent access token, and note the **Phone number ID**.
4. Install the Supabase CLI, then from this folder run:
   ```bash
   supabase functions deploy wa-reset --no-verify-jwt
   supabase secrets set WA_TOKEN=... WA_PHONE_NUMBER_ID=... WA_TEMPLATE=hanashuya_reset WA_LANG=id
   ```
5. Set `RESET_VIA = 'whatsapp-api'` in `js/config.js` and deploy the site.

The **Bantuan akun** tab keeps working either way, as a backup.

## Terms, privacy and consent records

`syarat-ketentuan.html` and `kebijakan-privasi.html` are linked from the sign-up form, the Akun tab and the site footer. Sign-up needs one ticked box for the terms (and having read the privacy policy); WhatsApp promos are a separate, optional box that members can change later in **Ubah data**.

Every acceptance and every promo opt-in or opt-out goes into `consent_log` with the document version, time and where it happened (`daftar` or `ubah data`). Rows can't be changed or deleted, and they stay after an account is deleted (holding only the account id).

When you change either page in a material way, update its version date on the page and in the database:

```sql
update settings set terms_version = '2027-01-15', privacy_version = '2027-01-15' where id = 1;
```

Members are then asked to read and accept the new version the next time they open their card. The owner dashboard only shows a WhatsApp button for lapsed members who opted in to promos.

## Rules the database enforces

- One sale per VireoPOS receipt number (spaces and dashes ignored).
- The member QR changes every 30 seconds; a scan is valid for 10 minutes while the cashier fills in the sale.
- Staff and owner accounts can't hold stamps. One WhatsApp number or username is one account.
- Stamps only between opening and closing time, and at most 6 stamps per card per day (both editable in **Pengaturan**).
- Members redeem from their own phone: **Tukar** asks *Yakin mau tukar?* with Ya or Tidak, then shows a red voucher with a running clock for the cashier. Each reward redeems once, and the cashier's **Tukar hadiah** tab lists today's redemptions to check against.
- Cashiers can't delete anything. They request an undo with a reason (sales or redemptions); the owner approves or rejects it.
- Typed card codes and a cashier stamping the same card 3+ times a week are flagged for the owner.
- Members who fill in gender and age keep their own answers; cashiers tag walk-ins.
- **Cocokkan struk** imports the VireoPOS sales CSV and flags stamps whose receipt is missing, more than 15 minutes off, or has a different total.

## Not in this MVP yet

- **WhatsApp verification at sign-up.** Every profile has an empty `whatsapp_verified_at` column and the app already reads it (`whoami().whatsapp_verified`). Once `wa-reset` is live, the same code path can confirm numbers: show a banner to unverified members, send a code, and set `whatsapp_verified_at` when it matches.
- **Birthday reward.** Birth dates are stored; the free Mini Choux box isn't tracked yet.
- Bot check (Cloudflare Turnstile) on the sign-up form.
- Importing existing VireoPOS members and their points, once the export format is known.
- Flavour tracking, wallet passes, more than one brand.
- The shared privacy policy (`../kebijakan-privasi.html`) needs review, including how long inactive accounts are kept.
- The landing page also promises 20% off the first purchase and a birthday box of Mini Choux. The app does not track either yet; staff handle them by hand.