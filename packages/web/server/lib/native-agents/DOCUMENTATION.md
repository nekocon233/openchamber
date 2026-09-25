# Native CLI sessions

## Purpose

Lets OpenChamber act as a frontend for the user's own Claude Code and Codex
CLIs. The CLI's session store is the only source of truth: this module reads
it, projects it into the Session, Message and Part records the shared UI
already renders, and never keeps a copy of the conversation. Native sessions
sit next to OpenCode sessions in the same projects and sidebar, but OpenCode
never sees them.

OpenChamber lists and reads both CLIs' sessions, creates sessions, and drives
turns: prompts, steering, stops, model and effort changes, plan mode and the
model's questions. Every tool runs without asking. Reverts, forks, rename,
archive, delete and compaction work the way they do for OpenCode sessions,
and the task lists of both CLIs show as todos.

## Wiring

- `server/index.js` creates the runtime with the data directory, the CLI
  resolver (`executables.js`), the child environment (`process.js`), the
  OpenChamber version, `publishNativeEvent` (the global hub) and the reader of
  the global AGENTS.md (`instructions.js`), routes the
  follow-up queue's startup existence check for native ids to
  `sessionExists`, and hands the runtime to shutdown.
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
| User message | `ncl_u_<entry uuid>` | the `ncx_u_<uuid>` id OpenChamber sent, else `ncx_u_<turn key>_<item id>` |
| Assistant message | `ncl_a_<sha16(session id)>_<API message id>` | `ncx_a_<turn key>_<turn or user item id>` |

Part ids derive from the same native keys (content block index, `tool_use`
id, Codex item id). Every id is deterministic, so a later live event and a
history reload name the same record, and every id passes the
`^[A-Za-z0-9_-]{4,128}$` check other OpenChamber routes apply.

## Listing

`GET /api/native/sessions?directory=` reports each backend separately:
`{ backends: { claude, codex } }`, each `{ status: 'ok', sessions }` or
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
- Tool names map onto the tools the UI knows (`Bash` to `bash`, `Edit` and
  `MultiEdit` to `edit`, Codex `commandExecution` to `bash`, `fileChange` to
  `apply_patch`, MCP tools to `<server>_<tool>`), with the file diff metadata
  the edit renderer reads. A Claude tool the UI does not know keeps its own
  name (`TaskCreate`), and its title is the first set input field among
  `subject`, `description`, `query`, `pattern`, `url` and the like, never the
  name again.

Claude gotchas:

- `getSessionMessages` drops `toolUseResult`, which holds the
  `structuredPatch` the edit diffs are built from. When a conversation used
  Edit, MultiEdit or Write, the store reads the raw transcript a second time
  through `importSessionToStore` into a throwaway store and keeps only the
  diff fields per entry uuid (the raw result also holds whole file
  contents). A failed second read costs the diffs, never the history.
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
  time, in an LRU bounded at 128 MiB of transcript. A 10 MB transcript with
  edits loads in about 160 ms cold, both reads included; later pages of the
  same transcript come from the cache.

Codex gotchas:

- History comes from `thread/turns/list { itemsView: 'full' }`; reading it
  does not resume the thread.
- A steer starts a new user message segment inside the same turn. Failed and
  interrupted turns carry an error on their assistant message.
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
  sources, `bypassPermissions` or `plan`, partial messages on. A new session
  starts with `sessionId`, one with a transcript resumes with `resume`.
- A prompt goes in with `priority: 'next'` and the uuid of the message id the
  UI sent, so a prompt sent mid-turn joins the turn at its next tool
  boundary. Model, effort (`applyFlagSettings({ effortLevel })`) and plan mode
  change in place.
- The projector's live mode opens the assistant message and its text and
  reasoning parts from stream events and completes the message on
  `message_stop`, because tools start while later blocks still stream. Only
  `assistant` and `user` frames and the `compact_boundary` system frame reach
  `applyEntry`. Subagent frames are left to the subagent's session;
  a Task call announces the subagent session with `session.created`.
- `canUseTool` answers `AskUserQuestion` from the question registry. The SDK
  still asks for this tool in `bypassPermissions` mode. `ExitPlanMode` creates
  a pending question with `kind: 'claude-plan-exit'`, including the plan when
  the CLI supplies it. Only the single answer `build` approves execution and
  returns a session-scoped `setMode: bypassPermissions` permission update.
  `plan`, dismissal, abort and query closure leave planning in place and stop
  the turn. A custom answer returns feedback so Claude can revise the plan.
  The shared UI translates the choices; their wire values remain `build` and
  `plan`. Calls without a `plan` input still project as `plan_exit` tools.
