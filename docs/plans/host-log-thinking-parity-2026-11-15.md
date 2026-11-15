# Host Logs thinking parity — bounded source plan

Status: R1 and independent root R2 reviewed; publish before source implementation. Base source is
`37baf6e4b7065fe1b730c928db0d9c54809f7fc5` on
`feat/frontend-parity-20261112` ([Draft PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8)).
Preserve its existing prompt-suggestion work and all prior changes. The consuming
app currently pins source `421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0`.

## Evidence and scope

The app's frozen frontend baseline `4a0e062` renders Claude thinking blocks and
OpenCode V1 reasoning as Thinking rows. Its
`src/main/services/team/taskLogs/stream/OpenCodeRuntimeProjectionMapper.ts` and
the OpenCode transcript fixture in
`src/features/member-log-stream/main/adapters/output/sources/__tests__/memberLogSources.test.ts`
establish V1 parity. Current Claude `Normalizer.partial` accepts only
`text_delta`; `Normalizer.assistant` accepts text and tool-use blocks. Current
V1 transcript projection already recognizes native `reasoning` parts, while
`v1-driver-output.ts` emits only text parts. The Session SPI cannot represent
thinking. These are the bounded source omissions to fix.

No prior Codex or OpenCode V2 Thinking frontend guarantee has been established;
their adapters are outside this change. No raw transcript API, new framework,
new provider capability, SDK upgrade, process policy, checkpoint format, model
call, default activation or package publication is included.

## Contract and implementation

Add a separate `EventPayload` union member with the same identity and snapshot
semantics as text:

```ts
{ readonly kind: 'thinking'; readonly messageRef: string;
  readonly block: number; readonly text: string;
  readonly phase: 'snapshot' | 'complete' }
```

Keep `text` a separate discriminated member so existing
`Extract<EventPayload, { kind: 'text' }>` consumers retain their type. Keep package
names, public exports, existing event shapes and caller-owned authority intact.
Consumers must add the new discriminant to their exhaustive decoders before the
new immutable package pair is admitted. This is an additive SPI variant, not a
claim that an old exhaustive consumer already understands it.

1. In Claude's existing normalizer, seed native `thinking` blocks and append
   `thinking_delta.thinking` strings. Emit accumulated snapshots and final
   `thinking` blocks with their actual message ID and native block index.
   Isolate text/thinking accumulation keys; keep wrapper UUID deduplication,
   fragmented assistant block indices, reset behavior and event order. Ignore
   signature deltas, signatures, redacted blocks and malformed non-string
   payloads. Do not derive thoughts from text or request hidden reasoning.
2. In the existing V1 driver output mapper, map native `reasoning` parts to
   `thinking`. Retain actual message identity and raw part index. Deduplicate
   unchanged snapshots per message, part and kind; emit the existing terminal
   phase transition even when the string is unchanged. Keep exact native cut,
   lineage, turn ordering and tool/result logic unchanged.
3. Reuse the existing Session and child-observation paths. They already apply
   session/input/operation ownership, output event/UTF-8 byte limits and native
   child provenance. Thinking must not enter the parent's normalizer when its
   native owner is a child. No new authority, replay or fallback path is added.

Do not fabricate stdout/stderr provenance. SDK iterator and HTTP transcript
events do not establish a process stream. The baseline stream filter includes
unmarked transcript rows under either stream selection; absence remains absent.
No stream field or synthetic Claude JSON is needed for these source facts.

## Finite file budget

Three production files, approximately 20–45 added/changed lines:

- `packages/provider-session-contracts/src/features/provider-session-contracts/contracts/session.ts`
- `packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/normalize.ts`
- `packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v1-driver-output.ts`

Seven existing test/fixture files, approximately 120–220 added/changed lines:

- `packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/normalize.test.ts`
- `packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/factory.test.ts`
- `packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/subagents.test.ts`
- `packages/provider-implementations/tests/features/provider-session-implementation/opencode-protocol/v1-driver.test.ts`
- `packages/provider-implementations/tests/features/provider-session-implementation/opencode-protocol/v1-driver-peer.ts`
- `packages/provider-implementations/tests/package/packed-consumer.test.ts`
- `packages/provider-session-contracts/tests/package/packed-consumer.test.ts`

This plan is the only new file. Estimates are review aids; a new production
module, other adapter or workflow change requires a concrete scope review.

## Required controlled proofs

- Claude native-shaped thinking deltas and final blocks preserve message/block
  identity and mixed thinking/text/tool order. Repeated wrapper UUIDs produce no
  duplicate final facts. Signature/redacted/malformed input produces no thinking
  text. Reset and UTF-8 output-limit behavior remain bounded.
