## 1. Disposable Type Contract

- [x] 1.1 Redefine `DisposableResource` so at least one disposal symbol is required while resources implementing either or both protocols remain accepted.
- [x] 1.2 Adapt the internal disposable detector to validate unsafe values without weakening the public type, preserving bound method calls and async-first selection.
- [x] 1.3 Update Scope runtime tests so invalid dynamic values use an explicit unsafe boundary and valid sync/async resources retain current registration, race-cleanup, and failure aggregation behavior.

## 2. Effect.add Implementation

- [x] 2.1 Add the typed async-yieldable `Effect.add(resource)` and delegate registration to the current Scope through the existing better-result normalization pattern.
- [x] 2.2 Add runtime tests for exact-value return, synchronous and asynchronous disposal, async-first preference, final `Result.err`, thrown/rejected programs, and cleanup failure precedence.
- [x] 2.3 Add runtime tests for missing Scope, registration against a closing Scope, immediate disposal, and preservation of simultaneous registration/disposal failures.

## 3. Compile-Time Contracts

- [x] 3.1 Add type tests proving `Effect.add` preserves the concrete resource subtype, exposes `UnhandledException`, and contributes no Service requirements.
- [x] 3.2 Add positive type tests for sync-only, async-only, and dual-protocol resources through both `Scope.add` and `Effect.add`.
- [x] 3.3 Add negative type tests rejecting plain and weakly typed objects that do not statically expose either disposal symbol.

## 4. Documentation and Validation

- [x] 4.1 Document `Effect.add` in README and AGENTS, including its distinction from `Effect.acquireRelease`, missing-Scope ownership constraint, and the narrowed `DisposableResource` migration note.
- [x] 4.2 Review the TODO API and add an example only if it has a genuine disposable execution resource; do not manufacture a no-op disposer for demonstration.
- [x] 4.3 Run focused Effect/Scope/type tests, `bun run check`, and `bun pm pack --dry-run`.
