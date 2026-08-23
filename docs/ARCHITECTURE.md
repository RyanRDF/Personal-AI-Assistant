# Arsitektur

## Tujuan desain

- Satu pemilik, satu Telegram bot, satu proses.
- Dapat dijalankan di laptop atau VPS tanpa public endpoint.
- Credential cukup dimasukkan melalui `.env`.
- Integrasi eksternal berada di belakang service boundary.
- Aksi saat ini read-only atau lokal sehingga risiko rendah.

## Komponen

### Telegram adapter

`src/telegram/bot.ts` menerima update teks, foto, dan dokumen melalui long polling concurrent. Middleware pertama memverifikasi numeric owner ID dan private chat. Forward chat/file disimpan ke vault; gambar biasa tetap mengikuti alur vision. Progress edit dibatasi lajunya, request memiliki timeout, dan `/cancel` tetap responsif ketika model bekerja.

### AI orchestrator

`src/ai/assistant.ts` menyediakan tool terstruktur:

- `remember`
- `update_memory`
- `create_email_watch`
- `list_email_watches`
- `search_gmail`
- `search_web`
- `save_vault_note`
- `create_vault_folder`
- `search_vault`
- `list_vault`
- `return_vault_file`

Model melakukan maksimum enam putaran tool untuk mencegah loop tanpa batas. Chat completion diproses secara streaming agar preview jawaban dapat ditampilkan. Tool mutasi hanya dimasukkan ke request model bila klausa awal pesan pemilik memberi intent eksplisit; penghapusan memori/aturan tetap command Telegram deterministik. Semua penggunaan token ditulis ke `usage_events`; tahap, tool, durasi, dan status request ditulis ke `request_traces` tanpa menyimpan gambar atau chain-of-thought.

### Memori

SQLite menyimpan riwayat pendek dan memori jangka panjang secara terpisah. Retrieval memori memakai lexical overlap lokal. Ini cukup untuk satu pengguna dan menghindari biaya embedding. Implementasi dapat diganti dengan hybrid retrieval dari Standalone RAG Chatbot tanpa mengubah Telegram.

### Vault

`VaultService` memakai SQLite untuk struktur folder, nama, tipe, hash, sumber Telegram, dan isi catatan. Byte file memakai nama storage key acak di `VAULT_STORAGE_PATH`, sehingga nama pengguna tidak pernah menjadi path filesystem. Unique index pada `(parent, lower(name))` menolak nama duplikat di folder yang sama. Operasi file memakai journal SQLite serta staging/trash pada volume yang sama; startup merekonsiliasi operasi yang terputus. Path folder divalidasi penuh sebelum dibuat dalam satu transaksi.

Konteks otomatis dan pencarian vault hanya memasukkan metadata sebagai data tidak tepercaya. Isi note penuh hanya tersedia melalui tool read yang diotorisasi dari permintaan eksplisit pemilik; turn yang membaca note sensitif tidak diberi tool egress jaringan. Tool read-only tetap dapat mencari item dan mengantrekan file untuk dikirim kembali ke chat Telegram pemilik.

### Dashboard

Server HTTP bawaan menyediakan dashboard file manager, API vault, dan `/health`. Dashboard hanya dapat berjalan tanpa token pada interface loopback. Bind ke container/jaringan mewajibkan Basic Auth melalui `DASHBOARD_TOKEN`. Endpoint health publik hanya mengembalikan `{ "ok": true }`; statistik rinci berada di `/api/status` yang terautentikasi.

### Gmail

Gmail memakai OAuth refresh token dan scope `gmail.readonly`.

```text
getProfile.historyId (baseline)
          │
          ▼
users.history.list(messageAdded)
          │
          ▼
ambil email baru, abaikan SENT/DRAFT
          │
          ▼
gpt-4o-mini semantic match
(Gmail query hanya hint, bukan hard filter)
          │
          ├── tidak cocok → simpan evaluation
          └── cocok → outbox SQLite → kirim Telegram
```

Cursor dan epoch checkpoint baru disimpan bersama setelah tidak ada kegagalan transient. Fetch, klasifikasi, dan pengiriman dicoba ulang sampai `EMAIL_MAX_RETRIES`; kegagalan terminal masuk dead-letter sehingga cursor tetap dapat bergerak. Unique key `(rule_id, gmail_message_id)` mencegah satu rule dievaluasi/diantrekan dua kali. Jika cursor Gmail kedaluwarsa, aplikasi melakukan catch-up paginated sejak checkpoint sukses terakhir; database lama memakai fallback tujuh hari.

Outbox memberi delivery *at-least-once*. Crash setelah Telegram menerima pesan tetapi sebelum transaksi status `sent` selesai dapat menghasilkan duplikat langka; exactly-once tidak dapat dijamin oleh Telegram Bot API tanpa transaksi lintas layanan.

### Web search

`WebSearchProvider` memiliki implementasi Brave dan SearXNG. Tool mengembalikan title, URL, dan snippet sebagai untrusted data. System prompt mewajibkan sitasi URL.

## Skema database

| Tabel | Fungsi |
|---|---|
| `messages` | Riwayat percakapan pendek per Telegram chat |
| `memories` | Preferensi/fakta/komitmen personal |
| `vault_items` | Struktur folder, catatan, dan metadata file vault |
| `vault_fs_operations` | Journal staging/trash untuk recovery operasi file vault |
| `email_rules` | Deskripsi semantik dan Gmail query opsional |
| `email_evaluations` | Deduplikasi dan audit hasil rule-message |
| `email_processing_failures` | Retry/dead-letter fetch dan klasifikasi |
| `email_notifications` | Persistent notification outbox dan status pengiriman |
| `app_state` | Gmail History cursor dan state kecil lain |
| `usage_events` | Penggunaan token per purpose/model |
| `request_traces` | Tahap operasional, tool, durasi, status, dan token per request |

## Trust boundaries

- Telegram identity adalah authorization boundary utama.
- `.env` adalah secret boundary dan tidak masuk Git.
- Email, web, memory, data vault, dan teks di dalam gambar merupakan input tidak tepercaya.
- Gambar dikirim ke model sebagai data URL dan tidak disimpan di database atau log.
- Subject, snippet, dan body email yang dipotong dikirim ke OpenAI untuk klasifikasi/pencarian; tidak ditulis ke log.
- OpenAI tidak diberi tool shell, email send, atau delete; mutasi vault hanya tersedia untuk intent eksplisit.
- Gmail token hanya dibaca dari environment; tidak disimpan plaintext di database.
- Memori, riwayat chat, catatan vault, dan file tetap plaintext; keamanan disk/volume host berada di luar proses aplikasi.

## Pengembangan berikutnya

Komponen yang dapat ditambahkan tanpa merombak core:

- Calendar/reminder scheduler.
- Voice-note transcription.
- RAG dokumen pribadi sebagai tool baru.
- Enkripsi secret dengan AES-256-GCM jika credential dipindahkan dari environment ke database.
- Conversation summarization saat history panjang.
- Model router fast/smart jika kebutuhan reasoning kompleks mulai sering muncul.
