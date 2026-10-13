# Local Proxy API reference

The routes below are used by the dashboard. Authentication/middleware still applies to the deployment. Examples assume `http://127.0.0.1:20128`.

## Runtime

### `GET /api/local-proxy`

Returns runtime state, selected node, subscriptions, nodes, health scheduler state, runtime fingerprint, and bounded request-failover evidence.

Important fields:

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

`config` rebuilds the generated config and returns its JSON without starting the sidecar.

### `PUT /api/local-proxy`

Select:

```json
{"nodeId":"NODE_ID"}
```

Rotate:

```json
{}
```

## Nodes

### `GET /api/local-proxy/nodes`

Optional query: `subscriptionId=SUBSCRIPTION_ID`.

### `POST /api/local-proxy/nodes`

Import one or more newline-separated URLs:

```json
{"urls":"vless://...\nss://...\ntrojan://..."}
```

Returns `201` with `nodes`, `importedNodes`, and `rejectedLines`.

### `PUT /api/local-proxy/nodes`

Run sequential batch health checks:

```json
{"testUrl":"http://cp.cloudflare.com/","subscriptionId":"OPTIONAL_ID"}
```

Returns `nodes`, `testedNodes`, `healthyNodes`, and `unhealthyNodes`.

### `DELETE /api/local-proxy/nodes`

Only `degraded` bulk deletion is accepted:

```json
{"healthStatus":"degraded","subscriptionId":"OPTIONAL_ID"}
```

### `GET /api/local-proxy/nodes/:id`

Returns `{ "node": ... }`, or `404`.

### `POST /api/local-proxy/nodes/:id`

Run a health check:

```json
{"testUrl":"http://cp.cloudflare.com/"}
```

The route can return HTTP 200 with a node result whose `healthStatus` is `unhealthy`; inspect the node result.

### `PUT /api/local-proxy/nodes/:id`

Updates supported metadata and `enabled`. `port` must be an integer from 1 to 65535.

### `DELETE /api/local-proxy/nodes/:id`

Deletes one node.

## Subscriptions

### `GET /api/local-proxy/subscriptions`

Returns `{ "subscriptions": [] }`.

### `POST /api/local-proxy/subscriptions`

```json
{"name":"Example","url":"https://provider.example/subscription"}
```

Only HTTP(S) URLs are accepted. Returns `201`.

### `GET /api/local-proxy/subscriptions/:id`

Returns one subscription or `404`.

### `PUT /api/local-proxy/subscriptions/:id`

Accepts non-empty `name` and/or HTTP(S) `url`. Editing does not refresh or delete imported nodes.

### `POST /api/local-proxy/subscriptions/:id`

Fetches and parses the subscription. Successful refresh replaces nodes imported by that subscription. A failed refresh returns `502` and preserves existing nodes.

### `DELETE /api/local-proxy/subscriptions/:id`

Deletes the subscription and its imported nodes.

## Settings

`GET /api/settings` and `PATCH /api/settings` manage the persisted scheduler values:

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

The settings route reconfigures the scheduler after a successful update when automatic-test fields change.

## Error handling

Errors are normally JSON `{ "error": "..." }`. Runtime start/config errors return `400` from the action route; missing resources return `404`; subscription refresh failures return `502`. Health result failures are represented in node fields so callers can inspect `healthStatus` and `lastError`.
