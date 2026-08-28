import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import axios from 'axios';
import Database from 'better-sqlite3';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// serve QRIS statis lu
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/qris.jpeg', express.static(path.join(__dirname, 'qris.jpeg')));
app.use('/qris', express.static(path.join(__dirname, 'qris.jpeg')));

// --- DB sqlite simple ---
const db = new Database('dropship.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_wa TEXT,
    customer_email TEXT,
    status TEXT,
    tripay_ref TEXT,
    tripay_pay_url TEXT,
    tripay_qr_string TEXT,
    rizpro_order_id TEXT,
    rizpro_qr_string TEXT,
    activation_link TEXT,
    created_at TEXT,
    paid_at TEXT
  );
`);

function genId(){ return 'ORD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,5).toUpperCase(); }

// --- Telegram helpers ---
import { execSync } from 'child_process';

async function sendViaHermes(text){
  // fallback kirim via hermes send (pakai bot Hermes yang sudah connected)
  try{
    // escape untuk shell
    const esc = text.replace(/'/g, `'\\''`);
    const cmd = `hermes send --to telegram '${esc}' 2>&1`;
    const out = execSync(cmd, { encoding:'utf-8', timeout:8000 });
    console.log('[HERMES SEND]', out.trim().slice(0,80));
    return { hermes:true, out };
  }catch(e){
    console.log('[HERMES SEND ERR]', e.message, e.stdout?.toString()?.slice(0,120));
    return { error:e.message };
  }
}

async function sendTelegram(text, opts={}){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  // Jika token ada dan valid, pakai direct API (bot terpisah)
  if(token && chat && !token.includes('isi_')) {
    try{
      const payload = { chat_id: chat, text, parse_mode: 'HTML', ...opts };
      const r = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload);
      return r.data;
    }catch(e){ console.log('telegram send err', e.response?.data||e.message); return { error:e.message } }
  }
  // Fallback: pakai hermes send (reuse bot Hermes yang sudah jalan)
  // opts diabaikan untuk hermes (hermes tidak support inline keyboard di text mode)
  // tapi untuk verif kita akan handle khusus di sendVerifButtons
  if(text){
    // strip HTML untuk hermes
    const plain = text.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&');
    return await sendViaHermes(plain);
  }
  console.log('[TELEGRAM SKIP]', text?.slice(0,120));
  return { skipped:true };
}

async function sendVerifButtons(order){
  const amount = parseInt(process.env.HARGA_JUAL || '100000');
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  // Jika ada token dedicated, pakai inline keyboard (retry 3x sebelum fallback)
  if(token && chat && !token.includes('isi_')) {
    const text = `🔔 <b>PESANAN MENUNGGU VERIFIKASI</b>\n\n`+
      `🆔 <code>${order.id}</code>\n`+
      `📱 WA: <code>${order.customer_wa||'-'}</code>\n`+
      `📧 Email: ${order.customer_email||'-'}\n`+
      `💰 Tagihan: Rp ${amount.toLocaleString('id-ID')}\n`+
      `⏰ ${new Date(order.created_at).toLocaleString('id-ID')}\n\n`+
      `Customer klik "<b>Aku sudah bayar</b>".\nSilahkan cek mutasi QRIS lu lalu verifikasi:`;
    for(let attempt=1; attempt<=3; attempt++){
      try{
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
          chat_id: chat,
          text,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text:'✅ Approve & Proses', callback_data:`approve:${order.id}` },
                { text:'❌ Reject', callback_data:`reject:${order.id}` }
              ]
            ]
          }
        }, { timeout: 15000 });
        console.log(`[TELEGRAM] Verif buttons sent for ${order.id} (attempt ${attempt})`);
        return;
      }catch(e){
        const errMsg = e.response?.data?.description || e.message;
        console.log(`[TELEGRAM] verif err attempt ${attempt}:`, errMsg);
        if(attempt < 3) await new Promise(r=>setTimeout(r, 2000*attempt));
        else console.log(`[TELEGRAM] all 3 attempts failed for ${order.id}, fallback to hermes`);
      }
    }
  }
  // Fallback Opsi A: pakai hermes send (reuse bot Hermes)
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
  const plain = 
    `🔔 *VERIFIKASI MANUAL PEMBAYARAN*\n\n`+
    `Ada customer claim sudah bayar via QRIS Statis:\n`+
    `🆔 ${order.id}\n`+
    `📱 WA: ${order.customer_wa||'-'}\n`+
    `📧 Email: ${order.customer_email||'-'}\n`+
    `💰 Tagihan: Rp ${amount.toLocaleString('id-ID')}\n`+
    `⏰ ${new Date(order.created_at).toLocaleString('id-ID')}\n\n`+
    `Customer klik "Aku sudah bayar".\n`+
    `Balas di chat ini:\n`+
    `✅ approve ${order.id}  (untuk approve & proses)\n`+
    `❌ reject ${order.id}  (untuk reject)\n`+
    `atau buka admin: ${backendUrl}/api/order/${order.id}`;
  await sendViaHermes(plain);
  console.log(`[HERMES] Verif notif sent for ${order.id} via hermes send`);
}

