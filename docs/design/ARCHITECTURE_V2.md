# Architecture v2 — AI control for juicebox.js as a plug-in

Status: **accepted**, 2026‑09‑28 (proposed 2026‑09‑27). Supersedes §6 of
`docs/development-notes/PORTING_MCP_TO_JUICEBOX_JS.md` (now on branch
`prototype` only), which stays as the historical record of the prototype. Decisions below were taken by D. Weisz;
the hard‑to‑reverse ones are recorded in `docs/adr/`, the vocabulary in
`CONTEXT.md`. §11 lists the answers to the open questions.

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
juicebox-mcp ──► juicebox-web catalog config          (D4; copied, see §11 Q2)
```

Nothing imports juicebox-mcp. juicebox.js imports nothing from the others.

## 4. juicebox.js — additions (generic, manifest‑declared, tested)

All additions go through `js/publicApi.js` and `test/testPublicApi.js`; no
"MCP", "room" or "WebSocket" wording anywhere in the library.

| Change | File(s) | Why |
|---|---|---|
| New subscribable coordinator callbacks, named by the existing `on*Change` convention: `onColorScaleChange {colorScale, browser}` (fired from the existing widget‑facing `onColorScale` **and** from `setColorScaleThreshold`, which fires nothing today), `onNormalizationChange {normalization, browser}`, `onNormalizationSubstituted {requested, effective, reason, browser}`, `onDisplayModeChange {mode, browser}`. Additive: `type` (plus/minus) added to the `onForegroundColorChange` payload. | `js/browserCoordinator.js` (`callbacks` map), `js/hicBrowser.js` `setColorScaleThreshold`, `js/hicColorScaleWidget.js`, `js/publicApi.js` `COORDINATOR_CALLBACKS` + `COORDINATOR_PAYLOAD_SHAPES` | Replaces the prototype's monkey‑patching of `notifyColorScale`, `setColorScaleThreshold`, `repaintMatrix`, `setNormalization`, `setDisplayMode`. Substitution (ADR‑0012) must be observable so a peer mirrors the *effective* normalization. Ships as **juicebox.js 4.6.0**. |
| New global event `TrackXYPairChange`, payload `{trackPair, property, value}`, posted from `TrackPair.setColor`, `setDataRange`, `setTrackLabelName`, and wherever `track.autoscale` / `track.logScale` are toggled (gear menu) | `js/trackPair.js`, `js/trackGearPopup.js`; `EVENTS_POSTED` + `EVENT_PAYLOAD_SHAPES` | The only mutations with no event today; the prototype used `Object.defineProperty` setters. |
| Add to `BROWSER_SURFACE`: `controlDataset`, `trackPairs`, `tracks2D`, `zoomAndCenter`, `setColorScaleThreshold`, `setNormalization`, `setDisplayMode`, `getDisplayMode`, `getColorScale`, `getSyncState`, `syncState` | `js/publicApi.js` | All exist and are used by the remote layer; declaring them makes "no callers in this repo" a complete finding (ADR‑0003). |
| `parseGotoInput` accepts the prototype's extra spellings: `chr1 10mb-20mb`, `chromosome 1`, `1:1000-2000`, `kb`/`mb` suffixes, and `{chr, start, end}` objects | `js/interactionHandler.js` (`parseGotoInput`, `parseLocusString`) + tests | Port of `normalizeLocusInput` / `parseLocusInputFlexible`. Generic locus parsing belongs in the viewer; the NLP that extracts a locus from a sentence does **not** (server, §6). |

Not added: `parseMapAndLocusCommand`, `ColorScaleManager`, `NotificationCoordinator`
changes — upstream already solved those differently.

## 5. `@aidenlab/juicebox-remote`

Location: `juicebox-mcp/packages/remote` (npm workspace), published to npm from
the `aidenlab` account (which owns the `@aidenlab` scope; juicebox.js itself is
published unscoped from the same account). Peer dependency:
`juicebox.js >=4.6.0 <5` (the version carrying §4; 4.5.x is already released).

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
  room: 'c0ffee…',          // from the page URL (§7); omit to have the server mint one
  onStatus: (s) => {},      // 'connecting' | 'open' | 'closed' | 'expired' ; optional
  onToolCall: (name) => {}, // for a toast; optional
})
remote.room                 // the room id, known once status is 'open'
remote.joinUrl              // join link for this page's URL + room
remote.detach()             // unsubscribe everything, close socket
```

A page may start a room with no MCP client involved (`room` omitted → server
mints one, replies `joined {room}`), so two people can co‑view without AI.

The package ships **no UI**. A host that wants a status dot, QR or toast
renders it from `onStatus` / `remote.joinUrl`.

### 5.2 Commands → public surface

