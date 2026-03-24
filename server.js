// Load environment variables from .env file for local development/testing
// This is only used when running server.js directly (not in bundled .mcpb)
import 'dotenv/config';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import { tmpdir, homedir, platform } from 'node:os';
import { DATA_SOURCES, getDataSource, getAllSourceIds, isValidSource } from './src/dataSourceConfigs.js';
import { parseDataSource } from './src/dataParsers.js';
import { filterMaps } from './src/mapFilter.js';
import { formatSearchResults, formatSearchResultsJSON } from './src/resultFormatter.js';
import { tinyURLShortener } from './src/urlShortener.js';

// Parse command line arguments
function parseCommandLineArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--browser-url' || arg === '-u') {
      args.browserUrl = process.argv[++i];
    } else if (arg.startsWith('--browser-url=')) {
      args.browserUrl = arg.split('=')[1];
    } else if (arg === '--http' || arg === '--http-mode') {
      args.httpMode = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: node server.js [options]

Options:
  --browser-url, -u <url>    Browser URL for the Juicebox app (e.g., https://your-app.netlify.app)
                             Overrides BROWSER_URL environment variable
  --http, --http-mode        Force HTTP/SSE mode (for MCP Inspector and other HTTP clients)
  --help, -h                 Show this help message

Environment Variables:
  BROWSER_URL                Browser URL (used if --browser-url not provided)
  MCP_PORT                   MCP server port (default: 3010)
  WS_PORT                    WebSocket server port (default: 3011)
  MCP_TRANSPORT              Set to "http" or "sse" to force HTTP mode
  FORCE_HTTP_MODE            Set to "true" to force HTTP mode
  TINYURL_API_KEY            TinyURL API key for URL shortening (optional)
  TINYURL_DOMAIN             TinyURL custom domain (optional, default: t.3dg.io)
  TINYURL_ENDPOINT           TinyURL API endpoint (optional, default: https://api.tinyurl.com/create)

Configuration Priority:
  1. Command line argument (--browser-url)
  2. Environment variable (BROWSER_URL)
  3. Default (http://localhost:5173)

Examples:
  node server.js --browser-url https://my-app.netlify.app
  node server.js -u http://localhost:5173
  node server.js --http  # Start in HTTP mode for MCP Inspector
      `);
      process.exit(0);
    }
  }
  return args;
}

const cliArgs = parseCommandLineArgs();

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3010;
const WS_PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 3011;
// Browser URL for the Juicebox app
// Priority: 1) Command line argument (--browser-url), 2) Environment variable (BROWSER_URL), 
//           3) Default (localhost)
const BROWSER_URL = cliArgs.browserUrl || process.env.BROWSER_URL || 'http://localhost:5173';

// TinyURL configuration
const TINYURL_API_KEY = process.env.TINYURL_API_KEY;
const TINYURL_DOMAIN = process.env.TINYURL_DOMAIN || 't.3dg.io';
const TINYURL_ENDPOINT = process.env.TINYURL_ENDPOINT || 'https://api.tinyurl.com/create';

// Initialize URL shortener
const shortenURL = tinyURLShortener({
  endpoint: TINYURL_ENDPOINT,
  apiKey: TINYURL_API_KEY,
  domain: TINYURL_DOMAIN
});

// Force HTTP mode if requested via command line
if (cliArgs.httpMode) {
  process.env.MCP_TRANSPORT = 'http';
}

// File-based logger for diagnostics (visible even when running in Claude Desktop)
// Default to temp directory to avoid cluttering user's home directory
const LOG_FILE = process.env.JUICEBOX_MCP_LOG_FILE || join(tmpdir(), 'juicebox-mcp-server.log');
const ENABLE_FILE_LOGGING = process.env.JUICEBOX_MCP_LOG !== 'false';

function logToFile(level, ...args) {
  if (!ENABLE_FILE_LOGGING) return;
  
  try {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    const logLine = `[${timestamp}] [${level}] ${message}\n`;
    appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (error) {
    // Silently fail if we can't write to log file
    // Don't use console.error here to avoid infinite loops
  }
}

// Enhanced logging functions that write to both stderr and file
function logError(...args) {
  console.error(...args);
  logToFile('ERROR', ...args);
}

function logWarn(...args) {
  console.warn(...args);
  logToFile('WARN', ...args);
}

function logInfo(...args) {
  // Only log to file for info messages (don't pollute stderr)
  logToFile('INFO', ...args);
}

// Store connected WebSocket clients by session ID
// Map<sessionId, Set<WebSocket>> — multiple browsers can share a session
const wsClients = new Map();

// Map to store pending session data requests (requestId -> { resolve, reject, timeout })
const pendingSessionRequests = new Map();

// State management removed - commands will simply update Juicebox without querying state

// Detect if we're running in STDIO mode (subprocess) or HTTP mode
// We need to check this early to handle WebSocket server errors appropriately
const forceHttpMode = process.env.MCP_TRANSPORT === 'http' || process.env.MCP_TRANSPORT === 'sse' || process.env.FORCE_HTTP_MODE === 'true';
const isStdioMode = !forceHttpMode && !process.stdin.isTTY;

// Create WebSocket server for browser communication
const wss = new WebSocketServer({ port: WS_PORT });

// Handle WebSocket server errors (e.g., port already in use)
wss.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logError(`\n⚠️  WARNING: Port ${WS_PORT} is already in use.`);
    logError(`   Another instance of the server may be running.`);
    if (isStdioMode) {
      // In STDIO mode, WebSocket server is optional - just warn and continue
      // The STDIO transport is the critical part for Claude Desktop
      logError(`   Continuing in STDIO mode (WebSocket server unavailable).`);
      logError(`   Browser connections will not work until port ${WS_PORT} is free.`);
      logError(`   To fix this:`);
      logError(`   1. Find the process using port ${WS_PORT}: lsof -i :${WS_PORT}`);
      logError(`   2. Kill it: kill <PID>`);
      logError(`   3. Or change WS_PORT in your environment\n`);
    } else {
      // In HTTP mode, WebSocket server is required - exit
      logError(`   This is required for HTTP mode. Exiting.\n`);
      process.exit(1);
    }
  } else {
    logError('WebSocket server error:', error);
    if (!isStdioMode) {
      // Only exit in HTTP mode - STDIO mode can continue without WebSocket server
      process.exit(1);
    } else {
      logError('Continuing in STDIO mode despite WebSocket server error.');
    }
  }
});

wss.on('listening', () => {
  // Log to file (and stderr) - won't interfere with MCP protocol on stdout
  logError(`WebSocket server listening on ws://localhost:${WS_PORT}`);
});

wss.on('connection', (ws) => {
  logInfo('Browser client connected (waiting for session ID)');
  let sessionId = null;

  ws.on('error', (error) => {
    logError(`WebSocket error (session: ${sessionId || 'unregistered'}):`, error);
  });

  // Handle incoming messages from clients
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      
      // First message should be session registration
      if (data.type === 'registerSession' && data.sessionId) {
        sessionId = data.sessionId;
        if (!wsClients.has(sessionId)) {
          wsClients.set(sessionId, new Set());
        }
        wsClients.get(sessionId).add(ws);
        logInfo(`Browser client registered with session ID: ${sessionId} (${wsClients.get(sessionId).size} client(s))`);
        
        // Send confirmation
        ws.send(JSON.stringify({
          type: 'sessionRegistered',
          sessionId: sessionId
        }));
      } else if (data.type === 'sessionData' && data.requestId) {
        // Handle session data response
        const request = pendingSessionRequests.get(data.requestId);
        if (request) {
          clearTimeout(request.timeout);
          pendingSessionRequests.delete(data.requestId);
          request.resolve(data.sessionData);
          logInfo(`Received session data for request ${data.requestId}`);
        } else {
          logWarn(`Received session data for unknown request ID: ${data.requestId}`);
        }
      } else if (data.type === 'sessionDataError' && data.requestId) {
        // Handle session data error response
        const request = pendingSessionRequests.get(data.requestId);
        if (request) {
          clearTimeout(request.timeout);
          pendingSessionRequests.delete(data.requestId);
          request.reject(new Error(data.error || 'Failed to get session data'));
          logError(`Session data error for request ${data.requestId}:`, data.error);
        }
      } else if (data.type === 'compressedSessionData' && data.requestId) {
        // Handle compressed session data response
        const request = pendingSessionRequests.get(data.requestId);
        if (request) {
          clearTimeout(request.timeout);
          pendingSessionRequests.delete(data.requestId);
          request.resolve(data.compressedSession);
          logInfo(`Received compressed session data for request ${data.requestId}`);
        } else {
          logWarn(`Received compressed session data for unknown request ID: ${data.requestId}`);
        }
      } else if (data.type === 'compressedSessionDataError' && data.requestId) {
        // Handle compressed session data error response
        const request = pendingSessionRequests.get(data.requestId);
        if (request) {
          clearTimeout(request.timeout);
          pendingSessionRequests.delete(data.requestId);
          request.reject(new Error(data.error || 'Failed to get compressed session data'));
          logError(`Compressed session data error for request ${data.requestId}:`, data.error);
        }
      } else if (data.type === 'syncEvent' && sessionId) {
        // Relay sync event to all OTHER browsers in the same session
        sendToOthersInSession(sessionId, ws, data);
      } else if (sessionId) {
        // Handle other messages (for testing/debugging)
        logInfo(`Received message from client (session ${sessionId}):`, data.type || 'unknown');
      } else {
        logWarn('Received message from unregistered client');
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Session not registered. Please send registerSession message first.'
        }));
      }
    } catch (error) {
      logError('Error parsing WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    if (sessionId && wsClients.has(sessionId)) {
      wsClients.get(sessionId).delete(ws);
      const remaining = wsClients.get(sessionId).size;
      if (remaining === 0) {
        wsClients.delete(sessionId);
      }
      logInfo(`Browser client disconnected (session: ${sessionId}, ${remaining} remaining)`);
    } else {
      logInfo('Browser client disconnected (unregistered)');
    }
  });

});

