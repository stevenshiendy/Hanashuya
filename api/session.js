// Keeps a member, cashier or owner signed in on this device.
//
// supabase-js saves the login in localStorage, but iPhone Safari wipes a site's
// localStorage after 7 days without a visit, and members often come less often than
// that. This function keeps the Supabase refresh token in an HttpOnly cookie that
// only this path can read. When the browser has lost its saved login, lib.js asks
// here to restore it, so nobody has to type their password again.
//
// The cookie lasts 400 days (the longest Chrome and Safari allow) and is renewed every
// time the card is opened, so in practice it never runs out. Pressing Keluar clears it.
//
// POST /api/session  {action: 'save', refresh_token}  stores the token
// POST /api/session  {action: 'restore'}              returns a fresh session or 204
// POST /api/session  {action: 'clear'}                removes the cookie

// Same values as member/js/config.js (both are public by design).
const SUPABASE_URL = 'https://jjdsoqpdiksosfotghwi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_2zhVFsxWlHGRnWDNRf6gjA_c6pXspmE';
const NAME = 'hs_rt';
const MAX_AGE = 400 * 24 * 60 * 60;

const cookie = (value, maxAge) =>
  `${NAME}=${value}; Path=/api/session; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

function readCookie(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${NAME}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  // Only this site's own pages may call it.
  const origin = req.headers.origin;
  if (!origin || origin !== `https://${req.headers.host}`) return res.status(403).end();

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch { return res.status(400).end(); }
  const token = typeof body.refresh_token === 'string' ? body.refresh_token : '';

  if (body.action === 'save') {
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(token)) return res.status(400).end();
    res.setHeader('Set-Cookie', cookie(encodeURIComponent(token), MAX_AGE));
    return res.status(204).end();
  }

  if (body.action === 'clear') {
    res.setHeader('Set-Cookie', cookie('', 0));
    return res.status(204).end();
  }

  if (body.action === 'restore') {
    const kept = readCookie(req);
    if (!kept) return res.status(204).end();
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: kept }),
    });
    if (!r.ok) {
      // The login was ended elsewhere (password change, Keluar on another device).
      res.setHeader('Set-Cookie', cookie('', 0));
      return res.status(204).end();
    }
    const s = await r.json();
    res.setHeader('Set-Cookie', cookie(encodeURIComponent(s.refresh_token), MAX_AGE));
    return res.status(200).json({ access_token: s.access_token, refresh_token: s.refresh_token });
  }

  return res.status(400).end();
}
