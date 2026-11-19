# Cancelled OpenCode V2 request admission

## Problem and selected boundary

The original request admission promise can still be pending when its abort
listener rejects the bounded await. The previous catch immediately reported
`cleanup_unknown`, even when the caller's original callback responded to that
same abort and completed its cleanup before the native read-cut settled. The
driver correctly retained that unknown outcome; later disposal could not repair
the premature classification.

Three controlled Host schedules characterize the distinction: both final HTTP
requests admitted before cancellation; one original admission held until after
cut failure; and the same pending admission returning from its own abort
listener. The third exposes the classification race. These schedules do not
identify the unobserved substage of a separate original native Linux failure.

The selected correction stays in the three existing protocol owners:

- Execution and control transports retain the absolute cutoff of their existing
  request timer and pass it to the existing admission helper. The control timer
  still starts before request-body consumption. Neither the thirty-second limit
  nor a shorter context deadline is extended.
- On signal cancellation, admission may join only its already-created, tracked
  callback promise within that original cutoff before first classifying cleanup.
  It does not call the callback again, acquire another lease, project a password
  or dispatch a request.
- Typed uncertainty, throwing release, a pending or late callback at the cutoff,
  and previously emitted unknown outcomes remain unknown. The same release is
  still attempted at most once, including late fulfillment after close.

The native read-cut retains its existing earlier bounded settlement. Response
body cleanup, transport disposal, driver sticky uncertainty and caller-owned
Host drain are unchanged. A directly used transport may wait for the remaining
original request interval after an early abort; it gains no later deadline or
additional grace interval. Public package exports and the Session SPI do not
change.

## Review and execution record

Independent prospective review accepted this scope against source
`b19494fd2de47538a1c9315e338199ff41bbe497`; final exact-source review is complete.
Review found one additional uncertainty case: control transport must retain
`cleanup_unknown` even when its typed disposition says `not_submitted`. The
existing control predicate now matches execution transport, and both actual
wires have a regression for this case.

The original source with the first eighteen new regression cases produced eleven
expected failures and seven negative passes; the same tests then passed on the
correction. The additional review case failed on control before its fix and
passed on both wires afterward. The final unchanged `pnpm check`, using Node
24.21.0 and pnpm 11.18.0, passed all 597 source tests, both packed-consumer tests,
TS7 builds and typechecks. Source hashes remained unchanged throughout that gate.

The implementation archive retained from that exact consumer gate is 191401 bytes,
SHA256 `ccc36bfab30ecb73185ede9ecb335bb1c0808ca646b9c5fb600527a085d5d700`.
Compared with the previous consumed archive, only the three reviewed compiled JS
owners differ. Every declaration, public export and other member is unchanged.
The 6230-byte Session SPI archive is byte-identical, SHA256
`0ea08bacd3f19a54c065cfaebbe8ae0fb3a8e6770886402f435a96e97867d2bc`.
[Exact source, results and reviews](evidence/v2-admission-settlement-20261119.json)
and [raw checks](evidence/v2-admission-settlement-checks-20261119.tar.gz) are retained.

These are local source/packed-consumer results. Original CI for both declared
Node versions and the consumer's distinct integration/native/GUI qualification
remain required. The Host adopts these exact checked bytes without repacking.

Only disposable TEST fixtures are selected. No real Claude/Codex executable,
vendor inference, package/release publication, consumer default activation or
authority/ownership change is part of this correction.
