# @aidenlab/juicebox-remote

Attach a [juicebox.js](https://github.com/aidenlab/juicebox.js) viewer to a room on the
[juicebox-mcp](https://github.com/aidenlab/juicebox-mcp) server, so an LLM connected over MCP
can drive it and every page in the room stays in sync.

```bash
npm install juicebox.js @aidenlab/juicebox-remote
```

`juicebox.js` is a peer dependency (`>=4.9.0-mcp.0 <5`: the fork build on the npm dist-tag `mcp`, until the hooks it needs are in an upstream release). The package never imports it: you pass in
your own namespace import, so the viewer is bundled once. Plain ESM, no build step.

## Embed example

```html
<div id="viewer"></div>
<script type="module">
  import * as hic from 'juicebox.js'
  import { attachRemote } from '@aidenlab/juicebox-remote'

  const container = document.getElementById('viewer')
  await hic.init(container, {})

  const remote = attachRemote({
    hic,
    container,
    url: 'wss://jbmcp.3dg.io/ws',
    room: new URLSearchParams(location.search).get('room') ?? undefined,
    onStatus: (status) => { document.title = `juicebox (${status})` },
    onToolCall: (name) => console.info(`AI ran ${name}`),
  })

  // Share remote.joinUrl once the status is 'open'.
</script>
```

The server accepts a WebSocket only from an `Origin` on its allow-list, so a new host page
needs its origin added to the server's `ALLOWED_ORIGINS`.

## API

### `attachRemote(options)`

| Option | | |
|---|---|---|
| `hic` | required | the juicebox.js namespace import |
| `container` | required | the element passed to `hic.init`; used by `hic.restoreSession` |
| `url` | required | the server's WebSocket endpoint, e.g. `'wss://jbmcp.3dg.io/ws'` |
| `room` | optional | the room to join. Omit it and the server mints one, so a page can start a room with no MCP client involved |
| `onStatus` | optional | `(status) => void`, see below |
| `onToolCall` | optional | `(name) => void`, called with a tool's name when the room reports that an MCP client ran it, e.g. for a toast |
| `createSocket` | optional | `(url) => WebSocket`; defaults to the platform `WebSocket` |

It returns:

- `room` — the room id, known once the status is `'open'`; kept across a dropped connection.
- `joinUrl` — the current page's URL with `?room=<id>` set: open it to join the same room.
  `undefined` until the room is joined, and outside a browser.
- `detach()` — unsubscribe from the viewer, close the socket and report `'closed'`. Safe to call
  twice.

### Statuses

| Status | Meaning |
|---|---|
| `'connecting'` | a connection attempt started (also before every reconnect) |
| `'open'` | the room answered; `room` and `joinUrl` are set |
| `'closed'` | the connection dropped (it reconnects on its own, backing off to one attempt every 5 s) or `detach()` was called |
| `'expired'` | the room was idle for 24 h and is gone. The remote stops for good; start a new one with `attachRemote` and no `room` |

### Joining a room

Once joined, the room's state wins: if another page is in the room, or the room holds a saved
session, this page is replaced by it. A page that restored a snapshot link (`?session=`) before
attaching therefore only seeds an empty room. After that the page saves its session to the
room (checked every 10 s, sent only when it changed), so a later joiner catches up even when no other page is open.

### Panels

A command may carry `panel`: a 1-based position among `hic.getAllBrowsers()` (left to right),
a map name that only one panel shows, or `"all"`. Omitted, it means the only panel when one is
open and fails, listing the panels, when several are. A panel command's ack names the panel it
acted on in `result`, one line per panel for `"all"`. `loadMap {panel: "new"}` opens a browser with
`hic.createBrowser(container, …)`; `closePanel` removes one (never the last) with `hic.deleteBrowser(browser)`, or
`browser.registry.delete(browser)` on a juicebox.js without that export (4.7.0); `getPanelList`
answers the list of panels.

Sync events are kept per panel too: every panel is followed, each event carries `panel`, the
sender's position, and a peer applies it to its panel at that position, dropping it when it has
none. Opening and closing a panel are sync events too: `panelOpen {panel}` opens an empty panel
on a peer whose last panel is one before it (as `loadMap {panel: "new"}` does) and is dropped
otherwise; `panelClose {panel}` closes the peer's panel at that position, never its last one. So
positions stay aligned on every page, empty panels included, and a `mapLoad` only ever applies to
a panel the peer has. An event without `panel` (from an older remote) applies to the current
panel. A peer's `getSession` answer, which a late joiner restores, lists one entry per panel,
`{}` for an empty one; the room's stored session (`hic.compressedSession()`) still skips them.
ADR-0008.

**Host requirements:** the remote hears a panel open and close from juicebox.js's global
`BrowserAdd` and `BrowserDelete` events (juicebox.js fork build; not posted by a restore or a
reset). Without them panels still open and close locally, but peers are not told. A host that
creates a panel must also select it (`hic.setCurrentBrowser`), as juicebox-web's clone button
and juicebox.js's own restore do: the remote scans the panels again on every selection (and
after each command or catch-up it runs), which is how a restored session's panels, or any panel
on a juicebox.js without `BrowserAdd`, get followed.

### Protocol

`@aidenlab/juicebox-remote/protocol` exports the wire protocol's message catalogue and
validators. The server imports it too; hosts do not need it.

## No UI

The package renders nothing. A host that wants a connection indicator, a join-link QR code or a
toast for tool calls builds it from `onStatus`, `remote.joinUrl` and `onToolCall`.

## License

MIT
