# Antigravity CLI sessions

## Ownership and compatibility

This adapter drives the user's official Antigravity CLI (`agy`) through its
persistent headless `stream-json` protocol. The initial baseline is agy 1.1.15
or later. The CLI owns authentication, credentials, conversation state and
native mutations. OpenChamber starts the binary but never reads OAuth tokens or
calls Antigravity backend services directly.

The process and turn lifecycle follows Paseo's MIT-licensed
`plugins/antigravity-provider`. Native index and transcript reading follows the
MIT-licensed `lefos13/paseo-plugin-antigravity-cli`. OpenChamber keeps its own
failure, identity and record contracts instead of adopting either host's plugin
API.

Antigravity uses backend `antigravity`, provider `antigravity-native` and
`nag_<conversation uuid>` session IDs. It supports independent native sessions,
dynamic models, Build and Plan, streamed text and tools, native history, model and effort changes,
interruption and archive. It participates in unified `ncv_` conversations through
the parent conversation controller. Standalone revert, fork, manual compaction
and native deletion remain unsupported. Native mid-turn question
replies, mid-turn steering, Small Model and terminal memory hooks are
also unsupported. Server routes return `NATIVE_ANTIGRAVITY_UNSUPPORTED` or
the corresponding unified unsupported-operation error; UI capabilities keep
those actions closed. Unified rewind and fork retain logical history prefixes
and open a new source on the next prompt. Retained Antigravity history prevents
permanent deletion of the logical conversation; archive remains available.
Automatic compaction records in a native transcript remain readable.

## Process and trust

`process.js` starts one process per active session. Build uses:

```text
agy --input-format stream-json --output-format stream-json \
  --add-dir <cwd> --disable-slash-commands --print-timeout 0 \
  --mode accept-edits --dangerously-skip-permissions \
  [--model <slug>] [--effort <level>] [--conversation <uuid>]
```

Plan uses `--mode plan --disable-slash-commands=false` so the CLI expands its
native plan instruction. Both Build and Plan use
`--dangerously-skip-permissions` and automatically approve tool actions,
including file access outside the workspace, file changes, shell commands,
MCP tools and browser actions. Plan selects the native planning workflow and
has full tool permissions. Session discovery requests no mode or full-access
override before the first prompt.

When a session selects an OpenChamber-managed subagent, `mcp-setup.js`
registers `openchamber_subagents` in `~/.gemini/config/mcp_config.json` and the
`openchamber-delegation` hook in `hooks.json`. Both entries contain only helper
paths and timeouts. Existing JSONC comments and unrelated entries are retained;
malformed files or reserved-name collisions fail setup before dispatch. If
the hook write fails, the matching MCP registration is rolled back.

Only an owned CLI's process environment supplies the private callback token.
With it, PreToolUse denies `invoke_subagent` and `define_subagent`, routing tasks
through the selected delegate tool. A leaf exposes no delegate tool. Without
the token, ordinary CLI launches see no managed tools and the hook allows
native delegation. Account, model routing and permission settings are unchanged.
Antigravity does not accept these policies in per-session settings, so the
adapter uses its native managed MCP and hook files.

The installed-CLI conformance suite covers the full-access launch contract.
An older CLI that rejects these flags fails the request; it never falls back
to Build. The shared native child environment removes the server's `NODE_ENV`, so
project tests do not inherit the web server's production mode.

`command.js` starts agy the way the user's interactive shell does when the
shell defines an `agy` function, for example magpie's wrapper that supplies
`GEMINI_API_KEY` and `GOOGLE_GEMINI_BASE_URL`. It checks `type -t agy` with
`bash` or `zsh -ic` and then runs `agy "$@"` through the same shell, passing
arguments as positional parameters. Model discovery, new sessions and prompts
use that command. Quota reads use the direct executable and the native backend
as described in Quota below. Detection failure, a non-function command, fish and
Windows keep the direct executable. The function is detected once per backend
lifetime; a changed shell profile is picked up after the server restarts.
OpenChamber never reads or logs the wrapper's environment.

