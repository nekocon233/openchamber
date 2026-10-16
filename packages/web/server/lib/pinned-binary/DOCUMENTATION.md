# Pinned binary

Downloads and publishes a third-party release binary for the running platform
and architecture. Two products use it: the FRPC tunnel client
(`tunnels/frpc-binary-manager.js`) and the managed CLIProxyAPI gateway
(`native-agents/cliproxyapi/binary-manager.js`). Each of those is a descriptor
plus its own asset table; nothing in this module names a product.

## Contract

`createPinnedBinaryManager({ descriptor, platform, arch, asset, dataDir, requestImpl, spawnSyncImpl, verifyBinary, downloadTimeoutMs, lockTimeoutMs, staleLockMs, lockPollMs, allowedDownloadHosts, createId, onProgress })`
returns `{ version, inspect(), prepare({ onProgress }), getPaths() }`.

The descriptor supplies everything product-specific: `id`, `label`, `version`,
`assets`, `resolveAsset(platform, arch)` (which throws an error coded
`unsupported_target` for a target the product has no build for), `productRoot(dataDir)`,
`limits: { archiveBytes, binaryBytes, expandedTarBytes }`, `isBinaryMember(asset, entryName)`
and `verifyBinary(binaryPath, { spawnSyncImpl }) -> { ok, version, error }`.

`prepare()` inspects the published binary, takes a directory lock, reuses a
cached archive whose size and digest still match, otherwise downloads and
verifies one, extracts the member, verifies the staged binary, and publishes it
at `<productRoot>/v<version>/<platform>-<arch>/<binaryName>` with mode `0700`.
It returns `{ path, version, target, source: 'installed' | 'archive-cache' | 'download' }`.
`inspect()` answers `{ supported, prepared, path, version, target, error }` and
never throws for an unsupported target.

## Boundaries

- Downloads are HTTPS only, restricted to `DOWNLOAD_HOSTS`, follow at most five
  redirects that are re-validated, and must match the pinned byte size while
  streaming; the sha256 is verified as the bytes arrive and again afterwards.
- Every pinned asset carries its size and digest in the product's asset table.
  A mismatch deletes the staged file and fails.
- Extraction walks the archive itself (tar.gz) or AdmZip (zip), rejects
  non-regular members, refuses traversal names by matching the exact member, and
  enforces the expansion and member-size caps from the descriptor.
- The lock is a `mkdir` mutex with an owner file, a heartbeat and stale
  takeover, so two servers cannot publish into one directory.
- This module writes only under the product root. It never reads or changes
  anything else the product owns.
