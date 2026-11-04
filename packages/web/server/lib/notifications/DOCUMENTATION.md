# Notifications Module Documentation

## Purpose
This module owns server-side notification preparation, trigger fanout, browser push subscription persistence, UI presence, and notification SSE delivery. Browser/PWA consumers live in the shared UI and web runtime, but their delivery and reconciliation rules are part of this contract.

## Entrypoints and structure
- `packages/web/server/lib/notifications/index.js`: public entrypoint imported by `packages/web/server/index.js`.
- `packages/web/server/lib/notifications/routes.js`: route registration for push, visibility, and session status/attention endpoints.
- `packages/web/server/lib/notifications/auth-runtime.js`: opaque notification-auth descriptors, authoritative validation, and auth invalidation fanout shared by SSE, Web Push, and APNs.
- `packages/web/server/lib/notifications/push-runtime.js`: push subscription persistence, VAPID initialization, and UI visibility runtime.
- `packages/web/server/lib/notifications/push-seal.js`: end-to-end sealing of native push text. A phone that registers with a `pushKey` (32 bytes, base64; made by the iOS shell in the App Group, by Android's `PushSealKey`) gets each notification as the generic scenario title, an empty body and `data.enc` = `v1.` + base64(nonce || AES-256-GCM ciphertext || tag) of `{ title, body }`. Each such device is its own relay send. The iOS Notification Service Extension and Android's `SealedPushMessagingService` open it; the relay sends a sealed push to Android as a data message (openchamber-website `apps/api/src/lib/fcm.ts`) so that service runs in the background. The sealed text is richer than the clear one: `runtime.js` passes `sealed` = the session name as title and what happened as body (the agent's reply; `Question:`, `Wants to run:` / `Wants to edit:` / `Wants to read:` / `Wants permission:`, `Error:` or the goal title before the detail), capped at 250 characters. When there is no such text, the phone opens the generic text. Phones without a key keep getting the generic text in the clear. Enterprise mode sends no `sealed` text and strips the session name, so the phone shows only the scenario title.
- `packages/web/server/lib/notifications/session-key.js`: hashes a UI session token into the `sha256:` key form. The push stores no longer group by it — they group by the opaque notification-auth identity, whose UI-session kind is already a digest (`auth-runtime.js`) — so the module is now only exercised by its own test. Both stores are written `0600`, and a `version: 1` file is wiped on read rather than migrated.
- `packages/web/server/lib/notifications/apns-runtime.js`: native iOS APNs device-token persistence + delivery. Two modes: **relay** (default — sign + POST tokens + generic text to the central Cloudflare relay `https://api.openchamber.dev/v1/push/send`, which holds the single project APNs key) and **direct** (fallback — sign ES256 JWT with Node crypto + HTTP/2, when `OPENCHAMBER_PUSH_RELAY_DISABLED=true`). Each server has an auto-generated ECDSA P-256 keypair (`getOrCreateRelayKeypair`, persisted in settings); it binds tokens on the relay (`/v1/push/register-token`) and signs every relay request, so the relay only delivers to tokens bound to that server. APNs is the native app's sole notification channel (no local notifications) and is NOT gated on UI visibility — iOS suppresses the foreground banner instead. Mobile push carries only generic text (scenario title + session name) — see `APNS.md`. In enterprise mode (`../enterprise-mode.js`) `fanoutPush` also drops the session name from APNs and sends web push with the scenario title, an empty body and the deep link only, since web push leaves through the browser vendor's push service. Desktop notifications and in-app toasts stay local and keep the full text.
- `packages/web/server/lib/notifications/emitter-runtime.js`: desktop/stdout + UI SSE notification emission runtime.
- `packages/web/server/lib/notifications/emit-route.js`: `POST /api/notifications/emit` for OpenCode plugins.
- `packages/web/server/lib/notifications/runtime.js`: trigger runtime for OpenCode event-driven notification fanout.
- `packages/web/server/lib/notifications/template-runtime.js`: notification template variables and session text/title enrichment runtime. Zen-model helpers are retained as compatibility stubs only.
- `packages/web/server/lib/notifications/template-locales.js`: the notification text OpenChamber writes itself, per interface language. An empty template field means "no custom text", so the notification uses these defaults and the settings page shows them as placeholders. `settings-runtime.js` no longer seeds English template text into an install; it clears the seed older builds wrote. The server keeps its own list because it cannot import `packages/ui`; an unknown tag falls back to English.
- `packages/web/server/lib/notifications/extension-channels.js`: extension notification channels (`provides: ["notifications"]`), see *Extension notification channels* below. `channel-accounts.js` is their account store, `channel-routes.js` the account card's routes.
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
  - `POST /api/sessions/:id/view` and `POST /api/sessions/:id/message-sent`: only reset the native push badge. Whether a session is unread is OpenCode's own `time.viewed`.

### Trigger runtime API (runtime.js)

`notifyPullRequest({ item, event })` delivers user merge-follow events through the same native, UI, web-push, APNs and extension-channel fanout. `notifyOnPullRequests` is a profile setting, default on, independent of completion/error notifications. It is checked on the server before every delivery. Fixed event titles follow the interface locale (`pull-request-locales.js`); the body names the repository and PR number. Enterprise-mode push and extension deliveries strip that reference through the existing fanout boundary. Notifications have kind `pull-request`, no session id, and never wake an agent. Existing click routing accepts sessions only, so these notifications currently bring the app forward without selecting a PR.
- `createNotificationTriggerRuntime(dependencies)`: creates runtime-owned debounced trigger handling for OpenCode events.
- Returned API:
  - `maybeSendPushForTrigger(payload, directoryHint?)` — the global event envelope directory is authoritative and takes precedence over payload heuristics.
- Owns:
  - completion/error/question/permission trigger routing; permission suppression consults the authoritative permission-auto-accept runtime
  - authoritative envelope-directory propagation into session enrichment fetches and Web/PWA navigation targets
  - session parent cache for subtask suppression. The parent is read through `readSessionRecord`, so a native CLI session's parent comes from the injected `nativeSessions.getSession` (OpenCode refuses native ids); only a positively known parent suppresses — an unreadable parent announces as before
  - per-turn ready suppression while a session's goal is active, reading a native CLI session through the injected `nativeSessions`
  - no ready notification on a `session.idle` while a subagent of that session is still running (a background-subagent pause; OpenCode runs the parent again with the result and its next idle announces). The check comes from `../opencode/session-activity.js`; when it cannot be made, the idle announces as before
  - an MCP elicitation form (session id `global`, owned by no session) notifies without a session: no session title lookup, and the deep link opens the app
  - template resolution and fallback behavior: an empty field in `settings.notificationTemplates` resolves to the default for `settings.locale` (`template-locales.js`), so notification text follows the interface language unless the user wrote their own
  - native notification fanout and web push payload fanout
  - push suppression while any fresh UI visibility heartbeat reports a focused client
  - no ready notification for a turn that is a step of an auto-review (`isInAutoReview`, answered by `../auto-review`'s `speaksFor`); `notifyAutoReviewEnded` sends the review's one notification when it ends, under the completion toggle, with `review*` texts from `template-locales.js` and APNs type `review`
  - extension notification channels: `deliverToExtensionChannels({ notification, requireHidden })` is called where push is (`sendToChannels`), with the text push gets and the enterprise stripping push applies; see *Extension notification channels* below
  - chats of isolated spaces: `maybeSendPushForTrigger(payload, { spaceId })` reads such a chat's record (title, parent, goal), its last reply and its running subagents inside the space, through `spaceFetchFor(spaceId)`, a `fetch` over the spaces dispatcher (`../spaces/space-fetch.js`), and never asks the host's OpenCode or the host's permission policy about it, since neither knows the chat. What comes back is the space's text, shown as it is shown in the sidebar. A space that cannot be asked gives the generic text, as a host chat whose reads fail does. The host's auto-accept is not consulted for a space's permission request, so such a request notifies after the debounce unless its reply arrives first.

### Extension notification channels (extension-channels.js, channel-accounts.js, channel-routes.js)

An installed extension whose service provides `notifications` (SDK `contributes.notifications`) is a delivery channel next to the desktop and the phone. `createExtensionNotificationChannels` owns which channels exist, their accounts and the delivery; `index.js` builds one, hands its `deliver` to `createNotificationTriggerRuntime` as `deliverToExtensionChannels`, and passes it to `feature-routes-runtime.js`, which registers the routes, reconciles it at start and from the guest activation and deactivation listeners.

- The catalog is the authority (`isNotificationChannelGuest`: enabled, fully approved with an effective `service` grant, the role and a parsed contribution). Approving the extension and connecting an account is the switch; pausing it is the off; nothing on the Notifications page refers to a channel. `reconcile()` runs serialized and revokes the handles of a guest that left.
- Accounts are OpenChamber's: one per channel in `{dataDir}/notification-channels.json` (`0o600`, temp file and rename, writes chained per file; a corrupt file is an error, never a disconnected channel). The token leaves the store only to mint a handle. `connect` probes a typed instance (`auth.probe`), verifies the token through the service (`auth.verify`, the handle carries the candidate token) and stores what the server said the account is; connecting again replaces the account. A `user` instance is an https origin or http on this machine; `fixed` is the contribution's origin. A `basic` username must be one the handle minter can send (`isProviderUsername`), refused as 400 `USERNAME_INVALID` before any call. When an update moves a `fixed` channel's server, `reconcile` writes the account off (`invalidReason: 'instance-changed'`) and `deliver` sends nothing to it: the token was given for the old server, and the card asks the user to connect again.
- Every call to the service carries a fresh handle from `../source-control/outbound-handles.js`, bound to the account's origin and token, served on `/notifications/outbound` by the callback listener; the service never holds a token. A `status: 401` writes the account off only when the proxy saw the server answer 401 through that handle; the card then says the account needs attention, and the channel is skipped until the user connects again.
- `deliver({ notification, requireHidden })` is called by `runtime.js` (`sendToChannels`) beside `fanoutPush`, after the kind's toggle, the debounces and the subagent, goal and auto-review suppressions, with the text push gets: in enterprise mode the kind's generic title (`message.js` `genericNotificationTitle`), no body, no session name, no directory, since the channel's server is outside the boundary. The channel rechecks enterprise mode immediately before forwarding, so a policy enabled during a queued call strips that call's content too. The module applies the visibility gate itself (`isAnyUiVisible`, unless `notificationMode` is `always`): the Electron focus gate the desktop branch reads does not exist on web. Delivery is at most once; a failed `notify` is warned once a minute per channel and never retried. Nothing here logs a notification's text.
- Routes: `GET /api/notifications/channels`, `PUT /api/notifications/channels/:providerId/account` (`{ token, username?, instance? }`), `DELETE /api/notifications/channels/:providerId/account`; failures are `{ error, code }` with the module's status (404 `CHANNEL_UNKNOWN`, 400 `TOKEN_REQUIRED` / `USERNAME_REQUIRED` / `USERNAME_INVALID` / `INSTANCE_REQUIRED` / `UNSUPPORTED_INSTANCE`, 401 `TOKEN_REFUSED`, 409 `CONNECT_SUPERSEDED`, 503 `CHANNEL_UNAVAILABLE` / `CHANNEL_BUSY`, 502 `MALFORMED_PROVIDER_RESPONSE`). No answer carries a token.

#### Why account changes use compare-and-set

A Connect captures a per-channel operation identity before verification. Disconnect invalidates that identity even when no account exists, and the store checks it under its write lock before committing. Each stored connection also has a random revision, so a delayed invalidation compares the original account under the same lock and cannot mark a replacement invalid. Older records without a revision remain readable and acquire one on their next connection.

#### Why calls share a bounded channel queue

The SDK promises one notification-role call at a time, including authentication. Each channel serializes at most 200 outstanding calls; newer notifications are dropped with a rate-limited warning and Connect receives a busy error. Deactivation aborts the channel's active request, drops queued calls and revokes handles. Queued notifications recheck visibility and read the current account when their call starts.

#### Why the channel's accounts have their own store and not the source-control auth store

That store models forge users (an integer `id`, `origin#id` identities, Git transport credentials) in `source-control-auth.json`, and a package providing both roles would share one `ext-<id>` section. A channel's account is a string id with one token; a store of its own keeps the shapes honest and removal independent.

#### Why delivery is gated on `isAnyUiVisible` here and not on the trigger runtime's focus check

The desktop branches read `getIsWindowFocused`, which only the Electron shell sets; on web the gate lives inside `fanoutPush` (`isAnyInteractiveClientVisible`) and inside web push (`requireNoSse`). A channel hooked after `fanoutPush` would therefore deliver on web while the user reads the answer. The module reads the push runtime's visibility itself, so a channel behaves like push on every runtime.

### Revoked and expired clients (client-push-access.js)

A registration made with a paired client's token sits under `clientSessionKeyFor(id)`. Two things keep notifications off a client that is no longer valid:

- Revoking a client, and clearing revoked clients from the list, removes the client's devices from both stores (`removeDevicesOfClients`). A failure while revoking is a log line, because the revocation is already written and the settings page acts on its success. The send check below still skips the client's own key, but a device also registered under another key keeps receiving through it until the client is cleared. Clearing removes the devices before the rows go, so a failure there keeps the rows, answers with an error the settings page shows, and can be retried.
- Every send skips the keys of revoked and expired clients in the list (`invalidSessionKeys`). When the list cannot be read the send fails with a log line and nothing goes out.

A valid client's device, a cookie session's device, and a phone that pairs again after being revoked keep or regain their notifications. The phone app registers again each time it connects with a token the server accepts. A browser subscribes only from the switch on the Notifications page, so a browser removed along with a revoked client gets no web push until that switch is turned off and on.

A registration whose client row is gone cannot be stopped. Its key is a hash of an id that no longer exists, and it looks exactly like a cookie session's key, so the send has to deliver to it. That covers a row an older build cleared, and a row replaced by pairing again when the phone's registration under the new client never reached the server. A client revoked by an older build whose device is also registered under a cookie session keeps delivering through that key until the client is cleared from the list.

A server with no UI password accepts requests without any credential, so a revoked token does not lock the phone out: its next registration succeeds as a new cookie session and notifications resume. Revocation on such a server does not cut the device's API access either, and that is `../ui-auth`'s to change.

#### Why a device leaves every key and not only the client's own

Sends deduplicate by device, so a phone that signed in with a cookie session before it paired would keep receiving through the older key. A key of another valid client stays: that pairing still authenticates, and removing its entry would silence a valid device until its next launch. A cookie session's key cannot be told from a stale one, so it goes; a phone whose cookie session is still valid registers again when it next connects, and a browser through its Notifications switch.

#### Why a send fails when the client list cannot be read

Delivery is at most once already (`APNS.md`, *When the relay cannot be reached*), and an unreadable list must not read as "nobody was revoked". One lost notification with a log line costs less than a revoked phone getting the text.

#### Why nothing is unbound on the relay

The relay has no route for it, and sends only ever start from this server's list, so removing the local record stops delivery. The token stays bound to this server, which is what lets the same phone register again after it pairs.

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
- For targeted notifications, the service worker posts a typed intent to ordered top-level app clients. Before acknowledging, the page synchronously persists a valid session target and applies it in memory. The acknowledgement also reports whether the client is an installed PWA. Installed PWAs then use `clients.openWindow()` so Windows and other platforms route through the app launcher; because the target is already durable, a `navigate-existing` reload restores that session instead of opening a new-session draft. If the launcher returns no window, the acknowledged client is focused directly. Browser tabs focus in place. Missing or rejected acknowledgements navigate an existing client to the complete target before focusing it; failed clients are retried in order and the target is finally opened once. Acknowledgements from older clients without acceptance or display-mode metadata remain launcher-safe during upgrades. The in-app deep-link handler resolves the owning directory, closes obstructing settings/mobile surfaces, and switches to chat without guessing the current directory.
- Native APNs keeps its relay payload opaque (`sessionId` only). On tap, the app refreshes the authenticated global session index before selecting an otherwise unknown session, rather than exposing a filesystem directory through the relay.
- Targetless notifications open a new window only when no existing window can be focused. Targeted installed-PWA clicks use the app launcher after their session target has been persisted.
- Legacy notifications without `data` recover the session ID from `ready-`, `error-`, `question-`, `permission-`, and `goal-` tags.
- Notifications without a session target focus an existing app directly. They do not post an empty navigation intent or launch `/` into an installed PWA, so the current session remains selected.
- If persistent service-worker delivery is unavailable, the main-thread `Notification` fallback installs its own click handler to focus and navigate the live page; it does not rely on `notificationclick`.

### Browser/PWA delivery invariants
- The production web entry registers the Service Worker based on Vite's `production` mode, not ambient `NODE_ENV`. A shell or process manager exporting `NODE_ENV=development` must not make `vite build` emit development cleanup that unregisters the production PWA.
- A push event is suppressed only when the service worker observes an actually focused top-level window client. A visible but unfocused window must not consume the push, while a focused client remains authoritative even if its visibility state is stale or hidden.
- A browser `PushSubscription` is local to the service-worker scope, not proof that the active OpenChamber runtime has registered it. Both desktop and hosted-mobile browser surfaces reconcile an existing subscription on startup, every runtime switch, and each shared control-stream `event-stream-ready` announcement, including reconnection to a restarted server at the same endpoint. Reconnection invalidates the previous acknowledgement; push is confirmed only after the active server accepts the registration. Signals during a same-runtime request coalesce into one follow-up, while a runtime switch starts recovery without waiting for the previous server. Stopped watchers discard pending work and late results. These subscribers share the existing control stream and add no polling or connection. Recovery does not request notification permission or create a first subscription for a user who has not enabled push. Electron, VS Code, and Capacitor do not run browser-push reconciliation.
- Reconciliation replaces a browser subscription when the active runtime uses a different VAPID key. If a browser omits `subscription.options.applicationServerKey`, an existing subscription with unknown provenance is preserved. Successfully resolved non-secret VAPID provenance is persisted in runtime-scoped browser storage, so renderer reloads, runtime switches, and same-runtime key rotation replace an incompatible subscription once without repeated unsubscribe/subscribe churn. Malformed or old provenance records are ignored.
- A null, empty, malformed, or failed VAPID-key lookup is non-authoritative and never removes an existing browser subscription. Replacement happens only after a successfully decoded key proves incompatibility.
- Disabling browser push removes the server registration only after `PushSubscription.unsubscribe()` resolves `true`. A false result or exception leaves the server record intact, reconciles the still-active browser subscription, and reports failure. If local removal succeeds but server cleanup fails, local state remains authoritatively disabled and the UI reports the partial failure.
- SSE-driven local delivery is suppressed in favor of push only after the current runtime acknowledges registration of the current endpoint. Missing, stale, or failed registration leaves local delivery eligible.
- The notification stream uses `runtimeFetch('/api/notifications/stream')`, so direct, authenticated remote, desktop proxy, and private-relay transports share the same path. Same-origin browser requests use their UI cookie, private-relay clients must carry their client bearer, and managed tunnel sessions use their authenticated tunnel cookie; no long-lived credential is added to the stream URL. Every Electron renderer consumes this stream, including Mini Chat. The main window suppresses only payloads marked as already delivered by its local in-process desktop server; notifications from a remote runtime still dispatch through the local Electron notification API, while Mini Chat opens a state-only stream and never duplicates notification delivery. The ready event contains no auth identity. The client aborts it on runtime changes, binds callbacks to the source runtime generation, requires the ready event before treating a connection as healthy, detects missed heartbeats, and reconnects with bounded exponential backoff. Hidden, offline, and permanent-client-error retries use the long backoff tier and wake early when connectivity or visibility returns.
- Web Push and APNs persistence version 2 groups registrations under opaque `notify:*` identities and stores only non-auth auth metadata (kind, expiry, and client id where applicable). Known legacy version 1 stores, whose keys may contain raw UI JWTs or tunnel session ids, are sanitized and not delivered. Unknown future versions fail closed without delivery or mutation, preserving the file for a newer runtime. Browser startup reconciliation or native token registration repopulates valid records.
- UI auth reset, remote-client revocation, and tunnel-session revoke/expiry invalidate the same opaque association. Existing notification SSE responses are ended immediately, listeners/timers are removed, and matching Web Push/APNs records are removed. Notification SSE validates before joining broadcast fanout and treats inactive, unknown, and validation errors as closed; delivery revalidates each remaining push identity, removes authoritative inactivity, and suppresses transient unknown results without deleting unrelated registrations.
- Passwordless UI-session associations use a process generation and fail closed across restart. An opted-in browser automatically registers its existing subscription when it reconnects; a closed browser must reconnect before its registration can recover. Password-protected associations are bound to the JWT secret and password policy, so enabling or changing a password invalidates passwordless/old-policy registrations.
- A successful settings load is authoritative for notification fields. Missing fields use the runtime defaults (`hidden-only` delivery policy, notifications disabled, event toggles enabled, and empty custom templates) rather than retaining another runtime's values. A failed settings load remains distinct and is not treated as an authoritative empty result.
- Test notifications include the selected real session ID and its directory when one exists. Without a selected session they intentionally carry no navigation target.

### APNs runtime API (apns-runtime.js)
- `createApnsRuntime(dependencies)`: creates runtime for native iOS APNs push and device-token state. Dependencies: `fsPromises`, `path`, `crypto`, `http2`, `APNS_TOKENS_FILE_PATH`, `readSettingsFromDiskMigrated`, `writeSettingsToDisk` (persists the auto-generated relay signing keypair).
- Returned API:
  - `addOrUpdateApnsToken(notificationAuth, deviceToken, userAgent, platform, environment)` — also binds a newly-seen token on the relay (signed `/v1/push/register-token`). `environment` is the APNs environment the token was minted for (`sandbox` for Xcode/dev-signed installs, `production` otherwise — reported by the client at registration); delivery groups tokens by it.
  - `removeApnsToken(notificationAuthOrSelector, deviceToken?)`
  - `removeApnsTokenFromAllSessions(deviceToken)`
  - `removeApnsDevicesOfSessions(sessionKeys, keep)`
  - `sendApnsToAllUiSessions(payload)` — `payload.sealed` (`{ title, body }`, optional) is what a phone with a push key opens; it is never sent in the clear. Signs + sends to all registered tokens (no UI-visibility gate; iOS suppresses the foreground banner). No-ops with a single warning when APNs is unconfigured. Drops tokens on `410` / `BadDeviceToken` / `Unregistered`. Relay sends run in parallel, each limited to 15 s and sent once more only when the request never left this machine, since the relay does not deduplicate (`APNS.md`, *When the relay cannot be reached*).
  - `resolveApnsConfig()`
- Configuration (env first, then `settings.apnsConfig`): `OPENCHAMBER_APNS_KEY_ID`, `OPENCHAMBER_APNS_TEAM_ID`, `OPENCHAMBER_APNS_P8` (PEM contents; literal `\n` accepted) or `OPENCHAMBER_APNS_P8_PATH`, `OPENCHAMBER_APNS_BUNDLE_ID` (default `com.openchamber.app`), `OPENCHAMBER_APNS_ENVIRONMENT` (optional override forcing every send to `sandbox` or `production`; when unset, each token is delivered to the environment it registered with, defaulting to `production` for tokens without one).

### Emitter runtime API (emitter-runtime.js)
- `createNotificationEmitterRuntime(dependencies)`: creates runtime for unified notification emission channels.
- Returned API:
   - `writeSseEvent(res, payload, serializedPayload?)`, where broadcast callers may share one JSON encoding across recipients
  - `emitDesktopNotification(payload)`
  - `broadcastUiNotification(payload)`

### Plugin notification route (emit-route.js)
- `createPluginNotificationEmitter(dependencies)` owns validation, the rate window and delivery; one instance is shared by the HTTP route and the `openchamber_notify` agent tool (`notify.send`).
- `registerNotificationEmitRoutes(app, dependencies)` returns `registerPluginRoute()` and `registerApiRoute()`. Bootstrap calls the first before API auth and the second after it.
- Callers: a plugin in the managed OpenCode (agent-tool bearer token, the only reason for the pre-auth registration) or any client that passes regular API auth. No other auth path exists.
- Body `{ title?, body?, tag?, sessionId?, directory?, showWhenFocused? }`, at least one of title/body; title ≤120, body ≤500 chars, 16kb JSON. `kind` is always `plugin` so callers cannot trigger kinds the UI treats specially.
- One shared rate window: 10 notifications per 10s, then 429 with `Retry-After`.
- Follows `nativeNotificationsEnabled` (returns `{ delivered: false }`) and `notificationMode`; focused plugin notices use an in-app info toast, while OS/browser notifications stay hidden until the window is not focused. `showWhenFocused: true` opts into the focused toast. Live delivery only: no web push or APNs fanout.
- Advertised as the `api.notifications.emit.v1` server capability.

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
- Native CLI sessions (`ncl_`/`ncx_` ids) are not in OpenCode. With the
  `nativeSessions` dependency (`isNativeSessionId`, `getSession`,
  `loadMessages`, backed by the native agents runtime), their title and last
  reply come from the native runtime, which needs the notification's
  directory; without a directory they get neither.

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

### Why interruption suppression is limited to steps

OpenCode uses `aborted` for both interrupted steps and exhausted auto-resume attempts. Only the step event identifies the interruption this filter suppresses; filtering terminal `session.error` events by that type would hide a failure that requires the user's attention.

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

## Browser event delivery

Web notifications subscribe to the shared `/api/openchamber/events` control
stream. The emitter sends each notification there and through the existing
global broadcaster. The broadcaster owns the main WebSocket and the legacy
`/api/notifications/stream` endpoint, which remains available to older clients.
Do not call both global and control broadcasters for one notification: they
share the WebSocket client set and would send each frame twice.

The web hook preserves `tag`, `sessionId`, `kind`, and the remaining notification
fields so the web notification API recognizes duplicate control-SSE and main-WS
delivery. Its existing five-second claim suppresses duplicate native alerts.
Native alerts remain best-effort live events, with no historical replay or
synthetic catch-up alerts. Unread marks are OpenCode session state (`packages/ui/src/sync/session-unread.ts`).

This removes one persistent HTTP connection per browser tab in both main-WS and
main-SSE modes. Two tabs use two control SSE connections, or four connections
when their main event pipelines also use SSE. It does not make HTTP/1.1 support
an unlimited number of tabs. The notification hook retains the app's background
work enablement, settings, focus, and runtime gates; it no longer opens a second
connection or switches sources when the main pipeline changes transport.

The control stream retains its browser-control capability declaration, runtime
switch cleanup, stale-source rejection, heartbeat, and reconnect-ready events.
Electron uses its native notification path; VS Code does not subscribe to this
server-only stream. Mobile shells retain their existing push behavior.
