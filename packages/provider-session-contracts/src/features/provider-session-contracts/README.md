---
type: feature
status: accepted
owner: "@agent-teams/provider-session-contracts"
owner_document: ADR-0093
---

# Provider Session contracts

The provider-neutral consumer Session SPI owns the unchanged fourteen public
provider driver types. `contracts/session.ts` is their single editable source.
The root package and feature public/internal entries expose only named types.
The unexported session scope shape preserves OpenConfig's structural contract.

This platform feature has only a contracts layer. It owns no behavior, resource,
Host, engine, SDK or persistence. Runtime and provider implementations import
its public root; the previous Agent Execution path reexports these definitions.
The package has no runtime dependencies or peers. Strict packed installation,
empty runtime exports and legacy type equality are checked at package boundaries.
