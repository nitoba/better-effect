# AGENTS.md

## Project overview

`better-effect` is a lightweight TypeScript library that adds a small set of Effect-inspired primitives around `better-result`.

The library currently has six core concepts:

- `Effect` — Result-oriented generator and composition primitives with typed Service requirements
- `Runtime` — Effect execution, Layer provisioning, and graceful lifecycle ownership
- `Service` — contextual dependency access through `yield*`
- `Layer` — declarative environment/provider composition
- `Scope` — contextual lifecycle and finalizer management
- `Resource` — acquire/use/release lifecycle with typed Result errors

Dependency injection itself is intentionally delegated to adapters such as ITI.

This project must remain substantially smaller and simpler than Effect.

## Commands

Use Bun for package management and tests.

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run lint
bun run format:check
bun run build
bun run publint
bun run check
```

Before considering a change complete, run:

```bash
bun run check
```

Do not introduce Vitest, Jest, pnpm, npm workspaces or another test/package manager unless the task explicitly requires it.

## Repository structure

Expected high-level structure:

```text
src/
├── service/
├── layer/
├── resource/
├── adapters/
└── index.ts

tests/
├── helpers/
├── types/
└── *.test.ts

examples/
└── todo-api/
```

Keep implementation details close to their primitive.

Do not move DI-specific code into `service/` or `layer/`. Container integrations belong in `src/adapters/`.

## Core architectural invariants

### Service

A Service class is simultaneously:

1. a class/implementation type;
2. a runtime dependency token;
3. a yieldable dependency handle.

Services are declared using an explicit self type and a non-empty literal tag:

```ts
class AuthService extends Service<AuthService>()('AuthService') {}
```

The class constructor remains the ergonomic runtime token and Layer handle. The
literal `serviceTag` is the stable logical identity used by Layer composition
and dependency backends. The self type anchors exact instance inference. Every
Service instance carries a required, declaration-only `ServiceIdentity<Tag>`;
that marker emits no runtime property. Public Effect, Layer and Runtime
environments use unions of those tagged instances, while constructors remain
resolver tokens.

Structural implementations pass through `ServiceContract<S>`, which removes
the inaccessible identity marker. `Service.of` and every Layer provider API
accept that marker-free contract and return or provide the branded Service
type without adding runtime metadata.

A Service should resolve like:

```ts
const auth = yield * AuthService
```

and `auth` must be inferred exactly as `AuthService`.

### ServiceResolver

The resolver relationship must be derived from the token.

The intended shape is:

```ts
resolve<T extends AnyServiceToken>(
  token: T
):
  | InstanceType<T>
  | PromiseLike<InstanceType<T>>
```

Do not use an unrelated generic result parameter such as:

```ts
resolve<A>(token: AnyServiceToken): A
```

That weakens the token → instance relationship and causes generic assignability problems.

### ServiceRuntime

`ServiceRuntime` is only a bridge to the currently configured resolver.

It must not:

- import ITI;
- create services;
- cache instances;
- manage provider graphs;
- know Layer implementations.

Keep it container-agnostic.

### DI adapters

Adapters own container-specific translation.

For example, ITI may require internal string identifiers. That translation must remain inside the ITI adapter.

The core must continue to use the class constructor as the Service handle and
resolver token. DI backends may translate its `serviceTag` to container-local
keys, but those keys must not leak into core APIs.

Do not leak ITI types or identifiers into:

- `Service`
- `ServiceRuntime`
- `Layer`
- application services

### Layer

Layer is a declarative collection of providers.

It is intentionally not Effect's full:

```ts
Layer<ROut, E, RIn>
```

Do not add typed dependency graphs, Context, Fiber, full Effect-style Scope strategies or MemoMap unless there is a concrete approved requirement.

The initial public API is deliberately small:

```ts
Layer.make(...)
Layer.succeed(...)
Layer.scoped(...)
Layer.gen(...)
Layer.scopedGen(...)
Layer.merge(...)
Layer.override(...)
```

`Layer.merge` must reject duplicate Service tags.

`Layer.override` is the explicit mechanism for intentional replacement.

Overrides with the same tag and bidirectionally compatible instance contracts
replace the prior provider. An incompatible same-tag override carries a typed
collision diagnostic and MUST NOT pass a complete-Layer boundary. Runtime
backends retain the registering constructor and perform a best-effort member
check when a different constructor is requested for the same tag.

Service identity comparisons must use the literal tag:

```ts
provider.service.serviceTag === Database.serviceTag
```

not a diagnostic-only constructor name:

```ts
provider.service.name === 'Database'
```

Public Layer metadata exposes provided and required Service instance unions.
A private LayerSpec token channel retains the exact registering constructor for
registration, replacement and collision diagnostics; `name` may be used for
diagnostics only.

### Layer type erasure

A Layer stores heterogeneous providers.

It is acceptable for the internal stored provider representation to erase the concrete instance type to `unknown`.

Type safety must be enforced at the public creation boundary:

```ts
Layer.make(Database, () => new Database())

