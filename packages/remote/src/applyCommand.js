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
    // Panel 'new' opens another viewer beside the current one, the way juicebox-web's
    // clone button does, and loads the map there; otherwise the addressed panel's map is
    // replaced (ADR-0007).
    let browser;
    if (panel === 'new') {
      browser = await newPanel(hic, container);
    } else {
      browser = onePanel(hic, panel, 'load_map');
    }
    await browser.loadHicFile({ url, name, normalization, locus });
    // After applying config.locus juicebox.js adopts a compatible peer's view; put the asked-for locus back.
    if (locus) await browser.parseGotoInput(locus);
    const browsers = hic.getAllBrowsers();
    return `loaded ${browser.dataset?.name ?? url} into panel ${browsers.indexOf(browser) + 1} of ${browsers.length} (${datasetLabel(browser)})`;
  },

  [CommandType.LOAD_CONTROL_MAP]: async ({ url, name, normalization, panel }, { hic }) => {
    const browser = onePanel(hic, panel, 'load_control_map');
    await browser.loadHicControlFile({ url, name, normalization });
    if (browser.dataset && browser.controlDataset && browser.getDisplayMode() !== 'AOB') {
      await browser.setDisplayMode('AOB');
    }
    return `${panelLabel(hic, browser)}: ok`;
  },

  [CommandType.CLOSE_PANEL]: async ({ panel }, { hic }) => {
    const browser = onePanel(hic, panel, 'close_panel');
    if (hic.getAllBrowsers().length === 1) throw new Error('cannot close the last panel');
    const closed = panelLabel(hic, browser);
    // The fallback covers juicebox.js builds without the export (upstream 4.7.0); it goes away
    // when the peer dependency is raised (ADR-0007).
    if (hic.deleteBrowser) hic.deleteBrowser(browser);
    else browser.registry.delete(browser);
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

  [CommandType.REMOVE_TRACK]: (command, { hic }) =>
    forTrackPanels(hic, command, (browser) => {
      const { trackPair, track2D } = findTrack(browser, command);
      if (track2D) browser.removeTrack2D(track2D);
      else browser.layoutController.removeTrackXYPair(trackPair);
    }),

  [CommandType.SET_TRACK_COLOR]: (command, { hic }) =>
    forTrackPanels(hic, command, (browser) => {
      const { trackPair, track2D } = findTrack(browser, command);
      // No colour resets the track to its default (a 2D track's features' own colours).
      const color = command.color ? rgbString(command.color) : undefined;
      if (track2D) browser.setTrack2DColor(track2D, color);
      else trackPair.setColor(color);
    }),

  [CommandType.SET_TRACK_NAME]: (command, { hic }) =>
    forTrackPanels(hic, command, (browser) => {
      const { trackPair, track2D } = findTrack(browser, command);
      if (track2D) browser.setTrack2DName(track2D, command.name);
      // igv's name setter relabels the row, which posts the change event once.
      else trackPair.track.name = command.name;
    }),

  [CommandType.SET_TRACK_DATA_RANGE]: (command, { hic }) =>
    forTrackPanels(hic, command, (browser) => findTrackPair(browser, command).setDataRange(command.min, command.max)),

  [CommandType.SET_TRACK_AUTOSCALE]: (command, { hic }) =>
    forTrackPanels(hic, command, (browser) => findTrackPair(browser, command).setAutoscale(command.enabled)),

  [CommandType.SET_TRACK_LOG_SCALE]: (command, { hic }) =>
    forTrackPanels(hic, command, (browser) => findTrackPair(browser, command).setLogScale(command.enabled)),

  [CommandType.GET_TRACK_LIST]: async (command, { hic }) => {
    const { trackPairs, tracks2D } = onePanel(hic, command.panel, 'list_tracks');
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
 * Omitted means the current panel, and is an error when more than one panel is open;
 * that error offers "all" only to a command that takes it (`acceptsAll`).
 */
function resolvePanels(hic, panel, acceptsAll = true) {
  const browsers = hic.getAllBrowsers();
  if (panel === undefined || panel === null) {
    if (browsers.length === 1) return [currentBrowser(hic)];
    if (browsers.length === 0) throw new Error('No browser');
    const labels = browsers.map((b, i) => `${i + 1} (${datasetLabel(b)})`);
    throw new Error(`${browsers.length} panels open; say panel: ${labels.join(' | ')}${acceptsAll ? ' | all' : ''}`);
  }
  // A string of digits ("2") is a position, not a name.
  if (typeof panel === 'string' && /^\d+$/.test(panel.trim())) panel = Number(panel);
  if (typeof panel === 'number') {
    const browser = browsers[panel - 1];
    if (!browser) throw new Error(`no panel ${panel} (${browsers.length} open)`);
    return [browser];
  }
  if (isAll(panel)) return browsers;
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

/**
 * Apply `apply` to each panel `panel` addresses; each needs a map. Resolves to one
 * line per panel, "panel N (map, genome): ok" or its error; rejects only when every
 * panel fails.
 */
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

async function forPanels(hic, panel, apply) {
  const lines = [];
  let failed = 0;
  for (const browser of resolvePanels(hic, panel)) {
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

/** The one browser `panel` addresses, for a command that does not take "all". */
function onePanel(hic, panel, tool) {
  if (isAll(panel)) {
    throw new Error(`${tool} acts on one panel; "all" is not accepted`);
  }
  return resolvePanels(hic, panel, false)[0];
}

/**
 * forPanels for a track command. With "all" the track must be named: a track
 * number is a position in one panel's list and means a different track in each.
 */
function forTrackPanels(hic, command, apply) {
  if (isAll(command.panel) && /^\d+$/.test(String(command.track).trim())) {
    throw new Error(`with panel "all", name the track; track ${command.track} is a different track in each panel`);
  }
  return forPanels(hic, command.panel, apply);
}

const isAll = (panel) => typeof panel === 'string' && panel.trim().toLowerCase() === 'all';

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

/**
 * Open a panel right of the others, the size of the current one, and select it, the way
 * juicebox-web's clone button does. Resolves to its browser, with no map yet.
 */
export async function newPanel(hic, container) {
  const { width, height } = currentBrowser(hic).config;
  const browser = await hic.createBrowser(container, { width, height });
  hic.setCurrentBrowser(browser);
  return browser;
}

function currentBrowser(hic) {
  const browser = hic.getCurrentBrowser();
  if (!browser) throw new Error('No browser');
  return browser;
}
