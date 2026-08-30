# Riset Evolusi Personal AI Assistant Menjadi Modern AI Agent Platform

**Tanggal riset:** 30 Agustus 2026  
**Konteks produk:** asisten pribadi single-owner, antarmuka Telegram, runtime TypeScript/Node.js, penyimpanan SQLite, dan sejumlah integrasi lokal.  
**Kebijakan sumber:** fakta eksternal di bawah hanya menggunakan dokumentasi resmi OpenAI dan Model Context Protocol (MCP). Rekomendasi arsitektur ditandai terpisah agar tidak tertukar dengan kemampuan resmi produk/protokol.

## Ringkasan eksekutif

Repo ini tidak perlu diubah menjadi “multi-agent swarm” untuk menjadi agent modern. Langkah paling bernilai adalah menjadikannya **satu agent runtime yang tahan restart, policy-driven, dapat menemukan tool secara dinamis, dan meminta persetujuan sebelum efek samping**. MCP menjadi salah satu sumber tool, bukan pusat seluruh arsitektur.

Fondasi keamanan yang sudah ada cukup baik: hanya owner di private chat, schema tool yang ketat, pemisahan data tidak tepercaya, pembatasan tool egress ketika vault sensitif dibaca, pembatalan request, trace lokal tanpa isi percakapan, dan pola durable outbox untuk email. Namun, orkestrasi sekarang masih berupa loop manual dengan daftar tool compile-time di `src/ai/assistant.ts`; status request aktif hanya disimpan dalam `Map` di `src/telegram/bot.ts`; belum ada registry MCP, approval yang dapat dilanjutkan setelah restart, ledger efek samping/idempotency, atau eval suite agentik.

Target yang disarankan:

1. Pertahankan **satu manager agent** sebagai pemilik percakapan dan keputusan akhir.
2. Bungkus service lokal yang ada sebagai function tools; sambungkan MCP resmi/public melalui hosted MCP bila cocok, dan MCP lokal/private melalui client MCP yang dikendalikan aplikasi.
3. Tambahkan katalog tool dan policy lokal yang menjadi otoritas, bukan mempercayai metadata MCP.
4. Simpan run, step, approval, dan eksekusi tool secara durable di SQLite sebelum menambah tool write-capable.
5. Migrasikan loop agent secara bertahap ke Responses API/Agents SDK, dengan eval dan feature flag sebagai pagar migrasi.
6. Mulai dari satu MCP resmi, read-only, selalu meminta approval. Jangan membuka marketplace arbitrer atau autonomous write pada fase awal.

## Baseline repo dan gap saat ini

### Kekuatan yang sudah layak dipertahankan

- `src/telegram/bot.ts` dan konfigurasi owner membatasi akses ke satu pemilik dan private chat.
- `src/ai/assistant.ts` memakai schema terstruktur dan membatasi loop tool maksimal enam putaran.
- Tool mutasi hanya tersedia bila intent eksplisit terdeteksi di awal permintaan.
- Attachment, email, web, memory, dan vault diperlakukan sebagai data tidak tepercaya; attachment bahkan menonaktifkan tool pada turn terkait.
- Setelah data vault sensitif dibaca, tool external-egress disingkirkan.
- `src/services/request-trace.ts` mencatat stage, tool, durasi, status, dan token tanpa menyimpan isi sensitif atau chain-of-thought.
- Pola outbox/journal email di SQLite sudah menunjukkan cara yang tepat untuk pekerjaan durable dan at-least-once.

### Gap yang perlu ditutup

| Area | Kondisi sekarang | Dampak ketika banyak MCP ditambahkan |
|---|---|---|
| Orkestrasi | Tool list dan loop manual terpusat di `src/ai/assistant.ts` | File menjadi bottleneck dan sulit diuji/policy-audit |
| Discovery | Tool compile-time; tidak ada katalog MCP | Semua server/tool harus di-hard-code dan dimuat ke prompt |
| Policy | Allowlist dan egress rule tersebar sebagai logika aplikasi | Tidak cukup untuk membedakan read/write/destructive, sensitivitas, dan approval per server/tool |
| Approval | Belum ada state approval durable | Request write tidak dapat dipause, direview, lalu dilanjutkan dengan aman |
| Durability | Request aktif berada di memory `Map` | Restart dapat kehilangan progress dan berisiko mengulang efek samping |
| Idempotency | Belum ada ledger eksekusi tool generik | Retry pihak ketiga dapat menggandakan email, event, pembayaran, atau perubahan data |
| Memory | Riwayat dan memory lokal ada, tetapi belum menjadi state run yang replayable | Sulit memulihkan tool call/approval secara konsisten |
| Observability | Trace request cukup baik tetapi belum span/run/step | Sulit menentukan tool selection, policy decision, retry, dan approval mana yang gagal |
| Evals | Belum ada dataset/grader agentik | Migrasi model/runtime atau penambahan MCP tidak memiliki regression gate |
| Credentials | Secret berasal dari environment/config | Belum ada provider kredensial per MCP, scope, expiry, dan rotasi |

