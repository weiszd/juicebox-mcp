// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://juicebox.example/app/?x=1"}
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachRemote, Status } from '../src/attachRemote.js';
import { FakeSocket, fakeHic, fakeTrackPair, fakeTrack2D, MAP_A } from './fakeJuicebox.js';

const hic = fakeHic();
const container = {};
const url = 'wss://jbmcp.example/ws';

const flush = () => Promise.resolve(); // the first connect is deferred to a microtask

async function attach(extra = {}) {
  const onStatus = vi.fn();
  const onToolCall = vi.fn();
  const remote = attachRemote({
    hic,
    container,
    url,
    onStatus,
    onToolCall,
    createSocket: (u) => new FakeSocket(u),
    ...extra,
  });
  await flush();
  return { remote, onStatus, onToolCall, socket: () => FakeSocket.instances.at(-1) };
}

const acksOf = (socket) => socket.sent.filter((m) => m.type === 'ack');

/** Attach to a joined room with the given fake `hic`; `send(cmd)` resolves to that command's ack. */
async function joinedWith(fake) {
  const { socket } = await attach({ hic: fake, room: 'r' });
  const s = socket();
  s.open();
  s.receive({ type: 'joined', room: 'r' });
  const send = async (cmd) => {
    s.receive(cmd);
    // Commands are async and queued; allow a generous number of microtask turns for the ack.
    for (let i = 0; i < 50; i++) {
      const ack = acksOf(s).find((a) => a.requestId === cmd.requestId);
      if (ack) return ack;
      await Promise.resolve();
    }
    throw new Error(`no ack for ${cmd.requestId}`);
  };
  return { socket: s, send };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('attachRemote: join', () => {
  it('reports connecting only after attachRemote has returned', async () => {
    const onStatus = vi.fn();
    const remote = attachRemote({ hic, container, url, onStatus, createSocket: (u) => new FakeSocket(u) });
    expect(onStatus).not.toHaveBeenCalled();
    await flush();
    expect(onStatus).toHaveBeenCalledWith(Status.CONNECTING);
    remote.detach();
  });

  it('connects with ?room= and sends join {room} when a room is given', async () => {
    const { socket, onStatus } = await attach({ room: 'c0ffee1234' });
    expect(onStatus).toHaveBeenCalledWith('connecting');
    expect(socket().url).toBe('wss://jbmcp.example/ws?room=c0ffee1234');
    socket().open();
    expect(socket().sent).toEqual([{ type: 'join', room: 'c0ffee1234' }]);
  });

  it('connects without ?room= and sends a bare join when no room is given', async () => {
    const { socket } = await attach();
    expect(socket().url).toBe(url);
    socket().open();
    expect(socket().sent).toEqual([{ type: 'join' }]);
  });

  it('becomes open on joined and exposes the (minted) room and joinUrl', async () => {
    const { remote, socket, onStatus } = await attach();
    expect(remote.room).toBeUndefined();
    expect(remote.joinUrl).toBeUndefined();
    socket().open();
    socket().receive({ type: 'joined', room: 'ABCDEFGH23' });
    expect(onStatus).toHaveBeenLastCalledWith('open');
    expect(remote.room).toBe('ABCDEFGH23');
    expect(remote.joinUrl).toBe('https://juicebox.example/app/?x=1&room=ABCDEFGH23');
  });

  it('reports expired on error {code: room-expired} and stops reconnecting', async () => {
    const { remote, socket, onStatus } = await attach({ room: 'gone000000' });
    socket().open();
    socket().receive({ type: 'error', code: 'room-expired' });
    expect(onStatus).toHaveBeenLastCalledWith('expired');
    expect(socket().closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(remote.room).toBeUndefined();
  });

  it('ignores an error without a code', async () => {
    const { socket, onStatus } = await attach({ room: 'r' });
    socket().open();
    socket().receive({ type: 'joined', room: 'r' });
    socket().receive({ type: 'error', message: 'something' });
    expect(onStatus).toHaveBeenLastCalledWith('open');
  });
});

describe('attachRemote: reconnect', () => {
  it('reports closed on a drop, then reconnects and re-sends join with the known room', async () => {
    const { socket, onStatus } = await attach();
    socket().open();
    socket().receive({ type: 'joined', room: 'MINTED0001' });
    const first = socket();
    first.drop();
    expect(onStatus).toHaveBeenLastCalledWith('closed');

    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    const second = socket();
    expect(second).not.toBe(first);
    expect(second.url).toBe('wss://jbmcp.example/ws?room=MINTED0001');
    expect(onStatus).toHaveBeenLastCalledWith('connecting');
    second.open();
    expect(second.sent).toEqual([{ type: 'join', room: 'MINTED0001' }]);
    second.receive({ type: 'joined', room: 'MINTED0001' });
    expect(onStatus).toHaveBeenLastCalledWith('open');
  });

  it('a socket that errors before opening is retried', async () => {
    const { socket } = await attach({ room: 'r' });
    socket().onerror?.({});
    socket().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe('attachRemote: detach', () => {
  it('closes the socket, reports closed, and does not reconnect', async () => {
    const { remote, socket, onStatus } = await attach({ room: 'r' });
    socket().open();
    socket().receive({ type: 'joined', room: 'r' });
    remote.detach();
    expect(socket().closed).toBe(true);
    expect(onStatus).toHaveBeenLastCalledWith('closed');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('after expired, detach is a no-op and does not report closed', async () => {
    const { remote, socket, onStatus } = await attach({ room: 'gone000000' });
    socket().open();
    socket().receive({ type: 'error', code: 'room-expired' });
    remote.detach();
    expect(onStatus).toHaveBeenLastCalledWith('expired');
  });

  it('cancels a pending reconnect', async () => {
    const { remote, socket } = await attach({ room: 'r' });
    socket().drop();
    remote.detach();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('is idempotent and ignores messages after detach', async () => {
    const { remote, socket, onStatus, onToolCall } = await attach({ room: 'r' });
    socket().open();
    remote.detach();
    remote.detach();
    socket().receive({ type: 'toolCall', name: 'load_map' });
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.filter(([s]) => s === 'closed')).toHaveLength(1);
  });
});

describe('attachRemote: messages', () => {
  it('toolCall {name} invokes onToolCall(name)', async () => {
    const { socket, onToolCall } = await attach({ room: 'r' });
    socket().open();
    socket().receive({ type: 'toolCall', name: 'goto_locus' });
    expect(onToolCall).toHaveBeenCalledWith('goto_locus');
  });

  it('tolerates malformed JSON and unknown message types', async () => {
    const { socket, onStatus } = await attach({ room: 'r' });
    socket().open();
    socket().onmessage({ data: '{not json' });
    socket().receive({ type: 'whatever' });
    socket().receive(null);
    expect(onStatus).toHaveBeenLastCalledWith('connecting');
  });

  it('works without onStatus / onToolCall', async () => {
    const remote = attachRemote({ hic, container, url, room: 'r', createSocket: (u) => new FakeSocket(u) });
    await flush();
    const s = FakeSocket.instances.at(-1);
    s.open();
    s.receive({ type: 'joined', room: 'r' });
    s.receive({ type: 'toolCall', name: 'x' });
    expect(remote.room).toBe('r');
    remote.detach();
  });
});

describe('attachRemote: arguments', () => {
  it('requires hic, container and url', () => {
    expect(() => attachRemote({ container, url })).toThrow(/hic/);
    expect(() => attachRemote({ hic, url })).toThrow(/container/);
    expect(() => attachRemote({ hic, container })).toThrow(/url/);
  });
});

// How a command's ack names the fake's one panel, whose dataset (MAP_A) has no genome.
const PANEL_1 = 'panel 1 (A, undefined)';

describe('attachRemote: view commands', () => {
  it('gotoLocus calls parseGotoInput with the locus and acks ok', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'gotoLocus', requestId: 'q1', locus: 'chr1:10mb-20mb' });
    expect(fake.current.parseGotoInput).toHaveBeenCalledWith('chr1:10mb-20mb');
    expect(ack).toEqual({ type: 'ack', requestId: 'q1', ok: true, result: `${PANEL_1}: ok` });
  });
});

describe('attachRemote: command failures', () => {
  it('a view command before any map is loaded acks ok:false without calling the surface', async () => {
    const fake = fakeHic({ panels: [null] });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'gotoLocus', requestId: 'q2', locus: 'chr1' });
    expect(ack).toEqual({ type: 'ack', requestId: 'q2', ok: false, error: 'panel 1 (no map): No map loaded' });
    expect(fake.current.parseGotoInput).not.toHaveBeenCalled();
  });

  it('an unknown command type acks ok:false naming the type', async () => {
    const { send } = await joinedWith(fakeHic());
    const ack = await send({ type: 'launchRocket', requestId: 'q3' });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/launchRocket/);
  });

  it('a surface call that rejects acks ok:false with its message, and later commands still apply', async () => {
    const fake = fakeHic();
    fake.current.parseGotoInput.mockRejectedValueOnce(new Error('Unrecognized locus: chrZ'));
    const { send } = await joinedWith(fake);
    expect(await send({ type: 'gotoLocus', requestId: 'q4', locus: 'chrZ' })).toEqual({
      type: 'ack',
      requestId: 'q4',
      ok: false,
      error: `${PANEL_1}: Unrecognized locus: chrZ`,
    });
    expect((await send({ type: 'gotoLocus', requestId: 'q5', locus: 'chr1' })).ok).toBe(true);
  });

  it('a surface call that throws synchronously acks ok:false', async () => {
    const fake = fakeHic();
    fake.current.setNormalization.mockImplementation(() => {
      throw new Error('disposed');
    });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setNormalization', requestId: 'q6', normalization: 'KR' });
    expect(ack).toEqual({ type: 'ack', requestId: 'q6', ok: false, error: `${PANEL_1}: disposed` });
  });

  it('a non-command message carrying a requestId (e.g. an ack) is not acked back', async () => {
    const { socket, send } = await joinedWith(fakeHic());
    socket.receive({ type: 'ack', requestId: 'echo', ok: true });
    await send({ type: 'zoomIn', requestId: 'after' }); // drains the queue
    expect(acksOf(socket).map((a) => a.requestId)).toEqual(['after']);
  });

  it('a command without a requestId gets no ack and no surface call', async () => {
    const fake = fakeHic();
    const { socket, send } = await joinedWith(fake);
    socket.receive({ type: 'gotoLocus', locus: 'chr1' });
    await send({ type: 'zoomIn', requestId: 'after' }); // drains the queue
    expect(fake.current.parseGotoInput).not.toHaveBeenCalled();
    expect(acksOf(socket).map((a) => a.requestId)).toEqual(['after']);
  });
});

describe('attachRemote: §5.2 view command rows', () => {
  it('loadMap calls loadHicFile with the map config, even with no map loaded yet', async () => {
    const fake = fakeHic({ panels: [null] });
    // A map whose dataset carries neither a name nor a genome.
    fake.current.loadHicFile.mockImplementationOnce(async ({ url }) => (fake.current.dataset = { url }));
    const { send } = await joinedWith(fake);
    const cmd = { url: 'https://maps.example/b.hic', name: 'B', normalization: 'KR', locus: 'chr1 chr1' };
    const ack = await send({ type: 'loadMap', requestId: 'm1', ...cmd });
    expect(fake.current.loadHicFile).toHaveBeenCalledWith(cmd);
    expect(ack).toEqual({
      type: 'ack',
      requestId: 'm1',
      ok: true,
      result: `loaded ${cmd.url} into panel 1 of 1 (undefined, undefined)`,
    });
  });

  it('loadControlMap with a base map present loads it and sets display mode AOB', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const cmd = { url: 'https://maps.example/ctl.hic', name: 'ctl', normalization: 'VC' };
    const ack = await send({ type: 'loadControlMap', requestId: 'c1', ...cmd });
    expect(fake.current.loadHicControlFile).toHaveBeenCalledWith(cmd);
    expect(fake.current.setDisplayMode).toHaveBeenCalledWith('AOB');
    expect(fake.current.loadHicControlFile.mock.invocationCallOrder[0]).toBeLessThan(
      fake.current.setDisplayMode.mock.invocationCallOrder[0],
    );
    expect(ack.ok).toBe(true);
  });

  it('loadControlMap without a base map leaves the display mode alone', async () => {
    const fake = fakeHic({ panels: [null] });
    const { send } = await joinedWith(fake);
    await send({ type: 'loadControlMap', requestId: 'c2', url: 'https://maps.example/ctl.hic' });
    expect(fake.current.loadHicControlFile).toHaveBeenCalled();
    expect(fake.current.setDisplayMode).not.toHaveBeenCalled();
  });

  it('loadControlMap does not re-set AOB when already in AOB', async () => {
    const fake = fakeHic();
    fake.current.getDisplayMode.mockReturnValue('AOB');
    const { send } = await joinedWith(fake);
    await send({ type: 'loadControlMap', requestId: 'c3', url: 'https://maps.example/ctl.hic' });
    expect(fake.current.setDisplayMode).not.toHaveBeenCalled();
  });

  it('loadSession restores the session into the host container', async () => {
    const fake = fakeHic({ panels: [null] });
    const { send } = await joinedWith(fake);
    const session = { browsers: [{ url: 'https://maps.example/a.hic' }] };
    const ack = await send({ type: 'loadSession', requestId: 's1', sessionData: session });
    expect(fake.restoreSession).toHaveBeenCalledWith(container, session);
    expect(ack.ok).toBe(true);
  });

  it('zoomIn / zoomOut call zoomAndCenter(±1) at the given centre', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    await send({ type: 'zoomIn', requestId: 'z1', centerX: 10, centerY: 20 });
    await send({ type: 'zoomOut', requestId: 'z2', centerX: 30, centerY: 40 });
    expect(fake.current.zoomAndCenter.mock.calls).toEqual([
      [1, 10, 20],
      [-1, 30, 40],
    ]);
  });

  it('zoomIn without a centre zooms about the middle of the map viewport', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'zoomIn', requestId: 'z3' });
    expect(fake.current.zoomAndCenter).toHaveBeenCalledWith(1, 400, 300);
    expect(ack.ok).toBe(true);
  });

  it('setForegroundColor sets the colour components, then re-sets the current threshold to repaint', async () => {
    const fake = fakeHic(); // threshold 2000
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setForegroundColor', requestId: 'f1', color: { r: 255, g: 0, b: 0 } });
    expect(fake.current.colorScale.setColorComponents).toHaveBeenCalledWith({ r: 255, g: 0, b: 0 });
    expect(fake.current.contactMatrixView.setColorScale).toHaveBeenCalledWith(fake.current.colorScale);
    expect(fake.current.setColorScaleThreshold).toHaveBeenCalledWith(2000);
    expect(fake.current.colorScale.setColorComponents.mock.invocationCallOrder[0]).toBeLessThan(
      fake.current.setColorScaleThreshold.mock.invocationCallOrder[0],
    );
    expect(ack.ok).toBe(true);
  });

  it('setForegroundColor with a threshold also sets the threshold', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    await send({ type: 'setForegroundColor', requestId: 'f2', color: { r: 0, g: 0, b: 255 }, threshold: 750 });
    expect(fake.current.colorScale.setColorComponents).toHaveBeenCalledWith({ r: 0, g: 0, b: 255 });
    expect(fake.current.setColorScaleThreshold).toHaveBeenCalledWith(750);
  });

  it('setBackgroundColor sets the matrix background', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setBackgroundColor', requestId: 'b1', color: { r: 1, g: 2, b: 3 } });
    expect(fake.current.contactMatrixView.setBackgroundColor).toHaveBeenCalledWith({ r: 1, g: 2, b: 3 });
    expect(ack.ok).toBe(true);
  });

  it('setColorScale sets, doubles or halves the threshold', async () => {
    const fake = fakeHic(); // threshold 2000
    fake.current.setColorScaleThreshold.mockImplementation(() => {}); // and it stays 2000
    const { send } = await joinedWith(fake);
    await send({ type: 'setColorScale', requestId: 't1', action: 'set', value: 500 });
    await send({ type: 'setColorScale', requestId: 't2', action: 'increase' });
    await send({ type: 'setColorScale', requestId: 't3', action: 'decrease' });
    expect(fake.current.setColorScaleThreshold.mock.calls).toEqual([[500], [4000], [1000]]);
  });

  it('setNormalization sets the normalization', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'setNormalization', requestId: 'n1', normalization: 'VC_SQRT' });
    expect(fake.current.setNormalization).toHaveBeenCalledWith('VC_SQRT');
    expect(ack.ok).toBe(true);
  });

  it('commands apply in arrival order: gotoLocus waits for a pending loadMap', async () => {
    const fake = fakeHic({ panels: [null] });
    let finishLoad;
    fake.current.loadHicFile.mockImplementationOnce(
      (config) =>
        new Promise((resolve) => {
          finishLoad = () => {
            fake.current.dataset = { url: config.url };
            resolve();
          };
        }),
    );
    const { socket, send } = await joinedWith(fake);
    socket.receive({ type: 'loadMap', requestId: 'o1', url: 'https://maps.example/a.hic' });
    socket.receive({ type: 'gotoLocus', requestId: 'o2', locus: 'chr2' });
    await flush();
    expect(acksOf(socket)).toEqual([]);
    finishLoad();
    const ack = await send({ type: 'zoomIn', requestId: 'o3', centerX: 1, centerY: 1 });
    expect(ack.ok).toBe(true);
    expect(acksOf(socket).map((a) => [a.requestId, a.ok])).toEqual([
      ['o1', true],
      ['o2', true],
      ['o3', true],
    ]);
  });
});

