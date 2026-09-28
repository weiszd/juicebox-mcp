import { WebSocketClient } from './WebSocketClient.js';
import { MessageType, ErrorCode, isSyncEvent } from './protocol.js';
import { applyCommand } from './applyCommand.js';
import { observe } from './observe.js';

const messageTypes = new Set(Object.values(MessageType));

/** Values passed to `onStatus` (design §5.1). */
export const Status = Object.freeze({
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSED: 'closed',
  EXPIRED: 'expired',
});

/**
 * Attach a juicebox.js viewer to a room on the juicebox-mcp server.
 * Design: docs/design/ARCHITECTURE_V2.md §5.1.
 *
 * @param {object} opts
 * @param {object} opts.hic                 the juicebox.js namespace import
 * @param {Element} opts.container          element passed to hic.init; only ever passed through
 * @param {string} opts.url                 WebSocket endpoint, e.g. 'wss://jbmcp.3dg.io/ws'
 * @param {string} [opts.room]              room to join; omit to have the server mint one
 * @param {(status: string) => void} [opts.onStatus]    'connecting' | 'open' | 'closed' | 'expired'
 * @param {(name: string) => void} [opts.onToolCall]
 * @param {(url: string) => WebSocket} [opts.createSocket]  defaults to the platform WebSocket
 * @returns {{ room: string|undefined, joinUrl: string|undefined, detach: () => void }}
 */
export function attachRemote({ hic, container, url, room, onStatus, onToolCall, createSocket }) {
  if (!hic) throw new TypeError('attachRemote: hic is required');
  if (!container) throw new TypeError('attachRemote: container is required');
  if (typeof url !== 'string' || !url) throw new TypeError('attachRemote: url is required');

  let roomToJoin = room; // given by the host, or minted by the server on the first `joined`
  let joinedRoom; // set on `joined`; kept across a drop so the host can still show it
  let joinUrl;

  const setStatus = (status) => onStatus?.(status);

  const client = new WebSocketClient({
    getUrl: () => {
      if (!roomToJoin) return url;
      const u = new URL(url);
      u.searchParams.set('room', roomToJoin);
      return u.toString();
    },
    createSocket,
    onConnecting: () => setStatus(Status.CONNECTING),
    onOpen: () => {
      client.send(roomToJoin ? { type: MessageType.JOIN, room: roomToJoin } : { type: MessageType.JOIN });
    },
    onMessage: handleMessage,
    onClose: () => setStatus(Status.CLOSED),
  });

  const observer = observe(hic, (msg) => client.send(msg));

  function handleMessage(msg) {
    if (typeof msg !== 'object' || msg === null) return;
    switch (msg.type) {
      case MessageType.JOINED:
        if (typeof msg.room !== 'string') return;
        roomToJoin = joinedRoom = msg.room;
        joinUrl = buildJoinUrl(msg.room);
        setStatus(Status.OPEN);
        return;
      case MessageType.ERROR:
        if (msg.code === ErrorCode.ROOM_EXPIRED) {
          client.close(); // an expired room never comes back; the host starts a new one
          observer.detach();
          joinedRoom = joinUrl = undefined;
          setStatus(Status.EXPIRED);
        }
        return;
      case MessageType.TOOL_CALL:
        if (typeof msg.name === 'string') onToolCall?.(msg.name);
        return;
      case MessageType.SYNC_EVENT:
        if (isSyncEvent(msg)) enqueue(() => observer.apply(msg));
        return;
      default:
        // Anything else carrying a requestId is a command; an unknown type is acked as a failure.
        if (typeof msg.requestId === 'string' && !messageTypes.has(msg.type)) enqueue(() => run(msg));
        return; // catch-up lands in a later ticket
    }
  }

  // Commands and peers' sync events apply one at a time in arrival order, so a
  // gotoLocus sent after a loadMap runs against the loaded map.
  let applying = Promise.resolve();
  function enqueue(task) {
    applying = applying.then(task);
  }

  async function run(command) {
    if (client.stopped) return;
    const ack = { type: MessageType.ACK, requestId: command.requestId };
    try {
      // Every page in the room gets the command, so what it changes is not sent as a sync event.
      const result = await observer.guard(() => applyCommand(hic, container, command));
      ack.ok = true;
      if (result !== undefined) ack.result = result; // request-style commands (getSession, …)
    } catch (e) {
      ack.ok = false;
      ack.error = e instanceof Error ? e.message : String(e);
    }
    client.send(ack);
  }

  // Deferred so no status callback fires before the caller holds the return value.
  queueMicrotask(() => client.connect());

  return {
    get room() {
      return joinedRoom;
    },
    get joinUrl() {
      return joinUrl;
    },
    detach() {
      if (client.stopped) return; // already detached, or expired (which never reports closed)
      observer.detach();
      client.close();
      setStatus(Status.CLOSED);
    },
  };
}

/** Join link for this page: the page URL with `room` set. Undefined outside a browser. */
function buildJoinUrl(room) {
  const href = globalThis.location?.href;
  if (!href) return undefined;
  const u = new URL(href);
  u.searchParams.set('room', room);
  return u.toString();
}
