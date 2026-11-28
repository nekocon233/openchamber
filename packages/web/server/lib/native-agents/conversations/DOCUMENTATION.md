# Unified native conversations

## Ownership

This module presents every registered native agent, currently Claude Code,
Codex, DeepSeek Harness and Antigravity, as one `ncv_<uuid>` conversation.
Read this document when changing cross-backend
selection, history projection, handoff preparation or shared-source cleanup.
The parent native runtime owns CLI processes, authentication, protocols and
raw transcripts.

`runtime.js` wraps that runtime. New UI drafts selecting a native model request
`kind: 'unified'` when capabilities declare `unifiedSessions` and include the
selected backend in `unifiedBackends`. That list comes from the complete native
backend definition. Servers predating the list support only the original
Claude, Codex and DeepSeek unified backends. A create without that kind remains
a single-CLI session, including integrations and utility work. Existing
standalone IDs are not migrated.

| Runtime | Behavior |
| --- | --- |
| Web | Uses the native server controller and shared UI. |
| Electron | Uses the same controller in the embedded server. |
| VS Code | Native agents remain explicitly unsupported. |
| Hosted mobile | Uses the connected server over runtime HTTP and events. |
| Capacitor | Uses the connected server through direct or Relay transport. |

## Durable identity and history

`store.js` writes versioned, owner-only manifests under
`<dataDir>/native-agents/conversations/`. They contain ordered execution
segments, native IDs, retained history boundaries, send identities, selections
and derived summary checkpoints. Conversation text stays in native transcripts.
The native registry stores private `conversationId` ownership on each source.
Owned sources stay out of the sidebar and refuse ordinary native mutations.
Client message identities resolve through each segment's captured send mapping,
including Antigravity's registry-bound native steps. No backend prefix list
controls logical message identity.

Every backend change starts another native source. An unchanged backend keeps
its source, including supported native rewinds of an exclusively owned source.
Closed sources have
a retained message boundary and Claude queries close before another backend
starts. A source referenced by another conversation survives deletion of its
original conversation. Unreadable manifests prevent destructive assumptions
about shared references and are retried on subsequent reads.

`history.js` projects message, parent and part identities into the logical
conversation. User sends retain their client IDs; forks namespace inherited
records for their own conversation. A segment's clock offset is shared by live
and historical projection. Child links retain native identity and execution
ownership. Per-turn model, effort and agent come from captured sends.
Native message-part snapshots project every part identity and timestamp as
history does, preserving recovered reasoning order during a running turn.

History pages carry an opaque `ncvpage_` cursor and `historyRevision`. They read
only the segments needed by the window. If an older source fails after newer
records were read, `historyUnavailable` preserves the readable window and a
retry cursor. Initial UI loading stops automatic extension at that boundary.
A failed newest source still fails the request. Full handoffs require all
needed source reads; partial history is never an empty successful handoff.

## Selection and turn admission

`PUT /api/native/sessions/:id/agents` atomically updates revisioned
`metadata.openchamber.native.agents`. A full combination also updates the main
selection in the same manifest write, guarded by both configuration and
selection revisions. All selected models and efforts are checked before any
write. The request contains catalog identities, never an endpoint or secret.
Standalone native roots may change their subagent choice but cannot apply a
full combination. Managed child sessions reject configuration writes.

Unified creation can include `configuration` with the first `selection`;
creation and role capture share one durable manifest. The client consumes its
runtime/directory-scoped draft only after success. Later configuration edits
apply on the next turn, while already-running delegates keep their captured
choices. Forks retain configuration snapshots. Queued sends retain their own
optional `subagentModel`; null explicitly captures CLI defaults, while absence
preserves older queued-send behavior.

The active physical source receives the manifest's configuration before prompt
admission. Delegated children retain their native IDs and logical parent ID;
the controller maps their live foreground/background activity to that active
source. Child history read failure preserves readable parent records and marks
metadata incomplete. Cleanup preflights retained child deletion capabilities
and preserves children whose physical source remains referenced by a fork.

`Session.model` and `Session.agent` describe the next selection. Server-owned
`metadata.openchamber.native` describes the executing backend and source,
handoff state and readiness. Its selection `revision`, persistent
`recordRevision` and `historyRevision` have separate lifetimes.

