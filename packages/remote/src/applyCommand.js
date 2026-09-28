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
  [CommandType.LOAD_MAP]: async ({ url, name, normalization, locus }, { hic }) => {
    await currentBrowser(hic).loadHicFile({ url, name, normalization, locus });
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

  [CommandType.LOAD_TRACK]: async ({ url, name, color, trackType, format }, { hic }) => {
    const config = { url };
    if (name) config.name = name;
    if (color) config.color = rgbString(color);
    if (trackType) config.type = trackType;
    if (format) config.format = format;
    // Not awaited: ok means the load started, not that the data arrived. juicebox.js
    // shows a pending row meanwhile and alerts on failure itself (ADR-0017).
    browserWithMap(hic).loadTracks([config]);
  },

  [CommandType.REMOVE_TRACK]: async (command, { hic }) => {
    const browser = browserWithMap(hic);
    browser.layoutController.removeTrackXYPair(findTrackPair(browser, command));
  },

  [CommandType.SET_TRACK_COLOR]: async (command, { hic }) => {
    // No colour resets the track to its default.
    findTrackPair(browserWithMap(hic), command).setColor(command.color ? rgbString(command.color) : undefined);
  },

  [CommandType.SET_TRACK_NAME]: async (command, { hic }) => {
    const trackPair = findTrackPair(browserWithMap(hic), command);
    // The label first, so its change event still sees the old name on the track.
    trackPair.setTrackLabelName(command.name);
    trackPair.track.name = command.name;
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

  [CommandType.GET_SESSION]: async (command, { hic }) => hic.toJSON(),

  [CommandType.GET_COMPRESSED_SESSION]: async (command, { hic }) => hic.compressedSession(),
};

/**
 * The track pair a command's `track` names: a 1-based index over the track pairs
 * then the 2D tracks (the order getTrackList numbers them in), or else a name,
 * matched case-insensitively. Throws for an unknown track and for a 2D track,
 * which has no public setters or removal to call.
 */
function findTrackPair({ trackPairs, tracks2D }, { type, track: identifier }) {
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
  if (track2D) throw new Error(`Track ${identifier} is a 2D track; ${type} applies to 1D tracks only`);
  if (!trackPair) throw new Error(`Track not found: ${identifier}`);
  return trackPair;
}

const rgbString = ({ r, g, b }) => `rgb(${r},${g},${b})`;

/** Zoom about the given pixel, or the middle of the map viewport when none is given. */
async function zoom(browser, direction, { centerX, centerY }) {
  const viewport = browser.contactMatrixView.viewportElement;
  await browser.zoomAndCenter(direction, centerX ?? viewport.clientWidth / 2, centerY ?? viewport.clientHeight / 2);
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
