import { CommandType } from './protocol.js';

/**
 * Apply one command to juicebox.js's public surface. Design §5.2.
 *
 * Resolves once the surface call's promise settles (a map load resolves with
 * its dataset; tiles and tracks are not awaited); throws, or rejects, when the
 * command cannot be applied, including an unknown command type.
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
};

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
