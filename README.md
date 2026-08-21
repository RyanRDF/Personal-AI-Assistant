# Personal AI Assistant

Asisten AI personal berbasis Telegram untuk satu pemilik. Aplikasi dapat mengobrol dalam bahasa Indonesia, mengingat preferensi, mencari web, mencari Gmail, dan mengirim notifikasi Telegram ketika email baru cocok secara semantik dengan deskripsi yang pernah diberikan.

## Fitur

- Telegram long polling: tidak membutuhkan domain publik atau webhook.
- Analisis gambar Telegram (foto maupun dokumen JPEG/PNG/WebP/GIF) dengan input vision OpenAI.
- Foto tanpa caption disimpan hanya di memori selama 10 menit untuk pertanyaan teks berikutnya.
- Streaming preview, indikator proses berkala, timeout, pembatalan, dan trace operasional.
- Owner-only dan private-chat-only melalui `TELEGRAM_ALLOWED_USER_ID`.
- Model dapat diganti lewat `.env`; default ekonomis `gpt-4o-mini`.
- Memori personal dan riwayat percakapan persisten di SQLite.
- Vault seperti file manager: forward chat/file, folder bertingkat, pencarian, rename, move, delete, pemeriksaan nama duplikat, dan pengiriman file kembali.
- Dashboard responsif untuk melihat isi vault, upload/download, status bot, uptime, storage, serta kegagalan request.
- Gmail read-only dengan OAuth 2.0.
- Aturan email natural-language, klasifikasi semantik, Gmail History cursor, persistent outbox, dan deduplikasi notifikasi.
- Brave Search API atau SearXNG sebagai pencarian web.
- Structured logging dengan redaksi credential dan pencatatan penggunaan token.
- Docker, unit tests, typecheck, dan build produksi.

## Arsitektur singkat

```text
Telegram (owner only)
        │
        ▼
PersonalAssistant ── OpenAI tool calling
        │
        ├── SQLite memory + conversation
        ├── SQLite vault metadata + data/vault files
        ├── Gmail search
        ├── Email watch rules
        └── Brave Search / SearXNG

Gmail History poller ── semantic classifier ── Telegram notification

Dashboard HTTP ── authenticated vault API + /health
```

Detail desain ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Perbandingan model ada di [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md).

## Persyaratan

- Git.
- Node.js 22 atau lebih baru.
- Telegram bot token dari `@BotFather`.
- Numeric Telegram user ID pemilik, misalnya dari `@userinfobot`.
- OpenAI API key.
- Opsional: Google OAuth client untuk Gmail.
- Opsional: Brave Search API key atau Docker untuk SearXNG.
- Untuk deployment lokal/VPS: Docker Engine/Desktop dengan Docker Compose v2.

## Instalasi lokal

### 1. Ambil source code dan install dependency

```powershell
git clone https://github.com/RyanRDF/Personal-AI-Assistant.git
Set-Location Personal-AI-Assistant
npm ci
Copy-Item .env.example .env
```

Linux/macOS:

```bash
git clone https://github.com/RyanRDF/Personal-AI-Assistant.git
cd Personal-AI-Assistant
npm ci
cp .env.example .env
```

Jangan menghapus `.gitignore`. File `.env`, database, dan token lokal sudah dikecualikan dari Git.

### 2. Mendapatkan `TELEGRAM_BOT_TOKEN`

