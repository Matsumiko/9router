# Operasi Local Proxy

## Setup pertama

1. Buka **Dashboard → Local Proxy**.
2. Pastikan Runtime card menemukan executable.
3. Tambahkan subscription atau buka **Add manual node**.
4. Refresh subscription jika diperlukan.
5. Aktifkan node yang boleh dipakai.
6. Atur URL Test.
7. Jalankan **Test all nodes**.
8. Pilih node sehat dengan **Use**, atau gunakan **Rotate healthy**.
9. Klik **Start sidecar**.
10. Gunakan **Preview config** dan Runtime card untuk memastikan node terpilih dan listener.

Saat dijalankan, sidecar hanya menerapkan proxy environment ke outbound fetch server-side yang didukung. Saat dihentikan, value proxy yang dikelola 9Router dihapus. Sidecar tidak mengatur browser atau proses CLI milik user.

## Subscription

Buat subscription dengan nama dan URL `http://` atau `https://`. Refresh mengunduh response, membatasi ukuran sampai 2 MiB, mem-parsing format URI/JSON yang didukung, mengganti node lama yang diimpor subscription tersebut, lalu memperbarui `lastFetchedAt`.

Edit subscription hanya mengubah nama/URL. Node hasil import tidak langsung dihapus; lakukan refresh terpisah untuk import dari URL baru. Refresh gagal akan mempertahankan node lama dan mencatat `lastError`.

Menghapus subscription menghapus subscription dan node yang diimpor olehnya. Node manual tidak memiliki subscription ID sehingga tidak ikut terhapus.

Fetch subscription memakai outbound proxy-aware normal, sehingga dapat mengikuti environment/sidecar aktif. Ini bukan probe health per-node.

## Node manual

Tempel satu URL per baris. Baris kosong dan komentar yang diawali `#` diabaikan. Scheme yang didukung:

```text
vless://...
vmess://...
trojan://...
ss://...
http://...
https://...
socks5://...
socks5h://...
```

Node dapat diaktifkan/nonaktifkan satu per satu. Node nonaktif dikeluarkan dari config generated dan pengetesan otomatis.

## Seleksi dan rotasi

**Use** memilih node. Jika sidecar berjalan, 9Router memperbarui selector sing-box melalui Clash API loopback tanpa restart jika memungkinkan. Jika selector API tidak tersedia dan restart diizinkan, 9Router membuat ulang/restart sidecar.

**Rotate healthy** memilih node aktif lain yang eligible dan statusnya bukan `unhealthy`. Rotasi terjadwal lebih ketat: hanya memilih node yang saat ini berstatus `healthy`.

## Failover level request

Failover level request menangani kegagalan transport sebelum response upstream ada:

1. `proxyAwareFetch` mengklasifikasikan fase kegagalan.
2. Local proxy manager mengeluarkan node yang sudah dicoba/terpilih lalu memilih pengganti yang eligible.
3. Request hanya boleh diulang jika body dapat di-replay dan belum ada data response yang dimulai.
4. Maksimal tiga kandidat dicoba.
5. Node yang gagal ditandai `degraded` setelah perpindahan berhasil.

Error HTTP provider bukan kegagalan transport node. Response yang sudah dimulai tidak pernah diulang.

Policy direct fallback:

- `GET`, `HEAD`, dan `OPTIONS` boleh fallback direct kecuali dilarang policy;
- request non-idempotent seperti chat `POST` tetap proxy-only secara default;
- `strictProxy: true` melarang direct fallback;
- `allowDirectFallback: true` secara eksplisit mengizinkan fallback untuk caller yang menerima risikonya.

Evidence terbaru yang dibatasi tersedia lewat `GET /api/local-proxy` dan hanya disimpan di memory; evidence hilang saat proses restart.

## Start, stop, dan rebuild

Sidecar adalah proses terpisah. Rebuild atau restart dashboard tidak memerlukan sidecar kedua. Saat startup, 9Router dapat mengadopsi proses managed yang sudah memiliki listener dan config generated.

Jika listener dipakai proses lain, startup mengembalikan diagnostic core, termasuk bind failure jika tersedia. Saat 9Router shutdown dengan graceful, sidecar managed dihentikan.

## Perbandingan dan validasi binary

Binary resmi `sing-box` dan build kompatibel `nekobox_core` sama-sama dapat dipakai. Test binary yang benar-benar dipilih dengan config generated:

```bash
$SING_BOX_BIN version
$SING_BOX_BIN check -c <DATA_DIR>/local-proxy/sing-box.json
```

Untuk membandingkan dua binary secara aman, gunakan config sementara terpisah dengan port listener/controller berbeda. Jangan menjalankan proses kedua pada `20129` atau `20130` ketika sidecar production sedang hidup. Response HTTP lengkap dari kedua binary membuktikan kompatibilitas untuk node/config dan target tersebut; bukan bukti semua format node atau semua provider pasti kompatibel.
