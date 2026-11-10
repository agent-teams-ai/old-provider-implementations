---
type: feature
status: accepted
owner: "@agent-teams/provider-implementations"
owner_document: ADR-0092
---

# Provider session implementation

One cohesive technical feature implements the runtime-owned interactive session
SPI. Provider-specific protocol mechanisms and adapters remain grouped under
`adapters/claude-sdk`, `adapters/codex-protocol` and
`adapters/opencode-protocol`. Fixed bounded queue/feed primitives live in
`adapters/provider-session-io`; they are not a separate graph or policy owner.

`contracts` contains the existing portable Codex event and approval wire shapes.
The public feature entry exposes only those types. SDK DTOs, native clients,
configuration and checkpoint bytes stay in adapters and the implementation-only
internal entry. Module composition and four curated package facades contain
named re-exports, without inline orchestration.

The feature has no domain or application layer because runtime session policy,
durable intent and authority belong to Agent Execution, and product tools belong
to Orchestrator. There are no empty layers or duplicated canonical contracts.
Callers provide custody, selected native transport/configuration and checkpoint
storage. The volatile provider queue, native callback fences and private bounded
checkpoint metadata are protocol mechanisms, not a second runtime authority.

Algorithms are retained from the exact qualified extraction checkpoint; the
materialization manifest distinguishes unchanged relocation from path and
assembly adaptations. Synthetic subprocess/HTTP fixtures retain targeted
interrupt, no replay after uncertainty, strict restore and late-permission
fences. They do not prove real authentication or deployment qualification.

The curated `./claude` facade also exposes `readClaudeMetadata`: one bounded SDK
initialization read of native models and credential-source metadata, with no
user input, tools, MCP or persisted conversation. Inherited hooks are explicitly
disabled for this metadata operation. Its captured configuration and
spawn callback remain Host-owned; SDK query closure does not prove physical
process release. The consumer must confirm custody before publishing the result.
The helper strips private account identity, bounds native metadata, closes on
success/failure/cancellation/deadline and reports cleanup uncertainty. It never
turns catalog/credential-source observations into authentication or execution
proof. This is a fixed native adapter helper inside the existing feature, not
another Session SPI, Assembly graph node or runtime lifecycle authority.

`probeClaudeModel` is the corresponding finite explicit model test. It waits for
native model metadata, rechecks the caller's `canSubmit` fence before releasing
one input, and accepts only matching main-thread text and terminal model usage.
Optional effort requires native model support and is passed to the SDK; explicit
one-million context uses the same SDK beta as interactive sessions and requires
matching context evidence. Tools, MCP, hooks and persistence are disabled. The
caller owns durable intent, replay, cancellation and physical process custody;
the helper returns no product or global authentication authority. This remains
inside the existing native adapter feature and curated `./claude` facade.
