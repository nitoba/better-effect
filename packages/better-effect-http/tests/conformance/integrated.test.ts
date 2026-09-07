// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- integration fixtures narrow platform streams and erased Effect programs at test boundaries.
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { expect, test } from 'bun:test'
import { HttpAuth, HttpClient, HttpRetry } from '../../src/index.ts'

test('holds one client permit for an open byte stream until its consumer closes it', async () => {
  let calls = 0
  let releaseFirst: (() => void) | undefined
  const fetch: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]))
              releaseFirst = () => controller.close()
            }
          }),
          { status: 200 }
        )
      }
      return new Response(new Uint8Array([2]), { status: 200 })
    },
    { preconnect: () => {} }
  )

  const runtime = await Runtime.make(
    HttpClient.layer({
      fetch,
      limits: { concurrency: 1 }
    })
  )
  let firstClosed = false
  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const client = yield* HttpClient
        const first = client.stream('/first').results()[Symbol.asyncIterator]()
        expect(await first.next()).toMatchObject({
          value: Result.ok(new Uint8Array([1])),
          done: false
        })

        const second = client.stream('/second').results()[Symbol.asyncIterator]()
        const secondResult = second.next()
        await Promise.resolve()
        try {
          expect(calls).toBe(1)
        } finally {
          releaseFirst?.()
          releaseFirst = undefined
          expect(await first.next()).toMatchObject({ done: true })
          firstClosed = true
          await second.return?.()
          await secondResult.catch(() => undefined)
        }
        expect(await secondResult).toMatchObject({
          value: Result.ok(new Uint8Array([2])),
          done: false
        })
        return Result.ok(undefined)
      })
    )
    if (Result.isError(result)) throw result.error
  } finally {
    if (!firstClosed) releaseFirst?.()
    await runtime.dispose()
  }
})

test('holds a client permit while an NDJSON body remains open', async () => {
  let calls = 0
  let releaseFirst: (() => void) | undefined
  const fetch: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      if (calls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"id":1}\n'))
              releaseFirst = () => controller.close()
            }
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
        )
      }
      return new Response('{"id":2}\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' }
      })
    },
    { preconnect: () => {} }
  )
  const runtime = await Runtime.make(
    HttpClient.layer({
      fetch,
      limits: { concurrency: 1 }
    })
  )
  let firstClosed = false

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const client = yield* HttpClient
        const first = client.ndjson('/first').results()[Symbol.asyncIterator]()
        expect(await first.next()).toMatchObject({
          value: Result.ok({ id: 1 }),
          done: false
        })

        const second = client.ndjson('/second').results()[Symbol.asyncIterator]()
        const secondResult = second.next()
        await Promise.resolve()
        try {
          expect(calls).toBe(1)
        } finally {
          releaseFirst?.()
          releaseFirst = undefined
          expect(await first.next()).toMatchObject({ done: true })
          firstClosed = true
          await second.return?.()
          await secondResult.catch(() => undefined)
        }
        expect(await secondResult).toMatchObject({
          value: Result.ok({ id: 2 }),
          done: false
        })
        return Result.ok(undefined)
      })
    )
    if (Result.isError(result)) throw result.error
  } finally {
    if (!firstClosed) releaseFirst?.()
    await runtime.dispose()
  }
})

test('holds an SSE permit while the stream consumer is still processing the body', async () => {
  let calls = 0
  let releaseConsumer: (() => void) | undefined
  let firstOpenedResolve: (() => void) | undefined
  const firstOpened = new Promise<void>((resolve) => {
    firstOpenedResolve = resolve
  })
  const fetch: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      if (calls === 1) firstOpenedResolve?.()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'))
          if (calls > 1) controller.close()
        }
      })
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    },
    { preconnect: () => {} }
  )
  const runtime = await Runtime.make(
    HttpClient.layer({
      fetch,
      limits: { concurrency: 1 }
    })
  )

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const client = yield* HttpClient
        const first = client
          .sse('/first')
          .use(async ({ body }) => {
            const reader = body.getReader()
            await reader.read()
            await new Promise<void>((resolve) => {
              releaseConsumer = resolve
            })
            await reader.cancel()
            return Result.ok('done')
          })
          [Symbol.asyncIterator]()
        const firstResult = first.next()
        await firstOpened

        const second = client.sse('/second').results()[Symbol.asyncIterator]()
        const secondResult = second.next()
        for (let index = 0; index < 8; index++) await Promise.resolve()
        try {
          expect(calls).toBe(1)
        } finally {
          releaseConsumer?.()
          expect(await firstResult).toMatchObject({ done: true })
          await second.return?.()
          await secondResult.catch(() => undefined)
        }
        expect(await secondResult).toMatchObject({ done: false })
        return Result.ok(undefined)
      })
    )
    if (Result.isError(result)) throw result.error
  } finally {
    releaseConsumer?.()
    await runtime.dispose()
  }
})

test('composes retry and bounded auth recovery without resetting the physical-send budget', async () => {
  let calls = 0
  let refreshed = 0
  const credentials: string[] = []
  const authentication = HttpAuth.authentication({
    credential: () => (refreshed === 0 ? 'old-token' : 'new-token')
  })
  const recovery = HttpAuth.refresh({
    maxReplays: 1,
    key: 'session-1',
    refresh: () => {
      refreshed++
      return Result.ok('new-token')
    }
  })
  const Api = HttpClient.service('ConformanceApi', {
    interceptors: [authentication],
    middleware: [recovery]
  })
  const fetch: typeof globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      calls++
      credentials.push(new Headers(init?.headers).get('authorization') ?? '')
      if (calls === 1) return new Response('{}', { status: 503, headers: { 'retry-after': '0' } })
      if (calls === 2) return new Response('{}', { status: 401 })
      return new Response('{"ok":true}', { status: 200 })
    },
    { preconnect: () => {} }
  )
  const runtime = await Runtime.make(Api.layer({ fetch, limits: { concurrency: 1 } }))

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const http = yield* Api
        const response = yield* http.get('/resource', {
          retry: HttpRetry.transient({ times: 1, respectRetryAfter: true })
        })
        return Result.ok(response.data)
      }) as never
    )

    expect(result).toEqual(Result.ok({ ok: true }))
    expect(calls).toBe(3)
    expect(refreshed).toBe(1)
    expect(credentials).toEqual(['Bearer old-token', 'Bearer old-token', 'Bearer new-token'])
  } finally {
    await runtime.dispose()
  }
})

test('keeps a successful response when an observer fails after the send', async () => {
  let calls = 0
  let observed = 0
  const Api = HttpClient.service('ObserverApi', {
    observers: [
      {
        name: 'failing-observer',
        _kind: 'observe' as const,
        onSuccess() {
          observed++
          throw new Error('observer secret')
        }
      }
    ]
  })
  const fetch: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      return new Response('{"ok":true}', { status: 200 })
    },
    { preconnect: () => {} }
  )
  const runtime = await Runtime.make(Api.layer({ fetch }))

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const http = yield* Api
        const response = yield* http.get('/resource')
        return Result.ok(response.data)
      }) as never
    )

    expect(result).toEqual(Result.ok({ ok: true }))
    expect(calls).toBe(1)
    expect(observed).toBe(1)
    expect(JSON.stringify(result)).not.toContain('observer secret')
  } finally {
    await runtime.dispose()
  }
})
