# PRD — Personal Agent Platform

Status: in progress

## Ringkasan

Ubah Personal AI Assistant dari chatbot dengan daftar tool statis menjadi Personal Agent yang dapat
menyelesaikan pekerjaan lintas aplikasi melalui Capability lokal dan MCP Connection, sambil tetap
mempertahankan kontrol Owner, privasi data, dan operasi satu proses yang sederhana.

Riset pendukung dan sumber primer dicatat di [research.md](./research.md).

## Baseline Saat Ini

Project sudah memiliki fondasi yang layak dipertahankan:

- Telegram private-chat dan owner-only sebagai authorization utama.
- Tiga belas function tool dengan JSON schema ketat dan validasi Zod.
- Policy awal berbasis intent, pemisahan payload tidak tepercaya, dan pemblokiran external egress
  setelah membaca note Vault sensitif.
- Maksimum enam tool loop, timeout, cancellation, usage tracking, dan request trace.
- SQLite, Vault durable, Gmail outbox, serta recovery lokal/S3.

Keterbatasan utamanya:

- Orkestrasi masih berupa loop Chat Completions di dalam `PersonalAssistant`.
- Tool didaftarkan statis; belum ada registry Capability atau discovery MCP.
- Request aktif hanya hidup di memory dan tidak dapat pause/resume setelah restart.
- Belum ada Approval durable yang terikat ke nama tool dan argumen tertentu.
- Trace mencatat nama tool, tetapi belum menjadi event log Agent Run yang dapat dievaluasi.

## Problem Statement

Owner ingin meminta pekerjaan lintas sistem—misalnya merangkum email lalu membuat agenda,
mengumpulkan dokumen lalu membuat laporan, atau membaca issue lalu membuat task—tanpa harus
mengetahui tool dan integrasi yang diperlukan. Menambah MCP langsung ke daftar tool saat ini akan
meningkatkan risiko prompt injection, kebocoran data, aksi yang tidak diinginkan, latency, dan biaya.

Project membutuhkan runtime dan Policy yang dapat mengontrol Capability sebelum memperluas jumlah
integrasi.

## Product Outcome

Owner dapat memberikan satu tujuan melalui Telegram atau Dashboard, memantau Agent Run, menyetujui
aksi sensitif dengan konteks yang jelas, membatalkan pekerjaan, dan menerima Artifact atau ringkasan
akhir yang dapat diaudit.

## Target Use Cases

1. **Research lintas sumber**: cari Gmail, Drive, web, dan Vault; hasilkan ringkasan bersumber dan
   simpan sebagai Artifact.
2. **Planning personal**: baca kalender dan email, usulkan jadwal, lalu buat event setelah Approval.
3. **Developer workflow**: baca repository/issue, susun diagnosis atau rencana, lalu buat issue atau
   komentar setelah Approval.
4. **Task capture**: ubah pesan, email, atau hasil meeting menjadi task pada aplikasi pilihan setelah
   Owner memeriksa target, judul, dan due date.
5. **Long-running work**: jalankan pekerjaan yang melebihi satu request Telegram, tampilkan progress,
   lalu lanjutkan setelah restart atau Approval.

MCP Connection awal dipilih berdasarkan use case nyata dan server resmi/tepercaya. Kandidat pilot:
Google Calendar, Google Drive, dan GitHub; daftar ini bukan komitmen untuk mengaktifkan semuanya.

## Goals

- Satu interface Agent Run untuk Telegram, Dashboard, dan test.
- Capability lokal dan MCP ditemukan melalui registry yang sama tanpa membocorkan detail transport.
- Policy mengevaluasi visibility, data egress, dan kebutuhan Approval sebelum eksekusi.
- Agent Run serta Approval dapat dipulihkan setelah proses restart.
- Setiap pemanggilan tool memiliki trace, outcome, latency, dan correlation ID.
- Perubahan model, prompt, Policy, dan Capability diuji pada eval set sebelum rollout.

## Non-goals v1

- Menjadi platform multi-user atau SaaS.
- Mengaktifkan server MCP arbitrer hanya dari URL yang dikirim melalui chat.
- Memberikan shell, browser-computer control, pembayaran, atau penghapusan massal tanpa use case dan
  threat model terpisah.
- Menjalankan write tool sensitif secara autonomous tanpa Approval.
- Memulai dengan multi-agent; specialist baru ditambahkan jika eval menunjukkan satu Agent tidak
  cukup dan pekerjaan memang dapat dibagi dengan jelas.
- Mengganti SQLite atau menambah message broker sebelum single-process worker terbukti tidak cukup.

## Functional Requirements

