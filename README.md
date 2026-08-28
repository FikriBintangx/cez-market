# RizPro Dropship - Opsi A Auto Order
Sisa token: 81% aman untuk MVP ini.

## Flow
Customer -> Bayar QRIS di Web Lu (Tripay) -> Webhook PAID -> Backend auto order ke RizProStore -> Bayar QR RizPro -> Scrape link serviceactivation.google.com -> Kirim ke customer

## Struktur
- backend/ : Express + Tripay webhook + order DB (sqlite)
- bot/ : Playwright auto-order RizProStore
- frontend/ : Landing simple

## Cara pakai lihat di masing2 folder
