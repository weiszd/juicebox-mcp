# juicebox-mcp

The server and browser-side control layer that let an MCP client drive juicebox.js on any web page and keep several pages in sync.

## Language

### Links and state

**Session**:
The serialized view, in juicebox.js wire format. Never the MCP transport session, never a room.
_Avoid_: state, snapshot (for the JSON itself)

**Snapshot link**:
A URL carrying `?session=`; opening it reproduces a view with no server involved.
_Avoid_: share URL, shareable URL, session link

**Room**:
A live relay channel on the server that pages join, identified by a room id.
_Avoid_: session, sessionId, channel

**Join link**:
A URL carrying `?room=`; opening it joins the room.
_Avoid_: share URL, juicebox URL, connection URL

**Join QR**:
A QR code encoding a join link.
_Avoid_: QR code (alone)

**Onboarding link**:
The one permanent URL a new user is given to begin onboarding.
_Avoid_: install link, connector URL (that is the server's address)

**Onboarding QR**:
A QR code encoding the onboarding link, for print and slides.
_Avoid_: QR code (alone)

**Saved session**:
The most recent session a page stored in its room; served to a late joiner when no peer is live.
_Avoid_: auto-save, cache

### Participants

**MCP client**:
The LLM-side program (Claude Desktop, ChatGPT, Cursor, …) that calls tools.
_Avoid_: client (alone), Claude

**Connector**:
The MCP server as it appears inside an MCP client once a user has added it.
_Avoid_: plugin, extension, integration

**Onboarding**:
The path a new user takes from never having used the connector to having it installed in their MCP client.
_Avoid_: setup, install (alone)

**Page**:
One web-browser tab hosting juicebox.js.
_Avoid_: browser (in juicebox.js a browser is a HiCBrowser panel), client

**Panel**:
One juicebox.js contact-map viewer inside a page (a HiCBrowser). A page holds one or more panels, ordered left to right; tools address one by its 1-based position in that order, or by its map name when unique, or all at once.
_Avoid_: browser, map (the .hic file), view

**Host**:
The shell or site that embeds juicebox.js and attaches a remote: juicebox-web, embed.html, any third-party site.
_Avoid_: frontend, app

**Remote**:
The control layer attached to one page's juicebox.js; what `attachRemote` returns.
_Avoid_: client, bridge, Application

**Peer**:
Another page in the same room.

**Late joiner**:
A page joining a room that already has state.

### Messages

**Tool**:
An MCP tool the MCP client calls; a tool call produces commands.

**Command**:
A server→remote message asking the viewer to do something.
_Avoid_: event, action

**Ack**:
A remote→server reply to a command: ok, or an error.
_Avoid_: response, result

**Sync event**:
A remote→room message describing a change made in one panel of that page, or a panel opened or closed there, named by position; relayed to peers only, never back to the sender.
_Avoid_: sync command, update
