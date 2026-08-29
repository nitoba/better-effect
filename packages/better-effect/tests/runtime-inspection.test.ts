import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  Layer,
  LayerDisposeError,
  MapLayerBackend,
  Program,
  Runtime,
  Scope,
  Service,
  ServiceRuntime,
  type AnyServiceToken,
  type LayerBackend,
  type LayerRegistration,
  type RuntimeInspection
} from '../src'

class InspectionDatabase extends Service<InspectionDatabase>()('inspection.database') {}

class InspectionRepository extends Service<InspectionRepository>()('inspection.repository') {}

class InspectionWarmupService extends Service<InspectionWarmupService>()('inspection.warmup') {}

class InspectionBrokenService extends Service<InspectionBrokenService>()('inspection.broken') {}

class InspectionFailingRelease extends Service<InspectionFailingRelease>()(
  'inspection.failing-release'
) {}

class InspectionCanonicalService extends Service<InspectionCanonicalService>()(
  'inspection.canonical'
) {}

type Deferred = {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

class DelayedRegistrationBackend implements LayerBackend {
  readonly delegate = new MapLayerBackend()
  readonly registeredTags: string[] = []

  constructor(private readonly registrationGate: Deferred) {}

  register(registration: LayerRegistration): Promise<void> {
    return this.registrationGate.promise.then(() => {
      if (registration.serviceTag === undefined) {
        throw new Error('Expected a canonical registration tag')
      }

      this.registeredTags.push(registration.serviceTag)
      this.delegate.register(registration)
    })
  }

  resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    return this.delegate.resolve(token)
  }

  disposeAll(): Promise<void> {
    return this.delegate.disposeAll()
  }
}

const namedProgram = (
  name: string,
  started: () => void,
  gate: Promise<void>,
  onCleanup?: () => void | PromiseLike<void>
) =>
  Program.named(
    name,
    Effect.fn(async function* () {
      yield* []

      if (onCleanup) {
        Scope.current().addFinalizer(() => onCleanup())
      }

      started()
      await gate
      return Result.ok(name)
    })
  )

