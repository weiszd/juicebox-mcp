import { MessageType, CommandType, ErrorCode, isSyncEvent, isAck } from '@aidenlab/juicebox-remote/protocol';
import { logInfo, logError } from '../lib/logger.js';

/** How long a command waits for its first ack before the tool reports "sent, unconfirmed" (§5.4). */
const ACK_TIMEOUT_MS = 10_000;

/** A room's storage is deleted this long after its last message (ADR-0006). */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

// Page → room messages kept from the prototype for the saved session and catch-up (design §7).
const SAVE_SESSION = 'saveSession'; // {compressedSession}
const REQUEST_SESSION_FROM_PEER = 'requestSessionFromPeer'; // answered with peerSessionData

/**
 * Durable Object for managing WebSocket connections between the MCP server and browser clients.
 * One instance per room (keyed by room id).
 * Uses the Hibernation API for cost-efficient idle connections.
 */
export class WebSocketRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // Map of requestId -> { resolve, timer, page } for commands awaiting their first ack;
    // `page` is the one socket asked, for requests.
    this.pendingAcks = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade from browser
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request);
    }

    // Worker sends a command to every page in the room
    if (url.pathname === '/send') {
      const command = await request.json();
      return Response.json(await this.sendToClient(command, this.state.getWebSockets()));
    }

    // Worker asks one page for data (getTrackList, getSession, getCompressedSession)
    if (url.pathname === '/request') {
      const command = await request.json();
      return Response.json(await this.sendToClient(command, this.state.getWebSockets(), { firstOnly: true }));
    }

    // Health check / connection status
    if (url.pathname === '/status') {
      const websockets = this.state.getWebSockets();
      return Response.json({
        connected: websockets.length > 0,
        count: websockets.length
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  handleWebSocketUpgrade(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket with the hibernation API. The room id (set by the Worker)
    // rides on the socket: a hibernated Durable Object does not know its own name.
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ room: new URL(request.url).searchParams.get('room') });
    logInfo(`[DO] WebSocket accepted. Total connections: ${this.state.getWebSockets().length}`);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Send a command, with a fresh requestId, to every socket in `websockets` (or with
   * `firstOnly`, to the first one that takes it) and wait for the first ack. Resolves
   * {status: 'acked', ok, result?, error?}, {status: 'unconfirmed'} when no ack arrives
   * within ACK_TIMEOUT_MS, {status: 'closed'} when the one page asked disconnects
   * first, or {status: 'no-page'}.
   */
  async sendToClient(command, websockets, { firstOnly = false } = {}) {
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
    if (sentTo.length === 0) return { status: 'no-page' };

    // Registered before this handler yields, so no ack can arrive ahead of it.
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(requestId);
        resolve({ status: 'unconfirmed' });
      }, ACK_TIMEOUT_MS);
      this.pendingAcks.set(requestId, { resolve, timer, page: firstOnly ? sentTo[0] : null });
    });
  }

  /**
   * Late joiner catch-up (design §7): the first live peer's session, else the room's
   * saved session, else an error.
   */
  async sendCatchUp(requester) {
    const peers = this.state.getWebSockets().filter(ws => ws !== requester);
    const live = await this.sendToClient({ type: CommandType.GET_SESSION }, peers, { firstOnly: true });

    let reply;
    if (live.status === 'acked' && live.ok) {
      reply = { session: live.result };
    } else {
      const saved = await this.state.storage.get('session');
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
      if (data.type === MessageType.JOIN && (await this.state.storage.get('expired'))) {
        ws.send(JSON.stringify({ type: MessageType.ERROR, code: ErrorCode.ROOM_EXPIRED }));
        ws.close(1000, 'room expired');
        return;
      }

      // Every message pushes the room's expiry out to 24 h from now (ADR-0006).
      await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

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
          pending.resolve({ status: 'acked', ok: data.ok, result: data.result, error: data.error });
        }
        return;
      }

      // Saved session: the page's latest compressed session, for a late joiner with no live peer
      if (data.type === SAVE_SESSION && data.compressedSession) {
        await this.state.storage.put('session', data.compressedSession);
        return;
      }

      // Late joiner: send it the room's current state
      if (data.type === REQUEST_SESSION_FROM_PEER) {
        await this.sendCatchUp(ws);
        return;
      }

      // Sync events: relay to all OTHER pages in the room
      if (isSyncEvent(data)) {
        const websockets = this.state.getWebSockets();
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
        pending.resolve({ status: 'closed' });
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
    await this.state.storage.deleteAll();
    // With no page left the room is gone and later joins are refused; a connected page keeps it.
    if (this.state.getWebSockets().length === 0) {
      await this.state.storage.put('expired', true);
    }
  }
}
