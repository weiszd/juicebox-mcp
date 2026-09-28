import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachRemote } from '../src/attachRemote.js';

// Minimal stand-in for the platform WebSocket: the test drives open/message.
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
}
FakeSocket.instances = [];

// Subscriber lists shaped like juicebox.js's: `fire`/`post` play the viewer
// announcing a change, `count` is what is still subscribed.
function fakeCoordinator() {
  const subscribers = {};
  return {
    addCallback(name, fn) {
      (subscribers[name] ??= []).push(fn);
      return () => {
        const i = subscribers[name].indexOf(fn);
        if (i > -1) subscribers[name].splice(i, 1);
      };
    },
    fire(name, payload) {
      for (const fn of [...(subscribers[name] ?? [])]) fn(payload);
    },
    count: () => Object.values(subscribers).flat().length,
  };
}

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
    count: () => Object.values(subscribers).flat().length,
  };
}

// A track pair whose setters post TrackXYPairChange, as juicebox.js's do.
function fakeTrackPair(bus, config) {
  const change = (property, value) => bus.post('TrackXYPairChange', { trackPair, property, value });
  const trackPair = {
    track: { name: config.name, config },
    setColor: vi.fn((color) => change('color', color)),
    setTrackLabelName: vi.fn((name) => change('name', name)),
    setDataRange: vi.fn((min, max) => change('dataRange', { min, max })),
    setAutoscale: vi.fn((on) => change('autoscale', on)),
    setLogScale: vi.fn((on) => change('logScale', on)),
  };
  return trackPair;
}

const tick = () => Promise.resolve();

// A browser whose surface calls announce themselves the way juicebox.js's do
// (async ones after an await), so a missing guard would show up as a sync event.
function fakeBrowser(bus) {
  const coordinator = fakeCoordinator();
  let rgb = { r: 255, g: 0, b: 0 };
  const colorScale = {
    threshold: 2000,
    getThreshold: () => colorScale.threshold,
    getColorComponents: () => ({ ...rgb }),
    setColorComponents: vi.fn((c) => (rgb = { ...c })),
  };
  const browser = {
    coordinator,
    colorScale,
    dataset: { url: 'https://maps.example/a.hic', name: 'A' },
    trackPairs: [],
    getSyncState: vi.fn(() => ({ chr1Name: 'chr1', chr2Name: 'chr1', binSize: 5000, binX: 10, binY: 10 })),
    syncState: vi.fn(async (state) => {
      await tick();
      coordinator.fire('onLocusChange', { state, changes: {}, browser });
    }),
    getColorScale: vi.fn(() => browser.colorScale),
    setColorScaleThreshold: vi.fn((t) => {
      browser.colorScale.threshold = t;
      coordinator.fire('onColorScaleChange', { colorScale: browser.colorScale, browser });
    }),
    setNormalization: vi.fn((normalization) => coordinator.fire('onNormalizationChange', { normalization, browser })),
    setDisplayMode: vi.fn(async (mode) => {
      await tick();
      coordinator.fire('onDisplayModeChange', { mode, browser });
    }),
    loadHicFile: vi.fn(async (config) => {
      await tick();
      browser.dataset = { url: config.url, name: config.name };
      coordinator.fire('onMapLoaded', { dataset: browser.dataset, browser });
    }),
    loadHicControlFile: vi.fn(async (config) => {
      await tick();
      browser.controlDataset = { url: config.url, name: config.name };
      coordinator.fire('onControlMapLoaded', { controlDataset: browser.controlDataset, browser });
    }),
    loadTracks: vi.fn(async (configs) => {
      await tick();
      for (const config of configs) {
        const trackPair = fakeTrackPair(bus, config);
        browser.trackPairs.push(trackPair);
        bus.post('TrackXYPairLoad', trackPair);
      }
    }),
    parseGotoInput: vi.fn(async () => {
      await tick();
      coordinator.fire('onLocusChange', { state: {}, changes: {}, browser });
    }),
    layoutController: {
      removeTrackXYPair: vi.fn((trackPair) => {
        browser.trackPairs.splice(browser.trackPairs.indexOf(trackPair), 1);
        bus.post('TrackXYPairRemoval', trackPair);
      }),
    },
    contactMatrixView: { setColorScale: vi.fn(), setBackgroundColor: vi.fn() },
  };
  return browser;
}

