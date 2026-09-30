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

// A track pair whose setters post TrackXYPairChange, as juicebox.js's do. Setting
// `track.name` relabels the row, as igv's TrackBase setter does: the name first.
// It knows its browser, as juicebox.js's do.
function fakeTrackPair(bus, config, browser) {
  const change = (property, value) => bus.post('TrackXYPairChange', { trackPair, property, value });
  let name = config.name;
  const trackPair = {
    browser,
    track: {
      get name() {
        return name;
      },
      set name(n) {
        name = n;
        trackPair.setTrackLabelName(n);
      },
      config,
    },
    setColor: vi.fn((color) => change('color', color)),
    setTrackLabelName: vi.fn((name) => change('name', name)),
    setDataRange: vi.fn((min, max) => change('dataRange', { min, max })),
    setAutoscale: vi.fn((on) => change('autoscale', on)),
    setLogScale: vi.fn((on) => change('logScale', on)),
  };
  return trackPair;
}

const fakeTrack2D = (config) => ({ name: config.name, config });
const is2D = ({ url }) => url.endsWith('.bedpe');

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
    config: { width: 640, height: 480 },
    coordinator,
    colorScale,
    dataset: { url: 'https://maps.example/a.hic', name: 'A' },
    trackPairs: [],
    tracks2D: [],
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
    displayMode: 'A',
    getDisplayMode: () => browser.displayMode,
    setDisplayMode: vi.fn(async (mode) => {
      await tick();
      browser.displayMode = mode;
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
        if (is2D(config)) {
          const track2D = fakeTrack2D(config);
          browser.tracks2D = [...browser.tracks2D, track2D];
          bus.post('Track2DLoad', track2D);
        } else {
          const trackPair = fakeTrackPair(bus, config, browser);
          browser.trackPairs.push(trackPair);
          bus.post('TrackXYPairLoad', trackPair);
        }
      }
    }),
    // As juicebox.js's: the name or colour is set before the change is posted.
    removeTrack2D: vi.fn((track2D) => {
      if (!browser.tracks2D.includes(track2D)) return;
      browser.tracks2D = browser.tracks2D.filter((t) => t !== track2D);
      bus.post('Track2DRemoval', track2D);
    }),
    setTrack2DColor: vi.fn((track2D, color) => {
      track2D.color = color;
      bus.post('Track2DChange', { track2D, property: 'color', value: color });
    }),
    setTrack2DName: vi.fn((track2D, name) => {
      track2D.name = name;
      bus.post('Track2DChange', { track2D, property: 'name', value: name });
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

// `panels` browsers left to right, the last one current. createBrowser adds one on the
// right and setCurrentBrowser selects it, posting BrowserSelect, as juicebox.js's do.
function fakeHic({ panels = 1 } = {}) {
  const bus = fakeBus();
  const hic = {
    EventBus: { globalBus: bus },
    panels: Array.from({ length: panels }, () => fakeBrowser(bus)),
    current: undefined,
    getCurrentBrowser: () => hic.current,
    getAllBrowsers: () => [...hic.panels],
    setCurrentBrowser: vi.fn((browser) => {
      hic.current = browser;
      bus.post('BrowserSelect', browser);
    }),
    createBrowser: vi.fn(async () => {
      await tick();
      const browser = fakeBrowser(bus);
      browser.dataset = undefined;
      hic.panels.push(browser);
      return browser;
    }),
    restoreSession: vi.fn(async () => {}),
    bus,
    newBrowser: () => fakeBrowser(bus),
    deleteBrowser: vi.fn((browser) => hic.panels.splice(hic.panels.indexOf(browser), 1)),
    addTrack: (config, browser = hic.current) => {
      const trackPair = fakeTrackPair(bus, config, browser);
      browser.trackPairs.push(trackPair);
      return trackPair;
    },
    addTrack2D: (config) => {
      const track2D = fakeTrack2D(config);
      hic.current.tracks2D.push(track2D);
      return track2D;
    },
  };
  hic.current = hic.panels.at(-1);
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
      { syncType: 'colorScaleChange', displayMode: 'A', threshold: 2000, r: 255, g: 0, b: 0 },
    ],
    [
      'onColorScaleChange (two-map signed scale)',
      'onColorScaleChange',
      (b) => {
        b.displayMode = 'AOB';
        return { colorScale: signedScale, browser: b };
      },
      {
        syncType: 'colorScaleChange',
        displayMode: 'AOB',
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
      { syncType: 'colorScaleChange', displayMode: 'A', threshold: 2000, r: 255, g: 0, b: 0 },
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
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, ...expected }]);
  });

  it('onLocusChange → locusChange carrying the browser sync state', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.current.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: hic.current });
    await settle();
    expect(syncEventsOf(socket)).toEqual([
      { type: 'syncEvent', panel: 1, syncType: 'locusChange', syncState: hic.current.getSyncState() },
    ]);
  });

  it('a threshold typed into the colour-scale widget, which stores a string, is sent as a number', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.current.colorScale.threshold = '1234'; // juicebox.js keeps numberUnFormatter's output as typed
    hic.current.coordinator.fire('onColorScaleChange', { colorScale: hic.current.colorScale, browser: hic.current });
    await settle();
    expect(syncEventsOf(socket).map((e) => e.threshold)).toEqual([1234]);
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
    hic.bus.post('TrackXYPairLoad', fakeTrackPair(hic.bus, config, hic.current));
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'trackLoad', configs: [config] }]);
  });

  it('TrackXYPairRemoval → trackRemove {track}', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('TrackXYPairRemoval', fakeTrackPair(hic.bus, config, hic.current));
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'trackRemove', track: 'CTCF' }]);
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
    hic.bus.post('TrackXYPairChange', { trackPair: fakeTrackPair(hic.bus, config, hic.current), property, value });
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, track: 'CTCF', ...expected }]);
  });

  it('after a rename, the track is named by its new name', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    const trackPair = fakeTrackPair(hic.bus, config, hic.current);
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
    hic.bus.post('TrackXYPairChange', { trackPair: fakeTrackPair(hic.bus, config, hic.current), property: 'height', value: 40 });
    await settle();
    expect(syncEventsOf(socket)).toEqual([]);
  });
});

