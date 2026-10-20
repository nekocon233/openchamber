# Work-status panel

A card rendered to the right of the transcript, in the right slot it shares
with the context panel. It reports the state of the current session, its branch, its quotas and its
subagents.

## Structure

Every readout is a **labelled row**: icon, name, trailing value. A number
without a name is unreadable at a glance, which is what an unlabelled stream of
values degenerates into.

Rows are grouped into **named sections**, one component each, composed in
order by `WorkStatusPanel`. The separator between them is a
`:not(:first-child)` CSS rule rather than a prop, because every section renders
conditionally; passing "am I first?" down would mean each one tracking what the
sections above it decided to render.

Sections render nothing when they have no rows, so the panel collapses upward
instead of reserving empty space. Turn stats keeps its header for a
selected session even without metrics, so a saved collapsed state can reopen.

## What it is not

It is **not** a context-panel surface. It is not registered in
`lib/surfaces/registry.ts`, has no rail icon, no tab, no persisted width and no
resizer. It is a card inside the chat column — rounded, with the dropdown's
hairline ring (`oc-panel-edge`, shared with the context panel card), a faint
fill and its own margin — rather than a docked pane flush against the window
edge. Opened over the transcript it is a dropdown and takes the dropdown's
full edge, lit top and tight shadows included (`data-edge-floating`).
When it overlays the transcript, it uses the shared `oc-glass-panel` surface;
the inline card keeps its lighter, non-blurred fill instead.

## Placement

`ChatContainer` owns the card's state, but the inline card renders through a
portal into the right slot (`components/layout/rightSlot.ts`): the context
panel's `aside` in `MainLayout`, which holds a right-anchored host for the card
under the panel's content. The slot animates one width for both, from the
card's column (`WORK_STATUS_COLUMN_WIDTH`, the card and its margins) to the
panel's width and back, while the card fades out and the panel fades in over
it. The chat column therefore narrows or widens once, in one direction.

The card tells the slot whether it wants its column through `reserved`:
switched on, room beside the chat (`roomy`, see below), and something to
show. It stays reserved while the context panel covers it, so closing the
panel goes straight back to the card's column instead of to nothing first.

The overlay form stays inside the chat column in `ChatContainer`.

## Visibility

`useWorkStatusVisibility` hides the panel when any of these hold:

- the user switched it off;
- the runtime is VS Code, or the mobile shell, where the inline and overlay
  forms do not exist and the same sections render in the mobile sheet instead;
- the context panel is open for the directory the app is effectively on —
  looked up through `useEffectiveDirectory` and `normalizeContextPanelDirectoryKey`,
  the same key the rail and the panel use. It is deliberately **not** the
  directory this panel reports about: a managed Chat reports about none, and
  that empty key answered "closed" for a context panel that was plainly open;
- the row cannot fit `WORK_STATUS_MIN_CHAT_WIDTH` of transcript alongside
  `WORK_STATUS_PANEL_WIDTH` of panel. Only that threshold decision is state
  (`roomy`); the width itself is not, because it changes on every frame of a
  sidebar animation and storing it re-rendered the whole chat each frame.

`ChatContainer` additionally suppresses it in mini-chat. It remains available
on a new-session draft: when the draft targets a
project or pending worktree, the panel uses that directory for project, MCP,
and usage readouts before a session exists.

### Mobile sheet

The mobile shell has no right slot and no desktop header, so the panel travels
as a bottom sheet. `MobileSessionMetadata`'s popover carries a Work status row;
the row closes the popover and opens `apps/MobileWorkStatusSheet.tsx`, which
wraps the same `WorkStatusPanel` in `MobileOverlayPanel` with
`presentation="sheet"`.

Sheet presentation changes only the host:

- no fixed width, height cap or inner scroller; `MobileOverlayPanel` owns
  scroll, keyboard insets, the scrim and the Android back layer;
- no right-slot reservation, no scroll-offset persistence and no
  overlay-style outside-click dismissal;
- the equalizer and `WorkStatusSectionsDialog` stay, with the dialog raised to
  `z-70` so it sits above the sheet's `z-60`;
- managed Chats pass `directory=null` and `repositoryEnabled=false`, exactly as
  the desktop panel does.

Rows navigate to the mobile host through `useWorkStatusNavigation`: the
context readout opens the Notes workspace tab, branch and changed files open
Changes, a change request opens Changes in PR mode through
`usePullRequestSelectionStore.requestDiff`, task rows select their tab and open
Tasks, a pinned message requests timeline focus, and a subagent switches to the
child session. Every one of those closes the sheet first. Project actions are
not offered on mobile because `ProjectActionsProvider` is not mounted there.

The desktop rows stay read-only for change requests, because the sidebar
tracker owns discovery. The mobile sheet passes `prewarmPrStatus`, letting
`useWorkStatusPrPrewarm` register the same active context and run one silent
`refreshTargets` on open. The store keeps its 90-second TTL, concurrency gate
and in-flight de-duplication; closing the sheet only releases the
registration. Extension status sections remain empty on mobile by the guest
surface policy.