Headless agy rejects `control_request` and `control_response` messages. There
is no interactive permission or question reply channel. Skipped native questions
stay in history. The application collects answers after the completed turn and
sends a new user message in the same conversation. The hidden headless-session
instructions ask the agent to call `ask_question` and end its response after a
skipped result. A finished plan uses one single-select question prefixed with
`<openchamber-plan-v1>\n`, containing the complete plan and the exact `build` /
`plan` options. Skipping it grants no approval. These instructions also describe native background notifications so
the agent can avoid status-polling loops. These instructions are not permission
enforcement; the CLI's full-access launch flags own tool permissions.
An Ask permission can stop a headless turn with `SUCCESS`, an empty response
and `denied_actions`. The adapter reports that combination as a permission
failure, never a user stop or successful completion. A native final response
or a nonempty result remains valid when a denied action did not prevent an
answer. The bounded send registry retains only the denied action names and
completion time, bound to the accepted client message. History restores that
cause without copying tool output or inferring live activity. A later complete
native final response takes precedence. No prompt is replayed and no permission
is granted automatically. A failed diagnostic write still settles the live
turn and reports that its details could not be saved.

The Settings page describes both modes. Installation and login remain
user actions in the official CLI on the server machine.

Startup waits for `init` with a 30-second deadline and validates a resumed
conversation ID. Each turn binds its process. Late frames from an older process
cannot settle or modify a newer turn. Prompt admission is serialized per
session; a second turn while one runs returns `NATIVE_SESSION_BUSY`. Prompts
are serialized even on the first restore after a server restart. Completion,
abort and event failures retain their turn/process owner; a delayed publication
cannot stop a newer turn, clear its cancellation flag or resolve its idle wait.
Concurrent completion paths share the same settlement promise. Invalid prompt
parts are refused before starting a replacement CLI, and failed admission
retains idle-process cleanup. Prompts
are never replayed automatically. Models, modes and efforts change by closing the idle process
and resuming the same conversation on the next prompt. Idle processes close
after five minutes. The unified controller also closes an idle source before
switching backend, so agy does not remain running until that timeout. Startup
errors before a prompt write are definite refusals that allow unified admission
to roll back. Errors after a write is attempted remain unknown until history
confirms delivery.

POSIX interruption sends SIGINT to the process group, then SIGTERM and SIGKILL
as fallbacks. Windows terminates the tree. Process completion waits for stdio
to drain before settling the turn. `result.usage` is cumulative over the
process and is not added to message usage. DONE generation steps own the
per-message measurement. Both nested `usage` and top-level transcript token
fields are read. The final native planner step identifies a result's message
when its streaming frame was lost. Final text corrects a partial stream without
duplicating its prefix or replacing earlier commentary. A complete final
transcript step supplies that text: the stream result can concatenate earlier
progress messages. A truncated final step keeps the live result instead.
At turn completion, history fills records and tool parts absent from the
stream, including skipped `ask_question` calls. Their native outcomes remain
unchanged; separate application question/plan parts carry human decisions.
Saved per-message token counters also fill live records whose generation
frames omitted usage. agy's output includes thinking; the shared projection
subtracts thinking from output before exposing the separate reasoning counter.
Inconsistent thinking/output counters remain unavailable. Existing live counters
and text timing remain intact;
absent saved usage stays unknown. Only changed records are republished, so
the loaded-turn average can recover without a page reload. A tool first seen
in a completed frame allocates its start before its end to keep its interval
valid for turn timing.
Native generation starts refine live message creation times when the stream
arrived later. Accepted user sends retain their admission time, and ordered
steps in one native second shift tool intervals together to preserve duration.
Recovered tools therefore stay within their owning generation's window.
`measurements.js` saves stream-only counters, completion times and part intervals
with the accepted send. It stores IDs and text hashes, without text, inputs or
outputs. Native parent/message identity and compatible usage gate restoration;
text timing also requires a matching content hash. Changed native data remains
authoritative. Invalid optional measurements fall back to native history without
discarding the send. The existing 200-send registry bound applies. A failed
measurement write does not discard the live result and follows completion-write
failure handling.
Post-turn application question and plan parts carry
`openchamberToolSource: 'native-interaction'`; they are UI decisions and contribute
no model tool time. Native `ask_question` calls retain their execution timing.
Complete saved arguments also fill partial tool frames (denials can carry only
a path), without replacing a known live error. Truncated saved arguments cannot
replace live input. Completed checkpoints supply their full summary and settle
stream placeholders; a missing completion does not leave a running spinner
after the turn has ended.
The known `ERROR` results for `stream was interrupted` and the output-token-limit
continuation instruction can remain after agy has completed its own recovery,
including on a subsequent turn without another saved error step. They recover
only against a complete final native planner step bound to the current user
step. A later user step, incomplete transcript, failed final step, truncated
text/error/tool calls or outstanding tool call prevents recovery. Explicit stops
and other errors remain failures even when the log contains assistant text.
The successful completion is saved before publishing recovered questions; native
error steps remain in the transcript. Unfinished tool frames do not become
successful empty outputs; a later durable completion can replace that unknown
result, including on a history read. Prompts are never resent to repair a stream.

