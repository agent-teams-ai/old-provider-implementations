# OpenCode extraction claim map

Evidence source: immutable fork `969afc56ec39d92c33dd5aabd15ef782da94dd87`;
selected current mechanisms are checked against observed committed main
`60d37dbe4d04842f98b93fb60c07224ffd7ccc1a`. The dirty local branch is untouched.
These are mechanism claims, not full runtime or product qualification.

| Old capability | Delivered mechanism | Remaining before full parity |
| --- | --- | --- |
| V1 explicit HTTP endpoint and native session APIs | Bounded HTTP client and scoped session façade; HTTP fixtures | Real binary/client contract qualification and runtime wiring |
| V1 permission requests and responses | Cross-session rejection and one POST attempt | Runtime live interaction/generation authority; native server enforcement |
| V1 shared-host targeted abort | Native session endpoint; neighboring synthetic session survives | Real stop observation, process/lease cleanup and containment |
| V1 SSE envelope and session/message references | Envelope decoder, bounded event/diagnostics | Reconnect/gap, canonical event projection and durable runtime feed |
| Native message IDs | Pure ordering/encoding | Runtime-owned durable allocation/scheduling |
| Existing schema1 session binding | Exact opaque legacy key + original workspace/run/host/profile/session/creation binding | Initial materialization, retirement and full authority-store validation |
| Technical cursor persistence | Consumer-owned atomic CAS port, sibling preservation, unknown receipt read-only reconciliation | Production storage custody/locking/durability and integration |
| V1 terminal outcome proof | Bound original workspace plus complete exact-anchor transcript/tool qualifier | Native observation/normalization, bounded pagination and runtime reconciliation |
| V2 native execution transport | Exact-version finite HTTP/SSE transport, mutation uncertainty and opaque identity-bound absence; localhost fixtures | Native host identity/lease qualification, generated client mapping and runtime integration |
| V2 generated clients and native event models | Finite session/log/message cut reader and neutral complete-cut lineage/text/tool/terminal projection, without product receipts | Qualified native package/graph identity, remaining official client surface and durable runtime feed |
| V2 session interrupt, permission, inbox cancellation and instructions | Exact two-pin translations over bound finite control wire; lost-receipt and neighbor-session HTTP fixtures | Runtime interaction/generation authority, native stop observation and real binary qualification |
| V1 existing-session canonical driver | Preserved native ascending input IDs/wire format, bounded exact-user snapshot/parent/model qualification, permissions, strict observed terminal/cancel and compatible checkpoint | Native Host/materialization, credential/OAuth custody, unknown recovery, questions/attachments/usage and token-delta parity |
| Existing native session driver composition | Candidate bounded volatile queue, exact-input permission lineage, control fence, qualified text/tool/result projection and idle-only checkpoint through the actual canonical DriverFactory/Session SPI | Real native/Host qualification, durable recovery, token-streaming parity and actual runtime composition |
| V2 host/profile/lease lifecycle | Pending | Move mechanisms behind runtime custody; no old process-global authority transplantation |
| Auth, model routing and subscription profiles | Pending | Explicit runtime policy/custody and behavior compatibility |
| Change evidence and transcript projection | Pending | Separate provider facts from Work/task attribution |
| Old ledger writes and bootstrap team authority | Excluded deliberately | Authoritative new Orchestrator handlers must replace these behaviors |

No row authorizes deleting a donor file or shutting down an existing host. Native
protocol transport success, technical terminal evidence and product Work completion
are separate observations. The library cannot infer authorization from a storage
key, member name, endpoint URL or a successful synthetic fixture.
