# Session Sidebar Documentation

## Refactor result

- `SessionSidebar.tsx` now acts mainly as orchestration; core logic moved to focused hooks/components.
- Desktop sidebar is a single multi-project tree: independently configurable `pinned` and `recent` top sections, then projects, then worktrees/archived groups, then sessions. The dedicated mobile sheet also renders `pinned` before `recent`, uses the same persisted visibility preferences from its project editor, and remembers each activity section's expanded state; both intentionally duplicate rows from the project tree.
- `NavRail` is no longer part of sidebar/navigation flow.
- Project headers now own root sessions directly; there is no separate rendered `project root` subgroup.
- Active/hover row styling is text-first; selected sessions use primary text instead of background fills.
- Archived groups are collapsed by default and support bulk deletion at group/folder level.
- Session rows support compact inline dates in minimal mode and simplified metadata in default mode.
- New extractions in latest pass reduced local effect/callback bulk further:
  - project session list builders
  - folder cleanup sync
  - sticky project header observer

## VS Code grouping

- VS Code uses the **same grouped project tree** as web/desktop (project headers + folders + pinned-first ordering), not a separate flat list. Each open VS Code workspace folder is a project header.
- VS Code groups strictly **by open workspace**: `useSessionGrouping` funnels every non-archived session into the project's root group and emits **no per-worktree subgroups** (worktrees aren't registered in VS Code). `getSessionsForProject` buckets sessions to a workspace by exact directory match, so only sessions whose directory is an open workspace folder appear.
- VS Code passes `hideDirectoryControls` (clean workspace headers, no worktree/close chrome) and no longer passes `showOnlyMainWorkspace`/`sharedSessionsOnly`. Folders and pinning therefore work natively, scoped to the workspace root.

## Persistence boundary

- Web, desktop, hosted mobile, and Capacitor mobile share project structure, project order, pinned sessions, worktree order, session folders, and folder assignments through the revisioned `sidebarState` runtime API.
- Active project/session selection, recency, project/worktree/folder collapse, activity-section expansion, width, search, and display preferences remain device-local.
- VS Code intentionally keeps project structure, pins, and folders workspace-local because its runtime API declares authoritative sidebar state unsupported.
- Views call the existing projection-store actions; those stores submit semantic mutations and reconcile authoritative snapshots. They must not POST the legacy whole-file session-folder payload.

## File summaries

### Components

- `SidebarHeader.tsx`: Top header UI for add-project, session search, and display mode.
- `SidebarActivitySections.tsx`: Desktop global top section renderer for independently visible `pinned` and `recent` sections.
- A session may intentionally appear in both top sections and in its project tree. Each copy uses a distinct render context so menus and parent expansion remain independent.
- `SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, and about actions.
- `SidebarProjectsList.tsx`: Main scrollable tree renderer for projects, root sessions, worktrees/groups, and empty/search states.
- `SessionGroupSection.tsx`: Renders a single worktree/archived group, collapse/expand, folder subtree, and group-level controls.
- `SessionNodeItem.tsx`: Renders one session row/tree node with inline metadata, menu actions, minimal/default variants, and nested children.
- `ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `sortableItems.tsx`: DnD sortable wrappers for project and group ordering plus project-row action affordances.
- `sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping/moving sessions into folders.
- `sessionOwnership.ts`: Resolves session directories once into shared project/worktree ownership and folder-scope indexes.

### Hooks

- `hooks/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `hooks/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `hooks/useSessionPrefetch.ts`: Prefetches messages for nearby/active sessions to improve perceived load speed.
- `hooks/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `hooks/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `hooks/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `hooks/useGroupOrdering.ts`: Applies persisted/custom group order with stable fallback ordering; archived groups are reorderable.
- `hooks/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `hooks/useSidebarPersistence.ts`: Restores and persists device-local sidebar UI state in browser storage and prunes stale pins after authoritative session loading. Project collapse never writes legacy settings fields.
- `hooks/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `hooks/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `hooks/useSessionFolderCleanup.ts`: Cleans stale folder session IDs by reconciling known sessions/archived scopes.
- `hooks/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `activitySections.ts`: Shared message-activity ordering helpers for desktop/mobile `recent` and `pinned` groups. Cached messages and global `message.updated` events outrank session metadata timestamps; missing message activity falls back to session timestamps.
- Active global session metadata wins over an older child-store cache entry. Once the global list is authoritative, live-only rows are admitted only from child stores that completed bootstrap; this preserves externally created sessions without resurrecting deleted cached sessions.
- The mobile sheet combines live child-store status, global status events, and a bounded, abortable, revision-gated per-directory status reconciliation while open. Rendering a row never bootstraps a directory or fetches message history, and the phone/iPad surface unmounts when closed so hidden subscriptions and status requests do not remain active.
- Desktop session rows, the header switcher, and command-palette session results resolve each session from the global event-backed status first and the initialized child-store status second. `busy` and `retry` use the shared rotating loader while explicit global `idle` overrides stale child activity. These surfaces subscribe per session and do not copy the mobile sheet's polling into permanently mounted desktop UI.
- Archived rows are historical: they neither bootstrap their referenced directory nor subscribe to live status/permission state.
- `utils.tsx`: Shared sidebar utilities (path normalization, sorting, dedupe, archived scope keys, project relation checks, text highlight, labels, compact/default date formatting).
