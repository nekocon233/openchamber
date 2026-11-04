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
its source until a rewind or frozen fork needs a new one. Closed sources have
a retained message boundary and Claude queries close before another backend
starts. A source referenced by another conversation survives deletion of its
original conversation. Unreadable manifests prevent destructive assumptions
about shared references and are retried on subsequent reads.

`history.js` projects message, parent and part identities into the logical
conversation. User sends retain their client IDs; forks namespace inherited
records for their own conversation. A segment's clock offset is shared by live
and historical projection. Child links retain native identity and execution
ownership. Per-turn model, effort and agent come from captured sends.

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
questions before switching. Claude and Antigravity idle processes close before
a new backend starts. Queued sends capture their configuration and use
`preserveSelection` so delivery cannot replace a later composer choice. The
UI rechecks server readiness before claiming queued work. The proposing source owns the plan decision. Approval may capture an execution
model and expected selection revision. Model-changing approvals first let that
source yield, then enter `automaticPrompt` with a stable logical delivery ID.
Only the approving question is excluded from the quiet-source check; other
questions, children and background work retain their protection. Acceptance
updates the next model and Build selection only at the captured revision.
An application-owned answer can settle on a retained planning source after
backend handoff; other events from inactive sources stay excluded.
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

## Context and operations

Antigravity checklist reads use the executing segment's retained history,
including a frozen fork before its first new source. A rewind cuts checklist
records before the same user message as chat; redo restores the retained list.
Logical checklist identities include conversation, segment and rewind boundary.
Events from a bounded or rewound source cannot update that logical list.

`context.js` transfers user text, visible replies and plans, tool inputs and
results, and attachment references through server-generated hidden instructions.
It leaves native reasoning and tool protocol execution with the source CLI.
The public client instruction limit does not constrain this server-built context.

Legacy model-id aliases, including unified Opus, resolve to the same catalog row.
The target catalog supplies context limits; an unknown window uses the existing
64k estimate and character-budget convention. A long history keeps recent whole
turns and summarizes earlier material in bounded chunks. Summary calls select
the source Claude/Codex model, or the destination Claude/Codex model when the
source is DeepSeek or Antigravity. They use existing tool-free utility generation
and no global small-model fallback. DeepSeek and Antigravity have no utility
generator; when neither end
supplies one, an oversized handoff refuses with a retryable explanation.

Revert snapshots belong to the logical ID. Revert sets a retained-prefix marker;
redo restores its files until the next admitted prompt commits it. That prompt
opens a new source from the retained prefix. Before restoring files, the
controller stops and settles the active source through its backend's own
lifecycle operation; DeepSeek uses its serialized native cancellation flow.
Forks freeze references to retained records and acquire their own sources when
prompted. Titles and archive state
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
