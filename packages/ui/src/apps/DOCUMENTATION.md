# VS Code and mobile application roots

## Ownership

`VSCodeApp` composes the shared runtime, theme and sync contexts for VS Code webviews. The extension host selects the root's `panelType` in its bootstrap document. `VSCodeLayout` owns chat/session navigation; `SettingsView` owns Settings pages and responsive navigation. The native panel lifecycle belongs to `packages/vscode/src`, documented there.

`MobileShell` in `MobileApp` owns the phone and tablet surfaces, Settings among them.

The workspace drawer and tablet panel share a scrollable tab strip. Its PR tab
loads the shared `PullRequestView` on first use, keyed by runtime and effective
workspace directory. The same draft-space directory rules as Changes apply.

`mobileConnections` owns saved mobile instances and their connect, password and reconnect flows. The welcome screen and Instances form share its controller. Runtime HTTP authentication remains in `lib/runtime-auth` and `lib/runtime-fetch`.

## Invariants

- Mobile custom headers belong to the normalized address entered in the form. They reach that address's health check, password login, session check and runtime HTTP requests. They never follow another direct candidate or the private relay. Authorization remains reserved for the client token.
- HTTP requests with mobile custom headers refuse redirects in both the native connection checks and the fetch transport. The configured address must be the final address, so a redirect cannot forward proxy credentials to another origin or path.
- Native header values live in secure storage. Metadata holds an opaque reference; browser-mode storage holds the parsed header configuration inline. Missing headers preserve old connections. An unreadable native entry fails the connection or edit operation, without replacing the saved headers with an empty set.
- A header edit writes a fresh secure entry before publishing its metadata reference. Failure preserves the old reference and credentials. Replaced and removed references are deleted after the metadata commit. Native bridge calls remain bounded by the existing secure-storage timeout.
- Native mobile with headers uses the existing fetch-based OpenChamber event stream reader and the native WebSocket adapter behind `openRuntimeWebSocket`. Files media previews use bounded runtime HTTP reads and owned object URLs; prepared chat images use the existing validated data-URL loader. HTML previews and inline Markdown video still use browser-owned URLs without proxy headers.
- An empty welcome-form header editor preserves a saved connection's headers. Explicit clearing belongs to the prefilled Instances edit form. Cancelling a password prompt does not erase existing header credentials.

- Chat-side Settings entry points request the native Settings tab through `RuntimeAPIs.vscode`. They preserve chat selection, drafts and the current layout. The source's in-page dialog flag is cleared so it cannot block chat shortcuts.
- Only the Settings root receives page navigation. The bridge parses it before applying it to stores, and the mounted root signals readiness before the host consumes pending navigation.
- The Settings root supplies no selected directory to the shared sync provider. It does not start global session polling, selected-directory session bootstrap or background queue delivery/cleanup, and seeing it never marks a chat as viewed. Settings pages resolve their own project through `useSettingsDirectory`; catalog updates still use the shared sync context.
- Its runtime shortcut hook registers Settings actions only and requires no chat sync context. Chat, model and session shortcuts remain with chat roots, so a key pressed in Settings cannot create an unseen draft or change a session selection there. Escape reaches an input or menu before the tab's close handler.
- On mobile, a request for the Settings dialog opens the fullscreen Settings surface and clears the dialog flag (`mobileSettingsNavigation.ts`). It lands on the requested page when the phone shows that page, otherwise on the page list. Entry points keep calling `setSettingsDialogOpen` and need no mobile branch.
- Mobile Changes shares the device-local project file type filter with the desktop Changes view. Working, last-turn and comparison lists apply the same exclusions; hidden paths are excluded from detail reads and diff prefetch. Complete status remains the source for commit counts, Git mutations and walkthrough targets. Fully filtered working changes keep the commit footer and show Restore all in the list.
- The mobile root loads source-control provider descriptors and account status on connection and runtime switches, and refreshes both after a native resume with the same connection. It mounts `useSourceControlProviderSync` once for provider changes and control-stream reconnects. The shared registry owns runtime isolation, retained snapshots and retry behavior.
- PR navigation retains the shared view while its workspace tab is hidden, with its clock paused and content effects disconnected. The shared workspace stores restore reading state and unfinished replies after a project switch or reload. PR-to-Changes keeps its existing return identity; Back to PR reveals the mobile PR tab rather than a desktop context pane.
- Settings uses the existing persistence and broadcast protocol. Moving its host changes no stored format, registry key or runtime availability.
- Notification commands and initial session tabs in VS Code use the shared session opener, so a `/btw` fork opens its parent and expands the panel mounted in the shared composer. Notification commands also reveal the chat view.

## Decisions

### Why mobile shares the PR panel

The workspace tab uses the desktop list, preview and branch workflow so provider
authority, actions and reading-state restoration have one owner. The Changes PR
picker remains a comparison selector. The tab strip scrolls to keep all seven
workspace entries reachable without compressing their touch targets.

### Why mobile loads source-control capabilities in the root

PR comparisons wait for the server's provider descriptors before reading a list or diff. Loading them with account status in the root lets a fresh PWA or native client open Changes without first visiting another surface or inheriting a desktop cache.

### Why mobile proxy headers bind to an address and not every transport

A saved device can have LAN addresses and a relay route that do not pass through the user's proxy. Binding headers to the entered address prevents proxy credentials from reaching those alternatives after a reconnect or candidate refresh.

### Why secure header writes use new references and not in-place replacement

The secure store and localStorage cannot commit together. A new reference lets a failed metadata write preserve the previous credentials without a compensating secret write that could also fail.

### Why navigation carries intent and not the source's stores

Each webview owns its own stores. A small parsed request preserves the originating Settings directory, page links, provider-connect action and new-snippet action without transferring chat state or overwriting the tab's independently edited settings.

### Why mobile listens for the dialog flag and not a mobile branch at every entry point

About twenty shared entry points open Settings through `setSettingsDialogOpen`. The phone renders no dialog, so each one did nothing there and left the flag set, which blocks chat shortcuts. One bridge in the shell covers every entry point, the same way the VS Code bridge does.
