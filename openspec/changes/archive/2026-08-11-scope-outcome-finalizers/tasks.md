## 1. Scope ownership and public contracts

- [x] 1.1 Split the public contextual `Scope` capability from owning
      `CloseableScope`; make `Scope.current()` and `yield* Scope` expose only the
      non-owning type while `Scope.make()` and `fork()` return the owning type.
- [x] 1.2 Add immutable `ScopeOutcome`, `ScopeFinalizer`,
      `CleanupFailureDiagnostic`, `RuntimeShutdownDiagnostic`, and observer types
      with required outcome parameters and no `better-result` import in
      `src/scope/**`.
- [x] 1.3 Add `RuntimeOptions` and export the new public lifecycle types
      through the Scope, Runtime, layer, and package entry points without exposing
      the internal boundary helper.

## 2. Scope closure and boundary semantics

- [x] 2.1 Make `CloseableScope.close(outcome?)` default to success, record the
      first outcome, share one Promise across concurrent callers, and propagate the
      chosen outcome to still-attached children.
- [x] 2.2 Pass outcomes to finalizers and resource release callbacks while
      retaining child detachment, child-first/LIFO ordering, immediate cleanup
      during races, and idempotent closure.
- [x] 2.3 Flatten nested child `ScopeCloseError` causes into one parent error
      while continuing all cleanup attempts.
- [x] 2.4 Generalize `runScoped` to accept only an owning Scope, inject a
      classifier and optional observer, then implement program-failure/cleanup-
      failure precedence and best-effort observer notification.
- [x] 2.5 Keep `Scope.run` Result-agnostic by using an always-successful
      classifier, verify `Scope.provide` remains non-owning, and ensure current
      contextual Scopes cannot close themselves through their public type.

## 3. Runtime outcome and shutdown integration

- [x] 3.1 Add the Runtime-only Result classifier for plain values, `Result.ok`,
      `Result.err`, and thrown/rejected program causes.
- [x] 3.2 Thread the classifier and cleanup observer through Runtime execution
      boundaries so child Scopes close before execution promises settle.
- [x] 3.3 Add optional cleanup observer options to layer building and Runtime
      construction while preserving complete-layer generic validation.
- [x] 3.4 Implement one-shot shutdown capture: close execution and root Scopes
      with the final program outcome, always attempt backend disposal, and preserve
      failed-program precedence over root/backend cleanup failures.
- [x] 3.5 Aggregate root `ScopeCloseError` and backend failures into one
      `LayerDisposeError` in cleanup order, expose it for successful programs, and
      send it through the shutdown diagnostic for failed programs.
- [x] 3.6 Preserve active-execution registration and graceful disposal ordering;
      close long-lived roots with success, keep root finalizers inside
      `ServiceRuntime`, and close partial build roots with the registration failure
      before backend cleanup.
- [x] 3.7 Keep execution failures out of disposal failures and preserve
      idempotent disposal, backend-last cleanup, and rejection of new executions.

## 4. Effect acquireRelease integration

- [x] 4.1 Require `Effect.acquireRelease` release callbacks to receive the final
      `ScopeOutcome` while keeping acquisition, error normalization, and Scope
      requirements unchanged.
- [x] 4.2 Add type coverage for outcome-aware and legacy release callbacks,
      preserving acquired-value and Effect error inference.

## 5. Verification tests

- [x] 5.1 Extend Scope tests for CloseableScope ownership, default success,
      explicit failure, first-close wins, parent propagation, already-closed child
      precedence, finalizer order, and flattened cleanup causes.
- [x] 5.2 Add boundary tests for plain values, `Result.ok`, `Result.err`, exact
      thrown exceptions, cleanup-only failures, suppressed cleanup diagnostics,
      observer isolation, and intermediate error recovery.
- [x] 5.3 Add the semantic split tests: `Scope.run(() => Result.err(x))` gives
      finalizers success, while Runtime execution gives failure; current contextual
      Scope types do not expose `close()`.
- [x] 5.4 Extend Runtime/layer tests for execution outcomes, observer delivery,
      root outcome differences between one-shot and long-lived runtimes, build
      failure cleanup, ServiceRuntime availability during root finalizers, graceful
      shutdown, and backend ordering.
- [x] 5.5 Add one-shot precedence tests for Result error/exception plus root
      cleanup failure, successful program plus cleanup failure, and simultaneous
      root/backend failures preserving both causes.
- [x] 5.6 Update existing expectations that relied on program-plus-cleanup
      `AggregateError` and add regression coverage for Resource compatibility.
- [x] 5.7 Add type tests for `ScopeOutcome`, `CloseableScope`, diagnostic
      unions, Runtime options, and callback compatibility.

## 6. Documentation and validation

- [x] 6.1 Document Scope versus CloseableScope ownership, ScopeOutcome,
      cleanup precedence, observer diagnostics, transaction-style release
      callbacks, one-shot root/backend semantics, and long-lived root semantics in
      README, AGENTS.md, and CODEX_HANDOFF.md.
- [x] 6.2 Run `bun run check`, `bun pm pack --dry-run`, and the OpenSpec strict
      validator; resolve type, lint, format, test, build, and package-contract
      failures before marking the change complete.
