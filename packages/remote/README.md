# @aidenlab/juicebox-remote

Attach a [juicebox.js](https://github.com/aidenlab/juicebox.js) viewer to a room on the
[juicebox-mcp](https://github.com/aidenlab/juicebox-mcp) server, so an LLM connected over MCP
can drive it and every page in the room stays in sync.

```bash
npm install juicebox.js @aidenlab/juicebox-remote
```

`juicebox.js` is a peer dependency (`>=4.6.0 <5`). The package never imports it: you pass in
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
a map name that only one panel shows, or `"all"`. Omitted, it means the current browser when
only one is open and fails, listing the panels, when several are. Every ack names the panel it
acted on, one line per panel for `"all"`. `loadMap {panel: "new"}` opens a browser with
`hic.createBrowser(container, …)`; `closePanel` removes one (never the last); `getPanelList`
answers the list of panels. Sync events to and from other pages still follow only the current
panel, so peers that each hold several panels can drift apart.

### Protocol

`@aidenlab/juicebox-remote/protocol` exports the wire protocol's message catalogue and
validators. The server imports it too; hosts do not need it.

## No UI

The package renders nothing. A host that wants a connection indicator, a join-link QR code or a
toast for tool calls builds it from `onStatus`, `remote.joinUrl` and `onToolCall`.

## License

MIT
