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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { orderId } = req.body || {};
  const orders = getOrders();
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
    `💰 Tagihan: Rp 75.000\n` +
    `⏰ ${new Date(order.created_at).toLocaleString('id-ID')}\n\n` +
    `Customer klik "<b>Aku sudah bayar</b>". Klik verifikasi:`;

  try {
    await axios.post(`https://api.telegram.org/bot${BOT1_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: notifText,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  } catch (e) {}

  return res.status(200).json({ success: true, status: 'PENDING_VERIFICATION', msg: 'Menunggu admin verifikasi' });
}