describe('attachRemote: §5.2 track command rows', () => {
  it('loadTrack calls loadTracks with the track config and acks ok without waiting for the load', async () => {
    const fake = fakeHic();
    fake.current.loadTracks.mockReturnValue(new Promise(() => {})); // a track load that never finishes
    const { send } = await joinedWith(fake);
    const ack = await send({
      type: 'loadTrack',
      requestId: 'l1',
      url: 'https://tracks.example/genes.txt.gz',
      name: 'Refseq Select',
      color: { r: 0, g: 128, b: 255 },
      trackType: 'annotation',
      format: 'refgene',
    });
    expect(fake.current.loadTracks).toHaveBeenCalledWith([
      {
        url: 'https://tracks.example/genes.txt.gz',
        name: 'Refseq Select',
        color: 'rgb(0,128,255)',
        type: 'annotation',
        format: 'refgene',
      },
    ]);
    expect(ack).toEqual({
      type: 'ack',
      requestId: 'l1',
      ok: true,
      result: `${PANEL_1}: ok`,
    });
  });

  it('loadTrack with only a url passes only the url', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    await send({ type: 'loadTrack', requestId: 'l2', url: 'https://tracks.example/a.bw' });
    expect(fake.current.loadTracks).toHaveBeenCalledWith([{ url: 'https://tracks.example/a.bw' }]);
  });

  // The genes preset (ticket 32): the file follows the map's genome, chosen here per panel.
  it.each([
    ['hg19', 'https://hgdownload.soe.ucsc.edu/goldenPath/hg19/database/ncbiRefSeqSelect.txt.gz'],
    ['mm10', 'https://hgdownload.soe.ucsc.edu/goldenPath/mm10/database/ncbiRefSeqSelect.txt.gz'],
    ['dm6', 'https://hgdownload.soe.ucsc.edu/goldenPath/dm6/database/ncbiRefSeq.txt.gz'],
  ])('loadTrack preset genes on a %s map loads that genome\'s RefSeq file as a refgene annotation', async (genomeId, url) => {
    const fake = fakeHic({ panels: [{ ...MAP_A, genome: genomeId }] });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'loadTrack', requestId: 'g1', preset: 'genes', name: 'Refseq Select', color: { r: 0, g: 0, b: 0 } });
    expect(fake.current.loadTracks).toHaveBeenCalledWith([
      { url, type: 'annotation', format: 'refgene', name: 'Refseq Select', color: 'rgb(0,0,0)' },
    ]);
    expect(ack.ok).toBe(true);
  });

  it('loadTrack preset genes on a map with no genome acks ok:false and loads nothing', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'loadTrack', requestId: 'g2', preset: 'genes' });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/which genome/);
    expect(fake.current.loadTracks).not.toHaveBeenCalled();
  });

  it('loadTrack with an unknown preset acks ok:false', async () => {
    const fake = fakeHic({ panels: [{ ...MAP_A, genome: 'hg19' }] });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'loadTrack', requestId: 'g3', preset: 'nonsense' });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/Unknown track preset/);
  });

  it('loadTrack before any map is loaded acks ok:false', async () => {
    const fake = fakeHic({ panels: [null] });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'loadTrack', requestId: 'l3', url: 'https://tracks.example/a.bw' });
    expect(ack).toEqual({ type: 'ack', requestId: 'l3', ok: false, error: 'panel 1 (no map): No map loaded' });
    expect(fake.current.loadTracks).not.toHaveBeenCalled();
  });

  it('removeTrack resolves by name, case-insensitively, and by 1-based index', async () => {
    const [a, b] = [fakeTrackPair('CTCF'), fakeTrackPair('H3K27ac')];
    const fake = fakeHic({ trackPairs: [a, b] });
    fake.current.layoutController.removeTrackXYPair.mockImplementation(() => {}); // the rows stay, so '2' is still b
    const { send } = await joinedWith(fake);
    expect((await send({ type: 'removeTrack', requestId: 'r1', track: 'ctcf' })).ok).toBe(true);
    expect((await send({ type: 'removeTrack', requestId: 'r2', track: '2' })).ok).toBe(true);
    expect(fake.current.layoutController.removeTrackXYPair.mock.calls).toEqual([[a], [b]]);
  });

  it('setTrackColor sets an rgb colour, or resets it when none is given', async () => {
    const tp = fakeTrackPair('CTCF');
    const { send } = await joinedWith(fakeHic({ trackPairs: [tp] }));
    await send({ type: 'setTrackColor', requestId: 'c1', track: 'CTCF', color: { r: 255, g: 0, b: 0 } });
    await send({ type: 'setTrackColor', requestId: 'c2', track: '1' });
    expect(tp.setColor.mock.calls).toEqual([['rgb(255,0,0)'], [undefined]]);
  });

  it('setTrackName relabels the track, and the track then resolves by its new name', async () => {
    const tp = fakeTrackPair('CTCF');
    const fake = fakeHic({ trackPairs: [tp] });
    const { send } = await joinedWith(fake);
    expect((await send({ type: 'setTrackName', requestId: 'n1', track: '1', name: 'CTCF rep1' })).ok).toBe(true);
    expect(tp.track.name).toBe('CTCF rep1');
    expect(tp.setTrackLabelName.mock.calls).toEqual([['CTCF rep1']]); // once: through the name setter only
    expect(tp.track.name).toBe('CTCF rep1');
    expect((await send({ type: 'removeTrack', requestId: 'n2', track: 'ctcf rep1' })).ok).toBe(true);
    expect(fake.current.layoutController.removeTrackXYPair).toHaveBeenCalledWith(tp);
  });

  it('setTrackDataRange sets min and max', async () => {
    const tp = fakeTrackPair('CTCF');
    const { send } = await joinedWith(fakeHic({ trackPairs: [tp] }));
    const ack = await send({ type: 'setTrackDataRange', requestId: 'd1', track: 'CTCF', min: 0, max: 10 });
    expect(tp.setDataRange).toHaveBeenCalledWith(0, 10);
    expect(ack.ok).toBe(true);
  });

  it('setTrackAutoscale / setTrackLogScale set the flag through the track pair', async () => {
    const tp = fakeTrackPair('CTCF');
    const { send } = await joinedWith(fakeHic({ trackPairs: [tp] }));
    await send({ type: 'setTrackAutoscale', requestId: 'a1', track: 'CTCF', enabled: true });
    await send({ type: 'setTrackLogScale', requestId: 'g1', track: '1', enabled: false });
    expect(tp.setAutoscale).toHaveBeenCalledWith(true);
    expect(tp.setLogScale).toHaveBeenCalledWith(false);
  });

  it.each([
    ['an unknown name', 'nope'],
    ['index 0', '0'],
    ['an index past the last track', '4'],
  ])('a track command naming %s acks ok:false and touches nothing', async (_, track) => {
    const tp = fakeTrackPair('CTCF');
    const fake = fakeHic({ trackPairs: [tp], tracks2D: [fakeTrack2D('loops')] });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'removeTrack', requestId: 'u1', track });
    expect(ack).toEqual({ type: 'ack', requestId: 'u1', ok: false, error: `${PANEL_1}: Track not found: ${track}` });
    const colorAck = await send({ type: 'setTrackColor', requestId: 'u2', track, color: { r: 1, g: 2, b: 3 } });
    expect(colorAck.ok).toBe(false);
    expect(fake.current.layoutController.removeTrackXYPair).not.toHaveBeenCalled();
    expect(tp.setColor).not.toHaveBeenCalled();
  });

  it('removeTrack on a 2D track, by name or by an index past the track pairs, removes it through the browser', async () => {
    const [loops, domains] = [fakeTrack2D('loops'), fakeTrack2D('domains')];
    const fake = fakeHic({ trackPairs: [fakeTrackPair('CTCF')], tracks2D: [loops, domains] });
    fake.current.removeTrack2D.mockImplementation(() => {}); // the tracks stay, so '3' is still domains
    const { send } = await joinedWith(fake);
    expect((await send({ type: 'removeTrack', requestId: 't1', track: 'LOOPS' })).ok).toBe(true);
    expect((await send({ type: 'removeTrack', requestId: 't2', track: '3' })).ok).toBe(true);
    expect(fake.current.removeTrack2D.mock.calls).toEqual([[loops], [domains]]);
    expect(fake.current.layoutController.removeTrackXYPair).not.toHaveBeenCalled();
  });

  it('setTrackColor on a 2D track sets an rgb colour, or gives back the features’ own when none is given', async () => {
    const loops = fakeTrack2D('loops');
    const fake = fakeHic({ tracks2D: [loops] });
    const { send } = await joinedWith(fake);
    expect((await send({ type: 'setTrackColor', requestId: 'c1', track: 'loops', color: { r: 0, g: 0, b: 255 } })).ok).toBe(true);
    expect((await send({ type: 'setTrackColor', requestId: 'c2', track: '1' })).ok).toBe(true);
    expect(fake.current.setTrack2DColor.mock.calls).toEqual([
      [loops, 'rgb(0,0,255)'],
      [loops, undefined],
    ]);
  });

  it('setTrackName on a 2D track renames it, and getTrackList then shows the new name', async () => {
    const loops = fakeTrack2D('loops', 'rgb(0,0,255)');
    const fake = fakeHic({ trackPairs: [fakeTrackPair('CTCF')], tracks2D: [loops] });
    const { send } = await joinedWith(fake);
    expect((await send({ type: 'setTrackName', requestId: 'n1', track: '2', name: 'HiCCUPS loops' })).ok).toBe(true);
    expect(fake.current.setTrack2DName).toHaveBeenCalledWith(loops, 'HiCCUPS loops');
    const { result } = await send({ type: 'getTrackList', requestId: 'n2' });
    expect(result[1]).toMatchObject({ index: 2, is2D: true, name: 'HiCCUPS loops' });
    expect((await send({ type: 'removeTrack', requestId: 'n3', track: 'hiccups loops' })).ok).toBe(true);
    expect(fake.current.removeTrack2D).toHaveBeenCalledWith(loops);
  });

  it.each(['setTrackDataRange', 'setTrackAutoscale', 'setTrackLogScale'])(
    '%s on a 2D track acks ok:false: it does not apply',
    async (type) => {
      const { send } = await joinedWith(fakeHic({ tracks2D: [fakeTrack2D('loops')] }));
      const ack = await send({ type, requestId: 'x1', track: 'loops', min: 0, max: 1, enabled: true });
      expect(ack).toEqual({
        type: 'ack',
        requestId: 'x1',
        ok: false,
        error: `${PANEL_1}: Track loops is a 2D track; ${type} does not apply to 2D tracks`,
      });
    },
  );

  it('a track command before any map is loaded acks ok:false', async () => {
    const { send } = await joinedWith(fakeHic({ panels: [null] }));
    const ack = await send({ type: 'removeTrack', requestId: 'm1', track: '1' });
    expect(ack).toEqual({ type: 'ack', requestId: 'm1', ok: false, error: 'panel 1 (no map): No map loaded' });
  });
});

