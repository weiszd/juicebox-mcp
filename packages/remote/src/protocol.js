/**
 * Wire protocol between a page (@aidenlab/juicebox-remote) and a room on the
 * juicebox-mcp server. Design: docs/design/ARCHITECTURE_V2.md §5.4.
 *
 * Imported by the server via the `@aidenlab/juicebox-remote/protocol` subpath
 * so both ends share one spelling. No runtime dependencies, no DOM.
 */

/** Messages that are not commands or sync events. */
export const MessageType = Object.freeze({
  JOIN: 'join', // page → room: {room?}
  JOINED: 'joined', // room → page: {room}
  ERROR: 'error', // room → page: {code, message?}
  ACK: 'ack', // page → room: {requestId, ok, result?, error?}
  TOOL_CALL: 'toolCall', // room → page: {name}
  SYNC_EVENT: 'syncEvent', // either way: {syncType, ...payload}
  PEER_SESSION_DATA: 'peerSessionData', // room → page: {session?|compressedSession?|error?}
  REQUEST_SESSION_FROM_PEER: 'requestSessionFromPeer', // page → room: {}; answered with peerSessionData
  SAVE_SESSION: 'saveSession', // page → room: {compressedSession}, kept as the room's saved session
});

/** Commands: room → page, every one carries `requestId` and gets one `ack` (§5.2). */
export const CommandType = Object.freeze({
  LOAD_MAP: 'loadMap',
  LOAD_CONTROL_MAP: 'loadControlMap',
  LOAD_SESSION: 'loadSession',
  GOTO_LOCUS: 'gotoLocus',
  ZOOM_IN: 'zoomIn',
  ZOOM_OUT: 'zoomOut',
  SET_FOREGROUND_COLOR: 'setForegroundColor',
  SET_BACKGROUND_COLOR: 'setBackgroundColor',
  SET_COLOR_SCALE: 'setColorScale',
  SET_NORMALIZATION: 'setNormalization',
  LOAD_TRACK: 'loadTrack',
  GET_TRACK_LIST: 'getTrackList',
  GET_PANEL_LIST: 'getPanelList',
  REMOVE_TRACK: 'removeTrack',
  SET_TRACK_COLOR: 'setTrackColor',
  SET_TRACK_NAME: 'setTrackName',
  SET_TRACK_DATA_RANGE: 'setTrackDataRange',
  SET_TRACK_AUTOSCALE: 'setTrackAutoscale',
  SET_TRACK_LOG_SCALE: 'setTrackLogScale',
  GET_SESSION: 'getSession',
  GET_COMPRESSED_SESSION: 'getCompressedSession',
});

/** `syncType` values carried by a `syncEvent` (§5.3). */
export const SyncEventType = Object.freeze({
  LOCUS_CHANGE: 'locusChange',
  COLOR_SCALE_CHANGE: 'colorScaleChange',
  BACKGROUND_COLOR_CHANGE: 'backgroundColorChange',
  NORMALIZATION_CHANGE: 'normalizationChange',
  DISPLAY_MODE_CHANGE: 'displayModeChange',
  MAP_LOAD: 'mapLoad',
  CONTROL_MAP_LOAD: 'controlMapLoad',
  TRACK_LOAD: 'trackLoad',
  TRACK_REMOVE: 'trackRemove',
  TRACK_COLOR_CHANGE: 'trackColorChange',
  TRACK_NAME_CHANGE: 'trackNameChange',
  TRACK_DATA_RANGE_CHANGE: 'trackDataRangeChange',
  TRACK_AUTOSCALE_CHANGE: 'trackAutoscaleChange',
  TRACK_LOG_SCALE_CHANGE: 'trackLogScaleChange',
});

/** `code` values of an `error` message. */
export const ErrorCode = Object.freeze({
  ROOM_EXPIRED: 'room-expired',
});

const commandTypes = new Set(Object.values(CommandType));
const syncEventTypes = new Set(Object.values(SyncEventType));

const isObject = (msg) => typeof msg === 'object' && msg !== null;

export function isCommand(msg) {
  return isObject(msg) && commandTypes.has(msg.type) && typeof msg.requestId === 'string';
}

export function isSyncEvent(msg) {
  return isObject(msg) && msg.type === MessageType.SYNC_EVENT && syncEventTypes.has(msg.syncType);
}

export function isAck(msg) {
  return (
    isObject(msg) &&
    msg.type === MessageType.ACK &&
    typeof msg.requestId === 'string' &&
    typeof msg.ok === 'boolean'
  );
}