describe('sync events: §5.3 EventBus 2D-track events', () => {
  const config = { url: 'https://tracks.example/loops.bedpe', name: 'loops' };

  it('Track2DLoad → trackLoad {configs}', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('Track2DLoad', hic.addTrack2D(config));
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'trackLoad', configs: [config] }]);
  });

  it('a 2D track opened from a local file (no url) is not sent', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    hic.bus.post('Track2DLoad', hic.addTrack2D({ name: 'local.bedpe' }));
    await settle();
    expect(syncEventsOf(socket)).toEqual([]);
  });

  it('Track2DRemoval → trackRemove {track}', async () => {
    const hic = fakeHic();
    const track2D = hic.addTrack2D(config);
    const { socket } = await joined(hic);
    hic.current.removeTrack2D(track2D); // off the panel before the removal is posted, as juicebox.js's
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'trackRemove', track: 'loops' }]);
  });

  it.each([
    ['color', 'rgb(0,0,255)', { syncType: 'trackColorChange', colorString: 'rgb(0,0,255)' }],
    ['color', undefined, { syncType: 'trackColorChange' }], // the features' own colours back
    ['name', 'HiCCUPS loops', { syncType: 'trackNameChange', name: 'HiCCUPS loops' }],
  ])('Track2DChange %s %s → one sync event naming the track', async (property, value, expected) => {
    const hic = fakeHic();
    const track2D = hic.addTrack2D(config);
    const { socket } = await joined(hic);
    if (property === 'color') hic.current.setTrack2DColor(track2D, value);
    else hic.current.setTrack2DName(track2D, value);
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, track: 'loops', ...expected }]);
  });

  it('after a rename, the 2D track is named by its new name', async () => {
    const hic = fakeHic();
    const track2D = hic.addTrack2D(config);
    const { socket } = await joined(hic);
    hic.current.setTrack2DName(track2D, 'HiCCUPS loops');
    hic.current.setTrack2DColor(track2D, 'red');
    hic.current.removeTrack2D(track2D);
    await settle();
    expect(syncEventsOf(socket).map(({ syncType, track }) => [syncType, track])).toEqual([
      ['trackNameChange', 'loops'],
      ['trackColorChange', 'HiCCUPS loops'],
      ['trackRemove', 'HiCCUPS loops'],
    ]);
  });

  it('a track pair on the panel before attach, renamed by hand, is named by its old name', async () => {
    const hic = fakeHic();
    const trackPair = hic.addTrack({ url: 'https://tracks.example/k27.bw', name: 'H3K27ac' });
    const { socket } = await joined(hic);
    trackPair.track.name = 'K27'; // the track menu's rename
    await settle();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'trackNameChange', track: 'H3K27ac', name: 'K27' }]);
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
        expect(tp.track.name).toBe('H3K27ac rep2');
        expect(tp.setTrackLabelName.mock.calls).toEqual([['H3K27ac rep2']]); // once: through the name setter only
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

  it('a threshold that arrives as a string is applied as a number', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'colorScaleChange', threshold: '750', r: 0, g: 0, b: 255 });
    await settle();
    expect(hic.current.setColorScaleThreshold).toHaveBeenCalledWith(750);
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
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'normalizationChange', normalization: 'KR' }]);
  });

  it('an unknown syncType is ignored', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'teleport' });
    await settle();
    expect(socket.sent.filter((m) => !['join', 'requestSessionFromPeer'].includes(m.type))).toEqual([]);
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

