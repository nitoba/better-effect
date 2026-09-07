// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- fixtures deliberately model Standard Schema and Fetch boundaries.
import { Result } from 'better-result'
import { Scope } from 'better-effect'
import { expect, test } from 'bun:test'
import { HttpDecodeError, HttpHookError, HttpRequestError, HttpTimeoutError } from '../src/errors'
import { SseUnexpectedEventError } from '../src/codecs/sse'
import { sse } from '../src/codecs/sse/description'
import { HttpStreamUnexpectedEndError } from '../src/stream'
import { HttpRetry } from '../src/retry'
import { HttpInterceptor, HttpRequest } from '../src'
import { makeHttpLimiter } from '../src/limits'
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
  expect(() =>
    sse({ fetch: fetchStream('data: ok\n\n') }, '/events', {
      method: 'POST',
      body: { command: 'run' },
      reconnect: { times: 1, onEnd: 'reconnect' }
    })
  ).toThrow(HttpRequestError)
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

test('reconnects transient openings and resumes with the delivered cursor', async () => {
  const requests: Array<{ readonly lastEventId: string | null }> = []
  let calls = 0
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      requests.push({ lastEventId: new Headers(init?.headers).get('last-event-id') })
      calls++
      if (calls === 1) return new Response(null, { status: 503 })
      if (calls === 2)
        return new Response('id: delivered\ndata: value\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      return new Response(null, { status: 204 })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const values = await collect(
    sse({ fetch }, '/events', {
      lastEventId: 'persisted',
      reconnect: {
        times: 2,
        delay: HttpRetry.fixed(0),
        resume: 'last-event-id',
        onEnd: 'reconnect'
      }
    }).results()
  )

  expect(values).toEqual([
    Result.ok({ event: 'message', data: 'value', id: 'delivered', lastEventId: 'delivered' })
  ])
  expect(calls).toBe(3)
  expect(requests.map((request) => request.lastEventId)).toEqual([
    'persisted',
    'persisted',
    'delivered'
  ])
})

test('reconnect times count failed openings and are not reset after headers', async () => {
  let calls = 0
  const fetch = Object.assign(
    async () => {
      calls++
      if (calls === 1) return new Response(null, { status: 503 })
      if (calls === 2)
        return new Response('id: one\ndata: value\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      return new Response(null, { status: 503 })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const values = await collect(
    sse({ fetch }, '/events', {
      reconnect: { times: 2, delay: () => 0, onEnd: 'reconnect' }
    }).results()
  )

  expect(values).toHaveLength(2)
  expect(values[0]).toEqual(
    Result.ok({ event: 'message', data: 'value', id: 'one', lastEventId: 'one' })
  )
  expect(values[1] && Result.isError(values[1])).toBe(true)
  expect(calls).toBe(3)
})

test('204 ends an SSE session without consuming reconnect budget', async () => {
  let calls = 0
  const fetch = Object.assign(
    async () => {
      calls++
      return new Response(null, { status: 204 })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const values = await collect(
    sse({ fetch }, '/events', {
      reconnect: { times: 5, delay: () => 0, onEnd: 'reconnect' }
    }).results()
  )
  expect(values).toEqual([])
  expect(calls).toBe(1)
})

test('id-only frames update the resumed cursor only after a complete frame', async () => {
  const headers: Array<string | null> = []
  let calls = 0
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      headers.push(new Headers(init?.headers).get('last-event-id'))
      calls++
      if (calls === 1)
        return new Response('id: first\n\nid:\n\nid: incomplete\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      return new Response(null, { status: 204 })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const values = await collect(
    sse({ fetch }, '/events', {
      reconnect: { times: 1, delay: () => 0, resume: 'last-event-id', onEnd: 'reconnect' }
    }).results()
  )
  expect(values).toEqual([])
  expect(calls).toBe(2)
  expect(headers).toEqual([null, null])
})

test('rejects illegal initial and replay cursors as request errors', () => {
  expect(() => sse({ fetch: fetchStream('') }, '/events', { lastEventId: 'bad\nvalue' })).toThrow(
    HttpRequestError
  )
  expect(() =>
    sse({ fetch: fetchStream('') }, '/events', {
      lastEventId: 'ok',
      reconnect: { times: 1, resume: 'last-event-id', onEnd: 'reconnect' },
      headers: { 'last-event-id': 'bad\u0000value' }
    })
  ).toThrow(HttpRequestError)
})

test('runs request interceptors for every physical opening and observes reconnect metadata', async () => {
  const authorization: string[] = []
  const reconnects: unknown[] = []
  let calls = 0
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      authorization.push(new Headers(init?.headers).get('authorization') ?? '')
      calls++
      if (calls === 1) return new Response(null, { status: 503 })
      return new Response(null, { status: 204 })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch
  const token = HttpInterceptor.make({
    name: 'fresh-token',
    onRequest: ({ request }) =>
      HttpRequest.setHeader(request, 'authorization', `token-${calls + 1}`)
  })
  const observer = HttpInterceptor.observe({
    name: 'reconnect-observer',
    onStreamReconnect: (context) => {
      reconnects.push(context)
    }
  })

  const values = await collect(
    sse({ fetch }, '/events', { reconnect: { times: 1, delay: () => 0 } }, undefined, [
      token,
      observer
    ]).results()
  )

  expect(values).toEqual([])
  expect(authorization).toEqual(['token-1', 'token-2'])
  expect(reconnects).toEqual([
    {
      connection: 2,
      attempt: 1,
      delayMs: 0,
      reason: 'status',
      lastEventId: ''
    }
  ])
})

test('releases the stream admission before waiting for a reconnect', async () => {
  const limiter = makeHttpLimiter({ concurrency: 1 })!
  let calls = 0
  const fetch = Object.assign(
    async () => {
      calls++
      if (calls === 1)
        return new Response('data: value\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      return new Response(null, { status: 204 })
    },
    { preconnect: () => {} }
  ) as typeof globalThis.fetch

  const values = await collect(
    sse(
      { fetch },
      '/events',
      { reconnect: { times: 1, delay: () => 0, onEnd: 'reconnect' } },
      limiter
    ).results()
  )
  expect(values).toEqual([
    Result.ok({ event: 'message', data: 'value', id: undefined, lastEventId: '' })
  ])
  expect(calls).toBe(2)
})
