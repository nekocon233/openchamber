# Claude Code execution

## Ownership

This module adds a managed OpenCode plugin and AI SDK model adapters. The
`claudeCodeExecution` setting selects the task executor independently of the
provider/model identity. OpenCode owns sessions, history, tool permissions,
tool execution, queues and event delivery.

At managed OpenCode startup, the runtime registers a model hook for every
provider ID in OpenCode's auth store. Explicit providers in the managed config
are registered too. The hook chooses an adapter from each model's API format,
not its provider name, so newly logged-in providers need no OpenChamber
allowlist entry. Models using `@ai-sdk/openai`, `@ai-sdk/anthropic` or
`@ai-sdk/openai-compatible` use the corresponding adapter unless their OpenCode
provider bypasses the supplied model SDK. Bypassing loaders and other API
formats fail before inference. The existing `claude-code` provider keeps its
own Claude runtime. New login-store entries are registered on the next managed
OpenCode restart.

## Model and credential boundary

`provider.js` creates the original AI SDK client with the options OpenCode
resolved, including its credential-owning `fetch` callback. ChatGPT OAuth
refresh and subscription endpoint selection stay with that callback. Kimi
retains its coding endpoint and key. No separate Codex agent is started, no
provider credentials are copied into Claude Code. At managed startup this
module reads only the auth store's provider IDs. It never serializes auth
entries into plugin config and never writes the auth store.

Keep the AI SDK adapter versions aligned with the OpenCode release used by the
application. Custom SDK URLs change the namespace OpenCode uses for model
options; `protocol.js` restores source namespaces, Kimi adaptive effort and
stateless OpenAI reasoning metadata before calling the original client.
Model IDs, capabilities, catalog variants, limits and costs are preserved.

OpenCode puts ChatGPT OAuth system instructions in `providerOptions.openai.instructions`.
The bridge restores the project rules from that field into Claude's prompt;
the gateway then replaces it with Claude's system instructions for each
Responses request. User-defined agent prompts are kept intact. Responses
function tools retain OpenCode's `strict: false` compatibility policy.

`gateway.js` binds a loopback-only Anthropic Messages endpoint for each Claude
run. A random per-run credential binds requests to one source model.
The gateway translates into AI SDK calls and streams the source result back.
It never executes tools. It accepts text, images, PDF inputs, tool requests,
tool results and mid-conversation system messages. Unsupported request blocks
fail validation. Missing terminal events, filtered responses and upstream
failures cannot become successful empty replies. Error responses contain
status and fixed explanations rather than provider response bodies.

Claude thinking signatures are forwarded when the source supplies them.
OpenAI reasoning metadata stays in the run's gateway; it is not forged into
Claude signatures. Provider-specific capabilities beyond these mapped
formats still require compatibility validation.

## Execution lifecycle

`hooks.js` captures a decision per submitted user message. Its headers carry
that decision, the authoritative plugin directory, session/message IDs and
source model. The adapter removes those headers before any provider request.
The same hooks cover UI messages, commands, scheduled work and OpenCode
subagent requests. A settings change applies to the next submitted message,
including in existing sessions; tool continuations keep their captured choice.

Each new user turn restores OpenCode's current conversation into a fresh
Claude run. Completed historical tool results are context, never replayed
operations. Switching models, changing executors, forking or restarting
therefore cannot silently resume an unrelated stale Claude session.

`bridge.js` disables Claude's native tools, project MCP discovery and hooks.
The host's allowed function tools become an in-process MCP server. A tool
request parks the Claude query and returns an AI SDK tool call. OpenCode
executes it under the selected agent's permissions; the next model request
resolves the waiting MCP call and continues the same query.

Active queries are scoped by directory, session and agent. Title/summary work
cannot replace the primary query. The event queue applies backpressure at 128
items. Abort, session idle/deletion, plugin disposal and terminal results close
queries and their gateways. Idle cleanup leaves independently running utility
agents alone; deletion and directory disposal stop them too.

OpenCode's title, summary and compaction agents use single-turn, no-tool Claude
queries. OpenChamber's separate direct `small-model` HTTP helpers remain owned
by that module and do not acquire an agent loop through this switch.

## Queued messages

Queue `sendConfig.executionFramework` captures the executor with the model.
Before a claimed message or command is sent, the UI prepares its fixed decision
through authenticated `POST /api/claude-execution/requests`. The host normalizes
the directory and rejects conflicting decisions for the same message ID.

The managed plugin obtains the decision through
`POST /internal/claude-execution/decision`. This route is registered before the
normal UI gate and independently requires both a loopback peer and the private
managed-process token. It returns only the selected boolean. Unprepared
messages read current authoritative settings; read failure is an error.
Prepared decisions expire after ten minutes and are bounded to 1,024 entries.
Their durable source is the queue; a failed dispatch can prepare them again.
Expired decisions fail rather than adopting a newer default.

## Runtime and packaging

Web and Electron inject the plugin when starting managed OpenCode. The switch
itself is live after that initial plugin load. External OpenCode and the VS
Code extension's separate lifecycle report unsupported capability; server and
extension-host mutation handlers enforce this beyond UI visibility. Hosted
and Capacitor clients use their connected host's implementation.

Electron stages the execution plugin, per-provider plugin, adapter bundles and
the matching native Claude SDK package outside `app.asar`, because the OpenCode
child cannot read Electron's virtual filesystem.
`OPENCHAMBER_CLAUDE_EXECUTION_PLUGIN` selects that staged entrypoint.
Development and ordinary web installs use the module entrypoints.

## Verification

Protocol tests cover message/tool conversion, incremental events, reasoning
state, source transport preservation and authoritative failure. A real Claude
SDK test uses an isolated home and local model fixture. The OpenCode integration
test is opt-in with `OPENCHAMBER_TEST_OPENCODE_BINARY`; it switches one real
session into Claude execution, reads a fixture through OpenCode, restores
history, then switches back. `OPENCHAMBER_TEST_CLAUDE_PLUGIN` runs the same test
against the staged desktop plugin. Neither fixture uses real provider accounts.
