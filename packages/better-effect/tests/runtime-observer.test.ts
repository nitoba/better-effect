import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import {
  Layer,
  LayerDisposeError,
  Runtime,
  Service,
  ServiceAcquisitionError,
  ServiceRuntime
} from '../src'
import { RecordedRuntimeObserver, RuntimeObserver, type RuntimeObserverEvent } from '../src/testing'

class RecordedService extends Service<RecordedService>()('RecordedService') {}

class BrokenService extends Service<BrokenService>()('RecordedBrokenService') {}

class FailingReleaseService extends Service<FailingReleaseService>()(
  'RecordedFailingReleaseService'
) {}

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
