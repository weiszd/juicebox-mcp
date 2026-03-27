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

    // Initialize hamburger menu
    this._initHamburgerMenu();
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
      ['setColorScale', (command) => {
        this._setColorScale(command);
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
      ['getTrackList', async (command) => {
        await this._getTrackList(command);
      }],
      ['removeTrack', (command) => {
        this._removeTrack(command);
      }],
      ['setTrackColor', (command) => {
        this._setTrackColor(command);
      }],
      ['setTrackName', (command) => {
        this._setTrackName(command);
      }],
      ['setTrackDataRange', (command) => {
        this._setTrackDataRange(command);
      }],
      ['setTrackAutoscale', (command) => {
        this._setTrackAutoscale(command);
      }],
      ['setTrackLogScale', (command) => {
        this._setTrackLogScale(command);
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

    // 7. DISPLAY MODE changes
    const originalSetDisplayMode = browser.setDisplayMode.bind(browser);
    browser.setDisplayMode = async (mode) => {
      await originalSetDisplayMode(mode);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('displayModeChange', { displayMode: mode });
      }
    };

    // 8. MAP LOAD — wrap loadHicFile and loadHicControlFile
    const originalLoadHicFile = browser.loadHicFile.bind(browser);
    browser.loadHicFile = async (config) => {
      await originalLoadHicFile(config);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('mapLoad', { url: config.url, name: config.name, normalization: config.normalization, locus: config.locus });
      }
    };

    const originalLoadHicControlFile = browser.loadHicControlFile.bind(browser);
    browser.loadHicControlFile = async (config) => {
      await originalLoadHicControlFile(config);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('controlMapLoad', { url: config.url, name: config.name, normalization: config.normalization });
      }
    };

    // 9. TRACK LOAD — wrap browser.loadTracks to catch both UI and MCP track loads
    const originalLoadTracks = browser.loadTracks.bind(browser);
    browser.loadTracks = async (configs) => {
      await originalLoadTracks(configs);
      if (!this._isSyncing && this.wsClient) {
        this.wsClient.sendSyncEvent('trackLoad', { configs });
      }
      // Wrap sync listeners on any newly added trackPairs
      this._wrapTrackPairsSyncListeners();
    };

    // 9. TRACK REMOVAL — wrap layoutController.removeTrackXYPair
    const lc = browser.layoutController;
    const originalRemoveTrack = lc.removeTrackXYPair.bind(lc);
    lc.removeTrackXYPair = (trackPair) => {
      const track = trackPair.track || trackPair.x?.track;
      const trackName = track?.name;
      originalRemoveTrack(trackPair);
      if (!this._isSyncing && this.wsClient && trackName) {
        this.wsClient.sendSyncEvent('trackRemove', { track: trackName });
      }
    };

    // 10. TRACK PROPERTY CHANGES — wrap methods on existing trackPairs
    this._wrapTrackPairsSyncListeners();
  }

  /**
   * Wrap setColor, setDataRange, setTrackLabelName on all trackPairs
   * so that UI-driven changes broadcast sync events.
   * Safe to call multiple times — already-wrapped pairs are skipped.
   */
  _wrapTrackPairsSyncListeners() {
    if (!this.browser || !this.wsClient) return;
    const trackPairs = this.browser.trackPairs || [];

    for (const tp of trackPairs) {
      if (tp._syncWrapped) continue;
      tp._syncWrapped = true;

      // Track the name in a closure variable so we always have the pre-change value,
      // even if track.name is set externally before setTrackLabelName is called.
      const t = tp.track || tp.x?.track;
      let lastKnownName = t?.name;

      // Wrap setColor
      if (tp.setColor) {
        const origSetColor = tp.setColor.bind(tp);
        tp.setColor = (color) => {
          origSetColor(color);
          if (!this._isSyncing && this.wsClient) {
            this.wsClient.sendSyncEvent('trackColorChange', { track: lastKnownName, colorString: color });
          }
        };
      }

      // Wrap setDataRange
      if (tp.setDataRange) {
        const origSetDataRange = tp.setDataRange.bind(tp);
        tp.setDataRange = (min, max) => {
          origSetDataRange(min, max);
          if (!this._isSyncing && this.wsClient) {
            this.wsClient.sendSyncEvent('trackDataRangeChange', { track: lastKnownName, min, max });
          }
        };
      }

      // Wrap setTrackLabelName
      if (tp.setTrackLabelName) {
        const origSetLabel = tp.setTrackLabelName.bind(tp);
        tp.setTrackLabelName = (name) => {
          const oldName = lastKnownName;
          origSetLabel(name);
          lastKnownName = name; // update for next time
          if (!this._isSyncing && this.wsClient) {
            this.wsClient.sendSyncEvent('trackNameChange', { track: oldName, name });
          }
        };
      }

      // Intercept autoscale and logScale property sets via getter/setter
      if (t) {
        let _autoscale = t.autoscale;
        Object.defineProperty(t, 'autoscale', {
          get() { return _autoscale; },
          set: (value) => {
            _autoscale = value;
            if (!this._isSyncing && this.wsClient) {
              this.wsClient.sendSyncEvent('trackAutoscaleChange', { track: lastKnownName, enabled: value });
            }
          },
          configurable: true
        });

        let _logScale = t.logScale;
        Object.defineProperty(t, 'logScale', {
          get() { return _logScale; },
          set: (value) => {
            _logScale = value;
            if (!this._isSyncing && this.wsClient) {
              this.wsClient.sendSyncEvent('trackLogScaleChange', { track: lastKnownName, enabled: value });
            }
          },
          configurable: true
        });
      }
    }
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
          await this.browser.loadHicFile({ url: command.url, name: command.name, normalization: command.normalization, locus: command.locus });
          break;

        case 'controlMapLoad':
          await this.browser.loadHicControlFile({ url: command.url, name: command.name, normalization: command.normalization });
          break;

        case 'trackLoad':
          if (command.configs) {
            await this.browser.loadTracks(command.configs);
          }
          break;

        case 'trackRemove': {
          const found = this._findTrack(command.track);
          if (found && !found.is2D) {
            this.browser.layoutController.removeTrackXYPair(found.trackPair);
          } else if (found && found.is2D) {
            const idx = this.browser.tracks2D.indexOf(found.track2D);
            if (idx >= 0) {
              this.browser.tracks2D.splice(idx, 1);
              this.browser.contactMatrixView.clearImageCaches();
              this.browser.contactMatrixView.update();
            }
          }
          break;
        }

        case 'trackColorChange': {
          const found = this._findTrack(command.track);
          if (found && !found.is2D) {
            found.track.color = command.colorString;
            found.trackPair.setColor(command.colorString);
          } else if (found && found.is2D) {
            found.track2D.color = command.colorString;
            this.browser.contactMatrixView.clearImageCaches();
            this.browser.contactMatrixView.update();
          }
          break;
        }

        case 'trackNameChange': {
          const found = this._findTrack(command.track);
          if (found && !found.is2D) {
            found.track.name = command.name;
            found.trackPair.setTrackLabelName(command.name);
          } else if (found && found.is2D) {
            found.track2D.name = command.name;
          }
          break;
        }

        case 'trackDataRangeChange': {
          const found = this._findTrack(command.track);
          if (found && !found.is2D) {
            found.trackPair.setDataRange(command.min, command.max);
          }
          break;
        }

        case 'trackAutoscaleChange': {
          const found = this._findTrack(command.track);
          if (found && !found.is2D) {
            found.track.autoscale = command.enabled;
            found.trackPair.repaintViews();
          }
          break;
        }

        case 'trackLogScaleChange': {
          const found = this._findTrack(command.track);
          if (found && !found.is2D) {
            found.track.logScale = command.enabled;
            found.trackPair.repaintViews();
          }
          break;
        }

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
   * Initialize hamburger menu interactions
   */
  _initHamburgerMenu() {
    const btn = document.getElementById('hamburger-btn');
    const menu = document.getElementById('hamburger-menu');
    const modal = document.getElementById('url-input-modal');
    const field = document.getElementById('url-input-field');
    const title = document.getElementById('url-input-modal-title');
    const submitBtn = document.getElementById('url-input-submit');
    const cancelBtn = document.getElementById('url-input-cancel');

    if (!btn || !menu || !modal) return;

    this._menuEl = menu;
    this._modalEl = modal;
    this._modalField = field;
    this._modalTitle = title;
    this._modalCallback = null;

    // Toggle menu
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.toggle('open');
      menu.setAttribute('aria-hidden', String(!isOpen));
      btn.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) {
        const first = menu.querySelector('.hamburger-menu-item');
        if (first) first.focus();
      }
    });

    // Menu item clicks
    menu.querySelectorAll('.hamburger-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        this._closeMenu();
        const action = item.dataset.action;
        if (action === 'loadMap') {
          this._showUrlModal('Load Map', 'https://example.com/file.hic', (url) => {
            this._loadMap({ url, name: this._filenameFromUrl(url) });
          });
        } else if (action === 'loadTrack') {
          this._showUrlModal('Load Track', 'https://example.com/track.bigwig', (url) => {
            this._loadTrack({ url, name: this._filenameFromUrl(url) });
          });
        }
      });
    });

    // Close menu on outside click
    document.addEventListener('click', (e) => {
      if (menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) {
        this._closeMenu();
      }
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (modal.classList.contains('open')) {
          this._closeUrlModal();
        } else if (menu.classList.contains('open')) {
          this._closeMenu();
          btn.focus();
        }
      }
    });

    // Modal cancel
    cancelBtn.addEventListener('click', () => this._closeUrlModal());

    // Modal submit
    submitBtn.addEventListener('click', () => this._submitUrlModal());

    // Enter in input
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._submitUrlModal();
      }
    });

    // Click on backdrop
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this._closeUrlModal();
    });
  }

  _closeMenu() {
    this._menuEl.classList.remove('open');
    this._menuEl.setAttribute('aria-hidden', 'true');
    document.getElementById('hamburger-btn').setAttribute('aria-expanded', 'false');
  }

  _showUrlModal(titleText, placeholder, callback) {
    this._modalCallback = callback;
    this._modalTitle.textContent = titleText;
    this._modalField.value = '';
    this._modalField.placeholder = placeholder;
    this._modalEl.classList.add('open');
    this._modalEl.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => this._modalField.focus());
  }

  _closeUrlModal() {
    this._modalEl.classList.remove('open');
    this._modalEl.setAttribute('aria-hidden', 'true');
    this._modalCallback = null;
  }

  _submitUrlModal() {
    const url = this._modalField.value.trim();
    if (!url) {
      this._modalField.style.borderColor = '#dc3545';
      setTimeout(() => { this._modalField.style.borderColor = ''; }, 1000);
      this._modalField.focus();
      return;
    }
    const callback = this._modalCallback;
    this._closeUrlModal();
    if (callback) callback(url);
  }

  _filenameFromUrl(url) {
    try {
      return new URL(url).pathname.split('/').pop() || url;
    } catch {
      return url;
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
        this.browser = juicebox.getCurrentBrowser();
        this._setupSyncEventListeners();
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
   * Set color scale threshold: absolute value, increase (double), or decrease (halve)
   */
  _setColorScale(command) {
    if (!this.browser) {
      console.error('Browser not initialized');
      return;
    }

    try {
      const colorScale = this.browser.getColorScale();
      if (!colorScale) {
        console.error('No color scale available');
        return;
      }

      let newThreshold;
      if (command.action === 'increase') {
        newThreshold = colorScale.getThreshold() * 2;
      } else if (command.action === 'decrease') {
        newThreshold = colorScale.getThreshold() / 2;
      } else {
        newThreshold = command.value;
      }

      this.browser.setColorScaleThreshold(newThreshold);
      // Update the UI widget (setColorScaleThreshold doesn't notify the widget)
      this.browser.notifyColorScale(this.browser.getColorScale());
      console.log(`Color scale threshold set to ${newThreshold}`);
    } catch (error) {
      console.error('Error setting color scale:', error);
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
      if (command.trackType) config.type = command.trackType;
      if (command.format) config.format = command.format;
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
   * Find a track by name (case-insensitive) or 1-based index.
   * Returns { trackPair, track, track2D, index, is2D } or null.
   */
  _findTrack(identifier) {
    if (!this.browser) return null;

    const trackPairs = this.browser.trackPairs || [];
    const tracks2D = this.browser.tracks2D || [];

    const getTrack = (tp) => tp.track || tp.x?.track;

    // Try as 1-based numeric index (1D first, then 2D)
    const num = parseInt(identifier);
    if (!isNaN(num) && String(num) === identifier.trim()) {
      if (num >= 1 && num <= trackPairs.length) {
        const tp = trackPairs[num - 1];
        return { trackPair: tp, track: getTrack(tp), index: num, is2D: false };
      }
      const idx2D = num - trackPairs.length;
      if (idx2D >= 1 && idx2D <= tracks2D.length) {
        return { track2D: tracks2D[idx2D - 1], index: num, is2D: true };
      }
      return null;
    }

    // Match by name (case-insensitive)
    const lowerName = identifier.toLowerCase();
    for (let i = 0; i < trackPairs.length; i++) {
      const t = getTrack(trackPairs[i]);
      if (t && t.name && t.name.toLowerCase() === lowerName) {
        return { trackPair: trackPairs[i], track: t, index: i + 1, is2D: false };
      }
    }
    for (let i = 0; i < tracks2D.length; i++) {
      if (tracks2D[i].name && tracks2D[i].name.toLowerCase() === lowerName) {
        return { track2D: tracks2D[i], index: trackPairs.length + i + 1, is2D: true };
      }
    }
    return null;
  }

  /**
   * Get list of loaded tracks and send back to server
   */
  async _getTrackList(command) {
    try {
      const session = juicebox.toJSON();
      const browsers = session.browsers || [];
      const tracks = [];

      for (const browser of browsers) {
        if (browser.tracks) {
          for (let i = 0; i < browser.tracks.length; i++) {
            const t = browser.tracks[i];
            tracks.push({ index: i + 1, ...t });
          }
        }
      }

      if (this.wsClient && this.wsClient.isConnected() && this.wsClient.ws) {
        this.wsClient.ws.send(JSON.stringify({
          type: 'trackListData',
          trackList: tracks,
          requestId: command.requestId
        }));
      }
    } catch (error) {
      console.error('Error getting track list:', error);
      if (this.wsClient && this.wsClient.isConnected() && this.wsClient.ws) {
        this.wsClient.ws.send(JSON.stringify({
          type: 'trackListError',
          error: error.message,
          requestId: command.requestId
        }));
      }
    }
  }

  /**
   * Remove a track by name or index
   */
  _removeTrack(command) {
    if (!this.browser) { console.error('Browser not initialized'); return; }
    const found = this._findTrack(command.track);
    if (!found) { console.error(`Track not found: ${command.track}`); return; }

    try {
      if (found.is2D) {
        const tracks2D = this.browser.tracks2D;
        const idx = tracks2D.indexOf(found.track2D);
        if (idx >= 0) {
          tracks2D.splice(idx, 1);
          this.browser.contactMatrixView.clearImageCaches();
          this.browser.contactMatrixView.update();
        }
      } else {
        this.browser.layoutController.removeTrackXYPair(found.trackPair);
      }
      console.log(`Track removed: ${command.track}`);
    } catch (error) {
      console.error('Error removing track:', error);
    }
  }

  /**
   * Set or reset track color
   */
  _setTrackColor(command) {
    if (!this.browser) { console.error('Browser not initialized'); return; }
    const found = this._findTrack(command.track);
    if (!found) { console.error(`Track not found: ${command.track}`); return; }

    try {
      const colorStr = command.color ? `rgb(${command.color.r},${command.color.g},${command.color.b})` : undefined;
      if (found.is2D) {
        found.track2D.color = colorStr;
        this.browser.contactMatrixView.clearImageCaches();
        this.browser.contactMatrixView.update();
      } else {
        found.track.color = colorStr;
        found.trackPair.setColor(colorStr);
      }
      console.log(`Track color ${colorStr ? 'set to ' + colorStr : 'reset'}: ${command.track}`);
    } catch (error) {
      console.error('Error setting track color:', error);
    }
  }

  /**
   * Set track name
   */
  _setTrackName(command) {
    if (!this.browser) { console.error('Browser not initialized'); return; }
    const found = this._findTrack(command.track);
    if (!found) { console.error(`Track not found: ${command.track}`); return; }

    try {
      if (found.is2D) {
        found.track2D.name = command.name;
      } else {
        // Call setTrackLabelName first so the sync wrapper captures the old name
        found.trackPair.setTrackLabelName(command.name);
        found.track.name = command.name;
      }
      console.log(`Track renamed to: ${command.name}`);
    } catch (error) {
      console.error('Error setting track name:', error);
    }
  }

  /**
   * Set track data range (1D tracks only)
   */
  _setTrackDataRange(command) {
    if (!this.browser) { console.error('Browser not initialized'); return; }
    const found = this._findTrack(command.track);
    if (!found) { console.error(`Track not found: ${command.track}`); return; }
    if (found.is2D) { console.error('Data range not supported for 2D tracks'); return; }

    try {
      found.trackPair.setDataRange(command.min, command.max);
      console.log(`Track data range set to [${command.min}, ${command.max}]: ${command.track}`);
    } catch (error) {
      console.error('Error setting track data range:', error);
    }
  }

  /**
   * Set track autoscale (1D tracks only)
   */
  _setTrackAutoscale(command) {
    if (!this.browser) { console.error('Browser not initialized'); return; }
    const found = this._findTrack(command.track);
    if (!found) { console.error(`Track not found: ${command.track}`); return; }
    if (found.is2D) { console.error('Autoscale not supported for 2D tracks'); return; }

    try {
      found.track.autoscale = command.enabled;
      found.trackPair.repaintViews();
      console.log(`Track autoscale ${command.enabled ? 'enabled' : 'disabled'}: ${command.track}`);
    } catch (error) {
      console.error('Error setting track autoscale:', error);
    }
  }

  /**
   * Set track log scale (1D tracks only)
   */
  _setTrackLogScale(command) {
    if (!this.browser) { console.error('Browser not initialized'); return; }
    const found = this._findTrack(command.track);
    if (!found) { console.error(`Track not found: ${command.track}`); return; }
    if (found.is2D) { console.error('Log scale not supported for 2D tracks'); return; }

    try {
      found.track.logScale = command.enabled;
      found.trackPair.repaintViews();
      console.log(`Track log scale ${command.enabled ? 'enabled' : 'disabled'}: ${command.track}`);
    } catch (error) {
      console.error('Error setting track log scale:', error);
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