// --- 1. Customer create order di web lu ---
app.post('/api/create-order', async (req,res)=>{
  const { wa, email } = req.body;
  const orderId = genId();
  const amount = parseInt(process.env.HARGA_JUAL || '100000');
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;

  // Create transaksi Tripay QRIS
  try{
    // Jika Tripay belum di-set, fallback mode QRIS statis lu (100k)
    if(!process.env.TRIPAY_API_KEY || process.env.TRIPAY_API_KEY.includes('isi_')){
      db.prepare(`INSERT INTO orders (id,customer_wa,customer_email,status,created_at) VALUES (?,?,?,?,?)`)
        .run(orderId, wa||'', email||'', 'WAITING_PAYMENT', new Date().toISOString());
      return res.json({
        success:true,
        mode:'QRIS_STATIS',
        order_id: orderId,
        pay_url: `${backendUrl}/pay/${orderId}`,
        qr_string: `QRIS_STATIS_${orderId}`,
        qris_url: `${backendUrl}/qris.jpeg`,
        qr_image: `/qris.jpeg`,
        amount,
        note: `Scan QRIS dan bayar Rp ${amount.toLocaleString('id-ID')} persis, lalu klik "Aku sudah bayar" — tunggu admin verif`
      });
    }

    const tripayPayload = {
      method: 'QRIS',
      merchant_ref: orderId,
      amount,
      customer_name: wa||'Customer',
      customer_email: email||'customer@mail.com',
      customer_phone: wa||'08123456789',
      order_items: [{ sku:'JIO-GEMINI-18B', name:'Google AI Pro Jio 18 Bulan', price:amount, quantity:1 }],
      callback_url: process.env.CALLBACK_URL,
      return_url: `https://web-lu.my.id/success?order=${orderId}`,
      expired_time: Math.floor(Date.now()/1000) + 30*60,
      signature: crypto.createHmac('sha256', process.env.TRIPAY_PRIVATE_KEY).update(process.env.TRIPAY_MERCHANT_CODE + orderId + amount).digest('hex')
    };

    const tripayRes = await axios.post('https://tripay.co.id/api/transaction/create', tripayPayload, {
      headers:{ 'Authorization':'Bearer '+process.env.TRIPAY_API_KEY }
    });

    const data = tripayRes.data?.data;
    db.prepare(`INSERT INTO orders (id,customer_wa,customer_email,status,tripay_ref,tripay_pay_url,tripay_qr_string,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(orderId, wa, email, 'WAITING_PAYMENT', data.reference, data.checkout_url, data.qr_string||data.qr_url, new Date().toISOString());

    res.json({ success:true, order_id: orderId, tripay:data });

  }catch(e){
    console.error(e.response?.data||e.message);
    res.status(500).json({ success:false, error: e.response?.data||e.message });
  }
});

// --- 1b. Customer klik "Aku sudah bayar" -> jadi PENDING_VERIFICATION ---
app.post('/api/confirm-payment', async (req,res)=>{
  const { orderId, order_id } = req.body;
  const id = orderId || order_id || req.body.id;
  if(!id) return res.status(400).json({ success:false, error:'orderId required' });
  const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(id);
  if(!order) return res.status(404).json({ success:false, error:'Order not found' });
  if(order.status === 'PENDING_VERIFICATION') return res.json({ success:true, status:'PENDING_VERIFICATION', msg:'Sudah menunggu verifikasi' });
  if(['PAID','RIZPRO_PAID','COMPLETED'].includes(order.status)) return res.json({ success:true, status:order.status, msg:'Sudah dibayar / diproses' });

  db.prepare(`UPDATE orders SET status='PENDING_VERIFICATION' WHERE id=?`).run(id);
  console.log(`[CONFIRM] ${id} -> PENDING_VERIFICATION (customer klik Aku sudah bayar)`);

  // Kirim notif telegram ke admin dengan tombol verifikasi
  await sendVerifButtons(order);

  // Fallback notif simple jika inline gagal
  await sendTelegram(`⏳ Customer klaim sudah bayar\nOrder: <code>${id}</code>\nWA: ${order.customer_wa}\nMenunggu verifikasi admin.`).catch(()=>{});

  res.json({ success:true, status:'PENDING_VERIFICATION', msg:'Menunggu admin verifikasi' });
});

// --- 1c. Admin verifikasi (Approve / Reject) ---
app.post('/api/admin/verify', async (req,res)=>{
  const { orderId, order_id, action } = req.body;
  const id = orderId || order_id || req.body.id;
  if(!id || !action) return res.status(400).json({ success:false, error:'orderId & action (approve/reject) required' });
  const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(id);
  if(!order) return res.status(404).json({ success:false, error:'Order not found' });

  if(action === 'approve' || action === 'APPROVE' || action === 'PAID'){
    db.prepare(`UPDATE orders SET status='PAID', paid_at=? WHERE id=?`).run(new Date().toISOString(), id);
    console.log(`[ADMIN VERIF] ${id} APPROVED -> PAID`);
    await sendTelegram(`✅ <b>Order ${id} DI-APPROVE</b>\nWA: ${order.customer_wa}\nMemulai bot order ke RizPro...`).catch(()=>{});
    // Trigger bot auto order ke RizProStore
    try{
      await axios.post('http://localhost:3001/bot/order', { orderId: id }, { timeout: 5000 });
    }catch(err){
      console.log('Bot belum jalan, simpan antrian. Trigger manual di admin.html');
      await sendTelegram(`⚠️ Bot http://localhost:3001 belum jalan.\nOrder ${id} perlu trigger manual via admin panel > Trigger Bot`).catch(()=>{});
    }
    return res.json({ success:true, status:'PAID', msg:'Approved, bot triggered' });
  } else if(action === 'reject' || action === 'REJECT'){
    db.prepare(`UPDATE orders SET status='WAITING_PAYMENT' WHERE id=?`).run(id);
    console.log(`[ADMIN VERIF] ${id} REJECTED -> balik WAITING_PAYMENT`);
    await sendTelegram(`❌ <b>Order ${id} DI-REJECT</b>\nWA: ${order.customer_wa}\nCustomer perlu bayar ulang.`).catch(()=>{});
    return res.json({ success:true, status:'WAITING_PAYMENT', msg:'Rejected, balik menunggu pembayaran' });
  } else {
    return res.status(400).json({ success:false, error:'action harus approve atau reject' });
  }
});

