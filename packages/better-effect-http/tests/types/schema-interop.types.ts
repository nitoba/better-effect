// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- declarations intentionally model external Standard Schema boundaries.
import { Effect, Service } from 'better-effect'
import { Schema, TaggedClass, type StandardSchemaV1 } from 'better-effect-schema'
import { Result } from 'better-result'
import { expectTypeOf } from 'bun:test'
import { type as arkType } from 'arktype'
import * as v from 'valibot'
import * as z from 'zod'
import * as Http from '../../src/index'
import type {
  HttpEndpointArgs,
  HttpOperation,
  HttpStream,
  NdjsonError,
  SseEventMessage
} from '../../src/index'

class User extends Schema.Class<User>('schema-interop/User')({
  schema: {
    '~standard': {
      version: 1,
      vendor: 'schema-interop-types',
      types: undefined as unknown as StandardSchemaV1.Types<unknown, { readonly id: string }>,
      validate: (value: unknown) =>
        typeof value === 'object' && value !== null && typeof Reflect.get(value, 'id') === 'string'
          ? { value: { id: Reflect.get(value, 'id') as string } }
          : { issues: [{ message: 'Expected a user' }] }
    }
  },
  propsSchema: {
    '~standard': {
      version: 1,
      vendor: 'schema-interop-types',
      types: undefined as unknown as StandardSchemaV1.Types<
        { readonly id: string },
        { readonly id: string }
      >,
      validate: (value: unknown) =>
        typeof value === 'object' && value !== null && typeof Reflect.get(value, 'id') === 'string'
          ? { value: { id: Reflect.get(value, 'id') as string } }
          : { issues: [{ message: 'Expected user props' }] }
    }
  }
}) {}

class Updated extends TaggedClass<Updated>()('Updated', {
  id: {
    '~standard': {
      version: 1,
      vendor: 'schema-interop-types',
      types: undefined as unknown as StandardSchemaV1.Types<unknown, string>,
      validate: (value: unknown) =>
        typeof value === 'string' ? { value } : { issues: [{ message: 'Expected id' }] }
    }
  }
}) {}

const client = null as unknown as Http.HttpClientInstance<'Interop'>
const userRequest = client.get('/users/1', { schema: User })
expectTypeOf<typeof userRequest>().toEqualTypeOf<HttpOperation<User>>()
const typedNdjson = client.ndjson('/users', { schema: User })
expectTypeOf<typeof typedNdjson>().toEqualTypeOf<HttpStream<User, NdjsonError>>()
const typedSse = client.sse('/events', { events: { updated: Updated } })
expectTypeOf<NonNullable<(typeof typedSse)['_A']>>().toEqualTypeOf<
  SseEventMessage<{ readonly updated: typeof Updated }>
>()

const zodWire = z.object({ user_id: z.string() })
const zodDomain = z.object({ id: z.string() })
const userCodec = {
  schema: zodDomain,
  encodedSchema: zodWire,
  encode(value: z.output<typeof zodDomain>) {
    return Result.ok({ user_id: value.id })
  }
}
const codecEndpoint = Http.HttpEndpoint.post('/users', {
  bodyCodec: userCodec,
  schema: User
})
expectTypeOf<HttpEndpointArgs<typeof codecEndpoint.definition>>().toEqualTypeOf<{
  readonly body: z.output<typeof zodDomain>
}>()

// @ts-expect-error a wire body schema cannot be combined with a domain codec.
Http.HttpEndpoint.post('/users', { body: zodWire, bodyCodec: userCodec })

const providerSchemas = [
  z.object({ id: z.string() }),
  v.object({ id: v.string() }),
  arkType({ id: 'string' })
] as const
for (const providerSchema of providerSchemas) {
  const operation = client.get('/users', { schema: providerSchema })
  expectTypeOf<typeof operation>().toMatchTypeOf<HttpOperation<{ readonly id: string }>>()
}

class UserRepository extends Service<UserRepository>()('SchemaInteropRepository') {}
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