describe('attachRemote: §5.2 request-style commands', () => {
  it('getTrackList returns the track pairs, then the 2D tracks, numbered from 1', async () => {
    const fake = fakeHic({
      trackPairs: [
        fakeTrackPair('CTCF', { color: 'rgb(255,0,0)', dataRange: { min: 0, max: 10 }, autoscale: false, logScale: true }),
        fakeTrackPair('H3K27ac', { dataRange: { min: 0, max: 3.5 }, autoscale: true, logScale: false }),
      ],
      tracks2D: [fakeTrack2D('loops', 'rgb(0,0,255)')],
    });
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'getTrackList', requestId: 'g1' });
    expect(ack).toEqual({
      type: 'ack',
      requestId: 'g1',
      ok: true,
      result: [
        {
          index: 1,
          is2D: false,
          name: 'CTCF',
          url: 'https://tracks.example/CTCF.bw',
          color: 'rgb(255,0,0)',
          dataRange: { min: 0, max: 10 },
          autoscale: false,
          logScale: true,
        },
        {
          index: 2,
          is2D: false,
          name: 'H3K27ac',
          url: 'https://tracks.example/H3K27ac.bw',
          dataRange: { min: 0, max: 3.5 },
          autoscale: true,
          logScale: false,
        },
        { index: 3, is2D: true, name: 'loops', url: 'https://tracks.example/loops.bedpe', color: 'rgb(0,0,255)' },
      ],
    });
  });

  it('getTrackList lists a still-loading track by its name and url', async () => {
    const pending = { isPendingTrack: true, config: { url: 'https://tracks.example/slow.bw' }, track: { name: 'slow' } };
    const { send } = await joinedWith(fakeHic({ trackPairs: [pending] }));
    const ack = await send({ type: 'getTrackList', requestId: 'g3' });
    expect(ack.result).toEqual([{ index: 1, is2D: false, name: 'slow', url: 'https://tracks.example/slow.bw' }]);
  });

  it('getTrackList with no tracks returns an empty list', async () => {
    const { send } = await joinedWith(fakeHic());
    expect(await send({ type: 'getTrackList', requestId: 'g2' })).toEqual({
      type: 'ack',
      requestId: 'g2',
      ok: true,
      result: [],
    });
  });

  it('getSession returns hic.toJSON()’s session as the result (every panel here has a map)', async () => {
    const fake = fakeHic();
    const { send } = await joinedWith(fake);
    const ack = await send({ type: 'getSession', requestId: 's1' });
    expect(ack).toEqual({ type: 'ack', requestId: 's1', ok: true, result: fake.toJSON.mock.results[0].value });
  });

  it('getCompressedSession returns hic.compressedSession() as the result', async () => {
    const fake = fakeHic();
    fake.compressedSession.mockReturnValue('session=blob:abc123');
    const { send } = await joinedWith(fake);
    expect(await send({ type: 'getCompressedSession', requestId: 's2' })).toEqual({
      type: 'ack',
      requestId: 's2',
      ok: true,
      result: 'session=blob:abc123',
    });
  });

  it('a session read that throws acks ok:false with its message and no result', async () => {
    const fake = fakeHic();
    fake.toJSON.mockImplementation(() => {
      throw new Error('no registry');
    });
    const { send } = await joinedWith(fake);
    expect(await send({ type: 'getSession', requestId: 's3' })).toEqual({
      type: 'ack',
      requestId: 's3',
      ok: false,
      error: 'no registry',
    });
  });
});
