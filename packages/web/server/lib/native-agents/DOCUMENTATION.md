# Native CLI sessions

## Purpose

Lets OpenChamber act as a frontend for the user's own Claude Code, Codex and
DeepSeek Harness CLIs. The CLI's session store is the only source of truth: this module reads
it, projects it into the Session, Message and Part records the shared UI
already renders, and never keeps a copy of the conversation. Native sessions
sit next to OpenCode sessions in the same projects and sidebar, but OpenCode
never sees them.

OpenChamber retains lossless selections made through its own question UI as
integration metadata. Question text, tools and replies still come from the CLI.
DeepSeek's process authentication, Web protocol, event-position cursors,
remote provider configuration and operation limits are owned by
`deepseek/DOCUMENTATION.md`. Read it when changing
that adapter or its shared UI contracts.
Shared long-term memory and project handoffs are owned by
`../agent-memory/DOCUMENTATION.md`, not by the native transcript stores.

OpenChamber lists and reads the CLIs' sessions, creates sessions, and drives
turns: prompts, steering, stops, model and effort changes, plan mode and the
model's questions. Every tool runs without asking. Reverts, forks, rename,
archive, delete and compaction work the way they do for OpenCode sessions.
Claude checklists and background-task details, and Codex plan documents, have
native snapshot APIs, including the steps Codex reports through `update_plan`
and the plan a Codex thread wrote.

## Wiring

- `server/index.js` creates the runtime with the data directory, the CLI
  resolver (`executables.js`), the child environment (`process.js`), the
  OpenChamber version, `publishNativeEvent` (the global hub) and the reader of
  the global AGENTS.md (`instructions.js`), routes the
  follow-up queue's startup existence check for native ids to
  `sessionExists`, gives `smallModels` to the small-model service
  (`configureNativeSmallModels`), and hands the runtime to shutdown.
- `opencode/feature-routes-runtime.js` registers `routes.js` first among the
  feature routes, before the generic OpenCode proxy. `opencode/core-routes.js`
  parses JSON bodies for `/api/native/`.
- `opencode/shutdown-runtime.js` awaits `shutdown()` (bounded at 5 s) before
  the message stream closes.
- Elsewhere, native ids are refused on purpose: the OpenCode proxy answers
  `409 NATIVE_SESSION_ROUTE` for `/api/session/<native id>/*`, and the message
  queue answers `409 NATIVE_SESSION_UNSUPPORTED`. Session runtime skips native
  ids in restart recovery and active counts.

## Ids

`ids.js` owns the namespace and `packages/ui/src/lib/native-agents/ids.ts`
mirrors it. A session id round-trips to the CLI's own id, so a session opened
here resumes in the terminal by that id:

| Id | Claude Code | Codex |
|---|---|---|
| Session | `ncl_<session uuid>` | `ncx_<thread id>` |
| Subagent session | `ncl_<uuid>_t_<tool_use id>` | `ncx_<child thread id>` |
| User message | `ncl_u_<entry uuid>` | the `ncx_u_<uuid>` or automatic plan-approval `ncx_u_plan_<uuid>` id OpenChamber sent, else `ncx_u_<turn key>_<item id>` |
| Assistant message | `ncl_a_<sha16(session id)>_<API message id>` | `ncx_a_<turn key>_<turn or user item id>` |

Part ids derive from the same native keys (content block index, `tool_use`
id, Codex item id). Every id is deterministic, so a later live event and a
history reload name the same record, and every id passes the
`^[A-Za-z0-9_-]{4,128}$` check other OpenChamber routes apply.

The server alone creates `ncx_u_plan_<uuid>` for approved plans. The UI's
normal-send ID validator remains restricted to ordinary client IDs, so a
manually sent prompt never reuses an automatic approval's provenance.

## Historical statistics

`GET /api/native/stats` reads retained native histories for Stats. `from` is
inclusive and optional, `to` is required and exclusive, and both are epoch
milliseconds. `timezone` selects calendar-day buckets. An optional `directory`
scopes the read to the selected project, its subdirectories and the worktrees
supplied by the existing worktree listing. Native discovery starts no OpenCode
locations. `tools=none` is the default; `tools=detail` counts calls on request.

Each backend reports `ok`, `partial`, `error` or `unavailable` independently.
Partial reports retain readable sessions and carry incomplete-history counts.
Coverage distinguishes recorded token, cost and reasoning values from missing
values. Reported zero stays zero; absent cost or usage stays unknown. Undated
messages contribute only to all-time totals and mark a report incomplete.
Root modification time cannot exclude newer activity in child transcripts.
Activity rows contain `{ date, steps, tokens, tokensComplete }`. `tokens` sums
the same disjoint buckets as the report total during the history scan and is
null when the date has no known usage. Recorded zero remains zero. Missing
usage on that date, incomplete history or undated records make
`tokensComplete` false. Undated tokens stay in all-time totals without a
calendar bucket; activity dates and streaks continue to count model steps.

Statistics use chat's source visibility and retained-chain rules, including
terminal sessions, registered SDK sessions, archives and children. The bounded
send registry is not an accounting source. Reads do not populate chat caches,
recover edit diffs, resume threads, send prompts or publish chat events. Each
request reads at most four histories concurrently across backends. Queued
backends take turns as slots become free. Request cancellation or a source
deadline removes its queued work immediately; running
reads keep their slots until they finish. DeepSeek closes its temporary snapshot
stream, then pages at that watermark without entering or evicting the chat
follower cache.
Codex has a 60-second source deadline to read full retained histories; other
sources keep a 25-second deadline. The web client's statistics request allows
75 seconds, including response transfer; ordinary native reads keep their
30-second deadline. A stalled history cannot discard other completed histories.

Steps count retained assistant records, excluding compact summaries. Claude
blocks sharing an API message id form one record; Codex uses assistant segments;
DeepSeek uses turn/step identities. Codex token totals sum disjoint token
buckets, never the last request-window `tokens.total`. Claude has no separate
reasoning bucket. Tool medians are exact within one source; the UI omits a
merged median when independent source populations contributed to one tool.

Web, Electron, hosted mobile and Capacitor use this endpoint. VS Code retains
its explicit unsupported native API and shows OpenCode statistics only. Reads
rewrite no transcript or usage record and create no persistent statistics DB.

## Listing

`GET /api/native/sessions?directory=` reports each backend separately:
`{ backends: { claude, codex, deepseek } }`, each `{ status: 'ok', sessions }` or
`{ status: 'error', message }`. One backend failing never hides the other,
and the UI keeps its previous sessions for a failed backend.

- Claude: `listSessions({ includeProgrammatic: false })`, which matches the
  terminal's `/resume` picker, plus sessions the registry holds. SDK-created
  sessions of other clients, such as the old OpenCode plugin, stay hidden.
- Codex: `thread/list` with `sourceKinds: ['cli', 'vscode']` and the
  directory as `cwd`. The old plugin's threads stay hidden: its SDK path is
  the `exec` source, never requested, and its app-server client has the
  `openchamber_codex` originator. App-server threads OpenChamber opens report
  source `vscode`.
- Subagents are never listed. Loading a parent's history returns them as
  `childSessions`, the only place they open from.
- DeepSeek lists persisted Web root summaries with `session/list`. Its stable
  logical ids can bind to active native forks after rewind; registry history
  metadata hides their internal predecessors. Older
  servers omit `deepseek`; that is unsupported, not an empty success.
- `GET /api/native/chat-directories` returns `{ directories }`: the
  directories of registry sessions below a managed chats root, matched by
  the root's configured and real path. Each managed chat has a directory of
  its own that no project names, so without this list a native chat created
  on one device would not appear on another.

## History projection

`GET .../sessions/:id/messages?directory=&limit=&before=` returns
`{ records, cursor, complete, childSessions }`, newest page first. `before` is
the id of the oldest message of the previous page; `cursor` is the next page's
`before`, `null` on the last page.

The projectors (`claude/projector.js`, `codex/projector.js`, and
`codex/items.js`) are pure and golden-tested against sanitized recordings of
real CLI runs in `*/fixtures/`. They satisfy the contract the UI renderer
depends on:

- Messages order by `time.created`, which the projectors keep strictly
  increasing. Parts keep arrival order.
- Every assistant message has a `parentID`. A synthetic user message is
  added when the transcript has none, so no assistant reply is orphaned.
- Every part carries `sessionID`. Finished text parts have `time.end`;
  finished tools have `state.time.end`. A tool that never got a result is
  settled as interrupted.
- Codex history recovers each item's start and end from the rollout's
  `item_completed` records. Synthesized question and skill rows take the time
  of the response record that produced them. An item without a recorded time
  falls back to its turn's bounds.
- An assistant message's `time.completed` covers every finished part it
  issued: a later tool result, or an item end later than the second-precision
  turn end, extends it. OpenCode completes a step after its tools, and turn
  telemetry subtracts tool time inside that window. A tool interval starts
  when the CLI starts the tool, not when the message that requested it was
  written, so a live attempt's first token never becomes a tool's start.
- Tool names map onto the tools the UI knows (`Bash` to `bash`, `Edit` and
  `MultiEdit` to `edit`, Codex `commandExecution` to `bash`, `fileChange` to
  `apply_patch`, MCP tools to `<server>_<tool>`), with the file diff metadata
  the edit renderer reads. A Claude tool the UI does not know keeps its own
  name (`TaskCreate`), and its title is the first set input field among
  `subject`, `description`, `query`, `pattern`, `url` and the like, never the
  name again.
