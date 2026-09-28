/**
 * Session ids on the ChatGPT path: no mcp-session-id, an x-openai-session on
 * every request, room id derived by HMAC with the SESSION_HMAC_SECRET secret
 * (design §5.4, §6.4). The test secret comes from vitest.config.js.
 */
import { SELF, env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index.js';

const ROOM_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/; // Crockford base32: no I, L, O, U

function initializeRequest(openaiSession) {
  return new Request('https://jbmcp.test/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-openai-session': openaiSession,
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  });
}

async function sessionFor(openaiSession) {
  return (await SELF.fetch(initializeRequest(openaiSession))).headers.get('mcp-session-id');
}

describe('x-openai-session room ids', () => {
  it('are 10 Crockford base32 characters, stable for the same header, distinct across headers', async () => {
    const a = await sessionFor('openai-session-a');
    expect(a).toMatch(ROOM_ID);
    expect(await sessionFor('openai-session-a')).toBe(a);
    expect(await sessionFor('openai-session-b')).not.toBe(a);
  });

  it('are not the raw header value', async () => {
    const raw = 'ABCDEFGHJK';
    expect(await sessionFor(raw)).not.toBe(raw);
  });

  it('without SESSION_HMAC_SECRET, initialize fails instead of using a default key', async () => {
    const { SESSION_HMAC_SECRET, ...envWithoutSecret } = env;
    const res = await worker.fetch(initializeRequest('openai-session-a'), envWithoutSecret, createExecutionContext());
    expect(res.status).toBe(500);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect((await res.json()).error.message).toMatch(/SESSION_HMAC_SECRET/);
  });
});