`catalog()` checks `agy --version` and reads tab-separated
`agy --settings '{"customModelsConfig":{"customModels":{}}}' models`.
This discovery-only override lists official built-in models and hides every
custom model, including Magpie entries and custom IDs without a namespace.
agy applies these settings to that invocation only. Saved configuration and
prompt routing remain unchanged; a previously selected custom ID can still
resume its native session. No model-family or provider-prefix allowlist is used.
`catalog.js` groups concrete slugs into one model when both the slug and label
name the same effort. The descriptor exposes only the listed efforts, in
low/medium/high/xhigh/max order. A model with only one listed effort has a fixed
budget and exposes no effort control, as confirmed by `agy --print /effort`.
Concrete slugs remain in `aliases` with their implied effort, so older saved
selections and favorites still resolve to the family. The CLI continues to
accept those slugs. New choices send the family id with a separate `variant`,
which becomes `--effort`; unsupported levels fail during native startup before
the prompt is sent. With an explicit effort, the adapter translates a known
old slug to its family before launch: agy rejects conflicting slug/flag pairs.
Registry records retain the original selected id and explicit effort.
The adapter retains alias mappings from its last successful catalog, scoped
to that backend instance and bounded by the discovery output limit. A refresh
replaces them; a failed read preserves them. The usual catalog path still makes
two CLI calls. A cold direct prompt using an old slug with an explicit effort
reads the catalog once before admission if discovery has not happened yet.
Canonical ids and prompts without an explicit effort need no extra discovery.

Output limits and non-text input are unknown and therefore not advertised. Images are
refused before native input; text files and file references follow the shared
prompt-parts conversion. Authentication failure is reported separately as
`reason: 'unauthenticated'` in the native catalog partition.

### Why all catalog models use a 1M context window

Every catalog model uses the maintainer-selected 1,000,000-token capacity for
shared usage readings and unified handoff budgets, because `agy models` does
not report limits. Built-in models and native Google login retain the CLI's
own capacity. In Gemini API mode, OpenChamber also applies a 1,000,000-token
budget to the selected and saved-default custom model definitions, identified
by their key or label. Other custom model budgets and all routes stay intact.
Automatic compaction remains under the CLI's control.

### Why API context budgets use process-local settings

An external catalog manager can replace custom model definitions and omit
AGY's `maxTokens` field. Each prompt admission reads the current definitions
and creates an owner-only temporary settings file for the CLI's `--settings`
override. This changes no global CLI settings or external application code.
Only custom model definitions go into the file; permission and authentication
settings remain with the CLI. The model, effort and full-access launch flags
are unchanged. A semantically unchanged override reuses the idle process;
changed definitions retire it before the next prompt so routes stay current.
Process exit, failed startup and discarded candidates remove their files.
Invalid or unreadable settings refuse admission before any prompt is sent.

## Identity, history and live state

