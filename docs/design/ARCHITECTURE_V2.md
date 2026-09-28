# Architecture v2 — AI control for juicebox.js as a plug-in

Status: **proposed**, 2026‑09‑27. Supersedes §6 of
`docs/development-notes/PORTING_MCP_TO_JUICEBOX_JS.md`, which stays as the
historical record of the prototype. Decisions below were taken by D. Weisz on
2026‑09‑27; rationale is recorded so they can be revisited.

## 1. Goal

Let an MCP client (Claude Desktop, Claude Code, ChatGPT, Cursor, …) drive a
juicebox.js viewer running on **any web page**, keep several such pages in
sync, and let a late joiner catch up — without the viewer library, the shell
that hosts it, or the page knowing anything about MCP.

Non‑goals for v2: a redesign of juicebox-web's UI; offline operation;
authentication beyond what §6.4 lists.

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **juicebox-web is the host shell.** The prototype's own frontend (`index.html`, `src/Application.js`, vendored `js/`, hamburger menu, Netlify build) is retired. | juicebox-web already owns catalogs, share/shortlink, `?session=` restore, two Cloudflare workers, and subscribes to `coordinator.addCallback` / `EventBus`. Duplicating it bought nothing. |
| D2 | **Separate origins.** juicebox-web on its own origin; MCP + WebSocket on `jbmcp.3dg.io`. | Keeps juicebox-web's deploy untouched; the control layer is opt‑in per page. Cost: `VITE_WS_URL` at build time and an `Origin` check on `/ws`. |
| D3 | **One server implementation: the Cloudflare Worker.** Streamable HTTP `/mcp`, `/ws` → Durable Object. `server.js` (express + `ws` + STDIO) is retired. Local use = `wrangler dev`. | Every target client speaks Streamable HTTP (Claude Desktop custom connector, `claude mcp add --transport http`, ChatGPT connector, Cursor); `mcp-remote` bridges the few that don't. Removes the 27‑tool duplication and the esbuild/`.mcpb` bundling of a whole Node server. |
| D4 | **Catalog source of truth = juicebox-web's** `js/*ContactMapDatasourceConfig.js` (igv‑data GitHub copies of the ENCODE/4DN/AidenLab TSVs). | Same files as the S3 copies the prototype used; one config, one URL to rotate. |
| D5 | **The browser‑side control layer is its own package, `@aidenlab/juicebox-remote`**, with no DOM and no shell assumptions. | Must be reusable from any site embedding juicebox.js (Spacewalk, third parties). Also makes it node‑testable, which juicebox.js's ADR‑0013 asks for. |
| D6 | **juicebox.js gains only generic observability hooks** — coordinator callbacks and one event — never WebSocket, MCP, or room vocabulary. | Keeps the viewer a component. The hooks are equally useful to juicebox-web itself. |
| D7 | **Two distinct link kinds stay distinct: *snapshot link* and *join link*** (§7). | They solve different problems and were being conflated as "the QR code". |
| D8 | **Repo strategy:** `juicebox-mcp` stays a separate repo and restarts with a clean tree; current `main` is preserved as branch `prototype` + tag (§9). | Node `.mcpb` server and Worker were prototype‑era; a clean tree makes the v2 layout legible. History remains reachable. |

## 3. Components

```
                 ┌────────────────────────────────────────────────┐
 MCP client ───► │ juicebox-mcp (Cloudflare Worker)                │
 (Streamable     │  /mcp  tools ─► deps.sendCommand ─┐             │
  HTTP)          │  /ws   ◄─── Durable Object "room" ◄┘  relay     │
                 └───────────────▲────────────────────────────────┘
                                 │ wss  {type, ...}  (protocol.js)
      ┌──────────────────────────┴─────────────────────────────┐
      │ any web page                                           │
      │   @aidenlab/juicebox-remote   attachRemote({hic, …})   │
      │       applyCommand ─► juicebox.js public surface        │
      │       observe      ◄─ coordinator callbacks / EventBus  │
      │   juicebox-web shell: ?room= param, status/QR widget    │
      └────────────────────────────────────────────────────────┘
```

Dependency direction (arrows = "imports"):

```
juicebox-web ──► @aidenlab/juicebox-remote ──► juicebox.js (peer dependency)
juicebox-mcp ──► @aidenlab/juicebox-remote/protocol   (message types only)
juicebox-mcp ──► juicebox-web catalog config          (D4; see §10 Q2)
```

Nothing imports juicebox-mcp. juicebox.js imports nothing from the others.

## 4. juicebox.js — additions (generic, manifest‑declared, tested)

All additions go through `js/publicApi.js` and `test/testPublicApi.js`; no
"MCP", "room" or "WebSocket" wording anywhere in the library.

