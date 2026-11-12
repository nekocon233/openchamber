# Remote desktop extension

## Ownership

This built-in owns its noVNC panel and Node service. The SDK owns the guest
socket contract; the UI host and server own authentication, routing and
service lifetime. This service translates its authenticated `/rfb` WebSocket
to an owned VNC TCP listener and never accepts a viewer-selected TCP target.

## Invariants

- The supported host is Linux with X11. Other platforms and Wayland-only
  desktops report missing support. Virtual desktops need TigerVNC and a local
  desktop or window manager. No packages are installed automatically.
- HTTP and WebSocket upgrades require the host service bearer and reject
  browser Origin headers. Both VNC listeners and the service bind IPv4 loopback
  on random ports. VNC uses VncAuth with a fresh random password and private
  temporary authentication files. Only the ephemeral VNC password reaches the
  authorized panel; service tokens, X11 cookies and TCP ports stay here.
- Display discovery reads socket ownership and local process display metadata.
  When the host runs as root, a physical desktop's owning UID/GID runs its VNC
  server. Xauthority bytes are never returned by `/status`.
- Virtual sessions use the service account even when a physical desktop belongs
  to another user. Their display and applications launched by the host share
  the same account; physical capture retains its selected desktop's identity.
- VNC servers must be native executables. Prefer Debian's `X0tigervnc` over its
  `x0vncserver` wrapper, which forks a separate daemon and would escape group
  cleanup. x11vnc is the fallback for an existing display; Xtigervnc creates a
  separate authenticated X11 display with X TCP listening disabled.
- A supervisor shares the process group with VNC and the desktop. A pipe kept
  open by the service ends on a hard service exit; EOF terminates the group and
  removes its authentication directory and display reservation. Normal stop
  also sends SIGTERM followed by SIGKILL. No detached desktop survives a stop.
- Hidden panels and hidden browser tabs disconnect their viewer and reconnect
  when shown. Desktop processes and windows keep their existing lifetime.
- Each requested physical display owns its capture session; choosing another
  display never reuses or closes a viewer's existing capture.
- Physical capture stops after 15 seconds without viewers. Virtual sessions
  survive panel/page transitions until Stop, Disable or host exit. Failed starts
  remove only their own files, process group and display reservation.
- `/status` distinguishes missing tools, missing displays, missing X11
  authorization and read failures. A failed status read is never an empty list.
- The panel mounts controls once and updates translations and theme in place.
  It covers every host locale. Toolbar direction follows Arabic/Hebrew; the
  desktop viewport always has physical left-to-right coordinates.
- Automatic clipboard writes and deliberate paste events exchange text up to
  the SDK limit. The opaque iframe cannot read the local clipboard directly;
  a clipboard text field remains available when browser permissions refuse it.
- Local scaling defaults on. Remote resolution changes default on for virtual
  sessions and off for physical displays, where resizing affects the monitor.
  Both controls are available in More. No automatic reconnect loop is used.

## Decisions

### Why virtual desktops use the service account

An independent virtual desktop belongs to the service that creates it. Borrowing
the physical login's UID while host-launched Chromium retains the service UID
can leave its visible X11 window blank even though Chromium renders internally.
Keeping the virtual display under the service account restores window painting
without changing the owner of an existing physical desktop.

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
