import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachRemote } from '../src/attachRemote.js';

// Panels (CONTEXT.md, ADR-0007): commands addressed by `panel` to one of several
// juicebox.js browsers in the page, driven through attachRemote with fakes.

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}
FakeSocket.instances = [];

/** A 1D track pair named `name`; its setters are spies. */
function fakeTrackPair(name) {
  return {
    track: { name, config: { url: `https://tracks.example/${name}.bw` } },
    setColor: vi.fn(),
    setDataRange: vi.fn(),
    setAutoscale: vi.fn(),
    setLogScale: vi.fn(),
  };
}

/**
 * A juicebox.js namespace holding one browser per entry of `panels`, left to
 * right, the last one current. An entry is `{name, genome}` for a panel with a
 * map, or `null` for one without. Browsers share one registry, as juicebox.js's
 * do; `registry.delete` disposes a browser, and the first remaining one becomes
 * current if it was.
 */
function fakeHic(panels) {
  const browsers = [];
  let current;
  const registry = {
    delete: vi.fn((browser) => {
      browsers.splice(browsers.indexOf(browser), 1);
      if (current === browser) current = browsers[0];
    }),
  };
  const dataset = ({ name, genome }) => ({ name, genomeId: genome, isWholeGenome: (chr) => chr === 0 });
  const newBrowser = (panel, config = { width: 640, height: 480 }) => {
    const browser = {
      config,
      registry,
      dataset: panel ? dataset(panel) : undefined,
      controlDataset: undefined,
      state: {
        chr1: 8,
        getLocus: () => ({
          x: { chr: 'chr8', start: 127_000_000, end: 129_000_000 },
          y: { chr: 'chr8', start: 127_000_000, end: 129_000_000 },
        }),
      },
      coordinator: { addCallback: () => () => {} },
      loadHicFile: vi.fn(async ({ url, name }) => {
        browser.dataset = dataset({ name: name ?? url, genome: 'mm10' });
      }),
      loadHicControlFile: vi.fn(async ({ url }) => {
        browser.controlDataset = { name: url };
      }),
      parseGotoInput: vi.fn(async () => {}),
      zoomAndCenter: vi.fn(async () => {}),
      getColorScale: () => ({ getThreshold: () => 2000, setColorComponents: vi.fn() }),
      setColorScaleThreshold: vi.fn(),
      setNormalization: vi.fn(),
      getDisplayMode: () => 'A',
      setDisplayMode: vi.fn(async () => {}),
      contactMatrixView: {
        setColorScale: vi.fn(),
        setBackgroundColor: vi.fn(),
        viewportElement: { clientWidth: 800, clientHeight: 600 },
        getViewDimensions: () => ({ width: 800, height: 600 }),
      },
      trackPairs: [],
      tracks2D: [],
      loadTracks: vi.fn(),
      layoutController: { removeTrackXYPair: vi.fn() },
      removeTrack2D: vi.fn(),
    };
    return browser;
  };
  for (const panel of panels) browsers.push(newBrowser(panel));
  current = browsers.at(-1);
  return {
    EventBus: { globalBus: { subscribe() {}, unsubscribe() {} } },
    getCurrentBrowser: () => current,
    getAllBrowsers: () => [...browsers],
    setCurrentBrowser: vi.fn((browser) => (current = browser)),
    createBrowser: vi.fn(async (container, config) => {
      const browser = newBrowser(null, config);
      browsers.push(browser);
      return browser;
    }),
    restoreSession: vi.fn(async () => {}),
    compressedSession: () => 'session=blob:x',
    browsers,
  };
}

const HEART = { name: 'heart', genome: 'mm10' };
const COLON = { name: 'colon', genome: 'GRCh38' };
const LIVER = { name: 'liver', genome: 'mm10' };

const container = { id: 'host' };
let nextId = 0;

