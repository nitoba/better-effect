# Transformation patterns

Use these patterns as refactoring guides, not blind search-and-replace recipes. Confirm the installed `better-effect` / `better-result` versions and preserve the target application's behavior.

## 1. Constructor-carried contextual dependencies -> Service requirements

### Before

```ts
class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditLog
  ) {}

  async rename(id: string, name: string) {
    const user = await this.users.findById(id)
    // ...
  }
}
```

### After

```ts
class UserService extends Service<UserService>()('UserService') {
  rename(id: string, name: string) {
    return Effect.gen(async function* () {
      const users = yield* UserRepository
      const audit = yield* AuditLog

      const user = yield* Result.await(users.findById(id))
      const renamed = yield* Result.await(users.rename(user.id, name))
      yield* Result.await(audit.record({ type: 'user.renamed', userId: user.id }))

      return Result.ok(renamed)
    })
  }
}
```

Use this when the dependencies are contextual capabilities needed by the operation. Keep constructor parameters that are true object invariants or ordinary domain values.

The provider can often become:

```ts
const UserServiceLive = Layer.make(UserService)
```

and its method-level Effect requirements remain visible to Layer completeness/type inference.

## 2. Eager Effect built outside Runtime -> lazy Program

### Before

```ts
const load = Effect.gen(async function* () {
  const database = yield* Database
  return Result.ok(await database.load())
})

const result = await runtime.run(() => load)
```

`Effect.gen` already ran when `load` was created, so Service resolution occurred before the intended Runtime boundary.

### After

```ts
const load = Effect.fn(async function* () {
  const database = yield* Database
  return Result.ok(await database.load())
})

const result = await runtime.run(load)
```

Parameterized Program factories remain ordinary functions:

```ts
const loadUser = (id: string) =>
  Effect.fn(async function* () {
    const users = yield* UserRepository
    const user = yield* Result.await(users.findById(id))

    return Result.ok(user)
  })
```

Every `Effect.gen`/`Effect.fn` generator finishes with a Result. The value produced by `Result.await` is the successful value, not the final Result to return.

## 3. Throwing domain decisions -> typed Result errors

### Before

```ts
async function loadUser(id: string) {
  const user = await repository.find(id)

  if (!user) {
    throw new Error('User not found')
  }

  return user
}
```

### After

```ts
class UserNotFound extends TaggedError('UserNotFound')<{
  readonly id: string
  readonly message: string
}> {}

function loadUser(id: string) {
  return repository.find(id).then((user) =>
    user
      ? Result.ok(user)
      : Result.err(new UserNotFound({ id, message: 'User not found' }))
  )
}
```

Then compose it:

```ts
const program = Effect.fn(async function* () {
  const user = yield* Result.await(loadUser(id))
  return Result.ok(user)
})
```

Use thrown exceptions for defects/unexpected failures, not expected business branches.

## 4. Rejecting infrastructure Promise -> Result normalization at the edge

### Before

```ts
async function fetchAccount(id: string) {
  return api.get(`/accounts/${id}`)
}
```

Callers now need repeated `try/catch`.

### After

```ts
class AccountApiFailure extends TaggedError('AccountApiFailure')<{
  readonly id: string
  readonly cause: unknown
  readonly message: string
}> {}

function fetchAccount(id: string) {
  return Result.tryPromise({
    try: () => api.get(`/accounts/${id}`),
    catch: (cause) =>
      new AccountApiFailure({
        id,
        cause,
        message: 'Could not load account'
      })
  })
}
```

Downstream Programs can now use `Result.await` and preserve typed short-circuiting.

## 5. Manual service locator -> Service + Layer + Runtime

### Before

```ts
const container = new Container()
container.register('database', () => createDatabase())

export async function handle() {
  const database = container.resolve<Database>('database')
  return database.query()
}
```

### After

```ts
class Database extends Service<Database>()('Database') {
  query() {
    // ...
  }
}

const DatabaseLive = Layer.make(Database, () => createDatabase())

const handle = Effect.fn(async function* () {
  const database = yield* Database
  const value = await database.query()

  return Result.ok(value)
})

await using runtime = await Runtime.make(DatabaseLive)
const result = await runtime.run(handle)
```

If a third-party container is still desired, select a `LayerBackend` adapter at Runtime creation. Do not leak its keys/types into Services.

