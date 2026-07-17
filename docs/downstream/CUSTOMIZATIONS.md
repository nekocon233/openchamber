# Downstream Customizations

This repository is the `nekocon233/openchamber` downstream distribution. Keep downstream behavior in focused commits and preserve it through reviewed upstream merge pull requests.

## Web Notification Navigation

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

## Distribution Update Policy

The Web package must not run the official npm self-updater because that would replace this distribution with `@openchamber/web@latest` and remove downstream changes.

`packages/web/server/lib/distribution-policy.js` marks Web updates as externally managed. Updates arrive through `.github/workflows/upstream-sync.yml`, reviewed pull requests, and a locally built package.

Do not mirror upstream release tags or enable canonical publishing workflows in the fork.

## OpenCode Runtime Requirement

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

## Local Development

Use `bun run dev` for normal Web HMR. The HMR flow intentionally unregisters service workers, so use `bun run dev:web:full` and refresh manually when validating PWA or notification-click behavior.

Run focused regression tests before deployment:

```bash
bun run --cwd packages/web test
bun test packages/ui/src/hooks/useWebNotificationStream.test.ts
```
