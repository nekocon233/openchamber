# DeepSeek Harness sessions

## Ownership and compatibility

This adapter drives the user's `dsh --profile web` through its Web Remote API.
The initial baseline is the published `@deepseek-ai/dsh` 0.2.0-rc.2 distribution
and Session format 4. SDK stdio lacks cancellation; ACP omits history replay
and interactive questions.

DSH owns configuration, credentials, logs and native mutations. OpenChamber's
existing native registry stores identities and integration metadata. The
adapter can install a pinned DSH CLI in an instance-owned directory when an
authenticated user clicks one-click setup. Clients edit the active DSH
profile's provider settings through the official configuration API.
Shared memory is available for OpenChamber-managed sessions. Independent DSH
terminal hook enrollment, utility models, scheduled-task execution and native
child-session browsing/question cards remain unsupported for this backend.
Unaddressable interactive requests are declined rather than left waiting.

`transport.js` owns the process, authentication and stream mux. `protocol.js`
parses the wire contracts. `projector.js` folds live/history records.
`backend.js` owns session operations, stream lifetimes and question delivery.
`checklist.js` projects committed `todo/write` events into the shared read-only
checklist contract. The latest whole list remains visible across turns,
including after DSH resets its per-turn `todos` projection to null. An explicit
empty write clears it; no write is unknown, and malformed data or failed reads
remain errors. The reader pages backwards under one fixed sequence watermark,
honors pending rewinds and rejects a changed branch or mutation during reads.
Item identities follow native content, while list identities follow the native
source. Live writes publish `session.checklist.updated` through the existing
conversation bridge. Invalid lists report an error without publishing emptiness.
`configuration.js` owns the remote provider editor and its partial-save contract.
`installation.js` owns managed npm installation and executable discovery;
`setup.js` owns the user-triggered setup job. `history.js` owns branch identity
segments and cursor compatibility. `maintenance.js` owns private maintenance
launches; its plugin observes the owned Host over inherited fd 3, and its Node
worker owns locked native artifact deletion and transaction recovery.

## Process and trust

The login-shell CLI resolver finds `dsh`, falling back to the managed installation.
The first backend request starts one
owned process with `--profile web --no-open --host 127.0.0.1 --port 0`, inheriting
the scrubbed CLI environment and `DSH_HOME`. The adapter exchanges the announced
launch token at the loopback root for a cookie through DSH's 303 redirect,
then authenticates HTTP and `/api/remote.mux` with that cookie and origin.
Other child output is discarded. Tokens and cookies remain in server memory.
Windows npm launchers resolve the installed package's declared Node entry and
run it directly through the user's Node executable, avoiding a batch shell.
This path is unit-tested; console visibility and packaging need a Windows host.

Enterprise mode refuses startup and every request. A policy change observed
with an existing process closes it. Process loss rejects requests and stream
openings, withdraws questions and settles local activity. Only a later request
starts another process. The event WebSocket has a separate lifetime. Losing it
or ending its `$events` stream rejects its streams, withdraws questions and
invalidates live observations, while the owned process and in-flight HTTP
prompt admission remain alive.
Demand reconnects through one shared connection attempt, reusing the private
cookie and origin. Reuse requires both an open socket and its `$events` ready
frame. Old connection callbacks cannot affect a newer connection.

A missing first frame retires the entire event connection and triggers one
bounded reconnect attempt. A missing upgrade or ready frame ends that attempt
without another automatic retry; later demand may try again. The failed read
still reports failure, and the next read establishes fresh history and global
subscriptions. Prompt submissions are never replayed by connection recovery.
Shutdown terminates the owned process tree alongside the other CLIs.
An external writer produces `NATIVE_DEEPSEEK_WRITER_HELD`;
the adapter never takes over that writer.

## Identity, history and live state

Session creation defers native-added announcements until the owning runtime's
`beforePublish` callback has durably registered any unified-conversation owner.
Root listing waits for that creation boundary, preventing internal execution
sources from appearing as separate sidebar conversations. The callback changes
no native protocol or credential behavior.

