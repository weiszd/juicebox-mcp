import juicebox from '../js/index.js';
import { WebSocketClient } from './WebSocketClient.js';
import ColorScale from '../js/colorScale.js';
import ContactMatrixView from '../js/contactMatrixView.js';
import QRCode from 'qrcode';
import { BGZip } from '../node_modules/igv-utils/src/index.js';

/**
 * Main application class that orchestrates Juicebox and WebSocket communication
 */
export class Application {
  async init(container, config = {}) {
    this.container = container;
    this.config = config;
    this.browser = null;

    // Sync state: true when applying a sync event from another browser (prevents re-broadcast)
    this._isSyncing = false;
    this._locusSyncTimeout = null;
    this._lastLocusSyncTime = 0;

    // Initialize command handler map
    this._initCommandHandlers();

    // Initialize Juicebox
    await this._initJuicebox(config);

    // Set up WebSocket connection
    this._setupWebSocket();
  }

  /**
   * Initialize Juicebox browser
   */
  async _initJuicebox(config) {
    // Use default config if none provided
    const defaultConfig = {
      backgroundColor: '255,255,255',
      ...config
    };

    // Initialize Juicebox
    await juicebox.init(this.container, defaultConfig);
    // Get the browser instance after initialization
    this.browser = juicebox.getCurrentBrowser();
    console.log(`Juicebox browser initialized: ${this.browser?.id || 'unknown'}`);
  }

  /**
   * Initialize the command handler map for WebSocket commands
   */
  _initCommandHandlers() {
    this.commandHandlers = new Map([
      ['toolCall', (command) => {
        this._showToolNotification(command.toolName);
      }],
      ['loadMap', async (command) => {
        await this._loadMap(command);
      }],
      ['loadControlMap', async (command) => {
        await this._loadControlMap(command);
      }],
      ['loadSession', async (command) => {
        await this._loadSession(command);
      }],
      ['zoomIn', async (command) => {
        await this._zoomIn(command);
      }],
      ['zoomOut', async (command) => {
        await this._zoomOut(command);
      }],
      ['setForegroundColor', (command) => {
        this._setForegroundColor(command);
      }],
      ['setBackgroundColor', (command) => {
        this._setBackgroundColor(command);
      }],
      ['gotoLocus', async (command) => {
        await this._gotoLocus(command);
      }],
      ['getSession', async (command) => {
        await this._getSession(command);
      }],
      ['getCompressedSession', async (command) => {
        await this._getCompressedSession(command);
      }],
      ['loadTrack', async (command) => {
        await this._loadTrack(command);
      }],
      ['setNormalization', (command) => {
        this._setNormalization(command);
      }],
      ['syncEvent', async (command) => {
        await this._handleSyncCommand(command);
      }],
      ['peerSessionData', async (command) => {
        await this._handlePeerSessionData(command);
      }]
    ]);
  }

  /**
   * Set up WebSocket connection
   */
  _setupWebSocket() {
    // Extract session ID from URL query parameters
    const urlParams = new URLSearchParams(window.location.search);
    const sessionId = urlParams.get('sessionId');

    if (!sessionId) {
      // No session ID provided - app can run but without MCP connection
      console.log('No sessionId found in URL. App running in standalone mode (no MCP connection).');
      this._updateConnectionStatus(false, 'not-connected');
      return;
    }

    console.log(`Initializing WebSocket client with session ID: ${sessionId}`);

    this._hasRequestedPeerSession = false;

    this.wsClient = new WebSocketClient(
      (command) => {
        this._handleWebSocketCommand(command);
      },
      (connected) => {
        this._updateConnectionStatus(connected);
        if (connected) {
          // On first connect, request session from a peer browser (if any)
          if (!this._hasRequestedPeerSession) {
            this._hasRequestedPeerSession = true;
            this._requestSessionFromPeer();
          }
          this._startAutoSave();
        } else {
          this._stopAutoSave();
        }
      },
      sessionId
    );
    this.wsClient.connect();

    // Set up sync event listeners to capture user interactions
    this._setupSyncEventListeners();

    // Show QR code for the session URL
    this._showSessionQRCode();
  }

