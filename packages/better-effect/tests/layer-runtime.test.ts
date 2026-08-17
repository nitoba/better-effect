import { describe, expect, test } from 'bun:test'

import { Result } from 'better-result'

import { Effect } from '../src/effect'
import {
  Layer,
  LayerDisposeError,
  LayerRegistrationError,
  ServiceTagCollisionError,
  type LayerBackend
} from '../src/layer'
import { createRuntimeHandle } from '../src/layer/runtime'
import { Runtime } from '../src/runtime'
import { Scope, ScopeCloseError } from '../src/scope'

import type { CleanupFailureDiagnostic, ScopeOutcome } from '../src/scope'

import type { RuntimeShutdownDiagnostic } from '../src/runtime'

import type { LayerRegistration } from '../src/layer/types'

import {
  Service,
  ServiceRuntime,
  ServiceRuntimeNotConfiguredError,
  type AnyServiceToken
} from '../src/service'

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (cause) => cause
  )

class ExampleService extends Service<ExampleService>()('ExampleService') {
  value(): number {
    return 42
  }
}

class DefaultService extends Service<DefaultService>()('DefaultService') {
  static constructed = 0

  readonly value = 42

  constructor() {
    super()
    DefaultService.constructed++
  }
}

class ConfiguredService extends Service<ConfiguredService>()('ConfiguredService') {
  constructor(readonly value: number) {
    super()
  }
}

class ScopedDependency extends Service<ScopedDependency>()('ScopedDependency') {
  readonly value = 'dependency'
}

class ScopedConsumer extends Service<ScopedConsumer>()('ScopedConsumer') {
  constructor(readonly dependency: ScopedDependency) {
    super()
  }
}

class RuntimeDatabase extends Service<RuntimeDatabase>()('RuntimeDatabase') {
  query(): string {
    return 'primary'
  }
}

class RuntimeDatabaseOverride extends Service<RuntimeDatabaseOverride>()('RuntimeDatabase') {
  query(): string {
    return 'override'
  }
}

class RegisteredDatabase extends Service<RegisteredDatabase>()('RegisteredDatabase') {
  query(): string {
    return 'registered'
  }
}

class RegisteredRepository extends Service<RegisteredRepository>()('RegisteredRepository') {
  load() {
    return Effect.gen(async function* () {
      const database = yield* RegisteredDatabase

      return Result.ok(database.query())
    })
  }
}

class MemoryLayerBackend implements LayerBackend {
  readonly providers = new Map<string, LayerRegistration>()

  readonly instances = new Map<string, unknown>()

  readonly resolvedTokens: AnyServiceToken[] = []

  disposed = false

  onDispose: (() => void) | undefined

  registerFailure: Error | undefined

  registerFailureAfterFirst: Error | undefined

  acquireBeforeRegistrationFailure = false

  disposeFailure: Error | undefined

  register(provider: LayerRegistration): void | PromiseLike<void> {
    if (this.registerFailure !== undefined) {
      throw this.registerFailure
    }

    if (this.registerFailureAfterFirst !== undefined && this.providers.size > 0) {
      if (this.acquireBeforeRegistrationFailure) {
        const first = this.providers.values().next().value

        if (first) {
          return this.resolve(first.service).then(() => {
            throw this.registerFailureAfterFirst
          })
        }
      }

      throw this.registerFailureAfterFirst
    }

    const existing = this.providers.get(provider.service.serviceTag)

    if (existing && existing.service !== provider.service) {
      throw new ServiceTagCollisionError(existing.service, provider.service)
    }

    this.providers.set(provider.service.serviceTag, provider)
  }

  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    this.resolvedTokens.push(token)

    const tag = token.serviceTag

    if (this.instances.has(tag)) {
      return this.instances.get(tag) as InstanceType<T>
    }

    const provider = this.providers.get(tag)

    if (!provider) {
      throw new Error(`Missing service: ${token.serviceTag}`)
    }

    const instance = await provider.acquire()

    this.instances.set(tag, instance)

