# Referensi API Local Proxy

Route berikut dipakai dashboard. Authentication/middleware tetap berlaku sesuai deployment. Contoh memakai `http://127.0.0.1:20128`.

## Runtime

### `GET /api/local-proxy`

Mengembalikan state runtime, node terpilih, subscription, node, state scheduler health, runtime fingerprint, dan evidence failover request yang dibatasi.

Field penting:

```json
{
  "available": true,
  "binaryPath": "/usr/local/bin/sing-box",
  "runtime": "sing-box",
  "running": true,
  "pid": 12345,
  "proxyUrl": "http://127.0.0.1:20129",
  "configPath": "/var/lib/9router/local-proxy/sing-box.json",
  "selectedNodeId": "NODE_ID",
  "requestFailoverCount": 0,
  "requestFailoverEvidence": [],
  "autoHealth": {"running": false, "lastRunAt": null, "nextRunAt": null, "lastResult": null},
  "subscriptions": [],
  "nodes": []
}
```

### `POST /api/local-proxy`

```json
{"action":"start"}
{"action":"stop"}
{"action":"config"}
```

`config` membuat ulang config generated dan mengembalikan JSON tanpa menjalankan sidecar.

### `PUT /api/local-proxy`

Pilih node:

```json
{"nodeId":"NODE_ID"}
```

Rotasi:

```json
{}
```

## Node

### `GET /api/local-proxy/nodes`

Query opsional: `subscriptionId=SUBSCRIPTION_ID`.

### `POST /api/local-proxy/nodes`

Import satu atau beberapa URL yang dipisahkan newline:

```json
{"urls":"vless://...\nss://...\ntrojan://..."}
```

Mengembalikan `201` dengan `nodes`, `importedNodes`, dan `rejectedLines`.

### `PUT /api/local-proxy/nodes`

Menjalankan batch health check berurutan:

```json
{"testUrl":"http://cp.cloudflare.com/","subscriptionId":"OPTIONAL_ID"}
```

Mengembalikan `nodes`, `testedNodes`, `healthyNodes`, dan `unhealthyNodes`.

### `DELETE /api/local-proxy/nodes`

Hanya bulk deletion status `degraded` yang diterima:

```json
{"healthStatus":"degraded","subscriptionId":"OPTIONAL_ID"}
```

### `GET /api/local-proxy/nodes/:id`

Mengembalikan `{ "node": ... }`, atau `404`.

### `POST /api/local-proxy/nodes/:id`

Menjalankan health check:

```json
{"testUrl":"http://cp.cloudflare.com/"}
```

Route bisa mengembalikan HTTP 200 dengan hasil node yang `healthStatus`-nya `unhealthy`; periksa hasil node tersebut.

### `PUT /api/local-proxy/nodes/:id`

Mengubah metadata yang didukung dan `enabled`. `port` harus integer 1 sampai 65535.

### `DELETE /api/local-proxy/nodes/:id`

Menghapus satu node.

## Subscription

### `GET /api/local-proxy/subscriptions`

Mengembalikan `{ "subscriptions": [] }`.

### `POST /api/local-proxy/subscriptions`

```json
{"name":"Example","url":"https://provider.example/subscription"}
```

Hanya URL HTTP(S) yang diterima. Mengembalikan `201`.

### `GET /api/local-proxy/subscriptions/:id`

Mengembalikan satu subscription atau `404`.

### `PUT /api/local-proxy/subscriptions/:id`

Menerima `name` dan/atau `url` HTTP(S) yang tidak kosong. Edit tidak melakukan refresh atau menghapus node import.

### `POST /api/local-proxy/subscriptions/:id`

Mengambil dan mem-parsing subscription. Refresh sukses mengganti node yang diimpor subscription tersebut. Refresh gagal mengembalikan `502` dan mempertahankan node lama.

### `DELETE /api/local-proxy/subscriptions/:id`

Menghapus subscription dan node hasil import-nya.

## Setting

`GET /api/settings` dan `PATCH /api/settings` mengelola value scheduler tersimpan:

```json
{
  "localProxyEnabled": true,
  "localProxyAutoStart": true,
  "localProxyAutoTestEnabled": true,
  "localProxyAutoTestIntervalMinutes": 15,
  "localProxyAutoTestUrl": "http://cp.cloudflare.com/",
  "localProxyAutoFailoverEnabled": false,
  "localProxyRotationStrategy": "failover",
  "localProxyRotationIntervalMinutes": 30
}
```

Route settings mengkonfigurasi ulang scheduler setelah update sukses jika field automatic-test berubah.

## Penanganan error

Error biasanya berupa JSON `{ "error": "..." }`. Error start/config runtime mengembalikan `400`; resource yang tidak ditemukan `404`; refresh subscription gagal `502`. Kegagalan health dicatat di field node sehingga caller dapat memeriksa `healthStatus` dan `lastError`.