// Send command to all browser clients in a session
function sendToSession(sessionId, command) {
  const clients = wsClients.get(sessionId);
  if (!clients || clients.size === 0) {
    logWarn(`No active WebSocket connection for session: ${sessionId} (available: ${Array.from(wsClients.keys()).join(', ') || 'none'})`);
    return false;
  }
  const message = JSON.stringify(command);
  let sent = 0;
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(message); sent++; } catch (error) {
        logError(`Error sending WebSocket message to session ${sessionId}: ${error.message}`);
      }
    }
  }
  if (sent > 0) {
    logInfo(`Command sent to session ${sessionId}: ${command.type} (${sent} client(s))`);
  }
  return sent > 0;
}

// Send command to all OTHER browser clients in a session (exclude sender)
function sendToOthersInSession(sessionId, senderWs, command) {
  const clients = wsClients.get(sessionId);
  if (!clients) return;
  const message = JSON.stringify(command);
  for (const ws of clients) {
    if (ws !== senderWs && ws.readyState === 1) {
      try { ws.send(message); } catch (e) { /* connection may be closing */ }
    }
  }
}

// Check if a session has at least one open WebSocket client
function hasOpenClient(sessionId) {
  const clients = wsClients.get(sessionId);
  if (!clients) return false;
  for (const ws of clients) {
    if (ws.readyState === 1) return true;
  }
  return false;
}

// State query functions removed - we don't query or cache state

// Request-scoped context for current session ID using AsyncLocalStorage
// This maintains context across async operations
const sessionContext = new AsyncLocalStorage();

// Helper function for tool handlers to route commands to the current request's session
function routeToCurrentSession(command) {
  const sessionId = sessionContext.getStore();
  if (sessionId) {
    const sent = sendToSession(sessionId, command);
    if (!sent && wsClients.size > 0) {
      // Fallback: if specific session not found, broadcast to all clients
      logWarn(`Session ${sessionId} not found, broadcasting to all ${wsClients.size} client(s)`);
      broadcastToClients(command);
    }
  } else if (isStdioMode) {
    // In STDIO mode, route to the unique STDIO session ID
    if (STDIO_SESSION_ID) {
      const sent = sendToSession(STDIO_SESSION_ID, command);
      if (!sent && wsClients.size > 0) {
        // Fallback: if STDIO session not found, broadcast to all clients
        logWarn(`STDIO session ${STDIO_SESSION_ID} not found, broadcasting to all ${wsClients.size} client(s)`);
        broadcastToClients(command);
      } else if (!sent) {
        logWarn(`No WebSocket clients connected. Command not routed: ${command.type}`);
      }
    } else {
      logWarn('Routing command in STDIO mode - no session ID available, broadcasting to all clients');
      if (wsClients.size > 0) {
        broadcastToClients(command);
      } else {
        logWarn(`No WebSocket clients connected. Command not routed: ${command.type}`);
      }
    }
  } else {
    logWarn('Tool handler called but no session context available. Command not routed.');
  }
}

// Broadcast command to all connected browser clients (kept for backward compatibility if needed)
function broadcastToClients(command) {
  const message = JSON.stringify(command);
  for (const [, clients] of wsClients) {
    for (const ws of clients) {
      if (ws.readyState === 1) {
        try { ws.send(message); } catch (e) { /* ignore */ }
      }
    }
  }
}

// Create MCP server
const mcpServer = new McpServer({
  name: 'juicebox-server',
  version: '1.1.0'
});

// Register MCP resources for data source configurations
mcpServer.setResourceRequestHandlers({
  list: async () => {
    return {
      resources: [
        {
          uri: 'juicebox://datasource/4dn',
          name: '4DN Contact Map Data Source',
          description: '4DN Hi-C contact map data source configuration',
          mimeType: 'application/json'
        },
        {
          uri: 'juicebox://datasource/encode',
          name: 'ENCODE Contact Map Data Source',
          description: 'ENCODE Hi-C contact map data source configuration',
          mimeType: 'application/json'
        }
      ]
    };
  },
  read: async (request) => {
    const { uri } = request.params;
    
    if (uri === 'juicebox://datasource/4dn') {
      const config = getDataSource('4dn');
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(config, null, 2)
        }]
      };
    } else if (uri === 'juicebox://datasource/encode') {
      const config = getDataSource('encode');
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(config, null, 2)
        }]
      };
    }
    
    throw new Error(`Unknown resource URI: ${uri}`);
  }
});

