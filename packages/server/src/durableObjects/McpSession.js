import { DurableObject } from 'cloudflare:workers';

/**
 * Durable Object per MCP session (keyed by the MCP session id): remembers the room
 * `join_room` bound the session to. With no binding stored, the session's room is
 * the room whose id is the session id itself (design §6). Reached through
 * `roomForSession` in src/room.js.
 */
export class McpSession extends DurableObject {
  /** The bound room, or '' when none is stored. */
  async getRoom() {
    return (await this.ctx.storage.get('room')) ?? '';
  }

  async setRoom(room) {
    await this.ctx.storage.put('room', room);
  }
}
