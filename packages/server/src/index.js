/**
 * Cloudflare Worker entry point for Juicebox MCP Server.
 *
 * Routes:
 *   GET  /ws?room=        - WebSocket upgrade → the room's Durable Object (pages); Origin allow-list
 *   POST /mcp             - MCP protocol (tool calls, initialization)
 *   GET  /mcp             - 405 (SSE not supported; JSON responses only)
 *   DELETE /mcp           - MCP protocol (session termination)
 *   OPTIONS /mcp          - CORS preflight
 *   GET  /*               - 404 (the viewer is hosted by juicebox-web, not this Worker)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools } from './mcp/toolHandlers.js';
import { tinyURLShortener } from './urlShortener.js';
import { logInfo, logWarn, logError } from './lib/logger.js';

// Re-export the Durable Object classes so Cloudflare can find them
export { WebSocketRoom } from './durableObjects/WebSocketRoom.js';
export { McpSession } from './durableObjects/McpSession.js';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A room id: 10 Crockford base32 characters (~50 bits), short enough for a
 * small join-link QR, long enough to be unguessable (design §5.4).
 */
function roomIdFromBytes(bytes) {
  return Array.from(bytes.subarray(0, 10), b => CROCKFORD_BASE32[b & 31]).join('');
}

function mintRoomId() {
  return roomIdFromBytes(crypto.getRandomValues(new Uint8Array(10)));
}

/**
 * Derive a stable room id from a vendor-specific header value using HMAC-SHA256,
 * so the same value always binds the same room. Avoids leaking raw tokens
 * (e.g., x-openai-session) in URLs.
 */