  /**
   * Set up listeners on the Juicebox browser to capture user interactions
   * and broadcast them as sync events to other browsers in the same session.
   */
  _setupSyncEventListeners() {
    if (!this.browser || !this.wsClient) return;

    const browser = this.browser;

    // 1. LOCUS CHANGE — navigation, zoom, pan
    // Wrap notifyLocusChange to detect all locus changes
    const originalNotifyLocusChange = browser.notifyLocusChange.bind(browser);
    browser.notifyLocusChange = (eventData) => {
      originalNotifyLocusChange(eventData);
      if (!this._isSyncing) {
        if (eventData.dragging) {
          this._throttledSendLocusSync();
        } else {
          this._debouncedSendLocusSync();
        }
      }
    };

    // 2. COLOR SCALE changes (full replacement, e.g. auto-computed on map load)
    const originalNotifyColorScale = browser.notifyColorScale.bind(browser);
    browser.notifyColorScale = (colorScale) => {
      originalNotifyColorScale(colorScale);
      if (!this._isSyncing && this.wsClient) {
        this._sendColorScaleSync();
      }
    };

    // 3. THRESHOLD changes (increase/decrease buttons, text input)
    const originalSetColorScaleThreshold = browser.setColorScaleThreshold.bind(browser);
    browser.setColorScaleThreshold = (threshold) => {
      originalSetColorScaleThreshold(threshold);
      if (!this._isSyncing && this.wsClient) {
        this._sendColorScaleSync();
      }
    };

    // 4. FOREGROUND COLOR changes (color picker → setColorComponents + repaintMatrix)
    const originalRepaintMatrix = browser.repaintMatrix.bind(browser);
    browser.repaintMatrix = () => {
      originalRepaintMatrix();
      if (!this._isSyncing && this.wsClient) {
        this._sendColorScaleSync();
      }
    };

    // 5. BACKGROUND COLOR changes (color picker)
    const cmv = browser.contactMatrixView;
    const originalSetBackgroundColor = cmv.setBackgroundColor.bind(cmv);
    cmv.setBackgroundColor = (rgb) => {
      originalSetBackgroundColor(rgb);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('backgroundColorChange', { color: rgb });
      }
    };

