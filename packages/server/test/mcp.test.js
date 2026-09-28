/**
 * MCP seam: JSON-RPC over POST /mcp on the Worker under test.
 */
import { SELF } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('initialize answers with the server info and an mcp-session-id', async () => {
  const res = await SELF.fetch('https://jbmcp.test/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    }),
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('mcp-session-id')).toBeTruthy();
  const body = await res.json();
  expect(body.id).toBe(1);
  expect(body.result.serverInfo.name).toBe('juicebox-server');
});