describe('Runtime.inspect', () => {
  test('returns detached immutable diagnostics without resolving or notifying', async () => {
    let acquisitions = 0
    let observerEvents = 0
    const runtime = await Runtime.make(
      Layer.merge(
        Layer.make(InspectionDatabase, () => {
          acquisitions++
          return new InspectionDatabase()
        }),
        Layer.make(InspectionRepository, () => {
          acquisitions++
          return new InspectionRepository()
        })
      ),
      {
        observers: [
          {
            onServiceResolve: () => {
              observerEvents++
            },
            onServiceAcquire: () => {
              observerEvents++
            }
          }
        ]
      }
    )

    try {
      const initial = runtime.inspect()

      expect(initial).toEqual({
        state: 'active',
        warmup: 'idle',
        activeExecutions: 0,
        executions: [],
        services: ['inspection.database', 'inspection.repository'],
        shutdownSignalAborted: false
      })
      expect(acquisitions).toBe(0)
      expect(observerEvents).toBe(0)
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Verify snapshots do not retain object tag aliases.
      expect(initial.services.every((tag) => typeof tag === 'string')).toBe(true)
      expect(Object.isFrozen(initial)).toBe(true)
      expect(Object.isFrozen(initial.executions)).toBe(true)
      expect(Object.isFrozen(initial.services)).toBe(true)

      const second = runtime.inspect()
      expect(second).not.toBe(initial)
      expect(second.executions).not.toBe(initial.executions)
      expect(second.services).not.toBe(initial.services)

      Reflect.set(initial.services, 0, 'mutated')

      expect(runtime.inspect().services).toEqual(['inspection.database', 'inspection.repository'])
      expect(Object.keys(initial)).toEqual([
        'state',
        'warmup',
        'activeExecutions',
        'executions',
        'services',
        'shutdownSignalAborted'
      ])
    } finally {
      await runtime.dispose()
    }
  })

  test('uses canonical tags across asynchronous backend registration', async () => {
    const registrationGate = deferred()
    const backend = new DelayedRegistrationBackend(registrationGate)
    const runtimePromise = Runtime.make(
      Layer.make(InspectionCanonicalService, () => new InspectionCanonicalService()),
      backend
    )

    await Promise.resolve()
    expect(backend.registeredTags).toEqual([])

    expect(Reflect.set(InspectionCanonicalService, 'serviceTag', 'inspection.mutated')).toBe(false)

    registrationGate.resolve()
    const runtime = await runtimePromise

    try {
      expect(backend.registeredTags).toEqual(['inspection.canonical'])
      expect(runtime.inspect().services).toEqual(['inspection.canonical'])
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Verify the backend-facing tag is primitive.
      expect(runtime.inspect().services.every((tag) => typeof tag === 'string')).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })

  test('reports warmup before, during, after and after failure', async () => {
    const acquisitionStarted = deferred()
    const releaseAcquisition = deferred()
    const runtime = await Runtime.make(
      Layer.make(InspectionWarmupService, async () => {
        acquisitionStarted.resolve()
        await releaseAcquisition.promise
        return new InspectionWarmupService()
      })
    )

    try {
      expect(runtime.inspect().warmup).toBe('idle')
      const warmup = runtime.warmup()
      await acquisitionStarted.promise
      expect(runtime.inspect()).toMatchObject({
        state: 'active',
        warmup: 'running',
        activeExecutions: 0
      })

      releaseAcquisition.resolve()
      await warmup
      expect(runtime.inspect().warmup).toBe('completed')
    } finally {
      await runtime.dispose()
    }

    const failureCause = new Error('warmup failed')
    const failedRuntime = await Runtime.make(
      Layer.make(InspectionBrokenService, () => {
        throw failureCause
      })
    )

    const failure = await failedRuntime.warmup().then(
      () => undefined,
      (cause) => cause
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failedRuntime.inspect()).toMatchObject({
      state: 'disposed',
      warmup: 'failed',
      activeExecutions: 0
    })
  })

  test('tracks concurrent named executions through Scope cleanup', async () => {
    let runtime!: Runtime<never>
    let startInspection: RuntimeInspection | undefined
    runtime = await Runtime.make(Layer.empty, {
      observers: [
        {
          onExecutionStart: () => {
            startInspection = runtime.inspect()
          }
        }
      ]
    })

    const firstStarted = deferred()
    const releaseFirst = deferred()
    const firstCleanupStarted = deferred()
    const releaseFirstCleanup = deferred()
    const secondStarted = deferred()
    const releaseSecond = deferred()
    const first = namedProgram(
      'inspection.first',
      firstStarted.resolve,
      releaseFirst.promise,
      () => {
        firstCleanupStarted.resolve()
        return releaseFirstCleanup.promise
      }
    )
    const second = namedProgram('inspection.second', secondStarted.resolve, releaseSecond.promise)

    try {
      const firstRun = runtime.run(first)
      await firstStarted.promise
      expect(startInspection).toMatchObject({
        state: 'active',
        activeExecutions: 1
      })

      const secondRun = runtime.run(second)
      await secondStarted.promise
      const during = runtime.inspect()

      expect(during.state).toBe('active')
      expect(during.activeExecutions).toBe(2)
      expect(during.executions).toHaveLength(2)
      expect(during.executions.map(({ name }) => name)).toEqual([
        'inspection.first',
        'inspection.second'
      ])
      expect(new Set(during.executions.map(({ executionId }) => executionId)).size).toBe(2)
      for (const execution of during.executions) {
        expect(Object.isFrozen(execution)).toBe(true)
        expect(Object.keys(execution)).toEqual(['executionId', 'startedAt', 'name'])
        expect('scope' in execution).toBe(false)
        expect('attributes' in execution).toBe(false)
      }

      const repeated = Array.from({ length: 100 }, () => runtime.inspect())
      expect(repeated.every((snapshot) => snapshot.activeExecutions === 2)).toBe(true)

      releaseFirst.resolve()
      await firstCleanupStarted.promise
      const duringCleanup = runtime.inspect()
      expect(duringCleanup.activeExecutions).toBe(2)
      expect(duringCleanup.executions.map(({ name }) => name)).toEqual([
        'inspection.first',
        'inspection.second'
      ])

      releaseSecond.resolve()
      await secondRun
      expect(runtime.inspect().activeExecutions).toBe(1)

      releaseFirstCleanup.resolve()
      await firstRun
      expect(runtime.inspect().activeExecutions).toBe(0)
    } finally {
      releaseFirst.resolve()
      releaseSecond.resolve()
      releaseFirstCleanup.resolve()
      await runtime.dispose()
    }
  })

  test('transitions to disposing before waiting and exposes shutdown aborts', async () => {
    let runtime!: Runtime<never>
    let abortedInspection: RuntimeInspection | undefined
    runtime = await Runtime.make(Layer.empty)
    const started = deferred()
    const execution = runtime.run(
      Effect.fn(async function* () {
        const signal = yield* CurrentAbortSignal
        started.resolve()
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              abortedInspection = runtime.inspect()
              resolve()
            },
            { once: true }
          )
        })
        return Result.ok(signal.aborted)
      })
    )

    await started.promise
    const disposal = runtime.dispose({
      gracePeriod: 0,
      abortAfterGracePeriod: true
    })

    expect(runtime.inspect().state).toBe('disposing')
    await Promise.all([execution, disposal])
    expect(abortedInspection).toMatchObject({
      state: 'disposing',
      activeExecutions: 1,
      shutdownSignalAborted: true
    })
    expect(runtime.inspect()).toMatchObject({
      state: 'disposed',
      activeExecutions: 0,
      shutdownSignalAborted: true
    })
  })

  test('reports disposed after cleanup failures', async () => {
    const releaseFailure = new Error('release failed')
    const runtime = await Runtime.make(
      Layer.scoped(
        InspectionFailingRelease,
        () => new InspectionFailingRelease(),
        () => {
          throw releaseFailure
        }
      )
    )

    await runtime.run(() => ServiceRuntime.resolve(InspectionFailingRelease))
    const failure = await runtime.dispose().then(
      () => undefined,
      (cause) => cause
    )

    expect(failure).toBeInstanceOf(LayerDisposeError)
    expect(runtime.inspect()).toMatchObject({
      state: 'disposed',
      activeExecutions: 0
    })
  })
})
