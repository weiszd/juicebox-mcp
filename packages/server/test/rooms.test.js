/**
 * Rooms seam: pages are real WebSocket clients on the Worker's /ws; tests assert
 * the messages each page receives. Design §5.4, §6, §6.4.
 *
 * "Not received" is proven with a barrier: a page's own `join` round trip. The
 * room answers a socket in order, so anything sent to that page before the
 * barrier arrives before its `joined`.
 */
import { env, runInDurableObject, runDurableObjectAlarm, evictDurableObject } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MessageType, CommandType, SyncEventType, ErrorCode } from '@aidenlab/juicebox-remote/protocol';
import { ORIGIN, upgrade, openPage, join, closePages, track } from './pages.js';

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/; // Crockford base32: no I, L, O, U
const HOUR = 60 * 60 * 1000;

const locusChange = { type: MessageType.SYNC_EVENT, syncType: SyncEventType.LOCUS_CHANGE, locus: 'chr1:1-1000' };

// Prototype message names for the saved session and catch-up.
const saveSession = (compressedSession) => ({ type: 'saveSession', compressedSession });
const requestSessionFromPeer = { type: 'requestSessionFromPeer' };

afterEach(() => {
  vi.useRealTimers();
  closePages();
});

const roomStub = (room) => env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(room));

/** A page in a fresh minted room, or in `room`; joined so the room holds its socket. */
async function pageIn(room) {
  const page = await openPage(room ? `?room=${room}` : '');
  const joined = await join(page, room);
  return { page, room: joined.room };
}

describe('join', () => {
  it('join with a room id answers joined with that room', async () => {
    const page = await openPage('?room=7ZQH4M2K9X');
    expect(await join(page, '7ZQH4M2K9X')).toEqual({ type: MessageType.JOINED, room: '7ZQH4M2K9X' });
  });

  it('join without a room id mints a 10-character Crockford base32 room', async () => {
    const a = await join(await openPage());
    const b = await join(await openPage());
    expect(a.type).toBe(MessageType.JOINED);
    expect(a.room).toMatch(ROOM_ID);
    expect(b.room).toMatch(ROOM_ID);
    expect(b.room).not.toBe(a.room);
  });

  it('a second page opening the minted room joins the same room', async () => {
    const { room } = await join(await openPage());
    const second = await openPage(`?room=${room}`);
    expect(await join(second, room)).toEqual({ type: MessageType.JOINED, room });
  });

  it('the query parameter is room; sessionId is not accepted', async () => {
    const page = await openPage('?sessionId=7ZQH4M2K9X');
    const { room } = await join(page);
    expect(room).toMatch(ROOM_ID);
    expect(room).not.toBe('7ZQH4M2K9X');
  });
});

describe('sync events', () => {
  it('a sync event from page A arrives at page B, not at A, and not in another room', async () => {
    const a = await openPage();
    const { room } = await join(a);
    const b = await openPage(`?room=${room}`);
    await join(b, room);
    const elsewhere = await openPage();
    const { room: otherRoom } = await join(elsewhere);

    a.send(locusChange);

    expect(await b.next()).toEqual(locusChange);
    expect(await join(a, room)).toEqual({ type: MessageType.JOINED, room });
    expect(await join(elsewhere, otherRoom)).toEqual({ type: MessageType.JOINED, room: otherRoom });
  });

  it('the sender’s panel position reaches the peer unchanged (ADR-0008)', async () => {
    const a = await openPage();
    const { room } = await join(a);
    const b = await openPage(`?room=${room}`);
    await join(b, room);
    const inPanel2 = { type: MessageType.SYNC_EVENT, syncType: SyncEventType.NORMALIZATION_CHANGE, panel: 2, normalization: 'KR' };

    a.send(inPanel2);

    expect(await b.next()).toEqual(inPanel2);
  });
});