// --- Telegram webhook (inline button callback) ---
app.post('/api/telegram-webhook', async (req,res)=>{
  const update = req.body;
  // handle callback_query dari inline keyboard
  if(update.callback_query){
    const cq = update.callback_query;
    const data = cq.data; // approve:ORD-xxx atau reject:ORD-xxx
    const [act, orderId] = (data||'').split(':');
    const from = cq.from?.username || cq.from?.first_name || 'admin';
    console.log(`[TG WEBHOOK] ${from} klik ${act} untuk ${orderId}`);

    // jawab callback biar loading di Telegram hilang
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if(token && !token.includes('isi_')){
      await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        callback_query_id: cq.id,
        text: act==='approve' ? '✅ Approving...' : '❌ Rejecting...'
      }).catch(()=>{});
    }

    const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
    if(!order){
      if(token) await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: cq.message.chat.id, text:`❌ Order ${orderId} tidak ditemukan` }).catch(()=>{});
      return res.json({ ok:true });
    }

    if(act === 'approve'){
      db.prepare(`UPDATE orders SET status='PAID', paid_at=? WHERE id=?`).run(new Date().toISOString(), orderId);
      try{ await axios.post('http://localhost:3001/bot/order', { orderId }); }catch(e){ console.log('bot trigger via tg webhook failed', e.message); }
      if(token){
        await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `✅ APPROVED oleh @${from}\nOrder: ${orderId}\nWA: ${order.customer_wa}\nStatus: PAID → bot sedang proses RizPro...`,
          parse_mode:'HTML'
        }).catch(()=>{});
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: cq.message.chat.id, text:`✅ Order ${orderId} di-approve. Bot akan proses.` }).catch(()=>{});
      }
    } else if(act === 'reject'){
      db.prepare(`UPDATE orders SET status='WAITING_PAYMENT' WHERE id=?`).run(orderId);
      if(token){
        await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          text: `❌ REJECTED oleh @${from}\nOrder: ${orderId}\nWA: ${order.customer_wa}\nStatus: balik ke WAITING_PAYMENT`,
          parse_mode:'HTML'
        }).catch(()=>{});
      }
    }
    return res.json({ ok:true });
  }

  // handle message /start atau /verif command
  if(update.message && update.message.text){
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if(text.startsWith('/start') || text.startsWith('/help')){
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: `👋 Halo! Bot verifikasi GeminiPro\n\nPerintah:\n/verif ORD-XXX approve - approve order\n/verif ORD-XXX reject - reject order\n/pending - lihat antrian PENDING_VERIFICATION\n/stat - statistik order`
      }).catch(()=>{});
    } else if(text.startsWith('/pending')){
      const rows = db.prepare(`SELECT * FROM orders WHERE status='PENDING_VERIFICATION' ORDER BY created_at DESC LIMIT 10`).all();
      let msg = `⏳ Pending Verification (${rows.length}):\n\n`;
      rows.forEach(o=>{ msg += `• ${o.id} | WA:${o.customer_wa} | ${new Date(o.created_at).toLocaleString('id-ID')}\n`; });
      if(rows.length===0) msg+='Tidak ada antrian.';
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: msg }).catch(()=>{});
    } else if(text.startsWith('/verif')){
      const parts = text.split(' ');
      const oid = parts[1];
      const act = parts[2];
      if(oid && act){
        const r = await axios.post(`http://localhost:${process.env.PORT||4000}/api/admin/verify`, { orderId: oid, action: act }, { validateStatus:()=>true }).catch(()=>null);
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: r?.data?.msg || `Verif ${oid} ${act}: ${JSON.stringify(r?.data)}` }).catch(()=>{});
      }
    } else if(text.startsWith('/stat')){
      const s = {
        total: db.prepare(`SELECT COUNT(*) as c FROM orders`).get().c,
        pending: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='PENDING_VERIFICATION'`).get().c,
        waiting: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='WAITING_PAYMENT'`).get().c
      };
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text:`📊 Total:${s.total} | Pending:${s.pending} | Waiting:${s.waiting}` }).catch(()=>{});
    }
  }

  res.json({ ok:true });
});

