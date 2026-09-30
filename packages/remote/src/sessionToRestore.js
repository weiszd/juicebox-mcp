/**
 * The session a late joiner restores from the room's `peerSessionData` answer
 * (design §7): a live peer's session, or else the room's saved session, which
 * comes compressed. Resolves to undefined when the room has no state (an error,
 * nothing, or a session with no map in it); rejects on a compressed session it
 * cannot read.
 *
 * @param {{session?: object, compressedSession?: string}} answer
 * @returns {Promise<object|undefined>}
 */
export async function sessionToRestore({ session, compressedSession }) {
  if (!session && typeof compressedSession === 'string') session = await decompressSession(compressedSession);
  // An entry with a url is a panel with a map; a peer's session also lists an empty panel as {}.
  return session?.browsers?.some((b) => b?.url) ? session : undefined;
}

/**
 * Read what `hic.compressedSession()` writes: `session=blob:` then the url-safe
 * base64 of the raw-deflated JSON, one byte per character (juicebox.js
 * sessionCodec, igv-utils BGZip.compressString). juicebox.js exports no decoder,
 * so its wire-format version check (`version: 1`) is not applied either.
 */
async function decompressSession(text) {
  const prefix = 'session=blob:';
  if (!text.startsWith(prefix)) throw new Error('Not a compressed session');
  const base64 = text.slice(prefix.length).replace(/\./g, '+').replace(/_/g, '/').replace(/-/g, '=');
  const deflated = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const inflated = new Response(new Response(deflated).body.pipeThrough(new DecompressionStream('deflate-raw')));
  const bytes = new Uint8Array(await inflated.arrayBuffer());
  return JSON.parse(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
}
