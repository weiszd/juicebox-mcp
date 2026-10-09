# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI control for the juicebox.js Hi-C contact map viewer, as a plug-in. Two packages in an npm-workspaces monorepo:

- `packages/remote` — `@aidenlab/juicebox-remote`, a browser library that attaches a juicebox.js viewer to a room on the server so an LLM can drive it and peers stay in sync.
- `packages/server` — the Cloudflare Worker MCP server (`/mcp`) plus a Durable Object per room (`/ws`). Deployed with wrangler, never published.

The viewer itself lives upstream in juicebox.js (the fork build `juicebox.js@mcp`, 4.10.0-mcp.x, until the hooks land upstream), and the hosting web page is juicebox-web. Neither is vendored here. The design is `docs/design/ARCHITECTURE_V2.md`; decisions are in `docs/adr/`.

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
npm run deploy:server          # wrangler deploy (the prototype Worker on jbmcp.3dg.io)
(cd packages/server && npx wrangler deploy --env dev)   # the Juicebot dev Worker, juicebot-mcp-dev.3dg.io
scripts/deploy-web-dev.sh      # build ../juicebox-web (fork master) → Pages juicebot-web-dev, juicebot-dev.3dg.io
scripts/deploy-wizard.sh       # maintainer deploy + onboarding, interactive (login, secrets, Pages var, clients); DEPLOY_ENV=dev
```

Server config lives in `packages/server/wrangler.toml` (`[vars]`: `BROWSER_URL`, `TINYURL_DOMAIN`, `TINYURL_ENDPOINT`, `ALLOWED_ORIGINS` — the exact-match `Origin` allow-list for `/ws`). It declares the `jbmcp.3dg.io` custom domain. Development runs on the separate **Juicebot dev** stack (`[env.dev]`: Worker `juicebot-mcp-dev` at juicebot-mcp-dev.3dg.io, page at juicebot-dev.3dg.io); the earlier demo stack (`[env.v2]`, juicebox-mcp-v2 + juicebox-v2.3dg.io) is frozen at tag `demo-2026-10` and is not redeployed. "Juicebot" is the product name of the AI-enabled juicebox; the dev stack carries a `-dev` suffix everywhere so the production release only adds the un-suffixed names. Secrets `TINYURL_API_KEY` and `SESSION_HMAC_SECRET` are set with `wrangler secret put` (locally in `packages/server/.dev.vars`, from `.dev.vars.example`); without `SESSION_HMAC_SECRET` the `x-openai-session` (ChatGPT) path fails rather than using a default key.

## Architecture

The server code is the prototype's Worker, moved as-is. Where it differs from the accepted design, the design wins and the ticket that closes the gap is named in `.scratch/v2/issues/`.

### Two channels

1. **MCP protocol** — client ↔ Worker over stateless Streamable HTTP on `/mcp` (JSON responses; a fresh `McpServer` per request; `GET /mcp` is rejected with 405). The MCP session id is minted on `initialize` as a room id (or derived by HMAC from `x-openai-session`); the session is bound to that room until `join_room` rebinds it.
2. **WebSocket** — page ↔ the room's Durable Object on `/ws?room=`. The Worker refuses an `Origin` not on `ALLOWED_ORIGINS` (403) and mints a 10-char Crockford base32 room when `room` is absent; the page's `join` is answered `joined {room}`; sync events go to every other socket in the room. Tool handlers never return visualization results; they push a `{type: '...'}` command into the bound room's Durable Object, which adds a `requestId`, sends it to every page, and waits up to 10 s for the first `ack`. No page → error result; no ack → "sent, unconfirmed". Request tools (`list_tracks`, `save_session`, `create_shareable_url`) ask only the first live page and read the ack's `result`; that page closing fails the request at once.

A tool call flows: client → `/mcp` tool handler → Durable Object → WebSocket → the page (today: nothing, the prototype frontend is gone; in v2: `@aidenlab/juicebox-remote` → juicebox.js public surface).

### `packages/server`

- `src/index.js` — Worker entry: routes, CORS, MCP transport, session and room id minting, `/ws` Origin check.
- `src/durableObjects/WebSocketRoom.js` — one Durable Object per room; owns the sockets, relays sync events to other peers, fans commands out and waits for acks, keeps the last saved session for late joiners (`requestSessionFromPeer` → `peerSessionData`). Every message re-arms an alarm 24 h out; it deletes the room's storage and, if no page is left, marks the room expired so later joins get `error {code: 'room-expired'}` (ADR-0006).
- `src/durableObjects/McpSession.js` — one Durable Object per MCP session; stores the room `join_room` bound it to (`getRoom`/`setRoom` over RPC).
- `src/room.js` — the only way the Worker reaches a room: `roomForSession(env, sessionId)` resolves the session's room (the `join_room` binding, else the session id) and returns a handle (`send`, `request`, `isConnected`, `current`, `bind`) over the two Durable Objects' RPC methods, and re-exports the room's ack outcomes (`AckStatus`) and `ACK_TIMEOUT_MS` for the tools.
- `src/mcp/toolHandlers.js` — the single `registerTools(mcpServer, deps)` tool catalogue: the command tools as rows of `COMMAND_TOOLS` registered in one loop, the request and local tools hand-registered. `deps` is `{sessionId, browserUrl, shortenURL, log, room}`, `room` being that handle.
- `src/search/` — dataset search pipeline: `catalogs` (ENCODE and 4DN igv-data TSV URLs + columns, copied from juicebox-web; keep in sync) → `dataSourceConfigs` (how each TSV is read) → `dataParsers` → `metadataEnricher` → `queryExpander` (genomics synonym dictionary) → `mapFilter` → `resultFormatter`. Beside it, `encodePortal.js` is the live ENCODE portal client behind `search_encode_hic` / `search_encode` (portal facts in its header).
- `src/mcp/juiceboxView.js` — the MCP App view (`ui://juicebox/join`, SEP-1865) that `get_juicebox_url` names in `_meta`: a card with the join link and its QR (from `structuredContent`), shown in the app pane by hosts that render MCP Apps; the link opens through the host. Claude's sandbox forbids framing other origins, so the viewer itself is not embedded.
- `src/qrPng.js`, `src/urlShortener.js` — join-link QR and TinyURL helpers.
- `src/lib/logger.js` — use `logInfo`/`logWarn`/`logError` in server code; **no `console.log` in tool paths**.

