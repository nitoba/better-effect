import {
  DuplicateServiceError,
  Layer,
  ServiceTagCollisionError,
  type LayerBackend,
  type LayerRegistration
} from '../layer'
import {
  RuntimeContextNotConfiguredError,
  RuntimeContextOverlapError,
  type RuntimeContext,
  type RuntimeContextStorage
} from '../runtime'
import { Scope, ScopeCloseError, ScopeClosedError, type CloseableScope } from '../scope'
import { ScopeRuntime } from '../scope/runtime'
import {
  Service,
  ServiceNotFoundError,
  ServiceRuntime,
  type AnyServiceToken,
  type ServiceResolver
} from '../service'

/** One runner-neutral conformance scenario. */
export interface ContractScenario {
  /** Stable human-readable scenario name for test-runner registration. */
  readonly name: string

  /** Execute the scenario and reject with a diagnostic when its contract is violated. */
  readonly run: () => Promise<void>
}

/** Thrown by a conformance scenario when an adapter violates its contract. */
export class ConformanceError extends Error {
  constructor(
    readonly scenario: string,
    detail: string,
    cause?: unknown
  ) {
    super(`${scenario}: ${detail}`, { cause })

    this.name = 'ConformanceError'
  }
}

/** Declared behavior for a backend after a provider acquisition fails. */
export type LayerBackendAcquisitionFailure = 'retry' | 'sticky'

/** Configuration for the LayerBackend conformance scenarios. */
export interface LayerBackendContractOptions {
  /** Create a new, isolated backend for every scenario. */
  readonly makeBackend: () => LayerBackend | PromiseLike<LayerBackend>

  /** Declare whether failed acquisitions retry or remain cached until disposal. */
  readonly acquisitionFailure: LayerBackendAcquisitionFailure

  /** Run adapter-specific cleanup after every scenario, including failed assertions. */
  readonly cleanup?: (backend: LayerBackend) => void | PromiseLike<void>
}

/** Supported overlap behavior for RuntimeContextStorage implementations. */
export type ContextConcurrency = 'concurrent' | 'sequential'

/** Configuration for the RuntimeContextStorage conformance scenarios. */
export interface RuntimeContextStorageContractOptions {
  /** Create a new, isolated storage instance for every scenario. */
  readonly makeStorage: () => RuntimeContextStorage

  /** Declare whether one storage instance supports overlapping root contexts. */
  readonly concurrency: ContextConcurrency

  /** Recognize the implementation's standard missing-context error. */
  readonly isMissingContextError?: (cause: unknown) => boolean

  /** Recognize the implementation's standard unsupported-overlap error. */
  readonly isOverlapError?: (cause: unknown) => boolean

  /** Create a storage that should not leak a frame into this storage. */
  readonly makeCompanionStorage?: () => RuntimeContextStorage

  /** Run adapter-specific cleanup after every scenario, including failed assertions. */
  readonly cleanup?: (storage: RuntimeContextStorage) => void | PromiseLike<void>
}

class ContractService extends Service<ContractService>()(
  '@better-effect/testing/ContractService'
) {}

class MissingContractService extends Service<MissingContractService>()(
  '@better-effect/testing/MissingContractService'
) {}

class CompatibleRegisteredService extends Service<CompatibleRegisteredService>()(
  '@better-effect/testing/CompatibleService'
) {
  read(): string {
    return 'registered'
  }

  write(): string {
    return 'registered-only'
  }
}

class CompatibleRequestedService extends Service<CompatibleRequestedService>()(
  '@better-effect/testing/CompatibleService'
) {
  read(): string {
    return 'requested'
  }
}

class IncompatibleRegisteredService extends Service<IncompatibleRegisteredService>()(
  '@better-effect/testing/IncompatibleService'
) {
  read(): string {
    return 'registered'
  }
}

class IncompatibleRequestedService extends Service<IncompatibleRequestedService>()(
  '@better-effect/testing/IncompatibleService'
) {
  write(): string {
    return 'requested'
  }
}

const layerScenario = (name: string, run: () => Promise<void>): ContractScenario => ({
  name,
  async run(): Promise<void> {
    try {
      await run()
    } catch (cause) {
      if (cause instanceof ConformanceError) {
        throw cause
      }

      throw new ConformanceError(name, `unexpected failure (${describeCause(cause)})`, cause)
    }
  }
})

const fail = (scenario: string, detail: string): never => {
  throw new ConformanceError(scenario, detail)
}

const assert = (condition: boolean, scenario: string, detail: string): void => {
  if (!condition) {
    fail(scenario, detail)
  }
}

const describeCause = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)

