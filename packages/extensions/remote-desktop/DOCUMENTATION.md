# Remote desktop extension

## Ownership

This built-in owns its noVNC panel and Node service. The SDK owns the guest
socket and header-control contracts; the UI host and server own authentication,
routing, header placement and service lifetime. This service translates its
authenticated `/rfb` WebSocket to an owned VNC TCP listener and never accepts a
viewer-selected TCP target.

## Invariants

- The supported host is Linux. Other platforms report missing support. Virtual
  desktops need TigerVNC (`Xtigervnc` or `Xvnc`), `vncpasswd` and a local
  desktop or window manager. No packages are installed automatically.
- HTTP and WebSocket upgrades require the host service bearer and reject
  browser Origin headers. Both VNC listeners and the service bind IPv4 loopback
  on random ports. VNC uses VncAuth with a fresh random password and private
  temporary authentication files. Only the ephemeral VNC password reaches the
  authorized panel; service tokens, X11 cookies and TCP ports stay here.
- Virtual sessions use the service account even when a physical desktop belongs
  to another user. Their display and applications launched by the host share
  the same account.
- VNC servers must be native ELF executables (`Xtigervnc` or `Xvnc`) so
  distribution shell wrappers cannot daemonize outside group cleanup.
  `Xtigervnc` creates a separate authenticated X11 display with X TCP listening
  disabled.
- A supervisor shares the process group with VNC and the desktop. A pipe kept
  open by the service ends on a hard service exit; EOF terminates the group and
  removes its authentication directory and display reservation. Normal stop
  also sends SIGTERM followed by SIGKILL. No detached desktop survives a stop.
- Hidden panels and hidden browser tabs disconnect their viewer and reconnect
  when shown. Desktop processes and windows keep their existing lifetime.
- Virtual sessions survive panel/page transitions and explicit viewer
  disconnects until `/session/stop`, Disable or host exit. Failed starts remove
  only their own files, process group and display reservation.
- `/status` distinguishes unsupported platforms, missing tools and read
  failures. A failed status read is never treated as a ready status.
- The panel publishes one `Connect` / `Disconnect` control into the host panel
  or page header through `setStatusControls` and renders no inner toolbar or
  status bar. Loading, empty and error notices render in the centered empty
  overlay while disconnected. It covers every host locale; the desktop viewport
  always has physical left-to-right coordinates.
- Automatic clipboard writes and deliberate paste events exchange text up to
  the SDK limit; clipboard failures surface through host toasts.
- Local scaling and remote resolution changes stay on so the virtual display
  follows the frame size. No automatic reconnect loop is used.

## Decisions

### Why virtual desktop only and host header controls

Sharing a physical `:0` display required an attached monitor and display-owner
`Xauthority` discovery, failed on headless Linux servers whose outputs stay
disconnected, and forced a second toolbar and status strip inside the iframe for
mode and display pickers. Running only the owned `Xtigervnc` session lets a
single `Connect` / `Disconnect` button live in the host panel or page titlebar
while the desktop fills the entire frame.

### Why virtual desktops use the service account

An independent virtual desktop belongs to the service that creates it. Borrowing
a physical login's UID while host-launched Chromium retains the service UID can
leave its visible X11 window blank even though Chromium renders internally.
Keeping the virtual display under the service account preserves window painting.

### Why the service owns the VNC listener

A panel-selected host or port would turn the extension into a generic local
network proxy. The service accepts only an id for a session it started and
owns; the outer host proxy adds its separate service bearer.

### Why a supervisor retains a parent pipe

A detached process group supports stopping every desktop child together, but
would otherwise outlive a hard service exit. EOF makes that exit observable
inside the group, including under Bun and packaged Electron.

### Why binary RFB streams replace whole-picture polling

noVNC and TigerVNC negotiate incremental rectangles, compression and local
cursor updates. The public service socket carries those bytes unchanged and
retains the iframe's network isolation and existing encrypted relay transport.

### Why noVNC has a build patch

The extension sandbox requires one classic IIFE. noVNC 1.7 uses module-level
await for H.264 detection, which cannot be emitted as IIFE. The shipped patch
keeps that detection asynchronous through a promise and retains the current
noVNC release. The upstream source, patch and licenses are named in NOTICE.md.
