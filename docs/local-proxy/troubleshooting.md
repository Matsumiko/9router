# Local Proxy troubleshooting

## Evidence first

Collect these before changing nodes or binaries:

```bash
curl -sS http://127.0.0.1:20128/api/local-proxy
curl -sS http://127.0.0.1:20128/api/health
ps -eo pid=,args= | grep -E '[s]ing-box|[n]ekobox_core'
$SING_BOX_BIN version
$SING_BOX_BIN check -c <DATA_DIR>/local-proxy/sing-box.json
```

Record the binary path/version, 9Router PID, build identity, selected node, target origin, `healthStatus`, `lastError`, `proxyPhase`, and timestamp. Redact UUIDs, passwords, tokens, subscription URLs with credentials, and full generated configs before sharing logs.

## `sing-box is unavailable`

Check the executable and process environment:

```bash
command -v sing-box || true
command -v nekobox_core || true
printf '%s\n' "${SING_BOX_BIN:-<unset>}"
"${SING_BOX_BIN:-sing-box}" version
```

Use an absolute `SING_BOX_BIN` path for systemd, Docker, or a supervisor with a restricted `PATH`. Confirm the file is executable and available to the same user running 9Router.

## Config check fails

```bash
$SING_BOX_BIN check -c <DATA_DIR>/local-proxy/sing-box.json
```

Common causes:

- installed core is older than the generated config schema;
- imported node uses an unsupported outbound or transport;
- malformed Reality, TLS, WebSocket, gRPC, or Shadowsocks plugin parameters;
- a second process changed the file while the sidecar was starting.

Use **Preview config**, validate with the exact selected binary, and test one node format at a time.

## Listener bind failure

The default ports are `20129` and `20130`:

```bash
ss -ltnp | grep -E ':20129|:20130' || true
```

Stop the unrelated process or choose `NINE_ROUTER_LOCAL_PROXY_PORT` and `NINE_ROUTER_LOCAL_PROXY_CONTROLLER_PORT`, then restart 9Router. Do not run a test core on the production ports.

## `fetch failed` through the sidecar

`fetch failed` is a symptom, not a root cause. Inspect the phase:

| Phase | Likely area |
|---|---|
| `dns` | target/node DNS, DNS detour, resolver reachability |
| `tcp_connect` | node address/port, firewall, relay availability |
| `tls` | SNI, certificate, TLS interception, Reality parameters |
| `proxy_tunnel` | proxy protocol/authentication or sidecar handshake |
| `response_headers` | upstream stalled or node path cannot reach target |
| `first_token` | response opened but failed before first body chunk |
| `stream_interruption` | established stream broke after data |

Then run the same Test URL through another healthy node. If both binaries pass the same target with the same config, changing binary is unlikely to fix a bad node or relay.

For a provider-specific failure, check **Exclude Local Sidecar**. Yellow/on bypasses the local sidecar for that provider; grey/off allows it. This does not disable external proxy pools or relays.

## Node is `unhealthy`

Inspect `lastError`, `lastCheckedAt`, and the selected Test URL. Confirm:

- the URL is public HTTP(S), with no credentials;
- the host resolves from the 9Router machine;
- node credentials, port, SNI, Host, path, and transport are correct;
- the exact binary can start the temporary config;
- outbound firewall permits the target;
- another node can complete the same probe.
Manual checks update a node immediately. Automatic checks keep their consecutive-failure counter in memory; the third consecutive failure enables the auto-failover decision when a healthy replacement exists. The persisted failed probe result remains `degraded` unless the probe operation records a terminal failure.

## Health check says `healthy`, provider request fails

This is expected when generic connectivity works but provider-specific behavior does not. Check provider authentication, API status, model availability, SNI/Host requirements, request format, rate limits, and response phase. A 5xx from the Test URL can still produce `healthy` because the test measures transport completion, not application success.

## Automatic testing never runs

Confirm:

1. `localProxyAutoTestEnabled` is enabled.
2. Dashboard save succeeded.
3. 9Router process is still running.
4. `GET /api/local-proxy` has a non-null `autoHealth.nextRunAt`.
5. The process can write `<DATA_DIR>/local-proxy`.

The scheduler is in-process. Restarting 9Router resets its timer.

## Auto failover does not switch

All conditions are required:

- automatic failover enabled;
- a selected active node;
- three consecutive failures for that selected node;
- another enabled node currently marked `healthy`;
- no five-minute cooldown.

No healthy replacement means no switch.

## Subscription imports no nodes

The response is capped at 2 MiB and must contain supported URI-list or JSON records. Inspect subscription `lastError`, confirm the URL returns the expected content, and check whether the provider uses an encrypted/proprietary format that must be decoded before import.

## A subscription fetch fails while health checks work

These are separate paths. Subscription refresh uses the normal proxy-aware outbound route and the active environment/sidecar; health checks use a temporary per-node process. Check the subscription URL, environment proxy, sidecar state, and subscription response separately.

## Do not misclassify model timeouts

A model timeout is not automatically a proxy defect. First capture transport phase and compare a direct/external route, another node, a small non-streaming request, and a streaming request. Do not rotate or delete nodes based only on an unclassified model timeout.