1. Buka [@BotFather](https://t.me/BotFather) di Telegram. Pastikan username tepat `@BotFather` dan memiliki tanda verifikasi.
2. Kirim `/newbot`.
3. Isi nama tampilan bot.
4. Isi username unik yang diakhiri `bot`, misalnya `RyanPersonalAssistantBot`.
5. BotFather akan memberikan token. Masukkan token tersebut ke `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=1234567890:token_dari_botfather
```

Token memberi kontrol penuh atas bot. Jangan masukkan token ke source code, screenshot, issue GitHub, atau commit. Jika bocor, gunakan menu bot di BotFather untuk mencabut/membuat token baru. Lihat [tutorial resmi Telegram](https://core.telegram.org/bots/tutorial).

### 3. Mendapatkan `TELEGRAM_ALLOWED_USER_ID`

Bot ini hanya menerima private chat dari satu numeric user ID.

1. Buka [@userinfobot](https://t.me/userinfobot).
2. Tekan **Start**.
3. Salin nilai numeric `Id`, bukan username Telegram.
4. Masukkan ke `.env` tanpa tanda kutip:

```dotenv
TELEGRAM_ALLOWED_USER_ID=123456789
```

### 4. Mendapatkan `OPENAI_API_KEY`

1. Masuk ke [OpenAI API Platform](https://platform.openai.com/).
2. Pilih/buat project API yang akan dipakai.
3. Buka halaman [API keys](https://platform.openai.com/api-keys).
4. Pilih **Create new secret key** dan gunakan project key biasa—bukan Admin API key.
5. Salin key saat ditampilkan dan masukkan ke `.env`:

```dotenv
OPENAI_API_KEY=sk-...
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
```

Pastikan akun/project API mempunyai billing atau credit yang aktif dan model yang dipilih tersedia untuk project tersebut. API key Gemini tidak dapat dimasukkan ke `OPENAI_API_KEY`; kode saat ini menggunakan OpenAI SDK. Daftar model dapat diperiksa pada [OpenAI model catalog](https://developers.openai.com/api/docs/models). OpenAI menyarankan API key dimuat dari environment server dan tidak diekspos pada aplikasi client. Lihat [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication).

### 5. Isi konfigurasi minimal

Setelah memperoleh tiga value wajib di atas, bagian minimal `.env` adalah:

```dotenv
TELEGRAM_BOT_TOKEN=token_dari_botfather
TELEGRAM_ALLOWED_USER_ID=123456789
OPENAI_API_KEY=sk-...
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
OPENAI_MAX_OUTPUT_TOKENS=2000
ASSISTANT_TIMEOUT_SECONDS=90
TELEGRAM_IMAGE_MAX_BYTES=10485760
TRACE_ENABLED_DEFAULT=false
```

### 6. Siapkan pencarian web gratis

Default project adalah SearXNG lokal. Generate secret, salin output `SEARXNG_SECRET=...` ke `.env`, lalu jalankan servicenya:

```powershell
npm run searxng:secret
docker compose --profile searxng up -d searxng
```

Pastikan konfigurasi berikut tetap ada:

```dotenv
SEARCH_PROVIDER=searxng
SEARXNG_BASE_URL=http://localhost:8080
DOCKER_SEARXNG_BASE_URL=http://searxng:8080
```

### 7. Jalankan bot

```powershell
npm run dev
```

Jangan menjalankan dua instance dengan token Telegram yang sama. Setelah log `Telegram bot started` muncul, buka bot, tekan **Start**, lalu coba:

```text
/status
/trace on
halo
```

Bot memakai long polling, sehingga komputer atau server harus tetap hidup. Tidak diperlukan domain publik, webhook, atau inbound port untuk Telegram.

## Referensi seluruh environment variable

Salin `.env.example` menjadi `.env`, lalu ubah hanya nilai yang diperlukan. Nilai kosong pada integrasi opsional boleh dibiarkan kosong.

### Telegram, OpenAI, dan perilaku inti

| Variable | Wajib | Cara mendapatkan / default |
|---|---:|---|
| `TELEGRAM_BOT_TOKEN` | Ya | Token rahasia dari `@BotFather` melalui `/newbot` |
| `TELEGRAM_ALLOWED_USER_ID` | Ya | Numeric ID akun pemilik, misalnya dari `@userinfobot` |
| `OPENAI_API_KEY` | Ya | Project secret key dari OpenAI API Platform |
| `OPENAI_CHAT_MODEL` | Tidak | Model chat/vision; default `gpt-4o-mini` |
| `OPENAI_CLASSIFIER_MODEL` | Tidak | Model klasifikasi email; default `gpt-4o-mini` |
| `OPENAI_MAX_OUTPUT_TOKENS` | Tidak | Maksimum output; default `2000` |
| `ASSISTANT_TIMEOUT_SECONDS` | Tidak | Timeout satu request; default `90` detik |
| `TELEGRAM_IMAGE_MAX_BYTES` | Tidak | Maksimum ukuran gambar; default `10485760` (10 MiB) |
| `TELEGRAM_PENDING_IMAGE_SECONDS` | Tidak | Masa simpan foto tanpa caption di RAM; default `600` |
| `TELEGRAM_PROGRESS_UPDATE_MS` | Tidak | Interval minimum edit progress; default `1200` ms |
| `TRACE_ENABLED_DEFAULT` | Tidak | `true`/`false`; dapat diubah per chat melalui `/trace` |
| `DATABASE_PATH` | Tidak | SQLite lokal; default `./data/assistant.sqlite` |
| `VAULT_STORAGE_PATH` | Tidak | Direktori byte file vault; default `./data/vault` |
| `VAULT_MAX_FILE_BYTES` | Tidak | Batas satu file; default/maksimum `20971520` (20 MiB) |
| `MAX_VAULT_CONTEXT_ITEMS` | Tidak | Maksimum item vault relevan dalam konteks AI; default `12` |
| `DASHBOARD_ENABLED` | Tidak | Jalankan dashboard dan `/health`; default `true` |
| `DASHBOARD_HOST` | Tidak | Default `127.0.0.1`; cloud/container memakai `0.0.0.0` dengan token |
| `PORT` | Tidak | Port dashboard; default `3030`, Railway menginjeksi nilainya |
| `DASHBOARD_TOKEN` | Wajib untuk akses jaringan | Password Basic Auth dashboard; tidak diperlukan untuk loopback lokal |
| `LOG_LEVEL` | Tidak | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, atau `silent` |
| `TIMEZONE` | Tidak | IANA timezone; default `Asia/Jakarta` |
| `MAX_HISTORY_MESSAGES` | Tidak | Jumlah pesan recent context; default `16` |
| `MAX_MEMORY_ITEMS` | Tidak | Maksimum memory context; default `20` |
| `MESSAGE_RETENTION_DAYS` | Tidak | Retensi chat dan trace; default `90` hari |

### Gmail

| Variable | Wajib untuk Gmail | Cara mendapatkan / default |
|---|---:|---|
| `GMAIL_CLIENT_ID` | Ya | OAuth 2.0 Client ID dari Google Cloud |
| `GMAIL_CLIENT_SECRET` | Ya | OAuth 2.0 Client Secret dari client yang sama |
| `GMAIL_REDIRECT_URI` | Ya | Harus sama persis dengan redirect URI Google; default `http://localhost:3000/oauth2callback` |
| `GMAIL_REFRESH_TOKEN` | Ya | Dihasilkan oleh `npm run gmail:auth` setelah consent |
| `GMAIL_POLL_SECONDS` | Tidak | Interval polling; default `120`, minimum `30` |
| `GMAIL_MATCH_THRESHOLD` | Tidak | Confidence notifikasi semantik `0..1`; default `0.72` |
| `GMAIL_MAX_BODY_CHARS` | Tidak | Potongan body yang dianalisis; default `6000` |
| `EMAIL_MAX_RETRIES` | Tidak | Retry sebelum dead-letter; default `3` |

### Web search

| Variable | Wajib | Cara mendapatkan / default |
|---|---:|---|
| `SEARCH_PROVIDER` | Tidak | `searxng` (default) atau `brave` |
| `SEARXNG_BASE_URL` | Untuk SearXNG | URL dari proses Node; default `http://localhost:8080` |
| `DOCKER_SEARXNG_BASE_URL` | Untuk Compose | DNS internal container; default `http://searxng:8080` |
| `SEARXNG_SECRET` | Untuk SearXNG | Generate dengan `npm run searxng:secret` |
| `BRAVE_SEARCH_API_KEY` | Untuk Brave | API key dari Brave Search API dashboard |
| `SEARCH_RESULT_LIMIT` | Tidak | Jumlah hasil; default `5`, maksimum `10` |

## Menghubungkan Gmail

Integrasi Gmail bersifat opsional. Assistant hanya meminta scope `gmail.readonly`; aplikasi tidak dapat mengirim, mengubah, atau menghapus email.

### 1. Buat dan konfigurasi Google Cloud project

1. Buka [Google Cloud Console](https://console.cloud.google.com/) dan buat/pilih project.
2. Buka **APIs & Services → Library**, cari **Gmail API**, lalu pilih **Enable**.
3. Buka **Google Auth Platform → Branding** dan isi nama aplikasi serta email kontak.
4. Buka **Audience**, pilih **External**, dan biarkan publishing status **Testing** untuk penggunaan personal.
5. Pada **Test users**, tambahkan alamat Gmail yang akan dihubungkan. Untuk penggunaan personal/testing, aplikasi tidak perlu dipublikasikan.
6. Bila halaman **Data Access** meminta scope, tambahkan `https://www.googleapis.com/auth/gmail.readonly`.

### 2. Buat OAuth Client ID

1. Buka **Google Auth Platform → Clients** atau **APIs & Services → Credentials**.
2. Pilih **Create OAuth client**.
3. Pilih application type **Web application**.
4. Pada **Authorized JavaScript origins**, biarkan kosong. Origin tidak boleh berisi path.
5. Pada **Authorized redirect URIs**, tambahkan persis:

```text
http://localhost:3000/oauth2callback
```

6. Simpan, lalu salin Client ID dan Client Secret ke `.env`:

```dotenv
GMAIL_CLIENT_ID=client-id-dari-google
GMAIL_CLIENT_SECRET=client-secret-dari-google
GMAIL_REDIRECT_URI=http://localhost:3000/oauth2callback
```

Jika port atau path diubah, nilai di Google Console dan `GMAIL_REDIRECT_URI` harus identik.

### 3. Hasilkan refresh token

Jalankan di komputer lokal yang mempunyai browser dan port `3000` tersedia:

```powershell
npm run gmail:auth
```

Script akan mencetak URL dan teks `Menunggu callback...`; ini normal. Buka URL tersebut di browser, login menggunakan test user yang didaftarkan, lalu:

1. Jika muncul **Google hasn't verified this app**, pilih **Continue** hanya bila Anda sendiri yang membuat OAuth project tersebut.
2. Izinkan akses read-only Gmail.
3. Setelah browser menampilkan keberhasilan, kembali ke terminal.
4. Salin baris refresh token yang dicetak ke `.env`:

```dotenv
GMAIL_REFRESH_TOKEN=refresh-token-dari-script
```

Jalankan ulang bot dan periksa `/status`. Refresh token tidak ditulis otomatis ke file dan `.env` tidak boleh di-commit.

Untuk deployment, lakukan proses OAuth ini di komputer lokal terlebih dahulu, lalu salin value `.env` secara aman ke server. Script auth tidak perlu dijalankan di container production.

### Troubleshooting OAuth Gmail

- `Error 403: access_denied`: pastikan email yang login tercantum persis pada **Test users** dan project yang dipilih benar.
- `Invalid Origin: URIs must not contain a path`: pindahkan URL callback ke **Authorized redirect URIs**; jangan masukkan `/oauth2callback` ke JavaScript origins.
- Terminal berhenti pada `Menunggu callback`: buka URL yang dicetak dan selesaikan consent; terminal memang menunggu redirect browser.
- Tidak mendapat refresh token: cabut akses aplikasi pada Google Account, pastikan login sebagai test user, lalu jalankan ulang `npm run gmail:auth`.
- Port `3000` dipakai aplikasi lain: hentikan aplikasi tersebut atau ubah port di Google redirect URI dan `.env` secara konsisten.

Google menjelaskan bahwa server-side OAuth menghasilkan authorization code yang ditukar menjadi access token dan refresh token untuk akses offline. Dokumentasi resmi: [Gmail server-side OAuth](https://developers.google.com/workspace/gmail/api/auth/web-server) dan [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

### Contoh pemantauan email

Kirim pesan biasa kepada bot:

```text
Kalau ada email baru tentang invoice proyek Alpha atau tagihan hosting, langsung kabari saya di Telegram.
```

Model akan membuat aturan persisten. Poller mengambil hanya perubahan baru melalui Gmail History API, lalu `gpt-4o-mini` menilai kecocokan semantik. Gunakan:

- `/watches` untuk melihat aturan.
- `/pause_watch <id>` untuk menjeda.
- `/resume_watch <id>` untuk mengaktifkan.
- `/delete_watch <id>` untuk menghapus.

Saat pertama diaktifkan, poller membuat baseline dan tidak membanjiri Telegram dengan email lama. Untuk email yang sudah ada, tanyakan langsung, misalnya `Cari email tentang tiket penerbangan bulan lalu`.

Subject, snippet, dan potongan body email dikirim ke model OpenAI yang dikonfigurasi untuk pencarian dan klasifikasi semantik. Konten tersebut tidak ditulis ke log; teks notifikasi yang sempat masuk outbox lokal juga dibersihkan setelah berhasil dikirim. Jika pemrosesan atau pengiriman gagal, sistem mencoba ulang sampai `EMAIL_MAX_RETRIES`, lalu menandainya sebagai dead-letter yang terlihat di `/status` agar satu email rusak tidak menghentikan seluruh cursor.

Outbox mencegah notifikasi hilang bila proses mati sebelum pengiriman. Jaminannya adalah *at-least-once*: pada celah yang sangat sempit—Telegram sudah menerima pesan tetapi proses mati sebelum status `sent` tersimpan—pesan dapat terkirim dua kali setelah restart.

## Pencarian web gratis

Default proyek adalah SearXNG self-hosted, sehingga tidak membutuhkan credential pencarian atau biaya per request. Brave Search tetap tersedia bila Anda lebih memilih layanan hosted.

### Pilihan A — Brave Search

1. Buat akun pada [Brave Search API](https://brave.com/search/api/).
2. Pilih paket yang tersedia dan buat API key dari dashboard.
3. Masukkan key ke `.env` seperti berikut.

```dotenv
SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=...
```

Harga, kuota, dan persyaratan verifikasi Brave dapat berubah; periksa halaman pricing dan dashboard akun sebelum memilihnya. Perlakukan API key sebagai rahasia.

### Pilihan B — SearXNG

SearXNG tidak membutuhkan API key atau biaya per pencarian, tetapi dijalankan sendiri:

```powershell
npm run searxng:secret
# Salin SEARXNG_SECRET yang dicetak ke .env, lalu:
docker compose --profile searxng up -d searxng
```

Lalu:

```dotenv
SEARCH_PROVIDER=searxng
SEARXNG_BASE_URL=http://localhost:8080
```

Di dalam Docker Compose, `DOCKER_SEARXNG_BASE_URL` default ke `http://searxng:8080` karena `localhost` di container menunjuk ke container assistant sendiri.

Konfigurasi repository sudah mengaktifkan output JSON yang dibutuhkan API dan hanya memublikasikan port ke `127.0.0.1`, bukan seluruh LAN. Limiter tidak digunakan karena instance bersifat lokal dan limiter SearXNG memerlukan Valkey; jangan mengekspos instance ini ke internet. Dokumentasi: [SearXNG Search API](https://docs.searxng.org/dev/search_api.html) dan [server settings](https://docs.searxng.org/admin/settings/settings_server.html).

## Memori

Contoh:

```text
Ingat bahwa saya tinggal di Jakarta dan lebih suka jawaban singkat.
```

Perintah:

- `/memory` melihat memori.
- `/forget <id>` menghapus satu memori.
- `/clear_memory CONFIRM` menghapus seluruh memori personal.
- `/clear_chat CONFIRM` menghapus riwayat pendek dan pesan Telegram yang tercatat dalam batas 48 jam Bot API, tanpa menghapus memori atau isi vault. Pesan yang lebih lama harus dihapus manual melalui aplikasi Telegram.

Memori memakai pencarian lexical lokal agar tidak membutuhkan embedding API dan tidak menambah biaya. Preferensi selalu tersedia sebagai konteks, sedangkan fakta lain hanya dimuat bila relevan dengan pertanyaan. Riwayat chat yang lebih lama dari `MESSAGE_RETENTION_DAYS` (default 90 hari) dibersihkan saat startup. Desain provider memungkinkan semantic/embedding retrieval ditambahkan nanti.

## Vault dan dashboard

Forward chat atau dokumen non-gambar ke bot untuk menyimpannya langsung. Foto dan dokumen gambar hanya masuk vault bila merupakan forward atau memakai caption `/save [folder]`; selain itu alur analisis gambar tetap berlaku. Untuk menyimpan chat yang sudah ada, reply pesan tersebut dengan `/save [judul] | [folder opsional]`.

Contoh alur:

```text
/mkdir Kerja/Invoice

# kirim dokumen dengan caption:
/save Kerja/Invoice

# cari dan ambil kembali:
/find invoice Agustus
/get 42
```

Nama item harus unik di folder yang sama tanpa membedakan huruf besar/kecil. Bila nama sudah ada, bot/dashboard menolak upload dan menunjukkan item konflik; file lama tidak ditimpa diam-diam.

Jalankan aplikasi, lalu buka `http://127.0.0.1:3030`. Dashboard menyediakan navigasi folder, pencarian nama/isi catatan, upload/download, catatan baru, rename, move, delete dengan konfirmasi, dan ringkasan status aplikasi. Untuk Docker/cloud, isi `DASHBOARD_TOKEN`; browser meminta Basic Auth (username bebas, password adalah token tersebut).

## Analisis gambar dan trace

Ada dua cara mengirim gambar:

1. Kirim foto dengan caption pertanyaan; bot langsung menganalisisnya.
2. Kirim foto tanpa caption; setelah bot mengonfirmasi penerimaan, kirim pertanyaan teks dalam 10 menit.

Bot mengambil resolusi foto Telegram terbesar dan mengirim gambar sebagai data URL ke model vision. URL unduhan Telegram yang mengandung bot token tidak ditulis ke log. Gambar mentah tidak disimpan ke SQLite; riwayat hanya menyimpan caption dan penanda bahwa sebuah gambar pernah dilampirkan.

Gunakan `/trace on` untuk menampilkan tahapan, tool, durasi, model, dan penggunaan token. `/last_trace` selalu dapat menampilkan trace teknis terakhir. Trace adalah observabilitas operasional, bukan chain-of-thought internal model. Gunakan `/cancel` untuk membatalkan request aktif. Bot memakai runner concurrent agar perintah pembatalan tetap dapat diproses ketika model sedang bekerja, sementara request AI tetap dibatasi satu per chat.

## Verifikasi sebelum deployment

Jalankan pemeriksaan source code terlebih dahulu:

```powershell
npm run check
npm test
npm run build
npm audit
```

Jika akan memakai Docker, validasi konfigurasi Compose setelah `.env` diisi:

```powershell
docker compose config --quiet
```

Lanjutkan dengan uji fungsional lokal:

1. Jalankan `npm run dev`.
2. Kirim `/status` untuk melihat konfigurasi model, Gmail, search, outbox, dan database.
3. Kirim `Balas dengan kata: berhasil` untuk menguji panggilan OpenAI sebenarnya.
4. Kirim gambar dengan caption pertanyaan untuk menguji vision.
5. Aktifkan `/trace on`, kirim pertanyaan, lalu periksa `/last_trace`.
6. Bila Gmail aktif, coba `Cari email terbaru dari Google` dan buat satu aturan watch percobaan.
7. Bila search aktif, coba `Cari berita teknologi terbaru dan sertakan sumber`.

`/status` memeriksa konfigurasi aplikasi, tetapi request percobaan tetap diperlukan untuk membuktikan credential remote, quota, model, dan jaringan benar-benar berfungsi.

## Deployment

### Pilihan A — Railway + persistent volume (direkomendasikan untuk 24/7)

Repository sudah menyertakan `railway.json`, healthcheck `/health`, restart policy, dan Dockerfile. Buat satu service dari GitHub, pasang volume pada `/app/data`, gunakan tepat satu replica, lalu set `DATABASE_PATH=/app/data/assistant.sqlite`, `VAULT_STORAGE_PATH=/app/data/vault`, `DASHBOARD_HOST=0.0.0.0`, `DASHBOARD_TOKEN`, dan `RAILWAY_RUN_UID=0`. Railway akan menginjeksi `PORT`.

Panduan lengkap, topologi, daftar variable, backup/restore, dan alternatif Fly.io ada di [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Pilihan B — Docker Compose di VPS

Sebelum menyalin project ke server:

- Lengkapi `.env` dan uji bot secara lokal.
- Isi `DASHBOARD_TOKEN`; Compose mengekspos dashboard hanya pada `127.0.0.1:${PORT:-3030}` di host.
- Jika Gmail digunakan, hasilkan `GMAIL_REFRESH_TOKEN` secara lokal terlebih dahulu.
- Pastikan server dapat membuat koneksi HTTPS keluar ke Telegram, OpenAI, dan Google. Telegram long polling tidak memerlukan port masuk atau domain publik.
- Di Linux, batasi izin file dengan `chmod 600 .env`.

Untuk menjalankan assistant bersama SearXNG:

```powershell
docker compose config --quiet
docker compose --profile searxng up -d --build
docker compose ps
docker compose logs --tail=100 assistant
```

Jika memakai Brave dan tidak memerlukan container SearXNG:

```powershell
docker compose up -d --build assistant
```

Buka Telegram, jalankan `/status`, lalu ulangi uji chat, image, Gmail, dan search yang digunakan. Hanya satu instance assistant boleh berjalan untuk satu token bot dan satu file database.

Untuk mengambil pembaruan source dan membangun ulang:

```powershell
git pull --ff-only
docker compose --profile searxng up -d --build
```

Perintah operasional penting:

```powershell
docker compose logs -f assistant
docker compose stop assistant
docker compose start assistant
docker compose down
```

`docker compose down` menghapus container dan network, tetapi bind mount `./data` tetap berada di host. Jangan gunakan `down -v` dan jangan menghapus folder `data` bila database masih diperlukan. Dokumentasi Docker menyarankan file Compose tambahan untuk perbedaan production bila nanti Anda membutuhkan konfigurasi khusus server; lihat [Docker Compose production](https://docs.docker.com/compose/how-tos/production/).

### Pilihan C — Node.js sebagai proses langsung

Gunakan pilihan ini bila server tidak memakai Docker:

```powershell
npm ci
npm run check
npm test
npm run build
npm prune --omit=dev
npm start
```

Jalankan `npm run gmail:auth` sebelum `npm prune --omit=dev`, karena script OAuth menggunakan dependency development. `npm start` harus dijaga oleh process manager atau service manager agar otomatis hidup kembali setelah crash/reboot.

Contoh unit `systemd` untuk Linux—sesuaikan user, lokasi project, dan hasil `which node`:

```ini
[Unit]
Description=Personal AI Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=personal-ai
WorkingDirectory=/opt/personal-ai-assistant
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/personal-ai-assistant/dist/src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Simpan sebagai `/etc/systemd/system/personal-ai-assistant.service`, lalu:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now personal-ai-assistant
sudo systemctl status personal-ai-assistant
sudo journalctl -u personal-ai-assistant -f
```

### Data persisten dan backup

SQLite, memori, aturan email, cursor Gmail, trace, dan seluruh byte file vault tersimpan pada `./data`. Untuk backup yang konsisten:

1. Hentikan proses/container assistant.
2. Salin seluruh folder `data` ke lokasi backup yang terenkripsi atau aksesnya terbatas.
3. Jalankan kembali assistant.

File `.env` juga perlu dicadangkan secara aman, terpisah dari Git. Jangan menaruhnya di image Docker, repository, chat, atau issue tracker.

### Checklist setelah deployment

- `.env` tidak terlacak Git dan hanya dapat dibaca oleh operator service.
- Token/key yang pernah tampil di chat, screenshot, atau commit sudah dirotasi.
- Hanya satu proses bot berjalan untuk token tersebut.
- Folder `data` persisten dan mempunyai backup.
- Database dan folder `data/vault` selalu dibackup/dipulihkan sebagai satu kesatuan.
- `/status` tidak menunjukkan konfigurasi wajib yang hilang atau dead-letter Gmail.
- Chat teks, gambar, dan `/last_trace` berhasil.
- Gmail search/watch berhasil bila diaktifkan.
- Web search menghasilkan URL sumber bila diaktifkan.
- Dashboard memakai HTTPS + `DASHBOARD_TOKEN` bila diakses melalui jaringan.
- SearXNG tetap terikat ke localhost dan tidak terbuka ke internet.

## Troubleshooting runtime

- Bot tidak merespons: pastikan proses masih hidup, token benar, numeric owner ID benar, chat bersifat private, dan tidak ada instance kedua dengan token yang sama.
- Respons muncul berulang: biasanya lebih dari satu instance bot berjalan. Hentikan proses/container duplikat.
- OpenAI `401`: key salah, dicabut, atau dimasukkan ke variable yang keliru. OpenAI `429`: periksa quota, billing, dan rate limit project.
- Model tidak ditemukan: gunakan model yang tersedia untuk project lalu ubah `OPENAI_CHAT_MODEL` dan `OPENAI_CLASSIFIER_MODEL`.
- Gambar tidak dijawab: periksa ukuran/format, caption atau masa tunggu gambar, model yang mendukung vision, log aplikasi, dan `/last_trace`.
- Search SearXNG gagal: periksa `docker compose ps searxng` dan `docker compose logs searxng`; proses lokal memakai `localhost`, sedangkan container memakai nama service `searxng`.
- Gmail tidak aktif: pastikan keempat variable Gmail terisi, refresh token masih valid, dan Gmail API tetap enabled.
- Proses lambat: periksa trace durasi tiap tahap, koneksi jaringan, search/Gmail tool yang dipanggil, timeout, serta model. Naikkan token output hanya bila jawaban memang terpotong karena token yang lebih besar juga dapat menambah waktu dan biaya.

## Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/start`, `/help` | Bantuan dan contoh penggunaan |
| `/status` | Status model, Gmail, dan search |
| `/trace on\|off` | Aktifkan/nonaktifkan detail proses live |
| `/last_trace` | Lihat trace teknis permintaan terakhir |
| `/cancel` | Batalkan permintaan aktif atau buang gambar sementara |
| `/memory` | Daftar memori personal |
| `/forget <id>` | Hapus memori |
| `/clear_memory CONFIRM` | Hapus seluruh memori setelah konfirmasi eksplisit |
| `/vault [folder]` | Lihat isi root atau folder vault |
| `/mkdir <folder/subfolder>` | Buat folder bertingkat |
| `/save` | Simpan pesan yang dibalas; pada file dapat dipakai sebagai caption |
| `/find <query>` | Cari nama file atau isi catatan |
| `/get <id>` | Kirim kembali file ke Telegram |
| `/rename <id> <nama>` | Ubah nama item setelah cek duplikat |
| `/move <id> <folder\|/>` | Pindahkan item ke folder atau root |
| `/delete_item <id> CONFIRM` | Hapus item/folder beserta isinya |
| `/watches` | Daftar aturan email |
| `/pause_watch <id>` | Jeda aturan |
| `/resume_watch <id>` | Aktifkan aturan |
| `/delete_watch <id>` | Hapus aturan |
| `/clear_chat CONFIRM` | Reset konteks AI dan hapus pesan Telegram tercatat hingga 48 jam terakhir |

Selain perintah tersebut, gunakan bahasa natural untuk bertanya, menerjemahkan, mencari, menyimpan preferensi, atau membuat aturan email.

## Keamanan dan batasan

- Bot menolak semua user selain ID pemilik dan menolak group chat.
- Gmail memakai read-only scope.
- Email, hasil web, isi vault, dan teks di dalam gambar diperlakukan sebagai untrusted data dalam prompt.
- Tool yang mengubah memori atau aturan hanya tersedia bila klausa awal pesan pemilik secara eksplisit meminta aksi tersebut; penghapusan hanya melalui command deterministik.
- Subject/body email tidak ditulis ke log aplikasi.
- Riwayat, memori, dan seluruh isi vault tersimpan dalam bentuk plaintext; lindungi folder/volume `data`, backup, serta dashboard.
- Dashboard tanpa token hanya diizinkan pada loopback. Bind jaringan/cloud gagal saat startup bila `DASHBOARD_TOKEN` kosong.
- Gambar dikirim ke OpenAI untuk dianalisis, tetapi gambar mentah tidak disimpan ke database atau log aplikasi.
- Foto tanpa caption berada sementara di RAM dan kedaluwarsa otomatis; restart proses juga langsung membuangnya.
- Tool yang tersedia tidak dapat mengirim email, menghapus email, menjalankan shell, atau melakukan transaksi.
- SQLite cocok untuk satu proses personal. Jangan menjalankan beberapa replica bot terhadap volume database yang sama.
- Pencocokan email memakai model probabilistik. Sesuaikan `GMAIL_MATCH_THRESHOLD` jika notifikasi terlalu banyak atau terlalu sedikit.
- Aplikasi tidak memproses lampiran Gmail pada versi ini.

## Referensi Standalone RAG Chatbot

Repository `Standalone RAG Chatbot` digunakan sebagai referensi pola untuk provider boundary, bounded conversation history, structured output, redaksi log, dan usage tracking. Komponen multi-user, dashboard Next.js, Docling, worker publik, dan pgvector tidak disalin karena tidak diperlukan untuk assistant Telegram personal. Jika fitur tanya-jawab dokumen pribadi ditambahkan nanti, retrieval pipeline dari proyek tersebut dapat diadaptasi sebagai tool baru tanpa mengubah adapter Telegram.
