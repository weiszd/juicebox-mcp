/**
 * Durable Object per MCP session (keyed by the MCP session id): remembers the room
 * `join_room` bound the session to. With no binding stored, the session's room is
 * the room whose id is the session id itself (design §6).
 */
export class McpSession {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    if (request.method === 'PUT') {
      await this.state.storage.put('room', await request.text());
      return new Response(null, { status: 204 });
    }
    return new Response((await this.state.storage.get('room')) ?? '');
  }
}
