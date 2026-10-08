import { CommandType } from './protocol.js';
import {
  closePanel,
  datasetLabel,
  openPanel,
  panelLabel,
  positionOf,
  removeTrack,
  resolvePanel,
  resolvePanels,
  setTrackAutoscale,
  setTrackColor,
  setTrackDataRange,
  setTrackLogScale,
  setTrackName,
} from './panels.js';

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
    // Panel 'new' opens another viewer beside the current one, the way juicebox-web's
    // clone button does, and loads the map there; otherwise the addressed panel's map is
    // replaced (ADR-0007).
    const browser = panel === 'new' ? await openPanel(hic, container, 'new') : resolvePanel(hic, panel, 'load_map');
    await browser.loadHicFile({ url, name, normalization, locus });
    // After applying config.locus juicebox.js adopts a compatible peer's view; put the asked-for locus back.
    if (locus) await browser.parseGotoInput(locus);
    return `loaded ${browser.dataset?.name ?? url} into panel ${positionOf(hic, browser)} of ${hic.getAllBrowsers().length} (${datasetLabel(browser)})`;
  },

  [CommandType.LOAD_CONTROL_MAP]: async ({ url, name, normalization, panel }, { hic }) => {
    const browser = resolvePanel(hic, panel, 'load_control_map');
    await browser.loadHicControlFile({ url, name, normalization });
    if (browser.dataset && browser.controlDataset && browser.getDisplayMode() !== 'AOB') {
      await browser.setDisplayMode('AOB');
    }
    return `${panelLabel(hic, browser)}: ok`;
  },

  [CommandType.CLOSE_PANEL]: async ({ panel }, { hic }) => {
    const browser = resolvePanel(hic, panel, 'close_panel');
    const closed = panelLabel(hic, browser);
    closePanel(hic, browser);
    const remaining = hic.getAllBrowsers().map((b, i) => `${i + 1} (${datasetLabel(b)})`);
    return `closed ${closed}; remaining: ${remaining.join(' | ')}`;
  },

  [CommandType.LOAD_SESSION]: async ({ sessionData }, { hic, container }) => {
    await hic.restoreSession(container, sessionData);
  },

  [CommandType.GOTO_LOCUS]: ({ locus, panel }, { hic }) =>
    forPanels(hic, panel, (browser) => browser.parseGotoInput(locus)),

  [CommandType.ZOOM_IN]: (command, { hic }) => forPanels(hic, command.panel, (browser) => zoom(browser, 1, command)),
  [CommandType.ZOOM_OUT]: (command, { hic }) => forPanels(hic, command.panel, (browser) => zoom(browser, -1, command)),

  [CommandType.SET_FOREGROUND_COLOR]: ({ color: { r, g, b }, threshold, panel }, { hic }) =>
    forPanels(hic, panel, (browser) => {
      const colorScale = browser.getColorScale();
      colorScale.setColorComponents({ r, g, b });
      browser.contactMatrixView.setColorScale(colorScale);
      // Tiles are cached without their colour; setting the threshold, even to the
      // current one, is the public call that invalidates them and repaints.
      browser.setColorScaleThreshold(threshold ?? colorScale.getThreshold());
    }),

  [CommandType.SET_BACKGROUND_COLOR]: ({ color: { r, g, b }, panel }, { hic }) =>
    forPanels(hic, panel, (browser) => browser.contactMatrixView.setBackgroundColor({ r, g, b })),

  [CommandType.SET_COLOR_SCALE]: ({ action, value, panel }, { hic }) =>
    forPanels(hic, panel, (browser) => {
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
    }),

  [CommandType.SET_NORMALIZATION]: ({ normalization, panel }, { hic }) =>
    forPanels(hic, panel, (browser) => browser.setNormalization(normalization)),

  [CommandType.LOAD_TRACK]: ({ url, preset, name, color, trackType, format, panel }, { hic }) => {
    const config = {};
    if (name) config.name = name;
    if (color) config.color = rgbString(color);
    if (trackType) config.type = trackType;
    if (format) config.format = format;
    // Not awaited: ok means the load started, not that the data arrived. juicebox.js
    // shows a pending row meanwhile and alerts on failure itself (ADR-0017).
    return forPanels(hic, panel, (browser) => {
      // A preset is resolved here, per panel, because the file depends on the map's genome.
      const track = preset ? presetTrack(preset, browser) : { url };
      browser.loadTracks([{ ...track, ...config }]);
    });
  },

  [CommandType.REMOVE_TRACK]: ({ track, panel }, { hic }) =>
    forTrackPanels(hic, panel, track, (browser) => removeTrack(browser, track)),

  // No colour resets the track to its default (a 2D track's features' own colours).
  [CommandType.SET_TRACK_COLOR]: ({ track, color, panel }, { hic }) =>
    forTrackPanels(hic, panel, track, (browser) => setTrackColor(browser, track, color ? rgbString(color) : undefined)),

  [CommandType.SET_TRACK_NAME]: ({ track, name, panel }, { hic }) =>
    forTrackPanels(hic, panel, track, (browser) => setTrackName(browser, track, name)),

  [CommandType.SET_TRACK_DATA_RANGE]: ({ track, min, max, panel }, { hic }) =>
    forTrackPanels(hic, panel, track, (browser) => setTrackDataRange(browser, track, min, max)),

  [CommandType.SET_TRACK_AUTOSCALE]: ({ track, enabled, panel }, { hic }) =>
    forTrackPanels(hic, panel, track, (browser) => setTrackAutoscale(browser, track, enabled)),

  [CommandType.SET_TRACK_LOG_SCALE]: ({ track, enabled, panel }, { hic }) =>
    forTrackPanels(hic, panel, track, (browser) => setTrackLogScale(browser, track, enabled)),

  [CommandType.GET_TRACK_LIST]: async (command, { hic }) => {
    const { trackPairs, tracks2D } = resolvePanel(hic, command.panel, 'list_tracks');
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

  // One entry per panel, `{}` for one with no map, so a late joiner restores the empty panels too
  // and positions stay aligned (ticket 33). juicebox.js's own session skips a panel without a map
  // url; its entries are the rest, in order.
  [CommandType.GET_SESSION]: async (command, { hic }) => {
    const { browsers: withMap, ...session } = hic.toJSON();
    let next = 0;
    const browsers = hic.getAllBrowsers().map((browser) => (browser.dataset?.url ? withMap[next++] : {}));
    return { ...session, browsers };
  },

  [CommandType.GET_COMPRESSED_SESSION]: async (command, { hic }) => hic.compressedSession(),
};