`PATCH /api/native/sessions/:id/selection` accepts a directory, selection and
expected selection revision. Selecting another model changes no running turn.
The next send checks live foreground activity, background work, children and
questions before switching. A conversation restores pending questions for its active
source and its children. A missing decision transcript blocks its owner and leaves
other conversations in the same directory able to send. Claude and Antigravity idle processes close before
a new backend starts. Queued sends capture their configuration and use
`preserveSelection` so delivery cannot replace a later composer choice. The
UI rechecks server readiness before claiming queued work. The proposing source owns the plan decision. Approval may capture an execution
model and expected selection revision. Changed execution settings first let the
planning turn yield, then enter `automaticPrompt` with a stable logical
delivery ID. Same-CLI execution keeps the source and uses its native transcript.
Cross-CLI execution retires the source and transfers context to the new backend.
The approving question is excluded from the activity check. A Claude query
that can keep its launch connection also keeps its background shell tasks.
The check protects other questions, children and other active background work.
Acceptance
updates the next model and Build selection only at the captured revision.
An application-owned answer can settle on a retained planning source after
backend handoff; other events from inactive sources stay excluded.
Completed Codex tool-wait patches are the other narrow exception. They update
only timing metadata, after a serialized retained-history read confirms the
message is inside the source boundary and before any rewind cut. Unreadable or
removed history rejects the patch without replacing messages or live activity.
The conversation send owner reports a completed rollback to the plan approval
owner, including numeric JSON-RPC refusals. The approval then reopens for a
different model or effort. Timeout and disconnect failures retain the target
source and admission instead. Confirmation distinguishes an accepted send,
an admission that was rolled back, and an unresolved result. Restart recovery
reopens a legacy dispatch only when the planning source is still active, its
logical send and admission are absent, and no orphan source remains owned by
the conversation. It never dispatches the recovered approval automatically.
Antigravity completed-turn question and plan continuations enter through
`automaticPrompt`, keeping source identity and logical send admission with this
conversation. Execution metadata also carries `unifiedBackends`, allowing the
model picker to negotiate older servers without another capability read.

Mutations serialize per conversation. Send identities have a payload
fingerprint, a logical/native ID mapping and durable admission state. A
`preparing` admission contains rollback references and has sent nothing to a
CLI, so startup can restore it. A `dispatched` admission requires native-history
confirmation after an ambiguous result and never blindly resends. Definite
refusals restore the previous segment binding and pending rewind. Failed
cleanup retains registry ownership so conversation deletion can retry.

Source-bound stops check `expectedSourceSessionId` under the conversation's
mutation lock before interrupting anything. A changed source rejects with
`NATIVE_CONVERSATION_SOURCE_CHANGED`, preserving the replacement execution.
Manual AGY queue sends use this guard after a definite busy refusal and confirm
whole-conversation readiness before sending their captured request again.

### Why source-bound stops have a separate route

`POST /api/native/sessions/:id/abort-source` requires the expected source.
Older servers reject this route instead of silently ignoring a new field on the
ordinary abort route. Clients preserve the queued message after that refusal.

## Context and operations

Antigravity checklist reads use the executing segment's retained history,
including a frozen fork before its first new source. A rewind cuts checklist
records before the same user message as chat; redo restores the retained list.
Logical checklist identities include conversation, segment and rewind boundary.
Events from a bounded or rewound source cannot update that logical list.

`context.js` transfers user text, visible replies and plans, tool inputs and
results, and attachments through server-generated hidden instructions.
Inline text uploads contribute their contents. Other attachments contribute
their filename or path.
It leaves native reasoning and tool protocol execution with the source CLI.
The public client instruction limit does not constrain this server-built context.

Legacy model-id aliases, including unified Opus, resolve to the same catalog row.
The target catalog supplies context limits; an unknown window uses the existing
64k estimate and character-budget convention. Context first replaces each
segment's covered prefix with its last completed, nonempty native compaction
summary. Claude's completed boundary can take its text from the following
assistant summary record. Failed, running or truncated summaries cannot replace history. The
rewind boundary is applied first, so a discarded checkpoint covers nothing.
Other execution segments and the full visible transcript remain intact.

A long history keeps recent whole turns and summarizes earlier material in
bounded chunks. Summary calls try the source model, destination model, then
the explicitly configured Small Model in Settings, with duplicate models
attempted once. Utility generation remains tool-free. The Settings candidate
must report `source: 'settings'`; implicit defaults and unrelated connected
providers cannot receive the conversation. A failed candidate's partial
summary is discarded before another model starts. Cancellation, enterprise
policy and checkpoint write failures stop preparation. DeepSeek and
Antigravity have no utility generator of their own.

### Antigravity side-question context

A first `/btw` prompt can use the provider window recorded on the last
successful inherited reply when its model and effort match the destination.
The history budget caps the transcript at 176,000 UTF-8 bytes to leave room
for the question and instructions under Antigravity's 192 kB input limit.
The handoff prioritizes recent whole turns. Earlier tools use compact labels
and marked excerpts of large inputs and results. Each excerpt reserves a
four-byte UTF-8 character at both ends. The usual summary path applies
when retained message text and tool excerpts exceed the budget. The stored
transcript keeps complete tool data.

### Why handoff reuses completed native summaries

