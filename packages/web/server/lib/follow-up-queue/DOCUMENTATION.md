# Follow-Up Queue Authority

## Purpose

`packages/web/server/lib/follow-up-queue` owns the OpenChamber host's authoritative per-session follow-up queue. It persists queue order, send configuration, attachment transport metadata, statuses, and short-lived claims so concurrent clients cannot auto-send the same item.

The module contains no logging. Global change events never contain session IDs, item IDs, message IDs, content, attachments, paths, request bodies, or credentials.

## Public API

Import from `./index.js`:

- `createFollowUpQueueCore(dependencies)` creates the filesystem authority.
- `core.load(sessionId)` returns the authoritative snapshot. A missing file returns revision `0` and an empty item array.
- `core.applyMutation(request)` validates, serializes, and atomically persists a public mutation.
- `core.terminalizeSession(sessionId, clientMutationId)` is the core's host-internal terminal path.
- `core.listStoredSessions()` enumerates readable authority scopes for host startup reconciliation; unreadable files are counted separately and do not erase unrelated queues.
- `createFollowUpQueueServerRuntime(dependencies)` broadcasts opaque revision hints and provides deletion-event terminalization, bounded exponential retry, and stored-session reconciliation.
- `registerFollowUpQueueRoutes(app, runtime)` is exported by `./routes.js`.

```js
const followUpQueue = createFollowUpQueueServerRuntime({
  fsPromises,
  path,
  rootDirectory: path.join(openchamberDataDir, 'follow-up-queue'),
  broadcastGlobalUiEvent,
  // Optional; defaults to 256 and cannot exceed 4096.
  dedupeLimit: 256,
});
```

`rootDirectory` must be absolute. One process should instantiate one core per root so callers share its in-memory per-scope FIFO. Per-scope lock directories additionally serialize mutations across OpenChamber processes that share the authority directory. A contender prepares a complete owner directory and atomically renames it into the canonical lock path. Dead owners are atomically moved to a deterministic, non-empty quarantine path derived from their owner token; the quarantine remains as an ABA fence so a delayed reaper cannot move a successor lock. Windows may report an existing-directory rename as `EPERM` or `EACCES`; those codes count as contention only after the destination is confirmed to be a directory, while other permission failures still fail closed.

## Scope And Snapshot

The only canonical scope is:

```js
{ kind: 'session', sessionId }
```

