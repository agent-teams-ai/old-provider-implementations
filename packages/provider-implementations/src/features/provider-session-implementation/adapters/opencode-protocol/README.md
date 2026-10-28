# OpenCode protocol extraction

[Current extraction claim map](parity.md).

Candidate V1 HTTP/SSE mechanisms from immutable donor
`969afc56ec39d92c33dd5aabd15ef782da94dd87`. The local fork checkout's HEAD
`3bf24764` predates that snapshot and lacks newer V2 mechanisms; it is not the
source of this extraction. Dirty donor files are never read into the package.

The factory accepts an explicit HTTP endpoint and optional cancellation/deadline
context. The consumer owns endpoint custody, credentials, native session identity,
serialization, durable intents and checkpoints. No host is started or disposed.
`bindOpenCodeSession` directs operations to one explicit native session and rejects
cross-session permission replies and mismatching native message identities. Missing
message attribution remains missing. The permission GET+POST check is not atomic
authorization: runtime owns current request/generation authority and the native
server must enforce the supplied session binding. Prompt HTTP success is a handoff
receipt, not provider acceptance or completion. Redirects are refused, including
307/308 mutation forwarding. A successful native abort response is only a
transport receipt; it does not prove process cleanup or turn termination.

The original bounded response reader, protocol DTO closure and SSE event envelope
are retained. All JSON responses use bounded parsing; a failed permission POST is
never retried through alternate routes. Session identifiers are URL encoded.
SSE routing leaves unscoped events unscoped. Pure native message-ID codecs are
retained; ambient global prompt allocation is left to the runtime's scheduler.

The persisted binding adapter maps one explicit existing schema1 record through a
consumer-owned read/CAS-bytes port. It preserves the private legacy lane-aware key,
other records and unknown extension data; a pre-lane archive is never promoted.
Before rewriting, native JSON reviver source conservatively vetoes any numeric
literal whose serialization would differ, including unsafe integers, high-precision
fractions and noncanonical numeric spelling. Such files remain byte-for-byte
untouched with an unknown outcome. Binding strings/cursors are limited to 64 KiB,
and both the input envelope and proposed replacement must fit 32 MiB.
Original workspace, profile, host, run, native session and record creation identity
are pinned. Materialization claims, mismatching owner generations and stopped
records fence cursor writes. A lost CAS receipt returns unknown; read-only
observation after reconstructing the adapter can recover the cursor without replay.
The port owner guarantees atomic compare/replace, locking, custody and durability;
the library never creates a store, discovers paths, starts owners or changes team state.
Whole-store authority validation and creation/retirement remain with the existing
owner; this mapping does not certify an arbitrary legacy store as safe authority.

The pure V1 terminal qualifier retains the donor's exact user anchor, complete
history, session/parent/chronology and settled tool checks. Its bound variant also
requires original workspace/run/host/profile evidence. It returns a technical turn
outcome, never product Work completion or native process cleanup.

The V2 finite execution transport retains the donor's exact `2.0.0` / `2.0.21`
route, directory, request/response byte/complexity, media, deadline and complete SSE
frame checks. It consumes finite log reads; it is not a live subscription. The
runtime supplies an already-owned loopback endpoint/directory and a private password
callback. There is no credential discovery or native SDK import. The callback and
native response details never become error/proof payloads. Redirects are refused.

Only privately minted error identity establishes not-submitted or exact native
session absence. Absence is bound to the original endpoint/directory/version/native
session; a generic 404 or caller-shaped error cannot establish it. These are
transport observations, not independent proof that a native endpoint belongs to a
workspace: runtime still must qualify its native host identity/lease. Post-invocation
failure stays unknown and never triggers automatic mutation replay. Cleanup closes
this transport's requests, not a shared host or native execution. Published V2
interrupt/permission/steer routes are not admitted by this finite execution slice.
A separate session-bound control adapter below admits only the retained control routes.

The readonly V2 native-cut reader uses the already-owned finite transport. It
compares original session/location selection and synced log before/after complete
pagination (at most eight pages / 1600 messages, 4096 log events, 32 MiB total read
bytes). A changed cut, missing final empty page, duplicate IDs, cyclic cursor or
foreign workspace is rejected. Only an observed full prefix beginning with native
`session.created` at sequence 0 is qualified; trimmed or absent history stays unknown.
This conservative requirement follows retained native R264 cuts for both pins,
not a claim that every native deployment guarantees indefinite log retention. Native messages without their own session field
keep that absence; the owned read source is checked separately. The reader never
creates a session, queues an input, repairs a gap or writes an admission journal.
Its transport contract requires bounded finite reads and current custody checks.

