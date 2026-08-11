## Why

`Scope.add` already owns the lifecycle for objects implementing JavaScript's disposal protocols, but `Effect.gen` users must expose the contextual Scope for this common operation. An `Effect.add` yieldable completes the Effect-native resource DX without introducing a new lifecycle primitive.

## What Changes

- Add `Effect.add(resource)` to register an already-acquired disposable object in the current Scope and yield that same object back to the program.
- Preserve the exact resource type, use the existing `UnhandledException` error channel for registration failures, and add no Service requirement metadata.
- Reuse existing Scope cleanup behavior, including LIFO order, immediate cleanup during close races, preference for `Symbol.asyncDispose`, and Runtime cleanup precedence/diagnostics.
- **BREAKING**: tighten `DisposableResource` so a value must statically provide at least one of `Symbol.dispose` or `Symbol.asyncDispose`; arbitrary objects are no longer accepted by `Scope.add` without an explicit unsafe cast.
- Keep `Effect.acquireRelease`, Scope ownership, Resource, and Runtime semantics unchanged.

## Capabilities

### New Capabilities

- `effect-add-disposable`: Defines Effect-native registration of already-acquired disposable objects in the contextual Scope.

### Modified Capabilities

- `scope-hierarchy-runtime-shutdown`: Makes the public disposable-resource contract require at least one disposal protocol and specifies Scope registration/disposal behavior.

## Impact

- Public API: adds `Effect.add` and narrows the exported `DisposableResource` type.
- Core implementation: `src/effect/` delegates registration to the current Scope; `src/scope/` retains all cleanup ownership.
- Compatibility: correctly typed disposable objects remain source-compatible; code passing arbitrary or weakly typed objects to `Scope.add` must narrow or explicitly cast them.
- Tests and docs: runtime behavior, type inference/rejection tests, README, and project invariants.
- Dependencies: no new runtime dependencies.
