import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import { BuiltLayerDisposedError, Layer, buildLayer, type LayerBackend } from '../src/layer'
import { Scope, ScopeCloseError } from '../src/scope'

import type { LayerProvider } from '../src/layer/types'

import {
  Service,
  ServiceRuntime,
  ServiceRuntimeNotConfiguredError,
  type AnyServiceToken
} from '../src/service'

class ExampleService extends Service<ExampleService>() {
  value(): number {
    return 42
  }
}

class MemoryLayerBackend implements LayerBackend {
  readonly providers = new Map<AnyServiceToken, LayerProvider>()

  readonly instances = new Map<AnyServiceToken, unknown>()

  disposed = false

  onDispose: (() => void) | undefined

  register(provider: LayerProvider): void {
    this.providers.set(provider.service, provider)
  }

  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    if (this.instances.has(token)) {
      return this.instances.get(token) as InstanceType<T>
    }

    const provider = this.providers.get(token)

    if (!provider) {
      throw new Error(`Missing service: ${token.name}`)
    }

    const instance = await provider.acquire()

    this.instances.set(token, instance)

    return instance as InstanceType<T>
  }

  async disposeAll(): Promise<void> {
    this.onDispose?.()

    this.instances.clear()

    this.disposed = true
  }
}

describe('buildLayer', () => {
  test('registers every provider in the backend', async () => {
    const layer = Layer.make(ExampleService, () => new ExampleService())

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(layer, backend)

    try {
      expect(backend.providers.has(ExampleService)).toBe(true)

      expect(backend.instances.size).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('does not acquire services while building the layer', async () => {
    let acquired = 0

    const layer = Layer.make(ExampleService, () => {
      acquired++

      return new ExampleService()
    })

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(layer, backend)

    try {
      expect(acquired).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('provides the backend inside runtime.run', async () => {
    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      backend
    )

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const service = yield* ExampleService

          return Result.ok(service.value())
        })
      )

      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value).toBe(42)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('caches instances according to backend behavior', async () => {
    let acquired = 0

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => {
        acquired++

        return new ExampleService()
      }),
      backend
    )

    try {
      const { first, second } = await runtime.run(async () => {
        const first = await ServiceRuntime.resolve(ExampleService)

        const second = await ServiceRuntime.resolve(ExampleService)

        return {
          first,
          second
        }
      })

      expect(first).toBe(second)

      expect(acquired).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('releases acquired scoped services', async () => {
    let released = 0

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          released++
        }
      ),
      backend
    )

    await runtime.run(() => ServiceRuntime.resolve(ExampleService))

    expect(released).toBe(0)

    await runtime.dispose()

    expect(released).toBe(1)
  })

  test('does not release services that were never acquired', async () => {
    let released = 0

    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          released++
        }
      ),
      backend
    )

    await runtime.dispose()

    expect(released).toBe(0)
  })

  test('closes the execution scope after runtime.run', async () => {
    let released = 0

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      await runtime.run(async () => {
        await Scope.current().acquire(
          () => ({ value: 42 }),
          () => {
            released++
          }
        )

        expect(released).toBe(0)
      })

      expect(released).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('closes the execution scope after a failed runtime.run', async () => {
    let released = 0
    const failure = new Error('program failed')

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const error = await runtime
        .run(async () => {
          await Scope.current().acquire(
            () => ({ value: 42 }),
            () => {
              released++
            }
          )

          throw failure
        })
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(error).toBe(failure)
      expect(released).toBe(1)
    } finally {
      await runtime.dispose()
    }
  })

  test('preserves program and execution cleanup failures', async () => {
    const programFailure = new Error('program failed')
    const cleanupFailure = new Error('cleanup failed')

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const error = await runtime
        .run(async () => {
          Scope.current().addFinalizer(() => {
            throw cleanupFailure
          })

          throw programFailure
        })
        .then(
          () => undefined,
          (cause) => cause
        )

      expect(error).toBeInstanceOf(AggregateError)

      if (error instanceof AggregateError) {
        expect(error.errors[0]).toBe(programFailure)
        expect(error.errors[1]).toBeInstanceOf(ScopeCloseError)
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps Layer.scoped resources alive between executions', async () => {
    let released = 0

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          released++
        }
      ),
      new MemoryLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(ExampleService))
    await runtime.run(() => ServiceRuntime.resolve(ExampleService))

    expect(released).toBe(0)

    await runtime.dispose()

    expect(released).toBe(1)
  })

  test('runs Layer provider factories in the root scope', async () => {
    let nestedResourceReleased = 0

    class ScopedFactoryService extends Service<ScopedFactoryService>() {}

    const runtime = await buildLayer(
      Layer.make(ScopedFactoryService, async () => {
        await Scope.current().acquire(
          () => ({ value: true }),
          () => {
            nestedResourceReleased++
          }
        )

        return new ScopedFactoryService()
      }),
      new MemoryLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(ScopedFactoryService))

    expect(nestedResourceReleased).toBe(0)

    await runtime.dispose()

    expect(nestedResourceReleased).toBe(1)
  })

  test('isolates execution scopes between concurrent runs', async () => {
    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const [first, second] = await Promise.all([
        runtime.run(async () => {
          const scope = Scope.current()
          await Promise.resolve()
          return scope
        }),
        runtime.run(async () => {
          const scope = Scope.current()
          await Promise.resolve()
          return scope
        })
      ])

      expect(first).not.toBe(second)
    } finally {
      await runtime.dispose()
    }
  })

  test('isolates execution scopes between concurrent runtimes', async () => {
    const runtimeA = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    const runtimeB = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const [scopeA, scopeB] = await Promise.all([
        runtimeA.run(async () => {
          await Promise.resolve()

          return Scope.current()
        }),
        runtimeB.run(async () => {
          await Promise.resolve()

          return Scope.current()
        })
      ])

      expect(scopeA).not.toBe(scopeB)
    } finally {
      await Promise.all([runtimeA.dispose(), runtimeB.dispose()])
    }
  })

  test('does not expose the resolver outside runtime.run', async () => {
    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      expect(ServiceRuntime.resolve(ExampleService)).rejects.toBeInstanceOf(
        ServiceRuntimeNotConfiguredError
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('does not leak the resolver after runtime.run completes', async () => {
    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const service = await runtime.run(() => ServiceRuntime.resolve(ExampleService))

      expect(service).toBeInstanceOf(ExampleService)

      expect(ServiceRuntime.resolve(ExampleService)).rejects.toBeInstanceOf(
        ServiceRuntimeNotConfiguredError
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('does not allow programs to run after dispose', async () => {
    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    await runtime.dispose()

    expect(() => runtime.run(() => ServiceRuntime.resolve(ExampleService))).toThrow(
      BuiltLayerDisposedError
    )
  })

  test('disposes the backend', async () => {
    const backend = new MemoryLayerBackend()

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      backend
    )

    expect(backend.disposed).toBe(false)

    await runtime.dispose()

    expect(backend.disposed).toBe(true)
  })

  test('waits for active executions before disposing root resources', async () => {
    let releaseExecution!: () => void
    let executionStarted!: () => void
    let released = 0

    const started = new Promise<void>((resolve) => {
      executionStarted = resolve
    })

    const executionMayFinish = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          released++
        }
      ),
      new MemoryLayerBackend()
    )

    const execution = runtime.run(async () => {
      await ServiceRuntime.resolve(ExampleService)
      executionStarted()
      await executionMayFinish
    })

    await started

    const disposal = runtime.dispose()

    expect(released).toBe(0)
    expect(() => runtime.run(() => undefined)).toThrow(BuiltLayerDisposedError)

    releaseExecution()
    await execution
    await disposal

    expect(released).toBe(1)
  })

  test('does not close an execution scope before a re-entrant disposal settles', async () => {
    let releaseGate!: () => void
    let disposal!: Promise<void>
    let released = 0

    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })

    const runtime = await buildLayer(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const execution = runtime.run(async () => {
        const scope = Scope.current()

        scope.addFinalizer(() => {
          released++
        })

        disposal = runtime.dispose()

        expect(released).toBe(0)

        await gate

        expect(released).toBe(0)
      })

      await Promise.resolve()
      expect(released).toBe(0)

      releaseGate()

      await execution
      await disposal

      expect(released).toBe(1)
    } finally {
      releaseGate()
      await runtime.dispose()
    }
  })

  test('runs root finalizers before backend cleanup', async () => {
    const events: string[] = []
    const backend = new MemoryLayerBackend()

    backend.onDispose = () => {
      events.push('backend')
    }

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          events.push('layer')
        }
      ),
      backend
    )

    await runtime.run(() => ServiceRuntime.resolve(ExampleService))
    await runtime.dispose()

    expect(events).toEqual(['layer', 'backend'])
  })

  test('shares concurrent disposal requests', async () => {
    let released = 0

    const runtime = await buildLayer(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          released++
        }
      ),
      new MemoryLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(ExampleService))

    const first = runtime.dispose()
    const second = runtime.dispose()

    expect(first).toBe(second)

    await Promise.all([first, second])

    expect(released).toBe(1)
  })
})
