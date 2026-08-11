# better-effect TODO API example

Small Bun API demonstrating:

- `Service` for contextual dependencies with `yield*`
- `Layer` for composing the application environment
- `Scope` for execution-local lifetimes and cleanup
- `Resource` as a compatibility helper for local acquire/use/release lifecycle
- `better-result` for typed errors and generator composition
- `Bun.SQL` with in-memory SQLite
- `Bun.password` for password hashing
- `Bun.serve` for HTTP routing
- ITI as the DI backend

## Run

From the repository root:

```bash
bun examples/todo-api/index.ts
```

Default URL:

```text
http://localhost:3333
```

Demo credentials:

```text
demo@example.com
demo1234
```

## Login

```bash
curl -s \
  -X POST http://localhost:3333/auth/login \
  -H 'content-type: application/json' \
  -d '{
    "email": "demo@example.com",
    "password": "demo1234"
  }'
```

Copy the returned token:

```bash
TOKEN="<token>"
```

## Create a todo

```bash
curl -s \
  -X POST http://localhost:3333/todos \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "title": "Study better-effect"
  }'
```

## List todos

```bash
curl -s \
  http://localhost:3333/todos \
  -H "authorization: Bearer $TOKEN"
```

## Get one todo

```bash
curl -s \
  http://localhost:3333/todos/<id> \
  -H "authorization: Bearer $TOKEN"
```

## Update a todo

```bash
curl -s \
  -X PATCH http://localhost:3333/todos/<id> \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "completed": true
  }'
```

## Delete a todo

```bash
curl -i \
  -X DELETE http://localhost:3333/todos/<id> \
  -H "authorization: Bearer $TOKEN"
```

## Where each primitive is used

### Service

Services and repositories extend `Service<Self>()` and resolve dependencies
inside `Effect.gen`:

```ts
const database = yield * Database
const todos = yield * TodoRepository
```

### Layer

`layers/app-live.ts` describes the live environment. `Database` is scoped so its
SQL client is closed when the runtime is disposed.

### Resource

`Resource.acquireUseRelease()` remains available for local acquire/use/release
workflows and preserves typed errors and cleanup precedence.

### Scope

`Database.run()` uses the execution `Scope` to model a connection lease. Bun's
SQLite adapter does not support `sql.reserve()` because it does not use connection
pooling, so the shared client remains owned by the database Layer's root scope.

```ts
const result = await runtime.run(() =>
  Effect.gen(async function* () {
    const scope = yield* Scope
    const connection = await scope.acquire(
      () => database.sql,
      () => undefined
    )

    return Result.ok(await useConnection(connection))
  })
)
```

The execution scope closes automatically after `runtime.run()` completes, while
the scoped database layer remains owned by the Runtime root scope.

Each request handled by the server receives its own child execution scope. During
shutdown, `runtime.dispose()` stops accepting new executions, waits for active
requests to finish, and then closes the root scope that owns the database layer.
For a nested batch lifetime, use `scope.fork()` with `Scope.provide()` and close the
child explicitly when the batch ends.