/** Attach `hic` to a joined room; `send(cmd)` resolves to that command's ack. */
async function joinedWith(hic) {
  attachRemote({ hic, container, url: 'wss://jbmcp.example/ws', room: 'r', createSocket: (u) => new FakeSocket(u) });
  await Promise.resolve();
  const socket = FakeSocket.instances.at(-1);
  socket.open();
  socket.receive({ type: 'joined', room: 'r' });
  return async (cmd) => {
    const requestId = `c${++nextId}`;
    socket.receive({ ...cmd, requestId });
    for (let i = 0; i < 50; i++) {
      const ack = socket.sent.find((m) => m.type === 'ack' && m.requestId === requestId);
      if (ack) {
        const { type, requestId: _, ...rest } = ack;
        return rest;
      }
      await Promise.resolve();
    }
    throw new Error(`no ack for ${cmd.type}`);
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('panels: which panel a command acts on', () => {
  it('a position picks that panel, counting from 1 on the left', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    const ack = await send({ type: 'gotoLocus', locus: 'MYC', panel: 2 });

    expect(ack).toEqual({ ok: true, result: 'panel 2 (colon, GRCh38): ok' });
    expect(hic.browsers[0].parseGotoInput).not.toHaveBeenCalled();
    expect(hic.browsers[1].parseGotoInput).toHaveBeenCalledWith('MYC');
  });

  it('a string of digits is a position, not a map name', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    expect(await send({ type: 'gotoLocus', locus: 'MYC', panel: ' 1 ' })).toEqual({ ok: true, result: 'panel 1 (heart, mm10): ok' });
    expect(hic.browsers[1].parseGotoInput).not.toHaveBeenCalled();
  });

  it('a map name picks the one panel showing it, case-insensitively', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    expect(await send({ type: 'setNormalization', normalization: 'KR', panel: 'Heart' })).toEqual({ ok: true, result: 'panel 1 (heart, mm10): ok' });
    expect(hic.browsers[0].setNormalization).toHaveBeenCalledWith('KR');
    expect(hic.browsers[1].setNormalization).not.toHaveBeenCalled();
  });

  it('a map name shown in several panels is refused, naming their positions', async () => {
    const hic = fakeHic([HEART, COLON, HEART, HEART]);
    const send = await joinedWith(hic);

    expect(await send({ type: 'gotoLocus', locus: 'MYC', panel: 'heart' })).toEqual({ ok: false, error: 'heart matches 3 panels; use 1, 3 or 4' });
    expect(hic.browsers.some((b) => b.parseGotoInput.mock.calls.length)).toBe(false);
  });

  it('an unknown map name is refused', async () => {
    const send = await joinedWith(fakeHic([HEART, COLON]));

    expect(await send({ type: 'gotoLocus', locus: 'MYC', panel: 'spleen' })).toEqual({ ok: false, error: 'no panel named spleen' });
  });

  it('a position past the last panel is refused, with the panel count', async () => {
    const send = await joinedWith(fakeHic([HEART, COLON]));

    expect(await send({ type: 'gotoLocus', locus: 'MYC', panel: 3 })).toEqual({ ok: false, error: 'no panel 3 (2 open)' });
  });

  it('"all" applies to every panel, one ack line each', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    const ack = await send({ type: 'gotoLocus', locus: 'MYC', panel: 'ALL' });

    expect(ack).toEqual({ ok: true, result: 'panel 1 (heart, mm10): ok\npanel 2 (colon, GRCh38): ok' });
    expect(hic.browsers.map((b) => b.parseGotoInput.mock.calls)).toEqual([[['MYC']], [['MYC']]]);
  });

  it('omitted with one panel open means that panel', async () => {
    const hic = fakeHic([HEART]);
    const send = await joinedWith(hic);

    expect(await send({ type: 'zoomIn' })).toEqual({ ok: true, result: 'panel 1 (heart, mm10): ok' });
    expect(hic.browsers[0].zoomAndCenter).toHaveBeenCalledWith(1, 400, 300);
  });

  it('omitted with two panels open is refused, listing the panels and "all", and nothing is applied', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    expect(await send({ type: 'loadTrack', url: 'https://tracks.example/ctcf.bw' })).toEqual({
      ok: false,
      error: '2 panels open; say panel: 1 (heart, mm10) | 2 (colon, GRCh38) | all',
    });
    expect(hic.browsers.some((b) => b.loadTracks.mock.calls.length)).toBe(false);
  });

  it.each([
    ['loadMap', { url: 'https://maps.example/a.hic' }],
    ['loadControlMap', { url: 'https://maps.example/b.hic' }],
    ['closePanel', {}],
    ['getTrackList', {}],
  ])('%s omitted with two panels open lists the panels without "all", which it does not take', async (type, args) => {
    const send = await joinedWith(fakeHic([HEART, COLON]));

    expect(await send({ type, ...args })).toEqual({ ok: false, error: '2 panels open; say panel: 1 (heart, mm10) | 2 (colon, GRCh38)' });
  });

  it.each([
    ['loadMap', 'load_map', { url: 'https://maps.example/a.hic' }],
    ['loadControlMap', 'load_control_map', { url: 'https://maps.example/b.hic' }],
    ['closePanel', 'close_panel', {}],
    ['getTrackList', 'list_tracks', {}],
  ])('%s refuses "all"', async (type, tool, args) => {
    const send = await joinedWith(fakeHic([HEART, COLON]));

    expect(await send({ type, ...args, panel: 'all' })).toEqual({ ok: false, error: `${tool} acts on one panel; "all" is not accepted` });
  });
});

