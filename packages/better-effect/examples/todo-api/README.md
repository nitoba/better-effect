# better-effect TODO API example

Small Bun API demonstrating:

- `Service` for contextual dependencies with `yield*`
- `Layer` for composing the application environment
- `Scope` for execution-local lifetimes and cleanup
- `Resource` as a standalone compatibility helper for local Result workflows
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

Services and repositories extend `Service<Self>()('Name')`; the explicit tag is
their stable logical identity while the self type preserves exact inference.
Dependencies resolve inside the Runtime-owned `Effect.fn` programs (and inside
eager `Effect.gen` workflows created from an active Runtime):

```ts
const database = yield * Database
const todos = yield * TodoRepository
```

When a service is a structural contract, `Service.of` type-checks an object
implementation and returns it unchanged. It is useful for lightweight live
implementations and test doubles:

```ts
const AuthorizationTest = Layer.succeed(
  Authorization,
  Authorization.of({
    authorize: async (token) => token.length > 0
  })
)
```

The returned object is not an instance of the Service class; use `new` when a
constructor or runtime invariants are part of the implementation.

### Layer

`layers/app-live.ts` describes the live environment. `Database` is a disposable
client, so `Layer.scopedDisposable()` keeps it alive across executions and closes it
when the runtime is disposed.

### Resource

`Resource.acquireUseRelease()` remains available as a standalone helper for local
acquire/use/release workflows. It preserves typed errors, cleanup precedence, and
automatic disposal support; it is not deprecated.

### Scope

The SQLite client is a real root-scoped resource: `Layer.scopedDisposable()` acquires
it once and closes it when the Runtime is disposed. Bun's SQLite adapter does not expose a pooled
connection lease, so this example does not register a fake execution resource with a
no-op release.

Each request handled by the server receives its own child execution scope. During
shutdown, `runtime.dispose()` stops accepting new executions, waits for active
requests to finish, and then closes the root scope that owns the database layer.
Real request-local resources can use `Effect.acquireRelease()` and are closed with that
request's execution scope. For a nested batch lifetime, use `scope.fork()` with
`Scope.provide()` and close the child explicitly when the batch ends.
