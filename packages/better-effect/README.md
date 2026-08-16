# better-effect

**Effect-like dependency safety for better-result.**

Type your errors with `better-result`. Typecheck the rest of your application wiring with `better-effect`.

Use Services directly inside `Effect.gen`, compose implementations into application environments, and let TypeScript catch missing dependencies before your application starts — while keeping Promises, `better-result`, and your DI backend.

```bash
bun add better-effect better-result
```

## TypeScript knows what your application needs

```ts
import { Result } from 'better-result'
import { Effect, Layer, Runtime, Service } from 'better-effect'

class Database extends Service<Database>()('Database') {
  findUser(id: string) {
    // ...
  }
}

class UserRepository extends Service<UserRepository>()('UserRepository') {
  findUser(id: string) {
    return Effect.gen(async function* () {
      const database = yield* Database

      return Result.ok(await database.findUser(id))
    })
  }
}

const UserRepositoryLive = Layer.make(UserRepository)

await Runtime.make(UserRepositoryLive, backend)
//                 ^^^^^^^^^^^^^^^^^^
// Type error: Database is required but not provided
```

The explicit self type keeps `yield*` inference exact, while the non-empty
literal is the Service's stable logical identity. Services with identical
methods but different tags are different dependencies; use a namespaced tag
such as `@acme/Database` when identities must be shared across packages.

`UserRepository` used `Database`, so `Database` became part of its environment requirements.

No dependency list was written manually.

Services can also describe a contract without requiring a class instance. Use the
static `of` helper to type-check a structural implementation; it returns the same
object unchanged at runtime:

```ts
class Authorization extends Service<Authorization>()('Authorization') {
  declare readonly authorize: (token: string) => Promise<boolean>
}

const authorization = Authorization.of({
  authorize: async (token) => token.length > 0
})

const AuthorizationLive = Layer.succeed(Authorization, authorization)
```

`Authorization.of(...)` does not call a constructor or make the result an
`instanceof Authorization`. For services with constructors, private fields or
other runtime invariants, use `new Authorization(...)` instead.

Provide it and the environment becomes complete:

```ts
const DatabaseLive = Layer.make(Database)

const AppLive = Layer.merge(DatabaseLive, UserRepositoryLive)

const runtime = await Runtime.make(AppLive, backend)
```

And the contract does not disappear after startup.

A Runtime also knows which Services exist in its environment:

```ts
await runtime.run(() =>
  Effect.gen(async function* () {
    const database = yield* Database

    return Result.ok(database)
  })
)
```

If a program asks that Runtime for a Service its environment does not provide, TypeScript rejects the call.

```text
yield* Database
      │
      ▼
program requires Database
      │
      ▼
Layer provides Database?
      │
   no ├──────────► TypeScript error
      │
     yes
      ▼
Runtime can execute it
```

We call this **typechecked wiring**.

The Services your code uses, the implementations your Layers provide, and the programs your Runtime executes participate in the same type-level contract.

### Discover type helpers from their API

Public type helpers are also grouped under the runtime API they describe:

```ts
import type { Effect, Layer, Runtime, Scope, Service } from 'better-effect'

type Program = ReturnType<UserRepository['findUser']>
type Success = Effect.Success<Program>
type Failure = Effect.Error<Program>
type Dependencies = Effect.Requirements<Program>
type Services = Layer.Provided<typeof AppLive>
type AppRuntime = Runtime.For<typeof AppLive>
type DatabaseTag = Service.Tag<typeof Database>
type Outcome = Scope.Outcome
```

These are declaration-only aliases and add nothing to the JavaScript bundle.
The existing prefixed spellings—including `EffectSuccess`,
`EffectRequirements`, `LayerProvided`, `RuntimeFor`, `ServiceTag` and
`ScopeOutcome`—remain public and are not deprecated.

---

## Why better-effect?

`better-result` already gives TypeScript applications an excellent model for typed failures.

But typed errors are only one part of a growing application.

Eventually you also need to answer:

- What does this service depend on?
- Did the application provide every dependency?
- Can this program run in this environment?
- How do I replace implementations in tests?
- Who owns this database connection?
- When should this resource be released?

Those problems are often discovered through container errors, startup failures, test setup, or manual composition-root maintenance.

Effect has powerful ideas for solving them.

`better-effect` explores a smaller path:

**keep `better-result`, Promises and normal TypeScript — borrow the architectural ideas that make dependencies and resource lifetimes easier to reason about.**

### Know your dependencies before runtime

Services can be requested directly:

```ts
const database = yield * Database
```

That access is also captured by the type system.

Layers know both what they provide and what their Services require. Incomplete environments can therefore fail during typechecking instead of application startup.

