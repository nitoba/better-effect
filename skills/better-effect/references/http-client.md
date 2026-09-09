# HTTP client, policies, and streaming

Package: `better-effect-http`. It is an outbound, server-side client using
ofetch internally, not a server framework or a re-export of ofetch options.
Public reference: [HTTP README](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-http/README.md).

## Client and typed endpoints

`HttpClient` is a Service token with `.layer(options)`. A request creates a lazy,
single-use Operation; consumption inside the active Runtime sends it. Create a
new Operation for another call rather than reusing a consumed one. Named clients
use `HttpClient.service(tag, hooks)` and their generated `.layer(options)`.
`client.use(...)` derives a client without mutating the shared one.

```ts
import * as z from 'zod'
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { HttpClient, HttpEndpoint } from 'better-effect-http'

const User = z.object({ id: z.string(), name: z.string() })
const Missing = z.object({ reason: z.string() })
const endpoints = {
  find: HttpEndpoint.get('/users/:id', {
    params: z.object({ id: z.string() }),
    responses: { 200: User, 404: Missing }
  })
}

const findUser = (id: string) =>
  Effect.fn(async function* () {
    const http = yield* HttpClient
    const api = http.endpoints(endpoints)
    const response = yield* api.find({ params: { id } })
    return Result.ok(response)
  })

await using runtime = await Runtime.make(
  HttpClient.layer({ baseURL: 'https://api.example.test' })
)
// A real application supplies its reachable baseURL before executing findUser.
```

The endpoint safely encodes path parameters. Its declared 404 is a successful,
status-discriminated response, not `HttpStatusError`; inspect `response.status`
to narrow `response.data`. An undeclared status fails. For one schema on all
successful statuses, use `schema` instead of `responses` (not both).

Methods include `get`, `post`, `put`, `patch`, `delete`, `head`, and
`request(method, path, options)`. Options include query, headers, body, signal,
timeout, responseType, schema, and responses. Without schema validation, JSON
data is unknown: a generic annotation is not runtime validation. Empty bodies,
HEAD, and 204/205/304 responses may have undefined data.

