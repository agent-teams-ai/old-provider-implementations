# Old provider implementations

Standalone source workspace for `@agent-teams/provider-implementations` and
`@agent-teams/provider-session-contracts`. The package names, public exports and
Node24/26 engine contracts are unchanged. The implementations adapt Claude SDK,
Codex app-server and OpenCode V1/V2 protocols. The contracts package contains the
provider-neutral Session SPI and has no runtime dependencies.

Consumers supply selected configuration, transports, process custody, durable
intent/checkpoints, tool authority and credentials. This repository contains no
runtime engine, orchestrator, product model, database or automatic provider
selection. Importing a public facade does not start a provider.

Use Node26.11.1 (Node24.21.0 is also covered) and pnpm11.18.0. After the initial
reviewed lockfile has been generated, normal verification is:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
```

`pnpm check` builds the two packages, checks their types, runs controlled source
protocol tests and verifies actual packed-package consumers. Tests use disposable
state, synthetic subprocesses and localhost fixtures. The package's optional
`qualify:claude-migration` command retains a historical donor-fixture qualification
and is not part of normal verification; it requires a separately selected read-only
upstream checkout. It never supplies production code at runtime.

Source was copied from agent-teams-ai/agent-runtime commit
`4e37051ed390da84842eb27535c8e9b07a0364b7`. The exact original and destination hashes
are recorded in `provenance/source-extraction.json`. Existing package provenance
and feature notes remain historical records; they do not adopt upstream engine
architecture governance or claim new provider/security qualification here.
No provider authentication, live inference or publishing belongs to CI.