## 6. Global application resource -> `Layer.scoped`

### Before

```ts
const pool = await createPool()

process.on('SIGTERM', async () => {
  await pool.close()
})
```

### After

```ts
const DatabaseLive = Layer.scoped(
  Database,
  async () => new Database(await createPool()),
  (database, outcome) => database.close(outcome)
)

await using runtime = await Runtime.make(DatabaseLive)
```

Use `Layer.scopedGen` when acquisition needs another Service:

```ts
const DatabaseLive = Layer.scopedGen(
  Database,
  async function* () {
    const config = yield* AppConfig
    return Database.connect(config.databaseUrl)
  },
  (database, outcome) => database.close(outcome)
)
```

## 7. Request-local manual `try/finally` -> `Effect.acquireRelease`

### Before

```ts
const transaction = await database.begin()

try {
  return await execute(transaction)
} finally {
  await transaction.close()
}
```

### After

```ts
const program = Effect.fn(async function* () {
  const database = yield* Database

  const transaction = yield* Effect.acquireRelease(
    () => database.begin(),
    (transaction, outcome) => transaction.close(outcome)
  )

  const value = yield* Result.await(transaction.execute())
  return Result.ok(value)
})
```

The transaction now belongs to the execution child Scope and closes with the final Runtime-classified outcome.

## 8. Already-acquired disposable + manual cleanup -> `Effect.add`

### Before

```ts
const socket = await connectSocket()

try {
  return await useSocket(socket)
} finally {
  await socket[Symbol.asyncDispose]()
}
```

### After

```ts
const program = Effect.fn(async function* () {
  const socket = await connectSocket()
  const managedSocket = yield* Effect.add(socket)

  const value = yield* Result.await(useSocket(managedSocket))
  return Result.ok(value)
})
```

Use this only when `socket` is already acquired and exposes a callable disposal protocol. If acquisition itself belongs in the workflow, prefer `Effect.acquireRelease`.

## 9. One local resource transaction -> `Resource.acquireUseRelease`

Not every lifecycle needs a Runtime/Effect hierarchy.

### Before

```ts
const file = await openFile()

try {
  return await render(file)
} finally {
  await file.close()
}
```

### After

```ts
const result = await Resource.acquireUseRelease({
  name: 'report file',
  acquire: () => openFileResult(),
  use: (file) => render(file),
  release: (file) => file.close()
})
```

Use this when one local acquire/use/release Result transaction is the whole ownership story. Use Scope-based APIs when the resource belongs to a Runtime execution or hierarchy.

## 10. Rebuilding an application graph for tests -> explicit Layer override

### Before

```ts
const app = makeApplication({
  database: fakeDatabase,
  mailer: realMailer,
  clock: realClock
})
```

### After

```ts
const DatabaseTest = Layer.succeed(
  Database,
  Database.of({
    findById: async (id) => Result.ok({ id })
  })
)

const AppTest = Layer.override(AppLive, DatabaseTest)
const result = await Runtime.run(AppTest, program)
```

Intentional replacement stays visible and unrelated production providers remain intact.

## 11. Mock class with meaningless constructor -> `Service.of`

### Before

```ts
class FakeMailer extends Mailer {
  constructor() {
    super(fakeTransportThatIsNeverUsed)
  }

  send() {
    return Promise.resolve(Result.ok(undefined))
  }
}
```

### After

```ts
const MailerTest = Layer.succeed(
  Mailer,
  Mailer.of({
    send: async () => Result.ok(undefined)
  })
)
```

Prefer a real subclass/instance when prototype behavior, private fields, or constructor invariants are relevant.

## 12. Accidental merge replacement -> `Layer.override`

### Before

```ts
const TestLive = Layer.merge(AppLive, DatabaseTest)
```

### After

```ts
const TestLive = Layer.override(AppLive, DatabaseTest)
```

For multiple replacements:

```ts
const TestLive = Layer.override(AppLive, DatabaseTest, ClockTest)
```

`Layer.merge` intentionally rejects duplicate tags. Override intent should be explicit.

## 13. Broad Layer annotation -> inference or `satisfies`

### Before

```ts
const AppLive: Layer<AppServices, never> = Layer.merge(
  DatabaseLive,
  RepositoryLive,
  ServicesLive
)
```

This is safe but can erase provider provenance needed for precise later overrides.

### After