Managed Chats never render or warm the Project repository section. A Chat draft
also passes no fallback directory to the panel, so an active project's branch
cannot leak into the draft while directory-independent sections remain
available.

`rowRef` is a **callback ref, not an object ref**. An object ref gives no signal
when the node attaches, so the measuring effect read `.current`, found nothing
whenever the row mounted after the effect first ran, and only recovered on the
next unrelated dependency change — in practice, opening and closing the context
panel. `useWorkStatusVisibility.test.ts` covers a row that attaches late.

### Why the chat area is measured, not the chat column

**The width test must observe something the panel cannot resize.** The chat
column's width is an *output* of the visibility decision: hiding the panel
widens the chat, which would re-satisfy a chat-width test and re-show the
panel, which narrows the chat again — an infinite oscillation.

It measures the **chat area** — the container holding the chat and the context
panel together, marked `data-chat-area` in `MainLayout`. Measuring the chat row
instead reported a width still catching up while the context panel animated
closed, so the panel reappeared only once that number crossed the threshold:
the chat widened and then narrowed again. The chat area does not move when the
context panel opens. `useWorkStatusVisibility.test.ts` pins both properties.

The context-panel check mirrors `ContextPanel`'s own derivation: `isOpen` alone
is not enough, because a panel with no resolvable active tab renders nothing
and therefore displaces nothing.

## Data sources

Most sections read shared caches, warming their owning loader when needed.
The panel adds no aggregated endpoint. Quotas use the shared three-minute timer;
native task summaries request their session snapshot once and follow live events.

| Block | Source | Notes |
|---|---|---|
| Context + cost | `contextUsage.ts` over `useSessionMessages`; cost via `useSubagentCostRollup` (own cost + every descendant subagent, recursively) | see below — the store getters cannot serve this |
| Branch, ahead/behind, attention | `useGitStore` directory state | warmed via `runBackgroundNetworkTask(ensureStatus)` and refreshed from Git mutation hints |
| Changed files | `useGitStore` status `files` + `diffStats` | working tree, not session-authored edits |
| PR + checks | `useFreshestSourceControlVisualSummaryForBranch` | **read-only**; follows the freshest bound-identity entry for the branch |
| Subagents | child sessions from `useAllLiveSessions` (`parentID`) + `useAllSessionStatuses`; per-row cost from `computeRollup`'s `perChildCost` (each child's own subtree total, so nested subagent-of-subagent cost rolls up under its immediate parent row) | |
| Subagent blockers | directory `permission` / `question` maps | one subscription covers every child |
| Usage | `components/usage/usageGroups.ts` over `useQuotaStore` | grouping shared with the mobile popover; presentation is not |
| Linked threads | `lib/linkedIssues.ts` over session metadata | written by the flows that attach an issue or PR |
| Turn stats | `telemetry.ts` over loaded message records | expanded idle sections follow completed records; busy or retrying sections retain the previous turn or recover it from a snapshot on opening or history publication; response speed describes that turn, while cache and speed average the completed history through it; the header falls back to average speed when response timing is unavailable; without a complete previous turn, the existing waiting row remains; either rate above 5,000 tok/s is unknown |
| Goal | `useSessionGoal` | respects the Settings toggle |
| MCP | `useMcpStore` | connect/disconnect reuses the dropdown's actions |
| Pinned messages | `getContextObligatoryMessages` + `state.part`, else one `getSessionMessage` read | see below |
| CLI checklist | `sync/session-native-checklist.ts` | Native Claude Code only; read-only and separate from project Todos |
| Background tasks | `useSessionNativeTaskDetails` in `sync/session-background-tasks.ts` | Current CLI process only; summary counts active non-ambient tasks |
| Plan document | `sync/session-native-plan.ts` | Native Codex only; the document the thread last wrote |
| CLI steps | `sync/session-native-todos.ts` | Native Codex only; steps Codex reported, which it never stores |

The four native sections share one shape: the header carries the count (or the
short state word), and the section's content is the records themselves — one
row per item, or the plan document. Each also renders a single muted row when
it has nothing to show, so a section that could not be read says why instead of
disappearing. None of them opens itself when content arrives: unlike subagents,
whose children are already in a store at mount, these load asynchronously, so
that edge would fire on every open and override a reader who collapsed them.
`defaultExpanded` decides the first view and the stored section state decides
every one after it.

### Native task surface

