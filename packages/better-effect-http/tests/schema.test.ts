// oxlint-disable anti-slop/no-chained-type-assertions -- fixtures intentionally model external schemas and fetch providers.
// oxlint-disable anti-slop/no-runtime-typeof -- this file exercises runtime boundary values.
// oxlint-disable anti-slop/no-unknown-parameters -- the schema fixture receives Standard Schema's unknown input.
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- fixture assertions document external protocol boundaries.
import { Effect } from 'better-effect'
import type { EffectYield } from 'better-effect'
import { SchemaDecodeFailure, SchemaExecutionFailure } from 'better-effect-schema'
import { Result } from 'better-result'
import { expect, test } from 'bun:test'
import {
  HttpClient,
  HttpDecodeError,
  HttpStatusError,
  operation,
  safeErrorJSON
} from '../src/index.ts'
import type { HttpError, HttpOperation } from '../src/index.ts'
import type { StandardSchemaV1 } from 'better-effect-schema'

const makeSchema = <Output>(
  validate: (
    value: unknown
  ) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>
): StandardSchemaV1<unknown, Output> => ({
  '~standard': {
    version: 1,
    vendor: 'better-effect-http-tests',
    types: undefined as unknown as StandardSchemaV1.Types<unknown, Output>,
    validate
  }
})

const makeFetch = (body: string, status: number): typeof globalThis.fetch =>
  Object.assign(async () => new Response(body, { status, statusText: `Status ${status}` }), {
    preconnect: () => {}
  }) as typeof globalThis.fetch

const run = async <A>(httpOperation: AsyncGenerator<EffectYield, A, unknown>) =>
  Effect.gen(async function* () {
    const response = yield* httpOperation
    return Result.ok(response)
  })

const expectError = async <A>(httpOperation: HttpOperation<A>): Promise<HttpError> => {
  const result = await run(httpOperation)
  expect(Result.isError(result)).toBe(true)
  if (!Result.isError(result)) throw new Error('Expected an HTTP error')
  return result.error as HttpError
}

test('decodes a transformed async schema exactly once', async () => {
  let calls = 0
  const user = makeSchema<{ id: number; source: string }>(async (value) => {
    calls++
    await Promise.resolve()
    const input = value as { readonly id: string }
    return { value: { id: Number(input.id), source: 'wire' } }
  })

  const result = await run(
    operation(
      { fetch: makeFetch('{"id":"42"}', 200) },
      { method: 'GET', path: 'https://example.test/users/42', options: { schema: user } }
    )
  )

  expect(Result.isError(result)).toBe(false)
  if (Result.isError(result)) return
  expect(result.value.data).toEqual({ id: 42, source: 'wire' })
  expect(calls).toBe(1)
})

test('schema-only requests apply the schema only to successful statuses', async () => {
  let calls = 0
  const schema = makeSchema(() => {
    calls++
    return { value: 'decoded' }
  })

  const error = await expectError(
    operation(
      { fetch: makeFetch('{"message":"not found"}', 404) },
      { method: 'GET', path: 'https://example.test/missing', options: { schema } }
    )
  )

  expect(error).toBeInstanceOf(HttpStatusError)
  expect(calls).toBe(0)
})

test('response schemas discriminate successful and expected error statuses', async () => {
  const user = makeSchema<{ id: number }>((value) => ({ value: value as { id: number } }))
  const missing = makeSchema<{ reason: string }>((value) => ({
    value: { reason: (value as { message: string }).message }
  }))
  const responses = { 200: user, 404: missing } as const

  const success = await run(
    operation(
      { fetch: makeFetch('{"id":7}', 200) },
      { method: 'GET', path: 'https://example.test/users/7', options: { responses } }
    )
  )
  const notFound = await run(
    operation(
      { fetch: makeFetch('{"message":"gone"}', 404) },
      { method: 'GET', path: 'https://example.test/users/7', options: { responses } }
    )
  )

  expect(Result.isError(success)).toBe(false)
  expect(Result.isError(notFound)).toBe(false)
  if (Result.isError(success) || Result.isError(notFound)) return
  expect(success.value.status).toBe(200)
  expect(success.value.data).toEqual({ id: 7 })
  expect(notFound.value.status).toBe(404)
  expect(notFound.value.data).toEqual({ reason: 'gone' })
})