The source CLI already continues from its completed checkpoint. Passing the
covered tool history again can require another summary even when the retained
native context fits the destination. Segment boundaries prevent a checkpoint
from discarding another CLI's history.

Revert snapshots belong to the logical ID. Revert sets a retained-prefix marker;
redo restores its files until the next admitted prompt commits it. That prompt
first uses the retained source's native rewind when the selected backend matches.
Claude resumes at the previous chain entry, Codex reverts before the native turn,
and DeepSeek commits its native event-prefix fork behind the same source ID.
The logical conversation alone restores files; staging the native rewind takes
no second file snapshot or restoration. Native first-message, mid-turn and
pre-compaction limitations fall back to context transfer. Antigravity's
headless protocol has no rewind or fork operation and uses that fallback.

An inherited source or one referenced by another conversation uses a native fork
at the exact cut when available. Its inherited transcript supplies CLI context;
the new segment's optional `from` message marks its first new prompt so those
inherited records do not appear twice in logical history. Older manifests omit
this field and retain their existing behavior. Unreadable manifests prevent
in-place mutation because their source references are unknown.
History reads establish the excluded native message IDs for live projection.
Before that boundary is known, replayed messages and parts cannot publish or
initialize the segment clock. The same exclusion applies on reconnect and to
interaction parts; it is not a one-time replay flag.

The preparation admission records an optional `rewindSource` before staging the
native revert. Restart recovery removes that pending native revert before
restoring the logical cut. Definite refusals preserve redo while native history
still contains the cut. If Codex already committed its native revert before
refusing the replacement turn, the retained prefix stays committed and the
replacement can be retried. An uncertain send keeps its admission and confirms
the same message from native history without replay.
Native revert-commit events use the admission's logical cut and the manifest's
history revision, never the backend's independent message ID or branch version.

Before restoring files, the
controller stops and settles the active source through its backend's own
lifecycle operation; DeepSeek uses its serialized native cancellation flow.
Forks freeze references to retained records and acquire their own sources when
prompted.

### Why native rewind precedes context transfer

A same-backend retry can retain native checkpoints, reasoning and tool state
without generating another summary. Shared sources require a native fork so
rewinding one conversation cannot change another conversation's retained history.

Titles and archive state
belong to the conversation; only the first source may supply an automatic title.
Initial previews omit hidden instructions and the `/plan` command prefix.
For an Antigravity or DeepSeek first source, `auto-title.js` summarizes the
first completed turn through the explicitly selected Small Model. With no
usable selection it keeps the preview. DeepSeek's adapter still names the
native session from visible user text, so hidden instructions stay out of the
fallback; the conversation title replaces that preview once the summary
exists. This work never falls back to another connected provider, is disabled
in enterprise mode, and is cancelled on a manual rename, rewind or shutdown.
The optional `generatedTitle` manifest marker preserves the result across native
preview refreshes and restarts. A later send cannot replace it with its text.
Switching the executing CLI preserves a pending title for the retained first source.

Session action metadata describes logical rewind and fork support, permanent
deletion across retained sources, and manual compaction on the executing source.
A conversation containing Antigravity history cannot be permanently deleted;
archive remains available. This also covers registry sources left after failed
or interrupted preparation. Unsupported deletion rejects before stopping work
or removing any source. Antigravity manual compaction returns an explicit
unsupported error; automatic compaction remains native history.

Supported deletion persists its cleanup intent, stops current work and removes
only unshared native sources. A partial failure keeps the logical record for
retry. Raw native statistics account for actual execution once; manifests and
inherited references add no synthetic usage.

Unified creation, prompting, compaction and continuing question replies enforce
enterprise mode on the server. Manifests remain readable; source reads and
cleanup retain each backend's policy checks. Shutdown cancels preparation and closes native runtimes before
waiting for operations and manifest writes to drain.

## Adding a native backend

Unified conversations are required for every native agent integration. Extend
the server identity schemas and their UI mirror, and provide the backend's
`sourceLifecycle` entry with stop, retire, deletion and compaction behavior.
Missing lifecycle entries fail admission. Optional native operations remain
explicit capabilities; they do not opt a backend out of unified chat.

Complete creation, prompt admission, history projection, live events, source
ownership, cancellation and restart recovery before exposing its models.
Application-driven question or plan follow-ups must use `automaticPrompt`.
Failed history reads block handoff. Uncertain delivery must be confirmed from
native history without replay.

The conformance matrix enumerates every registered backend and every directed
backend pair. New backends must pass creation, same-source continuation, context
transfer, live/history identity, queued selection, retirement, restart and
unsupported-operation cases. Native adapters also need deterministic CLI or
protocol fixtures. Fix the executable resolver in fixtures so local shell
functions cannot invoke a real CLI.
