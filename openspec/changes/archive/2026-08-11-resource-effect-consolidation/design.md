## Context

See `proposal.md` for the motivation. The current `Resource.acquireUseRelease()` implementation already creates a `Scope`, registers cleanup there, and closes that Scope after use; its Result-oriented error and release-precedence behavior is covered by `tests/resource.test.ts`.

The TODO API example still imports and uses `Scope` directly in `Database.run()` to model an execution-local lease. `Database.run()` exposes a `Promise<Result<A, DatabaseFailure>>` contract consumed by repositories through `Result.await(...)`, so the migration must preserve that contract while moving the example's lifecycle expression to `Effect.acquireRelease()`.

## Goals / Non-Goals

**Goals:**

- Confirm that Resource remains implemented on top of Scope and does not grow a second lifecycle mechanism.
- Use `Effect.acquireRelease()` for the TODO API's execution-local database lease without leaking Scope mechanics into the example's application code.
- Preserve Resource's public API, Result error channel, `ResourceReleaseFailure`, release precedence, and automatic disposable support.
- Make the README and example README present Effect/Runtime/Scope as the primary integrated model and Resource as a standalone helper.
- Add regression coverage for any changed example path and for the compatibility guarantees being audited.

**Non-Goals:**

- No `ScopeOutcome`, outcome-aware release callback, transaction policy, `Exit`, `Cause`, cancellation, or new lifecycle primitive.
- No `@deprecated` annotation or removal of Resource exports.
- No changes to `Effect.acquireRelease`, Scope hierarchy, Runtime disposal, Layer semantics, or Effect requirement inference.
- No redesign of Resource to accept Effect programs or Result-returning acquire callbacks beyond its existing API.

## Decisions

### Keep Resource as a compatibility facade, not a wrapper around Effect

Resource will continue to use Scope directly because its standalone contract has intentionally different error semantics: acquisition/use are represented as `Result` values, release failures are normalized as `ResourceReleaseFailure`, and a use failure takes precedence over a release failure. Reimplementing it through `Effect.acquireRelease()` would couple those semantics to Runtime execution and could change the public error type.

The audit should therefore prefer no source change when the existing implementation already satisfies the Scope-backed lifecycle. Any hardening must be local, behavior-preserving, and covered by the existing Resource tests.

### Migrate the TODO API database lease behind its existing Result contract

`Database.run()` will remain a `Promise<Result<A, DatabaseFailure>>` so repositories and their typed Effect requirements do not change. Its internal operation will be expressed with an async `Effect.gen` that yields `Effect.acquireRelease(() => database.sql, () => undefined)` and then executes the user callback.

The example-specific wrapper will continue to normalize unexpected acquisition, context, and callback failures into `DatabaseFailure`, flatten the internal Effect Result, and return the same outer Promise/Result shape. This preserves error handling while removing the direct `Scope.current()`/`scope.acquire()` usage from the example.

Changing every repository to acquire the SQL client itself was considered and rejected: it would duplicate the lease and error policy across repositories and weaken the Database service boundary.

### Reorganize documentation without implying deprecation

The main README will introduce the Effect/Runtime pattern first, then place Resource under a “Standalone resource helper” section that explains when its Result-oriented API is useful and explicitly states that it remains supported. The TODO API README will show `Effect.acquireRelease()` for the database lease and retain a brief compatibility note for standalone Resource usage.

The example facade may continue exporting Resource so existing example imports remain valid; documentation prominence changes, not the public export surface.

### Verify compatibility at the existing boundaries

Keep the current Resource runtime and type tests as the compatibility baseline. Add focused tests for the migrated database operation or example-facing wrapper that assert its Result shape, error normalization, and release timing under a Runtime execution. Use the repository's normal `bun run check` verification; do not add a separate test framework or dependency.

## Risks / Trade-offs

- **The example's database wrapper may accidentally turn a resolved `Result.err` into a rejected Promise** → Keep the internal Effect generator returning a Result and explicitly flatten the outer wrapper; test both success and typed database failure.
- **Moving the README section could make Resource appear deprecated** → Use the “Standalone resource helper” label and state that the API and semantics remain supported with no deprecation marker.
- **The example only has an active Scope inside Runtime executions** → Keep the migration inside `Database.run()` calls made by Runtime-backed services and preserve its existing contextual failure normalization.
- **The Resource audit may tempt lifecycle deduplication that changes error precedence** → Treat current Resource tests and public error types as invariants; avoid sharing Effect cleanup code unless semantics remain identical.

## Migration Plan

1. Audit Resource implementation, tests, exports, and type contracts; make only behavior-preserving hardening changes if needed.
2. Refactor the TODO API database lease to use `Effect.acquireRelease()` behind the existing `Database.run()` Result contract.
3. Update the root and example documentation, then add focused regression coverage.
4. Run `bun run check` and inspect the example-facing changes; resolve any type, formatting, or compatibility failures.

Rollback is a source-only revert. No data, dependency, or package-format migration is required.
