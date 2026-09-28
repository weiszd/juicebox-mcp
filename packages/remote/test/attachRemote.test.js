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

// Stand-in for the juicebox.js namespace: one current browser whose public
// surface members are spies. `mapLoaded: false` models a page with no map yet.
function fakeHic({ mapLoaded = true } = {}) {
  const colorScale = {
    threshold: 2000,
    getThreshold() {
      return this.threshold;
    },
    setColorComponents: vi.fn(),
  };
  const browser = {
    dataset: mapLoaded ? { url: 'https://maps.example/a.hic' } : undefined,
    controlDataset: undefined,
    coordinator: { addCallback: () => () => {} }, // sync events are covered in syncEvents.test.js
    loadHicFile: vi.fn(async (config) => {
      browser.dataset = { url: config.url };
    }),
    loadHicControlFile: vi.fn(async (config) => {
      browser.controlDataset = { url: config.url };
    }),
    parseGotoInput: vi.fn(async () => {}),
    zoomAndCenter: vi.fn(async () => {}),
    getColorScale: vi.fn(() => colorScale),
    setColorScaleThreshold: vi.fn(),
    setNormalization: vi.fn(),
    setDisplayMode: vi.fn(async () => {}),
    getDisplayMode: vi.fn(() => 'A'),
    contactMatrixView: {
      setColorScale: vi.fn(),
      setBackgroundColor: vi.fn(),
      viewportElement: { clientWidth: 800, clientHeight: 600 },
    },
  };
  return {
    EventBus: { globalBus: { subscribe() {}, unsubscribe() {} } },
    getCurrentBrowser: vi.fn(() => browser),
    restoreSession: vi.fn(async () => {}),
    browser,
    colorScale,
  };
}

const hic = fakeHic();
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

const acksOf = (socket) => socket.sent.filter((m) => m.type === 'ack');

/** Attach to a joined room with the given fake `hic`; `send(cmd)` resolves to that command's ack. */
async function joinedWith(fake) {
  const { socket } = await attach({ hic: fake, room: 'r' });
  const s = socket();
  s.open();
  s.receive({ type: 'joined', room: 'r' });
  const send = async (cmd) => {
    s.receive(cmd);
    // Commands are async and queued; allow a generous number of microtask turns for the ack.
    for (let i = 0; i < 50; i++) {
      const ack = acksOf(s).find((a) => a.requestId === cmd.requestId);
      if (ack) return ack;
      await Promise.resolve();
    }
    throw new Error(`no ack for ${cmd.requestId}`);
  };
  return { socket: s, send };
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

describe('attachRemote: view commands', () => {
  it('gotoLocus calls parseGotoInput with the locus and acks ok', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'gotoLocus', requestId: 'q1', locus: 'chr1:10mb-20mb' });
    expect(fake.browser.parseGotoInput).toHaveBeenCalledWith('chr1:10mb-20mb');
    expect(ack).toEqual({ type: 'ack', requestId: 'q1', ok: true });
  });
});

