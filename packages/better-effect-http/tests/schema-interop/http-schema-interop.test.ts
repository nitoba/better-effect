// oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-reflect-get, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- fixtures model provider-neutral Standard Schema and Fetch boundaries.
import { Effect, Runtime } from 'better-effect'
import {
  Class,
  Schema,
  SchemaUnsupportedOperation,
  TaggedClass,
  TaggedError,
  type StandardSchemaV1
} from 'better-effect-schema'
import { Result } from 'better-result'
import * as v from 'valibot'
import { type as arkType } from 'arktype'
import * as z from 'zod'
import { expect, test } from 'bun:test'
import { HttpClient, HttpEndpoint } from '../../src/index.ts'

const makeSchema = <Input, Output>(
  validate: (
    value: unknown
  ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
  vendor = 'better-effect-http-schema-interop'
): StandardSchemaV1<Input, Output> => ({
  '~standard': {
    version: 1,
    vendor,
    types: undefined as unknown as StandardSchemaV1.Types<Input, Output>,
    validate
  }
})

const responseFetch = (
  body: string,
  status = 200,
  headers: Record<string, string> = { 'content-type': 'application/json' }
): typeof globalThis.fetch =>
  Object.assign(async () => new Response(body, { status, headers }), {
    preconnect: () => {}
  }) as typeof globalThis.fetch

const streamFetch = (
  body: string,
  headers: Record<string, string> = { 'content-type': 'application/x-ndjson' }
): typeof globalThis.fetch =>
  Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body))
            controller.close()
          }
        }),
        { status: 200, headers }
      ),
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

const run = <A>(fetch: typeof globalThis.fetch, program: unknown) =>
  Runtime.run(HttpClient.layer({ fetch }), program as never) as Promise<Result<A, unknown>>

const idSchema = makeSchema<unknown, string>((value) =>
  typeof value === 'string' ? { value } : { issues: [{ message: 'Expected an id' }] }
)

const wireUserSchema = makeSchema<unknown, { readonly id: string; readonly label: string }>(
  (value) => {
    if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'id') !== 'string')
      return { issues: [{ message: 'Expected a user object' }] }
    const label = Reflect.get(value, 'label')
    return {
      value: {
        id: Reflect.get(value, 'id') as string,
        label: typeof label === 'string' ? label : 'default-label'
      }
    }
  }
)

const userPropsSchema = makeSchema<
  { readonly id: string; readonly label: string },
  { readonly id: string; readonly label: string }
>((value) => {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof Reflect.get(value, 'id') !== 'string' ||
    typeof Reflect.get(value, 'label') !== 'string'
  )
    return { issues: [{ message: 'Expected normalized user properties' }] }
  return {
    value: {
      id: Reflect.get(value, 'id') as string,
      label: Reflect.get(value, 'label') as string
    }
  }
})

class User extends Class<User>('schema-interop/User')({
  schema: wireUserSchema,
  propsSchema: userPropsSchema,
  encodedSchema: wireUserSchema,
  encode: (value: { readonly id: string; readonly label: string }) => ({
    id: value.id,
    label: value.label
  })
}) {
  #prefix = 'user'

  get displayName(): string {
    return `${this.#prefix}:${this.label}`
  }

  greet(): string {
    return `Hello ${this.displayName}`
  }
}

class Updated extends TaggedClass<Updated>()('Updated', { id: idSchema }) {
  isUpdated(): boolean {
    return this._tag === 'Updated'
  }
}

class DomainFailure extends TaggedError<DomainFailure>()('DomainFailure', { id: idSchema }) {}

test('buffered HTTP decodes Standard Schema providers without provider adapters', async () => {
  const providers = [
    { name: 'zod', schema: z.object({ id: z.string(), count: z.number() }) },
    { name: 'valibot', schema: v.object({ id: v.string(), count: v.number() }) },
    { name: 'arktype', schema: arkType({ id: 'string', count: 'number' }) }
  ] as const

  for (const provider of providers) {
    const result = await run<unknown>(
      responseFetch('{"id":"provider","count":1}'),
      Effect.fn(async function* () {
        const http = yield* HttpClient
        const response = yield* http.get('/users/provider', { schema: provider.schema })
        return Result.ok(response.data)
      })
    )

    expect(result).toEqual(Result.ok({ id: 'provider', count: 1 }))
  }
})