// --- TELEGRAM POLLING (biar button work tanpa ngrok/webhook) ---
let pollingOffset = 0;
let pollingActive = false;
async function handleTelegramUpdate(update){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if(!token || token.includes('isi_')) return;
  // callback_query dari inline button Approve/Reject
  if(update.callback_query){
    const cq = update.callback_query;
    const data = cq.data;
    const [act, orderId] = (data||'').split(':');
    const from = cq.from?.username || cq.from?.first_name || 'admin';
    console.log(`[TG POLL] ${from} klik ${act} untuk ${orderId}`);
    await axios.post(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      callback_query_id: cq.id,
      text: act==='approve' ? '✅ Approving...' : '❌ Rejecting...'
    }).catch(()=>{});
    const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(orderId);
    if(!order){
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: cq.message.chat.id, text:`❌ Order ${orderId} tidak ditemukan` }).catch(()=>{});
      return;
    }
    if(act === 'approve'){
      db.prepare(`UPDATE orders SET status='PAID', paid_at=? WHERE id=?`).run(new Date().toISOString(), orderId);
      try{ await axios.post('http://localhost:3001/bot/order', { orderId }); }catch(e){ console.log('bot trigger failed', e.message); }
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: `✅ APPROVED oleh @${from}\nOrder: ${orderId}\nWA: ${order.customer_wa}\nStatus: PAID → bot sedang proses RizPro...`
      }).catch(()=>{});
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: cq.message.chat.id, text:`✅ Order ${orderId} di-approve. Bot akan proses.` }).catch(()=>{});
    } else if(act === 'reject'){
      db.prepare(`UPDATE orders SET status='WAITING_PAYMENT' WHERE id=?`).run(orderId);
      await axios.post(`https://api.telegram.org/bot${token}/editMessageText`, {
        chat_id: cq.message.chat.id, message_id: cq.message.message_id,
        text: `❌ REJECTED oleh @${from}\nOrder: ${orderId}\nWA: ${order.customer_wa}\nStatus: balik ke WAITING_PAYMENT`
      }).catch(()=>{});
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: cq.message.chat.id, text:`❌ Order ${orderId} di-reject, customer perlu bayar ulang.` }).catch(()=>{});
    }
    return;
  }
  // message commands (/start /pending /verif /stat atau "approve ORD-xxx")
  if(update.message && update.message.text){
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();
    if(text.startsWith('/start') || text.startsWith('/help')){
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: `👋 Halo! Bot Verifikasi GeminiPro\n\nOrder baru akan muncul dengan tombol:\n✅ Approve & Proses  |  ❌ Reject\n\nPerintah manual:\n/verif ORD-XXX approve - approve order\n/verif ORD-XXX reject - reject order\napprove ORD-XXX - (tanpa slash juga bisa)\n/pending - lihat antrian\n/stat - statistik`
      }).catch(()=>{});
    } else if(text.startsWith('/pending') || text==='pending'){
      const rows = db.prepare(`SELECT * FROM orders WHERE status='PENDING_VERIFICATION' ORDER BY created_at DESC LIMIT 10`).all();
      let msg = `⏳ Pending Verification (${rows.length}):\n\n`;
      rows.forEach(o=>{ msg += `• ${o.id} | WA:${o.customer_wa} | ${new Date(o.created_at).toLocaleString('id-ID')}\n`; });
      if(rows.length===0) msg+='Tidak ada antrian.';
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: msg }).catch(()=>{});
    } else if(text.startsWith('/verif') || text.toLowerCase().startsWith('approve ') || text.toLowerCase().startsWith('reject ')){
      let oid, act;
      if(text.startsWith('/verif')){
        const parts = text.split(' '); oid = parts[1]; act = parts[2];
      } else {
        const parts = text.split(' '); act = parts[0].toLowerCase().replace('/',''); oid = parts[1];
      }
      if(oid && act){
        const r = await axios.post(`http://localhost:${process.env.PORT||3000}/api/admin/verify`, { orderId: oid, action: act }, { validateStatus:()=>true }).catch(()=>null);
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: r?.data?.msg || `Verif ${oid} ${act}: ${JSON.stringify(r?.data)}` }).catch(()=>{});
      }
    } else if(text.startsWith('/stat')){
      const s = {
        total: db.prepare(`SELECT COUNT(*) as c FROM orders`).get().c,
        pending: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='PENDING_VERIFICATION'`).get().c,
        waiting: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='WAITING_PAYMENT'`).get().c
      };
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text:`📊 Total:${s.total} | Pending:${s.pending} | Waiting:${s.waiting}` }).catch(()=>{});
    }
  }
}
async function startTelegramPolling(){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if(!token || token.includes('isi_')){ console.log('[TG POLL] skip - token belum diset'); return; }
  if(pollingActive) return; pollingActive = true;
  console.log('[TG POLL] Starting long-polling...');
  // hapus webhook dulu biar polling bisa jalan (Telegram tidak boleh webhook + polling barengan)
  try{ await axios.post(`https://api.telegram.org/bot${token}/deleteWebhook`, { drop_pending_updates: false }); }catch(e){}
  while(pollingActive){
    try{
      const r = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, { params:{ offset: pollingOffset, timeout: 25 }, timeout: 30000 });
      const updates = r.data?.result || [];
      for(const u of updates){
        pollingOffset = u.update_id + 1;
        await handleTelegramUpdate(u);
      }
    }catch(e){
      if(e.code !== 'ECONNABORTED') console.log('[TG POLL] err', e.message);
      await new Promise(r=>setTimeout(r, 3000));
    }
  }
}

