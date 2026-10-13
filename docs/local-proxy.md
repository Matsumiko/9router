# Local Proxy and sing-box

Local Proxy is an optional, local-only sing-box sidecar in 9Router. It routes supported 9Router server-side outbound HTTP requests through a selected proxy node. It does not deploy or modify a remote VPS.

## What it provides

- Local sing-box runtime with start/stop controls.
- Subscription import and refresh.
- Subscription editing without deleting the provider or its nodes.
- Manual import of one or more proxy URLs.
- VLESS, VMess, Trojan, Shadowsocks, HTTP, and SOCKS5 nodes.
- Shadowsocks with `v2ray-plugin` URI parameters.
- Enable/disable individual nodes.
- Per-node URL health checks.
- Batch health checks for all nodes or one selected subscription.
- Healthy-node rotation.
- Optional server-side automatic health checks.
- Optional automatic failover after repeated failures.
- Persistent sidecar auto-start setting from the Local Proxy dashboard.
- Generated sing-box configuration preview.

The sidecar is disabled until it is started from the dashboard or auto-start is enabled. Automatic health testing is also disabled by default. Auto-start runs only when both the local sidecar and auto-start settings are enabled.

## Runtime/build fingerprint

`GET /api/health` and `GET /api/local-proxy` expose the same `runtimeFingerprint` object. It contains the production bundle path, server PID, build timestamp (or Next `BUILD_ID` file timestamp), build identity, and source identity without including environment secrets:

```json
{
  "runtimeFingerprint": {
    "bundlePath": ".next/standalone",
    "serverPid": 12345,
    "buildId": "<next-build-id>",
    "buildTimestamp": "<iso-timestamp>",
    "buildIdentity": "<stable-hash>",
    "packageVersion": "0.5.99",
    "sourceIdentity": "version-0.5.99"
  }
}
```

`sourceIdentity` uses `NINE_ROUTER_SOURCE_ID`, `GIT_COMMIT_SHA`, or `GITHUB_SHA` when supplied by the build environment; otherwise it falls back to the package version. `buildIdentity` is a short hash of the non-secret build/source metadata.

## Transport failure phases

Proxy transport errors carry a non-secret `proxyPhase` field and log the target/proxy origin in sanitized form. The phase values are:

- `dns` — hostname resolution failed;
- `tcp_connect` — socket connection failed or timed out;
- `tls` — certificate or TLS negotiation failed;
- `proxy_tunnel` — proxy authentication/tunnel negotiation failed;
- `response_headers` — the upstream did not produce response headers;
- `first_token` — response headers arrived, but the first body chunk failed;
- `stream_interruption` — a body stream failed after at least one chunk;
- `cancelled` — the caller aborted the request.

Response-body failures are annotated lazily when the caller reads the body, so a `200` response can still produce a transport-phase error later. These annotations are diagnostic only; they do not change retry, failover, or direct-fallback policy.

## Structured request failover evidence

The authenticated `GET /api/local-proxy` response exposes `requestFailoverCount` and the latest bounded `requestFailoverEvidence` entries. Each entry contains `target`, `fromNodeId`, `toNodeId`, `attempt`, `phase`, `reason`, `directFallbackAllowed`, `switched`, and timestamp `at`. Target and reason values are sanitized; credentials, request paths, query strings, and bodies are not stored.

Evidence is recorded at the Local Proxy manager—the authority that selects the replacement node—so a failed selection and a successful switch are both visible. The evidence is diagnostic and does not itself trigger another retry or failover.

### Request-level failover example

A request sent through the active sidecar node can trigger failover before an upstream response exists:

1. Node A fails at TCP connect.
2. The manager marks Node A as `degraded`, selects eligible Node B, and records evidence.
3. The same request is retried through Node B instead of being sent directly.

Provider-test connections addressed to the local sidecar skip the separate standalone proxy probe because that probe cannot represent the selector’s active route. Their actual provider request still goes through `proxyAwareFetch`, so the request-level retry supplies the meaningful proxy signal.

