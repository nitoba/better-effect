import { ServiceRuntime } from '../service'

import type { AnyServiceToken } from '../service'

import { Scope, type CloseableScope } from '../scope'
import { runScoped } from '../scope/internal'
import { ScopeRuntime } from '../scope/runtime'

import {
  classifyRuntimeOutcome,
  type CleanupFailureObserver,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic
} from '../runtime/outcome'

import { BuiltLayerDisposedError, LayerDisposeError, LayerRegistrationError } from './errors'

import type { LayerBackend } from './backend'

import type { AnyLayer, CompleteExecution, CompleteLayer, LayerProvided } from './inference'

import type { LayerRegistration } from './types'

import type { ScopeOutcome } from '../scope'

type LayerProvider = AnyLayer['providers'][number]

/**
 * Low-level Layer handle retained for adapter and test integrations.
 *
 * @deprecated Prefer `Runtime.make()` for the public managed runtime API.
 */
export interface BuiltLayer<Provided extends AnyServiceToken = AnyServiceToken> {
  readonly backend: LayerBackend

  run<A>(program: CompleteExecution<Provided, A>): Promise<Awaited<A>>

  dispose(outcome?: ScopeOutcome): Promise<void>
}

const SCOPE_SUCCESS: ScopeOutcome = Object.freeze({ status: 'success' })

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
  rootScope: CloseableScope
): LayerRegistration => ({
  service: provider.service,

  acquire: () =>
    ScopeRuntime.run(rootScope, async () => {
      if (!provider.release) {
        return await provider.acquire()
      }

      return await rootScope.acquire(
        () => provider.acquire(),
        (resource, outcome) => provider.release!(resource, outcome)
      )
    })
})

class BuiltLayerImpl<Provided extends AnyServiceToken> implements BuiltLayer<Provided> {
  private disposePromise: Promise<void> | undefined

  private readonly executions = new Set<Promise<unknown>>()

  private state: 'active' | 'disposing' | 'disposed' = 'active'

  constructor(
    readonly backend: LayerBackend,
    private readonly rootScope: CloseableScope,
    private readonly onCleanupFailure: CleanupFailureObserver | undefined
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

    return runScoped(executionScope, () => ServiceRuntime.run(this.backend, program), options)
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
      await ServiceRuntime.run(this.backend, () => this.rootScope.close(outcome))
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
      throw new BuiltLayerDisposedError()
    }
  }
}

/**
 * Build a low-level Layer handle.
 *
 * @deprecated Prefer `Runtime.make()` for application code.
 */
export const buildLayer = async <L extends AnyLayer>(
  layer: CompleteLayer<L>,
  backend: LayerBackend,
  options: RuntimeOptions = {}
): Promise<BuiltLayer<LayerProvided<L>>> => {
  const rootScope = Scope.make()
  let current: LayerProvider | undefined

  try {
    for (const provider of layer.providers) {
      current = provider

      await backend.register(bindProviderToScope(provider, rootScope))
    }
  } catch (registrationCause) {
    const outcome: ScopeOutcome = {
      status: 'failure',
      cause: registrationCause
    }
    const cleanupCauses: unknown[] = []

    try {
      await ServiceRuntime.run(backend, () => rootScope.close(outcome))
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

    let cleanupCause: unknown

    if (cleanupCauses.length === 1) {
      cleanupCause = cleanupCauses[0]
    } else if (cleanupCauses.length > 1) {
      cleanupCause = new LayerDisposeError(cleanupCauses.flatMap(normalizeDisposeCauses))
    }

    throw new LayerRegistrationError(current?.service, registrationCause, cleanupCause)
  }

  return new BuiltLayerImpl<LayerProvided<L>>(backend, rootScope, options.onCleanupFailure)
}
