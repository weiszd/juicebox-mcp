import { describe, it, expect } from 'vitest';
import {
  resolvePanels,
  resolvePanel,
  panelAt,
  positionOf,
  panelLabel,
  openPanel,
  closePanel,
  findTrack,
  removeTrack,
  setTrackColor,
  setTrackName,
  setTrackDataRange,
  setTrackAutoscale,
  setTrackLogScale,
} from '../src/panels.js';
import { fakeHic, fakeTrackPair, fakeTrack2D } from './fakeJuicebox.js';

// The panels module (ADR-0007, ADR-0008): the one place panels are resolved, opened and
// closed and tracks are found and changed, for commands and peers' sync events alike.
// Specced directly against the shared fake, the second exception to "tests drive one
// package's public seam" (CLAUDE.md).

const HEART = { name: 'heart', genome: 'mm10' };
const COLON = { name: 'colon', genome: 'GRCh38' };
const container = { id: 'host' };

describe('panels module: resolving a panel spec', () => {
  it('a position picks that panel, counting from 1 on the left; a digit string is a position', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(resolvePanels(hic, 2)).toEqual([hic.browsers[1]]);
    expect(resolvePanels(hic, ' 1 ')).toEqual([hic.browsers[0]]);
  });

  it('a position past the open panels is refused', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(() => resolvePanels(hic, 3)).toThrow('no panel 3 (2 open)');
  });

  it('a map name picks the one panel showing it, matched case-insensitively', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(resolvePanels(hic, 'Colon')).toEqual([hic.browsers[1]]);
  });

  it('a map name two panels show is ambiguous, and the error names their positions', () => {
    const hic = fakeHic({ panels: [HEART, COLON, HEART] });

    expect(() => resolvePanels(hic, 'heart')).toThrow('heart matches 2 panels; use 1 or 3');
  });

  it('a map name no panel shows is refused', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(() => resolvePanels(hic, 'liver')).toThrow('no panel named liver');
  });

  it('"all" is every panel, left to right', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(resolvePanels(hic, 'ALL')).toEqual(hic.browsers);
  });

  it('omitted with one panel open is that panel', () => {
    const hic = fakeHic({ panels: [HEART] });

    expect(resolvePanels(hic, undefined)).toEqual([hic.browsers[0]]);
  });

  it('omitted with several panels open is refused, listing them and "all"', () => {
    const hic = fakeHic({ panels: [HEART, null] });

    expect(() => resolvePanels(hic)).toThrow('2 panels open; say panel: 1 (heart, mm10) | 2 (no map) | all');
  });

  it('with panel "all", a track must be named, not numbered', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(() => resolvePanels(hic, 'all', { track: 2 })).toThrow(
      'with panel "all", name the track; track 2 is a different track in each panel',
    );
    expect(resolvePanels(hic, 'all', { track: 'ctcf' })).toEqual(hic.browsers);
  });

  it('a one-panel resolve refuses "all", and its omitted-spec error does not offer it', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(() => resolvePanel(hic, 'all', 'close_panel')).toThrow('close_panel acts on one panel; "all" is not accepted');
    expect(() => resolvePanel(hic, undefined, 'close_panel')).toThrow(
      '2 panels open; say panel: 1 (heart, mm10) | 2 (colon, GRCh38)',
    );
    expect(() => resolvePanel(hic, undefined, 'close_panel')).not.toThrow('| all');
    expect(resolvePanel(hic, 'colon', 'close_panel')).toBe(hic.browsers[1]);
  });
});