// A loadTrack command or a restored session reaches every page, and each page's
// tracks finish loading after the guard lifts, so each page sends trackLoad for them.
describe('sync events: a track this page already has', () => {
  const ctcf = { url: 'https://tracks.example/ctcf.bw', name: 'CTCF' };
  const k27 = { url: 'https://tracks.example/k27.bw', name: 'H3K27ac' };

  it('a trackLoad for the url of a loaded track does not load it again', async () => {
    const hic = fakeHic();
    hic.addTrack(ctcf);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackLoad', configs: [ctcf] });
    await settle();
    expect(hic.current.loadTracks).not.toHaveBeenCalled();
  });

  it('nor of a pending one: the peer’s load of a loadTrack command finished first', async () => {
    const hic = fakeHic();
    // As juicebox.js's: the pending row, carrying its config, is there as soon as the load starts.
    hic.current.loadTracks.mockImplementationOnce((configs) => {
      hic.current.trackPairs.unshift(...configs.map((config) => ({ config, track: { name: config.name } })));
      return new Promise(() => {});
    });
    const { socket } = await joined(hic);
    socket.receive({ type: 'loadTrack', requestId: 'c1', url: ctcf.url, name: 'CTCF' });
    socket.receive({ type: 'syncEvent', syncType: 'trackLoad', configs: [{ ...ctcf, format: 'bigwig' }] });
    await settle();
    expect(acksOf(socket)).toEqual([
      { type: 'ack', requestId: 'c1', ok: true, result: 'panel 1 (A, undefined): ok' },
    ]);
    expect(hic.current.loadTracks).toHaveBeenCalledTimes(1);
  });

  it('only the configs whose url no track has are loaded', async () => {
    const hic = fakeHic();
    hic.addTrack(ctcf);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackLoad', configs: [ctcf, k27] });
    await settle();
    expect(hic.current.loadTracks.mock.calls).toEqual([[[k27]]]);
  });
});

