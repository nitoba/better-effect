// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- fixtures deliberately model Standard Schema and Fetch boundaries.
import { Result } from 'better-result'
import { Scope } from 'better-effect'
import { expect, test } from 'bun:test'
import { HttpDecodeError, HttpHookError, HttpTimeoutError } from '../src/errors'
import { SseUnexpectedEventError } from '../src/codecs/sse'
import { sse } from '../src/codecs/sse/description'
import { HttpStreamUnexpectedEndError } from '../src/stream'
import type { StandardSchemaV1 } from 'better-effect-schema'

const schema = <Output>(
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

const fetchStream = (
  body: string | Uint8Array,
  headers: Record<string, string> = { 'content-type': 'text/event-stream' },
  status = 200
): typeof globalThis.fetch =>
  Object.assign(async () => new Response(body, { status, headers }), {
    preconnect: () => {}
  }) as typeof globalThis.fetch

const fetchChunks = (
  chunks: readonly (string | Uint8Array)[],
  headers: Record<string, string> = { 'content-type': 'text/event-stream' }
): typeof globalThis.fetch =>
  Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks)
              controller.enqueue(
                typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
              )
            controller.close()
          }
        }),
        { status: 200, headers }
      ),
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

const collect = async <A, E>(
  source: AsyncIterable<Result<A, E>>
): Promise<readonly Result<A, E>[]> => {
  return Scope.run(async () => {
    const values: Result<A, E>[] = []
    for await (const value of source) values.push(value)
    return values
  })
}

test('parses raw SSE incrementally with UTF-8, CRLF, comments, multiline data, and default message name', async () => {
  const body = new Uint8Array([
    ...new TextEncoder().encode('\ufeff: heartbeat\r\nid: first\r\ndata: {"text":"caf'),
    ...new TextEncoder().encode('é"}\r\ndata: \n\r\n'),
    ...new TextEncoder().encode('unknown: ignored\nretry: invalid\nevent: done\ndata: complete\n\n')
  ])
  const values = await collect(sse({ fetch: fetchStream(body) }, '/events').results())

  expect(values).toEqual([
    Result.ok({
      event: 'message',
      data: '{"text":"café"}\n',
      id: 'first',
      lastEventId: 'first'
    }),
    Result.ok({ event: 'done', data: 'complete', id: undefined, lastEventId: 'first' })
  ])
})

test('decodes one JSON schema exactly once and preserves transformed output', async () => {
  let calls = 0
  const user = schema<{ id: number; source: string }>(async (value) => {
    calls++
    await Promise.resolve()
    return { value: { id: Number((value as { id: string }).id), source: 'schema' } }
  })
  const [value] = await collect(
    sse({ fetch: fetchStream('data: {"id":"42"}\n\n') }, '/events', { schema: user }).results()
  )

  expect(value).toEqual(
    Result.ok({
      event: 'message',
      data: { id: 42, source: 'schema' },
      id: undefined,
      lastEventId: ''
    })
  )
  expect(calls).toBe(1)
})

test('selects event schemas by name and rejects undeclared events', async () => {
  const events = {
    progress: schema<{ percent: number }>((value) => ({ value: value as { percent: number } })),
    completed: schema<{ ok: boolean }>((value) => ({ value: value as { ok: boolean } }))
  } as const
  const values = await collect(
    sse({ fetch: fetchStream('event: progress\ndata: {"percent":50}\n\n') }, '/events', {
      events
    }).results()
  )
  expect(values[0]).toEqual(
    Result.ok({
      event: 'progress',
      data: { percent: 50 },
      id: undefined,
      lastEventId: ''
    })
  )

  const [unknown] = await collect(
    sse({ fetch: fetchStream('event: other\ndata: {}\n\n') }, '/events', { events }).results()
  )
  expect(unknown).toBeDefined()
  expect(unknown && Result.isError(unknown) && unknown.error).toBeInstanceOf(
    SseUnexpectedEventError
  )
})

test('schema JSON failures are typed and do not reconnect', async () => {
  let calls = 0
  const invalid = schema(() => {
    calls++
    return { issues: [{ message: 'invalid' }] }
  })
  const values = await collect(
    sse({ fetch: fetchStream('data: {not-json}\n\n') }, '/events', { schema: invalid }).results()
  )
  expect(values).toHaveLength(1)
  expect(values[0] && Result.isError(values[0]) && values[0].error).toBeInstanceOf(HttpDecodeError)
  expect(calls).toBe(0)
})

test('204 is an explicit successful end while incompatible MIME is a typed failure', async () => {
  const empty = await collect(sse({ fetch: fetchStream('', {}, 204) }, '/events').results())
  expect(empty).toEqual([])

  const invalid = await collect(
    sse(
      { fetch: fetchStream('data: ok\n\n', { 'content-type': 'application/json' }) },
      '/events'
    ).results()
  )
  expect(invalid).toHaveLength(1)
  expect(invalid[0] && Result.isError(invalid[0])).toBe(true)
})

test('sets the SSE Accept header without changing POST JSON request inputs', async () => {
  let method: string | undefined
  let body: unknown
  let accept: string | null = null
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      method = String(init?.method)
      body = init?.body
      accept = new Headers(init?.headers).get('accept')
      return new Response('data: ok\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const values = await collect(
    sse({ fetch }, '/events', { method: 'POST', body: { readonly: true } }).results()
  )
  expect(values).toHaveLength(1)
  expect(method).toBe('POST')
  expect(body).toBe('{"readonly":true}')
  expect(accept === 'text/event-stream').toBe(true)
})

