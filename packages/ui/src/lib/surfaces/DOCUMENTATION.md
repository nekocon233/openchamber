# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces, the desktop workspaces switched by the vertical rail
(`components/layout/ContextPanelRail.tsx`) and rendered in the zones
around the chat by `components/layout/ContextPanel.tsx` (one per zone) and
`components/layout/ContextSurfacePanes.tsx`.

## Model

Full-screen extension pages are separate from this rail registry. `contributes.page` appears in one sidebar-header menu and uses `useUIStore.openGuestPageId`, the same mutually exclusive main-page lifecycle as Archive and Scheduled tasks. It mounts `PluginPane` with `surface="page"`, closes on runtime switch/uninstall/disable, and is not persisted. `openContextSurface` and the guest's `openSurface` cannot open a full-screen page. `openPage` opens only the calling extension's own declared page. Work Status sections (`contributes.statusSection`) are not rail surfaces either: they mount `PluginPane` with `surface="status"` inside the chat's Work Status panel and never open a tab. The entry-point restrictions below describe context-rail surfaces only.

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
  Built-in modes stay a closed list. Installed guests add `plugin:${id}`
  surfaces through `extras` on `sortContextSurfaces` /
  `getVisibleContextRailSurfaces`. Do not copy guest types out of
  `@openchamber/sdk`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces (chat) are hidden from the
  rail until a tab of their mode exists, and stay visible for as long as one
  does — they must not disappear while in use.
- Native task information is shown in Work Status. The retired `tasks` mode
  and its mobile workspace tab have no entry point. Persisted task tabs,
  dimensions and placements are discarded by the known-mode validator.
- In classic layout, `defaultWidth` is the panel width in px, used until the user resizes that
  surface (640 for the wide surfaces, 540 for most, 480 for Git; guest panels
  540). A resize is remembered in px per mode in
  `useUIStore.contextPanelByDirectory[dir].widthByMode` and restored on reload.
  The width does not follow the chat area: a sidebar toggle or a window resize
  leaves it alone, and it only narrows when it would leave the chat less than
  its minimum column. `ContextPanel` keeps the chat area's width as state only
  while it decides something (expanded, or that ceiling binds), and applies a
  change that arrives during a side-column animation once it ends. Older
  builds also stored `widthFractionByMode`; hydration ignores it and keeps the
  pixel width the same resize stored.
  In classic layout the file surface stores its full editor width under `file`. Without an
  editor, the panel uses `contextEditorTreeWidth`, the same pixel width as the
  docked file tree. Resizing the tree-only panel updates that shared tree width
  without changing the zone's width. Old `file-tree` width entries are
  discarded on hydration. Tree-only mode temporarily suspends panel expansion;
  reopening the editor restores its previous expanded state. The tree docks
  to the side `fileTreeSide` names (right by default, Settings › General ›
  Navigation) and stays aligned there at its saved width during the panel's
  collapse transition. The header's two layout icons keep their places and
  toggle whichever column stands on their side.