- A result frame with `queued_turn_count` 0 settles the turn. A stop is
  `terminal_reason` `aborted_*` and becomes the `MessageAbortedError`
  `{ message: 'aborted' }` the UI writes for turns it settles itself, with
  unfinished tools settled as `Interrupted`. The CLI's stop marker entries
  (`[Request interrupted by user]`) are not shown as user messages.
- A query idle for 5 minutes closes; the CLI exits and the next prompt resumes
  the session. At most 6 queries run; opening another closes the least
  recently used idle one and fails with `429 NATIVE_TOO_MANY_SESSIONS` when
  all are busy. A session's next query starts only after its previous query's
  process has exited, so two CLI processes never write one transcript. A
  closing query adds no live records to history reads.

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
- Fast: `model/list` names a model's service tiers, and a model with the
  `priority` tier (Codex calls it Fast) gets `fast: true` in the catalog. The
  UI then offers each effort again as `<effort>-fast`; `codexVariantSettings`
  (`catalog.js`) reads a variant back as its effort and whether it runs fast.
  A turn's `serviceTier` stays with the thread for later turns, and Codex's
  own settings may load a thread on Fast, so the live thread keeps the tier
  that `thread/start` and `thread/resume` report and sets `serviceTier` on
  `turn/start` only when the variant asks for another one: `priority`, or
  `default` to leave Fast. A variant without `-fast` never runs fast.
- Every `item/started` and `item/completed` re-projects the running turn with
  the history projector; agent text streams as deltas. The live turn owns each
  item's `startedAtMs` and `completedAtMs` (receipt time for older CLIs), so a
  finished patch exposes its output and a finished reasoning block stops
  streaming before the whole turn ends. Duplicate starts, events for another
  turn, and deltas after item completion cannot reopen or overwrite it.
  These timestamps leave memory with the turn; persisted history falls back
  to turn times because its items carry no timing. `turn/plan/updated` becomes
  `todo.updated`.
- Approval requests are accepted, `item/tool/requestUserInput` goes to the
  question registry, MCP elicitation is declined, and anything else is refused.

`questions.js` holds the questions running turns wait on, in memory only. A
reply or rejection resolves the CLI's pending callback and publishes
`question.replied` or `question.rejected`; stopping a turn or ending its query
rejects them.

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
Tools, reasoning, commentary and injected OpenChamber instructions are excluded.
A title is written through `thread/name/set` and announced as `session.updated`.
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
way the conversation shows the compaction marker, a user message with a
compaction part, and Claude's summary:

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
opened just to ask, which sends no prompt and leaves no transcript. Lists are
kept for 10 minutes per directory; a failed listing is not kept. Codex runs
its commands in its own terminal UI and lists none.

Todos: Claude Code keeps a session's task list as files under
`<config dir>/tasks/<session uuid>/`. After a TaskCreate or TaskUpdate result
the live session reads the list again, and a TodoWrite call carries the whole
list; either way it goes out as `todo.updated`, in order. Codex's plan updates
go out the same way (see Live turns).

## Registry

`<data dir>/native-agents/registry.json` holds only what the CLIs cannot
tell us: which sessions OpenChamber created or adopted (so they stay listed),
an archive flag for Claude (which has no archive), the model, effort and
agent of each OpenChamber send (at most 200 per session), the work-tree
snapshots of each OpenChamber prompt (at most 200 per session), the revert
in effect, and OpenChamber's own session metadata (btw and review links,
goals, the session assist's recap and suggestion), which OpenCode keeps in its
session metadata and a CLI has nowhere to keep. Session records carry that
metadata as OpenCode's do; `openchamber.native` is the server's and a client
cannot overwrite it. The PATCH route replaces it whole (at most 64 KiB), and
`setSessionAssist` writes the assist into it. Writing metadata adopts a
session the CLI created. A malformed snapshot, revert or metadata entry is
dropped on load; its session keeps its entry.

A session OpenChamber creates has no transcript until the CLI finishes a turn
in it. Until then `confirmedAt` is unset and the stores list and read it from
the registry. The first finished turn confirms it; from then on only the CLI's
store answers for it, so a session deleted in a terminal disappears here too.

