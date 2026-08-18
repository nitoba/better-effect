import type { AnyService, ServiceResolver } from '../service'

import { Scope, type CloseableScope } from '../scope'
import { runScoped } from '../scope/internal'
import { ScopeRuntime } from '../scope/runtime'

import {
  makeRuntimeContext,
  runRuntimeContext,
  type RuntimeContextStorage
} from '../runtime/context'

import { defaultRuntimeContextStorage } from '../runtime/default'

import {
  classifyRuntimeOutcome,
  type CleanupFailureObserver,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic
} from '../runtime/outcome'

import { LayerDisposeError, LayerRegistrationError } from './errors'

import { createResolutionResolver } from './resolution'

import type { LayerBackend } from './backend'

import type { LayerInput, CompleteExecution, CompleteInput, ProvidedEnvironment } from './inference'

import type { LayerRegistration } from './types'

import type { ScopeOutcome } from '../scope'

type LayerProvider = LayerInput['providers'][number]

interface RuntimeHandleCore<Provided extends AnyService> {
  /** The backend used to resolve this Layer's providers. */
  readonly backend: LayerBackend

  /** Run a program in a child Scope of the Layer's root Scope. */
  run<A>(program: CompleteExecution<Provided, A>): Promise<Awaited<A>>

  /** Stop new executions and release Layer-owned resources. */
  dispose(outcome?: ScopeOutcome): Promise<void>
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

const bindProviderToScope = (
  provider: LayerProvider,
  rootScope: CloseableScope,
  contextStorage: RuntimeContextStorage
): LayerRegistration => ({
  service: provider.service,

  acquire: () =>
    ScopeRuntime.run(
      rootScope,
      async () => {
        if (!provider.release) {
          return await provider.acquire()
        }

        return await rootScope.acquire(
          () => provider.acquire(),
          (resource, outcome) => provider.release!(resource, outcome)
        )
      },
      contextStorage
    )
})

class RuntimeHandleImpl<Provided extends AnyService> implements RuntimeHandleCore<Provided> {
  private disposePromise: Promise<void> | undefined

  private readonly executions = new Set<Promise<unknown>>()

  private state: 'active' | 'disposing' | 'disposed' = 'active'

  constructor(
    readonly backend: LayerBackend,
    private readonly resolver: ServiceResolver,
    private readonly rootScope: CloseableScope,
    private readonly onCleanupFailure: CleanupFailureObserver | undefined,
    private readonly contextStorage: RuntimeContextStorage,
    private readonly signal: AbortSignal | undefined
  ) {}

  run<A>(program: CompleteExecution<Provided, A>): Promise<Awaited<A>> {
    this.assertActive()

    const executionScope = this.rootScope.fork()

    let resolveExecution!: (value: Awaited<A> | PromiseLike<Awaited<A>>) => void
    let rejectExecution!: (cause?: unknown) => void

    const execution = new Promise<Awaited<A>>((resolve, reject) => {
      resolveExecution = resolve
      rejectExecution = reject
    })

    this.executions.add(execution)

    void execution.then(
      () => {
        this.executions.delete(execution)
      },
      () => {
        this.executions.delete(execution)
      }
    )

    try {
      const running = this.runExecution(executionScope, program)

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
    program: CompleteExecution<Provided, A>
  ): Promise<Awaited<A>> {
    const options = this.onCleanupFailure
      ? {
          classify: classifyRuntimeOutcome,
          onCleanupFailure: this.onCleanupFailure
        }
      : {
          classify: classifyRuntimeOutcome
        }

    return runScoped(executionScope, program, {
      ...options,
      contextStorage: this.contextStorage,
      context: makeRuntimeContext(this.resolver, executionScope, [], this.signal)
    })
  }

  dispose(outcome: ScopeOutcome = SCOPE_SUCCESS): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.state = 'disposing'

    const executions = [...this.executions]

    this.disposePromise = this.performDispose(executions, outcome)

    return this.disposePromise
  }

  private async performDispose(
    executions: readonly Promise<unknown>[],
    outcome: ScopeOutcome
  ): Promise<void> {
    const failures: unknown[] = []

    await Promise.allSettled(executions)

    try {
      await runRuntimeContext(
        this.contextStorage,
        makeRuntimeContext(this.resolver, this.rootScope, [], this.signal),
        () => this.rootScope.close(outcome)
      )
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
  options: RuntimeOptions = {}
): Promise<RuntimeHandle<ProvidedEnvironment<L>>> => {
  const rootScope = Scope.make()
  const contextStorage = options.contextStorage ?? defaultRuntimeContextStorage
  const resolver = createResolutionResolver(backend, contextStorage)
  ScopeRuntime.bind(rootScope, contextStorage)
  let current: LayerProvider | undefined

  try {
    for (const provider of layer.providers) {
      current = provider

      await backend.register(bindProviderToScope(provider, rootScope, contextStorage))
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
        makeRuntimeContext(resolver, rootScope, [], options.signal),
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

  return new RuntimeHandleImpl<ProvidedEnvironment<L>>(
    backend,
    resolver,
    rootScope,
    options.onCleanupFailure,
    contextStorage,
    options.signal
  )
}