- A Claude Bash result can carry `bashEditDiff`: what Claude Code recorded
  the command changing in the work tree. The CLI marks the field internal
  (2.1.283); its `bashEditDiffEnabled` setting documents it for hooks. The
  part stays `bash` and gets the recorded diffs as the edit renderer's
  `files` and `diff`, plus `recordedFileChanges: { withoutDiff, unnamed,
  unavailable?, shared? }` for the changed files the CLI named without a diff
  or only counted. The CLI keeps hunks for at most 5 files per command and
  none for a file whose change passes 400 lines or 64,000 characters, names
  at most 200 files, and flags `shared` when another command changed the
  same repository at the same time. It records nothing for read-only,
  failed, interrupted or background commands, skips plain git commands, and
  by default records only in `auto` and `bypassPermissions` modes while its
  bash-first mode steers the model to edit through the shell. A `bash` part
  without the metadata has no record, which never means it changed nothing.
  Codex reports no such record.

Claude gotchas:

- The CLI uses `model: "<synthetic>"` for its own notices, including quota
  errors and `No response requested.`. The projector uses the latest
  assistant model for the same parent prompt, then that prompt's captured
  send selection. Without either, the model stays empty. A placeholder never
  replaces a real model already observed in the stream; a later real model
  replaces the fallback. History and live frames use the same rule and keep
  the notice's text and usage, except `No response requested.`, which does
  not become a message. The CLI writes it when an interrupted request
  resumes, and the resume can come hours after the interrupt; a record for it
  would stretch that turn's window across the idle time, and the turn stats
  would report a fraction of the real rate.
- Assistant messages carry `contextWindow` when OpenChamber knows the
  effective window for the turn: the connection/catalog value on launch and
  history projection, or the CLI's `modelUsage` value on a live result. An
  unknown window stays absent rather than falling back to another model.
