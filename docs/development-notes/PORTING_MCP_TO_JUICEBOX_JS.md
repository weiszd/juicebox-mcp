# Porting the MCP / WebSocket layer to current juicebox.js

This document records what `juicebox-mcp` changed relative to the juicebox.js it
was forked from, in two stages, and what it takes to bring the MCP/WebSocket
functionality to the current upstream `aidenlab/juicebox.js`. It is written for
whoever does the port, and every claim below was checked against the git history
of this repo and a checkout of upstream `main` (v4.4.1, commit `f1a50ed`,
2026-09-16).

## 1. Lineage

| Stage | Repo | Commits | Base |
|---|---|---|---|
| 0 | `aidenlab/juicebox.js`, branch `juicebox-mcp` | — | juicebox.js **2.5.3** |
| 1 | `aidenlab/juicebox-mcp` | `1548a3b` (2025-12-09) … `0149fd1` (2026-01-06), 32 commits by Douglass Turner | fork of stage 0 |
| 2 | `weiszd/juicebox-mcp` | `a53ede4` (2026-03-23) … `ce76b4b` (2026-03-27), 15 commits by David Weisz | stage 1 |
| target | `aidenlab/juicebox.js` `main` | — | **4.4.1** |

Stage 1: 76 files, +9 726 / −1 690. Stage 2: 13 files, +3 524 / −143.

Upstream has moved two major versions since the fork point. It is now an
**embeddable component** (npm package exporting `dist/juicebox.esm.js`) with a
declared public API (`js/publicApi.js`, ADR‑0003), a browser registry per host
container (ADR‑0004), a single session decoder (ADR‑0006), and a `CONTEXT.md`
glossary. Nine of the `js/` files this fork modified or added no longer exist
upstream (`browserUIManager`, `colorScaleManager`, `notificationCoordinator`,
`renderCoordinator`, `stateManager`, `globals`, `igvjs-utils`, `igvRemoteFile`,
`liveMapDataset`); seventeen new ones appeared (`browserCoordinator`,
`browserRegistry`, `publicApi`, `syncGroup`, `sessionCodec`, `signedColorScale`,
`colorScaleParser`, `gestureRecognizer`, …).

**Consequence for the port:** the `js/` patches from stage 1 cannot be replayed.
The MCP layer has to be re‑attached to upstream's public surface, not
re‑forked.

## 2. What the fork is, in one paragraph

juicebox.js renders a Hi‑C contact map inside a host page. `juicebox-mcp` turns
it into a **standalone web app plus an MCP server**: an LLM client (Claude
Desktop, ChatGPT, Cursor) calls MCP tools; the server translates each tool call
into a JSON command pushed over a WebSocket to a browser tab running the app;
the app applies it through the juicebox browser API. Data flows back the same
way for session export, track listing, and shareable URLs. Several browsers can
share one session and stay in sync. Everything else — dataset search over
4DN/ENCODE catalogs, natural‑language locus parsing, URL shortening, QR codes,
Cloudflare Worker deployment — exists to serve that loop.

## 3. Stage 1 — `aidenlab/juicebox-mcp` (Turner, Dec 2025 – Jan 2026)

### 3.1 Repository shape: component → application

- **`index.html` added; Vite switched from library build to app build.**
  `vite.config.js` now has `rollupOptions.input: index.html`, outputs
  `dist/index.html` + `css/juicebox.css`, and copies `css/img`. A second
  `vite.config.netlify.js` differs only in `sourcemap: false` and no `publicDir`.
  `netlify.toml` deploys `dist` with an SPA redirect. (Netlify hosting later ran
  into S3 CORS problems — commits `ddb488c`…`10dcacd` — which is part of why
  stage 2 moved to Cloudflare.)
- **`src/` created** as the application layer above the library:
  `main.js` (boots `Application` with a minimal config; also documents the
  legacy and "enhanced" config formats), `Application.js`, `WebSocketClient.js`,
  and the search pipeline (§3.4).
