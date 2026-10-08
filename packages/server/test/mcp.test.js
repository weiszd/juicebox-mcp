/**
 * MCP seam: JSON-RPC over POST /mcp on the Worker under test, with fake pages on
 * /ws standing in for @aidenlab/juicebox-remote. Design §5.4, §6.
 */
import { SELF, env, runInDurableObject, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import jsQR from 'jsqr';
import { MessageType, CommandType } from '@aidenlab/juicebox-remote/protocol';
import { openPage, join, closePages } from './pages.js';
import prototypeTools from './fixtures/prototype-tools.json';
import heartHic from './fixtures/encode-hic-experiments.json';
import ctcfSearch from './fixtures/encode-search-ctcf.json';
import worker from '../src/index.js';

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/; // Crockford base32: no I, L, O, U

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closePages();
});

let rpcId = 0;
function rpc(method, params, headers = {}) {
  return SELF.fetch('https://jbmcp.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
}

function initialize(headers) {
  return rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }, headers);
}

/** A fresh MCP session; its id is also the id of the room it starts bound to. */
async function newSession() {
  return (await initialize()).headers.get('mcp-session-id');
}

async function callTool(session, name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args }, { 'mcp-session-id': session });
  return (await res.json()).result;
}

const text = (result) => result.content.find((c) => c.type === 'text').text;

/** A page in `room`, joined so the room already holds its socket. */
async function pageIn(room) {
  const page = await openPage(`?room=${room}`);
  await join(page, room);
  return page;
}

/** The page's next command, past the toolCall notice the room sends ahead of it. */
async function nextCommand(page) {
  expect((await page.next()).type).toBe(MessageType.TOOL_CALL);
  return page.next();
}

/**
 * Decode a QR code PNG as the server writes it (1-bit indexed, unfiltered rows)
 * and return the text it encodes.
 */
async function decodeQrPng(base64) {
  const png = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(png.buffer);
  let width, height, palette;
  const idat = [];
  for (let off = 8; off < png.length; ) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      expect([data[8], data[9], data[12]]).toEqual([1, 3, 0]); // bit depth 1, indexed, no interlace
    }
    if (type === 'PLTE') palette = data;
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const inflated = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(inflated).arrayBuffer());

  const rowBytes = Math.ceil(width / 8);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * (1 + rowBytes);
    expect(raw[row]).toBe(0); // filter: None
    for (let x = 0; x < width; x++) {
      const index = (raw[row + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
      rgba.set([...palette.subarray(index * 3, index * 3 + 3), 255], (y * width + x) * 4);
    }
  }
  return jsQR(rgba, width, height)?.data;
}

describe('initialize', () => {
  it('answers with the server info and an mcp-session-id that is a room id', async () => {
    const res = await initialize();

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toMatch(ROOM_ID);
    const body = await res.json();
    expect(body.result.serverInfo.name).toBe('juicebox-server');
    expect(body.result.serverInfo.icons[0].src).toBe('https://aidenlab.org/favicon.ico');
  });

  it('x-openai-session binds the same room id every time, and a different one per value', async () => {
    const a1 = (await initialize({ 'x-openai-session': 'openai-a' })).headers.get('mcp-session-id');
    const a2 = (await initialize({ 'x-openai-session': 'openai-a' })).headers.get('mcp-session-id');
    const b = (await initialize({ 'x-openai-session': 'openai-b' })).headers.get('mcp-session-id');

    expect(a1).toMatch(ROOM_ID);
    expect(a2).toBe(a1);
    expect(b).not.toBe(a1);
  });

  it('a tool call carrying only x-openai-session reaches the page in its room', async () => {
    const room = (await initialize({ 'x-openai-session': 'openai-c' })).headers.get('mcp-session-id');
    const page = await pageIn(room);

    const call = rpc('tools/call', { name: 'zoom_in', arguments: {} }, { 'x-openai-session': 'openai-c' });
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: true });

    expect(command.type).toBe(CommandType.ZOOM_IN);
    expect(text((await (await call).json()).result)).toBe('Zooming in');
  });
});

describe('tools/list', () => {
  // The client contract (ticket 36): every tool's name, title, description and input
  // schema, as served when the fixture was recorded. Regenerate the fixture only when
  // the contract changes on purpose.
  it('lists every tool with the recorded name, title, description and input schema', async () => {
    const res = await rpc('tools/list', {}, { 'mcp-session-id': await newSession() });
    const { tools } = (await res.json()).result;

    expect(tools.map((t) => t.name).sort()).toEqual(prototypeTools.map((t) => t.name).sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const { name, title, description, inputSchema } of prototypeTools) {
      const { title: servedTitle, description: servedDescription, inputSchema: servedSchema } = byName[name];
      expect({ title: servedTitle, description: servedDescription, inputSchema: servedSchema }, name)
        .toEqual({ title, description, inputSchema });
    }
  });

  it('search_maps is deliberately renamed search_map_catalogs (ticket 24): same schema, old name gone', async () => {
    const res = await rpc('tools/list', {}, { 'mcp-session-id': await newSession() });
    const byName = Object.fromEntries((await res.json()).result.tools.map((t) => [t.name, t.inputSchema]));

    // The fixture records the rename; the server serves search_maps' arguments under the new name only.
    expect(prototypeTools.filter((t) => t.renamedFrom).map((t) => [t.renamedFrom, t.name])).toEqual([['search_maps', 'search_map_catalogs']]);
    expect(Object.keys(byName.search_map_catalogs.properties)).toEqual(['source', 'query', 'limit']);
    expect(byName.search_maps).toBeUndefined();
  });
});

