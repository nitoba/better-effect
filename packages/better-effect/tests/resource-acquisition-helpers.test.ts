import { describe, expect, test } from 'bun:test'

import { Result, UnhandledException, type Result as ResultType } from 'better-result'

import { Effect } from '../src/effect'
import { Layer, LayerDisposeError, MapLayerBackend } from '../src/layer'
import { Runtime } from '../src/runtime'
import { Scope, ScopeCloseError, ScopeClosedError } from '../src/scope'

import type { DisposableResource, ScopeOutcome } from '../src/scope'

import { Service, ServiceAcquisitionError, ServiceRuntime } from '../src/service'

type Connection = {
  readonly id: string
}

const captureRejection = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

const expectSameResult = (result: ResultType<any, any>, expected: ResultType<any, any>): void => {
  expect(result).toBe(expected)
}

const expectUnhandled = (result: ResultType<unknown, unknown>, cause: unknown): void => {
  expect(Result.isError(result)).toBe(true)

  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(UnhandledException)

    if (result.error instanceof UnhandledException) {
      expect(result.error.cause).toBe(cause)
    }
  }
}

class DisposableClient extends Service<DisposableClient>()('DisposableClient') {
  request(): string {
    return 'request'
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

class SyncDisposableClient extends Service<SyncDisposableClient>()('SyncDisposableClient') {
  request(): string {
    return 'request'
  }

  [Symbol.dispose](): void {}
}

class RecordingBackend extends MapLayerBackend {
  constructor(private readonly events: string[]) {
    super()
  }

  override async disposeAll(...args: Parameters<MapLayerBackend['disposeAll']>): Promise<void> {
    this.events.push('backend')
    await super.disposeAll(...args)
  }
}

describe('Effect.acquireReleaseResult', () => {
  test('preserves synchronous Ok and exact Err acquisitions', async () => {
    const connection: Connection = { id: 'sync' }
    const acquisitionFailure = new Error('connection failed')
    const expectedFailure = Result.err<Connection, Error>(acquisitionFailure)
    let releases = 0
    let observedOutcome: ScopeOutcome | undefined

    const ok = await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireReleaseResult(
          () => Result.ok<Connection, Error>(connection),
          (resource, outcome) => {
            expect(resource).toBe(connection)
            observedOutcome = outcome
            releases++
          }
        )

        expect(acquired).toBe(connection)
        return Result.ok(acquired)
      })
    )

    expect(Result.isOk(ok)).toBe(true)
    if (Result.isOk(ok)) {
      expect(ok.value).toBe(connection)
    }
    expect(releases).toBe(1)
    expect(observedOutcome).toEqual({ status: 'success' })

    const failed = await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireReleaseResult(
          () => expectedFailure,
          () => {
            releases++
          }
        )

        return Result.ok(acquired)
      })
    )

    expectSameResult(failed, expectedFailure)
    expect(releases).toBe(1)
  })

  test('preserves asynchronous Ok and exact Err acquisitions', async () => {
    const connection: Connection = { id: 'async' }
    const acquisitionFailure = new Error('async connection failed')
    const expectedFailure = Result.err<Connection, Error>(acquisitionFailure)
    let releases = 0

    const ok = await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireReleaseResult(
          async () => {
            await Promise.resolve()
            return Result.ok<Connection, Error>(connection)
          },
          async (resource) => {
            await Promise.resolve()
            expect(resource).toBe(connection)
            releases++
          }
        )

        return Result.ok(acquired)
      })
    )

    expect(Result.isOk(ok)).toBe(true)
    if (Result.isOk(ok)) {
      expect(ok.value).toBe(connection)
    }
    expect(releases).toBe(1)

    const failed = await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireReleaseResult(
          async () => {
            await Promise.resolve()
            return expectedFailure
          },
          () => {
            releases++
          }
        )

        return Result.ok(acquired)
      })
    )

    expectSameResult(failed, expectedFailure)
    expect(releases).toBe(1)
  })

  test('normalizes thrown and rejected acquisition defects without releasing', async () => {
    const thrownCause = new Error('sync acquisition defect')
    const rejectedCause = new Error('async acquisition defect')
    let releases = 0

    const thrown = await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireReleaseResult(
          () => {
            throw thrownCause
          },
          () => {
            releases++
          }
        )

        return Result.ok(acquired)
      })
    )

    expectUnhandled(thrown, thrownCause)

    const rejected = await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireReleaseResult(
          async () => {
            throw rejectedCause
          },
          () => {
            releases++
          }
        )

        return Result.ok(acquired)
      })
    )

    expectUnhandled(rejected, rejectedCause)
    expect(releases).toBe(0)
  })

  test('releases after a Result error, thrown program, and rejected program', async () => {
    let resultReleases = 0
    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        yield* Effect.acquireReleaseResult(
          () => Result.ok<Connection, never>({ id: 'result' }),
          () => {
            resultReleases++
          }
        )

        return Result.err<number, 'failed'>('failed')
      })
    )

    expect(Result.isError(result)).toBe(true)
    expect(resultReleases).toBe(1)

    let thrownReleases = 0
    const programFailure = new Error('program failed')
    const thrown = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireReleaseResult(
            () => Result.ok<Connection, never>({ id: 'thrown' }),
            () => {
              thrownReleases++
            }
          )

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(thrown).toBe(programFailure)
    expect(thrownReleases).toBe(1)

    let rejectedReleases = 0
    const rejection = new Error('program rejected')
    const rejected = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireReleaseResult(
            () => Result.ok<Connection, never>({ id: 'rejected' }),
            () => {
              rejectedReleases++
            }
          )

          return Result.ok(true)
        })

        return Promise.reject(rejection)
      })
    )

    expect(rejected).toBe(rejection)
    expect(rejectedReleases).toBe(1)
  })

  test('preserves a program defect over a release defect', async () => {
    const programFailure = new Error('program failed')
    const releaseFailure = new Error('release failed')

    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireReleaseResult(
            () => Result.ok<Connection, never>({ id: 'failure' }),
            () => {
              throw releaseFailure
            }
          )

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
  })

  test('releases successfully acquired values when registration races with Scope close', async () => {
    let acquisitionStarted = false
    let resolveAcquisition!: (result: ResultType<Connection, never>) => void
    const acquisition = new Promise<ResultType<Connection, never>>((resolve) => {
      resolveAcquisition = resolve
    })
    const scope = Scope.make()
    const scopeFailure = new Error('scope closed')
    let releases = 0
    let observedOutcome: ScopeOutcome | undefined

    const pending = Scope.provide(scope, () =>
      Effect.gen(async function* () {
        const connection = yield* Effect.acquireReleaseResult(
          () => {
            acquisitionStarted = true
            return acquisition
          },
          (_resource, outcome) => {
            releases++
            observedOutcome = outcome
          }
        )

        return Result.ok(connection)
      })
    )

    while (!acquisitionStarted) {
      await Promise.resolve()
    }

    const closing = scope.close({ status: 'failure', cause: scopeFailure })
    resolveAcquisition(Result.ok({ id: 'race' }))

    const result = await pending
    expect(Result.isError(result)).toBe(true)
    expect(releases).toBe(1)
    expect(observedOutcome).toEqual({ status: 'failure', cause: scopeFailure })

    if (Result.isError(result) && result.error instanceof UnhandledException) {
      expect(result.error.cause).toBeInstanceOf(ScopeClosedError)
    }

    await closing
  })

  test('preserves registration and immediate release failures in a race', async () => {
    let acquisitionStarted = false
    let resolveAcquisition!: (result: ResultType<Connection, never>) => void
    const acquisition = new Promise<ResultType<Connection, never>>((resolve) => {
      resolveAcquisition = resolve
    })
    const scope = Scope.make()
    const releaseFailure = new Error('immediate release failed')

    const pending = Scope.provide(scope, () =>
      Effect.gen(async function* () {
        const connection = yield* Effect.acquireReleaseResult(
          () => {
            acquisitionStarted = true
            return acquisition
          },
          () => {
            throw releaseFailure
          }
        )

        return Result.ok(connection)
      })
    )

    while (!acquisitionStarted) {
      await Promise.resolve()
    }

    const closing = scope.close()
    resolveAcquisition(Result.ok({ id: 'race-failure' }))

    const result = await pending
    expect(Result.isError(result)).toBe(true)

    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(UnhandledException)

      if (result.error instanceof UnhandledException) {
        expect(result.error.cause).toBeInstanceOf(AggregateError)

        if (result.error.cause instanceof AggregateError) {
          expect(result.error.cause.errors).toEqual(
            expect.arrayContaining([expect.any(ScopeClosedError), releaseFailure])
          )
        }
      }
    }

    await closing
  })
})