describe('attachRemote: command failures', () => {
  it('a view command before any map is loaded acks ok:false without calling the surface', async () => {
    const fake = fakeHic({ mapLoaded: false });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'gotoLocus', requestId: 'q2', locus: 'chr1' });
    expect(ack).toEqual({ type: 'ack', requestId: 'q2', ok: false, error: 'No map loaded' });
    expect(fake.browser.parseGotoInput).not.toHaveBeenCalled();
  });

  it('an unknown command type acks ok:false naming the type', async () => {
    const { send } = await joinedWith(fakeHic());
    const ack = await send({ type: 'launchRocket', requestId: 'q3' });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/launchRocket/);
  });

  it('a surface call that rejects acks ok:false with its message, and later commands still apply', async () => {
    const fake = fakeHic();
    fake.browser.parseGotoInput.mockRejectedValueOnce(new Error('Unrecognized locus: chrZ'));
    const { send } = await joinedWith(fake);
    expect(await send({ type: 'gotoLocus', requestId: 'q4', locus: 'chrZ' })).toEqual({
      type: 'ack',
      requestId: 'q4',
      ok: false,
      error: 'Unrecognized locus: chrZ',
    });
    expect((await send({ type: 'gotoLocus', requestId: 'q5', locus: 'chr1' })).ok).toBe(true);
  });

  it('a surface call that throws synchronously acks ok:false', async () => {
    const fake = fakeHic();
    fake.browser.setNormalization.mockImplementation(() => {
      throw new Error('disposed');
    });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setNormalization', requestId: 'q6', normalization: 'KR' });
    expect(ack).toEqual({ type: 'ack', requestId: 'q6', ok: false, error: 'disposed' });
  });

  it('a non-command message carrying a requestId (e.g. an ack) is not acked back', async () => {
    const { socket, send } = await joinedWith(fakeHic());
    socket.receive({ type: 'ack', requestId: 'echo', ok: true });
    await send({ type: 'zoomIn', requestId: 'after' }); // drains the queue
    expect(acksOf(socket).map((a) => a.requestId)).toEqual(['after']);
  });

  it('a command without a requestId gets no ack and no surface call', async () => {
    const fake = fakeHic();
    const { socket, send } = await joinedWith(fake);
    socket.receive({ type: 'gotoLocus', locus: 'chr1' });
    await send({ type: 'zoomIn', requestId: 'after' }); // drains the queue
    expect(fake.browser.parseGotoInput).not.toHaveBeenCalled();
    expect(acksOf(socket).map((a) => a.requestId)).toEqual(['after']);
  });
});

