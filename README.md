# juicebox-mcp

AI control for the [juicebox.js](https://github.com/aidenlab/juicebox.js) Hi-C contact map viewer, as a plug-in. An MCP client (Claude Desktop, Claude Code, ChatGPT, Cursor, …) drives juicebox.js on a web page, and every page in the same room stays in sync.

```
MCP client ──/mcp──▶ Worker ──▶ room (Durable Object) ──/ws──▶ page: juicebox-web + @aidenlab/juicebox-remote
```

- `packages/server` — the MCP server: a Cloudflare Worker on `/mcp`, with a Durable Object per room behind `/ws`. Deployed with wrangler, never published.
- `packages/remote` — `@aidenlab/juicebox-remote`: the browser library that attaches a juicebox.js viewer to a room. The API is in [`packages/remote/README.md`](packages/remote/README.md).

The page is [juicebox-web](https://github.com/aidenlab/juicebox-web), which shows a room widget when it is built with `VITE_WS_URL`. The viewer and the page are separate repositories; neither is vendored here.

Read next: [`CONTEXT.md`](CONTEXT.md) (glossary: room, join link, snapshot link, session, …), [`docs/design/ARCHITECTURE_V2.md`](docs/design/ARCHITECTURE_V2.md) (the design), [`docs/adr/`](docs/adr/) (decisions).

## Connect an MCP client

The server is `https://jbmcp.3dg.io/mcp` (Streamable HTTP, no auth).

- **Claude Desktop** — Settings → Connectors → Add custom connector, URL `https://jbmcp.3dg.io/mcp`.
- **Claude Code** — `claude mcp add --transport http juicebox https://jbmcp.3dg.io/mcp`
- **Any stdio-only client** — bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), e.g. in `claude_desktop_config.json`:

  ```json
  {
    "mcpServers": {
      "juicebox": {
        "command": "npx",
        "args": ["-y", "mcp-remote", "https://jbmcp.3dg.io/mcp"]
      }
    }
  }
  ```

Then ask for the Juicebox link. `get_juicebox_url` returns a join link (`https://aidenlab.org/juicebox/?room=…`) and its QR code; open it, and ask the client to load a map and go to a locus. A page that started its own room ("Start room" in juicebox-web) can be handed to the client by pasting its join link; the client calls `join_room`.

## Run everything locally

Until juicebox.js 4.6.0 and `@aidenlab/juicebox-remote` are on npm and the juicebox-web widget has landed, the local stack is built from the weiszd forks: juicebox.js on branch `ticket/05-release-4.6.0`, juicebox-web on branch `ticket/16` (neither pushed yet, so use local checkouts). The layout below assumes the three checkouts are siblings.

1. **Server** (this repo):

   ```bash
   npm install
   cp packages/server/.dev.vars.example packages/server/.dev.vars   # BROWSER_URL → http://localhost:5173/
   npm run dev:server                                               # wrangler dev on http://localhost:8787
   ```

2. **Page** (juicebox-web). Its `package.json` takes both unpublished packages as tarballs at the checkout root:

   ```bash
   (cd ../juicebox.js && npm install && npm pack)          # juicebox.js-4.6.0.tgz
   (cd packages/remote && npm pack)                        # aidenlab-juicebox-remote-2.0.0.tgz
   cp ../juicebox.js/juicebox.js-4.6.0.tgz packages/remote/aidenlab-juicebox-remote-2.0.0.tgz ../juicebox-web/
   cd ../juicebox-web
   npm install                                             # Node 24 (.nvmrc)
   VITE_WS_URL=ws://localhost:8787/ws npm run dev          # vite on http://localhost:5173
   ```

   `http://localhost:5173` and `http://127.0.0.1:5173` are on the server's `ALLOWED_ORIGINS`; a page on any other origin gets 403 from `/ws`.

3. **Client.** Claude Desktop's custom connectors are reached from Anthropic's servers, so they cannot see `localhost`; use `mcp-remote` with `http://localhost:8787/mcp` in the config above. Claude Code connects directly: `claude mcp add --transport http juicebox-local http://localhost:8787/mcp`. The MCP Inspector works too (`npx @modelcontextprotocol/inspector`, Streamable HTTP, same URL).

`get_juicebox_url` now returns `http://localhost:5173/?room=…`. To drive the local page from the deployed server instead, skip step 1 and run step 2 with `VITE_WS_URL=wss://jbmcp.3dg.io/ws`; the join links then point at `https://aidenlab.org/juicebox/`, so swap that for `http://localhost:5173/` and keep `?room=`.

## Develop

```bash
npm test                 # vitest watch: remote in Node, server inside workerd
npm run test:run         # single run
npm run dev:server       # wrangler dev on :8787
```

Project conventions are in [`CLAUDE.md`](CLAUDE.md).

## Deploy

`scripts/deploy-wizard.sh` walks a maintainer through the whole deploy: `wrangler login`, the two secrets, `wrangler deploy`, probing `/mcp` and `/ws` on the custom domain, setting `VITE_WS_URL` on juicebox-web's Cloudflare Pages project, and connecting each client end to end. It prints a checklist of results to paste into the ticket.

Configuration lives in `packages/server/wrangler.toml`:

| | Value | Why |
|---|---|---|
| route | `jbmcp.3dg.io`, custom domain | wrangler attaches the domain and its DNS record on deploy |
| `workers_dev`, `preview_urls` | `false` | one public hostname; no `*.workers.dev` second entry point for clients or pages to drift onto |
| `BROWSER_URL` | `https://aidenlab.org/juicebox/` | juicebox-web, where join and snapshot links open (the trailing slash matters: relative assets) |
| `ALLOWED_ORIGINS` | aidenlab.org, juicebox.aidenlab.org, 3dg.io and www variants, juicebox-web.pages.dev, localhost:5173 | exact-match `Origin` check on `/ws`; WebSockets are not covered by CORS |
| `TINYURL_DOMAIN`, `TINYURL_ENDPOINT` | `t.3dg.io`, TinyURL API | snapshot-link shortening, the account juicebox-web uses |
| secret `SESSION_HMAC_SECRET` | `wrangler secret put` | keys room ids derived from ChatGPT's `x-openai-session`; unset → that path fails |
| secret `TINYURL_API_KEY` | `wrangler secret put` | unset → `create_shareable_url` returns the long link |

For `wrangler dev`, `packages/server/.dev.vars` overrides the vars and stands in for the secrets.

## The prototype

The pre-v2 prototype (Node `.mcpb` server, vendored viewer, Vite frontend) and its notes (`docs/mcp-notes/`, `docs/datasource-notes/`, `docs/development-notes/`, `docs/usage-scenerios/`) are on branch [`prototype`](https://github.com/aidenlab/juicebox-mcp/tree/prototype) and tag `v1.1.0-prototype`.

## License

MIT. See `LICENSE`.
