# The server is a Cloudflare Worker only; no local Node/STDIO server

The prototype shipped two parallel servers (Node/express/`ws` with STDIO for a `.mcpb` Claude Desktop bundle, and a Worker) registering the same 27 tools twice. Every target MCP client now speaks Streamable HTTP, and `mcp-remote` bridges the rest, so we keep only the Worker (`/mcp` Streamable HTTP, `/ws` → Durable Object) and use `wrangler dev` for local work. Cost accepted: no fully offline mode, and Claude Desktop users go through a custom connector or `mcp-remote` instead of a one-click bundle.
