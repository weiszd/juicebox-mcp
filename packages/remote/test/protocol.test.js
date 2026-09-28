import { describe, it, expect } from 'vitest';
import * as protocol from '../src/protocol.js';
import * as subpath from '@aidenlab/juicebox-remote/protocol';

const {
  MessageType,
  CommandType,
  SyncEventType,
  ErrorCode,
  isCommand,
  isSyncEvent,
  isAck,
} = protocol;

describe('protocol: catalogue', () => {
  it('is reachable on the ./protocol subpath', () => {
    expect(subpath.isCommand).toBe(isCommand);
  });

  it('names every §5.4 message', () => {
    expect(MessageType).toEqual({
      JOIN: 'join',
      JOINED: 'joined',
      ERROR: 'error',
      ACK: 'ack',
      TOOL_CALL: 'toolCall',
      SYNC_EVENT: 'syncEvent',
      PEER_SESSION_DATA: 'peerSessionData',
    });
    expect(ErrorCode).toEqual({ ROOM_EXPIRED: 'room-expired' });
  });

  it('has no reply types besides ack (the prototype\'s six collapse into ack result/error)', () => {
    const names = Object.values(protocol)
      .filter((v) => typeof v === 'object')
      .flatMap((v) => Object.values(v));
    for (const gone of ['sessionData', 'compressedSessionData', 'trackListData']) {
      expect(names).not.toContain(gone);
    }
    expect(names.filter((n) => n.endsWith('Error'))).toEqual([]);
  });

  it('names every §5.2 command', () => {
    expect(Object.values(CommandType).sort()).toEqual(
      [
        'loadMap', 'loadControlMap', 'loadSession', 'gotoLocus', 'zoomIn', 'zoomOut',
        'setForegroundColor', 'setBackgroundColor', 'setColorScale', 'setNormalization',
        'loadTrack', 'getTrackList', 'removeTrack', 'setTrackColor', 'setTrackName',
        'setTrackDataRange', 'setTrackAutoscale', 'setTrackLogScale',
        'getSession', 'getCompressedSession',
      ].sort(),
    );
  });

  it('names every §5.3 sync event', () => {
    expect(Object.values(SyncEventType).sort()).toEqual(
      [
        'locusChange', 'colorScaleChange', 'backgroundColorChange', 'normalizationChange',
        'displayModeChange', 'mapLoad', 'controlMapLoad', 'trackLoad', 'trackRemove',
        'trackColorChange', 'trackNameChange', 'trackDataRangeChange',
        'trackAutoscaleChange', 'trackLogScaleChange',
      ].sort(),
    );
  });
});

describe('protocol: guards', () => {
  it('isCommand accepts a known type with a string requestId', () => {
    expect(isCommand({ type: 'gotoLocus', requestId: 'r1', locus: 'chr1' })).toBe(true);
    expect(isCommand({ type: 'gotoLocus' })).toBe(false);
    expect(isCommand({ type: 'gotoLocus', requestId: 7 })).toBe(false);
    expect(isCommand({ type: 'toolCall', requestId: 'r1' })).toBe(false);
    expect(isCommand({ type: 'syncEvent', requestId: 'r1' })).toBe(false);
    expect(isCommand(null)).toBe(false);
    expect(isCommand('gotoLocus')).toBe(false);
  });

  it('isSyncEvent accepts type syncEvent with a known syncType', () => {
    expect(isSyncEvent({ type: 'syncEvent', syncType: 'locusChange' })).toBe(true);
    expect(isSyncEvent({ type: 'syncEvent', syncType: 'nope' })).toBe(false);
    expect(isSyncEvent({ type: 'syncEvent' })).toBe(false);
    expect(isSyncEvent({ type: 'locusChange' })).toBe(false);
    expect(isSyncEvent(undefined)).toBe(false);
  });

  it('isAck requires requestId string and boolean ok', () => {
    expect(isAck({ type: 'ack', requestId: 'r1', ok: true })).toBe(true);
    expect(isAck({ type: 'ack', requestId: 'r1', ok: false, error: 'x' })).toBe(true);
    expect(isAck({ type: 'ack', requestId: 'r1' })).toBe(false);
    expect(isAck({ type: 'ack', ok: true })).toBe(false);
    expect(isAck({ type: 'joined', requestId: 'r1', ok: true })).toBe(false);
    expect(isAck(null)).toBe(false);
  });
});
