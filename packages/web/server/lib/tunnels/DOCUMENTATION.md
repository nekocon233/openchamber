# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

Public tunnels require a UI password on the running server. The shared tunnel start operation enforces this for startup tunnels and HTTP requests; the HTTP route rejects passwordless starts before touching an existing tunnel.

In enterprise mode (`../enterprise-mode.js`) no tunnel starts at all: Cloudflare and ngrok terminate TLS at their edge and see plain text, and Tailscale opens this machine to other devices. The same shared start operation refuses first (so `--tunnel` at startup fails too), the HTTP route answers 403 `enterprise_mode` ahead of the password check, and an inactive status reports `enterpriseMode` so Settings shows why.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.ts`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/executable-search.ts`: cross-platform executable discovery, including Windows Store app aliases.
- `packages/web/server/lib/tunnels/registry.ts`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.ts`: Cloudflare preset and private FRPC endpoint/token persistence runtime.
- `packages/web/server/lib/tunnels/install-help.ts`: provider/platform install command metadata for missing tunnel dependencies.
- `packages/web/server/lib/tunnels/routes.ts`: shared start and diagnostic operations for server startup and HTTP requests.
- `packages/web/server/lib/tunnels/http-routes.ts`: HTTP handlers, lifecycle hooks and tunnel session responses.
- `packages/web/server/lib/tunnels/types.ts`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/contracts.ts`: controller and provider contracts shared by the registry and service.
- `packages/web/server/lib/tunnels/frpc-assets.ts`: pinned official FRPC release metadata and supported-target resolution.
- `packages/web/server/lib/tunnels/frpc-binary-manager.ts`: the FRPC descriptor for
  the shared pinned-binary manager, plus FRPC's own version check and the
  extractor wrappers its callers import.
- `packages/web/server/lib/pinned-binary/manager.ts`: the generic verified
  download, cache, lock, extraction and publish lifecycle the FRPC tunnel
  client uses.