// Helper function to convert hex color to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Zod schema for color input - accepts hex codes
const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color code (e.g., "#ff0000")')
  .describe('Hex color code (e.g., "#ff0000")');

// Register tool: load_map
mcpServer.registerTool(
  'load_map',
  {
    title: 'Load Map',
    description: 'Load a Hi-C contact map (.hic file) into Juicebox',
    inputSchema: {
      url: z.string().url().describe('URL to the .hic file'),
      name: z.string().optional().describe('Optional name for the map'),
      normalization: z.string().optional().describe('Normalization method (e.g., "VC", "VC_SQRT", "KR", "NONE")'),
      locus: z.string().optional().describe('Optional genomic locus (e.g., "1:1000000-2000000 1:1000000-2000000")')
    }
  },
  async ({ url, name, normalization, locus }) => {
    routeToCurrentSession({
      type: 'loadMap',
      url: url,
      name: name,
      normalization: normalization,
      locus: locus
    });

    return {
      content: [
        {
          type: 'text',
          text: `Loading map from ${url}${name ? ` (${name})` : ''}`
        }
      ]
    };
  }
);

// Register tool: load_control_map
mcpServer.registerTool(
  'load_control_map',
  {
    title: 'Load Control Map',
    description: 'Load a control map (.hic file) for comparison',
    inputSchema: {
      url: z.string().url().describe('URL to the control .hic file'),
      name: z.string().optional().describe('Optional name for the control map'),
      normalization: z.string().optional().describe('Normalization method (e.g., "VC", "VC_SQRT", "KR", "NONE")')
    }
  },
  async ({ url, name, normalization }) => {
    routeToCurrentSession({
      type: 'loadControlMap',
      url: url,
      name: name,
      normalization: normalization
    });

    return {
      content: [
        {
          type: 'text',
          text: `Loading control map from ${url}${name ? ` (${name})` : ''}`
        }
      ]
    };
  }
);