Native tasks live in the context panel's `tasks` rail surface
(`lib/surfaces/registry.ts`, mode `tasks`), rendered by
`components/chat/native-tasks/NativeTasksPane` inside `ContextPanel`.
`WorkStatusChecklistSection`, `WorkStatusBackgroundTasksSection`,
`WorkStatusPlanSection` and `WorkStatusTodosSection` open that surface on their
matching tab via `openContextSurface` plus the shared tab selection in
`native-tasks/task-ui-store`; a section's item rows are what carries that
action, so the plan document, which is not a list, has none. All four remain
discoverable when empty, failed or unsupported. Stable `taskChecklist`,
`taskBackground`, `taskPlan` and `taskTodos` ids use the existing section
visibility and order settings; the two Codex ids were appended, so a stored
custom order keeps its arrangement and gains them at the end. Settings search
opens `WorkStatusSectionsDialog` directly and highlights its mounted checkbox,
even when the panel cannot fit.

On phones and tablets the workspace drawer hosts the same pane as its `tasks`
tab (`apps/MobileWorkspaceDrawer.tsx`), passing `onClose` so a child-session
link can dismiss the drawer. The pane follows the currently selected session;
Codex and non-native sessions get an explicit explanation instead of a task
list, and VS Code's unsupported native runtime reports unsupported. An older
server without task capability flags shows an explicit unsupported message
rather than a successful empty list. There is no header button or dialog:
the rail, the drawer tab and the work-status summaries are the entry points.

The sync modules own task records, source identity, revisions and refresh. The
UI does not infer activity from checklist status or recent task outcomes. An
unknown background snapshot shows known edge details while explaining that CLI
task information is still pending; it supplies no active count. Ambient tasks
remain visible without contributing to session activity. Non-active records keep
the CLI's reported status; disappearing from the full set does not mean success.

Summaries load once and follow events without polling. An external process's
shared-list edits without an event become visible when the user opens the task
surface or refreshes it. Only the visible surface requests the owner's shared
45-second refresh. Hidden panel content unmounts through the panel's existing
visibility gate. Checklist partial and failed reads retain valid records with
explicit incomplete or stale feedback; they never become an empty success.

Task details mount on expansion. Output loads on that edge and on manual
refresh, at the server's 256 KiB limit. Collapse, surface close, session/runtime
switch or query-generation replacement aborts the read and rejects late results.
Truncation, empty output, unavailable output and failure remain distinct. The UI
never accepts output paths or polls every task log.

Stop calls only `nativeAgents.stopTask` for the captured session, directory,
query generation and task id. Server-provided `canStop` and `outputAvailable`
flags already include CLI capability and current-query eligibility. Pending and
accepted stop requests disable repeated submission, including after changing the
pane's tabs or closing and reopening the surface. This temporary UI state holds
one scope only, prunes non-active task ids when snapshots confirm them, and
clears on session/runtime or query changes. Acceptance means waiting for CLI
confirmation, not a locally invented terminal result. Failure remains on the
affected task and can be retried.
The existing whole-session Stop action is unchanged.

### Subagent rows

Subagent status uses the Tasks section's leading icons: blue for busy/retrying,
green for idle, and a neutral clock while status is unknown. A successful status
snapshot also establishes idle for omitted sessions in that same directory,
compared as normalized paths and skipping sessions whose status was invalidated.
The global status store fills the gap for children the snapshot does not cover:
a child it holds as busy runs, and one it saw settle is idle (or failed).
Permission requests and questions take precedence with a warning icon and text.
Running rows reuse `SessionActivityDuration` and its shared one-second ticker
for the current turn's elapsed time, including retries and waiting within that
turn. No timer is shown until the activity store has an observed start; blocked,
settled, and collapsed rows do not mount a running counter.

Rows are ordered newest first by creation time, never by last activity, which
reshuffled them on every step and moved them under the pointer. Rows group by
state first: blockers, then running, then unknown status, then finished (done
or failed, with no pending blocker). Creation order holds within each group, so
a fully finished list reads as it did at launch.
The section derives per-row cost with `computeRollup` over the live-session list
it already holds instead of opening a second subscription through the hook.

Hovering or focusing a row shows its session model's catalog display name,
falling back to the formatted model ID. Missing model metadata produces no
tooltip. Model-only session updates invalidate the live-session comparison.

### Turn stats

The section follows Usage by default and reuses the panel's existing rows. Only its header
has an icon; metric rows use labels and values without leading icons. It
reads already-loaded records without fetching history. Response speed and the
header describe the newest turn, which needs a preceding user message and
completed assistant steps. The cache and speed rows instead average every
complete turn in the loaded records, so paging in older history recalculates
them. A truncated leading segment or an unfinished trailing turn is skipped
rather than counted as zero.

Two rates answer different questions. Response speed uses the final assistant
message's output tokens divided by the union of its nonempty text intervals.
It excludes initial waiting, reasoning tokens and reasoning time, and earlier
tool steps. It requires complete, valid text timing and a final message without
tools, errors, synthetic text or ignored text. This measures text delivery from
stored timestamps, not provider-side decode speed. The header shows this rate
when it is available and falls back to the average speed when it is not.

