# juicebox-web is the host shell, on its own origin; the prototype frontend is retired

The prototype carried its own frontend (a 2.5.3 snapshot of juicebox.js plus a test shell) that duplicated what juicebox-web already owns: catalogs, share modal, `?session=` restore, deploy. juicebox-web becomes the host that attaches the remote, and stays on its own origin while MCP + WebSocket live on `jbmcp.3dg.io`, so the control layer is opt-in per page and juicebox-web's deploy is untouched. Cost accepted: the WebSocket URL is a build-time variable and `/ws` needs an Origin allow-list.
