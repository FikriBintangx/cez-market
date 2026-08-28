import axios from 'axios';
import fs from 'fs';

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

const CHAT_ID = '8311765503';
const BOT1_TOKEN = '8685900115:AAGrAe78T_D87Q_1OSwPqI9ahpG78nIBFKU';
const BOT2_TOKEN = '8619896976:AAFkfHTHcx6EQSI695BFDucW0SP96e4kKDg';
const BOT3_TOKEN = '8326705445:AAEiNoebqYDhnp7Lr5Ri4vR2FXFP0_IBO4M';

async function sendTg(token, text, photoUrl = null) {
  if (!token) return;
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
  } catch (e) {}
}

async function processRizProOrder(orderId) {
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
    if (!rizOrder?.reference_id) return;

    const rizRefId = rizOrder.reference_id;
    const totalAmount = rizOrder.total_amount || 25000;
    const qrisUrl = rizOrder.qris_image_url || `https://api-riz.sphytech.my.id/api/web/orders/${rizRefId}/qris.png`;

    order.rizpro_order_id = rizRefId;
    saveOrders(orders);

    // Bot 2 kirim QRIS
    await sendTg(BOT2_TOKEN, 
      `🛒 <b>QRIS KULAK RIZPROSTORE</b>\n\n` +
      `🆔 <b>Order:</b> <code>${orderId}</code>\n` +
      `🏷️ <b>Ref:</b> <code>${rizRefId}</code>\n` +
      `💰 <b>Total Bayar:</b> <b>Rp ${totalAmount.toLocaleString('id-ID')}</b>\n` +
      `👤 <b>Customer:</b> ${order.customer_wa}\n\n` +
      `<i>Scan & bayar QRIS persis Rp ${totalAmount.toLocaleString('id-ID')}</i>`,
      qrisUrl
    );

    // Polling status
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 4000));
      try {
        const check = await axios.post(`https://www.rizprostore.my.id/api/proxy/api/web/orders/${encodeURIComponent(rizRefId)}/refresh`);
        if (['paid', 'completed'].includes(check.data?.order?.status)) {
          let link = `https://www.rizprostore.my.id/pesanan?id=${rizRefId}`;
          try {
            const acc = await axios.post(`https://www.rizprostore.my.id/api/proxy/api/web/orders/${encodeURIComponent(rizRefId)}/accounts`);
            const accounts = acc.data?.accounts || [];
            if (accounts.length > 0) {
              link = accounts[0]?.activation_link || accounts[0]?.link || link;
            }
          } catch (e) {}

          order.status = 'COMPLETED';
          order.activation_link = link;
          saveOrders(orders);

          await sendTg(BOT3_TOKEN, 
            `🎉 <b>TRANSAKSI SUKSES / HISTORY</b>\n\n` +
            `🆔 <b>Order ID:</b> <code>${orderId}</code>\n` +
            `🏷️ <b>Ref RizPro:</b> <code>${rizRefId}</code>\n` +
            `📱 <b>WA:</b> <code>${order.customer_wa}</code>\n` +
            `💰 <b>Kulak:</b> Rp ${totalAmount.toLocaleString('id-ID')}\n` +
            `💵 <b>Jual:</b> Rp 75.000\n` +
            `📈 <b>Profit:</b> Rp ${(75000 - totalAmount).toLocaleString('id-ID')}\n\n` +
            `🔗 <b>Link:</b>\n<code>${link}</code>`
          );
          break;
        }
      } catch (e) {}
    }
  } catch (err) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const update = req.body || {};
  if (update.callback_query) {
    const cq = update.callback_query;
    const [act, orderId] = (cq.data || '').split(':');

    await axios.post(`https://api.telegram.org/bot${BOT1_TOKEN}/answerCallbackQuery`, {
      callback_query_id: cq.id,
      text: act === 'approve' ? '✅ Approved!' : '❌ Rejected'
    }).catch(() => {});

    const orders = getOrders();
    const order = orders[orderId];
    if (order) {
      if (act === 'approve') {
        order.status = 'PAID';
        order.paid_at = new Date().toISOString();
        saveOrders(orders);
        processRizProOrder(orderId);
        await sendTg(BOT1_TOKEN, `✅ <b>Order ${orderId} Di-APPROVE</b>\nMemulai auto-checkout RizPro...`);
      } else {
        order.status = 'WAITING_PAYMENT';
        saveOrders(orders);
        await sendTg(BOT1_TOKEN, `❌ <b>Order ${orderId} Di-REJECT</b>`);
      }
    }
  }
  return res.status(200).json({ ok: true });
}
