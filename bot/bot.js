import express from 'express';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Config
const RIZPRO_BASE_URL = process.env.RIZPRO_BASE_URL || 'https://www.rizprostore.my.id';
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8311765503';

// 3 Bot Tokens
const BOT1_APPROVAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Bot 1 (Approval)
const BOT2_PAYMENT_TOKEN = process.env.TELEGRAM_BOT_PAYMENT_TOKEN; // Bot 2 (Pembayaran / QRIS Kulak)
const BOT3_HISTORY_TOKEN = process.env.TELEGRAM_BOT_HISTORY_TOKEN; // Bot 3 (History & Notif Selesai)

// Helper kirim Telegram dengan token tertentu
async function sendTg(token, text, photoUrl = null) {
  if (!token) return console.log('[TG SKIP - NO TOKEN]', text?.slice(0, 80));
  try {
    if (photoUrl) {
      await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, {
        chat_id: CHAT_ID,
        photo: photoUrl,
        caption: text,
        parse_mode: 'HTML'
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML'
      });
    }
  } catch (e) {
    console.error('[TG ERR]', e.response?.data || e.message);
  }
}

// Core: Direct Checkout ke API RizProStore (Bypass Turnstile & Headless Browser)
async function autoOrderRizPro(orderId) {
  console.log(`[BOT] 🚀 Memulai auto order ke RizProStore untuk ${orderId}`);
  
  // Ambil detail order dari backend kita
  let orderData = null;
  try {
    const resOrder = await axios.get(`${BACKEND_URL}/api/order/${orderId}`);
    orderData = resOrder.data?.order || resOrder.data;
  } catch (err) {
    console.log(`[BOT] Gagal ambil detail order ${orderId}, lanjut dengan default`);
  }

  const customerWa = orderData?.customer_wa || '-';
  const customerEmail = orderData?.customer_email || `order_${orderId.toLowerCase()}@gmail.com`;

  try {
    // 1. Hit Checkout API RizProStore
    const guestEmail = `drop_${Date.now()}@gmail.com`; // Guest email unik agar bypass login requirement
    const checkoutPayload = {
      product_code: 'gemini',
      product_id: 1,
      variant_name: 'AKUN PRIVAT',
      qty: 1,
      buyer_name: 'Dropship Order',
      email: guestEmail,
      whatsapp: customerWa !== '-' ? customerWa : '08123456789',
      contact: guestEmail,
      total_amount: 25000,
      payment_method: 'qris',
      source: 'web',
      save_history: false,
      account_id: '',
      turnstile_token: '',
      verification_provider: ''
    };

    console.log('[BOT] Mengirim request checkout ke RizProStore...');
    const checkoutRes = await axios.post(`${RIZPRO_BASE_URL}/api/proxy/api/web/checkout`, checkoutPayload, {
      headers: { 'Content-Type': 'application/json' }
    });

    const rizOrder = checkoutRes.data?.order;
    if (!rizOrder || !rizOrder.reference_id) {
      throw new Error(`Gagal membuat order RizPro: ${JSON.stringify(checkoutRes.data)}`);
    }

    const rizRefId = rizOrder.reference_id;
    const totalAmount = rizOrder.total_amount || 25000;
    const qrisUrl = rizOrder.qris_image_url || `https://api-riz.sphytech.my.id/api/web/orders/${rizRefId}/qris.png`;

    console.log(`[BOT] ✅ Order RizPro dibuat: ${rizRefId}, Total: Rp ${totalAmount}, QRIS: ${qrisUrl}`);

    // Update backend dengan detail pesanan RizPro
    await axios.post(`${BACKEND_URL}/api/rizpro-result`, {
      orderId,
      rizpro_order_id: rizRefId,
      rizpro_qr_string: qrisUrl
    }).catch(() => {});

    // 2. Kirim QRIS Kulak ke BOT 2 (Bot Pembayaran)
    const captionBot2 = 
      `🛒 <b>QRIS KULAK RIZPROSTORE</b>\n\n` +
      `🆔 <b>Order Kami:</b> <code>${orderId}</code>\n` +
      `🏷️ <b>Ref RizPro:</b> <code>${rizRefId}</code>\n` +
      `💰 <b>Total Bayar:</b> <b>Rp ${totalAmount.toLocaleString('id-ID')}</b>\n` +
      `👤 <b>Customer:</b> ${customerWa}\n\n` +
      `<i>👉 Scan & bayar QRIS di atas persis senilai Rp ${totalAmount.toLocaleString('id-ID')}.\nBot otomatis memantau hingga pembayaran sukses!</i>`;

    await sendTg(BOT2_PAYMENT_TOKEN, captionBot2, qrisUrl);

    // 3. Polling Status Pembayaran di RizProStore (Maks 15 menit)
    console.log(`[BOT] ⏳ Mulai polling status order ${rizRefId}...`);
    let isPaid = false;
    const maxAttempts = 180; // 180 x 5s = 15 menit
    let attempts = 0;

    while (!isPaid && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 5000));
      attempts++;

      try {
        const checkRes = await axios.post(`${RIZPRO_BASE_URL}/api/proxy/api/web/orders/${encodeURIComponent(rizRefId)}/refresh`);
        const status = checkRes.data?.order?.status;
        console.log(`[BOT] [Poll #${attempts}] Status ${rizRefId}: ${status}`);

        if (status === 'paid' || status === 'completed') {
          isPaid = true;
          console.log(`[BOT] 🎉 Order ${rizRefId} TELAH DIBAYAR!`);
        }
      } catch (pollErr) {
        console.log(`[BOT] Poll error (${attempts}):`, pollErr.message);
      }
    }

    if (!isPaid) {
      const timeoutMsg = `⚠️ <b>TIMEOUT Pembayaran Kulak</b>\nOrder: <code>${orderId}</code> (Ref: ${rizRefId})\nQRIS belum terbayar dalam 15 menit.`;
      await sendTg(BOT2_PAYMENT_TOKEN, timeoutMsg);
      return { success: false, error: 'Payment timeout' };
    }

    // 4. Ambil Link Aktivasi / Detail Akun
    console.log(`[BOT] Mengambil link aktivasi / akun untuk ${rizRefId}...`);
    let activationLink = '';
    let accountInfo = '';

    try {
      const accRes = await axios.post(`${RIZPRO_BASE_URL}/api/proxy/api/web/orders/${encodeURIComponent(rizRefId)}/accounts`);
      const accounts = accRes.data?.accounts || [];
      if (accounts.length > 0) {
        accountInfo = JSON.stringify(accounts);
        activationLink = accounts[0]?.activation_link || accounts[0]?.link || accounts[0]?.credential || accounts[0]?.detail || '';
      }
    } catch (accErr) {
      console.log('[BOT] Fetch accounts API error:', accErr.response?.data || accErr.message);
    }

    // Fallback jika format link tertera di order response
    if (!activationLink) {
      activationLink = `https://www.rizprostore.my.id/pesanan?id=${rizRefId}`;
    }

    // 5. Update status COMPLETED ke backend kita
    await axios.post(`${BACKEND_URL}/api/rizpro-result`, {
      orderId,
      rizpro_order_id: rizRefId,
      activation_link: activationLink
    }).catch(() => {});

    // 6. Notifikasi Berhasil ke BOT 3 (History & Log Selesai)
    const msgBot3 = 
      `🎉 <b>TRANSAKSI SUKSES / HISTORY</b>\n\n` +
      `🆔 <b>Order ID:</b> <code>${orderId}</code>\n` +
      `🏷️ <b>Ref RizPro:</b> <code>${rizRefId}</code>\n` +
      `📱 <b>WA Customer:</b> <code>${customerWa}</code>\n` +
      `📧 <b>Email:</b> ${customerEmail}\n` +
      `💰 <b>Modal (Kulak):</b> Rp ${totalAmount.toLocaleString('id-ID')}\n` +
      `💵 <b>Jual:</b> Rp 35.000\n` +
      `📈 <b>Profit:</b> Rp ${(35000 - totalAmount).toLocaleString('id-ID')}\n\n` +
      `🔗 <b>Link Aktivasi / Detail:</b>\n<code>${activationLink}</code>\n\n` +
      `<i>Status: COMPLETED ✅</i>`;

    await sendTg(BOT3_HISTORY_TOKEN, msgBot3);

    // Notifikasi juga ke Bot 1 & Bot 2 bahwa order sudah tuntas
    await sendTg(BOT2_PAYMENT_TOKEN, `✅ <b>Pembayaran Diterima!</b>\nOrder <code>${orderId}</code> sudah selesai diproses.`);
    await sendTg(BOT1_APPROVAL_TOKEN, `✅ <b>Order Selesai:</b> <code>${orderId}</code>\nLink: <code>${activationLink}</code>`);

    return { success: true, rizRefId, activationLink };

  } catch (error) {
    console.error(`[BOT ERROR] Order ${orderId}:`, error.message);
    const errText = `❌ <b>Gagal Auto Order Kulak</b>\nOrder: <code>${orderId}</code>\nError: ${error.message}`;
    await sendTg(BOT2_PAYMENT_TOKEN, errText);
    await sendTg(BOT1_APPROVAL_TOKEN, errText);
    return { success: false, error: error.message };
  }
}

// Endpoint dipanggil backend setelah order di-Approve
app.post('/bot/order', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  res.json({ accepted: true, msg: `Bot mulai proses ${orderId}` });
  
  // Proses asynchronous di background
  autoOrderRizPro(orderId);
});

// Endpoint untuk test manual
app.get('/bot/test/:orderId', async (req, res) => {
  const result = await autoOrderRizPro(req.params.orderId);
  res.json(result);
});

app.get('/', (req, res) => {
  res.send(`<h3>🤖 RizPro Dropship Bot - 3 Telegram Bots Integration</h3>` +
           `<ul>` +
           `<li>Bot 1 (Approval): ${BOT1_APPROVAL_TOKEN ? 'Connected' : 'Not Set'}</li>` +
           `<li>Bot 2 (Payment/QRIS): ${BOT2_PAYMENT_TOKEN ? 'Connected' : 'Not Set'}</li>` +
           `<li>Bot 3 (History/Success): ${BOT3_HISTORY_TOKEN ? 'Connected' : 'Not Set'}</li>` +
           `</ul>`);
});

app.listen(3001, () => console.log('🤖 Bot Service jalan di http://localhost:3001'));

export { autoOrderRizPro };
