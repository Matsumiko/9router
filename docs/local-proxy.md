# Local Proxy / sing-box

Local Proxy is an optional, loopback-only sing-box-compatible sidecar for routing supported 9Router server-side outbound requests through imported proxy nodes. It does not deploy or modify a remote VPS.

## Documentation map

- [Installation](./local-proxy/installation.md) — install and select `sing-box` or `nekobox_core`.
- [Configuration](./local-proxy/configuration.md) — environment variables, dashboard settings, proxy policy, and storage.
- [Health checks](./local-proxy/health-checks.md) — the NekoBox-style per-node probe, status transitions, and automatic testing.
- [Operations](./local-proxy/operations.md) — subscriptions, manual nodes, selection, rotation, start/stop, and failover.
- [API reference](./local-proxy/api.md) — dashboard endpoints, request bodies, and response behavior.
- [Architecture](./local-proxy/architecture.md) — runtime flow and source integration points.
- [Troubleshooting](./local-proxy/troubleshooting.md) — common failures and evidence to collect.
- [Security](./local-proxy/security.md) — loopback, credentials, SSRF, and automatic failover considerations.

Bahasa Indonesia: [Panduan Local Proxy Bahasa Indonesia](./local-proxy.id.md).

## Quick start

```bash
# Install the official core separately, then expose it to the 9Router process.
export SING_BOX_BIN=/absolute/path/to/sing-box

npm install
npm run build
PORT=20128 HOSTNAME=127.0.0.1 NEXT_PUBLIC_BASE_URL=http://127.0.0.1:20128 npm run start
```

Open `http://127.0.0.1:20128/dashboard/local-proxy`, import a subscription or manual node, refresh/import nodes, enable at least one node, run **Test all nodes**, select a healthy node, and click **Start sidecar**.

The default listener is `http://127.0.0.1:20129`. The generated configuration is `<DATA_DIR>/local-proxy/sing-box.json` with restrictive file permissions.

## Important behavior

- The sidecar is disabled until started or auto-start is enabled.
- Health checks use a temporary one-node proxy process; they do not reuse the long-running sidecar.
- A yellow **Exclude Local Sidecar** provider toggle means that provider bypasses the local sidecar. A grey toggle means the provider may use it when active.
- `sing-box` and `nekobox_core` are both accepted when their installed version supports the generated configuration.
- Local-sidecar transport failures can trigger bounded node failover. Requests that already received response data are never replayed.
- Provider HTTP errors are not automatically treated as proxy-node failures.
