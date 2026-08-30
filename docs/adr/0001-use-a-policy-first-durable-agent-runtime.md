# Use a policy-first durable Agent Runtime

## Status

Accepted — foundation implemented 30 August 2026

## Context

Personal Agent saat ini memiliki sejumlah tool lokal yang aman untuk satu proses, tetapi orkestrasi
masih berupa loop Chat Completions di memori. Menambah banyak server MCP langsung ke loop tersebut
akan memperbesar permukaan data dan tindakan tanpa memberikan mekanisme pause/resume, approval yang
terikat pada argumen, atau audit trail yang dapat direkonstruksi.

Produk ini melayani satu Owner. Kebutuhan terdekatnya adalah memperluas jenis pekerjaan dengan aman,
bukan membagi percakapan ke banyak agent otonom.

## Decision

Gunakan satu `AgentRuntime` sebagai pintu masuk orkestrasi. Implementasinya boleh memanfaatkan OpenAI
Responses API dan Agents SDK, tetapi project tetap menjadi source of truth untuk:

- status dan event `Agent Run`;
- registrasi serta pembatasan `Capability` lokal dan MCP;
- evaluasi `Policy` dan `Risk Class`;
- `Approval` yang terikat ke Invocation beserta argumennya; dan
- receipt, audit, serta pemulihan setelah proses berhenti.

Semua Capability ditemukan melalui `CapabilityRegistry`, diotorisasi oleh `PolicyEngine`, dan
dijalankan melalui `CapabilityExecutor` yang sama. MCP tidak diekspos langsung kepada model tanpa
allowlist. Arsitektur multi-agent ditunda sampai evaluasi menunjukkan bahwa satu agent dengan
capability spesialis tidak lagi cukup.

## Options considered

### Keep the current in-memory Chat Completions loop

Perubahan paling kecil, tetapi tidak memberi durability dan membuat approval serta MCP lifecycle
tersebar di orchestration loop.

### Expose MCP servers directly to the model

Cepat untuk prototipe, tetapi terlalu mempercayai metadata server dan sulit menerapkan kebijakan
lokal yang konsisten untuk data pribadi dan tindakan eksternal.

### Adopt a multi-agent platform immediately

Memungkinkan spesialisasi dini, tetapi menambah handoff, state, observability, dan failure mode sebelum
ada bukti produk membutuhkannya.

## Consequences

- Penambahan MCP baru membutuhkan adapter/manifest, klasifikasi risiko, allowlist, dan eval sebelum
  diaktifkan.
- Migrasi dapat dilakukan bertahap karena Capability lokal lama dapat dibungkus oleh registry.
- Run dan approval memerlukan tabel baru serta worker pemulihan.
- OpenAI SDK menjadi mekanisme implementasi, bukan pemilik policy atau data lifecycle project.
- Multi-agent, public webhooks, dan distributed queue bukan bagian dari fase pertama.
