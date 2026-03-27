/**
 * Cloudflare Worker entry point for Juicebox MCP Server.
 *
 * Routes:
 *   GET  /ws              - WebSocket upgrade → Durable Object (browser communication)
 *   POST /mcp             - MCP protocol (tool calls, initialization)
 *   GET  /mcp             - MCP protocol (SSE streams)
 *   DELETE /mcp           - MCP protocol (session termination)
 *   OPTIONS /mcp          - CORS preflight
 *   GET  /*               - Static assets handled by Cloudflare [assets] directive
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools } from './mcp/toolHandlers.js';
import { tinyURLShortener } from '../src/urlShortener.js';
import { logInfo, logWarn, logError } from './lib/logger.js';

// Re-export the Durable Object class so Cloudflare can find it
export { WebSocketRoom } from './durableObjects/WebSocketRoom.js';

/**
 * Derive a stable, opaque session ID from a vendor-specific header value
 * using HMAC-SHA256. Avoids leaking raw tokens (e.g., x-openai-session) in URLs.
 */
async function deriveSessionId(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
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

    // --- WebSocket upgrade → Durable Object ---
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) {
        return new Response('Missing sessionId query parameter', { status: 400 });
      }
      const id = env.WEBSOCKET_ROOM.idFromName(sessionId);
      const stub = env.WEBSOCKET_ROOM.get(id);
      return stub.fetch(request);
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

    // --- Static assets via binding ---
    // Worker handles all requests (binding mode). Serve assets, with SPA fallback.
    return handleStaticAssets(request, env);
  }
};

/**
 * Handle MCP protocol requests (POST, GET, DELETE).
 *
 * Because Workers are stateless, we create a fresh McpServer + transport per request.
 * For non-initialize requests, we auto-initialize the server internally so tool
 * calls work without requiring the client to re-initialize on every request.
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

    function getDoStub(sid) {
      if (!sid) return null;
      const id = env.WEBSOCKET_ROOM.idFromName(sid);
      return env.WEBSOCKET_ROOM.get(id);
    }

    // Fallback: ChatGPT doesn't echo mcp-session-id back, but sends x-openai-session on every request.
    // HMAC the raw token so it's not exposed in browser URLs.
    const effectiveSessionId = sessionId ||
      (openaiSession ? await deriveSessionId(openaiSession, env.SESSION_HMAC_SECRET || 'juicebox-mcp-session-key') : null);

    const deps = {
      sessionId: effectiveSessionId,
      browserUrl,
      shortenURL,
      log: { logInfo, logWarn, logError },

      sendCommand: async (command) => {
        logInfo(`[sendCommand] type=${command.type} sessionId=${effectiveSessionId || 'NONE'}`);
        const stub = getDoStub(effectiveSessionId);
        if (!stub) {
          logWarn('[sendCommand] No DO stub — effectiveSessionId is null');
          return;
        }
        try {
          const resp = await stub.fetch(new Request('https://do/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command)
          }));
          const result = await resp.json();
          logInfo(`[sendCommand] DO response: ${JSON.stringify(result)}`);
        } catch (error) {
          logError('[sendCommand] Error sending to DO:', error);
        }
      },

      requestSessionData: async () => {
        const stub = getDoStub(effectiveSessionId);
        if (!stub) throw new Error('No session ID available');
        const resp = await stub.fetch(new Request('https://do/request-session-data', { method: 'POST' }));
        const result = await resp.json();
        if (result.error) throw new Error(result.error);
        return result.data;
      },

      requestCompressedSessionData: async () => {
        const stub = getDoStub(effectiveSessionId);
        if (!stub) throw new Error('No session ID available');
        const resp = await stub.fetch(new Request('https://do/request-compressed-session-data', { method: 'POST' }));
        const result = await resp.json();
        if (result.error) throw new Error(result.error);
        return result.data;
      },

      requestTrackList: async () => {
        const stub = getDoStub(effectiveSessionId);
        if (!stub) throw new Error('No session ID available');
        const resp = await stub.fetch(new Request('https://do/request-track-list', { method: 'POST' }));
        const result = await resp.json();
        if (result.error) throw new Error(result.error);
        return result.data;
      },

      isBrowserConnected: async () => {
        const stub = getDoStub(effectiveSessionId);
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

    // For non-initialize POST requests, we need to auto-initialize the server.
    // The transport rejects non-initialize requests if it hasn't seen an initialize first.
    const isInit = body?.method === 'initialize' ||
      (Array.isArray(body) && body.some(m => m.method === 'initialize'));

    if (request.method === 'POST' && !isInit) {
      // Send a synthetic initialize through the transport to warm it up
      const initBody = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'juicebox-worker', version: '1.0.0' }
        },
        id: '_internal_init'
      };
      const initReq = new Request(request.url, {
        method: 'POST',
        headers: new Headers({ 'Content-Type': 'application/json' }),
      });
      // Handle init (discard the response — it just warms up the transport)
      await transport.handleRequest(initReq, { parsedBody: initBody });
    }

    // Handle the actual request
    const response = await transport.handleRequest(request, body ? { parsedBody: body } : undefined);

    // For initialize responses in stateless mode, inject a session ID header
    // so MCP clients can use it for subsequent requests and WebSocket routing.
    if (isInit && !response.headers.has('mcp-session-id')) {
      const newSessionId = effectiveSessionId || crypto.randomUUID();
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

/**
 * Serve static assets via the ASSETS binding, with SPA fallback to index.html.
 */
async function handleStaticAssets(request, env) {
  try {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) {
      return response;
    }
  } catch (e) {
    // Fall through to SPA fallback
  }

  // SPA fallback: serve index.html for GET requests
  if (request.method === 'GET') {
    try {
      const indexUrl = new URL('/index.html', request.url);
      return await env.ASSETS.fetch(new Request(indexUrl, request));
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  }
  return new Response('Not Found', { status: 404 });
}
