# better-effect-http

`better-effect-http` is a small, server-side HTTP client for
[`better-effect`](https://github.com/nitoba/better-effect). It describes Fetch
requests as lazy, single-use `Program`s and leaves success/failure semantics to
[`better-result`](https://github.com/nitoba/better-result). The transport uses
`ofetch` internally, with the platform Fetch API at the boundary.

The package is intentionally separate from `better-effect`: the core package
does not import `ofetch`, HTTP, or a schema provider. Importing this package has
no I/O, does not read environment variables, create a Runtime, or register a
listener.

## Install

```bash
bun add better-effect-http better-effect better-result better-effect-schema
# Only the managed Hono recipe also needs:
bun add hono
```

The local workspace uses Bun 1.4.2 and TypeScript 7.0.2; release gates also run
the current Node.js LTS interoperability smoke tests. The public TypeScript
peer range starts at 6.0. The package has these peers:

| Peer                   | Supported range              | Why it is a peer                          |
| ---------------------- | ---------------------------- | ----------------------------------------- |
| `better-effect`        | `>=0.14.0 <0.15.0`           | Services, Layers, Runtime and Scope       |
| `better-result`        | `^3.0.0`                     | Result, `Result.await`, and tagged errors |
| `better-effect-schema` | `>=0.1.0 <0.2.0`             | Provider-neutral Standard Schema decode   |
| TypeScript             | `>=6.0.0`                    | public type contracts                     |
| `@opentelemetry/api`   | `>=1.9.0 <1.10.0` (optional) | the telemetry subpath only                |

`ofetch` and `eventsource-parser` are runtime dependencies. `ofetch` retry is
always disabled by this package; the HTTP retry policy is the only retry
controller. Zod, Valibot, and ArkType are not imported by HTTP. They can be
passed as Standard Schema values, and their optional
`better-effect-schema/{zod,valibot,arktype}` adapters are application choices
when capabilities beyond Standard Schema are needed.

The packed-artifact consumer matrix, export and peer audits, and Bun/Node
interoperability checks are documented in [`VERIFICATION.md`](./VERIFICATION.md)
and run as part of the package check.

The public entry points are:

| Import                             | Contents                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `better-effect-http`               | client, requests, responses, policies, schema decode, streaming and codecs |
| `better-effect-http/endpoints`     | the endpoint namespace (also re-exported by the root)                      |
| `better-effect-http/opentelemetry` | the optional tracer observer                                               |
| `better-effect-http/testing`       | deterministic `HttpTest` and controlled streams                            |

## The operational model

`HttpClient` is a Service token and a Layer factory. A method call only creates
a description; it does not read a socket. The request is sent when the
operation is consumed by `yield*` inside the application's Runtime.

```ts
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { HttpClient } from 'better-effect-http'

const App = Effect.fn(async function* () {
  const http = yield* HttpClient
  const response = yield* http.get('/users/42', { responseType: 'json' })
  return Result.ok(response.data)
})

const runtime = await Runtime.make(HttpClient.layer({ baseURL: 'https://api.example.test' }))
try {
  const result = await runtime.run(App)
  if (Result.isError(result)) console.error(result.error)
} finally {
  await runtime.dispose()
}
```

Use one application Runtime. Do not create a `NodeRuntime` with `Layer.empty`
and then create another Runtime for the HTTP Layer. The current resolver,
request signal, Scope, policies, and Services are supplied by the active
execution. `HttpClient.service('@app/PartnerHttp', hooks)` creates a named
Service with the same API and a matching `.layer(options)` factory:

```ts
const PartnerHttp = HttpClient.service('@app/PartnerHttp', {
  interceptors: [authentication],
  observers: [observer],
  middleware: [recovery]
})
const PartnerLive = PartnerHttp.layer({ baseURL: 'https://partner.example' })
```

The result of `.use(...)` is a new client. It does not mutate the configured
client or a shared request. Operations, request options, headers, and query
objects are derived immutably. Each buffered operation is single-use. A stream
terminal opens a one-shot reader/session; once that session is consumed or
closed it cannot be read again. Create another explicit stream description when
the application needs another request.

The public operation shape is `HttpOperation<A, E, R>` in spirit: `A` is the
decoded value, `E` is the HTTP failure channel, and `R` contains Services used
by effectful hooks/terminals. `Effect.Requirements` is checked at the Runtime
boundary like every other `better-effect` Program. A generic `HttpOperation`
annotation intentionally erases requirements; it is an explicit unchecked
escape hatch, not a recommendation.

## Requests, methods, and responses

All standard methods are available as `get`, `post`, `put`, `patch`, `delete`,
and `head`; `request(method, path, options)` handles a dynamic method. Options
include `query`, `headers`, `body`, `signal`, `timeout`, `responseType`, and
one of `schema` or `responses`.

`query` values are strings, numbers, booleans, nullish values, or arrays of
those values. Plain object bodies are JSON encoded once at the physical send;
`string`, `ArrayBuffer`, `Blob`, `FormData`, `URLSearchParams`, and
`ReadableStream<Uint8Array>` remain explicit body representations. Use
`responseType: 'json' | 'text' | 'blob' | 'arrayBuffer'` when a response is not
JSON. Empty bodies, `HEAD`, and status 204/205/304 resolve with `data:
undefined`; an empty JSON response is not an invented object.

Without a schema, a successful JSON value is `unknown` and is not validated by
a TypeScript generic. A generic such as `http.get<User>(...)` is not a schema
and does not add runtime validation. Use a Standard Schema value instead:

```ts
const user = yield * http.get('/users/42', { schema: UserSchema })
```

For one schema on all successful statuses, `schema` rejects non-2xx responses.
For status-discriminated decoding, use `responses`:

```ts
const response =
  yield *
  http.get('/users/42', {
    responses: {
      200: UserSchema,
      404: UserNotFoundSchema,
      422: ValidationErrorSchema
    }
  })

if (response.status === 404) {
  console.log(response.data.reason)
} else if (response.status === 422) {
  console.log(response.data.field)
} else {
  console.log(response.data.id)
}
```

Only declared statuses are accepted in the `responses` union. An undeclared
status is `HttpStatusError`. Transport, abort, timeout, status, decoding,
schema/provider execution, hook, and admission failures retain different
typed tags. `HttpStatusError.toJSON()` and `safeErrorJSON()` expose only a safe
allowlist; bodies, credentials, causes, arbitrary messages, and stacks are not
serialized automatically.

## Interceptors, observers, and middleware

These hooks have different contracts and run in the order configured on the
client:

| Hook                      | Purpose                                        | Frequency and outcome                                                                                   |
| ------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `HttpInterceptor.make`    | transform a request or response                | request transformation runs before every physical send; response transformation is part of that attempt |
| `HttpInterceptor.observe` | record logical success/error and SSE reconnect | best effort; callback failure never changes the HTTP result                                             |
| `HttpMiddleware.make`     | wrap the logical operation                     | one outer middleware call can decide whether/how to invoke `next`                                       |

Interceptors and middleware can return a value, a `Result`, a Promise, or an
effectful `Program`; their `R` and `E` are preserved. A request interceptor
receives an immutable `HttpRequest` and should return
`HttpRequest.setHeader(...)`, `HttpRequest.setQuery(...)`, or another derived
request. It must obtain user/request context at invocation time, not store the
last user's credential in a Layer. Observers receive only safe request/result
metadata and are diagnostic side effects. Middleware is the right place for a
logical policy such as bounded auth recovery.

## Retry and time budgets

`HttpRetry.make` is explicit. `HttpRetry.transient` defaults to `GET`, `HEAD`,
and `OPTIONS`; it does not make an unsafe method idempotent. A policy's
`times` counts additional physical attempts, while `totalMs` bounds the
logical call including backoff. `timeout` can set an attempt deadline and a
total deadline. There is one controller: ofetch retry is set to zero.

```ts
const response =
  yield *
  http.get('/health', {
    retry: HttpRetry.transient({
      times: 2,
      delay: HttpRetry.exponential({
        initialMs: 100,
        factor: 2,
        maxMs: 1_000,
        jitter: 'full'
      }),
      respectRetryAfter: true,
      totalMs: 2_500
    }),
    timeout: { attemptMs: 700, totalMs: 3_000 }
  })
```

The built-in status set is conservative: 408, 429, 500, 502, 503, and 504.
`Retry-After` accepts delta seconds and future HTTP dates; the effective wait
is the greater of server and local backoff. A method being safe is not proof
that its body is replayable: a stream or one-shot body must not be replayed.
Auth recovery and SSE reconnect use their own explicit bounds, but do not
form a second hidden retry loop. A retry repeats a physical HTTP attempt, not
the caller's business Program or a schema transform.

## Shared limits and isolation

`HttpClient.layer({ limits })` can set shared `concurrency`, a local `rate`
(`requests` per `perMs`), and a bounded `queue.maxSize`. Admission is per
physical send, so retry attempts consume capacity independently and always
release it. Aborting a queued request removes that waiter. There is no global
quota: two clients or two Sessions are isolated unless the application
deliberately shares the same configured client Layer.

For many independent operations, use the application's `Program.forEach`
composition and choose its concurrency deliberately. The HTTP limiter is a
shared local guard; it is not a remote quota, a queue broker, or a backpressure
protocol. Streaming reads remain pull-based, so downstream consumption controls
upstream reads.

## Telemetry and propagation

The optional `better-effect-http/opentelemetry` entry point adapts a caller's
tracer without installing an SDK, exporter, global provider, or process hook:

```ts
import { HttpTelemetry } from 'better-effect-http/opentelemetry'

const telemetry = HttpTelemetry.observe({
  tracer,
  propagation: { allowedOrigins: ['https://partner.example'] },
  recordEvents: true,
  onEvent: (event) => console.log(event.phase, event.operationId)
})
const instrumented = base.use(telemetry)
```

One logical operation keeps one identity; physical attempts and SSE openings
are children/events. Lifecycle phases distinguish admission, preparation,
send, headers, read, validation, retry wait, completion, error, and cancel.
Streaming spans close at EOF/terminal/error/cancel, not at response headers.
Use a low-cardinality route template when available.

URLs are reduced to origin and path. Bodies, query strings, fragments,
userinfo, tokens, cookies, cursors, arbitrary causes, and provider messages are
redacted by default. Headers use an allowlist and never expose
`Authorization`, `Cookie`, `Set-Cookie`, or equivalent secrets. Trace and
baggage propagate only to explicitly allowed origins; redirects do not expand
that policy. A telemetry callback throwing is secondary and cannot change the
request result.

## Schemas and explicit encoding

Response decoding calls `better-effect-schema`'s `Schema.decodeUnknownAsync`
through its provider-neutral Standard Schema boundary (or the corresponding
sync decode capability when the application deliberately uses a synchronous
boundary). The decoded output is the real output: classes retain `instanceof`,
getters, methods, and private state; transforms and defaults are not cloned into
plain objects. Sync and async validators are supported by the schema package's
corresponding capabilities. A schema execution failure is distinct from an
invalid value.

`better-effect-schema` classes, `TaggedClass`, and `TaggedError` work through
the same Standard Schema protocol. Import provider adapters only when defining
provider-specific capabilities. Standard Schema is a validation/decode
protocol; it is not a universal encoder or reflector. HTTP never inverts a
transform and never uses identity encoding as a fallback.

For a domain value whose wire representation differs, define an explicit
codec and use `bodyCodec` on an endpoint. `body` (a wire schema) and `bodyCodec`
are mutually exclusive. Encoding occurs once when the operation is consumed,
and retries do not rerun the business Program or silently apply a second
transform.

## Binary streaming

`http.stream(path, options)` returns an unstarted `HttpStream<Uint8Array>`.
`results()` exposes lazy `Result` chunks; `forEach`, `use`, `takeUntil`, and
`pipeTo` are scoped terminals. `pipeTo` writes each chunk to a
`WritableStream<Uint8Array>` and therefore does not materialize a complete
download:

```ts
const destination = fileWritableStream
yield * http.stream('/exports/archive.zip').pipeTo(destination)
```

The stream owns its reader and child Scope. Normal EOF, consumer break, sink
failure, abort, and cancellation close it once. A Hono/Web managed stream
keeps the request Scope alive until body completion or downstream cancel; it
does not turn a normal buffered response into a stream automatically.

## NDJSON

`http.ndjson(path, { schema, limits })` decodes one UTF-8 JSON record at a time.
LF and CRLF delimit records; empty lines are ignored, whitespace-only lines
and malformed JSON fail. The final record must have a delimiter unless
`allowFinalRecordWithoutDelimiter: true` is explicit. `maxRecordBytes` is
measured after transport chunking in UTF-8 bytes. An ordinary JSON array is one
record, not an implicit expansion.

```ts
yield *
  http
    .ndjson('/users/export', {
      schema: UserSchema,
      limits: { maxRecordBytes: 1_048_576 },
      retry: false
    })
    .forEach((user) =>
      Effect.fn(async function* () {
        const repository = yield* UserRepository
        yield* Result.await(repository.upsert(user))
        return Result.ok(undefined)
      })
    )
```

The callback is sequential in stream order. A persistence failure after a
record has been delivered is a business failure; do not retry the stream as if
delivery had not happened. Use an application idempotency key when the domain
needs replay protection.

## Server-sent events

`http.sse` is opt-in and incremental. Raw mode yields string `data`; `schema`
decodes every event's JSON data with one schema; `events` maps event names to
schemas and returns a discriminated `SseMessage` union. `event`, `id`,
`lastEventId`, multiline data, comments, UTF-8, and protocol `retry` controls
follow the SSE framing rules. `takeUntil(predicate, { requireMatch: true })`
requires an application terminal; `forEach`, `use`, and `results` provide other
ownership choices.

```ts
const events = http.sse('/jobs/42/events', {
  events: { progress: ProgressSchema, completed: CompletedSchema },
  reconnect: {
    times: 3,
    delay: HttpRetry.exponential({ initialMs: 250, factor: 2, maxMs: 5_000 }),
    resume: 'last-event-id',
    onEnd: 'reconnect'
  },
  timeout: { headersMs: 10_000, readIdleMs: 45_000, totalMs: false }
})

yield * events.takeUntil((message) => message.event === 'completed', { requireMatch: true })
```

Reconnection is disabled by default. `times` counts every new physical opening,
including failed openings; heartbeats and response headers do not reset it.
Only bodyless safe methods are replayable. An initial `lastEventId` comes from
the application. `Last-Event-ID` is a protocol cursor, not a business
checkpoint: the server may not retain history, events can be duplicated, and
the client does not promise exactly-once delivery. Persist business checkpoints
and idempotency independently. POST SSE generation should use `reconnect:
false` and an explicit `completed` event; reconnecting it can repeat work.

## Authentication recovery

Authentication is opt-in. `HttpAuth.authentication` reads a credential for
each physical send. `HttpAuth.refresh` only treats an eligible 401 as expired,
coalesces refreshes by an opaque session key, and permits a bounded replay:

```ts
const authentication = HttpAuth.authentication({
  credential: currentAccessToken
})
const recovery = HttpAuth.refresh({
  maxReplays: 1,
  key: currentSessionKey,
  refresh: refreshSessionToken
})
```

By default only bodyless `GET`, `HEAD`, and `OPTIONS` requests replay. Unsafe
or one-shot requests return `HttpAuthRefreshError`; a refreshed token is not
proof that a write is idempotent. Install the refresh operation on a client or
route without this middleware to avoid recursion. The response and admission
permit are released before refresh. A single-flight map is owned by the client
Layer and must not capture a request-local dependency beyond its lifetime;
when that ownership is unavailable, limit coalescing rather than promoting a
request Service into global state.

## Hono and Web streaming

The core `better-effect` package owns the optional `better-effect/hono` bridge.
`HonoEffect.app` builds the Hono application as a Layer, and `routes.stream`
is the explicit managed streaming terminal. Compose that Layer with the
HTTP-client Layer once:

```ts
const App = HonoEffect.app('@app/Api', {}, async function* (routes) {
  const app = new Hono()
  app.use('*', yield* routes.middleware())
  app.get(
    '/download',
    yield* routes.stream(
      Effect.fn(async function* () {
        const http = yield* HttpClient
        return Result.ok({
          headers: { 'content-type': 'application/octet-stream' },
          producer: async function* () {
            for await (const item of http.stream('/archive').results()) {
              if (Result.isError(item)) throw item.error
              yield item.value
            }
          }
        })
      })
    )
  )
  return app
})

const runtime = await Runtime.make(Layer.merge(HttpClient.layer({ baseURL }), App.layer))
```

The request boundary runs once for the whole Hono chain. The request-local
Scope remains alive after `Response` readiness until the body reaches EOF,
errors, or downstream cancellation. A downstream cancel closes the upstream
reader, retry/reconnect wait, and limit permit. Headers and status must be
decided before commit; after commit, a failure can only close/error the body or
emit an explicitly designed domain event, not replace the response status.
Normal JSON routes keep their existing Hono behavior. `onError` cannot replace
headers that have already been sent, and an unconsumed response body is closed
by the managed idle policy.

## Executable examples

The `examples/` directory is a small local-only recipe set. Every example uses
an identified demo payload, a controlled local server or `HttpTest`, one
Runtime, and `finally`/disposal cleanup. No credentials, paid provider, or
external service is required:

1. `typed-client.ts` — class/schema GET and POST with 404/422 status unions.
2. `auth-retry.ts` — effectful credential, bounded retry, observer, and
   single-flight refresh (with a `ClockTest` fixture).
3. `endpoints-sdk.ts` — safe path/query parameters and explicit domain codec.
4. `download.ts` — byte download directly into a `WritableStream`.
5. `ndjson.ts` — sequential persistence, typed failure, and no retry after
   partial delivery.
6. `sse-progress.ts` — typed progress/completed events and
   `takeUntil(..., { requireMatch: true })`.
7. `sse-resumable.ts` — application-supplied cursor, reconnect budget, and
   business idempotency separate from `Last-Event-ID`.
8. `generation.ts` — POST incremental generation with `reconnect: false` and
   an explicit completed event.
9. `hono-streaming.ts` — managed Hono proxy, first-chunk readiness, and
   downstream cancellation closing upstream.

Run the complete recipe check from this package:

```bash
bun run typecheck:examples
bun run examples:run
bun run test:docs
```

`test:docs` verifies the README/site contract, links, canonical imports, and
the complete example list. The package checks also build the real declaration
artifacts and run the packed consumer fixture.

## Compatibility and limits

This package does not provide a cache, circuit breaker, OpenAPI generator,
server `HttpApi` framework, WebSocket client, cookie jar, unrestricted
authenticated redirects, Range download resume, SSE ACK persistence, remote
history, exactly-once delivery, or browser/edge certification. Callback
cooperation is required: a callback that never settles cannot be forcefully
cancelled. Request origins, redirect policy, credentials, and business
idempotency remain application decisions. These limits are deliberate so the
HTTP boundary stays smaller than Effect and keeps ownership visible at the
Layer, Scope, and Runtime boundaries.
