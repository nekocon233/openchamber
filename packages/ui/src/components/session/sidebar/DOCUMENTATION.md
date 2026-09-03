# Session Sidebar

Sidebar code is organized by the business object it owns. Shared contracts are
kept at this root in `types.ts` and `utils.tsx`.

- `shell/` owns sidebar chrome, navigation, search, confirmations, and switcher effects.
- `list/` owns global-first session collection, directory bootstrap demand,
  layout-owned synchronization, authoritative cleanup, and nearby-session prefetch.
- `projects/` owns project zones, grouping, ordering, scroller behavior, project
  view state, repository state, and worktree presentation.
- `sessions/` owns session rows, row actions, expansion, ownership, and activity indicators.
- `recent/` owns Pinned, managed Chats, and Recent activity projections.
- `folders/` owns folder DnD, bulk actions, archived folders, and folder UI.
- `SessionSidebar.tsx` is orchestration only. It discovers worktrees, wires shell actions, and mounts the visible collection.
- Web and desktop render optional Pinned, managed Chats, optional Recent, then project zones. All three activity-zone visibility choices are device-local and independent. VS Code keeps its workspace-scoped grouped list and excludes those activity zones and worktrees.
- `by-worktree` renders slim PR-aware worktree headers. `flat` renders one merged active group per project with per-row branch markers. Both modes derive from the same project section data.
- Session rows use one single-line layout. `busy` and `retry` use `SessionRunningIndicator`; unread rows use a static info dot. `SessionActivityDuration` replaces the metadata slot while running and remains after settlement only while the row is unread.
- Collapsed project, group, and folder activity is always a static aggregate dot. A spinner is reserved for one identifiable running session or the short worktree-move operation.
- Parent expansion is manual. Each project, Pinned, Recent, active, and archived render context has an independent persisted key. Collapsing a parent clears only expanded descendants in that same context.
- Project collapse, group collapse/order, parent expansion, selection, and display preferences are device-local. Shared project/folder/pin/worktree structure follows the runtime sidebar-state authority; VS Code retains its local fallback.
- Recent includes non-archived root sessions that are active now or inside the timestamp window. It excludes child and archived sessions.
- Folder and project/worktree DnD use stable entity IDs, never array positions. Reordering commits only on drag end.
- Root session right-click and overflow menus expose `Move to worktree`: a submenu
  listing the canonical primary and linked worktree destinations, with the current
  target disabled and a separate `New worktree...` action. Opening the submenu
  refreshes the worktree topology. Moving transfers the full idle subtree. Clean
  and non-Git sources move session-only; a dirty Git source prompts to move only
  the session, move all source changes, or cancel. Descendants move first without
  changes and roll back session-only if a later descendant fails. The root moves
  last and carries source changes once, which prevents rollback from replaying the
  transferred patch into the source.
- Failure cleanup: a worktree created for the move is removed only after a
  definite failure. When the change-carrying request fails without confirming
  its outcome, that worktree is KEPT (it may hold the only copy of the user's
  changes), both directories are refreshed authoritatively because the session
  may have moved server-side, and the toast points the user at the destination.
  Existing destinations are never removed; they get the same guidance.

`MainLayout` and `VSCodeLayout` call `useSessionListSync({ isVSCode })`
unconditionally. The hook publishes complete directory bootstrap demand,
refreshes newly added topology, coalesces control events, and performs
authoritative cleanup. Root-level `useGlobalSessionsPolling` remains the only
initial and 45-second global poller. `useSessionListSync` must not create a
second global polling lifecycle.

The global sessions cache is the complete source for active and archived
coverage. Initialized directory stores only supply sessions missing from that
cache. Live busy and retry state comes from `global-session-status`, never from
the global cache or persisted history. A failed global or directory fetch keeps
existing data; it is never treated as an authoritative empty list.

## Persistence boundary

- Web, desktop, hosted mobile, and Capacitor mobile share project structure, project order, pinned sessions, worktree order, session folders, and folder assignments through the revisioned `sidebarState` runtime API.
- Active project/session selection, recency, project/worktree/folder collapse, activity-section expansion, width, search, and display preferences remain device-local.
- VS Code intentionally keeps project structure, pins, and folders workspace-local because its runtime API declares authoritative sidebar state unsupported.
- Views call the existing projection-store actions; those stores submit semantic mutations and reconcile authoritative snapshots. They must not POST the legacy whole-file session-folder payload.

## File summaries

### Components

