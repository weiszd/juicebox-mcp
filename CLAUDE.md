# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI control for the juicebox.js Hi-C contact map viewer, as a plug-in. Two packages in an npm-workspaces monorepo:

- `packages/remote` — `@aidenlab/juicebox-remote`, a browser library that attaches a juicebox.js viewer to a room on the server so an LLM can drive it and peers stay in sync.
- `packages/server` — the Cloudflare Worker MCP server (`/mcp`) plus a Durable Object per room (`/ws`). Deployed with wrangler, never published.

The viewer itself lives upstream in juicebox.js (4.6.0+), and the hosting web page is juicebox-web. Neither is vendored here. The design is `docs/design/ARCHITECTURE_V2.md`; decisions are in `docs/adr/`.

The pre-v2 prototype (Node `.mcpb` server, vendored viewer, Vite frontend) is preserved on branch `prototype` and tag `v1.1.0-prototype`. Do not port code from it without checking the design first.

## Commands

```bash
npm install                    # installs both workspaces

# Tests (vitest projects: `remote` in Node; `server` inside workerd via
# @cloudflare/vitest-pool-workers, Worker + Durable Object from wrangler.toml)
npm test                       # watch
npm run test:run               # single run
npm run test:run -- packages/server/test/search.test.js   # one file
npm run test:run -- -t "substring of name"                # one test

# Server
npm run dev:server             # wrangler dev on :8787
npm run deploy:server          # wrangler deploy
```

Server config lives in `packages/server/wrangler.toml` (`[vars]`: `BROWSER_URL`, `TINYURL_DOMAIN`, `TINYURL_ENDPOINT`, `ALLOWED_ORIGINS` — the exact-match `Origin` allow-list for `/ws`). The `TINYURL_API_KEY` secret is set with `wrangler secret put`.

## Architecture

The server code is the prototype's Worker, moved as-is. Where it differs from the accepted design, the design wins and the ticket that closes the gap is named in `.scratch/v2/issues/`.

### Two channels

1. **MCP protocol** — client ↔ Worker over stateless Streamable HTTP on `/mcp` (JSON responses; a fresh `McpServer` per request; `GET /mcp` is rejected with 405). The MCP session id is minted on `initialize` and keys the Durable Object the session talks to.
2. **WebSocket** — page ↔ the room's Durable Object on `/ws?room=`. The Worker refuses an `Origin` not on `ALLOWED_ORIGINS` (403) and mints a 10-char Crockford base32 room when `room` is absent; the page's `join` is answered `joined {room}`; sync events go to every other socket in the room. Tool handlers never return visualization results; they push a `{type: '...'}` command into the Durable Object and the page acts on it. Commands are fire-and-forget today; per-command acks are a v2 addition.

A tool call flows: client → `/mcp` tool handler → Durable Object → WebSocket → the page (today: nothing, the prototype frontend is gone; in v2: `@aidenlab/juicebox-remote` → juicebox.js public surface).

### `packages/server`

- `src/index.js` — Worker entry: routes, CORS, MCP transport, session and room id minting, `/ws` Origin check.
- `src/durableObjects/WebSocketRoom.js` — one Durable Object per room; owns the sockets, relays sync events to other peers, keeps the last saved session.
- `src/mcp/toolHandlers.js` — the single `registerTools(mcpServer, deps)` tool catalogue. `deps` abstracts the Durable Object (`sendCommand`, `requestSessionData`, `shortenURL`, …).
- `src/search/` — dataset search pipeline: `dataSourceConfigs` (TSV catalogs on S3, described declaratively) → `dataParsers` → `metadataEnricher` → `queryExpander` (genomics synonym dictionary) → `mapFilter` → `resultFormatter`.
- `src/qrPng.js`, `src/urlShortener.js` — join-link QR and TinyURL helpers.
- `src/lib/logger.js` — use `logInfo`/`logWarn`/`logError` in server code; **no `console.log` in tool paths**.

### `packages/remote`

Public entry will be `attachRemote({hic, container, url, room?, ...})` (design §5). Currently holds the prototype's reconnecting `WebSocketClient.js`; the protocol module, command applier and observer land in later tickets.

### Adding or changing a tool

Edit `packages/server/src/mcp/toolHandlers.js` (schema + handler); once the remote's command applier exists, add the matching row there. Tool names and schemas are part of the client contract; keep them stable.

## Conventions

- ESM throughout (`"type": "module"`), no TypeScript, no linter.
- Tool input schemas use zod; colors are `#rrggbb` hex.
- Tests drive one package's public seam and assert what leaves it (socket messages, viewer calls, HTTP responses); no reaching into internals. The one exception is the search pipeline, whose pure modules are specced directly (design: "the prototype's vitest specs move with the modules").
- `.scratch/` (local issue tracker) and per-developer `.claude/settings*.json` are gitignored.

## Further docs

- `docs/design/ARCHITECTURE_V2.md` — the accepted design (protocol tables in §5, repo plan in §9).
- `docs/adr/` — architecture decision records.
- `docs/mcp-notes/`, `docs/datasource-notes/`, `docs/development-notes/` — prototype-era notes; still accurate for the search pipeline and MCP tool reference, stale where they describe the Node server or the vendored viewer.

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/<feature>/` in this repo (no GitHub issues; the fork has them disabled). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`, both created lazily. See `docs/agents/domain.md`.