| ID | Requirement |
|---|---|
| FR-01 | Owner dapat membuat Agent Run dari teks, gambar, attachment, atau command yang didukung. |
| FR-02 | Runtime memilih Capability dari registry berdasarkan Policy dan konteks Agent Run. |
| FR-03 | MCP Connection dapat di-enable/disable dan memiliki allowlist tool eksplisit. |
| FR-04 | Capability discovery di-cache, memiliki expiry, dan kegagalannya tidak merusak Capability lain. |
| FR-05 | Setiap Capability memiliki risk class: `read`, `write-reversible`, `write-sensitive`, atau `forbidden`. |
| FR-06 | `write-reversible` dan `write-sensitive` menghasilkan Approval kecuali Policy menolaknya; MCP pilot baru selalu meminta Approval termasuk untuk read. |
| FR-07 | Approval menampilkan connection, tool, argumen teredaksi, data yang akan dikirim, dan dampak aksi. |
| FR-08 | Approval hanya berlaku untuk satu invocation digest dan kedaluwarsa setelah batas waktu. |
| FR-09 | Owner dapat approve, reject, cancel, melihat status, dan melanjutkan Agent Run. |
| FR-10 | Runtime menyimpan state yang cukup untuk resume tanpa mengulang side effect yang sudah berhasil. |
| FR-11 | Tool write memakai idempotency key bila provider mendukung; jika tidak, runtime menyimpan receipt dan tidak retry otomatis setelah outcome ambigu. |
| FR-12 | Output MCP diperlakukan sebagai data tidak tepercaya dan tidak dapat memperluas izin Agent Run. |
| FR-13 | Sensitive data tidak boleh dikirim ke Capability eksternal tanpa Policy atau Approval eksplisit. |
| FR-14 | Dashboard menampilkan MCP Connection health, pending Approval, Agent Run, dan trace tool. |
| FR-15 | Runtime menghasilkan Artifact atau jawaban akhir yang menyebutkan aksi berhasil, gagal, atau belum pasti. |

## Non-functional Requirements

### Security

- Credential tidak masuk prompt, trace, log, database plaintext, atau hasil tool.
- MCP server harus berasal dari konfigurasi operator; URL dari chat tidak pernah menjadi connection.
- Default-deny untuk tool baru dan write tool.
- Batasi ukuran input/output, redirect, URL, timeout, concurrency, dan jumlah tool call per Agent Run.
- Approval diverifikasi ulang terhadap Policy aktif sebelum eksekusi.

### Reliability

- Agent Run mempunyai state machine durable dan event append-only.
- Restart tidak mengulang invocation yang sudah memiliki receipt sukses.
- Failure satu MCP Connection tidak menghentikan registry atau Agent Run lain.
- Cancellation bersifat cooperative dan status akhirnya tersimpan.

### Performance dan Cost

- Tool catalog yang dikirim ke model hanya subset yang relevan.
- Discovery metadata digunakan ulang selama masih valid.
- Context panjang dipadatkan berdasarkan state penting, bukan memotong history secara buta.
- Budget per Agent Run mencakup waktu, token, tool call, dan external calls.

## Success Metrics

Target berikut divalidasi setelah baseline eval dibuat:

- ≥ 80% task success pada eval set v1 tanpa bantuan manual di luar Approval yang memang diwajibkan.
- 100% write-sensitive invocation memiliki Approval valid dan audit event.
- 0 credential atau secret muncul pada trace/log/eval fixture.
- ≥ 99% Agent Run yang menunggu Approval dapat dilanjutkan setelah restart pada integration test.
- ≥ 95% tool failure menghasilkan status akhir yang benar: failed, retryable, atau outcome-unknown.
- P95 waktu hingga acknowledgement Telegram < 2 detik; pekerjaan panjang lanjut di background.

## v1 Acceptance Criteria

- Satu Capability lokal dan minimal dua MCP Connection tepercaya dapat digunakan melalui registry.
- Setelah pilot dan safety eval lulus, satu workflow read-only berisiko rendah lintas dua sumber
  dapat selesai tanpa Approval berdasarkan allowlist dan Policy lokal.
- Satu workflow write berhenti pada Approval dan hanya berjalan setelah invocation yang sama disetujui.
- Restart pada state `running` dan `waiting_approval` tidak menyebabkan side effect duplikat.
- Dashboard dan Telegram dapat menampilkan status dan membatalkan Agent Run.
- Eval suite mencakup happy path, prompt injection, data exfiltration, tool failure, approval tampering,
  cancellation, timeout, dan crash recovery.

## Product Risks

- Tool description dari MCP dapat menyesatkan model atau meminta data berlebihan.
- OAuth scope terlalu luas dapat mengubah satu kesalahan menjadi insiden lintas aplikasi.
- Retry setelah timeout dapat menduplikasi aksi pada provider tanpa idempotency.
- Banyak tool sekaligus menurunkan selection accuracy dan menaikkan token/latency.
- Agent yang tampak “lebih pintar” tetapi tidak terukur dapat menurunkan kepercayaan Owner.

Mitigasi detail berada di [system-design.md](./system-design.md).