test('an undeclared status is an HTTP status error and never uses another schema', async () => {
  let calls = 0
  const schema = makeSchema(() => {
    calls++
    return { value: 'wrong schema' }
  })

  const error = await expectError(
    operation(
      { fetch: makeFetch('{"message":"unprocessable"}', 422) },
      {
        method: 'GET',
        path: 'https://example.test/users/7',
        options: { responses: { 200: schema } }
      }
    )
  )

  expect(error).toBeInstanceOf(HttpStatusError)
  expect(error).toMatchObject({ status: 422 })
  expect(calls).toBe(0)
})

test('schema failures and schema execution failures remain distinguishable', async () => {
  const invalid = makeSchema<{ id: number }>(() => ({
    issues: [{ message: 'wire payload must not be serialized into diagnostics' }]
  }))
  const invalidError = await expectError(
    operation(
      { fetch: makeFetch('{"id":"bad"}', 200) },
      { method: 'GET', path: 'https://example.test/users/7', options: { schema: invalid } }
    )
  )

  expect(invalidError).toBeInstanceOf(HttpDecodeError)
  if (!(invalidError instanceof HttpDecodeError)) return
  expect(invalidError).toMatchObject({ kind: 'schema' })
  expect(invalidError.cause).toBeInstanceOf(SchemaDecodeFailure)
  expect(safeErrorJSON(invalidError)).toEqual({ _tag: 'HttpDecodeError' })

  const execution = makeSchema<{ id: number }>(() => {
    throw new Error('provider secret')
  })
  const executionError = await expectError(
    operation(
      { fetch: makeFetch('{"id":7}', 200) },
      { method: 'GET', path: 'https://example.test/users/7', options: { schema: execution } }
    )
  )

  expect(executionError).toBeInstanceOf(HttpDecodeError)
  if (!(executionError instanceof HttpDecodeError)) return
  expect(executionError).toMatchObject({ kind: 'provider' })
  expect(executionError.cause).toBeInstanceOf(SchemaExecutionFailure)
  expect(JSON.stringify(executionError)).not.toContain('provider secret')
})

test('invalid JSON fails during parsing before schema validation', async () => {
  let calls = 0
  const schema = makeSchema(() => {
    calls++
    return { value: 'decoded' }
  })
  const error = await expectError(
    operation(
      { fetch: makeFetch('{not-json', 200) },
      { method: 'GET', path: 'https://example.test/users/7', options: { schema } }
    )
  )

  expect(error).toBeInstanceOf(HttpDecodeError)
  if (!(error instanceof HttpDecodeError)) return
  expect(error.kind).toBe('provider')
  expect(calls).toBe(0)
})

test('schema and responses cannot be combined at runtime', async () => {
  let calls = 0
  const schema = makeSchema(() => {
    calls++
    return { value: 'decoded' }
  })
  const error = await expectError(
    operation(
      { fetch: makeFetch('{"ok":true}', 200) },
      {
        method: 'GET',
        path: 'https://example.test/users/7',
        options: { schema, responses: { 200: schema } } as never
      }
    )
  )

  expect(error).toMatchObject({ _tag: 'HttpRequestError', phase: 'request' })
  expect(calls).toBe(0)
})

test('an expected schema can accept undefined for a no-content response', async () => {
  const schema = makeSchema<undefined>((value) => ({ value: value as undefined }))
  const result = await run(
    operation(
      { fetch: makeFetch('', 204) },
      { method: 'HEAD', path: 'https://example.test/health', options: { schema } }
    )
  )

  expect(Result.isError(result)).toBe(false)
  if (Result.isError(result)) return
  expect(result.value.data).toBeUndefined()
})

test('HttpClient exposes the response operation at runtime', () => {
  expect(HttpClient.service('TestHttp').layer).toBeDefined()
})