| Change | File(s) | Why |
|---|---|---|
| Expose existing coordinator methods as subscribable callbacks: `onColorScale(colorScale)`, `onNormalizationChange(normalization)`, `onNormalizationSubstituted(normalization, reason)`, `onDisplayMode(mode)` | `js/browserCoordinator.js` (`callbacks` map, lines ~56–62), `js/publicApi.js` `COORDINATOR_CALLBACKS` + `COORDINATOR_PAYLOAD_SHAPES` | Replaces the prototype's monkey‑patching of `notifyColorScale`, `setColorScaleThreshold`, `repaintMatrix`, `setNormalization`, `setDisplayMode`. Substitution (ADR‑0012) must be observable so a peer mirrors the *effective* normalization. |
| New global event `TrackXYPairChange`, payload `{trackPair, property, value}`, posted from `TrackPair.setColor`, `setDataRange`, `setTrackLabelName`, and wherever `track.autoscale` / `track.logScale` are toggled (gear menu) | `js/trackPair.js`, `js/trackGearPopup.js`; `EVENTS_POSTED` + `EVENT_PAYLOAD_SHAPES` | The only mutations with no event today; the prototype used `Object.defineProperty` setters. |
| Add to `BROWSER_SURFACE`: `controlDataset`, `trackPairs`, `tracks2D`, `zoomAndCenter`, `setColorScaleThreshold`, `setNormalization`, `setDisplayMode`, `getDisplayMode`, `getColorScale`, `getSyncState`, `syncState` | `js/publicApi.js` | All exist and are used by the remote layer; declaring them makes "no callers in this repo" a complete finding (ADR‑0003). |
| `parseGotoInput` accepts the prototype's extra spellings: `chr1 10mb-20mb`, `chromosome 1`, `1:1000-2000`, `kb`/`mb` suffixes, and `{chr, start, end}` objects | `js/interactionHandler.js` (`parseGotoInput`, `parseLocusString`) + tests | Port of `normalizeLocusInput` / `parseLocusInputFlexible`. Generic locus parsing belongs in the viewer; the NLP that extracts a locus from a sentence does **not** (server, §6). |

Not added: `parseMapAndLocusCommand`, `ColorScaleManager`, `NotificationCoordinator`
changes — upstream already solved those differently.

## 5. `@aidenlab/juicebox-remote`

Location: `juicebox-mcp/packages/remote` (npm workspace), published to npm.
Peer dependency: `juicebox.js >= 4.5` (the version carrying §4).

```
packages/remote/
  src/
    protocol.js        # message catalog + tiny validators; imported by the server too
    applyCommand.js    # (hic, container, command) → calls on the public surface
    observe.js         # subscribe to coordinator/EventBus → emit sync events
    WebSocketClient.js # from the prototype, unchanged
    attachRemote.js    # public entry point
  test/                # vitest + jsdom, a fake hic namespace + fake socket
```

### 5.1 API

```js
import { attachRemote } from '@aidenlab/juicebox-remote'

const remote = attachRemote({
  hic,                      // the juicebox.js namespace import (peer dep, no double bundle)
  container,                // element passed to hic.init / needed by hic.restoreSession
  url: 'wss://jbmcp.3dg.io/ws',
  room: 'c0ffee…',          // from the page URL (§7)
  onStatus: (s) => {},      // 'connecting' | 'open' | 'closed' ; optional
  onToolCall: (name) => {}, // for a toast; optional
})
remote.detach()             // unsubscribe everything, close socket
```

The package ships **no UI**. A host that wants a status dot, QR or toast
renders it from `onStatus` / `remote.joinUrl`.

### 5.2 Commands → public surface

| Command | Applied as |
|---|---|
| `loadMap {url,name,normalization,locus}` | `browser.loadHicFile(config)` |
| `loadControlMap` | `browser.loadHicControlFile(config)`; then `setDisplayMode('AOB')` if both maps present |
| `loadSession {session}` | `hic.restoreSession(container, session)` |
| `gotoLocus {locus}` | `browser.parseGotoInput(locus)` (§4) |
| `zoomIn` / `zoomOut` | `browser.zoomAndCenter(±1, cx, cy)` |
| `setForegroundColor {r,g,b}` | `browser.getColorScale().setColorComponents(...)`; `contactMatrixView.setColorScale` |
| `setBackgroundColor` | `contactMatrixView.setBackgroundColor(rgb)` |
| `setColorScale {op, value}` | `browser.setColorScaleThreshold(t)` |
| `setNormalization` | `browser.setNormalization(n)` |
| `loadTrack {configs}` | `browser.loadTracks(configs)` (does not await completion — ADR‑0017) |
| `getTrackList {requestId}` | enumerate `browser.trackPairs` then `browser.tracks2D` → reply `trackListData` |
| `removeTrack`, `setTrackColor`, `setTrackName`, `setTrackDataRange`, `setTrackAutoscale`, `setTrackLogScale` | resolve by name or 1‑based index, then `layoutController.removeTrackXYPair(tp)` / `tp.setColor` / `tp.setTrackLabelName` / `tp.setDataRange` / `tp.track.autoscale=` / `tp.track.logScale=` |
| `getSession` / `getCompressedSession {requestId}` | `hic.toJSON()` / `hic.compressedSession()` → reply |
| `syncEvent` | §5.3, with the re‑entrancy guard |
| `peerSessionData` | validate, then `hic.restoreSession` |
| `toolCall {name}` | `onToolCall(name)` only |

