# UI Auth Module Documentation

## Purpose
This module owns OpenChamber UI authentication for browser access, including password session auth, WebAuthn passkeys, trusted-device session handling, and the opaque auth descriptors used by notification delivery and long-lived channel lifecycle.

Trusted-device access has one durable credential model: a remote client bearer token stored by `packages/web/server/lib/client-auth/remote-clients.js`. Password, passkey, and Pairing v2 are issuance methods for that credential, not separate credential systems. Issued client tokens are returned once, stored server-side only as hashes, and are later authenticated via `Authorization: Bearer oc_client_...`.

Pairing v2 is implemented by `packages/web/server/lib/client-auth/pairing.js`. It stores short-lived one-time pairing sessions with hashed secrets, exposes create/cancel/redeem routes under `/api/client-auth/pairing/*`, and redeems a valid pairing secret into the same remote client token used by password/passkey trusted-device flows.

## Entrypoints and structure
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI auth controller runtime, cookie/session issuance, rate limiting, and auth route handlers.
- `packages/web/server/lib/ui-auth/channel-auth.js`: shared WebSocket authorization and established-channel expiry/revocation tracking. Channel runtimes receive the tracker through explicit composition-root injection.
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: passkey store and WebAuthn registration/authentication verification helpers.
- `packages/web/server/lib/client-auth/remote-clients.js`: trusted-device client token storage, bearer authentication, last-used tracking, and revocation.
- `packages/web/server/lib/client-auth/pairing.js`: short-lived Pairing v2 sessions and one-time secret redemption into trusted-device client tokens.

## Public exports (ui-auth.js)
- `createUiAuth({ password, cookieName, sessionTtlMs, readSettingsFromDiskMigrated })`: creates UI auth controller with methods:
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
  - `clearAllPasskeys()`
  - `beginRegistration(req, { label })`
  - `finishRegistration(payload)`
  - `beginAuthentication(req)`
  - `finishAuthentication(payload)`
  - `dispose()`