const rejected = async <Value>(
  value: Value | PromiseLike<Value>,
  scenario: string,
  expectation: string
) => {
  const outcome = await Promise.resolve(value).then(
    () => ({ rejected: false as const }),
    (cause) => ({ rejected: true as const, cause })
  )

  if (outcome.rejected) {
    return outcome.cause
  }

  fail(scenario, `expected ${expectation} to reject`)
}

const withBackend = async <Value>(
  options: LayerBackendContractOptions,
  run: (backend: LayerBackend) => Value | PromiseLike<Value>
): Promise<Awaited<Value>> => {
  const backend = await options.makeBackend()

  try {
    return await run(backend)
  } finally {
    try {
      await backend.disposeAll()
    } finally {
      await options.cleanup?.(backend)
    }
  }
}

const expectMissingService = (cause: unknown, service: AnyServiceToken, scenario: string): void => {
  assert(
    cause instanceof ServiceNotFoundError,
    scenario,
    `expected ServiceNotFoundError for tag "${service.serviceTag}", received ${describeCause(cause)}`
  )

  if (cause instanceof ServiceNotFoundError) {
    assert(
      cause.service.serviceTag === service.serviceTag,
      scenario,
      `expected missing tag "${service.serviceTag}", received "${cause.service.serviceTag}"`
    )
  }
}

const expectDuplicate = (cause: unknown, service: AnyServiceToken, scenario: string): void => {
  assert(
    cause instanceof DuplicateServiceError,
    scenario,
    `expected DuplicateServiceError for tag "${service.serviceTag}", received ${describeCause(cause)}`
  )

  if (cause instanceof DuplicateServiceError) {
    assert(
      cause.service.serviceTag === service.serviceTag,
      scenario,
      `expected duplicate tag "${service.serviceTag}", received "${cause.service.serviceTag}"`
    )
  }
}

const expectCollision = (cause: unknown, service: AnyServiceToken, scenario: string): void => {
  assert(
    cause instanceof ServiceTagCollisionError,
    scenario,
    `expected ServiceTagCollisionError for tag "${service.serviceTag}", received ${describeCause(cause)}`
  )

  if (cause instanceof ServiceTagCollisionError) {
    assert(
      cause.incoming.serviceTag === service.serviceTag,
      scenario,
      `expected collision tag "${service.serviceTag}", received "${cause.incoming.serviceTag}"`
    )
  }
}

/**
 * Return runner-neutral scenarios for a LayerBackend implementation.
 *
 * Every scenario creates a fresh backend and invokes `cleanup` in `finally`,
 * so consumers can register `scenario.run` directly with their test runner.
 */