describe('command tools: what the page receives (ticket 36)', () => {
  const URL_A = 'https://example.org/a.hic';
  const URL_T = 'https://example.org/t.bw';

  /**
   * Every command tool, with arguments, the command the room fans out (less its requestId)
   * and the tool text on a bare ok ack. Rows with a label exercise argument-dependent
   * payload or wording.
   */
  const commandTools = [
    ['load_map', { url: URL_A }, { type: 'loadMap', url: URL_A }, `Loading map from ${URL_A}`],
    ['load_map', { url: URL_A, name: 'heart', normalization: 'KR', locus: 'chr8:1-2', panel: 'new' },
      { type: 'loadMap', url: URL_A, name: 'heart', normalization: 'KR', locus: 'chr8:1-2', panel: 'new' },
      `Loading map from ${URL_A} (heart) in a new panel`, 'name, new panel'],
    ['load_map', { url: URL_A, panel: 2 }, { type: 'loadMap', url: URL_A, panel: 2 }, `Loading map from ${URL_A}`, 'replacing panel 2'],
    ['close_panel', { panel: 2 }, { type: 'closePanel', panel: 2 }, 'Closing panel'],
    ['load_control_map', { url: URL_A, name: 'ctl', normalization: 'VC', panel: 1 },
      { type: 'loadControlMap', url: URL_A, name: 'ctl', normalization: 'VC', panel: 1 }, `Loading control map from ${URL_A} (ctl)`],
    ['load_session', { sessionData: '{"browsers":[{},{}]}' },
      { type: 'loadSession', sessionData: { browsers: [{}, {}] } }, 'Session loaded successfully. Restored 2 browser(s).'],
    ['zoom_in', { centerX: 10, centerY: 20, panel: 'all' }, { type: 'zoomIn', centerX: 10, centerY: 20, panel: 'all' }, 'Zooming in'],
    ['zoom_out', {}, { type: 'zoomOut' }, 'Zooming out'],
    ['set_map_foreground_color', { color: '#ff8000', threshold: 5 },
      { type: 'setForegroundColor', color: { r: 255, g: 128, b: 0 }, threshold: 5 }, 'Map foreground color set to #ff8000 with threshold 5'],
    ['set_map_background_color', { color: '#ffffff' },
      { type: 'setBackgroundColor', color: { r: 255, g: 255, b: 255 } }, 'Map background color set to #ffffff'],
    ['set_color_scale', { action: 'set', value: 3 }, { type: 'setColorScale', action: 'set', value: 3 }, 'Color scale threshold set to 3'],
    ['set_color_scale', { action: 'increase' }, { type: 'setColorScale', action: 'increase' }, 'Color scale threshold increased (doubled)', 'increase'],
    ['load_track', { url: URL_T, name: 'H3K27ac', color: '#0000ff', panel: 'all' },
      { type: 'loadTrack', url: URL_T, name: 'H3K27ac', color: { r: 0, g: 0, b: 255 }, panel: 'all' }, `Loading track "H3K27ac" from ${URL_T}`],
    ['load_track', { url: 'genes' }, { type: 'loadTrack', preset: 'genes', name: 'Refseq Select', color: { r: 0, g: 0, b: 0 } },
      'Loading track "Refseq Select" from the genes preset for the map\'s genome', 'genes preset'],
    ['select_normalization', { normalization: 'VC_SQRT' }, { type: 'setNormalization', normalization: 'VC_SQRT' }, 'Normalization set to Coverage-Sqrt (VC_SQRT)'],
    ['remove_track', { track: 'genes' }, { type: 'removeTrack', track: 'genes' }, 'Removing track: genes'],
    // set_track_color sends rgb, not the hex it was given, and words a reset differently.
    ['set_track_color', { track: '2', color: '#00ff00' }, { type: 'setTrackColor', track: '2', color: { r: 0, g: 255, b: 0 } },
      'Setting track "2" color to #00ff00'],
    ['set_track_color', { track: 'genes' }, { type: 'setTrackColor', track: 'genes' }, 'Resetting track "genes" color to default', 'reset'],
    ['set_track_name', { track: '1', name: 'RefSeq' }, { type: 'setTrackName', track: '1', name: 'RefSeq' }, 'Renaming track "1" to "RefSeq"'],
    ['set_track_data_range', { track: 'genes', min: 0, max: 10 }, { type: 'setTrackDataRange', track: 'genes', min: 0, max: 10 },
      'Setting track "genes" data range to [0, 10]'],
    ['set_track_autoscale', { track: 'genes' }, { type: 'setTrackAutoscale', track: 'genes', enabled: true }, 'Enabling autoscale for track "genes"'],
    ['set_track_log_scale', { track: 'genes', enabled: false }, { type: 'setTrackLogScale', track: 'genes', enabled: false },
      'Disabling log scale for track "genes"'],
    ['goto_locus', { locus: 'chr1:1000-2000' }, { type: 'gotoLocus', locus: 'chr1:1000-2000' }, 'Navigating to locus: chr1:1000-2000'],
    ['goto_locus', { locus: { chr: 'chr1', start: 1000, end: 2000 } }, { type: 'gotoLocus', locus: { chr: 'chr1', start: 1000, end: 2000 } },
      'Navigating to locus: chr1:1000-2000', 'structured locus'],
  ];

  /** Call `name` with a page in the room, ack its command as given; {notice, command, result}. */
  async function callAndAck(name, args, ack = { ok: true }) {
    const session = await newSession();
    const page = await pageIn(session);
    const call = callTool(session, name, args);
    const notice = await page.next();
    const command = await page.next();
    page.send({ type: MessageType.ACK, requestId: command.requestId, ...ack });
    return { notice, command, result: await call };
  }

  it('covers each command tool at least once', () => {
    expect(new Set(commandTools.map(([name]) => name)).size).toBe(18);
  });

  it.each(commandTools.map(([name, args, command, text, label]) => [label ? `${name} (${label})` : name, name, args, command, text]))(
    '%s', async (_, name, args, expected, expectedText) => {
      const { notice, command, result } = await callAndAck(name, args);

      expect(notice).toEqual({ type: MessageType.TOOL_CALL, name });
      expect(command).toEqual({ ...expected, requestId: expect.any(String) });
      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe(expectedText);
    });

  describe('ack to tool result (the same for every command tool)', () => {
    it('ok with a result: the page\'s lines follow the tool text', async () => {
      const lines = 'panel 1 (heart, mm10): ok\npanel 2 (colon, GRCh38): No map loaded';
      const { result } = await callAndAck('goto_locus', { locus: 'MYC', panel: 'all' }, { ok: true, result: lines });

      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe(`Navigating to locus: MYC\n${lines}`);
    });

    it('not ok: an error carrying the page error text', async () => {
      const { result } = await callAndAck('goto_locus', { locus: 'chr1' }, { ok: false, error: 'No map loaded' });

      expect(result.isError).toBe(true);
      expect(text(result)).toBe('Error: No map loaded');
    });

    it('no ack within 10 s: the tool text, "sent, unconfirmed", not an error', async () => {
      const session = await newSession();
      const page = await pageIn(session);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const call = callTool(session, 'goto_locus', { locus: 'chr1' });
      await nextCommand(page); // the command is out and its ack timer is running
      // Advance from inside the room: its timer callback must run in the room's I/O context.
      const room = env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(session));
      await runInDurableObject(room, () => vi.advanceTimersByTimeAsync(10_000));
      const result = await call;

      expect(result.isError).toBeFalsy();
      expect(text(result)).toBe('Navigating to locus: chr1 (sent, unconfirmed: no page acknowledged within 10 s)');
    });

    it('no page in the room: an error naming the join link, not success', async () => {
      const result = await callTool(await newSession(), 'goto_locus', { locus: 'chr1' });

      expect(result.isError).toBe(true);
      expect(text(result)).toBe('Error: No page is connected to this room. Use get_juicebox_url to get the join link and open it in a browser.');
    });
  });
});