function fakeHic() {
  const bus = fakeBus();
  const hic = {
    EventBus: { globalBus: bus },
    current: fakeBrowser(bus),
    getCurrentBrowser: () => hic.current,
    restoreSession: vi.fn(async () => {}),
    bus,
    newBrowser: () => fakeBrowser(bus),
    addTrack: (config) => {
      const trackPair = fakeTrackPair(bus, config);
      hic.current.trackPairs.push(trackPair);
      return trackPair;
    },
  };
  return hic;
}

const syncEventsOf = (socket) => socket.sent.filter((m) => m.type === 'syncEvent');
const acksOf = (socket) => socket.sent.filter((m) => m.type === 'ack');

/** Let queued applies finish, then run past any locus debounce or throttle. */
async function settle() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
  vi.advanceTimersByTime(1000);
}

async function joined(hic) {
  const remote = attachRemote({ hic, container: {}, url: 'wss://jbmcp.example/ws', room: 'r',
    createSocket: (u) => new FakeSocket(u) });
  await Promise.resolve(); // the first connect is deferred to a microtask
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  socket.receive({ type: 'joined', room: 'r' });
  return { remote, socket };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sync events: §5.3 coordinator callbacks', () => {
  const signedScale = {
    positiveScale: {},
    getThreshold: () => 5,
    getColorComponents: (sign) => (sign === '-' ? { r: 0, g: 0, b: 255 } : { r: 255, g: 0, b: 0 }),
  };

  it.each([
    [
      'onColorScaleChange (one map)',
      'onColorScaleChange',
      (b) => ({ colorScale: b.colorScale, browser: b }),
      { syncType: 'colorScaleChange', threshold: 2000, r: 255, g: 0, b: 0 },
    ],
    [
      'onColorScaleChange (two-map signed scale)',
      'onColorScaleChange',
      (b) => ({ colorScale: signedScale, browser: b }),
      {
        syncType: 'colorScaleChange',
        threshold: 5,
        isRatio: true,
        positive: { r: 255, g: 0, b: 0 },
        negative: { r: 0, g: 0, b: 255 },
      },
    ],
    [
      'onForegroundColorChange (reads the edited scale)',
      'onForegroundColorChange',
      (b) => ({ rgb: { r: 255, g: 0, b: 0 }, type: '+', browser: b }),
      { syncType: 'colorScaleChange', threshold: 2000, r: 255, g: 0, b: 0 },
    ],
    [
      'onBackgroundColorChange',
      'onBackgroundColorChange',
      (b) => ({ rgb: { r: 1, g: 2, b: 3 }, browser: b }),
      { syncType: 'backgroundColorChange', color: { r: 1, g: 2, b: 3 } },
    ],
    [
      'onNormalizationChange',
      'onNormalizationChange',
      (b) => ({ normalization: 'KR', browser: b }),
      { syncType: 'normalizationChange', normalization: 'KR' },
    ],
    [
      'onNormalizationSubstituted (the effective one)',
      'onNormalizationSubstituted',
      (b) => ({ requested: 'KR', effective: 'VC', reason: 'KR is not available', browser: b }),
      { syncType: 'normalizationChange', normalization: 'VC' },
    ],
    [
      'onDisplayModeChange',
      'onDisplayModeChange',
      (b) => ({ mode: 'AOB', browser: b }),
      { syncType: 'displayModeChange', displayMode: 'AOB' },
    ],
    [
      'onMapLoaded (url and name off the dataset)',
      'onMapLoaded',
      (b) => ({ dataset: { url: 'https://maps.example/b.hic', name: 'B', extra: 1 }, datasetType: 'hic', browser: b }),
      { syncType: 'mapLoad', url: 'https://maps.example/b.hic', name: 'B' },
    ],
    [
      'onControlMapLoaded',
      'onControlMapLoaded',
      (b) => ({ controlDataset: { url: 'https://maps.example/ctl.hic', name: 'ctl' }, browser: b }),
      { syncType: 'controlMapLoad', url: 'https://maps.example/ctl.hic', name: 'ctl' },
    ],
  ])('%s → one sync event', async (_label, callback, payload, expected) => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.current.coordinator.fire(callback, payload(hic.current));
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', ...expected }]);
  });

  it('onLocusChange → locusChange carrying the browser sync state', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: hic.current });
    await settle();
    expect(syncEventsOf(socket)).toEqual([
      { type: 'syncEvent', syncType: 'locusChange', syncState: hic.current.getSyncState() },
    ]);
  });

  it('a map opened from a local file (no url) is not sent', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.current.coordinator.fire('onMapLoaded', { dataset: { name: 'local.hic' }, browser: hic.current });
    await settle();
    expect(syncEventsOf(socket)).toEqual([]);
  });
});

