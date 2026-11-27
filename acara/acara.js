// Paket Acara interest form (27 Nov 2026): sends to bulk_lead_submit (supabase/paket-acara.sql), which anyone may
// call; the owner sees it under Paket Acara > Peminat. No sign-in, nothing kept in the browser.
import { rpc, configured } from '../member/js/lib.js';

const form = document.querySelector('[data-lead]');
const msg = form.querySelector('[data-msg]');
const say = (text, error = false) => { msg.textContent = text; msg.hidden = !text; msg.classList.toggle('is-error', error); };
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
form.event_date.min = today;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  say('');
  const v = Object.fromEntries(new FormData(form));
  if (v.name.trim().length < 2) { say('Isi nama lengkap Kakak.', true); form.name.focus(); return; }
  if (v.whatsapp.replace(/\D/g, '').length < 10) { say('Isi nomor WhatsApp yang benar, misalnya 0812 3456 7890.', true); form.whatsapp.focus(); return; }
  if (!configured) { say('Formulir belum tersambung. Chat kami lewat WhatsApp ya Kak.', true); return; }
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true; btn.textContent = 'Mengirim…';
  try {
    await rpc('bulk_lead_submit', { p: { ...v, boxes: v.boxes.replace(/\D/g, '') || null, event_date: v.event_date || null } });
    form.reset();
    say('Terima kasih Kak, pesannya sudah kami terima. Kami hubungi lewat WhatsApp secepatnya.');
  } catch (err) {
    say(err.message || 'Belum terkirim. Coba lagi, atau chat kami lewat WhatsApp.', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Kirim';
  }
});