export const layerBackendContract = (
  options: LayerBackendContractOptions
): readonly ContractScenario[] => [
  layerScenario('LayerBackend registers providers lazily', async () => {
    await withBackend(options, async (backend) => {
      let acquisitions = 0

      await backend.register({
        service: ContractService,
        acquire: () => {
          acquisitions++
          return new ContractService()
        }
      })

      assert(
        acquisitions === 0,
        'LayerBackend registers providers lazily',
        `expected no acquisitions during registration for tag "${ContractService.serviceTag}", received ${acquisitions}`
      )
    })
  }),
  layerScenario('LayerBackend resolves the registered Service token', async () => {
    await withBackend(options, async (backend) => {
      const instance = new ContractService()

      await backend.register({
        service: ContractService,
        acquire: () => instance
      })

      const resolved = await backend.resolve(ContractService)

      assert(
        resolved === instance && resolved instanceof ContractService,
        'LayerBackend resolves the registered Service token',
        `expected token "${ContractService.serviceTag}" to resolve its registered instance`
      )
    })
  }),
  layerScenario('LayerBackend caches successful acquisitions', async () => {
    await withBackend(options, async (backend) => {
      let acquisitions = 0

      await backend.register({
        service: ContractService,
        acquire: () => {
          acquisitions++
          return new ContractService()
        }
      })

      const first = await backend.resolve(ContractService)
      const second = await backend.resolve(ContractService)

      assert(
        first === second && acquisitions === 1,
        'LayerBackend caches successful acquisitions',
        `expected one cached acquisition for tag "${ContractService.serviceTag}", received ${acquisitions}`
      )
    })
  }),
  layerScenario('LayerBackend deduplicates concurrent acquisitions', async () => {
    await withBackend(options, async (backend) => {
      let acquisitions = 0
      let releaseAcquisition!: () => void
      let markStarted!: () => void
      const acquired = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseAcquisition = resolve
      })
      const instance = new ContractService()

      await backend.register({
        service: ContractService,
        acquire: async () => {
          acquisitions++
          markStarted()
          await release
          return instance
        }
      })

      const first = Promise.resolve(backend.resolve(ContractService))
      const second = Promise.resolve(backend.resolve(ContractService))

      try {
        await acquired
        assert(
          acquisitions === 1,
          'LayerBackend deduplicates concurrent acquisitions',
          `expected one in-flight acquisition for tag "${ContractService.serviceTag}", received ${acquisitions}`
        )

        releaseAcquisition()
        const [firstInstance, secondInstance] = await Promise.all([first, second])

        assert(
          firstInstance === instance && secondInstance === instance,
          'LayerBackend deduplicates concurrent acquisitions',
          `expected concurrent resolves for tag "${ContractService.serviceTag}" to share one instance`
        )
      } finally {
        releaseAcquisition()
        await Promise.allSettled([first, second])
      }
    })
  }),
  layerScenario('LayerBackend reports a missing Service tag', async () => {
    await withBackend(options, async (backend) => {
      const cause = await rejected(
        Promise.resolve().then(() => backend.resolve(MissingContractService)),
        'LayerBackend reports a missing Service tag',
        `resolution for tag "${MissingContractService.serviceTag}"`
      )

      expectMissingService(
        cause,
        MissingContractService,
        'LayerBackend reports a missing Service tag'
      )
    })
  }),
  layerScenario('LayerBackend rejects exact duplicate registrations', async () => {
    await withBackend(options, async (backend) => {
      const registration: LayerRegistration = {
        service: ContractService,
        acquire: () => new ContractService()
      }

      await backend.register(registration)

      const cause = await rejected(
        Promise.resolve().then(() => backend.register(registration)),
        'LayerBackend rejects exact duplicate registrations',
        `a duplicate registration for tag "${ContractService.serviceTag}"`
      )

      expectDuplicate(cause, ContractService, 'LayerBackend rejects exact duplicate registrations')
    })
  }),
  layerScenario('LayerBackend rejects incompatible same-tag collisions', async () => {
    await withBackend(options, async (backend) => {
      await backend.register({
        service: IncompatibleRegisteredService,
        acquire: () => new IncompatibleRegisteredService()
      })

      const registrationCause = await rejected(
        Promise.resolve().then(() =>
          backend.register({
            service: IncompatibleRequestedService,
            acquire: () => new IncompatibleRequestedService()
          })
        ),
        'LayerBackend rejects incompatible same-tag collisions',
        `a colliding registration for tag "${IncompatibleRequestedService.serviceTag}"`
      )

      expectCollision(
        registrationCause,
        IncompatibleRequestedService,
        'LayerBackend rejects incompatible same-tag collisions'
      )

      const resolutionCause = await rejected(
        Promise.resolve().then(() => backend.resolve(IncompatibleRequestedService)),
        'LayerBackend rejects incompatible same-tag collisions',
        `an incompatible lookup for tag "${IncompatibleRequestedService.serviceTag}"`
      )

      expectCollision(
        resolutionCause,
        IncompatibleRequestedService,
        'LayerBackend rejects incompatible same-tag collisions'
      )
    })
  }),
  layerScenario('LayerBackend preserves compatible same-tag registrations', async () => {
    await withBackend(options, async (backend) => {
      const registered = new CompatibleRegisteredService()

      await backend.register({
        service: CompatibleRegisteredService,
        acquire: () => registered
      })

      const resolved = await backend.resolve(CompatibleRequestedService)

      assert(
        resolved === registered && resolved.read() === 'registered',
        'LayerBackend preserves compatible same-tag registrations',
        `expected compatible tag "${CompatibleRequestedService.serviceTag}" to resolve the registered contract`
      )
    })
  }),
  layerScenario('LayerBackend applies declared acquisition-failure behavior', async () => {
    await withBackend(options, async (backend) => {
      const failure = new Error('contract acquisition failure')
      let acquisitions = 0

      await backend.register({
        service: ContractService,
        acquire: async () => {
          acquisitions++
          throw failure
        }
      })

      const firstCause = await rejected(
        Promise.resolve().then(() => backend.resolve(ContractService)),
        'LayerBackend applies declared acquisition-failure behavior',
        `the first acquisition for tag "${ContractService.serviceTag}"`
      )
      const secondCause = await rejected(
        Promise.resolve().then(() => backend.resolve(ContractService)),
        'LayerBackend applies declared acquisition-failure behavior',
        `the second acquisition for tag "${ContractService.serviceTag}"`
      )
      const expectedAcquisitions = options.acquisitionFailure === 'retry' ? 2 : 1

      assert(
        firstCause === failure && secondCause === failure && acquisitions === expectedAcquisitions,
        'LayerBackend applies declared acquisition-failure behavior',
        `expected ${options.acquisitionFailure} behavior with ${expectedAcquisitions} acquisition attempts for tag "${ContractService.serviceTag}", received ${acquisitions}`
      )
    })
  }),
  layerScenario('LayerBackend disposal waits for in-flight acquisition', async () => {
    await withBackend(options, async (backend) => {
      let releaseAcquisition!: () => void
      let markStarted!: () => void
      let disposing: Promise<void> | undefined
      let observedPendingAcquisition = false
      const acquired = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const release = new Promise<void>((resolve) => {
        releaseAcquisition = resolve
      })

      await backend.register({
        service: ContractService,
        acquire: async () => {
          markStarted()
          await release
          return new ContractService()
        }
      })

      const resolving = Promise.resolve(backend.resolve(ContractService))

      try {
        await acquired
        disposing = Promise.resolve(
          backend.disposeAll({
            onPendingAcquisitions: (services) => {
              assert(
                services.includes(ContractService),
                'LayerBackend disposal waits for in-flight acquisition',
                `disposeAll did not report the pending tag "${ContractService.serviceTag}"`
              )
              observedPendingAcquisition = true
              releaseAcquisition()
            }
          })
        )

        assert(
          observedPendingAcquisition,
          'LayerBackend disposal waits for in-flight acquisition',
          `disposeAll did not synchronously observe the pending tag "${ContractService.serviceTag}"`
        )

        await Promise.all([resolving, disposing])
      } finally {
        releaseAcquisition()
        await Promise.allSettled(disposing === undefined ? [resolving] : [resolving, disposing])
      }
    })
  }),
  layerScenario('LayerBackend disposal clears registrations and supports reuse', async () => {
    await withBackend(options, async (backend) => {
      const first = new ContractService()

      await backend.register({
        service: ContractService,
        acquire: () => first
      })
      assert(
        (await backend.resolve(ContractService)) === first,
        'LayerBackend disposal clears registrations and supports reuse',
        `expected the first registration for tag "${ContractService.serviceTag}" to resolve before disposal`
      )

      await backend.disposeAll()

      const missingCause = await rejected(
        Promise.resolve().then(() => backend.resolve(ContractService)),
        'LayerBackend disposal clears registrations and supports reuse',
        `resolution after disposing tag "${ContractService.serviceTag}"`
      )

      expectMissingService(
        missingCause,
        ContractService,
        'LayerBackend disposal clears registrations and supports reuse'
      )

      const second = new ContractService()
      await backend.register({
        service: ContractService,
        acquire: () => second
      })

      assert(
        (await backend.resolve(ContractService)) === second,
        'LayerBackend disposal clears registrations and supports reuse',
        `expected a fresh instance for reused tag "${ContractService.serviceTag}" after disposal`
      )
    })
  }),
  layerScenario('LayerBackend repeated disposal is safe', async () => {
    await withBackend(options, async (backend) => {
      await backend.disposeAll()
      await backend.disposeAll()
    })
  }),
  layerScenario('LayerBackend does not execute Layer release callbacks', async () => {
    await withBackend(options, async (backend) => {
      let releases = 0
      const layer = Layer.scoped(
        ContractService,
        () => new ContractService(),
        () => {
          releases++
        }
      )
      const registration =
        layer.providers[0] ??
        fail(
          'LayerBackend does not execute Layer release callbacks',
          `Layer did not retain the provider for tag "${ContractService.serviceTag}"`
        )

      await backend.register(registration)
      await backend.resolve(ContractService)
      await backend.disposeAll()

      assert(
        releases === 0,
        'LayerBackend does not execute Layer release callbacks',
        `backend disposal executed ${releases} Layer release callback(s) for tag "${ContractService.serviceTag}"`
      )
    })
  })
]

