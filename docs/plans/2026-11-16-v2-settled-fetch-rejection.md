# Root R1: retain settled V2 fetch failures and explicit cleanup uncertainty

Date: 2026-11-16. This is a separate bounded producer correction within the existing frontend migration; it does not adopt a new package into the app or qualify its current failed Linux credential scenario.

## Exact selection and preserved history

The selected parent is `c79b81bf002eaac95436da71c7049d7f309906a9`, tree `5595f99535a7cabcb0cfeda053f988fd7e17a590`, on the existing `feat/frontend-parity-20261112` branch of `agent-teams-ai/old-provider-implementations`. At the root read on 2026-11-16 12:54:39 UTC, PR8 is open, unmerged and Draft, with original base `d58500bc983e897506e23d7b0bc8da1209864edd`. All 260 existing leaves and the complete existing native-prompt-suggestions plan are preserved. The three intervening commits since the app's consumed9423 source remain intact.

Select exactly the existing implementation owner and existing test suite identified by the frozen proposal below. The owner becomes `c074fa2c2219eab448e1d1276dbab75f2d9ade2e` (16708 bytes, 298 lines, SHA256 `4fc5b7050b224c55070d81cc3f5eb0d355226bd5b20f4a8aabbf395c9a4f1a9e`). The complete test becomes `3dc7e46b70b9786ad4f26220611f0865c2ebf4fb` (38378 bytes, 786 lines, SHA256 `2ffb04cab741e0b936e56a930768f37b74cd35b119e8b1f62ec8763199956616`). The exact two-file patch is `8cdcccb37c6bf62cd4826c61af3a8896b04062dc` (4683 bytes, SHA256 `5b8e20ce0b8d5df1d21f39469c1bf285102c7f3ce27be550f33152620f89f7f7`).

The change records settlement of the original rejected fetch while separately preserving its explicit unknown-cleanup debt. It rethrows that same rejection object. It does not infer physical cleanup from Promise settlement. The unchanged final sibling join, bounded-await owner, stream cleanup, transport/admission checks and driver sticky-unknown state retain their own authority.

## Publication and exact resulting-source checks

This R1 and its two evidence files are the only documentation additions. The exact patch and independent source review are retained in `docs/plans/evidence/v2-settled-fetch-rejection-2026-11-16/`. Before publishing, independently verify all three full documentation bodies, the complete current leaf union and the exact prospective two-source-child union. Publish this documentation-only commit with an ordinary expected-c79 ref update immediately, fully read back every body and the recursive tree/ref, then obtain independent published-binding R2. Only that exact reviewed document commit may parent the separate two-file source commit; immediately ordinary-push and fully read back its bodies, source-only delta and complete tree/ref. A changed lease requires fresh review. Never force, rewrite history, create another PR, merge, publish a package/release or change Draft status.

The original c79 workflows were all terminal at the root read: ordinary CI and V2 native qualification succeeded; actual Claude/Codex suggestion workflows were skipped. This is old-source evidence only. Preserve useful original current-head work and do not dispatch, rerun or cancel Actions manually. Existing PR synchronization provides all project execution; no local install, compiler, lint, build, test, application import, provider or native execution is selected.

Require the unchanged original `pnpm check` on both Node24.21.0 and26.11.1 with pnpm11.18.0 and the frozen dependency graph, including every old source/package test and the two new cases. Preserve the original 53-job OpenCode V2 matrix and its explicit expected-negative controls. Retain full raw output and the exact successful Node24 checked-consumer archives/receipt for the resulting source commit. Setup errors, timeouts, cancellation and unrelated old successes do not count as this correction's qualification. The two table cases are reasoning-backed prospective regressions, not an executed RED/GREEN claim. No separate new CI workflow, selective replacement run or extra mandatory documentation-only qualification round is introduced.

Actual Claude/Codex executables, including discovery and version queries, remain forbidden. Both original native-suggestion workflows retain their Draft job guards. Finite TEST peers and permitted OpenCode with disposable local fixtures retain their existing scope. All workflow, package, lockfile, export and public API bytes remain unchanged.

## Consumer boundary