```ts
const AppLive = Layer.merge(
  DatabaseLive,
  RepositoryLive,
  ServicesLive
) satisfies Layer<AppServices, never>
```

Or assert completeness at the root:

```ts
const AppLive = Layer.complete(
  Layer.merge(DatabaseLive, RepositoryLive, ServicesLive)
)
```

Do not reach for `Layer.Any` to silence a completeness issue that can be modeled precisely.

## 14. Untyped Runtime boundary -> `Runtime.For`

### Before

```ts
function createServer(runtime: Runtime) {
  // environment checks have been erased
}
```

### After

```ts
type AppRuntime = Runtime.For<typeof AppLive>

function createServer(runtime: AppRuntime) {
  // runtime.run keeps AppLive's environment contract
}
```

Use an unparameterized Runtime only as a deliberate unchecked boundary.

## 15. Per-request Runtime -> `runWith`

### Before

```ts
async function handleRequest(request: Request) {
  const RequestLive = CurrentRequest.layer(request)
  const runtime = await Runtime.make(Layer.merge(AppLive, RequestLive))

  try {
    return await runtime.run(handle)
  } finally {
    await runtime.dispose()
  }
}
```

### After

```ts
const runtime = await Runtime.make(AppLive)

async function handleRequest(request: Request) {
  return runtime.runWith(CurrentRequest.layer(request), handle)
}
```

Root infrastructure remains shared; request providers live only for that execution.

## 16. Manual request parameter plumbing -> request Layer

### Before

```ts
await application.handle({
  requestId,
  tenantId,
  userId
})
```

When values are genuinely cross-cutting execution context used by independent Services, model a contextual Service:

```ts
class RequestContext extends Service<RequestContext>()('RequestContext') {
  declare readonly requestId: string
  declare readonly tenantId: string
}

const RequestLive = Layer.succeed(
  RequestContext,
  RequestContext.of({ requestId, tenantId })
)

const result = await runtime.runWith(RequestLive, program)
```

Do not turn normal function input into a Service just to avoid parameters.

## 17. Eager work collection -> lazy bounded `Program.all`

When each operation must begin only inside the Runtime boundary and concurrency should be bounded:

```ts
const programs = ids.map((id) => loadUserProgram(id))
const allUsers = Program.all(programs, { concurrency: 8 })

const result = await runtime.run(allUsers)
```

`Program.all` stops scheduling after a child error or throw, lets already-started Programs settle, and preserves a deterministic primary failure. It does not cancel in-flight work or introduce Fibers. Use `Effect.all` when the Effects are already intentionally created in the active context. Use `Program.all` when the work itself must remain lazy.

## 18. Ambient time/random/logging -> replaceable standard Services

### Before

```ts
const expiresAt = new Date(Date.now() + ttl)
const id = Math.random().toString(36)
console.info('created', id)
```

### After

```ts
const createToken = Effect.fn(function* () {
  const clock = yield* Clock
  const random = yield* Random
  const logger = yield* Logger

  const id = random.next().toString(36)
  const expiresAt = new Date(clock.now().getTime() + ttl)
  logger.info('created token', { id })

  return Result.ok({ id, expiresAt })
})
```

Tests can use deterministic Layers such as `ClockTest.layer(...)`, `RandomSeeded.layer(seed)`, and `LoggerTest`.

Introduce these Services only when deterministic replacement/contextual access has concrete value.

## 19. Scattered environment reads -> typed Config boundary

### Before

```ts
const poolSize = Number(process.env.POOL_SIZE)
const url = process.env.DATABASE_URL!
```

### After

Use a Standard Schema-compatible descriptor and Config helpers from `better-effect/standard-services`. Keep source reading/validation at a configuration boundary and construct dependent providers from the validated config.

Follow the installed-version documentation for the exact Config API. Do not leak raw environment access throughout application Services, and do not attach secrets/raw environment payloads to validation errors or logs.

## 20. Hono handler with manual Service resolution -> request boundary adapter

### Before

```ts
app.get('/users/:id', async (c) => {
  const users = container.resolve(UserService)
  const user = await users.find(c.req.param('id'))
  return c.json(user)
})
```

### After

