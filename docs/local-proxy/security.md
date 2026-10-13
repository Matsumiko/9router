# Local Proxy security

## Keep the listener on loopback

The generated inbound binds to `127.0.0.1`. Do not expose `20129` or the Clash API controller publicly. A proxy listener can carry arbitrary outbound traffic and may contain credentials in its node configuration.

## Protect generated files and database backups

The generated config is written with mode `0600`, but access to the host user and data directory still matters. Proxy URLs, subscription URLs, UUIDs, passwords, and exported SQLite data may be secrets. Do not paste full configs into public issues or logs.

## Health URL SSRF guard

Health URLs must be HTTP(S), must not include userinfo, and must resolve to a public address. This prevents the health feature from being used as a loopback/private-network fetcher. A public URL can still be undesirable or rate-limited; choose a stable endpoint you are permitted to probe.

## Subscription risk

A subscription response is untrusted input. 9Router limits response size, parses supported formats, validates values, and generates a local config. Still, treat subscription providers as configuration suppliers: review imported nodes, disable unexpected nodes, and do not run a subscription URL containing credentials in a public dashboard.

## Provider exclusion

Provider-level **Exclude Local Sidecar** reduces reliance on local proxy nodes for that provider, but it does not guarantee direct egress when an external proxy pool or relay is configured. Review the effective proxy policy before assuming an upstream sees the host's direct IP.

## Direct fallback and replay

Direct fallback can expose the target request to the host network and may violate routing expectations. By default, non-idempotent requests such as chat `POST` are not sent direct after local-sidecar failure. `strictProxy: true` forbids direct fallback. Never enable `allowDirectFallback` for a request unless duplicate/alternate egress is acceptable.

A request that has received response headers or emitted body data is not replayed. This protects streaming semantics and prevents duplicate side effects after an established request.

## Automatic failover

Automatic failover changes the active route without a manual click. Keep it disabled when route changes require operator approval. If enabled, inspect the bounded failover evidence and use a short, stable health URL; avoid interpreting every provider error as a node failure.

## Logging and diagnostics

Transport logs sanitize target/proxy values and structured failover evidence stores only the origin, node IDs, phase, reason, attempt, and fallback policy. Avoid enabling debug logging around credentials unless logs are protected. Redact tokens and proxy authentication before sharing diagnostics.

## Binary and supply chain

Install the proxy core from a trusted source, pin versions where appropriate, verify checksums/signatures according to your environment, and run `version` plus `check` before allowing it to own the production listener. Official `sing-box` and compatible `nekobox_core` are separate binaries; do not assume feature parity solely from a shared command name.
