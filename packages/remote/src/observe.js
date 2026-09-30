import { MessageType, SyncEventType } from './protocol.js';
import { newPanel } from './applyCommand.js';

// While dragging, at most one locusChange per LOCUS_THROTTLE_MS, and the drag's
// last position always goes out; otherwise one once changes stop for LOCUS_DEBOUNCE_MS.
const LOCUS_THROTTLE_MS = 150;
const LOCUS_DEBOUNCE_MS = 100;

/**
 * Send a sync event for each change made on this page, and apply peers' sync
 * events to it. Design §5.3.
 *
 * Follows every panel: coordinator callbacks are subscribed on each browser in
 * `hic.getAllBrowsers()`, and the list is scanned again on `BrowserSelect` and on
 * `rescan()` (juicebox.js announces no panel's creation or closing; every way a panel
 * is created selects it, ADR-0008). Every sync event carries `panel`, the sender's
 * 1-based position, and a peer's is applied to the panel at that position.
 * Changes made while `guard` runs are not sent, so applying a peer's sync event
 * or a command does not echo back. Applies must run one at a time.
 *
 * Payload shapes are the prototype's (`src/Application.js` on branch `prototype`).
 *
 * @param {object} hic                  the juicebox.js namespace
 * @param {Element} container           passed to hic.createBrowser for a peer's new panel
 * @param {(msg: object) => void} send  sends one message to the room
 */