describe('Effect.acquireDisposable', () => {
  test('acquires lazily and preserves the exact disposable resource', async () => {
    let acquisitions = 0
    let disposals = 0
    const program = Effect.fn(async function* () {
      const resource = yield* Effect.acquireDisposable(() => {
        acquisitions++

        return {
          value: 42,
          [Symbol.dispose]() {
            disposals++
          }
        }
      })

      return Result.ok(resource)
    })

    expect(acquisitions).toBe(0)

    const runtime = await Runtime.make(Layer.merge())
    const result = await runtime.run(program)

    expect(Result.isOk(result)).toBe(true)
    expect(acquisitions).toBe(1)
    expect(disposals).toBe(1)

    await runtime.dispose()
  })

  test('prefers asynchronous disposal', async () => {
    const events: string[] = []
    const resource = {
      [Symbol.dispose]() {
        events.push('dispose')
      },
      async [Symbol.asyncDispose]() {
        await Promise.resolve()
        events.push('asyncDispose')
      }
    }

    await Scope.run(async () =>
      Effect.gen(async function* () {
        const acquired = yield* Effect.acquireDisposable(() => resource)

        expect(acquired).toBe(resource)
        return Result.ok(true)
      })
    )

    expect(events).toEqual(['asyncDispose'])
  })

  test('disposes after Result errors and preserves program failure precedence', async () => {
    let resultDisposals = 0
    const result = await Scope.run(async () =>
      Effect.gen(async function* () {
        yield* Effect.acquireDisposable(() => ({
          [Symbol.dispose]() {
            resultDisposals++
          }
        }))

        return Result.err<number, 'failed'>('failed')
      })
    )

    expect(Result.isError(result)).toBe(true)
    expect(resultDisposals).toBe(1)

    const programFailure = new Error('program failed')
    const releaseFailure = new Error('release failed')
    let defectDisposals = 0
    const error = await captureRejection(
      Scope.run(async () => {
        await Effect.gen(async function* () {
          yield* Effect.acquireDisposable(() => ({
            [Symbol.dispose]() {
              defectDisposals++
              throw releaseFailure
            }
          }))

          return Result.ok(true)
        })

        throw programFailure
      })
    )

    expect(error).toBe(programFailure)
    expect(defectDisposals).toBe(1)
  })

  test('normalizes acquisition defects and invalid runtime values', async () => {
    const acquisitionFailure = new Error('acquisition failed')
    const thrown = await Scope.run(async () =>
      Effect.gen(async function* () {
        const resource = yield* Effect.acquireDisposable(() => {
          throw acquisitionFailure
        })

        return Result.ok(resource)
      })
    )

    expectUnhandled(thrown, acquisitionFailure)

    // SAFETY: This deliberately crosses the compile-time boundary to verify runtime validation.
    const invalid = Object.create(null) as DisposableResource
    const invalidResult = await Scope.run(async () =>
      Effect.gen(async function* () {
        const resource = yield* Effect.acquireDisposable(() => invalid)

        return Result.ok(resource)
      })
    )

    expect(Result.isError(invalidResult)).toBe(true)
    if (Result.isError(invalidResult) && invalidResult.error instanceof UnhandledException) {
      expect(invalidResult.error.cause).toEqual(
        expect.objectContaining({
          name: 'ResourceNotDisposableError'
        })
      )
    }
  })
})