describe('commands to several pages', () => {
  it('fans out to every page in the room; the first ack decides', async () => {
    const session = await newSession();
    const a = await pageIn(session);
    const b = await pageIn(session);

    const call = callTool(session, 'goto_locus', { locus: 'chr2' });
    const [toA, toB] = await Promise.all([nextCommand(a), nextCommand(b)]);
    b.send({ type: MessageType.ACK, requestId: toB.requestId, ok: false, error: 'first' });
    const result = await call;
    a.send({ type: MessageType.ACK, requestId: toA.requestId, ok: true });

    expect(toA).toEqual(toB);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('first');
  });
});

describe('toolCall notice', () => {
  /** Every command-producing tool, with arguments it accepts, and the command it sends. */
  const commandTools = [
    ['load_map', { url: 'https://example.org/a.hic' }, CommandType.LOAD_MAP],
    ['load_control_map', { url: 'https://example.org/b.hic' }, CommandType.LOAD_CONTROL_MAP],
    ['load_session', { sessionData: JSON.stringify({ browsers: [] }) }, CommandType.LOAD_SESSION],
    ['zoom_in', {}, CommandType.ZOOM_IN],
    ['zoom_out', {}, CommandType.ZOOM_OUT],
    ['set_map_foreground_color', { color: '#ff0000' }, CommandType.SET_FOREGROUND_COLOR],
    ['set_map_background_color', { color: '#ffffff' }, CommandType.SET_BACKGROUND_COLOR],
    ['set_color_scale', { action: 'increase' }, CommandType.SET_COLOR_SCALE],
    ['load_track', { url: 'genes' }, CommandType.LOAD_TRACK],
    ['select_normalization', { normalization: 'KR' }, CommandType.SET_NORMALIZATION],
    ['remove_track', { track: 'genes' }, CommandType.REMOVE_TRACK],
    ['set_track_color', { track: 'genes', color: '#00ff00' }, CommandType.SET_TRACK_COLOR],
    ['set_track_name', { track: 'genes', name: 'RefSeq' }, CommandType.SET_TRACK_NAME],
    ['set_track_data_range', { track: 'genes', min: 0, max: 10 }, CommandType.SET_TRACK_DATA_RANGE],
    ['set_track_autoscale', { track: 'genes', enabled: true }, CommandType.SET_TRACK_AUTOSCALE],
    ['set_track_log_scale', { track: 'genes', enabled: true }, CommandType.SET_TRACK_LOG_SCALE],
    ['goto_locus', { locus: 'chr1' }, CommandType.GOTO_LOCUS],
    ['close_panel', { panel: 2 }, CommandType.CLOSE_PANEL],
  ];

  // The genes keyword travels as a preset: the file depends on the map's genome, which only
  // the page knows (ticket 32).
  it('load_track genes sends preset "genes" with the default name and colour, and no url', async () => {
    const session = await newSession();
    const page = await pageIn(session);
    const call = callTool(session, 'load_track', { url: 'genes' });
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: true });
    await call;
    expect(command).toEqual({
      type: CommandType.LOAD_TRACK,
      requestId: command.requestId,
      preset: 'genes',
      name: 'Refseq Select',
      color: { r: 0, g: 0, b: 0 },
    });
  });

  it.each(commandTools)('%s sends toolCall {name} to every page before its command', async (name, args, type) => {
    const session = await newSession();
    const a = await pageIn(session);
    const b = await pageIn(session);

    const call = callTool(session, name, args);
    const [noticeA, noticeB] = [await a.next(), await b.next()];
    const [commandA, commandB] = [await a.next(), await b.next()];
    a.send({ type: MessageType.ACK, requestId: commandA.requestId, ok: true });
    const result = await call;

    expect(noticeA).toEqual({ type: MessageType.TOOL_CALL, name });
    expect(noticeB).toEqual({ type: MessageType.TOOL_CALL, name });
    expect(commandA.type).toBe(type);
    expect(commandB).toEqual(commandA);
    expect(result.isError).toBeFalsy();
  });

  it('read-only tools send nothing to the page', async () => {
    const session = await newSession();
    const page = await pageIn(session);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('')); // the search tools' catalogs

    for (const [name, args] of [
      ['search_map_catalogs', { query: 'GM12878' }],
      ['get_data_source_statistics', { source: '4dn' }],
      ['get_map_details', { source: '4dn', index: 0 }],
      ['list_data_sources', {}],
      ['get_server_status', {}],
      ['juicebox_help', {}],
      ['get_juicebox_url', {}],
      ['join_room', { room: session }],
    ]) {
      await callTool(session, name, args);
    }
    page.send({ type: MessageType.JOIN, room: session });

    expect(await page.next()).toEqual({ type: MessageType.JOINED, room: session }); // barrier: nothing came before
  });
});