describe('attachRemote: §5.2 view command rows', () => {
  it('loadMap calls loadHicFile with the map config, even with no map loaded yet', async () => {
    const fake = fakeHic({ mapLoaded: false });
    const { send } = await joinedWith(fake);
    const cmd = { url: 'https://maps.example/b.hic', name: 'B', normalization: 'KR', locus: 'chr1 chr1' };
    const ack = await send({ type: 'loadMap', requestId: 'm1', ...cmd });
    expect(fake.browser.loadHicFile).toHaveBeenCalledWith(cmd);
    expect(ack).toEqual({ type: 'ack', requestId: 'm1', ok: true });
  });

  it('loadControlMap with a base map present loads it and sets display mode AOB', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const cmd = { url: 'https://maps.example/ctl.hic', name: 'ctl', normalization: 'VC' };
    const ack = await send({ type: 'loadControlMap', requestId: 'c1', ...cmd });
    expect(fake.browser.loadHicControlFile).toHaveBeenCalledWith(cmd);
    expect(fake.browser.setDisplayMode).toHaveBeenCalledWith('AOB');
    expect(fake.browser.loadHicControlFile.mock.invocationCallOrder[0]).toBeLessThan(
      fake.browser.setDisplayMode.mock.invocationCallOrder[0],
    );
    expect(ack.ok).toBe(true);
  });

  it('loadControlMap without a base map leaves the display mode alone', async () => {
    const fake = fakeHic({ mapLoaded: false });
    const { send } = await joinedWith(fake);
    await send({ type: 'loadControlMap', requestId: 'c2', url: 'https://maps.example/ctl.hic' });
    expect(fake.browser.loadHicControlFile).toHaveBeenCalled();
    expect(fake.browser.setDisplayMode).not.toHaveBeenCalled();
  });

  it('loadControlMap does not re-set AOB when already in AOB', async () => {
    const fake = fakeHic();
    fake.browser.getDisplayMode.mockReturnValue('AOB');
    const { send } = await joinedWith(fake);
    await send({ type: 'loadControlMap', requestId: 'c3', url: 'https://maps.example/ctl.hic' });
    expect(fake.browser.setDisplayMode).not.toHaveBeenCalled();
  });

  it('loadSession restores the session into the host container', async () => {
    const fake = fakeHic({ mapLoaded: false });
    const { send } = await joinedWith(fake);
    const session = { browsers: [{ url: 'https://maps.example/a.hic' }] };
    const ack = await send({ type: 'loadSession', requestId: 's1', sessionData: session });
    expect(fake.restoreSession).toHaveBeenCalledWith(container, session);
    expect(ack.ok).toBe(true);
  });

  it('zoomIn / zoomOut call zoomAndCenter(±1) at the given centre', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    await send({ type: 'zoomIn', requestId: 'z1', centerX: 10, centerY: 20 });
    await send({ type: 'zoomOut', requestId: 'z2', centerX: 30, centerY: 40 });
    expect(fake.browser.zoomAndCenter.mock.calls).toEqual([
      [1, 10, 20],
      [-1, 30, 40],
    ]);
  });

  it('zoomIn without a centre zooms about the middle of the map viewport', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'zoomIn', requestId: 'z3' });
    expect(fake.browser.zoomAndCenter).toHaveBeenCalledWith(1, 400, 300);
    expect(ack.ok).toBe(true);
  });

  it('setForegroundColor sets the colour components, then re-sets the current threshold to repaint', async () => {
    const fake = fakeHic(); // threshold 2000
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setForegroundColor', requestId: 'f1', color: { r: 255, g: 0, b: 0 } });
    expect(fake.colorScale.setColorComponents).toHaveBeenCalledWith({ r: 255, g: 0, b: 0 });
    expect(fake.browser.contactMatrixView.setColorScale).toHaveBeenCalledWith(fake.colorScale);
    expect(fake.browser.setColorScaleThreshold).toHaveBeenCalledWith(2000);
    expect(fake.colorScale.setColorComponents.mock.invocationCallOrder[0]).toBeLessThan(
      fake.browser.setColorScaleThreshold.mock.invocationCallOrder[0],
    );
    expect(ack.ok).toBe(true);
  });

  it('setForegroundColor with a threshold also sets the threshold', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    await send({ type: 'setForegroundColor', requestId: 'f2', color: { r: 0, g: 0, b: 255 }, threshold: 750 });
    expect(fake.colorScale.setColorComponents).toHaveBeenCalledWith({ r: 0, g: 0, b: 255 });
    expect(fake.browser.setColorScaleThreshold).toHaveBeenCalledWith(750);
  });

  it('setBackgroundColor sets the matrix background', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setBackgroundColor', requestId: 'b1', color: { r: 1, g: 2, b: 3 } });
    expect(fake.browser.contactMatrixView.setBackgroundColor).toHaveBeenCalledWith({ r: 1, g: 2, b: 3 });
    expect(ack.ok).toBe(true);
  });

  it('setColorScale sets, doubles or halves the threshold', async () => {
    const fake = fakeHic(); // threshold 2000
    const { send } = await joinedWith(fake);
    await send({ type: 'setColorScale', requestId: 't1', action: 'set', value: 500 });
    await send({ type: 'setColorScale', requestId: 't2', action: 'increase' });
    await send({ type: 'setColorScale', requestId: 't3', action: 'decrease' });
    expect(fake.browser.setColorScaleThreshold.mock.calls).toEqual([[500], [4000], [1000]]);
  });

  it('setNormalization sets the normalization', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setNormalization', requestId: 'n1', normalization: 'VC_SQRT' });
    expect(fake.browser.setNormalization).toHaveBeenCalledWith('VC_SQRT');
    expect(ack.ok).toBe(true);
  });

  it('commands apply in arrival order: gotoLocus waits for a pending loadMap', async () => {
    const fake = fakeHic({ mapLoaded: false });
    let finishLoad;
    fake.browser.loadHicFile.mockImplementationOnce(
      (config) =>
        new Promise((resolve) => {
          finishLoad = () => {
            fake.browser.dataset = { url: config.url };
            resolve();
          };
        }),
    );
    const { socket, send } = await joinedWith(fake);
    socket.receive({ type: 'loadMap', requestId: 'o1', url: 'https://maps.example/a.hic' });
    socket.receive({ type: 'gotoLocus', requestId: 'o2', locus: 'chr2' });
    await flush();
    expect(acksOf(socket)).toEqual([]);
    finishLoad();
    const ack = await send({ type: 'zoomIn', requestId: 'o3', centerX: 1, centerY: 1 });
    expect(ack.ok).toBe(true);
    expect(acksOf(socket).map((a) => [a.requestId, a.ok])).toEqual([
      ['o1', true],
      ['o2', true],
      ['o3', true],
    ]);
  });
});
