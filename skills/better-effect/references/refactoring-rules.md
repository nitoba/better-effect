# Refactoring rules

Modernize the affected feature, not every plain function in the codebase.
Preserve behavior while improving typed failure, environmental requirements,
and ownership. Use [transformation patterns](transformation-patterns.md) for
concrete changes and the integration reference for its exact public API.

## Inventory before editing

Inspect the whole affected path: manifests/lockfile, framework entrypoint,
Services, Layer graph, external I/O, transactions, workers, and tests. Write down
who owns each pool, client, server, stream, task, and current-user value.
Identify expected domain errors separately from infrastructure failures,
programmer defects, cancellation, and secondary cleanup failures.

Look for eager Effect.gen at module scope; duplicate Runtime roots; cast-away
Layer requirements; constructor plumbing for contextual dependencies; mutable
global request state; duplicate resource release; and Result-returning operations
wrapped in another Result. Also inspect integrations that may already provide
the boundary a custom helper is reimplementing.

## Preserve the model

Contextual infrastructure belongs behind Service tokens, accessed with `yield*`
in the operation that needs it. Keep ordinary inputs such as userId as parameters.
Keep constructors for genuine domain invariants or a native handle intentionally
owned by an instance; do not convert every data value into a contextual Service.

Use Result for expected failure, Effect for Result composition plus requirements,
and Program for lazy execution. Normalize an external rejecting boundary once;
keep already-adapted HTTP/auth/Kysely/MQ Operations directly yieldable. Do not
flatten a transaction error, absent session, provider failure, and programmer
bug into one generic error or a successful undefined.

Generator returns matter: Effect generators return Result; acquisition factories
return raw providers/options. Layer has no E channel. Handle typed startup
failure before Layer.effectDiscard; do not accidentally make a non-terminating
startup Program block readiness.

## Keep dependencies and replacement typed

Stable tags identify contracts, not constructor names, random IDs, or paths.
`Service.of` is structural validation, not runtime construction. Keep native
Kysely/Auth instances and private state intact. Missing Services must remain
visible through inferred E/R and Layer.Required, including requirements exposed
by Service methods and integration callbacks.

Compose with Layer.merge; replace with Layer.override. Preserve inferred Layers
or use satisfies; a broad annotation can erase provider provenance needed by
later overrides. Use Layer.complete at roots and Runtime.For when handing off
an owner. Localize a truly necessary unchecked adapter boundary instead of
spreading `as any`, bare Runtime, or Layer.Any through application code.

## Enforce one owner and the correct lifetime

A typical server has one owning Runtime. Framework callbacks, auth hooks,
workers, HTTP clients, and repositories use its non-owning executor or existing
bridge. A request Layer adds execution-local principal/tenant context without
mutating root providers. Separate Runtimes are for independently owned
environments, not for silencing missing requirements.

Put shared pools in root Layers, transient handles in execution Scopes, and
already-acquired disposables in Effect.add. Borrow facades over a shared pool;
close that pool once after its dependents. Use explicit lifecycle quiesce/drain/
release, not scattered process handlers that race with Runtime shutdown.

Buffered response readiness ends an execution; managed streaming readiness does
not. Keep the Scope alive until streaming completes/cancels. Cooperative abort
cannot undo an external side effect or forcibly terminate an arbitrary Promise.
A process-local scoped task is not a durable job.

## Modernize integrations without changing their contracts

| Existing pattern | Target boundary |
| --- | --- |
| Generic schema wrapper tied to old package name | Native provider + better-effect-schema portable operations; explicit encoding |
| Manual fetch wrappers/retry loops | HttpClient Layer and its single retry/policy boundary |
| Blind POST/SSE replay | Explicit replayability, bounded reconnect, business idempotency |
| Auth API input flags | `.asResponse` / `.withHeaders`; preserve cookies and plugin inference |
| Auth hooks with auxiliary Runtime | Hooks capturing the current executor with explicit failure mapping |
| ORM Proxy or directly yieldable native builder | Kysely `$call` terminals and native transaction callback |
| Re-yield Database inside a native transaction | Use the callback transaction for atomic writes |
| Raw queue adapter used as a second jobs framework | Core Queue/Job/Worker API with adapter Layers |
| Process-local recurring timer expected to survive restart | JobSchedules + JobScheduler + matching durable store |
| Domain commit followed by enqueue | Job.prepare + record-first native outbox transaction + publisher |

Do not migrate to capabilities absent from the installed version. Do not claim
all providers encode, all stores share helper names, or all drivers cancel a
write identically. Retain the selected framework's native validation and error
boundary instead of creating duplicate request parsing helpers.

## Test and stop at the useful boundary

Preserve exact Result errors where promised. Test defect and cleanup paths,
request isolation, startup failure, lazy worker acquisition, disposal ordering,
stream early termination, transaction rollback, and at-least-once retries.
Use explicit test Layers/deterministic standard Services instead of global
container resets. Add type-contract tests for inference and incompatible
providers; use real dialects where query/transaction semantics are the subject.

Pure calculations can remain plain functions, straightforward APIs can remain
Promises, and local failure flows can remain Results. Stop when introducing
another abstraction no longer communicates useful behavior, requirements, or
ownership. Report validation actually performed, not a generic "tests pass".