```json
{
  "at": "<iso-timestamp>",
  "target": "http://upstream.example",
  "fromNodeId": "node-a",
  "toNodeId": "node-b",
  "attempt": 1,
  "phase": "tcp_connect",
  "reason": "fetch failed",
  "directFallbackAllowed": true,
  "switched": true
}
```

The dashboard’s **Failover observability** card displays this evidence as:

- **Active node:** replacement node, or `-` when no node is selected;
- **Failover count:** number of recorded request-failover events;
- **Last phase:** transport phase from the latest evidence;
- **Direct fallback allowed:** number of evidence entries permitting direct egress;
- **Last failover switched/not switched**, timestamp, **From → to**, **Attempt**, **Target**, fallback policy, and reason.

`Target` contains only the URL origin. Evidence is in-memory, limited to the latest 50 entries, and lost on process restart.

## Requirements

- Node.js 20 or newer for source execution.
- A sing-box binary installed on the same machine as 9Router.
- A 9Router process with write access to its data directory.
- Public HTTP(S) access to the configured health-check URL.

The binary must include the outbound types required by the imported nodes. The application uses the executable configured through `SING_BOX_BIN` or `SINGBOX_BIN`; if neither is set, it falls back to `sing-box` on `PATH`.
9Router does not bundle sing-box. Install the binary separately on the same machine, verify it, then point 9Router to the executable with `SING_BOX_BIN`.

### Debian or Ubuntu

Use the official sing-box APT repository:

```bash
sudo mkdir -p /etc/apt/keyrings
sudo curl -fsSL https://sing-box.app/gpg.key -o /etc/apt/keyrings/sagernet.asc
sudo chmod a+r /etc/apt/keyrings/sagernet.asc
echo 'Types: deb
URIs: https://deb.sagernet.org/
Suites: *
Components: *
Enabled: yes
Signed-By: /etc/apt/keyrings/sagernet.asc' | sudo tee /etc/apt/sources.list.d/sagernet.sources
sudo apt-get update
sudo apt-get install sing-box
```

### RHEL, Fedora, or other DNF systems

```bash
sudo dnf config-manager --add-repo https://sing-box.app/sing-box.repo
sudo dnf install sing-box
```

If `config-manager` is unavailable, install the DNF plugin package first:

```bash
sudo dnf -y install dnf-plugins-core
```

### Arch Linux

Install the package from the AUR using your preferred AUR helper:

```bash
paru -S sing-box
```

### macOS or Linux with Homebrew

```bash
brew install sing-box
```

### Windows

With WinGet:

```powershell
winget install SagerNet.sing-box
```

With Scoop:

```powershell
scoop install sing-box
```

With Chocolatey:

```powershell
choco install sing-box
```

### Manual Linux installation

The official installer can install the latest release package on supported Linux distributions:

```bash
curl -fsSL https://sing-box.app/install.sh | sh
```

Review the installer and release source according to your organization's software-supply-chain policy before using a remote install script. For a pinned version:

```bash
curl -fsSL https://sing-box.app/install.sh | sh -s -- --version <version>
```

### Verify the binary

```bash
sing-box version
sing-box check --help
```

Then configure 9Router. If `sing-box` is on `PATH`, this is enough:

```bash
export SING_BOX_BIN=sing-box
```

For a binary installed outside `PATH`, use its absolute path:

```bash
export SING_BOX_BIN=/usr/local/bin/sing-box
```

On Windows PowerShell:

```powershell
$env:SING_BOX_BIN = "C:\\Program Files\\sing-box\\sing-box.exe"
```

The variable must be present in the environment of the 9Router process, not only in an unrelated terminal. If you use systemd, Docker, or another process supervisor, configure the variable in that service's environment.

