/**
 * MCP Tool Handlers for Cloudflare Workers deployment.
 * Ported from server.js — same tool definitions, adapted for Workers runtime.
 *
 * Dependencies are injected via the `deps` object to decouple from
 * the Node.js-specific routing (WebSocket via `ws`, filesystem, etc.)
 */

import { z } from 'zod';
import { generateQRPng } from '../../src/qrPng.js';
import { DATA_SOURCES, getDataSource, getAllSourceIds, isValidSource } from '../../src/dataSourceConfigs.js';
import { parseDataSource } from '../../src/dataParsers.js';
import { filterMaps } from '../../src/mapFilter.js';
import { formatSearchResults, formatSearchResultsJSON } from '../../src/resultFormatter.js';

// Helper function to convert hex color to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Zod schema for color input
const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color code (e.g., "#ff0000")')
  .describe('Hex color code (e.g., "#ff0000")');

/**
 * Register all MCP tools on the given server instance.
 *
 * @param {McpServer} mcpServer
 * @param {object} deps
 * @param {function} deps.sendCommand - (command) => void, sends command to browser via DO
 * @param {function} deps.requestSessionData - () => Promise<object>, gets session JSON from browser
 * @param {function} deps.requestCompressedSessionData - () => Promise<string>, gets compressed session
 * @param {function} deps.isBrowserConnected - () => Promise<boolean>
 * @param {string} deps.sessionId - current MCP session ID
 * @param {string} deps.browserUrl - configured frontend URL
 * @param {function} deps.shortenURL - (url) => Promise<string>
 * @param {object} deps.log - { logInfo, logWarn, logError }
 */