describe('sync events: §5.3 EventBus track events', () => {
  const config = { url: 'https://tracks.example/ctcf.bw', name: 'CTCF', format: 'bigwig' };

  it('TrackXYPairLoad → trackLoad {configs}', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('TrackXYPairLoad', fakeTrackPair(hic.bus, config));
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'trackLoad', configs: [config] }]);
  });

  it('TrackXYPairRemoval → trackRemove {track}', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('TrackXYPairRemoval', fakeTrackPair(hic.bus, config));
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'trackRemove', track: 'CTCF' }]);
  });

  it.each([
    ['color', '#ff0000', { syncType: 'trackColorChange', colorString: '#ff0000' }],
    ['dataRange', { min: 0, max: 10 }, { syncType: 'trackDataRangeChange', min: 0, max: 10 }],
    ['name', 'CTCF rep1', { syncType: 'trackNameChange', name: 'CTCF rep1' }],
    ['autoscale', false, { syncType: 'trackAutoscaleChange', enabled: false }],
    ['logScale', true, { syncType: 'trackLogScaleChange', enabled: true }],
  ])('TrackXYPairChange %s → one sync event naming the track', async (property, value, expected) => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('TrackXYPairChange', { trackPair: fakeTrackPair(hic.bus, config), property, value });
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', track: 'CTCF', ...expected }]);
  });

  it('after a rename, the track is named by its new name', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    const trackPair = fakeTrackPair(hic.bus, config);
    hic.bus.post('TrackXYPairChange', { trackPair, property: 'name', value: 'CTCF rep1' });
    hic.bus.post('TrackXYPairChange', { trackPair, property: 'color', value: 'blue' });
    await settle();
    expect(syncEventsOf(socket).map(({ syncType, track }) => [syncType, track])).toEqual([
      ['trackNameChange', 'CTCF'],
      ['trackColorChange', 'CTCF rep1'],
    ]);
  });

  it('an event for a property it does not know is not sent', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('TrackXYPairChange', { trackPair: fakeTrackPair(hic.bus, config), property: 'height', value: 40 });
    await settle();
    expect(syncEventsOf(socket)).toEqual([]);
  });
});

