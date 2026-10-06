# Local testing cheat sheet

Run your branch's MCP server on your own machine and drive a real Juicebox viewer
with it, from Claude Code, Claude Desktop or claude.ai. No Cloudflare deploy.

## The moving parts

Four things have to be in place. Three are processes you start; one is a setting in Claude.

| # | Part | What it does | Where it runs | Needed for |
|---|---|---|---|---|
| 1 | **Relay** (this repo's MCP server) | Receives Claude's tool calls on `/mcp` and passes them to the page over `/ws` | `localhost:8787` | Everything |
| 2 | **Page** (`juicebox-web`) | The actual viewer. Dials out to the relay, joins a room, draws the maps | `localhost:5173` | Any tool that drives the viewer |
| 3 | **Tunnel** (`cloudflared`) | Gives the relay a public `https://` address | `*.trycloudflare.com` | Claude Desktop and claude.ai only |
| 4 | **Connector** | Tells Claude where the relay is | Claude settings | Claude Desktop and claude.ai only |

```
Claude ──(connector URL)──> tunnel ──> RELAY :8787 <──(WebSocket)── PAGE :5173
                                                                      │
                                              map data is fetched by the page,
                                              straight from the public data hosts
```

Two things that are easy to get wrong:

- The relay serves no web page and no Hi-C data. It only relays commands.
- The page's relay address is fixed when the page is built (`VITE_WS_URL`). A hosted
  page such as `juicebot-dev.3dg.io` is built for the shared dev relay and can never
  join a room on your local one. That is why the page has to run locally too.

## One-time setup

```bash
# 1. Relay
cd /Users/turner/JuiceboxDevelopment/weiszd/juicebox-mcp
npm install
cp packages/server/.dev.vars.example packages/server/.dev.vars

# 2. Page: the fork, cloned next to this repo
cd /Users/turner/JuiceboxDevelopment/weiszd
git clone https://github.com/weiszd/juicebox-web.git
cd juicebox-web && npm install

# 3. Tunnel
brew install cloudflared
```

`.dev.vars` is gitignored; its defaults are right (`BROWSER_URL=http://localhost:5173/`,
so join links point at the local page). The fork pins Node 24 in `.nvmrc`; Node 26 also
works, Node 22 can crash `npm install`.

## Start everything (three terminals)

Start them in this order.

**Terminal 1: relay**

```bash
cd /Users/turner/JuiceboxDevelopment/weiszd/juicebox-mcp
npm run dev:server
```

**Terminal 2: page**

```bash
cd /Users/turner/JuiceboxDevelopment/weiszd/juicebox-web
VITE_WS_URL=ws://localhost:5173/ws npm run dev -- --port 5173 --strictPort
```

The second line is one command. The `VITE_WS_URL=...` prefix sets an environment variable for
that `npm run dev` only (it is not exported to the shell). Vite passes it to the page, which
uses it as the relay address; without it the page starts with no room widget and never
connects.

The address is the page's own port, not the relay's: the Vite dev server forwards `/ws` to
the relay on port 8787 (`server.proxy` in `juicebox-web/vite.config.mjs`), so the page only
ever talks to `localhost:5173`. The direct address, `ws://localhost:8787/ws`, also works in
regular Chrome.

The proxy is on the `juicebox-web` branch `dev/ws-proxy` (commit `17864e2`), not yet on
`master`. On a checkout without it, `ws://localhost:5173/ws` connects to nothing: use that
branch, or the direct address and regular Chrome.

**Terminal 3: tunnel** (skip if you only use Claude Code or the MCP Inspector)

```bash
cloudflared tunnel --url http://localhost:8787
```

It prints `https://<random-words>.trycloudflare.com`. The connector URL is that plus `/mcp`.

## Connect Claude

**Claude Desktop and claude.ai** (one connector covers both; it belongs to your account)

1. Settings → Connectors → Add custom connector.
2. Name: `Juicebox local`. URL: `https://<random-words>.trycloudflare.com/mcp`.
3. Leave the OAuth fields blank. Add.
4. In a new chat, turn the connector on in the tools menu.

The tunnel address changes every time `cloudflared` restarts. When it does, remove the
connector and add it again with the new URL.

**Claude Code** (no tunnel needed)

```bash
claude mcp add --transport http juicebox-local http://localhost:8787/mcp
```

**MCP Inspector** (no tunnel needed): `npx @modelcontextprotocol/inspector`, transport
"Streamable HTTP", URL `http://localhost:8787/mcp`.

## Use it

1. Say "Hello, Juicebot". Claude calls `get_juicebox_url` and gets a join link,
   `http://localhost:5173/?room=<ROOM>`.
2. In Claude Desktop the page opens in the panel beside the chat; if it does not, press
   **Open Juicebox** on the card. Elsewhere, open the link in a browser on this Mac (it is
   also under "Other ways to open" on the card).
3. Ask for a map, e.g. "load a GM12878 Hi-C map". It draws in that page.

Use `localhost` in the link, not `127.0.0.1`: the Vite dev server only answers on `localhost`.

## Claude Desktop's built-in panel needs the `/ws` proxy

The panel only works when the page reaches the relay through its own port, which is what
`VITE_WS_URL=ws://localhost:5173/ws` and the Vite `/ws` proxy in "Start everything" do.

Started with the direct address, `VITE_WS_URL=ws://localhost:8787/ws`, the panel opens the
page but the page never joins the room (yellow dot), and viewer tools report "No page is
connected". Its connection attempts never reach the relay: the relay logs neither an
accepted socket nor `[WS] refused Origin`. The same link in regular Chrome joins at once.
Claude's own explanation ("nothing is listening on port 8787", "using the deployed Workers
version") is wrong; ignore it.

## Check each part

| Part | Command | Good result |
|---|---|---|
| Relay | `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/mcp` | `405` |
| Page | `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/` | `200` |
| Tunnel | `curl -s -o /dev/null -w '%{http_code}\n' https://<random-words>.trycloudflare.com/mcp` | `405` |
| Page joined a room | Relay terminal prints `[DO] WebSocket accepted. Total connections: 1` | |
| Command reached a page | Relay terminal prints `[DO sendToClient] command=... websockets=1` | `websockets=0` means no page is in that room |

`405` is the healthy answer: `/mcp` only accepts `POST`.

The relay's full log is also kept in `~/Library/Preferences/.wrangler/logs/` (newest file).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "No page is connected to this room" | No page has joined. Check the relay terminal for `WebSocket accepted`; in the Claude Desktop panel, a yellow dot means the page was started with the direct relay address (see the panel section above) |
| Page loads but never joins | Page started without `VITE_WS_URL`, or not on port 5173 (the relay only accepts `localhost:5173` and `127.0.0.1:5173`, see `ALLOWED_ORIGINS` in `packages/server/wrangler.toml`). A refused page shows as `[WS] refused Origin: ...` in the relay terminal |
| Join link points at a deployed page | `.dev.vars` is missing; redo setup and restart the relay |
| Connector stopped working | Tunnel restarted and has a new address; re-add the connector |
| A new chat cannot drive the open page | Each chat gets its own room. Open the new chat's join link |
| Port 8787 or 5173 in use | An earlier relay or page is still running; stop it (`lsof -nP -iTCP:8787 -sTCP:LISTEN` shows the process) |
| "TinyURL API key not provided" warning | Harmless |
| Stale rooms or sessions | Stop the relay and delete `packages/server/.wrangler/state` |

## Shut down

`Ctrl-C` in each terminal. Stop the tunnel when you are not testing: while it runs,
anyone with the address can call your relay.

## Preview the join card on its own (none of the above needed)

The card Claude shows for `get_juicebox_url` is `packages/server/src/mcp/juiceboxView.js`.
It only fills in when a host hands it a tool result, so it cannot be opened directly. To
work on it without Claude, the relay, the page or the tunnel:

```bash
cd /Users/turner/JuiceboxDevelopment/weiszd/juicebox-mcp
node scripts/preview-view.mjs
```

Open `http://localhost:5199/`. Edit `juiceboxView.js`, save, refresh the browser: the
preview re-reads the file on every load. `Ctrl-C` stops it.

| Address | Shows |
|---|---|
| `http://localhost:5199/` | The card as in Claude Desktop |
| `http://localhost:5199/?platform=web` | The card in any other host |
| `http://localhost:5199/?state=waiting` | Before the join link arrives |
| `http://localhost:5199/?state=nolink` | A tool result with no link in it |

What is fake: the room is `PREVIEW123`, the QR code is a real one for that link, and
pressing **Open Juicebox** shows an alert with the link the host would open. The preview
fills the browser window, while Claude shows the card in a narrow frame, so narrow the
window to judge layout. `PORT=5200 node scripts/preview-view.mjs` uses another port.

The preview only imitates what a host reports. Before calling a change done, check it in
Claude Desktop, in a new chat. If the old card still appears, remove the connector and add
it again.

## Automated tests (none of the above needed)

```bash
npm run test:run                                            # everything, once
npm run test:run -- packages/server/test/search.test.js     # one file
npm run test:run -- -t "substring of name"                  # one test
npm test                                                    # watch mode
```

The server tests run the real Worker and Durable Objects locally, with no Cloudflare account.
