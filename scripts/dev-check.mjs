#!/usr/bin/env node
// Call one MCP tool on the Juicebot dev Worker, bound to a room, and print the result text.
//
//   node scripts/dev-check.mjs <room> <tool> ['<json args>']
//   node scripts/dev-check.mjs T35CHECKCQ list_panels
//   node scripts/dev-check.mjs T35CHECKCQ load_map '{"url":"https://hicfiles.s3.amazonaws.com/hiseq/gm12878/in-situ/combined.hic","panel":"new"}'
//   (a map known to load in the page; an ENCODE portal download URL may fail with "Failed to fetch")
//
// Use a throwaway room (open https://juicebot-dev.3dg.io/?room=<room> in a tab first), never a
// room someone is working in: the room asks its first live page for the session on every
// join, and a probe that does not ack breaks that room for everyone in it.
//
// Why this exists: the Claude Code juicebot plugin and Claude Desktop connectors point at
// juicebot-mcp.3dg.io, a custom domain of the frozen demo Worker juicebox-mcp-v2; its rooms are a
// different Durable Object namespace from the dev Worker's, so they cannot drive a page on
// juicebot-dev.3dg.io. MCP_URL overrides.
const [room, tool, argsJson = '{}'] = process.argv.slice(2);
if (!room || !tool) {
  console.error('usage: node scripts/dev-check.mjs <room> <tool> [json-args]');
  process.exit(2);
}
const url = process.env.MCP_URL || 'https://juicebot-mcp-dev.3dg.io/mcp';
const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function rpc(id, method, params, sessionId) {
  const res = await fetch(url, {
    method: 'POST',
    headers: sessionId ? { ...headers, 'mcp-session-id': sessionId } : headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = JSON.parse(text.match(/data: (.*)/)[1]); // SSE-framed answer
  }
  return [json, res.headers.get('mcp-session-id')];
}

const [, sessionId] = await rpc(1, 'initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'dev-check', version: '0' },
});
await rpc(2, 'tools/call', { name: 'join_room', arguments: { room } }, sessionId);
const [reply] = await rpc(3, 'tools/call', { name: tool, arguments: JSON.parse(argsJson) }, sessionId);
const text = (reply.result?.content || []).map((c) => c.text).join('\n');
console.log(text || JSON.stringify(reply, null, 2));
if (reply.result?.isError || reply.error) process.exit(1);
