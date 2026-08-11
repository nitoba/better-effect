## Why

Execution scopes are currently created independently from the Runtime root scope, so their ownership relationship is implicit. This makes it possible for Runtime shutdown to race with active executions and forces lifecycle coordination to be spread across `Scope`, `Layer`, the runtime facade, and backend cleanup. A hierarchical scope model with graceful shutdown gives each execution an explicit child lifetime while keeping Layer resources alive until the Runtime is disposed.

## What Changes

- Add parent/child scope hierarchy through `Scope.fork()`, with child detachment on close and parent-first child cleanup before the parent’s own finalizers.
- Separate `Scope.provide()` (use an existing scope without closing it) from `Scope.run()` (create, provide, execute, and close a scope).
- Make Runtime executions fork child scopes from the BuiltLayer root scope instead of creating unrelated scopes.
- Track active Runtime executions and make `dispose()` graceful: reject new executions, await active executions, close the root scope, then perform backend cleanup.
- Preserve existing LIFO finalizer order, idempotent close behavior, cleanup failure aggregation, and public `Resource` semantics.
- Keep this change intentionally small: do not add `ManagedRuntime`, `Scope.withChild()`, exit-aware finalizers, `Exit`/`Cause`, cancellation, or shutdown timeouts.

## Capabilities

### New Capabilities

- `scope-hierarchy-runtime-shutdown`: Hierarchical scopes, explicit scope provisioning, Runtime-owned execution scopes, active execution tracking, and graceful Runtime shutdown.

### Modified Capabilities

<!-- No existing capability requirements change. The current typed-layer requirements remain unchanged. -->

## Impact

- Affects the internal `Scope` implementation and scope context runtime.
- Changes BuiltLayer/Runtime lifecycle orchestration and execution behavior without adding a new public Runtime abstraction.
- Requires updates to scope and layer-runtime tests and documentation.
- Keeps DI adapters responsible for resolution/cache only; they must not regain ownership of Service release semantics.
- Adds no runtime dependencies and does not change the `Resource` API or its error precedence.
