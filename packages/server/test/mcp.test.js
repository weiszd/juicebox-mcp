/**
 * MCP seam: JSON-RPC over POST /mcp on the Worker under test, with fake pages on
 * /ws standing in for @aidenlab/juicebox-remote. Design §5.4, §6.
 */
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import jsQR from 'jsqr';
import { MessageType, CommandType } from '@aidenlab/juicebox-remote/protocol';
import { openPage, join, closePages } from './pages.js';
import prototypeTools from './fixtures/prototype-tools.json';

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/; // Crockford base32: no I, L, O, U

afterEach(() => {
  vi.useRealTimers();
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
    const command = await page.next();
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
    const command = await page.next();
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
    const command = await page.next();
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
    const [toA, toB] = await Promise.all([a.next(), b.next()]);
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
    await page.next(); // the command is out and its ack timer is running
    // Advance from inside the room: its timer callback must run in the room's I/O context.
    const room = env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(session));
    await runInDurableObject(room, () => vi.advanceTimersByTimeAsync(10_000));
    const result = await call;

    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('sent, unconfirmed');
  });
});

describe('join link and join_room', () => {
  it('get_juicebox_url returns the join link for the room named by the session id', async () => {
    const session = await newSession();
    const result = await callTool(session, 'get_juicebox_url');

    expect(text(result)).toContain(`?room=${session}`);
  });

  it('after join_room, get_juicebox_url returns that room\'s join link and its QR decodes to it', async () => {
    const session = await newSession();
    const room = await newSession(); // any other room id

    const joined = await callTool(session, 'join_room', { room });
    const result = await callTool(session, 'get_juicebox_url');

    expect(joined.isError).toBeFalsy();
    const link = text(result).match(/https?:\/\/\S+/)[0];
    expect(new URL(link).searchParams.get('room')).toBe(room);
    const qr = result.content.find((c) => c.type === 'image');
    expect(qr.mimeType).toBe('image/png');
    expect(await decodeQrPng(qr.data)).toBe(link);
  });

  it('after join_room, commands go to the pages in the joined room', async () => {
    const session = await newSession();
    const room = await newSession();
    const page = await pageIn(room);

    await callTool(session, 'join_room', { room });
    const call = callTool(session, 'zoom_out');
    const command = await page.next();
    page.send({ type: MessageType.ACK, requestId: command.requestId, ok: true });

    expect(command.type).toBe(CommandType.ZOOM_OUT);
    expect(text(await call)).toBe('Zooming out');
  });

  it('join_room refuses a string that is not a room id', async () => {
    const result = await callTool(await newSession(), 'join_room', { room: 'not-a-room' });

    expect(result.isError).toBe(true);
  });
});
