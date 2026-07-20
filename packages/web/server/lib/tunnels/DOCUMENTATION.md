# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.js`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: Cloudflare preset and private FRPC endpoint/token persistence runtime.
- `packages/web/server/lib/tunnels/install-help.js`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/frpc-assets.js`: pinned official FRPC release metadata and supported-target resolution.
- `packages/web/server/lib/tunnels/frpc-binary-manager.js`: verified FRPC download, cache, lock, extraction, and publish lifecycle.
- `packages/web/server/lib/tunnels/frpc-client.js`: private FRPC config/token/CA lifecycle, TCP and HTTP-vhost process control, endpoint normalization, and readiness detection.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/frpc.js`: registered managed FRPC provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.

## Managed FRPC provider
- Tunnel management is a host-local control surface. The HTTP routes for dependency checks, diagnostics, credential/config writes, start, and stop require a direct loopback request classified as local; public tunnels, Private Relay, LAN peers, and other external requests receive no management capability. Remote status responses are intentionally reduced to public active-state metadata and never include private endpoint paths or tunnel session credentials. Internal startup orchestration remains allowed so a persisted FRPC tunnel can recover with the host service.
- The FRPC provider is registered alongside Cloudflare and Ngrok and is reachable from routes, Settings, and CLI surfaces.
- `createFrpcBinaryManager()` returns `inspect()`, `prepare()`, and `getPaths()` for the pinned managed binary lifecycle.
- `startFrpcClient(options)` resolves only after authoritative proxy readiness and returns a controller with asynchronous `stop()`, `isRunning()`, `getPublicUrl()`, and safe server/endpoint metadata accessors. Stop waits for process exit, escalates from `SIGTERM` to `SIGKILL` after a bounded grace period, and leaves the controller active if termination cannot be confirmed.
- `createFrpcTunnelProvider()` exposes `capabilities`, `prepare`, `start`, `stop`, `checkAvailability`, and `resolvePublicUrl` while enforcing one active controller.
- FRPC is pinned to `0.70.0` for `darwin`, `linux`, and `win32` on `x64` and `arm64`. Managed files use versioned storage under `OPENCHAMBER_DATA_DIR/tunnels/frpc/`.
- TCP endpoints use `remotePort` with no `customDomain` and create an FRP TCP proxy from `127.0.0.1:<active-openchamber-port>`. Because that upstream is plain HTTP, TCP also requires an explicit origin-only `publicUrl` using `https://`; OpenChamber never infers browser TLS from the FRPS control address. The declared URL must be an external TLS terminator that forwards to the mapped remote port.
- HTTP-vhost endpoints use `customDomain` for FRPS routing and `hostname` for the external public URL. They require both hostnames, reject a simultaneous `remotePort`, generate `type = "http"` plus `customDomains`, and expose `https://<hostname>`.
- FRPC custom/public hostnames are strict bare DNS names: schemes, paths, ports, wildcards, trailing dots, and IP literals are rejected. `serverAddress` separately continues to accept IPv4, IPv6, or a bare hostname.
- TCP names remain `openchamber-<remote-port>`. HTTP names use a bounded SHA-256-derived name based on the normalized custom domain, avoiding unsafe or overlong domain-derived process names. Readiness requires FRPC's proxy-success log for the exact generated name; process liveness or control login alone is not readiness.
- Tokens exist only in a private temporary token file referenced through FRP `tokenSource`. Login, heartbeat, and new work connections all use token authentication. The selected trusted CA file is limited to 1 MiB, copied into the same private temporary directory, and referenced by generated config; temporary material is removed on stop, startup failure, or process exit. Persisted FRPC credentials use a separate atomic `0600` file and are never returned by status/settings routes or provider metadata.
- Doctor validates the selected trusted CA through the same readable regular-file and 1 MiB production loader. After readiness, FRPC output is drained through bounded, token-redacted line logging rather than retained in an unbounded process buffer.
- Every FRPC control/work connection enables TLS and emits both `transport.tls.trustedCaFile` and `transport.tls.serverName`. The server name is the normalized `serverAddress`; this protects FRPC-to-FRPS transport but does not add TLS to a TCP proxy's browser-facing side.
- Private FRPC config version 2 stores `trustedCaFile` and one complete discriminated endpoint (`proxyType: "tcp"` plus `remotePort` and `publicUrl`, or `proxyType: "http"` plus `customDomain` and `hostname`). Version-1 records cannot establish server identity and fail closed. Legacy TCP records without `publicUrl`, insecure/malformed URLs, and mixed endpoint records also fail closed; existing HTTP-vhost records remain valid.
- The last successfully connected private FRPC endpoint is authoritative over stale shared-settings drafts. An explicit request selects one complete endpoint variant and never inherits fields from the other variant. Status and start responses report `frpcProxyType`, `frpcTrustedCaFile`, `frpcPublicUrl`, `frpcCustomDomain`, `frpcPublicHostname`, and the existing common/TCP fields without returning the token.
- A missing private FRPC config may fall back to a complete shared-settings draft. An invalid or unreadable private config does not masquerade as missing: tunnel status reports `frpcConfigStatus: "error"` and a safe `frpcConfigError` while preserving unrelated provider status.
- FRPC controllers are non-reusable. Every successful start replaces an existing FRPC process even when provider, mode, and public URL are unchanged; the service reports that replacement so routes revoke old bootstrap links and sessions. Reusable providers retain their existing controller-reuse behavior.
- Explicit unknown providers, unknown modes, and provider-incompatible modes fail closed in service, route, CLI, and direct-startup paths. Defaults apply only when the corresponding value is omitted.
- FRPC preparation has 120-second lock and download budgets followed by a 20-second readiness budget. CLI start requests allow 300 seconds total. An HTTP disconnect or explicit stop aborts queued and in-progress starts so late preparation cannot publish a tunnel.
- Service stop snapshots every pending start, aborts it, and waits through its final provider cleanup before reporting success. The wait is bounded at 307 seconds from the longest FRPC start, stop-escalation, and overhead contracts; timeout or cleanup failure is reported as stop failure while the aborted start remains ineligible for publication. Ownership-scoped cleanup cannot stop a newer tunnel.
- Direct server startup forwards the trust anchor through `tunnelTrustedCaFile`, `--tunnel-trusted-ca-file`, and `OPENCHAMBER_TUNNEL_TRUSTED_CA_FILE`. TCP's declared browser origin uses `tunnelPublicUrl`, `--tunnel-public-url`, and `OPENCHAMBER_TUNNEL_PUBLIC_URL`. It forwards `customDomain` through `tunnelCustomDomain`, `--tunnel-custom-domain`, and `OPENCHAMBER_TUNNEL_CUSTOM_DOMAIN`; `tunnelHostname` / `OPENCHAMBER_TUNNEL_HOSTNAME` remains the external HTTP-vhost hostname.
- TCP FRPS deployments must bind raw proxy ports to loopback and place Caddy or an equivalent HTTPS terminator in front of each declared `publicUrl`; OpenChamber refuses to issue a bootstrap URL for HTTP or malformed provider origins. HTTP-vhost deployments continue to use the FRPS HTTP vhost listener and external HTTPS routing for the declared custom/public hostnames. A shared token does not provide user-level endpoint isolation.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