// Register tool: load_session
mcpServer.registerTool(
  'load_session',
  {
    title: 'Load Session',
    description: 'Load a Juicebox session from JSON data, attached file, or remote URL. Sessions restore browser configurations, loci, tracks, and visualization state. Supports three input methods: (1) direct JSON paste, (2) file attachment, (3) URL-based loading from remote sources (Dropbox, AWS, etc.).',
    inputSchema: {
      sessionData: z.string().optional().describe('JSON string of session data (use when pasting JSON directly into chat)'),
      sessionUrl: z.string().url().optional().describe('URL to fetch session JSON from remote source (e.g., Dropbox, AWS S3, GitHub raw file URL)'),
      fileContent: z.string().optional().describe('Content of attached session file (use when user attaches a .json file to the chat)')
    }
  },
  async ({ sessionData, sessionUrl, fileContent }) => {
    // Determine source: fileContent > sessionData > sessionUrl
    let parsedSession;
    
    try {
      if (fileContent) {
        // Handle attached file
        parsedSession = JSON.parse(fileContent);
      } else if (sessionData) {
        // Handle direct JSON paste
        parsedSession = JSON.parse(sessionData);
      } else if (sessionUrl) {
        // Normalize Dropbox URLs: convert preview links (dl=0) to download links (dl=1)
        let normalizedUrl = sessionUrl;
        if (sessionUrl.includes('dropbox.com') && sessionUrl.includes('dl=0')) {
          normalizedUrl = sessionUrl.replace('dl=0', 'dl=1');
          logInfo(`Normalized Dropbox URL: ${normalizedUrl}`);
        }
        
        // Fetch from remote URL (Dropbox, AWS, GitHub, etc.)
        logInfo(`Fetching session from URL: ${normalizedUrl}`);
        const response = await fetch(normalizedUrl);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch session from URL: ${response.status} ${response.statusText}`);
        }
        
        // Check Content-Type to ensure we're getting JSON
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
          logWarn(`Unexpected Content-Type: ${contentType}. Attempting to parse as JSON anyway.`);
        }
        
        // Get response text first to check if it's actually JSON
        const responseText = await response.text();
        
        // Check if response looks like HTML (common with Dropbox preview links)
        if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
          throw new Error('Received HTML instead of JSON. The URL may be a preview link. For Dropbox links, ensure dl=1 parameter is set, or use a direct download link.');
        }
        
        try {
          parsedSession = JSON.parse(responseText);
        } catch (parseError) {
          logError(`Failed to parse JSON from URL. Response preview: ${responseText.substring(0, 200)}...`);
          throw new Error(`Invalid JSON received from URL: ${parseError.message}. The URL may not point to a valid JSON file.`);
        }
      } else {
        throw new Error('No session data provided. Provide sessionData (for pasted JSON), sessionUrl (for remote URLs like Dropbox/AWS), or attach a file.');
      }
      
      // Validate session structure
      if (!parsedSession.browsers && !parsedSession.url) {
        throw new Error('Invalid session format: must contain "browsers" array or browser config');
      }
      
      // Route to browser
      routeToCurrentSession({
        type: 'loadSession',
        sessionData: parsedSession
      });
      
      const browserCount = parsedSession.browsers ? parsedSession.browsers.length : 1;
      return {
        content: [{
          type: 'text',
          text: `Session loaded successfully. Restored ${browserCount} browser(s).`
        }]
      };
    } catch (error) {
      logError(`Error loading session: ${error.message}`);
      if (error.stack) {
        logError(`Stack trace: ${error.stack}`);
      }
      return {
        content: [{
          type: 'text',
          text: `Error loading session: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Register tool: zoom_in
mcpServer.registerTool(
  'zoom_in',
  {
    title: 'Zoom In',
    description: 'Zoom in on the contact map',
    inputSchema: {
      centerX: z.number().optional().describe('Optional X coordinate for zoom center (pixels)'),
      centerY: z.number().optional().describe('Optional Y coordinate for zoom center (pixels)')
    }
  },
  async ({ centerX, centerY }) => {
    routeToCurrentSession({
      type: 'zoomIn',
      centerX: centerX,
      centerY: centerY
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Zooming in'
        }
      ]
    };
  }
);

// Register tool: zoom_out
mcpServer.registerTool(
  'zoom_out',
  {
    title: 'Zoom Out',
    description: 'Zoom out on the contact map',
    inputSchema: {
      centerX: z.number().optional().describe('Optional X coordinate for zoom center (pixels)'),
      centerY: z.number().optional().describe('Optional Y coordinate for zoom center (pixels)')
    }
  },
  async ({ centerX, centerY }) => {
    routeToCurrentSession({
      type: 'zoomOut',
      centerX: centerX,
      centerY: centerY
    });

    return {
      content: [
        {
          type: 'text',
          text: 'Zooming out'
        }
      ]
    };
  }
);

// Register tool: set_map_foreground_color
mcpServer.registerTool(
  'set_map_foreground_color',
  {
    title: 'Set Map Foreground Color',
    description: 'Set the foreground color scale for the contact map',
    inputSchema: {
      color: colorSchema,
      threshold: z.number().positive().optional().describe('Optional threshold value for the color scale')
    }
  },
  async ({ color, threshold }) => {
    const rgb = hexToRgb(color);
    if (!rgb) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid color: ${color}. Please use a hex code (e.g., "#ff0000")`
          }
        ],
        isError: true
      };
    }

    routeToCurrentSession({
      type: 'setForegroundColor',
      color: rgb,
      threshold: threshold
    });

    return {
      content: [
        {
          type: 'text',
          text: `Map foreground color set to ${color}${threshold ? ` with threshold ${threshold}` : ''}`
        }
      ]
    };
  }
);

// Register tool: set_map_background_color
mcpServer.registerTool(
  'set_map_background_color',
  {
    title: 'Set Map Background Color',
    description: 'Set the background color of the contact map',
    inputSchema: {
      color: colorSchema
    }
  },
  async ({ color }) => {
    const rgb = hexToRgb(color);
    if (!rgb) {
      return {
        content: [
          {
            type: 'text',
            text: `Invalid color: ${color}. Please use a hex code (e.g., "#000000")`
          }
        ],
        isError: true
      };
    }

    routeToCurrentSession({
      type: 'setBackgroundColor',
      color: rgb
    });

    return {
      content: [
        {
          type: 'text',
          text: `Map background color set to ${color}`
        }
      ]
    };
  }
);

// Register tool: create_shareable_url
mcpServer.registerTool(
  'create_shareable_url',
  {
    title: 'Create Shareable URL',
    description: 'Create a shareable URL for the current Juicebox session',
    inputSchema: {}
  },
  async () => {
    const sessionId = getCurrentSessionId();
    if (!sessionId) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No active session found.'
          }
        ],
        isError: true
      };
    }

    // Check if browser is connected
    const hasConnection = sessionId 
      ? (hasOpenClient(sessionId))
      : (isStdioMode && STDIO_SESSION_ID && hasOpenClient(STDIO_SESSION_ID));
    
    if (!hasConnection) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No active browser connection found. Please ensure the Juicebox browser is open and connected.'
          }
        ],
        isError: true
      };
    }

    try {
      // Request compressed session data from browser
      logInfo('Requesting compressed session data from browser...');
      const compressedSessionString = await requestCompressedSessionData(sessionId || STDIO_SESSION_ID);
      
      // Build URL with compressed session (format: base?session=blob:compressedData)
      // Note: We intentionally do NOT include sessionId in shareable URLs because:
      // 1. The compressed session data is self-contained and includes all state
      // 2. sessionId is only for WebSocket connection back to Claude Desktop
      // 3. When shared, recipients don't need Claude Desktop connection - just the visualization
      // Strip any existing query parameters from BROWSER_URL to ensure clean shareable URLs
      const baseUrl = BROWSER_URL.split('?')[0].split('#')[0];
      const shareableUrl = `${baseUrl}?${compressedSessionString}`;
      
      // Shorten the URL
      let shortenedUrl;
      try {
        shortenedUrl = await shortenURL(shareableUrl);
      } catch (error) {
        logWarn('Failed to shorten URL:', error.message);
        shortenedUrl = shareableUrl; // Fallback to original URL
      }
      
      // Include connection status
      const registeredSessions = Array.from(wsClients.keys());
      const isConnected = registeredSessions.includes(sessionId);
      const connectionStatus = isConnected 
        ? `✅ WebSocket client connected and registered`
        : `⚠️  WebSocket client NOT connected (registered sessions: ${registeredSessions.length > 0 ? registeredSessions.join(', ') : 'none'})`;
      
      return {
        content: [
          {
            type: 'text',
            text: `Shareable URL for this session:\n\n${shortenedUrl}\n\n${connectionStatus}\n\nCopy and paste this URL to share the current Juicebox session.`
          }
        ]
      };
    } catch (error) {
      logError('Error creating shareable URL:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error creating shareable URL: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Register tool: get_server_status
mcpServer.registerTool(
  'get_server_status',
  {
    title: 'Get Server Status',
    description: 'Get diagnostic information about the MCP server, WebSocket connections, and session status. Use this for debugging connection issues.',
    inputSchema: {}
  },
  async () => {
    const sessionId = getCurrentSessionId();
    const registeredSessions = Array.from(wsClients.keys());
    const isConnected = sessionId && registeredSessions.includes(sessionId);
    
    // Check WebSocket connection states
    const wsConnectionStates = {};
    let totalClients = 0;
    for (const [sid, clients] of wsClients) {
      const states = [];
      for (const ws of clients) {
        states.push(ws.readyState === 0 ? 'CONNECTING' : ws.readyState === 1 ? 'OPEN' : ws.readyState === 2 ? 'CLOSING' : 'CLOSED');
        totalClients++;
      }
      wsConnectionStates[sid] = { count: clients.size, states };
    }

    const statusInfo = {
      mode: isStdioMode ? 'STDIO' : 'HTTP/SSE',
      currentSessionId: sessionId || 'none',
      stdioSessionId: STDIO_SESSION_ID || 'not set',
      webSocketServerPort: WS_PORT,
      webSocketClientsConnected: totalClients,
      registeredSessionIds: registeredSessions,
      currentSessionConnected: isConnected,
      webSocketConnectionStates: wsConnectionStates,
      browserUrl: BROWSER_URL
    };
    
    return {
      content: [
        {
          type: 'text',
          text: `Server Status:\n\n` +
            `Mode: ${statusInfo.mode}\n` +
            `Current Session ID: ${statusInfo.currentSessionId}\n` +
            `STDIO Session ID: ${statusInfo.stdioSessionId}\n` +
            `WebSocket Server Port: ${statusInfo.webSocketServerPort}\n` +
            `WebSocket Clients Connected: ${statusInfo.webSocketClientsConnected}\n` +
            `Registered Session IDs: ${statusInfo.registeredSessionIds.length > 0 ? statusInfo.registeredSessionIds.join(', ') : 'none'}\n` +
            `Current Session Connected: ${statusInfo.currentSessionConnected ? '✅ Yes' : '❌ No'}\n` +
            `Browser URL: ${statusInfo.browserUrl}\n\n` +
            (Object.keys(wsConnectionStates).length > 0 
              ? `WebSocket Connection States:\n${Object.entries(wsConnectionStates).map(([sid, state]) => `  ${sid}: ${state.readyStateName} (${state.readyState})`).join('\n')}\n`
              : 'No WebSocket connections')
        }
      ]
    };
  }
);

// Register tool: get_juicebox_url
mcpServer.registerTool(
  'get_juicebox_url',
  {
    title: 'Get Juicebox URL',
    description: 'Get the URL to open in your browser to connect the Juicebox visualization app. Use this when users ask how to connect, how to open the Juicebox app, or say things like "Hello juicebox", "Open juicebox", "Show me juicebox", "Launch juicebox", etc.',
    inputSchema: {}
  },
  async () => {
    // In STDIO mode, use the unique STDIO session ID generated at startup
    // In HTTP mode, get session ID from context
    const sessionId = getCurrentSessionId();
    
    if (!sessionId) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: No active session found. Please ensure the MCP connection is properly initialized.'
          }
        ],
        isError: true
      };
    }

    const connectionUrl = `${BROWSER_URL}?sessionId=${sessionId}`;
    
    // Include diagnostic info for debugging
    const registeredSessions = Array.from(wsClients.keys());
    const isConnected = registeredSessions.includes(sessionId);
    const connectionStatus = isConnected 
      ? `✅ WebSocket client connected and registered`
      : `⚠️  WebSocket client NOT connected`;
    
    const diagnosticInfo = isStdioMode 
      ? `\n\n[Debug Info]\nMode: STDIO\nSTDIO Session ID: ${STDIO_SESSION_ID || 'not set'}\n${connectionStatus}\nRegistered WebSocket Sessions: ${registeredSessions.length > 0 ? registeredSessions.join(', ') : 'none'}\nWebSocket Server Port: ${WS_PORT}`
      : `\n\n[Debug Info]\nMode: HTTP/SSE\nCurrent Session ID: ${sessionId}\n${connectionStatus}\nRegistered WebSocket Sessions: ${registeredSessions.length > 0 ? registeredSessions.join(', ') : 'none'}\nWebSocket Server Port: ${WS_PORT}`;
    
    return {
      content: [
        {
          type: 'text',
          text: `Open this URL ${connectionUrl}\n\nto launch the Juicebox visualization app.${diagnosticInfo}`
        }
      ]
    };
  }
);

// Register tool: juicebox_help
mcpServer.registerTool(
  'juicebox_help',
  {
    title: 'Juicebox Help Guide',
    description: 'Provides a quick-start guide with common phrases and examples for using Juicebox via natural language. Use this ONLY when users explicitly ask about Juicebox, such as "how to use Juicebox", "Juicebox help", "how do I use Juicebox", "what can I do with Juicebox", "get started with Juicebox", "Juicebox examples", "how does Juicebox work", or similar questions specifically about the Juicebox tool. Do NOT use this for general "how to" questions unrelated to Juicebox.',
    inputSchema: {}
  },
  async () => {
    const guide = `# How to Use Juicebox with Claude

Welcome! You can interact with Juicebox using natural language. Just tell me what you want to do, and I'll help you explore Hi-C contact maps and genomic data.

## Getting Started

**First, connect your browser:**
- Say: "Open Juicebox" or "Show me Juicebox" or "Get the Juicebox URL"
- I'll give you a URL to open in your browser

## Common Things You Can Ask

### Finding and Loading Data

**Search for Hi-C maps:**
- "Find human hg38 contact maps"
- "Show me K562 cell line maps"
- "Search for mouse heart tissue Hi-C data"
- "What maps are available from ENCODE?"

**Load a specific map:**
- "Load this map" (after searching)
- "Load the first result"
- "Load map number 3"

**Load from a URL:**
- "Load this Hi-C file: [URL]"
- "Load a map from [URL] with KR normalization"

### Exploring the Genome

**Navigate to specific locations:**
- "Go to chromosome 1"
- "Show me chr1:1000000-2000000"
- "Navigate to BRCA1"
- "Jump to the GATA4 gene"
- "Show me chromosome 1 from position 1000 to 2000"

**Zoom:**
- "Zoom in"
- "Zoom out"
- "Zoom in on the center"

### Visualizing Data

**Change colors:**
- "Set the foreground color to red"
- "Make the background black"
- "Use blue (#0000ff) for the map"

**Load additional tracks:**
- "Add a gene track"
- "Load this annotation file: [URL]"
- "Add this bigWig track: [URL]"

### Working with Sessions

**Save your work:**
- "Save this session"
- "Save to my Desktop"
- "Save to [file path]"

**Share your visualization:**
- "Create a shareable URL"
- "Give me a link to share this"

**Load a saved session:**
- "Load this session: [paste JSON]"
- "Load session from [URL]"
- "Load this session file" (attach a .json file)

### Advanced Workflows

**Find complementary data:**
- "What other experiments are available for this biosample?"
- "Show me ChIP-seq data for this cell line"
- "Find enhancer marks (H3K27ac) for this sample"

**Compare maps:**
- "Load a control map from [URL]"
- "Compare this map with [another map]"

**Get information:**
- "What data sources are available?"
- "Tell me about this map"
- "What are the statistics for ENCODE data?"

## Tips

- **Be natural:** Just describe what you want to do in plain language
- **I'll guide you:** If something needs clarification, I'll ask
- **Context matters:** I remember what we've been working on
- **Combine requests:** You can ask for multiple things at once

## Example Workflow

You: "I want to explore Hi-C data from heart tissue"

Me: I'll search for heart-related experiments, show you options, help you select files, configure normalization, and suggest relevant annotations and complementary data.

You: "Load the left ventricle map with SCALE normalization"

Me: I'll load it with the recommended settings and offer to add gene tracks and annotations.

## Need Help?

Just ask:
- "How do I..."
- "What can I do?"
- "Show me examples"
- "Help me get started"

I'm here to help you explore genomic data efficiently!`;

    return {
      content: [
        {
          type: 'text',
          text: guide
        }
      ]
    };
  }
);

// Register tool: list_data_sources
mcpServer.registerTool(
  'list_data_sources',
  {
    title: 'List Data Sources',
    description: 'List available Hi-C contact map data sources (4DN, ENCODE) with their metadata columns. Use this when users ask what data sources are available, what maps can be searched, or want to understand the available metadata.',
    inputSchema: {}
  },
  async () => {
    const sources = getAllSourceIds().map(sourceId => {
      const config = getDataSource(sourceId);
      return {
        id: config.id,
        name: config.name,
        description: config.description,
        columns: config.columns,
        url: config.url
      };
    });
    
    const formatted = sources.map(source => {
      return `${source.name} (${source.id}):\n` +
        `  Description: ${source.description}\n` +
        `  Data URL: ${source.url}\n` +
        `  Available columns: ${source.columns.join(', ')}`;
    }).join('\n\n');
    
    return {
      content: [
        {
          type: 'text',
          text: `Available data sources:\n\n${formatted}`
        }
      ]
    };
  }
);

// Register tool: goto_locus
mcpServer.registerTool(
  'goto_locus',
  {
    title: 'Navigate to Locus',
    description: 'Navigate to a specific genomic locus in the currently loaded map. Supports natural language, gene names, standard format, and structured objects. Examples: "chr1:1000-2000", "BRCA1", "chromosome 1 from 1000 to 2000", or {chr: "chr1", start: 1000, end: 2000}. When a single chromosome is specified, it applies to both axes of the Hi-C contact map.',
    inputSchema: {
      locus: z.union([
        z.string().describe('Locus specification as string (natural language, standard format, or gene name). Examples: "chr1:1000-2000", "BRCA1", "chromosome 1 from 1000 to 2000"'),
        z.object({
          chr: z.string().describe('Chromosome name (e.g., "chr1")'),
          start: z.number().optional().describe('Start position in base pairs (1-based)'),
          end: z.number().optional().describe('End position in base pairs (1-based)')
        }).describe('Locus specification as structured object')
      ]).describe('Locus to navigate to. Can be a string (natural language or standard format) or an object with chr, start, and end properties.')
    }
  },
  async ({ locus }) => {
    if (!locus) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Locus specification is required'
          }
        ],
        isError: true
      };
    }

    routeToCurrentSession({
      type: 'gotoLocus',
      locus: locus
    });

    // Format locus string for display
    let locusDisplay;
    if (typeof locus === 'string') {
      locusDisplay = locus;
    } else if (typeof locus === 'object' && locus.chr) {
      if (locus.start !== undefined && locus.end !== undefined) {
        locusDisplay = `${locus.chr}:${locus.start}-${locus.end}`;
      } else {
        locusDisplay = locus.chr;
      }
    } else {
      locusDisplay = JSON.stringify(locus);
    }

    return {
      content: [
        {
          type: 'text',
          text: `Navigating to locus: ${locusDisplay}`
        }
      ]
    };
  }
);

