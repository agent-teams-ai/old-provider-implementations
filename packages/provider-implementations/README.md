# Provider implementations

Claude SDK, Codex app-server and selected OpenCode V1/V2 session implementations.
The sibling `@agent-teams/provider-session-contracts` package owns the shared
interactive SPI; this package references it through erased type imports.
Consumers own configuration, durable intent/checkpoints, process custody, tool
policy and provider qualification. No runtime engine package is required.

Import concrete APIs from `./claude`, `./codex`, `./opencode`, or `./session-io`.
The root exports types only; `./composition` exports factories. Public names and
exports are unchanged from the source checkpoint.

`pnpm --filter @agent-teams/provider-implementations check` builds, typechecks,
runs controlled protocol fixtures and verifies an isolated packed consumer.
The root `pnpm check` also builds and verifies the sibling contracts package.

The files in `provenance/` and feature-local documentation preserve prior
extraction history. Current standalone source provenance is recorded at
`../../provenance/source-extraction.json`; old ADR references describe upstream
history, not an engine dependency or a qualification claim for this checkout.
