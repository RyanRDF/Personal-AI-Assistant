# Deployment 24/7

## Rekomendasi: Railway + persistent volume

Railway adalah jalur paling ringkas untuk aplikasi ini karena repository sudah memiliki Dockerfile, endpoint health, restart policy, dashboard HTTP, dan satu direktori data persisten. Bot harus selalu menyala karena Telegram long polling dan Gmail watcher berjalan di background; jangan aktifkan mode sleep/serverless.

### Topologi produksi

```text
Internet
   │
   ├── Telegram/OpenAI/Gmail/Brave (koneksi keluar)
   │
   └── domain dashboard HTTPS
             │
             ▼
       1 Railway service
       bot + watcher + dashboard
             │
             ▼
       volume /app/data
       ├── assistant.sqlite
       └── vault/<storage-key>
```

Gunakan tepat **satu replica**. SQLite dan volume file bersifat single-writer, sedangkan dua proses long polling dengan token Telegram yang sama akan berebut update.

### Langkah deployment

1. Push repository ke GitHub, lalu buat project Railway dari repository tersebut. `railway.json` memilih Dockerfile, `/health`, restart `ALWAYS`, dan graceful draining 30 detik.
2. Tambahkan satu Railway Volume ke service dengan mount path `/app/data`. Railway mendokumentasikan `/app/data` untuk aplikasi yang menulis `./data`.
3. Karena image berjalan sebagai user non-root sedangkan Railway memasang volume sebagai root, tambahkan `RAILWAY_RUN_UID=0` sesuai dokumentasi Railway Volume.
4. Isi variable wajib dan optional yang digunakan. Jangan menyalin file `.env` ke Git.
5. Generate domain Railway untuk dashboard. Browser akan menampilkan Basic Auth; username boleh apa saja, password harus sama dengan `DASHBOARD_TOKEN`.
6. Setelah deployment aktif, buka `/health`, login ke dashboard, lalu uji `/status`, `/vault`, satu forward chat, satu upload file, dan `/get <id>`.
7. Aktifkan backup volume harian dan mingguan. Lakukan restore drill berkala; backup yang belum pernah diuji belum membuktikan proses pemulihan.

Variable inti produksi:

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_USER_ID=...
OPENAI_API_KEY=...

DATABASE_PATH=/app/data/assistant.sqlite
VAULT_STORAGE_PATH=/app/data/vault
DASHBOARD_ENABLED=true
DASHBOARD_HOST=0.0.0.0
DASHBOARD_TOKEN=secret-acak-panjang
RAILWAY_RUN_UID=0

# Railway menginjeksi PORT; jangan hardcode variable ini di dashboard Railway.
```

Untuk pencarian web, Brave lebih sederhana pada satu-service deployment. Jika tetap memakai SearXNG, deploy sebagai service kedua di private network dan arahkan `SEARXNG_BASE_URL` ke alamat internal service tersebut.

Referensi resmi:

- [Railway Config as Code](https://docs.railway.com/config-as-code/reference)
- [Railway Volumes](https://docs.railway.com/volumes)
- [Railway Volume backups](https://docs.railway.com/volumes/backups)
- [Railway healthchecks](https://docs.railway.com/deployments/healthchecks)

## Rencana backup dan pemulihan

Data yang harus dipertahankan adalah seluruh `/app/data`, bukan hanya SQLite. Metadata file berada di `assistant.sqlite`, sedangkan byte file berada di `vault/`; memulihkan salah satunya saja menghasilkan item yatim.

- Harian: snapshot volume otomatis.
- Mingguan: snapshot dengan retensi lebih panjang.
- Bulanan: salinan offsite terenkripsi bila isi vault kritis.
- Sebelum deploy perubahan besar: snapshot manual.
- Restore drill: pulihkan ke volume hasil restore, cek dashboard, buka catatan, dan download beberapa file acak.

## Alternatif: VPS + Docker Compose

Pilih VPS bila ingin kontrol penuh atau akan menjalankan SearXNG sendiri. Install Docker Engine dan Compose, clone repository, isi `.env`, pastikan `DASHBOARD_TOKEN` terisi, lalu jalankan:

```bash
docker compose --profile searxng up -d --build
docker compose ps
docker compose logs --tail=100 assistant
```

Compose memublikasikan dashboard hanya ke `127.0.0.1:3030`. Akses melalui SSH tunnel, atau pasang reverse proxy HTTPS (Caddy/Nginx) di depan port tersebut. Backup seluruh folder `data` saat proses dihentikan atau gunakan mekanisme snapshot filesystem yang konsisten.

## Alternatif: Fly.io

Fly.io juga cocok dengan Docker dan volume, tetapi volume terikat ke Machine/region. Untuk bot background, `auto_stop_machines` harus `off`; self-ping tidak cukup untuk menjaga worker tetap hidup. Gunakan satu Machine, satu volume, `kill_timeout` yang memadai, dan backup offsite.

Referensi: [Fly long-running tasks](https://fly.io/docs/blueprints/long-running-tasks/) dan [Fly volumes untuk SQLite](https://fly.io/docs/js/the-basics/volumes/).
