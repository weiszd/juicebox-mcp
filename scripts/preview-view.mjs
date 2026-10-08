#!/usr/bin/env node
/**
 * Preview the get_juicebox_url card (packages/server/src/mcp/juiceboxView.js) in a
 * plain browser, with no MCP host.
 *
 *   node scripts/preview-view.mjs          then open http://localhost:5199/
 *
 * The card normally talks to its host through the MCP Apps client; here that client
 * is replaced by a stub that answers with a fake tool result. The view is re-read on
 * every request, so edit juiceboxView.js and refresh the browser.
 *
 *   ?platform=desktop   what Claude Desktop reports (the default)
 *   ?platform=web       any other host
 *   ?state=waiting      before the tool result arrives
 *   ?state=nolink       a tool result with no join link
 */
import { createServer } from 'node:http';
import { generateQRPng } from '../packages/server/src/qrPng.js';

const PORT = Number(process.env.PORT || 5199);
const VIEW = new URL('../packages/server/src/mcp/juiceboxView.js', import.meta.url).href;
const JOIN_URL = 'http://localhost:5173/?room=PREVIEW123';

const stub = (platform, state) => `
  class App {
    getHostContext() { return { platform: ${JSON.stringify(platform)}, displayMode: "inline", availableDisplayModes: ["inline"], userAgent: "preview" }; }
    getHostVersion() { return { name: "preview-view.mjs", version: "0" }; }
    openLink({ url }) { console.log("openLink", url); alert("The host would open:\\n" + url); }
    async connect() {
      const result = ${JSON.stringify(
        state === 'nolink'
          ? { content: [{ type: 'text', text: 'no link here' }] }
          : { structuredContent: { room: 'PREVIEW123', joinUrl: JOIN_URL, qrPng: generateQRPng(JOIN_URL) }, content: [] }
      )};
      if (${JSON.stringify(state)} !== "waiting") setTimeout(() => this.ontoolresult?.(result), 200);
    }
  }`;

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/') { res.writeHead(404).end(); return; }
  try {
    const { VIEW_HTML } = await import(`${VIEW}?t=${Date.now()}`); // fresh copy each request
    const importLine = /import \{ App \} from "[^"]+";/;
    if (!importLine.test(VIEW_HTML)) throw new Error('The view no longer imports { App } the way this preview expects.');
    const html = VIEW_HTML.replace(importLine, () => stub(url.searchParams.get('platform') || 'desktop', url.searchParams.get('state') || 'result'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e?.stack || e));
  }
}).on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is in use (is the preview already running?). Open http://localhost:${PORT}/ or pick another: PORT=${PORT + 1} node scripts/preview-view.mjs`);
  process.exit(1);
}).listen(PORT,() => console.log(`card preview: http://localhost:${PORT}/  (?platform=web, ?state=waiting, ?state=nolink)`));
