# Deploy 5 menit

## 1. Install
cd backend && npm install
cd ../bot && npm install && npx playwright install chromium

## 2. Isi .env
cp backend/.env.example backend/.env
# edit backend/.env isi TRIPAY_API_KEY dll
# kalo mau test tanpa Tripay, biarin kosong -> mode DUMMY aktif

## 3. Jalanin
# Terminal 1
cd backend && npm run dev
# -> http://localhost:3000

# Terminal 2
cd bot && npm start
# -> http://localhost:3001

# Terminal 3 - frontend (buka file langsung)
# open frontend/index.html atau serve: npx serve frontend

## 4. Test flow dummy (tanpa bayar beneran)
1. Buka frontend/index.html -> isi WA -> Beli
2. Klik "Buka QRIS Bayar" -> klik Simulasi PAID
3. Bot akan trigger, kirim mock link, frontend polling akan muncul link aktivasi

## 5. Pasang ke RizPro real
- Buka https://www.rizprostore.my.id/ di Chrome, F12 inspect produk Jio
- Copy selector tombol Beli / input WA / image QR
- Paste ke bot/bot.js bagian TODO (line 30-45)
- Ganti headless:false -> true kalo sudah oke

## 6. Production
- Deploy backend + bot di VPS (Railway/Render/Vercel + VPS)
- Isi TELEGRAM_BOT_TOKEN biar lu dapet notif QR yang harus dibayar
- Mode semi-auto: bot kirim QR ke Telegram lu, lu scan bayar 27k, bot lanjut

Sisa token lu masih 81% jadi aman. Mau gue bantu live test sekarang?
