# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, trusted-device session handling, and the opaque auth descriptors used by notification delivery and long-lived channel lifecycle.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.ts`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `rate-limit.ts` owns the shared sign-in attempt budget and its lock and cleanup.
- `request-auth.ts` owns the request forms and routes that accept scoped URL tokens.
- `packages/web/server/lib/ui-auth/channel-auth.ts`: shared WebSocket authorization and established-channel expiry/revocation tracking. Channel runtimes receive the tracker through explicit composition-root injection. Source imports retain the `.js` specifier.
- `packages/web/server/lib/ui-auth/ui-passkeys.ts`: passkey store and WebAuthn registration/authentication verification helpers. Source imports retain `.js` specifiers.
- `packages/web/server/lib/ui-auth/session-cookie.ts`: resolves the session cookie name from a request's `Host` port; shared by session issuance and validation in `ui-auth.js` and notification/session identity extraction in `packages/web/server/lib/security/request-security.js`. Source imports retain the `.js` specifier.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation. Revoking also stops the device's push notifications (`../notifications/DOCUMENTATION.md`, *Revoked and expired clients*).
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Invariants

- Password and passkey sign-in share one attempt budget per trusted-proxy
  resolved client IP. Reading X-Forwarded-For directly would let an attacker
  choose a new bucket for each attempt. Only rejected passkey assertions spend
  that budget; failures after accepted authentication do not.
- Explicit bearer authentication decides session status on its own. Falling
  back to an ambient session cookie would hide a revoked native-client token
  while bearer-only API requests fail.
- An empty passkey label restores its registration-time generated name, so
  clearing a custom name does not erase the device's identifiable label.
- WebSocket upgrades reject an opaque browser origin. Passwordless mode
  checks a browser's origin against the trusted site for that socket. Revoking
  one channel attempts every matching connection even if a close callback fails.

## Session cookie scoping
Browsers key a cookie jar on the host only, never the port (RFC 6265). Two OpenChamber instances reached through the same hostname on different ports therefore shared a single `oc_ui_session` cookie. Logging into the second overwrote the first instance's session cookie (issue #2377). This affects LAN and loopback hosts alike.

`sessionCookieNameForRequest(req, base)` folds the request `Host` port into the cookie name: `oc_ui_session_<port>` when the host carries an explicit port (including a port from `x-forwarded-host`), or the bare `oc_ui_session` when it does not. `localhost:3000` and `localhost:3001` use separate names, just like two ports on one LAN address. Password and browser passkey login both call `issueSession` and receive this cookie. Session validation, clearing, and notification identity extraction use the same resolver; identity extraction does not provide a CSRF token. Bearer-token validation is unchanged.

Compatibility: upgrading renames the cookie for any explicit-port host, so already-signed-in browser sessions must log in once again. No on-disk format changes.

## URL auth tokens
`POST /auth/url-token` returns `{ token, expiresAt, expiresIn }`. `expiresAt` is on the server's clock; `expiresIn` is the remaining lifetime in milliseconds. The shared UI places the expiry on its own clock from `expiresIn` (`packages/ui/src/lib/runtime-auth.ts`), because a phone whose clock is a minute ahead of the server otherwise treats every fresh token as expired and opens the terminal and event sockets without one (issue #5614). `expiresAt` stays for clients older than `expiresIn`.

## Decisions

### Why upgrade authentication accepts a missing response

Token lookup accepts Node upgrade requests as well as Express requests. Only
headers and optional URL, method, path, query and secure fields are read.
An existing cookie or accepted bearer token needs no response. With password
auth disabled, a missing cookie still attempts to set a cookie; a null response
retains the JavaScript TypeError instead of silently issuing an unsent token.

### Why authentication dependencies and password hashing wait for use

JOSE loads on the first session check and WebAuthn's large dependency tree loads
on the first passkey operation. Password hashing waits for the first sign-in
attempt because doing it during server creation blocks the embedding host's
main thread on every startup.

### Why WebAuthn has a local declaration augmentation

The passkey store accepts every string transport and filters out only nonstrings.
WebAuthn option generation preserves those strings, including values outside
`@simplewebauthn/server`'s `AuthenticatorTransportFuture` union. Version 13.3.3
copies these descriptors into registration and authentication options without
checking transports, and authentication verification does not read credential
transports. `webauthn.d.ts` adds overloads for these runtime contracts, including
the generated option results. Filtering strings or declaring the stored values
as the library's union would change accepted files or misrepresent their contents.

The verification overloads accept unchecked HTTP responses. The library owns
cryptographic and response validation, including its existing rejection messages.
Registration verification copies `response.response.transports` into its result
without checking it, so that field stays `unknown` until the existing array and
string filters run. A successful verification does not establish a transport
union or even a transport array.

### Why external fields keep their runtime checks

