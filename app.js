const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');
const winston = require('winston');
const net = require('net');

// --- LOGGER SETUP ---
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' }),
  ],
});
if (process.env.NODE_ENV !== 'production') logger.add(new winston.transports.Console({ format: winston.format.simple() }));

// --- MODULES ---
const { createssh, createvmess, createvless, createtrojan } = require('./modules/create');
const { renewssh, renewvmess, renewvless, renewtrojan } = require('./modules/renew');

// --- CONFIG ---
const vars = JSON.parse(fs.readFileSync('./.vars.json', 'utf8'));
const BOT_TOKEN = vars.BOT_TOKEN;
const port = vars.PORT || 6969;
const ADMIN = vars.USER_ID; 
const API_KEY = vars.API_KEY || ""; // API key gateway pembayaran — isi di .vars.json
const GROUP_ID = vars.GROUP_ID;
const NAMA_STORE = vars.NAMA_STORE || "VPN PREMIUM STORE";

// --- SETTINGAN BISNIS ---
const AUTO_RESELLER_MIN = 30000; 
const BONUS_MIN_TOPUP = 10000;   
const BONUS_PERCENT = 0.10;      
const RESELLER_DISC = 0.20;      
const RESELLER_TARGET = 3;       
const TRIAL_QUOTA = 1;          
const TRIAL_IPLIMIT = 1;        
const TRIAL_EXP = 1;
const TRIAL_MINUTES = 60;       // durasi trial (menit) — auto-hapus via panel
const TRIAL_MAX_PER_DAY = 2;     // batas trial member per hari (reset tiap hari, WIB)            
const PAYMENT_EXP_MINUTES = 10;
const MIN_TOPUP = 5000; 

// 🟢 KONFIGURASI API MAMZPAY
const MAMZPAY_API_URL = vars.MAMZPAY_API_URL || ""; // contoh: http://IP-GATEWAY:PORT/api/payment/create
const MAMZPAY_STATUS_URL = vars.MAMZPAY_STATUS_URL || ""; // contoh: http://IP-GATEWAY:PORT/api/payment/status

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const adminIds = [parseInt(ADMIN)]; 
const userState = {};
global.depositState = {};
global.pendingDeposits = {};
global.processedTransactions = new Set();
let lastRequestTime = 0;
let reportSentDate = ''; 

// --- DATABASE SETUP ---
const db = new sqlite3.Database('./sellvpn.db', (err) => {
  if (err) logger.error('DB Error:', err.message);
  else logger.info('Connected to SQLite');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS pending_deposits (unique_code TEXT PRIMARY KEY, user_id INTEGER, amount INTEGER, original_amount INTEGER, timestamp INTEGER, status TEXT, qr_message_id INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS Server (id INTEGER PRIMARY KEY AUTOINCREMENT, domain TEXT, auth TEXT, harga INTEGER, nama_server TEXT, quota INTEGER, iplimit INTEGER, batas_create_akun INTEGER, total_create_akun INTEGER)`);
// [adapter] migrasi: tambah kolom tipe (fightertunnel/railway/panel)
db.all(`PRAGMA table_info(Server)`, [], (e, cols) => {
  if (!e && cols && !cols.some(c => c.name === 'tipe')) {
    db.run(`ALTER TABLE Server ADD COLUMN tipe TEXT DEFAULT 'fightertunnel'`, () =>
      console.log('[adapter] kolom Server.tipe ditambahkan'));
  }
});
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE, saldo INTEGER DEFAULT 0, last_trial INTEGER DEFAULT 0, level TEXT DEFAULT 'member', trx_month INTEGER DEFAULT 0)`);
    db.run("ALTER TABLE users ADD COLUMN trial_count INTEGER DEFAULT 0", () => {});
    db.run("ALTER TABLE users ADD COLUMN trial_date TEXT DEFAULT ''", () => {});
    db.run("ALTER TABLE users ADD COLUMN days_month INTEGER DEFAULT 0", () => {});
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER, type TEXT, info TEXT, timestamp INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS active_services (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, server_name TEXT, protocol TEXT, expired_at INTEGER, reminded INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
});
// ===== State reset bulanan otomatis & poin v2 =====
let SETTING_LAST_RESET = '';
let POIN_V2 = false;
let TARGET_OMZET = 0;
function setSetting(key, value) { db.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)], () => {}); }
function prevPeriodStr(base) { const d = new Date(base.getFullYear(), base.getMonth() - 1, 1); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
db.all("SELECT key, value FROM settings WHERE key IN ('last_reset_period','poin_v2','target_omzet')", [], (err, rows) => {
    if (!err && rows) rows.forEach(r => {
        if (r.key === 'last_reset_period') SETTING_LAST_RESET = r.value || '';
        if (r.key === 'poin_v2') POIN_V2 = r.value === '1';
        if (r.key === 'target_omzet') TARGET_OMZET = parseInt(r.value) || 0;
    });
    if (!SETTING_LAST_RESET) {
        const jkt0 = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        SETTING_LAST_RESET = prevPeriodStr(jkt0);
        setSetting('last_reset_period', SETTING_LAST_RESET);
    }
    console.log('[RESET-OTOMATIS] siap. Periode tertutup terakhir: ' + SETTING_LAST_RESET + ' | POIN_V2=' + POIN_V2 + ' | Target omzet: Rp ' + new Intl.NumberFormat('id-ID').format(TARGET_OMZET));
});


db.all('SELECT * FROM pending_deposits WHERE status = "pending"', [], (err, rows) => {
  if (!err && rows) {
    rows.forEach(row => {
      // Baris zombie (unique_code kosong) atau invoice yang sudah expired selama bot mati:
      // bersihkan diam-diam dari DB + hapus pesan QR-nya, TANPA notif kadaluarsa.
      // (Dulu baris zombie unique_code NULL lolos terus -> notif "TAGIHAN KADALUARSA" ke user tiap restart.)
      if (!row.unique_code || (Date.now() - row.timestamp > PAYMENT_EXP_MINUTES * 60000)) {
        db.run("DELETE FROM pending_deposits WHERE unique_code IS ?", [row.unique_code]);
        if (row.qr_message_id) bot.telegram.deleteMessage(row.user_id, row.qr_message_id).catch(()=>{});
        return;
      }
      global.pendingDeposits[row.unique_code] = {
        amount: row.amount, original: row.original_amount, uid: row.user_id,
        time: row.timestamp, status: row.status, msgId: row.qr_message_id
      };
    });
  }
});

function getFlag(name) {
    if (/id|indo|jakarta/i.test(name)) return '🇮🇩';
    if (/sg|singa|sin/i.test(name)) return '🇸🇬';
    if (/us|usa|united/i.test(name)) return '🇺🇸';
    if (/my|malay/i.test(name)) return '🇲🇾';
    if (/jp|japan/i.test(name)) return '🇯🇵';
    if (/hk|hongkong/i.test(name)) return '🇭🇰';
    return '🏳️'; 
}

function keyboard_nomor() {
    return [
        [{text:'⚡ Rp 5.000',callback_data:'preset_5000'},{text:'⚡ Rp 10.000',callback_data:'preset_10000'},{text:'⚡ Rp 30.000',callback_data:'preset_30000'}],
        [{text:'1',callback_data:'1'},{text:'2',callback_data:'2'},{text:'3',callback_data:'3'}],
        [{text:'4',callback_data:'4'},{text:'5',callback_data:'5'},{text:'6',callback_data:'6'}],
        [{text:'7',callback_data:'7'},{text:'8',callback_data:'8'},{text:'9',callback_data:'9'}],
        [{text:'🔙 Hapus',callback_data:'delete'},{text:'0',callback_data:'0'},{text:'✅ Lanjut',callback_data:'confirm'}],
        [{text:'🏠 Batal',callback_data:'send_main_menu'}]
    ];
}

function calculateMonthlyBonus(points) {
    if (POIN_V2) {
        if (points >= 26) return 35000;
        if (points >= 21) return 25000;
        if (points >= 16) return 15000;
        if (points >= 11) return 5000;
        if (points >= 5)  return 2000;
        if (points === 4) return 1500;
        if (points >= 2)  return 500;
        return 0;
    }
    if (points >= 26) return 35000;
    if (points >= 21) return 25000;
    if (points >= 16) return 15000;
    if (points >= 11) return 5000;
    if (points >= 5)  return 2000;
    return 0;
}

function calculateExpiry(days) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    targetDate.setHours(0, 0, 0, 0); 
    return targetDate.getTime();
}

