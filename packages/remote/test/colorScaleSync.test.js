import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachRemote } from '../src/attachRemote.js';

// A room as the server keeps one: sync events go to every other page, and a joiner's
// requestSessionFromPeer is answered with the first other page's getSession result.
// Every hop is a microtask, as a network hop is a task.
function fakeRoom() {
  const sockets = [];
  const pendingCatchUps = new Map(); // requestId → the page that asked
  let nextRequest = 0;
  const deliver = (socket, msg) => queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(msg) }));

  function receive(from, msg) {
    const others = sockets.filter((s) => s !== from && s.readyState === 1);
    switch (msg.type) {
      case 'join':
        return deliver(from, { type: 'joined', room: msg.room });
      case 'syncEvent':
        return others.forEach((s) => deliver(s, msg));
      case 'requestSessionFromPeer': {
        if (!others.length) return deliver(from, { type: 'peerSessionData', error: 'No session available' });
        const requestId = `catch-up-${nextRequest++}`;
        pendingCatchUps.set(requestId, from);
        return deliver(others[0], { type: 'getSession', requestId });
      }
      case 'ack': {
        const asker = pendingCatchUps.get(msg.requestId);
        pendingCatchUps.delete(msg.requestId);
        if (asker) deliver(asker, { type: 'peerSessionData', session: msg.result });
        return;
      }
    }
  }

  return {
    sockets,
    createSocket() {
      const socket = {
        readyState: 0,
        sent: [],
        send(data) {
          const msg = JSON.parse(data);
          socket.sent.push(msg);
          receive(socket, msg);
        },
        close() {
          socket.readyState = 3;
        },
      };
      sockets.push(socket);
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.onopen?.({});
      });
      return socket;
    },
  };
}

const tick = () => Promise.resolve();

// juicebox.js's colour scale as far as a display-mode switch goes. A and B draw with one
// ColorScale whose threshold is kept per mode (ImageTileSource.thresholdCache); a mode with
// none yet gets the page's auto threshold, which depends on its viewport, so it differs
// between pages. setDisplayMode's render announces the new mode's threshold through
// onColorScaleChange, and only then does onDisplayModeChange fire (HICBrowser.setDisplayMode).
function fakeBrowser(autoThreshold, { displayMode, threshold }) {
  const subscribers = {};
  const fire = (name, payload) => {
    for (const fn of [...(subscribers[name] ?? [])]) fn({ ...payload, browser });
  };
  const thresholds = { [displayMode]: threshold };
  const colorScale = {
    threshold,
    getThreshold: () => colorScale.threshold,
    getColorComponents: () => ({ r: 255, g: 0, b: 0 }),
    setColorComponents: () => {},
  };

  // The tile source's #ensureColorScale.
  async function render() {
    await tick();
    const mode = browser.displayMode;
    if (thresholds[mode] === undefined) thresholds[mode] = autoThreshold[mode];
    if (colorScale.threshold === thresholds[mode]) return;
    colorScale.threshold = thresholds[mode];
    fire('onColorScaleChange', { colorScale });
  }

  const browser = {
    dataset: { url: 'https://maps.example/a.hic', name: 'A' },
    displayMode,
    coordinator: {
      addCallback(name, fn) {
        (subscribers[name] ??= []).push(fn);
        return () => subscribers[name].splice(subscribers[name].indexOf(fn), 1);
      },
    },
    getSyncState: () => ({ chr1Name: 'chr1', chr2Name: 'chr1', binSize: 5000, binX: 1, binY: 1 }),
    getDisplayMode: () => browser.displayMode,
    getColorScale: () => colorScale,
    setDisplayMode: vi.fn(async (mode) => {
      browser.displayMode = mode;
      await render();
      fire('onDisplayModeChange', { mode });
    }),
    setColorScaleThreshold: (t) => {
      colorScale.threshold = thresholds[browser.displayMode] = t;
      fire('onColorScaleChange', { colorScale });
      render(); // not awaited, as juicebox.js's is not
    },
    contactMatrixView: {
      setColorScale: (scale) => (thresholds[browser.displayMode] = scale.threshold),
    },
  };
  return browser;
}