describe('join link and join_room', () => {
  it('get_juicebox_url returns the join link for the room named by the session id', async () => {
    const session = await newSession();
    const result = await callTool(session, 'get_juicebox_url');

    expect(text(result)).toContain(`?room=${session}`);
  });

  it('get_juicebox_url is an MCP App: the tool names the join card, whose QR decodes to the link (ticket 23)', async () => {
    const session = await newSession();
    const tools = (await (await rpc('tools/list', {}, { 'mcp-session-id': session })).json()).result.tools;
    const tool = tools.find((t) => t.name === 'get_juicebox_url');
    expect(tool._meta.ui.resourceUri).toBe('ui://juicebox/join');
    expect(tool._meta['ui/resourceUri']).toBe('ui://juicebox/join'); // flat key, older hosts

    const view = (await (await rpc('resources/read', { uri: 'ui://juicebox/join' }, { 'mcp-session-id': session })).json()).result.contents[0];
    expect(view.mimeType).toBe('text/html;profile=mcp-app');
    const result = await callTool(session, 'get_juicebox_url');
    const link = text(result).match(/https?:\/\/\S+/)[0];
    expect(view.text).not.toContain('<iframe'); // Claude's sandbox forbids framing other origins
    expect(view._meta.ui.csp.frameDomains).toBeUndefined();
    expect(result.content.find((c) => c.type === 'image')).toBeUndefined(); // the QR is the view's, not a file
    expect(result.structuredContent).toMatchObject({ room: session, joinUrl: link });
    expect(await decodeQrPng(result.structuredContent.qrPng)).toBe(link);
  });

  it('serves the data source configurations as resources', async () => {
    const session = await newSession();
    const listed = (await (await rpc('resources/list', {}, { 'mcp-session-id': session })).json()).result.resources;
    expect(listed.map((r) => r.uri).sort()).toEqual(['juicebox://datasource/4dn', 'juicebox://datasource/encode', 'ui://juicebox/join']);
    const encode = (await (await rpc('resources/read', { uri: 'juicebox://datasource/encode' }, { 'mcp-session-id': session })).json()).result.contents[0];
    expect(JSON.parse(encode.text).columns).toBeDefined();
  });

  it('get_juicebox_url gives the join link as a clickable link, not a code block', async () => {
    const session = await newSession();
    const result = await callTool(session, 'get_juicebox_url');

    const link = text(result).match(/https?:\/\/\S+/)[0];
    expect(text(result)).not.toContain('```');
    expect(new URL(link).searchParams.get('room')).toBe(session);
    const resourceLink = result.content.find((c) => c.type === 'resource_link');
    expect(resourceLink.uri).toBe(link);
  });

  it('after join_room, get_juicebox_url returns that room\'s join link', async () => {
    const session = await newSession();
    const room = await newSession(); // any other room id

    const joined = await callTool(session, 'join_room', { room });
    const result = await callTool(session, 'get_juicebox_url');

    expect(joined.isError).toBeFalsy();
    const link = text(result).match(/https?:\/\/\S+/)[0];
    expect(new URL(link).searchParams.get('room')).toBe(room);
    expect(result.structuredContent).toMatchObject({ room, joinUrl: link });
  });

  it('after join_room, commands go to the pages in the joined room', async () => {
    const session = await newSession();
    const room = await newSession();
    const page = await pageIn(room);

    await callTool(session, 'join_room', { room });
    const call = callTool(session, 'zoom_out');
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: true });

    expect(command.type).toBe(CommandType.ZOOM_OUT);
    expect(text(await call)).toBe('Zooming out');
  });

  it('join_room refuses a string that is not a room id', async () => {
    const result = await callTool(await newSession(), 'join_room', { room: 'not-a-room' });

    expect(result.isError).toBe(true);
  });
});

