# Cancelled OpenCode V2 request admission

## Current correction: preserve transport lifecycle cancellation

The first correction, published at `e458b7f5513a55122905205bd22bcb25977643b0`,
passed 597 source tests, both packed consumers and all 53 original native jobs.
Its app integration nevertheless exposed an existing negative case that timed
out: 23 cases passed and the original held-custody close exceeded its unchanged
15000ms test limit. Those results are retained separately.

After the original five-second Host drain, DriverSession close cancels its
lifecycle signal and awaits the submit loop. The first admission correction
kept that loop waiting for custody until the original request cutoff. Its wire
disposal was still beyond the blocked request, so the existing disposal bound
could not yet help.

The three existing implementation owners now pass the already-captured
transport lifecycle signal to the second existing bounded join. A separate
request/cut cancellation may still join the same callback while the original
context is live. Lifecycle cancellation interrupts that join, leaving pending
custody UNKNOWN and tracked for its single late release. No controller, timer,
deadline, public configuration field, driver or Host owner is introduced or
changed. Native-cut, body/dispose bounds and the original Host drain stay intact.

The cooperative and cutoff test tables now explicitly use separate request and
context signals; the previous broader expectation is preserved as history.
Four new lifecycle cases failed on exact e458 bytes and passed on the correction
with identical test bytes. Independent R1/R2 passed. The final original pinned
Node24.21/pnpm11.18 check passed **601 source cases and both packed consumers**,
including the unchanged real HTTP read-cut tests, TS7 build and typechecks.

The exact retained checked implementation archive is 191469 bytes, SHA256
`ee1ed16c939dbdab4ee6b31941b4bff5d7e1e423224f8ca32e65f3a6ec25aed4`.
Its 259 members differ from e458 in three private JS files and the private
admission helper declaration. Public exports/declarations, package metadata and
all other members are byte-identical. The Session SPI archive remains unchanged.
[Exact correction, retained failure and final checks](evidence/v2-admission-lifecycle-20261119.json)
and [raw reviews/checks](evidence/v2-admission-lifecycle-checks-20261119.tar.gz)
record this slice. New-source CI and the unchanged full24-case app consumer gate
remain required after publication and exact archive adoption. Neither the
original app failure nor earlier native results qualify this later source.

## Initial e458 correction — historical record

### Problem and selected boundary

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

### Review and execution record

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
