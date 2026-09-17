# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server that lets an LLM drive a browser-based Juicebox Hi-C contact map viewer through natural language. The repo contains **both halves**: the MCP server (Node and Cloudflare Worker flavors) and the Juicebox web frontend it controls. The frontend is derived from [juicebox.js](https://github.com/aidenlab/juicebox.js).

## Commands

```bash
npm install

# Frontend (Vite dev server on :5173)
npm run dev
npm run build                 # → dist/
npm run build:netlify         # Netlify variant (no sourcemaps)

# MCP server, Node flavor
npm run mcp:server            # runs server.js directly
npm run build:mcpb            # esbuild bundle → dist/juicebox-mcp-server.js, then .mcpb package
npm run start:mcpb            # run the bundled server

# Cloudflare Worker flavor (frontend + MCP + WebSocket in one deploy)
npm run dev:worker            # builds frontend with VITE_WS_URL=ws://localhost:8787/ws, then wrangler dev
npm run deploy:worker

# Tests (vitest, node environment)
npm test                      # watch
npm run test:run              # single run
npm run test:run -- test/testURL.js           # one file
npm run test:run -- -t "substring of name"    # one test

# Version: sync package.json / manifest.json / server.js from the latest GitHub release tag
npm run version:sync
```

`.env` (see `.env.example`) supplies `TINYURL_API_KEY`, `BROWSER_URL`, `MCP_PORT` (3010), `WS_PORT` (3011) for local Node runs. For the Worker, the same values live in `wrangler.toml` `[vars]`, with `TINYURL_API_KEY` set via `wrangler secret put`.

## Architecture

### Two communication channels

There are two *simultaneous, independent* channels (see `docs/development-notes/ARCHITECTURE_STDIO_WEBSOCKET.md`):

1. **MCP protocol** — Claude Desktop ↔ server. STDIO when launched as a subprocess (auto-detected via `!process.stdin.isTTY`), or Streamable HTTP on `/mcp`. Forced to HTTP with `MCP_TRANSPORT=http` or `FORCE_HTTP_MODE=true`.
2. **WebSocket** — server ↔ browser frontend. Tool handlers never return visualization results; they push a `{type: '...'}` command over the socket and the browser acts on it.

A tool call therefore flows: Claude → MCP tool handler → `routeToCurrentSession(command)` → WebSocket → `Application._handleWebSocketCommand` → `commandHandlers` map → Juicebox browser API.

### Session routing

Every browser is bound to a session. The frontend reads `?sessionId=` from its URL (`Application.js`); without one it runs standalone with no MCP connection. On the Node side, `AsyncLocalStorage` (`sessionContext`) carries the MCP session id into tool handlers so commands reach the right browser, falling back to broadcast. On the Worker side, the session id keys a Durable Object (`WEBSOCKET_ROOM`), which owns the sockets for that session.

Multiple browsers in the same session stay in sync: a browser emits `syncEvent` messages on user interaction (`WebSocketClient.sendSyncEvent`), and the server relays them to *other* clients in the session only (`sendToOthersInSession`, or the DO's equivalent). Handled in `Application._handleSyncCommand`.

Data flowing the other way (session JSON, track list) is request/response over the same socket with a pending-promise map and timeout: `requestSessionData`, `requestCompressedSessionData`, `requestTrackList`.

### The two server implementations are parallel and must be kept in sync

- `server.js` — Node/Express/`ws`. Used for local dev and the `.mcpb` Claude Desktop package.
- `worker/` — Cloudflare Worker. `worker/index.js` routes `/ws` → Durable Object, `/mcp` → a freshly constructed `McpServer` per request (Workers are stateless; SSE/`GET /mcp` is rejected, `enableJsonResponse` is used instead). Tools live in `worker/mcp/toolHandlers.js`, which takes a `deps` object (`sendCommand`, `requestSessionData`, `shortenURL`, …) abstracting the DO.

Both register the **same 27 tools** with the same names and schemas. **Adding, renaming, or changing a tool means editing both `server.js` and `worker/mcp/toolHandlers.js`**, and usually adding a handler in `Application.js`'s `commandHandlers` map. Shared logic lives in `src/` and is imported by both.

### Directory roles

- `js/` — vendored Juicebox.js viewer library (hicBrowser, contactMatrixView, colorScale, session, tracks, …). Treat as the upstream library layer; `js/index.js` is its public surface.
- `src/` — the MCP-specific application layer. `Application.js` is the bridge: it boots Juicebox, owns the `commandHandlers` map (one entry per MCP command type), and wires browser events back out as sync events. `WebSocketClient.js` handles connect/reconnect and WS URL resolution (explicit → `VITE_WS_URL` → same-host `/ws` → localhost).
- `src/dataSourceConfigs.js`, `dataParsers.js`, `metadataEnricher.js`, `queryExpander.js`, `mapFilter.js`, `resultFormatter.js` — the dataset search pipeline, shared by both servers. Sources (4DN, ENCODE) are TSV catalogs fetched from S3 and described declaratively (columns, `urlColumn`, `nameColumn`, `urlPrefix`). Search = parse → enrich → expand query with the genomics synonym dictionary → filter → format.
- `worker/` — Cloudflare-only code.
- `test/` — vitest specs plus `test/utils/` DOM/XHR mocks (vitest runs in `node` environment, so browser globals are mocked in `test/setup.js`). `test/utils/**` and `test/data/**` are excluded from the test glob.
- `dev/` — standalone HTML harnesses for manual debugging; not part of the build.

### Version management

`package.json` is the source of truth. `vite-plugin-version.js` rewrites `js/version.js` on every build; `server.js` and `manifest.json` carry hardcoded versions updated by `scripts/sync-version-from-github.js`. Bumping a version by hand means touching all of these.

## Conventions worth knowing

- ESM throughout (`"type": "module"`), no TypeScript, no linter configured.
- Tool input schemas use zod; colors are validated as `#rrggbb` hex and converted with `hexToRgb`.
- `server.js` logs to a file (`$TMPDIR/juicebox-mcp-server.log`, or `JUICEBOX_MCP_LOG_FILE`) because stdout is the MCP transport in STDIO mode — **never `console.log` in server code paths**; use `logInfo`/`logWarn`/`logError`.
- `dist/` is gitignored; the committed `.mcpb` at the repo root is a release artifact.

## Further docs

`docs/development-notes/PORTING_MCP_TO_JUICEBOX_JS.md` — what this fork changed vs. upstream juicebox.js (both stages), the server↔browser protocol contract, and the plan for re-attaching the MCP layer to current juicebox.js (4.x) as a host app. Read it before touching `js/` or `Application.js` sync wiring.

`docs/mcp-notes/` (tool reference, MCPB build guide, WebSocket debugging, Netlify setup), `docs/datasource-notes/` (search implementation), `docs/development-notes/` (STDIO/WebSocket architecture, color scale refactoring, locus specification, version management).
