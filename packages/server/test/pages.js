/**
 * Fake pages: real WebSocket clients on the Worker's /ws.
 */
import { SELF } from 'cloudflare:test';
import { expect } from 'vitest';
import { MessageType } from '@aidenlab/juicebox-remote/protocol';

export const ORIGIN = 'http://localhost:5173'; // on the wrangler.toml allow-list

export function upgrade(query = '', origin = ORIGIN) {
  const headers = { Upgrade: 'websocket' };
  if (origin) headers.Origin = origin;
  return SELF.fetch(`https://jbmcp.test/ws${query}`, { headers });
}

const open = [];

/** Close every socket opened since the last call; for afterEach. */
export function closePages() {
  for (const ws of open.splice(0)) ws.close();
}

/** Keep a socket for closePages(). */
export function track(ws) {
  open.push(ws);
}

/** Open a page socket; `next()` resolves with the next message it receives. */
export async function openPage(query) {
  const res = await upgrade(query);
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  ws.accept();
  track(ws);

  const queued = [];
  const waiting = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const resolve = waiting.shift();
    if (resolve) resolve(msg);
    else queued.push(msg);
  });

  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    next: () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((r) => waiting.push(r))),
    /** Close the page; resolves once the room has answered the close, i.e. has seen it go. */
    close: () => {
      open.splice(open.indexOf(ws), 1);
      const closed = new Promise((r) => ws.addEventListener('close', r));
      ws.close();
      return closed;
    },
  };
}

export function join(page, room) {
  page.send(room ? { type: MessageType.JOIN, room } : { type: MessageType.JOIN });
  return page.next();
}
