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
interruption and archive. Unified `ncv_` conversations, revert, fork, manual
compaction and native deletion are unsupported. Native mid-turn question
replies, mid-turn steering, Small Model and terminal memory hooks are
also unsupported. Server routes return `NATIVE_ANTIGRAVITY_UNSUPPORTED` or
`NATIVE_ANTIGRAVITY_UNIFIED_UNSUPPORTED`; UI capabilities keep those actions
closed. Automatic compaction records in a native transcript remain readable.

## Process and trust

`process.js` starts one process per active session. Build uses:

```text
agy --input-format stream-json --output-format stream-json \
  --add-dir <cwd> --disable-slash-commands --print-timeout 0 \
  --mode accept-edits --dangerously-skip-permissions \
  [--model <slug>] [--effort <level>] [--conversation <uuid>]
```

Plan uses `--mode plan --disable-slash-commands=false` so the CLI expands its
native plan instruction. It never uses `--dangerously-skip-permissions`.
Session-only `--settings` select `toolPermission: request-review` and deny
`write_file(*)`, `command(*)`, `mcp(*)` and `execute_url(*)`. Native read/search
tools remain available; shell commands are blocked even when they would only
read. These settings do not change the user's saved CLI configuration. Session
discovery requests no mode or full-access override before the first prompt.

The CLI's plan prefix alone is not a write boundary: its documented permission
overrides apply across modes. This launch contract is verified on agy 1.4.11.
An older CLI that rejects these flags fails the request; it never falls back to
Build. The shared native child environment removes the server's `NODE_ENV`, so
project tests do not inherit the web server's production mode.

Headless agy rejects `control_request` and `control_response` messages. There
is no interactive permission or question reply channel. Skipped native questions
stay in history. The application collects answers after the completed turn and
sends a new user message in the same conversation. The hidden headless-session
instructions ask the agent to call `ask_question` and end its response after a
skipped result. A finished plan uses one single-select question prefixed with
`<openchamber-plan-v1>\n`, containing the complete plan and the exact `build` /
`plan` options. Skipping it grants no approval. These instructions also describe native background notifications so
the agent can avoid status-polling loops. These instructions are not permission
enforcement; Plan's native deny rules own write protection.
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
after five minutes.

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
Complete saved arguments also fill partial tool frames (denials can carry only
a path), without replacing a known live error. Truncated saved arguments cannot
replace live input. Completed checkpoints supply their full summary and settle
stream placeholders; a missing completion does not leave a running spinner
after the turn has ended.
Only the known `ERROR` / `stream was interrupted` result is recovered against
a complete final native planner step. Other errors remain failures even when
the log contains partial assistant text. Unfinished tool frames do not become
successful empty outputs; a later durable completion can replace that unknown
result, including on a history read. Prompts are never resent to repair a stream.

`catalog()` checks `agy --version` and reads tab-separated `agy models`.
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

Model limits and non-text input are unknown and therefore not advertised. Images are
refused before native input; text files and file references follow the shared
prompt-parts conversion. Authentication failure is reported separately as
`reason: 'unauthenticated'` in the native catalog partition.

## Identity, history and live state

`store.js` opens `~/.gemini/antigravity-cli/conversation_summaries.db` read-only
through Node's built-in SQLite module. Root rows are filtered by workspace and
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
step by index. Instructions injected by OpenChamber are hidden in both paths.
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
tool errors and nonzero command exit codes remain errors in both live and
historical records. `tools.js` maps native read/edit/write/command arguments
to the shared tool cards, including file paths and replacement text.

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

`decisions.js` owns request identity, reply delivery and recovery. The registry
stores source call ID, user step, revision, request ID and open/dispatching/settled
state without copying the plan or question body. Reconnect reads only already
marked sessions; opening history can recover a legacy proposal. The source is
revalidated before every reply. Exact `build` approval sends a new Build prompt
with the approved plan bound in hidden instructions; `plan` closes the card
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
`<openchamber-instructions>` block. Unified conversation creation explicitly
rejects agy; existing unified manifests remain unchanged.

## Quota

`quota.js` serves the distinct `antigravity-cli` source through the existing
`GET /api/quota/:providerId` route. It runs a separate
`agy --disable-slash-commands=false --print /usage --print-timeout 10s`
process and parses the CLI's tab-separated report. This invokes no model and
never enters a chat's stream. Concurrent readers share one bounded probe.
Malformed output and CLI failures remain errors; the UI retains prior data.
Gemini and Claude/GPT keep separate five-hour and weekly windows and reset times.
The original `antigravity` tracker still belongs to the OpenCode plugin account.
Neither source represents a CLIProxyAPI account, which has its own OAuth login.
VS Code explicitly reports this native quota as unsupported. The CLI report
was verified with agy 1.4.11; older CLIs that cannot answer it report the error.

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
and quota. It works only in a new temporary directory, verifies denied writes
and commands in Plan, switches to Build, checks `NODE_ENV`, restarts the
adapter, resumes Plan, and checks saved mode identity and quota. On POSIX it
also interrupts a real Node command, verifies its delayed write never occurs,
and continues the same conversation in Plan. The permission-denial check also
creates and removes a private fixture directory under the user's home: temp
paths are implicitly readable, so they cannot exercise an out-of-workspace Ask.
It reads no existing user files:

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
