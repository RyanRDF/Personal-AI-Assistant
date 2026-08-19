# Arsitektur

## Tujuan desain

- Satu pemilik, satu Telegram bot, satu proses.
- Dapat dijalankan di laptop atau VPS tanpa public endpoint.
- Credential cukup dimasukkan melalui `.env`.
- Integrasi eksternal berada di belakang service boundary.
- Aksi saat ini read-only atau lokal sehingga risiko rendah.

## Komponen

### Telegram adapter

`src/telegram/bot.ts` menerima update teks, foto, dan dokumen gambar melalui long polling concurrent. Middleware pertama memverifikasi numeric owner ID dan private chat. Foto dengan caption langsung diteruskan sebagai input vision; foto tanpa caption hanya disimpan sementara di RAM untuk pertanyaan berikutnya. Progress edit dibatasi lajunya, request memiliki timeout, dan `/cancel` tetap responsif ketika model bekerja.

### AI orchestrator

`src/ai/assistant.ts` menyediakan tool terstruktur:

- `remember`
- `update_memory`
- `create_email_watch`
- `list_email_watches`
- `search_gmail`
- `search_web`

Model melakukan maksimum enam putaran tool untuk mencegah loop tanpa batas. Chat completion diproses secara streaming agar preview jawaban dapat ditampilkan. Tool mutasi hanya dimasukkan ke request model bila klausa awal pesan pemilik memberi intent eksplisit; penghapusan memori/aturan tetap command Telegram deterministik. Semua penggunaan token ditulis ke `usage_events`; tahap, tool, durasi, dan status request ditulis ke `request_traces` tanpa menyimpan gambar atau chain-of-thought.

### Memori

SQLite menyimpan riwayat pendek dan memori jangka panjang secara terpisah. Retrieval memori memakai lexical overlap lokal. Ini cukup untuk satu pengguna dan menghindari biaya embedding. Implementasi dapat diganti dengan hybrid retrieval dari Standalone RAG Chatbot tanpa mengubah Telegram.

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

Cursor baru disimpan setelah tidak ada kegagalan transient. Fetch, klasifikasi, dan pengiriman dicoba ulang sampai `EMAIL_MAX_RETRIES`; kegagalan terminal masuk dead-letter sehingga cursor tetap dapat bergerak. Unique key `(rule_id, gmail_message_id)` mencegah satu rule dievaluasi/diantrekan dua kali. Jika cursor Gmail kedaluwarsa, aplikasi membuat baseline baru tanpa replay massal.

Outbox memberi delivery *at-least-once*. Crash setelah Telegram menerima pesan tetapi sebelum transaksi status `sent` selesai dapat menghasilkan duplikat langka; exactly-once tidak dapat dijamin oleh Telegram Bot API tanpa transaksi lintas layanan.

### Web search

`WebSearchProvider` memiliki implementasi Brave dan SearXNG. Tool mengembalikan title, URL, dan snippet sebagai untrusted data. System prompt mewajibkan sitasi URL.

## Skema database

| Tabel | Fungsi |
|---|---|
| `messages` | Riwayat percakapan pendek per Telegram chat |
| `memories` | Preferensi/fakta/komitmen personal |
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
- Email, web, dan teks di dalam gambar merupakan input tidak tepercaya.
- Gambar dikirim ke model sebagai data URL dan tidak disimpan di database atau log.
- Subject, snippet, dan body email yang dipotong dikirim ke OpenAI untuk klasifikasi/pencarian; tidak ditulis ke log.
- OpenAI tidak diberi tool shell, file mutation, email send, atau delete.
- Gmail token hanya dibaca dari environment; tidak disimpan plaintext di database.
- Memori dan riwayat chat tetap plaintext di SQLite; keamanan disk/volume host berada di luar proses aplikasi.

## Pengembangan berikutnya

Komponen yang dapat ditambahkan tanpa merombak core:

- Calendar/reminder scheduler.
- Voice-note transcription.
- RAG dokumen pribadi sebagai tool baru.
- Enkripsi secret dengan AES-256-GCM jika credential dipindahkan dari environment ke database.
- Conversation summarization saat history panjang.
- Model router fast/smart jika kebutuhan reasoning kompleks mulai sering muncul.
