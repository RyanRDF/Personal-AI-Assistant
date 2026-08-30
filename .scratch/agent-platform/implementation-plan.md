# Implementation Plan — Personal Agent Platform

Status: in progress  
Related: [PRD](./spec.md), [System Design](./system-design.md),
[ADR-0001](../../docs/adr/0001-use-a-policy-first-durable-agent-runtime.md)

## Implementation status — 30 August 2026

Fondasi pertama sudah diimplementasikan dengan strangler migration:

- selesai: kontrak Capability, registry, policy, executor, adapter tool lokal, dan compatibility facade
  `AgentRuntime`;
- selesai: tabel/run state machine SQLite, append-only event, cancel propagation, dan recovery startup
  untuk run aktif yang terputus;
- selesai: konfigurasi MCP tervalidasi, Streamable HTTP adapter, discovery allowlist, schema/health cache,
  output untrusted, dan isolasi kegagalan connection;
- aktif secara aman: hanya MCP read-only yang secara eksplisit memakai `approval: never`;
- belum selesai: corpus eval penuh, model adapter Responses/Agents SDK, approval/resume persisten,
  invocation ledger yang aktif, durable worker/reconciliation, serta MCP write.

Dengan demikian fondasi Phase 1 sudah menjadi vertical slice yang berfungsi, tetapi gate eval dan
recovery side effect-nya belum dianggap selesai. Sebagian fondasi Phase 3 juga tersedia tanpa
menganggap gate approval dan eval fase tersebut telah tercapai.

## Delivery strategy

Perubahan dilakukan sebagai strangler migration: tool dan flow yang sudah stabil tetap berfungsi,
sementara seam baru dipasang di sekelilingnya. Setiap fase memiliki feature flag, migration yang bisa
diulang, dan gate evaluasi sebelum fase berikutnya aktif untuk Owner.

## Phase 0 — Baseline and safety inventory

Tujuan: mengetahui perilaku yang wajib dipertahankan sebelum mengganti orchestration.

- Susun 25–40 skenario representatif: percakapan biasa, Vault, Gmail draft/send, attachment, cancel,
  timeout, dan prompt injection.
- Catat seluruh tool saat ini, data yang dibaca/dikirim, side effect, idempotency, timeout, dan
  `Risk Class` awal.
- Bekukan golden tests untuk owner-only access, Vault egress lock, attachment isolation, dan batas
  iterasi/tool.
- Simpan baseline task success, tool-selection accuracy, latency, token usage, dan approval rate.

Gate:

- Semua tool memiliki owner, schema, risk class, dan data-egress classification.
- Skenario keselamatan kritis lulus pada implementation saat ini.

Rollback: tidak ada perubahan runtime.

## Phase 1 — Introduce the control plane without behavior change

Tujuan: membangun deep modules yang akan menahan kompleksitas MCP dan durability.

- Ekstrak `PolicyEngine` dari pemeriksaan intent/regex yang tersebar; pertahankan output lama melalui
  characterization tests.
- Buat `CapabilityRegistry`, `CapabilityExecutor`, dan adapter `LocalCapability` untuk tool yang sudah
  ada.
- Tambahkan `RunStore` berbasis SQLite beserta migration untuk `agent_runs`, `agent_run_events`,
  `tool_invocations`, dan `agent_approvals`.
- Buat `AgentRuntime` yang masih dapat memakai model adapter lama, tetapi seluruh Invocation sudah
  diregistrasi, dipolicy-kan, dan dicatat.
- Tambahkan correlation ID dari update Telegram hingga event, Invocation, dan Artifact.

Gate:

- Tidak ada perubahan respons yang disengaja pada corpus Phase 0.
- Restart di titik aman tidak menduplikasi side effect.
- Setiap Invocation menghasilkan event terminal atau status `outcome_unknown`.

Rollback: feature flag mengembalikan request ke orchestration lama; tabel baru bersifat additive.