// Register tool: search_maps
mcpServer.registerTool(
  'search_maps',
  {
    title: 'Search Maps',
    description: 'Search for Hi-C contact maps using natural language queries. Searches across all metadata fields (Assembly, Biosource, Biosample, Description, etc.). Use this when users want to find specific maps, e.g., "human hg38 maps", "mouse cell lines", "K562 cells", etc. NOTE: Results are limited to 50 by default. For statistical questions like "what assemblies are covered" or "how many maps are there", use get_data_source_statistics instead.',
    inputSchema: {
      source: z.string().optional().describe("Data source ID ('4dn', 'encode') or 'all' to search all sources. Default: 'all'"),
      query: z.string().describe('Natural language search query (e.g., "human hg38", "mouse cells", "K562")'),
      limit: z.number().int().positive().optional().describe('Maximum number of results to return (default: 50)')
    }
  },
  async ({ source = 'all', query, limit = 50 }) => {
    try {
      if (!query || !query.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Search query is required'
            }
          ],
          isError: true
        };
      }
      
      const sourceIds = source === 'all' ? getAllSourceIds() : [source];
      
      // Validate source IDs
      for (const sourceId of sourceIds) {
        if (!isValidSource(sourceId)) {
          return {
            content: [
              {
                type: 'text',
                text: `Error: Unknown data source "${sourceId}". Available sources: ${getAllSourceIds().join(', ')}`
              }
            ],
            isError: true
          };
        }
      }
      
      // Fetch and parse data from all specified sources
      const allMaps = [];
      for (const sourceId of sourceIds) {
        try {
          const maps = await parseDataSource(sourceId);
          allMaps.push(...maps);
        } catch (error) {
          logError(`Error parsing data source ${sourceId}:`, error);
          // Continue with other sources even if one fails
        }
      }
      
      if (allMaps.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No data available from the specified source(s). This may be a temporary network issue.`
            }
          ],
          isError: true
        };
      }
      
      // Filter maps by query
      const filteredMaps = filterMaps(allMaps, query);
      
      // Apply limit
      const limitedMaps = filteredMaps.slice(0, limit);
      
      // Format results
      const formattedTable = formatSearchResults(limitedMaps, query, source);
      const jsonResults = formatSearchResultsJSON(limitedMaps);
      
      // Combine formatted table and JSON for Claude
      const resultText = `${formattedTable}\n\n[Structured data for programmatic access]\n${jsonResults}`;
      
      return {
        content: [
          {
            type: 'text',
            text: resultText
          }
        ]
      };
    } catch (error) {
      logError('Error in search_maps tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error searching maps: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Register tool: get_data_source_statistics
mcpServer.registerTool(
  'get_data_source_statistics',
  {
    title: 'Get Data Source Statistics',
    description: 'Get statistical overview of a data source including total maps, assemblies covered, and breakdowns by metadata fields. Use this when users ask "what assemblies are available", "how many maps are there", "what cell types are covered", etc. This returns unfiltered statistics without search limits.',
    inputSchema: {
      source: z.string().describe("Data source ID ('4dn' or 'encode')")
    }
  },
  async ({ source }) => {
    try {
      if (!isValidSource(source)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown data source "${source}". Available sources: ${getAllSourceIds().join(', ')}`
            }
          ],
          isError: true
        };
      }
      
      // Fetch all maps without filtering
      const maps = await parseDataSource(source);
      
      if (maps.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No data available from ${source} data source. This may be a temporary network issue.`
            }
          ],
          isError: true
        };
      }
      
      // Calculate statistics
      const stats = {
        totalMaps: maps.length,
        assemblies: {},
        biosources: {},
        labs: {},
        experiments: {}
      };
      
      maps.forEach(map => {
        // Count by Assembly
        const assembly = map.metadata?.Assembly || 'Unknown';
        stats.assemblies[assembly] = (stats.assemblies[assembly] || 0) + 1;
        
        // Count by Biosource/Biosample
        const biosource = map.metadata?.Biosource || map.metadata?.Biosample || 'Unknown';
        stats.biosources[biosource] = (stats.biosources[biosource] || 0) + 1;
        
        // Count by Lab
        const lab = map.metadata?.Lab || 'Unknown';
        stats.labs[lab] = (stats.labs[lab] || 0) + 1;
        
        // Count by Experiment
        const experiment = map.metadata?.Experiment || 'Unknown';
        stats.experiments[experiment] = (stats.experiments[experiment] || 0) + 1;
      });
      
      // Format output
      const config = getDataSource(source);
      let output = `${config.name} Data Source Statistics\n`;
      output += `${'='.repeat(50)}\n\n`;
      output += `Total Maps: ${stats.totalMaps}\n\n`;
      
      // Assemblies
      output += `Assemblies Covered (${Object.keys(stats.assemblies).length} total):\n`;
      const sortedAssemblies = Object.entries(stats.assemblies)
        .sort((a, b) => b[1] - a[1]); // Sort by count
      sortedAssemblies.forEach(([assembly, count]) => {
        output += `  ${assembly}: ${count} maps\n`;
      });
      output += '\n';
      
      // Top Biosources
      output += `Top Biosources/Biosamples (showing top 10):\n`;
      const sortedBiosources = Object.entries(stats.biosources)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      sortedBiosources.forEach(([biosource, count]) => {
        output += `  ${biosource}: ${count} maps\n`;
      });
      output += '\n';
      
      // Top Labs
      output += `Top Labs (showing top 10):\n`;
      const sortedLabs = Object.entries(stats.labs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      sortedLabs.forEach(([lab, count]) => {
        output += `  ${lab}: ${count} maps\n`;
      });
      
      return {
        content: [
          {
            type: 'text',
            text: output
          }
        ]
      };
    } catch (error) {
      logError('Error in get_data_source_statistics tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error getting statistics: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Register tool: get_map_details
mcpServer.registerTool(
  'get_map_details',
  {
    title: 'Get Map Details',
    description: 'Get detailed information about a specific Hi-C contact map. Use this when users want more information about a specific map from search results.',
    inputSchema: {
      source: z.string().describe("Data source ID ('4dn' or 'encode')"),
      index: z.number().int().nonnegative().optional().describe('Index from search results (0-based). Required if url is not provided.'),
      url: z.string().url().optional().describe('Direct URL to the map. Required if index is not provided.')
    }
  },
  async ({ source, index, url }) => {
    try {
      if (!isValidSource(source)) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: Unknown data source "${source}". Available sources: ${getAllSourceIds().join(', ')}`
            }
          ],
          isError: true
        };
      }
      
      if (index === undefined && !url) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Either index or url must be provided'
            }
          ],
          isError: true
        };
      }
      
      // Fetch maps from source
      const maps = await parseDataSource(source);
      
      let map = null;
      if (url) {
        // Find map by URL
        map = maps.find(m => m.url === url);
        if (!map) {
          return {
            content: [
              {
                type: 'text',
                text: `Map with URL "${url}" not found in ${source} data source.`
              }
            ],
            isError: true
          };
        }
      } else {
        // Get map by index
        if (index >= maps.length) {
          return {
            content: [
              {
                type: 'text',
                text: `Index ${index} is out of range. ${source} data source has ${maps.length} maps (indices 0-${maps.length - 1}).`
              }
            ],
            isError: true
          };
        }
        map = maps[index];
      }
      
      // Format detailed information
      const details = [
        `Source: ${map.source}`,
        `Name: ${map.name}`,
        `URL: ${map.url}`,
        '',
        'Metadata:'
      ];
      
      if (map.metadata) {
        Object.entries(map.metadata).forEach(([key, value]) => {
          details.push(`  ${key}: ${value || '(empty)'}`);
        });
      }
      
      return {
        content: [
          {
            type: 'text',
            text: details.join('\n')
          }
        ]
      };
    } catch (error) {
      logError('Error in get_map_details tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error getting map details: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Helper function to get Desktop path based on operating system
function getDesktopPath() {
  const osPlatform = platform();
  const home = homedir();
  
  switch (osPlatform) {
    case 'darwin': // macOS
      return join(home, 'Desktop');
    case 'win32': // Windows
      return join(home, 'Desktop');
    case 'linux': // Linux
      return join(home, 'Desktop');
    default:
      // Fallback to home directory if Desktop doesn't exist
      return home;
  }
}

// Helper function to request session data from browser and wait for response
async function requestSessionData(sessionId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    
    // Set up timeout
    const timeout = setTimeout(() => {
      pendingSessionRequests.delete(requestId);
      reject(new Error('Timeout waiting for session data from browser'));
    }, timeoutMs);
    
    // Store promise handlers
    pendingSessionRequests.set(requestId, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
      timeout
    });
    
    // Send getSession command to browser
    const command = {
      type: 'getSession',
      requestId: requestId
    };
    
    if (sessionId) {
      if (!sendToSession(sessionId, command)) {
        clearTimeout(timeout);
        pendingSessionRequests.delete(requestId);
        reject(new Error('No active browser connection found'));
      }
    } else {
      // Try STDIO session or broadcast
      if (isStdioMode && STDIO_SESSION_ID) {
        if (!sendToSession(STDIO_SESSION_ID, command)) {
          clearTimeout(timeout);
          pendingSessionRequests.delete(requestId);
          reject(new Error('No active browser connection found'));
        }
      } else {
        clearTimeout(timeout);
        pendingSessionRequests.delete(requestId);
        reject(new Error('No session ID available'));
      }
    }
  });
}

