import { captureServiceTag } from '../service/tag'
import type { AnyService, AnyServiceToken, ServiceResolver } from '../service'

import { Scope, type CloseableScope } from '../scope'
import { runScoped } from '../scope/internal'
import { ScopeRuntime } from '../scope/runtime'

import {
  getRuntimeContext,
  makeRuntimeContext,
  runRuntimeContext,
  type RuntimeContextStorage
} from '../runtime/context'

import {
  createRuntimeExecutor,
  eraseRuntimeExecutor,
  type RuntimeExecutor
} from '../runtime/executor'

import { defaultRuntimeContextStorage } from '../runtime/default'

import {
  classifyRuntimeOutcome,
  type CleanupFailureObserver,
  type RuntimeDisposeOptions,
  type RuntimeOptions,
  type RuntimeRunOptions,
  type RuntimeShutdownDiagnostic
} from '../runtime/outcome'

import { linkAbortSignals, type AbortSignalLink } from '../runtime/signal'

import { LayerDisposeError, LayerRegistrationError } from './errors'
import { captureLayerRegistrationTag } from './registration'

import { createResolutionResolver } from './resolution'

import { getProgramName } from '../effect/program-metadata'
import type { ProgramIdentity } from '../effect/program-metadata'

import {
  makeRuntimeExecutionDependencies,
  type RuntimeExecutionDependencies,
  type RuntimeExecutionDependencyOverrides
} from '../runtime/execution'

import { notifyRuntimeObservers } from '../runtime/observer'

import type {
  RuntimeExecutionAttributes,
  RuntimeExecutionEndEvent,
  RuntimeExecutionMetadata,
  RuntimeObserver,
  RuntimeResourceReleaseEvent,
  RuntimeServiceAcquireEvent
} from '../runtime/observer'

import type { RuntimeInspection } from '../runtime/types'

import type { LayerBackend } from './backend'

import { MapLayerBackend } from './map-layer-backend'

import type {
  CompleteExecution,
  CompleteExecutionLayer,
  CompleteInput,
  LayerInput,
  ProvidedEnvironment
} from './inference'

import type { LayerRegistration } from './types'

import type {
  CleanupFailureDiagnostic,
  ScopeCloseError,
  ScopeFinalizer,
  ScopeOutcome
} from '../scope'

type LayerProvider = LayerInput['providers'][number]

interface RuntimeHandleCore<Provided extends AnyService> {
  /** The backend used to resolve this Layer's providers. */
  readonly backend: LayerBackend

  /** Run a program in a child Scope of the Layer's root Scope. */
  run<A>(program: CompleteExecution<Provided, A>, options?: RuntimeRunOptions): Promise<Awaited<A>>

