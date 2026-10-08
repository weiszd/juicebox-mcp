# Coding standards

Read during code review, not implementation. Mechanical rules live in the tests and CI
(`.github/workflows/test.yml`); this file holds the judgement calls a reviewer applies to a
diff. CLAUDE.md "Conventions" states the test-seam rule; the rules below assume it.

## Remote (`packages/remote`)

- **A lookup shared by commands and sync events is exercised with both value domains.** Commands
  carry what a tool accepted (a number or a name); sync events carry what the sender's viewer
  holds (any string, including all digits or names differing only by case). A change that
  unifies the two paths must show a spec case from the sync side's domain, or it has only
  tested the command side. (Ticket 35: the shared track lookup read an all-digit track name as
  a position on the sync path; review caught it, no spec had.)
- **Wire payloads are a contract with pages already deployed.** A refactor of the observer or
  applier keeps every `syncEvent` and `ack` shape byte-identical unless the ticket says
  otherwise; the reviewer diffs the emitted objects, not the code that builds them.

## Server (`packages/server`)

- **Tool names, titles, descriptions and schemas are the client contract.** The `tools/list`
  fixture is regenerated only when a ticket deliberately changes the contract, never to make a
  refactor pass; a diff that touches the fixture names the contract change in its message.
- **A catalogue row keeps its exception visible.** When a command tool needs more than the
  default row (argument conversion, a refusal, a fetch), the row declares it (`rgb`,
  `failure`, a named `command` function above the table); the loop stays generic.
- **A refactor that drops a `try`/`catch` says why.** The ticket-37 rewrite silently narrowed
  `load_session`'s catch so a room failure propagated instead of answering "Error loading
  session"; a removed guard is either shown unreachable (and the reason stated) or kept.

## Everywhere

- **Logging in tool paths uses `src/lib/logger.js`**, never `console`.
- **Cross-package imports go through the published seams**: the server imports the remote only
  via `@aidenlab/juicebox-remote/protocol`; the remote never imports juicebox.js.