describe('request tools', () => {
  /**
   * Of two pages, the one that receives the next message: {asked, request, other, otherNext}.
   * `otherNext` is the other page's pending next(), so a barrier can await it.
   */
  function firstToReceive(x, y) {
    const [nx, ny] = [x.next(), y.next()];
    return Promise.race([
      nx.then((request) => ({ asked: x, request, other: y, otherNext: ny })),
      ny.then((request) => ({ asked: y, request, other: x, otherNext: nx })),
    ]);
  }

  it('list_tracks returns the page\'s result; with two pages only one is asked', async () => {
    const session = await newSession();
    const a = await pageIn(session);
    const b = await pageIn(session);
    const tracks = [{ name: 'CTCF', type: '1D' }];

    const call = callTool(session, 'list_tracks');
    const { asked, request, other, otherNext } = await firstToReceive(a, b);
    asked.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: tracks });
    const result = await call;
    other.send({ type: MessageType.JOIN, room: session });

    expect(request).toEqual({ type: CommandType.GET_TRACK_LIST, requestId: expect.any(String) });
    expect(text(result)).toBe(JSON.stringify(tracks, null, 2));
    expect(await otherNext).toEqual({ type: MessageType.JOINED, room: session }); // barrier: the other got nothing
  });

  it('save_session returns the page\'s session JSON as text', async () => {
    const session = await newSession();
    const page = await pageIn(session);
    const saved = { browsers: [{ url: 'https://example.org/a.hic' }] };

    const call = callTool(session, 'save_session');
    const request = await page.next();
    page.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: saved });
    const result = await call;

    expect(request.type).toBe(CommandType.GET_SESSION);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain(JSON.stringify(saved, null, 2));
  });

  it('a request the page fails answers with the page error text', async () => {
    const session = await newSession();
    const page = await pageIn(session);

    const call = callTool(session, 'save_session');
    const request = await page.next();
    page.send({ type: MessageType.ACK, requestId: request.requestId, ok: false, error: 'No map loaded' });
    const result = await call;

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No map loaded');
  });

  it('no page in the room answers with an error', async () => {
    const result = await callTool(await newSession(), 'list_tracks');

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no page is connected/i);
  });

  it('closing page A while page B\'s request is pending leaves B\'s request alive', async () => {
    const session = await newSession();
    const x = await pageIn(session);
    const y = await pageIn(session);

    const call = callTool(session, 'list_tracks');
    const { asked: b, request, other: a } = await firstToReceive(x, y);
    await a.close();
    b.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: [{ name: 'genes' }] });
    const result = await call;

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('genes');
  });

  it('the page asked closing fails its request at once', async () => {
    const session = await newSession();
    const page = await pageIn(session);

    const call = callTool(session, 'list_tracks');
    await page.next();
    await page.close();
    const result = await call;

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/disconnected/i);
  });
});

