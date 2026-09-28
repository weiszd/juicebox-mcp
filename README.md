# juicebox-mcp

AI control for the [juicebox.js](https://github.com/aidenlab/juicebox.js) Hi-C contact map viewer, as a plug-in.

- `packages/remote` — `@aidenlab/juicebox-remote`: attaches a juicebox.js viewer to a room on the server so an MCP client can drive it and peers stay in sync.
- `packages/server` — the MCP server, a Cloudflare Worker (`/mcp`) with a Durable Object per room (`/ws`). Deployed at `https://jbmcp.3dg.io`.

The design is in `docs/design/ARCHITECTURE_V2.md`; decisions in `docs/adr/`. The pre-v2 prototype (Node `.mcpb` server plus a vendored viewer) is preserved on branch `prototype` and tag `v1.1.0-prototype`.

## Develop

```bash
npm install
npm test                 # vitest, both packages
npm run dev:server       # wrangler dev on http://localhost:8787
```

## Use from Claude Desktop

Claude Desktop reaches the hosted server through a custom connector pointed at `https://jbmcp.3dg.io/mcp`. For a local `wrangler dev` server, bridge it with `mcp-remote` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "juicebox": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8787/mcp"]
    }
  }
}
```

Then open a juicebox-web page, start a room, and ask Claude to load a map. `get_juicebox_url` returns the room's join link and QR code.

## License

MIT. See `LICENSE`.