Average speed sums output plus reasoning tokens and model time across every
complete loaded turn, then divides the totals. Model time is the turn's
wall-clock time from its user message through its last completed step, minus
the union of its completed and failed tool intervals, and minus every gap
longer than 5 minutes between finished steps. Using the whole turn covers
thinking and queue time before each step's first content block, which per-step
windows leave out and which made proxy sessions report implausibly high rates.
The long-gap exclusion covers waits that belong to no tool: Claude Code keeps
a turn open while a background task it started runs, and a CLI closed mid-turn
resumes the turn later. A 2 hour wait for a render once made a turn whose own
steps ran at 90 report 13 tok/s. The average is token-weighted, so a short turn
cannot dominate a long one. Average cache sums the same steps' input and cache fields and divides
cache reads by input plus reads and writes, also token-weighted. Both tooltips
say that the value covers history loaded in the session and changes when older
history is paged in. Invalid or missing inputs omit the dependent metric rather
than becoming zero; reported zeros remain valid. TTFT averages the earliest
text/reasoning start delay from every step of the newest turn, only when all
steps have a valid sample.

Either rate above 5,000 tok/s is reported as unknown. No provider streams that
fast, so such a value means the measured window is broken: a tool that runs
for nearly the whole step leaves a residual of a millisecond, and a text
interval can be equally short. The row is omitted rather than shown wrong.

Elapsed time is wall-clock time from the first user message in the turn through
the final assistant completion. It includes model waits, tool execution,
compaction, and other gaps. Average speed uses it minus tool time as its
denominator; response speed continues to use text intervals.

Metric labels stay short. Every row is a single hover and keyboard-focus target
for a shared tooltip, with a 750ms hover delay and a portal outside the panel's
scroller. Tooltips explain the measurement in every locale. The token row uses
compact input/output arrows; its tooltip gives full counts and explains that
input excludes cached tokens and output includes reasoning across all steps.

Live records subscriptions stop while collapsed, busy, retrying, or awaiting
status authority. Explicit idle events or a successful directory status snapshot
allow reactive computation. One component-owned committed result keeps the
headline and rows stable during the next active turn. When a section opens during
that turn without a retained result, it samples the already-loaded visible
records once. A later history-loader publication can supply delayed history.
Both paths exclude the entire running user-bounded turn, including completed
tool steps, from the selected turn and the averages. Streaming message and part
updates do not resample or aggregate that history, and the section fetches no
messages. With no complete previous turn, it keeps the existing waiting row.

The latest turn replaces every readout together after idle and completed records
are both available. If idle arrives before the final records, the previous turn
remains visible until those records arrive. Retained identity includes runtime,
normalized directory, session and revert boundary. Scope changes, fresh empty
records and reverts discard invalid results. After a runtime switch within a
mounted provider, its new history loader must resolve before old directory
records can be read. There is no global message-ID cache. Corrections to existing
message/part identities invalidate the current idle result. The web and desktop
panel and both mobile sheets use this shared logic; VS Code keeps the panel
hidden.

### Context usage has its own computation, on purpose

The header's readout cannot serve this panel, and the panel once failed in two
ways by sharing the header's old `useSessionUIStore.getContextUsage` getter:

1. The header reads the current session's messages with **no directory**,
   resolving to the *current* directory's child store. A session held by
   another directory — a worktree, or the moment after a directory switch —
   reads as "no messages", and the readout vanished while the header still
   showed a value.
2. The getter was **imperative**, as is `useConfigStore.getCurrentModel`.
   Selecting one yields a reference that never changes, so calling it during
   render subscribes to nothing; the readout went stale across session switches.
   The header now reads through `useSessionMessagesSelector`, which subscribes.

`contextUsage.ts` therefore computes the same quantity from messages the panel
has already subscribed to for a known session and directory, and the panel
subscribes to `currentProviderId` / `currentModelId` for the limits.
`contextUsage.test.ts` pins the arithmetic — notably that the *latest*
reporting assistant turn is the answer, not a sum across turns.
The context sidebar (`layout/ContextSidebarTab.tsx`) delegates to the same
function, including the 200k estimate for models that expose no window, so a
session cannot read 0.0% in one place and a different share in another.

Which message is "latest" is decided by `findLatestContextFill` in
`stores/utils/tokenUtils.ts`, shared with the VS Code header, mini chat,
mobile metadata, context sidebar and the context rail's ring icon
(`layout/ContextRailUsage.tsx`, which re-renders only when the reading changes
and reads cost only while its tooltip is open). A finished compaction's own record (a
`compaction` message with `status: 'completed'`) is not a reading: its tokens
describe the summarizing request,
whose input is the pre-compaction history. Until a later response reports
tokens, the fill is `compacted` and every surface shows a dash, never the older
pre-compaction number. A compaction still running, or one that failed, has not
changed the window, so the previous reading stays.

