# Arsitektur Local Proxy

## Alur runtime

```text
Request provider
      |
      v
9Router proxy-aware fetch
      |
      +-- provider mengecualikan sidecar? -- ya --> route direct/external
      |
      tidak
      v
HTTP(S)_PROXY / connection proxy
      |
      v
127.0.0.1:<port-local-proxy>
      |
      v
sing-box atau nekobox_core
      |
      v
selector proxy-auto -> node VLESS/VMess/Trojan/SS/HTTP/SOCKS
      |
      v
target upstream
```

Sidecar bersifat opsional dan hanya lokal. Server 9Router membuat config dan mengelola lifecycle proses; proxy core mengelola transport protokol, DNS detour, TLS, WebSocket, Reality, dan koneksi node.

## Lifecycle sidecar utama

1. `startLocalProxy()` membaca node aktif dan mengubah record node supported menjadi outbound.
2. Ia memilih node terpilih, mengutamakan node sehat dan latency terukur lebih rendah jika pilihan lama tidak valid.
3. Ia menulis `<DATA_DIR>/local-proxy/sing-box.json` dengan mode `0600`.
4. Ia mengadopsi proses managed yang sudah memakai config generated, atau menjalankan executable dengan `run -c`.
5. Ia menunggu mixed inbound dan Clash API controller.
6. Ia menerapkan proxy environment outbound hanya pada proses fetch server-side yang didukung.
7. `stopLocalProxy()` menghentikan proses managed dan menghapus hanya environment yang dikelola 9Router.

Proses dashboard dan sidecar adalah dua proses berbeda. Rebuild dashboard tidak otomatis memerlukan sidecar kedua.

## Lifecycle health check

Health test sengaja memakai jalur berbeda dari routing normal:

```text
record node
   -> validasi SSRF/public URL
   -> config sing-box sementara satu node
   -> mixed inbound loopback sementara
   -> GET melalui undici ProxyAgent
   -> response selesai / error transport
   -> simpan status, latency, timestamp, lastError
   -> hentikan child dan hapus config sementara
```

Ini mengisolasi test per-node dari selector aktif. Test ini adalah probe konektivitas, bukan test provider AI.

## Failover request

`proxyAwareFetch` mengklasifikasikan error transport sebagai DNS, TCP connect, TLS, proxy tunnel, response headers, first token, stream interruption, atau cancellation. Untuk sidecar lokal, pemilihan kandidat diserahkan ke `__nineRouterRequestProxyFailover` di Local Proxy manager.

Manager menserialisasi failover, mengecualikan node yang sudah dicoba, memilih kandidat aktif yang tidak `unhealthy`, dan menyimpan evidence terbatas. Body yang tidak dapat di-replay tidak diulang. Response yang sudah dimulai tidak diulang. Direct fallback ditentukan oleh method dan policy strict-proxy.

## Model DNS dan route

Config generated memakai DNS lokal untuk resolve node/relay dan DNS remote melalui proxy terpilih untuk domain target. Domain relay diarahkan ke DNS direct agar endpoint proxy dapat di-resolve tanpa loop. Traffic normal diarahkan ke `proxy-auto`; exception direct eksplisit dapat ditambahkan generator runtime.

## Exclude provider

`resolveProviderConnectionProxyConfig()` menggabungkan setting connection provider dengan setting strategy `excludeLocalProxy`. Jika connection proxy adalah sidecar lokal 9Router dan exclusion aktif, policy menonaktifkan proxy lokal tersebut dan memberi tanda `bypassLocalProxy`. External proxy pool dan relay URL tidak otomatis dihapus.

Policy diteruskan ke executor normal serta jalur refresh OAuth/model/project. Ini mencegah provider memakai sidecar saat OAuth refresh meskipun request model pertamanya direct.

## Titik integrasi source

- `src/app/(dashboard)/dashboard/local-proxy/page.js` — state dan action dashboard.
- `src/app/api/local-proxy/route.js` — status runtime, start/stop/config, select/rotate.
- `src/app/api/local-proxy/nodes/route.js` — list, import, batch health, hapus degraded.
- `src/app/api/local-proxy/nodes/[id]/route.js` — CRUD dan health node.
- `src/app/api/local-proxy/subscriptions/` — CRUD dan refresh subscription.
- `src/lib/db/repos/proxySubscriptionsRepo.js` — parser dan penyimpanan SQLite.
- `src/lib/network/localProxyManager.js` — deteksi core, config, lifecycle, selector, probe, failover request.
- `src/lib/network/localProxyHealthScheduler.js` — test otomatis, threshold, concurrency, failover/rotasi terjadwal.
- `open-sse/utils/proxyFetch.js` — policy proxy, fase transport, DNS bypass, replay/fallback.
- `src/lib/network/connectionProxy.js` — resolusi proxy provider dan exclusion sidecar.
- `custom-server.js` — shutdown hook dan integrasi lifecycle proses.