describe('panels (ADR-0007)', () => {
  /** Every tool that acts on one panel, with arguments it accepts besides `panel`. */
  const panelTools = [
    ['load_map', { url: 'https://example.org/a.hic' }],
    ['load_control_map', { url: 'https://example.org/b.hic' }],
    ['close_panel', {}],
    ['zoom_in', {}],
    ['zoom_out', {}],
    ['set_map_foreground_color', { color: '#ff0000' }],
    ['set_map_background_color', { color: '#ffffff' }],
    ['set_color_scale', { action: 'increase' }],
    ['load_track', { url: 'genes' }],
    ['select_normalization', { normalization: 'KR' }],
    ['remove_track', { track: 'genes' }],
    ['set_track_color', { track: 'genes', color: '#00ff00' }],
    ['set_track_name', { track: 'genes', name: 'RefSeq' }],
    ['set_track_data_range', { track: 'genes', min: 0, max: 10 }],
    ['set_track_autoscale', { track: 'genes', enabled: true }],
    ['set_track_log_scale', { track: 'genes', enabled: true }],
    ['goto_locus', { locus: 'chr1' }],
  ];

  /** Call `name`, answer its command with an ok ack carrying `result`; {command, result}. */
  async function commandFor(name, args, result) {
    const session = await newSession();
    const page = await pageIn(session);
    const call = callTool(session, name, args);
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: true, result });
    return { command, result: await call };
  }

  it.each(panelTools)('%s passes a position, a name or "all" through to the page unchanged', async (name, args) => {
    for (const panel of [2, 'heart', 'all']) {
      const { command } = await commandFor(name, { ...args, panel });
      expect(command.panel, `${name} panel ${panel}`).toBe(panel);
    }
  });

  it('a command without panel sends none; the page decides (one panel: the current one)', async () => {
    const { command } = await commandFor('goto_locus', { locus: 'chr1' });

    expect('panel' in command).toBe(false);
  });

  it('load_map {panel: "new"} asks for a new panel and answers with the page\'s "loaded … into panel N of M"', async () => {
    const url = 'https://example.org/heart.hic';
    const { command, result } = await commandFor('load_map', { url, locus: 'chr8:127000000-129000000', panel: 'new' },
      'loaded heart into panel 2 of 2 (heart, mm10)');

    expect(command).toEqual({ type: CommandType.LOAD_MAP, url, locus: 'chr8:127000000-129000000', panel: 'new', requestId: expect.any(String) });
    expect(text(result)).toBe(`Loading map from ${url} in a new panel\nloaded heart into panel 2 of 2 (heart, mm10)`);
  });

  it('close_panel sends closePanel {panel} and answers with the remaining numbering', async () => {
    const { command, result } = await commandFor('close_panel', { panel: 'heart' },
      'closed panel 1 (heart, mm10); remaining: 1 (colon, GRCh38)');

    expect(command).toEqual({ type: CommandType.CLOSE_PANEL, panel: 'heart', requestId: expect.any(String) });
    expect(text(result)).toBe('Closing panel\nclosed panel 1 (heart, mm10); remaining: 1 (colon, GRCh38)');
  });

  it('a page error (e.g. panel omitted with two open) comes back as the tool error', async () => {
    const session = await newSession();
    const page = await pageIn(session);
    const error = '2 panels open; say panel: 1 (heart, mm10) | 2 (colon, GRCh38) | all';

    const call = callTool(session, 'load_track', { url: 'genes' });
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: false, error });
    const result = await call;

    expect(result.isError).toBe(true);
    expect(text(result)).toBe(`Error: ${error}`);
  });

  it('list_panels asks one page for getPanelList and returns its list as JSON', async () => {
    const session = await newSession();
    const page = await pageIn(session);
    const panels = [
      { panel: 1, current: false, map: 'heart', genome: 'mm10', controlMap: null, tracks: 2, locus: 'All' },
      { panel: 2, current: true, map: 'colon', genome: 'GRCh38', controlMap: null, tracks: 0, locus: 'chr8:1-2 chr8:1-2' },
    ];

    const call = callTool(session, 'list_panels');
    const request = await page.next();
    page.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: panels });
    const result = await call;

    expect(request).toEqual({ type: CommandType.GET_PANEL_LIST, requestId: expect.any(String) });
    expect(text(result)).toBe(JSON.stringify(panels, null, 2));
  });

  it('juicebox_help shows side by side, per-panel tracks, "all" and closing a panel', async () => {
    const help = text(await callTool(await newSession(), 'juicebox_help'));

    expect(help).toContain('"Load a heart and a colon intact Hi-C map from ENCODE side by side"');
    expect(help).toContain('"Load CTCF into the heart panel"');
    expect(help).toContain('"Go to MYC on both panels"');
    expect(help).toContain('"Close the heart panel"');
  });

  it('list_tracks {panel} asks the page for that panel\'s tracks', async () => {
    const session = await newSession();
    const page = await pageIn(session);

    for (const panel of [2, 'colon']) {
      const call = callTool(session, 'list_tracks', { panel });
      const request = await page.next();
      page.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: [] });
      await call;

      expect(request).toEqual({ type: CommandType.GET_TRACK_LIST, panel, requestId: expect.any(String) });
    }
  });
});

