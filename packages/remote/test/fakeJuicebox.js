import { vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';

/**
 * One fake juicebox.js for every remote spec: the `hic` namespace attachRemote is
 * given, and the platform WebSocket it is given a factory for. The surface is what
 * the remote touches (src/applyCommand.js, src/observe.js, src/panels.js, src/attachRemote.js);
 * a new viewer method goes here, once. Every method is a spy.
 *
 * hic (fakeHic): EventBus.globalBus {subscribe, unsubscribe}, getCurrentBrowser,
 *   getAllBrowsers, setCurrentBrowser, createBrowser, deleteBrowser (absent with
 *   `deleteBrowser: false`), restoreSession, toJSON, compressedSession.
 * browser: config, registry.delete, dataset, controlDataset, state {chr1, getLocus},
 *   coordinator.addCallback, getSyncState, syncState, parseGotoInput, zoomAndCenter,
 *   loadHicFile, loadHicControlFile, setNormalization, getDisplayMode, setDisplayMode,
 *   colorScale / getColorScale {getThreshold, getColorComponents, setColorComponents},
 *   setColorScaleThreshold, contactMatrixView {setColorScale, setBackgroundColor,
 *   viewportElement, getViewDimensions}, trackPairs, tracks2D, loadTracks,
 *   layoutController.removeTrackXYPair, removeTrack2D, setTrack2DColor, setTrack2DName.
 * track pair (fakeTrackPair): browser, track {name, config}, setColor, setTrackLabelName,
 *   setDataRange, setAutoscale, setLogScale.
 * 2D track (fakeTrack2D): name, color, config.
 *
 * Test helpers, not juicebox.js: on hic `bus` {post, count}, `browsers`, `current`,
 * `session`, `newBrowser`, `clone`, `addTrack`, `addTrack2D`; on a coordinator `fire`, `count`.
 */

export const tick = () => Promise.resolve();

/** The map a default panel shows. */
export const MAP_A = { url: 'https://maps.example/a.hic', name: 'A' };

/** Minimal stand-in for the platform WebSocket: the test drives open/message/close. */
export class FakeSocket {
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

/** What hic.compressedSession() writes: `session=blob:` and the url-safe base64 of the raw-deflated JSON. */
export const compress = (session) =>
  'session=blob:' +
  deflateRawSync(JSON.stringify(session)).toString('base64').replace(/\+/g, '.').replace(/\//g, '_').replace(/=/g, '-');

// Subscriber lists shaped like juicebox.js's: `fire`/`post` play the viewer
// announcing a change, `count` is what is still subscribed.
function fakeCoordinator(browser) {
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
      for (const fn of [...(subscribers[name] ?? [])]) fn({ browser, ...payload });
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

// The global bus each browser posts to; a track pair finds it through its browser.
const busOf = new WeakMap();

/** A loaded map: `{url, name, genome}` (any of them may be missing). */
const fakeDataset = ({ url, name, genome }) => ({ url, name, genomeId: genome, isWholeGenome: (chr) => chr === 0 });

/**
 * A 1D track pair, named by a string (its config is then `{url}` of a .bw) or by a
 * track config. `look` is spread onto the track (color, dataRange, …). Setting
 * `track.name` relabels the row, as igv's TrackBase setter does: the name first.
 * Its setters post TrackXYPairChange, as juicebox.js's do, once it has a browser.
 */
export function fakeTrackPair(nameOrConfig, look = {}, browser) {
  const config = typeof nameOrConfig === 'string' ? { url: `https://tracks.example/${nameOrConfig}.bw` } : nameOrConfig;
  let name = typeof nameOrConfig === 'string' ? nameOrConfig : config.name;
  const change = (property, value) => busOf.get(trackPair.browser)?.post('TrackXYPairChange', { trackPair, property, value });
  const trackPair = {
    browser,
    track: {
      ...look,
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
    setTrackLabelName: vi.fn((n) => change('name', n)),
    setDataRange: vi.fn((min, max) => change('dataRange', { min, max })),
    setAutoscale: vi.fn((on) => change('autoscale', on)),
    setLogScale: vi.fn((on) => change('logScale', on)),
  };
  return trackPair;
}

/** A 2D track, named by a string (its config is then `{url}` of a .bedpe) or by a track config. */
export const fakeTrack2D = (nameOrConfig, color) =>
  typeof nameOrConfig === 'string'
    ? { name: nameOrConfig, color, config: { url: `https://tracks.example/${nameOrConfig}.bedpe` } }
    : { name: nameOrConfig.name, color, config: nameOrConfig };

const is2D = ({ url }) => url.endsWith('.bedpe');

/**
 * One panel's browser. `entry` is the map it shows (`{url, name, genome}`, a session's
 * browser entry, or null/`{}` for none), with an optional `displayMode` and `threshold`.
 *
 * With `autoThreshold` ({A, B, …}), the colour scale is modelled as far as a display-mode
 * switch goes: A and B draw with one ColorScale whose threshold is kept per mode
 * (ImageTileSource.thresholdCache); a mode with none yet gets the page's auto threshold,
 * which depends on its viewport, so it differs between pages. setDisplayMode's render
 * announces the new mode's threshold through onColorScaleChange, and only then does
 * onDisplayModeChange fire (HICBrowser.setDisplayMode).
 */
function fakeBrowser(bus, { entry, config = { width: 640, height: 480 }, registry, autoThreshold }) {
  const displayMode = entry?.displayMode ?? 'A';
  const threshold = entry?.threshold ?? autoThreshold?.[displayMode] ?? 2000;
  const thresholds = { [displayMode]: threshold };
  let rgb = { r: 255, g: 0, b: 0 };
  const colorScale = {
    threshold,
    getThreshold: () => colorScale.threshold,
    getColorComponents: () => ({ ...rgb }),
    setColorComponents: vi.fn((c) => (rgb = { ...c })),
  };

  // The tile source's #ensureColorScale.
  async function render() {
    await tick();
    if (!autoThreshold) return;
    const mode = browser.displayMode;
    if (thresholds[mode] === undefined) thresholds[mode] = autoThreshold[mode];
    if (browser.colorScale.threshold === thresholds[mode]) return;
    browser.colorScale.threshold = thresholds[mode];
    coordinator.fire('onColorScaleChange', { colorScale: browser.colorScale });
  }

  const browser = {
    config,
    registry,
    dataset: entry?.url || entry?.name ? fakeDataset(entry) : undefined,
    controlDataset: undefined,
    state: {
      chr1: 8,
      getLocus: () => ({
        x: { chr: 'chr8', start: 127_000_000, end: 129_000_000 },
        y: { chr: 'chr8', start: 127_000_000, end: 129_000_000 },
      }),
    },
    colorScale,
    displayMode,
    trackPairs: [],
    tracks2D: [],
    getSyncState: vi.fn(() => ({ chr1Name: 'chr1', chr2Name: 'chr1', binSize: 5000, binX: 10, binY: 10 })),
    syncState: vi.fn(async (state) => {
      await tick();
      coordinator.fire('onLocusChange', { state, changes: {} });
    }),
    parseGotoInput: vi.fn(async () => {
      await tick();
      coordinator.fire('onLocusChange', { state: {}, changes: {} });
    }),
    zoomAndCenter: vi.fn(async () => {}),
    getColorScale: vi.fn(() => browser.colorScale),
    setColorScaleThreshold: vi.fn((t) => {
      browser.colorScale.threshold = thresholds[browser.displayMode] = t;
      coordinator.fire('onColorScaleChange', { colorScale: browser.colorScale });
      render(); // not awaited, as juicebox.js's is not
    }),
    setNormalization: vi.fn((normalization) => coordinator.fire('onNormalizationChange', { normalization })),
    getDisplayMode: vi.fn(() => browser.displayMode),
    setDisplayMode: vi.fn(async (mode) => {
      browser.displayMode = mode;
      await render();
      coordinator.fire('onDisplayModeChange', { mode });
    }),
    loadHicFile: vi.fn(async ({ url, name }) => {
      await tick();
      browser.dataset = fakeDataset({ url, name, genome: 'mm10' });
      coordinator.fire('onMapLoaded', { dataset: browser.dataset });
    }),
    loadHicControlFile: vi.fn(async ({ url, name }) => {
      await tick();
      browser.controlDataset = { url, name };
      coordinator.fire('onControlMapLoaded', { controlDataset: browser.controlDataset });
    }),
    loadTracks: vi.fn(async (configs) => {
      await tick();
      for (const config of configs) {
        if (is2D(config)) {
          const track2D = fakeTrack2D(config);
          browser.tracks2D = [...browser.tracks2D, track2D];
          bus.post('Track2DLoad', track2D);
        } else {
          const trackPair = fakeTrackPair(config, {}, browser);
          browser.trackPairs.push(trackPair);
          bus.post('TrackXYPairLoad', trackPair);
        }
      }
    }),
    layoutController: {
      removeTrackXYPair: vi.fn((trackPair) => {
        browser.trackPairs.splice(browser.trackPairs.indexOf(trackPair), 1);
        bus.post('TrackXYPairRemoval', trackPair);
      }),
    },
    removeTrack2D: vi.fn((track2D) => {
      if (!browser.tracks2D.includes(track2D)) return;
      browser.tracks2D = browser.tracks2D.filter((t) => t !== track2D);
      bus.post('Track2DRemoval', track2D);
    }),
    // As juicebox.js's: the name or colour is set before the change is posted.
    setTrack2DColor: vi.fn((track2D, color) => {
      track2D.color = color;
      bus.post('Track2DChange', { track2D, property: 'color', value: color });
    }),
    setTrack2DName: vi.fn((track2D, name) => {
      track2D.name = name;
      bus.post('Track2DChange', { track2D, property: 'name', value: name });
    }),
    contactMatrixView: {
      setColorScale: vi.fn((scale) => (thresholds[browser.displayMode] = scale.threshold)),
      setBackgroundColor: vi.fn(),
      viewportElement: { clientWidth: 800, clientHeight: 600 },
      getViewDimensions: () => ({ width: 800, height: 600 }),
    },
  };
  const coordinator = fakeCoordinator(browser);
  browser.coordinator = coordinator;
  busOf.set(browser, bus);
  return browser;
}

/**
 * A juicebox.js namespace (the surface is in the header).
 *
 * @param {object} [opts]
 * @param {number|Array<object|null>} [opts.panels=1]  the panels left to right, the last one
 *   current: a count of panels showing MAP_A, or one entry per panel, `{url, name, genome}`
 *   for a panel with a map, `null` for one without
 * @param {Array} [opts.trackPairs]  the current panel's track pairs (fakeTrackPair)
 * @param {Array} [opts.tracks2D]  the current panel's 2D tracks (fakeTrack2D)
 * @param {object} [opts.autoThreshold]  per display mode, the page's auto threshold;
 *   turns on the per-mode colour scale (see fakeBrowser), recorded in the session
 * @param {string} [opts.selectedGene]  recorded in the session
 * @param {boolean} [opts.deleteBrowser=true]  false: no hic.deleteBrowser (juicebox.js 4.7.0)
 */
export function fakeHic({ panels = 1, trackPairs, tracks2D, autoThreshold, selectedGene, deleteBrowser = true } = {}) {
  const bus = fakeBus();
  // Browsers share one registry, as juicebox.js's do.
  const registry = {
    delete: vi.fn((browser) => {
      hic.browsers.splice(hic.browsers.indexOf(browser), 1);
      if (hic.current === browser) hic.current = hic.browsers[0];
    }),
  };
  const newBrowser = (entry, config) => fakeBrowser(bus, { entry, config, registry, autoThreshold });
  const entries = typeof panels === 'number' ? Array.from({ length: panels }, () => MAP_A) : panels;

  const hic = {
    EventBus: { globalBus: bus },
    bus,
    browsers: entries.map((entry) => newBrowser(entry)),
    current: undefined,
    getCurrentBrowser: () => hic.current,
    getAllBrowsers: () => [...hic.browsers],
    setCurrentBrowser: vi.fn((browser) => {
      hic.current = browser;
      bus.post('BrowserSelect', browser);
    }),
    createBrowser: vi.fn(async (container, config) => {
      await tick();
      const browser = newBrowser(null, config);
      hic.browsers.push(browser);
      bus.post('BrowserAdd', browser);
      return browser;
    }),
    restoreSession: vi.fn(async (container, session) => {
      await tick();
      hic.browsers = session.browsers.map((entry) => newBrowser(entry));
      hic.setCurrentBrowser(hic.browsers[0]);
      for (const browser of hic.browsers.filter((b) => b.dataset)) {
        browser.coordinator.fire('onMapLoaded', { dataset: browser.dataset });
        browser.coordinator.fire('onLocusChange', { state: {}, changes: {} });
      }
    }),
    toJSON: vi.fn(() => ({
      browsers: hic.browsers
        .filter((b) => b.dataset?.url)
        .map((b) => ({
          url: b.dataset.url,
          name: b.dataset.name,
          ...(autoThreshold ? { displayMode: b.displayMode, threshold: b.colorScale.getThreshold() } : {}),
        })),
      ...(selectedGene ? { selectedGene } : {}),
    })),
    compressedSession: vi.fn(() => compress(hic.toJSON())),
    get session() {
      return hic.toJSON();
    },
    set session(session) {
      hic.browsers = session.browsers.map((entry) => newBrowser(entry));
      hic.current = hic.browsers[0];
    },
    newBrowser: () => newBrowser(MAP_A),
    /** juicebox-web's clone button: an empty panel on the right, selected. */
    clone: async () => {
      const browser = await hic.createBrowser();
      hic.setCurrentBrowser(browser);
      return browser;
    },
    addTrack: (config, browser = hic.current) => {
      const trackPair = fakeTrackPair(config, {}, browser);
      browser.trackPairs.push(trackPair);
      return trackPair;
    },
    addTrack2D: (config) => {
      const track2D = fakeTrack2D(config);
      hic.current.tracks2D.push(track2D);
      return track2D;
    },
  };
  if (deleteBrowser) {
    hic.deleteBrowser = vi.fn((browser) => {
      bus.post('BrowserDelete', browser);
      hic.browsers.splice(hic.browsers.indexOf(browser), 1);
      if (hic.current === browser) hic.setCurrentBrowser(hic.browsers[0]);
    });
  }
  hic.current = hic.browsers.at(-1);
  if (trackPairs) hic.current.trackPairs = trackPairs.map((tp) => Object.assign(tp, { browser: tp.browser ?? hic.current }));
  if (tracks2D) hic.current.tracks2D = tracks2D;
  return hic;
}