Native responses may report `contextWindow`, their effective configured limit.
That value takes precedence over the current catalog in the shared header,
sidebar, work-status and mobile readers. Missing usage is unmeasured; a failed
supplemental read does not erase the previous reading for the same message.
Claude streams reached through a proxy can omit cache fields until the turn
result. The native projector keeps that incomplete usage unmeasured, so the
panel retains the previous committed turn while the turn runs; the successful
result frame's per-request iterations then write the actual values. The frame's
aggregate usage is never assigned to one assistant message.

Two further rules on this readout:

- The displayed percentage is computed **unrounded**. `clampPercent` applies
  `Math.round`, so routing the display value through it turned 33.6% into
  "34.0%" and made the panel disagree with the header. Rounding is still right
  for the colour threshold, which is what the header feeds it.
- When the model exposes no context limit, the percentage falls back to the
  store's own default limit instead of disappearing.

There is no cost-only fallback row. A row labelled "Context" showing nothing but
a price is not a context reading; cost rides along with the percentage or waits
for it.

### Pinned messages load only what they need

Pins are most useful on a long session — which is exactly when the pinned
message sits before the loaded part of the transcript. Session metadata keeps
only the pin's id, time and role, so a pin that is not loaded reads its one
message from OpenCode (`opencodeClient.getSessionMessage`) for the row's text.
No session is materialised for it, a loaded pin costs nothing, and a failed
read leaves the placeholder until the section mounts again.

### PR status is deliberately read-only

The panel never calls `startWatching`. PR watching is owned by the background
tracker, and its concurrency gate exists because per-consumer PR fetches once
saturated the browser's connection pool and stalled startup for ~20s. A panel
that started a watch per open session would reintroduce exactly that fan-out.
The PR surface can watch a concrete remote while passive readers initially know
only the automatic remote key, so the panel reads the freshest entry for the
directory and branch across remote keys. This keeps its PR and checks rows in
sync with the live PR surface without adding another request owner.

### Changed files come from git status, not the session

`Session.summary` looks like the obvious source and does not work. OpenCode's
`SessionSummary.summarize` writes `{additions: 0, deletions: 0, files: 0}` at
the start of every turn and then fills only the **message**-level
`summary.diffs`; session-level totals stay zero forever. The `session.diff`
event is reset to `[]` in the same place and carries real content only on
revert, so `state.session_diff` is not an aggregate either.

That leaves two honest options: aggregate per-message `summary.diffs` across
every turn, or read git status. The panel reads git status — it is
authoritative, already cached per directory, costs nothing extra, and sits
directly under the branch row where working-tree state is what a reader
expects.

The consequence is a real semantic difference: this counts the working tree,
including edits the user made by hand and excluding session edits that are
already committed. If a session-authored count is ever needed, it has to come
from aggregating message summaries, not from `Session.summary`.

One exception: while the directory is a worktree whose creation has not
finished (`useWorktreeBootstrapPending`), the working tree transiently holds
bootstrap files that the initial git reset is about to remove. Those are not
changes on the branch, so the panel neither fetches status nor renders the
changed-files row until the bootstrap settles, then forces one status fetch so
the row reflects the reset tree rather than a mid-creation snapshot.

## Section order

Usage provider errors are visible alongside both populated and empty quota
rows. Claude restores the owning runtime's last successful cached usage; missing
cache data adds no empty-data message and never triggers a provider query. Successful Claude values have no extra update-time or manual-refresh timing
hint. Failed refreshes keep a short status alongside any retained numbers.
Settings, mobile cards, and the VS Code quota dropdown share that formatter.
The runtime owns request limits. Opening the panel and periodic refreshes never
query Claude; only the refresh action does.

The default order is by durability:

1. **Session** (goal, context, cost), **Project** (attention, branch,
   changes, PR, checks), **Usage**, and **Turn stats** (session telemetry:
   throughput, duration, TTFT, cache hit rate) — true for as long as the session
   is open. Usage sits here rather than lower down because a spent quota stops the
   work outright;
2. **Subagents**, **CLI checklist** and **Background tasks**, for current work;
3. **MCP**, **Pinned messages**, **Context sources**, for supporting material.

The sections dialog has drag handles for changing this order, including hidden
sections. A drop updates the panel immediately. `workStatusSectionOrder` is a
profile preference persisted through the settings registry and the local UI
store. Missing or empty order uses the default; duplicate and obsolete ids are
discarded, and newly introduced sections append in default order. Visibility
changes never alter positions.

`WorkStatusPrimaryGroup` supplies Session and Project through a composition
callback so the panel can place them independently while retaining one set of
data subscriptions. Keyed fragments preserve mounted sections and DOM order;
sections that render nothing leave no spacing wrappers. Secondary elements are
created by the panel, so primary readout updates do not rerender them.

The overlay's outside-click and Escape dismissal pauses while this dialog is
open, since the dialog is portalled outside the panel.