- `shell/SidebarHeader.tsx`: Header toolbar for add-project, Scheduled/Multi-run/Archive full-page entry points, session search, selection mode, project sort, grouping, Pinned/Chats/Recent visibility, sticky headers, and collapse/expand all.
- `shell/SidebarNav.tsx`: New-session text row above the tree; hidden in VS Code.
- `recent/SidebarActivitySections.tsx`: Pinned, managed Chats, and Recent renderer. Chats use the managed root; Pinned and Recent each use a separate render context from project rows and each other.
- `shell/SidebarFooter.tsx`: Static footer with icon-only settings, shortcuts, about, and update actions.
- `projects/SessionProjectScroller.tsx`: Main scrollable renderer for project zones and their flat/archived groups; owns project and group drag-to-reorder.
- `projects/SessionGroupSection.tsx`: Renders one flat or archived group: sessions first, then flat folder entries with path labels, show-more batching, and explicit loading/error/retry state. Archived buckets virtualize past 50 rows.
- `sessions/SessionNodeItem.tsx`: Renders one session row/tree node with a single-line layout, inline branch label, indicators, menu actions, and nested children. Rows do not initiate directory bootstrap on mount.
- `sessions/collapsedActivityIndicator.tsx`: Aggregate busy/unseen dot for collapsed projects, groups, and folders.
- `shell/ConfirmDialogs.tsx`: Shared confirm dialog wrappers for session delete and folder delete flows.
- `projects/sortableItems.tsx`: DnD sortable wrappers for project/group ordering and project headers.
- `folders/sessionFolderDnd.tsx`: Folder/session DnD scope and wrappers for dropping sessions into folders.
- `sessions/sessionOwnership.ts`: Resolves session directories once into shared project/worktree ownership and folder-scope indexes.

### Hooks

- `sessions/useSessionActions.ts`: Centralizes session row actions (select/open, rename, share/unshare, archive/delete, confirmations).
- `shell/useSessionSearchEffects.ts`: Handles search open/close UX and input focus behavior.
- `list/useSessionPrefetch.ts`: Publishes directory-aware nearby/active session prefetch demand to the shared message loader. Pinned and Recent may prefetch across projects without substituting the current directory.
- `projects/useSessionGrouping.ts`: Builds grouped session structures and search text/filter helpers.
- `projects/useSessionSidebarSections.ts`: Composes final per-project sections and group search metadata for rendering.
- `projects/useProjectSessionSelection.ts`: Resolves active/current project-session selection logic and session-directory context.
- `folders/useArchivedAutoFolders.ts`: Maintains archived auto-folder structure and assignment behavior.
- `projects/useSessionProjectViewState.ts`: Restores and persists device-local project collapse, group order, and group collapse state. It never writes collapse state into host project settings.
- `sessions/useExpandedParents.ts`: Restores device-local parent expansion and clears descendants only inside the collapsed row's render context.
- `projects/useProjectRepoStatus.ts`: Tracks per-project git-repo state and root branch metadata.
- `projects/useProjectSessionLists.ts`: Reads live and archived project buckets from the shared ownership index.
- `list/useAuthoritativeSessionCleanup.ts`: Establishes the first complete active+archived list as a non-destructive baseline, then cleans persisted state only for sessions omitted by a later authoritative snapshot.
- `projects/useStickyProjectHeaders.ts`: Tracks which project headers are sticky/stuck via `IntersectionObserver`.

### Types and utilities

- `types.ts`: Shared sidebar types (`SessionNode`, `SessionGroup`, summary/search metadata).
- `recent/activitySections.ts`: Pinned/Recent membership and projection helpers. Pinned membership follows the runtime-directory-session pin identity without a time limit. Recent includes non-archived root sessions that are active now or fall within the timestamp window.
- Active global session metadata wins over an older child-store cache entry. Once the global list is authoritative, live-only rows are admitted only from child stores that completed bootstrap; this preserves externally created sessions without resurrecting deleted cached sessions.
- The mobile sheet combines live child-store status, global status events, and a bounded, abortable, revision-gated per-directory status reconciliation while open. Rendering a row never bootstraps a directory or fetches message history. The phone drawer and tablet sidebar stay mounted across close/collapse transitions so project and worktree state remains warm; the phone's status reconciliation is gated by its `open` state.
- Desktop session rows, the header switcher, and command-palette session results resolve each session from the global event-backed status first and the initialized child-store status second. `busy` and `retry` use the shared rotating loader while explicit global `idle` overrides stale child activity. These surfaces subscribe per session and do not copy the mobile sheet's polling into permanently mounted desktop UI.
- Archived rows are historical: they neither bootstrap their referenced directory nor subscribe to live status/permission state.
- `utils.tsx`: Shared sidebar utilities (path normalization, dedupe, archived scope keys, project relation checks, text highlight, labels, and compact date formatting). Shared session ranking lives in `sync/session-ordering.ts`.
- `list/sessionBootstrapDemands.ts`: Builds the deduplicated directory demand plan. Selected directories rank above active projects, expanded groups, visible collapsed groups, and background/collapsed projects.

Web, desktop, and the mobile sessions sheet show optional Pinned, optional
managed Chats, then optional Recent activity before the project tree. They use
the same device-local visibility preferences. Chats use their shared managed
root for folders and never expose worktree actions. Pinned and Recent duplicate
their project rows intentionally and retain child-session trees. Project display
can be all projects or one selected project. VS Code excludes worktrees and
managed Chats, while retaining its workspace-scoped grouped list and inline
archived buckets.