  /** Run a program with providers owned by that execution's child Scope. */
  runWith<Request extends LayerInput, A>(
    layer: Request & CompleteExecutionLayer<Provided, Request>,
    program: CompleteExecution<Provided | ProvidedEnvironment<Request>, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>>

  /** Resolve every registered provider before accepting normal executions. */
  warmup(): Promise<void>

  /** Return a detached diagnostic snapshot without changing Runtime state. */
  inspect(): RuntimeInspection

  /** Stop new executions and release Layer-owned resources. */
  dispose(input?: RuntimeDisposeOptions | ScopeOutcome): Promise<void>
}

/** Runtime-facing handle that owns a Layer's resources and execution scopes. */
export type RuntimeHandle<Provided extends AnyService = any> = RuntimeHandleCore<Provided>

const SCOPE_SUCCESS: ScopeOutcome = Object.freeze({ status: 'success' })

class RuntimeHandleDisposedError extends Error {
  constructor() {
    super('Cannot run a program using a disposed Layer')

    this.name = 'RuntimeHandleDisposedError'
  }
}

const normalizeDisposeCauses = (cause: unknown): readonly unknown[] => {
  if (cause instanceof AggregateError) {
    return [...cause.errors]
  }

  return [cause]
}

const isScopeOutcome = (
  input: RuntimeDisposeOptions | ScopeOutcome | undefined
): input is ScopeOutcome => input !== undefined && 'status' in input

const validateDisposeOptions = (options: RuntimeDisposeOptions): void => {
  const { gracePeriod } = options

  if (gracePeriod !== undefined && (!Number.isFinite(gracePeriod) || gracePeriod < 0)) {
    throw new RangeError('Runtime dispose gracePeriod must be a finite non-negative number')
  }
}

type ActiveExecution = {
  readonly promise: Promise<unknown>
  readonly metadata: RuntimeExecutionMetadata
}

type MutableRuntimeExecutionInspection = {
  executionId: string
  startedAt: number
  name?: string
}

const copyExecutionAttributes = (
  attributes: RuntimeExecutionAttributes | undefined
): RuntimeExecutionAttributes | undefined => {
  if (attributes === undefined) {
    return undefined
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validate JavaScript callers at the Runtime boundary.
  if (typeof attributes !== 'object' || attributes === null) {
    throw new TypeError('Runtime execution attributes must be an object')
  }

  return Object.freeze({ ...attributes })
}

type MutableRuntimeExecutionMetadata = {
  executionId: string
  startedAt: number
  name?: string
  attributes?: RuntimeExecutionAttributes
}

type PreparedExecution = {
  readonly metadata: RuntimeExecutionMetadata
  readonly signalLink: AbortSignalLink
}

const prepareExecution = <ProgramValue>(
  program: () => ProgramValue | PromiseLike<ProgramValue>,
  options: RuntimeRunOptions | undefined,
  dependencies: RuntimeExecutionDependencies,
  runtimeSignal: AbortSignal | undefined,
  shutdownSignal: AbortSignal
): PreparedExecution => ({
  metadata: makeExecutionMetadata(program, options?.attributes, dependencies),
  signalLink: linkAbortSignals(runtimeSignal, options?.signal, shutdownSignal)
})

const makeExecutionMetadata = (
  program: ProgramIdentity,
  attributes: RuntimeExecutionAttributes | undefined,
  dependencies: RuntimeExecutionDependencies
): RuntimeExecutionMetadata => {
  const name = getProgramName(program)
  const copiedAttributes = copyExecutionAttributes(attributes)

  const metadata: MutableRuntimeExecutionMetadata = {
    executionId: dependencies.createExecutionId(),
    startedAt: dependencies.now()
  }

  if (name !== undefined) {
    metadata.name = name
  }

  if (copiedAttributes !== undefined) {
    metadata.attributes = copiedAttributes
  }

  return Object.freeze(metadata)
}

const executionDuration = (
  metadata: RuntimeExecutionMetadata,
  dependencies: RuntimeExecutionDependencies
): number => {
  try {
    const elapsed = dependencies.now() - metadata.startedAt

    return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0
  } catch {
    return 0
  }
}

const notifyShutdownFailure = async (
  observer: CleanupFailureObserver | undefined,
  diagnostic: RuntimeShutdownDiagnostic
): Promise<void> => {
  if (!observer) {
    return
  }

  try {
    await observer(diagnostic)
  } catch {
    // Shutdown diagnostics are best effort and never affect the primary result.
  }
}

const releaseLayerResource = async (
  service: LayerProvider['service'],
  release: ScopeFinalizer,
  outcome: ScopeOutcome,
  observers: readonly RuntimeObserver[],
  executionId: string | undefined
): Promise<void> => {
  try {
    await release(outcome)
    const event: RuntimeResourceReleaseEvent = { service, outcome }

    if (executionId !== undefined) {
      Object.assign(event, { executionId })
    }

    notifyRuntimeObservers(observers, (observer) => observer.onResourceRelease, event)
  } catch (cause) {
    const event: RuntimeResourceReleaseEvent = { service, outcome, error: cause }

    if (executionId !== undefined) {
      Object.assign(event, { executionId })
    }

    notifyRuntimeObservers(observers, (observer) => observer.onResourceRelease, event)
    throw cause
  }
}

const bindProviderToScope = (
  provider: LayerProvider,
  scope: CloseableScope,
  contextStorage: RuntimeContextStorage,
  resolver: ServiceResolver,
  observers: readonly RuntimeObserver[],
  executor: RuntimeExecutor<AnyService>,
  ownerExecutionId?: string
): LayerRegistration => ({
  service: provider.service,
  serviceTag: provider.serviceTag,

  acquire: () => {
    const current = getRuntimeContext(contextStorage)
    const executionId = current?.executionId ?? ownerExecutionId
    const context = makeRuntimeContext(
      resolver,
      scope,
      current?.resolutionPath ?? [],
      current?.signal,
      current,
      undefined,
      executor
    )

    return runRuntimeContext(contextStorage, context, () =>
      ScopeRuntime.run(
        scope,
        async () => {
          const resolutionPath = current?.resolutionPath ?? [provider.service]

          try {
            const instance = provider.acquireWithRelease
              ? (
                  await scope.acquire(provider.acquireWithRelease, (acquired, outcome) =>
                    releaseLayerResource(
                      provider.service,
                      acquired.release,
                      outcome,
                      observers,
                      ownerExecutionId
                    )
                  )
                ).instance
              : provider.release
                ? await scope.acquire(
                    () => provider.acquire(),
                    (resource, outcome) =>
                      releaseLayerResource(
                        provider.service,
                        (releaseOutcome) => provider.release!(resource, releaseOutcome),
                        outcome,
                        observers,
                        ownerExecutionId
                      )
                  )
                : await provider.acquire()

            const event: RuntimeServiceAcquireEvent = {
              service: provider.service,
              resolutionPath,
              outcome: SCOPE_SUCCESS
            }

            if (executionId !== undefined) {
              Object.assign(event, { executionId })
            }

            notifyRuntimeObservers(observers, (observer) => observer.onServiceAcquire, event)

            return instance
          } catch (cause) {
            const event: RuntimeServiceAcquireEvent = {
              service: provider.service,
              resolutionPath,
              outcome: {
                status: 'failure',
                cause
              }
            }

            if (executionId !== undefined) {
              Object.assign(event, { executionId })
            }

            notifyRuntimeObservers(observers, (observer) => observer.onServiceAcquire, event)
            throw cause
          }
        },
        contextStorage
      )
    )
  }
})

/** Resolve request-local providers first, then fall back to the Runtime root. */
class ExecutionLayerBackend implements LayerBackend {
  private readonly localTags = new Set<string>()

  constructor(
    private readonly local: MapLayerBackend,
    private readonly root: LayerBackend
  ) {}

  register(registration: LayerRegistration): void {
    this.localTags.add(captureLayerRegistrationTag(registration))
    this.local.register(registration)
  }

  async resolve<T extends AnyServiceToken>(token: T): Promise<InstanceType<T>> {
    const tag = captureServiceTag(token)

    if (this.localTags.has(tag)) {
      return await this.local.resolve(token)
    }

    return await this.root.resolve(token)
  }

  async disposeAll(): Promise<void> {
    await this.local.disposeAll()
    this.localTags.clear()
  }
}

class RuntimeHandleImpl<Provided extends AnyService> implements RuntimeHandleCore<Provided> {
  private disposePromise: Promise<void> | undefined

  private warmupPromise: Promise<void> | undefined

  private readonly executions = new Set<ActiveExecution>()

  private readonly serviceTags: readonly string[]

  private readonly shutdownController = new AbortController()

  private state: 'active' | 'disposing' | 'disposed' = 'active'

  private warmupState: RuntimeInspection['warmup'] = 'idle'

  constructor(
    readonly backend: LayerBackend,
    private readonly resolver: ServiceResolver,
    private readonly rootScope: CloseableScope,
    private readonly onCleanupFailure: CleanupFailureObserver | undefined,
    private readonly contextStorage: RuntimeContextStorage,
    private readonly signal: AbortSignal | undefined,
    private readonly observers: readonly RuntimeObserver[],
    private readonly services: readonly AnyServiceToken[],
    serviceTags: readonly string[],
    private readonly executionDependencies: RuntimeExecutionDependencies,
    private readonly executor: RuntimeExecutor<AnyService>
  ) {
    this.serviceTags = Object.freeze([...serviceTags])
  }

  inspect(): RuntimeInspection {
    const executions = Object.freeze(
      [...this.executions].map(({ metadata }) => {
        const inspection: MutableRuntimeExecutionInspection = {
          executionId: metadata.executionId,
          startedAt: metadata.startedAt
        }

        if (metadata.name !== undefined) {
          inspection.name = metadata.name
        }

        return Object.freeze(inspection)
      })
    )

    return Object.freeze({
      state: this.state,
      warmup: this.warmupState,
      activeExecutions: executions.length,
      executions,
      services: Object.freeze([...this.serviceTags]),
      shutdownSignalAborted: this.shutdownController.signal.aborted
    })
  }

  run<A>(
    program: CompleteExecution<Provided, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>> {
    this.assertActive()

    let prepared: PreparedExecution

    try {
      prepared = prepareExecution(
        program,
        options,
        this.executionDependencies,
        this.signal,
        this.shutdownController.signal
      )
    } catch (cause) {
      return Promise.reject(cause)
    }

    try {
      this.assertActive()
    } catch (cause) {
      prepared.signalLink.dispose()
      throw cause
    }

    let executionScope: CloseableScope

    try {
      executionScope = this.rootScope.fork()
    } catch (cause) {
      prepared.signalLink.dispose()
      throw cause
    }

    return this.startExecution<Awaited<A>>(prepared.signalLink, prepared.metadata, () =>
      this.runExecution(
        executionScope,
        program,
        this.resolver,
        prepared.signalLink.signal,
        prepared.metadata
      )
    )
  }

  runWith<Request extends LayerInput, A>(
    layer: Request & CompleteExecutionLayer<Provided, Request>,
    program: CompleteExecution<Provided | ProvidedEnvironment<Request>, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>> {
    this.assertActive()

    let prepared: PreparedExecution

    try {
      prepared = prepareExecution(
        program,
        options,
        this.executionDependencies,
        this.signal,
        this.shutdownController.signal
      )
    } catch (cause) {
      return Promise.reject(cause)
    }

    try {
      this.assertActive()
    } catch (cause) {
      prepared.signalLink.dispose()
      throw cause
    }

    const localBackend = new MapLayerBackend()
    const backend = new ExecutionLayerBackend(localBackend, this.backend)
    const resolver = createResolutionResolver(backend, this.contextStorage, this.observers)
    let executionScope: CloseableScope

    try {
      executionScope = this.rootScope.fork()
    } catch (cause) {
      prepared.signalLink.dispose()
      throw cause
    }

    return this.startExecution<Awaited<A>>(
      prepared.signalLink,
      prepared.metadata,
      async (): Promise<Awaited<A>> => {
        try {
          return await this.runExecution<Awaited<A>>(
            executionScope,
            async (): Promise<Awaited<A>> => {
              for (const provider of layer.providers) {
                backend.register(
                  bindProviderToScope(
                    provider,
                    executionScope,
                    this.contextStorage,
                    resolver,
                    this.observers,
                    this.executor,
                    prepared.metadata.executionId
                  )
                )
              }

              return await program()
            },
            resolver,
            prepared.signalLink.signal,
            prepared.metadata
          )
        } finally {
          await localBackend.disposeAll()
        }
      }
    )
  }

  warmup(): Promise<void> {
    this.assertActive()

    if (this.warmupPromise) {
      return this.warmupPromise
    }

    this.warmupState = 'running'

    let warmup: Promise<void>

    try {
      warmup = runRuntimeContext(
        this.contextStorage,
        makeRuntimeContext(
          this.resolver,
          this.rootScope,
          [],
          this.signal,
          undefined,
          undefined,
          this.executor
        ),
        async () => {
          for (const service of this.services) {
            await this.resolver.resolve(service)
          }
        }
      )
    } catch (cause) {
      this.warmupState = 'failed'
      return Promise.reject(cause)
    }

    this.warmupPromise = warmup

    void warmup.then(
      () => {
        if (this.warmupPromise === warmup) {
          this.warmupState = 'completed'
          this.warmupPromise = undefined
        }
      },
      () => {
        if (this.warmupPromise === warmup) {
          this.warmupState = 'failed'
          this.warmupPromise = undefined
        }
      }
    )

    return warmup
  }

  private startExecution<A>(
    signalLink: AbortSignalLink,
    metadata: RuntimeExecutionMetadata,
    run: (metadata: RuntimeExecutionMetadata) => PromiseLike<A>
  ): Promise<A> {
    let resolveExecution!: (value: A | PromiseLike<A>) => void
    let rejectExecution!: (cause?: unknown) => void

    const execution = new Promise<A>((resolve, reject) => {
      resolveExecution = resolve
      rejectExecution = reject
    })

    const activeExecution: ActiveExecution = { promise: execution, metadata }

    this.executions.add(activeExecution)

    void execution.then(
      () => {
        this.executions.delete(activeExecution)
        signalLink.dispose()
      },
      () => {
        this.executions.delete(activeExecution)
        signalLink.dispose()
      }
    )

    try {
      const running = run(metadata)

      void running.then(
        (value) => {
          resolveExecution(value)
        },
        (cause) => {
          rejectExecution(cause)
        }
      )
    } catch (cause) {
      rejectExecution(cause)
    }

    return execution
  }

  private runExecution<A>(
    executionScope: CloseableScope,
    program: () => A | PromiseLike<A>,
    resolver: ServiceResolver = this.resolver,
    signal: AbortSignal = this.shutdownController.signal,
    metadata: RuntimeExecutionMetadata
  ): Promise<Awaited<A>> {
    let outcome: ScopeOutcome | undefined
    let cleanupFailure: ScopeCloseError | undefined
    const onOutcome = (determinedOutcome: ScopeOutcome): void => {
      outcome = determinedOutcome
    }
    const onExecutionCleanupFailure = async (
      diagnostic: CleanupFailureDiagnostic
    ): Promise<void> => {
      cleanupFailure = diagnostic.error

      if (this.onCleanupFailure !== undefined) {
        await this.onCleanupFailure(diagnostic)
      }
    }
    const runOptions = {
      classify: classifyRuntimeOutcome,
      onOutcome,
      onCleanupFailure: onExecutionCleanupFailure
    }

    const startEvent = Object.freeze({
      ...metadata,
      scope: executionScope
    })
    notifyRuntimeObservers(this.observers, (observer) => observer.onExecutionStart, startEvent)

    let ended = false
    const notifyEnd = (finalOutcome: ScopeOutcome): void => {
      if (ended) {
        return
      }

      ended = true
      const endEvent: RuntimeExecutionEndEvent = {
        ...metadata,
        scope: executionScope,
        outcome: finalOutcome,
        durationMs: executionDuration(metadata, this.executionDependencies)
      }

      if (cleanupFailure !== undefined) {
        Object.assign(endEvent, { cleanupFailure })
      }

      notifyRuntimeObservers(
        this.observers,
        (observer) => observer.onExecutionEnd,
        Object.freeze(endEvent)
      )
    }

    let execution: Promise<Awaited<A>>

    try {
      execution = runScoped(executionScope, program, {
        ...runOptions,
        contextStorage: this.contextStorage,
        context: makeRuntimeContext(
          resolver,
          executionScope,
          [],
          signal,
          undefined,
          metadata.executionId,
          this.executor
        )
      })
    } catch (cause) {
      const failure: ScopeOutcome = {
        status: 'failure',
        cause
      }
      notifyEnd(failure)
      return Promise.reject(cause)
    }

    return execution.then(
      (value) => {
        notifyEnd(
          outcome ?? {
            status: 'success'
          }
        )
        return value
      },
      (cause) => {
        notifyEnd(
          outcome ?? {
            status: 'failure',
            cause
          }
        )
        throw cause
      }
    )
  }

  dispose(input?: RuntimeDisposeOptions | ScopeOutcome): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }

    const outcome =
      isScopeOutcome(input) || input === undefined ? (input ?? SCOPE_SUCCESS) : SCOPE_SUCCESS
    const options = isScopeOutcome(input) || input === undefined ? {} : input

    validateDisposeOptions(options)
    this.state = 'disposing'

    const executions = [...this.executions]

    this.disposePromise = this.performDispose(executions, outcome, options)

    return this.disposePromise
  }

  private async performDispose(
    executions: readonly ActiveExecution[],
    outcome: ScopeOutcome,
    options: RuntimeDisposeOptions
  ): Promise<void> {
    const failures: unknown[] = []

    await Promise.allSettled(this.warmupPromise ? [this.warmupPromise] : [])
    await this.waitForExecutions(executions, options)

    try {
      const signalLink = linkAbortSignals(this.signal, this.shutdownController.signal)

      try {
        await runRuntimeContext(
          this.contextStorage,
          makeRuntimeContext(
            this.resolver,
            this.rootScope,
            [],
            signalLink.signal,
            undefined,
            undefined,
            this.executor
          ),
          () => this.rootScope.close(outcome)
        )
      } finally {
        signalLink.dispose()
      }
    } catch (cause) {
      failures.push(cause)
    }

    try {
      await this.backend.disposeAll()
    } catch (cause) {
      failures.push(cause)
    }

    this.state = 'disposed'

    if (failures.length > 0) {
      const error = new LayerDisposeError(failures.flatMap(normalizeDisposeCauses))

      await notifyShutdownFailure(this.onCleanupFailure, {
        outcome,
        error
      })

      throw error
    }
  }

  private async waitForExecutions(
    executions: readonly ActiveExecution[],
    options: RuntimeDisposeOptions
  ): Promise<void> {
    const settled = Promise.allSettled(executions.map((execution) => execution.promise))

    if (options.abortAfterGracePeriod !== true || executions.length === 0) {
      await settled
      return
    }

    const gracePeriod = options.gracePeriod ?? 0
    let timer: ReturnType<typeof setTimeout> | undefined

    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), gracePeriod)
      })
    ])

    if (timer !== undefined) {
      clearTimeout(timer)
    }

    if (timedOut && !this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new Error('Runtime shutdown grace period exceeded'))
    }

    await settled
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new RuntimeHandleDisposedError()
    }
  }
}

