import { Result } from 'better-result'

import { describe, expect, test } from 'bun:test'

import { Effect, Layer, Runtime, Scope, Service, type ScopeOutcome } from '../src'
import { RecordedRuntimeObserver } from '../src/testing'

class LifecycleConfig extends Service<LifecycleConfig>()('LifecycleConfig') {
  constructor(readonly intervalMs: number) {
    super()
  }
}

describe('Layer lifecycle-only entries', () => {
  test('acquires at Runtime.make and releases with the Runtime root outcome', async () => {
    const acquired: string[] = []
    const released: ScopeOutcome[] = []
    const layer = Layer.scopedDiscard(
      () => {
        acquired.push('acquire')
        return { stop: () => {} }
      },
      (_resource, outcome) => {
        released.push(outcome)
      }
    )

    expect(acquired).toEqual([])

    const runtime = await Runtime.make(layer)

    expect(acquired).toEqual(['acquire'])
    expect(runtime.inspect().services).toEqual([])

    await runtime.dispose()

    expect(released).toEqual([{ status: 'success' }])
  })

  test('resolves contextual Services after warmup and keeps lifecycle entries out of the environment', async () => {
    const events: string[] = []
    const config = Layer.make(LifecycleConfig, () => {
      events.push('provider')
      return new LifecycleConfig(250)
    })
    const lifecycle = Layer.scopedDiscard(
      async function* () {
        const current = yield* LifecycleConfig
        events.push(`lifecycle:${current.intervalMs}`)

        return { stop: () => {} }
      },
      () => {
        events.push('release')
      }
    )

    const runtime = await Runtime.make(Layer.merge(config, lifecycle), { warmup: true })

    expect(events).toEqual(['provider', 'lifecycle:250'])
    expect(runtime.inspect().services).toEqual([LifecycleConfig.serviceTag])

    await runtime.dispose()

    expect(events).toEqual(['provider', 'lifecycle:250', 'release'])
  })

  test('releases multiple entries in reverse activation order', async () => {
    const releases: string[] = []
    const first = Layer.scopedDiscard(
      () => 'first',
      (_resource, _outcome) => {
        releases.push('first')
      }
    )
    const second = Layer.scopedDiscard(
      () => 'second',
      (_resource, _outcome) => {
        releases.push('second')
      }
    )

    const runtime = await Runtime.make(Layer.merge(first, second))

    await runtime.dispose()

    expect(releases).toEqual(['second', 'first'])
  })

  test('rolls back earlier entries when activation fails', async () => {
    const activationFailure = new Error('activation failed')
    const releases: string[] = []
    const first = Layer.scopedDiscard(
      () => 'first',
      () => {
        releases.push('first')
      }
    )
    const second = Layer.scopedDiscard(
      () => {
        throw activationFailure
      },
      () => {
        releases.push('second')
      }
    )

    const failure = await Runtime.make(Layer.merge(first, second)).then(
      () => undefined,
      (cause) => cause
    )

    expect(failure).toBe(activationFailure)
    expect(releases).toEqual(['first'])
  })

  test('captures the root Runtime executor during lifecycle activation', async () => {
    let captured!: Runtime.Executor<never>
    const layer = Layer.scopedDiscard(
      async function* () {
        captured = yield* Runtime.executor<never>()
        return undefined
      },
      () => {}
    )

    const runtime = await Runtime.make(layer)

    expect(captured).toBe(runtime.executor)
    const result = await captured.run(() => Result.ok('from executor'))

    expect(result).toEqual(Result.ok('from executor'))
    await runtime.dispose()
  })

  test('runs direct lifecycle acquisition with the root Scope in context', async () => {
    let observedScope!: Scope
    const lifecycle = Layer.scopedDiscard(
      () => {
        observedScope = Scope.current()
        return undefined
      },
      () => {}
    )

    const runtime = await Runtime.make(lifecycle)

    expect(observedScope).toBeDefined()
    await runtime.dispose()
  })

  test('runs a no-failure Effect program as a lifecycle entry', async () => {
    const events: string[] = []
    // oxlint-disable-next-line require-yield -- Effect.fn accepts a generator-shaped async body.
    const program = Effect.fn(async function* () {
      events.push('program')
      return Result.ok(undefined)
    })

    const runtime = await Runtime.make(Layer.effectDiscard(program))

    expect(events).toEqual(['program'])
    await runtime.dispose()
  })

  test('reports lifecycle activation and release through the observer', async () => {
    const observer = RecordedRuntimeObserver.make()
    const lifecycle = Layer.scopedDiscard(
      () => ({ stop: () => {} }),
      () => {}
    )

    const runtime = await Runtime.make(lifecycle, { observers: [observer] })

    expect(observer.lifecycleStarts).toHaveLength(1)
    expect(observer.lifecycleEnds).toHaveLength(1)
    expect(observer.lifecycleEnds[0]?.outcome).toEqual({ status: 'success' })

    await runtime.dispose()

    expect(observer.lifecycleReleases).toHaveLength(1)
    expect(observer.lifecycleReleases[0]?.outcome).toEqual({ status: 'success' })
  })
})