async function checkServerStatus(serverOrHost) {
    // [adapter] cek per-tipe: object server (ada kolom tipe) -> pakai adapter
    if (typeof serverOrHost === 'object' && serverOrHost !== null && serverOrHost.tipe) {
        try { return await require('./modules/server-adapter').checkStatus(serverOrHost); }
        catch (e) { return false; }
    }
    let domain = '';
    if (typeof serverOrHost === 'object' && serverOrHost !== null) {
        domain = serverOrHost.domain || '';
    } else if (typeof serverOrHost === 'string') {
        domain = serverOrHost;
    }

    domain = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();

    try {
        const res = await axios.get('https://' + domain + '/api/status', { timeout: 4000 });
        if (res.data && res.data.status === true) {
            return true;
        }
    } catch (e) {}

    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2500); 
        socket.connect(22, domain, () => { socket.destroy(); resolve(true); });
        socket.on('error', () => { socket.destroy(); resolve(false); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
}

setInterval(() => {
    const NOW = Date.now();
    db.all("SELECT * FROM active_services WHERE reminded = 0 AND expired_at > ?", [NOW], (err, rows) => {
        if(!rows) return;
        rows.forEach(row => {
            const timeLeft = row.expired_at - NOW;
            const daysLeft = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
            if (daysLeft <= 3) {
                const expDate = new Date(row.expired_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
                const sisaTeks = daysLeft <= 0 ? "⚠️ HARI INI (Jam 00:00)" : `⏳ ${daysLeft} Hari Lagi`;
                const msg = `⚠️ *PENGINGAT MASA AKTIF*\n━━━━━━━━━━━━━━━━━━\nHalo, akun VPN Anda akan segera berakhir!\n\n👤 Username: \`${row.username}\`\n📦 Server: ${row.server_name}\n${sisaTeks}\n📅 Tgl Expired: ${expDate} Jam 00:00\n\n⛔ *PENTING:*\nHarap perpanjang *SEBELUM* tanggal ${expDate}. \nJika lewat dari tanggal tersebut, *JANGAN DIPERPANJANG* karena akun sudah otomatis terhapus server (Gagal).`;
                bot.telegram.sendMessage(row.user_id, msg, {parse_mode:'Markdown'}).catch(()=>{});
                db.run("UPDATE active_services SET reminded = 1 WHERE id = ?", [row.id]);
            }
        });
    });

    const jktTime = new Date().toLocaleString("en-US", {timeZone: "Asia/Jakarta"});
    const dt = new Date(jktTime);
    const dateStr = dt.toDateString(); 
    if (dt.getHours() === 23 && dt.getMinutes() === 59 && reportSentDate !== dateStr) {
        reportSentDate = dateStr; 
        const startOfDay = new Date(jktTime);
        startOfDay.setHours(0,0,0,0);
        const startTs = startOfDay.getTime();
        db.all("SELECT * FROM transactions WHERE timestamp >= ?", [startTs], (err, trxs) => {
            let totalJual = 0, countJual = 0, totalDepo = 0, countDepo = 0;
            if (trxs) {
                trxs.forEach(t => {
                    if (t.type === 'buy') { totalJual += t.amount; countJual++; }
                    if (t.type === 'deposit') { totalDepo += t.amount; countDepo++; }
                });
            }
            const jualFmt = new Intl.NumberFormat('id-ID').format(totalJual);
            const depoFmt = new Intl.NumberFormat('id-ID').format(totalDepo);
            const tglLaporan = dt.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            const reportMsg = `🌙 *LAPORAN HARIAN OTOMATIS*\n📅 ${tglLaporan}\n━━━━━━━━━━━━━━━━━━\n\n🛒 *PENJUALAN (SALDO KELUAR)*\n• Transaksi: ${countJual}\n• Total: *Rp ${jualFmt}*\n\n💰 *DEPOSIT (UANG MASUK)*\n• Transaksi: ${countDepo}\n• Total: *Rp ${depoFmt}*\n\n_Laporan ini dikirim otomatis setiap jam 23:59 WIB._`;
            adminIds.forEach(aid => bot.telegram.sendMessage(aid, reportMsg, {parse_mode:'Markdown'}).catch(()=>{}));
        });
    }
}, 60000); 

async function sendMainMenu(ctx) {
    const userId = ctx.from.id;
    const name = ctx.from.first_name || 'Partner';
    db.get('SELECT value FROM settings WHERE key = ?', ['info_bar'], (err, setting) => {
        const infoBar = setting ? `🔔 *INFO:* ${setting.value}\n\n` : '';
        db.get('SELECT saldo, level, trx_month FROM users WHERE user_id = ?', [userId], (err, row) => {
            const saldo = row ? row.saldo : 0;
            const level = row ? row.level : 'member';
            const poin = row ? row.trx_month : 0;
            const saldoFmt = new Intl.NumberFormat('id-ID').format(saldo);
            const levelIcon = level === 'reseller' ? '👑 RESELLER' : '👤 MEMBER';
            const bonusList = POIN_V2 ? `\n   • 2-3 Poin ➡️ Rp 500\n   • 4 Poin ➡️ Rp 1.500\n   • 5-10 Poin ➡️ Rp 2.000\n   • 11-15 Poin ➡️ Rp 5.000\n   • 16-20 Poin ➡️ Rp 15.000\n   • 21-25 Poin ➡️ Rp 25.000\n   • 26+ Poin ➡️ Rp 35.000` : `\n   • 5-10 Poin ➡️ Rp 2.000\n   • 11-15 Poin ➡️ Rp 5.000\n   • 16-20 Poin ➡️ Rp 15.000\n   • 21-25 Poin ➡️ Rp 25.000\n   • > 26 Poin ➡️ Rp 35.000`;
            const msg = `━━━━━━━━━━━━━━━━━━\n🚀  *MAMZ STORE* 🚀\n━━━━━━━━━━━━━━━━━━\nSelamat datang, *${name}*!\n\n${infoBar}📊 *STATISTIK ANDA:*\n🆔 ID: \`${userId}\`\n💰 Saldo: *Rp ${saldoFmt}*\n🔰 Level: *${levelIcon}*\n🏆 Poin: *${poin}*\n\n🎁 *PROMO SPESIAL:*\n1️⃣ Deposit > 10rb : *Bonus Saldo 10%*\n2️⃣ Deposit > 30rb : *Otomatis Upgrade RESELLER!* 👑\n3️⃣ Ayo kumpulkan poin untuk mendapatkan bonus:${bonusList}\n\n👇 *SILAKAN PILIH MENU:*`;
            const kb = [
                [{ text: '🛒 Beli VPN', callback_data: 'service_create' }, { text: '🎁 Trial Gratis', callback_data: 'service_trial' }],
                [{ text: '🔄 Perpanjang', callback_data: 'service_renew' }, { text: '📊 Status Server', callback_data: 'check_all_servers' }],
                [{ text: '💳 Isi Saldo', callback_data: 'topup_saldo' }, { text: 'ℹ️ Info Server', callback_data: 'listserver' }],
                [{ text: '📞 Bantuan Admin', url: 'https://t.me/' + (vars.ADMIN_USERNAME || 'admin') }]
            ];
            if (ctx.updateType === 'callback_query') {
                ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
            } else {
                ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
            }
        });
    });
}

bot.command(['start', 'menu'], async (ctx) => {
    db.run('INSERT OR IGNORE INTO users (user_id) VALUES (?)', [ctx.from.id]);
    await sendMainMenu(ctx);
});

bot.action('send_main_menu', async (ctx) => {
    delete userState[ctx.from.id];
    delete global.depositState[ctx.from.id];
    await sendMainMenu(ctx);
});

bot.command(['layanan', 'myservices', 'cekakun'], (ctx) => {
    const now = Date.now();
    db.all("SELECT * FROM active_services WHERE user_id = ? AND expired_at > ?", [ctx.from.id, now], (err, rows) => {
        if (!rows || rows.length === 0) return ctx.reply('⚠️ Anda belum memiliki layanan aktif.', {parse_mode:'Markdown'});
        let msg = `📦 *LAYANAN AKTIF ANDA*\n━━━━━━━━━━━━━━━━━━\n\n`;
        rows.forEach((row, i) => {
            const timeLeft = row.expired_at - now;
            const daysLeft = Math.floor(timeLeft / (1000 * 60 * 60 * 24));
            const expDate = new Date(row.expired_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
            msg += `${i+1}. 👤 *${row.username}* (${row.protocol.toUpperCase()})\n   🖥️ Server: ${row.server_name}\n   📅 Exp: ${expDate} (Jam 00:00)\n   ⏳ Sisa: ${daysLeft} Hari lagi\n\n`;
        });
        ctx.reply(msg, {parse_mode:'Markdown'});
    });
});

bot.action('check_all_servers', async (ctx) => {
    const msg = await ctx.editMessageText('⏳ *Sedang mengecek status semua server...*\nMohon tunggu sebentar.', {parse_mode:'Markdown'});
    db.all('SELECT * FROM Server', [], async (err, servers) => {
        if (!servers || servers.length === 0) return ctx.editMessageText('⚠️ Belum ada data server.');
        let report = `📊 *STATUS REAL-TIME SERVER*\n━━━━━━━━━━━━━━━━━━\n\n`;
        for (const s of servers) {
            const isOnline = await checkServerStatus(s);
            const statusIcon = isOnline ? '🟢 ONLINE ✅' : '🔴 OFFLINE ❌';
            report += `🖥️ *${s.nama_server}*\n   └ Status: ${statusIcon}\n\n`;
        }
        report += `_Terakhir dicek: ${new Date().toLocaleTimeString('id-ID')}_`;
        ctx.editMessageText(report, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{text:'🔄 Refresh', callback_data:'check_all_servers'}],[{text:'🔙 Menu Utama', callback_data:'send_main_menu'}]] } });
    });
});

