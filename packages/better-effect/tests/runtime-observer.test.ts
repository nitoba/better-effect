import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import {
  Effect,
  Layer,
  LayerDisposeError,
  MapLayerBackend,
  Program,
  Runtime,
  Service,
  ServiceAcquisitionError,
  ServiceRuntime,
  type RuntimeExecutionEndEvent,
  type RuntimeExecutionStartEvent
} from '../src'
import { createRuntimeHandle } from '../src/layer/runtime'
import { RecordedRuntimeObserver, RuntimeObserver, type RuntimeObserverEvent } from '../src/testing'

class RecordedService extends Service<RecordedService>()('RecordedService') {}

class BrokenService extends Service<BrokenService>()('RecordedBrokenService') {}

class FailingReleaseService extends Service<FailingReleaseService>()(
  'RecordedFailingReleaseService'
) {}

const captureRejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

describe('RecordedRuntimeObserver', () => {
  test('records lifecycle events in immutable ordered snapshots', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const observedEvents: RuntimeObserverEvent[] = []
    const runtime = await Runtime.make(
      Layer.scoped(
        RecordedService,
        () => new RecordedService(),
        () => {}
      ),
      {
        observers: [
          RuntimeObserver.compose(recorder, {
            onServiceResolve: (event) => {
              observedEvents.push(event)
            },
            onServiceAcquire: (event) => {
              observedEvents.push(event)
            },
            onExecutionStart: (event) => {
              observedEvents.push(event)
            },
            onExecutionEnd: (event) => {
              observedEvents.push(event)
            },
            onResourceRelease: (event) => {
              observedEvents.push(event)
            }
          })
        ]
      }
    )

    try {
      const service = await runtime.run(() => ServiceRuntime.resolve(RecordedService))

      expect(service).toBeInstanceOf(RecordedService)
      expect(recorder.executionStarts).toHaveLength(1)
      expect(recorder.serviceAcquisitions).toHaveLength(1)
      expect(recorder.serviceResolutions).toHaveLength(1)
      expect(recorder.executionEnds).toHaveLength(1)
      expect(recorder.resourceReleases).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }

    const snapshot = recorder.snapshot()
    const executionStart = snapshot.executionStarts[0]
    const serviceAcquisition = snapshot.serviceAcquisitions[0]
    const serviceResolution = snapshot.serviceResolutions[0]
    const executionEnd = snapshot.executionEnds[0]
    const resourceRelease = snapshot.resourceReleases[0]

    if (
      !executionStart ||
      !serviceAcquisition ||
      !serviceResolution ||
      !executionEnd ||
      !resourceRelease
    ) {
      throw new Error('Expected the recorder to capture every Runtime event')
    }

    expect(snapshot.resourceReleases).toHaveLength(1)
    expect(snapshot.timeline).toEqual([
      executionStart,
      serviceAcquisition,
      serviceResolution,
      executionEnd,
      resourceRelease
    ])
    expect(snapshot.timeline).toEqual(observedEvents)
    expect(snapshot.timeline[0]).toBe(observedEvents[0])
    expect(snapshot.timeline[1]).toBe(observedEvents[1])
    expect(snapshot.timeline[2]).toBe(observedEvents[2])
    expect(snapshot.timeline[3]).toBe(observedEvents[3])
    expect(snapshot.timeline[4]).toBe(observedEvents[4])
    expect(snapshot.timeline[0]).toBe(executionStart)
    expect(snapshot.timeline[1]).toBe(serviceAcquisition)
    expect(snapshot.timeline[2]).toBe(serviceResolution)
    expect(snapshot.timeline[3]).toBe(executionEnd)
    expect(snapshot.timeline[4]).toBe(resourceRelease)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.timeline)).toBe(true)
    expect(Object.isFrozen(recorder.executionStarts)).toBe(true)
  })

  test('clears and reuses one observer without changing prior snapshots', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.make(RecordedService), {
      observers: [recorder]
    })

    try {
      await runtime.run(() => ServiceRuntime.resolve(RecordedService))
      const firstSnapshot = recorder.snapshot()

      recorder.clear()

      expect(recorder.snapshot()).toEqual({
        serviceResolutions: [],
        serviceAcquisitions: [],
        executionStarts: [],
        executionEnds: [],
        resourceReleases: [],
        timeline: []
      })
      expect(firstSnapshot.executionStarts).toHaveLength(1)
      expect(firstSnapshot.serviceResolutions).toHaveLength(1)

      const result = await runtime.run(() => Result.ok('reused'))

      expect(Result.isOk(result) && result.value).toBe('reused')
      expect(recorder.executionStarts).toHaveLength(1)
      expect(recorder.executionEnds).toHaveLength(1)
      expect(recorder.serviceResolutions).toHaveLength(0)
      expect(recorder.serviceAcquisitions).toHaveLength(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('records Result errors and thrown defects as failed executions', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.make(RecordedService), {
      observers: [recorder]
    })
    const resultFailure = new Error('result failed')
    const defect = new Error('defect')

    try {
      const result = await runtime.run(() => Result.err(resultFailure))

      expect(Result.isError(result)).toBe(true)

      if (Result.isError(result)) {
        expect(result.error).toBe(resultFailure)
      }

      const observedDefect = await runtime
        .run(() => {
          throw defect
        })
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(observedDefect).toBe(defect)
      expect(recorder.executionEnds).toHaveLength(2)
      expect(recorder.executionEnds[0]?.outcome).toEqual({
        status: 'failure',
        cause: resultFailure
      })
      expect(recorder.executionEnds[1]?.outcome).toEqual({
        status: 'failure',
        cause: defect
      })
    } finally {
      await runtime.dispose()
    }
  })

  test('records successful and failed Service acquisition', async () => {
    const successRecorder = RecordedRuntimeObserver.make()
    const successfulRuntime = await Runtime.make(Layer.make(RecordedService), {
      observers: [successRecorder]
    })

    try {
      await successfulRuntime.run(() => ServiceRuntime.resolve(RecordedService))

      expect(successRecorder.serviceAcquisitions[0]?.outcome).toEqual({ status: 'success' })
      expect(successRecorder.serviceResolutions[0]?.outcome).toEqual({ status: 'success' })
    } finally {
      await successfulRuntime.dispose()
    }

    const failureRecorder = RecordedRuntimeObserver.make()
    const acquisitionFailure = new Error('acquisition failed')
    const failedRuntime = await Runtime.make(
      Layer.make(BrokenService, () => {
        throw acquisitionFailure
      }),
      { observers: [failureRecorder] }
    )

    try {
      const failure = await failedRuntime
        .run(() => ServiceRuntime.resolve(BrokenService))
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(failure).toBeInstanceOf(ServiceAcquisitionError)
      expect(failureRecorder.serviceAcquisitions[0]?.outcome).toEqual({
        status: 'failure',
        cause: acquisitionFailure
      })
      expect(failureRecorder.serviceResolutions[0]?.outcome).toEqual({
        status: 'failure',
        cause: failure
      })
    } finally {
      await failedRuntime.dispose()
    }
  })

  test('records successful and failed Layer resource releases', async () => {
    const successRecorder = RecordedRuntimeObserver.make()
    const successfulRuntime = await Runtime.make(
      Layer.scoped(
        RecordedService,
        () => new RecordedService(),
        () => {}
      ),
      { observers: [successRecorder] }
    )

    await successfulRuntime.run(() => ServiceRuntime.resolve(RecordedService))
    await successfulRuntime.dispose()

    expect(successRecorder.resourceReleases[0]).toMatchObject({
      service: RecordedService,
      outcome: { status: 'success' }
    })
    expect(successRecorder.resourceReleases[0]?.error).toBeUndefined()

    const failureRecorder = RecordedRuntimeObserver.make()
    const releaseFailure = new Error('release failed')
    const failedRuntime = await Runtime.make(
      Layer.scoped(
        FailingReleaseService,
        () => new FailingReleaseService(),
        () => {
          throw releaseFailure
        }
      ),
      { observers: [failureRecorder] }
    )

    await failedRuntime.run(() => ServiceRuntime.resolve(FailingReleaseService))
    const disposeFailure = await failedRuntime.dispose().then(
      () => undefined,
      (cause) => cause
    )

    expect(disposeFailure).toBeInstanceOf(LayerDisposeError)
    expect(failureRecorder.resourceReleases[0]).toMatchObject({
      service: FailingReleaseService,
      outcome: { status: 'success' },
      error: releaseFailure
    })
  })
  test('correlates concurrent named executions and isolates attributes', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let firstStarted!: () => void
    let secondStarted!: () => void

    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve
    })
    const firstAttributes = { requestId: 'first' }
    const secondAttributes = { requestId: 'second' }
    const first = Program.named(
      'users.first',
      Effect.fn(async function* () {
        yield* []
        firstStarted()
        await firstGate
        return Result.ok('first')
      })
    )
    const second = Program.named(
      'users.second',
      Effect.fn(async function* () {
        yield* []
        secondStarted()
        await secondGate
        return Result.ok('second')
      })
    )

    try {
      const firstRun = runtime.run(first, { attributes: firstAttributes })
      await firstStartedPromise
      const secondRun = runtime.run(second, { attributes: secondAttributes })
      await secondStartedPromise

      expect(recorder.executionStarts).toHaveLength(2)
      releaseFirst()
      releaseSecond()
      await Promise.all([firstRun, secondRun])

      const firstStart = recorder.executionStarts.find((event) => event.name === 'users.first')
      const secondStart = recorder.executionStarts.find((event) => event.name === 'users.second')
      const firstEnd = recorder.executionEnds.find((event) => event.name === 'users.first')
      const secondEnd = recorder.executionEnds.find((event) => event.name === 'users.second')

      if (!firstStart || !secondStart || !firstEnd || !secondEnd) {
        throw new Error('Expected correlated named execution events')
      }

      expect(firstStart.executionId).not.toBe(secondStart.executionId)
      expect(firstStart.executionId).toBe(firstEnd.executionId)
      expect(secondStart.executionId).toBe(secondEnd.executionId)
      expect(firstStart.startedAt).toBe(firstEnd.startedAt)
      expect(secondStart.startedAt).toBe(secondEnd.startedAt)
      expect(firstStart.attributes).toEqual(firstAttributes)
      expect(secondStart.attributes).toEqual(secondAttributes)
      expect(firstStart.attributes).not.toBe(firstAttributes)
      expect(secondStart.attributes).not.toBe(secondAttributes)
      expect(firstStart.attributes).not.toBe(secondStart.attributes)
      expect(Object.isFrozen(firstStart.attributes)).toBe(true)
      expect(Object.isFrozen(secondStart.attributes)).toBe(true)
      expect(firstEnd.durationMs).toBeGreaterThanOrEqual(0)
      expect(secondEnd.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      releaseFirst()
      releaseSecond()
      await runtime.dispose()
    }
  })

  test('freezes execution event envelopes before observer dispatch', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const mutate = (event: RuntimeExecutionStartEvent | RuntimeExecutionEndEvent): void => {
      Reflect.set(event, 'executionId', 'mutated-id')
      Reflect.set(event, 'name', 'mutated-name')
      Reflect.set(event, 'attributes', { requestId: 'mutated-request' })
    }
    const runtime = await Runtime.make(Layer.merge(), {
      observers: [
        {
          onExecutionStart: mutate,
          onExecutionEnd: mutate
        },
        recorder
      ]
    })
    const program = Program.named(
      'events.stable',
      Effect.fn(async function* () {
        yield* []
        return Result.ok('stable')
      })
    )

    try {
      await runtime.run(program, { attributes: { requestId: 'original-request' } })
    } finally {
      await runtime.dispose()
    }

    const start = recorder.executionStarts[0]
    const end = recorder.executionEnds[0]

    if (!start || !end) {
      throw new Error('Expected frozen execution events')
    }

    expect(Object.isFrozen(start)).toBe(true)
    expect(Object.isFrozen(end)).toBe(true)
    expect(start.executionId).toBe(end.executionId)
    expect(start.name).toBe('events.stable')
    expect(end.name).toBe('events.stable')
    expect(start.attributes).toEqual({ requestId: 'original-request' })
    expect(end.attributes).toEqual({ requestId: 'original-request' })
  })

  test('preflights metadata before forking run and runWith executions', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
    const getterFailure = new Error('execution attribute getter failed')
    const attributes = Object.defineProperty({}, 'requestId', {
      enumerable: true,
      get: () => {
        throw getterFailure
      }
    })
    const program = () => Result.ok('not-started')

    try {
      const runFailure = await captureRejection(runtime.run(program, { attributes }))
      const runWithFailure = await captureRejection(
        runtime.runWith(Layer.merge(), program, { attributes })
      )

      expect(runFailure).toBe(getterFailure)
      expect(runWithFailure).toBe(getterFailure)
      expect(recorder.executionStarts).toHaveLength(0)
      expect(recorder.executionEnds).toHaveLength(0)

      const recovered = await runtime.run(() => Result.ok('recovered'))
      expect(Result.isOk(recovered) && recovered.value).toBe('recovered')
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects runs disposed during metadata preparation before starting them', async () => {
    for (const form of ['run', 'runWith'] as const) {
      const recorder = RecordedRuntimeObserver.make()
      const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
      let releaseExecution!: () => void
      let markExecutionStarted!: () => void
      let disposal: Promise<void> | undefined
      let lateRuns = 0

      const executionStarted = new Promise<void>((resolve) => {
        markExecutionStarted = resolve
      })
      const executionMayFinish = new Promise<void>((resolve) => {
        releaseExecution = resolve
      })
      const ongoing = runtime.run(async () => {
        markExecutionStarted()
        await executionMayFinish
        return Result.ok('ongoing')
      })
      await executionStarted

      const program = () => {
        lateRuns++
        return Result.ok('late')
      }
      const attributes = {
        get requestId(): string {
          disposal = runtime.dispose()
          return 'reentrant'
        }
      }
      const controller = new AbortController()
      const signalOptions = {
        get signal(): AbortSignal {
          disposal = runtime.dispose()
          return controller.signal
        }
      }

      try {
        if (form === 'run') {
          expect(() => runtime.run(program, { attributes })).toThrow(
            'Cannot run a program using a disposed Layer'
          )
        } else {
          expect(() => runtime.runWith(Layer.merge(), program, signalOptions)).toThrow(
            'Cannot run a program using a disposed Layer'
          )
        }

        if (!disposal) {
          throw new Error('Expected metadata preparation to start Runtime disposal')
        }

        let disposalFinished = false
        void disposal.then(() => {
          disposalFinished = true
        })

        await Promise.resolve()
        expect(disposalFinished).toBe(false)
        expect(lateRuns).toBe(0)

        releaseExecution()
        await ongoing
        await disposal

        expect(disposalFinished).toBe(true)
        expect(recorder.executionStarts).toHaveLength(1)
        expect(recorder.executionEnds).toHaveLength(1)
      } finally {
        releaseExecution()
        await ongoing.catch(() => {})
        await disposal?.catch(() => {})
      }
    }
  })

  test('keeps Program names lazy, private, and explicit for collections', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
    let runs = 0
    const child = Program.named(
      'child.name',
      Effect.fn(function* () {
        yield* []
        runs++
        return Result.ok('child')
      })
    )

    expect(runs).toBe(0)
    expect(Object.keys(child)).toEqual([])

    try {
      const unnamed = Program.all([child])
      const named = Program.all([child], { name: 'users.batch' })
      const namedResults = Program.allResults([child], { name: 'users.results' })
      const namedForEach = Program.forEach([1], () => child, { name: 'users.each' })
      const renamed = Program.named('users.renamed', named)

      expect(runs).toBe(0)
      await runtime.run(unnamed)
      await runtime.run(renamed)
      await runtime.run(namedResults)
      await runtime.run(namedForEach)
      expect(runs).toBe(4)

      expect(recorder.executionStarts[0]?.name).toBeUndefined()
      expect(recorder.executionStarts[1]?.name).toBe('users.renamed')
      expect(recorder.executionStarts[2]?.name).toBe('users.results')
      expect(recorder.executionStarts[3]?.name).toBe('users.each')
      expect(recorder.executionEnds[0]?.name).toBeUndefined()
      expect(recorder.executionEnds[1]?.name).toBe('users.renamed')
      expect(recorder.executionEnds[2]?.name).toBe('users.results')
      expect(recorder.executionEnds[3]?.name).toBe('users.each')
    } finally {
      await runtime.dispose()
    }
  })

  test('carries metadata through execution-local runWith Layers', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
    const program = Program.named(
      'request.handle',
      Effect.fn(async function* () {
        yield* []
        return Result.ok('handled')
      })
    )

    try {
      const result = await runtime.runWith(Layer.merge(), program, {
        attributes: { requestId: 'request-1' }
      })

      expect(Result.isOk(result) && result.value).toBe('handled')
      expect(recorder.executionStarts[0]?.name).toBe('request.handle')
      expect(recorder.executionStarts[0]?.attributes).toEqual({ requestId: 'request-1' })
      expect(recorder.executionEnds[0]?.executionId).toBe(recorder.executionStarts[0]?.executionId)
    } finally {
      await runtime.dispose()
    }
  })

  test('propagates names through transparent Program combinators', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
    const source = Program.named(
      'users.source',
      Effect.fn(async function* () {
        yield* []
        return Result.ok(1)
      })
    )
    const mapped = Program.map(source, (value) => value + 1)
    const errorMapped = Program.mapError(source, (error) => String(error))
    const tapped = Program.tap(source, () => {})
    const errorTapped = Program.tapError(source, () => {})
    const chained = Program.andThen(source, (value) => Result.ok(value + 1))
    const failed = Program.named(
      'users.failed',
      Effect.fn(async function* () {
        yield* []
        return Result.err<number, 'failed'>('failed')
      })
    )
    const recovered = Program.recover(failed, () => Result.ok(0))

    try {
      await Promise.all([
        runtime.run(mapped),
        runtime.run(errorMapped),
        runtime.run(tapped),
        runtime.run(errorTapped),
        runtime.run(chained),
        runtime.run(recovered)
      ])

      expect(recorder.executionStarts.map((event) => event.name)).toEqual([
        'users.source',
        'users.source',
        'users.source',
        'users.source',
        'users.source',
        'users.failed'
      ])
      expect(recorder.executionEnds.map((event) => event.name)).toEqual(
        expect.arrayContaining(['users.source', 'users.failed'])
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('emits exactly one correlated end after every execution outcome', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const runtime = await Runtime.make(Layer.merge(), { observers: [recorder] })
    const resultFailure = new Error('result failure')
    const thrownFailure = new Error('thrown failure')
    const rejectedFailure = new Error('rejected failure')
    const cleanupFailure = new Error('cleanup failure')

    try {
      await runtime.run(() => Result.err(resultFailure))
      await runtime
        .run(() => {
          throw thrownFailure
        })
        .catch((cause) => {
          expect(cause).toBe(thrownFailure)
        })
      await runtime
        .run(() => Promise.reject(rejectedFailure))
        .catch((cause) => {
          expect(cause).toBe(rejectedFailure)
        })
      await runtime
        .run(
          Effect.fn(async function* () {
            yield* Effect.acquireRelease(
              () => 'resource',
              () => {
                throw cleanupFailure
              }
            )
            return Result.ok(true)
          })
        )
        .catch((cause) => {
          expect(cause).toMatchObject({ causes: [cleanupFailure] })
        })

      expect(recorder.executionStarts).toHaveLength(4)
      expect(recorder.executionEnds).toHaveLength(4)
      expect(recorder.executionEnds).toEqual(
        expect.arrayContaining(
          recorder.executionStarts.map((start) =>
            expect.objectContaining({ executionId: start.executionId })
          )
        )
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('rejects ID and timestamp failures before forking either execution form', async () => {
    const idFailure = new Error('execution ID failed')
    const timestampFailure = new Error('execution timestamp failed')
    const failures = [
      {
        cause: idFailure,
        overrides: {
          createExecutionId: () => {
            throw idFailure
          }
        }
      },
      {
        cause: timestampFailure,
        overrides: {
          now: () => {
            throw timestampFailure
          }
        }
      }
    ]

    for (const { cause, overrides } of failures) {
      const recorder = RecordedRuntimeObserver.make()
      const handle = await createRuntimeHandle(
        Layer.merge(),
        new MapLayerBackend(),
        { observers: [recorder] },
        overrides
      )
      const program = () => Result.ok('not-started')

      try {
        const runFailure = await captureRejection(handle.run(program))
        const runWithFailure = await captureRejection(handle.runWith(Layer.merge(), program))

        expect(runFailure).toBe(cause)
        expect(runWithFailure).toBe(cause)
        expect(recorder.executionStarts).toHaveLength(0)
        expect(recorder.executionEnds).toHaveLength(0)
      } finally {
        await handle.dispose()
      }
    }
  })

  test('uses injected monotonic dependencies and measures execution cleanup', async () => {
    const recorder = RecordedRuntimeObserver.make()
    let nextId = 0
    const timestamps = [100, 145]
    let cleanupSettled = false
    const handle = await createRuntimeHandle(
      Layer.merge(),
      new MapLayerBackend(),
      { observers: [recorder] },
      {
        createExecutionId: () => `test-execution-${++nextId}`,
        now: () => timestamps.shift() ?? 145
      }
    )

    try {
      await handle.run(
        Effect.fn(async function* () {
          yield* Effect.acquireRelease(
            () => 'resource',
            () => {
              cleanupSettled = true
            }
          )
          return Result.ok(true)
        })
      )

      const start = recorder.executionStarts[0]
      const end = recorder.executionEnds[0]

      if (!start || !end) {
        throw new Error('Expected injected execution events')
      }

      expect(start.executionId).toBe('test-execution-1')
      expect(end.executionId).toBe(start.executionId)
      expect(start.startedAt).toBe(100)
      expect(end.durationMs).toBe(45)
      expect(cleanupSettled).toBe(true)
    } finally {
      await handle.dispose()
    }
  })
})

describe('RuntimeObserver.compose', () => {
  test('supports zero, one and multiple observers in declaration order', async () => {
    const recorder = RecordedRuntimeObserver.make()
    const calls: string[] = []
    const runtime = await Runtime.make(Layer.make(RecordedService), {
      observers: [
        RuntimeObserver.compose(),
        RuntimeObserver.compose(
          recorder,
          {
            onExecutionStart: () => {
              calls.push('first')
            }
          },
          {
            onExecutionStart: () => {
              calls.push('second')
            }
          }
        )
      ]
    })

    try {
      const result = await runtime.run(() => Result.ok('composed'))

      expect(Result.isOk(result) && result.value).toBe('composed')
      expect(calls).toEqual(['first', 'second'])
      expect(recorder.executionStarts).toHaveLength(1)
      expect(recorder.executionEnds).toHaveLength(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('isolates synchronous observer throws from later observers and Runtime results', async () => {
    const calls: string[] = []
    const runtime = await Runtime.make(Layer.make(RecordedService), {
      observers: [
        RuntimeObserver.compose(
          {
            onExecutionStart: () => {
              throw new Error('observer failed')
            }
          },
          {
            onExecutionStart: () => {
              calls.push('later observer')
            }
          }
        )
      ]
    })

    try {
      const result = await runtime.run(() => Result.ok('unchanged'))

      expect(Result.isOk(result) && result.value).toBe('unchanged')
      expect(calls).toEqual(['later observer'])
    } finally {
      await runtime.dispose()
    }
  })

  test('isolates asynchronous observer rejections from later observers and Runtime results', async () => {
    const calls: string[] = []
    const runtime = await Runtime.make(Layer.make(RecordedService), {
      observers: [
        RuntimeObserver.compose(
          {
            onExecutionStart: async () => {
              throw new Error('observer rejected')
            }
          },
          {
            onExecutionStart: () => {
              calls.push('later observer')
            }
          }
        )
      ]
    })

    try {
      const result = await runtime.run(() => Result.ok('unchanged'))

      await Promise.resolve()
      expect(Result.isOk(result) && result.value).toBe('unchanged')
      expect(calls).toEqual(['later observer'])
    } finally {
      await runtime.dispose()
    }
  })
})