// Helper function to request compressed session data from browser and wait for response
async function requestCompressedSessionData(sessionId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    
    // Set up timeout
    const timeout = setTimeout(() => {
      pendingSessionRequests.delete(requestId);
      reject(new Error('Timeout waiting for compressed session data from browser'));
    }, timeoutMs);
    
    // Store promise handlers
    pendingSessionRequests.set(requestId, {
      resolve: (data) => {
        clearTimeout(timeout);
        resolve(data);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
      timeout
    });
    
    // Send getCompressedSession command to browser
    const command = {
      type: 'getCompressedSession',
      requestId: requestId
    };
    
    if (sessionId) {
      if (!sendToSession(sessionId, command)) {
        clearTimeout(timeout);
        pendingSessionRequests.delete(requestId);
        reject(new Error('No active browser connection found'));
      }
    } else {
      // Try STDIO session or broadcast
      if (isStdioMode && STDIO_SESSION_ID) {
        if (!sendToSession(STDIO_SESSION_ID, command)) {
          clearTimeout(timeout);
          pendingSessionRequests.delete(requestId);
          reject(new Error('No active browser connection found'));
        }
      } else {
        clearTimeout(timeout);
        pendingSessionRequests.delete(requestId);
        reject(new Error('No session ID available'));
      }
    }
  });
}