/** Build a Runtime handle for a complete Layer and register its providers. */
export const createRuntimeHandle = async <L extends LayerInput>(
  layer: L & CompleteInput<L>,
  backend: LayerBackend,
  options: RuntimeOptions = {},
  executionOverrides: RuntimeExecutionDependencyOverrides = {},
  providedExecutor?: RuntimeExecutor<ProvidedEnvironment<L>>
): Promise<RuntimeHandle<ProvidedEnvironment<L>>> => {
  const services = layer.providers.map((provider) => provider.service)
  const serviceTags = layer.providers.map((provider) => captureLayerRegistrationTag(provider))
  const rootScope = Scope.make()
  const contextStorage = options.contextStorage ?? defaultRuntimeContextStorage
  const observers = options.observers ?? []
  const resolver = createResolutionResolver(backend, contextStorage, observers)
  const executionDependencies = makeRuntimeExecutionDependencies(executionOverrides)
  ScopeRuntime.bind(rootScope, contextStorage)
  let handle!: RuntimeHandleImpl<ProvidedEnvironment<L>>
  const executor =
    providedExecutor ??
    createRuntimeExecutor<ProvidedEnvironment<L>>({
      run: (program, runOptions) => handle.run(program, runOptions),
      runWith: (request, program, runOptions) => handle.runWith(request, program, runOptions)
    })
  const contextExecutor = eraseRuntimeExecutor(executor)
  let current: LayerProvider | undefined

  try {
    for (const provider of layer.providers) {
      current = provider

      await backend.register(
        bindProviderToScope(
          provider,
          rootScope,
          contextStorage,
          resolver,
          observers,
          contextExecutor
        )
      )
    }
  } catch (registrationCause) {
    const outcome: ScopeOutcome = {
      status: 'failure',
      cause: registrationCause
    }
    const cleanupCauses: unknown[] = []

    try {
      await runRuntimeContext(
        contextStorage,
        makeRuntimeContext(
          resolver,
          rootScope,
          [],
          options.signal,
          undefined,
          undefined,
          contextExecutor
        ),
        () => rootScope.close(outcome)
      )
    } catch (cause) {
      cleanupCauses.push(cause)
    }

    try {
      await backend.disposeAll()
    } catch (cause) {
      cleanupCauses.push(cause)
    }

    if (cleanupCauses.length > 0) {
      const shutdownError = new LayerDisposeError(cleanupCauses.flatMap(normalizeDisposeCauses))

      await notifyShutdownFailure(options.onCleanupFailure, {
        outcome,
        error: shutdownError
      })
    }

    const cleanupCause =
      cleanupCauses.length === 1
        ? cleanupCauses[0]
        : cleanupCauses.length > 1
          ? new LayerDisposeError(cleanupCauses.flatMap(normalizeDisposeCauses))
          : undefined

    throw new LayerRegistrationError(current?.service, registrationCause, cleanupCause)
  }

  handle = new RuntimeHandleImpl<ProvidedEnvironment<L>>(
    backend,
    resolver,
    rootScope,
    options.onCleanupFailure,
    contextStorage,
    options.signal,
    observers,
    services,
    serviceTags,
    executionDependencies,
    contextExecutor
  )

  return handle
}
