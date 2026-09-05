import { expect, test } from 'bun:test'
import { Result, TaggedError } from 'better-result'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'

import { Effect, Layer, Runtime, Service } from '../src'
import { HonoEffect, HonoEffectBoundaryMissingError } from '../src/hono'
import { CurrentAbortSignal, CurrentRequest } from '../src/standard-services'
import type { AnyServiceToken, ScopeOutcome } from '../src'

class RequestId extends Service<RequestId>()('HonoRequestId') {
  constructor(readonly value: string) {
    super()
  }
}

class HttpFailure extends Error {}

const resolveApp = async <
  Provided extends import('../src').AnyService,
  Token extends AnyServiceToken
>(
  runtime: Runtime<Provided>,
  token: Token
): Promise<InstanceType<Token>> => {
  // SAFETY: This test helper intentionally erases the runtime environment; each caller supplies the requested token through its Layer.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the helper bridges a generic runtime to an arbitrary test token.
  const erasedRuntime = runtime as unknown as Runtime<import('../src').AnyService>
  const result = await erasedRuntime.run(
    Effect.fn(async function* () {
      return Result.ok(yield* token)
    })
  )

  if (Result.isError(result)) {
    throw result.error
  }

  return result.value
}

test('HonoEffect.app builds the app lazily and returns the native Hono app', async () => {
  let factoryRuns = 0
  const App = HonoEffect.app('@tests/HonoApp', {}, async function* (http) {
    factoryRuns += 1
    const app = new Hono()
    app.use('*', yield* http.middleware())
    app.get(
      '/value',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* () {
          return Result.ok('native')
        }
      )
    )
    return app
  })

  const runtime = await Runtime.make(App.layer)

  try {
    expect(factoryRuns).toBe(0)
    const app = await resolveApp(runtime, App)
    expect(factoryRuns).toBe(1)
    expect(app.fetch).toBeInstanceOf(Function)
    expect(await (await app.fetch(new Request('http://localhost/value'))).json()).toEqual({
      data: 'native'
    })
    await resolveApp(runtime, App)
    expect(factoryRuns).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect.layer provides an application-owned Service token', async () => {
  class ApiApplication extends Service<ApiApplication>()('@tests/ApiApplication') {
    declare readonly app: Hono
  }

  const live = HonoEffect.layer(ApiApplication, {}, async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    app.get(
      '/',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* () {
          return Result.ok('layer')
        }
      )
    )
    return ApiApplication.of({ app })
  })
  const runtime = await Runtime.make(live)

  try {
    const result = await runtime.run(
      Effect.fn(async function* () {
        const application = yield* ApiApplication
        return Result.ok(await application.app.request('/'))
      })
    )

    if (Result.isError(result)) {
      throw result.error
    }

    expect(await result.value.text()).toBe(JSON.stringify({ data: 'layer' }))
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect executes one request boundary with CurrentRequest, cancellation and cleanup', async () => {
  const outcomes: ScopeOutcome[] = []
  let requestLayerCalls = 0
  const App = HonoEffect.app(
    '@tests/HonoRequestBoundary',
    {
      requestLayer: (context) =>
        Layer.scoped(
          RequestId,
          () => {
            requestLayerCalls += 1
            return new RequestId(context.req.path)
          },
          (_instance, outcome) => {
            outcomes.push(outcome)
          }
        ),
      onSuccess: ({ value }, context) => context.json({ data: value }, 201)
    },
    async function* (http) {
      const app = new Hono()
      app.use('*', yield* http.middleware())
      app.get(
        '/items/:id',
        yield* http.gen(async function* (context) {
          const request = yield* CurrentRequest
          const signal = yield* CurrentAbortSignal
          const requestId = yield* RequestId

          return Result.ok({
            aborted: signal.aborted,
            id: context.req.param('id'),
            // SAFETY: CurrentRequest stores the original platform Request used by the Hono boundary.
            request: (request.request as Request).url,
            requestId: requestId.value
          })
        })
      )
      return app
    }
  )
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    const response = await app.fetch(
      new Request('http://localhost/items/42', { signal: controller.signal })
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      data: {
        aborted: true,
        id: '42',
        request: 'http://localhost/items/42',
        requestId: '/items/42'
      }
    })
    expect(requestLayerCalls).toBe(1)
    expect(outcomes).toEqual([{ status: 'success' }])
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect isolates concurrent requests and shares one boundary across nested middleware', async () => {
  const events: string[] = []
  const App = HonoEffect.app('@tests/HonoConcurrent', {}, async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    app.use('*', yield* http.middleware())
    app.get(
      '/:id',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* (context) {
          events.push(`start:${context.req.param('id')}`)
          await Promise.resolve()
          events.push(`end:${context.req.param('id')}`)
          return Result.ok(context.req.param('id'))
        }
      )
    )
    return app
  })
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const [first, second] = await Promise.all([app.request('/first'), app.request('/second')])

    expect(await first.json()).toEqual({ data: 'first' })
    expect(await second.json()).toEqual({ data: 'second' })
    expect(events).toEqual(['start:first', 'start:second', 'end:first', 'end:second'])
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect guard failures use the shared response policy and skip downstream', async () => {
  const failure = new HttpFailure('unauthorized')
  let routeCalled = false
  let policyCalls = 0
  const App = HonoEffect.app(
    '@tests/HonoGuard',
    {
      onFailure: (error: HttpFailure, context) => {
        policyCalls += 1
        return context.json({ error: error.message }, 401)
      }
    },
    async function* (http) {
      const app = new Hono()
      app.use('*', yield* http.middleware())
      app.use(
        '/private/*',
        yield* http.guard(
          // oxlint-disable-next-line require-yield -- guard bodies retain the generator API even when they need no Services.
          async function* () {
            return Result.err(failure)
          }
        )
      )
      app.get('/private/value', () => {
        routeCalled = true
        return new Response('unexpected')
      })
      return app
    }
  )
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const response = await app.request('/private/value')

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
    expect(routeCalled).toBe(false)
    expect(policyCalls).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect preserves response options, native responses and Hono defects', async () => {
  const defect = new Error('after defect')
  let observedDefect: unknown
  let policyCalls = 0
  const native = new Response('native', {
    headers: { 'set-cookie': 'session=ok' },
    status: 204
  })
  const App = HonoEffect.app(
    '@tests/HonoResponses',
    {
      onFailure: (_error: HttpFailure, context) => {
        policyCalls += 1
        return context.text('typed failure', 422)
      }
    },
    async function* (http) {
      const app = new Hono()
      app.onError((error) => {
        observedDefect = error
        return new Response('defect', { status: 599 })
      })
      app.use('*', yield* http.middleware())
      app.get(
        '/options',
        yield* http.gen(
          // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
          async function* () {
            return Result.ok({ value: 'ok' })
          },
          {
            serialize: (value) => value.value,
            status: 201
          }
        )
      )
      app.get(
        '/native',
        yield* http.gen(
          // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
          async function* () {
            return Result.ok(native)
          }
        )
      )
      app.get(
        '/defect',
        yield* http.gen(
          // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
          async function* () {
            return Result.err(new HttpFailure('typed'))
          }
        )
      )
      const after: MiddlewareHandler = async (_context, next) => {
        await next()
        throw defect
      }
      app.get(
        '/after-defect',
        yield* http.gen(
          after,
          // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
          async function* () {
            return Result.ok('ok')
          }
        )
      )
      return app
    }
  )
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const optionsResponse = await app.request('/options')
    const nativeResponse = await app.request('/native')
    const failureResponse = await app.request('/defect')
    const defectResponse = await app.request('/after-defect')

    expect(optionsResponse.status).toBe(201)
    expect(await optionsResponse.json()).toEqual({ data: 'ok' })
    expect(nativeResponse).toBe(native)
    expect(nativeResponse.headers.get('set-cookie')).toBe('session=ok')
    expect(failureResponse.status).toBe(422)
    expect(await failureResponse.text()).toBe('typed failure')
    expect(defectResponse.status).toBe(599)
    expect(await defectResponse.text()).toBe('defect')
    expect(observedDefect).toBe(defect)
    expect(policyCalls).toBe(1)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect preserves Hono validator and context inference at runtime', async () => {
  const App = HonoEffect.app('@tests/HonoValidator', {}, async function* (http) {
    const app = new Hono()
    const validate = validator('json', (value: { name?: string } | null) => {
      if (value?.name === undefined) {
        return new Response('invalid', { status: 400 })
      }

      return { name: value.name }
    })
    app.use('*', yield* http.middleware())
    app.post(
      '/users',
      yield* http.gen(
        validate,
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* (context) {
          return Result.ok(`${context.req.valid('json').name}:${context.req.path}`)
        }
      )
    )
    return app
  })
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const response = await app.request('/users', {
      body: JSON.stringify({ name: 'Ada' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })
    const invalid = await app.request('/users', {
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
      method: 'POST'
    })

    expect(await response.json()).toEqual({ data: 'Ada:/users' })
    expect(invalid.status).toBe(400)
    expect(await invalid.text()).toBe('invalid')
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect reports a missing request boundary explicitly', async () => {
  let observed: unknown
  const App = HonoEffect.app('@tests/HonoMissingBoundary', {}, async function* (http) {
    const app = new Hono()
    app.onError((error) => {
      observed = error
      return new Response('missing', { status: 500 })
    })
    app.get(
      '/',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* () {
          return Result.ok('never')
        }
      )
    )
    return app
  })
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const response = await app.request('/')

    expect(response.status).toBe(500)
    expect(await response.text()).toBe('missing')
    expect(observed).toBeInstanceOf(HonoEffectBoundaryMissingError)
  } finally {
    await runtime.dispose()
  }
})

test('HonoEffect defaults redact typed failures and pass through Response failures', async () => {
  const TaggedFailure = TaggedError('HonoTaggedFailure')
  const responseFailure = new Response('not found', { status: 404 })
  const App = HonoEffect.app('@tests/HonoDefaultPolicy', {}, async function* (http) {
    const app = new Hono()
    app.use('*', yield* http.middleware())
    app.get(
      '/error',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* () {
          return Result.err(new TaggedFailure({ message: 'private' }))
        }
      )
    )
    app.get(
      '/response',
      yield* http.gen(
        // oxlint-disable-next-line require-yield -- route bodies retain the generator API even when they need no Services.
        async function* () {
          return Result.err(responseFailure)
        }
      )
    )
    return app
  })
  const runtime = await Runtime.make(App.layer)

  try {
    const app = await resolveApp(runtime, App)
    const errorResponse = await app.request('/error')
    const response = await app.request('/response')

    expect(errorResponse.status).toBe(500)
    expect(await errorResponse.json()).toEqual({ error: 'Internal Server Error' })
    expect(response).toBe(responseFailure)
    expect(await response.text()).toBe('not found')
  } finally {
    await runtime.dispose()
  }
})