bot.command('admin', async (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return ctx.reply('🚫 *Akses Ditolak!* Anda bukan admin.', {parse_mode:'Markdown'});
    await sendAdminMenu(ctx);
});

bot.command('setinfo', (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return;
    const text = ctx.message.text.replace('/setinfo', '').trim();
    if (!text) return ctx.reply('⚠️ Format: `/setinfo [Pesan Pengumuman]`', {parse_mode:'Markdown'});
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", ['info_bar', text], () => ctx.reply('✅ Info Bar berhasil diperbarui!'));
});

bot.command('delinfo', (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return;
    db.run("DELETE FROM settings WHERE key = ?", ['info_bar'], () => ctx.reply('✅ Info Bar dihapus!'));
});

bot.command('fixsaldo', (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return;
    db.run("UPDATE users SET saldo = 0 WHERE user_id = ?", [ctx.from.id], () => ctx.reply('✅ *SALDO DI-RESET KE 0*\nSekarang silakan coba `/addsaldo` lagi.', {parse_mode:'Markdown'}));
});

bot.command('broadcast', async (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return;
    if (!ctx.message.reply_to_message) return ctx.reply('⚠️ *INFO:* Silakan balas (reply) pesan/gambar yang ingin dibroadcast.', {parse_mode:'Markdown'});
    const sourceMsg = ctx.message.reply_to_message;
    const loading = await ctx.reply('⏳ *Sedang mengirim broadcast...*', {parse_mode:'Markdown'});
    db.all("SELECT user_id FROM users", [], async (err, rows) => {
        let success = 0;
        for (const row of rows) {
            try { await bot.telegram.copyMessage(row.user_id, ctx.chat.id, sourceMsg.message_id); success++; } catch (e) {}
            await new Promise(r => setTimeout(r, 50)); 
        }
        try { ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id); } catch(e){}
        ctx.reply(`✅ *BROADCAST SELESAI*\n📢 Terkirim ke: ${success} User`, {parse_mode:'Markdown'});
    });
});

bot.command('addsaldo', (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return;
    const args = ctx.message.text.split(' ');
    if (args.length !== 3) return ctx.reply('⚠️ Format: `/addsaldo [ID] [Jumlah]`', {parse_mode:'Markdown'});
    const targetId = parseInt(args[1]);
    const amount = parseInt(args[2]);
    if (isNaN(amount)) return ctx.reply('❌ Jumlah harus angka!');
    db.run("UPDATE users SET saldo = COALESCE(saldo, 0) + ? WHERE user_id = ?", [amount, targetId], function(err) {
        if (this.changes > 0) {
             db.get('SELECT saldo FROM users WHERE user_id = ?', [targetId], (err, row) => {
                 const newSaldo = new Intl.NumberFormat('id-ID').format(row.saldo);
                 const amtFmt = new Intl.NumberFormat('id-ID').format(amount);
                 db.run("INSERT INTO transactions (user_id, amount, type, info, timestamp) VALUES (?, ?, ?, ?, ?)", [targetId, amount, 'deposit', 'Manual Admin', Date.now()]);
                 ctx.reply(`✅ *BERHASIL TAMBAH SALDO*\n━━━━━━━━━━━━━━━━━━\n👤 User ID: \`${targetId}\`\n➕ Nominal: Rp ${amtFmt}\n💰 Total Saldo: Rp ${newSaldo}`, {parse_mode:'Markdown'});
                 bot.telegram.sendMessage(targetId, `💳 *SALDO DITAMBAHKAN*\nAdmin telah menambahkan saldo Anda.\n\n➕ Nominal: Rp ${amtFmt}\n💰 Total Saldo: Rp ${newSaldo}`, {parse_mode:'Markdown'});
                 if (GROUP_ID) bot.telegram.sendMessage(GROUP_ID, `💸 *TOPUP BERHASIL*\n━━━━━━━━━━━━━━\n👤 User: \`${targetId}\`\n💰 Nominal: Rp ${amtFmt}\n⚙️ Jalur: Manual Admin`, {parse_mode:'Markdown'}).catch(()=>{});
             });
        } else {
            ctx.reply('❌ User ID tidak ditemukan di database.');
        }
    });
});