describe('Layer.scopedDisposable', () => {
  test('uses the disposer captured before an accessor removes the protocol', async () => {
    const events: string[] = []
    let dispose: (() => void) | undefined = () => {
      events.push('dispose')
    }
    const client = SyncDisposableClient.of({
      request: () => 'ok',
      get [Symbol.dispose](): () => void {
        return dispose!
      }
    })
    const runtime = await Runtime.make(
      Layer.scopedDisposable(SyncDisposableClient, () => client),
      new MapLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(SyncDisposableClient))
    dispose = undefined

    await runtime.dispose()

    expect(events).toEqual(['dispose'])
  })

  test('invokes an async disposer exactly once for a dual-protocol resource', async () => {
    const events: string[] = []
    const implementation = {
      request: () => 'ok',
      [Symbol.dispose]() {
        events.push('dispose')
      },
      async [Symbol.asyncDispose]() {
        events.push('asyncDispose')
      }
    }
    const client = DisposableClient.of(implementation)
    const runtime = await Runtime.make(
      Layer.scopedDisposable(DisposableClient, () => client),
      new MapLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(DisposableClient))
    await runtime.dispose()

    expect(events).toEqual(['asyncDispose'])
  })

  test('captures disposal independently for concurrent runtimes sharing a Layer', async () => {
    const events: string[] = []
    let acquisitions = 0
    const client = SyncDisposableClient.of({
      request: () => 'ok',
      get [Symbol.dispose](): () => void {
        const acquisition = ++acquisitions
        return () => {
          events.push(`dispose-${acquisition}`)
        }
      }
    })
    const layer = Layer.scopedDisposable(SyncDisposableClient, () => client)
    const [firstRuntime, secondRuntime] = await Promise.all([
      Runtime.make(layer, new MapLayerBackend()),
      Runtime.make(layer, new MapLayerBackend())
    ])

    await Promise.all([
      firstRuntime.run(() => ServiceRuntime.resolve(SyncDisposableClient)),
      secondRuntime.run(() => ServiceRuntime.resolve(SyncDisposableClient))
    ])

    await secondRuntime.dispose()
    await firstRuntime.dispose()

    expect(events).toEqual(['dispose-2', 'dispose-1'])
  })

  test('keeps a disposable Layer resource until root and disposes before backend cleanup', async () => {
    const events: string[] = []
    const client = DisposableClient.of({
      request: () => 'ok',
      async [Symbol.asyncDispose]() {
        events.push('asyncDispose')
      }
    })
    let acquisitions = 0
    const layer = Layer.scopedDisposable(DisposableClient, async () => {
      acquisitions++
      return client
    })
    const runtime = await Runtime.make(layer, new RecordingBackend(events))

    expect(acquisitions).toBe(0)

    const first = await runtime.run(() => ServiceRuntime.resolve(DisposableClient))
    const second = await runtime.run(() => ServiceRuntime.resolve(DisposableClient))

    expect(first).toBe(client)
    expect(second).toBe(client)
    expect(acquisitions).toBe(1)
    expect(events).toEqual([])

    await runtime.dispose()

    expect(events).toEqual(['asyncDispose', 'backend'])
  })

  test('reports disposal failures as root cleanup and still disposes the backend', async () => {
    const events: string[] = []
    const releaseFailure = new Error('client close failed')
    let disposals = 0
    const client = {
      request: () => 'ok',
      async [Symbol.asyncDispose]() {
        disposals++
        throw releaseFailure
      }
    }
    const runtime = await Runtime.make(
      Layer.scopedDisposable(DisposableClient, () => client),
      new RecordingBackend(events)
    )

    await runtime.run(() => ServiceRuntime.resolve(DisposableClient))

    const error = await captureRejection(runtime.dispose())

    expect(error).toBeInstanceOf(LayerDisposeError)
    expect(disposals).toBe(1)
    expect(events).toEqual(['backend'])

    if (error instanceof LayerDisposeError) {
      expect(error.causes).toHaveLength(1)
      expect(error.causes[0]).toBeInstanceOf(ScopeCloseError)
    }
  })

  test('rejects an unchecked non-disposable provider with the focused disposal error', async () => {
    // SAFETY: This deliberately crosses the compile-time boundary to verify runtime validation.
    const invalid = Object.create(null) as {
      request: () => string
      [Symbol.asyncDispose]: () => Promise<void>
    }
    const runtime = await Runtime.make(
      Layer.scopedDisposable(DisposableClient, () => invalid),
      new MapLayerBackend()
    )

    const error = await captureRejection(
      runtime.run(() => ServiceRuntime.resolve(DisposableClient))
    )

    expect(error).toBeInstanceOf(ServiceAcquisitionError)

    if (error instanceof ServiceAcquisitionError) {
      expect(error.cause).toMatchObject({ name: 'ResourceNotDisposableError' })
    }

    await runtime.dispose()
  })
})