describe('Origin allow-list', () => {
  it('every origin in the wrangler.toml ALLOWED_ORIGINS var may upgrade', async () => {
    expect(env.ALLOWED_ORIGINS).toContain(ORIGIN);
    for (const origin of env.ALLOWED_ORIGINS) {
      const res = await upgrade('', origin);
      expect(res.status, origin).toBe(101);
      res.webSocket.accept();
      track(res.webSocket);
    }
  });

  it('an upgrade from an origin not on the list is refused with 403', async () => {
    expect((await upgrade('?room=7ZQH4M2K9X', 'https://evil.example')).status).toBe(403);
  });

  it('an upgrade with no Origin header is refused with 403', async () => {
    expect((await upgrade('?room=7ZQH4M2K9X', null)).status).toBe(403);
  });
});

describe('saved session and late-joiner catch-up', () => {
  it('a saved session outlives its page and reaches a late joiner when no peer is live', async () => {
    const { page: a, room } = await pageIn();
    a.send(saveSession('session=blob:saved'));
    await a.close();
    await evictDurableObject(roomStub(room)); // only storage survives

    const { page: b } = await pageIn(room);
    b.send(requestSessionFromPeer);

    expect(await b.next()).toEqual({ type: MessageType.PEER_SESSION_DATA, compressedSession: 'session=blob:saved' });
  });

  it('with a peer live, the late joiner gets the peer\'s live session, not the saved one', async () => {
    const { page: a, room } = await pageIn();
    a.send(saveSession('session=blob:stale'));
    const { page: b } = await pageIn(room);

    b.send(requestSessionFromPeer);
    const ask = await a.next();
    a.send({ type: MessageType.ACK, requestId: ask.requestId, ok: true, result: { browsers: ['live'] } });

    expect(ask).toEqual({ type: CommandType.GET_SESSION, requestId: expect.any(String) });
    expect(await b.next()).toEqual({ type: MessageType.PEER_SESSION_DATA, session: { browsers: ['live'] } });
  });

  it('a peer that cannot answer falls back to the saved session', async () => {
    const { page: a, room } = await pageIn();
    a.send(saveSession('session=blob:saved'));
    const { page: b } = await pageIn(room);

    b.send(requestSessionFromPeer);
    const ask = await a.next();
    a.send({ type: MessageType.ACK, requestId: ask.requestId, ok: false, error: 'No map loaded' });

    expect(await b.next()).toEqual({ type: MessageType.PEER_SESSION_DATA, compressedSession: 'session=blob:saved' });
  });

  it('an empty room with nothing saved answers with an error', async () => {
    const { page } = await pageIn();
    page.send(requestSessionFromPeer);

    expect(await page.next()).toEqual({ type: MessageType.PEER_SESSION_DATA, error: 'No session available' });
  });
});

describe('expiry (ADR-0006)', () => {
  const alarmOf = (room) => runInDurableObject(roomStub(room), (_, state) => state.storage.getAlarm());

  it('the alarm is due 24 h after the last message; a message at +23 h pushes it out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const { page, room } = await pageIn(); // join is the first message

    expect(await alarmOf(room)).toBe(t0 + 24 * HOUR);

    vi.setSystemTime(t0 + 23 * HOUR);
    page.send(locusChange);
    await join(page, room); // barrier: the sync event was handled

    expect(await alarmOf(room)).toBe(t0 + 47 * HOUR);
  });

  it('the alarm deletes the room\'s storage; a join afterwards with no page left answers room-expired', async () => {
    const { page: a, room } = await pageIn();
    a.send(saveSession('session=blob:saved'));
    await a.close();

    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);
    expect(await runInDurableObject(roomStub(room), (_, state) => state.storage.get('session'))).toBeUndefined();

    const b = await openPage(`?room=${room}`);
    expect(await join(b, room)).toEqual({ type: MessageType.ERROR, code: ErrorCode.ROOM_EXPIRED });
  });

  it('a page still connected when the alarm fires keeps the room joinable', async () => {
    const { room } = await pageIn();

    expect(await runDurableObjectAlarm(roomStub(room))).toBe(true);

    const b = await openPage(`?room=${room}`);
    expect(await join(b, room)).toEqual({ type: MessageType.JOINED, room });
  });
});