export function observe(hic, container, send) {
  const bus = hic.EventBus.globalBus;
  let guarded = false;
  let detached = false;
  // Each followed browser: its callbacks' unsubscribers and its locus rate limiting.
  const followed = new Map();

  // The name a track pair or 2D track had when peers last heard of it: a rename's
  // event carries only the new one, and the track already has it.
  const trackNames = new WeakMap();
  const nameOf = (track) => trackNames.get(track) ?? (track.track ?? track).name;
  const dropped = new WeakSet(); // duplicate 2D tracks being removed, whose removal peers are not told of
  // A 2D track has no browser of its own and is off its panel by the time its removal is posted.
  const panelOf2D = new WeakMap();

  /** A browser's 1-based position from the left, what list_panels prints; 0 once it is closed. */
  const positionOf = (browser) => hic.getAllBrowsers().indexOf(browser) + 1;

  /** Send a change made in `browser`'s panel; one in no open panel has no position to name. */
  const emit = (browser, syncType, payload) => {
    if (guarded) return;
    const panel = positionOf(browser);
    if (panel) send({ type: MessageType.SYNC_EVENT, syncType, panel, ...payload });
  };

  const emitMapLoad = (browser, syncType, dataset) => {
    // A map opened from a local file has no URL a peer could load.
    if (typeof dataset?.url === 'string') emit(browser, syncType, { url: dataset.url, name: dataset.name });
  };

  /** The coordinator callbacks for one browser: each change is sent as that browser's panel. */
  const callbacksFor = (browser) => ({
    // juicebox.js 4.6.0 does not pass `dragging` to callbacks yet, so until it does every change is debounced.
    onLocusChange: ({ dragging }) => locusChanged(browser, dragging),
    onColorScaleChange: ({ colorScale }) =>
      emit(browser, SyncEventType.COLOR_SCALE_CHANGE, colorScalePayload(colorScale, browser)),
    // The colour picker edits the scale in place without firing onColorScaleChange.
    onForegroundColorChange: () =>
      emit(browser, SyncEventType.COLOR_SCALE_CHANGE, colorScalePayload(browser.getColorScale(), browser)),
    onBackgroundColorChange: ({ rgb }) => emit(browser, SyncEventType.BACKGROUND_COLOR_CHANGE, { color: rgb }),
    onNormalizationChange: ({ normalization }) =>
      emit(browser, SyncEventType.NORMALIZATION_CHANGE, { normalization }),
    // A peer mirrors what is drawn, not what was asked for (juicebox.js ADR-0012).
    onNormalizationSubstituted: ({ effective }) =>
      emit(browser, SyncEventType.NORMALIZATION_CHANGE, { normalization: effective }),
    onDisplayModeChange: ({ mode }) => emit(browser, SyncEventType.DISPLAY_MODE_CHANGE, { displayMode: mode }),
    onMapLoaded: ({ dataset }) => emitMapLoad(browser, SyncEventType.MAP_LOAD, dataset),
    onControlMapLoaded: ({ controlDataset }) =>
      emitMapLoad(browser, SyncEventType.CONTROL_MAP_LOAD, controlDataset),
  });

  const trackChanges = {
    color: (colorString) => [SyncEventType.TRACK_COLOR_CHANGE, { colorString }],
    dataRange: ({ min, max }) => [SyncEventType.TRACK_DATA_RANGE_CHANGE, { min, max }],
    name: (name) => [SyncEventType.TRACK_NAME_CHANGE, { name }],
    autoscale: (enabled) => [SyncEventType.TRACK_AUTOSCALE_CHANGE, { enabled }],
    logScale: (enabled) => [SyncEventType.TRACK_LOG_SCALE_CHANGE, { enabled }],
  };

  // Global EventBus handlers; each receives `{type, data}`.
  const busHandlers = {
    // A new panel is selected when it is created, and a restored session's panels replace the old ones.
    BrowserSelect: () => rescan(),
    TrackXYPairLoad: ({ data: trackPair }) => {
      trackNames.set(trackPair, trackPair.track.name);
      const { config } = trackPair.track;
      if (typeof config?.url === 'string') emit(trackPair.browser, SyncEventType.TRACK_LOAD, { configs: [config] });
    },
    TrackXYPairRemoval: ({ data: trackPair }) =>
      emit(trackPair.browser, SyncEventType.TRACK_REMOVE, { track: nameOf(trackPair) }),
    TrackXYPairChange: ({ data: { trackPair, property, value } }) =>
      trackChanged(trackPair.browser, trackPair, property, value),
    Track2DLoad: ({ data: track2D }) => {
      const browser = browserOf2D(track2D);
      const { config } = track2D;
      const url = config?.url;
      // A 2D track has no pending row, so a peer's trackLoad for one still loading here
      // loads it again (a loadTrack command or a restored session reaches every page):
      // the second copy to arrive goes.
      const tracks2D = browser?.tracks2D ?? [];
      const held = typeof url === 'string' && tracks2D.some((t) => t !== track2D && t.config?.url === url);
      if (held && tracks2D.includes(track2D)) {
        dropped.add(track2D);
        browser.removeTrack2D(track2D);
        return;
      }
      trackNames.set(track2D, track2D.name);
      if (typeof url === 'string') emit(browser, SyncEventType.TRACK_LOAD, { configs: [config] });
    },
    Track2DRemoval: ({ data: track2D }) => {
      if (!dropped.delete(track2D)) emit(browserOf2D(track2D), SyncEventType.TRACK_REMOVE, { track: nameOf(track2D) });
    },
    Track2DChange: ({ data: { track2D, property, value } }) =>
      trackChanged(browserOf2D(track2D), track2D, property, value),
  };

  /** The browser whose panel holds, or last held, a 2D track. */
  function browserOf2D(track2D) {
    const browser = hic.getAllBrowsers().find((b) => b.tracks2D?.includes(track2D)) ?? panelOf2D.get(track2D);
    if (browser) panelOf2D.set(track2D, browser);
    return browser;
  }

  const appliers = {
    [SyncEventType.LOCUS_CHANGE]: (browser, { syncState }) => browser.syncState(syncState),
    [SyncEventType.COLOR_SCALE_CHANGE]: async (browser, { displayMode, threshold, isRatio, positive, negative, r, g, b }) => {
      // A switch announces the new mode's threshold before the mode (juicebox.js's render inside
      // setDisplayMode fires onColorScaleChange), and A and B keep a threshold each, so the scale
      // goes to the mode it was sent from.
      if (displayMode && browser.getDisplayMode() !== displayMode) await browser.setDisplayMode(displayMode);
      const colorScale = browser.getColorScale();
      // One-map and two-map scales do not mix.
      if (Boolean(isRatio) !== isSigned(colorScale)) return;
      if (isRatio) {
        colorScale.setColorComponents(positive, '+');
        colorScale.setColorComponents(negative, '-');
      } else {
        colorScale.setColorComponents({ r, g, b });
      }
      browser.contactMatrixView.setColorScale(colorScale);
      await browser.setColorScaleThreshold(Number(threshold)); // also invalidates the tiles, so it repaints
    },
    [SyncEventType.BACKGROUND_COLOR_CHANGE]: (browser, { color: { r, g, b } }) =>
      browser.contactMatrixView.setBackgroundColor({ r, g, b }),
    [SyncEventType.NORMALIZATION_CHANGE]: (browser, { normalization }) => browser.setNormalization(normalization),
    // The colorScaleChange sent ahead of it has usually switched this page already.
    [SyncEventType.DISPLAY_MODE_CHANGE]: async (browser, { displayMode }) => {
      if (browser.getDisplayMode() !== displayMode) await browser.setDisplayMode(displayMode);
    },
    [SyncEventType.MAP_LOAD]: (browser, { url, name }) => browser.loadHicFile({ url, name }),
    [SyncEventType.CONTROL_MAP_LOAD]: (browser, { url, name }) => browser.loadHicControlFile({ url, name }),
    [SyncEventType.TRACK_LOAD]: (browser, { configs }) => {
      // A url a track pair already carries (a pending one its own config, a loaded one its track's)
      // is not loaded again: a loadTrack command or a restored session reaches every page, and each
      // page's tracks load after the guard lifts (ADR-0017), so every page sends trackLoad for them.
      const held = new Set([
        ...browser.trackPairs.map(({ track, config = track.config }) => config?.url),
        ...browser.tracks2D.map(({ config }) => config?.url),
      ]);
      const toLoad = configs.filter(({ url }) => !held.has(url));
      // Resolves once every track has loaded, so their load events fall inside the guard.
      if (toLoad.length) return browser.loadTracks(toLoad);
    },
    [SyncEventType.TRACK_REMOVE]: (browser, { track }) => {
      const { trackPair, track2D } = trackNamed(browser, track);
      if (track2D) browser.removeTrack2D(track2D);
      else browser.layoutController.removeTrackXYPair(trackPair);
    },
    [SyncEventType.TRACK_COLOR_CHANGE]: (browser, { track, colorString }) => {
      const { trackPair, track2D } = trackNamed(browser, track);
      if (track2D) browser.setTrack2DColor(track2D, colorString);
      else trackPair.setColor(colorString);
    },
    [SyncEventType.TRACK_NAME_CHANGE]: (browser, { track, name }) => {
      const { trackPair, track2D } = trackNamed(browser, track);
      if (track2D) browser.setTrack2DName(track2D, name);
      // What the track menu's rename writes; igv's setter relabels the row, which posts the change event.
      else trackPair.track.name = name;
    },
    [SyncEventType.TRACK_DATA_RANGE_CHANGE]: (browser, { track, min, max }) =>
      trackPairNamed(browser, track).setDataRange(min, max),
    [SyncEventType.TRACK_AUTOSCALE_CHANGE]: (browser, { track, enabled }) =>
      trackPairNamed(browser, track).setAutoscale(enabled),
    [SyncEventType.TRACK_LOG_SCALE_CHANGE]: (browser, { track, enabled }) =>
      trackPairNamed(browser, track).setLogScale(enabled),
  };

  /** A track pair's or a 2D track's change; peers name the track as they last heard it. */
  function trackChanged(browser, subject, property, value) {
    const track = nameOf(subject);
    if (property === 'name') trackNames.set(subject, value); // also when guarded: peers now use it
    const change = trackChanges[property]?.(value);
    if (change) emit(browser, change[0], { track, ...change[1] });
  }

  function trackPairNamed(browser, name) {
    const trackPair = browser.trackPairs.find((tp) => nameOf(tp) === name);
    if (!trackPair) throw new Error(`No track named ${name}`);
    return trackPair;
  }

  /** The track pair, or else the 2D track, peers know by `name`: `{trackPair}` or `{track2D}`. */
  function trackNamed(browser, name) {
    const trackPair = browser.trackPairs.find((tp) => nameOf(tp) === name);
    if (trackPair) return { trackPair };
    const track2D = browser.tracks2D.find((t) => nameOf(t) === name);
    if (!track2D) throw new Error(`No track named ${name}`);
    return { track2D };
  }

  // Rate limited per panel: panels synced within the page each send their own (ADR-0008).
  function locusChanged(browser, dragging) {
    const follow = followed.get(browser);
    if (guarded || !follow) return;
    clearTimeout(follow.locusTimer);
    const wait = dragging ? follow.lastLocusSent + LOCUS_THROTTLE_MS - Date.now() : LOCUS_DEBOUNCE_MS;
    if (wait <= 0) sendLocus(browser, follow);
    else follow.locusTimer = setTimeout(() => sendLocus(browser, follow), wait);
  }

  function sendLocus(browser, follow) {
    follow.lastLocusSent = Date.now();
    const panel = positionOf(browser);
    const syncState = browser.getSyncState();
    if (panel && syncState) {
      send({ type: MessageType.SYNC_EVENT, syncType: SyncEventType.LOCUS_CHANGE, panel, syncState });
    }
  }

  /** Follow the open panels: subscribe on each new one, drop the closed ones. */
  function rescan() {
    if (detached) return;
    const browsers = hic.getAllBrowsers();
    for (const browser of followed.keys()) {
      if (!browsers.includes(browser)) unfollow(browser);
    }
    for (const browser of browsers) {
      if (followed.has(browser)) continue;
      const offs = Object.entries(callbacksFor(browser)).map(([name, fn]) => browser.coordinator.addCallback(name, fn));
      followed.set(browser, { offs, locusTimer: undefined, lastLocusSent: -Infinity });
      // Tracks already on the panel are known by their current names.
      for (const track of [...(browser.trackPairs ?? []), ...(browser.tracks2D ?? [])]) {
        trackNames.set(track, nameOf(track));
      }
      for (const track2D of browser.tracks2D ?? []) panelOf2D.set(track2D, browser);
    }
  }

  function unfollow(browser) {
    const { offs, locusTimer } = followed.get(browser);
    for (const off of offs) off();
    clearTimeout(locusTimer);
    followed.delete(browser);
  }

  /**
   * The panel a peer's sync event is for: the one at its position, the current one for an
   * event without `panel` (a remote from before ADR-0008), or undefined when this page has
   * no such panel. A mapLoad for the position one past the last opens that panel.
   */
  async function panelFor({ panel, syncType }) {
    if (panel === undefined) return hic.getCurrentBrowser();
    if (!Number.isInteger(panel) || panel < 1) return undefined;
    const browsers = hic.getAllBrowsers();
    if (panel <= browsers.length) return browsers[panel - 1];
    if (syncType === SyncEventType.MAP_LOAD && panel === browsers.length + 1) return newPanel(hic, container);
    return undefined;
  }

  async function guard(fn) {
    guarded = true;
    try {
      return await fn();
    } finally {
      guarded = false;
    }
  }

  rescan();
  for (const [type, fn] of Object.entries(busHandlers)) bus.subscribe(type, fn);

  return {
    /** Run `fn` (a command or a sync event being applied) without sending sync events for what it changes. */
    guard,

    /** Scan the panels again, after something that may have opened or closed one (a command, a catch-up). */
    rescan,

    /** Apply a peer's sync event to the panel it names. Never rejects: a sync event has no reply. */
    async apply(event) {
      if (detached) return;
      try {
        await guard(async () => {
          const browser = await panelFor(event);
          if (browser) await appliers[event.syncType](browser, event);
        });
      } catch {
        // Dropped: nothing to report it to.
      }
      rescan(); // a mapLoad may have opened a panel
    },

    detach() {
      for (const browser of [...followed.keys()]) unfollow(browser);
      detached = true;
      for (const [type, fn] of Object.entries(busHandlers)) bus.unsubscribe(type, fn);
    },
  };
}

/** A SignedColorScale (the two-map display modes) has a positive and a negative scale. */
const isSigned = (colorScale) => colorScale.positiveScale !== undefined;

/** A scale and the display mode it belongs to. The threshold widget stores what was typed, a string. */
function colorScalePayload(colorScale, browser) {
  const displayMode = browser.getDisplayMode();
  const threshold = Number(colorScale.getThreshold());
  if (isSigned(colorScale)) {
    return {
      displayMode,
      threshold,
      isRatio: true,
      positive: colorScale.getColorComponents('+'),
      negative: colorScale.getColorComponents('-'),
    };
  }
  const { r, g, b } = colorScale.getColorComponents();
  return { displayMode, threshold, r, g, b };
}