describe('sync events: applying a peer’s sync event', () => {
  const syncState = { chr1Name: 'chr2', chr2Name: 'chr2', binSize: 25000, binX: 3, binY: 4 };
  const trackConfig = { url: 'https://tracks.example/ctcf.bw', name: 'CTCF' };

  it.each([
    ['locusChange', { syncState }, (b) => expect(b.syncState).toHaveBeenCalledWith(syncState)],
    [
      'colorScaleChange',
      { threshold: 750, r: 0, g: 0, b: 255 },
      (b) => {
        expect(b.colorScale.setColorComponents).toHaveBeenCalledWith({ r: 0, g: 0, b: 255 });
        expect(b.contactMatrixView.setColorScale).toHaveBeenCalledWith(b.colorScale);
        expect(b.setColorScaleThreshold).toHaveBeenCalledWith(750);
      },
    ],
    [
      'backgroundColorChange',
      { color: { r: 1, g: 2, b: 3 } },
      (b) => expect(b.contactMatrixView.setBackgroundColor).toHaveBeenCalledWith({ r: 1, g: 2, b: 3 }),
    ],
    ['normalizationChange', { normalization: 'VC' }, (b) => expect(b.setNormalization).toHaveBeenCalledWith('VC')],
    ['displayModeChange', { displayMode: 'BOA' }, (b) => expect(b.setDisplayMode).toHaveBeenCalledWith('BOA')],
    [
      'mapLoad',
      { url: 'https://maps.example/b.hic', name: 'B' },
      (b) => expect(b.loadHicFile).toHaveBeenCalledWith({ url: 'https://maps.example/b.hic', name: 'B' }),
    ],
    [
      'controlMapLoad',
      { url: 'https://maps.example/ctl.hic', name: 'ctl' },
      (b) => expect(b.loadHicControlFile).toHaveBeenCalledWith({ url: 'https://maps.example/ctl.hic', name: 'ctl' }),
    ],
    ['trackLoad', { configs: [trackConfig] }, (b) => expect(b.loadTracks).toHaveBeenCalledWith([trackConfig])],
    [
      'trackRemove',
      { track: 'H3K27ac' },
      (b, tp) => expect(b.layoutController.removeTrackXYPair).toHaveBeenCalledWith(tp),
    ],
    ['trackColorChange', { track: 'H3K27ac', colorString: '#00ff00' }, (b, tp) => expect(tp.setColor).toHaveBeenCalledWith('#00ff00')],
    [
      'trackNameChange',
      { track: 'H3K27ac', name: 'H3K27ac rep2' },
      (b, tp) => {
        expect(tp.setTrackLabelName).toHaveBeenCalledWith('H3K27ac rep2');
        expect(tp.track.name).toBe('H3K27ac rep2');
      },
    ],
    [
      'trackDataRangeChange',
      { track: 'H3K27ac', min: 0, max: 50 },
      (b, tp) => expect(tp.setDataRange).toHaveBeenCalledWith(0, 50),
    ],
    ['trackAutoscaleChange', { track: 'H3K27ac', enabled: true }, (b, tp) => expect(tp.setAutoscale).toHaveBeenCalledWith(true)],
    ['trackLogScaleChange', { track: 'H3K27ac', enabled: true }, (b, tp) => expect(tp.setLogScale).toHaveBeenCalledWith(true)],
  ])('%s calls the surface and sends no sync event back', async (syncType, payload, check) => {
    const hic = fakeHic();
    const trackPair = hic.addTrack({ url: 'https://tracks.example/k27.bw', name: 'H3K27ac' });
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType, ...payload });
    await settle();
    check(hic.current, trackPair);
    expect(syncEventsOf(socket)).toEqual([]);
  });

  it('a two-map colour scale sets both signed components', async () => {
    const hic = fakeHic();
    hic.current.colorScale = { positiveScale: {}, setColorComponents: vi.fn(), getThreshold: () => 5 };
    const { socket } = await joined(hic);
    const positive = { r: 255, g: 0, b: 0 };
    const negative = { r: 0, g: 0, b: 255 };
    socket.receive({ type: 'syncEvent', syncType: 'colorScaleChange', threshold: 8, isRatio: true, positive, negative });
    await settle();
    expect(hic.current.colorScale.setColorComponents.mock.calls).toEqual([
      [positive, '+'],
      [negative, '-'],
    ]);
    expect(hic.current.setColorScaleThreshold).toHaveBeenCalledWith(8);
  });

  it('a colour scale for the other display-mode kind is ignored', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'colorScaleChange', threshold: 8, isRatio: true, positive: {}, negative: {} });
    await settle();
    expect(hic.current.colorScale.setColorComponents).not.toHaveBeenCalled();
    expect(hic.current.setColorScaleThreshold).not.toHaveBeenCalled();
  });

  it('a renamed track is found by its new name afterwards', async () => {
    const hic = fakeHic();
    const trackPair = hic.addTrack({ url: 'https://tracks.example/k27.bw', name: 'H3K27ac' });
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackNameChange', track: 'H3K27ac', name: 'K27' });
    socket.receive({ type: 'syncEvent', syncType: 'trackColorChange', track: 'K27', colorString: 'red' });
    await settle();
    expect(trackPair.setColor).toHaveBeenCalledWith('red');
  });

  it('an unknown track is dropped, and later sync events still apply', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackRemove', track: 'nope' });
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'KR' });
    await settle();
    expect(hic.current.layoutController.removeTrackXYPair).not.toHaveBeenCalled();
    expect(hic.current.setNormalization).toHaveBeenCalledWith('KR');
  });

  it('sync events apply in arrival order: a locusChange waits for a pending mapLoad', async () => {
    const hic = fakeHic();
    let finishLoad;
    hic.current.loadHicFile.mockImplementationOnce(() => new Promise((resolve) => (finishLoad = resolve)));
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'mapLoad', url: 'https://maps.example/b.hic' });
    socket.receive({ type: 'syncEvent', syncType: 'locusChange', syncState });
    await settle();
    expect(hic.current.syncState).not.toHaveBeenCalled();
    finishLoad();
    await settle();
    expect(hic.current.syncState).toHaveBeenCalledWith(syncState);
  });

  it('a change made by hand after an apply is sent again', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'VC' });
    await settle();
    hic.current.setNormalization('KR');
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'KR' }]);
  });

  it('an unknown syncType is ignored', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'teleport' });
    await settle();
    expect(socket.sent.filter((m) => m.type !== 'join')).toEqual([]);
  });
});

