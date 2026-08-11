## 1. Resource audit and compatibility

- [x] 1.1 Review `src/resource` and confirm acquisition, finalizer registration, Scope closure, disposable fallback, and error normalization remain implemented through the existing Scope lifecycle.
- [x] 1.2 Add or strengthen Resource runtime/type coverage for successful use, Result errors, thrown/rejected use, release failures, release precedence, and automatic disposal without changing the public contract.
- [x] 1.3 Verify Resource exports and `ResourceReleaseFailure` remain unchanged and add no deprecation marker or replacement API.

## 2. TODO API migration

- [x] 2.1 Refactor `examples/todo-api/database.ts` so `Database.run()` uses `Effect.acquireRelease()` inside an async `Effect.gen` while preserving its `Promise<Result<A, DatabaseFailure>>` signature and error normalization.
- [x] 2.2 Remove the example's direct `Scope.current()`/`scope.acquire()` lease implementation and preserve the Runtime-owned execution/root lifetime boundary.
- [x] 2.3 Add focused regression coverage for the migrated database operation, including successful use, typed `DatabaseFailure`, and release completion under an active Scope/Runtime execution.
- [x] 2.4 Update the TODO API primitive documentation and snippets to demonstrate `Effect.acquireRelease()` for execution-local resources.

## 3. Documentation consolidation

- [x] 3.1 Reorganize the root README so the integrated Effect/Runtime/Scope pattern is primary and Resource appears under a clearly labeled “Standalone resource helper” section.
- [x] 3.2 Explain why Resource remains supported, including its Result-oriented error and release-precedence semantics, without implying deprecation.
- [x] 3.3 Update any comparison tables, primitive summaries, and example links affected by the documentation reorganization.

## 4. Verification

- [x] 4.1 Run `bun run check` and resolve implementation, test, type, lint, formatting, build, or publint failures.
- [x] 4.2 Perform a focused type/runtime smoke check for `examples/todo-api` and confirm no new dependency or public export changes were introduced.