- Editor layout uses one device-local `editorToolPanelWidth` for all side tools,
  including the directory and guest panels, across projects. It starts at 320 px.
  Switching tools preserves the column width; resizing one saves the shared width
  on release. The directory tree fills that column. Classic per-mode widths and
  the classic tree width keep their values. Bottom panels follow the chat width
  and retain their per-mode heights. The fit controller uses the shared width too,
  so a tool switch alone does not fold other columns or open an overlay.
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
  `ContextRailSurfacesDialog` edits this same order with drag handles beside
  the visibility checkboxes (`SettingsSortableVisibilityList`, which the phone's
  workspace tab settings also use; those tabs keep their own per-device order
  and hidden set, `lib/mobileWorkspaceTabs.ts`), including hidden panels. Mouse, touch and keyboard
  drops update the rail immediately; visibility changes and "Show all" preserve
  the order. Dialog reorders retain saved ids of unavailable extensions at the
  end of the preference. Escape cancels a drag before closing the dialog.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts`): it drops surfaces the user hid
  (`useUIStore.contextRailHiddenSurfaces`, edited from the rail's trailing
  configure button — `ContextRailSurfacesDialog`),
  drops the walkthrough on VS Code and below `WALKTHROUGH_MIN_WIDTH`, hides the Tracker
  unless a source-control account is connected (signed in from Settings →
  Integrations) or an item is open in it, and hides `has-content` surfaces
  until a tab of their mode exists. Both consumers use it so the digit shown
  on a rail badge always maps to the same surface the shortcut opens.

## Zones

Surfaces open in one of three zones around the chat (`lib/workspace/zones.ts`):
`right` (the context panel), `left` (before the chat)
or `bottom` (under the chat column only; the side zones
keep the full height). The chat is always the centre and cannot move.

Settings > General > Navigation offers `workspaceLayout`, a profile preference
for desktop web, PWA and Electron. `classic` remains the default. `editor`
puts the session list at the line's start, followed by the rail, left tool zone,
resident file editor, framed chat and right tool zone. The
global titlebar holds session entry points, project identity and native
window controls. Conversation title, tabs and actions occupy the chat frame's
header. RTL mirrors this order.
VS Code, hosted mobile and Capacitor keep their own layouts.

Every surface without a manual placement follows the layout default: left in
`editor`, right in `classic`. This includes every built-in and guest panel,
including guests installed after the layout was selected. Tool entry points use this rule, including the rail and shortcuts. In editor
layout document links select the resident editor without switching tools. Explicit
zone commands and the Work Status card retain their own zone.

Manual placements survive layout changes, repeated settings applies and hydration.
The `file` placement controls the directory panel in editor layout. The file
editor is a fixed host, outside the draggable zones. It remains visible with
an empty state when no file is open. `FileEditorPane` moves one `FilesView`
instance between that host and the classic file panel through `MovablePane`.
The file tree side and editor visibility preferences apply only to classic
layout; entering editor layout leaves their saved values alone.

Changes has one document tab in the resident editor. Its file list stays in
the tool zone and its comparison toolbar and details occupy that document.
Opening Changes from the rail opens both; picking a listed file selects and
navigates the document. The list and document close independently. Selecting
an existing document does not switch the tool zone. Moving the Changes tool
moves only the list. Classic keeps its combined Changes view.

Open sessions and New session stay at the titlebar's start. Open sessions shows
the complete session browser in a dropdown below its button. Selecting or
reselecting a session closes it, as do Escape, clicking outside, and the trigger.
This picker owns local open state and does not toggle or persist sidebar width
or visibility. The existing sidebar shortcut keeps its own behavior. The session list
has no titlebar strip or window-edge peek in editor layout and resizes from
its inner edge. The rail's top button (`layout/SessionsRailToggle`) shows and
hides it: pressed while the column is open, and the one control left at the
line's start once its width is zero. Classic keeps the rail at the end and gets
no such button; the hover peek there stays as it was. The main chat frame cannot
close or move into a tool zone.
In editor layout the session column is a framed card like the editor and chat:
the same hairline edge, 10 px radius and background, flush with the top and
inset by 4 px on both inline sides and the bottom. Its saved width is the whole
column, gutter included, and the fit controller keeps counting that width. A
narrow window floats the same card over the chat and keeps its scrim and
dismissal. Classic keeps its full-height divider.
Adjacent editor-layout cards leave a 0.25 rem gap. The bottom tool aligns
with the chat frame; classic layout keeps its existing gutters.

Editor and chat start with equal shares. `editorChatSplitRatio` is device-local;
`EditorWorkspaceColumns` clamps the editor to 320 px and chat to 400 px, including
their gutters, and saves only when a drag ends or a keyboard adjustment completes.
`EditorWorkspaceFit` folds sessions first and then side tools when those minimums
would not fit. It restores only panels it folded automatically. Manually reopening
a panel in that space makes it an overlay; at most one overlay is open. Its
trigger, an outside click or Escape closes it. Editors, terminals and open menus
retain their own Escape handling. Enough room docks an open overlay again.

Panel width limits reserve both fixed columns and exclude floating panels.
The fit controller measures the frame including navigation and reserves the
rail width once. Tool sizing and drag targets measure the inner row, which
excludes navigation and the rail.
The bottom zone and its drop target measure only the chat column. Side drop
targets exclude sessions and the resident editor's interior. Work Status measures
chat plus the right slot, excluding the editor. The left zone expands over the
tool row, leaving navigation and the rail accessible.

- Placement is per surface and per device: `useUIStore.contextSurfaceZones`
  records explicit `left`, `right` or `bottom` choices. Missing modes follow
  `getDefaultContextZone(workspaceLayout)`. Zone resolvers require that default
  explicitly, so rendering, opening and visibility agree.
- A layout change or hydration rehomes visible tabs atomically with the layout.
  When visible tabs meet in one zone, the most recently touched wins; ties keep
  the destination's existing tab. All tabs and dimensions survive. Closed
  surfaces stay closed and a relocated visible tab opens without expansion.
- Store version 25 preserves explicit right placements. Older saved left and
  bottom choices remain explicit; an omitted choice follows the layout. Earlier
  versions did not distinguish a manual right placement from the old default.
  Hydration reconciles already-open panels, including an existing editor layout.
- Each zone works like the right panel always has: the rail switches what it
  shows, multi-instance surfaces list their instances in its strip, and it
  closes, expands (one zone at a time) and resizes on its own. Per directory,
  the right zone keeps the panel's original top-level fields and the other two
  live in `zones`; read them through `getZoneView` / `resolveZoneActiveTab`,
  which never return a tab whose surface is placed elsewhere.
- A surface moves by dragging a rail icon out of the rail, a tab out of its
  strip (the zone's own, or a surface's own such as the terminal's, through
  `zoneSurfaceDragContext`), or a zone header anywhere no control takes the
  pointer (`components/layout/zoneDrag.ts`; a native listener, since surface
  toolbars are portalled into the header), or from "Move panel to …" on a
  tab's or rail icon's context menu. Targets are
  measured once at drag start; the layout changes once, on drop
  (`moveContextSurfaceToZone`). A surface that was on screen stays on screen
  in its new zone, in every project; one that was not is opened by the drop.
- Keep-alive surfaces mount once in `ContextSurfacePanes` and are portalled
  into the body of their zone (`MovablePane`), so a move keeps the editor's
  unsaved text and undo, the terminal session and the walkthrough's place. An
  Electron webview reloads whenever its element moves, so a browser tab
  reloads when its surface moves to another zone; nothing else moves it.
- In classic layout the chat keeps 400 px: a side zone that opens without
  room folds the session sidebar, then closes the other side zone, and both
  come back when it closes (`ZoneFitArbiter`, `lib/workspace/zoneFit.ts`).
- Another window's placement snapshot is adopted through the `storage` event
  (`zoneSync.ts`); each window keeps its own tabs and visible state. An empty
  map restores the layout default, while an absent field or unreadable event
  leaves the current placement alone. Adopting a snapshot records only explicit
  choices, including choices that currently equal the layout default.

### Why an expanded zone stays in the layout and not over the chat

It used to float over the chat with a spacer holding its docked size, so the
chat kept its width underneath and was hidden. People expand a zone to read
a diff or a page next to the agent's work and still want to write to it.
The float existed because collapsing straight back into the layout squeezed
the chat to nothing and the transcript measured its rows at that width; with
the chat column never below its minimum that cannot happen.

### Why the drag is not deferred

The zone used to apply its size at most every 100 ms and let its 240 ms size
transition carry each step, so a reflow of the chat and the surface would not
run on every pointer move. The edge trailed the pointer by 60 to 90 px, and
the transition re-laid out the chat and the surface on every frame anyway.
Following the pointer each frame costs about a fifth of the main thread with
a 120-turn session and an open editor, once the work that reacts to widths
waits for the release.

## Adding a surface

1. Built-in: add a `ContextPanelMode` value in `packages/ui/src/lib/surfaces/modes.ts`
   (the sanitizer uses `isContextPanelMode`). Register a descriptor here.
   Render the mode in `ContextPanel.tsx`. Add label/hint i18n keys.
2. Guest panel: ship a package with `openchamber.contributes.panel`. The host
  lists it from `GET /api/guests` and renders `PluginPane`. Settings →
  Extensions installs a folder path on that OpenChamber instance. A runtime
  switch clears the catalog so a previous instance cannot leave a rail slot
  from the last host. The rail paints `panel.icon` as a Remixicon glyph.
  `contributes.attach: true` or `"panel"` puts a row on
   the desktop/web chat + menu that opens `plugin:${id}`. `"dialog"` opens a
   host window around the same iframe so the guest can pick an item and call
   `attach`. New Worktree also opens that window for dialog guests. The guest
   still owns the list and HTTP. VS Code and mobile omit the row. Do not add
   a built-in mode for that guest.

## Tracker

The `pr` surface is the Tracker. Its strip lists instances like files and
chats do. The first tab is always the workspace's repository view
(`views/PullRequestView.tsx`): project PRs and CI runs on GitHub, or the branch
workflow on GitLab. It sorts
first, has no close button, and `closeContextPanelTabs` and the per-surface
tab budget never remove it. Every other tab is one issue, pull or merge
request or tracker item (`views/TrackerItemView.tsx`), opened by
`useUIStore.openTrackerItem` with the item's link as `targetPath`, a dedupe key
naming the item whatever page of it the link opens (`${provider}:${IDENTIFIER}`
for a tracker item, `linear:ENG-12` as before), and the project it is read
through as `targetDirectory` (none when that is the panel's own project).
`components/sourceBoard/openTrackerItem.ts` decides that project from the
session the link belongs to, so opening an item never moves the app to
another project. A tracker item link is one a served tracker's descriptor
claims (`lib/trackers/matchTrackerUrl.ts`); a tracker the connected server
does not serve opens its links in the browser.
A project that is a folder of repositories, with no repository at its root,
reads the item through the repository under it whose remote is the link's,
origin first, then any other remote such as a fork's upstream
(`useLinkRepository` in `sourceBoard/boardRepository.ts`). The Git selection is
not touched, and a link no repository there points into answers as one the
project cannot read.

The item tab reads and acts on the item the way the board's preview does,
with no new-session or worktree actions; attaching it to the session on screen
stays. A link its project cannot read, the host not knowing it or no account
reading it, opens in the browser and its tab closes, but only for the click
that just opened the tab and before it ever showed the item
(`wasTrackerItemRequested`). A tab restored on launch, or one that showed its
item before, says it cannot read it with a button to the browser, and a
failed read shows Retry. A tracker answers a missing item and a failed read
the same way, so a tracker item's tab, for every tracker, falls back only on
that first read.

Changes and the walkthrough opened from another project's PR keep that
project's folder as their tab's `targetDirectory`, so they read the PR through
that project's binding beside the chat on screen. Changes then shows that PR
only: no scope switch, no last-turn or review actions, no opening files in the
editor, since none of those belong to the session on screen. Opening either
surface from the rail, or Changes from anywhere that names no folder, returns
it to the panel's own project. Such a tab is saved as the panel's own: the PR
it was asked to show is held in memory only (`usePullRequestSelectionStore`),
so after a restart it would show whatever that project has checked out.

The rail icon is the project's host: its provider's sprite icon, else the mark
the descriptor serves as an icon URL (`providerIconSrc`), or `ticket-2` for a
project with no host. While the host is still unknown the rail shows the first
registered provider, as it did before hosts were read. Closing a Tracker whose
account disconnected waits until any provider's default instance has answered
an auth check.

## Workflows

The `workflows` surface shows the workflow runs of the project, every
session's (`components/chat/workflows/WorkflowsPanel.tsx`), one run at a time.
Workflows belong to the project as project actions do (`lib/workflows/project.ts`):
its runs are those of sessions in the project's folder and in its worktrees, and
its saved workflows are the project folder's, also when the session is in a
worktree. The run picker, the views (agents, log, result, script) and the run's
one action share the panel header, which gives up labels as it narrows
(`useToolbarFit`).
The picker lists the session on screen's runs first, then the other sessions'
with their session named, then the project's saved workflows. A run of another
session keeps all of this and adds Open session. Running a saved workflow asks
first, then starts it in the session on screen, or in a new session when none
is open (a draft), which opens; the run is that session's as if its agent had
started it, and its report comes back there. With no runs the panel lists the
saved workflows to run. The agents view lists each phase's agents with model,
time, tokens and cost above a summary line, and a row opens to the agent's
answer; a JSON answer or result is laid out as fields, with a list of records
as one block each (`WorkflowAnswerBlock`), and the JSON itself one toggle away.
Which run it shows is per session (per directory with no session open) and
memory only (`lib/workflows/panel.ts`): the session's newest, else the
project's. The picker deletes a finished run after a confirmation; the removal
reaches every client as an event, and a read on its way never brings it back.

Its rail icon shows while the project (worktrees included) has a run or a saved workflow or a
Workflows tab is open (`useWorkflowsSurfaceShown`, and `isWorkflowsSurfaceShown`
for the shortcut). While workflows are not shown (`selectWorkflowsShown`: VS
Code, or the workflow tool off) it is absent from the rail and from the rail's
surfaces dialog, and turning the tool off closes open Workflows tabs, as
memory's tab goes with its tool.

## Panel header

The panel has one header row. A single-instance surface with its own toolbar
(terminal, walkthrough, git's branch and sync controls, the notes
search, the context surface's session title) renders that toolbar through
`ContextPanelHeaderToolbar` (`components/layout/contextPanelHeaderSlot.tsx`)
instead of stacking a second row under the header: the toolbar replaces the
mode label and sits beside the fullscreen and close buttons. ContextPanel
provides the header element only to the surface on screen, so inactive tabs
and hosts outside the panel (the mobile workspace drawer) get no slot and
render the toolbar inline as before. A surface nested inside another one that
owns the header (the plan opened from the notes panel) is given a null slot. The label comes
back whenever no toolbar is mounted, so empty and loading states stay named.
Git moves only its first row: identity, pull request and upstream state stay
in the body below.

The directory in editor layout uses that same slot for its Files title, compact
search field and existing file actions. The search grows between the label and
actions without adding a row above the tree. The classic
multi-instance file strip keeps its own header and inline directory toolbar.

Changes uses `ContextPanelHeaderToolbar` with `preserveTitle` for its compact
return and file type actions. This variant retains the mode label and hugs its
controls instead of replacing the title with a full-width toolbar. Comparison
controls stay above the diff content. In editor layout the file list receives
its zone's header slot explicitly. Hidden or inactive lists release
their titlebar actions, and a host without a slot keeps its inline toolbar.
Extension panels (`GuestPanelPane`) use the same `preserveTitle` slot for any
controls published through `setStatusControls`, and full-screen extension pages
(`GuestPagePane`) portal theirs beside the page title in `Header`.

No new header buttons: the rail, `openContextSurface`, the composer +
menu (`contributes.attach`), and New Worktree's guest icons are the entry
points for opening surfaces or the attach window directly; deep links from
chat/palette go through the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, an in-content link, a composer + menu row from
  `contributes.attach`, or New Worktree's guest icons for dialog attach.
- Multi-instance and session-holding surfaces (file/editor, diff, browser,
  terminal, pull requests) are keep-alive panes in `ContextSurfacePanes.tsx`. Switching these
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Chat tab records stay open, but only the active chat tab's
  pinned chat column is mounted while the panel is open. A selected chat
  restores its state from the session stores. A closed panel mounts no chat.
  The PR pane uses React Activity to retain its list, preview and drafts while
  disconnecting effects and subscriptions when hidden. Its zone can close and
  reopen or move without remounting it. Visited PR tabs in other projects stay
  mounted with their own explicit directories; an unvisited tab stays asleep.
  Closing a tab removes its view, and a runtime switch clears the retained set.
  GitHub PR links reveal that same surface without toggling it closed. Its
  linked preview retains the normal list and branch views, and may read from
  a source directory different from the workspace hosting the pane. Opening
  another project's PR leaves the current conversation and project selected.
  Singleton surfaces (git, notes, context) remount on switch. These
  surfaces must restore their state from stores or snapshots.
- Escape never closes a zone. It belongs to what has focus inside (a menu, a
  field, the editor, the terminal), and a stray press while dismissing one of
  those used to take the whole panel with it.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.
  Trackers have no rail surface: their items list on the issues and PRs board
  (`components/sourceBoard`). A Linear tab persisted by an older version is
  dropped on load, like any unknown mode.
