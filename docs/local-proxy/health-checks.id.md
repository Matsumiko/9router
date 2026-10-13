# Health check Local Proxy

## Arti “healthy”

Node dianggap sehat ketika 9Router dapat menjalankan listener sing-box sementara satu-node dan menyelesaikan request HTTP melalui node tersebut ke URL Test. Check ini mengukur keterjangkauan transport proxy dan penyelesaian response HTTP. Check **tidak** memvalidasi status atau isi body tertentu: response 2xx, 3xx, 4xx, maupun 5xx yang selesai tetap membuktikan jalur proxy berhasil mencapai target.

Ini mengikuti model reachability bergaya NekoBox. Node yang berhasil mencapai target tetapi menerima error HTTP dari upstream masih dapat berstatus `healthy`; semantik provider perlu diperiksa terpisah.

## URL Test default

```text
http://cp.cloudflare.com/
```

`cp.cloudflare.com` adalah endpoint HTTP publik kecil yang umum dipakai sebagai probe konektivitas. URL custom dapat diisi di dashboard atau diatur melalui `NINE_ROUTER_PROXY_TEST_URL` sebagai fallback server.

URL harus:

- memakai `http://` atau `https://`;
- tidak memiliki username atau password;
- resolve ke alamat publik melalui SSRF guard;
- dapat diakses dari host 9Router melalui node yang diuji.

Gunakan endpoint publik yang stabil dan kecil. Jangan memakai API provider yang memerlukan autentikasi sebagai URL health node umum.

## Cara pengetesan satu node

Untuk setiap node, 9Router:

1. Membaca node dari SQLite.
2. Memvalidasi URL Test dan memastikan alamat hasil resolve bersifat publik.
3. Mengubah node menjadi outbound sing-box.
4. Membuat config sementara berisi satu outbound, mixed inbound sementara di loopback, DNS direct, dan DNS interception.
5. Menjalankan proses sing-box-compatible sementara.
6. Menunggu port loopback sementara menerima koneksi.
7. Mengirim GET ke URL Test melalui `undici` `ProxyAgent` yang menunjuk ke listener sementara.
8. Mencatat `healthy` dan elapsed milliseconds jika response HTTP selesai, apa pun status response-nya.
9. Mencatat `degraded`/`unhealthy` dan error transport jika probe tidak selesai.
10. Menghentikan proses sementara dan menghapus config health sementara.

Sidecar utama yang berjalan lama tidak dipakai ulang. Ini mencegah node yang sedang terpilih menutupi hasil node lain.

Setiap test memiliki timeout probe terbatas. Timeout, DNS failure, TCP failure, TLS failure, proxy handshake failure, atau kegagalan startup core sementara dihitung sebagai probe gagal.

## Check manual

### Dashboard

1. Buka **Dashboard → Local Proxy**.
2. Atur **Test URL** jika default tidak sesuai.
3. Klik aksi health pada baris node, atau **Test all nodes**.
4. Periksa status, latency, `lastCheckedAt`, dan `lastError`.

**Test all nodes** mengikuti filter subscription yang dipilih. Route batch mengecek node secara berurutan dan mengembalikan total hasil.

### API

Satu node:

```bash
curl -X POST http://127.0.0.1:20128/api/local-proxy/nodes/NODE_ID \
  -H 'Content-Type: application/json' \
  -d '{"testUrl":"http://cp.cloudflare.com/"}'
```

Semua node, opsional dibatasi subscription:

```bash
curl -X PUT http://127.0.0.1:20128/api/local-proxy/nodes \
  -H 'Content-Type: application/json' \
  -d '{"testUrl":"http://cp.cloudflare.com/","subscriptionId":"SUBSCRIPTION_ID"}'
```

Response API yang sukses berarti operasi health diproses. Tetap periksa `healthStatus` setiap node; probe bisa gagal sementara API tetap mengembalikan HTTP 200 dengan hasil yang sudah disimpan.

## Nilai status

| Status | Arti |
|---|---|
| `unknown` | Node belum menyelesaikan health check. |
| `healthy` | Proxy sementara berhasil menyelesaikan request HTTP. |
| `degraded` | Probe terbaru tidak selesai dengan sukses. Scheduler menyimpan counter kegagalan berurutan untuk keputusan failover, tetapi tidak mengubah hasil probe biasa menjadi `unhealthy`. |
| `unhealthy` | Operasi check per-node mencatat kegagalan terminal. |

Latency diukur dari awal probe sementara sampai response HTTP diterima. Ini bukan latency generasi provider.

## Pengetesan otomatis

Pengetesan otomatis adalah scheduler di dalam proses. Scheduler berjalan selama proses server 9Router hidup dan tidak memerlukan tab dashboard terbuka.

Default:

- nonaktif;
- interval: 15 menit, dibatasi 5–120;
- URL: `http://cp.cloudflare.com/`;
- concurrency maksimum: 4 node;
- failover otomatis: nonaktif;
- threshold failover: 3 kegagalan berurutan;
- cooldown failover: 5 menit.

Scheduler hanya mengecek node yang aktif. Check sukses mereset counter kegagalan berurutan. Probe gagal tetap `degraded` pada hasil node tersimpan sementara counter berada di bawah atau mencapai threshold; kegagalan berurutan ketiga mengaktifkan keputusan auto failover jika ada pengganti sehat. Exception probe terminal dapat dicatat sebagai `unhealthy`.

Rotasi terjadwal berbeda dari failover:

- `failover`: tidak ada rotasi terjadwal;
- `periodic`: memilih node sehat berikutnya;
- `weighted`: memilih alternatif sehat dengan probabilitas lebih tinggi untuk latency terukur yang lebih rendah.

Rotasi terjadwal memerlukan automatic testing, node aktif yang terpilih, dan interval rotasi yang sudah lewat. Failover dievaluasi lebih dahulu; run yang melakukan failover tidak sekaligus melakukan rotasi.

## Membaca kegagalan

Health check gagal berarti node tersebut tidak dapat menyelesaikan probe pada waktu itu. Ini tidak otomatis membuktikan provider, model, atau semua node rusak. Bandingkan:

- URL Test yang sama melalui node lain;
- akses direct dari host;
- parameter outbound generated node;
- log core sementara;
- `lastError` dan timestamp.

Health check sukses juga tidak membuktikan semua provider pasti bekerja. TLS provider, autentikasi, SNI, WebSocket, rate limit upstream, dan payload request dapat gagal setelah konektivitas umum berhasil.
