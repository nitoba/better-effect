import { expectTypeOf } from 'bun:test'
import type { StandardSchemaV1 } from 'better-effect-schema'
import type {
  HttpClientInstance,
  HttpEndpointArgs,
  HttpOperation,
  HttpResponseOperation,
  HttpStream,
  NdjsonError,
  ResponseData,
  SseEventMessage
} from '../../src'
import { HttpEndpoint } from '../../src'

declare const userSchema: StandardSchemaV1<unknown, { readonly id: string }>
declare const notFoundSchema: StandardSchemaV1<unknown, { readonly reason: string }>
declare const client: HttpClientInstance<'DocsClient'>

const typedGet = client.get('/users/1', { schema: userSchema })
const statusGet = client.get('/users/1', {
  responses: { 200: userSchema, 404: notFoundSchema }
})
expectTypeOf<typeof typedGet>().toEqualTypeOf<HttpOperation<{ readonly id: string }>>()
expectTypeOf<typeof statusGet>().toEqualTypeOf<
  HttpResponseOperation<
    ResponseData<{ readonly 200: typeof userSchema; readonly 404: typeof notFoundSchema }>
  >
>()

const endpoint = HttpEndpoint.post('/users/:id', {
  params: userSchema,
  bodyCodec: {
    schema: userSchema,
    encodedSchema: userSchema,
    encode(value: { readonly id: string }) {
      return { status: 'ok' as const, value: { id: value.id } }
    }
  }
})
declare const endpointArgs: HttpEndpointArgs<typeof endpoint.definition>
expectTypeOf<typeof endpointArgs>().toMatchTypeOf<{
  readonly params: unknown
  readonly body: { readonly id: string }
}>()

const events = client.sse('/events', { events: { progress: userSchema, failed: notFoundSchema } })
expectTypeOf<NonNullable<(typeof events)['_A']>>().toEqualTypeOf<
  SseEventMessage<{ readonly progress: typeof userSchema; readonly failed: typeof notFoundSchema }>
>()

const records = client.ndjson('/users', { schema: userSchema })
expectTypeOf<typeof records>().toEqualTypeOf<HttpStream<{ readonly id: string }, NdjsonError>>()
