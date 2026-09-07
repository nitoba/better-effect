# better-effect-http

Layer-first HTTP client foundations for `better-effect`.

This package is the distribution boundary for the HTTP roadmap. It provides a
lazy, `yield*`-compatible client built on the platform Fetch API and `ofetch`,
including response validation through the provider-neutral Standard Schema API
from `better-effect-schema`.

The package is intentionally separate from `better-effect`. It uses `ofetch`
as its planned internal transport and does not make any network request, read
environment variables, create a Runtime, or register listeners during import.

```bash
bun add better-effect-http
```

Define a client as a `better-effect` Service and provide it with a Layer:

```ts
import { Effect, Runtime } from 'better-effect'
import { HttpClient } from 'better-effect-http'
import { Result } from 'better-result'

const App = Effect.fn(async function* () {
  const http = yield* HttpClient
  const response = yield* http.response('/users/42', {
    responses: {
      200: UserSchema,
      404: UserNotFoundSchema
    }
  })

  return Result.ok(response.status === 404 ? null : response.data)
})

const result = await Runtime.run(HttpClient.layer({ baseURL: 'https://api.example.com' }), App)
```

`http.get(path, { schema })` validates successful responses with one schema.
`http.response(path, { responses })` selects and validates the schema matching
the final status, preserving the status/data correlation in TypeScript. A
status that is not declared in `responses` is returned as `HttpStatusError`.

NDJSON responses are decoded incrementally, one UTF-8 JSON record at a time. A
schema is optional; when present its transformed output is delivered to the
consumer exactly once per record:

```ts
const users = http.ndjson('/users/export', {
  schema: UserSchema,
  limits: { maxRecordBytes: 1_048_576 }
})

yield *
  users.forEach((user) =>
    Effect.fn(async function* () {
      const repository = yield* UserRepository
      yield* Result.await(repository.upsert(user))
      return Result.ok(undefined)
    })
  )
```

Records are separated by LF or CRLF. Empty lines are ignored, while whitespace
lines and malformed JSON terminate the stream. A final record must end in a
newline unless `allowFinalRecordWithoutDelimiter: true` is set. The record
limit is measured in UTF-8 bytes (independent of transport chunking), and an
ordinary JSON array is delivered as one record rather than expanded.

Authentication recovery is opt-in. Keep the session key opaque and derive the
current credential for each physical send; refresh state is shared only while
the same key is in flight:

```ts
import { HttpAuth } from 'better-effect-http'

const authentication = HttpAuth.authentication({
  credential: currentAccessToken
})
const recovery = HttpAuth.refresh({
  maxReplays: 1,
  key: currentSessionKey,
  refresh: refreshSessionToken
})
```

Only replayable, bodyless `GET`, `HEAD`, and `OPTIONS` requests are retried by
the default 401 policy. Unsafe or one-shot requests return a typed
`HttpAuthRefreshError`; refresh failures are never converted into network
errors. Configure the refresh endpoint with a client or route that does not
install this middleware to avoid recursion.

SSE streams are consumed incrementally through `http.sse`. Raw streams expose
string data; `schema` parses each event's data as JSON and validates it once,
while `events` selects a schema by event name and returns a discriminated
`SseMessage` union. Reconnection is disabled by default and can be enabled with
a finite opening budget. Only bodyless safe methods can be replayed
automatically. `lastEventId` is the identifier declared on the event and the
effective protocol cursor, not a business acknowledgement:

```ts
const events = http.sse('/jobs/42/events', {
  events: {
    progress: ProgressSchema,
    completed: CompletedSchema
  },
  lastEventId: persistedCheckpoint,
  reconnect: {
    times: 5,
    delay: HttpRetry.exponential({ initialMs: 500, factor: 2, maxMs: 15_000, jitter: 'full' }),
    resume: 'last-event-id',
    respectServerRetry: true,
    onEnd: 'reconnect'
  },
  timeout: { headersMs: 10_000, readIdleMs: 45_000, totalMs: false }
})

yield * events.forEach((message) => handleEvent(message))
```

The parser accepts UTF-8 chunks, LF/CRLF/CR line endings, comments, multiline
data, and protocol `retry` controls. `times` counts every new physical opening,
including failed openings; a response's headers or heartbeats do not reset the
budget. `Last-Event-ID` is sent only to the configured SSE origin, and an empty
cursor removes the header. A server cannot supply history that it does not
retain, and the client does not deduplicate events or promise exactly-once
delivery; applications own checkpoint persistence and effect idempotency.
Unknown event names fail by default when `events` is supplied; raw mode does
not parse JSON or interpret provider-specific markers.
