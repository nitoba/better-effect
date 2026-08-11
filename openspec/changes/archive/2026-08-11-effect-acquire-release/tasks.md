## 1. Effect API implementation

- [x] 1.1 Add the internal `Effect.acquireRelease` yieldable with an exact generic resource type, using the current Scope and `Scope.acquire()` for lifecycle ownership.
- [x] 1.2 Normalize synchronous and asynchronous acquisition failures through `Result.tryPromise` and `Result.await`, exposing `UnhandledException` without registering a release finalizer on failure.
- [x] 1.3 Expose `acquireRelease` through the existing `Effect` export/object pattern while preserving Service-only `EffectRequirements`, async-generator compatibility, and existing APIs.
- [x] 1.4 Keep release callbacks as Scope finalizers, including the existing cleanup/error-precedence semantics; do not modify Resource or add outcome-aware lifecycle machinery.

## 2. Runtime behavior tests

- [x] 2.1 Test successful acquisition through `Effect.gen` and verify the release runs exactly once when the owning Scope or Runtime execution closes.
- [x] 2.2 Test that release still runs after an Effect Result error, a thrown program error, and a rejected program promise.
- [x] 2.3 Test synchronous and rejected acquisition failures, including `UnhandledException` normalization, no release invocation, and the existing missing-Scope failure.
- [x] 2.4 Test release failures through the existing Scope/Runtime cleanup path, including preservation of program failure precedence.

## 3. Type-level coverage

- [x] 3.1 Add exact inference coverage for the yielded resource and `EffectSuccess` of `Effect.acquireRelease`.
- [x] 3.2 Assert that acquisition errors include `UnhandledException` and that a program using only `acquireRelease` has `EffectRequirements` of `never`.
- [x] 3.3 Assert that `acquireRelease` composes with Service yields by unioning requirements and errors without introducing a Scope requirement.

## 4. Documentation and verification

- [x] 4.1 Document the `Effect.acquireRelease` example, async-only usage, and the fact that release remains Scope cleanup; leave Resource status and deferred APIs unchanged.
- [x] 4.2 Run `bun run check` and `bun pm pack --dry-run`, resolving any implementation, type, formatting, or package-surface failures.
