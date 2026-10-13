# Troubleshooting Local Proxy

## Kumpulkan evidence terlebih dahulu

Sebelum mengganti node atau binary, kumpulkan:

```bash
curl -sS http://127.0.0.1:20128/api/local-proxy
curl -sS http://127.0.0.1:20128/api/health
ps -eo pid=,args= | grep -E '[s]ing-box|[n]ekobox_core'
$SING_BOX_BIN version
$SING_BOX_BIN check -c <DATA_DIR>/local-proxy/sing-box.json
```

Catat path/version binary, PID 9Router, build identity, node terpilih, origin target, `healthStatus`, `lastError`, `proxyPhase`, dan timestamp. Redact UUID, password, token, URL subscription yang berisi credential, dan config generated lengkap sebelum membagikan log.

## `sing-box is unavailable`

Periksa executable dan environment proses:

```bash
command -v sing-box || true
command -v nekobox_core || true
printf '%s\n' "${SING_BOX_BIN:-<unset>}"
"${SING_BOX_BIN:-sing-box}" version
```

Gunakan path absolute pada `SING_BOX_BIN` untuk systemd, Docker, atau supervisor yang memiliki `PATH` terbatas. Pastikan file executable dan dapat diakses user yang menjalankan 9Router.

## Config check gagal

```bash
$SING_BOX_BIN check -c <DATA_DIR>/local-proxy/sing-box.json
```

Penyebab umum:

- core terlalu lama dibanding schema config generated;
- node import memakai outbound atau transport yang tidak didukung;
- parameter Reality, TLS, WebSocket, gRPC, atau plugin Shadowsocks malformed;
- proses kedua mengubah file ketika sidecar startup.

Gunakan **Preview config**, validasi dengan binary yang benar-benar dipilih, dan test satu format node setiap kali.

## Listener bind failure

Port default adalah `20129` dan `20130`:

```bash
ss -ltnp | grep -E ':20129|:20130' || true
```

Hentikan proses lain atau pilih `NINE_ROUTER_LOCAL_PROXY_PORT` dan `NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT`, lalu restart 9Router. Jangan menjalankan core test pada port production.

## `fetch failed` melalui sidecar

`fetch failed` adalah gejala, bukan root cause. Periksa fase:

| Fase | Area yang mungkin bermasalah |
|---|---|
| `dns` | DNS target/node, DNS detour, resolver |
| `tcp_connect` | alamat/port node, firewall, relay |
| `tls` | SNI, certificate, TLS interception, parameter Reality |
| `proxy_tunnel` | protokol/auth proxy atau handshake sidecar |
| `response_headers` | upstream stall atau jalur node tidak mencapai target |
| `first_token` | response terbuka tetapi gagal sebelum chunk body pertama |
| `stream_interruption` | stream putus setelah data terkirim |

Lalu jalankan URL Test yang sama melalui node sehat lain. Jika kedua binary berhasil ke target yang sama dengan config yang sama, mengganti binary kemungkinan tidak menyelesaikan masalah node atau relay.

Untuk failure khusus provider, periksa **Exclude Local Sidecar**. Kuning/aktif melewati sidecar lokal; abu-abu/nonaktif mengizinkan sidecar. Ini tidak menonaktifkan external proxy pool atau relay.

## Node berstatus `unhealthy`

Periksa `lastError`, `lastCheckedAt`, dan URL Test terpilih. Pastikan:

- URL adalah HTTP(S) publik tanpa credential;
- host dapat di-resolve dari mesin 9Router;
- credential, port, SNI, Host, path, dan transport node benar;
- binary yang tepat dapat menjalankan config sementara;
- firewall outbound mengizinkan target;
- node lain bisa menyelesaikan probe yang sama.
Check manual langsung memperbarui node. Check otomatis menyimpan counter kegagalan berurutan di memory; kegagalan berurutan ketiga mengaktifkan keputusan auto failover jika ada pengganti sehat. Hasil probe gagal yang tersimpan tetap `degraded` kecuali operasi probe mencatat kegagalan terminal.

## Health check `healthy`, tetapi request provider gagal

Ini normal jika konektivitas umum berhasil tetapi perilaku provider gagal. Periksa authentication provider, status API, ketersediaan model, syarat SNI/Host, format request, rate limit, dan fase response. Status 5xx dari URL Test tetap dapat menghasilkan `healthy` karena test mengukur response transport selesai, bukan sukses aplikasi.

## Pengetesan otomatis tidak pernah berjalan

Pastikan:

1. `localProxyAutoTestEnabled` aktif.
2. Save di dashboard sukses.
3. Proses 9Router masih hidup.
4. `GET /api/local-proxy` memiliki `autoHealth.nextRunAt` yang tidak null.
5. Proses dapat menulis `<DATA_DIR>/local-proxy`.

Scheduler berjalan di dalam proses. Restart 9Router mereset timer.

## Auto failover tidak berpindah

Semua syarat berikut harus terpenuhi:

- automatic failover aktif;
- ada node aktif yang terpilih;
- node terpilih gagal tiga kali berurutan;
- ada node lain yang aktif dan berstatus `healthy`;
- cooldown lima menit tidak sedang berlaku.

Jika tidak ada pengganti sehat, node tidak dipindahkan.

## Subscription tidak mengimpor node

Response dibatasi 2 MiB dan harus berisi URI-list atau record JSON yang didukung. Periksa `lastError` subscription, pastikan URL mengembalikan konten yang benar, dan cek apakah provider memakai format encrypted/proprietary yang harus didecode sebelum import.

## Fetch subscription gagal, health check berhasil

Keduanya adalah jalur berbeda. Refresh subscription memakai outbound proxy-aware normal dan environment/sidecar aktif; health check memakai proses sementara per-node. Periksa URL subscription, environment proxy, status sidecar, dan response subscription secara terpisah.

## Jangan salah mengklasifikasikan model timeout

Timeout model tidak otomatis berarti proxy rusak. Kumpulkan fase transport terlebih dahulu dan bandingkan route direct/external, node lain, request non-streaming kecil, serta request streaming. Jangan merotasi atau menghapus node hanya berdasarkan timeout model yang belum terklasifikasi.
