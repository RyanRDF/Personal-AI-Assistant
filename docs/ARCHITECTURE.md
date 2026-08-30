# Arsitektur

## Tujuan desain

- Satu pemilik, satu Telegram bot, satu proses.
- Dapat dijalankan di laptop atau VPS tanpa public endpoint.
- Credential cukup dimasukkan melalui `.env`.
- Integrasi eksternal berada di belakang service boundary.
- Aksi saat ini read-only atau lokal sehingga risiko rendah.

## Komponen

### Telegram adapter

`src/telegram/bot.ts` menerima teks, foto, dokumen, video, animation, audio, voice, video note, dan sticker melalui long polling concurrent. Middleware pertama memverifikasi numeric owner ID dan private chat. Attachment dan caption dinormalisasi sebagai satu request, diunduh dengan byte counter, divalidasi berdasarkan signature, disimpan ke Vault, lalu dianalisis sesuai tipe. Progress edit dibatasi lajunya, request memiliki timeout, dan `/cancel` tetap responsif ketika model bekerja.

### Agent runtime dan capability platform

`src/agent/runtime.ts` menjadi pintu masuk request AI dari Telegram. Runtime membuat `Agent Run`
persisten, mencatat event lifecycle secara append-only, meneruskan cancel signal, dan menutup run
sebagai `completed`, `failed`, atau `cancelled`. Pada startup, run `queued`/`running` yang terputus
ditandai gagal dengan kode aman; prompt mentah dan pesan error tidak disalin ke audit event.

`src/ai/assistant.ts` tetap menjadi compatibility model adapter berbasis Chat Completions selama
migrasi bertahap. Tool lokal dan MCP dinormalisasi menjadi `Capability`, lalu melewati tiga seam:

- `CapabilityRegistry` menggabungkan catalog adapter tanpa membuat satu koneksi rusak memutus catalog
  lokal;
- `PolicyEngine` menentukan capability yang boleh terlihat dan mengotorisasi ulang argumen tepat
  sebelum eksekusi;
- `CapabilityExecutor` hanya menjalankan invocation yang sudah memperoleh keputusan authorize.

Capability lokal yang tersedia meliputi:

- `remember`
- `update_memory`
- `create_email_watch`
- `list_email_watches`
- `search_gmail`
- `search_web`
- `save_vault_note`
- `create_vault_text_file`
- `create_vault_folder`
- `search_vault`
- `list_vault`
- `return_vault_file`

Model melakukan maksimum enam putaran tool untuk mencegah loop tanpa batas. Chat completion diproses
secara streaming agar preview jawaban dapat ditampilkan. Tool mutasi hanya dimasukkan ke request model
bila klausa awal pesan pemilik memberi intent eksplisit; penghapusan memori/aturan tetap command
Telegram deterministik. Semua penggunaan token ditulis ke `usage_events`; tahap, tool, durasi, dan
status request ditulis ke `request_traces` tanpa menyimpan gambar atau chain-of-thought.

### MCP adapter

`src/mcp/http-adapter.ts` memakai MCP TypeScript SDK resmi dan Streamable HTTP transport dengan
negosiasi versi otomatis. Koneksi berasal dari `MCP_CONNECTIONS_JSON`, bukan dari isi chat. Konfigurasi
menolak credential di URL, mewajibkan HTTPS untuk host remote, mereferensikan token melalui nama
environment variable, dan hanya mengekspos tool yang masuk allowlist.

Catalog discovery, schema hash, expiry, dan health connection disimpan di SQLite. Schema yang tidak
valid dilewati tanpa memutus capability lokal. Output MCP dipotong sesuai batas connection, media/body
resource tidak diteruskan, dan seluruh hasil diberi label `untrusted-external-result`.

Milestone saat ini hanya mengizinkan MCP `read` dengan `approval: never`. Konfigurasi lain gagal
tertutup. Tabel approval sudah disiapkan, tetapi approval interaktif dan resume run belum diaktifkan;
aksi tulis eksternal tidak dapat dieksekusi melalui adapter ini.

### Memori

SQLite menyimpan riwayat pendek dan memori jangka panjang secara terpisah. Retrieval memori memakai lexical overlap lokal. Ini cukup untuk satu pengguna dan menghindari biaya embedding. Implementasi dapat diganti dengan hybrid retrieval dari Standalone RAG Chatbot tanpa mengubah Telegram.

### Vault