describe('ENCODE portal search (search_encode_hic, search_encode)', () => {
  const portal = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const NO_HITS = { '@graph': [], total: 0, facets: [] }; // the portal's zero-hit answer, with HTTP 404
  const params = (spy, call = 0) => new URL(spy.mock.calls[call][0]).searchParams;

  it('search_encode_hic asks for released Hi-C experiments of an organ, with an explicit non-browser User-Agent', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => portal(heartHic));

    await callTool(await newSession(), 'search_encode_hic', { biosample: 'heart', classification: 'tissue', assembly: 'GRCh38' });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url.startsWith('https://www.encodeproject.org/search/?')).toBe(true);
    const q = params(fetchSpy);
    expect(q.get('type')).toBe('Experiment');
    expect(q.get('format')).toBe('json');
    expect(q.get('status')).toBe('released');
    expect(q.getAll('assay_title')).toEqual(['intact Hi-C', 'in situ Hi-C', 'Hi-C', 'dilution Hi-C']);
    expect(q.get('biosample_ontology.organ_slims')).toBe('heart');
    expect(q.get('biosample_ontology.classification')).toBe('tissue');
    expect(q.get('assembly')).toBe('GRCh38');
    expect(q.getAll('field')).toEqual(expect.arrayContaining(['files.href', 'files.file_format', 'files.output_type', 'files.status']));
    expect(init.headers['user-agent']).toMatch(/Juicebox-MCP/);
    expect(init.headers['user-agent']).not.toMatch(/Chrome|Safari/); // a spoofed browser UA gets 502 from the portal's WAF
  });

  it('search_encode_hic lists released maps (MAPQ-thresholded first) and loadable track files, and drops experiments without released maps', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => portal(heartHic));

    const result = await callTool(await newSession(), 'search_encode_hic', { biosample: 'heart' });
    const [summary, json] = text(result).split('\n\n[Structured data]\n');

    expect(result.isError).toBeFalsy();
    expect(summary).toBe([
      '1 of 38 released ENCODE Hi-C experiments (organ "heart") (1 without released maps omitted):',
      '',
      '1. ENCSR000HRT — intact Hi-C — Homo sapiens heart left ventricle tissue male adult (51 years) [tissue; GRCh38; Erez Aiden, BCM]',
      '   map: mapping quality thresholded contact matrix (GRCh38, rep 1 27.8 GB) https://www.encodeproject.org/files/ENCFF002MQ/@@download/ENCFF002MQ.hic',
      '   map: contact matrix (GRCh38, rep 1 31.4 GB) https://www.encodeproject.org/files/ENCFF001CM/@@download/ENCFF001CM.hic',
      '   tracks (3, urls in the JSON): bedpe: contact domains, loops; bigWig: genome compartments',
    ].join('\n'));
    const [experiment] = JSON.parse(json);
    expect(experiment.maps.map((m) => m.url)).toEqual([
      'https://www.encodeproject.org/files/ENCFF002MQ/@@download/ENCFF002MQ.hic',
      'https://www.encodeproject.org/files/ENCFF001CM/@@download/ENCFF001CM.hic',
    ]);
    expect(experiment.tracks).toEqual([
      { url: 'https://www.encodeproject.org/files/ENCFF005CD/@@download/ENCFF005CD.bedpe.gz', format: 'bedpe', outputType: 'contact domains', assembly: 'GRCh38', replicates: [1] },
      { url: 'https://www.encodeproject.org/files/ENCFF004LP/@@download/ENCFF004LP.bedpe.gz', format: 'bedpe', outputType: 'loops', assembly: 'GRCh38', replicates: [1] },
      { url: 'https://www.encodeproject.org/files/ENCFF006SC/@@download/ENCFF006SC.bigWig', format: 'bigWig', outputType: 'genome compartments', assembly: 'GRCh38', replicates: [1] },
    ]);
  });

  it('search_encode_hic with one assay asks for that assay only', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => portal(heartHic));

    await callTool(await newSession(), 'search_encode_hic', { biosample: 'heart', assay: 'intact Hi-C' });

    expect(params(fetchSpy).getAll('assay_title')).toEqual(['intact Hi-C']);
  });

  it('a biosample that is no organ (portal 404, total 0) falls back to the full-text search', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => portal(NO_HITS, 404))
      .mockImplementationOnce(async () => portal(heartHic));

    const result = await callTool(await newSession(), 'search_encode_hic', { biosample: 'K562' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(params(fetchSpy, 0).get('biosample_ontology.organ_slims')).toBe('K562');
    expect(params(fetchSpy, 1).has('biosample_ontology.organ_slims')).toBe(false);
    expect(params(fetchSpy, 1).get('searchTerm')).toBe('K562');
    expect(text(result)).toMatch(/^1 of 38 released ENCODE Hi-C experiments \(text "K562"\)/);
  });

  it('no hits either way answers that nothing was found, not an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => portal(NO_HITS, 404));

    const result = await callTool(await newSession(), 'search_encode_hic', { biosample: 'spleen' });

    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe('No released ENCODE Hi-C experiments with maps found (text "spleen").');
  });

  it('a portal failure (e.g. 502 from its bot filter) is a tool error naming the status', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));

    const result = await callTool(await newSession(), 'search_encode_hic', { biosample: 'heart' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Error searching the ENCODE portal: ENCODE portal answered 502 for https:\/\/www\.encodeproject\.org\/search\/\?/);
  });

  it('search_encode passes facet filters through verbatim (a list repeats the key) and lists hits with links and facets', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => portal(ctcfSearch));

    const result = await callTool(await newSession(), 'search_encode', {
      query: 'heart',
      filters: { assay_title: 'TF ChIP-seq', 'target.label': 'CTCF', 'biosample_ontology.classification': ['tissue', 'primary cell'] },
      limit: 5,
    });

    const q = params(fetchSpy);
    expect(q.get('type')).toBe('Experiment');
    expect(q.get('searchTerm')).toBe('heart');
    expect(q.get('limit')).toBe('5');
    expect(q.get('status')).toBe('released');
    expect(q.get('assay_title')).toBe('TF ChIP-seq');
    expect(q.get('target.label')).toBe('CTCF');
    expect(q.getAll('biosample_ontology.classification')).toEqual(['tissue', 'primary cell']);
    const [head, hits, facets] = text(result).split('\n\n');
    expect(head).toBe(`2 of 38 Experiment hits on the ENCODE portal\n${fetchSpy.mock.calls[0][0]}`);
    expect(hits).toBe([
      '- ENCSR000CTC — TF ChIP-seq — Homo sapiens heart left ventricle tissue female adult (53 years) — target CTCF — Michael Snyder, Stanford — CTCF ChIP-seq on human heart left ventricle',
      '  https://www.encodeproject.org/experiments/ENCSR000CTC/',
      '- ENCFF009BW — bigWig fold change over control — GRCh38',
      '  https://www.encodeproject.org/files/ENCFF009BW/@@download/ENCFF009BW.bigWig',
    ].join('\n'));
    expect(facets).toBe([
      'Facets (narrow with filters):',
      'Object type: Experiment (38)',
      'Biosample: heart left ventricle (21), right atrium auricular region (17)',
    ].join('\n'));
  });

  it('search_encode with a status filter does not add status=released', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => portal(NO_HITS, 404));

    const result = await callTool(await newSession(), 'search_encode', { type: 'File', filters: { status: 'archived' } });

    expect(params(fetchSpy).getAll('status')).toEqual(['archived']);
    expect(params(fetchSpy).get('type')).toBe('File');
    expect(text(result)).toMatch(/^0 of 0 File hits on the ENCODE portal\n/);
    expect(text(result)).toContain('(none)');
  });
});

