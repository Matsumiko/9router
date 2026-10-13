# Local Proxy / sing-box

Local Proxy adalah sidecar sing-box-compatible opsional yang hanya bind ke loopback untuk meneruskan request outbound server-side 9Router melalui node proxy yang diimpor. Fitur ini tidak membuat atau mengubah VPS remote.

## Peta dokumentasi

- [Instalasi](./local-proxy/installation.id.md) — instalasi dan pemilihan `sing-box` atau `nekobox_core`.
- [Konfigurasi](./local-proxy/configuration.id.md) — environment variable, pengaturan dashboard, policy proxy, dan penyimpanan.
- [Health check](./local-proxy/health-checks.id.md) — probe per-node bergaya NekoBox, perubahan status, dan pengetesan otomatis.
- [Operasi](./local-proxy/operations.id.md) — subscription, node manual, pemilihan, rotasi, start/stop, dan failover.
- [Referensi API](./local-proxy/api.id.md) — endpoint dashboard, body request, dan perilaku response.
- [Arsitektur](./local-proxy/architecture.id.md) — alur runtime dan titik integrasi source.
- [Troubleshooting](./local-proxy/troubleshooting.id.md) — error umum dan evidence yang perlu dikumpulkan.
- [Keamanan](./local-proxy/security.id.md) — loopback, credential, SSRF, dan risiko failover otomatis.

English: [Local Proxy documentation](./local-proxy.md).

## Quick start

```bash
# Instal core resmi secara terpisah, lalu expose ke proses 9Router.
export SING_BOX_BIN=/absolute/path/to/sing-box

npm install
npm run build
PORT=20128 HOSTNAME=127.0.0.1 NEXT_PUBLIC_BASE_URL=http://127.0.0.1:20128 npm run start
```

Buka `http://127.0.0.1:20128/dashboard/local-proxy`, import subscription atau node manual, refresh/import node, aktifkan minimal satu node, jalankan **Test all nodes**, pilih node yang sehat, lalu klik **Start sidecar**.

Listener default adalah `http://127.0.0.1:20129`. Konfigurasi yang dibuat disimpan di `<DATA_DIR>/local-proxy/sing-box.json` dengan permission file yang ketat.

## Perilaku penting

- Sidecar nonaktif sampai dijalankan atau auto-start diaktifkan.
- Health check memakai proses proxy sementara satu-node; tidak memakai ulang sidecar utama yang berjalan lama.
- Toggle provider **Exclude Local Sidecar** warna kuning berarti provider tersebut melewati sidecar lokal. Toggle abu-abu berarti provider boleh memakai sidecar saat aktif.
- `sing-box` dan `nekobox_core` sama-sama diterima selama versi yang dipasang mendukung konfigurasi yang dibuat.
- Kegagalan transport sidecar lokal dapat memicu failover node yang dibatasi. Request yang sudah menerima data response tidak pernah diulang.
- Error HTTP dari provider tidak otomatis dianggap sebagai node proxy rusak.