async function sendAdminMenu(ctx) {
    const kb = [
        [{ text: '➕ Add Server', callback_data: 'addserver' }, { text: '❌ Del Server', callback_data: 'deleteserver' }],
        [{ text: '💲 Edit Harga', callback_data: 'editserver_harga' }, { text: '📝 Edit Nama', callback_data: 'nama_server_edit' }],
        [{ text: '🌐 Edit Domain', callback_data: 'editserver_domain' }, { text: '🔑 Edit Auth', callback_data: 'editserver_auth' }],
        [{ text: '📊 Edit Quota', callback_data: 'editserver_quota' }, { text: '📶 Edit Limit IP', callback_data: 'editserver_limit_ip' }],
        [{ text: '🔢 Batas Create', callback_data: 'editserver_batas_create_akun' }, { text: '👥 Total Create', callback_data: 'editserver_total_create_akun' }],
        [{ text: '🏷️ Edit Tipe Server', callback_data: 'editserver_tipe' }], // [adapter] v2
        [{ text: '🏆 LIST POIN', callback_data: 'list_poin_active' }, { text: '🔍 Cek User', callback_data: 'check_user_stats' }],
        [{ text: '💵 Add Saldo', callback_data: 'addsaldo_user' }, { text: '⬆️ Set Reseller', callback_data: 'manual_reseller' }],
        [{ text: '🎯 Target Omzet', callback_data: 'set_target_omzet' }, { text: '📅 RESET BULANAN', callback_data: 'monthly_reset' }],
        [{ text: '♻️ Reset Database', callback_data: 'resetdb' }],
        [{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]
    ];
    const msg = `🛠️ *PANEL ADMINISTRATOR*\nSilakan kelola server dan user dari sini.`;
    if (ctx.updateType === 'callback_query') ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
    else ctx.reply(msg, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

bot.action('addserver', (ctx) => { userState[ctx.from.id] = { step: 'addserver' }; ctx.reply('🌐 Masukkan Domain/IP:'); });
// [adapter] pilih tipe server saat tambah server
bot.action(/srvtipe_(.+)/, (ctx) => {
  const userId = ctx.from.id, st = userState[userId];
  if (!st || st.step !== 'add_tipe') return ctx.answerCbQuery();
  const tipe = ctx.match[1];
  db.run("INSERT INTO Server (domain,auth,nama_server,quota,iplimit,batas_create_akun,harga,total_create_akun,tipe) VALUES (?,?,?,?,?,?,?,?,?)",
    [st.domain, st.auth, st.nama, st.quota, st.ip, st.create, st.harga, 0, tipe],
    () => ctx.editMessageText('✅ Server tersimpan (tipe: ' + tipe + ').').catch(()=>{}));
  delete userState[userId];
  ctx.answerCbQuery();
});
bot.action('addsaldo_user', (ctx) => { userState[ctx.from.id] = { step: 'input_id_saldo' }; ctx.reply('👤 Masukkan ID User:'); });
bot.action('check_user_stats', (ctx) => { userState[ctx.from.id] = { step: 'check_user_id' }; ctx.reply('🔍 Masukkan ID User:'); });
bot.action('manual_reseller', (ctx) => { userState[ctx.from.id] = { step: 'set_reseller_id' }; ctx.reply('👑 Masukkan ID User yang akan dijadikan RESELLER:'); });
bot.action('set_target_omzet', (ctx) => {
    if (!adminIds.includes(ctx.from.id)) return;
    userState[ctx.from.id] = { step: 'set_target_omzet' };
    ctx.reply(`🎯 *TARGET OMZET BULANAN*\nTarget saat ini: *Rp ${new Intl.NumberFormat('id-ID').format(TARGET_OMZET)}*\n\nKirim angka target baru (contoh: 1500000). Kirim 0 untuk mematikan target.`, { parse_mode: 'Markdown' });
});

bot.action('monthly_reset', (ctx) => { ctx.editMessageText(`⚠️ *KONFIRMASI RESET BULANAN*\n\n1. Bagikan Bonus Poin\n2. Downgrade Reseller (<Target)\n3. Reset Poin Semua User\n\nLanjut proses?`, { parse_mode:'Markdown', reply_markup: { inline_keyboard: [[{text:'✅ YA, PROSES', callback_data:'confirm_monthly_reset'}, {text:'❌ BATAL', callback_data:'admin'}]] } }); });

bot.action('confirm_monthly_reset', (ctx) => { 
    ctx.editMessageText('⏳ Memproses Reset Bulanan...');
    db.all("SELECT user_id, trx_month, level FROM users WHERE trx_month >= 5", [], (err, rows) => {
        let bonusCount = 0;
        rows.forEach(row => {
            let bonus = calculateMonthlyBonus(row.trx_month);
            if (bonus > 0) {
                db.run("UPDATE users SET saldo = COALESCE(saldo, 0) + ? WHERE user_id = ?", [bonus, row.user_id]);
                db.run("INSERT INTO transactions (user_id, amount, type, info, timestamp) VALUES (?, ?, ?, ?, ?)", [row.user_id, bonus, 'deposit', 'Bonus Bulanan', Date.now()]);
                bot.telegram.sendMessage(row.user_id, `🎉 *BONUS BULANAN CAIR*\n\n🏆 Poin Anda: ${row.trx_month}\n💰 Bonus Masuk: Rp ${new Intl.NumberFormat('id-ID').format(bonus)}`).catch(()=>{});
                bonusCount++;
            }
        });
        db.all("SELECT user_id, trx_month FROM users WHERE level = 'reseller'", [], (err2, resellers) => {
            let downgradeCount = 0;
            resellers.forEach(r => {
                if (r.trx_month < RESELLER_TARGET) {
                    db.run("UPDATE users SET level = 'member' WHERE user_id = ?", [r.user_id]);
                    bot.telegram.sendMessage(r.user_id, `⚠️ *STATUS RESELLER DICABUT*\nTarget transaksi tidak tercapai bulan ini.`).catch(()=>{});
                    downgradeCount++;
                }
            });
            const _mjkt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
            SETTING_LAST_RESET = _mjkt.getFullYear() + '-' + String(_mjkt.getMonth() + 1).padStart(2, '0');
            setSetting('last_reset_period', SETTING_LAST_RESET);
            db.run("UPDATE users SET trx_month = 0, days_month = 0", () => {
                ctx.reply(`✅ *RESET BULANAN SELESAI*\n\n📊 *Laporan Detail:*\n🎁 Penerima Bonus: ${bonusCount} User\n📉 Downgrade Reseller: ${downgradeCount} User\n🔄 Reset Poin: Semua User`, {parse_mode:'Markdown'});
            });
        });
    });
});


// ===== RESET BULANAN OTOMATIS (tiap tanggal 1 jam 00:10 WIB) =====
let monthlyResetRunning = false;
function maybeFlipV2() {
    if (!POIN_V2 && Date.now() >= new Date('2026-11-01T00:10:00+07:00').getTime()) {
        POIN_V2 = true;
        setSetting('poin_v2', '1');
        console.log('[RESET-OTOMATIS] POIN_V2 AKTIF: poin akumulasi hari + tangga bonus baru mulai berlaku.');
        return true;
    }
    return false;
}

function runMonthlyResetAuto() {
    if (monthlyResetRunning) return;
    monthlyResetRunning = true;
    const jkt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const period = prevPeriodStr(jkt);
    const [py, pm] = period.split('-').map(Number);
    const startTs = Date.UTC(py, pm - 1, 1) - 7 * 3600 * 1000;
    const endTs = Date.UTC(py, pm, 1) - 7 * 3600 * 1000;
    const monthName = new Date(Date.UTC(py, pm - 1, 1)).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const minPts = POIN_V2 ? 2 : 5;
    const fmt = (n) => new Intl.NumberFormat('id-ID').format(n);

    db.all("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS omzet, COUNT(DISTINCT user_id) AS buyers FROM transactions WHERE type = 'buy' AND timestamp >= ? AND timestamp < ?", [startTs, endTs], (e1, aggRows) => {
        const agg = (aggRows && aggRows[0]) || { n: 0, omzet: 0, buyers: 0 };
        db.all("SELECT user_id, trx_month FROM users WHERE trx_month > 0 ORDER BY trx_month DESC", [], (e2, pointRows) => {
            pointRows = pointRows || [];
            const top5 = pointRows.slice(0, 5);
            let bonusCount = 0, bonusTotal = 0;
            pointRows.forEach(row => {
                const bonus = calculateMonthlyBonus(row.trx_month);
                if (row.trx_month >= minPts && bonus > 0) {
                    db.run("UPDATE users SET saldo = COALESCE(saldo, 0) + ? WHERE user_id = ?", [bonus, row.user_id]);
                    db.run("INSERT INTO transactions (user_id, amount, type, info, timestamp) VALUES (?, ?, ?, ?, ?)", [row.user_id, bonus, 'deposit', 'Bonus Bulanan', Date.now()]);
                    bot.telegram.sendMessage(row.user_id, `🎉 *BONUS BULANAN CAIR*\n\n🏆 Poin Anda: ${row.trx_month}\n💰 Bonus Masuk: Rp ${fmt(bonus)}`).catch(()=>{});
                    bonusCount++; bonusTotal += bonus;
                }
            });
            db.all("SELECT user_id, trx_month FROM users WHERE level = 'reseller'", [], (e3, resellers) => {
                const downgraded = [];
                (resellers || []).forEach(r => {
                    if (r.trx_month < RESELLER_TARGET) {
                        db.run("UPDATE users SET level = 'member' WHERE user_id = ?", [r.user_id]);
                        bot.telegram.sendMessage(r.user_id, `⚠️ *STATUS RESELLER DICABUT*\nTarget transaksi tidak tercapai bulan ini.`).catch(()=>{});
                        downgraded.push(r.user_id);
                    }
                });
                db.all("SELECT id, total_create_akun FROM Server", [], (e4, servers) => {
                    const snapNow = {};
                    (servers || []).forEach(s => { snapNow[s.id] = s.total_create_akun || 0; });
                    db.get("SELECT value FROM settings WHERE key = 'create_snapshot'", [], (e5, snapRow) => {
                        let newAccounts = null;
                        if (snapRow && snapRow.value) {
                            try { const old = JSON.parse(snapRow.value); newAccounts = 0; Object.keys(snapNow).forEach(k => { newAccounts += Math.max(0, snapNow[k] - (old[k] || 0)); }); } catch (e) {}
                        }
                        setSetting('create_snapshot', JSON.stringify(snapNow));
                        db.run("UPDATE users SET trx_month = 0, days_month = 0", () => {
                            SETTING_LAST_RESET = period;
                            setSetting('last_reset_period', period);
                            const flipped = maybeFlipV2();
                            const targetLine = TARGET_OMZET > 0 ? `🎯 Target: Rp ${fmt(TARGET_OMZET)} — capaian *${Math.round(100 * agg.omzet / TARGET_OMZET)}%*` : `🎯 Target: belum diset (Panel Admin → 🎯 Target Omzet)`;
                            const downList = downgraded.length ? ' (`' + downgraded.slice(0, 15).join('`, `') + '`' + (downgraded.length > 15 ? ` +${downgraded.length - 15} lagi` : '') + ')' : '';
                            const report =
`📊 *LAPORAN BULANAN — ${monthName.toUpperCase()}*
━━━━━━━━━━━━━━━━━━
💰 *Omzet: Rp ${fmt(agg.omzet)}*
${targetLine}
🧾 Transaksi: ${agg.n} | 👥 Pembeli unik: ${agg.buyers}
🆕 Akun baru: ${newAccounts === null ? '— (baseline baru dicatat bulan ini)' : newAccounts}
━━━━━━━━━━━━━━━━━━
🎁 Bonus poin: ${bonusCount} penerima, total Rp ${fmt(bonusTotal)}
📉 Reseller diturunkan: ${downgraded.length}${downList}
🏆 *Top poin ${monthName}:*
${top5.length ? top5.map((r, i) => `${i + 1}. \`${r.user_id}\` — ${r.trx_month} poin`).join('\n') : '—'}
━━━━━━━━━━━━━━━━━━
🔄 Poin semua user sudah direset ke 0.${flipped ? '\n✅ *Sistem poin AKUMULASI HARI + tangga bonus baru resmi AKTIF mulai bulan ini!*' : ''}`;
                            adminIds.forEach(aid => bot.telegram.sendMessage(aid, report, { parse_mode: 'Markdown' }).catch(()=>{}));
                            console.log(`[RESET-OTOMATIS] ${period} selesai. Bonus: ${bonusCount} user / Rp ${bonusTotal} | Downgrade: ${downgraded.length} | Omzet: Rp ${agg.omzet}`);
                            monthlyResetRunning = false;
                        });
                    });
                });
            });
        });
    });
}

function checkMonthlyReset() {
    try {
        if (!SETTING_LAST_RESET) return;
        const jkt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const due = prevPeriodStr(jkt);
        if (due <= SETTING_LAST_RESET) return;
        const day = jkt.getDate();
        const hhmm = String(jkt.getHours()).padStart(2, '0') + ':' + String(jkt.getMinutes()).padStart(2, '0');
        if (day === 1 && hhmm < '00:10') return;
        console.log(`[RESET-OTOMATIS] Menjalankan reset untuk periode ${due}...`);
        runMonthlyResetAuto();
    } catch (e) { console.error('[RESET-OTOMATIS] cek gagal:', e.message); }
}
setInterval(checkMonthlyReset, 60000);
setTimeout(checkMonthlyReset, 20000);


bot.action('list_poin_active', (ctx) => { db.all("SELECT user_id, level, trx_month FROM users WHERE trx_month > 0 ORDER BY trx_month DESC LIMIT 30", [], (err, rows) => { if (!rows || rows.length === 0) return ctx.reply('📊 Belum ada data poin.'); let msg = `🏆 *LEADERBOARD TRANSAKSI*\n━━━━━━━━━━━━━━━━━━\n`; rows.forEach((row, i) => msg += `${i+1}. \`${row.user_id}\` : *${row.trx_month} Poin*\n`); ctx.reply(msg, {parse_mode:'Markdown'}); }); });
const editActions = ['editserver_harga', 'nama_server_edit', 'editserver_domain', 'editserver_auth', 'editserver_quota', 'editserver_limit_ip', 'editserver_batas_create_akun', 'editserver_total_create_akun', 'editserver_tipe', 'deleteserver']; editActions.forEach(act => { bot.action(act, (ctx) => { db.all('SELECT * FROM Server', [], (err, servers) => { if (!servers.length) return ctx.reply('⚠️ Data Server Kosong.'); const kb = servers.map(s => [{ text: `${s.nama_server}`, callback_data: `${act}_${s.id}` }]); kb.push([{ text: '🔙 Batal', callback_data: 'admin' }]); ctx.editMessageText('🔧 Pilih Server:', { parse_mode:'Markdown', reply_markup: { inline_keyboard: kb } }); }); }); });
bot.action(/editserver_((?!tipe_)\w+)_(\d+)/, (ctx) => { userState[ctx.from.id] = { step: `edit_server_${ctx.match[1]}`, serverId: ctx.match[2] }; ctx.reply(`✍️ Edit *${ctx.match[1].toUpperCase()}* — Server ID ${ctx.match[2]}\nMasukkan nilai baru:`, { parse_mode: 'Markdown' }); });
bot.action(/nama_server_edit_(\d+)/, (ctx) => { userState[ctx.from.id] = { step: `edit_server_nama`, serverId: ctx.match[1] }; ctx.reply(`✍️ Masukkan Nama Baru:`); });
bot.action(/deleteserver_(\d+)/, (ctx) => { db.run('DELETE FROM Server WHERE id = ?', [ctx.match[1]], () => { ctx.answerCbQuery('Berhasil dihapus!'); sendAdminMenu(ctx); }); });
// [adapter] ubah tipe server
bot.action(/editserver_tipe_(\d+)/, (ctx) => {
  const sid = ctx.match[1];
  ctx.editMessageText('Pilih tipe baru:', { reply_markup: { inline_keyboard: [
    [{ text: '🛡️ FighterTunnel', callback_data: 'setipe_fightertunnel_' + sid },
     { text: '🚂 Railway', callback_data: 'setipe_railway_' + sid }],
    [{ text: '🛰️ Panel (script sendiri)', callback_data: 'setipe_panel_' + sid }],
    [{ text: '🔙 Batal', callback_data: 'admin' }]] }});
});
bot.action(/setipe_(.+)_(\d+)/, (ctx) => {
  db.run("UPDATE Server SET tipe = ? WHERE id = ?", [ctx.match[1], ctx.match[2]], () => {
    ctx.answerCbQuery('Tipe diperbarui!'); try { sendAdminMenu(ctx); } catch(e){}
  });
});
bot.action('resetdb', (ctx) => { ctx.editMessageText('⚠️ Hapus SEMUA Data Server?', { reply_markup: { inline_keyboard: [[{text:'✅ YA HAPUS', callback_data:'confirm_reset'}, {text:'❌ BATAL', callback_data:'admin'}]] } }); });
bot.action('confirm_reset', (ctx) => { db.run('DELETE FROM Server'); ctx.reply('✅ Database Server Berhasil Dikosongkan.'); });

bot.action('service_create', (ctx) => handleServiceAction(ctx, 'create'));
bot.action('service_renew', (ctx) => handleServiceAction(ctx, 'renew'));
bot.action('service_trial', (ctx) => checkTrialLimit(ctx));

function checkTrialLimit(ctx) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    db.get('SELECT level, trial_count, trial_date FROM users WHERE user_id = ?', [ctx.from.id], (err, row) => {
        if (row && row.level !== 'reseller') {
            const cnt = (row.trial_date === today) ? (row.trial_count || 0) : 0;
            if (cnt >= TRIAL_MAX_PER_DAY) {
                return ctx.answerCbQuery('⏳ BATAS TRIAL TERCAPAI\nTrial gratis maksimal 2x sehari.\nSilakan coba lagi besok, atau upgrade ke Reseller untuk Unlimited Trial.', {show_alert:true});
            }
        }
        handleServiceAction(ctx, 'trial');
    });
}

function handleServiceAction(ctx, action) {
    let label = action === 'create' ? 'BELI BARU' : (action === 'renew' ? 'PERPANJANG' : 'TRIAL GRATIS');
    const kb = [
      ['ssh', 'vmess'].map(t => ({ text: `🔌 ${t.toUpperCase()}`, callback_data: `${action}_${t}` })),
      ['vless', 'trojan'].map(t => ({ text: `🚀 ${t.toUpperCase()}`, callback_data: `${action}_${t}` })),
      [{ text: '🔙 Menu Utama', callback_data: 'send_main_menu' }]
    ];
    ctx.editMessageText(`🛠️ *LAYANAN ${label}*\nSilakan pilih protokol layanan:`, { parse_mode:'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
}

['ssh', 'vmess', 'vless', 'trojan'].forEach(svc => {
    bot.action(`create_${svc}`, (ctx) => selectServer(ctx, 'create', svc));
    bot.action(`renew_${svc}`, (ctx) => selectServer(ctx, 'renew', svc));
    bot.action(`trial_${svc}`, (ctx) => selectServer(ctx, 'trial', svc));
});

bot.action(/nav_srv_(\w+)_(\w+)_(\d+)/, (ctx) => { selectServer(ctx, ctx.match[1], ctx.match[2], parseInt(ctx.match[3])); });

function selectServer(ctx, action, type, page = 0) {
    db.get('SELECT level FROM users WHERE user_id = ?', [ctx.from.id], (err, user) => {
        const isReseller = user ? user.level === 'reseller' : false;
        db.all('SELECT * FROM Server', [], (err, servers) => {
            if (!servers.length) return ctx.reply('⚠️ Server Maintenance.');
            const limit = 6; 
            const totalPage = Math.ceil(servers.length / limit);
            const curPage = Math.min(Math.max(page, 0), totalPage - 1);
            const start = curPage * limit;
            const list = servers.slice(start, start + limit);
            let txt = `📋 *List Server (Halaman ${curPage + 1} dari ${totalPage}):*\n\n`;
            const kb = [];
            let currentRow = []; 
            list.forEach((s) => {
                const flag = getFlag(s.nama_server);
                const isFull = action !== 'renew' && (s.total_create_akun >= s.batas_create_akun); // renew tidak makan stok
                let currentPrice = s.harga;
                let priceLabel = "";
                if (isReseller) { currentPrice = Math.floor(s.harga * (1 - RESELLER_DISC)); priceLabel = " (Reseller)"; }
                const daily = new Intl.NumberFormat('id-ID').format(currentPrice);
                const monthly = new Intl.NumberFormat('id-ID').format(currentPrice * 30);
                txt += `🌐 ${flag}*${s.nama_server}*\n`;
                txt += `🏷️ Tipe: ${(require('./modules/server-adapter').TIPE_LABEL[s.tipe]||s.tipe||'FighterTunnel')}\n`; // [adapter] label tipe
                if (action === 'trial') txt += `🎁 Mode: *TRIAL GRATIS*\n`;
                else { txt += `💰 Harga${priceLabel}: Rp${daily}/hari\n`; txt += `📅 Harga per 30 hari: Rp${monthly}\n`; }
                txt += `📊 Quota: ${s.quota}GB\n`;
                txt += `🔢 Limit IP: ${s.iplimit} IP\n`;
                if (isFull) txt += `⚠️ Server Penuh\n\n`; else txt += `👥 Total Create Akun: ${s.total_create_akun}/${s.batas_create_akun}\n\n`;
                const btnTxt = isFull ? `🔴 ${s.nama_server} [FULL]` : `${flag} ${s.nama_server}`;
                const btn = { text: btnTxt, callback_data: isFull ? 'server_full' : `${action}_username_${type}_${s.id}` };
                currentRow.push(btn);
                if (currentRow.length === 2) { kb.push(currentRow); currentRow = []; }
            });
            if (currentRow.length > 0) kb.push(currentRow);
            const navRow = [];
            if (curPage > 0) navRow.push({ text: '⬅️ Back', callback_data: `nav_srv_${action}_${type}_${curPage - 1}` });
            if (curPage < totalPage - 1) navRow.push({ text: 'Next ➡️', callback_data: `nav_srv_${action}_${type}_${curPage + 1}` });
            if (navRow.length) kb.push(navRow);
            kb.push([{ text: '🔙 Menu Utama', callback_data: `send_main_menu` }]);
            ctx.editMessageText(txt, { parse_mode:'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        });
    });
}

bot.action('server_full', (ctx) => { ctx.answerCbQuery('⚠️ Silahkan pm @' + (vars.ADMIN_USERNAME || 'admin') + ' untuk meminta restok', { show_alert: true }); });
bot.action(/(create|renew|trial)_username_(.+)/, async (ctx) => {
    const parts = ctx.match[0].split('_'); 
    const serverId = parts[3];
    const server = await new Promise(r => db.get('SELECT * FROM Server WHERE id = ?', [serverId], (err, row) => r(row)));
    if (!server) return ctx.reply('❌ Server tidak ditemukan.');
    const checkMsg = await ctx.reply(`📡 Mengecek status server ${server.nama_server}...`);
    const isOnline = await checkServerStatus(server);
    await ctx.telegram.deleteMessage(ctx.chat.id, checkMsg.message_id).catch(()=>{});
    if (!isOnline) return ctx.reply(`⚠️ *MAAF, SERVER SEDANG GANGGUAN/OFFLINE*\n\nServer *${server.nama_server}* tidak dapat dijangkau saat ini.\nDemi keamanan saldo Anda, transaksi dibatalkan.`, {parse_mode:'Markdown'});
    userState[ctx.from.id] = { step: `username_input`, serverId, type: parts[2], action: parts[0] };
    ctx.reply(`👤 *INPUT USERNAME*\nServer: ${server.nama_server}\nMode: ${parts[0].toUpperCase()}\n\n✍️ Masukkan Username yang diinginkan (Huruf & Angka):`, {parse_mode:'Markdown'});
});

bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const state = userState[userId];
    const text = ctx.message.text.trim();
    if (!state) return;

    if (adminIds.includes(userId)) {
        if (state.step === 'check_user_id') { db.get('SELECT * FROM users WHERE user_id = ?', [text], (err, row) => { if (!row) return ctx.reply('❌ User tidak ditemukan.'); const level = row.level === 'reseller' ? '👑 RESELLER' : '👤 MEMBER'; const saldo = new Intl.NumberFormat('id-ID').format(row.saldo); ctx.reply(`🔍 *DETAIL USER*\n━━━━━━━━━━━━━━━━━━\nID: ${row.user_id}\nLevel: ${level}\nSaldo: Rp ${saldo}\nPoin Bulan Ini: ${row.trx_month}`, {parse_mode:'Markdown'}); }); delete userState[userId]; return; }
        if (state.step === 'set_target_omzet') { const val = parseInt(String(text).replace(/[^0-9]/g, '')) || 0; TARGET_OMZET = val; setSetting('target_omzet', val); ctx.reply(`✅ *Target omzet bulanan diset:* Rp ${new Intl.NumberFormat('id-ID').format(val)}${val === 0 ? ' (target dimatikan)' : ''}`, { parse_mode: 'Markdown' }); delete userState[userId]; return; }
        if (state.step === 'addserver') { state.domain = text; state.step = 'add_auth'; return ctx.reply('Auth:'); }
        if (state.step === 'add_auth') { state.auth = text; state.step = 'add_nama'; return ctx.reply('Nama Server:'); }
        if (state.step === 'add_nama') { state.nama = text; state.step = 'add_quota'; return ctx.reply('Quota (GB):'); }
        if (state.step === 'add_quota') { if(isNaN(text)) return ctx.reply('❌ Wajib Angka!'); state.quota = text; state.step = 'add_ip'; return ctx.reply('IP Limit:'); }
        if (state.step === 'add_ip') { if(isNaN(text)) return ctx.reply('❌ Wajib Angka!'); state.ip = text; state.step = 'add_create'; return ctx.reply('Limit Create Akun:'); }
        if (state.step === 'add_create') { if(isNaN(text)) return ctx.reply('❌ Wajib Angka!'); state.create = text; state.step = 'add_harga'; return ctx.reply('Harga Harian:'); }
        if (state.step === 'add_harga') { if(isNaN(text)) return ctx.reply('❌ Wajib Angka!'); state.harga = text; state.step = 'add_tipe'; return ctx.reply('Pilih tipe server:', { reply_markup: { inline_keyboard: [[{ text: '🛡️ FighterTunnel', callback_data: 'srvtipe_fightertunnel' }, { text: '🚂 Railway', callback_data: 'srvtipe_railway' }],[{ text: '🛰️ Panel (script sendiri)', callback_data: 'srvtipe_panel' }]] }}); }
        if (state.step === 'input_id_saldo') { state.targetId = text; state.step = 'input_amt'; return ctx.reply('Jumlah Saldo:'); }
        if (state.step === 'input_amt') {
            const amount = parseInt(text);
            if(isNaN(amount)) return ctx.reply('❌ Wajib Angka!');
            db.run("UPDATE users SET saldo = COALESCE(saldo, 0) + ? WHERE user_id = ?", [amount, state.targetId], function(){
               if(this.changes) {
                   const amtFmt = new Intl.NumberFormat('id-ID').format(amount);
                   db.run("INSERT INTO transactions (user_id, amount, type, info, timestamp) VALUES (?, ?, ?, ?, ?)", [state.targetId, amount, 'deposit', 'Manual Admin', Date.now()]);
                   ctx.reply(`✅ *SALDO DITAMBAHKAN*\nNominal: Rp ${amtFmt}\nKe User ID: \`${state.targetId}\``, {parse_mode:'Markdown'});
                   bot.telegram.sendMessage(state.targetId, `💳 *SALDO DITAMBAHKAN*\nAdmin telah menambahkan saldo sebesar Rp ${amtFmt}`, {parse_mode:'Markdown'});
                   if (GROUP_ID) bot.telegram.sendMessage(GROUP_ID, `💸 *TOPUP BERHASIL*\n━━━━━━━━━━━━━━\n👤 User: \`${state.targetId}\`\n💰 Nominal: Rp ${amtFmt}\n⚙️ Jalur: Manual Admin`, {parse_mode:'Markdown'}).catch(()=>{});
               } else ctx.reply('❌ User tidak ditemukan.');
            }); delete userState[userId]; return;
        }
        if (state.step === 'set_reseller_id') { db.run("UPDATE users SET level = 'reseller' WHERE user_id = ?", [text], function(err) { if (this.changes) { ctx.reply(`✅ User ID \`${text}\` berhasil diubah menjadi *RESELLER*.`, {parse_mode:'Markdown'}); bot.telegram.sendMessage(text, `👑 *SELAMAT!*\nStatus akun Anda telah diubah menjadi *RESELLER* oleh Admin.`, {parse_mode:'Markdown'}); } else ctx.reply('❌ User ID tidak ditemukan.'); }); delete userState[userId]; return; }
        if (state.step.startsWith('edit_server_')) { const f = state.step.replace('edit_server_', ''); const col = f === 'nama' ? 'nama_server' : f; if (col === 'auth' && String(text).trim().length < 15) { ctx.reply('❌ *Edit AUTH dibatalkan* — nilai terlalu pendek untuk API key (min 15 karakter). Auth lama TIDAK berubah.', {parse_mode:'Markdown'}); delete userState[userId]; return; } db.run(`UPDATE Server SET ${col} = ? WHERE id = ?`, [text, state.serverId], () => ctx.reply(`✅ *${col.toUpperCase()}* berhasil diperbarui.`, {parse_mode:'Markdown'})); delete userState[userId]; return; }
    }

    if (state.step === 'username_input') {
        if (!/^[a-z0-9]{3,20}$/.test(text)) return ctx.reply('❌ Username wajib huruf kecil/angka (3-20 karakter).');
        state.username = text;
        if (state.type === 'ssh') { state.step = 'password_input'; ctx.reply('🔑 Masukkan Password:'); }
        else { if(state.action === 'trial') processTransaction(ctx, userId, state); else { state.step = 'exp_input'; ctx.reply('⏳ Masukkan Durasi (Jumlah Hari):'); } }
    } else if (state.step === 'password_input') {
        state.password = text;
        if(state.action === 'trial') processTransaction(ctx, userId, state); else { state.step = 'exp_input'; ctx.reply('⏳ Masukkan Durasi (Jumlah Hari):'); }
    } else if (state.step === 'exp_input') {
        if(isNaN(text)) return ctx.reply('❌ Wajib Angka (Contoh: 30).');
        state.exp = parseInt(text);
        processTransaction(ctx, userId, state);
    }
});

function processTransaction(ctx, userId, state) {
    db.get('SELECT * FROM Server WHERE id = ?', [state.serverId], (err, server) => {
        db.get('SELECT * FROM users WHERE user_id = ?', [userId], async (err, user) => {
            let total = 0, quota = server.quota, ip = server.iplimit, exp = state.exp;
            
            if (state.action === 'trial') { 
                total = 0; quota = TRIAL_QUOTA; ip = TRIAL_IPLIMIT; exp = TRIAL_EXP; state.exp = TRIAL_EXP;
                const rand = Math.floor(1000 + Math.random() * 9000);
                state.username = `trial${rand}${state.username}`;
            } else {
                total = server.harga * state.exp;
                if (user.level === 'reseller') total = Math.floor(total * (1 - RESELLER_DISC));
            }

            if (user.saldo < total) {
                const reqSaldo = new Intl.NumberFormat('id-ID').format(total);
                const curSaldo = new Intl.NumberFormat('id-ID').format(user.saldo);
                return ctx.reply(`⚠️ *SALDO TIDAK CUKUP*\n━━━━━━━━━━━━━━\n💰 Saldo Anda: Rp ${curSaldo}\n🏷 Harga Layanan: Rp ${reqSaldo}\n\nSilakan isi saldo terlebih dahulu.`, {parse_mode:'Markdown'});
            }

            let msg = await ctx.reply('⏳ Sedang memproses...');
            try {
                let res = "Gagal.";
                const adapter = require('./modules/server-adapter'); // [adapter] 1 bot, 3 tipe server
                if (state.action !== 'renew') {
                    res = await adapter.createAccount(server.tipe, state.type, {
                        username: state.username, password: state.password,
                        exp, quota, ip, serverId: state.serverId, server, trial: state.action === 'trial', minutes: TRIAL_MINUTES });
                } else {
                    res = await adapter.renewAccount(server.tipe, state.type, {
                        username: state.username, exp, quota, ip,
                        serverId: state.serverId, server });
                }

                if (state.action === 'trial') { const _td = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); db.run("UPDATE users SET last_trial = ?, trial_date = ?, trial_count = CASE WHEN trial_date = ? THEN COALESCE(trial_count, 0) + 1 ELSE 1 END WHERE user_id = ?", [Date.now(), _td, _td, userId]); }
                else {
                    db.run("UPDATE users SET saldo = COALESCE(saldo, 0) - ? WHERE user_id = ?", [total, userId]);
                    if (POIN_V2) {
                        db.run("UPDATE users SET days_month = COALESCE(days_month, 0) + ?, trx_month = (COALESCE(days_month, 0) + ?) / 30 WHERE user_id = ?", [exp, exp, userId]);
                    } else {
                        const pts = Math.floor(exp / 30);
                        if (pts > 0) db.run("UPDATE users SET trx_month = trx_month + ? WHERE user_id = ?", [pts, userId]);
                    }
                    db.run("INSERT INTO transactions (user_id, amount, type, info, timestamp) VALUES (?, ?, ?, ?, ?)", [userId, total, 'buy', `${state.type.toUpperCase()} ${server.nama_server}`, Date.now()]);
                }
                
                if (state.action !== 'renew') db.run("UPDATE Server SET total_create_akun = total_create_akun + 1 WHERE id = ?", [state.serverId]); // renew tidak nambah counter create
                const expiredTime = state.action === 'trial' ? (Date.now() + TRIAL_MINUTES * 60000) : calculateExpiry(exp);
                if (state.action === 'renew') {
                    db.run(`UPDATE active_services SET expired_at = ?, reminded = 0 WHERE user_id = ? AND username = ? AND server_name = ?`, [expiredTime, userId, state.username, server.nama_server], function(err) {
                        if (this.changes === 0) { db.run("INSERT INTO active_services (user_id, username, server_name, protocol, expired_at) VALUES (?,?,?,?,?)", [userId, state.username, server.nama_server, state.type, expiredTime]); }
                    });
                } else {
                    db.run("INSERT INTO active_services (user_id, username, server_name, protocol, expired_at) VALUES (?,?,?,?,?)", [userId, state.username, server.nama_server, state.type, expiredTime]);
                }

                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});
                ctx.reply(res, {parse_mode:'Markdown'});
                const totalFmt = new Intl.NumberFormat('id-ID').format(total);
                const sisaSaldo = new Intl.NumberFormat('id-ID').format(user.saldo - total);
                const struk = `✅ *TRANSAKSI BERHASIL*\n━━━━━━━━━━━━━━\n📦 Layanan: ${state.type.toUpperCase()}\n🌍 Server: ${server.nama_server}\n⏳ Durasi: ${state.action === 'trial' ? TRIAL_MINUTES + ' Menit' : exp + ' Hari'}\n💰 Terpotong: Rp ${totalFmt}\n\n_Sisa Saldo Anda: Rp ${sisaSaldo}_`;
                ctx.reply(struk, {parse_mode:'Markdown'});
                
                const mode = state.action === 'trial' ? 'TRIAL' : (user.level === 'reseller' ? 'RESELLER' : 'MEMBER');
                adminIds.forEach(id => bot.telegram.sendMessage(id, `🔔 *TRANSAKSI BARU*\n━━━━━━━━━━━━━━\n👤 User: \`${userId}\` (${mode})\n📦 Layanan: ${state.type.toUpperCase()}\n🌍 Server: ${server.nama_server}\n💰 Total: Rp ${totalFmt}`, {parse_mode:'Markdown'}).catch(()=>{}));
                
                if (GROUP_ID) bot.telegram.sendMessage(GROUP_ID, `🎉 *TRANSAKSI BERHASIL*\n━━━━━━━━━━━━━━\n👤 User: \`${userId}\` (${mode})\n📦 Layanan: ${state.type.toUpperCase()}\n🌍 Server: ${server.nama_server}\n📝 Aksi: ${state.action.toUpperCase()}\n💰 Harga: Rp ${totalFmt}`, {parse_mode:'Markdown'}).catch(e => console.log('Gagal kirim ke grup:', e.message));

            } catch (e) {
                ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{});
                ctx.reply((e && e.message && e.message.startsWith('❌')) ? e.message : '❌ Gagal memproses permintaan.');
            }
            delete userState[userId];
        });
    });
}

bot.action('topup_saldo', (ctx) => {
    global.depositState[ctx.from.id] = { amount: '' };
    const msg = `💰 *ISI SALDO OTOMATIS*\n━━━━━━━━━━━━━━━━━━\n🔹 Minimal Deposit: Rp 5.000\n🎁 *Bonus 10%* jika deposit > 10.000\n👑 *AUTO RESELLER* jika deposit > 30.000\n\nTap *nominal cepat* ⚡, atau ketik nominal sendiri pakai tombol angka di bawah:`;
    ctx.editMessageText(msg, {parse_mode:'Markdown', reply_markup:{inline_keyboard:keyboard_nomor()}});
});

bot.on('callback_query', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const uid = ctx.from.id;
    if (global.depositState[uid]) {
        let cur = global.depositState[uid].amount;
        if (data === 'delete') cur = cur.slice(0, -1);
        else if (data === 'confirm') {
            if (!cur || parseInt(cur)<MIN_TOPUP) return ctx.answerCbQuery(`⚠️ Minimal Deposit Rp ${new Intl.NumberFormat('id-ID').format(MIN_TOPUP)}`);
            processDeposit(ctx, cur); return;
        } else if (data === 'send_main_menu') {
            delete global.depositState[uid]; sendMainMenu(ctx); return;
        } else if (data.startsWith('preset_')) {
            processDeposit(ctx, data.slice(7)); return;
        } else if (/^\d$/.test(data)) cur += data;
        global.depositState[uid].amount = cur;
        const fmt = cur ? new Intl.NumberFormat('id-ID').format(cur) : '0';
        const msg = `💰 *ISI SALDO OTOMATIS*\n━━━━━━━━━━━━━━━━━━\n🔹 Minimal Deposit: Rp 5.000\n🎁 *Bonus 10%* jika deposit > 10.000\n👑 *AUTO RESELLER* jika deposit > 30.000\n\n*Nominal Input:* Rp ${fmt}`;
        ctx.editMessageText(msg, {parse_mode:'Markdown', reply_markup:{inline_keyboard:keyboard_nomor()}}).catch(()=>{});
    }
});

// Tambah border putih (quiet zone) ke gambar QR dari gateway: gambar aslinya
// mepet tepi tanpa margin, beberapa scanner e-wallet menolak QR seperti itu.
async function qrWithBorder(url) {
    const { PNG } = require('pngjs');
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    const qr = PNG.sync.read(Buffer.from(resp.data));
    const border = Math.max(24, Math.round(qr.width * 0.08));
    const out = new PNG({ width: qr.width + border * 2, height: qr.height + border * 2 });
    out.data.fill(255);
    PNG.bitblt(qr, out, 0, 0, qr.width, qr.height, border, border);
    return PNG.sync.write(out);
}

async function processDeposit(ctx, amount) {
    if (Date.now() - lastRequestTime < 2000) return; lastRequestTime = Date.now();
    try { await ctx.deleteMessage(); } catch(e){}
    const wait = await ctx.reply('⏳ Membuat Invoice QRIS...');
    
    try {
        const my_ref_id = "ORD-" + Date.now(); 

        const payload = {
            api_key: API_KEY, 
            amount: parseInt(amount),
            ref_id: my_ref_id
        };

        const res = await axios.post(MAMZPAY_API_URL, payload);
        if (!res.data.status) throw new Error('API Fail');
        const d = res.data.data;
        
        let photo = d.qr_string;
        try { photo = { source: await qrWithBorder(d.qr_string) }; } catch (e) { console.error('⚠️ QR border gagal, kirim gambar asli:', e.message); }
        const msg = await ctx.replyWithPhoto(photo, { 
            caption: `🧾 *TAGIHAN TOP UP SALDO*\n━━━━━━━━━━━━━━━━━━\n🔖 *Ref ID:* \`${my_ref_id}\`\n💎 *Nominal:* Rp ${new Intl.NumberFormat('id-ID').format(amount)}\n💰 *TOTAL BAYAR:* Rp ${new Intl.NumberFormat('id-ID').format(d.amount_unique)}\n━━━━━━━━━━━━━━━━━━\n⚠️ *INSTRUKSI:*\n1. Scan QRIS di atas.\n2. Bayar *PAS SESUAI TOTAL*.\n3. Batas waktu: *${PAYMENT_EXP_MINUTES} Menit*.\n\n_Saldo masuk otomatis setelah pembayaran sukses._`, 
            parse_mode: 'Markdown' 
        });
        
        try { ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch(e){}
        
        global.pendingDeposits[my_ref_id] = { 
            amount: d.amount_unique, 
            original: parseInt(amount), 
            uid: ctx.from.id, 
            time: Date.now(), 
            msgId: msg.message_id 
        };

        db.run("INSERT INTO pending_deposits (unique_code, user_id, amount, original_amount, timestamp, status, qr_message_id) VALUES (?, ?, ?, ?, ?, 'pending', ?)", 
            [my_ref_id, ctx.from.id, d.amount_unique, parseInt(amount), Date.now(), msg.message_id]
        );
        delete global.depositState[ctx.from.id];
    } catch (e) { 
        console.error("Payment Gateway Error:", e.message);
        ctx.reply('❌ Gagal membuat invoice. Coba lagi nanti.'); 
    }
}

// Interval Polling Status Pembayaran & Expired (Setiap 10 Detik)
setInterval(async () => {
    for (const [ref_id, d] of Object.entries(global.pendingDeposits)) {
        if (Date.now() - d.time > PAYMENT_EXP_MINUTES * 60000) {
            delete global.pendingDeposits[ref_id]; 
            db.run("DELETE FROM pending_deposits WHERE unique_code = ?", [ref_id]);
            try { await bot.telegram.deleteMessage(d.uid, d.msgId); } catch(e){} 
            bot.telegram.sendMessage(d.uid, `❌ *TAGIHAN KADALUARSA*\nInvoice QRIS sudah expired. Silakan buat ulang.`, {parse_mode:'Markdown'}).catch(()=>{});
            continue; 
        }

        try {
            const checkUrl = `${MAMZPAY_STATUS_URL}?api_key=${API_KEY}&ref_id=${ref_id}`;
            console.log(`[CEK STATUS] Mengirim request ke Mamzpay untuk ID: ${ref_id}`);
            const res = await axios.get(checkUrl);
            console.log(`[BALASAN MAMZPAY] ${ref_id}:`, JSON.stringify(res.data));
            
            if (res.data && res.data.status === true && res.data.data && res.data.data.payment_status === 'PAID') {
                console.log(`[SUKSES] Pembayaran ${ref_id} berhasil! Memasukkan saldo...`);
                if (!global.processedTransactions.has(ref_id)) {
                    let bonus = d.original >= BONUS_MIN_TOPUP ? Math.floor(d.original * BONUS_PERCENT) : 0;
                    let total = d.original + bonus;
                    let extraMsg = "";
                    
                    db.get("SELECT level FROM users WHERE user_id = ?", [d.uid], (err, row) => {
                        if (!row) return;
                        let newLevel = row.level;
                        if (d.original >= AUTO_RESELLER_MIN && row.level === 'member') { 
                            newLevel = 'reseller'; 
                            extraMsg = "\n👑 *SELAMAT! ANDA NAIK JADI RESELLER!*"; 
                        }
                        db.run('UPDATE users SET saldo = COALESCE(saldo, 0) + ?, level = ? WHERE user_id = ?', [total, newLevel, d.uid]);
                        db.run("INSERT INTO transactions (user_id, amount, type, info, timestamp) VALUES (?, ?, ?, ?, ?)", [d.uid, total, 'deposit', 'QRIS Otomatis', Date.now()]);
                        
                        bot.telegram.sendMessage(d.uid, `✅ *DEPOSIT SUKSES*\n\n💰 Saldo Masuk: Rp ${new Intl.NumberFormat('id-ID').format(total)}\n🎁 Bonus: Rp ${new Intl.NumberFormat('id-ID').format(bonus)}${extraMsg}`, {parse_mode:'Markdown'}).catch(()=>{});
                        adminIds.forEach( aid => bot.telegram.sendMessage(aid, `🔔 *DEPOSIT MASUK*\nUser: \`${d.uid}\`\nTotal: Rp ${new Intl.NumberFormat('id-ID').format(total)}\nStatus: ${newLevel.toUpperCase()}`, {parse_mode:'Markdown'}).catch(()=>{}) );
                        if (GROUP_ID) bot.telegram.sendMessage(GROUP_ID, `💸 *TOPUP BERHASIL*\n━━━━━━━━━━━━━━\n👤 User: \`${d.uid}\`\n💰 Nominal: Rp ${new Intl.NumberFormat('id-ID').format(total)}\n⚙️ Jalur: QRIS Otomatis (Polling)`, {parse_mode:'Markdown'}).catch(()=>{});
                    });
                    
                    db.run("UPDATE pending_deposits SET status = 'PAID' WHERE unique_code = ?", [ref_id]);
                    try { bot.telegram.deleteMessage(d.uid, d.msgId); } catch(e){}
                    
                    global.processedTransactions.add(ref_id);
                    delete global.pendingDeposits[ref_id];
                }
            }
        } catch (error) {
            console.error(`[ERROR API MAMZPAY] Gagal mengecek ID ${ref_id}:`, error.message);
            if(error.response) console.error(`Detail Error:`, error.response.data);
        }
    }
}, 10000);

bot.action('listserver', async (ctx) => {
    await ctx.answerCbQuery();
    db.all('SELECT * FROM Server', [], (err, rows) => {
        let txt = `🌐 *DAFTAR SERVER TERSEDIA*\n━━━━━━━━━━━━━━━━━━\n`;
        rows.forEach(s => txt += `• ${getFlag(s.nama_server)} ${s.nama_server} | Rp ${new Intl.NumberFormat('id-ID').format(s.harga)}/hari\n`);
        ctx.reply(txt);
    });
});

app.listen(port, () => { console.log(`Run on port ${port}`); bot.launch(); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
