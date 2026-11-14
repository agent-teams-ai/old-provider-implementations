# Native next-prompt suggestions

Feature owner: `@agent-teams/provider-implementations/prompt-suggestions`.

This is a **volatile, opt-in provider observation**, not part of the canonical
Session SPI. The existing native Claude SDK Query and Codex App Server client
keep their transport and lifecycle ownership. This feature provides bounded,
portable candidate validation and native event/response decoding.

Claude push events may arrive after `result`; the caller must retain the
last successful native input before retiring it. Codex sampling is available
only on a compatible exact bound persistent App Server root thread and exact
completed native turn. Its model inference is extra work, not a free status read.

The Host owns the selected provider/member/tenant/team/conversation, permission,
eligibility, cost budgets, producer generation, release pins and UI display.
No provider import runs a process. The candidate cannot send any message,
invoke tools, append to transcript, mutate checkpoints or authorize a chat.

Design and explicit source/E2E gates:
`../../../../../docs/plans/2026-11-14-native-next-prompt-suggestions.md`.