// helper set webhook via API (panggil sekali - polling akan auto-disable webhook)
app.post('/api/telegram/set-webhook', async (req,res)=>{
  const { url } = req.body;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if(!token) return res.status(400).json({ error:'TELEGRAM_BOT_TOKEN belum isi' });
  if(!url){
    // jika url kosong = disable webhook & switch ke polling
    try{
      const r = await axios.post(`https://api.telegram.org/bot${token}/deleteWebhook`, {});
      pollingOffset = 0; if(!pollingActive) startTelegramPolling();
      return res.json({ ok:true, msg:'Webhook dihapus, polling aktif', result:r.data });
    }catch(e){ return res.status(500).json({ error:e.response?.data||e.message }); }
  }
  try{
    pollingActive = false; // stop polling kalau mau pakai webhook
    const r = await axios.post(`https://api.telegram.org/bot${token}/setWebhook`, { url });
    res.json(r.data);
  }catch(e){ res.status(500).json({ error:e.response?.data||e.message }); }
});
app.get('/api/telegram/webhook-info', async (req,res)=>{
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if(!token) return res.status(400).json({ error:'token belum isi' });
  const r = await axios.get(`https://api.telegram.org/bot${token}/getWebhookInfo`).catch(e=>e.response);
  res.json(r.data);
});
app.get('/api/telegram/polling-status', (req,res)=> res.json({ active: pollingActive, offset: pollingOffset }));
app.post('/api/telegram/start-polling', (req,res)=>{ if(!pollingActive) startTelegramPolling(); res.json({ ok:true, active: pollingActive }); });