## 1. Model orkestrasi

### Fakta dari sumber primer

OpenAI membedakan dua pola multi-agent: **handoff**, ketika specialist mengambil alih percakapan, dan **agents-as-tools**, ketika manager tetap memegang kontrol serta memanggil specialist sebagai tool. Pilihan ditentukan oleh siapa yang seharusnya memiliki jawaban berikutnya, bukan oleh keinginan membuat agent sebanyak mungkin ([OpenAI Agents SDK — Orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)).

Agents SDK menyediakan agent loop untuk menjalankan model, tool, handoff, guardrail, dan continuation. Dokumentasinya menawarkan beberapa strategi continuation—history aplikasi, session, Conversations API, atau `previous_response_id`—dan menyarankan memilih satu strategi per percakapan agar state tidak terduplikasi ([OpenAI Agents SDK — Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents), [OpenAI Agents SDK — Results](https://developers.openai.com/api/docs/guides/agents/results)). Responses API sendiri mendukung built-in tools, custom functions, dan MCP tools dalam satu request ([OpenAI Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)).

### Rekomendasi untuk repo

Gunakan **single manager agent**. Telegram tetap menjadi adapter I/O; manager agent tetap pemilik percakapan, policy decision, dan jawaban akhir. Gmail, vault, memory, web search, dan service lain tetap sebagai function tools lokal. MCP hanya menambah tool catalog.

Jangan mengadopsi handoff/multi-agent terlebih dahulu. Belum ada domain yang membutuhkan specialist mengambil alih percakapan, sedangkan handoff menambah state, trace, prompt, dan permukaan keamanan. Jika kelak eval menunjukkan satu agent gagal karena tool ambiguity atau domain prompt terlalu besar, gunakan agents-as-tools lebih dahulu agar manager tetap mengendalikan output dan approval.

Target interface minimum:

```text
TelegramAdapter
      |
      v
AgentRuntime ---- RunStore (SQLite)
      |  \
      |   +---- ApprovalService
      |   +---- ToolPolicy
      v
ToolCatalog
  |-- Local function tools (Gmail, vault, memory, web)
  |-- Hosted MCP tools (official public servers)
  `-- Client-managed MCP tools (local/private servers)
```

`AgentRuntime` sebaiknya menerima input yang tidak bergantung pada Telegram dan menghasilkan event terstruktur (`text_delta`, `tool_requested`, `approval_required`, `completed`, `failed`). Dengan begitu streaming Telegram, dashboard, test harness, dan kelak kanal lain memakai runtime yang sama.

## 2. MCP host, discovery, registry, dan transport

### Fakta dari sumber primer

Arsitektur MCP menempatkan aplikasi sebagai **host**. Host mengelola satu client per server, lifecycle, consent, authorization, security policy, dan agregasi context. Server dirancang fokus dan terisolasi: server tidak semestinya melihat seluruh percakapan atau server lain; host yang menegakkan batas tersebut ([MCP Architecture, specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/architecture)).

Transport standar MCP adalah `stdio` dan Streamable HTTP. `stdio` menjalankan server sebagai subprocess dengan pesan newline-delimited, sedangkan Streamable HTTP memakai HTTP POST dan dapat membalas JSON atau SSE; semantics protocol tetap sama walau cancellation dan lifecycle transport berbeda ([MCP Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)).

Spesifikasi terbaru menambahkan `server/discover` untuk negosiasi versi, capability, identity, dan cache lifetime. Identitas yang dilaporkan server adalah self-reported dan tidak boleh dijadikan bukti keamanan ([MCP Server Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)). `tools/list` dapat berubah menurut authorization, dapat dipaginasi dan dicache, sedangkan anotasi tool harus dianggap tidak tepercaya kecuali server-nya memang dipercaya ([MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

Official MCP Registry masih berstatus preview, hanya memuat metadata server publik, dan dirancang sebagai sumber untuk downstream aggregators—bukan sebagai katalog yang langsung dipercaya host. Verifikasi namespace membuktikan hubungan dengan source yang diklaim, bukan bahwa server aman ([About the MCP Registry](https://modelcontextprotocol.io/registry/about), [MCP Registry FAQ](https://modelcontextprotocol.io/registry/faq)).

OpenAI Responses API dapat memakai remote MCP sebagai hosted tool. `allowed_tools` membatasi tool yang diimpor dari suatu server; approval dapat dilakukan sebelum data dibagikan atau tool dijalankan ([OpenAI Connectors and remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)). Tool search dan deferred loading memungkinkan model menemukan namespace/tool saat dibutuhkan, sehingga semua schema tidak harus dimasukkan di awal request; dokumentasi menyarankan namespace yang kohesif dan, bila praktis, kurang dari sekitar sepuluh function per namespace ([OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)).

### Rekomendasi untuk repo

Buat katalog tiga lapis:

1. **Curated app registry di SQLite.** Hanya server yang diaktifkan owner yang boleh dipakai. Simpan ID stabil, nama, mode koneksi, URL/command reference, trust tier, status, dan timestamps—tanpa secret.
2. **Runtime discovery cache.** Saat connect, jalankan handshake/`server/discover`, lalu `tools/list`. Simpan versi, capability, schema hash, TTL, dan waktu terakhir berhasil. Normalisasi tool menjadi ID seperti `serverSlug.toolName`.
3. **External registry sebagai sumber kandidat.** Official Registry atau registry lain hanya dipakai untuk pencarian/admin suggestion. Jangan auto-install, auto-connect, atau auto-execute hasil registry.

Kebijakan lokal harus lebih berkuasa daripada anotasi server. Untuk setiap tool, catalog menghasilkan metadata lokal:

```ts
type ToolRisk = {
  effect: "read" | "write" | "external" | "destructive";
  sensitivity: "public" | "personal" | "secret";
  approval: "never" | "first_use" | "always";
  egress: boolean;
  idempotency: "native_key" | "safe_retry" | "reconcile" | "never_retry";
  timeoutMs: number;
  maxCallsPerRun: number;
};
```

Gunakan hosted MCP hanya untuk server remote resmi yang sesuai dengan batas trust platform. Gunakan client MCP di dalam aplikasi untuk server private/local atau ketika aplikasi harus mengontrol network, filtering, credentials, dan approval secara penuh. Ini konsisten dengan panduan integrasi Agents SDK yang membedakan hosted MCP dan client-managed MCP ([OpenAI Agents SDK — MCP integration and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability)).

Aktifkan tool search/deferred loading setelah jumlah schema mulai mengganggu token, latency, atau tool-selection eval. Pada fase satu MCP, `allowed_tools` eksplisit lebih mudah diaudit daripada discovery bebas.

## 3. Authentication dan secret handling

### Fakta dari sumber primer

Untuk HTTP, spesifikasi MCP mengadopsi OAuth 2.1: protected-resource metadata dan authorization-server metadata dipakai untuk discovery; scope seharusnya least-privilege; resource server harus memvalidasi issuer dan audience; access token dikirim dalam header `Authorization`, bukan URI. Token passthrough ke upstream lain dilarang. Untuk `stdio`, kredensial seharusnya diperoleh dari environment, bukan mekanisme OAuth HTTP ([MCP Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)).

Pada hosted remote MCP OpenAI, `authorization` tidak disimpan di objek Response dan perlu dikirim lagi pada setiap request. Artinya aplikasi tetap bertanggung jawab menyimpan dan memasok credential secara aman ([OpenAI Connectors and remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)).

### Rekomendasi untuk repo

Tambahkan `McpCredentialProvider` sebagai boundary terpisah. Registry menyimpan `credentialRef`, bukan token. Pada rollout pertama, dukung credential reference ke environment untuk satu server resmi read-only. Sebelum mendukung banyak akun/dynamic OAuth, sediakan secret store terenkripsi atau OS-backed store; jangan menyimpan raw refresh/access token dalam tabel `mcp_servers`, tool arguments, trace, approval payload, atau message history.

Untuk remote HTTP:

- pakai Authorization Code + PKCE bila ada interaksi owner;
- validasi metadata issuer dan exact redirect URI;
- ikat token ke resource/audience server yang benar;
- minta scope minimum dan lakukan step-up saat tool tertentu benar-benar membutuhkan scope tambahan;
- redaksi token dari exception, request log, dan telemetry;
- jangan meneruskan token MCP ke API lain atau membiarkan model melihatnya.

Untuk local `stdio`:

- allowlist exact executable/package/version dan argument template;
- inject hanya environment variables yang dibutuhkan subprocess;
- batasi filesystem dan network bila memungkinkan;
- jangan menerima arbitrary command dari chat, model, atau registry metadata.

Jangan membangun OAuth authorization server sendiri. Repo ini adalah single-owner client; gunakan authorization server milik penyedia MCP dan fokus pada penyimpanan token, lifecycle, scope, serta revoke/disconnect.

## 4. Least privilege, policy, approval, dan human-in-the-loop

### Fakta dari sumber primer

OpenAI remote MCP meminta approval secara default sebelum data dibagikan kepada server atau tool dijalankan; approval request dapat dikembalikan ke aplikasi dan Response kemudian dilanjutkan ([OpenAI Connectors and remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)). Agents SDK mendukung tool-level approval, interruption, serialisasi run state, dan resume setelah keputusan manusia. Guardrail tool dapat memeriksa input/output, sedangkan validasi yang melindungi efek samping sebaiknya ditempatkan sedekat mungkin dengan tool tersebut ([OpenAI Agents SDK — Guardrails and approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)).

Spesifikasi MCP sendiri mengharuskan host memberi manusia kemampuan untuk melihat tool, mengetahui ketika tool dipanggil, dan menolak invocation. Tool list juga dapat berbeda sesuai authorization user ([MCP Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).

### Rekomendasi untuk repo

Auto-run hanya untuk tool read-only yang sudah di-allowlist, berisiko rendah, tidak membawa data sensitif ke pihak lain, dan lolos policy. Minta approval eksplisit untuk:

- write atau delete;
- external communication seperti mengirim email/pesan;
- transaksi finansial;
- perubahan akun, credential, security, atau permission;
- akses data sensitif/bulk;
- pengiriman output satu server ke server lain;
- tool/server baru atau belum dipercaya;
- argumen yang berubah setelah approval sebelumnya.

Approval Telegram memakai inline buttons dan disimpan di SQLite. Tampilan approval minimal berisi: nama server/tool, ringkasan efek, tujuan/destination, argumen penting yang sudah diredaksi, data sensitif yang akan keluar, waktu kedaluwarsa, dan tombol Approve/Deny. Token callback harus random, sekali pakai, dan terikat pada `ownerId + chatId + runId + toolName + canonicalArgsHash + expiry`.

Persist serialized run state ketika status menjadi `waiting_approval`; setelah owner menyetujui, lanjutkan state yang sama. Jangan memanggil model dari awal untuk “mengingat” keputusan karena tool args dapat berubah. Guardrail dan approval tetap diperiksa di executor tepat sebelum side effect, tidak hanya ketika model memilih tool.

## 5. Prompt injection dan data exfiltration

### Fakta dari sumber primer

OpenAI memperingatkan bahwa remote MCP tidak diverifikasi oleh OpenAI dan dapat menerima data sensitif atau melakukan tindakan berbahaya. Panduannya menyarankan `allowed_tools`, approval, server resmi yang dipercaya, serta review/log atas data yang dikirim; URL atau instruksi yang muncul dari output MCP juga tidak boleh dipercaya secara otomatis ([OpenAI Connectors and remote MCP — Safety](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)).

Panduan keamanan MCP membahas token theft/passthrough, confused-deputy, SSRF, DNS rebinding, dan risiko local server yang berjalan dengan privilege client. Mitigasi resminya mencakup HTTPS, validasi redirect, pemblokiran alamat private/reserved untuk fetch yang tidak diizinkan, pembatasan egress, sandbox local server, explicit command consent, dan penggunaan `stdio` untuk local server ([MCP Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)).

### Rekomendasi untuk repo

Pertahankan dan generalisasi mekanisme trust yang sudah ada:

- Semua hasil MCP diberi label origin/trust, sama seperti email, attachment, web, memory, dan vault sekarang.
- Isi dari user atau tool adalah **data**, bukan otoritas untuk mengubah system prompt, policy, allowlist, approval, credentials, atau destination.
- Tambahkan policy aliran data: hasil sensitif dari tool A tidak boleh dikirim ke tool/server B yang memiliki egress kecuali owner meminta tujuan tersebut secara eksplisit dan menyetujui payload.
- Hanya host yang menentukan tool availability. Server description, tool annotation, atau tool output tidak boleh mengaktifkan tool tambahan.
- Terapkan batas ukuran input/output, timeout, rate limit, jumlah call, dan truncation yang dapat diaudit.
- Jangan auto-open/fetch URL hasil MCP. Validasi scheme (`https`), domain, redirects, resolved IP, dan blok private/reserved network kecuali server tersebut memang dikonfigurasi sebagai local/private.
- Hindari shell/browser/computer-use tool pada default profile. Jika kelak diperlukan, tempatkan dalam sandbox terpisah dan selalu approval.

Current rule “sensitive vault read removes external-egress tools” adalah kontrol yang baik. Ubah dari konstanta khusus menjadi rule engine berbasis label sehingga kontrol yang sama berlaku pada Gmail, memory, attachment, dan MCP.

## 6. Durable runs, retry, dan idempotency

### Fakta dari sumber primer

OpenAI background mode menjalankan Response secara asynchronous dan memungkinkan polling, tetapi membutuhkan penyimpanan sementara data response untuk polling; dokumentasinya menyebut implikasi sekitar sepuluh menit untuk Zero Data Retention. Fitur tersebut menyelesaikan lifecycle request model yang lama, bukan atomicity side effect pada API pihak ketiga ([OpenAI Background mode](https://developers.openai.com/api/docs/guides/background)).

Agents SDK dapat mempause run untuk approval dan menyimpan state agar dilanjutkan kemudian ([OpenAI Agents SDK — Guardrails and approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)). Ekstensi MCP Tasks juga menyediakan handle durable untuk pekerjaan asynchronous, polling, status, input tambahan, dan cancellation, tetapi ini adalah ekstensi untuk server yang mendukungnya, bukan jaminan semua tool MCP ([MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)).

### Rekomendasi untuk repo

SQLite tetap cukup. Tambahkan state machine aplikasi:

```text
queued -> running -> waiting_approval -> running -> completed
                    |                  |
                    v                  v
                 cancelled       failed / cancelled
```

Simpan sebelum dan sesudah setiap tool call. Tabel minimum:

- `agent_runs`: owner/chat/request, status, agent/model version, continuation strategy, timestamps, cancellation, final error.
- `agent_steps`: ordered step, kind, provider IDs, sanitized metadata, status, timing, token usage.
- `pending_approvals`: run/step, tool, args hash, redacted preview, expiry, decision, decision time.
- `tool_executions`: tool/server, effect, idempotency key, status (`prepared`, `started`, `succeeded`, `failed`, `unknown`), attempts, external receipt/reference.
- `mcp_servers` dan `mcp_tools`: registry, capability/schema cache, trust/policy metadata.

Untuk side effect, hitung key stabil misalnya:

```text
sha256(ownerId | runId | toolId | canonicalArgs | intentVersion)
```

Gunakan unique constraint pada key. Retry otomatis hanya jika API menerima native idempotency key atau metadata lokal menyatakan operasi aman diulang. Bila proses mati sesudah call dikirim tetapi sebelum receipt disimpan, tandai `unknown`; lakukan reconciliation melalui status API atau minta keputusan owner. Jangan blindly rerun. Sistem tidak boleh mengklaim exactly-once lintas pihak ketiga—target realistisnya at-least-once dengan deduplication dan reconciliation.

Gunakan pola email outbox yang sudah ada sebagai template, bukan memperkenalkan Kafka/Redis/distributed workflow engine. Background mode OpenAI boleh dipakai untuk reasoning panjang, tetapi `agent_runs` tetap source of truth aplikasi.

## 7. Memory, conversation state, dan privacy

### Fakta dari sumber primer

Responses API dapat mengelola multi-turn melalui `previous_response_id` atau Conversation object, atau aplikasi mengirim history secara manual. Response objects disimpan 30 hari secara default dan `store: false` dapat menonaktifkan penyimpanan tersebut; item dalam Conversation object tidak mengikuti TTL 30 hari yang sama. Token input sebelumnya tetap diperhitungkan ketika response chain dilanjutkan ([OpenAI Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)).

Agents SDK juga mendukung app-managed history dan session storage; dokumentasinya memperingatkan untuk memilih satu strategi continuation per conversation ([OpenAI Agents SDK — Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)).

### Rekomendasi untuk repo

Pertahankan SQLite sebagai state percakapan utama dan gunakan session app-controlled saat migrasi Agents SDK. Ini selaras dengan kebutuhan single-owner, retention lokal, restart recovery, dan audit approval. Jangan mencampur replay history lokal dengan `previous_response_id` untuk percakapan yang sama tanpa desain eksplisit karena turn dapat terduplikasi atau menjadi sulit direproduksi.

Pisahkan tiga jenis data:

1. **Run state replayable:** model/tool/approval items yang diperlukan untuk melanjutkan run.
2. **Conversation history:** pesan untuk konteks percakapan dengan retention policy.
3. **Long-term user memory:** fakta/preference terkurasi dengan provenance, confidence, dan kemampuan update/delete.

Tambahkan compaction/summarization saat context mencapai threshold, bukan berdasarkan jumlah pesan saja; simpan pointer ke source messages agar ringkasan dapat diaudit. Namun jangan mengganti lexical memory dengan vector database sebelum eval membuktikan retrieval sekarang tidak cukup. Tentukan `store` OpenAI secara eksplisit sesuai keputusan privacy; rekomendasi awal adalah local session + `store: false` bila semua kebutuhan continuation dan tracing tetap terpenuhi.

## 8. Observability, tracing, dan evals

### Fakta dari sumber primer

Agents SDK tracing menghasilkan trace dan span untuk model calls, tools, handoffs, guardrails, dan custom operations. Dokumentasi menyarankan trace digunakan untuk debugging lalu contoh kegagalan dimasukkan ke evaluasi ([OpenAI Agents SDK — Observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability)). Agent evals dan trace grading dapat menilai end-to-end behavior seperti pemilihan tool, handoff, dan policy; datasets dan eval runs memberi regression testing yang repeatable ([OpenAI Agent evals](https://developers.openai.com/api/docs/guides/agent-evals)). OpenAI juga menyediakan request ID dan menerima client request ID untuk korelasi operasional ([OpenAI API authentication and request IDs](https://platform.openai.com/docs/api-reference/authentication)).

### Rekomendasi untuk repo

Perluas `request_traces` tanpa menyimpan secret atau full payload. Catat:

- `run_id`, `step_id`, `parent_step_id`, agent/model/prompt version;
- server/tool ID dan schema version;
- policy decision dan rule ID;
- approval requested/approved/denied/expired serta latency;
- retry count, idempotency-key hash, external receipt;
- input/output byte count, bukan isi mentah;
- OpenAI request ID/client request ID;
- latency, token/cost estimate, cancellation, error class.

Hosted tracing boleh diadopsi setelah privacy/redaction ditinjau, tetapi trace SQLite tetap berguna sebagai audit source yang berada di bawah kontrol aplikasi.

Buat eval set kecil sebelum migrasi runtime. Kasus minimum:

- memilih tool yang benar dan menolak tool yang tidak relevan;
- owner authorization dan private-chat boundary;
- prompt injection dari attachment, email, web, memory, dan MCP output;
- larangan cross-server exfiltration data sensitif;
- approval wajib untuk write/destructive/external action;
- args tidak berubah setelah approval;
- cancellation, timeout, retry, restart saat `started`, dan reconciliation;
- MCP server down, schema berubah, tool hilang, token expired, dan partial response;
- jawaban tanpa tool tetap benar.

Regression gate awal: **forbidden tool invocation = 0, approval bypass = 0, duplicate side effect = 0**. Setelah itu ukur task success, tool-selection accuracy, latency p50/p95, token/cost, approval rate, MCP error rate, dan recovery success. Gunakan trace grader hanya setelah event dan policy metadata sudah cukup untuk dinilai.

## 9. Target module boundaries untuk repo ini

Rekomendasi struktur—bukan keharusan memindahkan semuanya sekaligus:

```text
src/
  agent/
    runtime.ts              # run loop/Agents SDK adapter
    events.ts               # event protocol untuk Telegram/test/dashboard
    policy.ts               # effect, sensitivity, egress, approval
    tool-catalog.ts         # katalog lokal + MCP, filtering/deferred loading
    run-store.ts            # durable state machine
  mcp/
    registry.ts             # curated server config dan discovery cache
    connection-manager.ts   # hosted/client-managed lifecycle
    credential-provider.ts  # token resolution tanpa expose ke model
    schema-normalizer.ts    # namespacing, validation, limits
  services/
    approval.ts             # issue/decide/expire/resume
    request-trace.ts        # richer spans; tetap sanitized
  telegram/
    bot.ts                  # adapter, streaming, cancel, approval callbacks
```

`src/ai/assistant.ts` secara bertahap mengecil menjadi konfigurasi agent/prompt dan compatibility facade. Service Gmail, vault, memory, serta search tetap menjadi modul domain; jangan pindahkan business rules ke prompt atau ke server MCP hanya demi “semua harus MCP”.

Boundary penting:

- **ToolCatalog** menjawab “tool apa yang tersedia?”
- **ToolPolicy** menjawab “apakah tool ini boleh dipanggil dengan data dan konteks ini?”
- **ApprovalService** menjawab “apakah owner menyetujui invocation spesifik ini?”
- **ToolExecutor** mengeksekusi dan mencatat ledger/idempotency.
- **AgentRuntime** mengorkestrasi, tetapi tidak boleh melewati empat boundary tersebut.

## 10. Strategi rollout yang aman

### Fase 0 — Baseline dan keputusan

- Bekukan behavior penting saat ini sebagai integration tests/eval cases.
- Tetapkan data classification, tool effect taxonomy, approval matrix, dan threat model.
- Pilih satu strategi conversation state dan privacy setting.

### Fase 1 — Durability dan policy tanpa MCP

- Tambahkan `agent_runs`, `agent_steps`, `pending_approvals`, dan `tool_executions`.
- Bungkus tool lokal lama dengan ToolCatalog/ToolPolicy.
- Pertahankan loop/model lama agar perubahan dapat diisolasi.

### Fase 2 — Responses API/Agents SDK

- Migrasikan run loop di balik feature flag.
- Pertahankan streaming Telegram, cancellation, memory, egress guard, dan output behavior.
- Bandingkan old/new runtime dengan eval dan shadow traces.

### Fase 3 — Satu MCP resmi, read-only

- Pilih satu server resmi yang manfaatnya jelas.
- Gunakan explicit `allowed_tools`; approval `always` pada awal rollout.
- Batasi scope, timeout, result size, dan egress. Tambahkan kill switch per server/tool.
- Setelah eval dan penggunaan nyata aman, hanya low-risk reads yang dapat dipertimbangkan untuk auto-run.

### Fase 4 — Satu tool write-capable

- Aktifkan hanya setelah approval durable, args hash, idempotency ledger, dan restart recovery lulus test.
- Canary tetap pada owner tunggal dan satu jenis side effect.

### Fase 5 — Multi-MCP dan tool search

- Tambahkan cache discovery dan deferred tool loading.
- Ukur tool ambiguity, token, latency, dan error sebelum menambah server berikutnya.
- External registry tetap menjadi kandidat import yang direview manusia.

### Fase 6 — Optimisasi lanjutan hanya berbasis bukti

- Tambahkan background model requests bila workload nyata sering melewati timeout.
- Tambahkan specialist agent hanya bila eval membuktikan manager tunggal menjadi bottleneck.
- Tambahkan MCP Tasks hanya untuk server yang memang menyediakan long-running operations.

Setiap fase perlu feature flag, rollback ke current tools, audit event, dan kill switch tanpa deploy ulang bila memungkinkan.

## 11. Yang belum perlu dibangun

- **Jangan** membuat multi-agent mesh atau autonomous handoff sekarang.
- **Jangan** auto-install/auto-connect server dari public registry atau metadata hasil model.
- **Jangan** membuat MCP protocol, gateway, public registry, atau OAuth authorization server sendiri.
- **Jangan** mengaktifkan shell, arbitrary local command, browser/computer-use, pembayaran, atau destructive tools pada default profile.
- **Jangan** mengizinkan write tanpa invocation-specific approval, policy recheck, dan ledger idempotency.
- **Jangan** menyimpan raw token/secret di SQLite biasa, trace, prompt, tool args, atau approval callback.
- **Jangan** memperkenalkan microservices, distributed queue, Kafka, atau workflow engine untuk satu owner/satu proses; SQLite transaction dan worker lokal cukup sampai ada bukti sebaliknya.
- **Jangan** mengklaim exactly-once untuk side effect lintas API; gunakan dedupe dan reconciliation.
- **Jangan** mengganti memory dengan vector DB/RAG sebelum eval retrieval menunjukkan kebutuhan.
- **Jangan** memasukkan seluruh tool schema ke setiap turn ketika catalog membesar; gunakan curated allowlist dan deferred discovery.
- **Jangan** menjadikan MCP tool annotations atau `serverInfo` sebagai sumber trust.
- **Jangan** menambah MCP Apps/UI dan Tasks extension pada MVP kecuali ada use case konkret.

## 12. Implikasi konkret untuk TypeScript/Telegram/SQLite single-owner

Keputusan pragmatis yang paling sesuai dengan repo ini:

1. **Tetap monolith modular.** Satu proses Node.js dengan composition root di `src/index.ts` masih tepat. Pisahkan boundary secara kode, bukan deploy unit.
2. **SQLite adalah keunggulan, bukan hambatan.** Gunakan transaksi, unique constraints, dan outbox pattern yang sudah terbukti untuk run, approval, serta side effect ledger.
3. **Telegram adalah human-control plane.** Owner-only private chat, inline approval, `/cancel`, dan status run memberi human-in-the-loop tanpa membuat dashboard admin baru.
4. **Migrasi di balik facade.** Pertahankan public behavior `PersonalAssistant` sambil memperkenalkan `AgentRuntime`; ini mengurangi perubahan simultan pada bot dan test.
5. **MCP adalah adapter tambahan.** Service lokal yang matang tidak perlu dipindahkan menjadi MCP. Gunakan MCP ketika interoperability atau integrasi eksternal memang bernilai.
6. **Security policy tetap lokal.** Server/tool metadata membantu discovery, tetapi keputusan izin berasal dari code/config yang versioned dan database owner-controlled.
7. **Mulai sempit.** Satu server resmi read-only, explicit allowlist, always-approve, satu owner, tanpa dynamic marketplace adalah vertical slice terbaik.
8. **Naikkan kemampuan berdasarkan eval.** Tool search, specialist agent, vector retrieval, background run, dan MCP Tasks hanya ditambahkan ketika metric menunjukkan masalah yang spesifik.

Urutan pekerjaan bernilai tertinggi adalah: **durable run + policy metadata → approval resume → Agents SDK/Responses adapter → satu MCP read-only → idempotent write tool → multi-MCP discovery/tool search**. Urutan ini menjaga fitur yang sudah bekerja sambil menutup risiko terbesar sebelum memperluas kemampuan agent.

## Daftar sumber primer

### OpenAI

- [Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)
- [Connectors and remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- [Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)
- [Background mode](https://developers.openai.com/api/docs/guides/background)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [Agents SDK — Orchestration](https://developers.openai.com/api/docs/guides/agents/orchestration)
- [Agents SDK — Running agents](https://developers.openai.com/api/docs/guides/agents/running-agents)
- [Agents SDK — Results](https://developers.openai.com/api/docs/guides/agents/results)
- [Agents SDK — Guardrails and approvals](https://developers.openai.com/api/docs/guides/agents/guardrails-approvals)
- [Agents SDK — MCP integration and observability](https://developers.openai.com/api/docs/guides/agents/integrations-observability)
- [Agent evals](https://developers.openai.com/api/docs/guides/agent-evals)
- [API authentication and request IDs](https://platform.openai.com/docs/api-reference/authentication)

### Model Context Protocol

- [Architecture, specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/architecture)
- [Transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
- [About the MCP Registry](https://modelcontextprotocol.io/registry/about)
- [MCP Registry FAQ](https://modelcontextprotocol.io/registry/faq)