Sessions initially use `ndh_<sha256(native id)>`. Opaque DSH identities resolve
from the header list or registry. A managed rewind keeps that logical id while
`deepseekHistory` in the registry binds it to an active native fork. Other
internal branches do not become duplicate sidebar sessions. User-created forks
keep independent logical identities. No conversation is copied into the registry. Root listing filters by the authoritative cwd and
excludes `origin: subagent`. Backend failures preserve the other partitions.

Client request ids include the session key and a UUID. DSH persists the id in
`source.rpcId`, reconciling the optimistic message. Fork-inherited request ids
receive child-scoped message ids. Assistant ids include session, turn and step;
tool call ids preserve native correlation.
User text/file parts use the shared `_pN`/`_fN` identities, so native echoes
replace optimistic parts instead of appending duplicate content.
An admission response lost after dispatch reports `NATIVE_PROMPT_OUTCOME_UNKNOWN`.
Shared send recovery confirms history and retains the same idempotent request
id. Explicit CLI refusals remain definite failures. Cancelled continuations
are checked again before prompt admission.

Following opens before paging. DeepSeek's `cursor` is an opaque event-position
cursor scoped to the session, unlike the older backends' message-id cursors.
It survives process restart and follower eviction without storing a second
conversation. Versioned cursors identify their native branch: an ancestor cursor
works only inside the prefix the active branch retained. Existing unversioned
cursors refer to the original branch. Pages use the follow watermark and DSH's turn-aligned reads.

Live chunks are ordered by attempt and dense index. A committed assistant is
staged until the remaining chunks drain, then replaces the live record under
the same ids. A retry discards the earlier visible prefix. Unknown usage and
cost remain absent. Compaction events produce shared compaction records:
`compaction/summary` carries the checkpoint as content blocks, so the record
shows its text blocks joined with newlines and never the raw stream output.
An event this build cannot parse is skipped instead of failing the whole read,
which keeps the transcript readable and sends possible, and reports one
`session.error` per session so missing content is never read as complete.
Feature/global instructions use the existing hidden instruction block.

Only sequenced `plan` and `modelSelection` projections supply the Session's
next agent and model. Cached hints do not establish them. Projection watermarks
and listing mutation revisions prevent stale reads replacing newer live state.

## Operations and questions

Session operations use the official `session/*` Remote methods; archive and
restore use the Workspace API. Files use `fileUploads/upload`; raster prompts
use DSH's inline image admission. The model catalog advertises no image
capability it cannot establish from the public catalog.
Catalog display names use the model's own name. Qualified model IDs retain
the native provider for routing without prefixing the displayed name.
The session catalog names no context window, so each model's configured
window and output cap come from the `llm-deepseek` settings models. A profile
that cannot answer leaves both null; the UI then uses its default estimate.
Local file references stream through DSH's authenticated binary-upload route.
History retains file names and references; native inline attachment previews
are currently unavailable.

The first managed send, command or question reply selects the session's native `danger-full-access`
permission preset. Approval waterfalls answer `allowed-once`. Human questions
and plan reviews remain interactive, preserving question ids, selections and
custom text. Timed questions remain visible after foreground continuation and
deliver late replies through `userQuestions/answer`. Plan review maps `build`
back to DSH's explicit approve label rather than inferring it from ordering.
Question settlement waits for DSH's reply acknowledgement. A delivery failure
keeps the same question retryable; concurrent replies cannot deliver twice.

Commands are discovered for an existing session and dispatched through
`commands/execute`. The permission command is excluded. Undo/redo use the shared
native revert and file snapshot store. A pending revert preserves the original
native log and can restore the files. The next prompt forks the exact retained
event prefix (or creates an empty session), durably changes the branch binding,
and commits the revert. Compaction commands use the same branch commit path.
A definite send failure restores the original binding and pending revert; an
unknown admission retains the new binding and original request id for history
reconciliation, refusing redo or an unrelated send until confirmed.