`store.js` opens `~/.gemini/antigravity-cli/conversation_summaries.db` read-only
through Node's built-in SQLite module. Readers allow up to one second for the
CLI's concurrent index writes to release their lock; a persistent lock remains
an error. Root rows are filtered by workspace and
`parent_conversation_id = ''`. Histories prefer
`brain/<conversation uuid>/.system_generated/logs/transcript_full.jsonl`.
The adjacent `transcript.jsonl` is a shortened preview. It supplies missing
steps while the full log is being appended and supports older CLI versions
that only retain the preview. Complete full records win by native step index;
malformed records mark history incomplete, and read failures remain errors.
Preview argument strings are JSON-encoded, while full logs and stream
parameters already contain native values. The file source selects decoding,
so literal text such as `true`, `null`, JSON and quoted strings stays text.
No conversation copy is written into OpenChamber storage. A missing index or
transcript for a confirmed session is an error, never an empty success. A new
registry-only session may legitimately have no transcript yet. One unreadable
summary row does not hide valid sibling rows.

Child reads follow `parent_conversation_id` to the root workspace, with cycle
and nesting-depth checks. They keep `nag_<uuid>` identities and their immediate
`parentID`, and appear in `childSessions`, outside the root list. A child's
worktree does not move it out of its parent's UI directory. Child transcripts
are selected by validated native IDs, never by a supplied `log_uri`. Children
are read-only and inherit their root's archive state.

`subagents.js` establishes ownership through live `subagent_info` and routes
only that process's known child events. Multiple and nested children publish
through the shared native events. `activityKnown: false` keeps an unobserved
child from being called completed by an idle directory snapshot. A parent
result does not establish a child's completion. Unsettled children become
unknown when observation ends; partial live copies then stop overriding native
history. Process exit releases child projections. Token events update only the
current projection; completed-turn records are merged on read.

`projector.js` shares deterministic native step identities between live frames
and history. `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` and `CHECKPOINT` map to
user, assistant, tool and compaction records. Tool results join their planner
step by index. Instructions injected by OpenChamber are hidden in both paths,
including when `agy` truncates a large `USER_INPUT` step across its closing
`</openchamber-instructions>` or `</USER_REQUEST>` tags.
Nonempty `PLANNER_RESPONSE.thinking` becomes a reasoning part before text and
tools, with a stable native-step ID. A `thinking` truncation marker survives as
`nativeOutputTruncated`. The installed CLI's `stream-json` agent responses
expose text deltas without thinking fields. Completed-turn history recovery
remains the final fallback. During a running turn, completed native generation
snapshots supply reasoning after an agent-response DONE frame and once after
its first finished tool, covering transcript writes that lag the response
frame. History reads also enrich observed live generations so the live overlay
cannot hide saved thinking. These updates change only reasoning parts; running
tools and session activity remain owned by the live stream. Complete thinking
replaces shortened snapshots, and repeated reads publish no duplicate parts.
Running reasoning inserts also publish the existing message-parts snapshot event so
clients place reasoning before text and tools immediately. Unified projection
maps every snapshot part into the same logical identities as history.
Completed-history recovery keeps individual part updates because the interaction
layer may own additional answered plan parts outside the native projection.
Child completion uses the same recovery before publishing idle, including when
the result arrives without any child update frames. Saved parent tasks restore
their users' text and timestamps and their replies' parentage, keeping each
assignment before its recovered generation.

Conversation `SYSTEM_MESSAGE` envelopes expose only validated UUID senders.
The native index's immediate `parent_conversation_id` relationship determines
whether a sender is the parent or a direct child. Parent messages become user
tasks in the child transcript; the initial task retains the live context user
ID. Direct-child reports become ordinary assistant text with
`nativeSubagentMessage` and `nativeSubagentSessionID` metadata. Completed-turn
recovery publishes reports omitted by the stream. Long native messages can
omit the envelope's closing tag; the validated header still supplies their
sender and complete retained body. System notices, background
task notifications and unrelated senders stay hidden. A partial child index
retains readable records, marks metadata incomplete and grants no ownership to
unreadable rows. Visible tasks and reports participate in unified handoffs;
reasoning stays with the source CLI.

