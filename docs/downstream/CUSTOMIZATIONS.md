# Downstream customizations

This repository is the `nekocon233/openchamber` downstream distribution. Keep downstream behavior in focused commits and preserve it through reviewed upstream merge pull requests.

## Web notification navigation

Notification clicks reuse an existing Web/PWA window, navigate it to the related session, and open a new window only as a fallback.

Owned files:

- `packages/web/src/sw.ts`
- `packages/web/src/api/notifications.ts`
- `packages/ui/src/hooks/useWebNotificationStream.ts`

Regression tests:

- `packages/web/src/sw.test.ts`
- `packages/web/src/api/notifications.test.ts`
- `packages/ui/src/hooks/useWebNotificationStream.test.ts`

Upstream tracking:

- https://github.com/openchamber/openchamber/issues/1459
- https://github.com/openchamber/openchamber/issues/1956
- https://github.com/openchamber/openchamber/pull/1957

Remove the downstream implementation only after upstream covers both existing-window focus and session deep-link data for push and foreground service-worker notifications. Keep the regression tests when removing duplicate implementation.

## Distribution update policy

The Web package must not run the official npm self-updater because that would replace this distribution with `@openchamber/web@latest` and remove downstream changes.

`packages/web/server/lib/distribution-policy.js` marks Web updates as externally managed. Updates arrive through reviewed merges from `openchamber/openchamber` and locally built packages.

Do not mirror upstream release tags or enable canonical publishing workflows in the fork.

Desktop packages use the repository identity embedded at build time. Packages built from `nekocon233/openchamber` update only from that fork. The fork release workflow publishes Desktop artifacts and updater manifests, but skips npm, mobile, Discord, and website publication.

Regression tests:

- `packages/web/bin/lib/commands-update.test.js`
- `packages/web/server/lib/opencode/openchamber-routes.test.js`
- `packages/electron/updater-feed.test.mjs`
- `packages/electron/scripts/finalize-latest-yml.test.mjs`

## Host-owned follow-up queue

Busy-session prompts configured for `queue` use OpenChamber's revisioned host queue. The queue captures text, attachments, structured context, agent mentions, and model selection at admission time. Claims prevent two clients from sending the same item. Failed sends release the claim, and session deletion creates a terminal tombstone so stale clients cannot revive the queue.

Web and Desktop use the host authority. VS Code reports the capability as unsupported and keeps its runtime-scoped local fallback. Direct OpenCode V2 queue delivery stays disabled so there is one queue owner.

Regression tests:

- `packages/web/server/lib/follow-up-queue/core.test.js`
- `packages/web/server/lib/follow-up-queue/routes.test.js`
- `packages/ui/src/stores/messageQueueStore.test.ts`
- `packages/ui/src/components/chat/ChatInput.queue.test.ts`

## Shared sidebar structure

Web, Desktop, hosted mobile, and Capacitor mobile share projects, project order, pins, worktree order, and session folders through the revisioned `sidebarState` API. Active selection, recency, collapse state, and other presentation choices remain device-local. VS Code keeps workspace-local structure.

Fetch failure is not an empty snapshot. Optimistic mutations roll back to the last authoritative revision, and the first complete startup snapshot establishes a baseline without deleting persisted session metadata.

## Managed FRPC tunnels

The fork includes a managed FRPC provider for TCP mappings and HTTP virtual hosts. Tunnel management is available only to direct local requests. Tokens, private endpoint paths, and temporary trust material never appear in public status responses or logs. FRPS certificates use the host trust store; there is no per-tunnel CA setting.

Regression tests live under `packages/web/server/lib/tunnels/` and `packages/web/bin/lib/cli-tunnel-*.test.js`.

## Session recovery and send safety

Session state keeps the downstream runtime, directory, session, and generation guards around asynchronous loads and mutations. Initial history expands to a complete turn boundary, legacy and V2 history cursors advance independently, and a failed source stays retryable without erasing records from the other source.

A prompt whose transport result is ambiguous is confirmed as `confirmed`, `not-found`, or `unknown`. An unreachable confirmation is not proof that the prompt failed. The optimistic message remains until a later authoritative check or the bounded timeout resolves it, and retries reuse the same message ID.

Before an ordinary existing-session send, an unavailable status probe blocks the send without consuming composer text or attachments.

## Session activity presentation

Individual running session rows use the shared rotating indicator and elapsed-time counter. Unread markers and collapsed project, folder, and group summaries remain static dots. Live activity comes from live events and authoritative status snapshots, never persisted message history.

## Trusted-device lifetime

Standard UI sessions expire after 12 hours. Sessions issued with `trustDevice: true` and their client tokens expire after a fixed, non-sliding 180 days. Cookie and client-token expiry must stay aligned.

Regression tests: `packages/web/server/lib/ui-auth/ui-auth.test.js`.

## Local Git integration

`docker-compose.yml` mounts `./data/gitconfig` at `/home/openchamber/.gitconfig` read-only. Do not commit the host file or broaden the mount to writable credentials.

Conflict continuation keeps the unsafe editor exception narrow. Rebase continuation uses only the fixed `GIT_EDITOR=true` no-op editor; merge continuation uses `git commit --no-edit` without an editor environment override.

Regression tests: `packages/web/server/lib/git/service.test.js`.

## OpenCode runtime requirement

OpenCode is an external runtime for the Web package. It is not vendored or patched by this fork.

- Minimum version for native GPT-5.6 reasoning variants: `1.17.19`
- Locally verified version: `1.18.3`
- Keep the OpenAI response-header timeout at 30 seconds while title generation has no reliable retry fallback.
- Do not restore an `agent.title` model override solely for this workaround.

The non-secret configuration requirement is:

```json
{
  "provider": {
    "openai": {
      "options": {
        "headerTimeout": 30000
      }
    }
  }
}
```

Never commit the complete user configuration, API keys, provider credentials, or tokens.

## Local development

Use `bun run dev` for normal Web HMR. The HMR flow intentionally unregisters service workers, so use `bun run dev:web:full` and refresh manually when validating PWA or notification-click behavior.

Run focused regression tests before deployment:

```bash
bun run --cwd packages/web test
bun test packages/ui/src/hooks/useWebNotificationStream.test.ts
```
