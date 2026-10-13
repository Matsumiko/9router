# Local Proxy configuration

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `SING_BOX_BIN` | unset | Explicit path to the proxy executable. Highest priority. |
| `SINGBOX_BIN` | unset | Alternative explicit executable variable. |
| `NINE_ROUTER_LOCAL_PROXY_PORT` | `20129` | Main loopback mixed-inbound port. Valid range: 1024–65535. |
| `NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT` | `20130` | Loopback Clash API controller port. |
| `NINE_ROUTER_PROXY_TEST_URL` | `http://cp.cloudflare.com/` | Fallback URL for per-node health checks. Dashboard and saved auto-test URLs override it. |
| `DATA_DIR` | platform default | Database and generated Local Proxy directory root. |
| `PORT` | `20128` in this checkout | 9Router dashboard/server port. |
| `HOSTNAME` | runtime-dependent | Dashboard bind address. |

Lowercase `http_proxy`, `https_proxy`, `all_proxy`, and `no_proxy` forms are accepted by the outbound fetch layer for environment proxies. Local Proxy itself applies process-local `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY` while running and clears values managed by 9Router when stopped.

Example:

```bash
DATA_DIR=/var/lib/9router \
SING_BOX_BIN=/usr/local/bin/sing-box \
NINE_ROUTER_LOCAL_PROXY_PORT=20729 \
npm run start
```

Restart 9Router after changing the listener port. The configured port is also used to identify whether a proxy URL is the 9Router local sidecar.

## Dashboard settings

The Local Proxy page persists these settings through `/api/settings`:

| Setting | Default | Range/values |
|---|---:|---|
| `localProxyEnabled` | `false` | Enables the Local Proxy feature state. |
| `localProxyAutoStart` | `false` | Starts the sidecar during application startup when enabled. |
| `localProxyAutoTestEnabled` | `false` | Enables the in-process automatic health scheduler. |
| `localProxyAutoTestIntervalMinutes` | `15` | Clamped to 5–120 minutes. |
| `localProxyAutoTestUrl` | `http://cp.cloudflare.com/` | Public HTTP(S) test URL. |
| `localProxyAutoFailoverEnabled` | `false` | Enables scheduled failover after repeated active-node failures. |
| `localProxyRotationStrategy` | `failover` | `failover`, `periodic`, or `weighted`. |
| `localProxyRotationIntervalMinutes` | `30` | Clamped to 15–240 minutes. |

Auto-start only has an effect when the Local Proxy feature is enabled. Automatic testing is independent of an open dashboard tab but lives in the 9Router process; restarting 9Router resets the in-memory timer and schedules it again from saved settings.

## Provider-level sidecar exclusion

The provider settings page has **Exclude Local Sidecar**:

- toggle yellow/on: this provider bypasses the local `127.0.0.1:<port>` sidecar;
- toggle grey/off: this provider may use the local sidecar when it is active.

Exclusion is provider-scoped. It does not disable the sidecar for other providers. It suppresses only the local sidecar route; an explicitly configured external proxy pool or relay can still be used. The exclusion policy is propagated to normal provider requests, OAuth refresh, project discovery, model discovery, and retry paths.

## Generated configuration

The main file is `<DATA_DIR>/local-proxy/sing-box.json`, written with mode `0600`. It contains:

- a mixed inbound bound to `127.0.0.1:<port>`;
- one outbound for each enabled supported node;
- a `direct` outbound;
- a `proxy-auto` selector;
- DNS routing for relay domains and remote DNS through the selected proxy;
- a final route through `proxy-auto`.

The sidecar does not expose its inbound beyond loopback. Use dashboard **Preview config** or `POST /api/local-proxy` with `{"action":"config"}` to inspect the generated JSON.

## Supported node inputs

The parser accepts URI-list input for:

- VLESS;
- VMess;
- Trojan;
- Shadowsocks, including supported `v2ray-plugin` URI parameters;
- HTTP/HTTPS;
- SOCKS5/SOCKS5H.

WebSocket host, TLS SNI, Reality public key/short ID, uTLS fingerprint, gRPC service name, HTTP upgrade, and related transport fields are preserved when represented by the input format. The installed core must support the resulting outbound type.

## Storage and permissions

Subscriptions and nodes are stored in the 9Router SQLite database. Generated configs and PID files are under `<DATA_DIR>/local-proxy`. Database exports can contain proxy credentials embedded in URLs or node data; treat them as secrets.
