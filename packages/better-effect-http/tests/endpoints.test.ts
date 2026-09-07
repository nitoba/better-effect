/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof, eslint(no-unused-vars), eslint(require-yield) -- test schema and transport doubles intentionally erase their runtime contracts. */
import { expect, test } from 'bun:test'
import { bindEndpoints, HttpEndpoint } from '../src/endpoints.ts'

const schema = <T>(check: (value: unknown) => value is T) => ({
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => (check(value) ? { value } : { issues: [{ message: 'invalid' }] })
  }
})

test('declarative endpoints validate and encode path parameters at consumption time', async () => {
  let request: { path: string; options: Record<string, unknown> } | undefined
  const client = {
    request: (method: string, path: string, options: Record<string, unknown>) => {
      request = { path: `${method} ${path}`, options }
      return (async function* () {
        yield* []
        return {
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          url: path,
          data: { id: 'ok' }
        }
      })()
    }
  } as never
  const endpoints = bindEndpoints(client, {
    find: HttpEndpoint.get('/users/:id', {
      params: schema((v): v is { id: string } => !!v && typeof v === 'object' && 'id' in v)
    })
  })
  const operation = endpoints.find({ params: { id: 'a/b?x#y' } })
  expect(request).toBeUndefined()
  const result = await operation.next()
  expect(result.done).toBe(true)
  expect(request?.path).toBe('GET /users/a%2Fb%3Fx%23y')
})

test('endpoint body codecs encode the domain value exactly once', async () => {
  let encodeCalls = 0
  let request: { readonly options: Record<string, unknown> } | undefined
  const domain = schema((value): value is { readonly id: string } => {
    throw new Error(`body schema must not run: ${String(value)}`)
  })
  const wire = schema(
    (value): value is { readonly user_id: string } =>
      !!value && typeof value === 'object' && 'user_id' in value
  )
  const codec = {
    schema: domain,
    encodedSchema: wire,
    encode(value: { readonly id: string }) {
      encodeCalls += 1
      return { status: 'ok' as const, value: { user_id: value.id } }
    }
  }
  const client = {
    request: (_method: string, _path: string, options: Record<string, unknown>) => {
      request = { options }
      return (async function* () {
        yield* []
        return {
          status: 201,
          statusText: 'Created',
          headers: new Headers(),
          url: '/users',
          data: { ok: true }
        }
      })()
    }
  } as never

  const endpoints = bindEndpoints(client, {
    create: HttpEndpoint.post('/users', { bodyCodec: codec })
  })
  const result = await endpoints.create({ body: { id: 'user-1' } }).next()

  expect(result.done).toBe(true)
  expect(request?.options.body).toEqual({ user_id: 'user-1' })
  expect(encodeCalls).toBe(1)
})

test('endpoint body and bodyCodec are mutually exclusive at runtime', async () => {
  let bodyValidations = 0
  let encodeCalls = 0
  const body = schema((_: unknown): _ is { readonly id: string } => {
    bodyValidations += 1
    return false
  })
  const codec = {
    schema: body,
    encodedSchema: body,
    encode() {
      encodeCalls += 1
      return { status: 'ok' as const, value: { id: 'encoded' } }
    }
  }
  const client = {
    request: () => {
      throw new Error('request must not run')
    }
  } as never

  const endpoints = bindEndpoints(client, {
    invalid: HttpEndpoint.post('/users', { body, bodyCodec: codec } as never)
  })
  const operation = endpoints.invalid({ body: { id: 'user-1' } } as never)
  const first = await operation.next()

  expect(first.done).toBe(false)
  expect(bodyValidations).toBe(0)
  expect(encodeCalls).toBe(0)
  expect('error' in first.value).toBe(true)
  if ('error' in first.value)
    expect(first.value.error).toMatchObject({ _tag: 'HttpRequestError', phase: 'request' })
})
