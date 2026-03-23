/**
 * WebSocket client for communicating with the MCP server
 * Handles connection to the WebSocket server and processes incoming commands
 * Automatically detects if server is not running and polls for availability
 */
export class WebSocketClient {
  constructor(onCommand, onStatusChange = null, sessionId = null) {
    this.ws = null;
    this.onCommand = onCommand;
    this.onStatusChange = onStatusChange;
    this.sessionId = sessionId; // Store session ID for this client
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.isConnecting = false;
    this.serverAvailable = false; // Track if we've ever successfully connected
    this.pollingMode = false; // True when server appears to be offline
    this.pollingInterval = null;
    this.pollingDelay = 5000; // Check every 5 seconds when server is offline
    this.initialConnectionAttempts = 0;
    this.maxInitialAttempts = 3; // Try 3 times quickly before assuming server is offline
    this.initialAttemptDelay = 500; // 500ms between initial attempts
    this._notifyStatusChange(false); // Initial status: disconnected
  }

  _notifyStatusChange(connected) {
    if (this.onStatusChange) {
      this.onStatusChange(connected);
    }
  }

  connect(url = null) {
    // Determine WebSocket URL:
    // 1. Explicit URL parameter (highest priority)
    // 2. Environment variable VITE_WS_URL (for Netlify/production)
    // 3. Auto-detect from current hostname (if same domain)
    // 4. Default to localhost for development
    let wsUrl = url;
    
    if (!wsUrl) {
      wsUrl = import.meta.env.VITE_WS_URL;
    }
    
    if (!wsUrl) {
      // Auto-detect: if running on HTTPS, try wss:// on same domain
      const isSecure = window.location.protocol === 'https:';
      const protocol = isSecure ? 'wss:' : 'ws:';
      const hostname = window.location.hostname;
      
      // Only auto-detect if not localhost (production deployment)
      if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        // Production: WebSocket on same domain via /ws path (Cloudflare Workers)
        wsUrl = `${protocol}//${hostname}/ws`;
      } else {
        // Development: default to localhost
        wsUrl = 'ws://localhost:3011';
        // wsUrl = `${protocol}//${hostname}/ws`;
      }
    }
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;
    
    // If we're in polling mode, log differently
    if (this.pollingMode) {
      console.log(`Checking if WebSocket server is available at ${wsUrl}...`);
    } else {
      console.log(`Connecting to WebSocket server at ${wsUrl}...`);
      console.log(`Session ID: ${this.sessionId || 'none'}`);
    }

    try {
      // Append sessionId as query parameter for Cloudflare Workers DO routing
      let connectUrl = wsUrl;
      if (this.sessionId) {
        const separator = wsUrl.includes('?') ? '&' : '?';
        connectUrl = `${wsUrl}${separator}sessionId=${encodeURIComponent(this.sessionId)}`;
      }
      this.ws = new WebSocket(connectUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected to:', wsUrl);
        console.log('Session ID for registration:', this.sessionId || 'none');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.serverAvailable = true;
        this.pollingMode = false;
        this.initialConnectionAttempts = 0;
        
        // Clear any polling interval since we're connected
        if (this.pollingInterval) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = null;
        }
        
        // Register session with server if sessionId is available
        if (this.sessionId) {
          console.log(`Registering session ID: ${this.sessionId}`);
          this.ws.send(JSON.stringify({
            type: 'registerSession',
            sessionId: this.sessionId
          }));
        } else {
          console.warn('No session ID provided. WebSocket connected but session not registered.');
        }
        
        this._notifyStatusChange(true);
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          // Handle session registration confirmation
          if (data.type === 'sessionRegistered') {
            console.log(`✅ Session registered successfully: ${data.sessionId}`);
            return;
          }
          
          // Handle error messages
          if (data.type === 'error') {
            console.error('WebSocket server error:', data.message);
            return;
          }
          
          // Handle regular commands
          console.log('Received command:', data);
          
          if (this.onCommand) {
            this.onCommand(data);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      this.ws.onerror = (error) => {
        // Don't log errors in polling mode to reduce noise
        if (!this.pollingMode) {
          console.error('WebSocket error:', error);
          console.error('Failed to connect to:', wsUrl);
        }
        this.isConnecting = false;
      };

      this.ws.onclose = (event) => {
        console.log(`WebSocket closed. Code: ${event.code}, Reason: ${event.reason || 'none'}, Clean: ${event.wasClean}`);
        this.isConnecting = false;
        this._notifyStatusChange(false);
        
        // If we were previously connected, attempt normal reconnection
        if (this.serverAvailable) {
          console.log('WebSocket disconnected (was connected), attempting to reconnect...');
          this._attemptReconnect(wsUrl);
        } else {
          // Server was never connected, check if we should enter polling mode
          this._handleInitialConnectionFailure(wsUrl, event);
        }
      };
    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
      this.isConnecting = false;
      this._handleInitialConnectionFailure(wsUrl, null);
    }
  }

  _handleInitialConnectionFailure(url, closeEvent) {
    this.initialConnectionAttempts++;
    
    // If we've tried a few times quickly and failed, assume server is not running
    if (this.initialConnectionAttempts >= this.maxInitialAttempts) {
      if (!this.pollingMode) {
        console.log('WebSocket server appears to be offline. Will check periodically for availability...');
        this.pollingMode = true;
        this._startPolling(url);
      }
    } else {
      // Try a few more times quickly before giving up
      setTimeout(() => {
        this.connect(url);
      }, this.initialAttemptDelay);
    }
  }

  _startPolling(url) {
    // Clear any existing polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    
    // Poll periodically to check if server becomes available
    this.pollingInterval = setInterval(() => {
      if (!this.isConnecting && !this.isConnected()) {
        this.connect(url);
      }
    }, this.pollingDelay);
  }

  _attemptReconnect(url) {
    // If we're in polling mode, don't do aggressive reconnection
    // The polling mechanism will handle it
    if (this.pollingMode) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnection attempts reached. Server may be offline. Entering polling mode...');
      this.pollingMode = true;
      this.serverAvailable = false;
      this._startPolling(url);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);
    
    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    setTimeout(() => {
      this.connect(url);
    }, delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    // Clear polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnection
    this.pollingMode = false;
    this.serverAvailable = false;
    this._notifyStatusChange(false);
  }

  isConnected() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }
}

