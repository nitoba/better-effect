import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import { CurrentAbortSignal, Effect, Layer, Runtime, Service, type ScopeOutcome } from '../src'
import { CurrentRequest } from '../src/standard-services'
import { NextEffect } from '../src/next'
import type { NextEffectProgram } from '../src/next'
import { RecordedRuntimeObserver } from '../src/testing'

class RootService extends Service<RootService>()('NextRootService') {
  value(): string {
    return 'root'
  }
}

class RequestService extends Service<RequestService>()('NextRequestService') {
  constructor(readonly value: string) {
    super()
  }
}

class DomainFailure extends Error {
  readonly _tag = 'NextDomainFailure' as const
}

class RootOverride extends Service<RootOverride>()('NextRootService') {
  value(): string {
    return 'override'
  }
}

type RouteContext = {
  readonly params: Promise<{ readonly id: string }>
}

const request = (url: string, signal?: AbortSignal): Request =>
  new Request(`https://example.test${url}`, signal === undefined ? undefined : { signal })

test('NextEffect runs one WebEffect boundary with explicit context, signal, and serialization', async () => {
  const observer = RecordedRuntimeObserver.make()
  const runtime = await Runtime.make(Layer.make(RootService), { observers: [observer] })
  const controller = new AbortController()
  let requestLayerCalls = 0
  let released = false
  let serializedBeforeRelease = false
  let requestOutcome: ScopeOutcome | undefined

  const requestLayer = Layer.scoped(
    RequestService,
    () => new RequestService('request-local'),
    (_service, outcome) => {
      requestOutcome = outcome
      released = true
    }
  )
  const http = NextEffect.make<RootService, DomainFailure, typeof requestLayer, RouteContext>(
    runtime,
    {
      requestLayer: (incoming, context) => {
        requestLayerCalls += 1
        expect(incoming).toBeInstanceOf(Request)
        expect(context).toEqual({ params: expect.any(Promise) })
        return requestLayer
      },
      onFailure: () => Response.json({ error: 'failed' }, { status: 500 })
    }
  )

  const handler = http.handler(
    (incoming, context) =>
      Effect.fn(async function* () {
        const root = yield* RootService
        const local = yield* RequestService
        const current = yield* CurrentRequest
        const signal = yield* CurrentAbortSignal
        const { id } = await context.params

        // SAFETY: NextEffect supplies the native Request through CurrentRequest.
        expect(current.request).toBe(incoming)
        expect(signal.aborted).toBe(false)

        return Result.ok({ id, root: root.value(), local: local.value })
      }),
    {
      serialize: (value) => {
        serializedBeforeRelease = !released
        return value
      }
    }
  )

  try {
    const responsePromise = handler(request('/items', controller.signal), {
      params: Promise.resolve({ id: 'item-1' })
    })
    const response = await responsePromise

    expect(await response.json()).toEqual({
      data: { id: 'item-1', root: 'root', local: 'request-local' }
    })
    expect(response.status).toBe(200)
    expect(requestLayerCalls).toBe(1)
    expect(serializedBeforeRelease).toBe(true)
    expect(released).toBe(true)
    expect(requestOutcome?.status).toBe('success')
    expect(observer.executionStarts).toHaveLength(1)
    expect(observer.executionEnds).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})

test('NextEffect maps typed failures, preserves defects, and keeps root ownership', async () => {
  let rootReleases = 0
  const runtime = await Runtime.make(
    Layer.scoped(
      RootService,
      () => new RootService(),
      () => {
        rootReleases += 1
      }
    )
  )
  const failure = new DomainFailure('private')
  let failureRequest: Request | undefined
  let failureContext: RouteContext | undefined
  await runtime.warmup()
  const http = NextEffect.make<
    RootService,
    DomainFailure,
    ReturnType<typeof CurrentRequest.layer>,
    RouteContext
  >(runtime, {
    onFailure: (error, incoming, context) => {
      expect(error).toBe(failure)
      failureRequest = incoming
      failureContext = context
      return Response.json({ error: 'safe' }, { status: 422 })
    }
  })

  try {
    const failureHandler = http.gen(async function* (_incoming, _context) {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.err(failure)
    })
    const failureResponse = await failureHandler(request('/failure'), {
      params: Promise.resolve({ id: 'failure' })
    })

    expect(failureResponse.status).toBe(422)
    expect(await failureResponse.json()).toEqual({ error: 'safe' })
    expect(failureRequest?.url).toBe('https://example.test/failure')
    expect(failureContext).toEqual({ params: expect.any(Promise) })

    const defect = new Error('defect')
    const rejectingProgram = async () => {
      throw defect
    }
    // SAFETY: This fixture deliberately supplies a rejecting Program to preserve the original defect.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the test intentionally erases the Program's phantom metadata.
    const defectProgram = rejectingProgram as unknown as NextEffectProgram<never, never, never>
    const defectHandler = http.handler(() => defectProgram)
    let caughtDefect: unknown
    try {
      await defectHandler(request('/defect'), { params: Promise.resolve({ id: 'defect' }) })
    } catch (cause) {
      caughtDefect = cause
    }
    expect(caughtDefect).toBe(defect)
  } finally {
    await runtime.dispose()
  }

  expect(rootReleases).toBe(1)
})

test('NextEffect isolates concurrent request Layers and CurrentRequest values', async () => {
  const runtime = await Runtime.make(Layer.make(RootService))
  let arrived = 0
  let allowRequests!: () => void
  const bothArrived = new Promise<void>((resolve) => {
    allowRequests = resolve
  })
  let releases = 0
  const http = NextEffect.make<RootService, unknown, Layer.Any, RouteContext>(runtime, {
    requestLayer: (incoming) => {
      // SAFETY: This test intentionally erases the request Layer to model the documented unchecked escape hatch.
      return Layer.scoped(
        RequestService,
        () => new RequestService(new URL(incoming.url).pathname),
        () => {
          releases += 1
        }
      ) as Layer.Any
    }
  })
  const handler = http.handler((_incoming) =>
    Effect.fn(async function* () {
      const local = yield* RequestService
      const current = yield* CurrentRequest
      arrived += 1
      if (arrived === 2) {
        allowRequests()
      }
      await bothArrived

      // SAFETY: NextEffect supplies the native Request through CurrentRequest.
      const currentRequest = current.request as Request
      return Result.ok({ local: local.value, current: currentRequest.url })
    })
  )

  try {
    const [first, second] = await Promise.all([
      handler(request('/first'), { params: Promise.resolve({ id: 'first' }) }),
      handler(request('/second'), { params: Promise.resolve({ id: 'second' }) })
    ])

    expect(await first.json()).toEqual({
      data: {
        local: '/first',
        current: 'https://example.test/first'
      }
    })
    expect(await second.json()).toEqual({
      data: {
        local: '/second',
        current: 'https://example.test/second'
      }
    })
    expect(releases).toBe(2)
  } finally {
    await runtime.dispose()
  }
})

test('NextEffect permits compatible same-tag request overrides', async () => {
  const runtime = await Runtime.make(Layer.make(RootService))
  const http = NextEffect.make(runtime, {
    requestLayer: () => Layer.succeed(RootOverride, new RootOverride())
  })

  try {
    const response = await http.handler(() =>
      Effect.fn(async function* () {
        const root = yield* RootService
        return Result.ok(root.value())
      })
    )(request('/override'), { params: Promise.resolve({ id: 'override' }) })

    expect(await response.json()).toEqual({ data: 'override' })
  } finally {
    await runtime.dispose()
  }
})

test('NextEffect inherits WebEffect JSON success and redacted failure policies', async () => {
  const runtime = await Runtime.make(Layer.empty)
  const http = NextEffect.make(runtime)

  try {
    const success = http.gen(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.ok({ value: 'ok' })
    })
    const failure = http.gen(async function* () {
      yield* Result.await(Promise.resolve(Result.ok(undefined)))
      return Result.err(new Error('private detail'))
    })
    const invalidSerialization = http.gen(
      async function* () {
        yield* Result.await(Promise.resolve(Result.ok(undefined)))
        return Result.ok('invalid')
      },
      {
        // SAFETY: This runtime fixture verifies that the boundary rejects an invalid callback result.
        serialize: () => new Date() as never
      }
    )
    const context = { params: Promise.resolve({ id: 'policy' }) }

    const successResponse = await success(request('/policy'), context)
    const failureResponse = await failure(request('/policy-failure'), context)

    expect(successResponse.status).toBe(200)
    expect(await successResponse.json()).toEqual({ data: { value: 'ok' } })
    expect(failureResponse.status).toBe(500)
    expect(await failureResponse.json()).toEqual({ error: 'Internal Server Error' })

    let serializationError: unknown
    try {
      await invalidSerialization(request('/invalid'), context)
    } catch (cause) {
      serializationError = cause
    }
    expect(serializationError).toBeInstanceOf(TypeError)
    // SAFETY: The preceding assertion narrows this caught cause to an Error instance.
    expect((serializationError as Error).message).toContain(
      'WebEffect default success serialization'
    )
  } finally {
    await runtime.dispose()
  }
})

test('NextEffect rejects conflicting route success policies at runtime', async () => {
  const runtime = await Runtime.make(Layer.empty)
  const http = NextEffect.make(runtime)
  const program = Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('ok')
  })
  const conflictingPolicies = [
    { respond: () => new Response('ok'), serialize: () => null },
    { respond: () => new Response('ok'), onSuccess: () => new Response('ok') },
    { serialize: () => null, onSuccess: () => new Response('ok') }
  ]

  try {
    for (const options of conflictingPolicies) {
      // SAFETY: This test deliberately erases the exclusive policy union to model JavaScript input.
      expect(() => http.handler(() => program, options as never)).toThrow(
        'at most one success policy'
      )
    }
  } finally {
    await runtime.dispose()
  }
})
