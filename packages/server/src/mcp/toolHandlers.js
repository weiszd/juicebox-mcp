/**
 * MCP Tool Handlers for Cloudflare Workers deployment.
 * Ported from server.js — same tool definitions, adapted for Workers runtime.
 *
 * Dependencies are injected via the `deps` object to decouple from
 * the Node.js-specific routing (WebSocket via `ws`, filesystem, etc.)
 */

import { z } from 'zod';
import { DATA_SOURCES, getDataSource, getAllSourceIds, isValidSource } from '../search/dataSourceConfigs.js';
import { parseDataSource } from '../search/dataParsers.js';
import { filterMaps } from '../search/mapFilter.js';
import { formatSearchResults, formatSearchResultsJSON } from '../search/resultFormatter.js';
import { generateQRPng } from '../qrPng.js';
import { hicExperiments, formatHicExperiments, encodeSearch, formatEncodeSearch, HIC_ASSAYS, CLASSIFICATIONS } from '../search/encodePortal.js';
import { VIEW_URI, VIEW_HTML, VIEW_META, VIEW_MIME_TYPE, TOOL_META } from './juiceboxView.js';

// Helper function to convert hex color to RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

// Room ids: 10 Crockford base32 characters (design §5.4)
const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/i;

// Zod schema for color input
const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a hex color code (e.g., "#ff0000")')
  .describe('Hex color code (e.g., "#ff0000")');
const panelSchema = z.union([z.number().int().positive(), z.string()]).optional()
  .describe('panel: position from the left (1, 2, ...), a map name, or "all"; required when more than one panel is open');
const onePanelSchema = z.union([z.number().int().positive(), z.string()]).optional()
  .describe('panel: position from the left (1, 2, ...) or a map name, no "all"; required when more than one panel is open');

/**
 * Register all MCP tools on the given server instance.
 *
 * @param {McpServer} mcpServer
 * @param {object} deps
 * @param {function} deps.sendCommand - (tool, command) => Promise<{status, ok?, result?, error?}>, names `tool` then sends `command` to every page in the room
 * @param {function} deps.getRoom - () => Promise<string|null>, the room bound to this MCP session
 * @param {function} deps.bindRoom - (room) => Promise<void>, rebinds this MCP session to a room
 * @param {function} deps.sendRequest - (command) => Promise<{status, ok?, result?, error?}>, asks the first live page only
 * @param {function} deps.isBrowserConnected - () => Promise<boolean>
 * @param {string} deps.sessionId - current MCP session ID
 * @param {string} deps.browserUrl - configured frontend URL
 * @param {function} deps.shortenURL - (url) => Promise<string>
 * @param {object} deps.log - { logInfo, logWarn, logError }
 */
