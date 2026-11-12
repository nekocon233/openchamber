# Remote desktop components

The panel bundles noVNC 1.7.0, copyright the noVNC authors, under MPL-2.0.
Its license is in LICENSE.noVNC.txt. Source is available at
https://github.com/novnc/noVNC/tree/v1.7.0. The included noVNC.browser.patch changes H.264 detection to run asynchronously
without module-level await so the library bundles as a classic IIFE.
The panel also includes noVNC's vendored pako decoder under its license
in LICENSE.pako.txt. The panel and service bundle Zod under the MIT license
in LICENSE.zod.txt.

TigerVNC and the optional x11vnc fallback are installed separately on the server.
Their binaries are not included in the OpenChamber package.