const makeResolver = (): ServiceResolver => {
  const services = new Map<AnyServiceToken, unknown>()

  return {
    resolve<T extends AnyServiceToken>(token: T): InstanceType<T> {
      const service = services.get(token)

      if (service === undefined) {
        throw new Error(`No test Service is registered for "${token.serviceTag}"`)
      }

      // SAFETY: This test resolver is keyed by the exact Service token used at lookup.
      return service as InstanceType<T>
    }
  }
}

const makeContext = (scope: CloseableScope, resolver: ServiceResolver): RuntimeContext => ({
  scope,
  resolver,
  resolutionPath: []
})

const withStorage = async <Value>(
  options: RuntimeContextStorageContractOptions,
  run: (storage: RuntimeContextStorage) => Value | PromiseLike<Value>
): Promise<Awaited<Value>> => {
  const storage = options.makeStorage()

  try {
    return await run(storage)
  } finally {
    await options.cleanup?.(storage)
  }
}

const expectMissingContext = (
  cause: unknown,
  options: RuntimeContextStorageContractOptions,
  scenario: string
): void => {
  const isMissing =
    options.isMissingContextError ??
    ((cause: unknown): boolean => cause instanceof RuntimeContextNotConfiguredError)

  assert(
    isMissing(cause),
    scenario,
    `expected the declared missing-context error for ${options.concurrency} storage, received ${describeCause(cause)}`
  )
}