// --- 2. Tripay callback (customer sudah bayar di web lu) ---
app.post('/api/tripay-callback', async (req,res)=>{
  const { merchant_ref, status } = req.body; // status PAID / EXPIRED etc
  console.log('Tripay callback:', req.body);

  // Validasi signature Tripay (penting!)
  const sig = req.headers['x-callback-signature'];
  const expected = crypto.createHmac('sha256', process.env.TRIPAY_PRIVATE_KEY||'dummy').update(JSON.stringify(req.body)).digest('hex');
  // if(sig !== expected) return res.status(401).end();

  if(status === 'PAID'){
    const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(merchant_ref);
    if(order){
      db.prepare(`UPDATE orders SET status='PAID', paid_at=? WHERE id=?`).run(new Date().toISOString(), merchant_ref);
      
      // TRIGGER BOT AUTO ORDER KE RIZPROSTORE
      console.log(`[TRIGGER] Order ${merchant_ref} PAID -> auto order ke RizProStore`);
      try{
        await axios.post('http://localhost:3001/bot/order', { orderId: merchant_ref });
      }catch(err){
        console.log('Bot belum jalan, order masuk antrian manual. Cek http://localhost:3001');
        if(process.env.TELEGRAM_BOT_TOKEN){
          const msg = `🔔 Order PAID ${merchant_ref}\nWA: ${order.customer_wa}\nAction: Bot auto order RizProStore perlu di-trigger manual`;
          await sendTelegram(msg).catch(()=>{});
        }
      }
    }
  }
  res.json({ success:true });
});