describe('sync events: commands', () => {
  it('what a command changes is not sent as a sync event (every page gets the command)', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'loadMap', requestId: 'c1', url: 'https://maps.example/b.hic', name: 'B' });
    socket.receive({ type: 'gotoLocus', requestId: 'c2', locus: 'chr2' });
    socket.receive({ type: 'setNormalization', requestId: 'c3', normalization: 'KR' });
    await settle();
    expect(acksOf(socket).map((a) => [a.requestId, a.ok])).toEqual([
      ['c1', true],
      ['c2', true],
      ['c3', true],
    ]);
    expect(syncEventsOf(socket)).toEqual([]);
  });
});

describe('sync events: locus rate limiting', () => {
  const locusEvents = (socket) => syncEventsOf(socket).filter((m) => m.syncType === 'locusChange');

  it('non-dragging changes are debounced: one event once they stop for 100 ms', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    const change = () => hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: hic.current });
    change();
    vi.advanceTimersByTime(50);
    change();
    vi.advanceTimersByTime(50);
    change();
    vi.advanceTimersByTime(99);
    expect(locusEvents(socket)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(locusEvents(socket)).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(locusEvents(socket)).toHaveLength(1);
  });

  it('dragging changes are throttled to one per 150 ms, and the last position is sent', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    const drag = () =>
      hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {}, dragging: true, browser: hic.current });
    drag();
    expect(locusEvents(socket)).toHaveLength(1); // leading edge
    for (let t = 20; t <= 400; t += 20) {
      vi.advanceTimersByTime(20);
      drag();
    }
    expect(locusEvents(socket)).toHaveLength(3); // t = 0, 150, 300
    vi.advanceTimersByTime(49);
    expect(locusEvents(socket)).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(locusEvents(socket)).toHaveLength(4); // t = 450: the drag's last position
    vi.advanceTimersByTime(1000);
    expect(locusEvents(socket)).toHaveLength(4);
  });

  it('the state sent is the one at send time', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: hic.current });
    hic.current.getSyncState.mockReturnValue({ chr1Name: 'chrX' });
    vi.advanceTimersByTime(100);
    expect(locusEvents(socket)).toEqual([{ type: 'syncEvent', syncType: 'locusChange', syncState: { chr1Name: 'chrX' } }]);
  });
});

describe('sync events: following the current browser', () => {
  it('BrowserSelect moves the callbacks to the new browser', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    const old = hic.current;
    hic.current = hic.newBrowser();
    hic.bus.post('BrowserSelect', hic.current);
    old.coordinator.fire('onNormalizationChange', { normalization: 'KR', browser: old });
    hic.current.coordinator.fire('onNormalizationChange', { normalization: 'VC', browser: hic.current });
    expect(old.coordinator.count()).toBe(0);
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'VC' }]);
  });

  it('attaching before any browser exists subscribes on the first BrowserSelect', async () => {
    const hic = fakeHic();
    const first = hic.current;
    hic.current = undefined;
    const { socket } = await joined(hic);
    hic.current = first;
    hic.bus.post('BrowserSelect', first);
    first.coordinator.fire('onDisplayModeChange', { mode: 'B', browser: first });
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'displayModeChange', displayMode: 'B' }]);
  });
});

describe('sync events: detach', () => {
  it('removes every coordinator callback and EventBus subscription', async () => {
    const hic = fakeHic();
    const { remote } = await joined(hic);
    expect(hic.current.coordinator.count()).toBe(9);
    expect(hic.bus.count()).toBe(4); // BrowserSelect + three track events
    remote.detach();
    expect(hic.current.coordinator.count()).toBe(0);
    expect(hic.bus.count()).toBe(0);
  });

  it('cancels a pending locus event', async () => {
    const hic = fakeHic();
    const { remote, socket } = await joined(hic);
    hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: hic.current });
    remote.detach();
    vi.advanceTimersByTime(1000);
    expect(syncEventsOf(socket)).toEqual([]);
  });

  it('an expired room drops the subscriptions too', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'error', code: 'room-expired' });
    expect(hic.current.coordinator.count()).toBe(0);
    expect(hic.bus.count()).toBe(0);
  });
});
