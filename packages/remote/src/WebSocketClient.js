/**
 * Reconnecting WebSocket client. Slimmed from the prototype: the socket is
 * created through an injected factory (the platform WebSocket by default) and
 * the connect URL is supplied by the caller, so this file touches no DOM, no
 * `window` and no build-time environment.
 *
 * Reconnect delay grows 1 s, 2 s, … up to 5 s and then stays there, which is
 * what the prototype's "polling mode" amounted to.
 */
export class WebSocketClient {
  /**
   * @param {object} opts
   * @param {() => string} opts.getUrl        called before every attempt (the room may have been minted since)
   * @param {(url: string) => WebSocket} [opts.createSocket]
   * @param {() => void} [opts.onConnecting]  before every attempt
   * @param {() => void} [opts.onOpen]
   * @param {(msg: object) => void} [opts.onMessage]  already-parsed JSON; unparsable frames are dropped
   * @param {() => void} [opts.onClose]        every close that is not the result of `close()`
   */
  constructor({ getUrl, createSocket = (url) => new WebSocket(url), onConnecting, onOpen, onMessage, onClose }) {
    this.getUrl = getUrl;
    this.createSocket = createSocket;
    this.onConnecting = onConnecting;
    this.onOpen = onOpen;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  connect() {
    if (this.stopped) return;
    this.onConnecting?.();
    const ws = this.createSocket(this.getUrl());
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return;
      this.reconnectAttempts = 0;
      this.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      this.onMessage?.(msg);
    };

    ws.onerror = () => {
      // The matching close event follows; nothing to do here.
    };

    ws.onclose = () => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.onClose?.();
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = 1000 * Math.min(this.reconnectAttempts, 5);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Close for good: no reconnect, no further callbacks. */
  close() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