export function registerTools(mcpServer, deps) {
  const {
    sendCommand,
    requestSessionData,
    requestCompressedSessionData,
    isBrowserConnected,
    sessionId,
    browserUrl,
    shortenURL,
    log
  } = deps;

  // Register MCP resources for data source configurations
  mcpServer.setResourceRequestHandlers({
    list: async () => ({
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
    }),
    read: async (request) => {
      const { uri } = request.params;
      if (uri === 'juicebox://datasource/4dn') {
        const config = getDataSource('4dn');
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(config, null, 2) }] };
      } else if (uri === 'juicebox://datasource/encode') {
        const config = getDataSource('encode');
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(config, null, 2) }] };
      }
      throw new Error(`Unknown resource URI: ${uri}`);
    }
  });

  // --- Tool: load_map ---
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
      await sendCommand({ type: 'loadMap', url, name, normalization, locus });
      return { content: [{ type: 'text', text: `Loading map from ${url}${name ? ` (${name})` : ''}` }] };
    }
  );

  // --- Tool: load_control_map ---
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
      await sendCommand({ type: 'loadControlMap', url, name, normalization });
      return { content: [{ type: 'text', text: `Loading control map from ${url}${name ? ` (${name})` : ''}` }] };
    }
  );

  // --- Tool: load_session ---
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
      let parsedSession;
      try {
        if (fileContent) {
          parsedSession = JSON.parse(fileContent);
        } else if (sessionData) {
          parsedSession = JSON.parse(sessionData);
        } else if (sessionUrl) {
          let normalizedUrl = sessionUrl;
          if (sessionUrl.includes('dropbox.com') && sessionUrl.includes('dl=0')) {
            normalizedUrl = sessionUrl.replace('dl=0', 'dl=1');
            log.logInfo(`Normalized Dropbox URL: ${normalizedUrl}`);
          }
          log.logInfo(`Fetching session from URL: ${normalizedUrl}`);
          const response = await fetch(normalizedUrl);
          if (!response.ok) {
            throw new Error(`Failed to fetch session from URL: ${response.status} ${response.statusText}`);
          }
          const responseText = await response.text();
          if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
            throw new Error('Received HTML instead of JSON. The URL may be a preview link. For Dropbox links, ensure dl=1 parameter is set, or use a direct download link.');
          }
          try {
            parsedSession = JSON.parse(responseText);
          } catch (parseError) {
            log.logError(`Failed to parse JSON from URL. Response preview: ${responseText.substring(0, 200)}...`);
            throw new Error(`Invalid JSON received from URL: ${parseError.message}. The URL may not point to a valid JSON file.`);
          }
        } else {
          throw new Error('No session data provided. Provide sessionData (for pasted JSON), sessionUrl (for remote URLs like Dropbox/AWS), or attach a file.');
        }

        if (!parsedSession.browsers && !parsedSession.url) {
          throw new Error('Invalid session format: must contain "browsers" array or browser config');
        }

        await sendCommand({ type: 'loadSession', sessionData: parsedSession });
        const browserCount = parsedSession.browsers ? parsedSession.browsers.length : 1;
        return { content: [{ type: 'text', text: `Session loaded successfully. Restored ${browserCount} browser(s).` }] };
      } catch (error) {
        log.logError(`Error loading session: ${error.message}`);
        return { content: [{ type: 'text', text: `Error loading session: ${error.message}` }], isError: true };
      }
    }
  );

  // --- Tool: zoom_in ---
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
      await sendCommand({ type: 'zoomIn', centerX, centerY });
      return { content: [{ type: 'text', text: 'Zooming in' }] };
    }
  );

  // --- Tool: zoom_out ---
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
      await sendCommand({ type: 'zoomOut', centerX, centerY });
      return { content: [{ type: 'text', text: 'Zooming out' }] };
    }
  );

  // --- Tool: set_map_foreground_color ---
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
        return { content: [{ type: 'text', text: `Invalid color: ${color}. Please use a hex code (e.g., "#ff0000")` }], isError: true };
      }
      await sendCommand({ type: 'setForegroundColor', color: rgb, threshold });
      return { content: [{ type: 'text', text: `Map foreground color set to ${color}${threshold ? ` with threshold ${threshold}` : ''}` }] };
    }
  );

  // --- Tool: set_map_background_color ---
  mcpServer.registerTool(
    'set_map_background_color',
    {
      title: 'Set Map Background Color',
      description: 'Set the background color of the contact map',
      inputSchema: { color: colorSchema }
    },
    async ({ color }) => {
      const rgb = hexToRgb(color);
      if (!rgb) {
        return { content: [{ type: 'text', text: `Invalid color: ${color}. Please use a hex code (e.g., "#000000")` }], isError: true };
      }
      await sendCommand({ type: 'setBackgroundColor', color: rgb });
      return { content: [{ type: 'text', text: `Map background color set to ${color}` }] };
    }
  );

  // Well-known track presets (resolved by keyword)
  const TRACK_PRESETS = {
    genes: {
      url: 'https://hgdownload.soe.ucsc.edu/goldenPath/hg38/database/ncbiRefSeqSelect.txt.gz',
      name: 'Refseq Select',
      color: { r: 0, g: 0, b: 0 },
      type: 'annotation',
      format: 'refgene'
    }
  };

  // --- Tool: load_track ---
  mcpServer.registerTool(
    'load_track',
    {
      title: 'Load Track',
      description: 'Load a 1D or 2D track into Juicebox from a URL. Supports bigWig, bigBed, bedGraph, bed, bedpe, interact, annotation, and other standard genomic track formats. The format is auto-detected from the file extension. When the user asks for a "genes" track, use the keyword "genes" as the url — it will automatically load the NCBI RefSeq Select gene track.',
      inputSchema: {
        url: z.string().describe('URL to the track file (e.g., bigWig, bigBed, bed, bedpe), or the keyword "genes" for the built-in gene track'),
        name: z.string().optional().describe('Optional display name for the track'),
        color: colorSchema.optional().describe('Optional track color as hex code (e.g., "#ff0000")')
      }
    },
    async ({ url, name, color }) => {
      const preset = TRACK_PRESETS[url.toLowerCase()];
      const resolvedUrl = preset ? preset.url : url;
      const resolvedName = name || (preset ? preset.name : undefined);
      const resolvedColor = color ? hexToRgb(color) : (preset ? preset.color : undefined);

      const command = { type: 'loadTrack', url: resolvedUrl, name: resolvedName };
      if (resolvedColor) command.color = resolvedColor;
      if (preset?.type) command.trackType = preset.type;
      if (preset?.format) command.format = preset.format;
      await sendCommand(command);
      return { content: [{ type: 'text', text: `Loading track${resolvedName ? ` "${resolvedName}"` : ''} from ${resolvedUrl}` }] };
    }
  );

  // --- Tool: select_normalization ---
  mcpServer.registerTool(
    'select_normalization',
    {
      title: 'Select Normalization',
      description: 'Change the normalization method for the currently loaded Hi-C contact map. This changes the normalization in-place without reloading the map. Available normalizations: NONE (raw counts), VC (Coverage), VC_SQRT (Coverage-Sqrt), KR (Balanced / Knight-Ruiz matrix balancing), SCALE, INTER_SCALE, GW_SCALE. The user may refer to normalizations by either their internal name or their visual/spoken name.',
      inputSchema: {
        normalization: z.string()
          .describe('Normalization method. Common values: NONE (raw counts), VC (Coverage), VC_SQRT (Coverage-Sqrt), KR (Balanced / Knight-Ruiz), SCALE, INTER_SCALE, GW_SCALE. The available normalizations depend on the loaded map.')
      }
    },
    async ({ normalization }) => {
      await sendCommand({ type: 'setNormalization', normalization });
      const normNames = {
        NONE: 'None',
        VC: 'Coverage (VC)',
        VC_SQRT: 'Coverage-Sqrt (VC_SQRT)',
        KR: 'Balanced / Knight-Ruiz (KR)',
        SCALE: 'SCALE',
        INTER_SCALE: 'INTER_SCALE',
        GW_SCALE: 'GW_SCALE'
      };
      return { content: [{ type: 'text', text: `Normalization set to ${normNames[normalization] || normalization}` }] };
    }
  );

  // --- Tool: create_shareable_url ---
  mcpServer.registerTool(
    'create_shareable_url',
    {
      title: 'Create Shareable URL',
      description: 'Create a shareable URL for the current Juicebox session',
      inputSchema: {}
    },
    async () => {
      if (!sessionId) {
        return { content: [{ type: 'text', text: 'Error: No active session found.' }], isError: true };
      }

      const connected = await isBrowserConnected();
      if (!connected) {
        return { content: [{ type: 'text', text: 'Error: No active browser connection found. Please ensure the Juicebox browser is open and connected.' }], isError: true };
      }

      try {
        log.logInfo('Requesting compressed session data from browser...');
        const compressedSessionString = await requestCompressedSessionData();
        const baseUrl = browserUrl.split('?')[0].split('#')[0];
        const shareableUrl = `${baseUrl}?${compressedSessionString}`;

        let shortenedUrl;
        try {
          shortenedUrl = await shortenURL(shareableUrl);
        } catch (error) {
          log.logWarn('Failed to shorten URL:', error.message);
          shortenedUrl = shareableUrl;
        }

        return {
          content: [{
            type: 'text',
            text: `Shareable URL for this session:\n\n${shortenedUrl}\n\nCopy and paste this URL to share the current Juicebox session.`
          }]
        };
      } catch (error) {
        log.logError('Error creating shareable URL:', error);
        return { content: [{ type: 'text', text: `Error creating shareable URL: ${error.message}` }], isError: true };
      }
    }
  );

  // --- Tool: get_server_status ---
  mcpServer.registerTool(
    'get_server_status',
    {
      title: 'Get Server Status',
      description: 'Get diagnostic information about the MCP server, WebSocket connections, and session status. Use this for debugging connection issues.',
      inputSchema: {}
    },
    async () => {
      const connected = await isBrowserConnected();
      return {
        content: [{
          type: 'text',
          text: `Server Status:\n\n` +
            `Mode: Cloudflare Workers\n` +
            `Current Session ID: ${sessionId || 'none'}\n` +
            `Browser Connected: ${connected ? 'Yes' : 'No'}\n` +
            `Browser URL: ${browserUrl}`
        }]
      };
    }
  );

  // --- Tool: get_juicebox_url ---
  mcpServer.registerTool(
    'get_juicebox_url',
    {
      title: 'Get Juicebox URL',
      description: 'Get the URL to open in your browser to connect the Juicebox visualization app. Use this when users ask how to connect, how to open the Juicebox app, or say things like "Hello juicebox", "Open juicebox", "Show me juicebox", "Launch juicebox", etc. This tool returns a QR code as an image content block. Always display the QR code image to the user so they can scan it to open the session on another device.',
      inputSchema: {}
    },
    async () => {
      if (!sessionId) {
        return { content: [{ type: 'text', text: 'Error: No active session found. Please ensure the MCP connection is properly initialized.' }], isError: true };
      }
      const connectionUrl = `${browserUrl}?sessionId=${sessionId}`;

      const content = [
        {
          type: 'text',
          text: `Open this URL to launch Juicebox:\n\n\`\`\`\n${connectionUrl}\n\`\`\``
        }
      ];

      try {
        const qrBase64 = generateQRPng(connectionUrl);
        content.push({
          type: 'image',
          data: qrBase64,
          mimeType: 'image/png'
        });
      } catch (e) {
        // QR generation is best-effort
      }

      return { content };
    }
  );

  // --- Tool: juicebox_help ---
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