The first rendered section heading reserves space on its right for the panel's
settings button. The scroller selects the first actual section DOM node, so
hidden and empty sections do not claim that space. Both heading variants expose
`data-work-status-heading`; only the heading is inset, leaving body rows at full
width. Heading summaries truncate within a bounded share of the available width
so project names and usage summaries cannot push actions under settings.

## Extension sections

An installed extension can add its own section (`contributes.statusSection`,
see `packages/sdk/DOCUMENTATION.md`). `WorkStatusExtensionSection` draws the
header from the extension's `statusTitle` (else its name) and panel icon, and
its body is a `PluginPane` with `surface="status"`: the same sandboxed iframe,
guest-scoped token, context, grants and pause gates as a rail panel.

Cost is bounded by mounting. The frame exists only while the panel's content is
mounted, the section is visible, and the section is expanded; the collapsible
drops its children when folded. `PluginPane` itself is lazy-loaded, so a panel
without extension sections never loads it. The frame's height starts at the
manifest `height` (default 120px) and follows the guest's `setHeight`, clamped
to 24..320px; taller content scrolls inside the frame, never the host. The last
requested height is remembered per extension id and version for the app
session (a module-level map, one number per installed extension), so folding
and reopening a section does not jump back to the manifest default.

An extension section is expanded by default unless its catalog row declares
`statusDefaultExpanded: false`; an explicit saved expansion choice wins. A row
with `statusRequiresProject` is absent, including from presence reporting, when
the panel has no actual Work Status directory. Status-frame controls exist only
while that expanded frame is mounted. A project change clears the header controls;
the guest republishes them from `onDirectory`. Workspace subscriptions and other
in-flight requests survive that project change. One or two controls use the header action
slot; three or four use a two-column row below the title. Folding removes the
controls with the frame rather than retaining a hidden controller.

An expanded extension can also open a sandboxed anchored popover outside its
body iframe. The host positions the card and loads the same approved entry
with `surface: 'popover'`. Folding or hiding the section removes the card with
its owner; project/runtime and authorization changes also dismiss it. Pointer
travel into the card and keyboard dismissal are handled by the SDK anchor
helper and the host overlay controller. This does not increase the status
frame's 320px height limit. The public contract is in `packages/sdk/API.md`,
under Anchored popovers.

`useWorkStatusExtensionSections` lists active guests with a `statusEntry` from
the catalog store (`useGuestStatusSections`). It is empty on VS Code and
mobile, which load no guests; the panel is hidden there anyway, but the empty
list is explicit rather than an accident of visibility. The rail owns loading
the catalog.

Section ids are `ext:<extension id>` and share the persisted order and hidden
lists with built-in ids. Sanitizing keeps well-formed `ext:` ids even when that
extension is not installed, because settings load before the catalog and a
paused or reinstalled extension should come back where the user put it.
`resolveWorkStatusSectionOrder` drops unavailable extension ids from what the
panel and the dialog show and appends available ones the saved order does not
know. A drag in the dialog writes the shown order followed by the saved ids it
did not show. "All hidden" and "Show all" count only sections that can
actually be shown. Extension rows carry an "Extension" label and no settings
search anchor (they are dynamic entities).

## Switching it off

A persisted preference (`workStatusPanelEnabled`) drives a header toggle, and a
dialog behind the equalizer icon switches individual sections off. Hidden
sections are stored rather than visible ones. Every section, including Turn
stats, is enabled by default. UI-store v21 migration and server-list hydration
remove the old automatic telemetry hiding unless `workStatusHiddenSectionsExplicit`
records a user-chosen list. Explicit hiding and other hidden sections survive.
The marker and list travel together through autosave, sanitization, and server
settings; an empty list enables everything. Complete settings
snapshots own this preference; unrelated partial save echoes leave it unchanged.

`workStatusPanelVisible` is separate and transient: the switch can be on while
layout still refuses the panel. The header's project/branch line and the git
rail read it to drop the readouts the panel already carries, and it is deliberately not persisted — it
describes the current frame, not a preference.

## Appearing and disappearing

The card keeps its width and only fades, on the slot's duration and curve
(`LAYOUT_ANIMATION_MS` through `useLayoutAnimationMs`, ease-out; zero when the `layoutAnimations` setting is off); the slot animates the width. It stays
mounted wherever it could ever show, so the fade has something to animate;
its content is dropped once the fade finishes. A card whose sections all
reported nothing gives its column back. When it is shown again the presence
count starts optimistic, as on first mount, so the column is not given back
for the frames before the sections report.

An empty card is a border around a settings icon, which reads as a fault. Each
section decides for itself that it has nothing to say, so they report through
`presenceContext.ts` and the panel collapses when none rendered. Deriving that
at the panel level would mean duplicating every data source the sections read.

There is one deliberate exception: when the user hides every section, the card
stays visible with a localized empty state and section controls. Collapsing that
state would also hide the only recovery path. A panel with enabled sections but
no data still follows the presence reports and collapses as before.

