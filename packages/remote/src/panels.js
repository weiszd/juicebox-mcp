/**
 * Panels (GLOSSARY.md: panel; ADR-0007, ADR-0008): the one place the remote resolves which
 * juicebox.js browsers a command or a peer's sync event addresses, opens and closes panels,
 * and finds and changes a panel's tracks. The command applier (applyCommand.js) and the
 * sync-event observer (observe.js) both call it, so the two paths cannot disagree.
 *
 * Commands address panels by a spec (resolvePanels, resolvePanel); sync events by
 * position only (panelAt), over the same lookup.
 */

/**
 * The browsers a panel spec addresses: a 1-based position from the left (a string of
 * digits is one too), "all", or a map name matched case-insensitively that must be unique.
 * Omitted means the current panel, and is an error when more than one panel is open.
 * With "all" a track must be named (`track`): a track number is a position in one panel's
 * list and means a different track in each.
 *
 * @param {object} hic
 * @param {number|string} [spec]
 * @param {{track?: number|string, acceptsAll?: boolean}} [opts]  `acceptsAll` false leaves
 *   "all" out of the omitted-spec error, for a command that acts on one panel
 */
export function resolvePanels(hic, spec, { track, acceptsAll = true } = {}) {
  const browsers = hic.getAllBrowsers();
  if (spec === undefined || spec === null) {
    if (browsers.length === 1) return [currentBrowser(hic)];
    if (browsers.length === 0) throw new Error('No browser');
    const labels = browsers.map((b, i) => `${i + 1} (${datasetLabel(b)})`);
    throw new Error(`${browsers.length} panels open; say panel: ${labels.join(' | ')}${acceptsAll ? ' | all' : ''}`);
  }
  // A string of digits ("2") is a position, not a name.
  if (typeof spec === 'string' && /^\d+$/.test(spec.trim())) spec = Number(spec);
  if (typeof spec === 'number') {
    const browser = panelAt(hic, spec);
    if (!browser) throw new Error(`no panel ${spec} (${browsers.length} open)`);
    return [browser];
  }
  if (isAll(spec)) {
    if (track !== undefined && isTrackNumber(track)) {
      throw new Error(`with panel "all", name the track; track ${track} is a different track in each panel`);
    }
    return browsers;
  }
  const positions = [];
  browsers.forEach((b, i) => {
    if (b.dataset?.name?.toLowerCase() === spec.toLowerCase()) positions.push(i + 1);
  });
  if (positions.length === 0) throw new Error(`no panel named ${spec}`);
  if (positions.length > 1) {
    throw new Error(`${spec} matches ${positions.length} panels; use ${positions.slice(0, -1).join(', ')} or ${positions.at(-1)}`);
  }
  return [browsers[positions[0] - 1]];
}

/** The one browser a spec addresses, for a command (`tool`) that does not take "all". */
export function resolvePanel(hic, spec, tool) {
  if (isAll(spec)) throw new Error(`${tool} acts on one panel; "all" is not accepted`);
  return resolvePanels(hic, spec, { acceptsAll: false })[0];
}

/** The browser at a 1-based position, what a sync event names; undefined when there is none. */
export function panelAt(hic, position) {
  if (!Number.isInteger(position) || position < 1) return undefined;
  return hic.getAllBrowsers()[position - 1];
}

/**
 * Open a panel right of the others, the size of the current one, and select it, the way
 * juicebox-web's clone button does; resolves to its browser, with no map yet. `at` is
 * "new", or a position (a peer's panelOpen), which opens one only when it is one past the
 * last panel, so positions stay aligned (ADR-0008); anywhere else resolves to undefined.
 */
export async function openPanel(hic, container, at) {
  if (at !== 'new' && at !== hic.getAllBrowsers().length + 1) return undefined;
  const { width, height } = currentBrowser(hic).config;
  const browser = await hic.createBrowser(container, { width, height });
  hic.setCurrentBrowser(browser);
  return browser;
}

