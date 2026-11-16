# Retain the final OpenCode V2 read failure and original close stage

## Selection and evidence boundary

This proposal selects a bounded diagnostic correction for the existing migration failure. It does not select a behavioral cleanup repair. The actual application receipt on `3be1fb3ec43d5682aa2ca77a6af62e6fa27b597b` consumes producer `c930d3c8b9a213762528d6e28c9ed0172ab1fa27` and implementation archive SHA256 `9d66036c17a4c2bf86dde9171d94d3048e5df6f6f1ee17ff05758e3a7cf2be41`. Its fourth, deliberately unanswered credential verification retains a held resource and the original Host exits1 where the unchanged fixture requires0. Physical child absence does not discharge unresolved I/O or admission debt. The old settled-fetch correction is already present.

The independent original-receipt review is `3be-v2-linux-r2/independent-actual-r2.json`, SHA256 `acf00cd6ef45671d86ad348ce9b8d4b95c27da7817bd8a14cbe99da2c9a1b741`. The bounded source proposal is `3be-v2-final-cleanup-diagnostic-proposal/proposal.json`, SHA256 `ce39326c978c739bc6386aa8a0b13927166e31afede35cb83dd72a1d8de0927b`. These are held review artifacts, not newly qualified runtime outcomes.

Two existing observations omit the discriminator needed to choose a repair:

1. The read-cut diagnostic retains the first failure. After the original sibling `allSettled`, an unknown-cleanup sibling may instead determine the error actually thrown.
2. Shared driver close returns the same unknown receipt when its original work join, protocol disposal, or physical confirmation fails. The application observes only `driver-close/unconfirmed`.

The selected correction observes those existing outcomes. It preserves the actual thrown error, unknown cleanup result, native authority, deadlines and no-replay rules.

## Repository and exact source scope

Repository: `agent-teams-ai/old-provider-implementations`. The reviewed parent is `c930d3c8b9a213762528d6e28c9ed0172ab1fa27`, tree `a9ce51413c87bc65b54fe07e45a1dc13b2b4c63a`. Existing PR8 is open Draft from `feat/frontend-parity-20261112` to `bootstrap`, base `d58500bc983e897506e23d7b0bc8da1209864edd`. Recheck those refs and preserve incoming history before any publication.

Exactly four existing source paths are selected:

| Path under packages/provider-implementations | Before Git blob | Purpose |
| --- | --- | --- |
| src/features/provider-session-implementation/adapters/opencode-protocol/v2-native-cut.ts | c074fa2c2219eab448e1d1276dbab75f2d9ade2e | Add final closed failure classification to the existing diagnostic |
| src/features/provider-session-implementation/adapters/opencode-protocol/driver-session.ts | 6cea8b4842161ceef56750dde740799f506a1037 | Observe the original failed close stage for V2 only |
| tests/features/provider-session-implementation/opencode-protocol/v2-native-cut.test.ts | 3dc7e46b70b9786ad4f26220611f0865c2ebf4fb | Preserve error/cleanup behavior while distinguishing first and final failure |
| tests/features/provider-session-implementation/opencode-protocol/v2-driver-session.test.ts | a25c90eedfb5e2a5da110ced3109fa4cb52f8ea8 | Exercise existing close branches and diagnostic neutrality |

No public Session SPI, package/export name, dependency, workflow, generated dist, archive or application source changes belong to this producer cut. Both implementation files are currently298 and227 physical lines; expected additions are small and must be reported without compression or extraction.

## Existing read-cut diagnostic

Keep every original `stage`, `reason`, `elapsedMs`, `deadlineExpired` and `aborted` value and its original capture point. Add `finalReason` to that same published event, using the existing closed `failureReason(error)` classifier on the actual outer-catch error after all existing sibling settlement. Do not obtain it from `failures.get(error)`, which intentionally maps translated errors to the earlier failure.

The original suppression of `mutable_native_readback` diagnostics remains. The original catch still aborts at the same point and throws the same error object. No additional clock, timer, request, read, wait, abort or cleanup call is introduced. The new field exposes only an existing allowlisted reason; no raw message, stack, code, URL, credential or body crosses the diagnostic boundary.

Treat `finalReason` as optional at subsequent TEST observation/projection boundaries so that a valid old producer event remains readable. Absence or invalidity of a new optional field must not reject a valid original event.

## Existing shared driver close

Add a local stage marker around the same three existing bounded awaits. Its closed values are `original-work`, `protocol-dispose` and `confirm-stopped`. The first stage includes the existing loop, control and reply promise join; it must not imply that any rejected original work has settled.

