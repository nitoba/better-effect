// oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- hostile values intentionally cross the untrusted transport boundary.
import { Effect, Runtime } from 'better-effect'
import { Result } from 'better-result'
import { expect, test } from 'bun:test'
import { HttpClient, HttpHookError } from '../src/index.ts'

test('serializes cyclic transport failures without exposing the body or cause', async () => {
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  const runtime = await Runtime.make(HttpClient.layer({ fetch: globalThis.fetch }))

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const http = yield* HttpClient
        const response = yield* http.post('/secrets', { body: cyclic })
        return Result.ok(response.data)
      })
    )

    expect(Result.isError(result)).toBe(true)
    if (!Result.isError(result)) return
    expect(result.error._tag).toBe('HttpRequestError')
    expect(() => JSON.stringify(result.error)).not.toThrow()
    expect(JSON.stringify(result.error)).not.toContain('self')

    const hookError = new HttpHookError({ phase: 'hook', cause: cyclic })
    expect(() => JSON.stringify(hookError)).not.toThrow()
    expect(JSON.stringify(hookError)).not.toContain('self')
  } finally {
    await runtime.dispose()
  }
})

test('turns hostile body and header values into safe request errors', async () => {
  let calls = 0
  const fetch: typeof globalThis.fetch = Object.assign(
    async () => {
      calls++
      return new Response('{"ok":true}', { status: 200 })
    },
    { preconnect: () => {} }
  )
  const runtime = await Runtime.make(HttpClient.layer({ fetch }))
  const hostileProxy = new Proxy(
    {},
    {
      get() {
        throw new Error('proxy secret')
      }
    }
  )

  try {
    for (const body of [hostileProxy, BigInt(1) as never]) {
      const result = await runtime.run(
        Effect.fn(async function* () {
          const http = yield* HttpClient
          const response = yield* http.post('/hostile', { body })
          return Result.ok(response.data)
        })
      )
      expect(Result.isError(result)).toBe(true)
      if (Result.isError(result)) {
        expect(result.error._tag).toBe('HttpRequestError')
        expect(JSON.stringify(result.error)).not.toContain('secret')
      }
    }

    const headerResult = await runtime.run(
      Effect.fn(async function* () {
        const http = yield* HttpClient
        const response = yield* http.get('/hostile', {
          headers: { 'x-secret': 'line\r\nsecret' }
        })
        return Result.ok(response.data)
      })
    )
    expect(Result.isError(headerResult)).toBe(true)
    if (Result.isError(headerResult)) {
      expect(headerResult.error._tag).toBe('HttpRequestError')
      expect(JSON.stringify(headerResult.error)).not.toContain('secret')
    }
    expect(calls).toBe(0)
  } finally {
    await runtime.dispose()
  }
})