Modul `Vault` memakai SQLite untuk struktur folder, nama, tipe, hash, caption/sumber Telegram, backend, dan isi catatan. Telegram, Dashboard, Assistant, dan test bergantung pada interface `Vault`; implementasi konkret serta adapter penyimpanan tetap internal. Byte file memakai storage key UUID, sehingga nama pengguna tidak pernah menjadi path fisik. Backend `local` memakai staging untuk write dan journal untuk cleanup delete setelah metadata commit; recovery tetap memahami operasi trash lama. Backend `s3` menyimpan file baru ke private Railway Bucket. Metadata per item membuat file legacy lokal tetap dapat dibaca setelah default diubah ke S3.

Upload tidak mempercayai filename atau MIME Telegram. Executable/script dan archive generik ditolak; signature, ukuran aktual, serta SHA-256 disimpan/divalidasi. Dashboard memaksa download dengan `Content-Disposition: attachment` dan `nosniff`.

### Attachment analyzer

- Gambar statis dikirim sebagai vision input.
- PDF, dokumen Office, text/code, dan spreadsheet dianalisis melalui OpenAI `input_file` pada Responses API tanpa tool.
- Audio/voice ditranskripsikan tanpa tool.
- Video tidak dikirim langsung ke model: FFmpeg non-shell mengekstrak frame terbatas dan audio; audio ditranskripsikan dan frame dikirim sebagai vision input.
- Format lain dapat disimpan sebagai byte opaque, tetapi bot menyatakan bahwa analisis belum didukung.

Seluruh OCR, isi dokumen, frame, dan transkrip dibungkus sebagai `UNTRUSTED_ATTACHMENT_DATA`. Turn attachment tidak diberi privileged tool, sehingga prompt injection di dalam file tidak dapat memberikan izin mutasi atau egress.

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
| `vault_fs_operations` | Journal staging/cleanup filesystem untuk recovery operasi file vault |
| `vault_object_operations` | Journal retry upload/delete object S3 lintas crash |
| `email_rules` | Deskripsi semantik dan Gmail query opsional |
| `email_evaluations` | Deduplikasi dan audit hasil rule-message |
| `email_processing_failures` | Retry/dead-letter fetch dan klasifikasi |
| `email_notifications` | Persistent notification outbox dan status pengiriman |
| `app_state` | Gmail History cursor dan state kecil lain |
| `usage_events` | Penggunaan token per purpose/model |
| `request_traces` | Tahap operasional, tool, durasi, status, dan token per request |
| `agent_runs` | Lifecycle durable satu request AI tanpa menyimpan prompt mentah |
| `agent_run_events` | Audit event append-only dan berurutan untuk setiap run |
| `agent_approvals` | Penyimpanan approval terikat digest untuk fase approval interaktif |
| `tool_invocations` | Status invocation dan idempotency untuk fase side effect durable |
| `mcp_connections` | Metadata, secret reference, dan health koneksi MCP |
| `mcp_capabilities` | Catalog capability MCP, schema hash, policy, dan masa cache |

## Trust boundaries

- Telegram identity adalah authorization boundary utama.
- `.env` adalah secret boundary dan tidak masuk Git.
- Email, web, MCP, memory, data vault, OCR, dokumen, transkrip, dan frame video merupakan input tidak tepercaya.
- Byte attachment disimpan sebagai object private dan tidak ditulis ke database atau log; SQLite hanya menyimpan metadata, caption, dan checksum.
- Subject, snippet, dan body email yang dipotong dikirim ke OpenAI untuk klasifikasi/pencarian; tidak ditulis ke log.
- OpenAI tidak diberi tool shell, email send, atau delete; mutasi vault hanya tersedia untuk intent eksplisit.
- Gmail token hanya dibaca dari environment; tidak disimpan plaintext di database.
- Memori, riwayat chat, catatan vault, dan file tetap plaintext; keamanan disk/volume host berada di luar proses aplikasi.

## Pengembangan berikutnya

Komponen yang dapat ditambahkan tanpa merombak core:

- Approval inbox Telegram yang dapat me-resume run dan memvalidasi digest invocation.
- Migrasi model orchestration ke Responses API/Agents SDK setelah parity eval tercapai.
- Worker durable dengan lease, retry, reconciliation, dan status `outcome_unknown`.
- Aksi MCP tulis reversible setelah approval, idempotency, dan safety eval tersedia.
- Calendar/reminder scheduler.
- RAG dokumen pribadi sebagai tool baru.
- Enkripsi secret dengan AES-256-GCM jika credential dipindahkan dari environment ke database.
- Conversation summarization saat history panjang.
- Model router fast/smart jika kebutuhan reasoning kompleks mulai sering muncul.