`HttpEndpoint` is also exposed by `better-effect-http/endpoints`. For domain
bodies with a different transport representation, declare `bodyCodec` with
`schema`, `encodedSchema`, and an explicit `encode` returning Result. `body`
and `bodyCodec` are mutually exclusive. Follow the executable
[endpoint/codec recipe](https://github.com/nitoba/better-effect/blob/main/packages/better-effect-http/examples/endpoints-sdk.ts).

## Hooks: do not conflate their roles

| API | Boundary | Rule |
| --- | --- | --- |
| `HttpInterceptor.make` | Request/response transformation per physical attempt | Derive immutable requests with `HttpRequest` helpers |
| `HttpInterceptor.observe` | Logical outcome/reconnect diagnostics | Best effort; observer failures must not change the result |
| `HttpMiddleware.make` | Whole logical operation around `next` | Use for bounded recovery/policy, not per-attempt instrumentation |

Effectful hooks retain E/R. Resolve credentials and request context when invoked,
not while constructing a shared Layer. Do not widen a generic Operation type to
erase these requirements. The active execution supplies resolver, signal, and
Scope; hooks must not start a second Runtime to get missing Services.

## Retry, deadlines, limits, and auth

```ts
import { HttpRetry } from 'better-effect-http'

const retry = HttpRetry.transient({
  times: 2,
  delay: HttpRetry.exponential({
    initialMs: 100,
    factor: 2,
    maxMs: 1_000,
    jitter: 'full'
  }),
  respectRetryAfter: true,
  totalMs: 2_500
})
```

Pass this as request `retry`, optionally with
`timeout: { attemptMs: 700, totalMs: 3_000 }`. `times` counts **additional**
physical attempts. ofetch retries are disabled: there must be one retry
controller, not nested invisible retry loops. Transient defaults are conservative
and use GET/HEAD/OPTIONS. Method safety does not make a one-shot body replayable,
and a retryable status does not make a write idempotent.

Client Layer `limits` support shared concurrency, a local rate
`{ requests, perMs }`, and `queue.maxSize`. Admission is per physical send;
retries consume capacity too. Local limits are not remote quotas or durable
queues. Use Program collection concurrency deliberately as a separate bound.

`HttpAuth.authentication({ credential })` obtains a credential per send.
`HttpAuth.refresh({ maxReplays, key, refresh })` permits bounded eligible-401
recovery and coalesces by an opaque session key. Default replay is restricted to
bodyless safe methods. Use a separate unwrapped refresh path to avoid recursion;
do not capture request-scoped Services in a Layer-owned single-flight cache.
Credential refresh is not proof that replaying a POST is safe.

## Byte streams, NDJSON, and SSE

`http.stream(path, options)` is an unstarted `HttpStream<Uint8Array>`.
`pipeTo(writable)` streams without buffering the whole file. `forEach`, `use`,
and `takeUntil` are scoped terminals; `results()` exposes async Result chunks.
Own the reader/session through EOF, early break, failure, or cancellation.
A closed session cannot be consumed again.

`http.ndjson(path, { schema, limits: { maxRecordBytes }, retry: false })`
decodes records incrementally. `forEach` callbacks are sequential and may return
Programs requiring application Services. A failure after partial delivery must
not replay the whole business stream implicitly. UTF-8 byte limits are not
character counts; check the installed parser policy for an unterminated final
record instead of assuming permissive parsing.

SSE supports raw string data, one `schema` for all JSON event data, or an
`events` map for a discriminated event union. Within an active Program, with
native Progress and Completed schemas already defined:

```ts
const http = yield* HttpClient
const events = http.sse('/jobs/42/events', {
  events: { progress: Progress, completed: Completed },
  reconnect: {
    times: 3,
    delay: HttpRetry.exponential({ initialMs: 250, factor: 2, maxMs: 5_000 }),
    resume: 'last-event-id',
    onEnd: 'reconnect'
  },
  timeout: { headersMs: 10_000, readIdleMs: 45_000, totalMs: false }
})
yield* events.takeUntil((message) => message.event === 'completed', { requireMatch: true })
```

Reconnect is disabled by default. Its budget counts physical openings,
including failed openings. Only replayable
bodyless safe requests reconnect. For POST generation use `reconnect: false`
and an explicit terminal event. Last-Event-ID is a protocol cursor, not durable
business acknowledgement or exactly-once delivery. Persist checkpoints and
idempotency separately.

To proxy a stream from Hono/Web, use the [managed framework boundary](frameworks.md).
Keep the request Scope and upstream reader alive until downstream completion;
do not release them when headers become ready or map a late failure to a new
status after commit.

## Diagnostics, testing, and limits

`better-effect-http/testing` exports `HttpTest` and controlled streams for
local deterministic transport tests. Test first-chunk readiness, cancel,
partial delivery, one-shot bodies, retry budgets, and secret redaction, not
just buffered successful JSON. The package's `examples/` directory has runnable
recipes for typed clients, auth/retry, endpoints, download, NDJSON, SSE progress,
resumption, generation, and Hono streaming.

`better-effect-http/opentelemetry` provides `HttpTelemetry.observe` using the
application's tracer. Trace/baggage propagation needs an explicit
`allowedOrigins` policy; redirects must not expand credential or propagation
scope. Default diagnostics redact tokens, cookies, query data, bodies, cursors,
and arbitrary causes. Distinguish transport, timeout/abort, status, decode,
provider execution, hook, and admission failures rather than collapsing them.

Do not invent cache, circuit-breaker, WebSocket, cookie-jar, OpenAPI/server
HttpApi, Range-resume, browser/Edge certification, or exactly-once guarantees.
Use only exports supported by the installed package.