The V2 native cut projector verifies exact delivered input, complete message/log
cut, contiguous event lineage, adjacent retry chains, assistant/text/tool snapshots
and execution terminal. Step/tool completion alone leaves the turn pending. It
emits text and raw technical tool facts, including running/error states. Tool names
and JSON content never infer task completion, a visible reply or a product receipt.
Unknown/future content parts are not interpreted as new capabilities. The runtime
owns captured-cut provenance and durable decisions; a projection DTO grants no
authorization and is not a privately minted recovery proof.

The V2 session-control adapter preserves the two pinned native dialects for
interrupt (`continue=false` / `resume=false`), permission (`reply` / `decision`),
inbox cancellation and session instruction entries. It binds one explicit native
session; shared Host MCP/configuration operations remain excluded. It retains
finite request/response limits and refuses redirects. An interrupt acknowledgement
is unconfirmed termination. Permission lookup verifies returned session and request
identity before one POST; this consistency check does not replace runtime generation
authority or native server authorization. A lost mutation response stays unknown.
Instructions contain caller-supplied native context, without team bootstrap builders.

The candidate session consumer composes these mechanisms over one existing
Host-selected native session. Its volatile bounded input queue, interaction map and
output feed do not replace runtime intents, input idempotency or durable recovery.
It checks the original workspace before each queue mutation, correlates native tool
permissions only through a qualified pending projection and its exact delivered
input plus running assistant/tool identity, fences
next handoff while a control reply is in flight, and seals admission after an
unknown mutation response without replay. Cancellation revokes interaction admission
after awaited lookups and aborts permission reply preflights before grant dispatch.
If a grant POST may already have started, its outcome remains unknown and seals
next handoff. Idle-only checkpoints pin the selected
native session and compatibility binding; restore never creates a replacement.
Host probing owns exact package/model/MCP/lease qualification. Close immediately
seals this consumer and bounds its own HTTP cleanup; Host stop evidence determines
whether cleanup can be confirmed. Native interrupt acknowledgement alone never does.
Structured questions, usage accounting and attachments are not supported by this
first consumer. `createOpenCodeV2DriverFactory` implements the actual runtime's
canonical `DriverFactory`/`Session` types (packed source `25de9bf2`): handoff is
`client-consumed`, permission replies may be asynchronous, and only observed native
terminal evidence produces `cancelled`. Transport acknowledgements remain unconfirmed.

`createOpenCodeV1DriverFactory` now implements that same actual canonical SPI for
one existing explicitly selected V1 native session. It preserves the V1
`/session/.../prompt_async` and permission wire formats and native ascending message
IDs; it does not emulate V2 inbox or execution-log events. The retained native
transcript mapper omits product bootstrap filtering. Reconciliation reads bounded
latest-window pages through the original user, validates every native message/part
session and assistant parent, checks the selected assistant model, confirms the
window again, and requires idle status plus the strict terminal qualifier.
Tool/step completion and unknown finish/error shapes never establish success.
Only measured `MessageAbortedError` terminal evidence establishes cancellation.

The two concrete backends share one private lifecycle actor containing the queue,
revocation, terminal, output and cleanup fences; native qualification stays within
each dialect. Positive cleanup also joins the backend's finite IO before requesting
Host stop evidence. V1 reads are capped at eight MiB per response and 32 MiB per
operation, with at most four 50-message pages per window. Overflow stays unknown.
The retained low-level client has its separate donor transcript budget; this new
consumer bound is not a claim of full native throughput parity. The canonical
consumer uses finite snapshot reconciliation (100ms polling for V1); retained SSE
parsing remains available separately and no token-delta capability is advertised.
Structured questions, attachments and usage are refused as required capabilities.
V1 Host creation/materialization, credentials/OAuth and durable unknown recovery
remain outside this candidate factory and are still required for full D.

This is not the full OpenCode driver. The V2 execution authority, host lease and
containment machinery, profile/auth custody, full durable materialization/store lifecycle, model routing, reconnect and
terminal observation/reconciliation remain unextracted. The narrow binding mapper
and V1 terminal qualifier above do not replace those owners. Their absence does not authorize
removing the donor. Product ledger writers, bootstrap handlers, sibling desktop
MCP discovery and team readiness are deliberately excluded and must be replaced
by their new owners before full parity. No runtime public SPI is defined here.

Tests use a new localhost fixture server, shared by two synthetic native sessions.
They test scoped cancellation and permission decisions, body bounds/deadlines,
SSE normalization and malformed payloads. They do not qualify a real OpenCode
binary, provider account, host containment, product tools or production persisted migration.
Binding tests use disposable files with one atomic CAS custodian and reconstruct
the adapter after a lost receipt; cross-process locking/power-loss durability are
port-owner responsibilities and are not qualified by this fixture.
