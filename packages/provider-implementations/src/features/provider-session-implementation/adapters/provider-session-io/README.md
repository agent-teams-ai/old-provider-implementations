# Provider session IO

Curated `./session-io` entry for the two actual provider session implementations.
`EventFeed`, `deferred` and `bounded` move here once from the reviewed Claude
primitives. Claude-specific failure codes remain in Claude. There is no provider,
SDK, canonical runtime, product, process custody or persistence dependency.

`EventFeed` admits one observer, bounds queued JSON-serializable facts by count
and encoded bytes, and has one reserved final fact when overflow must be reported.
It does not silently discard queued facts. `bounded` bounds observation time and
does not cancel the supplied operation; the owner supplies cancellation separately.
The caller owns each instance and its lifecycle. This is a shared volatile
mechanism under the existing FMS/CMS classification, without a Host or independently
assembled node. Consumers cross only this curated feature entry; reverse and deep
cross-feature imports remain forbidden by the architecture gate.
