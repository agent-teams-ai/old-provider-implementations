# Native next-prompt suggestions: isolated provider feature plan

Status: **design only, not implemented**  
Date: 2026-11-14  
Owning repository: [agent-teams-ai/old-provider-implementations](https://github.com/agent-teams-ai/old-provider-implementations)  
Target base: **bootstrap** at d58500bc983e897506e23d7b0bc8da1209864edd  
Delivery rule: separate Draft PR, no merge, no package release, no activation without the gates below.

## 0. Decision in one page

Build **one opt-in, feature-owned native prompt-suggestion capability** in the independent provider implementations package. The feature returns bounded, untrusted **candidate next user messages** from the **currently owned native session**. It never sends a user message, creates a product task, or owns conversation authority.

- Claude: opt in to the pinned Claude Agent SDK's native push event, using the **existing session and Query stream**. A result arrives first; the subsequent prompt_suggestion must remain observable. No new Claude query, additional child, or manually synthesized history.
- Codex: an explicit, bounded **thread/sample** request against an **existing persistent root thread** of the **same captured App Server client**, using the exact completed native turn ID. The request is experimental. Do not simulate it with turn/start or spawn a second ordinary Codex thread. Return unsupported on incompatible versions/capabilities.
- Host: owns the decision whether the completed input belongs to an active **human-to-teammate direct conversation**, its session/generation/tenant/project/lane identity, authorization, request admission, budgets, lifecycle and cancellations.
- Frontend: uses the **existing composer**, not a new chat surface. Tab inserts the candidate only into an empty draft; Escape dismisses; there is no auto-send.

**Phase 1 acceptance uses no vendor subscriptions.** Run actual built packages, Session SPI, Host and optionally native binaries, but route model inference into disposable scripted localhost fixtures. Publish the level of evidence honestly: protocol emulator != native binary != authenticated vendor inference.

## 1. Repositories, verified seams and migration context

| Source | Current fact and consequence |
| --- | --- |
| [Provider extraction PR #1](https://github.com/agent-teams-ai/old-provider-implementations/pull/1) | Extracted two independent packages, with the runtime engine and owner policy deliberately absent. Source-only delivery into bootstrap. |
| [Provider README](../../README.md) and [AGENTS.md](../../AGENTS.md) | Consumers own native process custody, configuration, durable intent/checkpoints, tools and credentials. CI must use disposable fixtures. Node 24.21.0 or 26.11.1 and pnpm 11.18.0. |
| [Provider implementation feature](../../packages/provider-implementations/src/features/provider-session-implementation/README.md) | One existing feature owns Claude SDK, Codex App Server and OpenCode protocol adapters. Its bounded feed primitives and session IO are not a new scheduler or business owner. |
| [Session SPI](../../packages/provider-session-contracts/src/features/provider-session-contracts/contracts/session.ts) | Canonical provider-neutral interactive contracts already have sessionRef, operationRef, inputId, terminal result, close receipts and generation. Preserve the **14 existing public driver types**. |
| [Frontend Stage 1 PR #982](https://github.com/777genius/agent-teams-ai/pull/982) and [plan](https://github.com/777genius/agent-teams-ai/blob/feat/provider-migration-stage-1/docs/plans/provider-migration/stage-1-legacy-host.md) | Real Desktop UI and packages/legacy-agent-host consume the extracted library. Stage 1 is synthetic candidate qualification; no Stage 2/new runtime rewrite or main cutover. |
| [Frontend parity PR #1186](https://github.com/777genius/agent-teams-ai/pull/1186) | Dependent parity work is in progress; do not modify it or treat its still-pending E2E as complete. |
| [Provider PR #8](https://github.com/agent-teams-ai/old-provider-implementations/pull/8) | Draft Codex account/login changes touch the same native client. Do not base this feature on the draft or overwrite its modifications. Rebase/review overlap before implementation. |
| [Agent Runtime donor PR #242](https://github.com/agent-teams-ai/agent-runtime/pull/242) | Historical donor for the extraction, stays Draft; never merge it to implement this feature. |
| [T3 Code Claude adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts) | Uses SDK promptSuggestions and captures prompt_suggestion **after result**. Useful provider proof, not architecture to copy wholesale. |
| [T3 Code Codex adapter](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) | Requests thread/sample on completed native turn and emits a common event. |
| [OpenAI thread/sample protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs) and [implementation](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/thread_sample.rs) | Requires source thread and exact expectedTurnId, runs an ephemeral fork, rejects invalid/in-progress/changed source cases and returns text or null. It is not a general completion endpoint. |

### Concrete verified code seams

- Claude pinned dependency: **@anthropic-ai/claude-agent-sdk 0.3.305** in pnpm-workspace.yaml. Existing ClaudeSession constructs the long-running SDK Query from a Host-provided spawn callback. The config currently enumerates allowed SDK options, and its normalizer processes result frames. Add a narrow opt-in and native event tap; do not pass arbitrary SDK options.
- Codex App Server client: packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/app-server.ts. The existing client owns initialized JSON-RPC transport and a map of bound CodexThreadSession instances. Reuse its request framing, AbortSignal and beforeWrite admission checks.
- Existing CodexDriverSession opens one start/resume thread, serializes input, correlates turn IDs and keeps custody outside the provider library. Sampling must run **only on this bound client and matching completed turn**, without modifying the normal submit path.
- Current Stage 1 Host proof selected **Codex protocol/CLI 0.162.0**. T3 documentation requires **Codex >=0.165** for prompt suggestions. Therefore current Host pin is **not qualified** for thread/sample; compatibility/upgrade is its own explicit gate, not an implicit dependency bump.
- Current public package entrypoints are ./claude, ./codex, ./opencode, ./session-io and ./composition. Add one deliberate opt-in ./prompt-suggestions export. The root import must stay inert and types-only. Existing imports, signatures and packed consumers remain compatible.

## 2. Exact scope

### Included

1. One **provider-side feature slice** with source validation and two native adapters (Claude push / Codex sample), plus focused tests and curated exports.
2. Minimal **additive** hooks in the existing Claude/Codex implementation adapters to observe their **owned** native sessions. Preserve existing Session SPI, normal event mapping and cancellation.
3. A small **optional Host-facing candidate port** that is not a runtime engine: invocation/callback is always driven by the consumer's explicit configuration. No import side effects.
4. An integration specification and follow-up worklist for legacy-agent-host + existing Desktop composer, ensuring the capability can later be adopted without frontend rewrite.
5. Phase 1 no-subscription emulator/source-protocol tests, packed external consumer, and selected Host/real Desktop fixture journey. Native binary/localhost lane when supported and explicitly recorded.

### Excluded

- OpenCode, Gemini or arbitrary provider fallback; generic model-completion service; custom RAG/embeddings.
- AI inline completion while typing, multi-option ranking, persistent history of predictions or team-level automated coaching.
- New service, broker, background worker, database, schedule, durable event log, second session SPI, or universal provider router.
- Product ownership moved to the provider package: **no team/DM/ACL, storage, auth, budgets, tool authority, process supervision, checkout management**.
- Editing/merging Stage 1 #982, parity #1186 or donor #242 as part of this **plan** PR; Stage 2/new agent-runtime integration and main/default release changes.
- Real Claude/Codex subscription, vendor auth/inference, billing verification or broad five-platform qualification in Phase 1.
- Auto-send, auto-accept, prompt injection of suggestion into native history or launch of an independent ordinary provider turn to approximate sampling.

## 3. Placement: feature-owned, no empty architecture layers

Proposed **implementation**, not scaffolding to create in this plan-only PR:

~~~text
packages/provider-implementations/
  src/
    features/
      native-prompt-suggestions/
        README.md                   # feature owner, boundaries, dependency direction
        contracts/
          candidate.ts              # narrow provider-level candidate and failure unions
        core/
          candidate-policy.ts       # pure shape/length/source identity validation
        adapters/
          claude-sdk.ts             # interpret native SDK event, never own Query
          codex-sample.ts           # typed thread/sample, never own Codex process
        composition.ts              # opt-in binding of Host-owned native handles
        index.ts                    # feature-private public surface
  src/
    prompt-suggestions.ts           # curated external entrypoint
  tests/
    features/
      native-prompt-suggestions/
        candidate-policy.test.ts
        claude-sdk.test.ts
        codex-sample.test.ts
        protocol-subprocess.test.ts
    package/
      prompt-suggestions-packed.test.ts
  package.json                      # one additive ./prompt-suggestions export
~~~

**Do not** add empty core/application, main/preload/renderer folders inside the library. It is a technical provider library, not the Electron application. Its one pure core policy is useful; native interaction lives in adapters. If small source changes inside the existing session implementation are needed, keep them in that existing feature, injecting the new source tap as an **optional** port. No reverse dependency from core to SDK or from the provider package to Host.

The legacy Desktop Host separately retains its existing process/domain layout in packages/legacy-agent-host. The existing UI's feature-first boundary remains in the app, not imported into the library.

## 4. Ownership and contract

### Provider-facing wire candidate

~~~ts
type NativeSuggestionCandidate = Readonly<{
  provider: 'claude' | 'codex';
  sessionRef: string;       // from the captured Session instance, not client input
  operationRef: string;     // from the settled existing SPI input
  nativeSessionRef: string; // opaque; never exposed to renderer unfiltered
  nativeTurnRef?: string;   // required for Codex; Claude SDK push is correlated locally
  text: string;             // untrusted candidate, not a user message
}>;
type NativeSuggestionResult =
  | { readonly kind: 'candidate'; readonly value: NativeSuggestionCandidate }
  | { readonly kind: 'none' }
  | { readonly kind: 'unsupported' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed'; readonly retryable: false };
~~~

Names are illustrative, not a decision to extend the canonical 14-type Session SPI. Use an **optional per-open capability binding/sink** in the concrete driver factory; the Host can choose whether to enable it for a captured session. It must not force the feature on consumers that do not opt in. Prefer one callback on the existing caller-owned configuration to a second lifecycle object or global singleton.

Only **provider-level** identity is carried here. Host wraps this in its own immutable tenantId/projectId/sessionId/generation, team incarnation, lane, member and authorized DM/conversation ref; **never ask this library to resolve or derive those product identities**. Candidate is transported as ephemeral information, never appended to durable messages or provider transcript.

### Host acceptance predicate (consumer-owned)

A suggestion may be shown **only if all are true at read/publish time**:

- The viewer is authorized to read the selected human-to-one-teammate direct conversation.
- The consumer explicitly enabled suggestions for this captured session.
- The specific operationRef belonged to a **human-authored direct input**, not a tool, agent-to-agent message, group, bootstrap, task or scheduled action.
- SPI result was succeeded; an exact native source turn terminal is confirmed.
- The original session, generation, member/lane and conversation remain current; no subsequent accepted user input, start, restart, rewind, clear, or session switch supersedes it.
- The composer is empty and editable, without active IME, attachments/chips, slash/mention menu, queued draft, approval input or other keyboard owner.
- The candidate is nonempty, bounded, not dismissed for that operation and generated inside the current revision.

On uncertainty, **hide**, not cross-fallback to another provider or guessed conversation. Renderer must recheck at display and acceptance, not only when the event arrived.

## 5. Claude SDK: exact lifecycle

1. During the **existing** openClaudeSession/open Query composition, Host opts in to promptSuggestions only for an eligible human-facing session. Capture flag immutably with the session; changes take effect at the next safe session open/restart. Preserve custody.launch, env restrictions, settings and config compatibility.
2. Continue consuming the same AsyncIterable **past the SDK result**. Native prompt_suggestion arrives asynchronously after result; processing result must not terminate the stream or close the Query prematurely.
3. Existing ClaudeSession tracks active/settled input and operationRef. On terminal success, retain a **single fenced settled slot** (session instance + operationRef + monotonic turn generation). On new admitted input, close, abort, restore mismatch or turn failure, clear it synchronously.
4. Validate SDK message type, nonempty bounded suggestion, native session_id and current slot. Route a candidate through the optional feature sink; do not reinterpret it as ordinary SPI result/text and do not expose as a durable event.
5. Ignore duplicate/late frames, suppression, errors, plan mode and lack of event. No separate inference fallback. Check the exact pinned SDK 0.3.305 for observed message shape, not just a newer SDK's docs.

**Potential seam requiring investigation in implementation:** ClaudeSession.read/inputs race near a new queued input. A source event may arrive after a new input advances. The completed slot must be invalidated on actual **new input admission**, not merely when a message is typed in UI. Host generation check provides a second guard.

## 6. Codex App Server: exact lifecycle

1. On the **same initialized CodexAppServerClient**, after a successful completed native turn, capture exact source threadId, native turnId, operationRef and ownership from the bound CodexThreadSession. Do not query another process or another account's CODEX_HOME.
2. Verify selected binary/protocol capability, persistent **root** thread, idle state and no new accepted input. **0.162.0 is unsupported until upgraded and separately qualified**; version alone is not proof if experimentalApi/method authorization is unavailable.
3. Issue **one** typed JSON-RPC request:

~~~json
{
  "method": "thread/sample",
  "params": {
    "threadId": "captured-native-thread",
    "expectedTurnId": "captured-completed-turn",
    "prompt": "Predict the next message the user is likely to send. Reply only with that message in under 20 words. Do not use tools. If there is no clear next step, reply with nothing.",
    "effort": "low"
  }
}
~~~

4. Decode the *actual* response: sourceTurnId equals the captured turn, text is string or null, and the source thread is still current. Treat null/empty/whitespace as none. Bound text and validation **before** handing a candidate to Host. A tool-call attempt, rate limit, request timeout, method-not-found, cancel, source changed or foreign turn must not surface user text.
5. Use existing RPC framing, limits and beforeWrite fence. On new input/cancel/disposal, cancel the sample through the supported protocol path if available; no turn/interrupt of the parent and **never retry after uncertain request admission**. Timeouts/unknown transport lead to discard, not replay.
6. The sample is an ephemeral fork; source history/checkpoint, native thread/turn counts and tool effects must remain unchanged. The provider library does not own physical process custody and does not infer that RPC close means child exit.

**Compatibility gate:** Confirm exact minimum supported Codex version and experimentalApi initialization against the selected real binary before enabling; verify existence of thread/sample rather than accepting a method from type definitions alone. If the current selected binary lacks it, report unsupported and leave core chat unaffected. No behind-the-scenes upgrade in the feature.

## 7. State, limits and security

- No DB. Host keeps a single **latest in-memory candidate per active conversation** and a bounded dismissal key per (session generation, operationRef). A cold restart drops suggestions; this is correct, not data loss. Provider library stores at most one in-flight sample/settled slot per native session.
- One extra inference request per **eligible completed human turn**, never per internal task or every assistant streaming event. Default **off** until explicit user-facing opt-in. Host uses its existing budget and concurrency policy; no provider-side global quota engine. Abort or suppress on high workload.
- Bound inputs/output (proposal: max 512 UTF-8 bytes displayed, max 4 KiB native sampler instruction, maximum 1 candidate, per-request deadline no longer than current native RPC limit; constants reviewed against UX). Truncate? **Reject** over-limit native suggestions, do not silently truncate or split UTF-8.
- Candidate text is **untrusted model output**. Render as text, not HTML/Markdown with active links; never execute tools, commands or shell fragments. Acceptance inserts editable text only; user must separately send.
- Do not log raw suggestion, native conversation, credentials, paths or provider response bodies in default telemetry. Allowed metrics: feature enabled/disabled, supported/unsupported, produced/suppressed/stale, latency bucket and sanitized failure category.
- Do not access ambient HOME, user accounts or network outside the captured disposable fixture; native processes must use Host-selected environment, profile, tool policy and existing custody.
- Failed cleanup stays unknown. A missing event is **none**, not an application error or permission bypass. Do not loosen existing protocol denial or checkpoint validation for this feature.

## 8. Consumer adoption: bounded, separate PRs

**Not part of this plan-only PR.** After provider library qualification:

- **Host slice** on Desktop Stage 1 branch packages/legacy-agent-host: opt-in flag in captured open config, native terminal binding, identity/authorization/eligibility gate, single ephemeral candidate read/subscribe through existing Host transport. No new host supervisor or parallel Session SPI. Preserve status/accepted/UNKNOWN semantics for normal user inputs.
- **Browser-safe transport** in existing app feature architecture: one DTO/request+event or existing subscription extension; IPC and HTTP both call the same Host use case. No direct provider SDK in renderer.
- **Existing composer** MessageComposer → MessageComposerInput → MentionableTextarea: add a tiny presentation hook and ghost suggestion, no new editor/chat system; Tab accepts when empty and no mention/slash/IME control, Escape dismisses, mouse/touch has explicit accessible action. Keep @, #, /, chips, attachments, queue and revision input behavior unchanged.
- **No alternate UI** for Create, Launch, Resume, messages, review or team tasks. Product owner must provide the exact conversation-to-native-operation mapping before the feature can show a suggestion; no guessed role from the last displayed bubble.
- Future **new agent-runtime / orchestrator** may adopt the provider package through its published typed adapter. There is no back-import, migration to new engine, or future domain authority in this feature.

## 9. Phase 1 test architecture: no real subscriptions

All cases run under TEST HOME / TEMP, isolated config/profile/worktree, generated credentials **not** copied from the user, localhost-only scripted model endpoint, deterministic clocks and captured child PIDs. Test runner must prove cleanup of only its own resources.

### Tier A: pure and protocol fixture tests (mandatory)

| Case | Fixture signal | Mandatory assertion |
| --- | --- | --- |
| Claude happy path | SDK Query async iterator emits assistant, successful result, delayed prompt_suggestion | One correct operationRef candidate, after result, no second query/input |
| Claude suppressions | First turn, plan mode, API error, no cache params, absent suggestion | Zero candidates, unaffected normal result |
| Claude stale | New input admitted before delayed suggestion; session generation changed | No candidate from previous operation |
| Claude shutdown | Abort/close before event; duplicate or foreign session ID | No leaked callback or stale candidate; cleanup receipt preserved |
| Codex happy path | Real JSON-RPC frames: initialize, thread/start or resume, turn/start/completed, then thread/sample | One request with exact threadId/expectedTurnId, sourceTurnId match, normal parent untouched |
| Codex non-support | Simulate 0.162, method-not-found, experimental disabled | Explicit unsupported, no fallback turn/start |
| Codex invalid result | null/empty, overlong text, wrong sourceTurnId, unexpected frame, tool attempt | None/stale/refusal; never forwarded |
| Codex race | next turn starts before write, during write, after sample response; cancel/timeout | No stale display, no retry, no parent interrupt |
| Isolation | Two sessions + two projects/tenants, same member names, different generations | No cross-delivery, no ambient-home reads |
| Backpressure | Burst many terminal/streaming events, older candidate pending | Max one in-flight per native session; bounded memory and event order |
| Legacy compatibility | Suggestions disabled, existing SPI and 2 packed consumers | Identical normal turns and public types/exports |

Use current SDK QueryFactory fixture and CodexAppServerTransport/subprocess fixture, not made-up methods. Assert native JSON-RPC request/notification IDs, exact startup, body, turn and cleanup. Negative cases must be **executed assertions**, not skipped tests.

### Tier B: native local binary with scripted model endpoint (required gate for native claim)

- Run the **selected native Claude SDK 0.3.305** with Host-injected spawn/config and a fresh local scripted inference backend only if the SDK/binary supports it without vendor credentials. If it cannot be safely isolated, retain Tier A proof and mark this native claim HOLD.
- Run **actual Codex App Server >=0.165** with experimental API and TEST CODEX_HOME, a **persistent root thread**, two completed turns against scripted localhost inference, followed by thread/sample using the exact turn. Verify request semantics, source UUID, fork isolation, absence of tool calls/source mutation, token counters and normal close/cleanup. If local model emulation is unsupported, mark native sampling HOLD; do not disguise a fake JSON-RPC server as native.
- No real vendor credentials, subscription login, external inference, global config mutation or unbounded retries. Capture binary SHA/version, OS/arch, fixture hashes, request counts, exact passed/failed/skipped/held cases, timestamps and PIDs. Keep secrets and raw prompts out of uploaded artifacts.

### Tier C: Stage 1 Host + actual existing Desktop UI (after provider package adoption)

1. Two real TEST teammates, Claude and Codex, each receives a **human direct input** through existing composer, not a test-only endpoint. Fixture inference completes; only the recipient gets its suggestion.
2. One host restart/Resume/new generation: restored session is correct and old suggestion disappears. Reopening with new source does not resurrect a prior candidate.
3. Active queue, group/team/task/tool/background message: no suggestion for agent-origin work. An extra completed internal turn cannot become the user's proposed next prompt.
4. While suggestion visible, type/paste, open @ or / menu, IME composition, Tab/Shift-Tab, Escape, change recipient/team/selected conversation. Existing key priority wins; no auto-send, no mutation of saved draft or attachments.
5. Verify Electron IPC and HTTP/browser adapter parity via same use case, not by calling provider from renderer. The actual DOM/CSS placement is checked visually; API-only tests cannot substitute for the UI gate.
6. Process cleanup: native provider children and Host stop, no orphan processes or leaked ports; UNKNOWN custody must not be represented as confirmed exit.

Use the program's existing candidate-synthetic runner and Source/Host test workflow, extending **one affected journey**. Do not create a parallel E2E framework or start the old Claude fork.

### Commands / exact gates

For provider repo, under Node 24.21.0 **and** 26.11.1, pnpm 11.18.0:

~~~sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
~~~

Required: build, TS 7.0.2 typecheck, feature protocol tests, both packed external-consumer checks, no new lints/exports drift. In implementation commits, run exact-head CI and existing affected native workflow. For the later Desktop adoption, use existing Source / Stage 1 Host / Electron fixture qualification and pin the exact consumed provider artifact SHA, with evidence for its real tested tree. **queued, skipped and fixture-only results are not vendor/native E2E successes.**

## 10. Implementation steps, estimated scope and merge discipline

| Step | Change owner | Estimated meaningful code LOC | Gate |
| --- | --- | ---: | --- |
| P0 feasibility | provider feature tests, pinned SDK/Codex schema probe only | 120-220 | Claude push + Codex version method support evidenced; unsupported accepted explicitly |
| P1 provider feature | packages/provider-implementations/src/features/native-prompt-suggestions | 240-420 | pure validation + supported contracts |
| P2 native taps | existing Claude/Codex adapter seams only, no SPI shape change | 180-350 | races, closed/UNKNOWN, exact session/turn verified |
| P3 isolated tests | existing tests/features and packed consumer tests | 350-650 | Tier A and Tier B; strict evidence labels |
| P4 separate Host adoption | packages/legacy-agent-host on Stage 1 branch | 180-350 | exact product ownership and generation identity |
| P5 separate renderer adoption | existing app feature + composer | 120-250 | UI keyboard/IME/empty draft and Tier C |
| **Total future work** | provider and later consumers | **1,190-2,240** | rough, not a build budget or delivered LOC |

No implementation file is part of this plan PR. Each **future** PR starts Draft; commit and push immediately, check reviewed diff, run only affected qualification, repair findings, then normal human/CI merge rules. Do not merge into bootstrap until exact-head code/package tests and review pass; never publish packages or release/default-switch as part of these source changes.

## 11. Explicit acceptance / stop conditions

The feature is **implemented** only when all selected gates pass, not when the planning doc merges:

- [ ] Native Claude suggestion from the **same owned SDK Query**, after successful terminal.
- [ ] Native Codex sampling on a **compatible exact bound root thread** with exact expectedTurnId, without changing source history.
- [ ] Old 0.162 Codex path correctly reports unsupported, without mutation or hidden upgrade.
- [ ] No extra ordinary model turn; no agent/tool action from sampling; no accidental replay after UNKNOWN.
- [ ] Exact ownership for human DM, no cross-team/project/member/session leakage; lifecycle and cancellations proven.
- [ ] Provider package/Session SPI exports remain compatible, packed consumers pass.
- [ ] Selected Host + Desktop existing composer journey and cold readback pass, including keyboard/IME.
- [ ] No vendor credentials used in Phase 1; TEST/native/vendor evidence levels recorded separately.
- [ ] Multiple source/security/UX review rounds, exact-head CI, no unresolved blocking findings.

A failed feasibility gate produces a documented **unsupported/HOLD** path; it must not trigger a redesign of all provider transports. Never claim feature-complete if native Codex sampling or Host ownership evidence is missing.

## 12. Review record for this design

This section records **design-only self-review**, not independent code-review approval. Three focused review passes are required before finalizing this document:

1. **Ownership and clean boundaries:** inspect no engine/domain import into provider package, no duplicate Session SPI, no new task authority.
2. **Native protocol and state safety:** inspect Claude after-result delivery, exact Codex root/turn/version, races, cancellation, no retry/parent mutation.
3. **E2E and scope:** ensure tests really execute native integrations where claimed, no subscriptions/real HOME, no silent skips, no alternate UI, realistic LOC and migration conflict isolation.

Final corrections and explicit unresolved implementation-time gates must be recorded here after review.

## 13. Primary references

- Current SDK option API: https://github.com/anthropics/claude-agent-sdk-typescript
- T3 actual UX: https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
- T3 regression on steered run: https://github.com/pingdotgg/t3code/issues/33705 and https://github.com/pingdotgg/t3code/pull/33706
- Codex protocol schema and implementation: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs and https://github.com/openai/codex/blob/main/codex-rs/app-server/src/thread_sample.rs
- Provider extraction and governance: https://github.com/agent-teams-ai/old-provider-implementations/pull/1, https://github.com/agent-teams-ai/agent-runtime/pull/242
- Desktop Host migration: https://github.com/777genius/agent-teams-ai/pull/982 and parity work https://github.com/777genius/agent-teams-ai/pull/1186
