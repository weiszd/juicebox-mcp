import { CommandType } from './protocol.js';

/**
 * Apply one command to juicebox.js's public surface. Design §5.2.
 *
 * Resolves once the surface call's promise settles (a map load resolves with
 * its dataset; tiles and tracks are not awaited), to the ack's `result` for a
 * request-style command and to undefined otherwise; throws, or rejects, when
 * the command cannot be applied, including an unknown command type.
 *
 * @param {object} hic        the juicebox.js namespace
 * @param {Element} container passed through to hic.restoreSession
 * @param {object} command    `{type, requestId, ...payload}`; `type` may be unknown
 */
export async function applyCommand(hic, container, command) {
  const apply = appliers[command.type];
  if (!apply) throw new Error(`Unknown command type: ${command.type}`);
  return apply(command, { hic, container });
}

// Payload shapes are what the server's tool handlers send (packages/server/src/mcp/toolHandlers.js).
const appliers = {
  [CommandType.LOAD_MAP]: async ({ url, name, normalization, locus, panel }, { hic, container }) => {
    // PROTOTYPE (proto/encode-portal-search): panel 'new' opens another viewer beside the
    // current one, the way juicebox-web's clone button does, and loads the map there.
    let browser = currentBrowser(hic);
    if (panel === 'new') {
      const { width, height } = browser.config;
      browser = await hic.createBrowser(container, { width, height });
      hic.setCurrentBrowser(browser);
    }
    await browser.loadHicFile({ url, name, normalization, locus });
  },

  [CommandType.LOAD_CONTROL_MAP]: async ({ url, name, normalization }, { hic }) => {
    const browser = currentBrowser(hic);
    await browser.loadHicControlFile({ url, name, normalization });
    if (browser.dataset && browser.controlDataset && browser.getDisplayMode() !== 'AOB') {
      await browser.setDisplayMode('AOB');
    }
  },

  [CommandType.LOAD_SESSION]: async ({ sessionData }, { hic, container }) => {
    await hic.restoreSession(container, sessionData);
  },

  [CommandType.GOTO_LOCUS]: async ({ locus }, { hic }) => {
    await browserWithMap(hic).parseGotoInput(locus);
  },

  [CommandType.ZOOM_IN]: (command, { hic }) => zoom(browserWithMap(hic), 1, command),
  [CommandType.ZOOM_OUT]: (command, { hic }) => zoom(browserWithMap(hic), -1, command),

  [CommandType.SET_FOREGROUND_COLOR]: async ({ color: { r, g, b }, threshold }, { hic }) => {
    const browser = browserWithMap(hic);
    const colorScale = browser.getColorScale();
    colorScale.setColorComponents({ r, g, b });
    browser.contactMatrixView.setColorScale(colorScale);
    // Tiles are cached without their colour; setting the threshold, even to the
    // current one, is the public call that invalidates them and repaints.
    browser.setColorScaleThreshold(threshold ?? colorScale.getThreshold());
  },

  [CommandType.SET_BACKGROUND_COLOR]: async ({ color: { r, g, b } }, { hic }) => {
    browserWithMap(hic).contactMatrixView.setBackgroundColor({ r, g, b });
  },

  [CommandType.SET_COLOR_SCALE]: async ({ action, value }, { hic }) => {
    const browser = browserWithMap(hic);
    const current = () => browser.getColorScale().getThreshold();
    switch (action) {
      case 'increase':
        return browser.setColorScaleThreshold(current() * 2);
      case 'decrease':
        return browser.setColorScaleThreshold(current() / 2);
      case 'set':
        return browser.setColorScaleThreshold(value);
      default:
        throw new Error(`Unknown color scale action: ${action}`);
    }
  },

  [CommandType.SET_NORMALIZATION]: async ({ normalization }, { hic }) => {
    browserWithMap(hic).setNormalization(normalization);
  },

  [CommandType.LOAD_TRACK]: async ({ url, name, color, trackType, format, panel }, { hic }) => {
    const config = { url };
    if (name) config.name = name;
    if (color) config.color = rgbString(color);
    if (trackType) config.type = trackType;
    if (format) config.format = format;
    // PROTOTYPE (proto/encode-portal-search): one load per addressed panel, each reported
    // on its own line; the command fails only when every panel fails.
    const lines = [];
    let failed = 0;
    for (const browser of resolvePanels(hic, panel)) {
      try {
        if (!browser.dataset) throw new Error('No map loaded');
        // Not awaited: ok means the load started, not that the data arrived. juicebox.js
        // shows a pending row meanwhile and alerts on failure itself (ADR-0017).
        browser.loadTracks([{ ...config }]);
        lines.push(`${panelLabel(hic, browser)}: loading track${name ? ` "${name}"` : ''} from ${url}`);
      } catch (e) {
        failed++;
        lines.push(`${panelLabel(hic, browser)}: ${e.message}`);
      }
    }
    if (failed === lines.length) throw new Error(lines.join('\n'));
    return lines.join('\n');
  },

  [CommandType.REMOVE_TRACK]: async (command, { hic }) => {
    const browser = browserWithMap(hic);
    const { trackPair, track2D } = findTrack(browser, command);
    if (track2D) browser.removeTrack2D(track2D);
    else browser.layoutController.removeTrackXYPair(trackPair);
  },

  [CommandType.SET_TRACK_COLOR]: async (command, { hic }) => {
    const browser = browserWithMap(hic);
    const { trackPair, track2D } = findTrack(browser, command);
    // No colour resets the track to its default (a 2D track's features' own colours).
    const color = command.color ? rgbString(command.color) : undefined;
    if (track2D) browser.setTrack2DColor(track2D, color);
    else trackPair.setColor(color);
  },

  [CommandType.SET_TRACK_NAME]: async (command, { hic }) => {
    const browser = browserWithMap(hic);
    const { trackPair, track2D } = findTrack(browser, command);
    if (track2D) browser.setTrack2DName(track2D, command.name);
    // igv's name setter relabels the row, which posts the change event once.
    else trackPair.track.name = command.name;
  },

  [CommandType.SET_TRACK_DATA_RANGE]: async (command, { hic }) => {
    findTrackPair(browserWithMap(hic), command).setDataRange(command.min, command.max);
  },

  [CommandType.SET_TRACK_AUTOSCALE]: async (command, { hic }) => {
    findTrackPair(browserWithMap(hic), command).setAutoscale(command.enabled);
  },

  [CommandType.SET_TRACK_LOG_SCALE]: async (command, { hic }) => {
    findTrackPair(browserWithMap(hic), command).setLogScale(command.enabled);
  },

  [CommandType.GET_TRACK_LIST]: async (command, { hic }) => {
    const { trackPairs, tracks2D } = currentBrowser(hic);
    // A pending track pair carries its config itself; a loaded one carries it on the track.
    const pairs = trackPairs.map(({ track, config = track.config }, i) => ({
      index: i + 1,
      is2D: false,
      name: track.name,
      url: config?.url,
      color: track.color,
      dataRange: track.dataRange,
      autoscale: track.autoscale,
      logScale: track.logScale,
    }));
    const twoD = tracks2D.map((track, i) => ({
      index: trackPairs.length + i + 1,
      is2D: true,
      name: track.name,
      url: track.config?.url,
      color: track.color,
    }));
    return [...pairs, ...twoD];
  },

  [CommandType.GET_PANEL_LIST]: async (command, { hic }) => {
    const current = hic.getCurrentBrowser();
    return hic.getAllBrowsers().map((browser, i) => {
      const { dataset, controlDataset, trackPairs, tracks2D } = browser;
      return {
        panel: i + 1,
        current: browser === current,
        map: dataset?.name ?? null,
        genome: dataset?.genomeId ?? null,
        controlMap: controlDataset?.name ?? null,
        tracks: trackPairs.length + tracks2D.length,
        locus: dataset ? locusString(browser) : null,
      };
    });
  },

  [CommandType.GET_SESSION]: async (command, { hic }) => hic.toJSON(),

  [CommandType.GET_COMPRESSED_SESSION]: async (command, { hic }) => hic.compressedSession(),
};

