# Notifications Module Documentation

## Purpose
This module owns server-side notification preparation, trigger fanout, browser push subscription persistence, UI presence, and notification SSE delivery. Browser/PWA consumers live in the shared UI and web runtime, but their delivery and reconciliation rules are part of this contract.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/auth-runtime.js`: opaque notification-auth descriptors, authoritative validation, and auth invalidation fanout shared by SSE, Web Push, and APNs.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery. Two modes: **relay** (default — sign + POST tokens + generic text to the central Cloudflare relay `https://api.openchamber.dev/v1/push/send`, which holds the single project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
- `packages/web/server/lib/notifications/message.js`: helper implementation module.
- `packages/web/server/lib/notifications/message.test.js`: unit tests for notification message helpers.

## Public exports

### Notifications API (re-exported from message.js)
- `truncateNotificationText(text, maxLength)`: Truncates text to specified max length, appending `...` if truncated.
- `prepareNotificationLastMessage({ message, settings })`: Prepares the last message for notification display by normalizing and truncating text.

### Route registration API (routes.js)
- `registerNotificationRoutes(app, dependencies)`: Registers notification-owned endpoints:
  - `GET /api/push/vapid-public-key`
  - `POST /api/push/subscribe`
  - `DELETE /api/push/subscribe`
  - `POST /api/push/apns-token` (native iOS APNs device-token registration)
  - `DELETE /api/push/apns-token`
  - `POST /api/push/visibility`
  - `GET /api/push/visibility`
  - `GET /api/notifications/stream`
  - `GET /api/session-activity`
  - `GET /api/sessions/snapshot`
  - `GET /api/sessions/status`
  - `GET /api/sessions/:id/status`
  - `GET /api/sessions/attention`
  - `GET /api/sessions/:id/attention`
  - `POST /api/sessions/:id/view`
  - `POST /api/sessions/:id/unview`
  - `POST /api/sessions/:id/message-sent`