### `packages/remote`

Publishable to npm as plain ESM, no build step; exports `.` (`src/attachRemote.js`) and `./protocol` (`src/protocol.js`, imported by the server too). The API, statuses and "no UI" contract are in `packages/remote/README.md`; the design is §5.

- `src/attachRemote.js` — `attachRemote({hic, container, url, room?, onStatus?, onToolCall?, createSocket?})` → `{room, joinUrl, detach}`. Joins the room, catches up from it (the room wins, §7), auto-saves the session, and runs commands, peers' sync events and catch-up one at a time in arrival order.
- `src/protocol.js` — message catalogue and validators (§5.4).
- `src/applyCommand.js` — one command → calls on juicebox.js's public surface (§5.2).
- `src/observe.js` — viewer changes → sync events, and applying peers' sync events without echoing them (§5.3).
- `src/panels.js` — the panel rules of ADR-0007/0008 in one place, called by both of the above: resolve a panel spec (position, unique map name, `"all"`, omitted) or a sync event's position to browsers, open (`"new"`, or a peer's `panelOpen` at exactly one past the last) and close (never the last) a panel, find a track by number or case-insensitive name, and the track operations (remove, colour, name, data range, autoscale, log scale) with the 2D-track guard. Map-level operations stay in `applyCommand.js`.
- `src/sessionToRestore.js` — decodes and validates the room's saved session.
- `src/WebSocketClient.js` — the prototype's reconnecting client, with an injected socket factory.

The package never imports juicebox.js: the host passes its namespace as `hic`, and `juicebox.js >=4.10.0-mcp.1 <5` is a peer dependency (the fork build, published from weiszd/juicebox.js to the `mcp` dist-tag; a plain range would never pick a pre-release). Tests drive `attachRemote` with the shared fake `hic` and fake socket (`test/fakeJuicebox.js`); `src/panels.js` also has its own spec against that fake (`test/panelsModule.test.js`). Publishing: a GitHub release tagged `remote-v<version>` runs `.github/workflows/publish-remote.yml` (npm trusted publishing).

### Adding or changing a tool

A command tool (one that sends one command to the pages) is a row of `COMMAND_TOOLS` in `packages/server/src/mcp/toolHandlers.js`: name, title, description, inputSchema, the `CommandType` member, the progress text, `rgb` for hex arguments the page takes as rgb, and only if needed a `command` override (refusals, parsing, presets) or a `failure` wording. Add the `CommandType` in `packages/remote/src/protocol.js` and its applier row in `packages/remote/src/applyCommand.js`, and the row to the payload table in `packages/server/test/mcp.test.js`; a consistency test requires every `CommandType` except `GET_*` to have exactly one tool. Request tools and local tools are hand-registered in the same file. Regenerate nothing: names, titles, descriptions and schemas are the client contract, pinned by `packages/server/test/fixtures/prototype-tools.json`, which changes only when the contract deliberately does.

## Conventions

- ESM throughout (`"type": "module"`), no TypeScript, no linter.
- Tool input schemas use zod; colors are `#rrggbb` hex.
- Tests drive one package's public seam and assert what leaves it (socket messages, viewer calls, HTTP responses); no reaching into internals. Two exceptions: the search pipeline, whose pure modules are specced directly (design: "the prototype's vitest specs move with the modules"), and the remote's panels module (`packages/remote/src/panels.js`), specced through its own interface against the shared fake juicebox.js because both the command and the sync-event paths depend on it.
- `.scratch/` (local issue tracker) and per-developer `.claude/settings*.json` are gitignored.

## Further docs

- `CODING_STANDARDS.md` — judgement rules applied at code review (the mechanical ones are the tests and CI).
- `docs/local-testing.md` — local relay + page, and driving the dev stack with `scripts/dev-check.mjs`.
- `docs/design/ARCHITECTURE_V2.md` — the accepted design (protocol tables in §5, repo plan in §9).
- `docs/adr/` — architecture decision records.
- Prototype-era notes (`docs/mcp-notes/`, `docs/datasource-notes/`, `docs/development-notes/`) are on branch `prototype` only (`git show prototype:docs/…`); still accurate for the search pipeline and MCP tool reference, stale where they describe the Node server or the vendored viewer.

## Agent skills

### Issue tracker

Issues live as local markdown under `.scratch/<feature>/` in this repo (no GitHub issues; the fork has them disabled). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root plus `docs/adr/`, both created lazily. See `docs/agents/domain.md`.