const rgbString = ({ r, g, b }) => `rgb(${r},${g},${b})`;

/** Zoom about the given pixel, or the middle of the map viewport when none is given. */
async function zoom(browser, direction, { centerX, centerY }) {
  const viewport = browser.contactMatrixView.viewportElement;
  await browser.zoomAndCenter(direction, centerX ?? viewport.clientWidth / 2, centerY ?? viewport.clientHeight / 2);
}

// UCSC ships NCBI RefSeq Select for these assemblies; the others get the full NCBI RefSeq set.
const REFSEQ_SELECT_GENOMES = new Set(['hg38', 'hg19', 'mm10', 'mm39']);

/** The `genes` preset: NCBI RefSeq from UCSC for the genome of this browser's map. */
function presetTrack(preset, browser) {
  if (preset !== 'genes') throw new Error(`Unknown track preset "${preset}"`);
  const genome = browser.dataset?.genomeId;
  if (!genome) throw new Error('The map does not say which genome it is on, so no gene track can be chosen');
  const table = REFSEQ_SELECT_GENOMES.has(genome) ? 'ncbiRefSeqSelect' : 'ncbiRefSeq';
  return {
    url: `https://hgdownload.soe.ucsc.edu/goldenPath/${genome}/database/${table}.txt.gz`,
    type: 'annotation',
    format: 'refgene',
  };
}

/**
 * Apply `apply` to each panel `panel` addresses (panels.js); each needs a map. Resolves to
 * one line per panel, "panel N (map, genome): ok" or its error; rejects only when every
 * panel fails. A track command passes its `track`, which "all" requires to be a name.
 */
async function forPanels(hic, panel, apply, track) {
  const lines = [];
  let failed = 0;
  for (const browser of resolvePanels(hic, panel, { track })) {
    try {
      if (!browser.dataset) throw new Error('No map loaded');
      await apply(browser);
      lines.push(`${panelLabel(hic, browser)}: ok`);
    } catch (e) {
      failed++;
      lines.push(`${panelLabel(hic, browser)}: ${e.message}`);
    }
  }
  if (failed === lines.length) throw new Error(lines.join('\n'));
  return lines.join('\n');
}

const forTrackPanels = (hic, panel, track, apply) => forPanels(hic, panel, apply, track);

/** The view as the locus box shows it: "All", or "chr1:1-2,000,000 chr1:1-2,000,000" (bp, 1-based). */
function locusString({ dataset, state, contactMatrixView }) {
  if (dataset.isWholeGenome(state.chr1)) return 'All';
  const { x, y } = state.getLocus(dataset, contactMatrixView.getViewDimensions());
  const range = ({ chr, start, end }) => `${chr}:${(start + 1).toLocaleString('en-US')}-${end.toLocaleString('en-US')}`;
  return `${range(x)} ${range(y)}`;
}
