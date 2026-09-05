import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import {
  CurrentAbortSignal,
  Effect,
  Layer,
  Program,
  Runtime,
  RuntimeExecutorNotConfiguredError,
  Scope,
  Service,
  ServiceRuntime,
  type RuntimeExecutor
} from '../src'
import { ExplicitRuntimeContextStorage } from '../src/runtime/explicit'

class RootService extends Service<RootService>()('runtime.executor.root') {
  constructor(readonly label: string) {
    super()
  }
}

class RequestService extends Service<RequestService>()('runtime.executor.request') {
  constructor(readonly label: string) {
    super()
  }
}

class CapturedService extends Service<CapturedService>()('runtime.executor.captured') {
  constructor(readonly executor: RuntimeExecutor<RootService>) {
    super()
  }
}

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

const rootLayer = (label: string) => Layer.succeed(RootService, new RootService(label))

const captureExecutor = () =>
  Effect.fn(async function* () {
    const executor = yield* Runtime.executor<RootService>()

    return Result.ok(executor)
  })

describe('Runtime.Executor', () => {
  test('fails explicitly when captured without a Runtime context', async () => {
    const failure = await Runtime.executor<RootService>()
      [Symbol.asyncIterator]()
      .next()
      .then(
        () => undefined,
        (cause) => cause
      )

    expect(failure).toBeInstanceOf(RuntimeExecutorNotConfiguredError)
  })

  test('captures the stable root executor view and runs after the capture lineage settles', async () => {
    const runtime = await Runtime.make(rootLayer('root'))

    try {
      const executor = Result.unwrap(await runtime.run(captureExecutor()))

      expect(executor).toBe(runtime.executor)

      const root = Result.unwrap(
        await executor.run(
          Effect.fn(async function* () {
            const service = yield* RootService

            return Result.ok(service)
          })
        )
      )

      expect(root).toBeInstanceOf(RootService)
      expect(root.label).toBe('root')
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps executors from separate Runtime roots isolated', async () => {
    const first = await Runtime.make(rootLayer('first'))
    const second = await Runtime.make(rootLayer('second'))

    try {
      const firstExecutor = Result.unwrap(await first.run(captureExecutor()))
      const secondExecutor = Result.unwrap(await second.run(captureExecutor()))
      const [firstRoot, secondRoot] = await Promise.all([
        firstExecutor.run(() => ServiceRuntime.resolve(RootService)),
        secondExecutor.run(() => ServiceRuntime.resolve(RootService))
      ])

      expect(firstRoot.label).toBe('first')
      expect(secondRoot.label).toBe('second')
    } finally {
      await Promise.all([first.dispose(), second.dispose()])
    }
  })

  test('opens a fresh child Scope and closes its finalizers before resolving', async () => {
    const runtime = await Runtime.make(rootLayer('root'))
    const cleaned: string[] = []
    const firstScope = deferred()

    try {
      const executor = Result.unwrap(await runtime.run(captureExecutor()))
      const value = await executor.run(
        Effect.fn(async function* () {
          const scope = yield* Scope
          scope.addFinalizer(() => {
            cleaned.push('child')
            firstScope.resolve()
          })

          return Result.ok(scope)
        })
      )

      expect(value).toBeInstanceOf(Object)
      expect(cleaned).toEqual(['child'])
      await firstScope.promise
      expect(runtime.inspect().activeExecutions).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('runWith provides and releases a request Layer while retaining root Services', async () => {
    let releases = 0
    const runtime = await Runtime.make(rootLayer('root'))

    try {
      const executor = Result.unwrap(await runtime.run(captureExecutor()))
      const result = Result.unwrap(
        await executor.runWith(
          Layer.scoped(
            RequestService,
            () => new RequestService('request'),
            () => {
              releases++
            }
          ),
          Effect.fn(async function* () {
            const root = yield* RootService
            const request = yield* RequestService

            return Result.ok(`${root.label}:${request.label}`)
          })
        )
      )

      expect(result).toBe('root:request')
      expect(releases).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('does not capture request-local Services from the capture execution', async () => {
    const runtime = await Runtime.make(rootLayer('root'))

    try {
      const executor = Result.unwrap(
        await runtime.runWith(
          Layer.succeed(RequestService, new RequestService('request')),
          Effect.fn(async function* () {
            return Result.ok(yield* Runtime.executor<RootService>())
          })
        )
      )

      const failure = await executor
        .run(() => ServiceRuntime.resolve(RequestService))
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain('runtime.executor.request')
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves execution metadata and observer events', async () => {
    const started = deferred()
    const release = deferred()
    const starts: string[] = []
    const ends: string[] = []
    const attributes: unknown[] = []
    const runtime = await Runtime.make(rootLayer('root'), {
      observers: [
        {
          onExecutionStart: (event) => {
            starts.push(event.name ?? 'missing')
            attributes.push(event.attributes)
          },
          onExecutionEnd: (event) => {
            ends.push(event.name ?? 'missing')
          }
        }
      ]
    })

    try {
      const executor = Result.unwrap(await runtime.run(captureExecutor()))
      const running = executor.run(
        Program.named(
          'runtime.executor.named',
          Effect.fn(async function* () {
            yield* []
            started.resolve()
            await release.promise

            return Result.ok(true)
          })
        ),
        { attributes: { source: 'executor' } }
      )

      await started.promise
      expect(runtime.inspect().executions).toHaveLength(1)
      expect(runtime.inspect().executions[0]?.name).toBe('runtime.executor.named')
      release.resolve()
      await running

      expect(starts).toEqual(['missing', 'runtime.executor.named'])
      expect(ends).toEqual(['missing', 'runtime.executor.named'])
      expect(attributes).toEqual([undefined, { source: 'executor' }])
    } finally {
      await runtime.dispose()
    }
  })

  test('can be captured while a Layer.gen provider is acquired', async () => {
    const runtime = await Runtime.make(
      Layer.merge(
        rootLayer('root'),
        Layer.gen(CapturedService, async function* () {
          const executor = yield* Runtime.executor<RootService>()

          return new CapturedService(executor)
        })
      ),
      { warmup: true }
    )

    try {
      const captured = await runtime.run(() => ServiceRuntime.resolve(CapturedService))
      const root = await captured.executor.run(() => ServiceRuntime.resolve(RootService))

      expect(Object.is(captured.executor, runtime.executor)).toBe(true)
      expect(root.label).toBe('root')
    } finally {
      await runtime.dispose()
    }
  })

  test('can be captured while a Layer.scopedGen provider is acquired', async () => {
    let releases = 0
    const runtime = await Runtime.make(
      Layer.merge(
        rootLayer('root'),
        Layer.scopedGen(
          CapturedService,
          async function* () {
            const executor = yield* Runtime.executor<RootService>()

            return new CapturedService(executor)
          },
          () => {
            releases++
          }
        )
      ),
      { warmup: true }
    )

    try {
      const captured = await runtime.run(() => ServiceRuntime.resolve(CapturedService))
      const root = await captured.executor.run(() => ServiceRuntime.resolve(RootService))

      expect(root.label).toBe('root')
    } finally {
      await runtime.dispose()
    }

    expect(releases).toBe(1)
  })

  test('preserves the root executor through explicit context storage', async () => {
    const runtime = await Runtime.make(rootLayer('explicit'), {
      contextStorage: new ExplicitRuntimeContextStorage()
    })

    try {
      const executor = Result.unwrap(await runtime.run(captureExecutor()))
      const root = await executor.run(() => ServiceRuntime.resolve(RootService))

      expect(root.label).toBe('explicit')
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves linked Runtime signals and Result/defect outcomes', async () => {
    const runtimeSignal = new AbortController()
    const cleanupOutcomes: string[] = []
    const runtime = await Runtime.make(
      Layer.scoped(
        RootService,
        () => new RootService('root'),
        (root, outcome) => {
          cleanupOutcomes.push(`${root.label}:${outcome.status}`)
        }
      ),
      { signal: runtimeSignal.signal }
    )

    try {
      const executor = Result.unwrap(await runtime.run(captureExecutor()))
      await executor.run(() => ServiceRuntime.resolve(RootService))
      const failed = await executor.run(() => Result.err('executor failure'))

      expect(failed.isErr()).toBe(true)
      runtimeSignal.abort()

      const signalResult = Result.unwrap(
        await executor.run(
          Effect.fn(async function* () {
            const signal = yield* CurrentAbortSignal

            return Result.ok(signal.aborted)
          })
        )
      )

      expect(signalResult).toBe(true)

      const defect = new Error('executor defect')
      const defectCause = await executor
        .run(() => {
          throw defect
        })
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(defectCause).toBe(defect)
    } finally {
      await runtime.dispose()
    }

    expect(cleanupOutcomes).toEqual(['root:success'])
  })

  test('rejects new executions after Runtime disposal begins', async () => {
    const runtime = await Runtime.make(rootLayer('root'))
    const executor = Result.unwrap(await runtime.run(captureExecutor()))

    await runtime.dispose()

    expect(() => executor.run(() => Result.ok(true))).toThrow('disposed Layer')
  })
})