The scroll offset resets on session change: restoring one session's offset into
another's shorter panel lands somewhere arbitrary.

The Subagents section opens itself when subagents appear where there were none,
on that edge only: re-expanding on every count change would fight a user who
just collapsed it.

Its expanded list is capped at eight rows and scrolls independently, so a
session with many subagents does not crowd every section below it out of the
panel.

## Collapsed Usage headline

Collapsed, the Usage section shows one quota rather than a mode word: the
**shortest window reported by the provider the composer is pointed at**. A
5-hour bucket answers "will the next turn land"; a monthly one does not.

Selection rules live in `usageHeadline.ts` and are pinned by
`usageHeadline.test.ts`:

- provider ids are matched directly, with a small alias table for the ones that
  diverge from OpenCode's (`openai`/`chatgpt` → `codex`, `anthropic` → `claude`,
  `gemini` → `google`);
- model-scoped rows are skipped while any provider-level row exists — a
  per-model quota is not the provider's;
- rows without a window duration (credit balances, tool counters) are a last
  resort, never preferred over a real window;
- **no match means no headline.** The section falls back to the display-mode
  label, because showing an unmatched provider's quota would read as the active
  one.

## Actions

Rows that name something the app can already show are buttons:

| Row | Opens |
|---|---|
| Context | the context overview (`openContextOverview`), same destination as the rail's Context surface |
| Changes | working-tree diff (`openContextPanelTab`, `diffScope: 'working'`, no target path) |
| Branch | git surface (`openContextSurface(dir, 'git')`) |
| Pull request, Checks | PR surface (`openContextSurface(dir, 'pr')`) |
| App icon (Project heading, right) | opens the project in the chosen app (`OpenInAppButton`, desktop with a local host only); its chevron copies the path or picks another app. The project name beside the title is plain text |
| Project action | runs or stops the selected project action (`ProjectActionsButton`); its chevron picks another action. The project's own actions come first and auto-discovery last, so with nothing picked the row offers the first configured action, or auto-discovery when there is none. The pick is stored per runtime and project (`lib/projectActionSelection.ts`) and survives remounts and restarts; a pick that no longer names an action falls back to the first one. A running action takes the row over an idle pick, and pressing the row acts on the action it shows, through the same shared-setup trust prompt as the menu. The row is a view: the runner lives in `ProjectActionsProvider` above the whole layout (see below). The header carries no action control, so a project without a repository still gets a Project section |
| Subagent | that child session's chat tab, read-only |
| Goal (row) | the composer's own `SessionGoalDialog` |
| Goal (pause/resume) | `setSessionGoalStatus(sessionId, directory, status)` |
| MCP switch | connects/disconnects the server |
| MCP status | the state doubles as the button that reconnects |
| Pinned (pin icon) | unpins the message |
| Pinned (text) | jumps the transcript to that message |

### Project actions outside the panel

The panel hides whenever a rail panel opens, so the actions cannot depend on
it. `components/layout/ProjectActionsProvider` mounts one runner
(`useProjectActionsRunner`) in `MainLayout` for the project
`useProjectActionsContext` resolves, which is the panel's own context. A managed
Chat resolves to none. Three views read that runner through
`projectActionsRunnerContext`:

- the Work Status row;
- `ProjectActionsDialog`, opened by `open_project_actions` (`mod+alt+r`). It
  lists the actions with their state, opens with the row's action highlighted,
  and Enter picks the action and runs or stops it;
- the command palette's search-only "Run: name" / "Stop: name" entries and its
  "Project actions" entry.

Because the runner outlives the panel, a run keeps its output watch (URL
auto-open, exit tracking) while the card is hidden. The server terminal listing
still runs only on demand: each view calls `useObserveProjectActionRuns` while
it is on screen, and the runner polls only while at least one view asks.

The goal icon reproduces the **composer target button's** colour mapping, not
the goal strip's. The two disagree today — the strip paints `paused` muted and
`blocked` warning, the button paints them info and error — and the button is
where this panel's reader last saw the goal. Unifying them is a separate change.

Jumping to a message is a message-link request (`requestMessageFocus`,
`lib/router/messageFocus.ts`), the same one links and search use: the timeline
loads older history until the message is there and opens a collapsed turn
around it, so a pin far back in a long session is reachable. While older history
loads, the pin's row shows a spinner: `readMessageFocusInFlight` names the
message a request is still bringing to the screen, and the timeline marks it
shown (`markMessageFocusShown`) once it lands; settling or expiry clears it too.

Opening a subagent takes the same branch as the transcript's Task tool: an
embedded panel, mobile, or VS Code navigates to the session instead of nesting
a tab.

## Context sources

Linked GitHub threads first, then skills and MCP counts.

