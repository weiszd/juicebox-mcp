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

Server config lives in `packages/server/wrangler.toml` (`[vars]`: `BROWSER_URL`, `TINYURL_DOMAIN`, `TINYURL_ENDPOINT`, `ALLOWED_ORIGINS` — the exact-match `Origin` allow-list for `/ws`). It declares the `jbmcp.3dg.io` custom domain. Secrets `TINYURL_API_KEY` and `SESSION_HMAC_SECRET` are set with `wrangler secret put` (locally in `packages/server/.dev.vars`); without `SESSION_HMAC_SECRET` the `x-openai-session` (ChatGPT) path fails rather than using a default key.

## Architecture

The server code is the prototype's Worker, moved as-is. Where it differs from the accepted design, the design wins and the ticket that closes the gap is named in `.scratch/v2/issues/`.

### Two channels

1. **MCP protocol** — client ↔ Worker over stateless Streamable HTTP on `/mcp` (JSON responses; a fresh `McpServer` per request; `GET /mcp` is rejected with 405). The MCP session id is minted on `initialize` as a room id (or derived by HMAC from `x-openai-session`); the session is bound to that room until `join_room` rebinds it.
2. **WebSocket** — page ↔ the room's Durable Object on `/ws?room=`. The Worker refuses an `Origin` not on `ALLOWED_ORIGINS` (403) and mints a 10-char Crockford base32 room when `room` is absent; the page's `join` is answered `joined {room}`; sync events go to every other socket in the room. Tool handlers never return visualization results; they push a `{type: '...'}` command into the bound room's Durable Object, which adds a `requestId`, sends it to every page, and waits up to 10 s for the first `ack`. No page → error result; no ack → "sent, unconfirmed". Request tools (`list_tracks`, `save_session`, `create_shareable_url`) ask only the first live page and read the ack's `result`; that page closing fails the request at once.

A tool call flows: client → `/mcp` tool handler → Durable Object → WebSocket → the page (today: nothing, the prototype frontend is gone; in v2: `@aidenlab/juicebox-remote` → juicebox.js public surface).

### `packages/server`

- `src/index.js` — Worker entry: routes, CORS, MCP transport, session and room id minting, `/ws` Origin check.
- `src/durableObjects/WebSocketRoom.js` — one Durable Object per room; owns the sockets, relays sync events to other peers, fans commands out and waits for acks, keeps the last saved session for late joiners (`requestSessionFromPeer` → `peerSessionData`). Every message re-arms an alarm 24 h out; it deletes the room's storage and, if no page is left, marks the room expired so later joins get `error {code: 'room-expired'}` (ADR-0006).
- `src/durableObjects/McpSession.js` — one Durable Object per MCP session; stores the room `join_room` bound it to.
- `src/mcp/toolHandlers.js` — the single `registerTools(mcpServer, deps)` tool catalogue. `deps` abstracts the Durable Object (`sendCommand`, `sendRequest`, `shortenURL`, …).
- `src/search/` — dataset search pipeline: `catalogs` (ENCODE and 4DN igv-data TSV URLs + columns, copied from juicebox-web; keep in sync) → `dataSourceConfigs` (how each TSV is read) → `dataParsers` → `metadataEnricher` → `queryExpander` (genomics synonym dictionary) → `mapFilter` → `resultFormatter`.
- `src/qrPng.js`, `src/urlShortener.js` — join-link QR and TinyURL helpers.
- `src/lib/logger.js` — use `logInfo`/`logWarn`/`logError` in server code; **no `console.log` in tool paths**.

### `packages/remote`

Publishable to npm as plain ESM, no build step; exports `.` (`src/attachRemote.js`) and `./protocol` (`src/protocol.js`, imported by the server too). The API, statuses and "no UI" contract are in `packages/remote/README.md`; the design is §5.

- `src/attachRemote.js` — `attachRemote({hic, container, url, room?, onStatus?, onToolCall?, createSocket?})` → `{room, joinUrl, detach}`. Joins the room, catches up from it (the room wins, §7), auto-saves the session, and runs commands, peers' sync events and catch-up one at a time in arrival order.
- `src/protocol.js` — message catalogue and validators (§5.4).
- `src/applyCommand.js` — one command → calls on juicebox.js's public surface (§5.2).
- `src/observe.js` — viewer changes → sync events, and applying peers' sync events without echoing them (§5.3).
- `src/sessionToRestore.js` — decodes and validates the room's saved session.
- `src/WebSocketClient.js` — the prototype's reconnecting client, with an injected socket factory.

The package never imports juicebox.js: the host passes its namespace as `hic`, and `juicebox.js >=4.6.0 <5` is a peer dependency. Tests drive `attachRemote` with a fake `hic` and a fake socket. The root `.npmrc` sets `legacy-peer-deps` only because 4.6.0 is not on npm yet (remove it once it is). Publishing: a GitHub release tagged `remote-v<version>` runs `.github/workflows/publish-remote.yml` (npm trusted publishing).

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
