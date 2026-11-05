// Sends a "Lupa password" code to the account's WhatsApp number through the
// WhatsApp Cloud API, using an approved authentication template with a copy-code
// button. Deploy: supabase functions deploy wa-reset --no-verify-jwt
// Secrets:   supabase secrets set WA_TOKEN=... WA_PHONE_NUMBER_ID=... WA_TEMPLATE=hanashuya_reset WA_LANG=id
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const { login } = await req.json().catch(() => ({ login: '' }));
  if (typeof login !== 'string' || login.trim().length < 3) return reply(400, { error: 'Tulis username atau nomor WhatsApp.' });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data, error } = await db.rpc('_issue_reset_code', { p_login: login });
  if (error) return reply(429, { error: error.message });

  // Same answer whether or not the account exists, so the form can't be used to find accounts.
  if (!data) return reply(200, { sent: true });

  const res = await fetch(`https://graph.facebook.com/v21.0/${Deno.env.get('WA_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Deno.env.get('WA_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: data.whatsapp,
      type: 'template',
      template: {
        name: Deno.env.get('WA_TEMPLATE') ?? 'hanashuya_reset',
        language: { code: Deno.env.get('WA_LANG') ?? 'id' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: data.code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: data.code }] },
        ],
      },
    }),
  });
  if (!res.ok) {
    console.error('WhatsApp send failed', res.status, await res.text());
    return reply(502, { error: 'Kode belum bisa dikirim. Coba lagi sebentar, atau hubungi Hanashuya lewat WhatsApp.' });
  }
  return reply(200, { sent: true });
});
