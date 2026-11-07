// Sign-up poster (qr-daftar.html): draws the QR and the short address.
import { signupUrl, qrSvg } from './lib.js';
const url = signupUrl();
const draw = () => {
  document.getElementById('poster-qr').innerHTML = qrSvg(url);
  document.getElementById('poster-url').textContent = url.replace(/^https?:\/\//, '');
};
if (window.qrcode) draw(); else window.addEventListener('load', draw);
document.getElementById('print').addEventListener('click', () => print());
