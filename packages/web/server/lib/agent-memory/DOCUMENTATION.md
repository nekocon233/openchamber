# Shared agent memory

`runtime.js` owns durable global preferences and project knowledge. OpenCode, Claude Code, Codex and managed DeepSeek Harness
sessions use this store. `agentMemoryToolEnabled` is off by default;
the capability and Settings entry are available without the retired
`OPENCHAMBER_MEMORY_ENABLE` experiment flag. Disabling memory stops agent reads,
writes and handoff capture. Existing entries remain on disk.

## Owners and scope

- `project-resolution.js` resolves a directory to its configured project or
  primary worktree. Configured worktrees retain their explicit project owner.
  Managed Chats directories share their Chats root.
- `actions.js` owns `memory.list`, `read`, `save` and `delete`, including the
  enablement check. The CLI delegates to the authenticated control service.
- `native-sharing.js` supplies a bounded memory index and the four latest
  other-session handoffs for the current project. Native session identities
  include the backend. A fact about one project never becomes global merely
  because another CLI reads it.
- `native-memory/projects/<project stem>/progress.json` holds temporary
  per-session handoffs with source timestamps and increasing project revisions.
  Each project has its own file; one corrupt project cannot blank another.
  Entries describe ended or interrupted turns, not proof of live activity or
  proof that the whole task succeeded.
- `file-lock.js` serializes read-modify-write operations across server
  processes. Memory, handoff and hook-config writes use atomic replacement.
  Missing storage is empty; malformed or unreadable storage is unavailable.

The native live owners capture their final reply when a turn ends. DeepSeek uses
its stable logical OpenChamber identity across native forks; revert hides its
handoff, redo restores it, and permanent deletion removes only that actor’s
handoff. Independent long-term memories remain shared. Late managed callbacks
are drained or suppressed before those transitions. Handoff
capture neither reloads the conversation nor makes an extra model request.
Late checkpoints cannot replace a newer observation for the same session.
Handoff read failure leaves readable long-term memory available and explicitly
marks progress unavailable. No background polling runs.

Managed DeepSeek context names an absolute runtime executable and the private
`native-cli.mjs` entry, so memory reads/writes do not depend on a global
`openchamber` command. That entry delegates only list/read/save/delete to the
existing CLI command and authentication, always emits JSON and fails nonzero;
it cannot manage hooks or run another CLI command. Packaged Electron stages a
standalone `native-memory-cli.mjs` outside ASAR and supplies its server-only path.

DeepSeek participation is limited to OpenChamber-managed sessions on the
connected server. Hook enrollment and connection readiness still describe only
Claude Code and Codex; no DSH terminal profile is modified.

## Native terminal hooks

Settings > General > OpenChamber tools installs missing terminal hooks when the
Agent memory tool is enabled. Setup is explicit through that switch and local to
the server computer. Web and Electron use that host's CLIs; remote and mobile
clients can enable memory and inspect sharing, but cannot install executable
hooks on a different computer. Turning the tool off stops agent reads, writes
and handoff capture without removing the installed hooks. VS Code retains its
explicit unsupported native API. The `openchamber memory` CLI remains the
manual connect/disconnect path, and the import API remains available to server
clients even though Settings no longer has an import row.

`native-connections.js` adds only its owned command handlers to Claude's user
settings and Codex's `hooks.json`. Other configuration and hooks survive connect,
reconnect and disconnect. Invalid configuration fails without replacing it.
Codex hooks must pass Codex's own trust review. Installed means configured;
ready means a hook has successfully reached this backend since enrollment.
Start or resume the CLI after setup and submit a prompt to verify it.

`native-hook.js` implements the native JSON stdin/stdout protocol:

- `UserPromptSubmit` reads current shared context.
- `SessionStart` after compaction restores context for the immediate continuation.
  Initial startup/resume waits for `UserPromptSubmit` to avoid duplicate blocks.
- `Stop` and `Interrupt` save a handoff. They never request continuation.

OpenChamber-managed prompts use the same context builder. While their turn is
owned by OpenChamber, the terminal hook skips duplicate delivery. Idle, failed
send and closure release that ownership. CLI commands in the index include the
owning server port, so another desktop instance cannot receive the write.
Unavailable services return an empty hook response without blocking the CLI;
the standard CLI command still reports its error and a nonzero exit.

Desktop packaging stages a standalone `native-memory-hook.mjs` resource outside
ASAR. Terminal hooks use the system Node executable, never the Electron binary.
Node must be installed on the server computer for desktop terminal enrollment.
The helper reuses CLI authentication; credentials never enter hook definitions.

## Existing native memories

Import creates a project-scoped reference to a known native Markdown memory
file. It does not rewrite the CLI's generated store or automatically copy every
claim into global preferences. Claude project paths use the resolved owner;
Codex's generated memory remains read-only. The user chooses the reference to
import, and the agent reads the relevant sections when needed. Authentication,
SQLite state and caches are not import sources.

## Interfaces and checks

Authenticated native routes provide sharing status, connect, disconnect and
reference import. Connection configuration failures are isolated per backend.
`progressUnavailable` and `sourcesUnavailable` distinguish failed reads from
empty successful results; clients retain their previous data for that scope.
Agent control exposes normal memory operations; `memory.context` and
`memory.checkpoint` are CLI-adapter actions, excluded from model tool schemas.

Use `openchamber memory --help` for read/write and terminal enrollment commands.
Focused tests cover cross-CLI handoffs, project isolation, concurrent writes,
stale checkpoints, corrupt storage, preserved hooks and native hook output.
Native platform behavior and Codex trust approval require their own runtime
checks; passing unit tests does not establish Windows or macOS behavior.
