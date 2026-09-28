// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://juicebox.example/app/?x=1"}
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachRemote, Status } from '../src/attachRemote.js';

// Minimal stand-in for the platform WebSocket: the test drives open/message/close.
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
  // Test helpers (server side of the wire)
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '', wasClean: false });
  }
}
FakeSocket.instances = [];

const hic = {}; // the namespace is passed through; this ticket touches none of it
const container = {};
const url = 'wss://jbmcp.example/ws';

const flush = () => Promise.resolve(); // the first connect is deferred to a microtask

async function attach(extra = {}) {
  const onStatus = vi.fn();
  const onToolCall = vi.fn();
  const remote = attachRemote({
    hic,
    container,
    url,
    onStatus,
    onToolCall,
    createSocket: (u) => new FakeSocket(u),
    ...extra,
  });
  await flush();
  return { remote, onStatus, onToolCall, socket: () => FakeSocket.instances.at(-1) };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('attachRemote: join', () => {
  it('reports connecting only after attachRemote has returned', async () => {
    const onStatus = vi.fn();
    const remote = attachRemote({ hic, container, url, onStatus, createSocket: (u) => new FakeSocket(u) });
    expect(onStatus).not.toHaveBeenCalled();
    await flush();
    expect(onStatus).toHaveBeenCalledWith(Status.CONNECTING);
    remote.detach();
  });

  it('connects with ?room= and sends join {room} when a room is given', async () => {
    const { socket, onStatus } = await attach({ room: 'c0ffee1234' });
    expect(onStatus).toHaveBeenCalledWith('connecting');
    expect(socket().url).toBe('wss://jbmcp.example/ws?room=c0ffee1234');
    socket().open();
    expect(socket().sent).toEqual([{ type: 'join', room: 'c0ffee1234' }]);
  });

  it('connects without ?room= and sends a bare join when no room is given', async () => {
    const { socket } = await attach();
    expect(socket().url).toBe(url);
    socket().open();
    expect(socket().sent).toEqual([{ type: 'join' }]);
  });

  it('becomes open on joined and exposes the (minted) room and joinUrl', async () => {
    const { remote, socket, onStatus } = await attach();
    expect(remote.room).toBeUndefined();
    expect(remote.joinUrl).toBeUndefined();
    socket().open();
    socket().receive({ type: 'joined', room: 'ABCDEFGH23' });
    expect(onStatus).toHaveBeenLastCalledWith('open');
    expect(remote.room).toBe('ABCDEFGH23');
    expect(remote.joinUrl).toBe('https://juicebox.example/app/?x=1&room=ABCDEFGH23');
  });

  it('reports expired on error {code: room-expired} and stops reconnecting', async () => {
    const { remote, socket, onStatus } = await attach({ room: 'gone000000' });
    socket().open();
    socket().receive({ type: 'error', code: 'room-expired' });
    expect(onStatus).toHaveBeenLastCalledWith('expired');
    expect(socket().closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(remote.room).toBeUndefined();
  });

  it('ignores an error without a code', async () => {
    const { socket, onStatus } = await attach({ room: 'r' });
    socket().open();
    socket().receive({ type: 'joined', room: 'r' });
    socket().receive({ type: 'error', message: 'something' });
    expect(onStatus).toHaveBeenLastCalledWith('open');
  });
});

describe('attachRemote: reconnect', () => {
  it('reports closed on a drop, then reconnects and re-sends join with the known room', async () => {
    const { socket, onStatus } = await attach();
    socket().open();
    socket().receive({ type: 'joined', room: 'MINTED0001' });
    const first = socket();
    first.drop();
    expect(onStatus).toHaveBeenLastCalledWith('closed');

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = socket();
    expect(second).not.toBe(first);
    expect(second.url).toBe('wss://jbmcp.example/ws?room=MINTED0001');
    expect(onStatus).toHaveBeenLastCalledWith('connecting');
    second.open();
    expect(second.sent).toEqual([{ type: 'join', room: 'MINTED0001' }]);
    second.receive({ type: 'joined', room: 'MINTED0001' });
    expect(onStatus).toHaveBeenLastCalledWith('open');
  });

  it('a socket that errors before opening is retried', async () => {
    const { socket } = await attach({ room: 'r' });
    socket().onerror?.({});
    socket().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('attachRemote: detach', () => {
  it('closes the socket, reports closed, and does not reconnect', async () => {
    const { remote, socket, onStatus } = await attach({ room: 'r' });
    socket().open();
    socket().receive({ type: 'joined', room: 'r' });
    remote.detach();
    expect(socket().closed).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('after expired, detach is a no-op and does not report closed', async () => {
    const { remote, socket, onStatus } = await attach({ room: 'gone000000' });
    socket().open();
    socket().receive({ type: 'error', code: 'room-expired' });
    remote.detach();
    expect(onStatus).toHaveBeenLastCalledWith('expired');
  });

  it('cancels a pending reconnect', async () => {
    const { remote, socket } = await attach({ room: 'r' });
    socket().drop();
    remote.detach();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('is idempotent and ignores messages after detach', async () => {
    const { remote, socket, onStatus, onToolCall } = await attach({ room: 'r' });
    socket().open();
    remote.detach();
    remote.detach();
    socket().receive({ type: 'toolCall', name: 'load_map' });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.filter(([s]) => s === 'closed')).toHaveLength(1);
  });
});

describe('attachRemote: messages', () => {
  it('toolCall {name} invokes onToolCall(name)', async () => {
    const { socket, onToolCall } = await attach({ room: 'r' });
    socket().open();
    socket().receive({ type: 'toolCall', name: 'goto_locus' });
    expect(onToolCall).toHaveBeenCalledWith('goto_locus');
  });

  it('tolerates malformed JSON and unknown message types', async () => {
    const { socket, onStatus } = await attach({ room: 'r' });
    socket().open();
    socket().onmessage({ data: '{not json' });
    socket().receive({ type: 'whatever' });
    socket().receive(null);
    expect(onStatus).toHaveBeenLastCalledWith('connecting');
  });

  it('works without onStatus / onToolCall', async () => {
    const remote = attachRemote({ hic, container, url, room: 'r', createSocket: (u) => new FakeSocket(u) });
    await flush();
    const s = FakeSocket.instances.at(-1);
    s.open();
    s.receive({ type: 'joined', room: 'r' });
    s.receive({ type: 'toolCall', name: 'x' });
    expect(remote.room).toBe('r');
    remote.detach();
  });
});

describe('attachRemote: arguments', () => {
  it('requires hic, container and url', () => {
    expect(() => attachRemote({ container, url })).toThrow(/hic/);
    expect(() => attachRemote({ hic, url })).toThrow(/container/);
    expect(() => attachRemote({ hic, container })).toThrow(/url/);
  });
});
