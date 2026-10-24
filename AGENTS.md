# Working instructions

Use pnpm11.18.0 and the exact Node versions in CI. Keep the two public package
names and exports compatible. Provider-specific protocol details belong in the
implementation adapters; consumer lifecycle/custody and product authority remain
caller-owned. Do not introduce engine or orchestrator dependencies.

Use only disposable fixtures. Normal checks must not read user credentials or
start real providers. Preserve uncertainty, cancellation, ownership and no-replay
guards. Run `pnpm check` before delivery. Do not publish packages or releases.
