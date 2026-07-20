# Sidebar State Core

## Purpose

`packages/web/server/lib/sidebar-state` owns the server-side source of truth for cross-device sidebar structure. `server/index.js` creates one runtime for the OpenChamber data directory, and `feature-routes-runtime.js` registers its authenticated HTTP routes.

The core persists structure only. It never stores session content, credentials, bearer tokens, active navigation, or transient sidebar presentation state.

## Public API

Import from `./index.js`:

- `createSidebarStateRuntime(dependencies)` creates one runtime for one state file.
- `runtime.initialize({ legacyProjects?, legacySessionFoldersByScope? })` creates revision `0` only when the file is absent. Existing valid state is returned unchanged. A malformed existing file throws and is never replaced.
- `runtime.readSnapshot()` strictly reads the authoritative snapshot. Missing and malformed files throw different typed errors.
- `runtime.applyMutation({ baseRevision, clientMutationId, operation })` validates, serializes, applies, and atomically persists one semantic operation.
- Typed errors expose stable `code` values. `SidebarStateConflictError` additionally exposes `baseRevision`, `actualRevision`, and `latestSnapshot`.
- `normalizeSidebarPath(value)` exposes the same lexical path normalization used by projects and worktree ordering.

Dependencies are explicit:

```js
const sidebarState = createSidebarStateRuntime({
  fsPromises,
  path,
  filePath: path.join(openchamberDataDir, 'sidebar-state.json'),
  // Optional, defaults to 256 and may not exceed 4096.
  dedupeLimit: 256,
});
```

`filePath` must be absolute. Instantiate one runtime per file so all callers share its FIFO mutation queue.

## Snapshot V1

The public snapshot is:

```json
{
  "schemaVersion": 1,
  "revision": 0,
  "projects": [],
  "pinnedSessionIds": [],
  "worktreeOrderByProject": {},
  "sessionFoldersByScope": {}
}
```

Project array position is authoritative project order. Shared project fields are `id`, normalized absolute `path`, `label`, `icon`, `iconImage`, `iconBackground`, `color`, `defaultModel`, and `addedAt`. Optional fields are omitted or use their documented nullable form.

The snapshot intentionally excludes:

- `activeProjectId`, because active navigation is device-local.
- `lastOpenedAt`, because recency is device-local and must not reorder another device.
- `sidebarCollapsed`, because collapse state is presentation-local.

The initializer accepts legacy project entries and the prior `sessions-directories.json` folder map. Migration preserves the first valid project ID/path and folder ID in source order, merges canonically equivalent folder scopes, strips project-local `lastOpenedAt` and `sidebarCollapsed`, omits invalid optional project metadata, and truncates bounded display text. Separate entries whose names collide after truncation remain separate because identity is ID-based. Invalid project or folder entries are isolated; orphaned or cyclic folder branches are removed, and the first valid session assignment in a scope wins. Top-level legacy shape/read failures and authoritative-state write failures still abort initialization without creating an authoritative empty file. This tolerance applies only to first-run import; mutation requests and authoritative files remain strict. Pins and worktree order intentionally begin empty because their former browser-local values cannot be imported safely by the server.

## Operations

Every mutation requires a non-negative `baseRevision` and a stable `clientMutationId`.