// Register tool: save_session
mcpServer.registerTool(
  'save_session',
  {
    title: 'Save Session',
    description: 'Save the current Juicebox session to a JSON file. The session includes all loaded maps, tracks, current view state, color scales, and other configuration. By default, saves to the Desktop with a timestamped filename.',
    inputSchema: {
      filePath: z.string().optional().describe('Optional: Full path to save the session file. If not provided, saves to Desktop with filename: juicebox-session-YYYY-MM-DD-HHMMSS.json')
    }
  },
  async ({ filePath }) => {
    try {
      
      // Get current session ID
      const sessionId = getCurrentSessionId();
      
      if (!sessionId && !isStdioMode) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: No active session found. Please ensure the browser is connected.'
            }
          ],
          isError: true
        };
      }
      
      // Check if browser is connected
      const hasConnection = sessionId 
        ? (hasOpenClient(sessionId))
        : (isStdioMode && STDIO_SESSION_ID && hasOpenClient(STDIO_SESSION_ID));
      
      if (!hasConnection) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: No active browser connection found. Please ensure the Juicebox browser is open and connected.'
            }
          ],
          isError: true
        };
      }
      
      // Request session data from browser
      logInfo('Requesting session data from browser...');
      const sessionData = await requestSessionData(sessionId || STDIO_SESSION_ID);
      
      // Determine file path
      let finalFilePath;
      if (filePath) {
        finalFilePath = filePath;
      } else {
        // Default to Desktop with timestamped filename
        const desktopPath = getDesktopPath();
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); // YYYY-MM-DDTHH-MM-SS
        finalFilePath = join(desktopPath, `juicebox-session-${timestamp}.json`);
      }
      
      // Ensure directory exists
      const dir = dirname(finalFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      
      // Write session data to file
      const jsonString = JSON.stringify(sessionData, null, 2);
      await fsPromises.writeFile(finalFilePath, jsonString, 'utf8');
      
      logInfo(`Session saved to: ${finalFilePath}`);
      
      return {
        content: [
          {
            type: 'text',
            text: `Session saved successfully to:\n${finalFilePath}\n\nThe session file includes all loaded maps, tracks, current view state, color scales, and configuration.`
          }
        ]
      };
    } catch (error) {
      logError('Error saving session:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error saving session: ${error.message}`
          }
        ],
        isError: true
      };
    }
  }
);