```ts
const http = HonoEffect.make(runtime, {
  onFailure: (_error, c) => c.json({ error: 'Request failed' }, 400)
})

app.use('/api/*', http.middleware())

app.get(
  '/api/users/:id',
  http.gen(async function* (c) {
    const users = yield* UserService
    const user = yield* Result.await(users.find(c.req.param('id')))

    return Result.ok(user)
  })
)
```

Use `http.handler` when the Program is defined outside HTTP:

```ts
app.get('/api/users/:id', http.handler((c) => getUser(c.req.param('id'))))
```

Expected Result failures go through the configured failure policy. The default policy redacts exception messages; custom policies should expose only safe, intentional domain details. Thrown defects remain in Hono's error path.

## 21. Auth middleware with duplicated Result plumbing -> `http.guard`

```ts
app.use(
  '/private/*',
  http.guard(async function* (c) {
    const auth = yield* AuthService
    const token = c.req.header('Authorization')

    if (!token) {
      return Result.err(
        new AuthenticationRequired({ message: 'Authentication required' })
      )
    }

    const user = yield* Result.await(auth.verify(token))
    c.set('user', user)

    return Result.ok()
  })
)
```

Keep failure-to-HTTP mapping centralized instead of repeating it in each middleware/route.

## 22. Manual DI adapter with unrelated generics -> token-derived resolver

### Before

```ts
resolve<A>(token: AnyServiceToken): A {
  return this.container.get(token.serviceTag) as A
}
```

### After

```ts
resolve<T extends AnyServiceToken>(
  token: T
): InstanceType<T> | PromiseLike<InstanceType<T>> {
  return this.container.get(token.serviceTag) as InstanceType<T>
}
```

Keep unavoidable casts at the adapter lookup boundary. Do not weaken the public Service token -> instance relationship.

## 23. Global mutable resolver in tests -> per-Runtime test environment

### Before

```ts
beforeEach(() => globalContainer.reset())
```

### After

```ts
const AppTest = Layer.override(AppLive, DatabaseTest, ClockTest)

const [first, second] = await Promise.all([
  Runtime.run(AppTest, programA),
  Runtime.run(AppTest, programB)
])
```

Runtime context is intended to be isolated. Tests should not require serial execution merely because dependency resolution is global.

## 24. Cleanup that masks the primary failure -> owned cleanup + diagnostics

Place cleanup under Layer/Scope/Resource ownership and report secondary failures through the supported observer:

```ts
const runtime = await Runtime.make(AppLive, {
  onCleanupFailure: ({ error }) => logger.error('cleanup failed', { error })
})
```

Do not catch and replace a typed program failure with a generic cleanup failure.

## 25. Manual startup probes -> Runtime warmup

If the real requirement is "all providers must acquire successfully before traffic starts":

```ts
const runtime = await Runtime.make(AppLive, { warmup: true })
startServer()
```

Use warmup only when eager startup validation is desired. Lazy provider acquisition remains the default.

## 26. Manual cancellation plumbing -> Runtime `AbortSignal`

At the boundary:

```ts
await runtime.run(program, { signal: request.signal })
```

Inside the Program:

```ts
const program = Effect.fn(async function* () {
  const signal = yield* CurrentAbortSignal
  const value = yield* Result.await(fetchResult({ signal }))

  return Result.ok(value)
})
```

Cancellation is cooperative. Do not model this as fibers or assume arbitrary Promises can be preempted.

## 27. Mixed ownership after refactoring -> one owner per resource

An incomplete refactor often leaves both old and new cleanup:

```ts
const DatabaseLive = Layer.scoped(Database, connect, close)

process.on('SIGTERM', async () => {
  await database.close()
  await runtime.dispose()
})
```

Once the Runtime/Layer owns the database, shutdown should dispose the Runtime only:

```ts
process.on('SIGTERM', async () => {
  await runtime.dispose()
})
```

Apply the same rule to Runtime, child Scopes, Layer-scoped resources, and execution resources: ownership must not be duplicated.

## Final refactoring check

After transformations, the code should tell a coherent story:

```text
input/domain data
      ↓
Program / Effect workflow
      ↓ yield*
Services
      ↓
Result success/failure
      ↓
Runtime execution boundary
      ↓
Scope cleanup
```

and separately:

```text
composition root
      ↓
Layers acquire/provide Services
      ↓
Runtime owns root lifetime
```

If the result requires more explanation than the original code without gaining typed failures, explicit requirements, testability, or ownership safety, simplify it.