### 5.3 Observed changes → sync events

| Source (juicebox.js) | Sync event |
|---|---|
| `addCallback('onLocusChange')` (`dragging` in payload) | `locusChange {syncState: browser.getSyncState()}` — throttled while dragging, debounced otherwise |
| `addCallback('onColorScale')` | `colorScaleChange` (threshold + rgb, or signed components) |
| `addCallback('onBackgroundColorChange')` | `backgroundColorChange` |
| `addCallback('onNormalizationChange')`, `('onNormalizationSubstituted')` | `normalizationChange` (effective value) |
| `addCallback('onDisplayMode')` | `displayModeChange` |
| `addCallback('onMapLoaded')`, `('onControlMapLoaded')` | `mapLoad` / `controlMapLoad` (url, name read off `dataset`) |
| `EventBus` `TrackXYPairLoad` / `TrackXYPairRemoval` / `TrackXYPairChange` | `trackLoad` / `trackRemove` / `track*Change` |

Receiving a `syncEvent` sets `isSyncing = true` around the apply so the
resulting callbacks are not re‑emitted. Same rule as the prototype.

### 5.4 Protocol (`protocol.js`)

Unchanged from the prototype (`PORTING_MCP_TO_JUICEBOX_JS.md` §5) except:
`registerSession {sessionId}` → `join {room}`; the URL query parameter
`sessionId` → `room` (§7). Message shapes are exported as constants plus
`isCommand(msg)` / `isSyncEvent(msg)` guards so both ends share one spelling.

## 6. `juicebox-mcp` server v2 (Worker only)

```
juicebox-mcp/
  packages/remote/            (§5)
  packages/server/
    src/index.js              Worker entry: /mcp, /ws, CORS
    src/room.js               Durable Object (was WebSocketRoom.js)
    src/tools.js              registerTools(mcpServer, deps) — single definition
    src/search/               dataParsers, metadataEnricher, queryExpander, mapFilter, resultFormatter
    src/qrPng.js, urlShortener.js
    wrangler.toml
  packages/connector-mcpb/    manifest.json → `npx mcp-remote https://jbmcp.3dg.io/mcp`
  docs/