describe('create_shareable_url', () => {
  /** tools/call straight into the Worker's fetch, with `vars` added to its env. */
  async function callToolWithEnv(vars, session, name) {
    const request = new Request('https://jbmcp.test/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: {} } }),
    });
    const res = await worker.fetch(request, { ...env, ...vars }, createExecutionContext());
    return (await res.json()).result;
  }

  it('without a TinyURL key answers with the long snapshot link', async () => {
    const session = await newSession();
    const page = await pageIn(session);

    const call = callTool(session, 'create_shareable_url');
    const request = await page.next();
    page.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: 'session=blob:abc123' });
    const result = await call;

    expect(request.type).toBe(CommandType.GET_COMPRESSED_SESSION);
    expect(text(result)).toContain(`${env.BROWSER_URL}?session=blob:abc123`);
  });

  it('with a key, shortens the snapshot link with TinyURL on t.3dg.io', async () => {
    const session = await newSession();
    const page = await pageIn(session);
    const tinyurl = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: { tiny_url: 'https://t.3dg.io/xyz' } }));

    const call = callToolWithEnv({ TINYURL_API_KEY: 'test-key' }, session, 'create_shareable_url');
    const request = await page.next();
    page.send({ type: MessageType.ACK, requestId: request.requestId, ok: true, result: 'session=blob:abc123' });
    const result = await call;

    expect(tinyurl).toHaveBeenCalledOnce();
    const [endpoint, init] = tinyurl.mock.calls[0];
    expect(endpoint).toBe('https://api.tinyurl.com/create');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body)).toEqual({ url: `${env.BROWSER_URL}?session=blob:abc123`, domain: 't.3dg.io', tags: ['juicebox', 'juicebox-mcp'] });
    expect(text(result)).toContain('https://t.3dg.io/xyz');
  });
});
