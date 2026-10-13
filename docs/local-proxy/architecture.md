# Local Proxy architecture

## Runtime flow

```text
Provider request
      |
      v
9Router proxy-aware fetch
      |
      +-- provider excludes local sidecar? -- yes --> direct/external configured route
      |
      no
      v
HTTP(S)_PROXY / connection proxy
      |
      v
127.0.0.1:<local-proxy-port>
      |
      v
sing-box or nekobox_core
      |
      v
proxy-auto selector -> selected VLESS/VMess/Trojan/SS/HTTP/SOCKS node
      |
      v
upstream target
```

The sidecar is optional and local-only. The 9Router server generates the config and owns the process lifecycle; the proxy core owns protocol transport, DNS detour, TLS, WebSocket, Reality, and node connections.

## Main sidecar lifecycle

1. `startLocalProxy()` loads enabled nodes and converts supported node records into outbounds.
2. It chooses the selected node, preferring healthy nodes and lower measured latency when no valid selection exists.
3. It writes `<DATA_DIR>/local-proxy/sing-box.json` with mode `0600`.
4. It adopts a matching managed process if one already owns the generated config, otherwise spawns the resolved executable with `run -c`.
5. It waits for the mixed inbound and Clash API controller.
6. It applies process-local outbound proxy environment values for supported server-side fetches.
7. `stopLocalProxy()` stops the managed process and clears only environment values managed by 9Router.

The dashboard process and sidecar are separate processes. A dashboard rebuild does not inherently require a second sidecar.

## Health-check lifecycle

Health testing deliberately uses a different path from normal routing:

```text
node record
   -> SSRF/public URL validation
   -> one-node temporary sing-box config
   -> temporary loopback mixed inbound
   -> undici ProxyAgent GET
   -> response completion / transport error
   -> persist status, latency, timestamp, lastError
   -> stop child and remove temporary config
```

This isolates per-node testing from the active selector. The test is a connectivity probe, not an AI provider test.

## Request failover

`proxyAwareFetch` classifies transport failures as DNS, TCP connect, TLS, proxy tunnel, response headers, first token, stream interruption, or cancellation. For a local sidecar it delegates candidate selection to `__nineRouterRequestProxyFailover` in the Local Proxy manager.

The manager serializes failover, excludes already tried nodes, selects enabled non-unhealthy candidates, and records bounded evidence. Bodies that cannot be replayed are not retried. Responses that have begun are not replayed. Direct fallback is determined by method and strict-proxy policy.

## DNS and route model

Generated configs use local DNS for node/relay resolution and remote DNS through the selected proxy for target domains. Relay domains are routed to direct DNS so the proxy endpoint itself can be resolved without a loop. The generated route sends normal traffic to `proxy-auto`, while explicit direct exceptions can be added by the runtime config generator.

## Provider exclusion

`resolveProviderConnectionProxyConfig()` combines provider connection settings with the provider strategy setting `excludeLocalProxy`. When the configured connection proxy is the 9Router local sidecar and exclusion is enabled, the resolved policy disables that local proxy and marks `bypassLocalProxy`. External proxy pools and relay URLs are not automatically removed.

The policy is passed to normal executors and token/model/project refresh paths. This prevents a provider from using the sidecar during an OAuth refresh even when its first model request was direct.

## Source integration points

- `src/app/(dashboard)/dashboard/local-proxy/page.js` — dashboard state and actions.
- `src/app/api/local-proxy/route.js` — runtime status, start/stop/config, select/rotate.
- `src/app/api/local-proxy/nodes/route.js` — list, import, batch health, degraded deletion.
- `src/app/api/local-proxy/nodes/[id]/route.js` — node CRUD and health.
- `src/app/api/local-proxy/subscriptions/` — subscription CRUD and refresh.
- `src/lib/db/repos/proxySubscriptionsRepo.js` — parser and SQLite persistence.
- `src/lib/network/localProxyManager.js` — core detection, config generation, lifecycle, selector, probes, request failover.
- `src/lib/network/localProxyHealthScheduler.js` — automatic testing, thresholds, concurrency, scheduled failover/rotation.
- `open-sse/utils/proxyFetch.js` — proxy policy, transport phases, DNS bypass, replay/fallback boundaries.
- `src/lib/network/connectionProxy.js` — provider proxy and local-sidecar exclusion resolution.
- `custom-server.js` — shutdown hook and process lifecycle integration.
