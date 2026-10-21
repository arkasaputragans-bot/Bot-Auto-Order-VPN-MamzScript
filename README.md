# Bot Auto Order VPN — MamzScript

Bot Telegram untuk **jual beli akun VPN otomatis** (SSH, VMess, VLESS, Trojan).
Pembeli bisa daftar, deposit via QRIS, beli/perpanjang/trial akun sendiri — semua otomatis,
sementara akunnya dibuatkan langsung di server panel kamu.

Bot ini adalah bot yang dipakai MamzStore dalam produksi.

## Fitur

- **Multi-server & multi-tipe** — satu bot melayani banyak server sekaligus:
  - `panel` — server [MamzScript](https://github.com/arkasaputragans-bot/MamzScript) (script panel VPN sendiri)
  - `fightertunnel` — server FighterTunnel
- **Deposit QRIS otomatis** — invoice + QR (sudah diberi border putih agar terbaca semua e-wallet),
  verifikasi pembayaran otomatis tiap 10 detik, saldo masuk sendiri. Ada tombol preset
  Rp 5.000 / 10.000 / 30.000, bonus deposit 10% (min. Rp 10.000), dan auto-upgrade
  Reseller (deposit min. Rp 30.000).
- **Beli & perpanjang akun** — SSH / VMess / VLESS / Trojan; perpanjang **tidak** memakan stok server.
- **Trial 60 menit** — otomatis terhapus, maks. 2x sehari untuk member (reseller bebas).
- **Sistem poin bulanan** — poin = total hari yang dibeli dalam sebulan ÷ 30 (semua pembelian
  terakumulasi, paket pendek pun terhitung). Tangga bonus:
  2–3 poin → Rp 500 · 4 → Rp 1.500 · 5–10 → Rp 2.000 · 11–15 → Rp 5.000 ·
  16–20 → Rp 15.000 · 21–25 → Rp 25.000 · 26+ → Rp 35.000.
- **Reset bulanan OTOMATIS** — tiap tanggal 1 jam 00:10 WIB: bonus dicairkan, reseller di bawah
  target (3 poin) diturunkan, poin direset, dan admin menerima **laporan bulanan**
  (omzet vs target yang bisa diset dari Panel Admin, jumlah transaksi, pembeli unik,
  akun baru, penerima bonus, top poin).
- **Level Member & Reseller** — diskon reseller 20%, target poin bulanan untuk mempertahankan status.
- **Pengingat kedaluwarsa** akun ke user + **laporan harian** otomatis ke admin jam 23:59 WIB.
- **Panel Admin lengkap di dalam bot** — tambah/edit server (domain, auth, harga, kuota,
  limit IP, batas create), cek poin & leaderboard, cek user, tambah saldo manual,
  set reseller, target omzet, reset bulanan manual.

## Kebutuhan

- Node.js 20+
- Server panel VPN: MamzScript (tipe `panel`) dan/atau FighterTunnel (tipe `fightertunnel`)
- Token bot dari [@BotFather](https://t.me/BotFather)
- Gateway pembayaran yang kompatibel dengan API MamzPay
  (`POST /api/payment/create` → invoice QRIS, `GET /api/payment/status` → cek status)
  beserta API key-nya

## Instalasi

```bash
git clone https://github.com/arkasaputragans-bot/Bot-Auto-Order-VPN-MamzScript.git
cd Bot-Auto-Order-VPN-MamzScript
npm install
cp .vars.json.example .vars.json
nano .vars.json   # isi semua konfigurasi (lihat tabel di bawah)
node app.js
```

Jalankan permanen dengan PM2:

```bash
npm install -g pm2
pm2 start app.js --name botvpn
pm2 save
```

Database SQLite (`sellvpn.db`) dibuat otomatis saat pertama kali jalan — tidak perlu setup manual.

## Konfigurasi `.vars.json`

| Key | Isi |
|---|---|
| `BOT_TOKEN` | Token bot dari BotFather |
| `USER_ID` | ID Telegram admin (pemilik bot) |
| `ADMIN_USERNAME` | Username Telegram admin (tanpa `@`), untuk tombol bantuan & info restok |
| `NAMA_STORE` | Nama toko yang tampil di bot |
| `GROUP_ID` | ID grup Telegram untuk notifikasi (format `-100...`), boleh dikosongkan |
| `PORT` | Port web server internal (default 6969) |
| `API_KEY` | API key gateway pembayaran kamu |
| `MAMZPAY_API_URL` | Endpoint buat invoice, mis. `http://IP-GATEWAY:PORT/api/payment/create` |
| `MAMZPAY_STATUS_URL` | Endpoint cek status, mis. `http://IP-GATEWAY:PORT/api/payment/status` |

> ⚠️ **Jangan pernah membagikan file `.vars.json` asli** — isinya token & kunci rahasia.
> File itu sudah masuk `.gitignore`.

Angka bisnis (harga mengikuti data server di database) dan konstanta promo
(bonus deposit, target reseller, durasi trial, tangga poin) diatur di bagian
`SETTINGAN BISNIS` di `app.js`.

## Cara Pakai

1. Jalankan bot, lalu sebagai admin buka **Panel Admin** dari menu utama.
2. **Add Server** — isi domain, auth (API key panel), nama, kuota, limit IP, batas create,
   harga per hari, lalu pilih tipe server (`panel` / `fightertunnel`).
3. Set target omzet bulanan lewat **Panel Admin → 🎯 Target Omzet** (untuk laporan bulanan).
4. User lain tinggal /start → deposit → beli akun. Selesai.

## Struktur

```
app.js                  — bot utama (menu, transaksi, deposit, poin, reset otomatis, laporan)
modules/
  server-adapter.js     — penghubung bot ke berbagai tipe server
  create-panel.js       — buat akun di panel MamzScript (termasuk trial menit)
  renew-panel.js        — perpanjang akun di panel MamzScript
  create.js / renew.js  — buat & perpanjang akun di FighterTunnel
  railway.js            — tipe server railway
.vars.json.example      — contoh konfigurasi
```

## Catatan

- Bot ini **tidak** menyertakan panel/server VPN-nya — untuk servernya gunakan
  [MamzScript](https://github.com/arkasaputragans-bot/MamzScript).
- Semua data (user, saldo, server, transaksi) tersimpan lokal di `sellvpn.db` — backup file itu secara berkala.
