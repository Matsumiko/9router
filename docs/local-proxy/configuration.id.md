# Konfigurasi Local Proxy

## Environment variable

| Variable | Default | Fungsi |
|---|---:|---|
| `SING_BOX_BIN` | tidak ada | Path explicit ke executable proxy. Prioritas tertinggi. |
| `SINGBOX_BIN` | tidak ada | Alternatif variable executable explicit. |
| `NINE_ROUTER_LOCAL_PROXY_PORT` | `20129` | Port mixed-inbound loopback utama. Range valid: 1024–65535. |
| `NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT` | `20130` | Port controller Clash API loopback. |
| `NINE_ROUTER_PROXY_TEST_URL` | `http://cp.cloudflare.com/` | URL fallback untuk health check per-node. URL dashboard dan auto-test yang tersimpan akan meng-override. |
| `DATA_DIR` | default platform | Root database dan directory Local Proxy generated. |
| `PORT` | `20128` pada checkout ini | Port dashboard/server 9Router. |
| `HOSTNAME` | tergantung runtime | Alamat bind dashboard. |

Format lowercase `http_proxy`, `https_proxy`, `all_proxy`, dan `no_proxy` juga diterima oleh outbound fetch layer untuk environment proxy. Saat berjalan, Local Proxy menerapkan `HTTP_PROXY`, `HTTPS_PROXY`, dan `ALL_PROXY` pada proses, lalu menghapus value yang dikelola 9Router ketika dihentikan.

Contoh:

```bash
DATA_DIR=/var/lib/9router \
SING_BOX_BIN=/usr/local/bin/sing-box \
NINE_ROUTER_LOCAL_PROXY_PORT=20729 \
npm run start
```

Restart 9Router setelah mengubah port listener. Port ini juga dipakai untuk mengenali apakah sebuah proxy URL adalah sidecar lokal 9Router.

## Pengaturan dashboard

Halaman Local Proxy menyimpan setting berikut melalui `/api/settings`:

| Setting | Default | Range/nilai |
|---|---:|---|
| `localProxyEnabled` | `false` | Mengaktifkan state fitur Local Proxy. |
| `localProxyAutoStart` | `false` | Menjalankan sidecar saat aplikasi startup jika aktif. |
| `localProxyAutoTestEnabled` | `false` | Mengaktifkan scheduler health check di dalam proses. |
| `localProxyAutoTestIntervalMinutes` | `15` | Dipaksa berada di 5–120 menit. |
| `localProxyAutoTestUrl` | `http://cp.cloudflare.com/` | URL test HTTP(S) publik. |
| `localProxyAutoFailoverEnabled` | `false` | Mengaktifkan failover terjadwal setelah kegagalan node aktif berulang. |
| `localProxyRotationStrategy` | `failover` | `failover`, `periodic`, atau `weighted`. |
| `localProxyRotationIntervalMinutes` | `30` | Dipaksa berada di 15–240 menit. |

Auto-start baru berpengaruh ketika fitur Local Proxy juga aktif. Pengetesan otomatis tidak bergantung pada tab dashboard yang terbuka, tetapi scheduler hidup di proses 9Router; restart 9Router mereset timer in-memory lalu menjadwalkannya lagi dari setting tersimpan.

## Exclude Local Sidecar per provider

Halaman setting provider memiliki **Exclude Local Sidecar**:

- toggle kuning/aktif: provider melewati sidecar lokal `127.0.0.1:<port>`;
- toggle abu-abu/nonaktif: provider boleh memakai sidecar lokal ketika aktif.

Exclusion hanya berlaku untuk provider tersebut. Sidecar provider lain tidak ikut mati. Yang dilewati hanya route sidecar lokal; external proxy pool atau relay yang dikonfigurasi eksplisit masih dapat dipakai. Policy ini diteruskan ke request provider, OAuth refresh, project discovery, model discovery, dan retry.

## Config generated

File utama adalah `<DATA_DIR>/local-proxy/sing-box.json`, ditulis dengan mode `0600`. Isinya mencakup:

- mixed inbound pada `127.0.0.1:<port>`;
- satu outbound untuk setiap node supported yang aktif;
- outbound `direct`;
- selector `proxy-auto`;
- routing DNS untuk domain relay dan remote DNS melalui proxy terpilih;
- route final melalui `proxy-auto`.

Inbound sidecar tidak dibuka selain loopback. Gunakan **Preview config** di dashboard atau `POST /api/local-proxy` dengan `{"action":"config"}` untuk melihat JSON.

## Input node yang didukung

Parser menerima URI-list untuk:

- VLESS;
- VMess;
- Trojan;
- Shadowsocks, termasuk parameter URI `v2ray-plugin` yang didukung;
- HTTP/HTTPS;
- SOCKS5/SOCKS5H.

Host WebSocket, TLS SNI, public key/short ID Reality, fingerprint uTLS, service name gRPC, HTTP upgrade, dan field transport terkait dipertahankan bila tersedia pada format input. Core yang dipasang harus mendukung outbound hasil generate.

## Penyimpanan dan permission

Subscription dan node disimpan di SQLite 9Router. Config generated dan PID file berada di `<DATA_DIR>/local-proxy`. Export database dapat berisi credential proxy di URL atau data node; perlakukan sebagai secret.