Official reference: [sing-box package manager installation](https://sing-box.sagernet.org/installation/package-manager/).

## Installation

### Run this modified source checkout (recommended)

This repository is the authoritative installation path for the modified `matsumiko` build. Clone the repository, install dependencies locally, and build or run it locally:

```bash
git clone https://github.com/Matsumiko/9router.git
cd 9router
cp .env.example .env
npm install

export SING_BOX_BIN=/absolute/path/to/sing-box
PORT=20128 HOSTNAME=127.0.0.1 \
  NEXT_PUBLIC_BASE_URL=http://127.0.0.1:20128 \
  npm run dev
```

For a production build:

```bash
npm run build
PORT=20128 HOSTNAME=127.0.0.1 \
  NEXT_PUBLIC_BASE_URL=http://127.0.0.1:20128 \
  npm run start
```

Open:

```text
http://127.0.0.1:20128/dashboard/local-proxy
```


### Install the upstream npm package

This is a separate upstream distribution path. `npm install -g 9router` does **not** install this modified checkout; it installs the published upstream package and may not include the Local Proxy changes documented here.

```bash
npm install -g 9router
9router
```

Use it only when you intentionally want the published upstream `9router` package. For the modified Local Proxy implementation documented here, clone or copy this repository and run it from source as shown above.

Install sing-box separately using the official release for the host operating system, then expose it to 9Router:

```bash
export SING_BOX_BIN=/absolute/path/to/sing-box
```

If the binary is already on `PATH`, no extra variable is required:

```bash
sing-box version
```

The dashboard is at `/dashboard/local-proxy`. The default Local Proxy listener is `127.0.0.1:20129` unless `NINE_ROUTER_LOCAL_PROXY_PORT` is configured.

The 9Router process needs write access to its data directory. The generated sing-box configuration is stored at `<DATA_DIR>/local-proxy/sing-box.json` with mode `0600`.


## First-time setup

1. Open **Dashboard → Local Proxy**.
2. Confirm the Runtime card reports sing-box availability.
3. Choose one input method:
   - add a subscription URL;
   - paste proxy URLs into **Add manual node**.
4. For a subscription, click **Refresh** to import its nodes.
5. Enable the nodes that should be available for routing.
6. Set the **Test URL** if the default is not appropriate.
7. Use **Test all nodes** to populate health and latency.
8. Select a node with **Use**, or click **Rotate healthy**.
9. Click **Start sidecar**.
10. Verify the generated configuration with **Preview config** if needed.

Starting the sidecar applies the local proxy to 9Router's supported server-side outbound fetch path. Stopping it clears only proxy environment values managed by 9Router.

### Restarting or rebuilding 9Router

The Local Proxy sidecar is an independent `sing-box` process. Rebuilding or restarting the dashboard does not require starting a second sidecar. On startup, 9Router reuses a managed `sing-box` process that already owns the generated configuration and listener. If another process owns `127.0.0.1:20129`, the dashboard reports sing-box's diagnostic, including the bind failure, instead of only an exit code.

## Subscription management

### Add a subscription

The subscription form requires:

- a display name;
- an `http://` or `https://` URL.

Click **Add subscription**, then **Refresh** on the provider row. Refresh downloads the provider response, parses supported records, replaces that subscription's previously imported nodes, and updates `lastFetchedAt`.

Subscription responses are limited to 2 MiB. The parser accepts URI-list and supported JSON subscription content.

### Edit a subscription

Click **Edit** on a provider row. The modal updates the name and/or URL with `PUT /api/local-proxy/subscriptions/:id`.

Editing does not delete imported nodes. Click **Refresh** separately when the new URL should be fetched. A failed refresh leaves the existing imported nodes in place and records the error on the subscription.

### Delete a subscription

Delete removes the subscription and all nodes imported from it. Manually imported nodes are not attached to a subscription and are not removed by deleting a provider.

## Manual node import

Click **Add manual node** and paste one or more URLs, one per line:

```text
vless://...
vmess://...
trojan://...
ss://...
http://...
socks5://...
```

Blank lines and lines beginning with `#` are ignored. Each valid URL becomes a separate local node. The import response reports the number imported and rejected.

Example VLESS URL:

```text
vless://UUID@example.com:443?security=tls&type=ws&host=example.com&path=%2F#Example
```

Example Shadowsocks URL:

```text
ss://BASE64_METHOD_AND_PASSWORD@example.com:443#Example%20SS
```

Shadowsocks with v2ray-plugin is also supported:

```text
ss://BASE64_METHOD_AND_PASSWORD@example.com:443?plugin=v2ray-plugin%3Btls%3Bmux%3D0%3Bmode%3Dwebsocket%3Bpath%3D%2Fproxy%3Bhost%3Dexample.com#Example%20SS
```

The parser converts the plugin value into sing-box's `plugin` and `plugin_opts` fields. The sing-box binary must support the requested plugin and its options.

## Node operations

Each node row provides:

- **Toggle**: enable or disable the node.
- **Use**: select the node for the sidecar.
- **Per-node health action**: test that node through a temporary sing-box listener.
- **Delete**: remove the local node.
- **Status**: `unknown`, `healthy`, `degraded`, or `unhealthy`.
- **Latency and timestamp**: shown after a health check.

Disabled nodes are excluded from the sidecar configuration and automatic health checks. The node search covers name, type, and server. The subscription filter scopes the visible nodes and the **Test all nodes** operation.

### Rotate healthy

**Rotate healthy** moves the selected node to the next enabled node whose status is not `unhealthy`. When the sidecar is running, selection is applied through its loopback Clash API selector without restarting the sidecar; if that API is unavailable, the existing restart path is used.

Request-level transport failover is serialized through the same selected-node state. A failed local-sidecar connection may switch to another eligible enabled node, up to three candidates per request. Requests that already received an upstream response are not replayed, and HTTP provider errors are not treated as node failures. After sidecar candidates are exhausted, direct fallback is allowed for `GET`, `HEAD`, and `OPTIONS`; non-idempotent methods (including chat/stream `POST`) remain proxy-only unless the caller explicitly passes `allowDirectFallback: true`. `strictProxy: true` still fails rather than using direct egress.

### Test all nodes

**Test all nodes** runs the configured Test URL through every node in the current subscription scope. It updates health status, latency, timestamp, and error fields, then displays healthy and unhealthy totals.

Manual batch testing runs through `PUT /api/local-proxy/nodes` and tests nodes sequentially. Automatic testing uses a bounded concurrency of four nodes.

## Automatic node testing and rotation

The **Automatic node testing** card controls a server-side scheduler. It continues while the 9Router server is running and does not depend on an open dashboard tab.

Settings:

| Setting | Default | Behavior |
| --- | ---: | --- |
| Enabled | `false` | Starts or stops the background scheduler. |
| Test interval | 15 minutes | Runtime clamps accepted values to 5–120 minutes. |
| Test URL | `https://www.gstatic.com/generate_204` | Public HTTP(S) URL requested through each enabled node. |
| Auto failover | `false` | Optional switch to another healthy node after three consecutive failures of the active node. |
| Rotation strategy | `failover` | `failover` disables scheduled rotation; `periodic` advances to the next healthy node; `weighted` selects a healthy node with higher probability when its measured latency is lower. |
| Rotation interval | 30 minutes | Runtime clamps accepted values to 15–240 minutes. |

Scheduled rotation requires automatic testing and an active selected node. Failover is evaluated first; when failover changes the active route, that run does not also perform scheduled rotation. Rotation only selects nodes reported `healthy`, never `degraded` or `unhealthy`. A live sidecar uses the selector API so existing connections are not recreated by a process restart.

Request failover is separate from scheduled health testing but uses the same node health records and selected-node authority. It only handles transport failures before an upstream response exists and has a maximum of three candidate attempts. If no eligible proxy remains, the caller's existing direct-fallback or strict-proxy policy decides whether direct egress is allowed.

### Observed provider test notes

The latest fresh-bundle run used a clean production build, a restarted standalone server, and a newly started sidecar. `ag/gemini-pro-agent` returned HTTP 200 in about 4.5 seconds but produced empty content with `finish_reason=max_tokens`. `ag/gemini-3.1-pro-low` and both DeepSeek probes did not complete within their bounded client timeouts during that run. All four model IDs were present in `/v1/models`; timeout results therefore require phase-level evidence before being classified as proxy defects.

## Improvement priority register

This register is the source of truth for Local Proxy follow-up work. Do not repeat a lower-priority item while a higher-priority item is incomplete. A result is `verified` only when the latest source has been built, the running server has been restarted from that build, and the changed behavior has been exercised.

| Priority | Item | Owner | Dependency | Acceptance criterion | Status |
|---|---|---|---|---|---|
| P0 | Build/runtime fingerprint | Server bootstrap, `/api/health`, Local Proxy status | None | Every test records build ID, bundle directory, server PID, and source/build timestamp; the running PID must match the freshly built bundle before model testing. | Next |
| P0 | Safe direct fallback for non-idempotent requests | `open-sse/utils/proxyFetch.js` and provider request policy | P0 fingerprint | POST chat/stream does not silently replay through direct egress after proxy exhaustion unless explicitly allowed; GET/HEAD behavior remains policy-controlled. | Next |
| P0 | Preserve no-replay stream invariant | `proxyFetch` and stream callers | P0 fallback policy | A request that received response headers or emitted a token is never replayed to another node or direct egress. | Designed; needs regression proof |
| P1 | Phase-aware timeout classification | `proxyFetch` | P0 fallback policy | Logs distinguish DNS, TCP connect, TLS/proxy tunnel, response-header, first-token, provider HTTP, and stream interruption failures. | Implemented; smoke verified |
| P1 | Structured failover evidence | Local Proxy manager and request logs | P1 timeout classification | Each failover records target, from-node, to-node, attempt, phase, reason, and whether direct fallback was allowed. | Implemented; request context smoke verified |
| P1 | Empty successful response validation | Provider response/adapter layer | P1 evidence | HTTP 200 with empty content and no tool call is surfaced as an invalid provider response, not reported as a successful chat. | Implemented; JSON and streaming completion validation |
| P2 | Deterministic synthetic failover tests | Local Proxy test harness | P0/P1 behavior | Invalid node A plus valid node B proves switch, degraded marking, successful request, and no direct fallback; all-invalid cases prove POST and GET policies separately. | Manager A→B and all-candidates-failed tests added; runtime harness pending |
| P2 | Dashboard failover observability | Local Proxy dashboard/API | P1 structured evidence | Runtime card shows active node, last failover, failure phase, failover count, and direct-fallback count. | Next |

### Confirmed versus unverified findings

Confirmed by the latest fresh-bundle run:

- clean production build completed successfully;
- the rebuilt standalone server was restarted and identified by a new PID;
- `/api/local-proxy` returned `200` from the rebuilt bundle;
- `selectedNodeId` was populated in the rebuilt runtime;
- sing-box config validation passed;
- the selector had 103 candidates and a live active node;
- `ag/gemini-pro-agent` returned HTTP 200 with empty content and `finish_reason=max_tokens`;
- the DeepSeek probes exceeded the bounded test timeout.

Not yet proven and MUST NOT be treated as a defect until tested:

- that the DeepSeek timeouts were caused by the proxy node rather than provider or adapter latency;
- that request-level failover switches nodes during a real transport failure from the API path;
- that direct fallback duplicated a provider POST;
- that the empty Gemini response is caused by routing rather than token/reasoning budget or adapter mapping.

## Regression checklist before declaring a change complete

Run the checklist in this order:

1. Build the source and record the build ID, bundle path, build exit code, and stderr.
2. Stop the previous server and sidecar; start the freshly built bundle.
3. Verify server PID, bundle path, `/api/health`, `/api/local-proxy`, and `selectedNodeId`.
4. Run `sing-box check` against the generated config.
5. Verify the selector's current node and candidate count through the loopback Clash API.
6. Test one non-streaming request and one streaming request through the selected model.
7. Test a transport failure with a synthetic invalid node and verify bounded failover.
8. Verify an HTTP provider error does not rotate the node.
9. Verify a response that has started is never replayed.
10. Verify POST exhaustion follows the explicit direct-fallback policy and does not silently duplicate the request.
11. Verify GET/HEAD exhaustion follows its configured direct-fallback policy.
12. Record the exact model, node, build ID, PID, elapsed time, status, finish reason, and response-content outcome.

### Stop conditions

- Stop and fix P0 before running P1/P2 interpretation tests.
- Stop and rebuild if the server PID or bundle path does not match the current source build.
- Stop and classify the failure if a model times out; do not label it a proxy defect without phase evidence.
- Stop if a POST is replayed after response headers or tokens have been sent.


Save the settings with **Save auto test** or **Save rotation**. The dashboard shows the last health run, next scheduled run, and latest rotation.

### Failure policy

Automatic testing is intentionally conservative:

- first or second consecutive failure: `degraded`;
- third consecutive failure: `unhealthy`;
- successful test: `healthy` and failure counter reset;
- at most four node checks run concurrently;
- each node check uses the existing sing-box temporary listener and probe timeout;
- automatic failover requires three consecutive failures of the selected node;
- failover has a five-minute cooldown;
- failover is skipped when no healthy replacement exists.

Automatic failover is off by default. Enable it only when changing the active route without operator confirmation is acceptable.
### sing-box binary detection

The runtime resolves the executable in this order:

1. `SING_BOX_BIN`, when set to an executable path;
2. `sing-box` in the process `PATH`;
3. `$HOME/.local/bin/sing-box`;
4. `/usr/local/bin/sing-box`, `/usr/bin/sing-box`, or `/bin/sing-box`.

The Local Proxy page displays the resolved path. If no executable is found, start returns an actionable installation error instead of a raw `ENOENT` spawn error.
### IPv4-only DNS strategy

Generated sing-box configurations use DNS strategy `ipv4_only`. This avoids failed AAAA connections on hosts without an IPv6 default route while preserving the original hostname for TLS SNI and WebSocket `Host` headers. The setting applies to both the main sidecar and temporary health-check instances.

## Health-check URL

The default URL is:

```text
https://www.gstatic.com/generate_204
```

A health URL must:

- use `http://` or `https://`;
- have no embedded username or password;
- resolve to a public address under the SSRF guard.

For the per-node API fallback, set:

```bash
export NINE_ROUTER_PROXY_TEST_URL=https://www.gstatic.com/generate_204
```

The dashboard Test URL and automatic-test setting take precedence for their respective operations.

## Configuration and environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `SING_BOX_BIN` | unset | Absolute path to the sing-box executable. |
| `SINGBOX_BIN` | unset | Alternative executable variable. |
| `NINE_ROUTER_LOCAL_PROXY_PORT` | `20129` | Local mixed-inbound listener port, valid range 1024–65535. |
| `NINE_ROUTER_PROXY_TEST_URL` | `https://www.gstatic.com/generate_204` | Server fallback health URL. |
| `PORT` | project/runtime dependent | 9Router dashboard HTTP port. |
| `HOSTNAME` | runtime dependent | Dashboard bind address. |
| `NEXT_PUBLIC_BASE_URL` | runtime dependent | Public/base URL used by the dashboard. |

For example:

```bash
NINE_ROUTER_LOCAL_PROXY_PORT=20729 npm run dev
```

produces:

```text
http://127.0.0.1:20729
```

Restart the 9Router process after changing the port. The status API and dashboard Runtime card report the configured listener, and the same configured value determines which `127.0.0.1` HTTP proxy URL is treated as the local sidecar.

The generated configuration is stored at:

```text
<DATA_DIR>/local-proxy/sing-box.json
```

The file is written with mode `0600`. Temporary health configurations are created under the same directory and removed after each check.

## API reference

The routes below are used by the dashboard. Authentication and deployment-specific middleware still apply when the instance requires login or API access.

### Get Local Proxy status

```http
GET /api/local-proxy
```

Returns runtime state, subscription rows, node rows, selected node, and automatic-health scheduler state:

```json
{
  "available": true,
  "runtime": "sing-box",
  "running": false,
  "proxyUrl": "http://127.0.0.1:20129",
  "autoHealth": {
    "running": false,
    "lastRunAt": null,
    "nextRunAt": null,
    "lastResult": null
  },
  "subscriptions": [],
  "nodes": []
}
```

### Start, stop, or preview configuration

```http
POST /api/local-proxy
Content-Type: application/json
```

Request bodies:

```json
{"action":"start"}
{"action":"stop"}
{"action":"config"}
```

`config` returns the generated JSON without starting the sidecar.

### Select or rotate a node

```http
PUT /api/local-proxy
Content-Type: application/json
```

Select a node:

```json
{"nodeId":"NODE_ID"}
```

Rotate to the next eligible node:

```json
{}
```

### List nodes

```http
GET /api/local-proxy/nodes
GET /api/local-proxy/nodes?subscriptionId=SUBSCRIPTION_ID
```

### Import manual nodes

```http
POST /api/local-proxy/nodes
Content-Type: application/json
```

```json
{
  "urls": "vless://...\nss://...\ntrojan://..."
}
```

Response:

```json
{
  "nodes": [],
  "importedNodes": 3,
  "rejectedLines": 0
}
```

### Test nodes in a batch

```http
PUT /api/local-proxy/nodes
Content-Type: application/json
```

```json
{
  "testUrl": "https://www.gstatic.com/generate_204",
  "subscriptionId": "OPTIONAL_SUBSCRIPTION_ID"
}
```

Response fields include `testedNodes`, `healthyNodes`, `unhealthyNodes`, and the updated `nodes` array.

### Test, update, or delete one node

```http
POST /api/local-proxy/nodes/NODE_ID
Content-Type: application/json
```

```json
{"testUrl":"https://www.gstatic.com/generate_204"}
```

```http
PUT /api/local-proxy/nodes/NODE_ID
DELETE /api/local-proxy/nodes/NODE_ID
```

The update route supports node metadata and `enabled` state. Health checks return HTTP 200 with a persisted health result even when the proxy probe itself fails; inspect `healthStatus` and `lastError`.

### Subscription routes

```http
GET    /api/local-proxy/subscriptions
POST   /api/local-proxy/subscriptions
GET    /api/local-proxy/subscriptions/SUBSCRIPTION_ID
PUT    /api/local-proxy/subscriptions/SUBSCRIPTION_ID
POST   /api/local-proxy/subscriptions/SUBSCRIPTION_ID
DELETE /api/local-proxy/subscriptions/SUBSCRIPTION_ID
```

Create:

```json
{
  "name": "Example provider",
  "url": "https://provider.example/subscription"
}
```

Edit:

```json
{
  "name": "Updated provider",
  "url": "https://provider.example/new-subscription"
}
```

The edit route accepts HTTP(S) URLs only and rejects empty names, empty URLs, and empty update payloads.

### Settings routes used by automatic testing

```http
GET   /api/settings
PATCH /api/settings
```

Relevant PATCH body:

```json
{
  "localProxyAutoTestEnabled": true,
  "localProxyAutoTestIntervalMinutes": 15,
  "localProxyAutoTestUrl": "https://www.gstatic.com/generate_204",
  "localProxyAutoFailoverEnabled": false,
  "localProxyRotationStrategy": "failover",
  "localProxyRotationIntervalMinutes": 30
}
```

The strategy accepts `failover`, `periodic`, or `weighted`. The scheduler is reconfigured immediately after a successful settings update.

## Integration behavior

When the sidecar starts, 9Router generates a sing-box config containing:

- a local mixed inbound on `127.0.0.1:<NINE_ROUTER_LOCAL_PROXY_PORT>`;
- one outbound for each enabled, supported node;
- a direct outbound;
- a `proxy-auto` selector containing all enabled supported nodes;
- a final route pointing to `proxy-auto`;

9Router then applies the loopback proxy to its supported server-side outbound requests through `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`. `NO_PROXY` includes loopback hosts. The environment is process-local and is cleared by 9Router when the sidecar stops. OAuth hosts `oauth2.googleapis.com` and `www.googleapis.com` are routed direct by the sidecar before the selector.

Health checks do not reuse the long-running sidecar. Each check builds a temporary one-node sing-box configuration, starts a temporary local listener, sends the probe through it, stores the result, and removes the temporary configuration.

## Data storage and backup

Subscriptions and local nodes are stored in the 9Router SQLite database. They are included in database export/import.

Backups can contain credentials embedded in proxy URLs or node fields. Treat exported database files as secrets and protect their file permissions.

Deleting a subscription deletes only nodes with that subscription's `subscriptionId`. Manually imported nodes have a null subscription ID and must be deleted separately.

## Troubleshooting

### `sing-box is unavailable` or start fails

Check the executable:

```bash
"$SING_BOX_BIN" version
```

Then confirm the process inherits the variable:

```bash
command -v sing-box
printf '%s\n' "$SING_BOX_BIN"
```

Use an absolute path when 9Router is launched by systemd, Docker, or another supervisor.

### `No enabled supported sing-box proxy nodes`

At least one node must be enabled and convertible to a sing-box outbound. Check the node type, enable toggle, and **Preview config** output.

### Shadowsocks says unsupported

Plain Shadowsocks and `v2ray-plugin` are supported. Confirm that:

- the URI contains a valid method/password payload;
- the plugin value is URL-encoded correctly;
- the installed sing-box build supports the plugin;
- the generated configuration passes the installed binary's `sing-box check` command.

Example check:

```bash
sing-box check -c <DATA_DIR>/local-proxy/sing-box.json
```

### Health status is `unhealthy`

Inspect the node's `lastError`, then check:

- the Test URL is public HTTP(S);
- DNS resolves from the 9Router host;
- the node credentials and port are valid;
- the node's transport parameters match the provider;
- the sing-box binary can start a temporary config;
- outbound firewall rules allow the destination.

A manual check records a result immediately. Automatic checks require three consecutive failures before marking a node unhealthy.

### Automatic tests never run

Confirm:

1. **Enabled** is checked.
2. **Save auto test** was clicked.
3. The 9Router server process is still running.
4. `GET /api/local-proxy` reports a non-null `autoHealth.nextRunAt`.
5. The process can write `<DATA_DIR>/local-proxy`.

The scheduler is in-process. Restarting 9Router resets its in-memory timer and schedules a new run from the saved settings.

### Auto failover does not switch nodes

Failover requires all of the following:

- Auto failover enabled;
- a selected active node;
- three consecutive failures of that selected node;
- another enabled node with `healthy` status;
- no active five-minute cooldown.

If no replacement is healthy, the active node is left unchanged.

### Subscription refresh returns no nodes

The parser supports URI-list and selected JSON formats, capped at 2 MiB. Provider-specific encrypted or proprietary formats may need to be decoded by the provider before import. Inspect the subscription's `lastError` and confirm the response contains supported URI schemes.

## Security notes

- Keep the Local Proxy listener bound to loopback unless there is a deliberate, authenticated reverse-proxy design.
- Do not expose sing-box credentials or generated config files publicly.
- Health URLs are restricted to public HTTP(S) destinations by the SSRF guard.
- Proxy URLs, subscription URLs, and database exports may contain credentials.
- Automatic failover changes routing without a manual click; keep it disabled unless that behavior is acceptable.

## Source integration points

The implementation is split across these areas:

- `src/app/(dashboard)/dashboard/local-proxy/page.js`: dashboard controls and state.
- `src/app/api/local-proxy/route.js`: runtime status, start/stop/config, selection, and rotation.
- `src/app/api/local-proxy/nodes/route.js`: node listing, manual import, and batch health checks.
- `src/app/api/local-proxy/nodes/[id]/route.js`: per-node CRUD and health checks.
- `src/app/api/local-proxy/subscriptions/[id]/route.js`: subscription read, edit, refresh, and delete.
- `src/lib/db/repos/proxySubscriptionsRepo.js`: URI parsing and SQLite persistence.
- `src/lib/network/localProxyManager.js`: sing-box config generation, runtime lifecycle, and probes.
- `src/lib/network/localProxyHealthScheduler.js`: automatic testing, concurrency, failure thresholds, and failover.
- `custom-server.js`: scheduler startup during server lifecycle.

For a quick overview, return to the [project README](../README.md).
