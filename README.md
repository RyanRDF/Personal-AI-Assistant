# Personal AI Assistant

Asisten AI personal berbasis Telegram untuk satu pemilik. Aplikasi dapat mengobrol dalam bahasa Indonesia, mengingat preferensi, mencari web, mencari Gmail, dan mengirim notifikasi Telegram ketika email baru cocok secara semantik dengan deskripsi yang pernah diberikan.

## Fitur

- Telegram long polling: tidak membutuhkan domain publik atau webhook.
- Owner-only dan private-chat-only melalui `TELEGRAM_ALLOWED_USER_ID`.
- Model dapat diganti lewat `.env`; default ekonomis `gpt-4o-mini`.
- Memori personal dan riwayat percakapan persisten di SQLite.
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
        ├── Gmail search
        ├── Email watch rules
        └── Brave Search / SearXNG

Gmail History poller ── semantic classifier ── Telegram notification
```

Detail desain ada di [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Perbandingan model ada di [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md).

## Persyaratan

- Node.js 22 atau lebih baru.
- Telegram bot token dari `@BotFather`.
- Numeric Telegram user ID pemilik, misalnya dari `@userinfobot`.
- OpenAI API key.
- Opsional: Google OAuth client untuk Gmail.
- Opsional: Brave Search API key atau Docker untuk SearXNG.

## Instalasi lokal

```powershell
Copy-Item .env.example .env
npm install
```

Isi minimal berikut di `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=token_dari_botfather
TELEGRAM_ALLOWED_USER_ID=123456789
OPENAI_API_KEY=sk-...
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
```

Jalankan:

```powershell
npm run searxng:secret
# Salin SEARXNG_SECRET yang dicetak ke .env, lalu jalankan backend pencarian gratis:
docker compose --profile searxng up -d searxng
npm run dev
```

Bot memakai long polling, sehingga komputer/VPS harus tetap hidup. Untuk produksi:

```powershell
npm run build
npm start
```

## Menghubungkan Gmail

Assistant meminta scope `gmail.readonly`; aplikasi tidak dapat mengirim atau menghapus email.

1. Buat project di Google Cloud Console.
2. Aktifkan Gmail API.
3. Konfigurasikan OAuth consent screen.
4. Buat OAuth Client ID untuk desktop/local app. Pastikan redirect URI yang dipakai cocok dengan `GMAIL_REDIRECT_URI`, default `http://localhost:3000/oauth2callback`.
5. Masukkan client ID dan client secret ke `.env`:

```dotenv
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=http://localhost:3000/oauth2callback
```

6. Jalankan:

```powershell
npm run gmail:auth
```

7. Buka URL yang dicetak, izinkan akses, lalu salin `GMAIL_REFRESH_TOKEN` yang tampil di terminal ke `.env`.
8. Restart bot dan cek `/status`.

Refresh token tidak ditulis ke file oleh script dan `.env` sudah masuk `.gitignore`. Jangan mengirim atau melakukan commit terhadap credential tersebut.

Dokumentasi resmi: [Gmail server-side OAuth](https://developers.google.com/workspace/gmail/api/auth/web-server) dan [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

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

Brave saat ini memberi kredit gratis bulanan yang cukup untuk sekitar 1.000 pencarian pada harga Search API standar. Akun tetap perlu dibuat dan menurut Brave kartu digunakan untuk verifikasi anti-fraud. Lihat [Brave Search API](https://brave.com/search/api/).

```dotenv
SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=...
```

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
- `/clear_chat` menghapus riwayat pendek tanpa menghapus memori.

Memori memakai pencarian lexical lokal agar tidak membutuhkan embedding API dan tidak menambah biaya. Preferensi selalu tersedia sebagai konteks, sedangkan fakta lain hanya dimuat bila relevan dengan pertanyaan. Riwayat chat yang lebih lama dari `MESSAGE_RETENTION_DAYS` (default 90 hari) dibersihkan saat startup. Desain provider memungkinkan semantic/embedding retrieval ditambahkan nanti.

## Menjalankan dengan Docker

```powershell
Copy-Item .env.example .env
npm run searxng:secret
# Salin secret ke .env, lalu:
docker compose --profile searxng up -d --build
docker compose logs -f assistant
```

Database disimpan pada `./data` dan tidak masuk Git.

## Pengujian

```powershell
npm run check
npm test
npm run build
npm audit
```

## Perintah Telegram

| Perintah | Fungsi |
|---|---|
| `/start`, `/help` | Bantuan dan contoh penggunaan |
| `/status` | Status model, Gmail, dan search |
| `/memory` | Daftar memori personal |
| `/forget <id>` | Hapus memori |
| `/clear_memory CONFIRM` | Hapus seluruh memori setelah konfirmasi eksplisit |
| `/watches` | Daftar aturan email |
| `/pause_watch <id>` | Jeda aturan |
| `/resume_watch <id>` | Aktifkan aturan |
| `/delete_watch <id>` | Hapus aturan |
| `/clear_chat` | Hapus riwayat chat pendek |

Selain perintah tersebut, gunakan bahasa natural untuk bertanya, menerjemahkan, mencari, menyimpan preferensi, atau membuat aturan email.

## Keamanan dan batasan

- Bot menolak semua user selain ID pemilik dan menolak group chat.
- Gmail memakai read-only scope.
- Email dan hasil web diberi batas sebagai untrusted data dalam prompt.
- Tool yang mengubah memori atau aturan hanya tersedia bila klausa awal pesan pemilik secara eksplisit meminta aksi tersebut; penghapusan hanya melalui command deterministik.
- Subject/body email tidak ditulis ke log aplikasi.
- Riwayat dan memori tersimpan lokal di SQLite dalam bentuk plaintext; lindungi akses ke folder `data` dan disk host.
- Tool yang tersedia tidak dapat mengirim email, menghapus email, menjalankan shell, atau melakukan transaksi.
- SQLite cocok untuk satu proses personal. Jangan menjalankan beberapa replica bot terhadap volume database yang sama.
- Pencocokan email memakai model probabilistik. Sesuaikan `GMAIL_MATCH_THRESHOLD` jika notifikasi terlalu banyak atau terlalu sedikit.
- Aplikasi tidak memproses lampiran Gmail pada versi ini.

## Referensi Standalone RAG Chatbot

Repository `Standalone RAG Chatbot` digunakan sebagai referensi pola untuk provider boundary, bounded conversation history, structured output, redaksi log, dan usage tracking. Komponen multi-user, dashboard Next.js, Docling, worker publik, dan pgvector tidak disalin karena tidak diperlukan untuk assistant Telegram personal. Jika fitur tanya-jawab dokumen pribadi ditambahkan nanti, retrieval pipeline dari proyek tersebut dapat diadaptasi sebagai tool baru tanpa mengubah adapter Telegram.