A missing file is an empty registry. An unparseable file is moved aside as
`registry.json.corrupt-<timestamp>`, the registry starts empty, and
`capabilities().registry.reset` reports it. A read error throws, so no caller
mistakes it for "no sessions". Writes are serialized and atomic, and memory
changes only after a write succeeds.

## Utility text generation

`codex/utility.js` runs small-model calls on the shared app-server. These are
ephemeral threads with no registry entry or published chat events. The
small-model service accepts an explicit `codex-native/<model>` setting and
uses Codex's account and model catalog. The CLI owns credentials and refresh.
An unavailable selected model fails instead of silently choosing another one.

Each request creates its own thread and supplies only its prompt and system
instructions. Environment access is disabled, the sandbox is read-only, and
shell, MCP, apps, plugins, hooks and multi-agent tools are disabled for that
thread. Any server-requested tool action is refused before reaching the normal
chat approval handler. Structured output uses `turn/start.outputSchema`.
The output-token budget is a brevity instruction because the turn API has no
hard output-token limit.

Only completed assistant text is returned; commentary and unrelated threads
are ignored. Failed or empty output rejects. Abort and deadline handling
return promptly, then interrupt and unsubscribe the owned thread, including
when its start reply arrives after cancellation. App-server exit rejects all
pending utility calls without restarting the process for cleanup. Notification
routing does one thread lookup, with no scan of chat sessions.

Web and Electron call this server runtime. Hosted mobile and Capacitor use the
Codex installation on their connected server. VS Code retains the explicit
`small-model-runtime-unsupported` response.

## Child processes

- `executables.js` finds `claude` and `codex` on the login shell's PATH, then
  in the installers' default locations. A miss is looked up again on the next
  call, so a CLI installed while the server runs is picked up.
- On Windows, npm installs a CLI as a `.cmd` shim, which Node cannot start
  without a shell. A native `.exe` in the installers' folder wins over a shim
  on PATH. A Codex shim still runs, through `cmd.exe /d /s /c call` with its
  fixed arguments (`cliCommand`). A Claude shim is refused with
  `503 NATIVE_CLI_SHIM` before the Agent SDK starts it: the SDK would launch
  it without a shell, and its JSON arguments are not safe on a `cmd.exe`
  command line. This path is unit-tested only; no Windows host has run it.
- `buildCliChildEnv` passes the user's environment minus `OPENCHAMBER_*` and
  `OPENCODE_SERVER_*` (agents must not read OpenChamber credentials through
  `env`) and minus `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and
  `CLAUDE_CODE_SSE_PORT`, which would make a child believe it runs nested
  inside another Claude session.
- One `codex app-server --listen stdio://` process serves every Codex thread.
  It starts on first use and restarts on the next request after it exits,
  with start failures backing off up to 30 s. It never restarts in a loop of
  its own. A missing binary is `503 NATIVE_CLI_MISSING`.
- The app-server runs in its own process group on POSIX; stopping it sends
  SIGTERM to the group, then SIGKILL after 2.5 s. Windows uses `taskkill /T`.
- The Agent SDK starts and stops the Claude Code processes itself. A query
  closes by ending its input; its abort controller is the backstop five
  seconds later, and shutdown aborts every query at once.

## Routes (`/api/native`)

Normal authenticated OpenChamber routes. Every read takes the session's
`directory`.

| Route | Answer |
|---|---|
| `GET /capabilities` | `{ supported: true, backends: { claude: { cli }, codex: { cli } }, registry }` |
| `GET /catalog` | Models per backend; Codex from `model/list`, reported per backend like listing |
| `GET /sessions?directory=` | Root sessions per backend (see Listing) |
| `GET /sessions/status?directory=` | Sessions with a running turn, as busy; every other session is idle |
| `GET /questions?directory=` | Questions native sessions wait on |
| `GET /sessions/:id?directory=` | One session record, `404 NATIVE_SESSION_NOT_FOUND` when missing |
| `GET /sessions/:id/messages?directory=` | A history page (see History projection) |
| `POST /sessions` | `{ backend, directory, title? }`: a new session, announced with `session.created` |
| `POST /sessions/:id/prompt` | `{ directory, messageID, parts, model, variant?, agent, instructions? }`; answers once the CLI took it. A model of the other CLI is `409 NATIVE_BACKEND_MISMATCH` |
| `GET /commands?backend=&directory=` | `{ commands: [{ name, description, argumentHint }] }` (see Compaction, commands and todos) |
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
