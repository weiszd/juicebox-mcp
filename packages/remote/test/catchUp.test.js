import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { attachRemote } from '../src/attachRemote.js';

// Minimal stand-in for the platform WebSocket: the test drives open/message/drop.
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
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

function fakeBus() {
  const subscribers = {};
  return {
    subscribe(type, fn) {
      (subscribers[type] ??= []).push(fn);
    },
    unsubscribe(type, fn) {
      subscribers[type] = (subscribers[type] ?? []).filter((f) => f !== fn);
    },
    post(type, data) {
      for (const fn of [...(subscribers[type] ?? [])]) fn({ type, data });
    },
  };
}

// A browser whose coordinator callbacks a test can fire, as juicebox.js's announce changes.
function fakeBrowser(dataset) {
  const subscribers = {};
  const browser = {
    dataset,
    coordinator: {
      addCallback(name, fn) {
        (subscribers[name] ??= []).push(fn);
        return () => subscribers[name].splice(subscribers[name].indexOf(fn), 1);
      },
      fire(name, payload) {
        for (const fn of [...(subscribers[name] ?? [])]) fn({ ...payload, browser });
      },
    },
    getSyncState: () => ({ chr1Name: 'chr1', chr2Name: 'chr1', binSize: 5000, binX: 1, binY: 1 }),
    setNormalization: vi.fn(),
  };
  return browser;
}

/** What hic.compressedSession() writes: `session=blob:` and the url-safe base64 of the raw-deflated JSON. */
const compress = (session) =>
  'session=blob:' +
  deflateRawSync(JSON.stringify(session)).toString('base64').replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-');

const sessionOf = (url) => ({ browsers: [{ url, name: url }] });
const pageSession = sessionOf('https://maps.example/page.hic');
const roomSession = sessionOf('https://maps.example/room.hic');

// A juicebox.js namespace whose restoreSession replaces the browser, as the real one
// does: BrowserSelect names the new one, and its map load and locus announce themselves.
function fakeHic({ mapLoaded = true } = {}) {
  const bus = fakeBus();
  const hic = {
    EventBus: { globalBus: bus },
    bus,
    current: fakeBrowser(mapLoaded ? { url: pageSession.browsers[0].url, name: 'page' } : undefined),
    session: mapLoaded ? pageSession : { browsers: [] },
    getCurrentBrowser: () => hic.current,
    compressedSession: vi.fn(() => compress(hic.session)),
    restoreSession: vi.fn(async (container, session) => {
      await Promise.resolve();
      hic.session = session;
      hic.current = fakeBrowser({ url: session.browsers[0].url, name: session.browsers[0].name });
      bus.post('BrowserSelect', hic.current);
      hic.current.coordinator.fire('onMapLoaded', { dataset: hic.current.dataset });
      hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {} });
    }),
  };
  return hic;
}

const container = {};

async function joined(hic) {
  const remote = attachRemote({ hic, container, url: 'wss://jbmcp.example/ws', room: 'r',
    createSocket: (u) => new FakeSocket(u) });
  await Promise.resolve(); // the first connect is deferred to a microtask
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  socket.receive({ type: 'joined', room: 'r' });
  return { remote, socket };
}

/** Let queued applies finish. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

const ofType = (socket, type) => socket.sent.filter((m) => m.type === type);
const savesOf = (socket) => ofType(socket, 'saveSession').map((m) => m.compressedSession);

/**
 * Wait until the room's answer has been handled, which the page's save loop starting marks.
 * A decompression runs off the microtask queue, so this waits in real time.
 */
const answered = () => vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('catch-up: after joined, the room’s state is asked for and applied', () => {
  it('asks the room for its state right after joined', async () => {
    const { socket } = await joined(fakeHic());
    expect(socket.sent).toEqual([{ type: 'join', room: 'r' }, { type: 'requestSessionFromPeer' }]);
  });

  it('a peer’s session is restored into the host container', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', session: roomSession });
    await settle();
    expect(hic.restoreSession).toHaveBeenCalledWith(container, roomSession);
  });

  it('a compressed session (the room’s saved session) is decompressed, then restored', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', compressedSession: compress(roomSession) });
    await answered();
    expect(hic.restoreSession).toHaveBeenCalledWith(container, roomSession);
  });

  it.each([
    ['an error (empty room)', { error: 'No session available' }],
    ['nothing', {}],
    ['a session with no map', { session: { browsers: [] } }],
    ['an unreadable compressed session', { compressedSession: 'session=blob:not-deflate' }],
  ])('with %s the page is left as is', async (_label, payload) => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', ...payload });
    await answered();
    expect(hic.restoreSession).not.toHaveBeenCalled();
  });

  it('what arrives after the room’s state applies to the restored page', async () => {
    const hic = fakeHic();
    const before = hic.current;
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', session: roomSession });
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'KR' });
    await settle();
    expect(before.setNormalization).not.toHaveBeenCalled();
    expect(hic.current.setNormalization).toHaveBeenCalledWith('KR');
  });

  it('asks once: a re-join after the answer does not ask again, nor is a second answer restored', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', error: 'No session available' });
    await settle();
    socket.drop();
    vi.advanceTimersByTime(1000);
    const again = FakeSocket.instances.at(-1);
    again.open();
    again.receive({ type: 'joined', room: 'r' });
    again.receive({ type: 'peerSessionData', session: roomSession });
    await settle();
    expect(ofType(again, 'requestSessionFromPeer')).toEqual([]);
    expect(hic.restoreSession).not.toHaveBeenCalled();
  });

  it('a re-join before any answer asks again', async () => {
    const { socket } = await joined(fakeHic());
    socket.drop();
    vi.advanceTimersByTime(1000);
    const again = FakeSocket.instances.at(-1);
    again.open();
    again.receive({ type: 'joined', room: 'r' });
    expect(ofType(again, 'requestSessionFromPeer')).toHaveLength(1);
  });
});

