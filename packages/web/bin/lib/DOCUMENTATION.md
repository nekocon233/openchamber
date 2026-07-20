# CLI Module Map

This directory contains the non-entrypoint implementation for the OpenChamber CLI. `packages/web/bin/cli.js` should stay thin: it owns bootstrap, command wiring, top-level dispatch, signal/cancel handling, and compatibility exports. Domain logic belongs in these modules.

## Entrypoint Boundary

- `../cli.js`
  - Owns process bootstrap, package/version lookup, command table wiring, signal handlers, top-level error handling, and legacy exports used by tests or external consumers.
  - Injects runtime dependencies into command factories, such as `serveCommand`, `stopCommand`, package-manager loading, cancel cleanup, and foreground server state setters.
  - Should not grow command-specific behavior. If a new branch needs more than dispatch/wiring, move it here into a command or helper module instead.

## Command Modules

Command modules implement user-facing commands and preserve output contracts across interactive, non-TTY, `--quiet`, and `--json` modes. They should use `../cli-output.js` for presentation helpers and keep safety validation in command logic, not prompts.

- `commands-serve.js`
  - Implements `openchamber serve`.
  - Owns OpenCode CLI checks, port resolution, log rotation, PID/instance registry writes, foreground/background server launch, startup summaries, and foreground shutdown behavior.

- `commands-lifecycle.js`
  - Implements `openchamber stop` and `openchamber restart`.
  - Owns lifecycle stop/restart semantics, desktop-managed port rejection, unmanaged instance shutdown attempts, PID/instance cleanup, and restart reuse of stored instance options.

- `commands-status.js`
  - Implements `openchamber status`.
  - Formats discovered instances and tunnel readiness/status for human, quiet, and JSON output.

- `commands-logs.js`
  - Implements `openchamber logs`.
  - Resolves log files, tails recent lines, and follows log output.

- `commands-startup.js`
  - Implements `openchamber startup`.
  - Handles startup subcommand dispatch and presentation around the lower-level startup service helpers.

- `commands-connect-url.js`
  - Implements `openchamber connect-url`.
  - Finds or starts a local instance and prints the browser/connect URL according to the selected output mode.
  - Emits a **pairing v2** link (`openchamber://connect?v=2&p=<base64url>`): it creates a one-time pairing session in the shared store (`client-pairing-sessions.json`) and encodes the pairing id + secret + transport candidates. The client redeems the secret over whichever candidate connects first (`/api/client-auth/pairing/redeem`). No standalone token is embedded — the QR itself is the single-use credential.
  - The default form advertises the resolved server URL as a direct (lan/tunnel) candidate and folds in a relay candidate when the host relay is enabled, so one link works on-LAN and off-network.
  - `--relay` builds a relay-only pairing link (the sole candidate is the relay transport), for sharing with a device that is not on the host's network — no server URL, no auto-start. The relay endpoint follows `OPENCHAMBER_RELAY_URL` / the stored setting / the default, matching the running host; the host must be running with the relay enabled to serve the redeem over the tunnel.

- `commands-update.js`
  - Implements `openchamber update`.
  - Loads the package-manager helper, performs update flow, and coordinates restart behavior after updates.

- `commands-tunnel.js`
  - Implements `openchamber tunnel` and its subcommands: `profile`, `providers`, `ready`, `doctor`, `status`, `start`, `stop`, and `completion`.
  - Owns tunnel-specific command flow, interactive prompt decisions, managed-local/managed-remote startup, QR display rules, tunnel start/stop API calls, and tunnel profile command handling.
  - Validates explicit providers, modes, FRPC addresses, and readable CA files before profile fallback in every output mode. Tunnel start requests use a 300-second HTTP budget, covering the 120-second install-lock wait, 120-second download, 20-second provider startup, and bounded overhead. An HTTP timeout aborts the server request so a pending FRPC start cannot later become active unexpectedly.
  - Tunnel stop requests allow 317 seconds so the server can finish the bounded pending-start cleanup contract. `tunnel stop --all` requires `--force` in non-interactive, JSON, and quiet modes; interactive multi-instance use retains confirmation. Every target is attempted, every result is rendered, and any single or partial failure exits non-zero without emitting duplicate JSON or human output.
  - Internal server auto-start always runs silently and defers the single final result to the tunnel command, preserving JSON-only and quiet output. Generated retry commands retain normalized provider, mode, endpoint, and output-mode flags.
  - Receives `serveCommand` and `stopCommand` by dependency injection. Do not reach back into `cli.js` command globals from this module.