/**
 * The track a command's `track` names, as `{trackPair}` or `{track2D}`: a
 * 1-based index over the track pairs then the 2D tracks (the order getTrackList
 * numbers them in), or else a name, matched case-insensitively. Throws for an
 * unknown track.
 */
function findTrack({ trackPairs, tracks2D }, { track: identifier }) {
  const id = String(identifier).trim();
  let trackPair, track2D;
  if (/^\d+$/.test(id)) {
    const i = Number(id) - 1;
    trackPair = trackPairs[i];
    if (!trackPair && i >= trackPairs.length) track2D = tracks2D[i - trackPairs.length];
  } else {
    const named = (t) => t.name?.toLowerCase() === id.toLowerCase();
    trackPair = trackPairs.find((tp) => named(tp.track));
    if (!trackPair) track2D = tracks2D.find(named);
  }
  if (!trackPair && !track2D) throw new Error(`Track not found: ${identifier}`);
  return { trackPair, track2D };
}

/** The track pair a command names; throws for a 2D track, which has no data range or scale. */
function findTrackPair(browser, command) {
  const { trackPair } = findTrack(browser, command);
  if (!trackPair) throw new Error(`Track ${command.track} is a 2D track; ${command.type} does not apply to 2D tracks`);
  return trackPair;
}