describe('panels: "all" when some panels fail', () => {
  it('succeeds with one line per panel when at least one panel succeeds', async () => {
    const hic = fakeHic([HEART, null, COLON]);
    hic.browsers[2].parseGotoInput.mockRejectedValue(new Error('Unrecognized locus: chrZ'));
    const send = await joinedWith(hic);

    expect(await send({ type: 'gotoLocus', locus: 'chrZ', panel: 'all' })).toEqual({
      ok: true,
      result: 'panel 1 (heart, mm10): ok\npanel 2 (no map): No map loaded\npanel 3 (colon, GRCh38): Unrecognized locus: chrZ',
    });
  });

  it('fails with every panel\'s line when every panel fails', async () => {
    const send = await joinedWith(fakeHic([null, null]));

    expect(await send({ type: 'setColorScale', action: 'set', value: 50, panel: 'all' })).toEqual({
      ok: false,
      error: 'panel 1 (no map): No map loaded\npanel 2 (no map): No map loaded',
    });
  });
});

describe('panels: tracks', () => {
  it('loadTrack {panel} loads into that panel only; "all" into each', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    await send({ type: 'loadTrack', url: 'https://tracks.example/ctcf.bw', panel: 'heart' });
    expect(hic.browsers.map((b) => b.loadTracks.mock.calls.length)).toEqual([1, 0]);

    await send({ type: 'loadTrack', url: 'https://tracks.example/genes.bb', panel: 'all' });
    expect(hic.browsers.map((b) => b.loadTracks.mock.calls.length)).toEqual([2, 1]);
  });

  it('a track command with "all" finds the track by name in each panel and reports the panel that lacks it', async () => {
    const hic = fakeHic([HEART, COLON]);
    const heartCtcf = fakeTrackPair('CTCF');
    hic.browsers[0].trackPairs = [fakeTrackPair('genes'), heartCtcf];
    hic.browsers[1].trackPairs = [fakeTrackPair('DNase')];
    const send = await joinedWith(hic);

    const ack = await send({ type: 'setTrackColor', track: 'ctcf', color: { r: 255, g: 0, b: 0 }, panel: 'all' });

    expect(ack).toEqual({ ok: true, result: 'panel 1 (heart, mm10): ok\npanel 2 (colon, GRCh38): Track not found: ctcf' });
    expect(heartCtcf.setColor).toHaveBeenCalledWith('rgb(255,0,0)');
  });

  it('a track command with "all" refuses a track number, which means a different track in each panel', async () => {
    const hic = fakeHic([HEART, COLON]);
    hic.browsers[0].trackPairs = [fakeTrackPair('genes')];
    hic.browsers[1].trackPairs = [fakeTrackPair('DNase')];
    const send = await joinedWith(hic);

    expect(await send({ type: 'removeTrack', track: '1', panel: 'all' })).toEqual({
      ok: false,
      error: 'with panel "all", name the track; track 1 is a different track in each panel',
    });
    expect(hic.browsers.some((b) => b.layoutController.removeTrackXYPair.mock.calls.length)).toBe(false);
  });

  it('a track number still works for one panel', async () => {
    const hic = fakeHic([HEART, COLON]);
    const dnase = fakeTrackPair('DNase');
    hic.browsers[1].trackPairs = [dnase];
    const send = await joinedWith(hic);

    expect(await send({ type: 'setTrackAutoscale', track: '1', enabled: false, panel: 2 })).toEqual({ ok: true, result: 'panel 2 (colon, GRCh38): ok' });
    expect(dnase.setAutoscale).toHaveBeenCalledWith(false);
  });

  it('getTrackList {panel} lists that panel\'s tracks', async () => {
    const hic = fakeHic([HEART, COLON]);
    hic.browsers[1].trackPairs = [fakeTrackPair('DNase')];
    const send = await joinedWith(hic);

    const { result } = await send({ type: 'getTrackList', panel: 'colon' });

    expect(result.map((t) => t.name)).toEqual(['DNase']);
  });
});

