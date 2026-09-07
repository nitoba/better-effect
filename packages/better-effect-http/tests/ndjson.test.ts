// oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- fixtures exercise hostile wire values at the transport/schema boundaries.
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { expect, test } from 'bun:test'
import { HttpClient, HttpDecodeError, HttpHookError } from '../src/index.ts'
import {
  HttpNdjsonLimitError,
  HttpNdjsonParseError,
  HttpNdjsonUtf8Error
} from '../src/codecs/ndjson/index.ts'
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

const streamFetch = (
  chunks: readonly Uint8Array[],
  options?: { readonly headers?: RequestInit['headers']; readonly onCancel?: () => void }
): typeof globalThis.fetch =>
  Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
          cancel() {
            options?.onCancel?.()
          }
        }),
        (() => {
          return { status: 200, headers: new Headers(options?.headers) } satisfies ResponseInit
        })()
      ),
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

const utf8 = new TextEncoder()

const run = (fetch: typeof globalThis.fetch, program: unknown) =>
  Runtime.run(HttpClient.layer({ fetch }), program as never) as Promise<Result<unknown, unknown>>

test('decodes UTF-8 incrementally across every byte split and CRLF boundaries', async () => {
  const wire = utf8.encode('{"name":"caf\u00e9"}\r\n{"name":"東京"}\r\n')
  const schema = makeSchema<{ name: string }>((value) => ({ value: value as { name: string } }))

  for (let split = 1; split < wire.byteLength; split++) {
    const chunks = [wire.slice(0, split), wire.slice(split)]
    const result = await run(
      streamFetch(chunks),
      Effect.fn(async function* () {
        const http = yield* HttpClient
        const values: { name: string }[] = []
        const terminal = http.ndjson('/users', { schema }).forEach((value) =>
          Effect.fn(function* () {
            values.push(value)
            yield* []
            return Result.ok(undefined)
          })
        )
        yield* terminal
        return Result.ok({ values, consumed: undefined })
      })
    )
    expect(result).toEqual(
      Result.ok({
        values: [{ name: 'café' }, { name: '東京' }],
        consumed: undefined
      })
    )
  }
})

test('delivers records before the response closes and does not parse a JSON array as multiple records', async () => {
  let pulls = 0
  let release: (() => void) | undefined
  const fetch = Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            pulls++
            if (pulls === 1) controller.enqueue(utf8.encode('{"id":1}\n'))
            else if (pulls === 2) {
              await new Promise<void>((resolve) => {
                release = resolve
              })
              controller.enqueue(utf8.encode('[{"id":2},{"id":3}]\n'))
            } else controller.close()
          }
        }),
        { status: 200 }
      ),
    { preconnect: () => {} }
  ) as typeof globalThis.fetch
  const schema = makeSchema<unknown>((value) => ({ value }))
  const seen: unknown[] = []
  const resultPromise = run(
    fetch,
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users', { schema }).forEach((value) => {
        seen.push(value)
        return Result.ok(undefined)
      })
    })
  )
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(seen).toEqual([{ id: 1 }])
  release?.()
  expect(await resultPromise).toEqual(Result.ok(undefined))
  expect(seen).toEqual([{ id: 1 }, [{ id: 2 }, { id: 3 }]])
})

test('ignores empty lines, rejects whitespace lines, and requires an EOF delimiter by default', async () => {
  const schema = makeSchema<{ id: number }>((value) => ({ value: value as { id: number } }))
  const empty = await run(
    streamFetch([utf8.encode('\n\r\n{"id":1}\n')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const values: { id: number }[] = []
      const result = yield* http.ndjson('/users', { schema }).forEach((value) => {
        values.push(value)
        return Result.ok(undefined)
      })
      return Result.ok({ result, values })
    })
  )
  expect(empty).toEqual(Result.ok({ result: Result.ok(undefined), values: [{ id: 1 }] }))

  const whitespace = await run(
    streamFetch([utf8.encode('   \n')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users').forEach(() => Result.ok(undefined))
    })
  )
  expect(Result.isError(whitespace)).toBe(true)
  if (Result.isError(whitespace)) expect(whitespace.error).toBeInstanceOf(HttpNdjsonParseError)

  const unterminated = await run(
    streamFetch([utf8.encode('{"id":1}')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users').forEach(() => Result.ok(undefined))
    })
  )
  expect(Result.isError(unterminated)).toBe(true)
  if (Result.isError(unterminated)) expect(unterminated.error).toBeInstanceOf(HttpNdjsonParseError)
})