## Shared Helper Modules

These modules hold reusable, non-presentational logic for commands.

- `cli-args.js`
  - Argument parsing, defaults, help text, completion script generation, and typo suggestions. The CLI boundary detects raw `--json` and `--quiet` flags before parsing so missing-value failures preserve the requested output contract regardless of flag order.

- `cli-errors.js`
  - CLI exit codes and typed tunnel CLI errors, including already-reported failures that preserve one-document JSON and non-duplicated human output while exiting non-zero.

- `cli-paths.js`
  - Data, run, log, settings, tunnel profile, and managed-local config paths.

- `cli-process.js`
  - PID files, instance registry files, process identity checks, runtime metadata checks, and process termination helpers.

- `cli-lifecycle.js`
  - Instance discovery, live health probing, attachability checks, provider discovery, and status aggregation used by lifecycle/status/tunnel commands.

- `cli-http.js`
  - HTTP helpers for health checks, shutdown requests, JSON API calls, tunnel provider fetches, and system info fetches.

- `cli-network.js`
  - Host resolution, URL building, LAN detection, unsafe browser port validation, and UI password/network exposure checks.

- `cli-ports.js`
  - Port availability checks and available-port resolution.

- `cli-log-files.js`
  - Log rotation, tail reads, and file-follow streaming.

- `cli-executables.js`
  - Executable path resolution and PATH lookup helpers.

- `cli-startup.js`
  - Native startup service detection, install/uninstall/status helpers, and platform-specific startup command execution.

- `cli-tunnel-profiles.js`
  - Provider-discriminated tunnel profile normalization, token resolution/redaction, profile storage, migration, file-permission enforcement, and Cloudflare managed-remote pair compatibility.
  - FRPC profiles store server address, control port, trusted CA file, and exactly one TCP or HTTP-vhost endpoint. TCP requires an explicit origin-only HTTPS `publicUrl`; legacy TCP profiles without it remain inspectable but cannot start until an explicit `--public-url` is supplied. Legacy FRPC profiles without a trust anchor are omitted rather than reused. Output exposes only `hasToken`; FRPC rejects inline `--token` and accepts file/stdin/prompt sources.
  - Profile and compatibility credential files use atomic replacement as one transaction. Credential publication happens first; any later profile failure restores both previous files.
  - CLI-owned Cloudflare compatibility credentials use `cli-profile:<profile-id>`. Existing raw IDs are treated as legacy CLI ownership only when linked to a previous/current CLI profile; unlinked raw records are not imported because they may be Settings-owned. Persistence merges Settings/server records verbatim and updates or removes only credentials owned by affected CLI profiles.
  - Only a missing profile file is treated as an empty store. Malformed or unreadable storage fails explicitly so later commands cannot overwrite credentials based on a false empty state.

- `cli-tunnel-utils.js`
  - Tunnel-specific command string builders, TTL parsing/formatting, and replay command helpers.

- `cli-tunnel-capabilities.js`
  - Built-in tunnel provider capability fallbacks used when a live server cannot provide tunnel metadata.

## Placement Rules

- Add new CLI commands as `commands-*.js` modules and wire them from `cli.js`.
- Add reusable logic to the narrow helper module that owns the domain. Create a new helper module before mixing unrelated domains into an existing one.
- Keep command modules responsible for user-visible behavior and mode-specific output. Keep helper modules mostly output-free unless the helper exists specifically for CLI rendering.
- Preserve output contracts when moving code:
  - `--json` emits JSON only.
  - `--quiet` emits concise essential output.
  - Prompts are gated by `canPrompt(options)`.
  - Validation and policy run in every mode.
- Prefer dependency injection from `cli.js` for cross-command behavior, especially when one command needs another command's implementation.
- Do not import `cli.js` from modules in this directory. The dependency direction is `cli.js` -> command modules -> helper modules.

## Verification

For CLI behavior changes, run the focused CLI suite from `packages/web`:

```sh
bun run test -- bin/cli.test.js
```

Before finalizing source changes that affect CLI behavior, also run:

```sh
bun run type-check
bun run lint
```
