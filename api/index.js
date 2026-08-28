import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Memory/tmp store persistence
const DB_FILE = '/tmp/orders.json';

function getOrders() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    }
  } catch (e) {}
  return global._ORDERS || {};
}

function saveOrders(orders) {
  global._ORDERS = orders;
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(orders));
  } catch (e) {}
}

const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8311765503';
const BOT1_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8685900115:AAGrAe78T_D87Q_1OSwPqI9ahpG78nIBFKU';
const BOT2_TOKEN = process.env.TELEGRAM_BOT_PAYMENT_TOKEN || '8619896976:AAFkfHTHcx6EQSI695BFDucW0SP96e4kKDg';
const BOT3_TOKEN = process.env.TELEGRAM_BOT_HISTORY_TOKEN || '8326705445:AAEiNoebqYDhnp7Lr5Ri4vR2FXFP0_IBO4M';

async function sendTg(token, text, photoUrl = null, inlineKeyboard = null) {
  if (!token) return;
  try {
    if (photoUrl) {
      await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, {
        chat_id: CHAT_ID,
        photo: photoUrl,
        caption: text,
        parse_mode: 'HTML',
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
      });
    }
  } catch (e) {
    console.error('[TG ERR]', e.response?.data || e.message);
  }
}

// Background auto order RizPro
async function processRizProOrder(orderId, host) {
  const orders = getOrders();
  const order = orders[orderId];
  if (!order) return;

  try {
    const guestEmail = `drop_${Date.now()}@gmail.com`;
    const payload = {
      product_code: 'gemini',
      product_id: 1,
      variant_name: 'AKUN PRIVAT',
      qty: 1,
      buyer_name: 'Dropship Order',
      email: guestEmail,
      whatsapp: order.customer_wa || '08123456789',
      contact: guestEmail,
      total_amount: 25000,
      payment_method: 'qris',
      source: 'web',
      save_history: false,
      account_id: '',
      turnstile_token: '',
      verification_provider: ''
    };

    const res = await axios.post('https://www.rizprostore.my.id/api/proxy/api/web/checkout', payload);
    const rizOrder = res.data?.order;
    if (!rizOrder?.reference_id) throw new Error('Failed to create RizPro order');

    const rizRefId = rizOrder.reference_id;
    const totalAmount = rizOrder.total_amount || 25000;
    const qrisUrl = rizOrder.qris_image_url || `https://api-riz.sphytech.my.id/api/web/orders/${rizRefId}/qris.png`;

    order.rizpro_order_id = rizRefId;
    order.rizpro_qr_string = qrisUrl;
    saveOrders(orders);

    // Bot 2 kirim QRIS Kulak
    const captionBot2 = 
      `🛒 <b>QRIS KULAK RIZPROSTORE</b>\n\n` +
      `🆔 <b>Order:</b> <code>${orderId}</code>\n` +
      `🏷️ <b>Ref:</b> <code>${rizRefId}</code>\n` +
      `💰 <b>Total Bayar:</b> <b>Rp ${totalAmount.toLocaleString('id-ID')}</b>\n` +
      `👤 <b>Customer:</b> ${order.customer_wa}\n\n` +
      `<i>👉 Scan & bayar persis senilai Rp ${totalAmount.toLocaleString('id-ID')}.\nSistem otomatis memantau status pembayaran.</i>`;

    await sendTg(BOT2_TOKEN, captionBot2, qrisUrl);

    // Polling background (maks 25 siklus di serverless)
    let isPaid = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const check = await axios.post(`https://www.rizprostore.my.id/api/proxy/api/web/orders/${encodeURIComponent(rizRefId)}/refresh`);
        if (['paid', 'completed'].includes(check.data?.order?.status)) {
          isPaid = true;
          break;
        }
      } catch (e) {}
    }

    let link = `https://www.rizprostore.my.id/pesanan?id=${rizRefId}`;
    if (isPaid) {
      try {
        const acc = await axios.post(`https://www.rizprostore.my.id/api/proxy/api/web/orders/${encodeURIComponent(rizRefId)}/accounts`);
        const accounts = acc.data?.accounts || [];
        if (accounts.length > 0) {
          link = accounts[0]?.activation_link || accounts[0]?.link || accounts[0]?.detail || link;
        }
      } catch (e) {}

      order.status = 'COMPLETED';
      order.activation_link = link;
      saveOrders(orders);

      // Bot 3 History
      await sendTg(BOT3_TOKEN, 
        `🎉 <b>TRANSAKSI SUKSES / HISTORY</b>\n\n` +
        `🆔 <b>Order ID:</b> <code>${orderId}</code>\n` +
        `🏷️ <b>Ref RizPro:</b> <code>${rizRefId}</code>\n` +
        `📱 <b>WA:</b> <code>${order.customer_wa}</code>\n` +
        `💰 <b>Kulak:</b> Rp ${totalAmount.toLocaleString('id-ID')}\n` +
        `💵 <b>Jual:</b> Rp 35.000\n` +
        `📈 <b>Profit:</b> Rp ${(35000 - totalAmount).toLocaleString('id-ID')}\n\n` +
        `🔗 <b>Link:</b>\n<code>${link}</code>`
      );
    }
  } catch (err) {
    console.error('RizPro order err:', err.message);
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/^\/api/, '');
  const orders = getOrders();
  const host = `https://${req.headers.host}`;

  // 1. Create Order
  if (pathname === '/create-order' && req.method === 'POST') {
    const { wa, email } = req.body || {};
    const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
    const amount = 35000;

    orders[orderId] = {
      id: orderId,
      customer_wa: wa || '-',
      customer_email: email || '-',
      status: 'WAITING_PAYMENT',
      amount,
      created_at: new Date().toISOString()
    };
    saveOrders(orders);

    return res.json({
      success: true,
      mode: 'QRIS_STATIS',
      order_id: orderId,
      pay_url: `${host}/pay/${orderId}`,
      qris_url: `${host}/qris.jpeg`,
      qr_image: `/qris.jpeg`,
      amount,
      note: 'Scan QRIS dan klik Aku sudah bayar'
    });
  }

  // 2. Confirm Payment
  if (pathname === '/confirm-payment' && req.method === 'POST') {
    const { orderId } = req.body || {};
    const order = orders[orderId];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'PENDING_VERIFICATION';
    saveOrders(orders);

    const keyboard = [
      [
        { text: '✅ Approve & Order', callback_data: `approve:${orderId}` },
        { text: '❌ Reject', callback_data: `reject:${orderId}` }
      ]
    ];

    const notifText = 
      `🔔 <b>PESANAN MENUNGGU VERIFIKASI</b>\n\n` +
      `🆔 <code>${orderId}</code>\n` +
      `📱 WA: <code>${order.customer_wa}</code>\n` +
      `📧 Email: ${order.customer_email}\n` +
      `💰 Tagihan: Rp 35.000\n` +
      `⏰ ${new Date(order.created_at).toLocaleString('id-ID')}\n\n` +
      `Customer klik "<b>Aku sudah bayar</b>". Klik verifikasi:`;

    await sendTg(BOT1_TOKEN, notifText, null, keyboard);

    return res.json({ success: true, status: 'PENDING_VERIFICATION', msg: 'Menunggu admin verifikasi' });
  }

  // 3. Admin Verify (Approve / Reject)
  if (pathname === '/admin/verify' && req.method === 'POST') {
    const { orderId, action } = req.body || {};
    const order = orders[orderId];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (action === 'approve') {
      order.status = 'PAID';
      order.paid_at = new Date().toISOString();
      saveOrders(orders);
      processRizProOrder(orderId, host);
      return res.json({ success: true, status: 'PAID', msg: 'Approved, auto ordering to RizPro' });
    } else {
      order.status = 'WAITING_PAYMENT';
      saveOrders(orders);
      return res.json({ success: true, status: 'WAITING_PAYMENT', msg: 'Rejected' });
    }
  }

  // 4. Telegram Webhook Callback
  if (pathname === '/telegram-webhook' && req.method === 'POST') {
    const update = req.body || {};
    if (update.callback_query) {
      const cq = update.callback_query;
      const [act, orderId] = (cq.data || '').split(':');

      await axios.post(`https://api.telegram.org/bot${BOT1_TOKEN}/answerCallbackQuery`, {
        callback_query_id: cq.id,
        text: act === 'approve' ? '✅ Approved!' : '❌ Rejected'
      }).catch(() => {});

      const order = orders[orderId];
      if (order) {
        if (act === 'approve') {
          order.status = 'PAID';
          order.paid_at = new Date().toISOString();
          saveOrders(orders);
          processRizProOrder(orderId, host);
          await sendTg(BOT1_TOKEN, `✅ <b>Order ${orderId} Di-APPROVE</b>\nMemulai auto-checkout RizPro...`);
        } else {
          order.status = 'WAITING_PAYMENT';
          saveOrders(orders);
          await sendTg(BOT1_TOKEN, `❌ <b>Order ${orderId} Di-REJECT</b>`);
        }
      }
    }
    return res.json({ ok: true });
  }

  // 5. Get Order Details
  if (pathname.startsWith('/order/')) {
    const id = pathname.replace('/order/', '');
    const order = orders[id];
    if (!order) return res.status(404).json({ error: 'Not found' });
    return res.json({ success: true, order });
  }

  // 6. Get All Orders (Admin)
  if (pathname === '/orders') {
    return res.json({ success: true, orders: Object.values(orders) });
  }

  return res.json({ ok: true, name: 'CEZ Market Serverless API' });
}