// Set up Express HTTP server for MCP transport
const app = express();
app.use(express.json());

// Enable CORS for ChatGPT and other clients
app.use(
  cors({
    origin: '*', // Allow all origins (restrict in production)
    exposedHeaders: ['Mcp-Session-Id'],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
  })
);

// STDIO mode detection moved earlier (before WebSocket server creation)

// Map to store transports by session ID (for HTTP mode)
const transports = {};

// For STDIO mode, generate a unique session ID for each process instance
let STDIO_SESSION_ID = null;

// Helper function to get the current session ID (works in both STDIO and HTTP modes)
function getCurrentSessionId() {
  if (isStdioMode) {
    return STDIO_SESSION_ID;
  } else {
    return sessionContext.getStore();
  }
}

// If running in STDIO mode (subprocess), set up STDIO transport
if (isStdioMode) {
  // Generate a unique session ID for this STDIO connection
  STDIO_SESSION_ID = randomUUID();
  
  logError('Running in STDIO mode (subprocess)');
  const stdioTransport = new StdioServerTransport();
  
  // Connect MCP server to STDIO transport
  mcpServer.connect(stdioTransport).catch((error) => {
    logError('Error connecting MCP server to STDIO transport:', error);
    process.exit(1);
  });
  
  logError('MCP server connected via STDIO transport');
  logError(`Browser URL configured: ${BROWSER_URL}`);
  logError(`STDIO session ID: ${STDIO_SESSION_ID}`);
  logInfo(`Diagnostic log file: ${LOG_FILE}`);
} else {
  logError('Running in HTTP/SSE mode');
  logError(`MCP Server endpoint: http://localhost:${MCP_PORT}/mcp`);
  logError(`For MCP Inspector:`);
  logError(`  - Transport type: "streamable HTTP" (not "SSE")`);
  logError(`  - Connection type: "direct"`);
  logError(`  - Connection URL: http://localhost:${MCP_PORT}/mcp`);
  logError(``);
  logError(`Note: Server defaults to STDIO mode for Claude Desktop compatibility.`);
  logError(`      Use --http flag or MCP_TRANSPORT=http to enable HTTP mode for testing.`);
  logInfo(`Diagnostic log file: ${LOG_FILE}`);
}

// Handle POST requests (initialization and tool calls) - only in HTTP mode
if (!isStdioMode) {
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  // Log request for debugging
  logInfo(`MCP request: ${req.body?.method || 'unknown'} (session: ${sessionId || 'none'})`);
  
  try {
    let transport;
    
    if (sessionId && transports[sessionId]) {
      // Reuse existing transport for subsequent requests
      transport = transports[sessionId];
    } else if (sessionId && !transports[sessionId]) {
      // Session ID provided but transport doesn't exist - session expired or lost
      // Allow re-initialization if this is an initialize request
      if (isInitializeRequest(req.body)) {
        logInfo(`Session ${sessionId} not found, creating new transport for re-initialization`);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId, // Reuse the same session ID
          onsessioninitialized: (sid) => {
            logInfo(`MCP session re-initialized: ${sid}`);
            transports[sid] = transport;
          }
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logInfo(`MCP session closed: ${sid}`);
            delete transports[sid];
          }
        };

        await mcpServer.connect(transport);
      } else {
        // Session ID exists but transport is missing and not an init request
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found'
          },
          id: req.body?.id || null
        });
        return;
      }
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // Create new transport for initialization
      logInfo('Creating new transport for initialization');
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          logInfo(`MCP session initialized: ${sid}`);
          transports[sid] = transport;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && transports[sid]) {
          logInfo(`MCP session closed: ${sid}`);
          delete transports[sid];
        }
      };

      // Connect transport to MCP server
      await mcpServer.connect(transport);
    } else {
      // Invalid request - no session ID or not initialization request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided or invalid initialization request'
        },
        id: req.body?.id || null
      });
      return;
    }

    // Use AsyncLocalStorage to maintain session context across async operations
    try {
      await sessionContext.run(sessionId || null, async () => {
        // Detect tool calls and notify WebSocket clients
        if (req.body?.method === 'tools/call' && req.body?.params?.name && sessionId) {
          sendToSession(sessionId, {
            type: 'toolCall',
            toolName: req.body.params.name,
            timestamp: Date.now()
          });
        }

        // Handle the POST request - tool handlers will be called during this
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      logError('Error handling MCP POST request:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  } catch (error) {
    logError('Error in MCP POST handler (transport setup):', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error'
        },
        id: null
      });
    }
  }
});
}

// Handle GET requests for SSE streams - only in HTTP mode
if (!isStdioMode) {
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  try {
    const transport = transports[sessionId];
    const lastEventId = req.headers['last-event-id'];
    
    logInfo(`SSE stream ${lastEventId ? 'reconnecting' : 'establishing'} for session ${sessionId}`);
    
    await transport.handleRequest(req, res);
  } catch (error) {
    logError('Error handling MCP GET request:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing SSE stream');
    }
  }
});
}

// Handle DELETE requests for session termination - only in HTTP mode
if (!isStdioMode) {
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  try {
    logInfo(`Session termination request for session ${sessionId}`);
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  } catch (error) {
    logError('Error handling session termination:', error);
    if (!res.headersSent) {
      res.status(500).send('Error processing session termination');
    }
  }
});
}

// Serve static files from dist folder (for unified deployment) - only in HTTP mode
if (!isStdioMode) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const distPath = join(__dirname, 'dist');

  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    // Serve index.html for all non-API routes (SPA routing)
    app.use((req, res, next) => {
      // Skip if this is an MCP route
      if (req.path.startsWith('/mcp')) {
        return next();
      }
      // Only handle GET requests for SPA routing
      if (req.method === 'GET') {
        res.sendFile(join(distPath, 'index.html'));
      } else {
        next();
      }
    });
  }

  // Start HTTP server
  app.listen(MCP_PORT, () => {
    // Use logError for startup messages to avoid interfering with MCP protocol on stdout
    logError(`MCP Server listening on http://localhost:${MCP_PORT}/mcp`);
    logError(`Browser URL configured: ${BROWSER_URL}`);
    logInfo(`Diagnostic log file: ${LOG_FILE}`);
    if (existsSync(distPath)) {
      logError(`Serving static files from ${distPath}`);
    }
  });
}

// Handle server shutdown
process.on('SIGINT', async () => {
  logWarn('Shutting down servers...');
  
  // Close all WebSocket connections
  wss.close();
  
  // Close all MCP transports
  for (const sessionId in transports) {
    try {
      await transports[sessionId].close();
    } catch (error) {
      logError(`Error closing transport for session ${sessionId}:`, error);
    }
  }
  
  await mcpServer.close();
  process.exit(0);
});

