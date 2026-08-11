## 1. Scope lifecycle consolidation

- [x] 1.1 Add the internal `src/scope/internal.ts` `runScoped` helper that provides an existing Scope, always closes it, and preserves program-plus-cleanup failures in stable order.
- [x] 1.2 Refactor `Scope.run()` to use `runScoped()` while preserving its create/provide/close API and existing `ScopeRuntime` behavior.
- [x] 1.3 Add or update Scope tests for combined program/cleanup failures, nested context restoration, and the fact that `Scope.provide()` does not close its supplied Scope.

## 2. Runtime execution coordination

- [x] 2.1 Refactor `BuiltLayerImpl.runExecution()` to use `runScoped()` so Runtime execution cleanup has the same error precedence as `Scope.run()`.
- [x] 2.2 Reserve and register each execution Promise before invoking user code, while preserving the existing generic return type and preventing unhandled rejection chains.
- [x] 2.3 Make disposal consume a stable snapshot after transitioning to `disposing`, await all registered executions, close the root Scope under `ServiceRuntime`, dispose the backend last, and retain idempotent failure aggregation.
- [x] 2.4 Keep the existing `CompleteLayer` type validation, `BuiltLayerDisposedError`, Layer-root resource ownership, and DI adapter release boundaries unchanged.

## 3. Regression coverage

- [x] 3.1 Test that Runtime program and execution-cleanup failures are both observable, with the program failure retained first.
- [x] 3.2 Test that disposal initiated before a program’s first yield cannot close or release that execution’s resources before the program settles.
- [x] 3.3 Test new-run rejection during disposal, active-execution waiting, root-finalizer-before-backend ordering, and idempotent concurrent disposal.
- [x] 3.4 Test concurrent execution Scope isolation and preserve existing Resource and ITI lifecycle regression coverage.

## 4. Documentation and verification

- [x] 4.1 Update README.md and AGENTS.md to describe the hardened execution ownership, cleanup error behavior, and graceful shutdown ordering without introducing cancellation or timeout semantics.
- [x] 4.2 Run `bun run check` and `bun pm pack --dry-run`; resolve type, test, lint, formatting, build, and package-inspection failures.
