## 1. Hierarchical Scope core

- [x] 1.1 Extend `Scope` with parent/child ownership, `fork()`, and child detachment on close while preserving the existing closed-scope checks.
- [x] 1.2 Refactor Scope closure to snapshot and close active children before the scope’s own LIFO finalizers, continue after failures, and preserve idempotent concurrent close behavior.
- [x] 1.3 Add `Scope.provide()` as a non-owning context boundary and refactor `Scope.run()` to use it while preserving program/cleanup failure precedence and aggregation.

## 2. Runtime lifecycle integration

- [x] 2.1 Change BuiltLayer execution to fork a child Scope from the root Scope, provide that child to the program, and close it before the execution promise settles on success or failure.
- [x] 2.2 Add active execution tracking and an explicit active/disposing/disposed state so new runs are rejected once disposal starts without creating unhandled promise rejections.
- [x] 2.3 Make disposal wait for active executions, then close the root Scope, then run backend cleanup, aggregate failures, and share the same disposal promise across repeated calls.
- [x] 2.4 Verify Layer provider acquisition remains bound to the root Scope and that DI adapters/backends do not regain responsibility for provider release.

## 3. Behavioral and type regression coverage

- [x] 3.1 Add Scope tests for fork ownership, child detach, parent-before-own-finalizer ordering, child/finalizer failure aggregation, and concurrent idempotent close.
- [x] 3.2 Add tests for `Scope.provide()` non-ownership and `Scope.run()` cleanup on both success and failure, including combined program and cleanup failures.
- [x] 3.3 Add Layer/Runtime tests for isolated concurrent execution scopes, execution cleanup, Layer resource survival between runs, graceful disposal waiting, and rejection of new runs during disposal.
- [x] 3.4 Add or update type tests proving contextual Scope access remains excluded from `EffectRequirements`.
- [x] 3.5 Run the existing Resource, adapter, and full test suites to confirm no public Resource or DI lifecycle semantics regress.

## 4. Documentation and verification

- [x] 4.1 Update README and project lifecycle guidance to document child execution scopes, `Scope.provide()`, and graceful Runtime disposal without introducing a ManagedRuntime abstraction.
- [x] 4.2 Run `bun run check` and resolve formatting, lint, typecheck, build, package, and test failures.