Runtime keeps that environment information and checks programs against it when they run.

### Compose application environments

Layers describe implementations without making your application code depend on a specific DI container.

```ts
const AppLive = Layer.merge(DatabaseLive, UserRepositoryLive, AuthServiceLive)
```

Testing can replace implementations explicitly:

```ts
const AppTest = Layer.override(AppLive, DatabaseTest)
```

The environment contract remains typed after the override.

### Own resource lifetimes

Some dependencies are values.

Others own connections, sessions, files or other resources.

`Layer.scoped`, `Layer.scopedGen`, `Effect.acquireRelease`, `Effect.add` and `Scope` make their lifetime explicit.

```ts
const DatabaseLive = Layer.scoped(
  Database,
  () => Database.connect(),
  (database) => database.close()
)
```

Runtime owns the application lifetime and safely releases scoped resources when that lifetime ends.

Resources acquired during an individual execution belong to that execution instead.

### Keep your runtime choices

`better-effect` is not a replacement implementation of Effect.

It does not introduce a fiber runtime, scheduler, streams, queues or a public `Effect<A, E, R>` abstraction.

`Effect.gen` builds on `better-result` generator composition while carrying Service requirements through the TypeScript type system.

Dependency resolution stays behind a pluggable backend.

Your application can keep using ordinary Promises and existing libraries.

---

## How it compares

|                               | better-result | better-effect       | Effect          |
| ----------------------------- | ------------- | ------------------- | --------------- |
| Typed success/failure         | ✓             | ✓ via better-result | ✓               |
| Generator composition         | ✓             | ✓                   | ✓               |
| Contextual Services           | —             | ✓                   | ✓               |
| Dependency requirements       | —             | ✓                   | ✓               |
| Checked environments          | —             | ✓                   | ✓               |
| Scoped resource lifetimes     | —             | ✓                   | ✓               |
| Pluggable external DI backend | —             | ✓                   | different model |
| Fiber runtime                 | —             | —                   | ✓               |
| Structured concurrency        | —             | —                   | ✓               |
| Streams / queues / schedules  | —             | —                   | ✓               |
| Full effect ecosystem         | —             | —                   | ✓               |

### Choose `better-result`

When typed error handling and Result composition are enough.

### Add `better-effect`

When your Result-based application also needs contextual Services, typechecked application wiring, composable environments, or resource lifetime management.

### Choose Effect

When you want a complete effect system and its runtime, concurrency model, dependency model, resource management and broader ecosystem.

`better-effect` is inspired by some of those ideas. It is intentionally not a reimplementation of the whole system.

---

## Core ideas

### Typechecked wiring

**Service requirements → Layer completeness → Runtime validation**

Use a Service and its requirement follows the program.

Build an incomplete environment and TypeScript tells you what is missing.

Run a program against an incompatible Runtime and the mismatch remains visible at compile time.

### Composable environments

**Layer → merge → override → DI backend**

Describe application implementations independently from the container responsible for resolving them.

Compose production environments and replace selected implementations for tests.

### Scoped lifetimes

**Scope → scoped Layers → acquire/release → graceful Runtime disposal**

Make ownership explicit for resources that need cleanup.

Application resources live with the Runtime. Execution resources live with the execution.

### better-result underneath

**Result → Result.gen → Effect.gen → pipe**

Keep `better-result` as the source of truth for typed successes, failures, short-circuiting
and generator control flow. `Effect.gen` delegates to `Result.gen`; it adds only the
phantom Service requirements that TypeScript needs to check the application environment.
At runtime, an `EffectResult` is still a `better-result` Result; the requirements exist
only in the type.

For a linear workflow, `pipe` composes the same kind of program without introducing a
second Result model or a lazy Effect runtime:

```ts
import { Effect, pipe } from 'better-effect'

const program = pipe(
  findUser(id),
  Effect.map((user: User) => user.email),
  Effect.andThen(loadPermissions),
  Effect.mapError((cause: LoadUserError | PermissionError) => new ApplicationError({ cause }))
)
```

The combinators keep the `better-result` semantics: `Effect.map` changes the success
type, `Effect.mapError` changes the error type, and `Effect.andThen` only calls the next
step after an `Ok`. Use `Effect.andThenAsync` when the next operation returns a
`Promise<Result>`; it always returns a Promise, including when the source is synchronous
or already an `Err`. The pipeline carries the requirements of every step, so Runtime
still rejects it when its Layer does not provide every required Service.

Use `Effect.gen` for larger workflows with several intermediate values, branches or
procedural logic. Use `pipe` for concise, linear composition; both are ways to compose
`better-result` programs while keeping dependency checking in the `better-effect` layer.
