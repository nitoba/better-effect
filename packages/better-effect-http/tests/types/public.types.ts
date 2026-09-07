import * as Http from '../../src'
import { expectTypeOf } from 'bun:test'
import type {
  HttpClientInstance,
  HttpOperation,
  HttpResponseOperation,
  HttpStream,
  NdjsonError,
  ResponseData,
  SseEventMessage,
  SseMessage
} from '../../src'
import { Effect, Service } from 'better-effect'
import { Result } from 'better-result'
import type { StandardSchemaV1 } from 'better-effect-schema'

const request = Http.HttpRequest.make('https://example.test')
const authenticated = Http.HttpRequest.bearerToken(request, 'secret')
const status: Http.HttpStatusError = new Http.HttpStatusError({
  phase: 'status',
  status: 500,
  statusText: 'Error',
  headers: new Headers(),
  url: request.url
})

const exactTag: '_tag' extends keyof typeof status ? true : never = true
const immutable: typeof request extends Readonly<{ url: string }> ? true : never = true
void authenticated
void exactTag
void immutable

declare const userSchema: StandardSchemaV1<unknown, { readonly id: number }>
declare const notFoundSchema: StandardSchemaV1<unknown, { readonly reason: string }>
declare const client: HttpClientInstance<'Api'>

const user = client.get('/users/42', { schema: userSchema })
const responses = client.response('/users/42', {
  responses: { 200: userSchema, 404: notFoundSchema }
})

const expectedUser: HttpOperation<{ readonly id: number }> = user
const expectedResponses: HttpResponseOperation<
  ResponseData<{ 200: typeof userSchema; 404: typeof notFoundSchema }>
> = responses

const endpointCodec = {
  schema: userSchema,
  encodedSchema: userSchema,
  encode(value: { readonly id: number }) {
    return Result.ok({ id: value.id })
  }
}
const codecEndpoint = Http.HttpEndpoint.post('/users', { bodyCodec: endpointCodec })
expectTypeOf<Http.HttpEndpointArgs<typeof codecEndpoint.definition>>().toEqualTypeOf<{
  readonly body: { readonly id: number }
}>()

// @ts-expect-error endpoint body validation and explicit body encoding are mutually exclusive.
Http.HttpEndpoint.post('/users', { body: userSchema, bodyCodec: endpointCodec })

const rawEvents = client.sse('/events')
const typedEvents = client.sse('/events', { schema: userSchema })
const namedEvents = client.sse('/events', {
  events: { progress: userSchema, failed: notFoundSchema },
  reconnect: false,
  timeout: { headersMs: 10_000, readIdleMs: 45_000, totalMs: false }
})
type ExpectedNamedEvents = SseEventMessage<{
  readonly progress: typeof userSchema
  readonly failed: typeof notFoundSchema
}>
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false
type Assert<Condition extends true> = Condition
type _RawEventsExact = Assert<
  Equal<NonNullable<(typeof rawEvents)['_A']>, SseMessage<string, string>>
>
type _TypedEventsExact = Assert<
  Equal<NonNullable<(typeof typedEvents)['_A']>, SseMessage<string, { readonly id: number }>>
>
type _NamedEventsExact = Assert<Equal<NonNullable<(typeof namedEvents)['_A']>, ExpectedNamedEvents>>
const handleNamed = (message: ExpectedNamedEvents): void => {
  if (message.event === 'progress') {
    const id: number = message.data.id
    void id
  } else {
    const reason: string = message.data.reason
    void reason
  }
}

// @ts-expect-error schema and events are mutually exclusive.
client.sse('/events', { schema: userSchema, events: { progress: userSchema } })

void rawEvents
void typedEvents
void namedEvents
void handleNamed

const recovery = Http.HttpAuth.refresh({
  maxReplays: 1,
  key: 'session',
  refresh: 'token'
})
const typedRecovery: Http.HttpAuthMiddleware<never, never> = recovery
const configured = Http.HttpClient.service('Configured', {
  interceptors: [Http.HttpAuth.authentication({ credential: 'token' })],
  middleware: [typedRecovery]
})

void expectedUser
void expectedResponses
void typedRecovery
void configured

declare const userRecordSchema: StandardSchemaV1<unknown, { readonly id: number }>
const typedNdjson = client.ndjson('/users', {
  schema: userRecordSchema,
  limits: { maxRecordBytes: 1024 }
})
const unknownNdjson = client.ndjson('/users')

expectTypeOf<typeof typedNdjson>().toEqualTypeOf<HttpStream<{ readonly id: number }, NdjsonError>>()
expectTypeOf<typeof unknownNdjson>().toEqualTypeOf<HttpStream<unknown, NdjsonError>>()

class UserRepository extends Service<UserRepository>()('UserRepository') {}
const consuming = Effect.fn(async function* () {
  yield* typedNdjson.forEach(() =>
    Effect.fn(async function* () {
      const repository = yield* UserRepository
      void repository
      return Result.ok(undefined)
    })
  )
  return Result.ok(undefined)
})
expectTypeOf<Effect.Requirements<typeof consuming>>().toEqualTypeOf<UserRepository>()
