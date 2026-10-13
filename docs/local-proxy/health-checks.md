# Local Proxy health checks

## What “healthy” means

A node is healthy when 9Router can start a temporary one-node sing-box listener and complete an HTTP request through that node to the configured Test URL. The check measures proxy transport reachability and HTTP response completion. It does **not** validate that the response body matches a particular status or application payload: a completed 2xx, 3xx, 4xx, or 5xx response still proves that the proxy path reached the target.

This follows the NekoBox-style reachability model. A node that reaches the target but receives an upstream HTTP error can still be marked `healthy`; investigate provider semantics separately.

## Default Test URL

```text
http://cp.cloudflare.com/
```

`cp.cloudflare.com` is a small public HTTP endpoint commonly used as a connectivity probe. A custom URL can be entered in the dashboard or supplied through `NINE_ROUTER_PROXY_TEST_URL` as the server fallback.

A URL must:

- use `http://` or `https://`;
- contain no username or password;
- resolve to a public address under the SSRF guard;
- be reachable from the 9Router host through the tested node.

Prefer a stable, small, public endpoint. Do not use a provider API that requires authentication as a generic node-health URL.

## How one node is tested

For each node, 9Router:

1. Loads the node from SQLite.
2. Validates the Test URL and checks that its resolved address is public.
3. Converts the node to a sing-box outbound.
4. Builds a temporary config containing that one outbound, a temporary mixed inbound on loopback, direct DNS, and DNS interception.
5. Starts a temporary sing-box-compatible process.
6. Waits for the temporary loopback port to accept connections.
7. Sends a GET request to the Test URL through an `undici` `ProxyAgent` pointed at the temporary listener.
8. Records `healthy` and elapsed milliseconds when an HTTP response completes, regardless of response status.
9. Records `degraded`/`unhealthy` and the transport error when the probe cannot complete.
10. Stops the temporary process and removes the temporary health config.

The long-running sidecar is not reused for this operation. This prevents the currently selected node from masking the result of another node.

Each test uses a bounded probe timeout. A timeout, DNS failure, TCP failure, TLS failure, proxy handshake failure, or temporary core startup failure is a failed health probe.

## Manual checks

### Dashboard

1. Open **Dashboard → Local Proxy**.
2. Set **Test URL** if the default is unsuitable.
3. Click the node-row health action for one node, or **Test all nodes**.
4. Inspect status, latency, `lastCheckedAt`, and `lastError`.

**Test all nodes** is scoped by the selected subscription filter. The batch route checks nodes sequentially and returns totals.

### API

One node:

```bash
curl -X POST http://127.0.0.1:20128/api/local-proxy/nodes/NODE_ID \
  -H 'Content-Type: application/json' \
  -d '{"testUrl":"http://cp.cloudflare.com/"}'
```

All nodes, optionally scoped to a subscription:

```bash
curl -X PUT http://127.0.0.1:20128/api/local-proxy/nodes \
  -H 'Content-Type: application/json' \
  -d '{"testUrl":"http://cp.cloudflare.com/","subscriptionId":"SUBSCRIPTION_ID"}'
```

A successful API response means the health operation was processed. Inspect each node's `healthStatus`; the probe itself may have failed while the API still returns HTTP 200 with a persisted result.

## Status values

| Status | Meaning |
|---|---|
| `unknown` | Node has not completed a health check yet. |
| `healthy` | The temporary proxy completed an HTTP request. |
| `degraded` | The latest probe did not complete successfully. The scheduler keeps a consecutive-failure counter for failover decisions but does not promote an ordinary probe result to `unhealthy`. |
| `unhealthy` | A terminal per-node check failure was recorded by the probe operation. |

Latency is measured from temporary probe start until the HTTP response is received. It is not a provider-generation latency metric.

## Automatic testing

Automatic testing is an in-process scheduler. It runs while the 9Router server process is alive and does not require an open dashboard tab.

Defaults:

- disabled;
- interval: 15 minutes, clamped to 5–120;
- URL: `http://cp.cloudflare.com/`;
- maximum concurrency: 4 nodes;
- automatic failover: disabled;
- failover threshold: 3 consecutive failures;
- failover cooldown: 5 minutes.

The scheduler checks enabled nodes only. A successful check resets the node's consecutive-failure counter. Failed probes remain `degraded` in the persisted node result while the counter is below or at the threshold; the third consecutive failure enables the auto-failover decision when a healthy replacement exists. A terminal probe exception can be recorded as `unhealthy`.

Scheduled rotation is separate from failover:

- `failover`: no scheduled rotation;
- `periodic`: select the next healthy node;
- `weighted`: choose among healthy alternatives with greater probability for lower measured latency.

Scheduled rotation requires automatic testing, an active selected node, and the configured rotation interval. Failover is evaluated first; a run that fails over does not also rotate.

## Interpreting failures

A failed health check proves that this node could not complete the probe at that time. It does not by itself prove that a provider, model, or all nodes are broken. Compare:

- the same Test URL through another node;
- direct access from the host;
- the node's generated outbound parameters;
- the temporary core log;
- the recorded `lastError` and timestamp.

A successful health check does not prove that every provider works. Provider TLS requirements, authentication, SNI, WebSocket behavior, upstream rate limits, and request payloads can fail after generic connectivity succeeds.
