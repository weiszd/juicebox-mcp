/**
 * Rooms seam: pages are real WebSocket clients on the Worker's /ws; tests assert
 * the messages each page receives. Design §5.4, §6, §6.4.
 *
 * "Not received" is proven with a barrier: a page's own `join` round trip. The
 * room answers a socket in order, so anything sent to that page before the
 * barrier arrives before its `joined`.
 */
import { env } from 'cloudflare:test';
import { describe, it, expect, afterEach } from 'vitest';
import { MessageType, SyncEventType } from '@aidenlab/juicebox-remote/protocol';
import { ORIGIN, upgrade, openPage, join, closePages, track } from './pages.js';

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/; // Crockford base32: no I, L, O, U

const locusChange = { type: MessageType.SYNC_EVENT, syncType: SyncEventType.LOCUS_CHANGE, locus: 'chr1:1-1000' };

afterEach(closePages);

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
