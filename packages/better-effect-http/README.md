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