- `packages/web/server/lib/tunnels/frpc-endpoint.ts`: parses FRPS addresses, ports, tokens and TCP or HTTP-vhost endpoints for the process, CLI and persisted profiles.
- `packages/web/server/lib/tunnels/frpc-client.ts`: private FRPC config/token lifecycle, host-trust CA resolution, TCP and HTTP-vhost process control, and readiness detection.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/frpc.js`: registered managed FRPC provider implementation.
- `packages/web/server/lib/tunnels/providers/ngrok.js`: Ngrok quick tunnel provider implementation.
- `packages/web/server/lib/tunnels/providers/tailscale.js`: Tailscale Serve (tailnet only) and Funnel (public) provider; the process itself lives in `../tailscale-tunnel.js`.
- `packages/web/server/lib/tunnels/tunnel-wiring-runtime.ts`: tunnel service/routes composition runtime and active-port wiring for main server startup.

## Invariants

- Tunnel starts run under one mutex so concurrent starts cannot orphan child
  processes. Stop cancels active and queued starts before waiting for cleanup.
  A failed preset write releases the queue for later saves.
- An absent HTTPS port remains undefined for provider defaults. A noninteger
  becomes invalid and reaches the same capability validation as an explicitly
  unsupported port; saved defaults apply only to modes listing that port.
- Request fields remain unchecked until normalization. An explicit own
  `configPath` overrides defaults even when its value is undefined.
- Tunnel-locality checks account for forwarded client addresses even when the Host header says localhost. Tailscale passes Host through, so a remote caller can choose it; forwarded non-loopback addresses can only reduce trust. Login rate-limit buckets use Express's trusted-proxy resolution.

## TypeScript boundaries

The converted files import Node filesystem, path and home-directory APIs and
folder-local normalization and install metadata. External inputs are environment
variables, filesystem stat/access results, request/default fields and registered
provider implementations. Providers own process output parsing; the service
owns the normalized start request and the controller returned by a provider.

`routes.ts` and `tunnel-auth.ts` use the Express and HTTP contracts in
`../shared`. Request body properties and settings fields remain unchecked
until their text, numeric or normalization checks. Managed config reads return
validated entries, so the routes use their token strings directly.
`setActiveTunnel` accepts an optional string-or-null mode and stores
`string | null`, matching both startup and route callers.

The wiring dependencies reuse the route dependency contract. The server's
Node entry registers source resolution before loading the runtime; Electron
loads the server through that entry, and VS Code does not import these runtimes.

### Why request guards remain

HTTP provider, mode, preset, hostname, token, path and TTL fields still need
validation. Header text checks preserve handling of missing or array headers;
cookie and connect-token text checks preserve malformed-input behavior.
Host and IP normalization accept missing values and reject non-text inputs.
The generic doctor checks retain their text predicate because provider-required
field names index a dictionary, including inherited members such as
`constructor`. A non-text truthy value still satisfies the original presence
check.

Internal cookie ages are always numbers, bootstrap expiry is number-or-null,
provider diagnosis is an optional callable, capability keys are strings and
managed-config tokens have already passed file validation. Their redundant
type checks are removed. Bootstrap/session revocation and expiration state
retain explicit nulls.

`managed-config.ts` owns the persisted entry and config contracts. Its injected
filesystem reads JSON as unchecked data; object, array, text and finite timestamp
checks establish the stored entry shape. Invalid input still produces an empty
list, and only ENOENT starts legacy migration. Filesystem errors retain their
existing warning and empty-result behavior.

### Why preset inputs follow the injected normalizer

`../settings/settings-runtime.js` forwards raw presets and token fields from
existing settings. The config runtime preserves that boundary: token fields
remain unchecked until its text guards, and the generic preset input is passed
unchanged to the injected normalizer. The normalizer determines which input it
accepts and returns validated preset fields. The generic links the forwarding
method to that exact input contract without promising that settings are already
validated. The hostname normalizer's type comes from its owning settings module.

Both production callers of `resolveManagedRemoteTunnelToken` build `presetId`
with a request text check and a string fallback. Its internal text recheck is
removed; token upsert and file-entry text checks remain because those fields
still come from unchecked settings or files.

### Why boundary guards remain

Exported normalizers and path validation still accept calls from unconverted
JavaScript. Their text/object guards preserve rejection and default behavior.
Registry guards validate provider ids and required methods at registration,
and ids at lookup. Environment lookup retains its text guard because environment
values are external and an object lookup can also find an inherited member.
These guards are type predicates; they do not assert unchecked domain shapes.

The service no longer rechecks the types of controller mode/provider or an
availability message. Those values belong to the provider contract. Executable
names are string literals at every production caller, and search directories
come from splitting PATH, so their internal text rechecks are removed.

### Why Windows aliases have a launch fallback

Windows app execution aliases can launch even when filesystem stat/access
returns EACCES. The version probe decides availability after the launch fallback.
See https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/desktop-to-uwp-extensions.

## HTTPS port
A mode that takes an HTTPS port lists the allowed ones in its capability descriptor (`httpsPorts`). Validation, the Settings select and the CLI all read that list, so it exists once. The saved `tunnelHttpsPort` setting applies only to such modes; an explicit `httpsPort` for any other mode is refused. A start whose port differs from the running tunnel's replaces it.

## Tailscale
Facts below come from Tailscale's documentation and CLI source, not from observation alone.
- OpenChamber runs `tailscale serve|funnel --https=<port> http://127.0.0.1:<port>` in the foreground. Tailscale ties a foreground config to the CLI's session and deletes it when the process ends (`DeleteForegroundSession` in `ipn/ipnlocal`), so killing the child is the whole cleanup on every platform; OpenChamber never resets or edits the user's other Serve config.
- Tailscale routes by TLS SNI, forwards the client's `Host`, and supplies the client address in `X-Forwarded-For`. The scope check treats a forwarded non-loopback peer as remote even with a loopback `Host`. Tunnel state identifies the expected public hostname. The remote classification survives an inactive tunnel.
- Before HTTPS (Serve) or Funnel is turned on for the tailnet, the CLI prints an approval link and waits. The start fails fast with code `approval_required` and the link, which Settings shows as a button.
- The Mac App Store and Standalone apps keep the CLI inside `/Applications/Tailscale.app`, and that binary opens the app window unless `TAILSCALE_BE_CLI=1` is set. Their "CLI integration" adds `/usr/local/bin/tailscale`, a `/bin/sh` wrapper that runs the binary as a child: a signal sent to the wrapper never reaches Tailscale, so Stop would leave the tunnel up. `resolveTailscaleTarget` runs the bundle binary directly whenever the app exists (seen live on 1.104.2).

