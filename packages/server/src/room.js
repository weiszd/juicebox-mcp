import { logInfo } from './lib/logger.js';

/**
 * The only way the Worker reaches a room or an MCP session's room binding. The two
 * Durable Objects (WebSocketRoom, McpSession) expose RPC methods; this module knows
 * which room a session is in and hands tools one handle to it.
 */

/** How long a command waits for its first ack before the tool reports "sent, unconfirmed" (§5.4). */
export const ACK_TIMEOUT_MS = 10_000;

/**
 * What a command or request to a room resolves to: `acked` with the first page's
 * {ok, result?, error?}; `unconfirmed` when no ack arrives within ACK_TIMEOUT_MS;
 * `closed` when the one page a request asked disconnects first; `no-page` when no
 * page is connected (or the session has no room).
 */
export const AckStatus = Object.freeze({
  ACKED: 'acked',
  UNCONFIRMED: 'unconfirmed',
  CLOSED: 'closed',
  NO_PAGE: 'no-page',
});

/**
 * The room an MCP session drives (design §6): the room `join_room` bound it to, else
 * the room whose id is the session id; no session, no room. The binding is read at
 * most once per handle, and only when a tool asks for it.
 *
 * @returns {{current(): Promise<string|null>, bind(room: string): Promise<void>,
 *   send(tool: string, command: object): Promise<object>, request(command: object): Promise<object>,
 *   isConnected(): Promise<boolean>}}
 */
export function roomForSession(env, sessionId) {
  const session = sessionId && env.MCP_SESSION.get(env.MCP_SESSION.idFromName(sessionId));
  let lookup;

  const current = () => {
    lookup ??= session
      ? session.getRoom().then(bound => bound || sessionId)
      : Promise.resolve(null);
    return lookup;
  };

  const stub = async () => {
    const room = await current();
    return room ? env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(room)) : null;
  };

  return {
    current,

    async bind(room) {
      await session.setRoom(room);
      lookup = Promise.resolve(room);
    },

    /** Names `tool` to every page, then sends `command` to all of them and waits for the first ack. */
    async send(tool, command) {
      logInfo(`[room.send] tool=${tool} type=${command.type} sessionId=${sessionId || 'NONE'}`);
      const room = await stub();
      return room ? room.send(tool, command) : { status: AckStatus.NO_PAGE };
    },

    /** Asks the first live page only. */
    async request(command) {
      logInfo(`[room.request] type=${command.type} sessionId=${sessionId || 'NONE'}`);
      const room = await stub();
      return room ? room.request(command) : { status: AckStatus.NO_PAGE };
    },

    async isConnected() {
      try {
        const room = await stub();
        return room ? (await room.status()).connected : false;
      } catch {
        return false;
      }
    },
  };
}