### Trigger runtime API (runtime.js)
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned debounced trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload, directoryHint?)` — the global event envelope directory is authoritative and takes precedence over payload heuristics.
- Owns:
  - completion/error/question/permission trigger routing; permission suppression consults the authoritative permission-auto-accept runtime
  - authoritative envelope-directory propagation into session enrichment fetches and Web/PWA navigation targets
  - session parent cache for subtask suppression
  - template resolution and fallback behavior
  - native notification fanout and web push payload fanout
  - push suppression while any fresh UI visibility heartbeat reports a focused client

### Push runtime API (push-runtime.js)
- `createPushRuntime(dependencies)`: creates runtime for web push and UI visibility state.
- Returned API:
  - `getOrCreateVapidKeys()`
  - `ensurePushInitialized()`
  - `setPushInitialized(value)`
  - `addOrUpdatePushSubscription(notificationAuth, subscription, userAgent)`
  - `removePushSubscription(notificationAuthOrSelector, endpoint?)` — omitting the endpoint removes every registration for an invalidated identity or auth kind.
  - `sendPushToAllUiSessions(payload, options?)`
  - `updateUiVisibility(notificationAuth, visible)`
  - `isAnyUiVisible()`
  - `isUiVisible(token)`

### Web notification click behavior
- Push and foreground service-worker notifications carry the session ID, owning directory when known, and a same-origin `/?session=...` deep link.
- Clicking a notification prefers an existing focused or visible Web/PWA window, navigates it to the target session, and focuses it.
- For targeted notifications, the service worker posts a typed intent to ordered top-level app clients. The acknowledgement reports whether a client is an installed PWA. Chromium permits one window-interaction operation per notification click, so an installed PWA uses `clients.openWindow()` once (allowing Windows to route through the app launcher), while a browser tab uses `WindowClient.focus()`. The PWA manifest declares `launch_handler.client_mode = navigate-existing`, so launcher requests reuse and navigate the active PWA window instead of creating another desktop window. If an acknowledged browser client closes before focus, the unchanged target is retried against the next existing client and finally opened once. Missing acknowledgements open the complete target once; acknowledgements from older clients without display-mode metadata take the launcher-safe path, and legacy clients without messaging are navigated before focus. The in-app deep-link handler resolves the owning directory, closes obstructing settings/mobile surfaces, and switches to chat without guessing the current directory.
- Native APNs keeps its relay payload opaque (`sessionId` only). On tap, the app refreshes the authenticated global session index before selecting an otherwise unknown session, rather than exposing a filesystem directory through the relay.
- A new window is opened only when no existing window can be focused.
- Legacy notifications without `data` recover the session ID from `ready-`, `error-`, `question-`, `permission-`, and `goal-` tags.
- Notifications without a session target focus an existing app directly. They do not post an empty navigation intent or launch `/` into an installed PWA, so the current session remains selected.
- If persistent service-worker delivery is unavailable, the main-thread `Notification` fallback installs its own click handler to focus and navigate the live page; it does not rely on `notificationclick`.

### Browser/PWA delivery invariants
- A push event is suppressed only when the service worker observes an actually focused top-level window client. A visible but unfocused window must not consume the push, while a focused client remains authoritative even if its visibility state is stale or hidden.
- A browser `PushSubscription` is local to the service-worker scope, not proof that the active OpenChamber runtime has registered it. Both desktop and hosted-mobile browser surfaces reconcile an existing subscription on startup and every runtime switch, replacing it when the active runtime uses a different VAPID key. If a browser omits `subscription.options.applicationServerKey`, an existing subscription with unknown provenance is preserved. Successfully resolved non-secret VAPID provenance is persisted in runtime-scoped browser storage, so renderer reloads, runtime switches, and same-runtime key rotation replace an incompatible subscription once without repeated unsubscribe/subscribe churn. Malformed or old provenance records are ignored. Capacitor mobile remains APNs/FCM-only and does not run browser-push reconciliation.
- A null, empty, malformed, or failed VAPID-key lookup is non-authoritative and never removes an existing browser subscription. Replacement happens only after a successfully decoded key proves incompatibility.
- Disabling browser push removes the server registration only after `PushSubscription.unsubscribe()` resolves `true`. A false result or exception leaves the server record intact, reconciles the still-active browser subscription, and reports failure. If local removal succeeds but server cleanup fails, local state remains authoritatively disabled and the UI reports the partial failure.
- SSE-driven local delivery is suppressed in favor of push only after the current runtime acknowledges registration of the current endpoint. Missing, stale, or failed registration leaves local delivery eligible.
- The notification stream uses `runtimeFetch('/api/notifications/stream')`, so direct, authenticated remote, desktop proxy, and private-relay transports share the same path. Same-origin browser requests use their UI cookie, private-relay clients must carry their client bearer, and managed tunnel sessions use their authenticated tunnel cookie; no long-lived credential is added to the stream URL. The ready event contains no auth identity. The client aborts it on runtime changes, requires the ready event before treating a connection as healthy, detects missed heartbeats, and reconnects with bounded exponential backoff. Hidden, offline, and permanent-client-error retries use the long backoff tier and wake early when connectivity or visibility returns.
- Web Push and APNs persistence version 2 groups registrations under opaque `notify:*` identities and stores only non-auth auth metadata (kind, expiry, and client id where applicable). Known legacy version 1 stores, whose keys may contain raw UI JWTs or tunnel session ids, are sanitized and not delivered. Unknown future versions fail closed without delivery or mutation, preserving the file for a newer runtime. Browser startup reconciliation or native token registration repopulates valid records.
- UI auth reset, remote-client revocation, and tunnel-session revoke/expiry invalidate the same opaque association. Existing notification SSE responses are ended immediately, listeners/timers are removed, and matching Web Push/APNs records are removed. Notification SSE validates before joining broadcast fanout and treats inactive, unknown, and validation errors as closed; delivery revalidates each remaining push identity, removes authoritative inactivity, and suppresses transient unknown results without deleting unrelated registrations.
- Passwordless UI-session associations use a process generation and fail closed across restart. Password-protected associations are bound to the JWT secret and password policy, so enabling or changing a password invalidates passwordless/old-policy registrations.
- A successful settings load is authoritative for notification fields. Missing fields use the runtime defaults (`hidden-only` delivery policy, notifications disabled, event toggles enabled, and empty custom templates) rather than retaining another runtime's values. A failed settings load remains distinct and is not treated as an authoritative empty result.
- Test notifications include the selected real session ID and its directory when one exists. Without a selected session they intentionally carry no navigation target.

### APNs runtime API (apns-runtime.js)
- `createApnsRuntime(dependencies)`: creates runtime for native iOS APNs push and device-token state. Dependencies: `fsPromises`, `path`, `crypto`, `http2`, `APNS_TOKENS_FILE_PATH`, `readSettingsFromDiskMigrated`, `writeSettingsToDisk` (persists the auto-generated relay signing keypair).
- Returned API:
  - `addOrUpdateApnsToken(notificationAuth, deviceToken, userAgent)` — also binds a newly-seen token on the relay (signed `/v1/push/register-token`).
  - `removeApnsToken(notificationAuthOrSelector, deviceToken?)`
  - `removeApnsTokenFromAllSessions(deviceToken)`
  - `sendApnsToAllUiSessions(payload)` — signs + sends to all registered tokens (no UI-visibility gate; iOS suppresses the foreground banner). No-ops with a single warning when APNs is unconfigured. Drops tokens on `410` / `BadDeviceToken` / `Unregistered`.
  - `resolveApnsConfig()`
- Configuration (env first, then `settings.apnsConfig`): `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8` (PEM contents; literal `\n` accepted) or `OPENCHAMBER_APNS_P8_PATH`, `OPENCHAMBER_APNS_BUNDLE_ID` (default `com.openchamber.app`), `OPENCHAMBER_APNS_ENVIRONMENT` (`sandbox` default, or `production`).

### Emitter runtime API (emitter-runtime.js)
- `createNotificationEmitterRuntime(dependencies)`: creates runtime for unified notification emission channels.
- Returned API:
  - `writeSseEvent(res, payload)`
  - `emitDesktopNotification(payload)`
  - `broadcastUiNotification(payload)`

### Template runtime API (template-runtime.js)
- `createNotificationTemplateRuntime(dependencies)`: creates shared notification/template runtime. Model-backed summarization was retired after the Zen provider became unavailable.
- Returned API:
  - `resolveNotificationTemplate(template, variables)`
  - `shouldApplyResolvedTemplateMessage(template, resolved, variables)`
  - `fetchFreeZenModels()` compatibility stub returning `[]`
  - `resolveZenModel(override)` compatibility stub preserving stored values without validation
  - `validateZenModelAtStartup()` compatibility no-op
  - `summarizeText(text, targetLength, zenModel)` compatibility stub returning local fallback text
  - `extractLastMessageText(payload, maxLength?)`
  - `fetchLastAssistantMessageText(sessionId, messageId, maxLength?, directory?)`
  - `maybeCacheSessionInfoFromEvent(payload)`
  - `buildTemplateVariables(payload, sessionId, directoryHint?)`
  - `getCachedZenModels()`

## Constants

### Default values
- `DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH`: 250 (default max length for notification text).
- `NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS`: 20000 (notification SSE comment heartbeat interval).

## Settings object format

The `settings` parameter for `prepareNotificationLastMessage` supports `maxLastMessageLength` (number), the maximum length for the final notification text (default: 250). Legacy summarization settings may still exist in persisted settings but are ignored.

## Response contracts

### `truncateNotificationText`
- Returns empty string for non-string input.
- Returns original text if under max length.
- Returns `${text.slice(0, maxLength)}...` for truncated text.

### `prepareNotificationLastMessage`
- Returns empty string for empty/null message.
- Returns truncated original message. Model-backed notification summarization is retired.
- Normalizes markdown-like formatting to plain text before truncation.
- Always applies `maxLastMessageLength` truncation to final result.

## Notes for contributors

### Adding new notification helpers
1. Add new helper functions to `packages/web/server/lib/notifications/message.js`.
2. Export functions that are intended for public use.
3. Follow existing patterns for input validation (e.g., type checking for strings).
4. Use `resolvePositiveNumber` for numeric parameters with fallbacks to maintain safe defaults.
5. Add corresponding unit tests in `packages/web/server/lib/notifications/message.test.js`.

### Error handling
- `prepareNotificationLastMessage` does not call model summarization.
- Invalid numeric parameters default to safe fallback values.
- Non-string inputs are handled gracefully (return empty string).

### Testing
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
- Unit tests should cover truncation behavior and edge cases (empty strings, invalid inputs).
