import { WebSocketClient } from './WebSocketClient.js';
import { MessageType, ErrorCode, isSyncEvent } from './protocol.js';
import { applyCommand } from './applyCommand.js';
import { observe } from './observe.js';
import { sessionToRestore } from './sessionToRestore.js';

const messageTypes = new Set(Object.values(MessageType));

// How often the page saves its session to the room when it changed (the prototype's number).
const SAVE_INTERVAL_MS = 10_000;

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
 * Once joined, the room's session, if it has one, replaces the page's (§7), so
 * a host that opens a snapshot link attaches after restoring its session: that
 * session then seeds an empty room and yields to one with state.
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
  let inRoom = false; // from `joined` until the socket closes
  let caughtUp = false; // the room has answered the request for its state
  let saveTimer;
  let lastSaved; // the compressed session the room last received from this page

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
    onClose: () => {
      inRoom = false;
      setStatus(Status.CLOSED);
    },
  });

  const observer = observe(hic, container, (msg) => client.send(msg));

  function handleMessage(msg) {
    if (typeof msg !== 'object' || msg === null) return;
    switch (msg.type) {
      case MessageType.JOINED:
        if (typeof msg.room !== 'string') return;
        roomToJoin = joinedRoom = msg.room;
        joinUrl = buildJoinUrl(msg.room);
        inRoom = true;
        setStatus(Status.OPEN);
        // Asked again on a re-join only if unanswered: catching up would undo what the page did meanwhile.
        if (!caughtUp) client.send({ type: MessageType.REQUEST_SESSION_FROM_PEER });
        return;
      case MessageType.ERROR:
        if (msg.code === ErrorCode.ROOM_EXPIRED) {
          client.close(); // an expired room never comes back; the host starts a new one
          observer.detach();
          clearInterval(saveTimer);
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
      case MessageType.PEER_SESSION_DATA:
        enqueue(() => catchUp(msg));
        return;
      default:
        // Anything else carrying a requestId is a command; an unknown type is acked as a failure.
        if (typeof msg.requestId === 'string' && !messageTypes.has(msg.type)) enqueue(() => run(msg));
        return;
    }
  }

  // Commands, peers' sync events and the room's state apply one at a time in arrival order, so a
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
    observer.rescan(); // load_map panel:"new" and close_panel open and close panels
    client.send(ack);
  }

  // The page saves its session only once the room has answered, so it never overwrites
  // the room's with its own before hearing it.
  async function catchUp(answer) {
    if (caughtUp || client.stopped) return;
    caughtUp = true;
    let failed = false;
    try {
      const session = await sessionToRestore(answer);
      // The room already shows it. restoreSession replaces the panels; the observer follows them.
      if (session) await observer.guard(() => hic.restoreSession(container, session));
    } catch {
      failed = true; // unreadable, or the restore failed: the page stays as it is, with no one to tell
    }
    observer.rescan(); // the restored session's panels replace the page's
    if (client.stopped) return;
    // The room wins (§7): one this page failed to show keeps its session until the page changes.
    if (failed) lastSaved = hic.compressedSession();
    else saveSession();
    saveTimer = setInterval(saveSession, SAVE_INTERVAL_MS);
  }

  function saveSession() {
    if (!inRoom || !hic.getCurrentBrowser()?.dataset) return; // a page with no map has nothing to save
    const compressedSession = hic.compressedSession();
    if (compressedSession === lastSaved) return;
    if (client.send({ type: MessageType.SAVE_SESSION, compressedSession })) lastSaved = compressedSession;
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
      clearInterval(saveTimer);
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
