# LSP Bridge Module Documentation

## Ownership
`packages/web/server/lib/lsp/routes.js` owns the optional `/api/lsp/status` and `/api/lsp/request` endpoints that bridge `@codemirror/lsp-client` JSON-RPC requests to host-installed stdio language servers (`csharp-ls` or `OmniSharp` for C#, `typescript-language-server` for TS/JS, `pyright-langserver` for Python, `gopls` for Go, and `rust-analyzer` for Rust).

## Invariants
- Loads with Node built-ins only.
- Never fails editor operations when a host language server binary is absent or times out: `/api/lsp/status` and `/api/lsp/request` return `{ available: false }` so the UI's hybrid `Transport` (`packages/ui/src/lib/codemirror/lspWorkspaceBridge.ts`) transparently falls back to its built-in Lezer syntax-tree and ripgrep navigation engine.
- Stderr of spawned language servers is ignored (`stdio: ['pipe', 'pipe', 'ignore']`) so diagnostic output can never fill an OS pipe and block the child process.
- Idle language server processes terminate automatically after 5 minutes of inactivity.

## Decisions

### Why HTTP JSON-RPC framing with an in-process fallback instead of requiring a persistent WebSocket LSP daemon
Most users run OpenChamber without language server binaries installed for every language they browse. Probing PATH on demand and returning `{ available: false }` when absent lets `@codemirror/lsp-client` use the in-process Lezer + ripgrep provider with zero setup, while still upgrading to full compiler semantics when a language server binary is present on the host.