### Why child recovery covers every saved task

Parent assignments are retained as system messages and may arrive without a
new user-input frame. A completed child observation therefore recovers its
whole saved history and task boundaries. Foreground turns retain their own
accepted-send boundary so one completion cannot publish another user turn.
The last complete visible reply supplies the final step identity before child
settlement. A result without preceding update frames therefore cannot overwrite
an earlier progress reply; unreadable history retains the stream result fallback.

### Why running reasoning reads follow completed steps

The stream omits thinking even when the transcript already contains it. A
generation completion and its first tool completion each allow one transcript
read; token deltas and idle time read nothing. Only DONE planner snapshots can
enrich already observed generations, so a history read neither invents a live
message nor settles a running tool.

Malformed complete lines and unknown step types mark history incomplete;
unterminated trailing writes are not treated as corruption.
Native `truncated_fields` markers survive in assistant text and tool metadata,
so the UI distinguishes shortened saved output from automatic compaction.
Tool-level truncation markers also survive even when the full transcript has
no `truncated_fields` entry. Text absent from both native logs stays truncated.

Background `run_command` results join their original tool step through the
native task id in `SYSTEM_MESSAGE` completion notifications. Only matching
conversation and task ids can complete the tool; a saved `RUNNING` row without
a completion has an unrecorded outcome, never proof of live activity. Native
tool errors, `INVALID` results and nonzero command exit codes remain errors in
historical records. Live tool errors retain the native error field. `tools.js`
maps native read/edit/write/command arguments
to the shared tool cards, including file paths and replacement text.

Completed edits carry replacement excerpts as `files`/`diff`, marked
`nativeDiffScope: 'replacement'`. Their line numbers are relative to the
excerpt, so the UI suppresses file-line navigation and full-file change counts.
Failed or truncated inputs supply no successful edit preview. Multiple
replacement chunks retain separate excerpts. Read ranges become the shared
one-based offset and inclusive limit; web searches retain their query. Native
MCP `call_mcp_tool` wrappers preserve server/tool identity, arguments and MCP
provenance. Tool metadata carries `nativeBackend: 'antigravity'`, including
after logical conversation projection.

### Conversation checklist

`checklist-mcp.mjs` is a stateless local stdio helper with no network or file
operations. `mcp-setup.js` registers `openchamber_checklist` in the CLI's global
MCP configuration, preserving JSONC comments and unrelated entries. A reserved
name collision, including a workspace override, fails before prompt admission.
Only the managed CLI's process environment enables `update_checklist`; ordinary
terminal launches expose no tools. Checklist setup leaves delegation and
permission hooks unchanged. A missing system Node leaves the checklist
capability unavailable while ordinary chat remains usable.

The tool replaces a complete `todos` list of stable IDs, content and
`pending`/`in_progress`/`completed` states, bounded at 2,000 entries and 256 KiB.
It validates input and returns a versioned digest receipt. The CLI's completed
tool record owns the list, including an explicit empty write. No checklist text
is copied into the registry or another task database. Only a matching server,
tool, complete input and receipt can commit a snapshot. Failed calls retain the
previous list. Incomplete history remains partial or throws when no valid list
can be recovered; absence of a call is `source_unknown`, never an inferred
empty list. `manage_task` continues to describe background commands.

`checklist.js` owns live/history interpretation. Native step indexes order
revisions; successful live tool completion publishes the existing
`session.checklist.updated` event. Reads, reconnect and turn completion recover
retained history without starting a CLI. The UI refreshes on open and manual
request, without idle polling. Child lists belong to their own native IDs.
Unified reads and events carry logical list identities; rewind and frozen fork
reads honor their retained prefix, and inactive source events stay excluded.

### Why the checklist stays in the CLI transcript

A stateless MCP receipt makes the CLI's accepted tool record sufficient for
live updates and restart recovery. A second persisted checklist would require
ordering and rollback between two stores and could outlive a rewound history.

### Why the executable and protocol are separate