describe('panels module: positions', () => {
  it('a position looks up the panel there, or nothing for a position no panel has', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(panelAt(hic, 2)).toBe(hic.browsers[1]);
    expect(panelAt(hic, 3)).toBeUndefined();
    expect(panelAt(hic, 0)).toBeUndefined();
    expect(panelAt(hic, 1.5)).toBeUndefined();
    expect(panelAt(hic, '1')).toBeUndefined();
  });

  it('a browser’s position counts from 1 on the left, 0 once it is closed', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });
    const colon = hic.browsers[1];

    expect(positionOf(hic, colon)).toBe(2);
    expect(panelLabel(hic, colon)).toBe('panel 2 (colon, GRCh38)');
    hic.deleteBrowser(colon);
    expect(positionOf(hic, colon)).toBe(0);
  });
});

describe('panels module: opening and closing a panel', () => {
  it('"new" opens an empty panel on the right, the size of the current one, and selects it', async () => {
    const hic = fakeHic({ panels: [HEART] });

    const browser = await openPanel(hic, container, 'new');

    expect(hic.browsers).toEqual([expect.anything(), browser]);
    expect(browser.dataset).toBeFalsy();
    expect(hic.createBrowser).toHaveBeenCalledWith(container, { width: 640, height: 480 });
    expect(hic.current).toBe(browser);
  });

  it('a position one past the last panel opens one there, as "new" does', async () => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    const browser = await openPanel(hic, container, 3);

    expect(positionOf(hic, browser)).toBe(3);
    expect(hic.current).toBe(browser);
  });

  it.each([2, 4, 0, undefined])('position %s, anywhere but one past the last, opens nothing', async (position) => {
    const hic = fakeHic({ panels: [HEART, COLON] });

    expect(await openPanel(hic, container, position)).toBeUndefined();
    expect(hic.createBrowser).not.toHaveBeenCalled();
    expect(hic.browsers).toHaveLength(2);
  });

  it('closing a panel takes it out; the others move left', () => {
    const hic = fakeHic({ panels: [HEART, COLON] });
    const [heart, colon] = hic.browsers;

    closePanel(hic, heart);

    expect(hic.deleteBrowser).toHaveBeenCalledWith(heart);
    expect(hic.browsers).toEqual([colon]);
    expect(positionOf(hic, colon)).toBe(1);
  });

  it('closing goes through the browser registry on a juicebox.js without deleteBrowser (4.7.0)', () => {
    const hic = fakeHic({ panels: [HEART, COLON], deleteBrowser: false });
    const heart = hic.browsers[0];

    closePanel(hic, heart);

    expect(heart.registry.delete).toHaveBeenCalledWith(heart);
    expect(hic.browsers).toHaveLength(1);
  });

  it('the last panel is never closed', () => {
    const hic = fakeHic({ panels: [HEART] });

    expect(() => closePanel(hic, hic.browsers[0])).toThrow('cannot close the last panel');
    expect(hic.deleteBrowser).not.toHaveBeenCalled();
    expect(hic.browsers).toHaveLength(1);
  });
});

