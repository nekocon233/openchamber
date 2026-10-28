# Unified native conversations

## Ownership

This module presents Claude Code, Codex and DeepSeek Harness execution as one
`ncv_<uuid>` conversation. Read this document when changing cross-backend
selection, history projection, handoff preparation or shared-source cleanup.
The parent native runtime owns CLI processes, authentication, protocols and
raw transcripts.

`runtime.js` wraps that runtime. New UI drafts selecting a native model request
`kind: 'unified'` when capabilities declare `unifiedSessions`. A create without
that kind remains a single-CLI session, including existing integrations and
utility work.

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

`Session.model` and `Session.agent` describe the next selection. Server-owned
`metadata.openchamber.native` describes the executing backend and source,
handoff state and readiness. Its selection `revision`, persistent
`recordRevision` and `historyRevision` have separate lifetimes.

`PATCH /api/native/sessions/:id/selection` accepts a directory, selection and
expected selection revision. Selecting another model changes no running turn.
The next send checks live foreground activity, background work, children and
questions before switching. Queued sends capture their configuration and use
`preserveSelection` so delivery cannot replace a later composer choice. The
UI rechecks server readiness before claiming queued work. Plan approval stays
with the source that asked; approving Build updates the unchanged next-agent
selection without replacing a newly selected destination model.

Mutations serialize per conversation. Send identities have a payload
fingerprint, a logical/native ID mapping and durable admission state. A
`preparing` admission contains rollback references and has sent nothing to a
CLI, so startup can restore it. A `dispatched` admission requires native-history
confirmation after an ambiguous result and never blindly resends. Definite
refusals restore the previous segment binding and pending rewind. Failed
cleanup retains registry ownership so conversation deletion can retry.

## Context and operations

`context.js` transfers user text, visible replies and plans, tool inputs and
results, and attachment references through server-generated hidden instructions.
It leaves native reasoning and tool protocol execution with the source CLI.
The public client instruction limit does not constrain this server-built context.

The target catalog supplies context limits; an unknown window uses the existing
64k estimate and character-budget convention. A long history keeps recent whole
turns and summarizes earlier material in bounded chunks. Summary calls select
the source Claude/Codex model, or the destination Claude/Codex model when the
source is DeepSeek. They use existing tool-free utility generation and no global
small-model fallback. DeepSeek has no utility generator; when neither end
supplies one, an oversized handoff refuses with a retryable explanation.

Revert snapshots belong to the logical ID. Revert sets a retained-prefix marker;
redo restores its files until the next admitted prompt commits it. That prompt
opens a new source from the retained prefix. Before restoring files, the
controller stops and settles the active source through its backend's own
lifecycle operation; DeepSeek uses its serialized native cancellation flow.
Forks freeze references to retained records and acquire their own sources when
prompted. Titles and archive state
belong to the conversation; only the first source may supply an automatic title.

Deletion persists its remaining cleanup intent, stops current work and removes
only unshared native sources. A partial failure keeps the logical record for
retry. Raw native statistics account for actual execution once; manifests and
inherited references add no synthetic usage.

Unified creation, prompting, compaction and continuing question replies enforce
enterprise mode on the server. Manifests remain readable; source reads and
cleanup retain each backend's policy checks. Shutdown cancels preparation and closes native runtimes before
waiting for operations and manifest writes to drain.
