# Pemilihan model

Nama model valid yang dimaksud adalah `gpt-4o-mini`, `gpt-4o`, `gpt-5-mini`, dan `gpt-5`. Tidak ada model API resmi bernama `gpt-5o` atau `gpt-5o-mini`.

Data berikut diperiksa pada 19 Agustus 2026 dari dokumentasi resmi OpenAI. Harga merupakan harga standard text token per satu juta token dan dapat berubah.

| Model | Input | Output | Context | Karakteristik untuk assistant ini |
|---|---:|---:|---:|---|
| `gpt-4o-mini` | US$0,15 | US$0,60 | 128K | Paling hemat; dokumentasi secara eksplisit memberi contoh translate, intent classification, dan keyword extraction; mendukung function calling dan structured output. |
| `gpt-5-mini` | US$0,25 | US$2,00 | 400K | Reasoning lebih kuat untuk tugas terdefinisi, tetapi output 3,33× harga 4o-mini dan kini ditandai deprecated. |
| `gpt-5` | US$1,25 | US$10,00 | 400K | Reasoning kuat tetapi berlebihan untuk chat personal/filter email dan kini ditandai deprecated. |
| `gpt-4o` | US$2,50 | US$10,00 | 128K | Kualitas general lebih tinggi daripada 4o-mini, tetapi sekitar 16,7× lebih mahal pada input dan output. |

Sumber resmi:

- [GPT-4o mini](https://developers.openai.com/api/docs/models/gpt-4o-mini)
- [GPT-4o](https://developers.openai.com/api/docs/models/gpt-4o)
- [GPT-5 mini](https://developers.openai.com/api/docs/models/gpt-5-mini)
- [GPT-5](https://developers.openai.com/api/docs/models/gpt-5)

## Keputusan

Default proyek adalah `gpt-4o-mini` untuk chat, tool selection, translation, dan klasifikasi email. Alasannya:

1. Paling murah dari empat pilihan.
2. Kebutuhan utama adalah bahasa, ekstraksi intent, dan pencocokan terstruktur, bukan reasoning panjang.
3. Function calling dan structured output sudah tersedia.
4. GPT-5/GPT-5 mini lama sudah ditandai deprecated, sehingga tidak cocok menjadi fondasi jangka panjang walaupun masih muncul di catalog.

Model tidak otomatis mengurangi jumlah token hanya karena berukuran kecil; yang terutama berkurang adalah biaya per token. Proyek menghemat jumlah token secara terpisah dengan:

- Membatasi riwayat melalui `MAX_HISTORY_MESSAGES`.
- Mengambil maksimum `MAX_MEMORY_ITEMS` yang relevan.
- Membatasi output melalui `OPENAI_MAX_OUTPUT_TOKENS`.
- Memotong body email melalui `GMAIL_MAX_BODY_CHARS`.
- Menggunakan lexical memory tanpa embedding.
- Tidak melakukan web search kecuali dibutuhkan.

Semua model dapat diganti tanpa perubahan kode:

```dotenv
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_CLASSIFIER_MODEL=gpt-4o-mini
```

Jika suatu hari kualitas klasifikasi email kurang, naikkan hanya `OPENAI_CLASSIFIER_MODEL` agar biaya chat biasa tetap rendah. Model ID dan status deprecation harus diperiksa kembali di OpenAI Docs sebelum deployment jangka panjang.