describe('saved session: the page saves its compressed session when it changed', () => {
  it('nothing is saved before the room has answered, so the page cannot overwrite the room’s state', async () => {
    const { socket } = await joined(fakeHic());
    vi.advanceTimersByTime(60_000);
    expect(savesOf(socket)).toEqual([]);
  });

  it('once answered: saved at once, then every 10 s only when it changed', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', error: 'No session available' });
    await settle();
    expect(savesOf(socket)).toEqual([compress(pageSession)]);
    vi.advanceTimersByTime(30_000);
    expect(savesOf(socket)).toHaveLength(1);
    hic.session = sessionOf('https://maps.example/changed.hic');
    vi.advanceTimersByTime(9_999);
    expect(savesOf(socket)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(savesOf(socket)).toEqual([compress(pageSession), compress(hic.session)]);
    vi.advanceTimersByTime(30_000);
    expect(savesOf(socket)).toHaveLength(2);
  });

  it('a page with no map saves nothing', async () => {
    const hic = fakeHic({ mapLoaded: false });
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', error: 'No session available' });
    await settle();
    vi.advanceTimersByTime(30_000);
    expect(savesOf(socket)).toEqual([]);
  });

  it('nothing is saved until the page is back in the room; a change made meanwhile is saved then', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', error: 'No session available' });
    await settle();
    socket.drop();
    hic.session = sessionOf('https://maps.example/changed.hic');
    vi.advanceTimersByTime(1000); // reconnects
    const again = FakeSocket.instances.at(-1);
    again.open();
    vi.advanceTimersByTime(10_000); // open, but not joined yet
    expect(savesOf(again)).toEqual([]);
    again.receive({ type: 'joined', room: 'r' });
    vi.advanceTimersByTime(10_000);
    expect(savesOf(again)).toEqual([compress(hic.session)]);
  });

  it.each([
    ['detach', (remote) => remote.detach()],
    ['expiry', (remote, socket) => socket.receive({ type: 'error', code: 'room-expired' })],
  ])('stops on %s', async (_label, end) => {
    const hic = fakeHic();
    const { remote, socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', error: 'No session available' });
    await settle();
    end(remote, socket);
    hic.session = sessionOf('https://maps.example/changed.hic');
    vi.advanceTimersByTime(60_000);
    expect(savesOf(socket)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a page detached while restoring does not start saving', async () => {
    const hic = fakeHic();
    let finishRestore;
    hic.restoreSession.mockImplementationOnce(() => new Promise((resolve) => (finishRestore = resolve)));
    const { remote, socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', session: roomSession });
    await settle();
    remote.detach();
    finishRestore();
    await settle();
    expect(savesOf(socket)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('snapshot then join: the page restored the session from a snapshot link before attaching', () => {
  it('room state present: the room’s session replaces the page’s, and is what the page saves', async () => {
    const hic = fakeHic(); // pageSession came from the snapshot link
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', compressedSession: compress(roomSession) });
    await answered();
    expect(hic.restoreSession).toHaveBeenCalledWith(container, roomSession);
    expect(savesOf(socket)).toEqual([compress(roomSession)]);
  });

  it('room empty: the page’s session becomes the room’s first saved session', async () => {
    const { socket } = await joined(fakeHic());
    socket.receive({ type: 'peerSessionData', error: 'No session available' });
    await settle();
    expect(socket.sent.slice(2)).toEqual([{ type: 'saveSession', compressedSession: compress(pageSession) }]);
  });

  it.each([
    ['its restore failed', { session: roomSession }, (hic) => hic.restoreSession.mockRejectedValueOnce(new Error('map failed'))],
    ['its saved session is unreadable', { compressedSession: 'session=blob:not-deflate' }, () => {}],
  ])('room state present but not shown (%s): the page does not overwrite it until the page changes', async (_label, payload, arrange) => {
    const hic = fakeHic();
    arrange(hic);
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', ...payload });
    await answered();
    vi.advanceTimersByTime(30_000);
    expect(savesOf(socket)).toEqual([]);
    hic.session = sessionOf('https://maps.example/changed.hic');
    vi.advanceTimersByTime(10_000);
    expect(savesOf(socket)).toEqual([compress(hic.session)]);
  });
});

describe('catch-up: the restore is guarded', () => {
  it('restoring the room’s state sends no sync event', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', session: roomSession });
    await settle();
    vi.advanceTimersByTime(1000); // past the locus debounce
    expect(hic.restoreSession).toHaveBeenCalled();
    expect(ofType(socket, 'syncEvent')).toEqual([]);
  });

  it('afterwards a change by hand on the restored browser is sent', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'peerSessionData', session: roomSession });
    await settle();
    hic.current.coordinator.fire('onNormalizationChange', { normalization: 'VC' });
    expect(ofType(socket, 'syncEvent')).toEqual([
      { type: 'syncEvent', syncType: 'normalizationChange', normalization: 'VC' },
    ]);
  });
});
