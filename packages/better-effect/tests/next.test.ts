/* oxlint-disable typescript/await-thenable -- Bun's promise matchers are asynchronous despite their matcher return type. */

import { expect, test } from 'bun:test'
import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Runtime,
  RuntimeExecutorNotConfiguredError,
  Service,
  type ScopeOutcome
} from '../src'
import { CurrentRequest } from '../src/standard-services'
import { NextEffect, NextEffectDisposedError } from '../src/next'
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

const context = (id = 'item'): RouteContext => ({ params: Promise.resolve({ id }) })

test('NextEffect.managed runs one WebEffect boundary with serialization and request scope cleanup', async () => {
  const observer = RecordedRuntimeObserver.make()
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
  const http = NextEffect.managed(Layer.make(RootService), {
    requestLayer: (incoming, routeContext: RouteContext) => {
      requestLayerCalls += 1
      expect(incoming).toBeInstanceOf(Request)
      expect(routeContext).toEqual({ params: expect.any(Promise) })
      return requestLayer
    },
    onFailure: () => Response.json({ error: 'failed' }, { status: 500 }),
    runtime: { observers: [observer] }
  })
  const controller = new AbortController()

  const handler = http.handler(
    (incoming, routeContext: RouteContext) =>
      Effect.fn(async function* () {
        const root = yield* RootService
        const local = yield* RequestService
        const current = yield* CurrentRequest
        const signal = yield* CurrentAbortSignal
        const { id } = await routeContext.params

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

  const response = await handler(request('/items', controller.signal), context('item-1'))

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

  await http.dispose()
})

test('NextEffect.fromCurrent captures the active executor and propagates route requirements', async () => {
  const runtime = await Runtime.make(Layer.make(RootService))
  const next = NextEffect.fromCurrent()
  const materialize = Effect.fn(async function* () {
    const handler = yield* next.gen(async function* () {
      const root = yield* RootService
      return Result.ok(root.value())
    })

    return Result.ok(handler)
  })

  try {
    const handler = Result.unwrap(await runtime.run(materialize))
    const response = await handler(request('/current'), context('current'))

    expect(await response.json()).toEqual({ data: 'root' })
  } finally {
    await runtime.dispose()
  }
})

test('NextEffect.fromCurrent fails explicitly outside a Runtime', () => {
  const next = NextEffect.fromCurrent()
  const operation = next.gen(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('never')
  })
  const iterator = operation[Symbol.iterator]()

  expect(() => iterator.next()).toThrow(RuntimeExecutorNotConfiguredError)
})

test('managed initialization is lazy and shared by concurrent first requests', async () => {
  const signalListenersBefore = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')
  let acquisitions = 0
  let releaseAcquisition!: () => void
  const acquisitionGate = new Promise<void>((resolve) => {
    releaseAcquisition = resolve
  })
  const http = NextEffect.managed(
    Layer.make(RootService, async () => {
      acquisitions += 1
      await acquisitionGate
      return new RootService()
    }),
    { runtime: { warmup: true } }
  )
  const handler = http.gen(async function* () {
    const root = yield* RootService
    return Result.ok(root.value())
  })

  expect(http.inspect().state).toBe('idle')
  const first = handler(request('/first'), context('first'))
  const second = handler(request('/second'), context('second'))

  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  expect(http.inspect().state).toBe('initializing')
  expect(acquisitions).toBe(1)

  releaseAcquisition()
  const [firstResponse, secondResponse] = await Promise.all([first, second])

  expect(await firstResponse.json()).toEqual({ data: 'root' })
  expect(await secondResponse.json()).toEqual({ data: 'root' })
  expect(acquisitions).toBe(1)
  expect(http.inspect().state).toBe('ready')
  expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(
    signalListenersBefore
  )

  await http.dispose()
  expect(http.inspect().state).toBe('disposed')
})

test('managed propagates root cleanup failures and leaves the manager disposed', async () => {
  const cleanupFailure = new Error('root cleanup failed')
  const http = NextEffect.managed(
    Layer.scoped(
      RootService,
      () => new RootService(),
      () => {
        throw cleanupFailure
      }
    ),
    { runtime: { warmup: true } }
  )

  await http.initialize()
  await expect(http.dispose()).rejects.toThrow('Failed to dispose Layer')
  expect(http.inspect().state).toBe('disposed')
})

test('managed initialization failure is memoized until disposal', async () => {
  let attempts = 0
  const failure = new Error('init failed')
  const http = NextEffect.managed(
    Layer.make(RootService, () => {
      attempts += 1
      throw failure
    }),
    { runtime: { warmup: true } }
  )

  let firstFailure: unknown
  try {
    await http.initialize()
  } catch (cause) {
    firstFailure = cause
  }

  let secondFailure: unknown
  try {
    await http.initialize()
  } catch (cause) {
    secondFailure = cause
  }

  expect(firstFailure).toBeInstanceOf(Error)
  expect(secondFailure).toBe(firstFailure)
  expect(attempts).toBe(1)
  expect(http.inspect().state).toBe('failed')

  await http.dispose()
  await expect(http.dispose()).resolves.toBeUndefined()
})

test('dispose during initialization drains the shared initialization and is idempotent', async () => {
  let releaseInitialization!: () => void
  const initializationGate = new Promise<void>((resolve) => {
    releaseInitialization = resolve
  })
  const http = NextEffect.managed(
    Layer.make(RootService, async () => {
      await initializationGate
      return new RootService()
    }),
    { runtime: { warmup: true } }
  )

  const initialized = http.initialize()
  const firstDispose = http.dispose()
  const secondDispose = http.dispose()

  expect(firstDispose).toBe(secondDispose)
  expect(http.inspect().state).toBe('disposing')
  releaseInitialization()

  await expect(initialized).resolves.toBeUndefined()
  await expect(firstDispose).resolves.toBeUndefined()
  expect(http.inspect().state).toBe('disposed')
})

test('dispose blocks new requests while admitted requests drain', async () => {
  let allowRequest!: () => void
  const requestGate = new Promise<void>((resolve) => {
    allowRequest = resolve
  })
  const http = NextEffect.managed(Layer.make(RootService))
  const handler = http.gen(async function* () {
    yield* RootService
    await requestGate
    return Result.ok('done')
  })

  const active = handler(request('/active'), context('active'))
  await Promise.resolve()
  const disposing = http.dispose()

  await expect(handler(request('/late'), context('late'))).rejects.toBeInstanceOf(
    NextEffectDisposedError
  )
  allowRequest()

  await expect(active).resolves.toBeInstanceOf(Response)
  await expect(disposing).resolves.toBeUndefined()
})

test('managed request Layers remain isolated and compatible overrides work', async () => {
  let releases = 0
  const http = NextEffect.managed(Layer.make(RootService), {
    requestLayer: (incoming: Request) =>
      Layer.scoped(
        RequestService,
        () => new RequestService(new URL(incoming.url).pathname),
        () => {
          releases += 1
        }
      )
  })
  const handler = http.handler((_incoming) =>
    Effect.fn(async function* () {
      const local = yield* RequestService
      const current = yield* CurrentRequest
      // SAFETY: CurrentRequest is supplied by the Next WebEffect boundary with the native Request value.
      return Result.ok({ local: local.value, current: (current.request as Request).url })
    })
  )

  const [first, second] = await Promise.all([
    handler(request('/first'), context('first')),
    handler(request('/second'), context('second'))
  ])

  expect(await first.json()).toEqual({
    data: { local: '/first', current: 'https://example.test/first' }
  })
  expect(await second.json()).toEqual({
    data: { local: '/second', current: 'https://example.test/second' }
  })
  expect(releases).toBe(2)
  await http.dispose()

  const override = NextEffect.managed(Layer.make(RootService), {
    requestLayer: () => Layer.succeed(RootOverride, new RootOverride())
  })
  const overrideHandler = override.handler(() =>
    Effect.fn(async function* () {
      const root = yield* RootService
      return Result.ok(root.value())
    })
  )
  const response = await overrideHandler(request('/override'), context('override'))
  expect(await response.json()).toEqual({ data: 'override' })
  await override.dispose()
})

test('managed maps typed failures and preserves defects', async () => {
  const failure = new DomainFailure('private')
  const http = NextEffect.managed(Layer.empty, {
    onFailure: (error: DomainFailure) => Response.json({ error: error.message }, { status: 422 })
  })

  const failureHandler = http.gen(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.err(failure)
  })
  const failureResponse = await failureHandler(request('/failure'), context('failure'))

  expect(failureResponse.status).toBe(422)
  expect(await failureResponse.json()).toEqual({ error: 'private' })

  const defect = new Error('defect')
  const rejectingProgram = async () => {
    throw defect
  }
  // SAFETY: This fixture deliberately erases the Program's phantom metadata to preserve a thrown defect.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  const defectProgram = rejectingProgram as unknown as NextEffectProgram<never, never, never>
  const defectHandler = http.handler(() => defectProgram)

  await expect(defectHandler(request('/defect'), context('defect'))).rejects.toBe(defect)
  await http.dispose()
})

test('route success policies remain exclusive at runtime', async () => {
  const http = NextEffect.managed(Layer.empty)
  const program = Effect.fn(async function* () {
    yield* Result.await(Promise.resolve(Result.ok(undefined)))
    return Result.ok('ok')
  })
  const conflictingPolicies = [
    { respond: () => new Response('ok'), serialize: () => null },
    { respond: () => new Response('ok'), onSuccess: () => new Response('ok') },
    { serialize: () => null, onSuccess: () => new Response('ok') }
  ]

  for (const options of conflictingPolicies) {
    // SAFETY: This fixture erases the exclusive route option union to exercise JavaScript input validation.
    expect(() => http.handler(() => program, options as never)).toThrow(
      'at most one success policy'
    )
  }

  await http.dispose()
})