- `project.add`: `{ type, project, index? }`. The default index is the end.
- `project.remove`: `{ type, projectId }`. Removal also clears that project's worktree order.
- `project.update`: `{ type, projectId, patch }`. `id`, `lastOpenedAt`, and `sidebarCollapsed` cannot be patched. `null` removes optional metadata.
- `project.move`: `{ type, projectId, toIndex }`.
- `session.pin` / `session.unpin`: `{ type, sessionId }`.
- `worktree.move`: `{ type, projectId, path, toIndex, orderedPaths }`. `orderedPaths` is the client's complete pre-move visible worktree order. The core normalizes and deduplicates paths, moves `path`, then persists the complete result. Supplying the complete list makes the first move well-defined even when no custom order exists yet.
- `worktree.clearOrder`: `{ type, projectId }`.
- `folder.create`: `{ type, scopeKey, folder: { id, name, createdAt, parentId } }`.
- `folder.rename`: `{ type, scopeKey, folderId, name }`.
- `folder.delete`: `{ type, scopeKey, folderId }`; descendants are deleted recursively.
- `folder.assign`: `{ type, scopeKey, folderId, sessionIds }`; each session belongs to at most one folder in a scope.
- `folder.unassign`: `{ type, scopeKey, sessionIds }`.
- `folder.cleanup`: `{ type, scopeKey, existingSessionIds, pruneEmpty }`; cleanup also removes orphaned descendants.

Project and session IDs are trimmed ASCII identifiers with bounded lengths. Project and worktree paths must be absolute POSIX, Windows drive, or UNC paths. Normalization converts backslashes, removes redundant separators and dot segments, resolves safe `..` segments, preserves roots, and uppercases Windows drive letters. Stored paths must already be canonical; non-canonical persisted data is treated as malformed rather than silently rewritten.

## Authority And Failure

- A successful initialized empty snapshot is authoritative empty state.
- Missing state throws `SidebarStateNotInitializedError`; malformed JSON or schema throws `SidebarStateCorruptError`. Neither becomes an empty snapshot.
- Calls are linearized through a recoverable FIFO. A rejected read or write does not poison later queue entries.
- A new mutation must match the current revision. A mismatch throws `SidebarStateConflictError` with the latest snapshot and performs no write.
- Dedupe lookup happens before revision comparison. Retrying an already-applied `clientMutationId` is safe even with its original stale revision.
- Reusing a retained `clientMutationId` for a different normalized operation throws `SidebarStateIdempotencyError`.
- Accepted mutations increment revision even when their semantic effect is already satisfied. This gives every persisted mutation a unique revision and keeps the dedupe ledger ordered.
- Dedupe records are persisted in the same atomic storage envelope as the snapshot and are bounded. Once a key ages out, it is no longer idempotent.
- Writes use a unique sibling temp file opened with `wx`, mode `0600`, followed by rename. No direct-write fallback exists. A write or rename failure removes the temp file where possible, throws `SidebarStateWriteError`, and leaves the prior file authoritative.
- The module contains no logging. Callers must not log request bodies, snapshots, paths, labels, or error causes.

The queue coordinates one server process. Multiple processes must not share the same state file without an external lock.

## Performance Contract

Sidebar structure mutations are low-frequency server/disk work, not a render or stream hot path. Each accepted mutation performs one strict read, bounded validation/dedupe lookup, one in-memory semantic update, and one atomic file replacement. Work is linear in the bounded snapshot size. Reads and writes reject storage above 16 MiB. The persisted dedupe ledger defaults to 256 records and cannot exceed 4096. The core has no polling, background timers, unbounded history, or stale in-memory authority cache.

## Route Integration

- `GET /api/sidebar-state` returns the authoritative snapshot. A storage failure is a `5xx`, never an empty success.
- `POST /api/sidebar-state/mutations` accepts only `baseRevision`, `clientMutationId`, and one semantic operation. Validation is `400`; conflicts are `409` with `latestSnapshot`; storage failures are `5xx`.
- `GET /api/session-folders` remains a read-only compatibility projection. Legacy whole-file POST writes are rejected with `SIDEBAR_STATE_LEGACY_WRITE_REJECTED`.
- Global `openchamber:sidebar-state.changed` events carry only the new revision and prompt clients to refresh; snapshots and paths are not broadcast.
- The UI retains `activeProjectId`, `lastOpenedAt`, all collapse state, and view preferences locally. VS Code intentionally reports this API unsupported and keeps workspace-local structure.

## Tests

Run the focused suite with:

```bash
bun run --cwd packages/web test -- server/lib/sidebar-state/runtime.test.js
```