Directory demand always includes known project roots and worktrees. Visibility
only changes priority. Row mounts must not start bootstrap work. Selection and
activity subscriptions stay session-scoped so a structural list update does not
make every row observe unrelated streaming updates.

## Loading rules

- Always publish every known project root and worktree directory. Collapse/visibility changes priority only; they do not opt a directory out of authoritative refresh.
- Current directory and selected-session directory are `selected` demand and therefore run first.
- Expanded projects/worktrees outrank merely visible and background groups.
- The sync scheduler deduplicates, promotes, retries, and limits work. Sidebar components must not reproduce that lifecycle with mount effects.
- Hide speculative work when the sidebar/chat surface is hidden: message prefetch, Git/PR enrichment and subscriptions, search listeners, sticky-header observation, and archived-folder derivation stop. The session row tree unmounts so row-owned status, permission, unseen, and viewport subscriptions do no background work. The outer sidebar remains mounted, preserving UI state and authoritative directory refresh for an immediate reopen; deferred derived work reruns from current state when visibility returns.
- The sidebar does not subscribe its whole tree to the cross-directory live-session aggregate. Global create/structural/lifecycle snapshots drive rendered session metadata; the cached sync index only fills sessions not yet present globally and provides refresh fallback data. Row activity continues to come from the session-keyed live status index.
- Session selection does not invalidate the sidebar orchestration component. Each mounted row selects only whether its own session ID is active, while parent expansion, project selection memory, and neighbor prefetch run in small effect-only subscribers.
- Parent expansion is exclusively manual. Selecting or navigating to a subsession never expands its parent automatically.
- Expanding adds only the parent key. Collapsing walks descendants only in the interaction path, clears every expanded descendant key in the same render context and active/archived bucket, and persists the result once. Other roots remain unchanged, and no descendant list is retained in state.
- Project/worktree, Pinned, and Recent trees use independent persisted context keys, with active and archived buckets separated. Expansion changes in one context neither invalidate nor change the others. The persisted storage key remains `v3`; older state mixed contexts and is not migrated into this contract.
- Folder membership may contain both a parent session and its descendants. Rendering treats only the highest assigned ancestors as folder roots because their normal session trees already include assigned descendants; persisted membership remains unchanged for cleanup and move semantics.
- Sidebar selection holds the clicked row's viewport position across navigation-driven sidebar updates. Wheel or touch input cancels the hold immediately, so programmatic compensation never fights intentional scrolling.
- Global session subscriptions are structural: create/delete, title, share, archive, directory, parent, and slug changes invalidate the tree. Recency-only `time.updated` changes do not trigger a rebuild. The separate lifecycle rank invalidates ordering only on `settled ↔ active` transitions, with root sessions ranked among roots and child sessions only among siblings of the same parent.
- Opening the root-session `Move to worktree` submenu force-refreshes the owning project's worktree topology so externally created worktrees appear without a full reload. While that refresh runs, the menu keeps the last known primary/linked topology visible; if the refresh fails, the stale topology remains and the load failure state stays explicit. Failure cleanup never removes or manages an existing destination worktree.
- CLI/server-created sessions use the low-frequency OpenChamber control event stream to refresh only the created session directory. The same event retriggers bounded worktree discovery so a newly created external worktree gains ownership without a view reload; it does not re-enable broad session or streaming subscriptions.
- Recent membership includes active root sessions immediately even when their last committed `time.updated` falls outside the 48-hour window. Children and archived sessions remain excluded, and inactive roots remain timestamp-based. The active-ID subscription is disabled while the sidebar is hidden and ignores retry/status detail changes, avoiding streaming-frequency rerenders.
- Structural updates rebuild grouped nodes only for projects whose local sessions, worktrees, repository state, or branch changed; unchanged project sections preserve references so memoized group/session descendants skip the update wave.
- Empty successful lists, unresolved loads, and failed loads are separate UI states. Failed groups expose Retry and retain prior data.
- Directory permission failures remain visible even when stale sessions are retained. Flat groups inspect every represented root/worktree directory; local Desktop may open the native picker for the exact failed directory, while other runtimes keep the ordinary Retry action.
- Pins and folder assignments are not pruned from the first startup snapshot or from optimistic mutations. Confirmed local deletion and routed external deletion clean immediately; a later authoritative omission after an established baseline covers missed external delete events.
- Pending-permission/question row badges fade with the same hover/menu-open rule as the date label, except on non-VS Code always-visible-actions rows, which reserve permanent padding and keep the badges shown. VS Code hover-reveals its actions over the row's right edge even under `alwaysShowActions`, so its badges keep fading (`selectRowBadgeVisibilityClass` in `sessions/sessionNodeItemUtils.ts`).
