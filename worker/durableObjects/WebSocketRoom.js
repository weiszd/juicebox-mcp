/**
 * Durable Object for managing WebSocket connections between the MCP server and browser clients.
 * One instance per session (keyed by sessionId).
 * Uses the Hibernation API for cost-efficient idle connections.
 */
export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map of requestId -> { resolve, reject, timer } for pending data requests
    this.pendingRequests = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade from browser
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // Worker sends a command to the browser
    if (url.pathname === '/send') {
      const command = await request.json();
      return this.sendToClient(command);
    }

    // Worker requests session data from browser (synchronous wait for WS response)
    if (url.pathname === '/request-session-data') {
      return this.requestDataFromBrowser('getSession', 'sessionData', 'sessionDataError');
    }

    // Worker requests compressed session data from browser
    if (url.pathname === '/request-compressed-session-data') {
      return this.requestDataFromBrowser('getCompressedSession', 'compressedSessionData', 'compressedSessionDataError');
    }

    // Health check / connection status
    if (url.pathname === '/status') {
      const websockets = this.state.getWebSockets();
      return Response.json({
        connected: websockets.length > 0,
        count: websockets.length
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  handleWebSocketUpgrade(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket with the hibernation API
    this.state.acceptWebSocket(server);
    console.log(`[DO] WebSocket accepted. Total connections: ${this.state.getWebSockets().length}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Send a command to all connected browser WebSockets.
   */
  sendToClient(command) {
    const websockets = this.state.getWebSockets();
    console.log(`[DO sendToClient] command=${command.type} websockets=${websockets.length}`);
    if (websockets.length === 0) {
      return Response.json({ sent: false, error: 'No browser connected' }, { status: 404 });
    }

    const message = JSON.stringify(command);
    let sent = 0;
    for (const ws of websockets) {
      try {
        ws.send(message);
        sent++;
        console.log(`[DO sendToClient] sent to WebSocket`);
      } catch (e) {
        console.error(`[DO sendToClient] error sending:`, e);
      }
    }

    return Response.json({ sent: sent > 0, count: sent });
  }

  /**
   * Request data from the browser and wait for the response.
   * This creates a pending request, sends a command over WebSocket,
   * and returns a Promise that resolves when the browser responds.
   */
  async requestDataFromBrowser(commandType, responseType, errorType) {
    const websockets = this.state.getWebSockets();
    if (websockets.length === 0) {
      return Response.json({ error: 'No browser connected' }, { status: 404 });
    }

    const requestId = crypto.randomUUID();

    // Create a promise that will be resolved by the webSocketMessage handler
    const dataPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Timeout waiting for browser response'));
      }, 15000);

      this.pendingRequests.set(requestId, { resolve, reject, timer, responseType, errorType });
    });

    // Send command to browser
    const command = JSON.stringify({ type: commandType, requestId });
    for (const ws of websockets) {
      try {
        ws.send(command);
        break; // Send to first connected client
      } catch (e) {
        // Try next
      }
    }

    try {
      const data = await dataPromise;
      return Response.json({ data });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  // --- Hibernation API lifecycle methods ---

  webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));

      // Handle session registration (backward compat with existing protocol)
      if (data.type === 'registerSession') {
        ws.send(JSON.stringify({ type: 'sessionRegistered', sessionId: data.sessionId }));
        return;
      }

      // Check if this is a response to a pending request
      if (data.requestId && this.pendingRequests.has(data.requestId)) {
        const pending = this.pendingRequests.get(data.requestId);
        this.pendingRequests.delete(data.requestId);
        clearTimeout(pending.timer);

        if (data.type === pending.responseType) {
          // Resolve with the appropriate data field
          const responseData = data.sessionData || data.compressedSession || data;
          pending.resolve(responseData);
        } else if (data.type === pending.errorType) {
          pending.reject(new Error(data.error || 'Browser returned an error'));
        } else {
          pending.resolve(data);
        }
        return;
      }

      // Sync events: relay to all OTHER browsers in the same session
      if (data.type === 'syncEvent') {
        const websockets = this.state.getWebSockets();
        const msg = JSON.stringify(data);
        for (const other of websockets) {
          if (other !== ws) {
            try { other.send(msg); } catch (e) { /* connection may be closing */ }
          }
        }
        return;
      }

      // Other messages are ignored (browser might send debug info, etc.)
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    // Clean up - reject any pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser disconnected'));
    }
    this.pendingRequests.clear();
  }

  webSocketError(ws, error) {
    console.error('WebSocket error in Durable Object:', error);
  }
}
