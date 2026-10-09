import { logInfo } from './lib/logger.js';
import { AckStatus } from './durableObjects/WebSocketRoom.js';

/**
 * The only way the Worker reaches a room or an MCP session's room binding. The two
 * Durable Objects (WebSocketRoom, McpSession) expose RPC methods; this module knows
 * which room a session is in and hands tools one handle to it.
 */

// The ack outcomes and the timeout are the room's own (WebSocketRoom.js); tools read them here.
export { ACK_TIMEOUT_MS, AckStatus } from './durableObjects/WebSocketRoom.js';

/**
 * The room an MCP session drives (design §6): the room `join_room` bound it to, else
 * the room whose id is the session id; no session, no room. The binding is read at
 * most once per handle, and only when a tool asks for it.
 *
 * @returns {{current(): Promise<string|null>, bind(roomId: string): Promise<void>,
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

  const roomStub = async () => {
    const roomId = await current();
    return roomId ? env.WEBSOCKET_ROOM.get(env.WEBSOCKET_ROOM.idFromName(roomId)) : null;
  };

  // Awaited, so a failing room rejects inside this call and reaches the tool's own catch.
  const viaRoom = async (method, ...args) => {
    const stub = await roomStub();
    return stub ? await stub[method](...args) : { status: AckStatus.NO_PAGE };
  };

  return {
    current,

    async bind(roomId) {
      await session.setRoom(roomId);
      lookup = Promise.resolve(roomId);
    },

    /** Names `tool` to every page, then sends `command` to all of them and waits for the first ack. */
    send(tool, command) {
      logInfo(`[room.send] tool=${tool} type=${command.type} sessionId=${sessionId || 'NONE'}`);
      return viaRoom('send', tool, command);
    },

    /** Asks the first live page only. */
    request(command) {
      logInfo(`[room.request] type=${command.type} sessionId=${sessionId || 'NONE'}`);
      return viaRoom('request', command);
    },

    /** False when no page is connected; a room that cannot answer counts as none. */
    async isConnected() {
      const stub = await roomStub();
      if (!stub) return false;
      try {
        return (await stub.status()).connected;
      } catch {
        return false;
      }
    },
  };
}