**Zoom:**
- "Zoom in"
- "Zoom out"

### Visualizing Data

**Change colors:**
- "Set the foreground color to red"
- "Make the background black"
- "Use blue (#0000ff) for the map"

**Change normalization (does NOT reload the map):**
- "Switch to KR normalization" or "Use Balanced normalization"
- "Set normalization to Coverage" or "Use VC normalization"
- "Remove normalization" or "Set normalization to None"
- Available: None, Coverage (VC), Coverage-Sqrt (VC_SQRT), Balanced/Knight-Ruiz (KR), SCALE, INTER_SCALE, GW_SCALE

### Working with Sessions

**Save your work:**
- "Save this session"

**Share your visualization:**
- "Create a shareable URL"
- "Give me a link to share this"

**Load a saved session:**
- "Load this session: [paste JSON]"
- "Load session from [URL]"

### Advanced Workflows

**Compare maps:**
- "Load a control map from [URL]"

**Get information:**
- "What data sources are available?"
- "Tell me about this map"

## Tips

- **Be natural:** Just describe what you want to do in plain language
- **I'll guide you:** If something needs clarification, I'll ask
- **Context matters:** I remember what we've been working on

## Need Help?

Just ask:
- "How do I..."
- "What can I do?"
- "Show me examples"`;

      return { content: [{ type: 'text', text: guide }] };
    }
  );

  // --- Tool: list_data_sources ---
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
        return { id: config.id, name: config.name, description: config.description, columns: config.columns, url: config.url };
      });
      const formatted = sources.map(source =>
        `${source.name} (${source.id}):\n  Description: ${source.description}\n  Data URL: ${source.url}\n  Available columns: ${source.columns.join(', ')}`
      ).join('\n\n');
      return { content: [{ type: 'text', text: `Available data sources:\n\n${formatted}` }] };
    }
  );

  // --- Tool: goto_locus ---
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
        ]).describe('Locus to navigate to.')
      }
    },
    async ({ locus }) => {
      if (!locus) {
        return { content: [{ type: 'text', text: 'Error: Locus specification is required' }], isError: true };
      }
      await sendCommand({ type: 'gotoLocus', locus });
      let locusDisplay;
      if (typeof locus === 'string') {
        locusDisplay = locus;
      } else if (typeof locus === 'object' && locus.chr) {
        locusDisplay = locus.start !== undefined && locus.end !== undefined
          ? `${locus.chr}:${locus.start}-${locus.end}`
          : locus.chr;
      } else {
        locusDisplay = JSON.stringify(locus);
      }
      return { content: [{ type: 'text', text: `Navigating to locus: ${locusDisplay}` }] };
    }
  );

  // --- Tool: search_maps ---
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
          return { content: [{ type: 'text', text: 'Error: Search query is required' }], isError: true };
        }
        const sourceIds = source === 'all' ? getAllSourceIds() : [source];
        for (const sourceId of sourceIds) {
          if (!isValidSource(sourceId)) {
            return { content: [{ type: 'text', text: `Error: Unknown data source "${sourceId}". Available sources: ${getAllSourceIds().join(', ')}` }], isError: true };
          }
        }

        const allMaps = [];
        for (const sourceId of sourceIds) {
          try {
            const maps = await parseDataSource(sourceId);
            allMaps.push(...maps);
          } catch (error) {
            log.logError(`Error parsing data source ${sourceId}:`, error);
          }
        }

        if (allMaps.length === 0) {
          return { content: [{ type: 'text', text: 'No data available from the specified source(s). This may be a temporary network issue.' }], isError: true };
        }

        const filteredMaps = filterMaps(allMaps, query);
        const limitedMaps = filteredMaps.slice(0, limit);
        const formattedTable = formatSearchResults(limitedMaps, query, source);
        const jsonResults = formatSearchResultsJSON(limitedMaps);
        const resultText = `${formattedTable}\n\n[Structured data for programmatic access]\n${jsonResults}`;
        return { content: [{ type: 'text', text: resultText }] };
      } catch (error) {
        log.logError('Error in search_maps tool:', error);
        return { content: [{ type: 'text', text: `Error searching maps: ${error.message}` }], isError: true };
      }
    }
  );

  // --- Tool: get_data_source_statistics ---
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
          return { content: [{ type: 'text', text: `Error: Unknown data source "${source}". Available sources: ${getAllSourceIds().join(', ')}` }], isError: true };
        }
        const maps = await parseDataSource(source);
        if (maps.length === 0) {
          return { content: [{ type: 'text', text: `No data available from ${source} data source. This may be a temporary network issue.` }], isError: true };
        }

        const stats = { totalMaps: maps.length, assemblies: {}, biosources: {}, labs: {}, experiments: {} };
        maps.forEach(map => {
          const assembly = map.metadata?.Assembly || 'Unknown';
          stats.assemblies[assembly] = (stats.assemblies[assembly] || 0) + 1;
          const biosource = map.metadata?.Biosource || map.metadata?.Biosample || 'Unknown';
          stats.biosources[biosource] = (stats.biosources[biosource] || 0) + 1;
          const lab = map.metadata?.Lab || 'Unknown';
          stats.labs[lab] = (stats.labs[lab] || 0) + 1;
          const experiment = map.metadata?.Experiment || 'Unknown';
          stats.experiments[experiment] = (stats.experiments[experiment] || 0) + 1;
        });

        const config = getDataSource(source);
        let output = `${config.name} Data Source Statistics\n${'='.repeat(50)}\n\nTotal Maps: ${stats.totalMaps}\n\n`;
        output += `Assemblies Covered (${Object.keys(stats.assemblies).length} total):\n`;
        Object.entries(stats.assemblies).sort((a, b) => b[1] - a[1]).forEach(([assembly, count]) => {
          output += `  ${assembly}: ${count} maps\n`;
        });
        output += '\n';
        output += `Top Biosources/Biosamples (showing top 10):\n`;
        Object.entries(stats.biosources).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([biosource, count]) => {
          output += `  ${biosource}: ${count} maps\n`;
        });
        output += '\n';
        output += `Top Labs (showing top 10):\n`;
        Object.entries(stats.labs).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([lab, count]) => {
          output += `  ${lab}: ${count} maps\n`;
        });
        return { content: [{ type: 'text', text: output }] };
      } catch (error) {
        log.logError('Error in get_data_source_statistics tool:', error);
        return { content: [{ type: 'text', text: `Error getting statistics: ${error.message}` }], isError: true };
      }
    }
  );

  // --- Tool: get_map_details ---
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
          return { content: [{ type: 'text', text: `Error: Unknown data source "${source}". Available sources: ${getAllSourceIds().join(', ')}` }], isError: true };
        }
        if (index === undefined && !url) {
          return { content: [{ type: 'text', text: 'Error: Either index or url must be provided' }], isError: true };
        }

        const maps = await parseDataSource(source);
        let map = null;
        if (url) {
          map = maps.find(m => m.url === url);
          if (!map) {
            return { content: [{ type: 'text', text: `Map with URL "${url}" not found in ${source} data source.` }], isError: true };
          }
        } else {
          if (index >= maps.length) {
            return { content: [{ type: 'text', text: `Index ${index} is out of range. ${source} data source has ${maps.length} maps (indices 0-${maps.length - 1}).` }], isError: true };
          }
          map = maps[index];
        }

        const details = [`Source: ${map.source}`, `Name: ${map.name}`, `URL: ${map.url}`, '', 'Metadata:'];
        if (map.metadata) {
          Object.entries(map.metadata).forEach(([key, value]) => {
            details.push(`  ${key}: ${value || '(empty)'}`);
          });
        }
        return { content: [{ type: 'text', text: details.join('\n') }] };
      } catch (error) {
        log.logError('Error in get_map_details tool:', error);
        return { content: [{ type: 'text', text: `Error getting map details: ${error.message}` }], isError: true };
      }
    }
  );

  // --- Tool: save_session ---
  mcpServer.registerTool(
    'save_session',
    {
      title: 'Save Session',
      description: 'Save the current Juicebox session. On Cloudflare Workers, returns the session JSON as text (no filesystem available). On local server, saves to a file.',
      inputSchema: {
        filePath: z.string().optional().describe('Optional: Ignored on Cloudflare Workers deployment. On local server, full path to save the session file.')
      }
    },
    async ({ filePath }) => {
      try {
        if (!sessionId) {
          return { content: [{ type: 'text', text: 'Error: No active session found. Please ensure the browser is connected.' }], isError: true };
        }

        const connected = await isBrowserConnected();
        if (!connected) {
          return { content: [{ type: 'text', text: 'Error: No active browser connection found. Please ensure the Juicebox browser is open and connected.' }], isError: true };
        }

        log.logInfo('Requesting session data from browser...');
        const sessionDataResult = await requestSessionData();
        const jsonString = JSON.stringify(sessionDataResult, null, 2);

        return {
          content: [{
            type: 'text',
            text: `Session data retrieved successfully.\n\nYou can copy the JSON below to save it locally:\n\n\`\`\`json\n${jsonString}\n\`\`\``
          }]
        };
      } catch (error) {
        log.logError('Error saving session:', error);
        return { content: [{ type: 'text', text: `Error saving session: ${error.message}` }], isError: true };
      }
    }
  );
}