describe('panels module: tracks', () => {
  /** One panel with track pairs ctcf, h3k27ac and the 2D track loops. */
  const panelWithTracks = () => {
    const hic = fakeHic({
      panels: [HEART],
      trackPairs: [fakeTrackPair('ctcf'), fakeTrackPair('h3k27ac')],
      tracks2D: [fakeTrack2D('loops')],
    });
    return { hic, browser: hic.current, ctcf: hic.current.trackPairs[0], h3k27ac: hic.current.trackPairs[1], loops: hic.current.tracks2D[0] };
  };

  it('a number counts the track pairs, then the 2D tracks, from 1', () => {
    const { browser, h3k27ac, loops } = panelWithTracks();

    expect(findTrack(browser, 2)).toEqual({ trackPair: h3k27ac });
    expect(findTrack(browser, ' 3 ')).toEqual({ track2D: loops });
  });

  it('a name is matched case-insensitively, a track pair before a 2D track of that name', () => {
    const { browser, ctcf, loops } = panelWithTracks();
    const twin = fakeTrackPair('Loops', {}, browser);
    browser.trackPairs.push(twin);

    expect(findTrack(browser, 'CTCF')).toEqual({ trackPair: ctcf });
    expect(findTrack(browser, 'loops')).toEqual({ trackPair: twin });
    browser.trackPairs.pop();
    expect(findTrack(browser, 'LOOPS')).toEqual({ track2D: loops });
  });

  it('an exact-case name wins over a case-insensitive match earlier in the list', () => {
    const { browser } = panelWithTracks();
    const upper = fakeTrackPair('CTCF', {}, browser);
    browser.trackPairs.push(upper);

    expect(findTrack(browser, 'CTCF')).toEqual({ trackPair: upper });
  });

  it('by name only, an all-digit name is the track with that name, not a position', () => {
    const { browser, h3k27ac } = panelWithTracks();
    const two = fakeTrackPair('2', {}, browser);
    browser.trackPairs.push(two);

    expect(findTrack(browser, '2', { byName: true })).toEqual({ trackPair: two });
    expect(findTrack(browser, '2')).toEqual({ trackPair: h3k27ac });
    expect(() => findTrack(browser, '3', { byName: true })).toThrow('Track not found: 3');
  });

  it.each([4, 'rad21'])('track %s, which the panel does not have, is refused', (track) => {
    const { browser } = panelWithTracks();

    expect(() => findTrack(browser, track)).toThrow(`Track not found: ${track}`);
  });

  it('remove, colour and rename reach a track pair through its own setters', () => {
    const { browser, ctcf, h3k27ac } = panelWithTracks();

    setTrackColor(browser, 'ctcf', 'rgb(0,0,255)');
    setTrackName(browser, 'ctcf', 'CTCF ChIP');
    removeTrack(browser, 2);

    expect(ctcf.setColor).toHaveBeenCalledWith('rgb(0,0,255)');
    expect(ctcf.track.name).toBe('CTCF ChIP');
    expect(ctcf.setTrackLabelName).toHaveBeenCalledWith('CTCF ChIP');
    expect(browser.layoutController.removeTrackXYPair).toHaveBeenCalledWith(h3k27ac);
  });

  it('remove, colour and rename reach a 2D track through the browser; no colour resets it', () => {
    const { browser, loops } = panelWithTracks();

    setTrackColor(browser, 'loops', undefined);
    setTrackName(browser, 'loops', 'HiCCUPS loops');
    removeTrack(browser, 'HiCCUPS loops');

    expect(browser.setTrack2DColor).toHaveBeenCalledWith(loops, undefined);
    expect(browser.setTrack2DName).toHaveBeenCalledWith(loops, 'HiCCUPS loops');
    expect(browser.removeTrack2D).toHaveBeenCalledWith(loops);
  });

  it('data range, autoscale and log scale set a track pair’s', () => {
    const { browser, ctcf } = panelWithTracks();

    setTrackDataRange(browser, 'ctcf', 0, 10);
    setTrackAutoscale(browser, 1, false);
    setTrackLogScale(browser, 'Ctcf', true);

    expect(ctcf.setDataRange).toHaveBeenCalledWith(0, 10);
    expect(ctcf.setAutoscale).toHaveBeenCalledWith(false);
    expect(ctcf.setLogScale).toHaveBeenCalledWith(true);
  });

  it.each([
    ['setTrackDataRange', (browser, track) => setTrackDataRange(browser, track, 0, 10)],
    ['setTrackAutoscale', (browser, track) => setTrackAutoscale(browser, track, true)],
    ['setTrackLogScale', (browser, track) => setTrackLogScale(browser, track, true)],
  ])('%s does not apply to a 2D track, by name or by number', (op, apply) => {
    const { browser } = panelWithTracks();

    expect(() => apply(browser, 'loops')).toThrow(`Track loops is a 2D track; ${op} does not apply to 2D tracks`);
    expect(() => apply(browser, 3)).toThrow(`Track 3 is a 2D track; ${op} does not apply to 2D tracks`);
  });
});