const rgbString = ({ r, g, b }) => `rgb(${r},${g},${b})`;

/** Zoom about the given pixel, or the middle of the map viewport when none is given. */
async function zoom(browser, direction, { centerX, centerY }) {
  const viewport = browser.contactMatrixView.viewportElement;
  await browser.zoomAndCenter(direction, centerX ?? viewport.clientWidth / 2, centerY ?? viewport.clientHeight / 2);
}

/**
 * The browsers a command's `panel` addresses (CONTEXT.md: panel): a 1-based position
 * from the left, "all", or a map name matched case-insensitively that must be unique.
 * Omitted means the current panel, and is an error when more than one panel is open.
 */
function resolvePanels(hic, panel) {
  const browsers = hic.getAllBrowsers();
  if (panel === undefined || panel === null) {
    if (browsers.length === 1) return [currentBrowser(hic)];
    if (browsers.length === 0) throw new Error('No browser');
    const labels = browsers.map((b, i) => `${i + 1} (${datasetLabel(b)})`);
    throw new Error(`${browsers.length} panels open; say panel: ${labels.join(' | ')} | all`);
  }
  if (typeof panel === 'number') {
    const browser = browsers[panel - 1];
    if (!browser) throw new Error(`no panel ${panel} (${browsers.length} open)`);
    return [browser];
  }
  if (panel.toLowerCase() === 'all') return browsers;
  const positions = [];
  browsers.forEach((b, i) => {
    if (b.dataset?.name?.toLowerCase() === panel.toLowerCase()) positions.push(i + 1);
  });
  if (positions.length === 0) throw new Error(`no panel named ${panel}`);
  if (positions.length > 1) {
    throw new Error(`${panel} matches ${positions.length} panels; use ${positions.slice(0, -1).join(', ')} or ${positions.at(-1)}`);
  }
  return [browsers[positions[0] - 1]];
}

/** "panel 2 (heart, mm10)", or "panel 2 (no map)". */
function panelLabel(hic, browser) {
  return `panel ${hic.getAllBrowsers().indexOf(browser) + 1} (${datasetLabel(browser)})`;
}

const datasetLabel = ({ dataset }) => (dataset ? `${dataset.name}, ${dataset.genomeId}` : 'no map');

/** The view as the locus box shows it: "All", or "chr1:1-2,000,000 chr1:1-2,000,000" (bp, 1-based). */
function locusString({ dataset, state, contactMatrixView }) {
  if (dataset.isWholeGenome(state.chr1)) return 'All';
  const { x, y } = state.getLocus(dataset, contactMatrixView.getViewDimensions());
  const range = ({ chr, start, end }) => `${chr}:${(start + 1).toLocaleString('en-US')}-${end.toLocaleString('en-US')}`;
  return `${range(x)} ${range(y)}`;
}

function currentBrowser(hic) {
  const browser = hic.getCurrentBrowser();
  if (!browser) throw new Error('No browser');
  return browser;
}

function browserWithMap(hic) {
  const browser = currentBrowser(hic);
  if (!browser.dataset) throw new Error('No map loaded');
  return browser;
}