describe('sync events: applying a peer’s sync event to a 2D track', () => {
  const loops = { url: 'https://tracks.example/loops.bedpe', name: 'loops' };

  it.each([
    ['trackRemove', { track: 'loops' }, (b, t) => expect(b.removeTrack2D).toHaveBeenCalledWith(t)],
    [
      'trackColorChange',
      { track: 'loops', colorString: 'rgb(0,255,0)' },
      (b, t) => expect(b.setTrack2DColor).toHaveBeenCalledWith(t, 'rgb(0,255,0)'),
    ],
    [
      'trackNameChange',
      { track: 'loops', name: 'HiCCUPS loops' },
      (b, t) => expect(b.setTrack2DName).toHaveBeenCalledWith(t, 'HiCCUPS loops'),
    ],
  ])('%s calls the browser’s 2D-track member and sends no sync event back', async (syncType, payload, check) => {
    const hic = fakeHic();
    const track2D = hic.addTrack2D(loops);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType, ...payload });
    await settle();
    check(hic.current, track2D);
    expect(syncEventsOf(socket)).toEqual([]);
  });

  it('trackLoad of a 2D track loads it and sends no sync event back', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackLoad', configs: [loops] });
    await settle();
    expect(hic.current.tracks2D.map((t) => t.config)).toEqual([loops]);
    expect(syncEventsOf(socket)).toEqual([]);
  });

  it('a renamed 2D track is found by its new name afterwards', async () => {
    const hic = fakeHic();
    const track2D = hic.addTrack2D(loops);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackNameChange', track: 'loops', name: 'L' });
    socket.receive({ type: 'syncEvent', syncType: 'trackColorChange', track: 'L', colorString: 'red' });
    await settle();
    expect(hic.current.setTrack2DColor).toHaveBeenCalledWith(track2D, 'red');
  });

  it('a track pair named like a 2D track is the one a peer’s sync event reaches', async () => {
    const hic = fakeHic();
    const trackPair = hic.addTrack({ url: 'https://tracks.example/loops.bw', name: 'loops' });
    hic.addTrack2D(loops);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackColorChange', track: 'loops', colorString: 'red' });
    await settle();
    expect(trackPair.setColor).toHaveBeenCalledWith('red');
    expect(hic.current.setTrack2DColor).not.toHaveBeenCalled();
  });

  it('a 1D-only sync event (data range) naming a 2D track is dropped', async () => {
    const hic = fakeHic();
    hic.addTrack2D(loops);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackDataRangeChange', track: 'loops', min: 0, max: 1 });
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'KR' });
    await settle();
    expect(hic.current.setNormalization).toHaveBeenCalledWith('KR');
  });
});

// A 2D track has no pending row, so a peer's trackLoad can arrive while this page's own
// load of the same track (from a loadTrack command or a restored session) is in flight.
describe('sync events: a 2D track this page already has', () => {
  const loops = { url: 'https://tracks.example/loops.bedpe', name: 'loops' };

  it('a trackLoad for the url of a loaded 2D track does not load it again', async () => {
    const hic = fakeHic();
    hic.addTrack2D(loops);
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'trackLoad', configs: [loops] });
    await settle();
    expect(hic.current.loadTracks).not.toHaveBeenCalled();
  });

  it('the second copy to arrive is removed, and peers hear of neither it nor its removal', async () => {
    const hic = fakeHic();
    const { current } = hic;
    let finishOwnLoad;
    current.loadTracks.mockImplementationOnce(async (configs) => {
      await new Promise((resolve) => (finishOwnLoad = resolve));
      for (const config of configs) {
        const track2D = fakeTrack2D(config);
        current.tracks2D = [...current.tracks2D, track2D];
        hic.bus.post('Track2DLoad', track2D);
      }
    });
    const { socket } = await joined(hic);
    socket.receive({ type: 'loadTrack', requestId: 'c1', url: loops.url, name: 'loops' });
    socket.receive({ type: 'syncEvent', syncType: 'trackLoad', configs: [loops] }); // the peer's finished first
    await settle();
    expect(current.tracks2D).toHaveLength(1);
    const first = current.tracks2D[0];
    finishOwnLoad();
    await settle();
    expect(current.tracks2D).toEqual([first]);
    expect(current.removeTrack2D).toHaveBeenCalledTimes(1);
    expect(syncEventsOf(socket)).toEqual([]);
  });

  it('a second 2D track loaded by hand with another url is sent as usual', async () => {
    const hic = fakeHic();
    hic.addTrack2D(loops);
    const { socket } = await joined(hic);
    const domains = { url: 'https://tracks.example/domains.bedpe', name: 'domains' };
    await hic.current.loadTracks([domains]);
    await settle();
    expect(hic.current.removeTrack2D).not.toHaveBeenCalled();
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'trackLoad', configs: [domains] }]);
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
    expect(locusEvents(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'locusChange', syncState: { chr1Name: 'chrX' } }]);
  });
});

describe('sync events: following the current browser', () => {
  it('BrowserSelect moves the callbacks to the new browser', async () => {
    const hic = fakeHic();
    const { socket } = await joined(hic);
    const old = hic.current;
    hic.current = hic.newBrowser(); // a restored session replaces the panel
    hic.panels = [hic.current];
    hic.bus.post('BrowserSelect', hic.current);
    old.coordinator.fire('onNormalizationChange', { normalization: 'KR', browser: old });
    hic.current.coordinator.fire('onNormalizationChange', { normalization: 'VC', browser: hic.current });
    expect(old.coordinator.count()).toBe(0);
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'normalizationChange', normalization: 'VC' }]);
  });

  it('attaching before any browser exists subscribes on the first BrowserSelect', async () => {
    const hic = fakeHic();
    const first = hic.current;
    hic.current = undefined;
    hic.panels = [];
    const { socket } = await joined(hic);
    hic.current = first;
    hic.panels = [first];
    hic.bus.post('BrowserSelect', first);
    first.coordinator.fire('onDisplayModeChange', { mode: 'B', browser: first });
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', panel: 1, syncType: 'displayModeChange', displayMode: 'B' }]);
  });
});