Layer.scoped(
  Database,
  () => new Database(),
  (database) => database.close()
)
```

Keep casts localized at the internal type-erasure boundary.

Do not build a complex generic tuple/union system merely to remove a safe internal cast.

`Layer.scoped` intentionally keeps its compatibility-friendly release callback shape
`(instance) => ...`. The internal `LayerProvider` normalizes that callback to its
outcome-aware `(instance, outcome) => ...` form, but `Layer.scoped` does not expose the
`ScopeOutcome`. Use `Layer.scopedGen` when acquisition needs contextual Services and
release logic needs the final `ScopeOutcome`; its callback explicitly receives both
`(instance, outcome)`.

### Typed execution requirements

Every typed execution boundary (`RuntimeHandle.run`, managed `Runtime.run`, and
one-shot `Runtime.run`) MUST validate the final `EffectRequirements` of its
program against the tagged Service instance union provided by its Layer. The
inferred Runtime and RuntimeHandle values retain that union; unparameterized
annotations intentionally erase it as an explicit unchecked escape hatch.
Unavailable requirements must appear through the package-private named
`MissingDependencies<Missing>` diagnostic, not underscored diagnostic members.

Use `Runtime.For<typeof AppLive>` when a Runtime inferred from a concrete Layer
must be named in an application boundary. It is a type-only alias for
`Runtime<Layer.Provided<typeof AppLive>>` and must preserve the same execution
checks. The compatible top-level spellings `RuntimeFor<typeof AppLive>` and
`LayerProvided<typeof AppLive>` remain public and equivalent.

### Scope

`Scope` is the lifecycle primitive.

DI backends must not own Service release semantics.

Resources created by `Layer.scoped` and `Layer.scopedGen` belong to the Runtime root
Scope. `Layer.scopedGen` may yield contextual Services during acquisition, and its
release callback receives the root `ScopeOutcome`.

Resources acquired inside `runtime.run` belong to that execution's Scope.

`Scope` must not become a Service requirement.

Scopes are hierarchical: `Scope.fork()` creates a child owned by the parent until the
child closes, and parent closure closes still-attached children before its own
finalizers. `Scope.provide()` supplies an existing Scope without closing it; `Scope.run`
owns the Scope it creates.

The contextual `Scope` capability is non-owning. `Scope.current()` and `yield* Scope`
expose acquisition, finalizer registration, and child creation, but not `close()`.
`Scope.make()` and `fork()` return `CloseableScope`, whose owner is responsible for
closure. `ScopeOutcome` is either `{ status: 'success' }` or
`{ status: 'failure', cause: unknown }`; finalizers and release callbacks receive the
chosen outcome. Scope itself must remain independent of `better-result`.

Runtime executions must use child Scopes of the Runtime root. Runtime disposal is
graceful: reject new runs, wait for active runs, close the root Scope, then perform
backend cleanup. Do not add a separate ManagedRuntime abstraction for this lifecycle.

`Resource` remains a compatibility facade over Scope until explicitly deprecated.

`Effect.add(resource)` registers an already-acquired disposable object in the current
Scope and yields that same object. It must not acquire the resource or create a Scope;
without a current Scope it preserves the existing missing-Scope failure. Prefer
`Effect.acquireRelease` when acquisition is part of the Effect or cleanup needs an
explicit callback and `ScopeOutcome`.

`DisposableResource` requires a callable `Symbol.dispose` or `Symbol.asyncDispose`.
Plain or weakly typed values must be narrowed before `Scope.add` or `Effect.add`,
although runtime validation still rejects unsafe values without either protocol.

Never register `LayerProvider.release` directly into a DI container disposer.

### Scope hierarchy

An execution MUST be registered as active before its program callback can run. Its child
Scope MUST remain open until the program settles, including when disposal is initiated
re-entrantly before the program yields. The final outcome is classified only at the
execution boundary: plain values and `Result.ok` are success, `Result.err` is failure,
and thrown/rejected causes are failure. Intermediate Results MUST NOT change Scope state.
If both the program and child cleanup fail, the exact program failure remains primary;
cleanup is preserved in one best-effort diagnostic when an observer is configured.

Scope closure is child-first and LIFO. The first `CloseableScope.close(outcome?)` call
fixes the outcome and later calls share the same Promise. Parent closure propagates its
outcome to still-attached children, and nested `ScopeCloseError` causes are flattened.

Cleanup observers are boundary concerns: direct `Scope.close()` MUST NOT invoke one.
Execution and Runtime shutdown boundaries may notify once with an aggregated diagnostic;
observer failures are ignored and never alter the primary result. The precedence is:

```text
program failure > cleanup failure > program success
```

### Graceful Runtime disposal

`runtime.dispose()` MUST transition to disposing before awaiting work, reject new
executions, await the active execution snapshot, close the root Scope, and dispose the
backend last. Execution failures MUST NOT prevent root or backend cleanup. Repeated
disposal calls share one outcome. No cancellation, timeout, Fiber, or forced-shutdown
machinery should be introduced for this behavior.

One-shot `Runtime.run` closes its execution and root Scopes with the complete final
outcome, then always attempts backend disposal. Root and backend failures are aggregated
in that order. A failed program preserves its exact exception or `Result.err`; a
successful program exposes shutdown cleanup failure. A long-lived Runtime closes its
root with success regardless of earlier execution outcomes.

### Resource

`Resource.acquireUseRelease()` must always attempt release after successful acquisition, including when:

- `use` returns `Err`;
- `use` throws;
- `use` rejects.

Do not implement `use` with a short-circuiting `yield*` that can skip release.

The error precedence is intentional:

```text
1. error from use
2. error from release
3. successful value from use
```

If both `use` and `release` fail, preserve the `use` error.

If explicit `release` is omitted, resource disposal should prefer:

```ts
Symbol.asyncDispose
```

then:

```ts
Symbol.dispose
```

Unexpected exceptions/rejections are normalized using `better-result`'s `UnhandledException` behavior.

### better-result

Do not recreate Result, Either or generator error propagation.

Use `better-result` as the source of truth for:

- `Result`
- `Result.gen`
- `Result.await`
- `TaggedError`
- `UnhandledException`

The public TypeScript peer range starts at 5.7. The package and declaration
fixtures MUST support TypeScript 5.7.2 and the current project compiler. The
phantom Service-requirement types do not require TypeScript 7.

Every `Result.gen` generator must finish by returning a `Result`.

Prefer:

```ts
const value = yield * Result.await(operation())