describe('panels: loadMap', () => {
  it('panel "new" opens a panel the size of the current one, makes it current, loads there and names it', async () => {
    const hic = fakeHic([COLON]);
    const send = await joinedWith(hic);

    const ack = await send({ type: 'loadMap', url: 'https://maps.example/heart.hic', name: 'heart', panel: 'new' });

    expect(hic.createBrowser).toHaveBeenCalledWith(container, { width: 640, height: 480 });
    const created = hic.browsers[1];
    expect(hic.setCurrentBrowser).toHaveBeenCalledWith(created);
    expect(created.loadHicFile).toHaveBeenCalledWith({ url: 'https://maps.example/heart.hic', name: 'heart' });
    expect(hic.browsers[0].loadHicFile).not.toHaveBeenCalled();
    expect(ack).toEqual({ ok: true, result: 'loaded heart into panel 2 of 2 (heart, mm10)' });
  });

  it('panel "new" with a locus goes to that locus again after the load (juicebox.js adopts a peer\'s view)', async () => {
    const hic = fakeHic([HEART]);
    const send = await joinedWith(hic);

    await send({ type: 'loadMap', url: 'https://maps.example/gm.hic', name: 'GM12878', locus: 'chr8:127mb-129mb', panel: 'new' });

    const created = hic.browsers[1];
    expect(created.parseGotoInput).toHaveBeenCalledWith('chr8:127mb-129mb');
    expect(created.parseGotoInput.mock.invocationCallOrder[0]).toBeGreaterThan(created.loadHicFile.mock.invocationCallOrder[0]);
  });

  it('without a locus nothing is re-applied', async () => {
    const hic = fakeHic([HEART]);
    const send = await joinedWith(hic);

    await send({ type: 'loadMap', url: 'https://maps.example/gm.hic', panel: 'new' });

    expect(hic.browsers[1].parseGotoInput).not.toHaveBeenCalled();
  });

  it('an existing panel has its map replaced', async () => {
    const hic = fakeHic([HEART, COLON]);
    const send = await joinedWith(hic);

    const ack = await send({ type: 'loadMap', url: 'https://maps.example/liver.hic', name: 'liver', panel: 1 });

    expect(hic.createBrowser).not.toHaveBeenCalled();
    expect(hic.browsers[0].loadHicFile).toHaveBeenCalledWith({ url: 'https://maps.example/liver.hic', name: 'liver' });
    expect(ack).toEqual({ ok: true, result: 'loaded liver into panel 1 of 2 (liver, mm10)' });
  });
});

describe('panels: closePanel', () => {
  it('closes the addressed panel through hic.deleteBrowser when the namespace exports it', async () => {
    const hic = fakeHic([HEART, COLON, LIVER]);
    const colon = hic.browsers[1];
    hic.deleteBrowser = vi.fn((browser) => hic.browsers.splice(hic.browsers.indexOf(browser), 1));
    const send = await joinedWith(hic);

    const ack = await send({ type: 'closePanel', panel: 'colon' });

    expect(hic.deleteBrowser).toHaveBeenCalledWith(colon);
    expect(colon.registry.delete).not.toHaveBeenCalled();
    expect(ack).toEqual({ ok: true, result: 'closed panel 2 (colon, GRCh38); remaining: 1 (heart, mm10) | 2 (liver, mm10)' });
  });

  it('falls back to its registry without hic.deleteBrowser (juicebox.js 4.7.0) and reports the remaining numbering', async () => {
    const hic = fakeHic([HEART, COLON, LIVER]);
    const colon = hic.browsers[1];
    const send = await joinedWith(hic);

    const ack = await send({ type: 'closePanel', panel: 'colon' });

    expect(colon.registry.delete).toHaveBeenCalledWith(colon);
    expect(ack).toEqual({ ok: true, result: 'closed panel 2 (colon, GRCh38); remaining: 1 (heart, mm10) | 2 (liver, mm10)' });
  });

  it('refuses to close the last panel', async () => {
    const hic = fakeHic([HEART]);
    const send = await joinedWith(hic);

    expect(await send({ type: 'closePanel', panel: 1 })).toEqual({ ok: false, error: 'cannot close the last panel' });
    expect(hic.browsers[0].registry.delete).not.toHaveBeenCalled();
    expect(hic.getAllBrowsers()).toHaveLength(1);
  });
});

describe('panels: getPanelList', () => {
  it('lists every panel left to right: position, current, map, genome, control map, track count, locus', async () => {
    const hic = fakeHic([HEART, null, COLON]);
    hic.browsers[0].controlDataset = { name: 'heart control' };
    hic.browsers[0].trackPairs = [fakeTrackPair('genes')];
    hic.browsers[0].tracks2D = [{ name: 'loops', config: {} }];
    hic.browsers[2].state.chr1 = 0; // whole genome
    const send = await joinedWith(hic);

    const { ok, result } = await send({ type: 'getPanelList' });

    expect(ok).toBe(true);
    expect(result).toEqual([
      { panel: 1, current: false, map: 'heart', genome: 'mm10', controlMap: 'heart control', tracks: 2,
        locus: 'chr8:127,000,001-129,000,000 chr8:127,000,001-129,000,000' },
      { panel: 2, current: false, map: null, genome: null, controlMap: null, tracks: 0, locus: null },
      { panel: 3, current: true, map: 'colon', genome: 'GRCh38', controlMap: null, tracks: 0, locus: 'All' },
    ]);
  });
});
