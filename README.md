# better-effect

Lightweight Effect-inspired primitives built around [`better-result`](https://www.npmjs.com/package/better-result).

`better-effect` focuses on a small set of ideas that are useful in application code without bringing in a full effect runtime:

- **Service** — contextual dependency access with `yield*`
- **Layer** — declarative composition of live/test environments
- **Resource** — safe acquire/use/release lifecycle
- **DI adapters** — dependency resolution is delegated to an external container instead of being reimplemented by the library

The goal is not to recreate Effect. The goal is to provide a small, composable layer on top of `better-result`.

## Installation

```bash
bun add better-effect better-result
```

If you want the ITI adapter:

```bash
bun add iti
```

## Service

A service is a class that also acts as its own dependency token.

```ts
import { Result } from "better-result";
import { Service } from "better-effect";

export class Database extends Service<Database>() {
  findUser(email: string) {
    return Promise.resolve({
      id: "1",
      email,
    });
  }
}

export class UserRepository extends Service<UserRepository>() {
  findByEmail(email: string) {
    return Result.gen(async function* () {
      const database = yield* Database;

      const user = await database.findUser(email);

      return Result.ok(user);
    });
  }
}
```

There are no string tokens:

```ts
const database = yield * Database;
```

The class itself is the identity used by the resolver, and the result is inferred as `Database`.

### Why classes are tokens

Using constructors directly avoids duplicated identifiers such as:

```ts
Service<AuthService>()("authService");
```

and prevents string-key collisions or typos.

Conceptually:

```text
yield* AuthService
        │
        ▼
ServiceRuntime
        │
        ▼
ServiceResolver
        │
        ▼
AuthService instance
```

## Layer

A Layer describes which implementations form an application environment.

It does **not** implement dependency resolution. That remains the responsibility of the configured backend.

```ts
import { Layer } from "better-effect";

export const DatabaseLive = Layer.scoped(
  Database,
  async () => {
    const database = new Database();

    await database.connect();

    return database;
  },
  (database) => database.close(),
);

export const UserRepositoryLive = Layer.make(
  UserRepository,
  () => new UserRepository(),
);

export const AppLive = Layer.merge(DatabaseLive, UserRepositoryLive);
```

The core Layer API intentionally stays small:

```ts
Layer.make(Service, acquire);
Layer.succeed(Service, instance);
Layer.scoped(Service, acquire, release);
Layer.merge(...layers);
Layer.override(base, ...overrides);
```

### Test environments

Layers make implementation replacement explicit:

```ts
const DatabaseTest = Layer.succeed(Database, new InMemoryDatabase());

const AppTest = Layer.override(AppLive, DatabaseTest);
```

## ITI adapter

`better-effect` does not depend on ITI in its core. ITI is just one possible backend.

```ts
import { buildLayer } from "better-effect";

import { ItiLayerBackend } from "better-effect/iti";

const runtime = await buildLayer(AppLive, new ItiLayerBackend());

try {
  await main();
} finally {
  await runtime.dispose();
}
```

This keeps application code independent from the DI container.

A different backend can implement the same resolver/backend contracts without changing Services or Layers.

## Resource

`Resource.acquireUseRelease()` handles local resource lifecycle while preserving typed `Result` errors.

```ts
import { Resource } from "better-effect";

const result = await Resource.acquireUseRelease({
  name: "transaction",

  acquire: () => database.begin(),

  use: (transaction) => executeCommand(transaction),

  release: (transaction) => transaction.close(),
});
```

When `release` is omitted, `Resource` attempts to use the JavaScript explicit resource management protocol:

```ts
Symbol.asyncDispose;
Symbol.dispose;
```

### Error precedence

If both `use` and `release` fail, the error produced by `use` is preserved.

The precedence is:

```text
1. use failure
2. release failure
3. successful use value
```

Acquisition exceptions, rejected promises, and unexpected failures are normalized through `better-result`.

## Service vs Layer vs Resource

| Primitive       | Responsibility                                        |
| --------------- | ----------------------------------------------------- |
| `Service`       | Request a contextual dependency                       |
| `Layer`         | Describe the implementations that form an environment |
| `Resource`      | Manage a resource local to one operation              |
| DI backend      | Resolve, cache and dispose service instances          |
| `better-result` | Typed failures and generator control flow             |

## Complete example

The repository contains a TODO API example under:

```text
examples/todo-api
```

It demonstrates:

- Bun HTTP server
- SQLite in memory with `Bun.SQL`
- user login
- session authentication
- TODO CRUD
- `Service` dependency access
- Layer composition
- scoped database lifecycle
- `Resource.acquireUseRelease()`
- ITI as the DI backend

Run it from the repository root:

```bash
bun examples/todo-api/index.ts
```

## Development

Install dependencies:

```bash
bun install
```

Run tests:

```bash
bun test
```

Typecheck:

```bash
bun run typecheck
```

Run the full quality gate:

```bash
bun run check
```

The project uses:

- Bun as package manager and test runner
- TypeScript
- tsdown for library builds
- Oxlint
- Oxfmt
- publint

## Design principles

### Keep the core small

`better-effect` should not grow into a second Effect runtime.

The core intentionally does not implement:

- fibers
- schedules
- streams
- queues
- a dependency graph runtime
- a custom DI container
- a custom Context
- a custom Scope runtime
- `Effect<A, E, R>`

### Delegate instead of rebuilding

Dependency resolution, caching and container lifecycle belong to DI backends.

`better-effect` supplies the protocol and composition primitives.

### Preserve inference at public boundaries

Type safety is part of the API.

For example:

```ts
const auth = yield * AuthService;
// AuthService
```

and:

```ts
const database = await ServiceRuntime.resolve(Database);
// Database
```

must preserve exact instance types.

### Type erasure stays internal

Layers may store heterogeneous providers internally using erased types.

The public constructors (`Layer.make`, `Layer.succeed`, `Layer.scoped`) are responsible for preserving the relationship between a Service token and its instance type.

## Current scope

The project is intentionally small and experimental.

The initial scope is:

```text
Service
Layer
Resource
DI adapters
better-result integration
```

New abstractions should only be added when they solve a concrete problem without duplicating responsibilities already handled well by another library.

## License

MIT