return Result.ok(value)
```

Do not assume a raw value can be returned from `Result.gen`.

### Effect type

The public `Effect<A, E, R extends Service.Any = never>` is a type-only facade
over a `better-result` Result. `R` is a tagged Service instance union. It MUST
NOT become a lazy instruction tree, runtime Effect representation, Context,
Fiber or scheduler abstraction. Constructors remain the values yielded and
resolved at runtime; only their instance types enter public requirement
metadata.

### Pipelines

Pipeline combinators MUST preserve `EffectRequirements` metadata.

Chaining two Effect programs MUST union both requirement sets and both error types.

Pipeline combinators MUST delegate Result semantics and short-circuiting to
`better-result`.

`pipe` MUST remain generic and unaware of Effect, Result, Promise, Scope or Service.

Do not introduce prototype-based Pipeable APIs, `.pipe()` methods, or runtime metadata
solely for carrying Effect requirements.

## Testing

Use `bun:test`.

Runtime tests belong in:

```text
tests/*.test.ts
```

Compile-time/type-contract tests belong in:

```text
tests/types/
```

Type inference is part of the public API and must be tested.

Important contracts include:

```ts
const service = yield * AuthService
// exactly AuthService

const service = await ServiceRuntime.resolve(AuthService)
// exactly AuthService
```

Use `expectTypeOf(...).toEqualTypeOf<T>()` when exact equality is the behavior being protected.

Use `toMatchTypeOf<T>()` only when testing that one type satisfies a broader contract.

`ServiceRuntime` uses `AsyncLocalStorage`. Tests should enter resolver context through
`ServiceRuntime.run()` or a Runtime execution boundary and verify that the context is
restored afterward. Concurrent runtimes are expected to remain isolated; no global reset
or serial-test discipline is required for resolver context.

### Resolver test doubles

Do not implement a fake generic resolver that always returns one concrete class.

Prefer a Map-backed resolver keyed by the Service handle (the resolver itself
may use tags internally):

```ts
Map<AnyServiceToken, unknown>
```

and cast only at the lookup boundary to `InstanceType<T>`.

This accurately models the resolver contract and avoids invalid generic assumptions.

## Public API

Treat exports from `src/index.ts` and package subpath exports as public API.

Before adding an export, ask whether consumers genuinely need it.

Internal helpers should remain internal.

In particular, avoid exporting low-level Resource implementation helpers such as:

- `runResult`
- `runRelease`
- `combineUseAndRelease`
- `disposeResource`

unless there is a demonstrated public use case.

## Examples

`examples/todo-api` is an executable integration example and should remain representative of the recommended architecture.

When changing Service, Layer, Resource or adapters, update the example if the public usage changes.

Do not move business logic into the DI container.

Recommended shape:

```text
AuthService
    ↓ yield*
UserRepository
    ↓ yield*
Database
```

Layers describe implementations; services contain behavior.

## Dependency policy

Avoid new runtime dependencies unless they are essential.

`better-result` is the foundational Result dependency.

Container libraries such as ITI should remain optional integrations.

Before adding a dependency, check whether:

1. the platform already provides the capability;
2. Bun already provides the capability;
3. the feature belongs in an adapter instead of core;
4. a small implementation is safer than adding a dependency.

Do not add Effect as a dependency.

## Style

Follow the repository's Oxfmt output.

Do not manually fight the formatter.

Use `import type` for type-only imports.

Prefer small modules with clear responsibility.

Avoid comments that merely restate the code. Comments should explain non-obvious architectural or semantic choices.

Keep APIs explicit and unsurprising.

## CI and release

CI must pass before publishing:

```text
typecheck
lint
format check
tests
build
publint
package inspection
```

The npm release workflow uses Trusted Publishing/OIDC.

Do not add a long-lived `NPM_TOKEN` secret when Trusted Publishing is available.

Release tags use:

```text
v<package-version>
```

Example:

```text
package.json: 0.1.3
GitHub Release tag: v0.1.3
```

The publish workflow must reject mismatched package and tag versions.

## Change discipline

For public API changes:

1. update implementation;
2. update runtime tests;
3. update type tests;
4. update examples;
5. update README;
6. run `bun run check`.

Do not expand abstractions speculatively.

Prefer the smallest addition that solves the demonstrated problem.
