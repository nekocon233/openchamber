# Port Forward

## Purpose

This module makes a dev server on the OpenChamber host reachable from a client
that cannot bind a local port — a browser tab, a PWA, a phone. `../dev-tunnel/`
already solves this for the desktop shell by binding a port on the user's own
machine; a browser has no equivalent, and its `localhost` is its own.

It needs one hostname per forwarded port, which not every deployment can
produce. Where a wildcard certificate is out of reach — a Cloudflare quick
tunnel, the private relay — `openchamber forward` binds a local port instead,
over the same `../dev-tunnel/` socket. That path needs no hostname and no
server change, at the cost of running a process on the client machine.

Each forwarded port answers on a hostname of its own, so the page loads at the
root of a real origin: absolute URLs resolve, cookies scope correctly, and HMR
sockets connect with nothing rewritten. That is the same reason the desktop
tunnel binds a local port rather than serving the page under a path prefix.

## Boundaries

- `host-template.js` builds forwarded hostnames from the user's template and
  recognises them coming back. Pure string work, no I/O.
- `grants.js` owns who may load a forward: single-use grants exchanged for a
  per-hostname cookie. Nothing is persisted.
- `proxy.js` moves one request or one upgrade to `127.0.0.1:<port>`.
- `runtime.js` decides whether a request is allowed through and in what order
  the checks run. It is the only place that combines the three above.
- `routes.js` is the control surface on the OpenChamber origin.
- `claim.js` is a two-function module the other upgrade listeners import.
- Port discovery is not owned here; `runtime.js` is handed the same scanner the
  user's own dev-server list is built from.
- Choosing what to open, and when, belongs to the UI:
  `packages/ui/src/lib/browser/portForward.ts` decides whether an address needs
  a forward at all and turns it into one that loads;
  `packages/ui/src/components/browser/useForwardedPorts.ts` owns the list and
  the start/stop controls.

## Invariants

- Three separate things must hold before bytes move, and none substitutes for
  another: the user turned this port on, discovery still reports it, and the
  caller holds a grant or cookie for that exact port. Discovery alone opens
  nothing, or every service that happens to listen on the host would be
  published the moment one of them was.
- A discovery failure denies the request and leaves the user's forwards alone.
  "The scan broke" is not "the dev server stopped", and treating it as the
  latter would switch off forwards the moment `lsof` hiccuped.
- A hostname matching the template never falls through to Express. It carries
  none of OpenChamber's credentials, so reaching the app's routes would serve
  the app — and its sign-in page — from an origin OpenChamber does not
  authenticate.
- A forwarded upgrade is claimed synchronously, before any `await`. Node runs
  every `upgrade` listener for every upgrade, and the others match on path,
  which a forwarded hostname owns all of.
- Changing the host template drops every active forward, because the hostnames
  already handed out no longer route anywhere.
- Forwards live in memory only. Surviving a restart would leave a dev server
  reachable past the moment anybody decided it should be.

## Client-Side Invariants

These hold in the UI and are easy to break from either side:

- The tab keeps the address the user asked for (`localhost:5173`), never the
  forwarded hostname. The forwarded one changes with the template and means
  nothing after a restart, so persisting it would strand the tab.
- A grant is minted per load, never cached. The forward spends it on first use,
  so a reused one is already dead — and minting again renews a cookie that has
  since expired, which a cached URL could not.
- Re-resolving is driven by navigation and by an explicit "forward this port"
  action, never by the forward-list poll. Polling into it would re-mint the
  grant every few seconds and reload the page under the user.

## How This Differs From The Dev Tunnel

`../dev-tunnel/` promises that nothing is inspected or modified — it moves raw
TCP bytes. This module terminates HTTP, so it cannot make that promise and
makes a narrower one instead: **the path space is identical and no body is
touched**. It edits exactly three things, and adding a fourth needs a reason.

1. `Host` becomes `localhost:<port>`, so a framework checking it against an
   allowlist (Vite's `allowedHosts`, Rails' `host_authorization`) sees the
   loopback name it was configured for.
2. Hop-by-hop headers are dropped in both directions, including any named by
   `Connection` — except on an upgrade, where `Connection` and `Upgrade` are
   the handshake.
3. OpenChamber's own cookie is removed before the request reaches the dev
   server.

## Deployment Constraints

These are the operator's to satisfy; OpenChamber cannot detect them and will
surface the failure as an unexplained browser error if they are unmet.

- The tunnel in front of OpenChamber must route the whole wildcard back here,
  and must set `X-Forwarded-Proto`. A forward refuses plain HTTP, because its
  cookie is `Secure` and could not be set.
- The template must produce hostnames an existing certificate covers.
  Cloudflare's Universal SSL covers only one wildcard level: with OpenChamber
  on `oc.example.com`, `5173.oc.example.com` has no certificate, so the
  template belongs at the same level — `oc--{port}.example.com`.
- The cookie is `SameSite=None; Partitioned` so it survives being framed by the
  OpenChamber UI. Verify that on a real browser after changing it; no static
  check covers cookie partitioning.

## Runtime Note

Bun's `node:http` does not deliver bytes written to an upgraded socket in
either direction. Under `bun server/index.js` a forwarded page loads but its
HMR socket never exchanges anything. Every shipped server runs under Node
(`bin/cli.js` is `#!/usr/bin/env node`), and `websocket-forward.fixture.mjs`
covers the upgrade path there, spawned from `runtime.test.js`. Validate forward
behaviour under Node.

## Security Posture

A forward places a dev server behind a public entry point. The grant and cookie
gate keeps unauthorised callers out, but what sits behind that gate was never
designed to face a network — dev servers have shipped path-traversal bugs. So a
forward is off by default, turned on per port by an explicit action, and
stoppable at any time, and the UI says as much.
