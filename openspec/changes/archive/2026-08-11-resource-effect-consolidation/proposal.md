## Why

`Resource.acquireUseRelease()` and `Effect.acquireRelease()` express related lifecycle intentions, but the documentation and example code currently give both patterns equal weight. The runtime model is now centered on contextual `Scope`, so the project should promote the integrated Effect form while preserving `Resource` as a compatible standalone helper.

## What Changes

- Audit `Resource.acquireUseRelease()` and its tests to ensure its implementation remains entirely built on `Scope` without duplicating lifecycle machinery.
- Migrate the `examples/todo-api` resource usage to `Effect.acquireRelease()` where the example already runs inside a Runtime execution.
- Keep `Resource.acquireUseRelease()` available with its current API, Result error behavior, release precedence, and disposal support.
- Reorganize the README so `Effect.acquireRelease()` is the primary integrated pattern and `Resource` is documented in a focused “Standalone resource helper” section.
- Add compatibility coverage for Resource behavior and the migrated example path.
- Do not deprecate Resource yet.
- Do not add `ScopeOutcome`, outcome-aware finalizers, `Exit`, `Cause`, cancellation, or another lifecycle primitive.

## Capabilities

### New Capabilities

<!-- No new externally observable capability is introduced. This change consolidates existing APIs and documentation. -->

### Modified Capabilities

<!-- No existing requirement changes. Resource remains behaviorally compatible. -->

## Impact

- May touch `src/resource` only for small internal hardening or deduplication discovered during the audit.
- Updates `examples/todo-api`, README documentation, and Resource/runtime regression tests.
- Preserves the public `Resource` API and does not change dependencies, Layer, Runtime, Scope, or Effect type contracts.
- No migration or deprecation is required; users may continue using Resource for standalone Result-oriented workflows.
