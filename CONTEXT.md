# Personal Agent

Personal Agent membantu satu pemilik menyelesaikan pekerjaan melalui percakapan, data pribadi,
dan capability eksternal tanpa menyerahkan kontrol atas tindakan sensitif.

## Language

**Owner**:
Satu-satunya manusia yang berwenang meminta pekerjaan, memberikan approval, dan menerima hasil.
_Avoid_: User, account, operator

**Agent Run**:
Upaya yang dapat dilanjutkan untuk memenuhi satu tujuan Owner, termasuk reasoning, pemanggilan
capability, approval, dan hasil akhirnya.
_Avoid_: Request, turn, job

**Capability**:
Kemampuan terdaftar yang dapat dipilih Agent untuk membaca data atau melakukan tindakan, baik
disediakan secara lokal maupun melalui MCP.
_Avoid_: Integration, feature

**Invocation**:
Satu usulan eksekusi Capability dengan argumen tertentu yang dapat dipautkan ke Policy, Approval,
dan hasil eksekusinya.
_Avoid_: Call, action

**Tool**:
Representasi sebuah Capability yang ditawarkan kepada model untuk dipilih dan dipanggil.
_Avoid_: Function, command

**MCP Connection**:
Hubungan yang dikonfigurasi antara Personal Agent dan satu server MCP tepercaya, termasuk identitas,
scope, serta kebijakan penggunaannya.
_Avoid_: Plugin, provider, connector

**Approval**:
Keputusan Owner yang memberi atau menolak izin untuk tepat satu tindakan sensitif beserta argumen
yang ditampilkan.
_Avoid_: Confirmation, consent

**Policy**:
Aturan yang menentukan Capability mana yang terlihat, data apa yang boleh keluar, dan tindakan mana
yang membutuhkan Approval pada suatu Agent Run.
_Avoid_: Permission check, guardrail

**Risk Class**:
Klasifikasi lokal yang menentukan apakah sebuah Invocation boleh berjalan otomatis, memerlukan
Approval, atau harus ditolak.
_Avoid_: Safety flag, MCP annotation

**Artifact**:
Hasil tahan lama dari Agent Run, seperti file, catatan, laporan, atau data terstruktur yang dapat
dibuka kembali oleh Owner.
_Avoid_: Output, attachment