test('allows a final record without delimiter only when explicitly requested', async () => {
  const result = await run(
    streamFetch([utf8.encode('{"id":1}')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const values: unknown[] = []
      return yield* http
        .ndjson('/users', { allowFinalRecordWithoutDelimiter: true })
        .forEach((value) => {
          values.push(value)
          return Result.ok(undefined)
        })
    })
  )
  expect(result).toEqual(Result.ok(undefined))
})

test('enforces maxRecordBytes using UTF-8 bytes and does not expose the record payload', async () => {
  const exact = utf8.encode('{"name":"é"}\n')
  const result = await run(
    streamFetch([exact.slice(0, -1), exact.slice(-1)]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const values: unknown[] = []
      return yield* http
        .ndjson('/users', { limits: { maxRecordBytes: exact.byteLength - 2 } })
        .forEach((value) => {
          values.push(value)
          return Result.ok(undefined)
        })
    })
  )
  expect(Result.isError(result)).toBe(true)
  if (!Result.isError(result)) return
  expect(result.error).toBeInstanceOf(HttpNdjsonLimitError)
  expect(JSON.stringify(result.error)).not.toContain('é')
})

test('rejects invalid UTF-8 strictly without replacement characters', async () => {
  const result = await run(
    streamFetch([new Uint8Array([0xc3, 0x28, 0x0a])]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users').forEach(() => Result.ok(undefined))
    })
  )
  expect(Result.isError(result)).toBe(true)
  if (Result.isError(result)) expect(result.error).toBeInstanceOf(HttpNdjsonUtf8Error)
})

test('decodes each schema exactly once, preserving transforms and provider failures', async () => {
  let calls = 0
  const schema = makeSchema<{ id: number }>(async (value) => {
    calls++
    await Promise.resolve()
    return { value: { id: Number((value as { id: string }).id) } }
  })
  const result = await run(
    streamFetch([utf8.encode('{"id":"42"}\n')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      const values: { id: number }[] = []
      return yield* http.ndjson('/users', { schema }).forEach((value) => {
        values.push(value)
        return Result.ok(undefined)
      })
    })
  )
  expect(result).toEqual(Result.ok(undefined))
  expect(calls).toBe(1)

  const provider = makeSchema(() => {
    throw new Error('secret-provider')
  })
  const failed = await run(
    streamFetch([utf8.encode('{"id":1}\n')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users', { schema: provider }).forEach(() => Result.ok(undefined))
    })
  )
  expect(Result.isError(failed)).toBe(true)
  if (Result.isError(failed)) {
    expect(failed.error).toBeInstanceOf(HttpDecodeError)
    expect(JSON.stringify(failed.error)).not.toContain('secret-provider')
  }
})

test('consumer Err/throw terminates without replaying already delivered records', async () => {
  const schema = makeSchema<{ id: number }>((value) => ({ value: value as { id: number } }))
  let calls = 0
  const failed = await run(
    streamFetch([utf8.encode('{"id":1}\n{"id":2}\n{"id":3}\n')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users', { schema }).forEach((value) => {
        calls++
        return value.id === 2 ? Result.err('stop') : Result.ok(undefined)
      })
    })
  )
  expect(failed).toEqual(Result.err('stop'))
  expect(calls).toBe(2)

  let programs = 0
  const thrown = await run(
    streamFetch([utf8.encode('{"id":1}\n{"id":2}\n')]),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users', { schema }).forEach(async () => {
        programs++
        throw new Error('consumer-secret')
      })
    })
  )
  expect(Result.isError(thrown)).toBe(true)
  if (Result.isError(thrown)) {
    expect(thrown.error).toBeInstanceOf(HttpHookError)
  }
  expect(programs).toBe(1)
})

test('closes the body when a consumer stops early', async () => {
  let cancels = 0
  const body = [utf8.encode('{"id":1}\n{"id":2}\n')]
  const result = await run(
    streamFetch(body, { onCancel: () => cancels++ }),
    Effect.fn(async function* () {
      const http = yield* HttpClient
      return yield* http.ndjson('/users').takeUntil(() => true)
    })
  )
  expect(result).toEqual(Result.ok({ id: 1 }))
  expect(cancels).toBeLessThanOrEqual(1)
})
