# Codex protocol

Owner: provider adapter mechanisms. Public surface: the package `./codex` export.
Purpose: normalize recorded Codex exec JSONL and technical approval requests,
and encode an explicit permission decision. The codecs are pure; the explicit app-server client uses a caller-owned connected transport.

The runtime supplies decision authority, durable identity binding, process custody,
durable queues, persistence and recovery. The adapter bounds private volatile queues,
input/output and exact native event attribution. Returned raw provider data
is untrusted, potentially sensitive adapter data; do not log or expose it by default.
Unknown events remain explicit. No successful turn implies task completion.

This feature has static private helpers and ephemeral provider protocol state,
with no Get Modular module/Host lifecycle.
It introduces no runtime-wide SPI. `createCodexDriverFactory` implements the actual
canonical runtime's erased `DriverFactory`/`Session` contract; provider-shaped data
ends at this adapter rather than entering runtime core contracts.

Compared with the donor, parsed nested wire shapes are checked before mapping;
malformed item/usage/terminal fields emit a warning and cannot report success.
The JSON-RPC method stays authoritative over a conflicting params.type. The
private mapper is split into item and lifecycle functions for the profile budget.
The source inventory and deliberate exclusions remain in the root manifest.

Native `turn.failed` emits an explicit `turn_failed` fact, including when the
provider omits its diagnostic message; an ordinary `error` remains a warning.
Neither fact changes product task state. Missing usage and individual counters
remain absent; observed zero stays zero. Counters must be non-negative safe
integers. Invalid counter records produce a malformed-output warning.


The `CodexAppServerClient` is a provider-native technical boundary, not the runtime
public driver SPI. The caller supplies a connected UTF-8 JSONL transport, owns its
process and shutdown, and must honor the global transport abort. Writes are atomic
frames: a request cancellation after dispatch cannot unsend a frame. The client
never discovers/spawns/kills a binary, reads credentials/config, reconnects, retries
an uncertain request, persists state, or modifies teams/tasks/messages.

Call `initialize` once with explicit client metadata, then `startThread` with the
runtime-selected native configuration, or `resumeThread` with an already-reconciled
native thread ID and compatible configuration. No implicit sandbox, permission or
model policy is inserted. Native IDs are private checkpoint material; the runtime
owns durable identity/config binding, generations, leases, custody and recovery.
Resume is a native protocol command, not proof that previous work is recoverable.

A bound session's `submitTurn` keeps only a bounded volatile per-thread queue.
`accepted` is a native turn/start receipt; `completed` resolves only for the exact
native turn terminal. Neither is a durable-input or product-task acknowledgment.
After transport loss, request uncertainty or an unknown terminal status, queued
input is rejected and never replayed. The runtime decides reconciliation and may
establish a new transport; the library does not decide what input to resubmit.

`interrupt` takes the exact accepted `{threadId, turnId}`. A delayed control keeps
those IDs and cannot target a later turn. An interrupt response is only a receipt;
turn termination requires its separately scoped native notification. Submission
abort before dispatch is known not sent; after dispatch it requests an interrupt
once the native turn identity is known. It does not invent a stopped outcome.

Approval callbacks receive a current native request and abort signal. Replies use
explicit wire decisions, are suppressed after terminal/close, and never select
product permission policy. Legacy requests without a turn ID require independent
item attribution from the current native turn. Unattributed approvals are refused;
unknown notifications retain missing identity. Conflicting direct/nested native
thread, turn or item IDs cannot establish terminal or approval authority. Runtime current-generation authority
and native provider scope enforcement remain required.

Frames, chunks, nesting, pending requests, server callbacks, queued writes, threads,
turns, buffered pre-receipt notifications and text/items have explicit bounds.
The runtime still owns wall-clock/idle deadlines, durable queues, output delivery
backpressure, storage, process failures and recovery. The synchronous event sink
must hand observations to that runtime without starting unbounded async work.
Local close synchronously seals new/queued writes and aborts callbacks, but makes
no claim that a native turn or its process has stopped.

Tests include a real synthetic Node subprocess speaking JSON-RPC in a newly
created temporary directory. It contains no Codex executable, account or network
provider; these tests qualify the technical protocol mechanism only. Actual Codex
version/capability behavior, process custody and full team parity remain pending.

## Canonical session binding

The factory receives explicit Host configuration and selected checkpoint ports.
Its connected transport must be exclusive to this session binding: the caller
owns the binary, environment, authentication, protocol version, current generation,
MCP/product tools and physical cleanup. The library initializes the native client
and starts a thread with only caller-selected native configuration. No ambient
discovery or model/sandbox/approval policy is inserted. Capability rejection and
checkpoint compatibility checks precede native protocol IO.

The adapter preserves one active native turn and a bounded volatile canonical
input queue. A native turn/start receipt maps only to `client-consumed` with
provider acceptance unknown. The separately observed native terminal maps to
succeeded, failed or cancelled; unknown status, timeout or lost transport seals
the binding without replay. Queued inputs then return known-not-sent. Terminal
is committed before native abort callbacks, so delayed interrupt cancellation
cannot erase a known outcome or seal the next input. A pending interrupt fences
the next canonical input; its exact native turn reference cannot drift to B.

Native command/file approval and proven legacy item approval map to independent
canonical permission interactions. Allow encodes a single-turn accept, never
acceptForSession. Duplicate, aborted or previous-turn replies are stale. Rich
native permission grants have no faithful boolean mapping and return an empty
turn grant plus an unsupported diagnostic; questions and attachments are not
advertised. The Host qualifies the finite capability subset for this exact binding.
The native client exposes attributed item observations, including delta-only items;
these are facts, not permission authority. The canonical adapter retains bounded
native-thread item ownership tombstones. Cross-turn item reuse permanently makes
turn-less legacy approval ambiguous. Exhausting the history count/byte budget
refuses further legacy approvals with an output-limit diagnostic; entries are
never evicted and reassigned. Exact modern thread/turn approval stays usable.

Idle version-2 checkpoints contain a private native thread ID, compatibility digest
over account/config/trusted binding and selected native parameters, and the bounded
item ownership history/exhaustion flag. Ownership uses fresh private input tokens,
so even native turn-ID reuse after reconnect cannot reassign an old legacy item.
Restore validates the strict plain-data schema, duplicate IDs, ownership tokens
and history count/byte bounds before any native IO. History-free version-1
checkpoints are incompatible. Explicit restore requires that selected checkpoint;
native resume failure cannot create a fresh thread.
The Host must reconcile native persistence and recovery eligibility before opening.
Local close synchronously seals submissions and interactions and detaches protocol
IO; cleanup remains unknown unless the caller separately confirms owned native
work stopped. It never kills a shared host or claims a process stopped from EOF.

Focused tests use two isolated actual synthetic JSON-RPC children, selected restore,
permissions, neighbor-safe delayed interrupt, output bounds, timeout, no replay and
truthful cleanup. Packed proof assigns the factory to the actual canonical type
and runs the installed adapter across that subprocess boundary. This is technical
candidate qualification, without a real Codex binary, account or full-team claim.
