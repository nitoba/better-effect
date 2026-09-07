/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, eslint(require-yield) -- These fixtures exercise the erased middleware boundary and generator-shaped test programs. */
import { Effect } from 'better-effect'
import { Result } from 'better-result'
import { expect, test } from 'bun:test'
import { HttpAuth, HttpAuthRefreshError, HttpRequest, HttpStatusError } from '../src'
import type { HttpRequest as HttpRequestType, HttpResponse } from '../src'
import { operationWithHooks } from '../src/internal/hooks'

const response: HttpResponse<{ readonly ok: true }> = {
  status: 200,
  statusText: 'OK',
  headers: new Headers(),
  url: 'https://example.test/resource',
  data: { ok: true }
}

const unauthorized = () =>
  new HttpStatusError({
    phase: 'status',
    status: 401,
    statusText: 'Unauthorized',
    headers: new Headers(),
    url: response.url
  })

const run = (
  middleware: ReturnType<typeof HttpAuth.refresh>,
  request: HttpRequestType,
  next: Parameters<typeof middleware.handle>[1]
) => {
  const output = middleware.handle(request, next)
  return typeof output === 'function' ? output() : output
}

test('coalesces same-session refreshes and replays each logical call once', async () => {
  let refreshes = 0
  let attempts = 0
  const recovery = HttpAuth.refresh({
    key: 'session-1',
    refresh: () => {
      refreshes++
      return new Promise<string>((resolve) => setTimeout(() => resolve('renewed'), 5))
    }
  })
  const request = HttpRequest.make(response.url)
  const next = (current: HttpRequestType) =>
    // oxlint-disable-next-line require-yield -- The fixture returns a completed Result through the generator-shaped Program API.
    Effect.fn(async function* () {
      attempts++
      if (current.headers.get('authorization') === 'Bearer renewed') return Result.ok(response)
      return Result.err(unauthorized())
    })()

  const results = await Promise.all([run(recovery, request, next), run(recovery, request, next)])

  expect(results.every(Result.isOk)).toBe(true)
  expect(refreshes).toBe(1)
  expect(attempts).toBe(4)
})

test('does not replay unsafe or one-shot requests', async () => {
  let refreshes = 0
  const recovery = HttpAuth.refresh({
    key: 'session-1',
    refresh: () => {
      refreshes++
      return Result.ok('renewed')
    }
  })
  const request = HttpRequest.make(response.url, {
    method: 'POST',
    body: 'write'
  })
  const next = () =>
    // oxlint-disable-next-line require-yield -- The fixture returns a completed Result through the generator-shaped Program API.
    Effect.fn(async function* () {
      return Result.err(unauthorized())
    })()

  const result = await run(recovery, request, next)

  expect(Result.isError(result)).toBe(true)
  expect(Result.isError(result) && result.error).toBeInstanceOf(HttpAuthRefreshError)
  if (Result.isError(result))
    expect((result.error as HttpAuthRefreshError).reason).toBe('not-replayable')
  expect(refreshes).toBe(0)
})

test('reads credentials afresh for every request', async () => {
  let reads = 0
  const authentication = HttpAuth.authentication({
    credential: () => {
      reads++
      return Result.ok('token-' + reads)
    }
  })
  const first = await authentication.onRequest?.({ request: HttpRequest.make(response.url) })
  const second = await authentication.onRequest?.({ request: HttpRequest.make(response.url) })

  if (first && 'headers' in first) expect(first.headers.get('authorization')).toBe('Bearer token-1')
  if (second && 'headers' in second)
    expect(second.headers.get('authorization')).toBe('Bearer token-2')
  expect(reads).toBe(2)
})

test('maxReplays zero leaves an eligible 401 untouched', async () => {
  let refreshes = 0
  const recovery = HttpAuth.refresh({
    maxReplays: 0,
    key: 'session-1',
    refresh: () => {
      refreshes++
      return Result.ok('renewed')
    }
  })
  const request = HttpRequest.make(response.url)
  const next = () =>
    // oxlint-disable-next-line require-yield -- The fixture returns a completed Result through the generator-shaped Program API.
    Effect.fn(async function* () {
      return Result.err(unauthorized())
    })()

  const result = await run(recovery, request, next)

  expect(Result.isError(result)).toBe(true)
  expect(Result.isError(result) && result.error).toBeInstanceOf(HttpStatusError)
  expect(refreshes).toBe(0)
})

test('client hook composition applies authentication and bounded refresh', async () => {
  let token = 'expired'
  let sends = 0
  const authentication = HttpAuth.authentication({ credential: () => Result.ok(token) })
  const recovery = HttpAuth.refresh({
    key: 'session-1',
    refresh: () => {
      token = 'renewed'
      return Result.ok(token)
    }
  })
  const fetch = Object.assign(
    async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) => {
      sends++
      const headers = new Headers(init?.headers)
      if (headers.get('authorization') === 'Bearer renewed')
        return new Response('{"ok":true}', { status: 200 })
      return new Response('unauthorized', { status: 401 })
    },
    { preconnect: () => {} }
  )

  const operation = operationWithHooks(
    { fetch },
    { method: 'GET', path: 'https://example.test/resource', options: { retry: false } },
    undefined,
    [authentication, recovery]
  )
  const result = await operation.next()

  expect(result.done).toBe(true)
  if (result.done) expect(result.value.status).toBe(200)
  expect(sends).toBe(2)
})
