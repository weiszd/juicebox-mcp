/**
 * The MCP App view (SEP-1865) that shows Juicebox inside an MCP Apps host such
 * as Claude Desktop: a `ui://` HTML resource that frames the page at
 * BROWSER_URL with `?room=<id>` (a join link), so the viewer the pane shows is a
 * page in the session's room and later tools redraw it in place. Hosts that do
 * not render apps ignore the metadata and keep the text link and QR code.
 */

export const VIEW_URI = 'ui://juicebox/join';
export const VIEW_MIME_TYPE = 'text/html;profile=mcp-app';
/** `_meta` for the tool: the current key and the flat one older hosts read. */
export const TOOL_META = { ui: { resourceUri: VIEW_URI }, 'ui/resourceUri': VIEW_URI };

/** Client bundle the view loads, as in Claude's no-build MCP Apps quickstart. */
const APP_CLIENT = 'https://unpkg.com/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js';

/** `_meta.ui` for the resource: the sandbox may frame the page and load the client. */
export function viewMeta(browserUrl) {
  return {
    ui: {
      csp: {
        frameDomains: [new URL(browserUrl).origin],
        resourceDomains: [new URL(APP_CLIENT).origin]
      }
    }
  };
}

export const VIEW_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Juicebox</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: 13px system-ui, sans-serif; }
  #bar { display: flex; align-items: center; gap: 12px; padding: 6px 10px; }
  #bar span { flex: 1; opacity: 0.8; }
  iframe { flex: 1; min-height: 560px; width: 100%; border: 0; }
</style></head>
<body>
<div id="bar"><span id="status">Connecting…</span><button id="open" disabled>Open in browser</button></div>
<iframe id="view" title="Juicebox"></iframe>
<script type="module">
  import { App } from "${APP_CLIENT}";
  const $ = (id) => document.getElementById(id);
  const app = new App({ name: "Juicebox", version: "1.0.0" });
  let joinUrl;
  const show = ({ structuredContent: sc, content }) => {
    joinUrl = sc?.joinUrl ?? content?.find((c) => c.type === "text")?.text.match(/https?:\\/\\/\\S+/)?.[0];
    if (!joinUrl) { $("status").textContent = "No join link in the tool result."; return; }
    $("status").textContent = "Room " + (sc?.room ?? new URL(joinUrl).searchParams.get("room"));
    $("view").src = joinUrl;
    $("open").disabled = false;
  };
  app.ontoolresult = show; // set before connect() so the first result is not missed
  $("open").onclick = () => app.openLink({ url: joinUrl });
  await app.connect();
</script>
</body></html>`;