```

- **Run modes:** `wrangler dev` (local, DO emulated) and `wrangler deploy`.
- **Clients:** Claude Desktop → custom connector (remote) or `mcp-remote`
  (local); Claude Code → `claude mcp add --transport http`; ChatGPT →
  connector (existing `x-openai-session` HMAC fallback); Inspector/Cursor native.
- **Tool changes vs prototype:**
  - `get_juicebox_url` → returns the **join link** (§7) + QR PNG.
  - `create_shareable_url` → returns the **snapshot link** (asks the browser for
    `compressedSession()`, shortens via juicebox-web's `jb-shortlink` worker
    instead of TinyURL — §10 Q3).
  - `save_session` → returns the session JSON as a text result (no filesystem).
  - `search_maps` and friends read the juicebox-web catalog config (D4).
  - Everything else: same names, same schemas.
- **Retired:** `server.js`, esbuild bundle, express/ws/cors/dotenv deps, the
  2.3 MB `.mcpb` at the repo root, `.history/`.

### 6.4 Security baseline

- `/ws` upgrade: reject unless `Origin` is on an allow‑list (`wrangler.toml`
  var). WebSockets are not covered by CORS.
- Room ids are server‑minted UUIDs (or HMAC of `x-openai-session`); a client
  cannot reach a browser it was not paired with.
- `TINYURL_API_KEY` — if kept at all — is a `wrangler secret`, never in a
  manifest.
- OAuth (`@cloudflare/workers-oauth-provider`) is a later, additive step.

## 7. Two links, two purposes

| | **Snapshot link** | **Join link** |
|---|---|---|
| Carries | `?session=<compressed session JSON>` — the whole view, serialized (juicebox.js wire format v1, ADR‑0006) | `?room=<id>` — a pointer to a live relay room |
| Needs | nothing but juicebox-web | the MCP/WS server running |
| Lifetime | permanent; a link in a paper must decode years later | while the room exists |
| Who makes it | juicebox-web share modal; MCP `create_shareable_url` | MCP `get_juicebox_url`; juicebox-web room widget |
| Opening it | reproduces the view, standalone | joins the room, receives current state from a peer (or the room's last auto‑save), then follows the room |
| QR | share modal (existing `qrcode.js`) | room widget (same `qrcode.js`, different URL) |

Both exist in juicebox-web, in different widgets, and the words *snapshot* and
*join* are used in code, UI labels and tool descriptions. A URL may carry
both parameters: restore the snapshot first, then join. The parameter is
renamed from `sessionId` to `room` because "session" already means the
serialized JSON in juicebox.js's `CONTEXT.md` and the MCP transport's
`mcp-session-id`; three meanings on one word was the source of the conflation.

## 8. juicebox-web integration

One shell‑owned widget (juicebox-web vocabulary: a *widget*), roughly 50 lines:

- on load, read `?room=`; if present, `attachRemote({hic, container, url: import.meta.env.VITE_WS_URL, room, …})`;
- a connection indicator in the navbar; a "Join link" QR entry in the share
  area, clearly separate from the snapshot share modal (§7);
- `onToolCall` → the existing alert/toast area.

No other change to the shell. The `embed.html` distribution can attach the
same way, which is the "any web page" proof.

## 9. Repository plan for `juicebox-mcp`

Preserve, then restart clean, without a force push:

```bash
# 0. land PR #1 (docs) on main first so the history branch carries it
# 1. freeze the prototype
git branch prototype main
git tag v1.1.0-prototype main
git push origin prototype v1.1.0-prototype
# 2. one commit on main that empties the tree except what carries over
git rm -r --cached . && git clean -fdx   # then restore the keep-list below
git commit -m "chore: start v2 layout; prototype preserved on branch 'prototype'"
```

Keep‑list from the prototype (moved into the v2 layout, not rewritten):
`worker/index.js`, `worker/durableObjects/WebSocketRoom.js`,
`worker/mcp/toolHandlers.js`, `worker/lib/logger.js`, `wrangler.toml`,
`src/WebSocketClient.js`, `src/dataParsers.js`, `src/metadataEnricher.js`,
`src/queryExpander.js`, `src/mapFilter.js`, `src/resultFormatter.js`,
`src/qrPng.js`, `src/urlShortener.js`, `docs/`, `LICENSE`, `CODE_OF_CONDUCT.md`,
`CONTRIBUTING.md`, `.gitignore`.

Dropped: `js/`, `css/`, `index.html`, `src/Application.js`, `src/main.js`,
`src/dataSourceConfigs.js`, `server.js`, `esbuild.config.js`, `build-mcpb.js`,
`manifest.json`, `*.mcpb`, `netlify.toml`, `vite.config*.js`,
`vite-plugin-version.js`, `scripts/`, `test/` (viewer tests belong upstream),
`dev/`, `*.code-workspace`.

Alternative if a truly empty `git log` is wanted: `git checkout --orphan v2`,
commit the keep‑list, `git branch -M v2 main`, `git push --force origin main`.
Same result for the tree; breaks any existing clone's `main`. Not recommended.

## 10. Order of work, with verification

1. **juicebox.js §4** — PRs with manifest + tests. Verify: `test/testPublicApi.js` green; juicebox-web unchanged and green against the new version.
2. **`packages/remote`** — `protocol.js`, `applyCommand`, `observe`, `attachRemote`. Verify: jsdom tests with a fake `hic` namespace covering every row of §5.2/§5.3.
3. **`packages/server`** — move Worker code, single `tools.js`, catalog import (D4), `Origin` check. Verify: `wrangler dev` + MCP Inspector, all 27 tools; ChatGPT HMAC path unchanged.
4. **juicebox-web widget §8** — `?room=`, indicator, join‑link QR. Verify: two tabs on one room stay in sync for every §5.3 event; a third tab opened late receives the state; a snapshot link still restores with the server down.
5. **Client onboarding** — Claude Desktop custom connector, `mcp-remote` local recipe, `connector-mcpb`. Verify: each drives a map load end to end.
6. **Repo restart §9**, README, retire prototype docs to the `prototype` branch.

## 11. Open questions

- **Q1** juicebox.js version that carries §4 — bump minor (4.5.0) and pin
  `@aidenlab/juicebox-remote`'s peer range to it?
- **Q2** D4 makes the server import a file from the juicebox-web repo. Options:
  publish the catalog configs as a tiny package, or copy the three files into
  `packages/server` with a "source: juicebox-web" header. Lean: copy; they change rarely.
- **Q3** URL shortener: keep TinyURL (`t.3dg.io`) or call juicebox-web's
  `jb-shortlink` worker? One shortener is enough; whichever owns the domain.
- **Q4** Should the Durable Object persist the last auto‑saved session in DO
  storage (survives eviction) or in memory only (prototype behaviour)?
- **Q5** Room id in the join link: raw UUID, or short id so the QR stays small?
