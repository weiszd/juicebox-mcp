/**
 * The MCP App view (SEP-1865) for get_juicebox_url: a card with the join link
 * and its QR code, shown in the app pane by hosts that render MCP Apps (Claude
 * Desktop, claude.ai, Cowork). The link opens through the host (`ui/open-link`),
 * which Claude routes to its browser pane. Claude's sandbox forbids framing other
 * origins (`frame-src 'self' blob: data:`), so the viewer itself is not embedded.
 * Hosts without MCP Apps ignore the metadata and use the text link.
 */

export const VIEW_URI = 'ui://juicebox/join';
export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';

/** Client bundle the view loads, as in Claude's no-build MCP Apps quickstart. */
const APP_CLIENT = 'https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js';

/** `_meta.ui` for the resource: the sandbox may load the client; the QR is a data: image. */
export const VIEW_META = { ui: { csp: { resourceDomains: [new URL(APP_CLIENT).origin] } } };

/** `_meta` for the tool: the current key and the flat one older hosts read. */
export const TOOL_META = { ui: { resourceUri: VIEW_URI }, 'ui/resourceUri': VIEW_URI };

export const VIEW_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Juicebox</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 12px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  img { width: 160px; height: 160px; image-rendering: pixelated; background: #fff; border-radius: 6px; }
  #text { display: flex; flex-direction: column; gap: 8px; min-width: 200px; }
  a { word-break: break-all; }
  button { align-self: flex-start; padding: 6px 12px; }
</style></head>
<body>
<img id="qr" alt="QR code of the join link" hidden>
<div id="text">
  <div id="status">Waiting for the join link…</div>
  <a id="link" href="#" hidden></a>
  <button id="open" hidden>Open Juicebox</button>
  <div id="hint" hidden>Scan the QR code to open the same room on a phone or another device.</div>
</div>
<script type="module">
  import { App } from "${APP_CLIENT}";
  const $ = (id) => document.getElementById(id);
  const app = new App({ name: "Juicebox", version: "1.0.0" });
  let joinUrl;
  const open = async (e) => {
    e?.preventDefault();
    if (!joinUrl) return;
    try { await app.openLink({ url: joinUrl }); $("status").textContent += " · opened"; }
    catch (err) { $("status").textContent += " · open-link refused: " + (err?.message ?? err); }
  };
  app.ontoolresult = ({ structuredContent: sc, content }) => {
    joinUrl = sc?.joinUrl ?? content?.find((c) => c.type === "text")?.text.match(/https?:\\/\\/\\S+/)?.[0];
    if (!joinUrl) { $("status").textContent = "No join link in the tool result."; return; }
    $("status").textContent = "Juicebox room " + (sc?.room ?? new URL(joinUrl).searchParams.get("room"));
    $("link").textContent = joinUrl; $("link").href = joinUrl; $("link").hidden = false;
    $("open").hidden = false;
    if (sc?.qrPng) { $("qr").src = "data:image/png;base64," + sc.qrPng; $("qr").hidden = false; $("hint").hidden = false; }
    open(); // trial: ask the host to open the page without a click (ticket 23)
  };
  $("link").onclick = open;
  $("open").onclick = open;
  await app.connect();
</script>
</body></html>`;