## Phase 2 — Move model orchestration to Responses/Agents SDK

Tujuan: memakai primitive agent modern tanpa menyerahkan policy dan lifecycle project.

- Implementasikan `ModelRuntime` berbasis Responses API; gunakan Agents SDK hanya bila tracing,
  session, dan handoff primitives-nya mengurangi kode project secara nyata.
- Petakan conversation/run continuity tanpa mengandalkan state provider sebagai satu-satunya salinan.
- Terapkan batas tool, timeout, cancel, parallelism, dan token budget dari policy lokal.
- Jalankan shadow evaluation pada request read-only. Proposal tool dibandingkan, tetapi side effect
  hanya dieksekusi oleh runtime aktif.
- Cut over per jenis task lewat feature flag setelah parity tercapai.

Gate:

- Tidak ada regresi kritis pada safety suite.
- Task success tidak turun lebih dari 5% dari baseline dan p95 latency masih dalam budget PRD.
- Cancel serta recovery lulus pada test yang menghentikan proses secara paksa.

Rollback: arahkan feature flag ke model adapter lama dengan RunStore dan PolicyEngine tetap aktif.

## Phase 3 — Add one read-only MCP pilot

Tujuan: membuktikan lifecycle MCP dengan blast radius kecil.

- Pilih satu server resmi/tepercaya untuk kebutuhan nyata Owner; kandidat awal: Google Drive read-only
  atau GitHub read-only.
- Wajibkan Approval untuk semua Invocation MCP selama pilot, termasuk read. Relaksasi hanya dilakukan
  per Capability setelah safety eval dan review data-egress lulus.
- Tambahkan konfigurasi `MCP Connection`, secret reference, health check, discovery, schema cache,
  allowlist, dan circuit breaker.
- Normalisasi tool MCP menjadi Capability internal; jangan menjadikan annotation MCP sebagai keputusan
  otorisasi.
- Gunakan `allowed_tools` atau mekanisme ekuivalen agar catalog yang terlihat tetap kecil.
- Buat fake MCP server untuk contract, timeout, malformed schema, disconnect, dan prompt-injection tests.

Gate:

- Hanya capability allowlisted yang dapat muncul di model context.
- Tidak ada Invocation MCP pilot yang berjalan tanpa Approval valid.
- Data dari MCP tetap berlabel untrusted dan tidak dapat mengubah Policy.
- Connection dapat dinonaktifkan tanpa memutus flow lokal.

Rollback: disable satu MCP Connection; tidak perlu rollback runtime.

## Phase 4 — Approval-backed external writes

Tujuan: membuka side effect eksternal dengan kontrol Owner yang spesifik.

- Buat approval inbox di Telegram lebih dahulu; dashboard dapat menyusul menggunakan service yang
  sama.
- Tampilkan tujuan, capability, server, argumen penting, data yang keluar, dan masa berlaku.
- Ikat Approval ke digest canonical dari run, capability, target, dan argumen. Perubahan apa pun
  membuat Approval lama tidak berlaku.
- Mulai dari satu tindakan reversible, misalnya membuat draft atau issue, bukan delete/send otomatis.
- Terapkan idempotency key, reconciliation, retry policy, dan status `outcome_unknown`.

Gate:

- Invocation tidak dapat dieksekusi ulang dengan Approval yang expired, ditolak, atau digest berbeda.
- Crash sebelum/sesudah side effect tidak menghasilkan duplikasi pada integration test.
- Audit dapat menjawab siapa menyetujui apa, data apa yang keluar, kapan, dan hasilnya.

Rollback: ubah Risk Class capability menjadi deny/read-only dan nonaktifkan write scope.

## Phase 5 — Durable long-running work

Tujuan: Agent Run dapat menunggu, dilanjutkan, dan dipulihkan dengan aman.

