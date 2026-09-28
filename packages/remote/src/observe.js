import { MessageType, SyncEventType } from './protocol.js';

// While dragging, at most one locusChange per LOCUS_THROTTLE_MS, and the drag's
// last position always goes out; otherwise one once changes stop for LOCUS_DEBOUNCE_MS.
const LOCUS_THROTTLE_MS = 150;
const LOCUS_DEBOUNCE_MS = 100;

/**
 * Send a sync event for each change made on this page, and apply peers' sync
 * events to it. Design §5.3.
 *
 * Follows the current browser: its coordinator callbacks are moved to whichever
 * browser `BrowserSelect` names (a restored session replaces the browser).
 * Changes made while `guard` runs are not sent, so applying a peer's sync event
 * or a command does not echo back. Applies must run one at a time.
 *
 * Payload shapes are the prototype's (`src/Application.js` on branch `prototype`).
 *
 * @param {object} hic                  the juicebox.js namespace
 * @param {(msg: object) => void} send  sends one message to the room
 */
export function observe(hic, send) {
  const bus = hic.EventBus.globalBus;
  let guarded = false;
  let detached = false;
  let observed; // the browser whose coordinator callbacks are subscribed
  let offCallbacks = [];
  let locusTimer;
  let lastLocusSent = -Infinity;

  // The name a track pair or 2D track had when peers last heard of it: a rename's
  // event carries only the new one, and the track already has it.
  const trackNames = new WeakMap();
  const nameOf = (track) => trackNames.get(track) ?? (track.track ?? track).name;
  const dropped = new WeakSet(); // duplicate 2D tracks being removed, whose removal peers are not told of

  const emit = (syncType, payload) => {
    if (!guarded) send({ type: MessageType.SYNC_EVENT, syncType, ...payload });
  };

  const emitMapLoad = (syncType, dataset) => {
    // A map opened from a local file has no URL a peer could load.
    if (typeof dataset?.url === 'string') emit(syncType, { url: dataset.url, name: dataset.name });
  };

  const callbacks = {
    // juicebox.js 4.6.0 does not pass `dragging` to callbacks yet, so until it does every change is debounced.
    onLocusChange: ({ dragging }) => locusChanged(dragging),
    onColorScaleChange: ({ colorScale }) => emit(SyncEventType.COLOR_SCALE_CHANGE, colorScalePayload(colorScale)),
    // The colour picker edits the scale in place without firing onColorScaleChange.
    onForegroundColorChange: ({ browser }) =>
      emit(SyncEventType.COLOR_SCALE_CHANGE, colorScalePayload(browser.getColorScale())),
    onBackgroundColorChange: ({ rgb }) => emit(SyncEventType.BACKGROUND_COLOR_CHANGE, { color: rgb }),
    onNormalizationChange: ({ normalization }) => emit(SyncEventType.NORMALIZATION_CHANGE, { normalization }),
    // A peer mirrors what is drawn, not what was asked for (juicebox.js ADR-0012).
    onNormalizationSubstituted: ({ effective }) =>
      emit(SyncEventType.NORMALIZATION_CHANGE, { normalization: effective }),
    onDisplayModeChange: ({ mode }) => emit(SyncEventType.DISPLAY_MODE_CHANGE, { displayMode: mode }),
    onMapLoaded: ({ dataset }) => emitMapLoad(SyncEventType.MAP_LOAD, dataset),
    onControlMapLoaded: ({ controlDataset }) => emitMapLoad(SyncEventType.CONTROL_MAP_LOAD, controlDataset),
  };

  const trackChanges = {
    color: (colorString) => [SyncEventType.TRACK_COLOR_CHANGE, { colorString }],
    dataRange: ({ min, max }) => [SyncEventType.TRACK_DATA_RANGE_CHANGE, { min, max }],
    name: (name) => [SyncEventType.TRACK_NAME_CHANGE, { name }],
    autoscale: (enabled) => [SyncEventType.TRACK_AUTOSCALE_CHANGE, { enabled }],
    logScale: (enabled) => [SyncEventType.TRACK_LOG_SCALE_CHANGE, { enabled }],
  };

  // Global EventBus handlers; each receives `{type, data}`.
  const busHandlers = {
    BrowserSelect: ({ data: browser }) => follow(browser),
    TrackXYPairLoad: ({ data: trackPair }) => {
      trackNames.set(trackPair, trackPair.track.name);
      const { config } = trackPair.track;
      if (typeof config?.url === 'string') emit(SyncEventType.TRACK_LOAD, { configs: [config] });
    },
    TrackXYPairRemoval: ({ data: trackPair }) => emit(SyncEventType.TRACK_REMOVE, { track: nameOf(trackPair) }),
    TrackXYPairChange: ({ data: { trackPair, property, value } }) => trackChanged(trackPair, property, value),
    Track2DLoad: ({ data: track2D }) => {
      const { config } = track2D;
      const url = config?.url;
      // A 2D track has no pending row, so a peer's trackLoad for one still loading here
      // loads it again (a loadTrack command or a restored session reaches every page):
      // the second copy to arrive goes.
      const tracks2D = observed?.tracks2D ?? [];
      const held = typeof url === 'string' && tracks2D.some((t) => t !== track2D && t.config?.url === url);
      if (held && tracks2D.includes(track2D)) {
        dropped.add(track2D);
        observed.removeTrack2D(track2D);
        return;
      }
      trackNames.set(track2D, track2D.name);
      if (typeof url === 'string') emit(SyncEventType.TRACK_LOAD, { configs: [config] });
    },
    Track2DRemoval: ({ data: track2D }) => {
      if (!dropped.delete(track2D)) emit(SyncEventType.TRACK_REMOVE, { track: nameOf(track2D) });
    },
    Track2DChange: ({ data: { track2D, property, value } }) => trackChanged(track2D, property, value),
  };

  const appliers = {
    [SyncEventType.LOCUS_CHANGE]: (browser, { syncState }) => browser.syncState(syncState),
    [SyncEventType.COLOR_SCALE_CHANGE]: async (browser, { threshold, isRatio, positive, negative, r, g, b }) => {
      const colorScale = browser.getColorScale();
      // One-map and two-map scales do not mix; the display mode syncs on its own.
      if (Boolean(isRatio) !== isSigned(colorScale)) return;
      if (isRatio) {
        colorScale.setColorComponents(positive, '+');
        colorScale.setColorComponents(negative, '-');
      } else {
        colorScale.setColorComponents({ r, g, b });
      }
      browser.contactMatrixView.setColorScale(colorScale);
      await browser.setColorScaleThreshold(threshold); // also invalidates the tiles, so it repaints
    },
    [SyncEventType.BACKGROUND_COLOR_CHANGE]: (browser, { color: { r, g, b } }) =>
      browser.contactMatrixView.setBackgroundColor({ r, g, b }),
    [SyncEventType.NORMALIZATION_CHANGE]: (browser, { normalization }) => browser.setNormalization(normalization),
    [SyncEventType.DISPLAY_MODE_CHANGE]: (browser, { displayMode }) => browser.setDisplayMode(displayMode),
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
  function trackChanged(subject, property, value) {
    const track = nameOf(subject);
    if (property === 'name') trackNames.set(subject, value); // also when guarded: peers now use it
    const change = trackChanges[property]?.(value);
    if (change) emit(change[0], { track, ...change[1] });
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

  function locusChanged(dragging) {
    if (guarded) return;
    clearTimeout(locusTimer);
    const wait = dragging ? lastLocusSent + LOCUS_THROTTLE_MS - Date.now() : LOCUS_DEBOUNCE_MS;
    if (wait <= 0) sendLocus();
    else locusTimer = setTimeout(sendLocus, wait);
  }

  function sendLocus() {
    lastLocusSent = Date.now();
    const syncState = observed?.getSyncState();
    if (syncState) send({ type: MessageType.SYNC_EVENT, syncType: SyncEventType.LOCUS_CHANGE, syncState });
  }

  function follow(browser) {
    for (const off of offCallbacks) off();
    offCallbacks = browser
      ? Object.entries(callbacks).map(([name, fn]) => browser.coordinator.addCallback(name, fn))
      : [];
    observed = browser;
    // Tracks already on the panel are known by their current names.
    for (const track of [...(browser?.trackPairs ?? []), ...(browser?.tracks2D ?? [])]) {
      trackNames.set(track, nameOf(track));
    }
  }

  async function guard(fn) {
    guarded = true;
    try {
      return await fn();
    } finally {
      guarded = false;
    }
  }

  follow(hic.getCurrentBrowser());
  for (const [type, fn] of Object.entries(busHandlers)) bus.subscribe(type, fn);

  return {
    /** Run `fn` (a command or a sync event being applied) without sending sync events for what it changes. */
    guard,

    /** Apply a peer's sync event to the current browser. Never rejects: a sync event has no reply. */
    async apply(event) {
      const browser = hic.getCurrentBrowser();
      if (detached || !browser) return;
      try {
        await guard(() => appliers[event.syncType](browser, event));
      } catch {
        // Dropped: nothing to report it to.
      }
    },

    detach() {
      detached = true;
      clearTimeout(locusTimer);
      follow(undefined);
      for (const [type, fn] of Object.entries(busHandlers)) bus.unsubscribe(type, fn);
    },
  };
}

/** A SignedColorScale (the two-map display modes) has a positive and a negative scale. */
const isSigned = (colorScale) => colorScale.positiveScale !== undefined;

function colorScalePayload(colorScale) {
  const threshold = colorScale.getThreshold();
  if (isSigned(colorScale)) {
    return {
      threshold,
      isRatio: true,
      positive: colorScale.getColorComponents('+'),
      negative: colorScale.getColorComponents('-'),
    };
  }
  const { r, g, b } = colorScale.getColorComponents();
  return { threshold, r, g, b };
}