    return instance as InstanceType<T>
  }

  async disposeAll(): Promise<void> {
    this.onDispose?.()

    this.instances.clear()

    this.disposed = true

    if (this.disposeFailure !== undefined) {
      throw this.disposeFailure
    }
  }
}

describe('createRuntimeHandle', () => {
  test('uses the default constructor lazily when acquire is omitted', async () => {
    DefaultService.constructed = 0

    const layer = Layer.make(DefaultService)

    expect(DefaultService.constructed).toBe(0)

    const provider = layer.providers[0]
    const instance = await provider!.acquire()

    expect(DefaultService.constructed).toBe(1)
    expect(instance).toBeInstanceOf(DefaultService)
    expect((instance as DefaultService).value).toBe(42)
  })

  test('continues accepting an explicit acquire callback', async () => {
    const layer = Layer.make(ConfiguredService, () => new ConfiguredService(42))

    const provider = layer.providers[0]
    const instance = await provider!.acquire()

    expect(instance).toBeInstanceOf(ConfiguredService)
    expect((instance as ConfiguredService).value).toBe(42)
  })

  test('registers every provider in the backend', async () => {
    const layer = Layer.make(ExampleService, () => new ExampleService())

    const backend = new MemoryLayerBackend()

    const runtime = await createRuntimeHandle(layer, backend)

    try {
      expect(backend.providers.has(ExampleService.serviceTag)).toBe(true)

      expect(backend.instances.size).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('registers exact constructors while keeping provenance declaration-only', async () => {
    const layer = Layer.merge(
      Layer.make(RegisteredDatabase),
      Layer.gen(RegisteredRepository, async function* () {
        const database = yield* RegisteredDatabase

        void database

        return new RegisteredRepository()
      })
    )
    const backend = new MemoryLayerBackend()
    const runtime = await createRuntimeHandle(layer, backend)

    try {
      expect([...backend.providers.values()].map((provider) => provider.service)).toEqual([
        RegisteredDatabase,
        RegisteredRepository
      ])
      expect(Object.getOwnPropertySymbols(layer)).toEqual([])

      const instances = await runtime.run(async () => ({
        database: await backend.resolve(RegisteredDatabase),
        repository: await backend.resolve(RegisteredRepository)
      }))

      expect(Object.getOwnPropertySymbols(Object(instances.database))).toEqual([])
      expect(Object.getOwnPropertySymbols(Object(instances.repository))).toEqual([])
      expect(Object.getOwnPropertyNames(instances.database)).not.toContain('LayerProvenanceTypeId')
      expect(Object.getOwnPropertyNames(instances.repository)).not.toContain(
        'LayerProvenanceTypeId'
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps constructor tokens at runtime without emitting instance identity metadata', async () => {
    const layer = Layer.override(
      Layer.make(RuntimeDatabase, () => new RuntimeDatabase()),
      Layer.make(RuntimeDatabaseOverride, () => new RuntimeDatabaseOverride())
    )
    const backend = new MemoryLayerBackend()
    const runtime = await createRuntimeHandle(layer, backend)

    try {
      expect(backend.providers.get(RuntimeDatabase.serviceTag)?.service).toBe(
        RuntimeDatabaseOverride
      )

      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const database = yield* RuntimeDatabase

          return Result.ok(database)
        })
      )

      expect(backend.resolvedTokens).toContain(RuntimeDatabase)
      expect(Result.isOk(result)).toBe(true)

      if (Result.isOk(result)) {
        expect(result.value.query()).toBe('override')
        expect(Object.getOwnPropertySymbols(result.value)).toEqual([])
        expect(Object.getOwnPropertyNames(result.value)).not.toContain('ServiceIdentityTypeId')
      }

      expect(Object.getOwnPropertySymbols(RuntimeDatabaseOverride.prototype)).toEqual([])
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

    const runtime = await createRuntimeHandle(layer, backend)

    try {
      expect(acquired).toBe(0)
    } finally {
      await runtime.dispose()
    }
  })

  test('provides the backend inside runtime.run', async () => {
    const backend = new MemoryLayerBackend()

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

  test('acquires scoped generators lazily and caches their instances', async () => {
    let factoryRuns = 0
    let releases = 0
    let releaseOutcome: ScopeOutcome | undefined

    const runtime = await createRuntimeHandle(
      Layer.merge(
        Layer.make(ScopedDependency, () => new ScopedDependency()),
        Layer.scopedGen(
          ScopedConsumer,
          async function* () {
            factoryRuns++

            const dependency = yield* ScopedDependency

            return new ScopedConsumer(dependency)
          },
          (_consumer, outcome) => {
            releases++
            releaseOutcome = outcome
          }
        )
      ),
      new MemoryLayerBackend()
    )

    try {
      expect(factoryRuns).toBe(0)

      const first = await runtime.run(() => ServiceRuntime.resolve(ScopedConsumer))
      const second = await runtime.run(() => ServiceRuntime.resolve(ScopedConsumer))

      expect(first).toBe(second)
      expect(first.dependency.value).toBe('dependency')
      expect(factoryRuns).toBe(1)
      expect(releases).toBe(0)
    } finally {
      await runtime.dispose()
    }

    expect(releases).toBe(1)
    expect(releaseOutcome).toEqual({ status: 'success' })
  })

  test('does not release a scoped generator after failed acquisition', async () => {
    const acquisitionFailure = new Error('scoped generator acquisition failed')
    let releases = 0

    const runtime = await createRuntimeHandle(
      Layer.scopedGen(
        ExampleService,
        // oxlint-disable-next-line require-yield
        async function* () {
          return await Promise.reject<ExampleService>(acquisitionFailure)
        },
        () => {
          releases++
        }
      ),
      new MemoryLayerBackend()
    )

    const error = await captureRejection(runtime.run(() => ServiceRuntime.resolve(ExampleService)))

    expect(error).toBe(acquisitionFailure)
    expect(releases).toBe(0)

    await runtime.dispose()
  })

  test('passes root outcomes to long-lived and one-shot scoped generators', async () => {
    let longLivedOutcome: ScopeOutcome | undefined
    const longLived = await createRuntimeHandle(
      Layer.scopedGen(
        ExampleService,
        // oxlint-disable-next-line require-yield
        async function* () {
          return new ExampleService()
        },
        (_service, outcome) => {
          longLivedOutcome = outcome
        }
      ),
      new MemoryLayerBackend()
    )

    await longLived.run(() => ServiceRuntime.resolve(ExampleService))
    await longLived.run(() => Result.err(new Error('execution failed')))
    await longLived.dispose()

    expect(longLivedOutcome).toEqual({ status: 'success' })

    let oneShotOutcome: ScopeOutcome | undefined
    const programFailure = new Error('program failed')
    const expected = Result.err(programFailure)

    const result = await Runtime.run(
      Layer.scopedGen(
        ExampleService,
        // oxlint-disable-next-line require-yield
        async function* () {
          return new ExampleService()
        },
        (_service, outcome) => {
          oneShotOutcome = outcome
        }
      ),
      new MemoryLayerBackend(),
      async () => {
        await ServiceRuntime.resolve(ExampleService)

        return expected
      }
    )

    expect(result).toBe(expected)
    expect(oneShotOutcome).toEqual({ status: 'failure', cause: programFailure })
  })

  test('releases dependent scoped generators in LIFO order', async () => {
    const events: string[] = []
    const runtime = await createRuntimeHandle(
      Layer.merge(
        Layer.scopedGen(
          ScopedDependency,
          // oxlint-disable-next-line require-yield
          async function* () {
            return new ScopedDependency()
          },
          () => {
            events.push('dependency')
          }
        ),
        Layer.scopedGen(
          ScopedConsumer,
          async function* () {
            const dependency = yield* ScopedDependency

            return new ScopedConsumer(dependency)
          },
          () => {
            events.push('consumer')
          }
        )
      ),
      new MemoryLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(ScopedConsumer))
    await runtime.dispose()

    expect(events).toEqual(['consumer', 'dependency'])
  })

  test('aggregates scoped generator release failures with backend cleanup', async () => {
    const consumerFailure = new Error('consumer release failed')
    const dependencyFailure = new Error('dependency release failed')
    const backendFailure = new Error('backend dispose failed')
    const events: string[] = []
    const diagnostics: RuntimeShutdownDiagnostic[] = []
    const backend = new MemoryLayerBackend()
    backend.disposeFailure = backendFailure
    backend.onDispose = () => {
      events.push('backend')
    }

    const runtime = await createRuntimeHandle(
      Layer.merge(
        Layer.scopedGen(
          ScopedDependency,
          // oxlint-disable-next-line require-yield
          async function* () {
            return new ScopedDependency()
          },
          () => {
            events.push('dependency')
            throw dependencyFailure
          }
        ),
        Layer.scopedGen(
          ScopedConsumer,
          async function* () {
            const dependency = yield* ScopedDependency

            return new ScopedConsumer(dependency)
          },
          () => {
            events.push('consumer')
            throw consumerFailure
          }
        )
      ),
      backend,
      {
        onCleanupFailure: (diagnostic) => {
          if (diagnostic.error instanceof LayerDisposeError) {
            diagnostics.push(diagnostic)
          }
        }
      }
    )

    await runtime.run(() => ServiceRuntime.resolve(ScopedConsumer))

    const error = await captureRejection(runtime.dispose())

    expect(error).toBeInstanceOf(LayerDisposeError)
    expect(events).toEqual(['consumer', 'dependency', 'backend'])
    expect(diagnostics).toHaveLength(1)

    if (error instanceof LayerDisposeError) {
      expect(error.causes).toHaveLength(2)
      expect(error.causes[0]).toBeInstanceOf(ScopeCloseError)
      expect(error.causes[1]).toBe(backendFailure)

      if (error.causes[0] instanceof ScopeCloseError) {
        expect(error.causes[0].causes).toEqual([consumerFailure, dependencyFailure])
      }
    }
  })

  test('releases acquired scoped services', async () => {
    let released = 0

    const backend = new MemoryLayerBackend()

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

      expect(error).toBe(programFailure)
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps Layer.scoped resources alive between executions', async () => {
    let released = 0

    const runtime = await createRuntimeHandle(
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

    class ScopedFactoryService extends Service<ScopedFactoryService>()('ScopedFactoryService') {}

    const runtime = await createRuntimeHandle(
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
    const runtime = await createRuntimeHandle(
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
    const runtimeA = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    const runtimeB = await createRuntimeHandle(
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
    const runtime = await createRuntimeHandle(
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
    const runtime = await createRuntimeHandle(
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
    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    await runtime.dispose()

    expect(() => runtime.run(() => ServiceRuntime.resolve(ExampleService))).toThrow(
      'Cannot run a program using a disposed Layer'
    )
  })

  test('disposes the backend', async () => {
    const backend = new MemoryLayerBackend()

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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
    expect(() => runtime.run(() => undefined)).toThrow(
      'Cannot run a program using a disposed Layer'
    )

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

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

    const runtime = await createRuntimeHandle(
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

  test('classifies Result errors at the Runtime boundary', async () => {
    const programFailure = new Error('program failed')
    const cleanupFailure = new Error('cleanup failed')
    const expected = Result.err(programFailure)
    const diagnostics: Array<CleanupFailureDiagnostic | RuntimeShutdownDiagnostic> = []

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend(),
      {
        onCleanupFailure: (diagnostic) => {
          diagnostics.push(diagnostic)
        }
      }
    )

    try {
      const result = await runtime.run(async () => {
        Scope.current().addFinalizer(() => {
          throw cleanupFailure
        })

        return expected
      })

      expect(result).toBe(expected)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.outcome).toEqual({
        status: 'failure',
        cause: programFailure
      })
      expect(diagnostics[0]?.error).toBeInstanceOf(ScopeCloseError)

      if (diagnostics[0]?.error instanceof ScopeCloseError) {
        expect(diagnostics[0].error.causes).toEqual([cleanupFailure])
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('makes execution cleanup failure primary after success', async () => {
    const cleanupFailure = new Error('cleanup failed')
    const diagnostics: Array<CleanupFailureDiagnostic | RuntimeShutdownDiagnostic> = []

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend(),
      {
        onCleanupFailure: (diagnostic) => {
          diagnostics.push(diagnostic)
        }
      }
    )

    try {
      const error = await captureRejection(
        runtime.run(async () => {
          Scope.current().addFinalizer(() => {
            throw cleanupFailure
          })

          return Result.ok(true)
        })
      )

      expect(error).toBeInstanceOf(ScopeCloseError)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.outcome).toEqual({ status: 'success' })
    } finally {
      await runtime.dispose()
    }
  })

  test('reports cleanup failure after a plain execution value', async () => {
    const cleanupFailure = new Error('cleanup failed')

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const error = await captureRejection(
        runtime.run(async () => {
          Scope.current().addFinalizer(() => {
            throw cleanupFailure
          })

          return 42
        })
      )

      expect(error).toBeInstanceOf(ScopeCloseError)
    } finally {
      await runtime.dispose()
    }
  })

  test('notifies once with all execution cleanup failures', async () => {
    const firstFailure = new Error('first cleanup failed')
    const secondFailure = new Error('second cleanup failed')
    const diagnostics: Array<CleanupFailureDiagnostic | RuntimeShutdownDiagnostic> = []

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend(),
      {
        onCleanupFailure: (diagnostic) => {
          diagnostics.push(diagnostic)
        }
      }
    )

    try {
      await captureRejection(
        runtime.run(async () => {
          const scope = Scope.current()

          scope.addFinalizer(() => {
            throw firstFailure
          })
          scope.addFinalizer(() => {
            throw secondFailure
          })

          return Result.ok(true)
        })
      )

      expect(diagnostics).toHaveLength(1)

      if (diagnostics[0]?.error instanceof ScopeCloseError) {
        expect(diagnostics[0].error.causes).toEqual([secondFailure, firstFailure])
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('ignores cleanup observer failures', async () => {
    const cleanupFailure = new Error('cleanup failed')
    const observerFailure = new Error('observer failed')

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend(),
      {
        onCleanupFailure: () => {
          throw observerFailure
        }
      }
    )

    try {
      const error = await captureRejection(
        runtime.run(async () => {
          Scope.current().addFinalizer(() => {
            throw cleanupFailure
          })

          return Result.ok(true)
        })
      )

      expect(error).toBeInstanceOf(ScopeCloseError)

      if (error instanceof ScopeCloseError) {
        expect(error.causes).toEqual([cleanupFailure])
      }
    } finally {
      await runtime.dispose()
    }
  })

  test('passes the final failure outcome to Effect.acquireRelease in Runtime', async () => {
    let observed: ScopeOutcome | undefined
    const expected = Result.err(new Error('program failed'))

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          yield* Effect.acquireRelease(
            () => ({ value: true }),
            (_resource, outcome) => {
              observed = outcome
            }
          )

          return expected
        })
      )

      expect(result).toBe(expected)
      expect(observed).toEqual({
        status: 'failure',
        cause: expected.error
      })
    } finally {
      await runtime.dispose()
    }
  })

  test('classifies only the final recovered Result outcome', async () => {
    let observed: ScopeOutcome | undefined

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend()
    )

    try {
      const result = await runtime.run(() =>
        Effect.gen(async function* () {
          const inner = Result.err('recoverable')
          const recovered = Result.isError(inner) ? 'recovered' : 'unexpected'

          yield* Effect.acquireRelease(
            () => ({ value: true }),
            (_resource, outcome) => {
              observed = outcome
            }
          )

          return Result.ok(recovered)
        })
      )

      expect(result).toEqual(Result.ok('recovered'))
      expect(observed).toEqual({ status: 'success' })
    } finally {
      await runtime.dispose()
    }
  })

  test('reports execution cleanup while preserving a thrown program cause', async () => {
    const programFailure = new Error('program failed')
    const cleanupFailure = new Error('cleanup failed')
    const diagnostics: Array<CleanupFailureDiagnostic | RuntimeShutdownDiagnostic> = []

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, () => new ExampleService()),
      new MemoryLayerBackend(),
      {
        onCleanupFailure: (diagnostic) => {
          diagnostics.push(diagnostic)
        }
      }
    )

    try {
      const error = await captureRejection(
        runtime.run(async () => {
          Scope.current().addFinalizer(() => {
            throw cleanupFailure
          })

          throw programFailure
        })
      )

      expect(error).toBe(programFailure)
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]?.outcome).toEqual({
        status: 'failure',
        cause: programFailure
      })
    } finally {
      await runtime.dispose()
    }
  })

  test('keeps root finalizers in the ServiceRuntime during long-lived disposal', async () => {
    let observed: ScopeOutcome | undefined
    let resolverAvailable = false

    const runtime = await createRuntimeHandle(
      Layer.make(ExampleService, async () => {
        Scope.current().addFinalizer(async (outcome) => {
          observed = outcome
          resolverAvailable =
            (await ServiceRuntime.resolve(ExampleService)) instanceof ExampleService
        })

        return new ExampleService()
      }),
      new MemoryLayerBackend()
    )

    await runtime.run(() => ServiceRuntime.resolve(ExampleService))
    await runtime.run(() => Result.err(new Error('execution failed')))
    await runtime.dispose()

    expect(observed).toEqual({ status: 'success' })
    expect(resolverAvailable).toBe(true)
  })

  test('passes the one-shot program outcome to the root Scope', async () => {
    let observed: ScopeOutcome | undefined
    const programFailure = new Error('program failed')
    const expected = Result.err(programFailure)

    const result = await Runtime.run(
      Layer.make(ExampleService, async () => {
        Scope.current().addFinalizer((outcome) => {
          observed = outcome
        })

        return new ExampleService()
      }),
      new MemoryLayerBackend(),
      async () => {
        await ServiceRuntime.resolve(ExampleService)

        return expected
      }
    )

    expect(result).toBe(expected)
    expect(observed).toEqual({
      status: 'failure',
      cause: programFailure
    })
  })

  test('keeps the one-shot root outcome successful when only execution cleanup fails', async () => {
    let rootOutcome: ScopeOutcome | undefined
    const executionCleanupFailure = new Error('execution cleanup failed')

    const error = await captureRejection(
      Runtime.run(
        Layer.make(ExampleService, async () => {
          Scope.current().addFinalizer((outcome) => {
            rootOutcome = outcome
          })

          return new ExampleService()
        }),
        new MemoryLayerBackend(),
        async () => {
          await ServiceRuntime.resolve(ExampleService)

          Scope.current().addFinalizer(() => {
            throw executionCleanupFailure
          })

          return Result.ok(true)
        }
      )
    )

    expect(error).toBeInstanceOf(ScopeCloseError)
    expect(rootOutcome).toEqual({ status: 'success' })
  })

  test('aggregates root and backend failures while preserving a Result error', async () => {
    const rootFailure = new Error('root cleanup failed')
    const backendFailure = new Error('backend cleanup failed')
    const programFailure = new Error('program failed')
    const expected = Result.err(programFailure)
    const diagnostics: RuntimeShutdownDiagnostic[] = []
    const backend = new MemoryLayerBackend()
    backend.disposeFailure = backendFailure

    const result = await Runtime.run(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          throw rootFailure
        }
      ),
      backend,
      async () => {
        await ServiceRuntime.resolve(ExampleService)

        return expected
      },
      {
        onCleanupFailure: (diagnostic) => {
          if (diagnostic.error instanceof LayerDisposeError) {
            diagnostics.push(diagnostic)
          }
        }
      }
    )

    expect(result).toBe(expected)
    expect(backend.disposed).toBe(true)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.outcome).toEqual({
      status: 'failure',
      cause: programFailure
    })
    expect(diagnostics[0]?.error.causes).toHaveLength(2)
    expect(diagnostics[0]?.error.causes[0]).toBeInstanceOf(ScopeCloseError)
    expect(diagnostics[0]?.error.causes[1]).toBe(backendFailure)
  })

  test('exposes root and backend failures after one-shot success', async () => {
    const rootFailure = new Error('root cleanup failed')
    const backendFailure = new Error('backend cleanup failed')
    const backend = new MemoryLayerBackend()
    backend.disposeFailure = backendFailure

    const error = await captureRejection(
      Runtime.run(
        Layer.scoped(
          ExampleService,
          () => new ExampleService(),
          () => {
            throw rootFailure
          }
        ),
        backend,
        async () => {
          await ServiceRuntime.resolve(ExampleService)

          return Result.ok(true)
        }
      )
    )

    expect(error).toBeInstanceOf(LayerDisposeError)

    if (error instanceof LayerDisposeError) {
      expect(error.causes).toHaveLength(2)
      expect(error.causes[0]).toBeInstanceOf(ScopeCloseError)
      expect(error.causes[1]).toBe(backendFailure)
    }

    expect(backend.disposed).toBe(true)
  })

  test('preserves a thrown one-shot program failure over shutdown failures', async () => {
    const programFailure = new Error('program failed')
    const rootFailure = new Error('root cleanup failed')
    const backendFailure = new Error('backend cleanup failed')
    const diagnostics: RuntimeShutdownDiagnostic[] = []
    const backend = new MemoryLayerBackend()
    backend.disposeFailure = backendFailure

    const error = await captureRejection(
      Runtime.run(
        Layer.scoped(
          ExampleService,
          () => new ExampleService(),
          () => {
            throw rootFailure
          }
        ),
        backend,
        async () => {
          await ServiceRuntime.resolve(ExampleService)

          throw programFailure
        },
        {
          onCleanupFailure: (diagnostic) => {
            if (diagnostic.error instanceof LayerDisposeError) {
              diagnostics.push(diagnostic)
            }
          }
        }
      )
    )

    expect(error).toBe(programFailure)
    expect(diagnostics).toHaveLength(1)
    expect(backend.disposed).toBe(true)
  })

  test('always attempts backend cleanup after root cleanup fails', async () => {
    const rootFailure = new Error('root cleanup failed')
    const backendFailure = new Error('backend cleanup failed')
    const backend = new MemoryLayerBackend()
    backend.disposeFailure = backendFailure

    const runtime = await createRuntimeHandle(
      Layer.scoped(
        ExampleService,
        () => new ExampleService(),
        () => {
          throw rootFailure
        }
      ),
      backend
    )

    await runtime.run(() => ServiceRuntime.resolve(ExampleService))

    const disposalError = await captureRejection(runtime.dispose())

    expect(disposalError).toBeInstanceOf(LayerDisposeError)
    expect(backend.disposed).toBe(true)
  })

  test('cleans up a partially built layer after registration failure', async () => {
    class SecondService extends Service<SecondService>()('SecondService') {}

    const registrationFailure = new Error('registration failed')
    const backendFailure = new Error('backend cleanup failed')
    let rootOutcome: ScopeOutcome | undefined
    const diagnostics: RuntimeShutdownDiagnostic[] = []
    const backend = new MemoryLayerBackend()
    backend.registerFailureAfterFirst = registrationFailure
    backend.acquireBeforeRegistrationFailure = true
    backend.disposeFailure = backendFailure

    const error = await captureRejection(
      createRuntimeHandle(
        Layer.merge(
          Layer.make(ExampleService, () => {
            Scope.current().addFinalizer((outcome) => {
              rootOutcome = outcome
            })

            return new ExampleService()
          }),
          Layer.make(SecondService, () => new SecondService())
        ),
        backend,
        {
          onCleanupFailure: (diagnostic) => {
            if (diagnostic.error instanceof LayerDisposeError) {
              diagnostics.push(diagnostic)
            }
          }
        }
      )
    )

    expect(error).toBeInstanceOf(LayerRegistrationError)
    expect(backend.disposed).toBe(true)
    expect(rootOutcome).toEqual({
      status: 'failure',
      cause: registrationFailure
    })
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.outcome.status).toBe('failure')

    if (error instanceof LayerRegistrationError) {
      expect(error.registrationCause).toBe(registrationFailure)
      expect(error.cleanupCause).toBe(backendFailure)
    }
  })
})