async function deriveSessionId(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return roomIdFromBytes(new Uint8Array(sig));
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

function corsResponse(response) {
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- WebSocket upgrade → the room's Durable Object ---
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      if (!env.ALLOWED_ORIGINS.includes(request.headers.get('Origin'))) {
        return new Response('Origin not allowed', { status: 403 });
      }
      // No room given: mint one. The Durable Object reads it back from the URL.
      const room = url.searchParams.get('room') || mintRoomId();
      url.searchParams.set('room', room);
      const stub = env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(room));
      return stub.fetch(new Request(url, request));
    }

    // --- CORS preflight for /mcp ---
    if (url.pathname === '/mcp' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --- MCP protocol endpoints ---
    if (url.pathname === '/mcp') {
      // Reject GET /mcp (SSE streams) — Workers can't hold long-lived connections.
      // We use enableJsonResponse mode so SSE is not needed.
      if (request.method === 'GET') {
        return new Response('SSE not supported in Workers deployment. Use Streamable HTTP (POST) mode.', {
          status: 405,
          headers: { ...CORS_HEADERS, 'Allow': 'POST, DELETE, OPTIONS' }
        });
      }
      return corsResponse(await handleMcpRequest(request, env));
    }

    // The viewer is hosted by juicebox-web, not this Worker.
    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Handle MCP protocol requests (POST, GET, DELETE).
 *
 * Because Workers are stateless, we create a fresh McpServer + transport per request.
 * A stateless transport accepts tool calls without a prior initialize.
 */
async function handleMcpRequest(request, env) {
  try {
    // Parse the request body up front so we can inspect and replay it
    let body = null;
    if (request.method === 'POST') {
      body = await request.json();
    }

    const sessionId = request.headers.get('mcp-session-id');
    const openaiSession = request.headers.get('x-openai-session');
    logInfo(`[MCP] ${request.method} ${body?.method || 'N/A'} | mcp-session-id: ${sessionId || 'NONE'} | x-openai-session: ${openaiSession ? 'present' : 'NONE'}`);

    // Create a new MCP server for this request
    const mcpServer = new McpServer({
      name: 'juicebox-server',
      version: '1.1.0'
    });

    // Stateless transport — no session ID validation.
    // We manage session IDs at the Worker level (from request headers).
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Build the deps object for tool handlers
    const browserUrl = env.BROWSER_URL || 'https://juicebox-mcp.workers.dev';
    const shortenURL = tinyURLShortener({
      endpoint: env.TINYURL_ENDPOINT || 'https://api.tinyurl.com/create',
      apiKey: env.TINYURL_API_KEY,
      domain: env.TINYURL_DOMAIN || 't.3dg.io'
    });

    // Fallback: ChatGPT doesn't echo mcp-session-id back, but sends x-openai-session on every request.
    // HMAC the raw token so it's not exposed in browser URLs. No secret, no fallback key.
    if (!sessionId && openaiSession && !env.SESSION_HMAC_SECRET) {
      logError('[MCP] SESSION_HMAC_SECRET is not set; refusing x-openai-session request');
      return Response.json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Server misconfigured: SESSION_HMAC_SECRET is not set' },
        id: body?.id ?? null
      }, { status: 500 });
    }
    const effectiveSessionId = sessionId ||
      (openaiSession ? await deriveSessionId(openaiSession, env.SESSION_HMAC_SECRET) : null);

    // The room this MCP session is bound to: the one join_room stored, else the
    // room named by the session id. Looked up at most once per request, and only
    // by tools that reach a page.
    const sessionStub = effectiveSessionId &&
      env.MCP_SESSION.get(env.MCP_SESSION.idFromName(effectiveSessionId));
    let roomLookup;
    function getRoom() {
      roomLookup ??= sessionStub
        ? sessionStub.fetch('https://do/room').then(r => r.text()).then(bound => bound || effectiveSessionId)
        : Promise.resolve(null);
      return roomLookup;
    }

    async function getDoStub() {
      const room = await getRoom();
      if (!room) return null;
      return env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(room));
    }

    async function postToRoom(path, command) {
      const stub = await getDoStub();
      if (!stub) return { status: 'no-page' };
      const resp = await stub.fetch(new Request(`https://do${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command)
      }));
      return resp.json();
    }

    const deps = {
      sessionId: effectiveSessionId,
      browserUrl,
      shortenURL,
      log: { logInfo, logWarn, logError },
      getRoom,

      bindRoom: async (room) => {
        await sessionStub.fetch('https://do/room', { method: 'PUT', body: room });
        roomLookup = Promise.resolve(room);
      },

      // Resolves {status: 'acked', ok, result?, error?} | {status: 'unconfirmed'} | {status: 'no-page'}.
      sendCommand: (command) => {
        logInfo(`[sendCommand] type=${command.type} sessionId=${effectiveSessionId || 'NONE'}`);
        return postToRoom('/send', command);
      },

      // Same, but asks only the first live page; adds {status: 'closed'} if it disconnects first.
      sendRequest: (command) => {
        logInfo(`[sendRequest] type=${command.type} sessionId=${effectiveSessionId || 'NONE'}`);
        return postToRoom('/request', command);
      },

      isBrowserConnected: async () => {
        const stub = await getDoStub();
        if (!stub) return false;
        try {
          const resp = await stub.fetch(new Request('https://do/status'));
          const result = await resp.json();
          return result.connected;
        } catch {
          return false;
        }
      }
    };

    // Register all tools
    registerTools(mcpServer, deps);

    // Connect the server to the transport
    await mcpServer.connect(transport);

    const isInit = body?.method === 'initialize' ||
      (Array.isArray(body) && body.some(m => m.method === 'initialize'));

    // Handle the actual request
    const response = await transport.handleRequest(request, body ? { parsedBody: body } : undefined);

    // For initialize responses in stateless mode, inject a session ID header
    // so MCP clients can use it for subsequent requests and WebSocket routing.
    if (isInit && !response.headers.has('mcp-session-id')) {
      const newSessionId = effectiveSessionId || mintRoomId();
      const patched = new Response(response.body, response);
      patched.headers.set('mcp-session-id', newSessionId);
      return patched;
    }

    return response;
  } catch (error) {
    logError('Error handling MCP request:', error);
    return Response.json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null
    }, { status: 500 });
  }
}