test('parser does not dispatch an incomplete event at EOF', async () => {
  const values = await collect(
    sse({ fetch: fetchStream('data: incomplete\n') }, '/events').results()
  )
  expect(values).toEqual([])
})

test('decodes a multibyte UTF-8 code point split across transport chunks', async () => {
  const encoded = new TextEncoder().encode('data: café\n\n')
  const values = await collect(
    sse({ fetch: fetchChunks([encoded.slice(0, 10), encoded.slice(10)]) }, '/events').results()
  )

  expect(values).toEqual([
    Result.ok({ event: 'message', data: 'café', id: undefined, lastEventId: '' })
  ])
})

test('takeUntil includes the terminal event and reports missing matches', async () => {
  const match = await Scope.run(async () =>
    sse({ fetch: fetchStream('event: done\ndata: complete\n\n') }, '/events')
      .takeUntil((message) => message.event === 'done', { requireMatch: true })
      .next()
  )
  expect(match.value).toEqual(
    Result.ok({ event: 'done', data: 'complete', id: undefined, lastEventId: '' })
  )

  const missing = await Scope.run(async () =>
    sse({ fetch: fetchStream('data: other\n\n') }, '/events')
      .takeUntil((message) => message.event === 'done', { requireMatch: true })
      .next()
  )
  expect(missing.value && Result.isError(missing.value) && missing.value.error).toBeInstanceOf(
    HttpStreamUnexpectedEndError
  )
})

test('consumer and predicate failures are returned as typed hook errors', async () => {
  const consumer = await Scope.run(async () =>
    sse({ fetch: fetchStream('data: value\n\n') }, '/events')
      .forEach(() => {
        throw new Error('consumer failed')
      })
      .next()
  )
  expect(consumer.value && Result.isError(consumer.value) && consumer.value.error).toBeInstanceOf(
    HttpHookError
  )

  const predicate = await Scope.run(async () =>
    sse({ fetch: fetchStream('data: value\n\n') }, '/events')
      .takeUntil(() => {
        throw new Error('predicate failed')
      })
      .next()
  )
  expect(
    predicate.value && Result.isError(predicate.value) && predicate.value.error
  ).toBeInstanceOf(HttpHookError)
})

test('preserves protocol cursor order, resets empty ids, and ignores NUL ids', async () => {
  const values = await collect(
    sse(
      {
        fetch: fetchStream('id: first\ndata: one\n\nid:\ndata: two\n\nid: bad\0id\ndata: three\n\n')
      },
      '/events'
    ).results()
  )
  expect(
    values.map((value) => (Result.isError(value) ? value.error : value.value.lastEventId))
  ).toEqual(['first', '', ''])
})

test('byte limits reject oversized lines and cap parser queueing', async () => {
  const line = await collect(
    sse({ fetch: fetchStream('data: 12345\n\n') }, '/events', {
      limits: { maxLineBytes: 5 }
    }).results()
  )
  expect(line).toHaveLength(1)
  expect(line[0] && Result.isError(line[0])).toBe(true)

  const queue = await collect(
    sse({ fetch: fetchStream('data: 1\n\ndata: 2\n\n') }, '/events', {
      limits: { maxBufferedEvents: 1 }
    }).results()
  )
  expect(queue).toHaveLength(1)
  expect(queue[0] && Result.isError(queue[0])).toBe(true)
})

test('byte limits carry line and event state across transport chunks', async () => {
  const values = await collect(
    sse({ fetch: fetchChunks(['data: 12', '345\n\n']) }, '/events', {
      limits: { maxLineBytes: 8 }
    }).results()
  )
  expect(values).toHaveLength(1)
  expect(values[0] && Result.isError(values[0])).toBe(true)
})

test('read idle timeout treats heartbeat bytes as activity and times out silent readers', async () => {
  const silent = Object.assign(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {})
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      ),
    { preconnect: () => {} }
  ) as typeof globalThis.fetch
  const values = await collect(
    sse({ fetch: silent }, '/events', { timeout: { readIdleMs: 5 } }).results()
  )
  expect(values).toHaveLength(1)
  expect(values[0] && Result.isError(values[0]) && values[0].error).toBeInstanceOf(HttpTimeoutError)
})

test('headers and total timeouts abort a response that never opens', async () => {
  const blocked = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) =>
      await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      }),
    { preconnect: () => {} }
  ) as typeof globalThis.fetch
  const values = await collect(
    sse({ fetch: blocked }, '/events', { timeout: { headersMs: 100, totalMs: 5 } }).results()
  )
  expect(values).toHaveLength(1)
  expect(values[0] && Result.isError(values[0]) && values[0].error).toBeInstanceOf(HttpTimeoutError)
})

test('reconnect true is rejected before opening the one-shot body', () => {
  expect(() =>
    sse({ fetch: fetchStream('data: ok\n\n') }, '/events', { reconnect: true } as never)
  ).toThrow()
})

test('schema and event-map modes are mutually exclusive at runtime', () => {
  const value = schema((input) => ({ value: input }))
  expect(() =>
    sse({ fetch: fetchStream('data: ok\n\n') }, '/events', {
      schema: value,
      events: { message: value }
    } as never)
  ).toThrow()
})
