# Native next-prompt suggestions: isolated provider feature plan

Status: **design only, not implemented**  
Date: 2026-11-14  
Owning repository: [agent-teams-ai/old-provider-implementations](https://github.com/agent-teams-ai/old-provider-implementations)  
Target base: **bootstrap** at d58500bc983e897506e23d7b0bc8da1209864edd  
Delivery rule: separate Draft PR, no merge, no package release, no activation without the gates below.

## 0. Decision in one page

Build **one opt-in, feature-owned native prompt-suggestion capability** in the independent provider implementations package. The feature returns bounded, untrusted **candidate next user messages** from the **currently owned native session**. It never sends a user message, creates a product task, or owns conversation authority.

- Claude: opt in to the pinned Claude Agent SDK's native push event, using the **existing session and Query stream**. A result arrives first; the subsequent prompt_suggestion must remain observable. No new Claude query, additional child, or manually synthesized history. **The SDK switch is session-scoped, not one-request-per-human-turn:** if the user opts in, make the capability available to **every Claude teammate session**; Host alone filters what reaches a human chat. Do not restrict to special roles or direct-only native sessions. Document and test that SDK may spend extra tokens after internal turns in mixed sessions.
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

### SOLID / Clean Architecture / DRY enforcement

| Principle | Enforceable decision | Regression evidence |
| --- | --- | --- |
| Single responsibility | Native provider tap only captures a candidate; Host alone decides authorization, eligibility, budgets and current conversation. | Provider code imports no Host, UI, task, ACL or DB module; consumer is the only publisher to UI. |
| Open/closed | The feature is opt-in through a **separate** curated package export. Existing Claude, Codex and OpenCode driver behavior is unchanged when not wired. | Disabled/legacy packed consumer, SDK startup and original Session SPI tests pass. |
| Liskov substitution | Do **not** add a mandatory method to the Session interface or claim all providers implement sampling. | Original fourteen SPI types are byte-compatible at exported type surface; OpenCode remains unaffected. |
| Interface segregation | Two narrow sources: an injected callback for Claude SDK push and a typed one-shot sampling request for Codex App Server. | Tests use each source independently; no optional-method-rich universal manager. |
| Dependency inversion | Source adapters depend on small feature-owned contracts and **consumer-provided** captured native handles, not concrete Host/runtime classes. | Static import checks and packed external consumer with no runtime engine. |
| DRY | Candidate validation/terminal-freshness shape is shared exactly once. **Do not** unify unlike native transports or duplicate existing RPC queues, output feed and cancellation. | One pure validator with two adapter fixture suites; existing RPC and stream regressions remain green. |

**Minimal composition rule:** the existing ClaudeSession/ CodexDriverSession exposes only a **type-only, optional notification/one-shot hook** at its current native boundary. The new feature consumes those injected hooks and knows no private paths from the old session-implementation feature. Concrete SDK Query and Codex RPC remain physically owned by their existing session drivers. The Host supplies source eligibility/cancellation; the feature returns candidates without owning Session/DriverFactory, child processes, checkpoint persistence or endpoint configuration. Avoid dependency cycles and avoid passing raw SDK Query, CodexRpcClient or unrestricted JSON-RPC into the Host.

**No accidental checkpoint break:** the opt-in native suggestion callback is runtime-only auxiliary output, not checkpointed conversation input. Preserve existing Claude compatibility hash and Codex driverCompatibility unless a reviewed native behavior change proves otherwise. Test old disabled checkpoints, opt-in after safe restart and untouched OpenCode/consumer exports.

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
- The original session, generation, member/lane and conversation remain current; no **later separately executed native turn**, restart, rewind, clear or session switch supersedes it. A queued message cancelled before execution is not automatically a later executed turn. A human Steer delivered into the **same** native turn may qualify only when Host has an exact lineage/operation mapping; otherwise suppress. Never infer latest executed turn from the largest UI run ordinal.
- The composer is empty and editable, without active IME, attachments/chips, slash/mention menu, queued draft, approval input or other keyboard owner.
- The candidate is nonempty, bounded, not dismissed for that operation and generated inside the current revision.

On uncertainty, **hide**, not cross-fallback to another provider or guessed conversation. Renderer must recheck at display and acceptance, not only when the event arrived.

## 5. Claude SDK: exact lifecycle

1. During the **existing** openClaudeSession/open Query composition, opt in to promptSuggestions for **every Claude teammate/lead owned session** when the user explicitly enabled the global setting and the provider capability is supported. Do not require a human-direct-only session; real teams legitimately mix DM, group and internal work. This option is session-scoped, so the SDK may trigger inference after non-human turns; the separate Host authorization and operation checks prevent showing them, **but do not prevent provider usage**. This trade-off must be visible in Settings before opt-in, with an optional existing-host budget/backpressure gate at safe session open (no new quota subsystem). Capture flag immutably with the session; changes take effect at the next safe open/restart. Preserve custody.launch, env restrictions, settings and config compatibility.
2. Continue consuming the same AsyncIterable **past the SDK result**. Native prompt_suggestion arrives asynchronously after result; processing result must not terminate the stream or close the Query prematurely.
3. Existing ClaudeSession tracks active/settled input and operationRef. **Current source observation:** acceptTerminal clears this.active immediately on result. Capture a **single fenced settled slot before this.active is cleared** (session instance + operationRef + monotonic turn generation), otherwise an after-result prompt_suggestion has no owner. On new admitted input, close, abort, restore mismatch or turn failure, clear it synchronously.
4. Tap the SDK prompt_suggestion frame **before** generic Claude Normalizer/backgroundNormalizer, nested events or normal SPI event projection; the existing normalizer does not own this event. Validate type, nonempty bounded suggestion, native session_id and current slot. Route a candidate through the optional feature sink; do not reinterpret it as ordinary SPI result/text/diagnostic and do not expose as a durable event.
5. Ignore duplicate/late frames, suppression, errors, plan mode and lack of event. No separate inference fallback. Check the exact pinned SDK 0.3.305 for observed message shape, not just a newer SDK's docs.

**Observed seam and remaining qualification:** ClaudeSession.read continues iterating after result (good), while acceptTerminal retires active input immediately (a deliberate lifecycle contract). A source event may arrive after a queued input advances. The completed slot must be captured before retirement and invalidated on actual **new input admission**, not merely when a message is typed in UI. Host generation check provides a second guard. Snapshot the optional feature flag without making it an incompatible native checkpoint version: suggestions are auxiliary output, not native conversation history. Explicitly test old checkpoints with the feature disabled and enabled across a safe new process.

## 6. Codex App Server: exact lifecycle

1. On the **same initialized CodexAppServerClient**, after a successful completed native turn, capture exact source threadId, native turnId, operationRef and ownership from the bound CodexThreadSession. Do not query another process or another account's CODEX_HOME.
2. Verify selected binary/protocol capability, persistent **root** thread, idle state and no new accepted input. **0.162.0 is unsupported until upgraded and separately qualified**; version alone is not proof if experimentalApi/method authorization is unavailable.
3. Issue **one** typed JSON-RPC request. The low effort override is optional: omit it when the selected model/provider does not support reason-effort updates; never change selected provider/model to make sampling work:

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

4. Decode the *actual* response: sourceTurnId equals the captured turn, text is string or null, and the source thread is still current. Treat null/empty/whitespace as none. Bound text and validation **before** handing a candidate to Host. Preserve optional native input/output token counts for **Host-owned** quota accounting without exposing them to renderer. A tool-call attempt, rate limit, request timeout, method-not-found, cancel, source changed or foreign turn must not surface user text.
5. Use existing RPC framing, limits and beforeWrite fence. If supported, track the pending **sample RPC request ID** and cancel with the protocol's sample cancellation method (not turn/interrupt on the parent). Abort or discard on new input/cancel/disposal. A local AbortSignal alone may stop waiting without stopping native inference; therefore do **not** report cleanup confirmed without a native cancellation/terminal or owned process cleanup receipt. **Never retry after uncertain request admission**. Timeouts/unknown transport lead to discard, not replay.
6. The sample is an ephemeral fork; source history/checkpoint, native thread/turn counts and tool effects must remain unchanged. The instruction "Do not use tools" is not a security boundary: verify that any attempted tool call yields **no candidate and no tool effect**. Where supported, select disableMcp for eligible Responses Lite / incremental-tool sources, but never count it as a universal sandbox. The provider library does not own physical process custody and does not infer that RPC close means child exit.


**Source-turn guards:** validate native completion against captured turn/start and turn/completed notifications. Before request write and after response, check the same native thread/turn, no newer **executed** turn and no blocked/uncertain pending input. A stale or missing completion ID is not repaired from UI message order. The temporary fork may cost additional tokens; Host opts in and accounts for it as a native model request, not a free read.

**Compatibility gate:** Confirm exact minimum supported Codex version and experimentalApi initialization against the selected real binary before enabling; verify existence of thread/sample rather than accepting a method from type definitions alone. If the current selected binary lacks it, report unsupported and leave core chat unaffected. No behind-the-scenes upgrade in the feature.

## 7. State, limits and security

- No DB. Host keeps a single **latest in-memory candidate per active conversation** and a bounded dismissal key per (session generation, operationRef). A cold restart drops suggestions; this is correct, not data loss. Provider library stores at most one in-flight sample/settled slot per native session.
- **Codex:** at most one sample inference request per **eligible completed human turn**, never per internal task or streaming event. **Claude:** enabling SDK promptSuggestions may use one additional inference request after **every SDK turn**, including internal work in mixed sessions. This cannot be converted into per-turn gating merely by UI filtering. Product policy is a **global default-off opt-in with clear cost notice**, no per-teammate exclusions; use the existing Host budgets and session-start backpressure when available. Do not falsely claim zero hidden inference or automatic immediate disable on open Claude Queries; a safe restart may be needed to change the option.
- Bound inputs/output (proposal: max 512 UTF-8 bytes displayed, max 4 KiB native sampler instruction, maximum 1 candidate, per-request deadline no longer than current native RPC limit; constants reviewed against UX). Truncate? **Reject** over-limit native suggestions, do not silently truncate or split UTF-8.
- Candidate text is **untrusted model output**. Render as text, not HTML/Markdown with active links; never execute tools, commands or shell fragments. Acceptance inserts editable text only; user must separately send.
- Do not log raw suggestion, native conversation, credentials, paths or provider response bodies in default telemetry. Allowed metrics: feature enabled/disabled, supported/unsupported, produced/suppressed/stale, latency bucket and sanitized failure category.
- Do not access ambient HOME, user accounts or network outside the captured disposable fixture; native processes must use Host-selected environment, profile, tool policy and existing custody.
- Failed cleanup stays unknown. A missing event is **none**, not an application error or permission bypass. Do not loosen existing protocol denial or checkpoint validation for this feature.

## 8. Consumer adoption: bounded, separate PRs

**Not part of this plan-only PR.** After provider library qualification:

- **Host slice** on Desktop Stage 1 branch packages/legacy-agent-host: opt-in flag in captured open config, native terminal binding, identity/authorization/eligibility gate, single ephemeral candidate read/subscribe through existing Host transport. No new host supervisor or parallel Session SPI. Preserve status/accepted/UNKNOWN semantics for normal user inputs.
- **Browser-safe transport** in existing app feature architecture: extend the existing Host event delivery with **one typed, ephemeral suggestion notification** and one common authorization/freshness use case; IPC and HTTP both pass through that use case. Do not create a second SSE server, polling scheduler or durable message feed. A reconnect may drop the candidate; no history replay is needed. No direct provider SDK in renderer.
- **Existing composer** MessageComposer → MessageComposerInput → MentionableTextarea: add a tiny presentation hook and ghost suggestion, no new editor/chat system; Tab accepts when empty and no mention/slash/IME control, Escape dismisses, mouse/touch has explicit accessible action. Keep @, #, /, chips, attachments, queue and revision input behavior unchanged.
- **No alternate UI** for Create, Launch, Resume, messages, review or team tasks. Product owner must provide the exact conversation-to-native-operation mapping before the feature can show a suggestion; no guessed role from the last displayed bubble.
- Future **new agent-runtime / orchestrator** may adopt the provider package through its published typed adapter. There is no back-import, migration to new engine, or future domain authority in this feature.

## 8A. All-teammate coverage contract and polished UX

**Non-negotiable coverage:** this is one global user-facing feature for **every teammate with an effective Claude or Codex provider**, not a lead-only flag, model-name heuristic or one selected team. For each selected member, resolve the canonical effective provider from the **member's captured runtime lane**; never reuse the lead provider or infer from display name. The same rules work for solo mode, ordinary teams and mixed-provider teams. A teammate can receive internal work and still be eligible for a later **human direct** prompt in its native session. A candidate is only presented if its origin can be proven; "eligible teammate" does not imply "every response creates a suggestion."

### Coverage matrix (must become executable acceptance cases)

| Target / surface | Requirement | When shown |
| --- | --- | --- |
| Claude lead, solo or multi-member | Supported, not special-cased by role | Human DM to lead; exact completed input |
| Claude non-lead teammate in Claude or mixed team | Supported even when native session also handles tasks/group messages | Human DM to that teammate, not its internal task |
| Codex lead or non-lead teammate | Supported for **qualified native App Server** regardless of team lead provider | Human DM + persistent root + valid completed turn |
| Same provider, multiple teammates | Each has independently owned native session/result and candidate | Only selected recipient and conversation |
| Same-named teammate in two teams | Separate team/session generations and operation IDs | Never cross-show or cross-dismiss |
| Existing session after enabling feature | Claude next safe query restart; Codex eligible next completed direct turn | No forced kill/restart; show current capability status |
| Mixed conversation traffic | No blanket member exclusion; provider output may still be generated in Claude | Only proven human-origin direct operation |
| Group chat, broadcast, cross-team agent/internal task, bootstrap, schedule | No single human-to-teammate follow-up prediction | Suppress without new UI or inference (Codex); Claude may still emit |
| OpenCode, Gemini, missing/old Codex or unavailable native session | Graceful unsupported; no fallback generation or spinner | Existing composer remains unchanged |

**Completeness rule:** when feature flag is on, each eligible active Claude session has the native tap bound **after its next safe Query restart**, and every eligible compatible Codex session has a sampling capability. If current Codex 0.162 remains pinned, **all-Codex coverage is not achieved**: promotion requires an explicitly qualified >=0.165 native release and exact Host/Desktop pin update in a separate dependent change. Do **not** promise suggestions on arbitrary provider-neutral/non-native profiles: verify actual selected native owner and report unsupported privately. A user never needs to select a lead first or manually install a second provider for each teammate.

### Visual interaction (existing composer only)

Use a **small, understated suggestion row inside the existing composer surface**, beneath its recipient toolbar / immediately above the input. Prefer this over ghost text **inside** MentionableTextarea: the current editor has overlay chips, backdrops, @/#/slash dropdowns, IME and multiple layout modes; injecting ghost text into it risks caret/selection regressions. The row is a **preview**, not an editable draft, user message bubble, tooltip-only hint or toast.

~~~text
┌───────────────────────────────────────────────────────┐
│ To: Codex · backend                                   │  existing toolbar
│  ✧  Check the tests and open a PR      [Tab] [Insert] ×│  suggestion row
│  [Your message…                                       ]│  existing editor
│                                         microphone Send│  existing footer
└───────────────────────────────────────────────────────┘
~~~

- Visually restrained: same app surface tokens, muted text, subtle boundary/divider, at most two preview lines, narrow sparkle icon **not a colored badge**, no new box/card frame, no large explanatory copy. Soft 120–160 ms appearance only if reduced-motion permits; no layout-shifting animation or perpetual shimmer.
- Preview is plain safe text; no Markdown/HTML rendering, links or tool execution. If candidate exceeds 2 lines, clamp preview with ellipsis while **Insert** preserves the full bounded candidate. No fabricated word-by-word typing.
- **Tab** fills the draft **only** when input is empty, focused, non-composing, with no active mention/command/task menu, no attachment/chip, no queue edit/revision/approval and no keyboard shortcut owner. **Shift+Tab** stays normal focus movement. Never steal Tab when the focus is on the suggestion controls.
- Mouse/touch **Insert** is a real button with accessible name, and always rechecks candidate revision/recipient before inserting. Escape or × dismisses this one candidate without clearing a saved draft. If user starts typing/pasting/recording or opens other composer interactions, hide suggestion; do not overwrite anything. No implicit send.
- After insertion, text becomes an ordinary editable draft, and the row disappears. Submit still uses existing button/shortcut; never auto-submit, auto-queue or modify action mode (Do/Ask/Delegate).
- **Accessibility**: use a regular button, visible focus ring, bounded keyboard navigation, meaningful aria-label / tooltip via existing app primitives. Do not automatically move focus or repeatedly announce suggestions on each rerender; at most one polite assistive announcement when a new candidate becomes available. Honor font size and high-contrast themes.
- **Responsive**: same row for full, compact, floating and narrow chat; on narrow screens hide the Tab visual and keep a tappable Insert affordance. Do not make it desktop-pointer-only like T3. Disabled or unsupported sources simply retain the current input, with no hanging skeleton.
- **Loading**: never show an indefinite spinner under the composer. Suggestions are best-effort. No suggestion or provider error is not a failed chat turn. One concise hint in the existing settings explains why Claude may incur extra usage and why Codex needs a newer native version.
- **Discoverability and activation:** the existing Settings toggle must identify supported provider types and the live state honestly: `On for new sessions` versus `Current Claude session needs a safe restart`, without claiming that a toggle retroactively changes a running SDK Query. Show this concise status **in Settings**, not as repeated chat notices. Do not auto-restart or interrupt working teammates; existing safe Restart control remains available. Codex 0.162 users see `Update Codex to enable` in Settings, not an inert promise in the composer.
- **Draft and ordering:** a candidate is visually a suggestion, not a queued outbound message. The passive preview never changes draft persistence, send validation, member selection, action mode or scroll position. On arriving during a nonempty draft, keep the draft and suppress preview; **never delay sending** to wait for suggestions. After a new human input, discard the prior candidate even if its provider answer arrives later.
- **Viewport/layout:** render inside the existing composer stack with stable height when shown; avoid covering chat history, navigation or floating corner actions. Preview truncates to 2 lines in normal layouts and 1 in compact, while click inserts the entire bounded text. On a narrow touch device, preserve a minimum 44px tap target for Insert and dismiss without adding a second row of competing controls.
- **Settings**: one global opt-in toggle in an existing Settings surface (default OFF), not one switch per teammate, and not a separate onboarding page. Wording: "Suggest a next message" and "Uses extra provider requests. Applies to Claude and compatible Codex teammates." Feature flag changes are captured per native session and may need a safe Claude session restart; no forced interruption.

### UX state transitions (must have tests)

~~~text
disabled/unsupported → no row
enabled + human DM in progress → no row
completed eligible turn + matching candidate + empty editable composer → offer row
offer + Tab/Insert → insert editable text once; dismiss row
offer + Escape/× → dismiss row for that exact operation
offer + user types/pastes/attaches/switches receiver/opens command → hide, preserve draft
offer + new executed turn, clear, stop, relaunch, session generation change → invalidate
offer + cancelled queued run that never executed → still allow last executed
late/foreign/error/empty native output → no row, no product/chat error
~~~

Existing UI baseline is MessageComposer / MessageComposerInput / MentionableTextarea in Stage 1. **One** feature hook and one passive row, with a narrow keyboard callback; avoid bloating the 1400+ line MentionableTextarea implementation or adding an alternate editor. Existing team recipient selection, direct list, group, expanded/compact/floating composer variants and localization must be covered by visual E2E, not unit snapshots alone.

### UX success criteria

Test at 1440x900 and compact/narrow viewport, light/dark themes, keyboard-only, CJK IME, reduced motion and screen-reader landmarks. Verify no overlap with mention menus, file chips, buttons, responsive content, queue and revision notices; no focus loss; no layout jumping of sent message list; no misattributed provider identity. User must understand the row is a **suggestion they can edit**, not an agent action or unsent queued message, without reading documentation. Keep additional UI controls to **Insert and dismiss** only.

## 9. Phase 1 test architecture: no real subscriptions

All cases run under TEST HOME / TEMP, isolated config/profile/worktree, generated credentials **not** copied from the user, localhost-only scripted model endpoint, deterministic clocks and captured child PIDs. Test runner must prove cleanup of only its own resources.

### Tier A: pure and protocol fixture tests (mandatory)

| Case | Fixture signal | Mandatory assertion |
| --- | --- | --- |
| Claude happy path | SDK Query async iterator emits assistant, successful result, delayed prompt_suggestion | One correct operationRef candidate, after result, no second query/input |
| All teammates + mixed teams | Claude lead, Claude peer, Codex lead/peer; two teams with same member name; human DM after an internal task | Feature works for each eligible captured member, not just lead; no stale cross-member suggestion; native Claude may spend after internal turns but does not display them |
| Claude suppressions | First turn, plan mode, API error, no cache params, absent suggestion | Zero candidates, unaffected normal result |
| Claude stale | New input admitted before delayed suggestion; session generation changed | No candidate from previous operation |
| Claude shutdown | Abort/close before event; duplicate or foreign session ID | No leaked callback or stale candidate; cleanup receipt preserved |
| Claude mixed-session targeting | Claude lead/teammate session receives user DM, internal task, group and another user DM | Capability available to this teammate; only the right completed human DM can appear, internal candidates never displayed, extra SDK usage accounted for honestly |
| Codex happy path | Real JSON-RPC frames: initialize, thread/start or resume, turn/start/completed, then thread/sample | One request with exact threadId/expectedTurnId, sourceTurnId match, normal parent untouched |
| Codex non-support | Simulate 0.162, method-not-found, experimental disabled | Explicit unsupported, no fallback turn/start |
| Codex invalid result | null/empty, overlong text, wrong sourceTurnId, unexpected frame, tool attempt | None/stale/refusal; never forwarded |
| Codex race | next turn starts before write, during write, after sample response; cancel/timeout | No stale display, no retry, no parent interrupt |
| Isolation | Two sessions + two projects/tenants, same member names, different generations | No cross-delivery, no ambient-home reads |
| Backpressure | Burst many terminal/streaming events, older candidate pending | Max one in-flight per native session; bounded memory and event order |
| Legacy compatibility | Suggestions disabled, existing SPI and 2 packed consumers | Identical normal turns and public types/exports |

Use current SDK QueryFactory fixture and CodexAppServerTransport/subprocess fixture, not made-up methods. Assert native JSON-RPC request/notification IDs, exact startup, body, turn and cleanup. Negative cases must be **executed assertions**, not skipped tests.

### Canonical executable fixture scripts and audit counters

Use the **existing** Claude QueryFactory test seam and CodexAppServerTransport/subprocess fixture. Minimal deterministic cases, not a new mock-server product:

~~~text
CLAUDE (stream on captured SessionRef, no new query)
  SDK.user(inputId=I1, operationRef=OP1, nativeSession=S1)
  SDK.assistant(...) -> SDK.result(success, session_id=S1)
  wait scripted 75 ms -> SDK.prompt_suggestion(session_id=S1, suggestion="Review the tests")
  assert Host candidate(OP1), result already emitted, native input count=1, Query count=1
  repeat with OP2 admitted before delayed frame -> zero old candidates

CODEX (one captured stdio App Server client / persistent root)
  client -> initialize(experimentalApi=true) -> initialized
  client -> thread/start(persistent root) -> threadId=T1
  client -> turn/start(threadId=T1, input=I1) -> native turnId=N1
  peer -> turn/completed(N1)
  client -> thread/sample(threadId=T1, expectedTurnId=N1, prompt=...)
  peer -> response(sourceTurnId=N1, text="Review the tests", token counters)
  assert: thread/start count=1, turn/start count=1, sample count=1,
          tool effects=0, source history unchanged, suggestion linked to OP1
  inject thread N2 or another session before response -> zero stale candidates
~~~

The scripted fixture must honor real JSON-RPC message IDs, async writes/reads, cancellation and the native response schema; no direct call to a stubbed suggestion method at the UI boundary. Assert counts and exact request/response IDs in logs/receipts, with only TEST strings. For a native-binary result, **also** inspect upstream model-request bodies and process identity. Do not report zero skipped tests as evidence that all scenarios executed if a gate is conditional.

### Tier B: native local binary with scripted model endpoint (required gate for native claim)

- Run the **selected native Claude SDK 0.3.305** with Host-injected spawn/config and a fresh local scripted Anthropic-compatible inference endpoint only if the SDK/binary supports it without vendor credentials. Set an isolated fake API key scoped only to the localhost test server and deny all non-loopback egress. Inspect whether the actual native model requests contain the expected two-turn marker; a predetermined reply alone is not proof of retained context. If it cannot be safely isolated, retain Tier A proof and mark this native claim HOLD.
- Run **actual Codex App Server >=0.165** with experimental API and TEST CODEX_HOME, a **persistent root thread**, two completed turns against scripted localhost inference, followed by thread/sample using the exact turn. Verify request semantics, source UUID, fork isolation, absence of tool calls/source mutation, token counters and normal close/cleanup. **Inspect the actual upstream HTTP model-request body** for prior first-turn and second-turn markers and assert each appears in inherited context as expected; sample text by itself does not prove native history continuity. If local model emulation is unsupported, mark native sampling HOLD; do not disguise a fake JSON-RPC server as native.
- No real vendor credentials, subscription login, external inference, global config mutation or unbounded retries. Capture binary SHA/version, OS/arch, fixture hashes, request counts, exact passed/failed/skipped/held cases, timestamps and PIDs. Keep secrets and raw prompts out of uploaded artifacts.

### Tier C: Stage 1 Host + actual existing Desktop UI (after provider package adoption)

1. Two real TEST teammates, Claude and Codex, each receives a **human direct input** through existing composer, not a test-only endpoint. Fixture inference completes; only the recipient gets its suggestion.
2. One host restart/Resume/new generation: restored session is correct and old suggestion disappears. Reopening with new source does not resurrect a prior candidate.
3. Active queue, group/team/task/tool/background message: no suggestion for agent-origin work. An extra completed internal turn cannot become the user's proposed next prompt.
4. While suggestion visible, type/paste, open @ or / menu, IME composition, Tab/Shift-Tab, Escape, change recipient/team/selected conversation. Existing key priority wins; no auto-send, no mutation of saved draft or attachments. Also test a **cancelled-before-start queued UI run**: an earlier truly completed native turn remains eligible only with exact provenance, matching the defect class in T3 Code #33705; a newer executed turn always invalidates it.
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
- [ ] Product rollout only after selected Host Codex native pin is **explicitly upgraded and qualified** for thread/sample; otherwise the feature is reported as Claude-only/partial coverage, never all teammates.
- [ ] No extra ordinary model turn; no agent/tool action from sampling; no accidental replay after UNKNOWN.
- [ ] Exact ownership for human DM, no cross-team/project/member/session leakage; lifecycle and cancellations proven.
- [ ] Provider package/Session SPI exports remain compatible, packed consumers pass; no new root import side effect.
- [ ] Claude result->prompt_suggestion mapping survives active-input retirement, native checkpoint resume, mixed session roles and internal work; internal-work suggestion is never displayed, and SDK inference overhead is documented.
- [ ] Codex #8 account Draft source overlap and selected 0.162 vs >=0.165 version gate are reconciled before product wiring.
- [ ] Selected Host + Desktop existing composer journey and cold readback pass, including keyboard/IME.
- [ ] No vendor credentials used in Phase 1; TEST/native/vendor evidence levels recorded separately.
- [ ] Multiple source/security/UX review rounds, exact-head CI, no unresolved blocking findings.

A failed feasibility gate produces a documented **unsupported/HOLD** path; it must not trigger a redesign of all provider transports. Never claim feature-complete if native Codex sampling or Host ownership evidence is missing.

## 12. Review record for this design

This section records **design-only self-review**, not independent code-review approval. Five focused review passes were performed before finalizing this document:

1. **Ownership and clean boundaries (historical, superseded by coverage review):** initially required session-exclusivity for Claude to prevent unnecessary internal inference. This was safe but violated all-teammates coverage. Coverage revision adopts explicit opt-in + cost disclosure + strict per-operation presentation instead. Keep provider package without engine/domain imports and preserve existing Session SPI.
2. **Native protocol and state safety (reviewed, corrected):** a queued UI run may be the latest ordinal but never have executed; bind suggestions to the **last real native completed turn**, not a UI ordinal. Record Codex sourceTurnId/token counts, explicit sample request-id cancellation (where available), and UNKNOWN cleanup distinction. A prompt instruction is not tool isolation: no tool action must be observed.
3. **E2E and scope (reviewed, corrected):** add explicit scripted peer sequence and invariant counts; distinguish SDK fake stream, actual provider binary+localhost, and real vendor inference. Validate *actual model input* context and process cleanup, not a canned reply. Specify an ephemeral existing-transport event instead of a second SSE/poller. Pinned Claude checkpoint compatibility and Codex #8 integration overlap remain gated.

**Completed design self-reviews (five passes, not independent approvals):**

| Pass | Finding | Correction |
| --- | --- | --- |
| 1: boundaries/cost (superseded) | Claude SDK promptSuggestions is per-Query/session. Filtering only at UI would still generate suggestions for internal agent work. | Initially restricted to exclusive human-direct sessions. **Superseded after explicit all-teammate requirement**: enable with informed opt-in in all selected Claude sessions, filter only presentation, and account for usage. |
| 2: native safety | UI latest run can be a never-executed cancelled queue entry; sample cancellation and tool-free prompt alone are insufficient guards. | Bind to **last executed native turn** and exact expected/source turn IDs. Track native sample request ID, cancellation/UNKNOWN cleanup and zero tool effects. |
| 3: fixtures/compatibility | Existing Claude normalizer sees unexpected frames; active input is cleared on result. Synthetic text replies are not evidence of native context; adding a transport would overbuild. | Tap after-result frame before generic normalizer, capture settled slot before retirement. Add full JSON-RPC/Query fixture sequence, native upstream-context inspection, existing ephemeral Host notification, checkpoint compatibility and exact release evidence levels. |
| 4: SOLID/DRY review | A new feature could accidentally import private session client internals, introduce a second cancellation loop, or invalidate checkpoint compatibility. | Explicit dependency/port boundaries and static import checks; reuse existing SDK Query/RPC, type-only optional hooks and legacy package checks. No new checkpoint data for auxiliary suggestions. |
| 5: coverage/UX critical review | All-teammate support conflicts with previous Claude session-exclusivity rule; SDK opt-in cannot be toggled mid-session. Codex pinned 0.162 would leave all Codex teammates unsupported. A preview could cover compact/floating composers or overwrite drafts. | Supersede blanket exclusion; global informed opt-in + exact per-operation UI filters; new-session/restart state in existing Settings, explicit Codex >=0.165 qualified pin as launch gate; compact safe previews, touch affordances and no draft mutation. |

**Unresolved implementation-time gates (not disguised as review passes):**
1. Native Claude 0.3.305 prompt_suggestion in a **dedicated human direct Query**, with a fully isolated local scripted model endpoint and confirmed custody.
2. Exact Codex App Server >=0.165 experimental thread/sample support on **persistent root** using current package protocols, without a vendor subscription.
3. Host product data model proving exact identity for **each** direct-conversation/native-session/operation mapping across all eligible members, even in mixed session workloads; never guess from member name or UI latest run. Suppress only the unprovable candidate, not all teammates.
4. No overlap/collision with open provider Codex #8; selected tested artifact SHA and upstream base must be rechecked.
5. Follow-up Host/renderer PR and selected existing Desktop fixture E2E; the provider-only plan is not product acceptance.

Final corrections and explicit unresolved implementation-time gates must be recorded here after review.

## 13. Primary references

- Current SDK option API: https://github.com/anthropics/claude-agent-sdk-typescript
- T3 actual UX: https://github.com/pingdotgg/t3code/blob/main/docs/user/composer.md
- T3 regression on steered run: https://github.com/pingdotgg/t3code/issues/33705 and https://github.com/pingdotgg/t3code/pull/33706
- Codex protocol schema and implementation: https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs and https://github.com/openai/codex/blob/main/codex-rs/app-server/src/thread_sample.rs
- Provider extraction and governance: https://github.com/agent-teams-ai/old-provider-implementations/pull/1, https://github.com/agent-teams-ai/agent-runtime/pull/242
- Desktop Host migration: https://github.com/777genius/agent-teams-ai/pull/982 and parity work https://github.com/777genius/agent-teams-ai/pull/1186

## 14. R1 — fence ambiguous Claude suggestions and retain uncertain Codex sample cancellation

**Review basis and decision, 2026-11-15.** This is a documentation-only, test-first corrective scope on an isolated repair branch based on existing provider PR #8. It freezes consumed commit `421fee918811b8a0b0c73d0ff3e761b9a1c5ecb0` (tree `b4099afec73293b6d479694a92a9e6b72aa184bd`) and reviewed PR head `9423f600dfb04d04448326dbced89919924b0b5f` (tree `a873a5f9ad8e6da1d8894db22a02d8c8efb37199`). The direct PR readback still reports Draft/open, head `feat/frontend-parity-20261112`, base `bootstrap` / `d58500bc983e897506e23d7b0bc8da1209864edd`. Full comparison is ahead 43 / behind 0 with merge base 421. Both merged histories, the optional prompt feature and both Thinking commits remain intact. The isolated branch starts at exact 9423 after a fresh PR metadata/source readback, preserving that complete ancestry. It does not move the shared PR #8 head. No reset, rebase that discards published history, feature revert or replacement package assembled from selected unreviewed hunks is authorized.

**Whole-dependency assessment: HOLD before consumer adoption.** Both complete recursive trees and all 33 changed full files were read; their exact leaf delta agrees with the compare result. There are no deleted leaves or changed file modes; new files are ordinary `100644` blobs. The change consists of 17 implementation/contract TypeScript files, nine tests/fixture files, two feature README/plan files, one package manifest, two native scripts and two workflows. Existing account/login mechanisms, selected account/configuration/readiness/custody checks, default transport limits, lockfile/dependency pins and original normal input/close contracts are not changed by this delta. Thinking adds one neutral `EventPayload` variant, Claude exposed thinking snapshots/final blocks without signatures or redaction payloads, and OpenCode V1 reasoning with the original message/part positions; the reviewed Session, child and packed tests retain those distinctions. Those pieces have no separately identified source blocker. The complete dependency remains held for the two concrete optional-suggestion defects below; a green aggregate does not substitute for their regression proof.

### 14.1 Exact complete source inventory

| Path | Consumed 421 blob | Reviewed 9423 blob |
| --- | --- | --- |
| `.github/workflows/native-prompt-suggestions-claude.yml` | new | `ebf288d5b6e6143de244fcf813cfb00d30fd4e21` |
| `.github/workflows/native-prompt-suggestions.yml` | new | `4276d8995ee6118283af3c83f33f79d51d67edb2` |
| `docs/plans/2026-11-14-native-next-prompt-suggestions.md` | new | `73278e383be49959ddbb3dcd5ea417abdb9aa0d9` |
| `packages/provider-implementations/package.json` | `9a10fcab4e18e13bca2f981c0756f8b77724ed5d` | `4628124ce991ab036fbb2923297b179bdb107d25` |
| `packages/provider-implementations/src/features/native-prompt-suggestions/README.md` | new | `c67ff63e5ed677785c414a05f9488597cec713ff` |
| `packages/provider-implementations/src/features/native-prompt-suggestions/adapters/claude-sdk.ts` | new | `6d64f6c730c0a1f2b6cd3d448cddbcfb0149b4ae` |
| `packages/provider-implementations/src/features/native-prompt-suggestions/adapters/codex-sample.ts` | new | `74dc7ec7cb42625294d15e5ff307a08815e8f87d` |
| `packages/provider-implementations/src/features/native-prompt-suggestions/contracts.ts` | new | `5cb6281efbab2befbb8ce1eb53741e3e98687452` |
| `packages/provider-implementations/src/features/native-prompt-suggestions/core/policy.ts` | new | `1640bb77c348b1534cc629b8296d7398474ab5ce` |
| `packages/provider-implementations/src/features/native-prompt-suggestions/index.ts` | new | `e94d921fb74462831b2a43d6299bf79903fc34fd` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/config.ts` | `9413483f0e47c7db97c7fa9a215a394fbe87e220` | `6f87d41344f92e2bd2b4786584132ec469cdd6d0` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/normalize.ts` | `882824f03717cabe8fc745cb12226e326395d4a2` | `0a3da44e99c6a5f8cdaf201066a431811c29aa83` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/session.ts` | `98a514c3c44fcb62a4bac2a0b6b5f48a9d6883c5` | `51b1e49aea3db62fbc991edba4c8e207edb65cab` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/app-server.ts` | `3841690bd7dd88a768b28f2c4cc1eee240094164` | `924e2dc8b09fb90c081e47fc0b803079b50f85ae` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/driver-config.ts` | `d02d3c6ab540aa6415fbf32e16bf6e3be2f0377e` | `05c9433802596c434644c02e6c2df20360696ae4` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/driver-session.ts` | `ace1ef025ff21f7f14e0d82554372cdd8693507f` | `c77809d097940bed17cebc13b849f57f13a0db0b` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/rpc-client.ts` | `272a606f98b637fcb40ca20606a866597967394a` | `40fce90046397607a009f9b70e5b66421933cfeb` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/rpc-types.ts` | `2e0f8bb26b718736b286b0f12050b8cde818248e` | `5235a5e3103d11f23e2949c8ce9f2de08f1090c8` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/thread-session.ts` | `8bba99b637df83517bc67f513d4ddae6f6cabc5f` | `8e5d8b78700ffdb7e488a2a44a48461dcf5000ec` |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/opencode-protocol/v1-driver-output.ts` | `a7bc9d7e0baab9cd3d5f3729df904f32ac0e3b15` | `d0df18a1b4a11d82545277e6ae890b461b154930` |
| `packages/provider-implementations/src/prompt-suggestions.ts` | new | `589d7083982bd69e2424f3e9de7f0a311ac727f3` |
| `packages/provider-implementations/tests/features/native-prompt-suggestions/claude-sdk.test.ts` | new | `4af5b42b89e313cf5f3c65f8d1e817b854982062` |
| `packages/provider-implementations/tests/features/native-prompt-suggestions/codex-subprocess.test.ts` | new | `3f03bca7ea8847521cf4f3943bc9d5690c11174a` |
| `packages/provider-implementations/tests/features/native-prompt-suggestions/policy.test.ts` | new | `341a55c6adc64312676812e9761742f3872e472c` |
| `packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/factory.test.ts` | `21dd0546410fb8de1e8d81c42613e971f1eb8200` | `0c4d5532256b6f57fe8419b8baec37adf376501c` |
| `packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/normalize.test.ts` | `1a2054416a0926a1a63d8518ed8e0b12e2341e91` | `4daceed134f36949af6283b1043c6ea5d1d7eed5` |
| `packages/provider-implementations/tests/features/provider-session-implementation/claude-sdk/subagents.test.ts` | `960b22bd7222601e37fa723e1ed3953258c1eacb` | `0ee68d58ce4b4bc3abbd6fe06f7ed247bc5f768c` |
| `packages/provider-implementations/tests/features/provider-session-implementation/opencode-protocol/v1-driver.test.ts` | `6afaa4ed3b7f21ccf1478a0549b4118a1c318269` | `1433ac589d1f2f505a2ed8fdbe21347a76f49380` |
| `packages/provider-implementations/tests/fixtures/codex-app-server.ts` | `61ad864f060ad5694a4877786791d138525b723a` | `8ac9c649390148b9930b7c7061f6f77fea6c5f8b` |
| `packages/provider-implementations/tests/package/packed-consumer.test.ts` | `de3265d83babcf97c5c4e298006c80ef2c6c6922` | `17f3f9bf22208d87b2c97a803b5b8aa3353ff383` |
| `packages/provider-session-contracts/src/features/provider-session-contracts/contracts/session.ts` | `bd4668e0cf16ee7c2c2eb0d7b63863049b7cb5f6` | `1614599ce10109bdd82d20918cee8e87145e0e4e` |
| `scripts/native-prompt-suggestions-claude.mjs` | new | `98e1eb5b3a58fd2bc30886ddeb827a0a1b1cf01e` |
| `scripts/native-prompt-suggestions-codex.mjs` | new | `37a4e08a2f9513baa4ef565135a80caebffcc7e1` |

The original source-and-packed CI is `43768692114` at 9423: Node 24.21.0 job `132979504266` raw 105,744 bytes / SHA-256 `424d7af4c52aa56ead46896c0de02f8222917f55814d7571bb111f3639acbc5d`, and Node 26.11.1 job `132979503956` raw 100,255 bytes / SHA-256 `dc91a8dd0e8a4982feefdbfafdd0c186278156ded24e2f4b58bc36a894c3e1c6`. Each actual run reports 540 controlled tests passed, zero failed/skipped, plus the original contracts and implementation packed-consumer cases. Root independently downloaded artifact `14183890131`: ZIP 193,146 bytes / SHA-256 `01aa79d2dbca55c9dbcb6d271d0ee745339e03c5a226b8f1067b851fbed4ff96`, CRC/unique safe paths checked, exactly two archives and the receipt. Actual checked implementation bytes are 185,996 / `24040cc82613d8472bbead0643bd6eb1a8132227019a825bf0815af396c56267`; Session SPI bytes are 6,230 / `0ea08bacd3f19a54c065cfaebbe8ae0fb3a8e6770886402f435a96e97867d2bc`. This is original 9423 evidence, not proof of the future repair, real native providers, Host, Electron or release qualification. The reviewing child read the full CI logs/source; the ZIP verification is explicitly root's verification.

### 14.2 Two source-backed defects and the identity limit

**Claude accepted successor can be overtaken by the preceding result.** In `claude-sdk/session.ts` blob `51b1e49aea3db62fbc991edba4c8e207edb65cab`, accepting B synchronously clears `lastSuccessfulInput` at lines 109–111. If A is still active, A's later successful terminal sets that slot back to A at 394–396 without checking the already accepted successor. The original next-input path awaits `checkReadiness` at 242 before handing B to the SDK. While that original await is pending, `active` is undefined and the ordinary after-result suggestion for A passes 311. This is a concrete legal ordering through the actual Query fixture and original readiness seam, not a timing measurement or an observed vendor incident. The three existing optional Claude tests cover an immediate duplicate, a foreign session, internal filtering, a late frame while the next input is active and default-off, but not this accepted-queue ordering.

The same wire format also limits recovery after overtaking. Root read the installed exact SDK 0.3.305 declarations: `Options` documents at most one `prompt_suggestion` per turn, arriving after that turn's `result`, with suppression including the first turn, errors, plan mode and other settings/limits. `SDKPromptSuggestionMessage` has `type`, `suggestion`, `uuid` and `session_id`; it has no native turn/input ID and supplies no cross-turn completion-order guarantee. A first outstanding A suggestion delivered after B's terminal cannot be assigned to B merely because B most recently completed. A local counter, session ID, UUID or arrival order cannot manufacture the missing native lineage. The correction must cover both the queued-B case and this late-A-after-B case, without claiming an undocumented SDK ordering rule.

**Codex local RPC expiry discards the only native cancellation handle.** In RPC blob `40fce90046397607a009f9b70e5b66421933cfeb`, 64–75 delete a sent pending request and reject `request-timeout` with unknown acceptance without aborting the caller signal. In app-server blob `924e2dc8b09fb90c081e47fc0b803079b50f85ae`, 155–158 then mark the sample settled and remove its only abort/cancel listener; driver blob `c77809d097940bed17cebc13b849f57f13a0db0b`, 257–258, clears `sampleAbort`. A later accepted ordinary input cannot cancel that original sample, and a later completed turn may launch another. The original finite subprocess fixture `8ac9c649390148b9930b7c7061f6f77fea6c5f8b` retains `pendingSamples` at 94 until exact `thread/sample/cancel` at 103–109; ordinary `turn/start` at 112 does not clear them. A valid short `rpcLimits.requestTimeoutMs` therefore exposes the defect using existing controlled transport only. The four new Codex tests exercise cancellation before the timeout, not this ordering. Local expiry is not native terminal or physical cleanup evidence.

These two findings have independent source review; no real Claude/Codex process, model request, version command or new runtime experiment was used to establish them. They do not explain historical Windows readiness failures, change those outcomes, or establish that an original `confirmStopped` failed. The current optional feature remains default-off and is not being enabled in any product.

### 14.3 Authorized producer policy: one original binding, bounded uncertainty

**Claude — one captured Query, one pending auxiliary slot, one private quarantine.** Track only the exact already-owned original input that actually reaches this Query's existing handoff and its original terminal state. Do not derive identity from text, display role, UUID ordering, native session alone or a guessed SDK turn counter. A newly accepted successor that overtakes a prior potentially outstanding native suggestion makes subsequent auxiliary attribution uncertain. The same applies if an older queued input reaches its original handoff after a successor has already been admitted. Once that ambiguity is present, retain a private auxiliary quarantine for this captured Query's lifetime and suppress ambiguous offers. Normal inputs, queue admission, readiness, terminal events, interactions, checkpoints, interrupt, close and physical custody continue through their existing paths; quarantine must not seal, interrupt, restart or replace the native Query.

The potential native auxiliary slot must also account for an internal/ineligible input: the SDK option is Query-scoped and can generate after internal work even though Host eligibility correctly suppresses display. A late internal candidate cannot borrow the next human input. Retire an unambiguous slot only from its own already-bound observation/lifecycle facts; consume a valid same-session after-result auxiliary frame at most once before calling the observer, even when its text is empty/invalid or the offer fails. Foreign/nested/restore frames cannot consume or establish another input's ownership. Recheck the captured slot, open state and quarantine after the existing eligibility callback, which may reenter ordinary admission/close; observer errors remain isolated and never become ordinary Session failure.

A successful result is necessary for an offer but is not proof that no old suggestion can arrive. Interrupt, failure or absence of a suggestion cannot silently rebind uncertain old work to B. Once quarantine is set, a later candidate, ordinary success, callback return or cancel acknowledgment does not clear it. There is no proven same-Query recovery criterion in the documented wire, so no such criterion may be invented. State starts fresh only in an independently caller-created new Query through the already existing open path; this correction starts no Query. The SDK's documented first-turn suppression is not permission to invent a native counter: an unobserved prior suggestion can conservatively suppress later auxiliary output for that Query. This limitation must remain explicit; the change does not qualify complete native next-prompt availability. A flow where the original unambiguous A observation was consumed before B admission must still permit B's independently bound suggestion.

**Codex — retain uncertain sent-sample ownership inside the existing client.** The existing `onSentId` reports original frame-dispatch admission, not provider acceptance. Capture that original ID once. If a potentially sent sample ends through local timeout/abort/other uncertain transport settlement without an observed native response, synchronously latch auxiliary sampling unavailable for that client lifetime before discarding the local listener/slot. Attempt at most one best-effort `thread/sample/cancel` for that captured ID while the original RPC transport is open, sharing one once-only flag between explicit abort and uncertain-error handling. Use the existing request queue and original RPC budgets; no new clock, deadline, retry, process, parent `turn/interrupt`, replay or second cancellation. Closed transport cannot be reopened to send it.

Do not promote an uncertain sample after a cancel ACK: that acknowledges the control request, while late original RPC replies are already discarded by the original pending-map logic. Without a retained exact-original terminal proof, further auxiliary samples stay refused on this client; ordinary turns and readiness remain usable. Known-not-sent rejection, a received definite native error response (including unsupported method), and a received sample result are distinct from local unknown termination and must not be relabeled as physical cleanup failure. Preserve the original thrown error object and successful native response. Existing driver `close` and `confirmStopped` remain the only existing physical cleanup path; no sample flag, ACK, EOF or local rejection substitutes for that receipt. The conservative client-wide auxiliary latch is bounded state, not a new transport/session owner.

### 14.4 Exact four-path edit boundary

| Existing path | Exact 9423 preimage | Original physical lines | Maximum source delta | Final physical ceiling |
| --- | --- | ---: | ---: | ---: |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/claude-sdk/session.ts` | `51b1e49aea3db62fbc991edba4c8e207edb65cab` | 516 | +55 / -20 | 571 |
| `packages/provider-implementations/src/features/provider-session-implementation/adapters/codex-protocol/app-server.ts` | `924e2dc8b09fb90c081e47fc0b803079b50f85ae` | 321 | +40 / -4 | 361 |
| `packages/provider-implementations/tests/features/native-prompt-suggestions/claude-sdk.test.ts` | `4af5b42b89e313cf5f3c65f8d1e817b854982062` | 95 | +235 / -0 | 330 |
| `packages/provider-implementations/tests/features/native-prompt-suggestions/codex-subprocess.test.ts` | `3f03bca7ea8847521cf4f3943bc9d5690c11174a` | 83 | +225 / -0 | 308 |

Only necessary named built-in/public-facade test imports and appended actual-fixture cases/helpers are permitted in the two test files; every original test, helper and assertion must survive byte-for-byte after reversing those additions. Use the existing `QueryFixture`, real original adapter/factory and finite `tests/fixtures/codex-app-server.ts` subprocess. Do not copy production state machines into tests or replace original readiness/terminal methods. Source patches must provide complete forward/inverse checks against these exact preimages; all unselected producer bytes remain unchanged. If a fresh preimage differs, stop application for a bounded rebase review rather than overwriting it.

The driver/session config, RPC implementation/types/limits, thread-session, fixture producer, policy/decoder/exports, package manifest, lockfile, all contracts including Thinking, native scripts and every workflow are outside the executable edit scope. This R1 publication itself only appends to `docs/plans/2026-11-14-native-next-prompt-suggestions.md`, preserving complete preimage `73278e383be49959ddbb3dcd5ea417abdb9aa0d9`. No source candidate may precede the published R1/full-content readback; no producer application may precede the specific test-only RED gates.

### 14.5 Required finite tests and meaningful RED

1. Claude: run the actual original Query and Session; hand A once, synchronously admit B while A is active, hold only B's original readiness callback, settle A, and emit the ordinary A after-result suggestion before releasing that callback. Verify zero offers while both original inputs/handoffs/results and their identities remain valid. Baseline must fail the offered-candidate assertion, not fixture setup, an unavailable private helper, a missing marker or an artificial clock.
2. Claude: finish A without consuming its auxiliary frame, admit and finish B, then emit A's first delayed same-session frame. Verify no B attribution and that later success cannot clear the auxiliary quarantine. Include the same ambiguity from an internal/ineligible prior input. A complementary actual Query flow must retain one correct candidate per input when each unambiguous prior frame is consumed before the next admission. Keep default-off, foreign/nested/invalid/duplicate suppression, close/interrupt boundaries, one Query and original input counts. Eligibility/offer callback errors or reentrant admission must not escape into normal lifecycle.
3. Codex: use the actual finite subprocess/connected client, its exact completed native turn, existing `sample-mode: hold`, and an explicitly selected short valid original RPC timeout. Await the actual original request-timeout error to establish that local settlement; require exactly one cancellation carrying that sample's observed request ID. Baseline must fail missing targeted cancellation after that actual timeout. Do not substitute a sleeps-only assertion, mocked timeout implementation or copied sample method.
4. Codex: after the same uncertain sent sample, an ordinary following turn must still start and complete with exact original thread/turn identity, but another auxiliary sample must be refused before an additional sample frame. Baseline must fail the expected refusal/extra-frame assertion. A cancel reply must not unlock the latch; an explicit abort racing the timeout must not duplicate cancellation. Known-not-sent/pre-aborted requests produce no native cancellation or unknown-work latch; a definite native unsupported response may be handled as none without disabling later separately valid auxiliary work. Preserve unchanged main `turn/start` counts, no parent interrupt/replay, normal response/error identity and original close/custody receipts.

These are real controlled mechanisms through existing test seams. The synthetic fixture's pending map demonstrates protocol bookkeeping; it does not establish vendor or OS custody. Do not use a real SDK process/binary, Codex executable, credential, external model, SDK version command or the optional native scripts, including with a localhost model. Original test timeouts, package limits and production RPC budgets are not extended. New test cases may explicitly choose an existing supported short fixture RPC limit to observe the defect; they may not change timer implementation or turn a production timeout into a later deadline.

### 14.6 Publication, CI staging and archive adoption gates

Root first creates the isolated branch `fix/native-suggestion-fences-20261115` from exact `9423f600dfb04d04448326dbced89919924b0b5f`, subject to a fresh absent-ref lease and unchanged PR #8 head/workflow readback. Root publishes and immediately pushes this complete documentation-only R1 there, retaining the entire earlier plan and all commits. Independent full-content/tree/ref readback must confirm the exact plan addition and unchanged four preimages before any code objects or test application. This scope then authorizes root to open ONE ordinary Draft repair PR in `agent-teams-ai/old-provider-implementations`, head `fix/native-suggestion-fences-20261115`, base the existing PR #8 head branch `feat/frontend-parity-20261112`. Title/body must identify the two held auxiliary defects, finite test-first stages, original safe CI, unresolved native qualification and unchanged shared PR #8. Read back the actual Draft/base/head/commits and workflow selections before any subsequent stage. Then author/review only the two additive test candidates, create/push the test-only stage on that isolated branch, and retain the resulting original CI evidence. Source producers remain exactly `51b1e49…` / `924e2dc…` at this stage. The original whole safe check must expose both Claude regression assertions and Codex timeout/cancellation/admission failures while retaining original passing tests. A setup/import/type/harness failure is not semantic RED. If a failing subtest prevents later negative assertions, disclose that; complete GREEN must execute them all.

Use the repository's unchanged `.github/workflows/ci.yml` blob `7e2bb17761d783b7d0ed298c62c56680a6636279`: ordinary `pull_request` CI, exact checked-out head, pnpm 11.18.0, Node 24.21.0 and 26.11.1, `pnpm install --frozen-lockfile --ignore-scripts`, then root `pnpm check`. That exact root command is `pnpm build && pnpm typecheck && pnpm test && pnpm test:package`; the controlled source command already includes both test files. No alternate tsconfig, flags, filtered success claim, disabled test, workflow rewrite or invented lint task is authorized. Preserve raw logs/API joins and exact counts; RED may stop before archives, so absent archives stay absent and are not fabricated or required through a new producer.

Only after independent acceptance of the actual specific REDs may the two bounded producer candidates be authored and independently reviewed, with original tests and exact inverse/source inventory. Root applies/commits/immediately pushes the accepted producers and obtains the original complete two-Node safe GREEN, types and both packed consumers on the resulting source. Any failed gate keeps qualification open; no source-only acceptance or earlier 540 PASS transfers to the repair. The one explicitly named Draft repair PR and its ordinary opened/synchronize CI events are the only new CI venue authorized here. There is no authorized manual workflow dispatch, rerun/cancel, second PR, promotion, provider PR #8 merge or direct shared-head update. After GREEN, root must separately review the history-preserving integration of this repaired descendant; this R1 does not authorize it implicitly.

PR #8 and the isolated repair PR remain Draft. Read back all FOUR workflow blobs before creating the repair PR and before each staged source update, not merely their display names. The exact frozen inventory and routing are:

| Workflow | Exact 9423 blob | Original jobs and expected routing for only this plan plus the four approved paths |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `7e2bb17761d783b7d0ed298c62c56680a6636279` | `check`, two original Node matrix jobs, ordinary pull_request with no path filter; controlled `pnpm check` only. Only existing controlled fixtures are selected; the repair introduces no real provider Query/process. |
| `.github/workflows/native-prompt-suggestions-claude.yml` | `ebf288d5b6e6143de244fcf813cfb00d30fd4e21` | `claude-native-suggestion`; filters only its standalone script/workflow, so this repair diff does not match. Its existing job condition additionally refuses Draft pull requests. |
| `.github/workflows/native-prompt-suggestions.yml` | `4276d8995ee6118283af3c83f33f79d51d67edb2` | `codex-native-sample`; the two producer paths match its source filters, but the existing job condition `github.event_name != 'pull_request' || github.event.pull_request.draft == false` refuses this Draft repair PR. Tests-only and plan-only changes do not match. |
| `.github/workflows/native-v2-readonly.yml` | `b4b88ce1c41c89559a584cce830de59fb5ec0fc0` | `native-v2-test`, existing native matrix. It has NO Draft job guard; none of this plan's five selected document/source/test paths match its explicit V2/SPI/package/harness path filters, so this repair does not create that native venue. Do not describe Draft alone as protection for this workflow. |

There are no other workflow leaves, `push` or `pull_request_target` jobs in the frozen provider tree. Any new workflow, modified workflow, changed base/head or expanded changed-path set requires a fresh bounded routing review before another push; do not assume this table covers later changes. Workflow dispatch or marking ready can execute actual vendors and is not authorized. The standalone native scripts directly execute Claude/Codex and do not exercise the corrected provider adapter end to end; they also do not establish captured Host/OS cleanup. Previous Draft skips and localhost-only descriptions are not native qualification. No native workflow or executable, including `--version`, may be invoked for this repair.

After the complete resulting-source review and safe GREEN, retain the SAME two archives installed by the original packed consumers plus their exact-head receipt; verify sizes/SHA-256/ZIP safety against the new artifact before any consuming application pin update. The 9423 checked pair remains historical held evidence. Adoption of implementation and Session SPI, Host normalization, all current package/workspace/lock/source pins and consumer regressions is a later atomic reviewed application change, not implicit authority from this R1. Do not update only the Thinking files or copy new contracts while retaining the old implementation archive.

This is a finite repair to two demonstrated auxiliary lifecycle defects. It does not implement the future product composer, broaden provider availability, prove live native feature completeness, add new actors/observation loops, relax ownership/currentness/cleanup, or change any historical Windows result. No child agent has created a commit or moved a ref, applied source/tests, dispatched/rerun CI or executed a provider for this proposal. Root publication and staged application follow the explicit gates above.
