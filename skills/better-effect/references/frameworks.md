# Framework and host boundaries

Use core optional entrypoints, not a hand-written Runtime per route. Public
reference: [core README](https://github.com/nitoba/better-effect/blob/main/packages/better-effect/README.md).
Outbound requests belong to [better-effect-http](http-client.md), not WebEffect.

## Pick the owner

| Host | API | Ownership |
| --- | --- | --- |
| Node/Bun command | `better-effect/node`: `NodeRuntime.runMain(AppLive, main, options)` | One Runtime for the command; typed exit/failure and cleanup policies |
| Layer-defined long-lived process | `NodeRuntime.launch(AppLive, options)` | Owns Runtime, waits for host/caller signal |
| Standard Request/Response | `better-effect/web`: `WebEffect.handleWith(executor, request, program, options)` | Borrows executor; one request execution |
| Managed response body | `WebEffect.streamWith(...)` | Retains the execution through body completion/cancellation |
| Hono | `better-effect/hono`: `HonoEffect.app` / `HonoEffect.layer` | App built as a Layer in the host's Runtime |
| Bun server | `better-effect/bun`: `BunEffect.server` / `BunEffect.layer` | Native Bun.serve acquired/quiesced/released by Layer |
| Next App Router modules | `better-effect/next`: `NextEffect.managed(AppLive)` | Lazy shared Runtime; host calls initialize/dispose |
| Next routes built in an active Runtime | `NextEffect.fromCurrent()` | Non-owning builders capture the existing executor |

Do not call `NodeRuntime.runMain(Layer.empty, ...)` and then create another
Runtime for the actual server/worker/auth graph. Compose the complete graph
into the chosen owner. Two independently owned applications are a different
case from accidental nested ownership.

## Hono: build the app inside its Layer

This complete composition uses only Hono, better-effect, and better-result:

```ts
import { Hono } from 'hono'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
import { Result } from 'better-result'

class Greeting extends Service<Greeting>()('@example/Greeting') {
  hello(name: string) {
    return `Hello, ${name}`
  }
}

const Api = HonoEffect.app('@example/Api', {}, async function* (http) {
  const app = new Hono()
  app.use('*', yield* http.middleware())
  app.get(
    '/hello/:name',
    yield* http.gen(async function* (c) {
      const greeting = yield* Greeting
      return Result.ok({ message: greeting.hello(c.req.param('name')) })
    })
  )
  return app
})

const AppLive = Layer.complete(Layer.merge(Layer.make(Greeting), Api.layer))
await using runtime = await Runtime.make(AppLive)
const resolved = await runtime.run(
  Effect.fn(async function* () {
    return Result.ok(yield* Api)
  })
)
if (Result.isError(resolved)) throw resolved.error
const response = await resolved.value.request('/hello/Ada')
```

The final throw is an imperative example boundary, not a business error policy.
The app factory returns the Hono instance, not `Result.ok(app)`. Keep that
instance inside the factory: do not share a mutable module-level Hono instance
across different Runtimes or redeclare `const app` in one module scope.

Install `yield* http.middleware()` before middleware needing Services.
`yield* http.gen(...)`, `yield* http.handler(...)`, and
`yield* http.guard(...)` build captured handlers inside the factory.
`HonoEffect.layer(Token, options, factory)` provides an existing Service token.

Use the application's native Hono validators (`sValidator`, `zValidator`, or
other compatible middleware) before the generator callback. For example, inside
the factory, with `validateBody` already defined:

```ts
app.post(
  '/items',
  yield* http.gen(validateBody, async function* (c) {
    const input = c.req.valid('json')
    return Result.ok(input)
  }, { status: 201 })
)
```

Validators run before the Program and infer `c.req.valid(...)`. Do not create
parallel `readJson`/`readQuery`/`readParams` helpers that bypass this contract.
Use `requestLayer` for principal/tenant context; do not reconstruct a container
with `c.set` for every Service. See [Better Auth](better-auth.md) for sessions.

## Response policies and streaming

Web/Hono/Next boundaries distinguish typed failures from defects. The default
non-Response typed failure is redacted to an internal-server-error response.
Custom policies must expose only intentional domain details; never serialize
raw driver/provider errors, credentials, or causes. Native Responses preserve
headers and cookies. Defects follow the framework's error path.

The default Web/Next success policy passes through a Response, maps top-level
undefined to 204, and wraps strict JSON-safe plain data as `{ data: value }`.
A schema class, Date, bigint, nested undefined, cyclic object, accessor, or
custom prototype is not automatically safe. Explicitly encode/project domain
values or supply an appropriate success policy; a TypeScript type is not a
serializer. Next route `respond`, `serialize`, and route-level `onSuccess`
are alternative success policies, not a stack of transformations.

A buffered boundary closes request-local resources before its handler Promise
resolves. When a response still reads scoped resources, use the explicit
managed stream descriptor with `status`, `headers`, and a lazy `producer`.
For Web use `WebEffect.streamWith`; inside Hono use `yield* http.stream(program)`.
Do not return an arbitrary streaming Response through a buffered boundary and
assume that its resource Scope stays alive.

Managed streaming separates response readiness from execution completion,
preserves request Services and backpressure, and closes on EOF, consumer cancel,
error, abort, idle policy, or shutdown. Before headers commit, map errors to a
Response. Afterwards, only the body or an explicitly designed terminal event
can communicate failure; a new HTTP status is no longer possible.
Use the executable [Hono streaming recipe](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-http/examples/hono-streaming.ts)
for upstream-reader cancellation and ownership.

## Bun, Node, and Next lifecycle

`BunEffect.server(tag, generator)` returns a generated Service and `.layer`.
Its generator returns native server options, commonly after yielding
`BunEffect.handler(options, programFactory)`. For an existing Service,
`BunEffect.layer` maps the native server using `{ options, map }`. A Bun host can
also resolve an existing Hono application and use its native fetch handler;
avoid wrapping that handler in a second request execution.

`NodeRuntime.runMain` maps Result failures through `onFailure`, defects through
its defect path, and cleanup failures through their own policy. It sets
`process.exitCode`, not `process.exit()`. `NodeRuntime.launch` is appropriate
when ingress and background components are fully represented by Layers.
Configure shutdown explicitly, for example
`shutdown: { gracePeriod: 10_000, abortAfterGracePeriod: true }`.
Quiesce ingress before draining and releasing shared resources.

Next's `managed` manager belongs in one shared module, not one manager per
route. Concurrent first requests share initialization. Export Route Handlers
through its `.gen`/`.handler` builders, await `context.params`, and connect
`.initialize()`/`.dispose()` to the actual host lifecycle. `fromCurrent` builders
are yieldable inside a live Runtime; they are not a replacement for managed
module-scope initialization. Do not promise automatic HMR cleanup, serverless
worker ownership, or Edge support.
