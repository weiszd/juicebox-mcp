import { MessageType, CommandType, ErrorCode, isSyncEvent, isAck } from '@aidenlab/juicebox-remote/protocol';
import { DurableObject } from 'cloudflare:workers';
import { logInfo, logError } from '../lib/logger.js';

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

/** A room's storage is deleted this long after its last message (ADR-0006). */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Durable Object for managing WebSocket connections between the MCP server and browser clients.
 * One instance per room (keyed by room id).
 * Uses the Hibernation API for cost-efficient idle connections. Pages arrive on `fetch`
 * (the WebSocket upgrade); the Worker calls the RPC methods `send`, `request` and
 * `status` through `roomForSession` in src/room.js.
 */
export class WebSocketRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Map of requestId -> { resolve, timer, page } for commands awaiting their first ack;
    // `page` is the one socket asked, for requests.
    this.pendingAcks = new Map();
  }

  /** Pages connect here: the WebSocket upgrade from /ws?room=. */
  async fetch(request) {
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.#handleWebSocketUpgrade(request);
    }
    return new Response('Not Found', { status: 404 });
  }

  /** Names `tool` to every page first (§5.2), then sends `command` to all of them; resolves an AckStatus outcome. */
  async send(tool, command) {
    const websockets = this.ctx.getWebSockets();
    const notice = JSON.stringify({ type: MessageType.TOOL_CALL, name: tool });
    for (const ws of websockets) {
      try { ws.send(notice); } catch (e) { /* connection may be closing */ }
    }
    return this.#sendToClient(command, websockets);
  }

  /** Asks one page for data (getTrackList, getSession, getCompressedSession, …). */
  async request(command) {
    return this.#sendToClient(command, this.ctx.getWebSockets(), { firstOnly: true });
  }

  status() {
    const count = this.ctx.getWebSockets().length;
    return { connected: count > 0, count };
  }

  #handleWebSocketUpgrade(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket with the hibernation API. The room id (set by the Worker)
    // rides on the socket: a hibernated Durable Object does not know its own name.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ room: new URL(request.url).searchParams.get('room') });
    logInfo(`[DO] WebSocket accepted. Total connections: ${this.ctx.getWebSockets().length}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Send a command, with a fresh requestId, to every socket in `websockets` (or with
   * `firstOnly`, to the first one that takes it) and wait for the first ack. Resolves
   * one of the AckStatus outcomes.
   */
  async #sendToClient(command, websockets, { firstOnly = false } = {}) {
    logInfo(`[DO sendToClient] command=${command.type} websockets=${websockets.length}`);

    const requestId = crypto.randomUUID();
    const message = JSON.stringify({ ...command, requestId });
    const sentTo = [];
    for (const ws of websockets) {
      try {
        ws.send(message);
        sentTo.push(ws);
        if (firstOnly) break;
      } catch (e) {
        logError(`[DO sendToClient] error sending:`, e);
      }
    }
    if (sentTo.length === 0) return { status: AckStatus.NO_PAGE };

    // Registered before this handler yields, so no ack can arrive ahead of it.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(requestId);
        resolve({ status: AckStatus.UNCONFIRMED });
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(requestId, { resolve, timer, page: firstOnly ? sentTo[0] : null });
    });
  }

  /**
   * Late joiner catch-up (design §7): the first live peer's session, else the room's
   * saved session, else an error.
   */
  async #sendCatchUp(requester) {
    const peers = this.ctx.getWebSockets().filter(ws => ws !== requester);
    const live = await this.#sendToClient({ type: CommandType.GET_SESSION }, peers, { firstOnly: true });

    let reply;
    if (live.status === AckStatus.ACKED && live.ok) {
      reply = { session: live.result };
    } else {
      const saved = await this.ctx.storage.get('session');
      reply = saved ? { compressedSession: saved } : { error: 'No session available' };
    }
    try {
      requester.send(JSON.stringify({ type: MessageType.PEER_SESSION_DATA, ...reply }));
    } catch (e) { /* the late joiner left meanwhile */ }
  }

  // --- Hibernation API lifecycle methods ---

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));

      // A room that expired with no page left stays gone (ADR-0006).
      if (data.type === MessageType.JOIN && (await this.ctx.storage.get('expired'))) {
        ws.send(JSON.stringify({ type: MessageType.ERROR, code: ErrorCode.ROOM_EXPIRED }));
        ws.close(1000, 'room expired');
        return;
      }

      // Every message pushes the room's expiry out to 24 h from now (ADR-0006).
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);

      // The socket already reached this room via /ws?room=; `join` confirms which one.
      if (data.type === MessageType.JOIN) {
        ws.send(JSON.stringify({ type: MessageType.JOINED, room: ws.deserializeAttachment().room }));
        return;
      }

      // The first ack for a command resolves it; later acks from other pages are dropped.
      if (isAck(data)) {
        const pending = this.pendingAcks.get(data.requestId);
        if (pending) {
          this.pendingAcks.delete(data.requestId);
          clearTimeout(pending.timer);
          pending.resolve({ status: AckStatus.ACKED, ok: data.ok, result: data.result, error: data.error });
        }
        return;
      }

      // Saved session: the page's latest compressed session, for a late joiner with no live peer
      if (data.type === MessageType.SAVE_SESSION && data.compressedSession) {
        await this.ctx.storage.put('session', data.compressedSession);
        return;
      }

      // Late joiner: send it the room's current state
      if (data.type === MessageType.REQUEST_SESSION_FROM_PEER) {
        await this.#sendCatchUp(ws);
        return;
      }

      // Sync events: relay to all OTHER pages in the room
      if (isSyncEvent(data)) {
        const websockets = this.ctx.getWebSockets();
        const msg = JSON.stringify(data);
        for (const other of websockets) {
          if (other !== ws) {
            try { other.send(msg); } catch (e) { /* connection may be closing */ }
          }
        }
        return;
      }

      // Other messages are ignored (browser might send debug info, etc.)
    } catch (error) {
      logError('Error parsing WebSocket message:', error);
    }
  }

  webSocketClose(ws, code, reason, wasClean) {
    // A request asked this page alone, so it fails now; commands sent to every page wait on.
    for (const [requestId, pending] of this.pendingAcks) {
      if (pending.page === ws) {
        this.pendingAcks.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve({ status: AckStatus.CLOSED });
      }
    }
    // Answer the close so the socket leaves getWebSockets() (no auto-reply at this compatibility date).
    try { ws.close(); } catch (e) { /* already closed */ }
  }

  webSocketError(ws, error) {
    logError('WebSocket error in Durable Object:', error);
  }

  /** 24 h after the last message (ADR-0006): delete the room's storage. */
  async alarm() {
    await this.ctx.storage.deleteAll();
    // With no page left the room is gone and later joins are refused; a connected page keeps it.
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.put('expired', true);
    }
  }
}