/**
 * Close a panel; never the last one, a page always shows one. The fallback covers juicebox.js
 * builds without the `deleteBrowser` export (upstream 4.7.0); it goes away when the peer
 * dependency is raised (ADR-0007).
 */
export function closePanel(hic, browser) {
  if (hic.getAllBrowsers().length === 1) throw new Error('cannot close the last panel');
  if (hic.deleteBrowser) hic.deleteBrowser(browser);
  else browser.registry.delete(browser);
}

/** A browser's 1-based position from the left, what list_panels prints; 0 once it is closed. */
export const positionOf = (hic, browser) => hic.getAllBrowsers().indexOf(browser) + 1;

/** "panel 2 (heart, mm10)", or "panel 2 (no map)". */
export const panelLabel = (hic, browser) => `panel ${positionOf(hic, browser)} (${datasetLabel(browser)})`;

/** "heart, mm10", or "no map". */
export const datasetLabel = ({ dataset }) => (dataset ? `${dataset.name}, ${dataset.genomeId}` : 'no map');

/**
 * The track a command or a peer's sync event names on a panel, as `{trackPair}` or
 * `{track2D}`: a 1-based number over the track pairs then the 2D tracks (the order
 * list_tracks numbers them in), or else a name, matched case-insensitively, a track pair
 * before a 2D track. Throws for a track the panel does not have.
 */
export function findTrack({ trackPairs, tracks2D }, track) {
  const id = String(track).trim();
  let trackPair, track2D;
  if (isTrackNumber(id)) {
    const i = Number(id) - 1;
    trackPair = trackPairs[i];
    if (!trackPair && i >= trackPairs.length) track2D = tracks2D[i - trackPairs.length];
  } else {
    const named = (t) => t.name?.toLowerCase() === id.toLowerCase();
    trackPair = trackPairs.find((tp) => named(tp.track));
    if (!trackPair) track2D = tracks2D.find(named);
  }
  if (!trackPair && !track2D) throw new Error(`Track not found: ${track}`);
  return trackPair ? { trackPair } : { track2D };
}

export function removeTrack(browser, track) {
  const { trackPair, track2D } = findTrack(browser, track);
  if (track2D) browser.removeTrack2D(track2D);
  else browser.layoutController.removeTrackXYPair(trackPair);
}

/** `color` an rgb or CSS colour string; none resets the track to its default (a 2D track's features' own colours). */
export function setTrackColor(browser, track, color) {
  const { trackPair, track2D } = findTrack(browser, track);
  if (track2D) browser.setTrack2DColor(track2D, color);
  else trackPair.setColor(color);
}

export function setTrackName(browser, track, name) {
  const { trackPair, track2D } = findTrack(browser, track);
  if (track2D) browser.setTrack2DName(track2D, name);
  // What the track menu's rename writes; igv's name setter relabels the row, which posts the change event once.
  else trackPair.track.name = name;
}

export const setTrackDataRange = (browser, track, min, max) =>
  trackPairFor(browser, track, 'setTrackDataRange').setDataRange(min, max);

export const setTrackAutoscale = (browser, track, enabled) =>
  trackPairFor(browser, track, 'setTrackAutoscale').setAutoscale(enabled);

export const setTrackLogScale = (browser, track, enabled) =>
  trackPairFor(browser, track, 'setTrackLogScale').setLogScale(enabled);

/** The track pair `track` names; throws for a 2D track, which has no data range or scale (`op`). */
function trackPairFor(browser, track, op) {
  const { trackPair } = findTrack(browser, track);
  if (!trackPair) throw new Error(`Track ${track} is a 2D track; ${op} does not apply to 2D tracks`);
  return trackPair;
}

const isAll = (spec) => typeof spec === 'string' && spec.trim().toLowerCase() === 'all';

const isTrackNumber = (track) => /^\d+$/.test(String(track).trim());

function currentBrowser(hic) {
  const browser = hic.getCurrentBrowser();
  if (!browser) throw new Error('No browser');
  return browser;
}