Unified-conversation mutations use the backend's serialized `stop` operation
before restoring files. It adopts a cold session before cancellation, waits
for native execution and transcript delivery to settle, then drains turn
snapshot and memory work. The shared Claude/Codex `whenIdle` interface does
not apply to DeepSeek.

Identity segments keep inherited user/assistant/part ids stable while assigning
new branch output a different namespace. `session.revert.committed` carries the
new `nativeHistoryRevision`; shared reducers retire in-flight reads and trim the
range. `metadata.openchamber.native.historyRevision` also advances, so a client
that missed the range event discards its obsolete cache on the next patch.
Paged history also carries `historyRevision`. The shared loader resets its
confirmed window when the revision changes, including when discovering it
during pagination, and never joins pages from different branches. Reads that
cross a server-side branch mutation fail explicitly. Revision order takes
precedence over timestamps from different native branches.
Server-advertised `native.actions` gates desktop, timeline, bulk and mobile UI.

### Permanent deletion

Deletion requires the pinned npm distribution, system Node and the JSONL format-4
backend. A startup `--patch` adds only an application-owned observer. Its inherited
fd-3 pipe describes the actual storage root and current native activity; it adds
no network listener or browser-facing operation and reads no credentials.
Another active DSH session or pending human question refuses deletion with 409
`NATIVE_DEEPSEEK_MAINTENANCE_BUSY`. The selected turn stops and settles first.
New managed mutations are blocked throughout maintenance; Claude/Codex continue.

A registry deletion intent becomes durable before the owned DSH process closes.
The worker loads codecs and kernel leases from that exact DSH installation,
claims every target before moving files, validates native identities and paths,
and retains each original `session.lock` inode. It deletes internal branch logs
and exclusive native subagents, preserving independent forks and subagents their
inherited catalogs still reference. It never rewrites a log or steals a writer.

A private journal records same-directory artifact moves. An interrupted prepared
transaction restores them; a committed transaction purges them. Recovery runs
before the next DSH startup. Shared handoffs and registry entries are then
removed; a failed integration cleanup retains its registry intent and retries
on the next authoritative listing in the same native storage root. Partial
cleanup reports `NATIVE_DEEPSEEK_DELETE_CLEANUP_FAILED`; native deletion is still
announced. Workspace files, provider settings, independent forks and long-term
memories remain intact. Maintenance never restarts the OpenChamber server.

### Shared memory

The existing memory switch controls managed DSH context and memory CLI actions.
Each prompt receives the bounded global/project title index and recent other-
session handoffs through the existing hidden instruction block. Bodies are read
on demand with the existing authenticated memory commands, using the owning
server port. DSH receives an absolute executable/entry command, so a globally
installed `openchamber` binary is unnecessary. No additional model request or history reload runs.

Only a sequenced terminal event for an admitted managed turn captures its final
text, with completed/interrupted status. Lifecycle work drains before a revert
or deletion; suppressed or stale branch completions cannot restore a retired
handoff. Revert hides that session's handoff, redo restores it, and deletion
removes it. Independently saved facts remain in the shared store. The stable
logical session id is the memory actor across internal forks and restarts.
This integration does not enroll an independent terminal `dsh` profile.

Packaged Electron stages the maintenance worker and observer as standalone Node
ESM resources outside ASAR. Main supplies their paths through server-only
`OPENCHAMBER_DSH_WORKER_PATH` / `OPENCHAMBER_DSH_PLUGIN_PATH`; normal web and
unpackaged desktop use the source modules. Both resources bundle their schema
parser but resolve native codecs from the installed DSH package at runtime.

## Remote configuration

`POST /api/native/deepseek/setup` starts or joins one setup job and immediately
returns its state. The body must be empty; clients cannot choose packages,
executables, commands or credentials. The job installs DSH if missing, starts
the native settings service, and finishes as `ready` when DSH already has a
credential or `needs-key` when the independent form needs one. It never reads
Claude Code connections or copies another backend's key, endpoint or models.
Existing DSH settings remain untouched by setup.

