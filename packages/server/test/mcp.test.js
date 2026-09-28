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
  it('lists the prototype tools with unchanged names and input schemas, plus join_room', async () => {
    const res = await rpc('tools/list', {}, { 'mcp-session-id': await newSession() });
    const { tools } = (await res.json()).result;

    expect(tools).toHaveLength(28);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
    for (const { name, inputSchema } of prototypeTools) {
      expect(byName[name], name).toEqual(inputSchema);
    }
    expect(byName.join_room.required).toEqual(['room']);
  });
});

describe('commands with ack', () => {
  it('sends the prototype payload plus a requestId; ok:true answers with the success text', async () => {
    const session = await newSession();
    const page = await pageIn(session);

    const call = callTool(session, 'goto_locus', { locus: 'chr1:1000-2000' });
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: true });
    const result = await call;

    expect(command).toEqual({ type: CommandType.GOTO_LOCUS, locus: 'chr1:1000-2000', requestId: expect.any(String) });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toBe('Navigating to locus: chr1:1000-2000');
  });

  it('ok:false answers with an error carrying the page error text', async () => {
    const session = await newSession();
    const page = await pageIn(session);

    const call = callTool(session, 'goto_locus', { locus: 'chr1:1000-2000' });
    const command = await nextCommand(page);
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: false, error: 'No map loaded' });
    const result = await call;

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('No map loaded');
  });

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

  it('no page in the room answers with an error, not success', async () => {
    const result = await callTool(await newSession(), 'goto_locus', { locus: 'chr1' });

    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/no page is connected/i);
  });

  it('no ack within 10 s answers "sent, unconfirmed"', async () => {
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
    expect(text(result)).toContain('sent, unconfirmed');
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
  ];

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
      ['search_maps', { query: 'GM12878' }],
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
    expect(view.text).not.toContain('<iframe'); // Claude's sandbox forbids framing other origins
    expect(view._meta.ui.csp.frameDomains).toBeUndefined();

    const result = await callTool(session, 'get_juicebox_url');
    const link = text(result).match(/https?:\/\/\S+/)[0];
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
    expect(text(result)).toContain(`[Open Juicebox](${link})`);
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
    expect(JSON.parse(init.body)).toEqual({ url: `${env.BROWSER_URL}?session=blob:abc123`, domain: 't.3dg.io' });
    expect(text(result)).toContain('https://t.3dg.io/xyz');
  });
});
