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
  body { font: 14px system-ui, sans-serif; margin: 0; padding: 12px; }
  img { width: 160px; height: 160px; image-rendering: pixelated; background: #fff; border-radius: 6px; }
  #text { display: flex; flex-direction: column; gap: 8px; min-width: 200px; }
  a { word-break: break-all; }
  button { align-self: flex-start; padding: 10px 18px; font-size: 15px; }
  details { font-size: 12px; opacity: .8; }
  details > * { margin-top: 6px; }
</style></head>
<body>
<!-- PROTOTYPE (proto/first-launch): one message or one button; QR, room and link collapsed; host context shown for the test. -->
<div id="text">
  <div id="status">Waiting for the join link…</div>
  <button id="open" hidden>Open Juicebox</button>
  <details id="more" hidden><summary>Other ways to open</summary>
    <div id="room"></div>
    <a id="link" href="#"></a>
    <div><img id="qr" alt="QR code of the join link" hidden></div>
    <div id="hint" hidden>Scan the QR code to open the same room on a phone or another device.</div>
  </details>
  <details id="debug" open><summary>PROTOTYPE: what the card knows about its host</summary><pre id="ctx" style="white-space:pre-wrap;font-size:11px"></pre></details>
</div>
<script type="module">
  import { App } from "${APP_CLIENT}";
  const $ = (id) => document.getElementById(id);
  const app = new App({ name: "Juicebox", version: "1.0.0" });
  let joinUrl, room, qrPng;
  const open = (e) => { e?.preventDefault(); if (joinUrl) app.openLink({ url: joinUrl }); };
  const render = () => {
    let ctx, host;
    try { ctx = app.getHostContext?.(); } catch (e) { ctx = { error: String(e) }; }
    try { host = app.getHostVersion?.(); } catch (e) { host = { error: String(e) }; }
    $("ctx").textContent = JSON.stringify({
      platform: ctx?.platform, hostInfo: host, hostUserAgent: ctx?.userAgent, displayMode: ctx?.displayMode,
      availableDisplayModes: ctx?.availableDisplayModes, deviceCapabilities: ctx?.deviceCapabilities,
      navigatorUserAgent: navigator.userAgent, hostContextKeys: ctx ? Object.keys(ctx) : null
    }, null, 2);
    if (!joinUrl) return;
    const desktop = ctx?.platform === "desktop";
    $("status").textContent = desktop
      ? "Juicebox should open in the panel on the right; if it does not, press Open Juicebox. If Claude asks, choose \u201cAlways allow for this website\u201d."
      : "Juicebox is ready.";
    $("open").hidden = false;
    $("room").textContent = "Juicebox room " + room;
    $("link").textContent = desktop ? "Open in a separate browser window" : joinUrl; $("link").href = joinUrl;
    if (qrPng) { $("qr").src = "data:image/png;base64," + qrPng; $("qr").hidden = false; $("hint").hidden = false; }
    $("more").hidden = false;
  };
  app.ontoolresult = ({ structuredContent: sc, content }) => {
    joinUrl = sc?.joinUrl ?? content?.find((c) => c.type === "text")?.text.match(/https?:\\/\\/\\S+/)?.[0];
    if (!joinUrl) { $("status").textContent = "No join link in the tool result."; return; }
    room = sc?.room ?? new URL(joinUrl).searchParams.get("room"); qrPng = sc?.qrPng;
    render();
  };
  app.onhostcontextchanged = render;
  $("link").onclick = open;
  $("open").onclick = open;
  await app.connect();
  render();
</script>
</body></html>`;