- `getSessionMessages` drops `toolUseResult`, which holds the
  `structuredPatch` the edit diffs are built from and a command's
  `bashEditDiff`. When a conversation used Edit, MultiEdit, Write or Bash,
  the store reads the raw transcript a second time through
  `importSessionToStore` into a throwaway store and keeps only the diff
  fields per entry uuid (the raw result also holds whole file contents and a
  command's output). Entries without a structured result, most of them, skip
  the result parsers; failed parses were most of that pass's cost. A failed
  second read leaves the main history readable and marks supplemental metadata
  incomplete. Question calls trigger the same read to recover their structured
  answers; incomplete results are retried rather than cached as complete.
- A subagent's history does that read only when the subagent edited files,
  asked a question or lost tool results: it goes through the whole session, nothing caches
  it, and nearly every subagent runs commands. The file changes of a
  subagent's commands therefore show live, and after a reload only when that
  read runs anyway.
- Subagent history can omit parallel tool results from its selected
  `parentUuid` chain. When a retained call has no result, the store reads raw
  entries through `importSessionToStore`, selecting only that subagent's key,
  and recovers results for those retained call IDs. It does not replay users
  or assistants from discarded branches or borrow another child's results.
  The read is shared with edit-diff recovery. A failed required recovery read
  fails the page instead of declaring the tools interrupted. Unresolved tools
  remain running while the live query reports that child running; completed
  and interrupted child histories settle them as before.
- `getSessionMessages` returns only the chain after the last compaction. When
  that chain opens with a compaction, the store adds the conversation before
  it (`earlierEntries` in `claude/store.js`): it reads the raw transcript
  once, cuts it just before the boundary, and hands the cut to
  `getSessionMessages` through an in-memory `sessionStore` (an alpha SDK
  option), which returns that segment by the SDK's own chain rules, from the
  compaction before. It repeats while a segment opens with a compaction. The
  boundary's `logicalParentUuid` is no guide to the cut: the CLI can name an
  entry it writes after the boundary.
  Messages a compaction carried over open the next chain too; they stay in
  the segment they were written in, and each uuid shows once. The earlier
  segments are projected on their own and kept with the history cache entry
  while the same compaction stays the last one, so the raw transcript is read
  again only after a new compaction (it then gives the edit diffs too). A
  failure leaves the earlier segments out; the chain after the compaction
  still shows. The UI pages through the whole history as before.
- A compaction boundary becomes an `ncl_k_<uuid>` message with a compaction
  part, and the compact summary becomes a `summary: true` assistant message.
  `includeSystemMessages` returns every system entry on the chain (turn
  durations, away summaries, local commands, notices) with only its `type`:
  no `subtype`, no `compactMetadata`. A history system entry is therefore a
  boundary only when the compact summary (`isCompactSummary`) comes right
  after it, and any other shows nothing. The part's `auto` is true only for
  the `auto` trigger a live `compact_boundary` frame names
  (`compact_metadata`); a boundary read back from history makes no claim.
- Meta and local-command entries are skipped, and so is the
  `origin.kind: 'task-notification'` entry the CLI adds when a background
  subagent finishes: the subagent's row and the reply after it already show
  the result. Meta entries are the CLI's own notes to the model, such as its
  nudge to go on after a reply hit the output limit. A history read marks them
  `is_meta` and a live frame `isSynthetic`. The projector checks both, so a
  running turn leaves out what a later history read leaves out.
- History is cached per session, keyed by transcript size and modification
  time, in an LRU bounded at 128 MiB of transcript. On 2026-09-29, on a busy
  machine, a cold load with both reads took about 0.2 to 0.3 s for a 4 MB
  transcript, 1.5 to 1.8 s for a 41 MB one and 2.0 to 2.3 s for a 66 MB one
  with five compactions; the second read alone costs about 10 ms per MB.
  Later pages of the same transcript come from the cache.

Codex gotchas:

- A single-session read returns the CLI's own `cwd`. A directory supplied by
  a client is only a lookup hint, so `/resume <thread-id>` cannot move another
  project's session into the currently selected project.
- History reads turn metadata through `thread/turns/list` with
  `itemsView: 'notLoaded'`, then exhausts `thread/items/list` for each turn
  in pages of 100 items. Both reads preserve chronological order without
  resuming the thread. Item pages must belong to the requested turn; a failed
  page fails the read rather than returning an incomplete conversation.
  This keeps long histories out of a single response while retaining the
  JSON-RPC connection's 32 MiB message limit. Automatic title generation
  uses the same item pagination for its first turn.
- Those RPCs omit usage and user-input calls.
  `codex/history-details.js` streams supplemental metadata from the app-server
  supplied rollout, verifies the thread identity and joins only retained
  turns. It records each `item_completed` event's `started_at_ms` and
  `completed_at_ms`. Synthesized question rows use the `function_call` line
  time as their start and the `function_call_output` or `retained_context`
  line time as their end; synthesized skill rows use the response line time.
  Modern `token_usage_record`
  and legacy `token_count` records share one counter ledger, so a request
  represented in both is counted once. Question calls and verified answers
  restore the question tool row. Explicit skill attachments and successful
  manifest reads retain skill activity; mentioning a skill is not usage.
- `codex/usage.js` separates uncached input, cache reads/writes, output and
  reasoning. Reply buckets accumulate within their assistant segment while
  `tokens.total` is the final request window. `contextWindow` is the effective
  limit the CLI reported. Missing usage or monetary cost is unknown, not zero.
  Per-turn model/effort metadata fills gaps in the bounded send registry.
- A turn's `completedAt` has second precision; an item end can land after it.
  The projector extends the assistant's `time.completed` to the latest
  finished part. Items without a recorded time still fall back to the turn's
  bounds.
- A steer starts a new user message segment inside the same turn. Failures and
  ordinary stops carry an error on their assistant message; Claude's explicit
  keep-planning choice follows the behavior below.
- Only JSON-RPC `-32600` "thread not loaded" or "invalid thread id" means a
  thread is missing. Every other error propagates, so a transport failure is
  never reported as a deleted session.

## Live turns

Both backends publish through `publisher.js`, which compares each record with
what it last published for the session and emits only what changed:
`message.updated` for the message, then `message.part.updated` for its parts.
Streamed text goes out as `message.part.delta`. Events carry copies, because
projectors keep mutating their records and the hub serializes an event later,
after delta coalescing. A turn publishes `session.status` busy, then idle with
`session.idle`, and `session.error` when it failed (not when it was stopped).
After every finished turn the runtime confirms the session in the registry and
publishes its fresh record as `session.updated`, which carries the CLI's title
for a new session.

Claude Code (`claude/live.js`): one streaming-input `query()` per session,
kept open between turns.

- Options: the user's `claude` binary, the child environment, the
  `claude_code` system prompt preset with nothing appended, all setting
  sources, `bypassPermissions` or `plan`, partial messages and
  `forwardSubagentText` on. A new session
  starts with `sessionId`, one with a transcript resumes with `resume`.
- Model: `claudeLaunchModel` (`catalog.js`) hands the CLI `opus`, `sonnet`
  and `fable` in their `[1m]` form, at launch and when switching in place.
  Claude Code runs a plain alias with 200K, so only that form gets the 1M
  window the catalog reports. Haiku has no 1M form. Messages, the registry
  and saved selections keep the plain alias.
- A prompt goes in with `priority: 'next'` and the uuid of the message id the
  UI sent, so a prompt sent mid-turn joins the turn at its next tool
  boundary. Model, effort (`applyFlagSettings({ effortLevel })`) and plan mode
  change in place.
- The projector's live mode opens the assistant message and its text and
  reasoning parts from stream events and completes the message on
  `message_stop`, because tools start while later blocks still stream. A tool
  result that arrives afterwards moves `time.completed` to the result time.
  Usage
  accumulates privately from `message_start` and each `message_delta`; it is
  written to the message only after both cache fields have arrived. A proxied
  stream that omits them leaves the message without `tokens`, so the UI hides
  the measurement instead of reading a false zero. A history read fills a live
  record's missing `tokens` and `contextWindow` from the transcript, and a
  settled Claude turn refreshes the open transcript so those measurements
  replace the live placeholder. A successful result frame then applies its
  per-request `usage.iterations`: a one-to-one count updates every assistant in
  the turn, and any other count updates only the final assistant. The frame's
  aggregate usage never describes one message. Its `modelUsage` also stamps the
  effective `contextWindow` when the model is unambiguous. Only `assistant` and
  `user` frames and the `compact_boundary` system frame reach `applyEntry`. A Task call announces the subagent session with
  `session.created`. `claude/subagents.js` routes child frames by
  `parent_tool_use_id` to an independent projection and publishes that child's
  messages, reasoning, tools and deltas through the same event hub. Full-frame
  UUIDs deduplicate replay; children never append messages to the parent.
  Task-start events establish busy status, and foreground tool results or
  task terminal events settle it. An asynchronous launch result leaves the
  child running. The native status snapshot includes running children, and
  message reads overlay their live records for cold opens and reconnects.
  A live child's session record is available before its transcript is indexed.
  Parent completion does not end background children; interruption and query
  exit settle their outstanding work and clear their activity. Child state
  stays scoped to its owning query and is released when that query exits.
- `canUseTool` answers `AskUserQuestion` from the question registry. The SDK
  still asks for this tool in `bypassPermissions` mode. `ExitPlanMode` creates
  a pending question with `kind: 'claude-plan-exit'`, including the plan when
  the CLI supplies it. Only the single answer `build` approves execution and
  returns a session-scoped `setMode: bypassPermissions` permission update.
  `plan`, dismissal, abort and query closure leave planning in place and stop
  the turn. A custom answer returns feedback so Claude can revise the plan.
  Only an explicit single `plan` answer suppresses the resulting aborted
  assistant-message error, so keeping a plan does not show a stopped notice.
  Tools, subagents and activity still settle as interrupted. This intent is
  scoped to that turn and cleared at every result or query exit. A manual stop
  or query closure takes precedence, and real failures remain visible.
  The shared UI translates the choices; their wire values remain `build` and
  `plan`. Calls without a `plan` input still project as `plan_exit` tools.
- A result frame with `queued_turn_count` 0 settles the turn. A stop is
  `terminal_reason` `aborted_*` and becomes the `MessageAbortedError`
  `{ message: 'aborted' }` the UI writes for turns it settles itself, with
  unfinished tools settled as `Interrupted`. The CLI's stop marker entries
  (`[Request interrupted by user]`) are not shown as user messages.
- Claude Code also runs turns nobody prompted. When a background task
  finishes, the CLI gives its notification to the model and answers it in a
  turn of its own, which `queued_turn_count` does not count. The main
  conversation's first `message_start` while the session is idle marks that
  turn busy the way a prompt does, and its result settles it. A session left
  idle through such a turn has no working stop, the UI settles its open reply
  as interrupted, and the idle timeout the finished task started closes the
  query mid-turn.
- A query with neither a running turn nor background work for 5 minutes
  closes; the CLI exits and the next prompt resumes the session. The CLI's
  `background_tasks_changed` snapshot owns background activity for that
  process, resets on a new query, and excludes tasks marked `ambient`.
  Malformed snapshots preserve the preceding state. A finished parent turn
  can remain idle and accept input while its background tasks keep the query
  open. When the last task ends, the full idle timeout starts again.
  At most 6 queries run; opening another closes the least recently used query
  with no turn or background work and fails with `429 NATIVE_TOO_MANY_SESSIONS`
  when all are working. Explicit closure and shutdown still stop background
  work. A session's next query starts only after its previous query's
  process has exited, so two CLI processes never write one transcript. A
  closing query adds no live records to history reads.
- Clients see those background tasks, because an idle session with tasks
  will continue by itself. The query keeps each non-ambient task's id, type
  and description, and publishes every change of the set as
  `session.background.updated` `{ sessionID, tasks }`: the whole set, empty
  once none run. The CLI's exit publishes the empty set, since nothing wakes
  the session after it. `GET /api/native/sessions/background` returns every
  open query's set as `{ [sessionId]: { directory, tasks } }` for clients
  that missed the events. The map is complete: no task outlives its query.
  Status, notifications and suggestions still follow turns only. Codex
  reports no background work, and Claude's scheduled wakeups are not tasks.
- The Stop route (`POST .../abort`) interrupts the running turn. When no
  turn runs, it stops the session's background tasks one by one with
  `stopTask`; the CLI marks a task the user stopped as notified, so the model
  is not woken to report it. OpenChamber does not declare
  `perTaskStopAffordance`, so by the SDK's contract an interrupt also ends
  background tasks. Reverts, archive and delete stop only the turn
  (`stopTurn`) and close the query when they need to.

Codex (`codex/live.js`): turns on the shared app-server.

- `codex/catalog.js` combines `model/list` with `config/read` and the CLI's
  model metadata in `model_catalog_json` or `$CODEX_HOME/models_cache.json`.
  The working window respects `model_context_window`, each model's maximum,
  and its reserved percentage. Chat and small-model calls share this catalog.
  A missing default cache or missing model metadata keeps the legacy estimate;
  other file or API failures report a catalog error. Codex owns automatic
  compaction and applies context settings when it loads a thread.
- The app-server unloads a thread once its turn ends, so a prompt resumes the
  thread first (`thread/resume` with approval policy `never` and full access),
  except a thread the runtime just started, which has no rollout to resume.
- A prompt starts a turn with the message id as `clientUserMessageId`, the
  model and effort, and `collaborationMode` `default` or `plan` with Codex's own
  instructions (`experimentalApi` is declared at initialize). A prompt sent
  mid-turn goes out as `turn/steer`.
- Turns explicitly request `summary: 'auto'`; native reviews apply the same
  setting through `thread/settings/update`. Omitting the field can select a
  model's default of no readable summary even when the saved turn context says
  `auto`. Streamed summary text and completed reasoning items use the existing
  reasoning parts. The UI's reasoning setting controls their visibility.
  Encrypted reasoning alone has no displayable text; old turns without a
  returned summary cannot be filled in retrospectively.
- Fast: `model/list` names a model's service tiers, and a model with the
  `priority` tier (Codex calls it Fast) gets `fast: true` in the catalog. The
  UI then offers each effort again as `<effort>-fast`; `codexVariantSettings`
  (`catalog.js`) reads a variant back as its effort and whether it runs fast.
  A turn's `serviceTier` stays with the thread for later turns, and Codex's
  own settings may load a thread on Fast, so the live thread keeps the tier
  that `thread/start` and `thread/resume` report and sets `serviceTier` on
  `turn/start` only when the variant asks for another one: `priority`, or
  `default` to leave Fast. A variant without `-fast` never runs fast.
- A compaction starts a new assistant segment keyed by the compaction item id.
  Replies before and after it keep distinct message ids across live updates
  and history reads, so reconciliation cannot merge them across the marker.
- A completed history assistant record supersedes a live copy of the same id
  that never observed the turn finish. The live copy may still be an
  in-progress projection with unfinished tools; the transcript is the settled
  state. A live record that is itself completed keeps its parts and only takes
  missing tokens or contextWindow from history.
- Every `item/started` and `item/completed` re-projects the running turn with
  the history projector; agent text streams as deltas. The live turn owns each
  item's `startedAtMs` and `completedAtMs` (receipt time for older CLIs), so a
  finished patch exposes its output and a finished reasoning block stops
  streaming before the whole turn ends. Duplicate starts, events for another
  turn, and deltas after item completion cannot reopen or overwrite it.
  These timestamps leave memory with the turn; persisted history recovers
  them from the rollout's `item_completed` records and falls back to turn
  times only for items without one. `turn/plan/updated` becomes the
  `session.todos.updated` snapshot below.
- A `plan` item is the plan a planning turn wrote. It projects as the
  `plan_exit` tool part Claude Code's ExitPlanMode projects as — a collapsed
  row the reader opens — so a session keeps one record of the plan it was
  asked to approve, in the same shape either CLI produces.
- Codex leaves its `update_plan` tool out of the model's declaration unless
  `tools.update_plan.enabled` is set, and that tool is what makes the CLI send
  `turn/plan/updated` at all. `codex/app-server.js` passes it as a fixed
  argument, not through the connection overrides: those are empty until the
  user configures a provider, which would leave the CLI's own login without
  the tool.
- A `thread/started` notification with a known `parentThreadId` registers a
  child before its first turn is persisted. Its reported directory and model
  belong to that child, including nested agents. Child turn/item events use
  the same projector and native publisher as directly prompted threads, and
  history reads overlay the child's live turn. Thread and turn notifications
  own its busy status; finishing a parent does not settle its children.
  Duplicate announcements do not reset a running child. Unload, closure and
  app-server exit clear child activity and release its live metadata.
- Approval requests are accepted, `item/tool/requestUserInput` goes to the
  question registry, MCP elicitation is declined, and anything else is refused.
- An OpenChamber planning turn captures its send selection when it starts.
  On successful completion, its last completed, nonempty `plan` item opens
  a `codex-plan-exit` question through `codex/plan-decisions.js`. Task lists,
  ordinary text, child turns and history reads never open one. The Codex turn
  is idle while the decision waits; the native questions endpoint restores
  that pending decision when the UI reconnects.
- Only the single answer `build` starts implementation. The runtime sends
  `Implement the plan.` as an ordinary new prompt in `default` mode, using
  the planning turn's directory, model and effort. The normal send path owns
  snapshots, message IDs and recorded selections. Its `ncx_u_plan_<uuid>`
  client ID persists in Codex's user item. Live and historical projections
  retain the original message and mark its text with
  `metadata.openchamberOrigin: 'codex-plan-approval'`; the shared UI hides that
  part without losing the execution turn or its Build selection. This does
  not depend on the bounded send registry. Ordinary prompts with the same
  text, custom feedback and older unmarked approvals remain visible.
  Custom feedback starts a new planning turn; `plan`, cancellation or an invalid answer sends nothing.
- `interactions.js` keeps the selection of a question OpenChamber asked, keyed
  by the tool call it belongs to, and `attach` puts it back when the session is
  read. A plan exit becomes a `question` part carrying the plan and the answer;
  any other question keeps the part it already had and gains the answers.
  Nothing is recorded for a question asked without a tool call, which is why
  Codex's plan exit left no trace until its question named the plan item's own
  part. That part is what `attach` matches, and an answer arrives after the
  turn has settled, so the match happens on a history read rather than live.
  The restored row keeps the plan tool's interval, not the approval timestamp:
  an approval can settle long after the assistant completed, and turn
  telemetry must not subtract time outside that step.
  A failed start publishes a session error without retrying or recording a
  successful Build prompt.
- Plan decisions remain cancellable through prompt preparation and thread
  resume. New prompts, stop, compaction, review, reverts, archive/delete,
  thread closure and app-server exit invalidate them. Duplicate replies
  cannot send again. They live only in the server's memory and are not
  reconstructed from history after restart. The goal loop checks
  `hasPendingPlanDecision` before auditing or continuing an idle native session.

`questions.js` holds native questions in memory. A reply or rejection resolves
the pending callback and publishes `question.replied` or `question.rejected`.
The optional per-question `onReply` acknowledges delivery before settlement.
A failed delivery retains the question for retry; another reply during delivery
returns `NATIVE_QUESTION_REPLY_PENDING`. Authoritative interruption still
withdraws an in-flight question. DeepSeek uses this acknowledgement boundary.
Tool questions end with their turn; a completed Codex plan's decision has the
separate lifetime described above.

`interactions.js` retains call IDs, choices, outcomes and timestamps, without
copying question bodies. It restores exact multi-select/custom answers and
plan decisions after reload. Forks copy only retained calls; deletion removes
the metadata. Reply acknowledgement awaits the metadata write. Plan questions
include optional `nativePlanCallID` metadata naming the
original call, so the UI keeps disclosure state across the original tool and
its answered question. It is rebuilt from saved call IDs without a migration.
Native history remains readable if supplemental metadata fails: `metadataComplete: false`
reports the partial read and the UI keeps previously measured token fields.

Codex consumes `thread/tokenUsage/updated` for its matching active turn.
Duplicate/stale counters do not publish again, and steering and compaction keep
separate segment accounting. `item/plan/delta` updates only the target plan part;
the completed item supplies the authoritative final text. Structured MCP calls
carry MCP provenance so the concise transcript retains them, including tools
whose names resemble built-ins. MCP `isError` remains a failed tool result.

`loadMessages` lays a running turn's live records over the history it read,
so a reload mid-turn shows the streaming reply and the next delta lands on a
part the UI holds.

Prompt parts (`prompt-parts.js`): text passes through; images go as images
(Claude also takes PDFs as documents); a text file sent inline is decoded into
the prompt; a file referenced by path is named for the agent to read. Anything
else is refused with `400`, never dropped.

A prompt's `instructions` come from an OpenChamber feature that must tell the
agent something (the `/btw` boundary, a review's handoff rules, a goal's
reminder). They are appended to the prompt's text as one
`<openchamber-instructions>` block, after the user's parts so their ids stay
the same. Both projectors hide that block, live and in history, so the
conversation shows what the user wrote.

The global AGENTS.md, which the Behavior settings edit at
`<OpenCode config dir>/AGENTS.md` and OpenCode reads as global rules, reaches
every CLI session as well (`instructions.js`), in OpenCode's
`Instructions from: <path>` form: appended to Claude Code's system prompt when
a query starts, and passed to Codex as `developerInstructions` on
`thread/start`, `thread/resume` and `thread/fork`. The file is read at every
start, so an edit reaches the next session. Claude Code records its system
prompt with a conversation's first request, so an existing Claude session
picks up an edit only after it compacts. A missing, empty or unreadable file
adds nothing. No other OpenChamber context reaches the CLIs.

## Reverts and forks

DeepSeek uses the same pending/file restore contract, then creates a native fork
on commit while preserving its logical session identity. Its versioned cursor,
identity segments, admission recovery and locked permanent deletion contracts
are detailed in `deepseek/DOCUMENTATION.md`. Managed DSH prompts also participate
in the existing shared memory store; independent terminal enrollment remains
Claude/Codex-only.

A revert follows OpenCode's model: files go back at once, the session record
carries `revert: { messageID }` while the revert can still be undone, and the
next prompt commits it by rewinding the CLI's conversation. `revert.js` owns
the revert state and `snapshots.js` the files. Changes to one session's
revert state run one at a time.

Files:

- Before every OpenChamber prompt the work tree is snapshotted into a shadow
  git repository under `<data dir>/native-agents/snapshots/`, one per
  repository root. Every command points `--git-dir` at the shadow repository
  and `--work-tree` at the user's repository, which only ever answers
  `rev-parse`; its `.gitignore` applies. Directories outside git get no
  snapshots.
- When the session goes idle, the tree is snapshotted again for the prompts
  that busy period answered.
- A revert restores only the files the reverted turns changed, to their state
  before the reverted prompt, so edits the user made between turns stay.
  Unrevert puts those files back as they were before the revert.
- A prompt without a snapshot (typed in a terminal, sent in a fork, or older
  than the 200 kept per session) reverts the conversation only. The answer
  says `conversationOnly: true`, and the UI tells the user.

Conversation:

- The prompt that commits a revert marks it `committed` before it hands
  anything to the CLI. From then on history reads leave the reverted messages
  out and the session record drops `revert`. If the CLI never takes the
  prompt, the revert goes back to pending and can be undone again.
- Claude Code rewinds by resuming at the last chain entry before the reverted
  prompt (`resumeSessionAt`). The prompt closes the open query and resumes a
  new one at that entry; later prompts for the same revert join it. The
  transcript shows the rewind only once the CLI writes the new prompt, so the
  revert stays `committed` in the registry until the chain no longer holds the
  reverted prompt. The runtime checks after every finished turn and before
  each prompt, and resumes at the entry again if the rewind never happened.
- Claude Code has no entry to resume at before a session's first prompt, so
  reverting it is `409 NATIVE_REVERT_FIRST_MESSAGE`.
- Claude Code resumes only inside the chain after the last compaction, so
  reverting or forking from a message the history shows from before it is
  `409 NATIVE_REWIND_BEFORE_COMPACTION`.
- Codex rewinds with `thread/revert { beforeTurnId }` before the next turn
  starts, and the revert ends with that call. A turn that is already gone
  counts as rewound. Codex keeps whole turns, so a message steered into a
  running turn cannot be a revert or fork point: `409 NATIVE_REVERT_MID_TURN`.
- A revert first stops a running turn and waits up to 10 s for the CLI to
  settle it, else `409 NATIVE_SESSION_BUSY`.

Forks copy the conversation before a user message into a new session: Claude
`forkSession({ upToMessageId })` at the entry a revert would resume at, Codex
`thread/fork { beforeTurnId }`. A fork without a message copies the whole
conversation (`/btw` of an idle session). Forking at a Claude session's first
prompt starts an empty session instead. Claude forks are registered as confirmed:
they have a transcript, and SDK sessions are not listed otherwise. Codex forks
are registered unconfirmed, because a fork before the first turn is empty, and
are named `<title> (fork)` the way Claude Code names its forks.

## Session management

Titles belong to the CLIs. A rename is Claude Code's custom-title entry
(`renameSession`, which the terminal shows too) or Codex's thread name
(`thread/name/set`). A title given at creation waits in the registry until a
Claude transcript exists and is then written to it; Codex takes a name before
the first turn. Once a transcript exists, the registry title is not used.

`codex/auto-title.js` generates a title after an OpenChamber-created Codex
session's first turn completes successfully. The completion callback registers
the work before awaiting the initial session refresh, and uses the registry
entry from before confirmation. Later turns, adopted sessions, named threads,
forks and subagents do not trigger generation. No startup history scan runs.

The title uses the configured Small Model with the same explicit-provider
override rules as manual AI rename. It reads only the first persisted turn,
supplying at most 4,000 characters of user text and 8,000 of final reply text.
When the turn has no non-commentary final answer, the last nonempty `plan` item
supplies the assistant text, because a plan-mode turn delivers its result
there. Other tools, reasoning, commentary and injected OpenChamber instructions
are excluded. A title is written through `thread/name/set` and announced as
`session.updated`.
This server operation works with the UI closed on web, Electron and connected
mobile clients. VS Code still has no native CLI runtime.

Generation is cancellable and limited to 60 seconds. Manual rename, archive,
delete, revert and shutdown cancel pending work. Manual mutations wait for an
automatic save/publication already in flight, but never wait for generation.
The store serializes title writes per session and rechecks the CLI's name,
directory, archive state and first-turn identity inside the automatic write.
Directory checks resolve symlinks because Codex canonicalizes its working
directory. The final check omits turn items. Codex has no name compare-and-set
operation, so a concurrent write from another CLI client after the check remains outside this
ordering. Failed or empty generation leaves the preview intact; manual AI
rename remains available to retry. A failed first turn does not auto-title a
later turn.

Archive: Codex archives a thread by moving its rollout into
`archived_sessions/` (`thread/archive`, `thread/unarchive`). Listing asks for
archived threads separately, and a single read goes by that rollout path.
Claude Code has no archive, so the registry keeps the flag, adopting a
terminal session (`origin: 'adopted'`) the first time one is archived.
Archiving stops a running turn.

Delete removes the session from its CLI's store the way the CLI's own delete
does: Claude's transcript and subagent transcripts (`deleteSession`, which
leaves the CLI's task files), Codex's thread (`thread/delete`). A running turn
stops and a Claude process exits first. A session with no transcript yet only
leaves the registry. Codex keeps a thread its forks still read from:
`409 NATIVE_DELETE_FORK_SOURCE`. The session and, for Claude, its subagent
sessions go out as `session.deleted`.

A Claude Code subagent session is part of its parent's transcript. It takes
its parent's archive flag, is announced with its parent when that is archived,
restored or deleted, and cannot be renamed, archived or deleted on its own
(`400`). Codex subagent threads are threads of their own.

## Compaction, commands and todos

`POST /sessions/:id/compact` runs the CLI's own compaction on the model the
composer picked. Claude Code gets `/compact` (with any summary instructions)
as a prompt that shows no user message of its own; Codex runs
`thread/compact/start`, which takes no instructions (`400`) and streams in as
a turn of its own. A pending revert commits first, as for a prompt. Either
way the conversation shows a `compaction` message with explicit lifecycle and
Claude's summary. IDs and legacy compaction parts remain stable. A successful
compaction clears the measured window until the next response; a running or
failed compaction does not erase the prior reading. Connection sessions use a
separate capped launch for this command, so a manual compaction requested
while a turn or background task is running fails with
`NATIVE_CONNECTION_BUSY` instead of replacing that process.

- Claude's live `compact_boundary` frame opens the marker, the synthetic user
  frame after it is the summary, and replayed local-command output is
  skipped, so live records match a later history read.
- History shows other slash commands as typed (`/cost`, a skill) under the
  prompt's own id; `/compact` shows only as its marker, and local-command
  output is left out. Only a command entry marked `isCompletedLocalCommand`
  came from a prompt. The CLI writes the same tags unmarked for commands it
  runs itself, such as the `/model` a model switch between turns records, and
  those stay out of the conversation.
- A Codex `contextCompaction` item becomes the marker `ncx_k_<TK>_<item id>`.
  A /compact runs as a turn of its own, so a compaction that follows the
  turn's prompt is marked `auto`.

`GET /commands?backend=&directory=` lists Claude Code's slash commands
(`supportedCommands()`), from a query running in the directory or from one
opened just to ask, which sends no prompt and leaves no transcript. Claude
lists are kept for 10 minutes per directory; a failed listing is not kept.

Codex parses built-in slash commands in its terminal, not in `turn/start`.
The composer therefore owns their dispatch. Model, effort and plan commands
update its existing selections. Session commands reuse the session actions.
`/status` reports the composer's next-turn settings, not token or account usage.
`/diff` opens the workspace Git view, `/mention` opens file completion, and
`/copy` copies the latest completed assistant text loaded in the session.
`/side` uses OpenChamber's existing `/btw` flow.

Codex command discovery calls `skills/list` with the requested directory and
`forceReload: true`. It returns enabled skills and any per-skill errors as
`warnings`, so one broken skill does not hide valid skills. The menu fetches
on opening or changing runtime/directory, never on each keystroke. Built-in
commands remain available while skills load or discovery fails.
`codex/commands.js` resolves `/skill-name arguments` again at submission and
sends both `$skill-name arguments` and the explicit native `skill` input with
the discovered path. Files and feature instructions retain their order.
`/init` becomes an explicit request to inspect the project and create or update
its AGENTS.md. Ordinary prompts cause no command-discovery request.
Unknown, disabled and unsupported slash commands fail with
`NATIVE_CODEX_COMMAND_UNSUPPORTED` before a turn starts. Absolute file paths
and slashes within prose remain ordinary text.

`POST /codex/command` handles `/skills`, `/mcp`, `/ps`, `/stop` and `/review`.
It accepts a closed command union, never arbitrary RPC methods. Results are
`{ kind: 'output', entries, notices }` or `{ kind: 'accepted' }`. Skill
inspection also works before the first session. Thread-specific inspections
resume the thread when needed; history reads still never resume it.
MCP and terminal listings consume all pages and expose only their display
fields. `/stop` cleans the selected thread's background terminals.
`/review` calls `review/start` with inline delivery after applying the selected
model and effort. It accepts an uncommitted-changes target, a base branch, a
commit, or custom instructions, and refuses a busy session. Its streamed
events use the same projector as other turns.

Terminal-only controls, such as `/raw`, `/statusline` and `/keymap`, are not
forwarded as prompts. Commands without an OpenChamber handler, including
`/permissions`, also report unsupported; native sessions still use the fixed
approval policy documented above.

### Claude checklists

Claude Code offers its task-tracking tools only to the models it recognizes,
and a connection's model is a third-party id it does not, so every query opts
in with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (`claude/live.js`). Without it the
model has no checklist tool at all and records nothing here. Those tools write
each task as `<config dir>/tasks/<list id>/<task id>.json`.

`claude/tasks.js` owns checklist reads and publications. The query captures
`CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_TASK_LIST_ID` from its actual connection
environment. Without an explicit list ID, it uses the session UUID. Only the
absolute config directory and safe list ID are saved in the registry's private
`claudeChecklistSource` field. They never enter public session metadata; the
snapshot identity is a hash of the source. A restart reads that captured source,
not the current connection or environment. Older entries without a capture
report `source_unknown` until a query supplies one. A failed source write leaves
live reads working, logs a fixed warning without paths or environment, and does
not guarantee recovery of the new source after restart.

`GET /sessions/:id/checklist` does not open a query. A ready snapshot carries
`identity`, `source`, `revision`, `observedAt`, `complete`, `unreadable` and
`items`. Items retain description, active form, owner and dependency IDs when
provided. Missing task directories are a successful empty file observation,
except for a confirmed TodoWrite-only history fallback. Successful empty file
lists, file-tool observations and previously observed files take precedence over
that fallback. Compacted history cannot establish TodoWrite-only usage. History
is inspected at most once per bound source, using the existing store; a source
outside the SDK's config root has no history fallback.

File reads reject unsafe list IDs, directory links, non-regular files and
filename/record ID mismatches. Limits are 64 KiB per file, 8 MiB total, 2,000
items and 4,000 directory entries per read. Bad files and read races increment
`unreadable` and make the result partial; directory read failures throw. Clients
merge valid partial entries without deleting missing ones. A complete empty
snapshot can clear the list; failure cannot.

Successful TaskCreate/TaskUpdate results trigger a shared-list read, including
those inside subagents. Reads coalesce by list identity and repeat if a mutation
arrived while reading. All bound sessions sharing that file list receive the
same `session.checklist.updated` snapshot. Successful TodoWrite results publish
directly to their own conversation's history list, never another session sharing
a file source. File authority wins over TodoWrite. Child TodoWrite has a child
identity and cannot replace the parent's list. Token deltas do no checklist
work. Idle keeps the checklist; session deletion releases its binding.

#### The plan a list still shows

A task list keeps every task its conversation ever created, and a model starts
a new plan by creating new ones. So a task the last complete read did not hold
means the finished tasks before it belong to a plan the user has left, and they
stop being published. Unfinished tasks always stay, and so does a task created
in that very batch, whatever status it already reports. A task that runs again
is shown again, and one whose file is gone cannot stay retired. A status change
on its own, a repeated read and a read that states nothing new retire nothing,
so a task that just finished stays until the next addition.

Only the published list narrows. The task files, the history and the
conversation are untouched, and another client of the same list is unaffected.

The projection lives in the registry under the list's identity, so every
session bound to a list shows the same plan and a restart does not show retired
tasks again. Only a complete read moves the baseline or retires a task; a
partial read and a failed one change neither, though a task such a read shows
running again is released. A projection that could not be saved keeps the list
as it was and is retried by the next read. A list nothing references anymore
never writes over the state its rebound list reads. A first read without a
baseline only establishes one; a successful `TaskCreate` result, whose
`task.id` comes from the tool's own structured output, names what arrived even
then. A structured result that does not parse still refreshes, and the next
complete read decides.

One thing no file read can answer is the order of two events between reads. A
task created and another finished while nothing was reading arrive as one batch,
and the created one is what stays. Reads happen when the checklist is read, when
a task tool succeeds and on the visible refresh; nothing polls the files.

### Claude background-task details

`claude/background-tasks.js` owns one query generation, its task records and
output grants. `background_tasks_changed` alone owns membership. Start, progress,
update and notification edges supply details and outcomes without changing the
live set. A disappearing task has no inferred successful outcome. Ambient
members appear in details but never in the existing non-ambient activity set or
query keepalive calculation.

A query starts with `state: unknown`, a random generation and empty observations.
The first valid full-set signal, including an empty set, establishes `active`
observation. No timeout or SDK version claims support. `inactive` on close and
`unsupported` on unsupported backends have null generation and no records.
`session.tasks.updated` and GET return the same full snapshot and revision.
Revisions increase across query replacements during one server runtime. They
restart with the server, so reconnect readers must reset revision authority and
reject their old in-flight requests. Equivalent updates do not publish again.

The owner retains at most 100 recent nonmember records, including terminal tasks
and tasks whose end edge was missed. It never truncates current full-set members.
`omitted` reports eviction. Closing the query clears records and output grants
and publishes an inactive snapshot. Records are not durable task history.

Single-task stop requires the current session, directory, generation and full-set
membership, and calls only that query's `stopTask`. Concurrent requests for the
same task share one operation. Success means accepted, not completed; failure is
reported on that record without changing another task. Existing session Stop,
`perTaskStopAffordance` and `agentProgressSummaries` remain unchanged.

The installed Agent SDK README links the SDK overview. Its `sdk.d.ts` documents
`stopTask(taskId)` and `readFile(path, { maxBytes, encoding })`; it has no general
task-list API. `sdk-tools.d.ts` documents structured Agent `outputFile` results,
and task notifications expose `output_file`. Only those structured CLI fields,
associated with this query's task identity and built-in tool calls, can grant
output access. Rendered tool text, MCP payloads and caller-provided paths cannot.

The output root follows the official Claude environment-variable contract:
`CLAUDE_CODE_TMPDIR` overrides the temp base; macOS otherwise uses `/tmp`, other
platforms the OS temp directory; Claude adds `claude-<uid>` on Unix or `claude`
on Windows. Claude Code 2.1.293's installed source places task outputs under
`<root>/<project>/<session UUID>/tasks/<task ID>.output`. The reader validates a
CLI-provided path against that layout rather than constructing or searching for
one. Only the configured root's OS alias is normalized, such as macOS `/tmp`.
The root and all components below it must be real directories/regular files;
symlinks and another session/task are refused. The server opens the verified
artifact with `O_NOFOLLOW`, checks that its file descriptor still names the
verified regular-file inode, and reads from that descriptor. A path swap between
validation and opening is rejected; a swap after opening cannot retarget the
read. This deliberately avoids the SDK's path-based `readFile` race. The existing
bypass-permission native runtime authorizes only this captured task artifact,
not arbitrary files. The query must still have its read method and remain open.

Outputs are fetched only on request with a 256 KiB response cap and at most one
extra byte to detect truncation. Empty, truncated, not-recorded, unreadable and
query-closed responses stay distinct. `outputAvailable` means a structured path
and the current query's read method are present, not a promise the file still
exists. A temp override only present in CLI settings, or a different CLI path
layout, can therefore be unreadable rather than broadening the allowed root.
`canStop` likewise reflects current query membership and its real stop method.
No output content or connection environment is logged.

Web and Electron run this owner on their server. Hosted mobile and Capacitor use
the same HTTP and event contracts without local file access. VS Code remains
explicitly unsupported. Existing global background snapshots and
`session.background.updated` retain their non-ambient activity-only meaning.

Focused validation uses `tasks.test.js`, `background-tasks.test.js`,
`live.test.js`, `subagents.test.js`, `registry.test.js` and the task/runtime route
cases in `runtime.test.js`. The latter also contains revert fixtures that invoke
git; a no-git validation run selects only the task-runtime and route groups.
These fixtures do not launch a real Claude query or prove platform/relay behavior.

### Codex plan documents and steps

`codex/plan-todos.js` owns the steps a turn reports through `update_plan`.
Codex marks the notification carrying them transient and non-durable — upstream
`rollout/src/policy.rs` returns `None` for `EventMsg::PlanUpdate` under
"Transient, non-durable events" — so they reach no rollout entry, no
thread-history item and no RPC, and nothing can read them back. The owner
therefore reports an observation of one process and never claims more. A thread
it has not heard from is `unknown` with a null generation, which is not a
thread without steps. `active` follows an observation, and `inactive` follows
the thread being unloaded, closed, forgotten or losing its app-server, keeping
the steps it last saw because they are the only record that will exist. Closing
a thread that never reported steps publishes nothing. Equivalent observations
do not publish again, and a revision a reader already holds is never reissued;
revisions restart with the process, so a reconnect resets the reader's
authority and a new generation replaces the old snapshot whatever its revision.
Reads go through `GET /sessions/:id/todos`, which answers `unknown` for a
thread this process holds no observation for and `unsupported` for another
backend.

A turn ends by unloading its thread and the next turn resumes the same one, so
an observation outlives the turn that began it: a thread that reports steps
again is `active` again in the same generation, and a list that returns
publishes even when its steps did not change. A report names the turn that made
it, and one whose turn already ended, whose thread is not loaded or whose
thread this connection does not drive is dropped, so a late report cannot
present an old plan as the current one.

Every report is the whole list, and a step the previous report did not have
means the finished steps before it belong to work the user has moved past, so
they stop being published. Unfinished steps always stay, and so does a step the
report adds whatever it already says. A step is named by its text and, for a
text the list repeats, by which occurrence it is, so reordering the same steps
retires nothing and a report that drops one states nothing about the others. A
retired step that runs again is shown again. The statuses, order and text of
every step still come from Codex; only what the list publishes is narrowed.

`codex/store.js`'s `latestPlan` reads the newest nonempty `plan` item from the
thread store, newest turn first, and `runtime.plan` wraps it. The thread store
is the source rather than the live turn because Codex unloads a thread once its
turn ends — the moment the plan is most worth reading. A thread with no plan is
`{ state: 'empty' }`, which is a successful authoritative read; a failed read
throws and becomes an HTTP error, so a caller never reports one as missing.
`{ state: 'unavailable', reason: 'unsupported' }` answers any other backend.
The snapshot carries `text`, `truncated` (past 200,000 characters) and the
`turnId` that wrote it, with no shared-list identity: a plan belongs to one
thread and is not reconciled across sessions.

## Registry

`<data dir>/native-agents/registry.json` holds only what the CLIs cannot
tell us: which sessions OpenChamber created or adopted (so they stay listed),
an archive flag for Claude (which has no archive), the model, effort and
agent of each OpenChamber send (at most 200 per session), the work-tree
snapshots of each OpenChamber prompt (at most 200 per session), the revert
in effect, the private captured Claude checklist config directory/list ID,
and OpenChamber's own session metadata (btw and review links,
goals, the session assist's recap and suggestion), which OpenCode keeps in its
session metadata and a CLI has nowhere to keep. Session records carry that
metadata as OpenCode's do; `openchamber.native` is the server's and a client
cannot overwrite it. The PATCH route replaces it whole (at most 64 KiB), and
`setSessionAssist` writes the assist into it. Writing metadata adopts a
session the CLI created. A malformed snapshot, revert or metadata entry is
dropped on load; its session keeps its entry.

The `checklists` map holds what each Claude task list still shows: the raw ID
baseline of its last complete read, the IDs of finished tasks a later plan
retired, and the IDs a `TaskCreate` result named that no complete read has
consumed yet. At most 2,000 IDs per field. It is keyed by the list's identity
rather than a session, because several conversations can share one list and
deleting a session must not retire the projection they read. A malformed
projection is dropped whole: a partially read record would show retired tasks
again, and no record at all is the honest answer.

A session OpenChamber creates has no transcript until the CLI finishes a turn
in it. Until then `confirmedAt` is unset and the stores list and read it from
the registry. The first finished turn confirms it; from then on only the CLI's
store answers for it, so a session deleted in a terminal disappears here too.

A missing file is an empty registry. An unparseable file is moved aside as
`registry.json.corrupt-<timestamp>`, the registry starts empty, and
`capabilities().registry.reset` reports it. A read error throws, so no caller
mistakes it for "no sessions". Writes are serialized and atomic, and memory
changes only after a write succeeds.

## Claude Code connections

`claude/connections.js` owns named Anthropic-compatible connections in
`<data dir>/native-agents/claude-connections.json`. This is server-local
credential storage, outside preferences and OpenCode configuration. Writes
are serialized and atomic, with owner-only file permissions on POSIX. Missing
storage means no custom connections; malformed or unreadable storage fails
without replacing it. API responses carry `hasKey`, never the key. Omitting
`apiKey` when editing preserves it.

The authenticated `/api/native/claude/connections` GET/POST and `/:id`
PATCH/DELETE routes manage connections. Each model has a stable UUID separate
from the upstream model ID. The native catalog keeps provider `claude-native`
and names models `connection:<connection UUID>:<model UUID>`. User messages,
assistant messages and registry send records retain this identity. The default
CLI models remain available with their existing IDs and inherited settings.

A connection resolves to a revisioned launch configuration. The main model,
family aliases and subagents use its upstream model ID. Credentials, endpoint,
context/output budgets and competing backend/auth variables are supplied per
process. The auto-compact window reserves the effective output increment
(currently capped at 128k for Claude Code 2.1.301) inside the configured
context window, so a turn is compacted before `messages + max_tokens` can cross
the provider's hard limit. A manual `/compact` uses the same connection with a
64k summary budget under a distinct launch key, which lets a session already
near the hard window recover; the next ordinary prompt resumes the normal
budget. A private temporary settings file takes precedence over user/project
settings without putting keys in command-line arguments or modifying terminal
configuration. It is removed when the query exits, including failed starts.
A hard process kill can leave an owner-only temporary file for OS temp cleanup.
Provider error diagnostics redact the configured credential.

Changing a connection, its revision or its model replaces an idle query and
resumes the same transcript only after the old process exits. A running turn
or background task rejects the change with `NATIVE_CONNECTION_BUSY`. Prompts
for one session are serialized during launch so simultaneous sends cannot
open two writers. Other sessions keep their own configuration. Deleted models
or connections fail subsequent sends with `NATIVE_CONNECTION_UNAVAILABLE`;
existing queries finish with their captured credentials. History is retained.
No failure silently chooses another service. Managed Claude policies remain
owned by the CLI and can refuse an otherwise valid connection.

Utility generation resolves the same connection and does not require an
Anthropic account login for a configured key. Third-party models retain their
own thinking default. Image/PDF support and effort levels are configured per
model; custom models do not inherit Claude capabilities. A connection aimed at
the Kimi Coding endpoint reports its own usage quota.

Connection launches set `ENABLE_TOOL_SEARCH=false`: Tool Search writes
`tool_reference` blocks into tool results, and Anthropic-compatible
third-party endpoints reject that block type with HTTP 400 on every send that
replays it. Blocks already in a transcript — produced under the Anthropic
login, where Tool Search stays on — poison a resume onto a connection the
same way. Before a managed launch resumes a transcript, `store.js` scans the
chain the CLI would replay (entries after the
last compaction, block-level, sidechains excluded) and the send fails with
`NATIVE_HISTORY_NOT_PORTABLE` naming the referenced tools instead of spawning
a query that must fail. The default Anthropic login resumes unchecked. The
guard scans the active replay chain, excluding sidechains and text mentions.
It also detects replay carriers written by the removed ChatGPT plan bridge.
Nothing can replay them any more, so any resume of such a session fails before
spawning with `400 NATIVE_GPT_REPLAY_UNRESUMABLE`, and only a new session can
continue that work. No transcript is rewritten during a provider switch.

Web and Electron use the connected server's connections. Hosted mobile and
Capacitor use that same server and CLI. VS Code's native adapter rejects these
operations as unsupported.

## Codex connections

`codex/connections.js` owns named OpenAI-compatible connections in
`<data dir>/native-agents/codex-connections.json`. Storage, permissions,
serialized atomic writes, read-failure semantics and the `hasKey` projection
match the Claude Code connections above; the schema differs because Codex
authenticates a provider with one bearer key.

A connection reaches the CLI as process arguments, because Codex reads its
provider table from configuration rather than from the environment:
`-c model_providers.codexconn-<connection UUID>.{name,base_url,env_key,wire_api,requires_openai_auth}`.
The key itself is never an argument: `env_key` names a variable that the
app-server child receives in its environment as `CODEX_CONN_<UUID with
underscores>`. `buildCliChildEnv` strips `OPENCHAMBER_*`, so the prefix must
stay outside that namespace. Because `-c` is a start argument, the whole
provider table is written at spawn; a saved, edited or removed connection
restarts the shared app-server through `runtime.saveCodexConnection` /
`removeCodexConnection`. That restart never interrupts a turn: while any thread
is busy the server marks the process stale, and the next idle moment restarts
it. Until then a changed connection is simply not in effect yet.

Codex records a provider on the thread, so a session moves to a connection
through `thread/settings/update` with `modelProvider` before its next turn;
`turn/start` has no provider parameter. A thread on no connection runs the
CLI's own login under provider `openai`, which is what a session switches back
to. The native catalog names connection models
`codex-connection:<connection UUID>:<model UUID>` and `resolve` returns the
upstream model together with the provider id, keeping the catalog identity
separate from the upstream name.

Model metadata is hand-entered per model (id, context window, output limit,
image input, reasoning efforts) rather than read from the provider: Codex does
not fetch a catalog for a provider authenticated by `env_key`. `wire_api` is
fixed to `responses`, the only value the CLI still speaks; an endpoint that
only implements Chat Completions cannot be used. Connection models therefore
report no usage quota, unlike a Kimi Claude Code connection.

Routes: `GET/POST /api/native/codex/connections` and
`PATCH/DELETE /api/native/codex/connections/:id`. Responses never carry the key.
VS Code's native adapter rejects these operations as unsupported.
## Managed CLIProxyAPI gateway

Claude Code reaches GPT models through a CLIProxyAPI gateway that OpenChamber
runs itself. The gateway is a pinned third-party binary (MIT, router-for-me),
downloaded, verified and published by `pinned-binary/manager.js` through the
descriptor in `cliproxyapi/binary-manager.js`; nothing here installs or expects
a system copy. An endpoint run elsewhere is still usable, but only as an
ordinary custom connection on the same settings page.

`cliproxyapi/store.js` is the only source of truth: `enabled`, `port`,
`authDir`, `upstreamProxy`, `managementKey`, `clientKeys`, `installedVersion`
in `<data dir>/native-agents/cliproxyapi.json` (owner-only, atomic rename). A
v1 document, which described a pasted endpoint and key, migrates when it points
at this machine and is dropped otherwise; either way the connection that used it
keeps working. The default `authDir` is the upstream default `~/.cli-proxy-api`
when that directory already holds credentials, so an existing login carries
over, and otherwise a directory under the data dir. OpenChamber generates the
management key, so no route carries one, and `clientKeys[0]` is what the
connection it writes authenticates with; an empty list adopts the key of a
connection already pointing at the gateway.

`cliproxyapi/config.js` renders the YAML the process reads, and only that:
`allow-remote: false`, `disable-control-panel: true`, `session-affinity: true`,
`requests.proxy-url` when a proxy is set, and `oauth.auth-dir`. It is a derived
artifact, rewritten before every spawn and never read back, because the gateway
hashes a plaintext `secret-key` at startup and its management API normalizes the
whole file on write. The child environment drops every proxy variable and sets
`NO_PROXY` for loopback, so the config file is the only visible source of proxy
truth (Go ignores the macOS system proxy).

`cliproxyapi/gateway.js` owns the process, shaped like the Codex app-server: one
single-flight `start()`, readiness defined as the port answering rather than a
log pattern, a pre-spawn probe that refuses a port someone else owns with
`CLIPROXYAPI_PORT_IN_USE`, crash backoff capped at 30 s, `stop()` that persists
`enabled: false` (a person asked for that), and a kill-on-parent-exit handler.
A stop that is not a person's decision, like a host shutdown or a restart, goes
through `stop({ persist: false })` and leaves the switch on. `start()`
regenerates the
config, prepares the binary, spawns it, waits for the port, and reads the
running version from the `X-Cpa-Version` header. The server resumes a gateway
whose store says `enabled` at boot; nothing else starts one.

`cliproxyapi/service.js` composes the store, the gateway and the management
client into what the provider section drives: `status()`, `start()`, `stop()`,
`shutdown()` (the host-shutdown stop that keeps the gateway enabled for the
next boot), `setUpstreamProxy()` (which restarts a running gateway, because the
config is
read at startup), `beginLogin()`, `loginStatus(state)`, `cancelLogin(state)`,
`submitLoginCallback(state, url)`, `removeAccount(name)` and
`saveConnection(input)`. `status()` reports
`{ configured, enabled, running, ready, port, authDir, upstreamProxy,
installedVersion, runningVersion, install, managementEnabled, keyRejected,
accounts, clientKeys, lastError, restarting }`; `install` is a stat, never a
subprocess, so polling stays cheap.

`submitLoginCallback(state, url)` serves a browser that cannot reach the
gateway's loopback listener: the authorization page ends on
`http://localhost:1455/auth/callback`, which only resolves on the computer
running the browser, so the user pastes that address back. The URL is parsed for
its code and never fetched, its `state` must equal the attempt's, and the code
goes to the gateway's `POST /v0/management/oauth-callback`, which exchanges it in
the background while `loginStatus` keeps polling. A gateway that explains a
refusal in its response body reaches the caller as
`CLIPROXYAPI_LOGIN_CALLBACK_REJECTED` with that text as the message.

`cliproxyapi/models.js` reads the Codex CLI's own model cache
(`$CODEX_HOME/models_cache.json`, `~/.codex` otherwise) for the metadata a
connection row needs: display name, context window, image input and effort
levels. `listModels()` intersects it with what the gateway serves through
`GET /v1/models` (which takes a client key, not the management one) and reports
the rest as `unknown`. `importModels()` writes every known model into the
gateway's connection, replacing its list and updating the connection that
already points at this gateway instead of adding a twin. The output limit is
`CODEX_OUTPUT_LIMIT`, the same 128k the Codex path uses, and the context window
is the model's maximum, so an imported row matches what a working connection
looks like.

A model catalog name is the model's own name; the connection it belongs to is
identified by its id, not by a prefix on every model.

Routes are `GET /api/native/claude/cliproxyapi` (status),
`GET /models`, `POST /import`,
`POST /start`, `POST /stop`, `POST /proxy`, `POST /login`,
`GET|DELETE /login/:state`, `POST /login/:state/callback`,
`DELETE /accounts/:name` and `POST /connection`.
Any authenticated client may call them, including one reaching the server
through a tunnel or the mobile app: authentication is the boundary, not where
the request came from. The memory routes keep their own local-management
requirement, because enrolling a CLI installs an executable hook on the host.
Errors carry `CLIPROXYAPI_*` codes; `GET /v1/models` is the gateway's own
authenticated surface and is never proxied by this server.

Downloading needs egress to `github.com` and
`release-assets.githubusercontent.com` from the server process itself, which
does not use a proxy. A machine that reaches GitHub only through one can place
the verified release in
`<data dir>/native-agents/cliproxyapi/v<version>/<platform>-<arch>/`
(binary named `cli-proxy-api`, archive next to it) and the manager will verify
and use it as `source: 'installed'` without any download.

## Utility text generation

The small-model service accepts an explicit `codex-native/<model>` or
`claude-native/<model>` setting and reaches the CLIs through the runtime's
`smallModels`, keyed by provider id. Inherited CLI models use the CLI's login and catalog. Configured Claude
connections use their owning credential store. An unavailable selected model fails
instead of silently choosing another one. Failed or empty output rejects.

`codex/utility.js` runs these calls on the shared app-server. They are
ephemeral threads with no registry entry or published chat events.
Each request creates its own thread and supplies only its prompt and system
instructions. Environment access is disabled, the sandbox is read-only, and
shell, MCP, apps, plugins, hooks and multi-agent tools are disabled for that
thread. Any server-requested tool action is refused before reaching the normal
chat approval handler. Structured output uses `turn/start.outputSchema`.
The output-token budget is a brevity instruction because the turn API has no
hard output-token limit.

Only completed assistant text is returned; commentary and unrelated threads
are ignored. Abort and deadline handling
return promptly, then interrupt and unsubscribe the owned thread, including
when its start reply arrives after cancellation. App-server exit rejects all
pending utility calls without restarting the process for cleanup. Notification
routing does one thread lookup, with no scan of chat sessions.

`claude/utility.js` runs one Agent SDK query per request, with every built-in
tool, setting source and MCP server off, thinking off and `dontAsk`
permissions. `persistSession: false` keeps it out of the transcripts, so it
never shows up as a session. Claude Code tells the model its working directory
and that directory's git state, so the query runs in the system temp directory
rather than the session's project. The model goes through `claudeLaunchModel`,
which keeps the input budget in line with the window the catalog reports.
Structured output uses the SDK's `outputFormat`. Claude Code answers it with a
tool call of its own, one extra turn, so the query sets no turn limit. The
output-token budget is a brevity instruction here too. Claude Code also makes
a small Haiku call of its own for each query, visible in `modelUsage`.

`claude auth status --json` reports the login. It exits 1 when signed out and
still prints the state. An API failure such as an expired login ends the query
as a success whose text is the error, and that text rejects. The SDK takes
about two seconds to stop Claude Code, so abort and deadline answer the caller
at once and the query ends in the background. Shutdown aborts every running
query.

Web and Electron call these server runtimes. Hosted mobile and Capacitor use
the CLIs installed on their connected server. VS Code retains the explicit
`small-model-runtime-unsupported` response.

## Child processes

- `executables.js` finds `claude`, `codex`, `dsh`, Node and npm on the login
  shell's PATH, then in the installers' default locations. A miss is looked up again on the next
  call, so a CLI installed while the server runs is picked up.
- On Windows, npm installs a CLI as a `.cmd` shim, which Node cannot start
  without a shell. A native `.exe` in the installers' folder wins over a shim
  on PATH. A Codex shim still runs, through `cmd.exe /d /s /c call` with its
  fixed arguments (`cliCommand`). A Claude shim is refused with
  `503 NATIVE_CLI_SHIM` before the Agent SDK starts it: the SDK would launch
  it without a shell, and its JSON arguments are not safe on a `cmd.exe`
  command line. `launchableClaudeExecutable` owns this rule for live sessions
  and utility calls. This path is unit-tested only; no Windows host has run it.
- `buildCliChildEnv` passes the user's environment minus `OPENCHAMBER_*` and
  `OPENCODE_SERVER_*` (agents must not read OpenChamber credentials through
  `env`) and minus `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and
  `CLAUDE_CODE_SSE_PORT`, which would make a child believe it runs nested
  inside another Claude session.
- One `codex app-server --listen stdio://` process serves every Codex thread.
  It carries the configured connections as `-c` overrides and starts those
  connections' keys in its environment; a connection change restarts it once no
  thread is mid-turn (see Codex connections).
  It starts on first use and restarts on the next request after it exits,
  with start failures backing off up to 30 s. It never restarts in a loop of
  its own. A missing binary is `503 NATIVE_CLI_MISSING`.
- The app-server runs in its own process group on POSIX; stopping it sends
  SIGTERM to the group, then SIGKILL after 2.5 s. Windows uses `taskkill /T`.
- The Agent SDK starts and stops the Claude Code processes itself. A query
  closes by ending its input; its abort controller is the backstop five
  seconds later, and shutdown aborts every query at once.
- `claude auth status --json` runs through `execFile`, hidden on Windows and
  stopped after 10 s.

## Routes (`/api/native`)

Normal authenticated OpenChamber routes. Every read takes the session's
`directory`.

| Route | Answer |
|---|---|
| `GET /capabilities` | `{ supported: true, backends: { claude: { cli, tasks: { checklist, background, output, stop } }, codex: { cli, tasks: { plan, todos } } }, registry }`; task flags describe host implementation, query snapshots describe current observations |
| `GET /catalog` | Models per backend; Codex from `model/list`, reported per backend like listing |
| `GET /sessions?directory=` | Root sessions per backend (see Listing) |
| `GET /sessions/status?directory=` | Sessions with a running turn, as busy; every other session is idle |
| `GET /questions?directory=` | Questions native sessions wait on |
| `GET /sessions/:id?directory=` | One session record, `404 NATIVE_SESSION_NOT_FOUND` when missing |
| `GET /sessions/:id/messages?directory=` | A history page (see History projection) |
| `GET /sessions/:id/checklist?directory=` | Ready checklist snapshot or unavailable source, without opening a query |
| `GET /sessions/:id/plan?directory=` | The plan a Codex thread last wrote: a ready snapshot, an authoritative empty, or unsupported for another backend |
| `GET /sessions/:id/todos?directory=` | The steps Codex reported, as this process observed them: unknown, active or inactive, or unsupported for another backend |
| `GET /sessions/:id/tasks?directory=` | Full query task snapshot, generation, revision and omitted count |
| `GET /sessions/:id/tasks/:taskId/output?directory=&generation=` | Bounded task output or explicit unavailable reason; no path parameter |
| `POST /sessions/:id/tasks/:taskId/stop` | `{ directory, generation }`: stops only the owned current task; `{ accepted: true }` |
| `POST /sessions` | `{ backend, directory, title? }`: a new session, announced with `session.created` |
| `POST /sessions/:id/prompt` | `{ directory, messageID, parts, model, variant?, agent, instructions? }`; answers once the CLI took it. A model of the other CLI is `409 NATIVE_BACKEND_MISMATCH` |
| `GET /commands?backend=&directory=` | `{ commands: [{ name, description, argumentHint }] }` (see Compaction, commands and todos) |
| `POST /codex/command` | A Codex inspection or review command; output entries or an accepted review |
| `PATCH /sessions/:id` | `{ directory, title?, archived?, metadata? }`: the updated session, announced with `session.updated`; `metadata` replaces OpenChamber's session metadata |
| `DELETE /sessions/:id?directory=` | `{ deleted: true }`, announced with `session.deleted` |
| `POST /sessions/:id/abort` | Stops the running turn; `{ aborted: false }` when none runs |
| `POST /sessions/:id/compact` | `{ directory, model, variant?, agent, instructions? }`; answers once the CLI took it |
| `POST /sessions/:id/revert` | `{ directory, messageID }`: `{ session, filesRestored, conversationOnly }`, announced with `session.updated` |
| `POST /sessions/:id/unrevert` | `{ directory }`: the session record; a revert the next prompt committed stays |
| `POST /sessions/:id/fork` | `{ directory, messageID? }`: the new session, announced with `session.created`; without `messageID` it holds the whole conversation |
| `POST /questions/:requestId/reply` | `{ answers: string[][] }`, one list of labels per question |
| `POST /questions/:requestId/reject` | Rejects the question; `404 NATIVE_QUESTION_NOT_FOUND` when it is gone |

Errors are `{ error, code }`: a `NativeAgentError` keeps its status and code,
invalid input is `400 NATIVE_INVALID_REQUEST`, a Codex JSON-RPC error is
`502 NATIVE_BACKEND_ERROR`, anything else `500 NATIVE_INTERNAL_ERROR`.

## UI ownership

The shared UI reads these routes through `RuntimeAPIs.nativeAgents`
(`packages/web/src/api/nativeAgents.ts`; VS Code reports `supported: false`).
How the UI merges native sessions, history, statuses and questions into its
stores is in `packages/ui/src/sync/DOCUMENTATION.md` under "Native CLI
sessions".

## Compatibility audit

The native adapters support usage recovery, structured questions and answers,
explicit skill loading, compaction boundaries, streamed plans and MCP tool
results. Codex history supplements the app-server's retained turns from the
same thread's rollout; missing supplemental data is marked incomplete instead
of reporting authoritative zeros. Costs and account quotas remain unknown when
the CLI supplies none. Native goal token budgets remain explicitly unsupported
independently of usage reporting.

Claude's SDK history omits structured tool results. The supplemental raw read
recovers `AskUserQuestion` answers as well as file changes, including a separate
freeform response. A failed read is incomplete and is retried on the next
history request. Terminal multi-select strings stay verbatim because the CLI
has already joined them; OpenChamber UI selections retain their exact arrays.

Codex MCP elicitation is still declined by the existing request handler.
New upstream item types such as image generation, subagent activity, hook
prompts, function-call output and sleep have no dedicated transcript renderer.
Unknown items are skipped without fabricating empty messages. These are
remaining capabilities, not substitutes for the supported tool-call records.

Shared global preferences, project knowledge and terminal handoffs are owned by
`../agent-memory/DOCUMENTATION.md`. Enrollment is opt-in and local to the server
computer. Codex's own hook trust review still applies. VS Code explicitly
reports native agents as unsupported; mobile surfaces use their connected
server's adapters.

Saved question choices follow a fork's retained call IDs. Source history is
read before creating the fork. If the supplemental copy fails after creation,
the created session is published and the error names the surviving fork.
Deletion publishes every deleted native session even when supplemental cleanup
fails; `NATIVE_INTERACTION_CLEANUP_FAILED` explicitly reports the leftover
choice metadata. Neither failure can undo a completed native operation.