The app continues to consume exact9423 checked archives. The eventual archive also contains the three existing c79 commits, so its separate adoption review must cover the complete9423-to-resulting-source delta; it must not describe that whole package as only this six-line owner correction. After successful original producer qualification and independent actual-result review, any app adoption requires its own exact-head archive/receipt and atomic pin selection in the existing migration plan. Do not edit vendor dist or locally repack files. This producer correction does not select P11 C, advance the app primary ref, replace B Runtime/Team/types/lint, or close P08/P09, Windows readiness, M16, native Resume, Desktop, release/default activation or Stage2 obligations.

The full original Linux B failure remains INCOMPLETE: the first diagnostic and trace cap do not prove which later fetch/admission/cancel state caused failed cleanup. A concrete source invariant justified this correction, but its historical native cause and resulting successful close remain unproved.

## Frozen prospective design and source reasoning

The following complete proposal was prepared as inert data before root selection. Its earlier unselected and future-selection wording describes that preparation; only the exact bounded source selection and delivery order above supersede it.

---

# R1 proposal: preserve original V2 fetch settlement without losing cleanup debt

Status: INERT, unselected, source review only. No test, compiler, provider, workflow, Git ref, app package pin or archive was changed or executed for this candidate.

Proposed producer plan location: `docs/plans/2026-11-16-v2-settled-fetch-rejection.md`.

## Exact owner and delivery base

The consumer currently uses `agent-teams-ai/old-provider-implementations` source `9423f600dfb04d04448326dbced89919924b0b5f`, tree `a873a5f9ad8e6da1d8894db22a02d8c8efb37199`. Its checked implementation archive is 185996 bytes, SHA-256 `24040cc82613d8472bbead0643bd6eb1a8132227019a825bf0815af396c56267`; Session SPI archive is 6230 bytes, SHA-256 `0ea08bacd3f19a54c065cfaebbe8ae0fb3a8e6770886402f435a96e97867d2bc`.

Read-only inspection found existing Draft PR8 open on `feat/frontend-parity-20261112`, current head `c79b81bf002eaac95436da71c7049d7f309906a9`. It is three commits ahead of consumed9423. Those existing Claude/Codex suggestion changes remain intact; this candidate is not a replacement of that head with old source.

At both commits, the exact two relevant preimages are:

- Implementation owner `packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v2-native-cut.ts`: Git blob `177f850298c86902a33198d22e2c2020b56827a1`, 16526 bytes, 293 lines.
- Existing suite `packages/provider-implementations/tests/features/provider-session-implementation/opencode-protocol/v2-native-cut.test.ts`: Git blob `be55411efcb329191c3db8abf8a564dca54332fa`, 36411 bytes, 745 lines.

AGENTS, root/package scripts and all four original workflows were read at c79; their exact full contents and hashes are retained in the companion packet. A future source selection must refresh the current branch and preserve all intervening work. Root alone may perform normal CAS delivery after separate published R1/R2.

## Demonstrated source invariant

The current read owner sets `fetchPending=true` before the original fetch. It clears that flag only after the bounded response await succeeds. If the original fetch rejects, the flag remains true even though that original promise has settled.

The final session/log pair is joined with the existing sibling-abort mechanism. When the final session fails, it aborts the final log read. A log fetch that rejects on that signal can therefore be already settled when its catch runs, but the current `fetchPending && signal.aborted` branch manufactures `native_read_cleanup_unknown`. The existing final-pair priority then selects that synthetic unknown instead of the first original fixed session error. The native driver separately latches this unknown classification. No change to that driver latch is proposed.

This is an observable cut-error distinction supported by the actual owner and promise ordering. It is not proof that physical process or transport cleanup succeeded. Original wire disposal, admission ownership, body cleanup, driver confirmation and Host custody still make their own unchanged decisions.

## Why simply clearing pending is unsafe

The original log rejection can itself carry `native_read_cleanup_unknown` or the existing `ExecutionTransportFailure` cleanup-unknown code. During sibling abort, the wrapper Promise.race deadline rejection can win over the derived work rejection. Clearing only `fetchPending` would then let the wrapper hide genuine cleanup debt.

The selected source design must retain that distinction, using the same original promise and existing closed `unknownCleanup` classifier:

