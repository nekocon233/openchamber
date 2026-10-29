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
dynamic models, streamed text and tools, native history, model changes,
interruption and archive. Unified `ncv_` conversations, revert, fork, manual
compaction and native deletion are unsupported. Plan mode, interactive
questions, mid-turn steering, Small Model, quota and terminal memory hooks are
also unsupported. Server routes return `NATIVE_ANTIGRAVITY_UNSUPPORTED` or
`NATIVE_ANTIGRAVITY_UNIFIED_UNSUPPORTED`; UI capabilities keep those actions
closed. Automatic compaction records in a native transcript remain readable.

## Process and trust

`process.js` starts one process per active session with:

```text
agy --input-format stream-json --output-format stream-json \
  --add-dir <cwd> --disable-slash-commands --print-timeout 0 \
  --dangerously-skip-permissions [--model <slug>] [--conversation <uuid>]
```

Headless agy cannot ask interactive permission questions. This matches the
existing native full-access model, but the Settings page makes the behavior and
Google's consumer-plan third-party-use warning visible. Installation and login
remain user actions in the official CLI on the server machine.

Startup waits for `init` with a 30-second deadline and validates a resumed
conversation ID. Each turn binds its process. Late frames from an older process
cannot settle or modify a newer turn. Prompt admission is serialized per
session; a second turn while one runs returns `NATIVE_SESSION_BUSY`. Prompts
are never replayed automatically. Models change by closing the idle process
and resuming the same conversation on the next prompt. Idle processes close
after five minutes.

POSIX interruption sends SIGINT to the process group, then SIGTERM and SIGKILL
as fallbacks. Windows terminates the tree. Process completion waits for stdio
to drain before settling the turn. `result.usage` is cumulative over the
process and is not added to message usage. DONE generation steps own the
per-message measurement. A final `ERROR` result is checked against the native
transcript: a complete final planner response after the current user input
settles the turn successfully, preserving any native error row. Otherwise the
turn fails. This handles agy's known sticky `stream was interrupted` result
without resending the prompt.

`catalog()` checks `agy --version` and reads tab-separated `agy models`. Model
limits and non-text input are unknown and therefore not advertised. Images are
refused before native input; text files and file references follow the shared
prompt-parts conversion. Authentication failure is reported separately as
`reason: 'unauthenticated'` in the native catalog partition.

## Identity, history and live state

`store.js` opens `~/.gemini/antigravity-cli/conversation_summaries.db` read-only
through Node's built-in SQLite module. Root rows are filtered by workspace and
`parent_conversation_id = ''`. Histories come from
`brain/<conversation uuid>/.system_generated/logs/transcript.jsonl`. No
conversation copy is written into OpenChamber storage. A missing index or
transcript for a confirmed session is an error, never an empty success. A new
registry-only session may legitimately have no transcript yet. One unreadable
summary row does not hide valid sibling rows.

`projector.js` shares deterministic native step identities between live frames
and history. `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC` and `CHECKPOINT` map to
user, assistant, tool and compaction records. Tool results join their planner
step by index. Instructions injected by OpenChamber are hidden in both paths.
Malformed complete lines and unknown step types mark history incomplete;
unterminated trailing writes are not treated as corruption.

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

Web and Electron use this server adapter. Hosted mobile and Capacitor use the
connected server through existing native HTTP and events. VS Code retains its
explicit unsupported native API. There is no agy-specific RuntimeAPI, bridge,
quota integration, Small Model runtime, memory hook or Electron helper.

Global AGENTS.md is injected into the first prompt of each agy process and
hidden from the transcript projection. Feature instructions use the existing
`<openchamber-instructions>` block. Unified conversation creation explicitly
rejects agy; existing unified manifests remain unchanged.

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