Request headers, query values, request bodies, persisted passkeys, settings and
error properties remain unchecked at their boundaries. String, number, object
and array predicates preserve the original acceptance rules, including arrays
as stored record objects and arbitrary string transports. Property-bearing input
guards exclude only null and undefined: JavaScript permits optional property
reads on primitives, arrays and functions too. Their optional fields remain
unknown until individually checked.

Internally constructed cookie ages, controller methods, client identifiers and
Node timer methods use their owner types. URL, path and method fields use the
HTTP request contract. Their redundant `typeof` checks are removed. Cookie
dictionary lookups retain their original truthiness checks.

The renamed passkey remains in the mapped list because the map preserves its
ID and relying-party ID. The already-found record supplies the type checker's
fallback for that guaranteed lookup; it cannot be selected for a valid store.

### Why guest URL token scopes only open guest files

A guest iframe can read its own URL token. Its `guest:<id>` scope therefore
accepts only GET requests beneath that guest's package path, and rejects
WebSocket upgrades and every other guest or system path. An absent scope remains
null; an invalid scope remains undefined.

### Why cookie headers retain runtime string checks

`Host` and `x-forwarded-host` come from HTTP requests. `SessionCookieRequest`
accepts Node's header representation and permits a missing request or headers.
The string guard preserves the existing rejection of array-valued forwarded
hosts and the fallback to `Host`. No internal value needs a `typeof` check.

## Public exports (ui-auth.js)
- `readSessionTtlMs(raw, unitMs, fallbackMs)`: parses a positive session lifetime from an environment value, else the fallback. Defaults come from `OPENCHAMBER_UI_SESSION_TTL_HOURS` (12) and `OPENCHAMBER_UI_TRUSTED_SESSION_TTL_DAYS` (180, used when the user ticks "trust this device").
- `createUiAuth({ password, cookieName, sessionTtlMs, trustedSessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
  - Standard sessions expire 12 hours after issuance. Sessions requested with `trustDevice: true`, and client tokens issued from those sessions, expire 180 days after issuance. These are fixed, non-sliding expirations.
  - `enabled`
  - `requireAuth(req, res, next)`
  - `requireClientAuth(req, res, next)` — bearer-only validation with no UI-cookie issuance or mutation; Private Relay requests use this gate because their loopback hop is not local trust.
  - `resolveNotificationAuth(req, res, options)` — returns an opaque, non-auth notification descriptor for an already authenticated UI/client request.
  - `resolveChannelAuth(req, res, options)` — the same opaque descriptor contract for an authenticated long-lived SSE/WebSocket channel.
  - `resolveUrlAuth(req)` — resolves only a valid path-scoped URL token to its opaque descriptor; it never accepts a cookie or returns the URL token/session credential.
  - `validateNotificationAuth(auth)` — authoritatively checks client records and session expiry without requiring a persisted credential.
  - `handleSessionStatus(req, res)`
  - `handleSessionCreate(req, res)`
  - `handlePasskeyStatus(req, res)`
  - `handlePasskeyRegistrationOptions(req, res)`
  - `handlePasskeyRegistrationVerify(req, res)`
  - `handlePasskeyAuthenticationOptions(req, res)`
  - `handlePasskeyAuthenticationVerify(req, res)`
  - `handlePasskeyList(req, res)`
  - `handlePasskeyRevoke(req, res)`
  - `handlePasskeyRename(req, res)`
  - `handleResetAuth(req, res)`
  - `ensureSessionToken(req, res)`
  - `dispose()`

Global UI auth reset invalidates all `ui-session` notification descriptors and removes URL tokens derived from invalidated identities. Raw UI JWTs remain HttpOnly/server-side and are never returned in notification SSE events or used as persisted notification record keys.
Passwordless notification generations are process-scoped, so restart or enabling password protection invalidates every passwordless-era association. Password-protected generations are bound to both the JWT secret and normalized password policy; changing either invalidates old associations, while an unchanged policy remains valid across restart. The obsolete standalone generation file is not trusted.

Externally-originated WebSocket upgrades (managed/public tunnel scope or the Private Relay marker) require a valid allowlisted `oc_url_token` and the normal origin check even when UI password auth is disabled. Direct local passwordless sockets intentionally remain cookie/token-free. Established authenticated channels retain only the opaque descriptor and close immediately on identity invalidation or descriptor expiry.

## Public exports (ui-passkeys.js)
- `createUiPasskeys({ passwordBinding, readSettingsFromDiskMigrated, storeFile, rpName, challengeTtlMs })`: creates passkey runtime with methods:
  - `enabled`
  - `getStatus(req)`
  - `listPasskeys(req)`
  - `revokePasskey(req, passkeyId)`
  - `renamePasskey(req, passkeyId, label)`
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