    // 6. NORMALIZATION changes
    const originalSetNormalization = browser.setNormalization.bind(browser);
    browser.setNormalization = (normalization) => {
      originalSetNormalization(normalization);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('normalizationChange', { normalization });
      }
    };

    // 4. DISPLAY MODE changes
    const originalSetDisplayMode = browser.setDisplayMode.bind(browser);
    browser.setDisplayMode = async (mode) => {
      await originalSetDisplayMode(mode);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('displayModeChange', { displayMode: mode });
      }
    };
  }

  /**
   * Send the current color scale state as a sync event.
   * Handles both ColorScale (A/B modes) and RatioColorScale (AOB/BOA modes).
   */
  _sendColorScaleSync() {
    if (!this.browser || !this.wsClient) return;
    const colorScale = this.browser.getColorScale();
    if (!colorScale) return;

    const payload = { threshold: colorScale.getThreshold() };

    if (colorScale.positiveScale) {
      // RatioColorScale (AOB/BOA mode)
      payload.isRatio = true;
      payload.positive = colorScale.positiveScale.getColorComponents();
      payload.negative = colorScale.negativeScale.getColorComponents();
    } else {
      // Plain ColorScale (A/B mode)
      payload.r = colorScale.r;
      payload.g = colorScale.g;
      payload.b = colorScale.b;
    }

    this.wsClient.sendSyncEvent('colorScaleChange', payload);
  }

  /**
   * Send the current locus state as a sync event (immediate).
   */
  _sendLocusSyncEvent() {
    if (!this.browser || !this.wsClient) return;
    const syncState = this.browser.getSyncState();
    if (!syncState) return;
    this.wsClient.sendSyncEvent('locusChange', { syncState });
  }

  /**
   * Debounced locus sync for discrete events (zoom clicks, goto).
   */
  _debouncedSendLocusSync() {
    if (this._locusSyncTimeout) {
      clearTimeout(this._locusSyncTimeout);
    }
    this._locusSyncTimeout = setTimeout(() => {
      this._sendLocusSyncEvent();
      this._locusSyncTimeout = null;
    }, 100);
  }

  /**
   * Throttled locus sync for continuous events (dragging).
   */
  _throttledSendLocusSync() {
    const now = Date.now();
    if (now - this._lastLocusSyncTime >= 150) {
      this._sendLocusSyncEvent();
      this._lastLocusSyncTime = now;
    }
  }

  /**
   * Handle incoming sync commands from other browsers.
   * Applies the state change WITHOUT re-broadcasting (via _isSyncing flag).
   */
  async _handleSyncCommand(command) {
    if (!this.browser) return;

    this._isSyncing = true;
    try {
      switch (command.syncType) {
        case 'locusChange':
          // Use existing syncState() which calls update(false) — no re-propagation
          await this.browser.syncState(command.syncState);
          break;

        case 'colorScaleChange': {
          if (command.isRatio) {
            // RatioColorScale (AOB/BOA mode) — update existing scale in place
            const ratioScale = this.browser.getColorScale();
            if (ratioScale && ratioScale.positiveScale) {
              ratioScale.setThreshold(command.threshold);
              ratioScale.positiveScale.setColorComponents(command.positive);
              ratioScale.negativeScale.setColorComponents(command.negative);
              this.browser.notifyColorScale(ratioScale);
              this.browser.repaintMatrix();
            }
          } else {
            // Plain ColorScale (A/B mode)
            const colorScale = new ColorScale({
              threshold: command.threshold,
              r: command.r,
              g: command.g,
              b: command.b
            });
            this.browser.contactMatrixView.setColorScale(colorScale);
            this.browser.notifyColorScale(colorScale);
            this.browser.repaintMatrix();
          }
          break;
        }

        case 'backgroundColorChange': {
          const { r, g, b } = command.color;
          this.browser.contactMatrixView.setBackgroundColor({ r, g, b });
          break;
        }

        case 'normalizationChange':
          this.browser.setNormalization(command.normalization);
          // Also update the dropdown selector text (setNormalization only updates the map,
          // not the widget, since it assumes the widget initiated the change)
          this.browser.notifyNormalizationExternalChange(command.normalization);
          break;

        case 'displayModeChange':
          await this.browser.setDisplayMode(command.displayMode);
          break;

        case 'mapLoad':
          await this._loadMap(command);
          break;

        case 'controlMapLoad':
          await this._loadControlMap(command);
          break;

        default:
          console.warn('Unknown sync type:', command.syncType);
      }
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Update connection status UI (if status element exists)
   */
  _updateConnectionStatus(connected, statusType = 'disconnected') {
    const statusElement = document.getElementById('ws-status');
    if (!statusElement) return;

    const labelElement = statusElement.querySelector('.ws-status-label');
    if (!labelElement) return;

    if (connected) {
      statusElement.classList.remove('disconnected', 'not-connected');
      statusElement.classList.add('connected');
      labelElement.textContent = 'connected';
    } else {
      statusElement.classList.remove('connected');
      if (statusType === 'not-connected') {
        statusElement.classList.remove('disconnected');
        statusElement.classList.add('not-connected');
        labelElement.textContent = 'not connected';
      } else {
        statusElement.classList.remove('not-connected');
        statusElement.classList.add('disconnected');
        labelElement.textContent = 'disconnected';
      }
    }
  }

  /**
   * Request the current session state from a peer browser in the same session.
   * Called once on first WebSocket connect to sync late joiners.
   */
  _requestSessionFromPeer() {
    if (!this.wsClient || !this.wsClient.isConnected()) return;
    console.log('Requesting session from peer browser...');
    this.wsClient.ws.send(JSON.stringify({ type: 'requestSessionFromPeer' }));
  }

  /**
   * Handle session data received from a peer browser or from stored auto-save.
   * Supports both raw JSON (sessionData) and compressed format (compressedSession).
   */
  async _handlePeerSessionData(command) {
    if (command.error) {
      console.log('No peer session available:', command.error);
      return;
    }

    let sessionData = command.sessionData;
    if (!sessionData && command.compressedSession) {
      // Decompress: strip "session=blob:" prefix, then BGZip decompress
      try {
        const blob = command.compressedSession.startsWith('session=blob:')
          ? command.compressedSession.substring(13)
          : command.compressedSession;
        sessionData = JSON.parse(BGZip.uncompressString(blob));
      } catch (e) {
        console.error('Error decompressing peer session:', e);
        return;
      }
    }

    if (!sessionData) {
      console.log('Peer returned empty session data');
      return;
    }

    // Ensure sessionData is a parsed object (not a JSON string)
    if (typeof sessionData === 'string') {
      try {
        sessionData = JSON.parse(sessionData);
      } catch (e) {
        console.error('Invalid peer session data (not valid JSON):', e);
        return;
      }
    }

    // Validate the session has at least one browser with a URL
    const browsers = sessionData.browsers || [];
    const hasLoadedMap = browsers.some(b => b.url || b.dataset);
    if (!hasLoadedMap) {
      console.log('Peer session has no loaded maps, skipping restore');
      return;
    }

    console.log('Restoring session from peer browser');
    this._isSyncing = true;
    try {
      await juicebox.restoreSession(this.container, sessionData);
      this.browser = juicebox.getCurrentBrowser();
      // Re-setup sync listeners since restoreSession may recreate the browser
      this._setupSyncEventListeners();
    } catch (error) {
      console.error('Error restoring peer session:', error);
    } finally {
      this._isSyncing = false;
    }
  }

  /**
   * Start periodic auto-save of compressed session to the server.
   */
  _startAutoSave() {
    if (this._autoSaveInterval) return;
    this._lastSavedSession = null;
    this._autoSaveInterval = setInterval(() => this._autoSaveSession(), 10000);
  }

  /**
   * Stop auto-save timer.
   */
  _stopAutoSave() {
    if (this._autoSaveInterval) {
      clearInterval(this._autoSaveInterval);
      this._autoSaveInterval = null;
    }
  }

  /**
   * Auto-save: serialize session as compressed string and send to server.
   * Only sends if the session has changed since the last save.
   */
  _autoSaveSession() {
    if (!this.browser || !this.wsClient?.isConnected()) return;
    try {
      const compressed = juicebox.compressedSession();
      if (!compressed || compressed === this._lastSavedSession) return;
      this._lastSavedSession = compressed;
      this.wsClient.ws.send(JSON.stringify({ type: 'saveSession', compressedSession: compressed }));
      console.log('Auto-saved session');
    } catch (e) {
      // No map loaded yet — nothing to save
    }
  }

  /**
   * Show a QR code linking to the current session URL.
   * Renders into the #qr-code element if present.
   */
  async _showSessionQRCode() {
    const container = document.getElementById('qr-code');
    if (!container) return;

    try {
      const svg = await QRCode.toString(window.location.href, {
        type: 'svg',
        width: 160,
        margin: 0,
        color: { dark: '#333', light: '#0000' } // transparent background
      });
      container.innerHTML = svg;
      container.style.display = 'block';
    } catch (error) {
      console.error('Error generating QR code:', error);
    }
  }

  /**
   * Handle WebSocket command
   */
  async _handleWebSocketCommand(command) {
    const handler = this.commandHandlers.get(command.type);
    if (handler) {
      try {
        await handler(command);
      } catch (error) {
        console.error(`Error in handler for ${command.type}:`, error);
      }
    } else {
      console.warn('Unknown command type:', command.type);
    }
  }

  /**
   * Show tool notification
   */
  _showToolNotification(toolName) {
    // Format tool name for display (convert snake_case to Title Case)
    const formattedName = toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');

    const notificationElement = document.getElementById('tool-notification');
    if (!notificationElement) return;

    const labelElement = notificationElement.querySelector('.tool-notification-label');
    if (!labelElement) return;

    // Clear any existing timeout
    if (this._toolNotificationTimeout) {
      clearTimeout(this._toolNotificationTimeout);
      this._toolNotificationTimeout = null;
    }

    labelElement.textContent = formattedName;

    // Show notification with animation
    notificationElement.classList.remove('hidden');
    notificationElement.classList.add('visible');

    // Hide after 3 seconds
    this._toolNotificationTimeout = setTimeout(() => {
      notificationElement.classList.remove('visible');
      notificationElement.classList.add('hidden');
      this._toolNotificationTimeout = null;
    }, 3000);
  }

  /**
   * Load a map
   */
  async _loadMap(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    const config = {
      url: command.url,
      name: command.name,
      normalization: command.normalization,
      locus: command.locus
    };

    try {
      await this.browser.loadHicFile(config);
      console.log(`Map loaded: ${command.url}`);

      // If both contact map and control map are loaded, set display mode to AOB
      await this._ensureAOBModeWhenBothMapsLoaded();
    } catch (error) {
      console.error('Error loading map:', error);
    }
  }

  /**
   * Load a control map
   */
  async _loadControlMap(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    const config = {
      url: command.url,
      name: command.name,
      normalization: command.normalization
    };

    try {
      // Load control map using the dedicated method
      await this.browser.loadHicControlFile(config);
      console.log(`Control map loaded: ${command.url}`);

      // If both contact map and control map are loaded, set display mode to AOB
      await this._ensureAOBModeWhenBothMapsLoaded();
    } catch (error) {
      console.error('Error loading control map:', error);
    }
  }

  /**
   * Load a session
   */
  async _loadSession(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      let sessionData = command.sessionData;

      // If sessionUrl is provided, load it
      if (command.sessionUrl) {
        const response = await fetch(command.sessionUrl);
        sessionData = await response.json();
      }

      if (sessionData) {
        await juicebox.restoreSession(this.container, sessionData);
        console.log('Session loaded');
      } else {
        console.error('No session data provided');
      }
    } catch (error) {
      console.error('Error loading session:', error);
    }
  }

  /**
   * Zoom in
   */
  async _zoomIn(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const centerX = command.centerX;
      const centerY = command.centerY;

      // Use zoomAndCenter with direction > 0 for zoom in
      await this.browser.interactions.zoomAndCenter(1, centerX, centerY);
      console.log('Zoomed in');
    } catch (error) {
      console.error('Error zooming in:', error);
    }
  }

  /**
   * Zoom out
   */
  async _zoomOut(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const centerX = command.centerX;
      const centerY = command.centerY;

      // Use zoomAndCenter with direction < 0 for zoom out
      await this.browser.interactions.zoomAndCenter(-1, centerX, centerY);
      console.log('Zoomed out');
    } catch (error) {
      console.error('Error zooming out:', error);
    }
  }

  /**
   * Navigate to a specific genomic locus
   */
  async _gotoLocus(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const locus = command.locus;

      if (!locus) {
        console.error('No locus specified');
        return;
      }

      // Use parseLocusInputFlexible which handles both string and object formats
      await this.browser.parseLocusInputFlexible(locus);
      console.log(`Navigated to locus: ${typeof locus === 'string' ? locus : JSON.stringify(locus)}`);
    } catch (error) {
      console.error('Error navigating to locus:', error);
    }
  }

  /**
   * Set foreground color (color scale)
   */
  _setForegroundColor(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const { r, g, b } = command.color;
      const threshold = command.threshold || 2000; // Default threshold

      // Create color scale
      const colorScale = new ColorScale({
        threshold: threshold,
        r: r,
        g: g,
        b: b
      });

      // Set color scale on contact matrix view
      this.browser.contactMatrixView.setColorScale(colorScale);
      this.browser.notifyColorScale(colorScale);

      console.log(`Foreground color set to RGB(${r}, ${g}, ${b}) with threshold ${threshold}`);
    } catch (error) {
      console.error('Error setting foreground color:', error);
    }
  }

  /**
   * Set background color
   */
  _setBackgroundColor(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const { r, g, b } = command.color;

      // Set background color on contact matrix view
      this.browser.contactMatrixView.setBackgroundColor({ r, g, b });

      console.log(`Background color set to RGB(${r}, ${g}, ${b})`);
    } catch (error) {
      console.error('Error setting background color:', error);
    }
  }

  /**
   * Load a track
   */
  async _loadTrack(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const config = { url: command.url };
      if (command.name) config.name = command.name;
      if (command.color) {
        const { r, g, b } = command.color;
        config.color = `rgb(${r},${g},${b})`;
      }
      await this.browser.loadTracks([config]);
      console.log(`Track loaded: ${command.url}`);
    } catch (error) {
      console.error('Error loading track:', error);
    }
  }

  /**
   * Set normalization method on the current map (without reloading)
   */
  _setNormalization(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      this.browser.setNormalization(command.normalization);
      this.browser.notifyNormalizationExternalChange(command.normalization);
      console.log(`Normalization set to ${command.normalization}`);
    } catch (error) {
      console.error('Error setting normalization:', error);
    }
  }

  /**
   * Get session JSON and send it back to the server
   */
  async _getSession(command) {
    try {
      // Import juicebox to access toJSON
      const sessionData = juicebox.toJSON();

      // Send session data back to server via WebSocket
      if (this.wsClient && this.wsClient.isConnected() && this.wsClient.ws) {
        this.wsClient.ws.send(JSON.stringify({
          type: 'sessionData',
          sessionData: sessionData,
          requestId: command.requestId // Echo back requestId for matching
        }));
        console.log('Session data sent to server');
      } else {
        console.error('WebSocket not connected, cannot send session data');
      }
    } catch (error) {
      console.error('Error getting session:', error);
      // Send error back to server
      if (this.wsClient && this.wsClient.isConnected() && this.wsClient.ws) {
        this.wsClient.ws.send(JSON.stringify({
          type: 'sessionDataError',
          error: error.message,
          requestId: command.requestId
        }));
      }
    }
  }

  /**
   * Get compressed session string and send it back to the server
   */
  async _getCompressedSession(command) {
    try {
      // Import juicebox to access compressedSession
      const compressedSessionString = juicebox.compressedSession();

      // Send compressed session string back to server via WebSocket
      if (this.wsClient && this.wsClient.isConnected() && this.wsClient.ws) {
        this.wsClient.ws.send(JSON.stringify({
          type: 'compressedSessionData',
          compressedSession: compressedSessionString,
          requestId: command.requestId // Echo back requestId for matching
        }));
        console.log('Compressed session data sent to server');
      } else {
        console.error('WebSocket not connected, cannot send compressed session data');
      }
    } catch (error) {
      console.error('Error getting compressed session:', error);
      // Send error back to server
      if (this.wsClient && this.wsClient.isConnected() && this.wsClient.ws) {
        this.wsClient.ws.send(JSON.stringify({
          type: 'compressedSessionDataError',
          error: error.message,
          requestId: command.requestId
        }));
      }
    }
  }

  /**
   * Ensure display mode is set to AOB when both contact map and control map are loaded.
   * This is called after loading either map to automatically switch to comparison mode.
   */
  async _ensureAOBModeWhenBothMapsLoaded() {
    if (!this.browser) {
      return;
    }

    try {
      // Check if both maps are loaded
      const hasContactMap = this.browser.dataset || this.browser.activeDataset;
      const hasControlMap = this.browser.controlDataset;

      if (hasContactMap && hasControlMap) {
        // Both maps are loaded, set display mode to AOB (A over B)
        const currentMode = this.browser.getDisplayMode();
        if (currentMode !== 'AOB') {
          await this.browser.setDisplayMode('AOB');
          console.log('Display mode set to AOB (A over B) since both maps are loaded');
        }
      }
    } catch (error) {
      console.error('Error ensuring AOB mode:', error);
    }
  }
}
