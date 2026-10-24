# Claude SDK adapter

Concrete `./claude` provider entrypoint. The six reviewed B algorithms at
`c9740b35a433ba370ed473a8dbfba27f3d902bbd` move here with their canonical
runtime SPI imports. The former index algorithm is `open-session.ts`; the public
index adds only exports. `createClaudeDriverFactory` implements the real erased
`@agent-teams/agent-execution/interactive-contracts` factory; `openClaudeSession`
retains the same underlying algorithm for the existing qualification harness.
[Provenance](../../../../../provenance/claude-sdk-extraction.json) records immutable donor blobs and hashes.

The Host supplies trusted native configuration, an explicit checkpoint-reference
reader, scoped capabilities, readiness and process custody. The factory rejects
unsupported capabilities before constructing the SDK, and rejects mismatching
runtime session/configuration revisions. Checkpoint absence never selects latest
or starts a fresh session. Native account/workspace/configuration compatibility
and session existence are checked by the reviewed algorithm; checkpoint bytes
never enter runtime caller snapshots. The runtime owns durable session/generation,
input/operation identity, admission, deadlines, authorization and recovery.

The adapter owns volatile SDK input sequencing, normalization and interaction
correlation. SDK input consumption is not provider acceptance. Missing usage
stays unknown. Technical result cannot complete product Work. Interrupt and close
seal callbacks; an SDK close receipt requires separate Host confirmation before
claiming physical cleanup. No replay, provider fallback, daemon, process-tree
supervisor, credential discovery, team/task/message writer or product-state store
is added. SDK launch is routed through the Host custody port with its selected
explicit environment. Product team capabilities must be supplied through the
Orchestrator-owned control MCP; this boundary does not authorize feature removal.

An optional trusted `toolBinding` port supplies an explicit tool-name set and
`prepare(ClaudeToolBindingRequest) -> { updatedInput }`. The adapter captures the
runtime session/input/operation and native tool-use ID before awaiting the Host.
It requires the SDK hook's native session/tool-use ID/name to match a tool
observed in foreground frames correlated to that input; unknown attribution and
native subagents fail closed. Native prompt IDs are independent of submitted SDK
input UUIDs and are never treated as interchangeable. This prevents
a delayed first callback from A from borrowing active B. Payloads are copied.
Native tool identities remain tombstoned across inputs in this physical session;
cross-input ID reuse fails closed. The configured output-event budget also bounds
the number of retained identities. Capacity exhaustion ends with `output-limit`,
without evicting attribution or authorizing an ambiguous callback.
Interrupt, terminal, close, timeout or SDK abort revokes preparation. A late
result cannot reach MCP. Only updated input is returned: the Host cannot grant
a technical permission through this port. It owns any opaque invocation payload
and product authorization remains with the Orchestrator control service. The
matched tool-name set participates in checkpoint compatibility.

Exact reviewed dependency tuple: Claude Agent SDK `0.3.305`, bundled Claude Code
`2.1.305`, Anthropic SDK `0.122.0`, MCP SDK `1.30.0`, Zod `4.6.7`. These explicit
pins prevent broad SDK peer ranges from silently changing the moved tuple.
Canonical runtime types come from a digest-pinned actual C package tarball,
with its normal Filesystem Custody companion override for private `0.0.0` local
qualification. They are not copied contracts or source aliases. See the
[artifact record](../../../architecture/runtime-contract-artifacts.json).

This feature is an adapter selected by external Host composition, with static
feature-local helpers and no Get Modular Host/Assembly lifecycle. The profile
allows only the SDK public entry and an erased canonical contract edge. Runtime
imports or deep imports across that type-only boundary fail the architecture gate.
This candidate is not real-provider, security, deployment or full-team qualification.

The B experiment's editable algorithm must be replaced by re-exports and its
five private files removed in the coordinated integration patch. Its existing
qualification fixtures and one evolving SDK-process harness remain the oracle.
`pnpm qualify:claude-migration /path/to/read-only/agent-runtime` stages only those
immutable test fixtures in a new temporary consumer and runs them against the
installed library and actual canonical package tarballs. It stages no old driver
source. The test-owned configuration builder retains mutable limits while C's
public limits remain readonly. The current canonical contract uses `client-consumed`
and permits asynchronous replies, so fixture expectations adopt that vocabulary
and reply calls are awaited with an AST-targeted change; all assertions remain.
It uses only localhost
synthetic model/MCP data and reads no user credentials.
The adapted SDK-process fixture additionally rewrites a read-only echo marker
through this port and verifies the rewritten value at the actual MCP handler.
An optional second CLI argument names an owned artifact directory. Only after
successful qualification is the exact installed tarball copied there without
overwriting a file, with SHA256 and integrity printed in the final receipt.
