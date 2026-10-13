# Keamanan Local Proxy

## Pertahankan listener di loopback

Inbound generated bind ke `127.0.0.1`. Jangan expose `20129` atau controller Clash API ke publik. Listener proxy dapat membawa outbound traffic apa pun dan config node dapat berisi credential.

## Lindungi file generated dan backup database

Config generated ditulis dengan mode `0600`, tetapi akses user host dan data directory tetap penting. URL proxy, URL subscription, UUID, password, dan data SQLite export dapat menjadi secret. Jangan menempelkan config lengkap ke issue atau log publik.

## SSRF guard URL health

URL health harus HTTP(S), tidak boleh memiliki userinfo, dan harus resolve ke alamat publik. Ini mencegah fitur health dipakai untuk fetch loopback/private network. URL publik tetap dapat tidak diinginkan atau rate-limited; gunakan endpoint stabil yang boleh diprobe.

## Risiko subscription

Response subscription adalah input tidak terpercaya. 9Router membatasi ukuran response, parsing format supported, validasi value, dan generate config lokal. Tetap perlakukan provider subscription sebagai pemasok config: review node import, nonaktifkan node mencurigakan, dan jangan menjalankan URL subscription yang berisi credential pada dashboard publik.

## Exclude provider

**Exclude Local Sidecar** per provider mengurangi ketergantungan provider pada node proxy lokal, tetapi tidak menjamin egress direct jika external proxy pool atau relay terkonfigurasi. Periksa effective proxy policy sebelum menyimpulkan upstream melihat IP direct host.

## Direct fallback dan replay

Direct fallback dapat mengekspos request ke network host dan melanggar ekspektasi routing. Secara default, request non-idempotent seperti chat `POST` tidak dikirim direct setelah sidecar gagal. `strictProxy: true` melarang direct fallback. Jangan mengaktifkan `allowDirectFallback` kecuali duplicate/egress alternatif memang dapat diterima.

Request yang sudah menerima response headers atau data body tidak diulang. Ini melindungi semantics streaming dan mencegah side effect ganda setelah request sudah established.

## Failover otomatis

Failover otomatis mengubah route tanpa klik manual. Biarkan nonaktif jika perubahan route memerlukan persetujuan operator. Jika diaktifkan, periksa evidence failover yang dibatasi dan gunakan URL health yang pendek serta stabil; jangan menganggap setiap error provider sebagai node rusak.

## Log dan diagnosis

Log transport menyamarkan target/proxy dan evidence failover hanya menyimpan origin, node ID, fase, alasan, attempt, dan policy fallback. Hindari debug logging di sekitar credential kecuali log terlindungi. Redact token dan autentikasi proxy sebelum membagikan diagnosis.

## Binary dan supply chain

Instal proxy core dari sumber terpercaya, pin version bila perlu, verifikasi checksum/signature sesuai environment, lalu jalankan `version` dan `check` sebelum core memiliki listener production. `sing-box` resmi dan `nekobox_core` kompatibel adalah binary berbeda; jangan menganggap feature parity hanya karena nama command sama.