The host imports only `checklist-protocol.mjs`. Bundlers can collapse module
URLs into their entrypoint, so an executable's URL guard cannot reliably keep
stdio listeners out of a bundled host. Electron bundles the helper separately.

### Why replacements are excerpts

The CLI records target and replacement text without the original file position
or complete previous file. Comparing those fragments preserves the recorded
edit; reading today's file would invent a historical diff and coordinates.

`tasks.js` also projects saved commands through the existing task-view API.
API task ids use `<conversation>_task-<step>` so they remain a single route
segment; native notification matching still uses `<conversation>/task-<step>`.
A `history` snapshot has no active or stoppable tasks: recorded exit codes own
completed/failed outcomes and an absent completion stays unknown. At most 200
recent tasks are returned, with an omitted count. Task output reads only the
matching conversation's derived `tasks/task-N.log`, never a supplied log URI,
and returns the last 256 KiB with a truncation flag. Missing log files can use
the retained native result; unreadable files stay unavailable. Turn completion
publishes `session.tasks.updated`; views also refresh manually or on reconnect,
without idle polling. There is no independent task-stop protocol, so Stop
remains unavailable for individual saved tasks.

agy does not retain OpenChamber's client message ID. Registry send records
therefore carry an optional bounded `stepIndex` and prompt fingerprint. A live
`user_input` step authoritatively binds the accepted client ID. Fingerprint
matching is only a recovery path after interrupted admission. External terminal
prompts receive deterministic native step IDs. Registry writes remain serial
and atomic, and rebinding one message to another step is refused.

The CLI can prepend `/plan` to saved user input in Plan mode. Display removes
one such prefix only for a registered Plan send whose original fingerprint
matches the remaining text. Typed prefixes, external prompts and mismatches
remain intact. Interrupted admission recovery tries the exact fingerprint
first, then a Plan-only prefix match. The saved transcript and native mode
are unchanged.

The registry also owns archive and title overrides. Deletion is not simulated:
hiding a native conversation in OpenChamber while leaving it in agy would make
`deleted: true` false, so deletion remains unsupported.

## Operations and runtimes

`interaction-signals.js` validates complete structured calls.
`interaction-proposals.js` groups skipped questions in the latest completed
application turn. Unanswered questions take priority over a plan from that turn.
Only a successful saved turn with a complete final planner response can open a
new request. A legacy `implementation_plan.md` write with explicit user-facing
feedback metadata can supply its complete draft on a history read; a denied
write remains an error and grants no file access. Ordinary assistant prose,
truncated arguments, native answers and incomplete/error/aborted turns never
create approvals. Child sessions remain read-only.

### Why unanswered native questions accept blank numbered answers

AGY 1.5.2 can save an unanswered headless question as `A1: ` instead of
`A1: User Skipped`. Both formats recover application questions and plans only
when every expected answer is present, numbered in order and unanswered.
Successful application completion and complete native history remain required;
recovery opens a decision and never approves implementation.

### Why plan marker cleanup follows identity generation

Application plan text omits an optional final `</openchamber-plan-v1>` line,
and an empty result cannot become a proposal. Revision hashes still use the
original signal before cleanup so pending and answered decisions retain their
identity across reloads; native transcripts stay unchanged.

`decisions.js` owns request identity, reply delivery and recovery. The registry
stores source call ID, user step, revision, request ID and open/dispatching/settled
state without copying the plan or question body. Reconnect reads only already
marked sessions; opening history can recover a legacy proposal. The source is
revalidated before every reply. Exact `build` approval sends a new Build prompt
with the approved plan bound in hidden instructions and no visible user text.
Question answers and custom plan feedback also travel in hidden instructions;
their visible selections belong to the question card. Each continuation retains
its user record for selection and assistant parentage, without adding an automatic
message bubble. The send registry records reply provenance by the decision's
exact client message ID, including legacy replies still identified by durable
decision state. It never hides ordinary messages by matching their text.
`plan` closes the card
without a new prompt. Custom plan feedback starts a Plan prompt. Ordinary
answers retain the original agent, model and effort. Manual prompts, Stop and
archive invalidate the old decision. Goal continuations wait for pending
decisions, including durable decisions after restart.