// --- 3. Cek status order (polling dari frontend) ---
app.get('/api/order/:id', (req,res)=>{
  const order = db.prepare(`SELECT * FROM orders WHERE id=?`).get(req.params.id);
  if(!order) return res.status(404).json({ error:'not found' });
  res.json(order);
});

// --- 3b. Admin: list semua orders + stats ---
app.get('/api/orders', (req,res)=>{
  const { status, limit=100 } = req.query;
  let rows;
  if(status) rows = db.prepare(`SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT ?`).all(status, parseInt(limit));
  else rows = db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`).all(parseInt(limit));
  const stats = {
    total: db.prepare(`SELECT COUNT(*) as c FROM orders`).get().c,
    waiting: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='WAITING_PAYMENT'`).get().c,
    pending: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='PENDING_VERIFICATION'`).get().c,
    paid: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='PAID'`).get().c,
    completed: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status='COMPLETED'`).get().c,
    revenue: db.prepare(`SELECT COUNT(*) as c FROM orders WHERE status IN ('PAID','RIZPRO_PAID','COMPLETED','PENDING_VERIFICATION')`).get().c * parseInt(process.env.HARGA_JUAL||'100000')
  };
  res.json({ stats, orders: rows });
});

app.delete('/api/order/:id', (req,res)=>{
  db.prepare(`DELETE FROM orders WHERE id=?`).run(req.params.id);
  res.json({ success:true });
});

// --- 4. Endpoint untuk bot update setelah dapet link aktivasi dari RizPro ---
app.post('/api/rizpro-result', (req,res)=>{
  const { orderId, rizpro_qr_string, activation_link } = req.body;
  db.prepare(`UPDATE orders SET rizpro_qr_string=?, activation_link=?, status=? WHERE id=?`)
    .run(rizpro_qr_string||'', activation_link||'', activation_link ? 'COMPLETED' : 'RIZPRO_PAID', orderId);
  
  // notif ke customer via WA (integrasi Fonnte/Wablas bisa ditambah disini)
  console.log(`[DONE] Order ${orderId} link: ${activation_link}`);
  if(activation_link){
    sendTelegram(`✅ <b>SELESAI ${orderId}</b>\nLink: <code>${activation_link}</code>\nCustomer: ${db.prepare(`SELECT customer_wa FROM orders WHERE id=?`).get(orderId)?.customer_wa}`).catch(()=>{});
  }
  res.json({ success:true });
});

// dummy pay page untuk testing tanpa Tripay — tampilkan QRIS statis lu
app.get('/pay/:id', (req,res)=>{
  const o = db.prepare(`SELECT * FROM orders WHERE id=?`).get(req.params.id);
  if(!o) return res.status(404).send('Order not found');
  const amount = parseInt(process.env.HARGA_JUAL||'100000');
  const isPending = o.status==='PENDING_VERIFICATION';
  const isPaid = ['PAID','RIZPRO_PAID','COMPLETED'].includes(o.status);
  const pendingHtml = isPending ? `<div style="background:#fef9c3;border:1px solid #fde047;padding:12px;border-radius:12px;margin-top:12px;font-size:13px">⏳ <b>Menunggu admin verifikasi...</b><br>Customer sudah klik "Aku sudah bayar".<br>Admin cek mutasi lalu verifikasi via Telegram / Admin Panel.<br><span style="font-size:11px;color:#888">Status: PENDING_VERIFICATION</span></div>` : '';
  const paidHtml = isPaid ? `<div style="background:#dcfce7;border:1px solid #86efac;padding:12px;border-radius:12px;margin-top:12px;font-size:13px">✅ <b>Sudah di-verifikasi & diproses</b><br>Status: ${o.status}${o.activation_link?`<br><a href="${o.activation_link}" target="_blank" style="color:#15803d;font-weight:800;word-break:break-all">${o.activation_link}</a>`:''}</div>` : '';
  const actionBtn = o.status==='WAITING_PAYMENT' ? `<button id="payBtn" onclick="confirmPay()" style="background:#f7d64a;border:0;padding:16px 20px;border-radius:12px;font-weight:800;width:100%;cursor:pointer;margin-top:12px;font-size:15px">✅ Aku Sudah Bayar — Verifikasi Manual</button><p style="font-size:11px;color:#888;margin-top:8px">Klik setelah kamu transfer. Admin akan verifikasi 1-5 menit.</p>` : '';
  res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:system-ui;max-width:480px;margin:32px auto;padding:20px;background:#fbf8e8} .card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 4px 16px rgba(0,0,0,.08);text-align:center} img{max-width:320px;width:100%;border-radius:12px;border:1px solid #eee} .mono{font-family:monospace;background:#f5f5f5;padding:2px 6px;border-radius:6px;font-size:12px}</style></head><body>
  <div class="card"><h2>Bayar Rp ${amount.toLocaleString('id-ID')}</h2><p class="mono">${o.id}</p><p>WA: ${o.customer_wa} • <b>${o.status}</b></p>
  <img src="/qris.jpeg" alt="QRIS"><p style="font-size:13px;color:#555;margin-top:8px">Scan QRIS ini (a.n. QRIS lu) dan bayar <b>Rp ${amount.toLocaleString('id-ID')}</b> persis.</p>
  ${pendingHtml}${paidHtml}${actionBtn}
  <div id="msg" style="margin-top:12px;font-size:13px"></div>
  <p style="font-size:11px;color:#888;margin-top:14px"><a href="/">← Kembali ke Store</a> • <a href="/api/order/${o.id}" target="_blank">Cek JSON</a></p></div>
  <script>
    async function confirmPay(){
      const btn=document.getElementById('payBtn');
      btn.disabled=true; btn.innerText='Mengirim...';
      try{
        const r=await fetch('/api/confirm-payment',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:'${o.id}'})});
        const j=await r.json();
        document.getElementById('msg').innerHTML='<div style="background:#fef9c3;border:1px solid #fde047;padding:12px;border-radius:12px">⏳ <b>Tunggu admin verif ya</b><br>'+j.msg+'<br>Admin akan cek mutasi & verifikasi via Telegram.</div>';
        btn.innerText='✅ Sudah dikirim — tunggu verif';
        setTimeout(()=>location.reload(),2500);
      }catch(e){ document.getElementById('msg').innerText='Gagal: '+e.message; btn.disabled=false; btn.innerText='✅ Aku Sudah Bayar — Verifikasi Manual'; }
    }
  </script></body></html>`);
});
app.post('/api/simulate-paid', express.urlencoded({extended:true}), async (req,res)=>{
  const orderId = req.body.orderId;
  await axios.post(`http://localhost:${process.env.PORT||4000}/api/tripay-callback`, { merchant_ref: orderId, status:'PAID' }).catch(()=>{});
  res.send(`Simulated PAID for ${orderId}. Cek <a href="/api/order/${orderId}">/api/order/${orderId}</a> | Bot akan auto trigger (legacy)`);
});

app.get('/', (req,res)=> res.json({ ok:true, msg:'RizPro Dropship Backend Opsi A - Ready', endpoints:['POST /api/create-order','POST /api/confirm-payment','POST /api/admin/verify','POST /api/telegram-webhook','GET /api/order/:id','GET /api/orders','DELETE /api/order/:id'] }));

app.listen(process.env.PORT||3000, ()=> {
  console.log(`Backend jalan di http://localhost:${process.env.PORT||3000}`);
  // auto-start polling kalau token sudah isi
  if(process.env.TELEGRAM_BOT_TOKEN && !process.env.TELEGRAM_BOT_TOKEN.includes('isi_')){
    startTelegramPolling();
  }
});