- **`dashboard.html`, `notes/`, `vendor/colors.js` removed**; legacy `dev/*.html`
  harnesses moved to `dev/legacy/`; `docs/url.md` moved under
  `docs/development-notes/`.
- **MCPB packaging:** `esbuild.config.js` bundles `server.js` (with express
  and all deps, Node built‑ins external, plus a `createRequire` shim for dynamic
  requires) into `dist/juicebox-mcp-server.js`; `build-mcpb.js` zips it with
  `manifest.json` into a `.mcpb` for Claude Desktop. The committed
  `juicebox-mcp-20251219-164324.mcpb` is the release artifact.
- **Version plumbing:** `vite-plugin-version.js` rewrites `js/version.js` from
  `package.json` on each build; `scripts/sync-version-from-github.js` pulls the
  latest GitHub release tag into `package.json`, `manifest.json` and the
  hardcoded version in `server.js`.
- **New dependencies:** `@modelcontextprotocol/sdk`, `express`, `cors`, `ws`,
  `zod`, `dotenv`, `esbuild`, `archiver`, `qrcode` (stage 2).

### 3.2 `server.js` — the Node MCP server (new, ~1 800 lines at end of stage 1)

- `McpServer` from the MCP SDK with **two transports**: `StdioServerTransport`
  when spawned by Claude Desktop (detected by `!process.stdin.isTTY`), or
  Streamable HTTP via express on `/mcp` (`MCP_PORT`, default 3010) when forced
  with `MCP_TRANSPORT=http` / `FORCE_HTTP_MODE=true`.
- A **`ws` WebSocketServer on `WS_PORT` (3011)** that is always up, independent
  of the MCP transport. Browsers `registerSession` with a session id; the server
  keeps `Map<sessionId, Set<ws>>`.
- **Session routing.** In HTTP mode, `AsyncLocalStorage` (`sessionContext`)
  carries the MCP session id from the express handler into tool handlers, so
  `routeToCurrentSession(command)` reaches only that session's browsers, with a
  broadcast fallback. In STDIO mode a single `STDIO_SESSION_ID` (UUID) is
  minted at startup; `get_juicebox_url` returns `${BROWSER_URL}?sessionId=…`.
- **Request/response over the socket.** `requestSessionData` /
  `requestCompressedSessionData` push `{type:'getSession', requestId}` and
  resolve a promise from `pendingSessionRequests` when the browser answers
  `sessionData` / `sessionDataError` (10 s timeout).
- **File logging** (`$TMPDIR/juicebox-mcp-server.log`) because stdout is the
  MCP transport in STDIO mode.
- **17 tools** at end of stage 1: `load_map`, `load_control_map`,
  `load_session`, `zoom_in`, `zoom_out`, `set_map_foreground_color`,
  `set_map_background_color`, `create_shareable_url`, `get_server_status`,
  `get_juicebox_url`, `juicebox_help`, `list_data_sources`, `goto_locus`,
  `search_maps`, `get_data_source_statistics`, `get_map_details`,
  `save_session`. MCP **resources** expose the data‑source configs.
- **Shareable URL** (`create_shareable_url`): asks the browser for
  `juicebox.compressedSession()`, builds a frontend URL carrying it (no session
  id — a pure app URL, commit `d50642c`), and shortens via TinyURL
  (`src/urlShortener.js`, domain `t.3dg.io`).
- **`save_session`** writes the session JSON to the Desktop or a given path
  (Node fs; not available in the Worker).

### 3.3 `src/Application.js` + `src/WebSocketClient.js` — the browser bridge

- `Application.init(container, config)` calls `juicebox.init`, grabs
  `juicebox.getCurrentBrowser()`, reads `?sessionId=` from the page URL, and
  opens `WebSocketClient`. Without a session id the app runs standalone.
- A `commandHandlers: Map<type, handler>` dispatches incoming commands
  (`loadMap`, `loadControlMap`, `loadSession`, `zoomIn`, `zoomOut`,
  `setForegroundColor`, `setBackgroundColor`, `gotoLocus`, `getSession`,
  `getCompressedSession`, `toolCall`). `toolCall` only drives a 3 s on‑screen
  toast naming the tool.