// Two pages in one room, each with two panels (ADR-0008): what one page sends is handed
// to the other's socket, as the room relays it.
describe('sync events: several panels', () => {
  const syncState = { chr1Name: 'chr2', chr2Name: 'chr2', binSize: 25000, binX: 3, binY: 4 };
  const relay = (from, to) => syncEventsOf(from).forEach((event) => to.receive(event));

  async function twoPages() {
    const a = fakeHic({ panels: 2 });
    const b = fakeHic({ panels: 2 });
    const pageA = await joined(a);
    const pageB = await joined(b);
    return { a, b, socketA: pageA.socket, socketB: pageB.socket };
  }

  it.each([
    ['locus', (p) => p.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: p }), (p) => p.syncState],
    ['colour scale', (p) => p.setColorScaleThreshold(900), (p) => p.setColorScaleThreshold],
    ['normalization', (p) => p.setNormalization('KR'), (p) => p.setNormalization],
  ])('a %s change in panel 2 reaches panel 2 on the peer, not panel 1', async (_label, change, surface) => {
    const { a, b, socketA, socketB } = await twoPages();
    change(a.panels[1]);
    await settle();
    expect(syncEventsOf(socketA).map((e) => e.panel)).toEqual([2]);
    relay(socketA, socketB);
    await settle();
    expect(surface(b.panels[1])).toHaveBeenCalled();
    expect(surface(b.panels[0])).not.toHaveBeenCalled();
    expect(syncEventsOf(socketB)).toEqual([]);
  });

  it('a track change in panel 2 reaches the track of that name in panel 2 on the peer', async () => {
    const config = { url: 'https://tracks.example/ctcf.bw', name: 'CTCF' };
    const a = fakeHic({ panels: 2 });
    const b = fakeHic({ panels: 2 });
    const tracksA = a.panels.map((p) => a.addTrack(config, p));
    const tracksB = b.panels.map((p) => b.addTrack(config, p));
    const { socket: socketA } = await joined(a);
    const { socket: socketB } = await joined(b);
    tracksA[1].setColor('#00ff00');
    await settle();
    expect(syncEventsOf(socketA)).toEqual([
      { type: 'syncEvent', syncType: 'trackColorChange', panel: 2, track: 'CTCF', colorString: '#00ff00' },
    ]);
    relay(socketA, socketB);
    await settle();
    expect(tracksB[1].setColor).toHaveBeenCalledWith('#00ff00');
    expect(tracksB[0].setColor).not.toHaveBeenCalled();
  });

  it('a 2D track change names the panel holding the track', async () => {
    const hic = fakeHic({ panels: 2 });
    const track2D = fakeTrack2D({ url: 'https://tracks.example/loops.bedpe', name: 'loops' });
    hic.panels[0].tracks2D.push(track2D);
    const { socket } = await joined(hic);
    hic.panels[0].setTrack2DColor(track2D, 'red');
    hic.panels[0].removeTrack2D(track2D);
    await settle();
    expect(syncEventsOf(socket).map(({ syncType, panel }) => [syncType, panel])).toEqual([
      ['trackColorChange', 1],
      ['trackRemove', 1],
    ]);
  });

  it('one drag in panels synced within the page sends one locusChange per panel', async () => {
    const hic = fakeHic({ panels: 2 });
    const { socket } = await joined(hic);
    for (const p of hic.panels) p.coordinator.fire('onLocusChange', { state: {}, changes: {}, browser: p });
    await settle();
    expect(syncEventsOf(socket).map(({ syncType, panel }) => [syncType, panel])).toEqual([
      ['locusChange', 1],
      ['locusChange', 2],
    ]);
  });

  it('an event for a position this page lacks is dropped, and later ones still apply', async () => {
    const hic = fakeHic({ panels: 2 });
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', panel: 3, normalization: 'KR' });
    socket.receive({ type: 'syncEvent', syncType: 'locusChange', panel: 3, syncState });
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', panel: 1, normalization: 'VC' });
    await settle();
    expect(hic.panels[1].setNormalization).not.toHaveBeenCalled();
    expect(hic.panels[0].setNormalization.mock.calls).toEqual([['VC']]);
    expect(hic.createBrowser).not.toHaveBeenCalled();
  });

  it('a mapLoad for one past the last position opens that panel, loads the map there and is followed', async () => {
    const hic = fakeHic({ panels: 2 });
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'mapLoad', panel: 3, url: 'https://maps.example/b.hic', name: 'B' });
    await settle();
    expect(hic.createBrowser).toHaveBeenCalledWith(expect.anything(), { width: 640, height: 480 });
    expect(hic.panels).toHaveLength(3);
    const created = hic.panels[2];
    expect(hic.setCurrentBrowser).toHaveBeenCalledWith(created);
    expect(created.loadHicFile).toHaveBeenCalledWith({ url: 'https://maps.example/b.hic', name: 'B' });
    expect(syncEventsOf(socket)).toEqual([]);
    created.setNormalization('KR');
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'normalizationChange', panel: 3, normalization: 'KR' }]);
  });

  it('a mapLoad two past the last position is dropped', async () => {
    const hic = fakeHic({ panels: 2 });
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'mapLoad', panel: 4, url: 'https://maps.example/b.hic' });
    await settle();
    expect(hic.createBrowser).not.toHaveBeenCalled();
    expect(hic.panels.map((p) => p.loadHicFile.mock.calls.length)).toEqual([0, 0]);
  });

  it('an event without panel (a remote from before ADR-0008) goes to the current panel', async () => {
    const hic = fakeHic({ panels: 2 });
    hic.current = hic.panels[0];
    const { socket } = await joined(hic);
    socket.receive({ type: 'syncEvent', syncType: 'normalizationChange', normalization: 'KR' });
    await settle();
    expect(hic.panels[0].setNormalization).toHaveBeenCalledWith('KR');
    expect(hic.panels[1].setNormalization).not.toHaveBeenCalled();
  });

  it('a panel added after attach and selected (BrowserSelect) is followed', async () => {
    const hic = fakeHic({ panels: 2 });
    const { socket } = await joined(hic);
    const added = hic.newBrowser();
    hic.panels.push(added); // juicebox-web's clone button: create, then select
    hic.setCurrentBrowser(added);
    added.setNormalization('KR');
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'normalizationChange', panel: 3, normalization: 'KR' }]);
  });

  it('a panel opened by a command is followed, and one closed by a command is dropped', async () => {
    const hic = fakeHic({ panels: 2 });
    const { socket } = await joined(hic);
    const [first] = hic.panels;
    socket.receive({ type: 'loadMap', requestId: 'c1', panel: 'new', url: 'https://maps.example/b.hic', name: 'B' });
    socket.receive({ type: 'closePanel', requestId: 'c2', panel: 1 });
    await settle();
    expect(acksOf(socket).map((a) => [a.requestId, a.ok])).toEqual([
      ['c1', true],
      ['c2', true],
    ]);
    expect(first.coordinator.count()).toBe(0);
    hic.panels[1].setNormalization('KR'); // the new one, now second
    expect(syncEventsOf(socket)).toEqual([{ type: 'syncEvent', syncType: 'normalizationChange', panel: 2, normalization: 'KR' }]);
  });
});

describe('sync events: detach', () => {
  it('removes every coordinator callback and EventBus subscription', async () => {
    const hic = fakeHic();
    const { remote } = await joined(hic);
    expect(hic.current.coordinator.count()).toBe(9);
    expect(hic.bus.count()).toBe(7); // BrowserSelect + three track-pair events + three 2D-track events
    remote.detach();
    expect(hic.current.coordinator.count()).toBe(0);
    expect(hic.bus.count()).toBe(0);
  });

  it('removes the callbacks from every panel', async () => {
    const hic = fakeHic({ panels: 2 });
    const { remote } = await joined(hic);
    expect(hic.panels.map((p) => p.coordinator.count())).toEqual([9, 9]);
    remote.detach();
    expect(hic.panels.map((p) => p.coordinator.count())).toEqual([0, 0]);
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