1. Add one local `fetchCleanupUnknown=false` flag.
2. In the second argument of the existing original-fetch `.then`, set pending false, record explicit unknown cleanup, and rethrow the same rejection object.
3. In the unchanged abort/deadline guard, test `fetchPending || fetchCleanupUnknown`.

The debt flag belongs to this one original fetch and is never cleared by wrapper finally/catch or by later physical cleanup. The success and late-response handler remains unchanged. Retaining the original abort/deadline condition also preserves the existing non-aborted fixed-error path and its identity.

Production delta: one existing owner, six added lines and one removed line. No new owner, API, dependency, stream, timer, retry, request, cancellation action, deadline, cache, helper framework or workflow operand. The owner is 298 lines after this delta.

## Existing-suite regression

Append two table cases within the existing `v2-native-cut.test.ts` suite before the unchanged late-response test. Reuse its existing finite localhost fixture.

Both cases allow the original before-session, before-log and two serial page reads. The final log is the original promise listening to its original cut signal; the final session rejects a single fixed `Error('invalid_native_read_response')`. Only the existing sibling failure aborts the pair.

- Ordinary settled rejection: the final log rejects a private TEST error when its actual signal is aborted. The public cut must reject with the exact first session Error object.
- Explicit unknown rejection: the final log instead rejects `native_read_cleanup_unknown` on the same signal. That unknown must still dominate the first ordinary failure even if the wrapper abort wins.

Both cases assert one original rejection, exactly six original fetch attempts, two session reads, two log reads, the actual final signal aborted, and exactly four HTTP requests at the existing finite server. There is no added model turn, command, timer or external provider. The test uses a locally retained non-null signal, with no shape cast or duplicate production type.

All old tests remain byte-preserved: truly pending fetch, late response reclamation, genuinely pending final sibling, pending body read, failed/pending cancellation, failed lock release, locked/missing reader, failed cancellation of a rejected response, media/binding/byte/chunk limits. The candidate test file is 786 lines, a 41-line insertion producing two cases.

Expected distinctions are source reasoning only: the current owner would reject the ordinary case with a synthetic unknown; a naive pending-only correction would fail the explicit-unknown case. No RED/GREEN result has been measured for these additions.

## Qualification and artifact boundaries

Use the existing producer PR8 route, retaining Draft state. The original `.github/workflows/ci.yml` already runs `pnpm check` on exact Node24.21.0 and26.11.1 with pnpm11.18.0 and frozen dependencies. Its existing source test glob includes this suite. The unchanged Node24 packed-consumer step retains the same exact two archives actually installed by the consumer tests and writes their original exact-head receipt.

The owner/test paths already select the unchanged 53-job `.github/workflows/native-v2-readonly.yml` matrix. No job selector, timeout, assertion, fixture, supported platform or qualification boundary is changed. The original Claude and Codex prompt-suggestion workflows have unchanged Draft-PR job guards at the inspected current head; retain those guards and Draft status. No new PR, ready-for-review change or manual workflow dispatch is proposed.

Before any source delivery, the separate R1/R2 must bind the complete current producer head and these exact bodies. All original required producer checks and native matrix remain required on the eventual source commit. No local project execution is authorized by this inert packet. No source-only result may stand in for original successful CI/packed receipts.

Future app adoption, if later authorized, must use only those original successful exact-head checked archive bytes and source receipts under its own atomic pin review. Never edit vendor dist or repack local candidate archives. The current app pins and receipts remain unchanged.

## Relationship to the current Linux failure

The full original B852 Linux receipt records an after-log transport_failure (841ms; observed abort=false, deadlineExpired=false), followed by driver-close/unconfirmed, runState=threw, outcome=unobserved and errorClass=held. The first-only diagnostic and earlier ordinary trace cap do not expose all later sibling/admission/cancellation states.

Those facts do not establish that this pending-flag branch caused the native failure, nor that this candidate repairs it. The old72 receipt has the same six recorded source/tool digests but a different first sibling and final closed error class. No cause is transferred between those runs.

Current Linux credentials and later management/product qualification remain HOLD. Separate native Host/model-probe/fixture passes do not discharge them. Darwin P09, packaged/P08, M16, Desktop and P11 C boundaries remain unchanged.
