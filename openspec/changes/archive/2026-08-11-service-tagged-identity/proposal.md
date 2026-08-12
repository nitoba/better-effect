## Why

`Service` identity is currently reconstructed from the instance/constructor
shape. Because TypeScript is structural, Services with identical contracts can
be confused when Effect requirements, Layer completeness, overrides, and
Runtime execution are validated. This change gives every Service an explicit
string-literal identity shared by the type-level model and runtime backends,
while keeping the class constructor as the ergonomic `yield*` handle.

## What Changes

- **BREAKING**: Replace `Service<Self>()` declarations with
  `Service<Self>()('ServiceName')` declarations. The explicit self type is
  retained because TypeScript cannot specialize an inherited static iterator
  exactly from a tag-only factory.
- Preserve exact `yield* Service` instance inference and carry a tag-aware,
  self-bound constructor contract (`ServiceToken<'ServiceName', Service>`) in
  `EffectRequirements` and related metadata. The runtime resolver continues to
  preserve the concrete constructor-to-instance relationship.
- Require Service tags to remain non-empty string literals; widened `string`
  tags must be rejected at the public declaration boundary.
- Make Layer completeness, missing-Service diagnostics, overrides, and Runtime
  execution checks distinguish structurally identical Services with different
  tags.
- Define compatibility for Services with the same tag using both tag equality
  and bidirectional instance-contract compatibility; incompatible same-tag
  providers MUST NOT be silently substituted.
- Key the built-in Memory and ITI backend provider/instance/pending maps by
  Service tag, while retaining the constructor for exact typing and collision
  diagnostics.
- Reject duplicate Service tags during `Layer.merge`; keep `Layer.override` as
  the explicit replacement operation for compatible providers.
- Update Service, Layer, Runtime, Effect, adapter, example, README, AGENTS, and
  runtime/type-test declarations to the tagged API.
- Add user-facing JSDoc to exported classes, methods, functions, errors, and
  public type contracts, with concise usage examples for primary entry points.
- Keep Scope, Resource, better-result integration, pipeline behavior, and
  graceful Runtime disposal semantics unchanged.
- **BREAKING**: Update the package's Service identity API and type helpers for
  the pre-1.0 migration; do not retain the old and tagged declaration models as
  parallel public APIs.

## Capabilities

### New Capabilities

- `service-identity`: Explicit literal Service tags, self-bound constructor
  requirement metadata, tag/contract compatibility, and runtime collision
  behavior.

### Modified Capabilities

- `typed-layer-requirements`: Layer completeness, missing requirements, and
  override matching use tagged Service identity plus contract compatibility.
- `typed-runtime-execution-requirements`: Runtime and one-shot execution
  validation preserve and compare tag-aware Service constructor contracts.

## Impact

- Public APIs in `src/service`, `src/effect/types`, `src/layer/inference`,
  `src/layer`, `src/runtime`, and package exports.
- Built-in `MemoryLayerBackend` and optional `ItiLayerBackend` registration,
  lookup, caching, duplicate detection, and diagnostics.
- All Service declarations in tests, type contracts, examples, and README;
  existing `ServiceToken<Instance>` usages require migration.
- No new runtime dependency is expected. The package versioning/release policy
  must treat the declaration change as a breaking pre-1.0 release, without
  publishing automatically.