Human choices are saved before dispatch. A definite pre-send failure keeps the
card retryable. An accepted or uncertain send keeps its durable dispatch marker,
withdraws the card and reports that the conversation must be checked; restart
never replays it. Shutdown withdraws callbacks without recording user rejection,
so an open request returns with the same ID. Native history owns the original
tool results, while `interactions.js` restores application choices on the
separate parts across later turns and reloads.

Web and Electron use this server adapter. Hosted mobile and Capacitor use the
connected server through existing native HTTP and events. VS Code retains its
explicit unsupported native API. There is no agy-specific RuntimeAPI, bridge,
Small Model runtime, memory hook or Electron helper.

Global AGENTS.md is injected into the first prompt of each agy process and
hidden from the transcript projection. Feature instructions use the existing
`<openchamber-instructions>` block. Unified creation and source ownership follow
the parent conversation controller.

## Execution model on plan approval

A plan approval may transfer to the shared execution owner when the selected
model differs from the proposal's captured model. The native AGY decision is
settled without starting its own continuation. The shared owner keeps the human
choice and delivery identity, then uses normal admission for the selected model.
The parent native module's Plan execution model selection section owns recovery
and uncertain-delivery behavior. Native skipped question outcomes remain intact.

## Quota

`quota.js` serves the distinct `antigravity-cli` source through the existing
`GET /api/quota/:providerId` route. It starts the resolved agy executable
directly, bypassing shell wrappers that can inject gateway model arguments.
The command uses `--settings '{"modelProvider":"","model":""}'` with
`--disable-slash-commands=false --print /usage --print-timeout 10s` to read
the current CLI login's native quota. These settings apply only to that
process; saved settings and chat routing are unchanged. The tab-separated
report invokes no model and never enters a chat's stream. Concurrent readers
share one bounded probe.
Malformed output and CLI failures remain errors; the UI retains prior data.
Gemini and Claude/GPT keep separate five-hour and weekly windows and reset times.
The original `antigravity` tracker still belongs to the OpenCode plugin account.
VS Code explicitly reports this native quota as unsupported. The CLI report
was verified with agy 1.4.12. CLIs that cannot apply the session settings or
answer the command report the error without retrying through a gateway.

## Validation

`backend.test.js` starts a real fake-agy Node child that writes a SQLite index
and JSONL transcript. It covers model discovery, live/history agreement, stable
client IDs, tools, model changes, busy refusal, interruption, sticky stream
errors and unsupported inputs. `store.test.js` covers malformed history,
fingerprint recovery, missing transcripts and workspace filtering.
`runtime.test.js` covers runtime registration, archive, capabilities,
authentication and unsupported operations. These fixtures make no model or
network calls and do not prove real subscription, Windows, Relay or packaged
Electron behavior.

The installed-CLI conformance suite is opt-in because it uses the user's login
and quota. It uses a new temporary workspace, verifies successful edits
and commands in Plan, switches to Build, checks `NODE_ENV`, restarts the
adapter, resumes Plan, and checks saved mode identity and quota. On POSIX it
also interrupts a real Node command, verifies its delayed write never occurs,
and continues the same conversation in Plan. The cross-workspace read check also
creates and removes a private fixture directory under the user's home. Temp
paths are implicitly readable, so this private fixture verifies access to a
path that would otherwise require approval. It reads no existing user files:

```sh
OPENCHAMBER_AGY_LIVE_TEST=1 OPENCHAMBER_AGY_LIVE_MODEL=gemini-3.8-flash-medium \
  bun run --cwd packages/web test server/lib/native-agents/antigravity/live.test.js
```

Choose an installed model from `agy models`. Fixtures cover unsupported control
paths, malformed history, missing output, error preservation and child event
ownership; they do not substitute for the opt-in CLI checks. Protocol references:
[headless](https://antigravity.google/docs/cli/headless/),
[modes](https://antigravity.google/docs/cli/modes), and
[permissions](https://antigravity.google/docs/permissions?tab=cli).
