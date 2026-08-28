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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { id } = req.query;
  const orders = getOrders();
  const order = orders[id];

  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.status(200).json({ success: true, order });
}