- Handlers call straight into the library: `browser.loadHicFile`,
  `browser.loadHicControlFile`, `browser.parseLocusInputFlexible`,
  `browser.interactions.zoomAndCenter`, `browser.contactMatrixView.setColorScale
  / setBackgroundColor / clearImageCaches / update`, `browser.getColorScale`,
  `browser.setDisplayMode`, `juicebox.restoreSession / toJSON /
  compressedSession`.
- Loading a control map when a main map is present switches display mode to
  `AOB` (`_ensureAOBModeWhenBothMapsLoaded`, PR #9).
- `WebSocketClient` reconnects with backoff, polls until the socket is open,
  sends `registerSession`, and exposes `onCommand` / `onStatusChange`.

### 3.4 Dataset search pipeline (`src/`, shared by server flavors)

`dataSourceConfigs.js` declares each catalog (4DN, ENCODE) as a TSV URL plus
column names, `urlColumn`, `nameColumn`, `urlPrefix`. `dataParsers.js` fetches
and parses, then `metadataEnricher.js` derives species/assembly/tissue tags;
`queryExpander.js` expands the query with a genomics synonym dictionary
(human ↔ hg38/GRCh38, K562 ↔ K‑562, …); `mapFilter.js` scores; and
`resultFormatter.js` renders text or JSON for the LLM. Documented in
`docs/datasource-notes/`. This code has **no dependency on juicebox.js** and
ports verbatim.

### 3.5 Modifications inside the library (`js/`) — 10 files, +883 / −172

These are the changes that will *not* carry over, listed so their intent can be
re‑implemented against upstream.

| File | What changed | Why the bridge needed it |
|---|---|---|
| `colorScaleManager.js` (new, 102 lines) | Holds `colorScale`, `ratioColorScale`, `diffColorScale`; `getColorScaleForDisplayMode(mode)` | Single foreground scale shared by A and B modes, separate ratio scale for AOB/BOA (PR #8 "Improved AB Map Color Semantics"). See `docs/development-notes/COLOR_SCALE_REFACTORING.md`. |
| `contactMatrixView.js` (+208/−) | Constructor takes `colorScaleManager` instead of two scales; `getBackgroundColor()`; single background for all modes; null‑guards on `dataset`/`state`; renamed `ds`/`dsControl` → `contactMapDataset`/`controlMapDataset` | Color tools must set one scale and have it apply to both maps; guards let commands arrive before a map is loaded |
| `hicBrowser.js` (+83) | Parses `config.colorScale` / `config.ratioColorScale` strings (`R:threshold:pos:neg`); `getColorScale()` delegates to the manager; new `parseLocusInputFlexible(input)` and `parseMapAndLocusCommand(input)` (delegating to `interactions`); `toJSON` writes `ratioColorScale` | Session round‑trip of ratio colors; a single entry point for `goto_locus` that accepts strings *or* `{chr,start,end}` objects |
| `interactionHandler.js` (+336) | `parseLocusInputFlexible`, `normalizeLocusInput` (accepts "chr1 10mb‑20mb", "chromosome 1", gene names, `1:1000-2000`, "kb"/"mb" suffixes), `parseMapAndLocusCommand` (extracts lab / cell type / source / assembly + locus from one sentence), `_parseNumber`; `dragging` flag on locus‑change notifications | Natural‑language locus handling for the LLM; see `docs/development-notes/LOCUS_SPECIFICATION_ENHANCEMENTS.md`. The `dragging` flag is used in stage 2 to throttle vs debounce sync |
| `hicColorScaleWidget.js` (+237) | Rebuilt widget: foreground / background / negative‑ratio swatches, ±threshold buttons (`updateThreshold(browser, 0.5|2.0)`), ratio‑mode labels | UI parity with the new color model |
| `browserUIManager.js` | Creates `ColorScaleManager`, parses string `backgroundColor` | Wiring for the above |
| `controlMapWidget.js` | Drops its `eventBus.subscribe("DisplayMode")`; display mode now flows only through `NotificationCoordinator.notifyDisplayMode` | Remove duplicate notification path |
| `notificationCoordinator.js` | `notifyDisplayMode` reads scales from the manager; background swatch reads `getBackgroundColor()` | Wiring |
| `dataLoader.js` (+3) | Small guard/ordering fix around disabling updates during load | — |

Upstream 4.4.1 went a different way on the same problems: `SignedColorScale`
(`RatioColorScale`, `DiffColorScale`) + `colorScaleParser.js`, and the
`BrowserCoordinator` replaces `NotificationCoordinator`. The *behaviours* above
(one scale for A/B, ratio scale for AOB/BOA, threshold ×2/÷2) already exist
upstream; the *mechanism* does not need porting.

## 4. Stage 2 — `weiszd/juicebox-mcp` (Weisz, Mar 2026)

### 4.1 Cloudflare Worker deployment (`worker/`, `wrangler.toml`)

A second, parallel MCP server so the frontend, MCP endpoint and WebSocket all
live on one origin (`jbmcp.3dg.io`) with no local process:

- `worker/index.js` — routes `GET /ws` (WebSocket upgrade → Durable Object
  named by `sessionId`), `POST|DELETE /mcp` (MCP), `OPTIONS /mcp` (CORS),
  everything else → static `dist/` via the `[assets]` binding. `GET /mcp` (SSE)
  is rejected with 405; the transport runs in `enableJsonResponse` mode because
  Workers cannot hold long‑lived streams. **A fresh `McpServer` + transport is
  built per request** (Workers are stateless) and auto‑initialized for
  non‑`initialize` calls.
- **Session id fallback for ChatGPT** (commit `a515541`): ChatGPT does not echo
  `mcp-session-id` but sends `x-openai-session` on every request; the Worker
  HMAC‑SHA256s that token (secret `SESSION_HMAC_SECRET`) to derive a stable,
  opaque session id that is safe to put in the browser URL.
- `worker/durableObjects/WebSocketRoom.js` — one DO per session using the
  hibernation API (`state.acceptWebSocket`, `getWebSockets`). Internal HTTP
  routes `/send`, `/request-session-data`, `/request-compressed-session-data`,
  `/request-track-list`, `/status`. Relays `syncEvent` to peers, stores the last
  `saveSession`, serves `requestSessionFromPeer`.
- `worker/mcp/toolHandlers.js` — `registerTools(mcpServer, deps)`: the same 27
  tools as `server.js`, with all I/O injected through `deps`
  (`sendCommand`, `requestSessionData`, `requestCompressedSessionData`,
  `requestTrackList`, `isBrowserConnected`, `sessionId`, `browserUrl`,
  `shortenURL`, `log`). This dependency‑injected shape is the one to keep;
  `server.js` still has the tools inlined and should eventually consume the
  same module.
- `WebSocketClient` now connects to `${protocol}//${hostname}/ws` (was port
  3011) and appends `?sessionId=` so the Worker can pick the DO. `npm run
  dev:worker` builds with `VITE_WS_URL=ws://localhost:8787/ws`.

### 4.2 Multi‑browser session sync (commit `3d28f3f` and follow‑ups)

Any browser change is mirrored to the other browsers in the same session:

- The browser sends `{type:'syncEvent', syncType, ...payload}`; the server /
  DO relays it to the *other* sockets of that session (`sendToOthersInSession`).
- Receiving side: `Application._handleSyncCommand` applies it with an
  `_isSyncing` guard so it is not re‑broadcast.
- **Sync types:** `locusChange` (carries `browser.getSyncState()`, applied
  with `browser.syncState()`; throttled while dragging, debounced otherwise),
  `colorScaleChange` (threshold + rgb, or `isRatio` with positive/negative
  components), `backgroundColorChange`, `normalizationChange`,
  `displayModeChange`, `mapLoad`, `controlMapLoad`, `trackLoad`,
  `trackRemove`, `trackColorChange`, `trackNameChange`, `trackDataRangeChange`,
  `trackAutoscaleChange`, `trackLogScaleChange`.
- **How outgoing events are captured — by monkey‑patching the browser**
  (`_setupSyncEventListeners`, `_wrapTrackPairsSyncListeners`). The bridge
  wraps `browser.notifyLocusChange`, `notifyColorScale`,
  `setColorScaleThreshold`, `repaintMatrix`, `setNormalization`,
  `setDisplayMode`, `loadHicFile`, `loadHicControlFile`, `loadTracks`,
  `contactMatrixView.setBackgroundColor`, `layoutController.removeTrackXYPair`,
  and per track pair `setColor`, `setDataRange`, `setTrackLabelName`, plus
  `Object.defineProperty` setters on `track.autoscale` / `track.logScale`.
  This was the pragmatic choice on a 2.5.x fork with no event surface for these
  changes. **It is the single biggest thing to redo in the port** (§6.2).

### 4.3 Late joiners, auto‑save, QR code, menu

- **Peer session for late joiners** (`1b05223`, `8d194bf`, `de49802`): a
  browser that connects to a session with existing peers sends
  `requestSessionFromPeer`; the server asks a peer for `getSession` and returns
  `peerSessionData`, or serves the last auto‑saved compressed session
  (`savedSessions` / DO storage) if no peer is open. The browser validates the
  payload before `juicebox.restoreSession`.
- **Auto‑save**: the browser periodically sends `saveSession` with
  `juicebox.compressedSession()` so a session survives all tabs closing.
- **QR code** (`719e422`, `cd16ae0`): `#qr-code` in the page shows the session
  URL (client‑side `qrcode`); `get_juicebox_url` also returns a PNG QR as an
  MCP image (`src/qrPng.js`, pure‑JS PNG encoder so it runs in Workers).
- **Hamburger menu + URL modal** (`e83e7f6`): in‑page "Load map…" / "Load
  track…" so the app is usable without an LLM.

### 4.4 Ten new tools (`b5a5606`, `e9665d0`, `8346f76`, `ce76b4b`)

`load_track` (with `TRACK_PRESETS`, e.g. "gene track" → NCBI RefSeq Select for
the loaded assembly; 2D annotation files go through the same command),
`select_normalization` (in place, no reload; also calls
`browser.notifyNormalizationExternalChange` to refresh the widget),
`set_color_scale` (`increase` ×2 / `decrease` ÷2 / `set` exact threshold),
`list_tracks` (request/response `getTrackList` → `trackListData`, numbering 1D
pairs then 2D tracks), `remove_track`, `set_track_color`, `set_track_name`,
`set_track_data_range`, `set_track_autoscale`, `set_track_log_scale` (all
resolve a track by name or 1‑based index via `_findTrack`).

## 5. Protocol reference (what must survive the port unchanged)

The LLM‑facing tool names/schemas and the wire protocol between server and
browser are the contract; the library underneath can change freely.

**Server → browser commands** (`{type, ...}`): `toolCall`, `loadMap`,
`loadControlMap`, `loadSession`, `zoomIn`, `zoomOut`, `gotoLocus`,
`setForegroundColor`, `setBackgroundColor`, `setColorScale`,
`setNormalization`, `loadTrack`, `removeTrack`, `setTrackColor`,
`setTrackName`, `setTrackDataRange`, `setTrackAutoscale`, `setTrackLogScale`,
`getSession {requestId}`, `getCompressedSession {requestId}`,
`getTrackList {requestId}`, `peerSessionData`, `syncEvent`, `sessionRegistered`,
`error`.

**Browser → server messages:** `registerSession {sessionId}`,
`sessionData | sessionDataError {requestId}`,
`compressedSessionData | compressedSessionDataError {requestId}`,
`trackListData | trackListError {requestId}`, `saveSession
{compressedSession}`, `requestSessionFromPeer`, `syncEvent {syncType, …}`.

**MCP tools (27):** see `docs/mcp-notes/MCP_SERVER_TOOLS.md`; names listed in
§3.2 and §4.4.

## 6. Porting to juicebox.js 4.4.1

### 6.1 Strategy: host app, not fork

Upstream is explicit that juicebox.js is an embeddable component with a
manifest of what hosts may touch (`js/publicApi.js`; `test/testPublicApi.js`
enforces it). The right shape for the port is therefore **a host application
that depends on `juicebox.js` from npm** — the same relationship juicebox‑web
and Spacewalk have — rather than a copy of `js/`. Concretely:

```
juicebox-mcp/          (new layout)
  server.js, worker/   ← carried over as-is (see 6.4)
  src/                 ← Application.js rewritten against the public surface;
                          WebSocketClient.js, data*.js, qrPng.js, urlShortener.js unchanged
  index.html, vite.config.js
  package.json         ← "juicebox.js": "^4.4.1" (dependency, not vendored js/)
```

Anything the bridge needs that the public surface does not offer becomes a
small, reviewable upstream PR (§6.3), which is also what makes the feature
available to juicebox‑web later.

### 6.2 Surface audit: every library member the bridge touches

Checked against upstream `js/hicBrowser.js` and `js/publicApi.js`.

| Used by `Application.js` | Upstream 4.4.1 | Action |
|---|---|---|
| `juicebox.init`, `getCurrentBrowser`, `toJSON`, `restoreSession`, `compressedSession` | present; `initRegistry` added | Prefer `initRegistry(container, config)` and hold the **registry**; `registry.toJSON()` / `registry.restoreSession()` are the per‑embed session API (ADR‑0004, ADR‑0011). |
| `browser.loadHicFile`, `loadHicControlFile`, `loadTracks` | present, in `BROWSER_SURFACE` | Keep. Note `loadTracks` no longer awaits track completion (ADR‑0017, "pending track"). |
| `browser.dataset`, `controlDataset`, `activeDataset`, `tracks`, `trackPairs`, `contactMatrixView`, `layoutController`, `interactions` | present (`controlDataset`, `trackPairs`, `interactions` are *not* in the manifest) | Keep, but propose adding `controlDataset` and `trackPairs` to `BROWSER_SURFACE`. Avoid `interactions`; use `browser.zoomAndCenter(direction, cx, cy)` which is on the browser. |
| `browser.getColorScale`, `setColorScaleThreshold`, `setDisplayMode`, `getDisplayMode`, `setNormalization`, `repaintMatrix` | present | Keep. |
| `browser.getSyncState`, `syncState` | present (`state.getSyncState(dataset)`, refuses when not synchable) | Keep for cross‑machine locus sync. Cross‑tab sync is *not* the in‑page sync group (ADR‑0016) — different chromosome naming/resolution ordering is already handled by the sync‑state projection. |
| `contactMatrixView.setColorScale`, `setBackgroundColor`, `clearImageCaches`, `update` | present | Keep. `clearImageCaches({thresholds})` signature changed. |
| `layoutController.removeTrackXYPair` | present | Keep. |
| `browser.parseLocusInputFlexible` | **missing** | Upstream has `browser.parseGotoInput(input)` (gene names, `chr:start-end`, two‑locus input). Port `normalizeLocusInput` (the "10mb", "chromosome 1", object‑input handling) into the bridge as a pre‑processor that feeds `parseGotoInput`, or propose it upstream as an extension of `parseGotoInput`. `parseMapAndLocusCommand` belongs to the server, not the browser — move it to `src/`. |
| `browser.notifyColorScale`, `notifyNormalizationExternalChange`, `notifyLocusChange` | **missing** (were `NotificationCoordinator`) | Replace with `browser.coordinator` (§6.3). `setNormalization` upstream already calls `coordinator.onNormalizationChange`, so the extra "external change" notification is unnecessary. |
| `contactMatrixView.colorScaleManager` (via config parsing) | **missing** | Drop. Upstream parses `colorScale` / `ratioColorScale` strings itself (`colorScaleParser.js`, config schema in `docs/config-schema.md`). |

### 6.3 Replacing monkey‑patching with coordinator callbacks

Upstream's `BrowserCoordinator` is the declared host extension point
(`browser.coordinator.addCallback(name, fn)`, ADR‑0002). Today it accepts
`onMapLoaded`, `onControlMapLoaded`, `onLocusChange`, `onGenomeChange`,
`onBackgroundColorChange`, `onForegroundColorChange`, `onSyncRefused`. The
global `EventBus` additionally posts `TrackXYPairLoad`, `TrackXYPairRemoval`,
`BrowserSelect`, `BrowserTargetChange`, `GenomeChange`.

Mapping of the fork's sync sources:

| Fork hook (patched method) | Upstream mechanism | Gap |
|---|---|---|
| `notifyLocusChange` | `addCallback('onLocusChange')` — payload includes `dragging` | none |
| `setBackgroundColor` | `addCallback('onBackgroundColorChange')` | none |
| `notifyColorScale`, `setColorScaleThreshold`, `repaintMatrix` | coordinator has `onColorScale(colorScale)` and `onForegroundColorChange(rgb)` internally; only the latter is subscribable | **PR: expose `onColorScale` in `COORDINATOR_CALLBACKS`** (payload: the scale; hosts call `getThreshold()` / `getColorComponents()`) |
| `setNormalization` | coordinator `onNormalizationChange` / `onNormalizationSubstituted` exist internally | **PR: expose both.** Substitution matters: a peer must mirror the *effective* normalization (ADR‑0012) |
| `setDisplayMode` | coordinator `onDisplayMode(mode)` internal | **PR: expose** |
| `loadHicFile`, `loadHicControlFile` | `onMapLoaded {dataset, state, datasetType, browser}`, `onControlMapLoaded` | none — read `dataset.url` / `dataset.name` off the payload instead of the config |
| `loadTracks` | `EventBus.globalBus` `TrackXYPairLoad` (payload: the `TrackPair`; `track.config.format` is published shape) | none |
| `layoutController.removeTrackXYPair` | `TrackXYPairRemoval` | none |
| `trackPair.setColor / setDataRange / setTrackLabelName`, `track.autoscale / logScale` setters | **nothing** | **PR: post a `TrackXYPairChange {trackPair, property, value}` event from `TrackPair`** (methods exist upstream with the same names: `setColor`, `setDataRange`, `setTrackLabelName`). Until merged, wrapping the four `TrackPair` methods is the one place patching would remain — keep it isolated in one function. |

With those three or four small upstream additions the bridge holds no
references to library internals and survives future refactors.

### 6.4 What ports verbatim

- `server.js` and `worker/` — they never import from `js/`. Only
  `toolHandlers.js`'s `TRACK_PRESETS` and locus parsing text may need review.
  Consider making `server.js` consume `worker/mcp/toolHandlers.js` via `deps`
  so tools are defined once (already the stated intent in that file's header).
- `src/WebSocketClient.js`, `src/qrPng.js`, `src/urlShortener.js`, and the
  search pipeline (`dataSourceConfigs`, `dataParsers`, `metadataEnricher`,
  `queryExpander`, `mapFilter`, `resultFormatter`).
- `index.html` structure, the hamburger menu / URL modal / QR element / tool
  toast, and their CSS — after checking upstream's current `.hic-root` markup
  and `--hic-viewport-*` sizing variables.
- All of `docs/mcp-notes/` and `docs/datasource-notes/`.

### 6.5 What must be rewritten

- `src/Application.js`: keep the `commandHandlers` map and every `_handle*` /
  `_load*` method's *intent*, but re‑implement `_setupSyncEventListeners` and
  `_wrapTrackPairsSyncListeners` per §6.3, replace `parseLocusInputFlexible`
  per §6.2, and switch session export/restore to the registry.
- Session payloads: upstream now reads wire‑format **v0 and v1** and writes v1
  through one decoder (`sessionCodec.js`, ADR‑0006). Sessions saved by this fork
  (2.5.x `toJSON` plus the fork's `ratioColorScale` key) must be tested through
  `restoreSession`; the golden corpus in `test/data/wireFormatCorpus.js` is
  where a compatibility case belongs. Shareable URLs (`t.3dg.io/…`) already in
  circulation carry `compressedSession()` blobs — verify they still decode.
- Track identification for `list_tracks` / `remove_track` etc.: pending tracks
  (ADR‑0017) now appear before they finish loading; decide whether they are
  listed.

### 6.6 Suggested order of work

1. Scaffold the host app: `npm i juicebox.js@^4.4.1`, `index.html` +
   `src/main.js` calling `initRegistry`, confirm a map loads standalone.
2. Move `WebSocketClient`, search pipeline, `qrPng`, `urlShortener` in
   unchanged; wire `Application` with only the commands that map 1:1
   (`loadMap`, `loadControlMap`, `zoomIn/Out`, colors, normalization, display
   mode, `getSession`, `getCompressedSession`). Run `server.js` locally against
   it.
3. Re‑implement `gotoLocus` on `parseGotoInput` + a ported `normalizeLocusInput`.
4. Rebuild outgoing sync on `coordinator.addCallback` + `EventBus` for the
   events that exist; open the upstream PRs for `onColorScale`,
   `onNormalizationChange/Substituted`, `onDisplayMode`, `TrackXYPairChange`,
   and the `BROWSER_SURFACE` additions. Keep a single, clearly marked
   compatibility shim for track‑pair property changes until merged.
5. Track tools (`list/remove/set_track_*`) on `trackPairs` + `tracks2D`.
6. Peer session / auto‑save / QR / menu.
7. Worker deploy; run the three transports (STDIO via `.mcpb`, HTTP, Worker)
   against the same frontend build.
8. Wire‑format regression: restore a fork‑era session JSON and a fork‑era
   `t.3dg.io` link.

### 6.7 Things to know about upstream before starting

- **Public API is enforced.** `test/testPublicApi.js` fails when the manifest
  and reality diverge; any surface addition needs a manifest entry.
- **No browser‑level test automation** (ADR‑0013); the seam is tested from Node
  with jsdom. Upstream devDeps: `igv` 3.8.5, `igv-ui` v1.5.9, `igv-utils`
  v1.7.1, `hic-straw` v4.0.0, Vite 8, Vitest 4 — all newer than this fork's.
- **Teardown contract** (ADR‑0005): `dispose` / `reset` / `clearDataset`. A
  `loadSession` command should go through `registry.restoreSession`, not
  construct browsers itself.
- **Data hosts gate requests** (ADR‑0001): ENCODE sits behind an AWS WAF bot
  challenge that only `aidenlab.org` / `igv.org` origins pass, and the
  `hicfiles` / `dnazoo` S3 buckets require a recognised `User‑Agent`. Search
  results from `search_maps` point at exactly these hosts, so a localhost dev
  build needs upstream's `dev-proxy/` Vite plugin (`setUrlMapper`); production
  must be served from an approved domain. This is the same problem that broke
  the Netlify deployment in stage 1.
- **Vocabulary**: use `CONTEXT.md`'s terms in new code and PRs (registry, sync
  state, coordinator, chokepoint, substitution, pending track).
- **Secrets**: `manifest.json` in this repo carries a literal
  `TINYURL_API_KEY`; the Worker reads it from a `wrangler secret`. The ported
  `.mcpb` should take the key from user configuration rather than ship it.

## 7. Where to look in this repo while porting

| Topic | Files |
|---|---|
| Tool definitions (dependency‑injected) | `worker/mcp/toolHandlers.js` |
| Node server: transports, WS routing, peer sessions | `server.js` lines 139–460, 1843–2110 |
| Browser command handling & sync | `src/Application.js` (`commandHandlers` L56–125, `_setupSyncEventListeners` L180, `_wrapTrackPairsSyncListeners` L303, `_handleSyncCommand` L444, `_handlePeerSessionData` L627) |
| Durable Object protocol | `worker/durableObjects/WebSocketRoom.js` |
| Fork‑era library patches, for intent | `git diff 1548a3b 0149fd1 -- js/` |
| Stage‑2 additions | `git diff 0149fd1 HEAD` |