At the existing unknown return, publish one best-effort in-memory diagnostic on `agent-teams:opencode-v2:driver-close-failed`. Its closed outcome is `threw` for the existing catch, or `unconfirmed` when the existing normalized V2 physical confirmation returns false. Include only the validated64-hex `trustedBinding` already supplied by the caller, plus the stage and outcome. That digest is a correlation label, never process or cancellation authority.

The V2-only guard and binding validation must be inside best-effort handling. Use own data descriptors rather than invoking accessors for newly observed configuration fields. Producer-owned validation and publication failures must not replace the original receipt or throw into close. Emit nothing for successful close, V1, malformed/inherited/accessor binding, or absent subscribers. Do not read a raw exception to classify the close stage.

This neutrality requirement does not isolate arbitrary subscribers: [Node24.21 diagnostics_channel](https://nodejs.org/download/release/v24.21.0/docs/api/diagnostics_channel.html#channelsubscribefunction) invokes them synchronously, and a throwing callback triggers `uncaughtException` outside the publisher's catch. The future TEST collector must contain its own callback errors. Do not add process exception handlers, channel wrappers or a universal observer-isolation claim; subscriber work retains the existing synchronous channel semantics.

Preserve seal/abort/wake, the same bounded await arguments and order, the cached closing Promise, one original physical confirmation when reached, the same truthiness semantics of the shared owner, and the existing `feed.end()` finally. The unchanged V2 wrapper already normalizes confirmation to strict boolean. If disposal fails, do not newly call physical confirmation. Do not clear sticky cleanupUnknown, reinterpret later process absence, retry any action or reset a deadline.

## Focused checks in the existing suites

Extend the existing read-cut cases rather than adding a parallel harness. Distinguish the preserved first reason from the final override in the actual sibling-failure path. Retain the original thrown Error where no override is selected, and retain existing unresolved fetch, explicit unknown, late body cancellation and byte/clock limits. Exercise allowlisted classification without invoking diagnostic getters.

Use the existing shared-session constructor/protocol seam in the V2 driver suite to cover failed original-work join, disposal throw, false and throwing physical confirmation, and successful close. Verify original downstream call counts/order, cached Promise identity, unchanged receipt/feed completion, no V1 or success event, and no raw/getter data. Keep all pre-existing assertions and fixture deadlines. These are proposed checks, not executed results.

No local project import, install, compiler, test, provider, native executable or GUI execution is selected. Original CI supplies qualification.

## Publication and qualification sequence

Publish this selected document and its independent R2, then read back their complete actual bodies/tree before creating source afterimages. Review the exact four-path diff independently with full preimage/inverse preservation and actual line counts. A separate staging ref may hold this coherent document/source sequence without opening another PR. Every commit is followed immediately by ordinary expected-parent publication; no force or history rewrite.

Before moving the existing PR8 branch, the sole agreed CI observer must confirm no useful original jobs would be cancelled. Preserve Draft, base and all existing history. Use only the original automatically eligible jobs; no manual dispatch, rerun or cancel.

The unchanged producer CI requires `pnpm check` under Node24.21.0 and26.11.1 with pnpm11.18.0. Its Node24 row retains the exact two archives exercised by the packed-consumer check. The original finite OpenCode V2 native matrix is also applicable because both implementation paths match its existing selector. Successful queues, partial output or stale receipts are not qualification.

Genuine Claude/Codex suggestion jobs remain gated by Draft and are never invoked. Do not mark Ready, merge, publish packages/releases, activate defaults or enter Stage2.

## Consumer boundary remains a separate selection

This producer cut alone does not change the application or qualify the original Linux credential journey. After exact producer qualification, a separate adoption review must inspect the entire consumed-c930 to resulting-source delta, the checked archive, source/toolchain identities and unchanged contracts. Never edit a tarball or generated dist to manufacture the diagnostic.

The prospective application cut is limited to its existing TEST passive collector and existing Host lifecycle suite: preserve optional finalReason, hold at most one validated close fact with an ambiguity flag, and enrich the already reserved Host driver-close row only for the exact matching trustedBinding/probeDigest. Missing, mismatched or ambiguous data remains inconclusive. No extra stderr row, clock, I/O, cap, authority or behavioral acceptance change is implied. Its exact source, tests, validation pins and adoption inventory must be separately selected before implementation.

Only the original resulting-source Linux credential execution can reveal the missing cause. If it reports protocol disposal, the native I/O debt origin may still require a further justified observation; this proposal does not authorize a speculative cleanup repair or weaken the original gate.