`GET` on the setup route returns in-memory job state, including a stable
error code on failure, without starting a process or returning child output.
The Settings page polls every 2 seconds only during installation or startup.
Leaving the page stops polling; the server job continues. Reload resumes an
active job's progress. A failed progress read remains unconfirmed and offers
reload. Runtime identity and read revisions guard asynchronous responses.

Managed packages live under
`<dataDir>/native-agents/deepseek/cli-v0.2.0-rc.2-<platform>-<arch>` in a private
npm prefix. No workspace dependency, global prefix or PATH is changed. A valid
CLI on the server PATH takes precedence. npm runs through the user's Node and
its JS entry, including on Windows; batch launchers are never executed by the
installer. Lifecycle scripts are disabled. Runtime peer resolution stays on
because DSH imports peer packages at boot. Child output is discarded, since npm
can print registry credentials. Installation is bounded at 10 minutes.

A unique staging directory becomes discoverable only after package identity,
version and CLI startup through `--version` pass and the complete directory is
atomically published. Concurrent requests share one installer; different
servers may publish a complete prefix first. Failure or ordinary shutdown
stops the installer process tree and removes staging. A force-killed server
can leave undiscovered `.install-*` directories for manual cleanup. Completed
installations survive later configuration failures and are reused on retry.
Server shutdown cancels the setup job alongside the native transport.
Enterprise mode refuses setup before installation and all later DSH requests.

`GET /api/native/deepseek/configuration` reads the active profile's
`llm-deepseek` namespace through `settings/describe` and describes its named
credential through `credentials/describe`. The response contains the endpoint,
model IDs, settings revision and credential presence/writability. It never
contains a key, the credential reference, another namespace or a Host path.

`POST` to the same route accepts that revision, an optional replacement API
key, the endpoint and model IDs. Null endpoint removes the user override and
retains DSH's default or composition value. Retained models keep their other
native metadata. `settings/mutate` changes only the endpoint and catalog, with
the expected revision; `credentials/set` stores a supplied key in DSH's own
credential store. Omitting the key preserves it. Read-only profiles and
read-only credential sources are enforced on the server.

Writes from OpenChamber serialize. A stale revision is 409
`NATIVE_DEEPSEEK_SETTINGS_CONFLICT`. A settings failure leaves the key alone.
If settings commit but the credential write fails or loses its acknowledgement,
the result is `status: credential-error` with the committed configuration and
revision, allowing the form to retry. A credential error message is never
forwarded because a provider could echo the submitted key. A lost HTTP save
response requires reloading the configuration before another save. DSH applies
changes to subsequent model requests without restarting an active session.

Every operation uses the transport's enterprise check before crossing into DSH.
The settings page disables the provider editor in enterprise mode. All ordinary
authenticated clients, including remote browsers and Relay clients, can configure
their connected server; no local-management gate applies. The one-click installer
requires Node.js and npm on the server. A valid `dsh` installation exposes its
own configuration API.

Web and Electron use this server adapter and configuration editor. Hosted mobile
and Capacitor reach it through existing HTTP and events, including Relay. The
DSH socket never reaches those clients. VS Code remains unsupported.

## Validation

Tests launch `fixtures/server.mjs` as a real child with cookie/origin-protected
HTTP and WebSocket endpoints. They exercise framing, history, duplicate
admission, cancellation isolation, questions, continuation, process loss,
enterprise refusal and native HTTP routing. Projector tests exercise message
identity, streaming, retry replacement, tools, usage and compaction. Installer
tests use real Node children to check single-flight installation, publication,
failure, cancellation and the Windows prefix layout. Setup routing tests verify
that the Claude connection store is never read. The fixture runs no model or
tools and does not prove real CLI behavior or packaged platform behavior.
