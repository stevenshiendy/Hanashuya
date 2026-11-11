// Sample receipts from the till's database tests (pos_checkout output), for cetak-uji.html.
export const SAMPLES = {
 "walk": {
  "receipt_no": "HS-261111-0001",
  "status": "dibayar",
  "channel": "toko",
  "channel_label": "Di booth",
  "sold_at": "2026-11-11T09:09:39.306+00:00",
  "served_by": "Ranny",
  "member": null,
  "lines": [
   {
    "name": "Signature 1 pcs",
    "flavour": "Vanilla",
    "qty": 1,
    "line_total": 20000,
    "free_bag": false
   },
   {
    "name": "Mini Box isi 15",
    "flavour": "Matcha",
    "qty": 1,
    "line_total": 102000,
    "free_bag": false
   }
  ],
  "subtotal": 122000,
  "discount": 0,
  "promo_label": null,
  "promo_product": null,
  "total": 122000,
  "payment_method": "tunai",
  "cash_received": 150000,
  "change": 28000,
  "stamps": 0,
  "card": null,
  "new_rewards": null
 },
 "member": {
  "receipt_no": "HS-261111-0002",
  "status": "dibayar",
  "channel": "toko",
  "channel_label": "Di booth",
  "sold_at": "2026-11-11T09:09:39.325+00:00",
  "served_by": "Ranny",
  "member": "Desi",
  "lines": [
   {
    "name": "Mini Box isi 15",
    "flavour": "Vanilla",
    "qty": 1,
    "line_total": 99000,
    "free_bag": false
   },
   {
    "name": "Signature 1 pcs",
    "flavour": "Choco",
    "qty": 1,
    "line_total": 20000,
    "free_bag": false
   }
  ],
  "subtotal": 119000,
  "discount": 10000,
  "promo_label": "Diskon 50% untuk 1 produk",
  "promo_product": "Signature 1 pcs",
  "total": 109000,
  "payment_method": "qris",
  "cash_received": null,
  "change": null,
  "stamps": 2,
  "card": {
   "position": 2,
   "size": 10,
   "waiting": 0,
   "next_label": "Diskon 10%",
   "next_in": 1
  },
  "new_rewards": []
 },
 "reward": {
  "receipt_no": "HS-261111-0003",
  "status": "dibayar",
  "channel": "toko",
  "channel_label": "Di booth",
  "sold_at": "2026-11-11T09:09:39.338+00:00",
  "served_by": "Ranny",
  "member": "Desi",
  "lines": [
   {
    "name": "Signature Box isi 6",
    "flavour": "Vanilla",
    "qty": 1,
    "line_total": 120000,
    "free_bag": false
   }
  ],
  "subtotal": 120000,
  "discount": 0,
  "promo_label": null,
  "promo_product": null,
  "total": 120000,
  "payment_method": "tunai",
  "cash_received": 120000,
  "change": 0,
  "stamps": 2,
  "card": {
   "position": 4,
   "size": 10,
   "waiting": 0,
   "next_label": "Diskon 20%",
   "next_in": 3
  },
  "new_rewards": [
   "Diskon 10%"
  ]
 },
 "promo": {
  "receipt_no": "HS-261111-0004",
  "status": "dibayar",
  "channel": "toko",
  "channel_label": "Di booth",
  "sold_at": "2026-11-11T09:09:39.343+00:00",
  "served_by": "Ranny",
  "member": "Desi",
  "lines": [
   {
    "name": "Mini Box isi 8",
    "flavour": "Matcha Strawberry",
    "qty": 1,
    "line_total": 71000,
    "free_bag": false
   },
   {
    "name": "Signature 1 pcs",
    "flavour": "Vanilla",
    "qty": 1,
    "line_total": 20000,
    "free_bag": false
   }
  ],
  "subtotal": 91000,
  "discount": 9100,
  "promo_label": "Diskon 10%",
  "promo_product": null,
  "total": 81900,
  "payment_method": "tunai",
  "cash_received": 100000,
  "change": 18100,
  "stamps": 1,
  "card": {
   "position": 5,
   "size": 10,
   "waiting": 0,
   "next_label": "Diskon 20%",
   "next_in": 2
  },
  "new_rewards": []
 },
 "free": {
  "receipt_no": "HS-261111-0006",
  "status": "dibayar",
  "channel": "toko",
  "channel_label": "Di booth",
  "sold_at": "2026-11-11T09:09:39.365+00:00",
  "served_by": "Ranny",
  "member": "Desi",
  "lines": [
   {
    "name": "Signature 1 pcs",
    "flavour": "Vanilla",
    "qty": 1,
    "line_total": 20000,
    "free_bag": false
   }
  ],
  "subtotal": 20000,
  "discount": 20000,
  "promo_label": "1 Signature choux gratis",
  "promo_product": "Signature 1 pcs",
  "total": 0,
  "payment_method": "gratis",
  "cash_received": null,
  "change": null,
  "stamps": 0,
  "card": {
   "position": 4,
   "size": 10,
   "waiting": 0,
   "next_label": "Diskon 20%",
   "next_in": 3
  },
  "new_rewards": null
 }
};