- Pisahkan claim/execute loop dari transport Telegram tanpa perlu distributed queue.
- Tambahkan lease, heartbeat, retry schedule, dan recovery scan pada SQLite.
- Dukung status `waiting_approval`, `waiting_external`, `cancel_requested`, dan `outcome_unknown`.
- Gunakan background response/polling hanya sebagai implementation detail; RunStore tetap authoritative.
- Uji restart pada setiap transisi state dan degradasi tiap dependency.

Gate:

- Run yang aman dilanjutkan otomatis setelah restart.
- Run ambigu tidak di-retry otomatis dan meminta rekonsiliasi Owner.
- Queue pressure tidak membuat bot kehilangan kemampuan cancel atau memberi status.

Rollback: hentikan worker baru; run yang belum terminal tetap tercatat untuk recovery/manual action.

## Phase 6 — Eval-gated capability expansion

Tujuan: membuat penambahan MCP rutin, bukan eksperimen berisiko.

Untuk setiap MCP/Capability baru wajib ada:

- use case dan owner value yang terukur;
- provenance server, auth/scopes, data-egress map, dan threat review;
- allowlist, Risk Class, timeout, retry, idempotency, serta disable switch;
- contract tests dan task/safety eval;
- runbook connect, rotate credential, outage, dan revoke.

Tool search/dynamic catalog baru dipertimbangkan ketika catalog statis terbukti menaikkan token atau
kesalahan pemilihan secara material. Multi-agent baru dipertimbangkan bila eval menunjukkan domain
spesialis membutuhkan prompt, policy, dan ownership hasil yang benar-benar terpisah.

## First two-week slice

Urutan kerja paling bernilai untuk sprint pertama:

1. Buat corpus eval dan inventory seluruh tool/risk.
2. Definisikan kontrak `Capability`, `Invocation`, `PolicyDecision`, `RunEvent`, `AgentRuntime`, dan
   `CapabilityExecutor`.
3. Implementasikan `CapabilityRegistry` untuk tool lokal tanpa mengubah handler Telegram.
4. Ekstrak policy yang ada dan buat characterization tests.
5. Tambahkan migration RunStore serta satu vertical slice read-only dari request sampai event terminal.
6. Demo restart/recovery dan bandingkan hasilnya dengan baseline.

Sprint selesai ketika vertical slice tersebut berjalan di CI, memiliki trace yang dapat dibaca, dan
dapat dinonaktifkan dengan satu feature flag.

## Suggested work packages

| Order | Work package | Depends on | Primary proof |
|---|---|---|---|
| 1 | Eval corpus and safety baseline | — | Repeatable report |
| 2 | Capability contracts and registry | 1 | Local-tool parity tests |
| 3 | PolicyEngine extraction | 1–2 | Golden authorization tests |
| 4 | RunStore schema and state machine | 2 | Restart/crash tests |
| 5 | AgentRuntime vertical slice | 2–4 | End-to-end read-only run |
| 6 | Responses model adapter | 5 | Shadow/parity evaluation |
| 7 | Read-only MCP pilot | 3–6 | Contract and injection tests |
| 8 | Approval service and UI | 3–5 | Digest/replay tests |
| 9 | First reversible MCP write | 7–8 | Idempotency/recovery tests |
| 10 | Durable worker and expansion template | 4–9 | Restart and outage drills |

## Definition of done for the program

- PRD acceptance criteria terpenuhi dan tercatat oleh automated eval/report.
- Setiap Capability aktif memiliki manifest, risk class, policy, tests, metrics, dan kill switch.
- Seluruh side effect sensitif memiliki approval/receipt yang dapat diaudit.
- Run dapat dibatalkan dan dipulihkan tanpa kehilangan atau menduplikasi tindakan.
- Tambah/hapus satu MCP tidak memerlukan perubahan pada Telegram handler atau core orchestration.
- Dokumentasi operasi dan threat model diperbarui bersama setiap capability baru.