`browser` is the panel the command's `panel` addresses (ADR‑0007, CONTEXT.md:
panel): a 1‑based position in `hic.getAllBrowsers()` (left to right), a map name
only one panel shows, or `"all"` (every panel, where the table says so). Omitted,
it is the current browser when one panel is open and an error listing the panels
when several are. An ack's `result` names the panel(s) acted on, one line each,
e.g. `panel 2 (heart, mm10): ok`; with `"all"` the command fails only when every
panel fails.

| Command | `panel` | Applied as |
|---|---|---|
| `loadMap {url,name,normalization,locus,panel}` | one, or `"new"` | `browser.loadHicFile(config)`; `"new"`: `hic.createBrowser(container, {width,height})` + `hic.setCurrentBrowser` first; with a locus, `parseGotoInput(locus)` again after the load (juicebox.js adopts a compatible peer's view); result `loaded X into panel N of M (map, genome)` |
| `loadControlMap {…,panel}` | one | `browser.loadHicControlFile(config)`; then `setDisplayMode('AOB')` if both maps present |
| `closePanel {panel}` | one | `browser.registry.delete(browser)` (what juicebox.js's `deleteBrowser` does; 4.7.0 does not export it); refused for the last panel; result names the remaining panels |
| `loadSession {session}` | — | `hic.restoreSession(container, session)` |
| `gotoLocus {locus,panel}` | one or all | `browser.parseGotoInput(locus)` (§4) |
| `zoomIn` / `zoomOut {panel}` | one or all | `browser.zoomAndCenter(±1, cx, cy)` |
| `setForegroundColor {r,g,b,panel}` | one or all | `browser.getColorScale().setColorComponents(...)`; `contactMatrixView.setColorScale` |
| `setBackgroundColor {panel}` | one or all | `contactMatrixView.setBackgroundColor(rgb)` |
| `setColorScale {op, value, panel}` | one or all | `browser.setColorScaleThreshold(t)` |
| `setNormalization {panel}` | one or all | `browser.setNormalization(n)` |
| `loadTrack {url\|preset,name?,color?,panel}` | one or all | `browser.loadTracks([config])` (does not await completion — ADR‑0017); `preset: "genes"` becomes the UCSC NCBI RefSeq file for that panel's `dataset.genomeId` |
| `getTrackList {requestId,panel}` | one | enumerate `browser.trackPairs` then `browser.tracks2D` → reply `trackListData` |
| `getPanelList {requestId}` | — | `hic.getAllBrowsers()` → `[{panel, current, map, genome, controlMap, tracks, locus}]` |
| `removeTrack`, `setTrackColor`, `setTrackName`, `setTrackDataRange`, `setTrackAutoscale`, `setTrackLogScale` `{track,…,panel}` | one or all | resolve by name or 1‑based index (by name only with `"all"`), then `layoutController.removeTrackXYPair(tp)` / `tp.setColor` / `tp.setTrackLabelName` / `tp.setDataRange` / `tp.track.autoscale=` / `tp.track.logScale=` |
| `getSession` / `getCompressedSession {requestId}` | `hic.toJSON()` / `hic.compressedSession()` → reply |
| `syncEvent` | §5.3, with the re‑entrancy guard |
| `peerSessionData` | validate, then `hic.restoreSession` |
| `toolCall {name}` | `onToolCall(name)` only |

### 5.3 Observed changes → sync events

| Source (juicebox.js) | Sync event |
|---|---|
| `addCallback('onLocusChange')` (`dragging` in payload) | `locusChange {syncState: browser.getSyncState()}` — throttled while dragging, debounced otherwise |
| `addCallback('onColorScale')` | `colorScaleChange` (display mode, numeric threshold + rgb, or signed components); a peer in another mode switches to it first |
| `addCallback('onBackgroundColorChange')` | `backgroundColorChange` |
| `addCallback('onNormalizationChange')`, `('onNormalizationSubstituted')` | `normalizationChange` (effective value) |
| `addCallback('onDisplayMode')` | `displayModeChange` |
| `addCallback('onMapLoaded')`, `('onControlMapLoaded')` | `mapLoad` / `controlMapLoad` (url, name read off `dataset`) |
| `EventBus` `TrackXYPairLoad` / `TrackXYPairRemoval` / `TrackXYPairChange` | `trackLoad` / `trackRemove` / `track*Change` |

Receiving a `syncEvent` sets `isSyncing = true` around the apply so the
resulting callbacks are not re‑emitted. Same rule as the prototype.

Every sync event carries `panel`, the sender's 1-based left-to-right position
(what `list_panels` prints), and is applied to the receiver's panel at that
position; a position the receiver lacks is dropped, except that a `mapLoad`
for one past its last panel opens that panel and loads the map there. An event
without `panel` applies to the current panel. The remote follows every panel
in `getAllBrowsers()`, scanning again on `BrowserSelect` and after each command
or catch-up it runs, so a host that creates a panel must select it.
`BrowserSelect` itself is not mirrored. Panels synced within one page each send
their own `locusChange`. ADR-0008.

### 5.4 Protocol (`protocol.js`)

From the prototype (`PORTING_MCP_TO_JUICEBOX_JS.md` §5) with these changes:

- `registerSession {sessionId}` → `join {room?}`; server replies `joined {room}`
  (minting a room when none was given) or `error {code: 'room-expired'}`.
  URL query parameter `sessionId` → `room` (§7).
- **Every command carries a `requestId` and gets an `ack {requestId, ok, result?, error?}`**
  from the remote once applied (or failed). Tools wait up to 10 s for the ack
  and report "sent, unconfirmed" on timeout. The prototype's fire‑and‑forget
  tools reported success even with no page connected. `ack` is the **only**
  reply shape: the prototype's six reply types (`sessionData`,
  `compressedSessionData`, `trackListData` and their `*Error` twins) collapse
  into `result` / `error`. "ok" means the call on the public surface returned,
  not that data finished loading (ADR‑0017 for tracks).
- Room ids are server‑minted 10‑character Crockford base32 strings (~50 bits),
  not UUIDs, so the join‑link QR stays small.

Message shapes are exported as constants plus `isCommand(msg)` /
`isSyncEvent(msg)` guards so both ends share one spelling.

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
  - `get_juicebox_url` → returns the **join link** (§7) for the room, and for MCP Apps hosts a card view with the link and its QR
    bound to this MCP session (minted on `initialize`, or set by `join_room`).
  - **New** `join_room {room}` → binds the MCP session to an existing room,
    e.g. one a page started (§5.1) whose join link the user pasted into chat.
  - `create_shareable_url` → returns the **snapshot link** (asks the page for
    `compressedSession()`, shortens with TinyURL on `t.3dg.io`, the same
    account and domain juicebox-web uses; key is a `wrangler secret`). The
    page's own Share button shortens through juicebox-web's `jb-shortlink`
    worker (`juicebox.aidenlab.org/shorten`), since TinyURL's API no longer
    answers browser origins; this Worker only shortens for the tool.
  - `save_session` → returns the session JSON as a text result (no filesystem).
  - `search_maps`, renamed `search_map_catalogs` (ticket 24) so the model does
    not mistake it for a portal search, and friends read a copy of the
    juicebox-web ENCODE and 4DN catalog modules (`src/search/catalogs.js`,
    header `source: juicebox-web js/…ContactMapDatasourceConfig.js`): ≈176
    ENCODE cell-line maps, ≈600 4DN maps, no tissues, no intact Hi-C; the
    AidenLab `hicfiles.json` list is a later ticket.
  - **New** `search_encode_hic {biosample?, assay?, classification?, assembly?,
    query?, limit?}` → live, experiment‑first search of the ENCODE portal
    (`src/search/encodePortal.js`): released Hi‑C experiments (intact, in situ,
    Hi‑C, dilution), each with its released `.hic` maps (MAPQ‑thresholded first)
    and the companion files the viewer loads as tracks (bedpe loops / domains /
    stripes, bed subcompartments, bigWig compartments). Organ words filter on
    `biosample_ontology.organ_slims`; zero hits there falls back to full‑text
    `searchTerm` (cell lines such as K562). **New** `search_encode {type?,
    query?, filters?, limit?}` → any other portal search, facet filters passed
    through verbatim, facets returned. Portal facts (ticket 24): AWS WAF in
    front, so an explicit non‑browser User‑Agent is answered in <300 ms, a
    spoofed browser UA gets 502 and no UA hangs; zero hits is HTTP 404 with a
    normal JSON body (`total: 0`); `field=` selects properties and dotted names
    embed (`files.href`); a repeated filter key ORs; `organ_slims` includes
    organ‑derived cell lines (colon → HCT116), hence `classification`.
  - **New** `list_panels` and `close_panel`, and `panel` on every one‑panel tool
    and on `load_map` (`"new"`), §5.2 and ADR‑0007.
  - Everything else: same names, same schemas.
- **Room lifecycle (Durable Object):** the last saved session lives in DO
  storage (the prototype already did this); an alarm deletes the room's storage
  24 h after its last message (ADR‑0006). Request/response tools ask the first
  live page; a socket closing rejects only that page's pending requests.
- **Tests:** `@cloudflare/vitest-pool-workers` for the DO (join, relay to
  others only, request/response, ack, expiry) and for tool registration.
- **Retired:** `server.js`, esbuild bundle, express/ws/cors/dotenv deps, the
  2.3 MB `.mcpb` at the repo root, `.history/`. `packages/connector-mcpb` is
  deferred; the README carries the `mcp-remote` recipe instead.

### 6.4 Security baseline

- `/ws` upgrade: reject unless `Origin` is on an allow‑list (`wrangler.toml`
  var). WebSockets are not covered by CORS.
- Room ids are server‑minted UUIDs (or HMAC of `x-openai-session`); a client
  cannot reach a browser it was not paired with.
- `TINYURL_API_KEY` and `SESSION_HMAC_SECRET` are `wrangler secret`s; the
  prototype's hardcoded HMAC fallback key is removed.
- `jbmcp.3dg.io` is declared as a custom domain in `wrangler.toml` (the
  prototype set it only as `BROWSER_URL`).
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
both parameters: restore the snapshot first, then join; **if the room already
has state (a live peer or a saved session) the room wins**, and the snapshot
only seeds an empty room. juicebox.js ignores a lone `?room=` (its query
adapter claims a session only when `url` is present). The parameter is
renamed from `sessionId` to `room` because "session" already means the
serialized JSON in juicebox.js's `CONTEXT.md` and the MCP transport's
`mcp-session-id`; three meanings on one word was the source of the conflation.

## 8. juicebox-web integration

One shell‑owned widget (juicebox-web vocabulary: a *widget*), roughly 50 lines:

- in `js/app.js` `init()` after `hic.init` (and `js/embed.js`), read `?room=`;
  if present, `attachRemote({hic, container, url: import.meta.env.VITE_WS_URL, room, …})`.
  juicebox-web itself parses no URL parameters today; `?session=` is handled
  inside juicebox.js;
- a "Start room" action that calls `attachRemote` without `room` (§5.1);
- a connection indicator in the navbar; a "Join link" QR entry in the share
  area, clearly separate from the snapshot share modal (§7);
- `onToolCall` → the existing alert/toast area.

`VITE_WS_URL` is added to `.env.example` and set in the Cloudflare Pages
project (production and preview). Work happens on the `weiszd/juicebox-web`
fork and lands by PR. No other change to the shell. The `embed.html`
distribution attaches the same way, which is the "any web page" proof.

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

0. **Repo restart §9** first (PR #1 is merged), so `packages/` is built on the clean tree. The deployed prototype Worker keeps running.
1. **juicebox.js §4** — tickets in `.scratch/v2/` here; code on the `weiszd/juicebox.js` fork, landed by one PR to aidenlab that also carries a mirror ADR for "generic hooks only". Verify: `test/testPublicApi.js` green; juicebox-web unchanged and green against 4.6.0. Point the stale local checkout (4.1.1) at the fork and pull first.
2. **`packages/remote`** — `protocol.js`, `applyCommand`, `observe`, `attachRemote`. Verify: jsdom tests with a fake `hic` namespace covering every row of §5.2/§5.3, plus ack and room minting.
3. **`packages/server`** — move Worker code, single `tools.js`, catalog copy, `Origin` check, ack, short room ids, expiry alarm. Verify: vitest‑pool‑workers suite green; `wrangler dev` + MCP Inspector, all 27 tools; ChatGPT HMAC path unchanged.
4. **juicebox-web widget §8** — `?room=`, start room, indicator, join‑link QR; PR from the fork. Verify: two tabs on one room stay in sync for every §5.3 event; a third tab opened late receives the state; a snapshot link still restores with the server down.
5. **Client onboarding** — Claude Desktop custom connector, `mcp-remote` local recipe. Verify: each drives a map load end to end.
6. README, retire prototype docs to the `prototype` branch.

## 11. Open questions — resolved 2026‑09‑28

- **Q1** juicebox.js 4.5.1 was released 2026‑09‑27; §4 ships as **4.6.0**, peer range `>=4.6.0 <5`.
- **Q2** **Copy** the ENCODE and 4DN modules into `packages/server` with a source header (§6). AidenLab list later.
- **Q3** **TinyURL** from the Worker, `t.3dg.io`, key as a secret (§6). `jb-shortlink` is a redirector, not a shortener.
- **Q4** DO storage (already the case) **plus a 24 h idle expiry alarm** (ADR‑0006).
- **Q5** **Short id**, 10‑char Crockford base32 (§5.4).

Decided in the same review: command acks (§5.4); page‑started rooms (§5.1);
snapshot‑vs‑room precedence (§7); callback naming (§4); `@aidenlab/juicebox-remote`
stays the name; server tests with vitest‑pool‑workers (§6); `connector-mcpb`
deferred (§6); all juicebox.js and juicebox-web work via the weiszd forks + PR, no
issues opened on aidenlab repos (§8, §10).