test('buffered HTTP preserves real class and tagged outputs', async () => {
  const userResult = await run<User>(
    responseFetch('{"id":"u-1","label":"Ada"}'),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const response = yield* http.get('/users/u-1', { schema: User })
      return Result.ok(response.data)
    })
  )

  expect(Result.isError(userResult)).toBe(false)
  if (Result.isError(userResult)) return
  expect(userResult.value).toBeInstanceOf(User)
  expect(userResult.value.displayName).toBe('user:Ada')
  expect(userResult.value.greet()).toBe('Hello user:Ada')

  const tagged = await run<Updated>(
    responseFetch('{"_tag":"Updated","id":"u-1"}'),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const response = yield* http.get('/users/u-1/updated', { schema: Updated })
      return Result.ok(response.data)
    })
  )
  expect(Result.isError(tagged)).toBe(false)
  if (Result.isError(tagged)) return
  expect(tagged.value).toBeInstanceOf(Updated)
  expect(tagged.value.isUpdated()).toBe(true)

  const failure = await run<DomainFailure>(
    responseFetch('{"_tag":"DomainFailure","id":"u-1"}'),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const response = yield* http.get('/users/u-1/failure', { schema: DomainFailure })
      return Result.ok(response.data)
    })
  )
  expect(Result.isError(failure)).toBe(false)
  if (Result.isError(failure)) return
  expect(failure.value).toBeInstanceOf(DomainFailure)
  expect(failure.value._tag).toBe('DomainFailure')
})

test('NDJSON and SSE preserve class instances for every decoded value', async () => {
  const ndjson = await run<readonly User[]>(
    streamFetch('{"id":"u-1","label":"Ada"}\n{"id":"u-2","label":"Grace"}\n'),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const values: User[] = []
      yield* http.ndjson('/users', { schema: User }).forEach((value) => {
        values.push(value)
        return Result.ok(undefined)
      })
      return Result.ok(values)
    })
  )

  expect(Result.isError(ndjson)).toBe(false)
  if (Result.isError(ndjson)) return
  expect(ndjson.value).toHaveLength(2)
  expect(ndjson.value.every((value) => value instanceof User)).toBe(true)
  expect(ndjson.value.map((value) => value.greet())).toEqual(['Hello user:Ada', 'Hello user:Grace'])

  const sse = await run<readonly User[]>(
    streamFetch('event: updated\ndata: {"id":"u-3","label":"Lin"}\n\n', {
      'content-type': 'text/event-stream'
    }),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const values: User[] = []
      yield* http.sse('/events', { events: { updated: User } }).forEach((message) => {
        values.push(message.data)
        return Result.ok(undefined)
      })
      return Result.ok(values)
    })
  )

  expect(Result.isError(sse)).toBe(false)
  if (Result.isError(sse)) return
  expect(sse.value).toHaveLength(1)
  expect(sse.value[0]).toBeInstanceOf(User)
  expect(sse.value[0]?.greet()).toBe('Hello user:Lin')
})

test('endpoint body codecs encode a class once and decode the response class', async () => {
  let encodes = 0
  let sentBody: unknown
  const codec = {
    schema: User,
    encodedSchema: makeSchema<unknown, { readonly user_id: string }>((value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        typeof Reflect.get(value, 'user_id') !== 'string'
      )
        return { issues: [{ message: 'Expected encoded user' }] }
      return { value: { user_id: Reflect.get(value, 'user_id') as string } }
    }),
    encode(value: User) {
      encodes += 1
      return { status: 'ok' as const, value: { user_id: value.id } }
    }
  }
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      sentBody = init?.body
      return new Response('{"id":"u-1","label":"Saved"}', {
        status: 201,
        headers: { 'content-type': 'application/json' }
      })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const result = await run<User>(
    fetch,
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const decoded = await Schema.decodeUnknownAsync(User, { id: 'u-1', label: 'Ada' })
      if (Result.isError(decoded)) return decoded
      const endpoint = http.endpoints({
        save: HttpEndpoint.post('/users', { bodyCodec: codec, schema: User })
      })
      const response = yield* endpoint.save({ body: decoded.value })
      return Result.ok(response.data)
    })
  )

  expect(Result.isError(result)).toBe(false)
  if (Result.isError(result)) return
  expect(sentBody).toBe('{"user_id":"u-1"}')
  expect(encodes).toBe(1)
  expect(result.value).toBeInstanceOf(User)
  expect(result.value.greet()).toBe('Hello user:Saved')
})

test('one-way schema values are rejected by encoding without an identity fallback', async () => {
  const oneWay = { schema: wireUserSchema, encodedSchema: wireUserSchema } as never
  const result = await Schema.encodeAsync(oneWay, { id: 'u-1', label: 'Ada' } as never)

  expect(Result.isError(result)).toBe(true)
  if (Result.isError(result)) expect(result.error).toBeInstanceOf(SchemaUnsupportedOperation)
})