export function registerTools(mcpServer, deps) {
  const {
    sendCommand,
    sendRequest,
    isBrowserConnected,
    getRoom,
    bindRoom,
    sessionId,
    browserUrl,
    shortenURL,
    log
  } = deps;

  const NO_PAGE = 'No page is connected to this room. Use get_juicebox_url to get the join link and open it in a browser.';

  /**
   * Send a command to the bound room and report what the first page's ack said:
   * `text` on ok, the page's error on not ok, "sent, unconfirmed" on no ack in 10 s,
   * and an error when no page is connected (design §5.4). The room names `tool` to
   * every page first (`toolCall`, §5.2).
   */
  async function runCommand(tool, command, text) {
    const outcome = await sendCommand(tool, command);
    if (outcome.status === 'no-page') {
      return { content: [{ type: 'text', text: `Error: ${NO_PAGE}` }], isError: true };
    }
    if (outcome.status === 'unconfirmed') {
      return { content: [{ type: 'text', text: `${text} (sent, unconfirmed: no page acknowledged within 10 s)` }] };
    }
    if (!outcome.ok) {
      return { content: [{ type: 'text', text: `Error: ${outcome.error || `the page could not apply ${command.type}`}` }], isError: true };
    }
    // A command's ack carries one line per panel it acted on (ADR-0007).
    return { content: [{ type: 'text', text: typeof outcome.result === 'string' ? `${text}\n${outcome.result}` : text }] };
  }

  /**
   * Ask the first live page in the bound room for data (design §6) and resolve
   * {result} from its ack, or {error} with the tool result to return instead.
   */
  async function runRequest(type, payload = {}) {
    const outcome = await sendRequest({ type, ...payload });
    const fail = (text) => ({ error: { content: [{ type: 'text', text: `Error: ${text}` }], isError: true } });
    if (outcome.status === 'no-page') return fail(NO_PAGE);
    if (outcome.status === 'unconfirmed') return fail('the page did not answer within 10 s.');
    if (outcome.status === 'closed') return fail('the page disconnected before answering.');
    if (!outcome.ok) return fail(outcome.error || `the page could not answer ${type}`);
    return { result: outcome.result };
  }

  // MCP resources: the data source configurations and the MCP App view.
  // (The prototype called the SDK's internal setResourceRequestHandlers() with
  // arguments it ignores, so these were never served; registerResource is the API.)
  for (const [key, name] of [['4dn', '4DN'], ['encode', 'ENCODE']]) {
    mcpServer.registerResource(
      `${name} Contact Map Data Source`,
      `juicebox://datasource/${key}`,
      { description: `${name} Hi-C contact map data source configuration`, mimeType: 'application/json' },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(getDataSource(key), null, 2) }] })
    );
  }
  mcpServer.registerResource(
    'Juicebox join card',
    VIEW_URI,
    { description: 'MCP App view for get_juicebox_url: the join link and its QR code', mimeType: VIEW_MIME_TYPE },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: VIEW_MIME_TYPE, text: VIEW_HTML, _meta: VIEW_META }] })
  );
  // --- Tool: load_map ---
  mcpServer.registerTool(
    'load_map',
    {
      title: 'Load Map',
      description: 'Load a Hi-C contact map (.hic file) into Juicebox. With panel "new" the map opens in an additional panel beside the current one (side by side); otherwise it replaces the map in the panel named by `panel`, which is required when more than one panel is open.',
      inputSchema: {
        url: z.string().url().describe('URL to the .hic file'),
        name: z.string().optional().describe('Optional name for the map'),
        normalization: z.string().optional().describe('Normalization method (e.g., "VC", "VC_SQRT", "KR", "NONE")'),
        locus: z.string().optional().describe('Optional genomic locus (e.g., "1:1000000-2000000 1:1000000-2000000")'),
        panel: z.union([z.number().int().positive(), z.string()]).optional().describe('panel: "new" opens another panel beside the others and loads there (side-by-side comparisons); a position from the left (1, 2, ...) or a map name replaces that panel\'s map, no "all"; required when more than one panel is open')
      }
    },
    async ({ url, name, normalization, locus, panel }) => {
      return runCommand('load_map', { type: 'loadMap', url, name, normalization, locus, panel }, `Loading map from ${url}${name ? ` (${name})` : ''}${panel === 'new' ? ' in a new panel' : ''}`);
    }
  );

  // --- Tool: close_panel ---
  mcpServer.registerTool(
    'close_panel',
    {
      title: 'Close Panel',
      description: 'Close one panel (contact-map viewer) of the page; the panels to its right move one position left. The last panel cannot be closed.',
      inputSchema: { panel: onePanelSchema }
    },
    async ({ panel }) => {
      return runCommand('close_panel', { type: 'closePanel', panel }, 'Closing panel');
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
        normalization: z.string().optional().describe('Normalization method (e.g., "VC", "VC_SQRT", "KR", "NONE")'),
        panel: onePanelSchema
      }
    },
    async ({ url, name, normalization, panel }) => {
      return runCommand('load_control_map', { type: 'loadControlMap', url, name, normalization, panel }, `Loading control map from ${url}${name ? ` (${name})` : ''}`);
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

        const browserCount = parsedSession.browsers ? parsedSession.browsers.length : 1;
        return await runCommand('load_session', { type: 'loadSession', sessionData: parsedSession }, `Session loaded successfully. Restored ${browserCount} browser(s).`);
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
        centerY: z.number().optional().describe('Optional Y coordinate for zoom center (pixels)'),
        panel: panelSchema
      }
    },
    async ({ centerX, centerY, panel }) => {
      return runCommand('zoom_in', { type: 'zoomIn', centerX, centerY, panel }, 'Zooming in');
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
        centerY: z.number().optional().describe('Optional Y coordinate for zoom center (pixels)'),
        panel: panelSchema
      }
    },
    async ({ centerX, centerY, panel }) => {
      return runCommand('zoom_out', { type: 'zoomOut', centerX, centerY, panel }, 'Zooming out');
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
        threshold: z.number().positive().optional().describe('Optional threshold value for the color scale'),
        panel: panelSchema
      }
    },
    async ({ color, threshold, panel }) => {
      const rgb = hexToRgb(color);
      if (!rgb) {
        return { content: [{ type: 'text', text: `Invalid color: ${color}. Please use a hex code (e.g., "#ff0000")` }], isError: true };
      }
      return runCommand('set_map_foreground_color', { type: 'setForegroundColor', color: rgb, threshold, panel }, `Map foreground color set to ${color}${threshold ? ` with threshold ${threshold}` : ''}`);
    }
  );

  // --- Tool: set_map_background_color ---
  mcpServer.registerTool(
    'set_map_background_color',
    {
      title: 'Set Map Background Color',
      description: 'Set the background color of the contact map',
      inputSchema: { color: colorSchema, panel: panelSchema }
    },
    async ({ color, panel }) => {
      const rgb = hexToRgb(color);
      if (!rgb) {
        return { content: [{ type: 'text', text: `Invalid color: ${color}. Please use a hex code (e.g., "#000000")` }], isError: true };
      }
      return runCommand('set_map_background_color', { type: 'setBackgroundColor', color: rgb, panel }, `Map background color set to ${color}`);
    }
  );

  // --- Tool: set_color_scale ---
  mcpServer.registerTool(
    'set_color_scale',
    {
      title: 'Set Color Scale',
      description: 'Adjust the color scale (threshold) of the contact map. Use "increase" to double the threshold (lighter), "decrease" to halve it (darker), or set an exact numeric value.',
      inputSchema: {
        action: z.enum(['increase', 'decrease', 'set']).describe('Action: "increase" doubles the threshold, "decrease" halves it, "set" uses the provided value'),
        value: z.number().positive().optional().describe('Exact threshold value (required when action is "set")'),
        panel: panelSchema
      }
    },
    async ({ action, value, panel }) => {
      if (action === 'set' && (value === undefined || value === null)) {
        return { content: [{ type: 'text', text: 'A positive numeric value is required when action is "set"' }], isError: true };
      }
      const desc = action === 'set' ? `set to ${value}` : action === 'increase' ? 'increased (doubled)' : 'decreased (halved)';
      return runCommand('set_color_scale', { type: 'setColorScale', action, value, panel }, `Color scale threshold ${desc}`);
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
        color: colorSchema.optional().describe('Optional track color as hex code (e.g., "#ff0000")'),
        panel: z.union([z.number().int().positive(), z.string()]).optional().describe('panel: position from the left (1, 2, ...), a map name, or "all"; required when more than one panel is open')
      }
    },
    async ({ url, name, color, panel }) => {
      const preset = TRACK_PRESETS[url.toLowerCase()];
      const resolvedUrl = preset ? preset.url : url;
      const resolvedName = name || (preset ? preset.name : undefined);
      const resolvedColor = color ? hexToRgb(color) : (preset ? preset.color : undefined);

      const command = { type: 'loadTrack', url: resolvedUrl, name: resolvedName };
      if (resolvedColor) command.color = resolvedColor;
      if (preset?.type) command.trackType = preset.type;
      if (preset?.format) command.format = preset.format;
      if (panel !== undefined) command.panel = panel;
      return runCommand('load_track', command, `Loading track${resolvedName ? ` "${resolvedName}"` : ''} from ${resolvedUrl}`);
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
          .describe('Normalization method. Common values: NONE (raw counts), VC (Coverage), VC_SQRT (Coverage-Sqrt), KR (Balanced / Knight-Ruiz), SCALE, INTER_SCALE, GW_SCALE. The available normalizations depend on the loaded map.'),
        panel: panelSchema
      }
    },
    async ({ normalization, panel }) => {
      const normNames = {
        NONE: 'None',
        VC: 'Coverage (VC)',
        VC_SQRT: 'Coverage-Sqrt (VC_SQRT)',
        KR: 'Balanced / Knight-Ruiz (KR)',
        SCALE: 'SCALE',
        INTER_SCALE: 'INTER_SCALE',
        GW_SCALE: 'GW_SCALE'
      };
      return runCommand('select_normalization', { type: 'setNormalization', normalization, panel }, `Normalization set to ${normNames[normalization] || normalization}`);
    }
  );

  // --- Tool: list_tracks ---
  mcpServer.registerTool(
    'list_tracks',
    {
      title: 'List Tracks',
      description: 'List all loaded 1D and 2D tracks in the current Juicebox session, including their names, types, colors, data ranges, and display settings.',
      inputSchema: { panel: onePanelSchema }
    },
    async ({ panel }) => {
      const { result: tracks, error } = await runRequest('getTrackList', { panel });
      if (error) return error;
      if (!tracks || tracks.length === 0) {
        return { content: [{ type: 'text', text: 'No tracks loaded.' }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(tracks, null, 2) }] };
    }
  );

  // --- Tool: list_panels ---
  mcpServer.registerTool(
    'list_panels',
    {
      title: 'List Panels',
      description: 'List the panels (contact-map viewers) open in the page, left to right: position, whether it is the current one, map name, genome, control map, track count and locus. Tools that take `panel` address a panel by this position, by its map name, or "all".',
      inputSchema: {}
    },
    async () => {
      const { result: panels, error } = await runRequest('getPanelList');
      if (error) return error;
      return { content: [{ type: 'text', text: JSON.stringify(panels, null, 2) }] };
    }
  );

  // --- Tool: remove_track ---
  mcpServer.registerTool(
    'remove_track',
    {
      title: 'Remove Track',
      description: 'Remove a loaded track from Juicebox by name or index number (use list_tracks to see available tracks).',
      inputSchema: {
        track: z.string().describe('Track name or 1-based index number'),
        panel: panelSchema
      }
    },
    async ({ track, panel }) => {
      return runCommand('remove_track', { type: 'removeTrack', track, panel }, `Removing track: ${track}`);
    }
  );

  // --- Tool: set_track_color ---
  mcpServer.registerTool(
    'set_track_color',
    {
      title: 'Set Track Color',
      description: 'Set or reset the color of a loaded track. Omit color to reset to default.',
      inputSchema: {
        track: z.string().describe('Track name or 1-based index number'),
        color: colorSchema.optional().describe('Hex color (e.g., "#ff0000"). Omit to reset to default.'),
        panel: panelSchema
      }
    },
    async ({ track, color, panel }) => {
      const command = { type: 'setTrackColor', track, panel };
      if (color) {
        const rgb = hexToRgb(color);
        if (rgb) command.color = rgb;
      }
      return runCommand('set_track_color', command, color ? `Setting track "${track}" color to ${color}` : `Resetting track "${track}" color to default`);
    }
  );

  // --- Tool: set_track_name ---
  mcpServer.registerTool(
    'set_track_name',
    {
      title: 'Set Track Name',
      description: 'Rename a loaded track.',
      inputSchema: {
        track: z.string().describe('Current track name or 1-based index number'),
        name: z.string().describe('New display name for the track'),
        panel: panelSchema
      }
    },
    async ({ track, name, panel }) => {
      return runCommand('set_track_name', { type: 'setTrackName', track, name, panel }, `Renaming track "${track}" to "${name}"`);
    }
  );

  // --- Tool: set_track_data_range ---
  mcpServer.registerTool(
    'set_track_data_range',
    {
      title: 'Set Track Data Range',
      description: 'Set the min/max data range for a 1D track. This disables autoscale.',
      inputSchema: {
        track: z.string().describe('Track name or 1-based index number'),
        min: z.number().describe('Minimum value'),
        max: z.number().describe('Maximum value'),
        panel: panelSchema
      }
    },
    async ({ track, min, max, panel }) => {
      return runCommand('set_track_data_range', { type: 'setTrackDataRange', track, min, max, panel }, `Setting track "${track}" data range to [${min}, ${max}]`);
    }
  );

  // --- Tool: set_track_autoscale ---
  mcpServer.registerTool(
    'set_track_autoscale',
    {
      title: 'Set Track Autoscale',
      description: 'Enable or disable autoscale for a 1D track.',
      inputSchema: {
        track: z.string().describe('Track name or 1-based index number'),
        enabled: z.boolean().default(true).describe('Enable (true) or disable (false) autoscale'),
        panel: panelSchema
      }
    },
    async ({ track, enabled, panel }) => {
      return runCommand('set_track_autoscale', { type: 'setTrackAutoscale', track, enabled, panel }, `${enabled ? 'Enabling' : 'Disabling'} autoscale for track "${track}"`);
    }
  );

  // --- Tool: set_track_log_scale ---
  mcpServer.registerTool(
    'set_track_log_scale',
    {
      title: 'Set Track Log Scale',
      description: 'Enable or disable log scale for a 1D track.',
      inputSchema: {
        track: z.string().describe('Track name or 1-based index number'),
        enabled: z.boolean().default(true).describe('Enable (true) or disable (false) log scale'),
        panel: panelSchema
      }
    },
    async ({ track, enabled, panel }) => {
      return runCommand('set_track_log_scale', { type: 'setTrackLogScale', track, enabled, panel }, `${enabled ? 'Enabling' : 'Disabling'} log scale for track "${track}"`);
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

      log.logInfo('Requesting compressed session data from browser...');
      const { result: compressedSessionString, error } = await runRequest('getCompressedSession');
      if (error) return error;
      // The snapshot link (design §7): compressedSession() is `session=blob:…`.
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
            `Room: ${(await getRoom()) || 'none'}\n` +
            `Browser Connected: ${connected ? 'Yes' : 'No'}\n` +
            `Browser URL: ${browserUrl}`
        }]
      };
    }
  );

  // --- Tool: get_juicebox_url ---
  // Hosts that render MCP Apps show VIEW_URI (link + QR card) from structuredContent;
  // the others get the text link.
  mcpServer.registerTool(
    'get_juicebox_url',
    {
      title: 'Get Juicebox URL',
      description: 'Get the join link that opens Juicebox connected to the room bound to this MCP session. Use this when users ask how to connect, how to open the Juicebox app, or say things like "Hello juicebox", "Open juicebox", "Show me juicebox", "Launch juicebox", etc. If you have a browser tool (Claude\'s built-in browser or Claude in Chrome), open the join link in it right away so Juicebox appears in the side panel next to the conversation: the page connects to this session\'s room and later tool calls redraw it there. Hosts that render MCP Apps also show a card with the link and its QR code. Always present the link to the user as a clickable link too (a plain URL or markdown link, never inside a code block).',
      inputSchema: {},
      _meta: TOOL_META
    },
    async () => {
      const room = await getRoom();
      if (!room) {
        return { content: [{ type: 'text', text: 'Error: No active session found. Please ensure the MCP connection is properly initialized.' }], isError: true };
      }
      const joinLink = new URL(browserUrl);
      joinLink.searchParams.set('room', room);
      const connectionUrl = joinLink.toString();

      // A bare URL and a markdown link: chat clients render both as clickable; a
      // code block would not be. The resource_link is the same link for clients that
      // render link content blocks (Cowork opens it in its browser pane).
      const content = [
        {
          type: 'text',
          text: `Juicebox join link for room ${room}:\n${connectionUrl}\n\n[Open Juicebox](${connectionUrl})\n\nNext step: if you have a browser tool, open this link in the built-in browser now so the viewer shows in the side panel; it joins room ${room} and later Juicebox tool calls redraw it there. Otherwise show the link for the user to click.`
        },
        {
          type: 'resource_link',
          uri: connectionUrl,
          name: 'Open Juicebox',
          description: `Join link for Juicebox room ${room}`,
          mimeType: 'text/html'
        }
      ];
      const structuredContent = { room, joinUrl: connectionUrl };
      try {
        structuredContent.qrPng = generateQRPng(connectionUrl); // base64 PNG, drawn by the view
      } catch {
        // QR is best-effort
      }
      return { content, structuredContent };
    }
  );

  // --- Tool: join_room ---
  mcpServer.registerTool(
    'join_room',
    {
      title: 'Join Room',
      description: 'Bind this MCP session to an existing room, e.g. one a page started whose join link (…?room=<id>) the user pasted into chat. Later tools drive the pages in that room, and get_juicebox_url returns its join link.',
      inputSchema: {
        room: z.string().regex(ROOM_ID, 'Must be a 10-character room id').describe('Room id: the value of the room parameter in the join link')
      }
    },
    async ({ room }) => {
      if (!sessionId) {
        return { content: [{ type: 'text', text: 'Error: No active session found. Please ensure the MCP connection is properly initialized.' }], isError: true };
      }
      room = room.toUpperCase();
      await bindRoom(room);
      const connected = await isBrowserConnected();
      return { content: [{ type: 'text', text: `Joined room ${room}. ${connected ? 'A page is connected.' : 'No page is connected yet.'}` }] };
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
- I'll give you a URL with a QR code to open in your browser

## Common Things You Can Ask

### Finding and Loading Data

**Search for Hi-C maps:**
- "Find human hg38 contact maps"
- "Show me K562 cell line maps"
- "Search for mouse heart tissue Hi-C data"
- "What maps are available from ENCODE?"

**Load a map:**
- "Load this map" (after searching)
- "Load map number 3"
- "Load this Hi-C file: [URL]"
- "Load a map from [URL] with KR normalization"

**Load a control map for comparison:**
- "Load a control map from [URL]"

### Exploring the Genome

**Navigate to specific locations:**
- "Go to chromosome 1"
- "Show me chr1:1000000-2000000"
- "Navigate to BRCA1"
- "Jump to the GATA4 gene"

**Zoom:**
- "Zoom in" / "Zoom out"

### Tracks

**Load tracks:**
- "Add a gene track" (loads NCBI RefSeq Select automatically)
- "Load this bigWig track: [URL]"
- "Add this annotation file: [URL]"

**Manage tracks:**
- "List loaded tracks" — shows all 1D and 2D tracks with their properties
- "Remove the gene track" or "Remove track 2" — remove by name or index
- "Rename track 1 to My Track"

**Track visualization:**
- "Set the gene track color to red"
- "Reset track 2 color to default"
- "Set track data range to 0-10"
- "Enable autoscale for the bigWig track"
- "Enable log scale for track 1"

### Map Visualization

**Change colors:**
- "Set the foreground color to red"
- "Make the background black"
- "Use blue (#0000ff) for the map"

**Adjust color scale (threshold):**
- "Increase the color scale" — doubles the threshold (lighter map)
- "Decrease the color scale" — halves the threshold (darker map)
- "Set the color scale to 500" — set an exact threshold value

**Change normalization (in-place, no reload):**
- "Switch to KR normalization" or "Use Balanced normalization"
- "Set normalization to Coverage" or "Use VC normalization"
- "Remove normalization" or "Set normalization to None"
- Available: None, Coverage (VC), Coverage-Sqrt (VC_SQRT), Balanced/Knight-Ruiz (KR), SCALE, INTER_SCALE, GW_SCALE

### Side by Side (panels)

Each map can open in its own panel, numbered 1, 2, ... from the left. With more than one panel open, say which one: by number, by map name, or "both"/"all".

**Open maps side by side:**
- "Load a heart and a colon intact Hi-C map from ENCODE side by side"
- "Open GM12878 next to it at chr8:127-129Mb"
- "Which panels are open?"

**Per-panel tracks and settings:**
- "Load CTCF into the heart panel"
- "Load the gene track in panel 2"
- "Set the colon colour scale to 50"

**All panels at once:**
- "Go to MYC on both panels"
- "Load the gene track in all panels"

**Close a panel:**
- "Close the heart panel" (the panels to its right move one number left; the last panel stays open)

### Sessions

**Save and restore:**
- "Save this session"
- "Save to [file path]"
- "Load this session: [paste JSON]"
- "Load session from [URL]"

**Share:**
- "Create a shareable URL"
- "Give me a link to share this"

### Data Discovery

**Get information:**
- "What data sources are available?"
- "Tell me about this map"
- "What are the statistics for ENCODE data?"
- "What other experiments are available for this biosample?"

## Tips

- **Be natural:** Just describe what you want to do in plain language
- **I'll guide you:** If something needs clarification, I'll ask
- **Context matters:** I remember what we've been working on
- **Multi-browser sync:** All browsers connected to the same session stay in sync automatically

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
      const portal = 'ENCODE portal (live search of encodeproject.org, not a catalog):\n  search_encode_hic — Hi-C experiments with their map and track files (tissues, intact Hi-C, cell lines)\n  search_encode — any other assay, annotation, biosample or publication';
      return { content: [{ type: 'text', text: `Available data sources:\n\n${formatted}\n\n${portal}` }] };
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
        ]).describe('Locus to navigate to.'),
        panel: panelSchema
      }
    },
    async ({ locus, panel }) => {
      if (!locus) {
        return { content: [{ type: 'text', text: 'Error: Locus specification is required' }], isError: true };
      }
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
      return runCommand('goto_locus', { type: 'gotoLocus', locus, panel }, `Navigating to locus: ${locusDisplay}`);
    }
  );

  // --- Tool: search_map_catalogs (renamed from search_maps, ticket 24) ---
  // What it does: downloads the two curated igv-data TSV catalogs that juicebox-web's
  // "load from ENCODE / 4DN" modals use (src/search/catalogs.js), and fuzzy-matches every
  // whitespace-separated query term (with genome/cell-line synonyms) against the catalog
  // columns; every term must match somewhere (AND).
  // Limitations: the catalogs are static lists, not the portals. ENCODE ≈176 rows, cell
  // lines only (GM12878, HCT116, IMR-90, K562, A549 …) — no tissues, no intact Hi-C;
  // 4DN ≈600 rows. Broad terms ("human", "hg38") match nearly every row. Output repeats
  // the rows as a table and as raw JSON, so the default 50 rows are ≈64 KB. Anything the
  // catalogs lack must go through search_encode_hic / search_encode (live portal).
  mcpServer.registerTool(
    'search_map_catalogs',
    {
      title: 'Search Map Catalogs',
      description: 'Search the two curated contact-map catalogs that ship with juicebox-web (ENCODE: ~176 cell-line maps such as GM12878, HCT116, IMR-90, K562; 4DN: ~600 maps) with natural language, e.g. "human hg38 maps", "mouse cell lines", "K562". This is a static list, NOT the ENCODE or 4DN portal: it has no ENCODE tissues and no intact Hi-C. If a query finds nothing here, or the user asks for tissues, intact Hi-C or anything ENCODE-specific, use search_encode_hic instead. Results are limited to 50 by default. For statistical questions like "what assemblies are covered" or "how many maps are there", use get_data_source_statistics instead.',
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

  // --- Tool: search_encode_hic ---
  // Live, experiment-first search of the ENCODE portal; the portal quirks it relies on
  // are documented in src/search/encodePortal.js.
  mcpServer.registerTool(
    'search_encode_hic',
    {
      title: 'Search ENCODE Hi-C',
      description: 'Search the live ENCODE portal (encodeproject.org) for Hi-C experiments and list, per experiment, its contact-map files and the companion files the viewer can load as tracks (loops, contact domains and chromatin stripes as bedpe; subcompartments as bed; compartments as bigWig). Use this for any ENCODE map the catalogs do not have: tissues (heart, colon, brain ...), intact Hi-C, specific cell lines. Put organ, tissue or cell-line words in `biosample` (organs match the ontology; other words fall back to text search); ask for "intact Hi-C" with `assay`; set `classification: "tissue"` when the user means tissue rather than a cell line derived from that organ. To load a map pass `maps[].url` to load_map (prefer the "mapping quality thresholded contact matrix", one per biosample); pass `tracks[].url` to load_track. For non-Hi-C questions use search_encode.',
      inputSchema: {
        biosample: z.string().optional().describe('Organ, tissue or cell line words, e.g. "heart", "colon", "K562"'),
        assay: z.enum(HIC_ASSAYS).optional().describe('One Hi-C flavour; default: all of intact Hi-C, in situ Hi-C, Hi-C, dilution Hi-C'),
        classification: z.enum(CLASSIFICATIONS).optional().describe('Biosample classification, e.g. "tissue" to exclude cell lines derived from the organ'),
        assembly: z.string().optional().describe('Genome assembly, e.g. "GRCh38", "mm10"'),
        query: z.string().optional().describe('Free text for the portal full-text search (lab, donor, treatment ...)'),
        limit: z.number().int().positive().max(50).optional().describe('Maximum experiments to return (default: 10)')
      }
    },
    async ({ biosample, assay, classification, assembly, query, limit = 10 }) => {
      try {
        const result = await hicExperiments({ biosample, assay, classification, assembly, searchTerm: query, limit });
        return { content: [{ type: 'text', text: formatHicExperiments(result) }] };
      } catch (error) {
        log.logError('Error in search_encode_hic tool:', error);
        return { content: [{ type: 'text', text: `Error searching the ENCODE portal: ${error.message}` }], isError: true };
      }
    }
  );

  // --- Tool: search_encode ---
  mcpServer.registerTool(
    'search_encode',
    {
      title: 'Search ENCODE',
      description: 'General search of the live ENCODE portal for anything that is not a Hi-C map: other assays (TF ChIP-seq, Histone ChIP-seq, DNase-seq, ATAC-seq, RNA-seq ...), annotations, biosamples, publications. `query` is the portal full-text search; `filters` are portal facet fields passed through verbatim, e.g. {"assay_title": "TF ChIP-seq", "biosample_ontology.organ_slims": "heart", "target.label": "CTCF"}; a list value means any of them. The result lists the hits with their portal links and the facets you can narrow by. For the files of one experiment use type "File" with {"dataset": "/experiments/ENCSRxxxxxx/"}.',
      inputSchema: {
        type: z.string().optional().describe('Portal object type: Experiment (default), Annotation, File, Biosample, Publication, ...'),
        query: z.string().optional().describe('Free text'),
        filters: z.record(z.union([z.string(), z.array(z.string())])).optional().describe('Facet field → value or list of values, passed to the portal as query parameters'),
        limit: z.number().int().positive().max(100).optional().describe('Maximum hits to return (default: 20)')
      }
    },
    async ({ type = 'Experiment', query, filters = {}, limit = 20 }) => {
      try {
        const result = await encodeSearch({ type, searchTerm: query, filters, limit });
        return { content: [{ type: 'text', text: formatEncodeSearch(result, { type }) }] };
      } catch (error) {
        log.logError('Error in search_encode tool:', error);
        return { content: [{ type: 'text', text: `Error searching the ENCODE portal: ${error.message}` }], isError: true };
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
      if (!sessionId) {
        return { content: [{ type: 'text', text: 'Error: No active session found. Please ensure the browser is connected.' }], isError: true };
      }

      log.logInfo('Requesting session data from browser...');
      const { result: sessionDataResult, error } = await runRequest('getSession');
      if (error) return error;
      const jsonString = JSON.stringify(sessionDataResult, null, 2);

      return {
        content: [{
          type: 'text',
          text: `Session data retrieved successfully.\n\nYou can copy the JSON below to save it locally:\n\n\`\`\`json\n${jsonString}\n\`\`\``
        }]
      };
    }
  );
}