Agents are deliberately absent: an agent is who does the work, not material
loaded into the context. Tools are absent too — `Agent.tools` is a per-agent
override map rather than a registry, so its size would be a number that means
something other than "tools available".

### Linked issues and pull requests

Written by the flows that already attach a thread — sending a message with
issues, PRs or guest items attached in the composer, and session creation from
an issue or PR in `NewWorktreeDialog`. There is no manual "link this" control:
attaching a thread to the work *is* the act of linking it. A message's
references are written in one metadata patch (`sessionActions.addLinkedIssues`):
each write replaces the whole list, so one write per item would keep only the
last.

Stored in session metadata as a **snapshot** (`lib/linkedIssues.ts`, namespace
`openchamber.linked_issues`), riding the same `patchSessionMetadata` channel as
pinned messages. Number, title, url, author and avatar only — the body,
comments and state belong to GitHub, and mirroring them would mean owning their
staleness. The stored title can drift; that is the price of a store that never
needs refreshing. A GitHub row opens github.com. A Linear row opens the
right-hand Linear panel when Linear is connected on desktop/web; otherwise it
opens the Linear URL (no rail in VS Code or the phone shell, and none while
disconnected).

Writes happen **after** the send promise resolves and are deliberately
swallowed on failure: the message went out, and a missing bookkeeping entry
must not surface as a send error.

The entry id comes from the thread URL rather than a separate owner/repo pair,
because every attach flow has the URL and only some carry the repo separately.
Issues and pull requests share one id shape, since they share a numbering space
per repository.

## Loading data the header used to own

Two readouts had no loader of their own and appeared only after the user opened
the matching header dropdown:

- **MCP** — `McpDropdown` was the only mount-time caller of `refresh()`.
- **Usage** — `useQuotaAutoRefresh` schedules the shared fixed three-minute
  refresh; the *first* fetch was performed by the dropdown's open handler.
- **Skills** — `loadSkills()` ran only when the composer's slash autocomplete
  opened, so the context-sources count was whatever happened to be cached. The
  section loads them itself, keyed on the directory, since skills are
  discovered relative to the active project. It does not wrap the call in
  `runBackgroundNetworkTask`: the store already gates its own fetch.

Usage waits for the instance to say it is initialised. Quota providers report
themselves as configured only once the instance can read their credentials,
which on a remote instance is not true when the UI mounts — a fetch fired at
mount gets "nothing configured" for every provider, and since each one then has
a result, nothing asks again until the three-minute refresh. That is why Usage
could stay missing from the panel until Settings -> Usage forced a fresh fetch.
`useQuotaStore.ensureLoadedForRuntime` owns both the readiness rule and the
once-per-instance bookkeeping, so every caller can ask on each connection
change.

### These readouts belong to the connected instance

Same-origin web pages and Electron's Vite proxy initialize a runtime identity
even when the API base is empty. Requests stay relative to the page origin.
Electron dev uses `local`; hosted pages use their HTTP origin. Without this,
the quota loader treats a working proxy as a transient disconnected runtime
and skips the initial load.

Quotas, MCP status, skills, agent memory and the Linear/GitHub logins are all
served by whichever OpenChamber instance is connected, and each was cached
globally or by directory alone — which two instances can share. A switch left
the previous instance's answers on screen, and its Linear login usable against
a runtime that has no Linear. `apps/runtimeEndpointReset.ts` now drops all of
them, each store guarding its own in-flight requests with a generation so a
response for the previous instance cannot land in the new one. The MCP and
skills effects take `isConnected` as a dependency — not a gate — because
`directory` alone does not change when both instances hold the same path.

The panel now performs these itself, silently and through the
background-network gate, so it cannot compete with chat bootstrap traffic for
sockets. Usage additionally provides an explicit refresh action in its section
header. A panel that reports a subsystem's state cannot depend on an unrelated
component having been mounted or opened.

The repository section follows the same ownership rule. It subscribes directly
to `sessionEvents` Git refresh hints and refreshes its directory's shared Git
cache, rather than relying on the composer's former changed-files row or on the
Git context surface being opened first.

## Persisted panel state

Expanded sections (`workStatusExpandedSections`, keyed by a stable section id)
and the scroll offset (`workStatusScrollTop`) live in the persisted
`useUIStore`. Component state would not do: the content unmounts every time the
context panel opens, which would silently discard the user's arrangement.

The scroll offset is restored in the scroller's callback ref, at the moment it
attaches, and read through `useUIStore.getState()` rather than a subscription —
subscribing would fight the user mid-scroll. Writes are coalesced to one per
animation frame.

## Not implemented yet

- Test/build/dev-server status and LSP diagnostics — a separate track. Note
  that `state.lsp` already exists in the sync state.


Managed Claude connections have a separate quota identity from the CLI. The
Usage headline uses the selected model's connection UUID to match its native
Kimi quota card; it never substitutes the default Claude account when that card
is absent. Provider-level quota cards remain independently
selectable in Settings.
