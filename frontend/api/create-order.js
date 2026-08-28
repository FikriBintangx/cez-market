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

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { wa, email } = req.body || {};
  const orderId = 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase();
  const amount = 75000;
  const host = `https://${req.headers.host || 'cez-market.vercel.app'}`;

  const orders = getOrders();
  orders[orderId] = {
    id: orderId,
    customer_wa: wa || '-',
    customer_email: email || '-',
    status: 'WAITING_PAYMENT',
    amount,
    created_at: new Date().toISOString()
  };
  saveOrders(orders);

  // Notif info ke bot admin
  try {
    await axios.post(`https://api.telegram.org/bot${BOT1_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text: `🛒 <b>Order Baru Dibuat</b>\nID: <code>${orderId}</code>\nWA: <code>${wa}</code>\nTagihan: Rp 75.000`,
      parse_mode: 'HTML'
    });
  } catch (e) {}

  return res.status(200).json({
    success: true,
    mode: 'QRIS_STATIS',
    order_id: orderId,
    pay_url: `${host}/pay/${orderId}`,
    qris_url: `${host}/qris.jpeg`,
    qr_string: `QRIS_CEZ_MARKET_${orderId}`,
    amount,
    note: 'Scan QRIS dan klik Aku sudah bayar'
  });
}