- The existing controlled factory retains session/input/operation ownership on
  thinking events and ordinary terminal behavior. The existing subagent fixture
  sends thinking only through its authorized child observation, with no parent
  leak; existing child limits and refusal paths remain exercised.
- The disposable V1 localhost peer supplies actual-shaped reasoning before text
  and tool parts. Assert native indices, input/operation ownership, changed
  snapshots, no unchanged-snapshot duplicates and the final complete event.
  Keep existing foreign session/parent, uncertainty, cancellation and no-replay
  assertions unchanged.
- Both packed-consumer tests compile the new distinct variant and narrow it from
  the exact installed Session SPI archive. The implementation consumer must keep
  the existing two-archive installation and runtime exercises. Source tests do
  not substitute for packed-consumer qualification.

No tests use credentials or start real Claude/Codex providers. Existing normal
`pnpm check` remains the full source/build/type/packed-consumer gate.

## Delivery and workflow safety

The intended review topology is one bounded dependent Draft PR based on current
PR #8's `feat/frontend-parity-20261112` branch, not a second app migration branch.
Do not push this work onto PR #8 directly: PR path filters inspect its cumulative
base diff, which already contains the native Claude suggestion script/workflow.

**A child PR alone is insufficient under the current no-real-Claude/Codex
constraint.** At the exact base above,
`.github/workflows/native-prompt-suggestions.yml` also selects
`packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/**`
and executes the official Codex 0.166.0 App Server with locally scripted
inference. Neither native suggestion workflow exempts Draft PRs. The child PR
would avoid the Claude trigger but would still trigger native Codex.

Publish only the reviewable provider branch and keep child PR creation on HOLD.
Continue the finite implementation and controlled local checks. Do not change
workflow paths, skip checks, use skip directives, relocate source to evade
paths, or change gates. Current workflows have no `push` trigger. Recheck
workflow/source head before any remote action.

The concrete external qualification prerequisite is an authorized route to run
the existing `ci.yml` and required allowed OpenCode workflow on the exact source
head without triggering the forbidden native suggestion workflows. Both expose
`workflow_dispatch`, but the current connector has no dispatch operation, local
`gh` has no authentication, and browser dispatch lacks its required originating
context. Do not claim those runs were dispatched or require credentials to
continue local work. Full pinned CI and the resulting checked archives remain
unqualified until that route is available. A missing run is not a PASS. This
does not authorize a merge or production admission.

## Exact artifact qualification

Use pnpm **11.18.0**, Node **24.21.0** and **26.11.1** as pinned by CI. The local
24.21.0 binary can run affected controlled tests where dependencies permit;
uncached pnpm 11.18.0 must not be silently replaced with a different version.
The existing app TypeScript 7.0.2 compiler and already available dependencies
may provide a scoped type check only; they do not substitute for the provider's
pinned full gate or create qualified package archives.
Require full existing `pnpm check` success on both CI Node versions. Because the
shared Session SPI changes, retain the existing OpenCode V2 native workflow's
qualification requirement even though V2 output behavior is unchanged; do not
weaken its paths or matrix.

From the successful exact-head Node 24.21.0 CI job, obtain
`opencode-v2-spi-consumer-checked-<sourceCommit>`. It must contain the same two
archives installed by the packed-consumer test, plus `receipt.json`. Verify run
repository/head/job success; receipt schema, exact source commit, exactly one
implementation archive and one contract archive; and each archive's size and
SHA-256. Preserve the receipt's `source-and-packed-consumer-only` qualification
and false native-Host/packaged-Electron flags. Do not repack, substitute a local
build, edit vendor dist or publish a registry package.

Only those checked immutable bytes may update the app's existing provider pins
and locked package graph, together with its finite Host/frontend Thinking
changes. The app must separately qualify its exact codec, activity storage,
strict read/DTO projection and Logs rendering/search/filter/snapshot behavior.
Source CI and OpenCode native receipts do not claim app Host process custody,
native Claude/Codex or packaged Electron qualification.

## Review record

R1 `/root/p09_review` traced the frozen frontend, consumed source, current source
and workflow triggers. R2 `/root` inspected the three production owners, existing
normalizer tests, pinned CI and all workflow event declarations on 15 November
2026. GO for the finite source change and controlled fixtures after this plan is
published. Wrapper deduplication, native indices, kind-separated accumulation and
the child observation boundary must remain explicit in tests. No `push` workflow
exists at the inspected base; keep PR creation and checked artifact adoption on
HOLD until an authorized qualification route is available. This review is not a
source/test PASS and does not waive `pnpm check` or either packed-consumer test.
