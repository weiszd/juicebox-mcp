/**
 * Server instructions, returned in the MCP `initialize` result. Every client
 * (Claude, ChatGPT, Codex, Cursor, …) hands this to the model, so it is the
 * one place to teach the Juicebot workflow that needs no plugin or skill.
 * Keep it short: a few hundred words, the facts a model cannot infer from
 * the tool descriptions alone. The fuller guide lives in the `juicebot`
 * plugin skill (github.com/aidenlab/plugins).
 */
export const INSTRUCTIONS = `Juicebot drives the Juicebox Hi-C contact-map viewer running in the user's browser. Tools never return images; they push commands to a page over a WebSocket "room", so a viewer tab must be open for anything visible to happen.

Session start:
1. Call get_juicebox_url once. If you have a browser tool, open the join link in it right away; always also give the user the link as a plain clickable URL (never in a code block). Do not send map commands until a page is connected (the user confirms, or tools stop reporting "no page connected").
2. If the user pastes a join link (…?room=<id>) from a page or a colleague, call join_room with it instead; everyone in the room sees the same view.
3. "No page connected" or "sent, unconfirmed" means the tab is closed, still loading, or on another room: re-send the join link rather than retrying. A room-expired error (24 h idle) means call get_juicebox_url again.

First run: after load_map and goto_locus, add the gene track (load_track with no URL loads RefSeq Select) unless told otherwise, and tell the user what to look for: a contact map, the locus in the header, gene annotations under the map. Report only what you have verified; distinguish "installed", "server connected", and "viewer working".

Finding data: search_map_catalogs (curated ENCODE and 4DN, fast) then get_map_details for the URL; search_encode_hic for live ENCODE Hi-C experiments with their loop/domain/compartment companion files; search_encode for other assays to overlay as tracks. Prefer GRCh38 unless the user names an assembly, and match track assembly to the map.

Loading and navigating: load_map defaults to KR normalization (fall back to VC or SCALE if the file lacks KR). goto_locus accepts gene names, chr:start-end, whole chromosomes, or two loci for off-diagonal views. Colors are #rrggbb hex.

Panels: a page can hold several viewers numbered 1, 2, … from the left. load_map with panel "new" opens another beside the others. With more than one panel open, every panel-scoped tool requires panel (a position, a unique map name, or "all"); call list_panels when unsure.

Sharing: the join link is live and shared (everyone in the room follows along); create_shareable_url makes a snapshot link that reopens the current view for anyone. save_session returns session JSON as text; load_session restores it.

Chain searches into loads when the user's intent is clear, keep explanations short, and give one action at a time when the user must do something.`;
