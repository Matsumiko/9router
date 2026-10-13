# Local Proxy operations

## First-time setup

1. Open **Dashboard → Local Proxy**.
2. Confirm that the Runtime card finds an executable.
3. Add a subscription or open **Add manual node**.
4. Refresh the subscription if applicable.
5. Enable the nodes that should be eligible.
6. Set the Test URL.
7. Run **Test all nodes**.
8. Select a healthy node with **Use**, or use **Rotate healthy**.
9. Click **Start sidecar**.
10. Use **Preview config** and the Runtime card to confirm the selected node and listener.

Starting the sidecar applies its proxy environment only to supported server-side outbound fetches. Stopping it clears proxy values managed by 9Router. It does not configure the user's browser or CLI process.

## Subscriptions

Create a subscription with a name and an `http://` or `https://` URL. Refresh downloads the response, limits it to 2 MiB, parses supported URI/JSON formats, replaces nodes previously imported by that subscription, and updates `lastFetchedAt`.

Editing a subscription changes only its name/URL. It does not delete existing imported nodes; refresh separately to import from the new URL. A failed refresh leaves existing nodes and records `lastError`.

Deleting a subscription deletes the subscription and its imported nodes. Manually imported nodes have no subscription ID and are not deleted with a subscription.

Subscription fetches use the normal proxy-aware outbound path, so they can follow the active environment/sidecar route. They are not per-node health probes.

## Manual nodes

Paste one URL per line. Blank lines and `#` comments are ignored. Supported schemes:

```text
vless://...
vmess://...
trojan://...
ss://...
http://...
https://...
socks5://...
socks5h://...
```

Enable/disable nodes independently. Disabled nodes are excluded from the generated config and automatic testing.

## Selection and rotation

**Use** selects a node. If the sidecar is running, 9Router updates the sing-box selector through the loopback Clash API without restarting where possible. If the selector API is unavailable and restart is allowed, 9Router rebuilds/restarts the sidecar.

**Rotate healthy** selects another eligible enabled node whose status is not `unhealthy`. Scheduled rotation is stricter: it selects only nodes currently marked `healthy`.

## Request-level failover

Request-level failover handles transport failures before an upstream response exists:

1. `proxyAwareFetch` classifies the failure phase.
2. The local proxy manager excludes tried/selected nodes and chooses an eligible replacement.
3. The request may be replayed only when its body is replayable and no response data has started.
4. Up to three candidate attempts are allowed.
5. The selected failed node is marked `degraded` after a successful switch.

HTTP provider errors are not node transport failures. A response that has started is never replayed.

Direct fallback policy:

- `GET`, `HEAD`, and `OPTIONS` may fall back direct unless policy forbids it;
- non-idempotent requests such as chat `POST` remain proxy-only by default;
- `strictProxy: true` forbids direct fallback;
- `allowDirectFallback: true` explicitly permits it for a caller that accepts the risk.

The latest bounded evidence is exposed by `GET /api/local-proxy` and is in-memory only; it is lost on process restart.

## Start, stop, and rebuild

The sidecar is an independent process. Rebuilding or restarting the dashboard does not require a second sidecar. On startup, 9Router can adopt a managed process that already owns the configured listener and generated config.

If another process owns the listener, startup returns the core's diagnostic, including bind failure where available. On graceful 9Router shutdown, the managed sidecar is stopped.

## Binary comparison and validation

Both official `sing-box` and compatible `nekobox_core` builds can be used. Test the exact binary with the generated config:

```bash
$SING_BOX_BIN version
$SING_BOX_BIN check -c <DATA_DIR>/local-proxy/sing-box.json
```

To compare two binaries safely, use separate temporary configs with different listener/controller ports. Do not start a second process on `20129` or `20130` while the production sidecar is running. A complete HTTP response through both binaries proves compatibility for that node/config and target; it does not prove every node format or provider path.