`sessionId` is a non-empty string of at most 256 JavaScript code units and 1024 UTF-8 bytes. C0/C1 controls, `/`, `\`, and the path segments `.` and `..` are rejected. The lowercase SHA-256 of `JSON.stringify({ kind: 'session', sessionId })` is `scopeToken`; files are named `<scopeToken>.json`, so the raw session ID never enters a filesystem path. Stored scope/token mismatches are corruption.

The public snapshot is:

```js
{ scopeToken, revision, items }
```

The missing-file snapshot is authoritative `{ scopeToken, revision: 0, items: [] }`. Read or validation failure is never converted to empty success. The sole exception is host-internal terminalization after an authoritative deletion event: a corrupt queue is replaced by an empty terminal tombstone so malformed retained content cannot block deletion cleanup.

## Item Contract

Items are ordered FIFO records:

```js
{
  id,
  messageId,
  content,
  attachments?,
  createdAt,
  status: 'staged' | 'queued',
  sendConfig?: { providerID, modelID, agent?, variant? },
  claim?: { id, expiresAt },
}
```

`messageId` is client-created once and remains unchanged across claims and retries, preventing a lease retry from creating a second OpenCode message. Public `add` operations cannot supply `claim`.

Attachment records allow exactly `id`, `dataUrl`, `mimeType`, `filename`, `size`, `source`, and optional `serverPath`, `vscodePath`, `vscodeSource`. `source` is `local`, `server`, or `vscode`; `vscodeSource` is `file` or `selection`. The browser-only `file` object is forbidden by strict extra-field validation.

Explicit bounds are:

- 256 queue items; 32 attachments per item and 512 per queue.
- 1 MiB UTF-8 content per item and 4 MiB total queue content.
- 56 MiB per `dataUrl` and 56 MiB total attachment string data per queue.
- 2 GiB maximum declared attachment `size`.
- 256-byte identifiers, 256-byte MIME types, 4 KiB filenames, and 16 KiB optional attachment paths.
- 64 MiB maximum persisted authority file and 64 MiB route-local JSON body limit.

All objects reject unknown fields. Stored and incoming item arrays reject duplicate item IDs, message IDs, and per-item attachment IDs.

## Mutations

Every public request is exactly:

```js
{ sessionId, baseRevision, clientMutationId, operation }
```

Supported operations are:

- `{ type: 'add', item }`
- `{ type: 'remove', itemId }`
- `{ type: 'set-status', itemId, status }`
- `{ type: 'move', itemId, beforeId }`, where `null` means the end
- `{ type: 'claim', itemId, claimId, mode: 'manual' | 'auto' }`
- `{ type: 'complete', itemId, claimId }`
- `{ type: 'release', itemId, claimId, status }`

The retained idempotency record is checked before revision comparison so a response-lost retry with its original base can recover. A first-seen request otherwise requires an exact `baseRevision`; mismatch throws `FollowUpQueueConflictError` with `latestSnapshot` and performs no write.

Only a semantic snapshot change advances revision by one. Missing remove/status/move/claim targets, a missing move anchor, same status/order, ineligible auto claim, and claim mismatch are no-ops. They return `applied: false`, do not advance revision, and still atomically persist their mutation ID. Adding an existing item ID or message ID is a no-op only when the complete normalized item is identical; otherwise it is an item conflict.

The result is:

```js
{ snapshot, applied, deduplicated, mutationRevision }
```

`mutationRevision` is the created revision or `null` for a first-seen no-op. A bounded FIFO ledger stores each `clientMutationId`, normalized-operation SHA-256 fingerprint, and mutation revision. The same retained ID and operation returns `deduplicated: true`; a different operation with that ID is a `409` idempotency conflict. Once an entry leaves the configured window it is no longer idempotent.

## Claims And Completion

The host sets every acquired claim's `expiresAt` to its current clock plus exactly 120 seconds. `auto` can claim only `queued` items; `manual` can claim either status. Another unexpired claim blocks acquisition, while an expired claim can be replaced. A fresh claim mutation using the same claim ID may renew that claim; replaying the same mutation ID never renews it.

`complete` and `release` require the currently stored claim ID, including after that claim's expiry. `complete` removes the item. `release` clears the claim and sets the requested `staged` or `queued` status. A replacement claimant prevents an older claimant from completing or releasing the item.

## Terminalization

An authoritative `session.deleted` event or successful proxied OpenCode session deletion calls the host-internal terminal path. After acquiring the same per-scope mutation lock, it durably creates and directory-syncs an opaque terminal fence shared by every host process using the authority root. Mutations already holding the lock complete before deletion; every later mutation observes the fence. Loads and public mutations fail closed while that fence exists without a terminal envelope. Its first application then clears all items, advances revision, and writes a terminal tombstone. Future public requests must still match the terminal revision; accepted requests only enter the bounded dedupe ledger and can never change or revive the queue.

Deletion events accept the existing `properties.sessionID` and `properties.info.id` shapes. Duplicate in-flight work is coalesced per session. Read and write failures retry indefinitely with the same mutation ID using exponential delays from 250 ms to 30 seconds. Loads and public mutations for that session wait behind pending terminalization instead of exposing or changing stale content. A post-rename directory-sync failure is therefore recovered as a deduplicated mutation with its original revision.

Startup always completes existing terminal fences without consulting OpenCode. After OpenCode becomes ready and the global event watcher is connected, reconciliation enumerates every remaining readable non-terminal queue and checks that session directly against OpenCode. A confirmed `404` terminalizes it. Failed, malformed, or ambiguous lookups increment the partial-failure count and preserve the queue; they are never treated as an authoritative empty session set. Corrupt files whose scope remains readable can still be terminalized when their session is confirmed missing. If the watcher connects late or reconciliation is partial, the next watcher connection retries the pass.

## Storage And Failure

Each scope has an independent recoverable FIFO covering loads and mutations. Public loads remain lock-free atomic-file reads. Mutations take the scope's cross-process lock around the complete read-modify-write transaction, so concurrent claims and terminalization cannot both commit from one base revision. Only a valid owner with a confirmed dead PID may be reclaimed; owner read or parse errors fail closed. Lock release retries until it can move the canonical directory to an owner-specific released path, so transient rename or later cleanup failure cannot abandon the live lock. A rejected operation does not poison the queue, and one blocked scope does not delay another.

Writes create the root with mode `0700` and sync its parent after first creation where supported, write and flush a unique sibling temporary file with `wx` and mode `0600`, rename it over the authority file, and sync the authority directory. There is no direct-write fallback. Pre-rename failure removes the temporary file where possible and leaves the prior file authoritative. Read, corrupt, and write errors expose stable codes without retaining storage causes.

## Events And Routes

An applied mutation, or deduplicated recovery with a non-null `mutationRevision`, broadcasts only:

```js
{
  type: 'openchamber:follow-up-queue.changed',
  properties: { scopeToken, revision },
}
```

Terminalization adds only `reset: true` to the same opaque properties. This tells clients to accept an authority revision reset when deletion had to replace an unreadable file; it still reveals no session or item identity.

Routes are registered before the generic OpenCode proxy:

- `GET /auth/follow-up-queue/capabilities`
- `POST /auth/follow-up-queue/load` with exactly `{ sessionId }`
- `POST /auth/follow-up-queue/mutations`
- Authenticated aliases under `/api/follow-up-queue/*`

Capabilities return `{ authority: 'openchamber-host', version: 1 }`. Every success and error response is `Cache-Control: no-store`. Both namespaces pass normal OpenChamber authentication before the route-local JSON parser buffers a body. Validation is `400`; revision, item, and idempotency conflicts are `409`; storage failures are generic `500` responses.

The server has no explicit chat-draft authority or chat-draft routes. Existing chat-draft files are not read, migrated, or deleted.

## Tests

```bash
bun run --cwd packages/web test -- server/lib/follow-up-queue server/lib/opencode/core-routes.test.js
```