const expectOverlap = (
  cause: unknown,
  options: RuntimeContextStorageContractOptions,
  scenario: string
): void => {
  const isOverlap =
    options.isOverlapError ??
    ((cause: unknown): boolean => cause instanceof RuntimeContextOverlapError)

  assert(
    isOverlap(cause),
    scenario,
    `expected the declared overlap error for sequential storage, received ${describeCause(cause)}`
  )
}

const closeScopes = async (...scopes: readonly CloseableScope[]): Promise<void> => {
  const failures: unknown[] = []

  for (const scope of scopes) {
    try {
      await scope.close()
    } catch (cause) {
      failures.push(cause)
    }
  }

  if (failures.length === 1) {
    throw failures[0]
  }

  if (failures.length > 1) {
    throw new AggregateError(failures, 'Contract Scope cleanup failed')
  }
}

/**
 * Return runner-neutral scenarios for a RuntimeContextStorage implementation.
 *
 * Every scenario creates a fresh storage and invokes `cleanup` in `finally`,
 * so consumers can register `scenario.run` directly with their test runner.
 */
export const runtimeContextStorageContract = (
  options: RuntimeContextStorageContractOptions
): readonly ContractScenario[] => {
  const scenarios: ContractScenario[] = [
    layerScenario(
      'RuntimeContextStorage exposes context synchronously and after await',
      async () => {
        await withStorage(options, async (storage) => {
          const scope = Scope.make()
          const context = makeContext(scope, makeResolver())

          try {
            await storage.run(context, async () => {
              assert(
                storage.current() === context,
                'RuntimeContextStorage exposes context synchronously and after await',
                'current() did not return the context synchronously inside run()'
              )
              await Promise.resolve()
              assert(
                storage.current() === context,
                'RuntimeContextStorage exposes context synchronously and after await',
                'current() did not retain the context after Promise suspension'
              )
            })
          } finally {
            await scope.close()
          }
        })
      }
    ),
    layerScenario(
      'RuntimeContextStorage restores parent context after nested execution',
      async () => {
        await withStorage(options, async (storage) => {
          const rootScope = Scope.make()
          const childScope = rootScope.fork()
          const resolver = makeResolver()
          const root = makeContext(rootScope, resolver)

          try {
            await storage.run(root, async () => {
              await ServiceRuntime.run(
                resolver,
                async () => {
                  const serviceContext = storage.current()

                  assert(
                    serviceContext !== root && serviceContext.resolver === resolver,
                    'RuntimeContextStorage restores parent context after nested execution',
                    'ServiceRuntime.run did not preserve the parent resolver lineage'
                  )

                  await Scope.provide(childScope, async () => {
                    const scopeContext = storage.current()

                    assert(
                      scopeContext.scope === childScope && scopeContext.resolver === resolver,
                      'RuntimeContextStorage restores parent context after nested execution',
                      'Scope.provide did not preserve the parent Service lineage'
                    )
                    await Promise.resolve()
                    assert(
                      storage.current() === scopeContext,
                      'RuntimeContextStorage restores parent context after nested execution',
                      'derived Scope context changed after Promise suspension'
                    )
                  })

                  assert(
                    storage.current() === serviceContext,
                    'RuntimeContextStorage restores parent context after nested execution',
                    'parent Service context was not restored after Scope.provide'
                  )
                },
                storage
              )

              assert(
                storage.current() === root,
                'RuntimeContextStorage restores parent context after nested execution',
                'root context was not restored after ServiceRuntime.run'
              )
            })
          } finally {
            await closeScopes(childScope, rootScope)
          }
        })
      }
    ),
    layerScenario('RuntimeContextStorage restores context after synchronous throw', async () => {
      await withStorage(options, async (storage) => {
        const scope = Scope.make()
        const context = makeContext(scope, makeResolver())
        const failure = new Error('contract synchronous failure')

        try {
          const cause = await rejected(
            Promise.resolve().then(() =>
              storage.run(context, () => {
                throw failure
              })
            ),
            'RuntimeContextStorage restores context after synchronous throw',
            'the synchronous callback failure'
          )

          assert(
            cause === failure,
            'RuntimeContextStorage restores context after synchronous throw',
            `expected the original synchronous failure, received ${describeCause(cause)}`
          )
          expectMissingContext(
            await rejected(
              Promise.resolve().then(() => storage.current()),
              'RuntimeContextStorage restores context after synchronous throw',
              'current() outside run()'
            ),
            options,
            'RuntimeContextStorage restores context after synchronous throw'
          )
        } finally {
          await scope.close()
        }
      })
    }),
    layerScenario('RuntimeContextStorage restores context after Promise rejection', async () => {
      await withStorage(options, async (storage) => {
        const scope = Scope.make()
        const context = makeContext(scope, makeResolver())
        const failure = new Error('contract async failure')

        try {
          const cause = await rejected(
            storage.run(context, async () => {
              await Promise.resolve()
              throw failure
            }),
            'RuntimeContextStorage restores context after Promise rejection',
            'the asynchronous callback failure'
          )

          assert(
            cause === failure,
            'RuntimeContextStorage restores context after Promise rejection',
            `expected the original asynchronous failure, received ${describeCause(cause)}`
          )
          expectMissingContext(
            await rejected(
              Promise.resolve().then(() => storage.current()),
              'RuntimeContextStorage restores context after Promise rejection',
              'current() outside run()'
            ),
            options,
            'RuntimeContextStorage restores context after Promise rejection'
          )
        } finally {
          await scope.close()
        }
      })
    }),
    layerScenario('RuntimeContextStorage preserves custom internal failures', async () => {
      await withStorage(options, async (storage) => {
        const failure = new Error('contract storage failure')
        const faultyStorage: RuntimeContextStorage = {
          run: (context, program) => storage.run(context, program),
          current: () => {
            throw failure
          }
        }

        const cause = await rejected(
          Promise.resolve().then(() =>
            ServiceRuntime.run(makeResolver(), () => undefined, faultyStorage)
          ),
          'RuntimeContextStorage preserves custom internal failures',
          'a custom storage failure'
        )

        assert(
          cause === failure,
          'RuntimeContextStorage preserves custom internal failures',
          `expected the original custom failure, received ${describeCause(cause)}`
        )
      })
    }),
    layerScenario('Scope closes when RuntimeContextStorage.run throws synchronously', async () => {
      await withStorage(options, async (storage) => {
        const parent = Scope.make()
        const child = parent.fork()
        const storageFailure = new Error('contract close storage failure')
        const closeFailure = new Error('contract close finalizer failure')
        const outcome = { status: 'failure' as const, cause: closeFailure }
        const events: string[] = []
        const faultyStorage: RuntimeContextStorage = {
          run: () => {
            throw storageFailure
          },
          current: () => storage.current()
        }

        child.addFinalizer((childOutcome) => {
          events.push(`child:${childOutcome.status}`)
        })
        parent.addFinalizer((parentOutcome) => {
          events.push(`first:${parentOutcome.status}`)
          throw closeFailure
        })
        parent.addFinalizer((parentOutcome) => {
          events.push(`second:${parentOutcome.status}`)
        })
        ScopeRuntime.bind(parent, faultyStorage)

        const firstClose = parent.close(outcome)
        const secondClose = parent.close()

        assert(
          secondClose === firstClose,
          'Scope closes when RuntimeContextStorage.run throws synchronously',
          'later close did not share the original close Promise'
        )

        const cause = await rejected(
          firstClose,
          'Scope closes when RuntimeContextStorage.run throws synchronously',
          'the storage-safe close'
        )

        assert(
          cause instanceof ScopeCloseError &&
            cause.causes.length === 2 &&
            cause.causes[0] === storageFailure &&
            cause.causes[1] === closeFailure,
          'Scope closes when RuntimeContextStorage.run throws synchronously',
          `expected storage then finalizer cleanup failures, received ${describeCause(cause)}`
        )
        assert(
          events.join(',') === 'child:failure,second:failure,first:failure',
          'Scope closes when RuntimeContextStorage.run throws synchronously',
          `expected child-first LIFO finalizers with the original outcome, received ${events.join(',')}`
        )

        const closedCause = await rejected(
          Promise.resolve().then(() => parent.addFinalizer(() => undefined)),
          'Scope closes when RuntimeContextStorage.run throws synchronously',
          'registration after close'
        )

        assert(
          closedCause instanceof ScopeClosedError,
          'Scope closes when RuntimeContextStorage.run throws synchronously',
          `Scope remained open after storage failure (${describeCause(closedCause)})`
        )
      })
    })
  ]

  if (options.concurrency === 'concurrent') {
    scenarios.push(
      layerScenario('RuntimeContextStorage isolates concurrent roots', async () => {
        await withStorage(options, async (storage) => {
          const firstScope = Scope.make()
          const secondScope = Scope.make()
          const first = makeContext(firstScope, makeResolver())
          const second = makeContext(secondScope, makeResolver())
          let releaseFirst!: () => void
          let releaseSecond!: () => void
          let firstStarted!: () => void
          let secondStarted!: () => void
          const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          const secondMayFinish = new Promise<void>((resolve) => {
            releaseSecond = resolve
          })
          const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve
          })
          const secondStartedPromise = new Promise<void>((resolve) => {
            secondStarted = resolve
          })
          const runs: Promise<RuntimeContext>[] = []

          try {
            const firstRun = Promise.resolve(
              storage.run(first, async () => {
                firstStarted()
                await firstMayFinish
                return storage.current()
              })
            )
            runs.push(firstRun)
            const secondRun = Promise.resolve(
              storage.run(second, async () => {
                secondStarted()
                await secondMayFinish
                return storage.current()
              })
            )
            runs.push(secondRun)

            await Promise.all([firstStartedPromise, secondStartedPromise])
            releaseFirst()
            releaseSecond()
            const [firstCurrent, secondCurrent] = await Promise.all([firstRun, secondRun])

            assert(
              firstCurrent === first && secondCurrent === second,
              'RuntimeContextStorage isolates concurrent roots',
              'overlapping roots observed another context frame'
            )
          } finally {
            releaseFirst()
            releaseSecond()
            await Promise.allSettled(runs)
            await closeScopes(firstScope, secondScope)
          }
        })
      }),
      layerScenario('RuntimeContextStorage isolates concurrent derived siblings', async () => {
        await withStorage(options, async (storage) => {
          const rootScope = Scope.make()
          const firstScope = rootScope.fork()
          const secondScope = rootScope.fork()
          const root = makeContext(rootScope, makeResolver())
          let releaseFirst!: () => void
          let releaseSecond!: () => void
          let firstStarted!: () => void
          let secondStarted!: () => void
          const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          const secondMayFinish = new Promise<void>((resolve) => {
            releaseSecond = resolve
          })
          const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve
          })
          const secondStartedPromise = new Promise<void>((resolve) => {
            secondStarted = resolve
          })

          const runs: Promise<RuntimeContext>[] = []

          try {
            await storage.run(root, async () => {
              try {
                const firstRun = Promise.resolve(
                  Scope.provide(firstScope, async () => {
                    firstStarted()
                    await firstMayFinish
                    return storage.current()
                  })
                )
                runs.push(firstRun)
                const secondRun = Promise.resolve(
                  Scope.provide(secondScope, async () => {
                    secondStarted()
                    await secondMayFinish
                    return storage.current()
                  })
                )
                runs.push(secondRun)

                await Promise.all([firstStartedPromise, secondStartedPromise])
                releaseFirst()
                releaseSecond()
                const [firstContext, secondContext] = await Promise.all([firstRun, secondRun])

                assert(
                  firstContext.scope === firstScope && secondContext.scope === secondScope,
                  'RuntimeContextStorage isolates concurrent derived siblings',
                  'overlapping derived siblings observed another Scope context'
                )
                assert(
                  storage.current() === root,
                  'RuntimeContextStorage isolates concurrent derived siblings',
                  'root context was not restored after concurrent derived siblings settled'
                )
              } finally {
                releaseFirst()
                releaseSecond()
                await Promise.allSettled(runs)
              }
            })
          } finally {
            releaseFirst()
            releaseSecond()
            await Promise.allSettled(runs)
            await closeScopes(firstScope, secondScope, rootScope)
          }
        })
      })
    )
  } else {
    scenarios.push(
      layerScenario('RuntimeContextStorage rejects overlap and remains reusable', async () => {
        await withStorage(options, async (storage) => {
          const firstScope = Scope.make()
          const secondScope = Scope.make()
          const first = makeContext(firstScope, makeResolver())
          const second = makeContext(secondScope, makeResolver())
          let releaseFirst!: () => void
          let firstStarted!: () => void
          const firstMayFinish = new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve
          })
          const runs: Promise<RuntimeContext>[] = []

          try {
            const firstRun = Promise.resolve(
              storage.run(first, async () => {
                firstStarted()
                await firstMayFinish
                return storage.current()
              })
            )
            runs.push(firstRun)

            await firstStartedPromise
            const overlapCause = await rejected(
              Promise.resolve().then(() => storage.run(second, () => storage.current())),
              'RuntimeContextStorage rejects overlap and remains reusable',
              'an overlapping root run'
            )

            expectOverlap(
              overlapCause,
              options,
              'RuntimeContextStorage rejects overlap and remains reusable'
            )

            releaseFirst()
            assert(
              (await firstRun) === first,
              'RuntimeContextStorage rejects overlap and remains reusable',
              'the first context did not remain intact after rejected overlap'
            )
            assert(
              storage.run(second, () => storage.current()) === second,
              'RuntimeContextStorage rejects overlap and remains reusable',
              'storage was not reusable after rejected overlap'
            )
          } finally {
            releaseFirst()
            await Promise.allSettled(runs)
            await closeScopes(firstScope, secondScope)
          }
        })
      }),
      layerScenario(
        'RuntimeContextStorage rejects overlapping derived siblings and remains reusable',
        async () => {
          await withStorage(options, async (storage) => {
            const rootScope = Scope.make()
            const firstScope = rootScope.fork()
            const secondScope = rootScope.fork()
            const root = makeContext(rootScope, makeResolver())
            let releaseFirst!: () => void
            let firstStarted!: () => void
            const firstMayFinish = new Promise<void>((resolve) => {
              releaseFirst = resolve
            })
            const firstStartedPromise = new Promise<void>((resolve) => {
              firstStarted = resolve
            })
            const runs: Promise<RuntimeContext>[] = []

            try {
              await storage.run(root, async () => {
                try {
                  const firstRun = Promise.resolve(
                    Scope.provide(firstScope, async () => {
                      firstStarted()
                      await firstMayFinish
                      return storage.current()
                    })
                  )
                  runs.push(firstRun)

                  await firstStartedPromise
                  let secondRan = false
                  const overlapCause = await rejected(
                    Promise.resolve().then(() =>
                      Scope.provide(secondScope, () => {
                        secondRan = true
                        return storage.current()
                      })
                    ),
                    'RuntimeContextStorage rejects overlapping derived siblings and remains reusable',
                    'an overlapping derived sibling run'
                  )

                  expectOverlap(
                    overlapCause,
                    options,
                    'RuntimeContextStorage rejects overlapping derived siblings and remains reusable'
                  )
                  assert(
                    !secondRan,
                    'RuntimeContextStorage rejects overlapping derived siblings and remains reusable',
                    'the rejected derived sibling callback ran'
                  )

                  releaseFirst()
                  const firstContext = await firstRun

                  assert(
                    firstContext.scope === firstScope,
                    'RuntimeContextStorage rejects overlapping derived siblings and remains reusable',
                    'the first derived sibling context changed after rejected overlap'
                  )
                  assert(
                    storage.current() === root,
                    'RuntimeContextStorage rejects overlapping derived siblings and remains reusable',
                    'root context was not restored after the first derived sibling settled'
                  )
                } finally {
                  releaseFirst()
                  await Promise.allSettled(runs)
                }
              })

              const reusable = makeContext(secondScope, makeResolver())
              assert(
                storage.run(reusable, () => storage.current()) === reusable,
                'RuntimeContextStorage rejects overlapping derived siblings and remains reusable',
                'storage was not reusable after rejected derived sibling overlap'
              )
            } finally {
              releaseFirst()
              await Promise.allSettled(runs)
              await closeScopes(firstScope, secondScope, rootScope)
            }
          })
        }
      )
    )
  }

  const makeCompanionStorage = options.makeCompanionStorage

  if (makeCompanionStorage) {
    scenarios.push(
      layerScenario('RuntimeContextStorage interoperates without leaking frames', async () => {
        await withStorage(options, async (storage) => {
          const companion = makeCompanionStorage()
          const outerScope = Scope.make()
          const innerScope = Scope.make()
          const outer = makeContext(outerScope, makeResolver())
          const inner = makeContext(innerScope, makeResolver())

          try {
            await storage.run(outer, async () => {
              await companion.run(inner, async () => {
                assert(
                  companion.current() === inner,
                  'RuntimeContextStorage interoperates without leaking frames',
                  'companion storage did not expose its own context'
                )
                await Promise.resolve()
                assert(
                  companion.current() === inner,
                  'RuntimeContextStorage interoperates without leaking frames',
                  'companion storage lost its context after Promise suspension'
                )
              })

              assert(
                storage.current() === outer,
                'RuntimeContextStorage interoperates without leaking frames',
                'companion storage leaked its frame into the primary storage'
              )
              expectMissingContext(
                await rejected(
                  Promise.resolve().then(() => companion.current()),
                  'RuntimeContextStorage interoperates without leaking frames',
                  'companion current() after its run() settled'
                ),
                options,
                'RuntimeContextStorage interoperates without leaking frames'
              )
            })

            expectMissingContext(
              await rejected(
                Promise.resolve().then(() => storage.current()),
                'RuntimeContextStorage interoperates without leaking frames',
                'primary current() after its run() settled'
              ),
              options,
              'RuntimeContextStorage interoperates without leaking frames'
            )
          } finally {
            try {
              await closeScopes(outerScope, innerScope)
            } finally {
              await options.cleanup?.(companion)
            }
          }
        })
      })
    )
  }

  return scenarios
}