### Why Serve offers only Funnel's three ports
Serve accepts any port, but one saved port that is valid in both modes means switching modes never loses or silently rewrites the user's choice. The three ports also cover the realistic reason to move off 443: another Serve config already on it.

## Managed FRPC provider
- Tunnel management is available to any authenticated client, wherever it runs: dependency checks, diagnostics, credential/config writes, start, and stop answer the same for a browser on the host, one reaching the server through its own tunnel, and the mobile app. The status payload is the same for all of them, session credentials and endpoint paths included; authentication (UI password, tunnel session, or client bearer, per `opencode/DOCUMENTATION.md`) is the boundary. Management used to be host-local; that extra guard was removed deliberately, so anyone holding a valid credential can now repoint or stop the tunnel from anywhere. Internal startup orchestration still runs so a persisted FRPC tunnel can recover with the host service.
- The FRPC provider is registered alongside Cloudflare and Ngrok and is reachable from routes, Settings, and CLI surfaces.
- `createFrpcBinaryManager()` returns `inspect()`, `prepare()`, and `getPaths()` for the pinned managed binary lifecycle.
- `startFrpcClient(options)` resolves only after authoritative proxy readiness and returns a controller with asynchronous `stop()`, `isRunning()`, `getPublicUrl()`, and safe server/endpoint metadata accessors. Stop waits for process exit, escalates from `SIGTERM` to `SIGKILL` after a bounded grace period, and leaves the controller active if termination cannot be confirmed.
- `createFrpcTunnelProvider()` exposes `capabilities`, `prepare`, `start`, `stop`, `checkAvailability`, and `resolvePublicUrl` while enforcing one active controller.
- FRPC is pinned to `0.70.0` for `darwin`, `linux`, and `win32` on `x64` and `arm64`. Managed files use versioned storage under `OPENCHAMBER_DATA_DIR/tunnels/frpc/`.
- TCP endpoints use `remotePort` with no `customDomain` and create an FRP TCP proxy from `127.0.0.1:<active-openchamber-port>`. Because that upstream is plain HTTP, TCP also requires an explicit origin-only `publicUrl` using `https://`; OpenChamber never infers browser TLS from the FRPS control address. The declared URL must be an external TLS terminator that forwards to the mapped remote port.
- HTTP-vhost endpoints use `customDomain` for FRPS routing and `hostname` for the external public URL. They require both hostnames, reject a simultaneous `remotePort`, generate `type = "http"` plus `customDomains`, and expose `https://<hostname>`.
- FRPC custom/public hostnames are strict bare DNS names: schemes, paths, ports, wildcards, trailing dots, and IP literals are rejected. `serverAddress` separately continues to accept IPv4, IPv6, or a bare hostname.
- TCP names remain `openchamber-<remote-port>`. HTTP names use a bounded SHA-256-derived name based on the normalized custom domain, avoiding unsafe or overlong domain-derived process names. Readiness requires FRPC's proxy-success log for the exact generated name; process liveness or control login alone is not readiness.
- Tokens exist only in a private temporary token file referenced through FRP `tokenSource`. Login, heartbeat, and new work connections all use token authentication. The trusted CA material is resolved automatically from host runtime trust roots (`loadFrpcDefaultTrustedCa` in `frpc-client.js`): Node's `tls.getCACertificates('system' | 'default')` and `tls.rootCertificates`, legacy host FRP bundles at `~/.config/frp/ca.crt` and `~/.frp/ca.crt`, the `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS` bundles, and standard OS bundle paths; inside Docker the "host" is the container runtime trust store. The deduplicated PEM is normalized through X.509 parsing, capped at 1 MiB, written as `trusted-ca.pem` with mode `0600` into the same private temporary directory, and referenced by generated config; temporary material is removed on stop, startup failure, or process exit. OpenChamber never learns a CA from an unauthenticated FRPS. Private or enterprise FRPS CAs must be installed into the OS/container trust store, exposed through `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`, or placed at one of the legacy host FRP paths above; there is no per-tunnel CA setting. Persisted FRPC credentials use a separate atomic `0600` file and are never returned by status/settings routes or provider metadata.
- Doctor validates host trust roots through the same 1 MiB production loader. Runtime logging emits only complete, bounded lines after token redaction. Incomplete output can contain a fragment of a credential and is discarded. Logging and exit callbacks cannot prevent child-process cleanup.
- Every FRPC control/work connection enables TLS and emits both `transport.tls.trustedCaFile` (the generated private host-roots PEM) and `transport.tls.serverName`. The server name is the normalized `serverAddress`, so FRPS must present a certificate whose SAN matches it; this protects FRPC-to-FRPS transport but does not add TLS to a TCP proxy's browser-facing side.
- Private FRPC config version 3 stores one complete discriminated endpoint (`proxyType: "tcp"` plus `remotePort` and `publicUrl`, or `proxyType: "http"` plus `customDomain` and `hostname`); it stores no CA material because trust always comes from the host runtime. Version-2 records are read as version 3 and their legacy CA path is dropped on the next successful save. Version-1 records cannot establish server identity and fail closed. Legacy TCP records without `publicUrl`, insecure/malformed URLs, and mixed endpoint records also fail closed; existing HTTP-vhost records remain valid.
- The last successfully connected private FRPC endpoint is authoritative over stale shared-settings drafts. An explicit request selects one complete endpoint variant and never inherits fields from the other variant. Status and start responses report `frpcProxyType`, `frpcPublicUrl`, `frpcCustomDomain`, `frpcPublicHostname`, and the existing common/TCP fields without returning the token.
- A missing private FRPC config may fall back to a complete shared-settings draft. An invalid or unreadable private config does not masquerade as missing: tunnel status reports `frpcConfigStatus: "error"` and a safe `frpcConfigError` while preserving unrelated provider status.
- FRPC controllers are non-reusable. Every successful start replaces an existing FRPC process even when provider, mode, and public URL are unchanged; the service reports that replacement so routes revoke old bootstrap links and sessions. Reusable providers retain their existing controller-reuse behavior.
- Explicit unknown providers, unknown modes, and provider-incompatible modes fail closed in service, route, CLI, and direct-startup paths. Defaults apply only when the corresponding value is omitted.
- FRPC preparation has 120-second lock and download budgets followed by a 20-second readiness budget. CLI start requests allow 300 seconds total. An HTTP disconnect or explicit stop aborts queued and in-progress starts so late preparation cannot publish a tunnel.
- Service stop snapshots every pending start, aborts it, and waits through its final provider cleanup before reporting success. The wait is bounded at 307 seconds from the longest FRPC start, stop-escalation, and overhead contracts; timeout or cleanup failure is reported as stop failure while the aborted start remains ineligible for publication. Ownership-scoped cleanup cannot stop a newer tunnel.
- Direct server startup needs no trust-anchor input; FRPS verification always uses the host runtime trust roots described above. TCP's declared browser origin uses `tunnelPublicUrl`, `--tunnel-public-url`, and `OPENCHAMBER_TUNNEL_PUBLIC_URL`. It forwards `customDomain` through `tunnelCustomDomain`, `--tunnel-custom-domain`, and `OPENCHAMBER_TUNNEL_CUSTOM_DOMAIN`; `tunnelHostname` / `OPENCHAMBER_TUNNEL_HOSTNAME` remains the external HTTP-vhost hostname.
- TCP FRPS deployments must bind raw proxy ports to loopback and place Caddy or an equivalent HTTPS terminator in front of each declared `publicUrl`; OpenChamber refuses to issue a bootstrap URL for HTTP or malformed provider origins. HTTP-vhost deployments continue to use the FRPS HTTP vhost listener and external HTTPS routing for the declared custom/public hostnames. A shared token does not provide user-level endpoint isolation.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort, hasUiPassword)`