/** A page's juicebox.js namespace: one browser, a session of its mode and threshold. */
function fakeHic(autoThreshold) {
  const subscribers = {};
  const bus = {
    subscribe: (type, fn) => (subscribers[type] ??= []).push(fn),
    unsubscribe: (type, fn) => (subscribers[type] = (subscribers[type] ?? []).filter((f) => f !== fn)),
    post: (type, data) => (subscribers[type] ?? []).forEach((fn) => fn({ type, data })),
  };
  const hic = {
    EventBus: { globalBus: bus },
    current: fakeBrowser(autoThreshold, { displayMode: 'A', threshold: autoThreshold.A }),
    getCurrentBrowser: () => hic.current,
    toJSON: () => {
      const { dataset, displayMode } = hic.current;
      const threshold = hic.current.getColorScale().getThreshold();
      return { browsers: [{ url: dataset.url, name: dataset.name, displayMode, threshold }] };
    },
    compressedSession: () => JSON.stringify(hic.toJSON()),
    restoreSession: vi.fn(async (container, session) => {
      await tick();
      const [{ displayMode, threshold }] = session.browsers;
      hic.current = fakeBrowser(autoThreshold, { displayMode, threshold });
      bus.post('BrowserSelect', hic.current);
    }),
  };
  return hic;
}

/** Let every hop and queued apply finish. */
async function settle() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

async function join(room, hic) {
  const remote = attachRemote({ hic, container: {}, url: 'wss://jbmcp.example/ws', room: 'r', createSocket: room.createSocket });
  await settle();
  return { remote, socket: room.sockets.at(-1) };
}

const viewOf = (hic) => ({ displayMode: hic.current.getDisplayMode(), threshold: hic.current.getColorScale().getThreshold() });
const syncEventsOf = (socket) => socket.sent.filter((m) => m.type === 'syncEvent');

// Two pages whose viewports give the same A threshold and different B ones.
const senderAutoThresholds = { A: 21.48, B: 16.77 };
const peerAutoThresholds = { A: 21.48, B: 12.5 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('colour scale across a display-mode switch', () => {
  it('the peer ends each switch on the sender’s threshold for the new mode', async () => {
    const room = fakeRoom();
    const sender = fakeHic(senderAutoThresholds);
    const peer = fakeHic(peerAutoThresholds);
    await join(room, sender);
    await join(room, peer);

    await sender.current.setDisplayMode('B');
    await settle();
    expect(viewOf(peer)).toEqual({ displayMode: 'B', threshold: 16.77 });

    await sender.current.setDisplayMode('A');
    await settle();
    expect(viewOf(peer)).toEqual({ displayMode: 'A', threshold: 21.48 });
  });

  it('applying them sends nothing back, not even the auto threshold the peer’s own switch computes', async () => {
    const room = fakeRoom();
    const sender = fakeHic(senderAutoThresholds);
    const peer = fakeHic(peerAutoThresholds);
    await join(room, sender);
    const { socket: peerSocket } = await join(room, peer);

    await sender.current.setDisplayMode('B');
    await settle();
    await sender.current.setDisplayMode('A');
    await settle();
    expect(syncEventsOf(peerSocket)).toEqual([]);
  });

  it('the peer switches once per switch of the sender’s', async () => {
    const room = fakeRoom();
    const sender = fakeHic(senderAutoThresholds);
    const peer = fakeHic(peerAutoThresholds);
    await join(room, sender);
    await join(room, peer);

    await sender.current.setDisplayMode('B');
    await settle();
    expect(peer.current.setDisplayMode.mock.calls).toEqual([['B']]);
  });

  it('a late joiner catching up from that peer gets the sender’s threshold', async () => {
    const room = fakeRoom();
    const sender = fakeHic(senderAutoThresholds);
    const peer = fakeHic(peerAutoThresholds);
    const { remote: senderRemote } = await join(room, sender);
    await join(room, peer);
    await sender.current.setDisplayMode('B');
    await settle();
    await sender.current.setDisplayMode('A');
    await settle();

    senderRemote.detach(); // the peer is the room's only live page
    const lateJoiner = fakeHic({ A: 9.9, B: 9.9 });
    await join(room, lateJoiner);
    expect(lateJoiner.restoreSession).toHaveBeenCalled();
    expect(viewOf(lateJoiner)).toEqual({ displayMode: 'A', threshold: 21.48 });
  });
});
