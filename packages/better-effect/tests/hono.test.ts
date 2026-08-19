import { expect, test } from 'bun:test'
import { Result } from 'better-result'
import { Hono } from 'hono'
import { validator } from 'hono/validator'

import { Effect, Layer, Runtime, Service } from '../src'
import { HonoEffect } from '../src/hono'
import { CurrentAbortSignal, CurrentRequest } from '../src/standard-services'
import type { ScopeOutcome } from '../src'

class HttpService extends Service<HttpService>()('HttpService') {
  value(): string {
    return 'ok'
  }
}

class HttpFailure extends Error {}

const makeRuntime = () => Runtime.make(Layer.succeed(HttpService, new HttpService()))

test('HonoEffect runs one request Scope and resolves Services lazily', async () => {
  const runtime = await makeRuntime()
  const outcomes: ScopeOutcome[] = []
  const http = HonoEffect.make(runtime, {
    onFailure: (error: HttpFailure, context) => context.json({ error: error.message }, 400)
  })
  const app = new Hono()

  app.use('*', http.middleware())
  app.get(
    '/ok',
    http.gen(async function* () {
      const service = yield* HttpService
      const resource = yield* Effect.acquireRelease(
        () => ({ value: service.value() }),
        (_resource, outcome) => {
          outcomes.push(outcome)
        }
      )

      return Result.ok(resource.value)
    })
  )

  try {
    const response = await app.request('/ok')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: 'ok' })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toEqual({ status: 'success' })
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect keeps Result.err as the request Scope failure after responding', async () => {
  const runtime = await makeRuntime()
  const failure = new HttpFailure('missing')
  let observed: ScopeOutcome | undefined
  const http = HonoEffect.make(runtime, {
    onFailure: (error: HttpFailure, context) => context.json({ error: error.message }, 404)
  })
  const app = new Hono()

  app.use('*', http.middleware())
  app.get(
    '/missing',
    http.gen(async function* () {
      yield* Effect.acquireRelease(
        () => ({
          [Symbol.dispose]: () => {}
        }),
        (_resource, outcome) => {
          observed = outcome
        }
      )

      return Result.err(failure)
    })
  )

  try {
    const response = await app.request('/missing')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'missing' })
    expect(observed).toEqual({ status: 'failure', cause: failure })
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect guard short-circuits with the central failure policy', async () => {
  const runtime = await makeRuntime()
  const failure = new HttpFailure('unauthorized')
  let routeCalled = false
  const http = HonoEffect.make(runtime, {
    onFailure: (error: HttpFailure, context) => context.json({ error: error.message }, 401)
  })
  const app = new Hono()

  app.use('*', http.middleware())
  app.use(
    '/private/*',
    http.guard(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.err(failure)
    })
  )
  app.get('/private/value', () => {
    routeCalled = true
    return new Response('unexpected')
  })

  try {
    const response = await app.request('/private/value')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(routeCalled).toBe(false)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect provides CurrentRequest and the request AbortSignal', async () => {
  const runtime = await Runtime.make(Layer.merge())
  const http = HonoEffect.make(runtime)
  const app = new Hono()
  const controller = new AbortController()

  app.use('*', http.middleware())
  app.get(
    '/',
    http.gen(async function* () {
      const request = yield* CurrentRequest
      const signal = yield* CurrentAbortSignal

      return Result.ok({
        // SAFETY: CurrentRequest is populated with the Web Request by HonoEffect.middleware().
        url: (request.request as Request).url,
        aborted: signal.aborted
      })
    })
  )

  controller.abort(new Error('cancelled'))

  try {
    const response = await app.request(
      new Request('http://localhost/', { signal: controller.signal })
    )

    expect(await response.json()).toEqual({
      data: {
        url: 'http://localhost/',
        aborted: true
      }
    })
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect does not open a second execution when installed twice', async () => {
  const runtime = await makeRuntime()
  let active = 0
  let peak = 0
  const http = HonoEffect.make(runtime)
  const app = new Hono()

  app.use('*', http.middleware())
  app.use('*', http.middleware())
  app.get(
    '/',
    http.gen(async function* () {
      yield* Effect.acquireRelease(
        () => {
          active += 1
          peak = Math.max(peak, active)
          return {}
        },
        () => {
          active -= 1
        }
      )

      return Result.ok('ok')
    })
  )

  try {
    await app.request('/')
    expect(peak).toBe(1)
    expect(active).toBe(0)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect keeps Hono onError for defects', async () => {
  const runtime = await makeRuntime()
  const defect = new Error('boom')
  let observed: unknown
  const http = HonoEffect.make(runtime)
  const app = new Hono()

  app.onError((error, context) => {
    observed = error
    return context.text('defect', 500)
  })
  app.use('*', http.middleware())
  app.get('/defect', async () => {
    throw defect
  })

  try {
    const response = await app.request('/defect')

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('defect')
    expect(observed).toBe(defect)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect handler preserves the Program success type', async () => {
  const runtime = await makeRuntime()
  const http = HonoEffect.make(runtime)
  const program = Effect.fn(async function* () {
    const service = yield* HttpService
    return Result.ok(service.value())
  })

  const handler = http.handler(() => program)

  expect(handler).toBeFunction()

  await runtime.dispose()
})

test('HonoEffect infers and composes a Hono input validator', async () => {
  const runtime = await makeRuntime()
  let handlerCalled = false
  const validateJson = validator('json', (value: { name?: string } | null) => {
    if (value?.name === undefined) {
      return new Response('invalid', { status: 422 })
    }

    return { name: value.name }
  })
  const http = HonoEffect.make(runtime)
  const app = new Hono()

  app.use('*', http.middleware())
  app.post(
    '/validated',
    http.gen(validateJson, async function* (c) {
      handlerCalled = true
      const input = c.req.valid('json')
      const service = yield* HttpService

      return Result.ok(`${input.name}:${service.value()}`)
    })
  )
  app.post(
    '/validated-handler',
    http.handler(validateJson, (c) => {
      const input = c.req.valid('json')

      return Effect.fn(async function* () {
        const service = yield* HttpService
        return Result.ok(`${input.name}:${service.value()}`)
      })
    })
  )

  try {
    const validResponse = await app.request('/validated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' })
    })

    expect(validResponse.status).toBe(200)
    expect(await validResponse.json()).toEqual({ data: 'Ada:ok' })
    expect(handlerCalled).toBe(true)

    const handlerResponse = await app.request('/validated-handler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Grace' })
    })

    expect(handlerResponse.status).toBe(200)
    expect(await handlerResponse.json()).toEqual({ data: 'Grace:ok' })

    handlerCalled = false
    const invalidResponse = await app.request('/validated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })

    expect(invalidResponse.status).toBe(422)
    expect(await invalidResponse.text()).toBe('invalid')
    expect(handlerCalled).toBe(false)
  } finally {
    await runtime.dispose()
  }
})
