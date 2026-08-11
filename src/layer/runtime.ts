import { ServiceRuntime } from '../service'

import { Scope } from '../scope'
import { runScoped } from '../scope/internal'
import { ScopeRuntime } from '../scope/runtime'

import { BuiltLayerDisposedError, LayerDisposeError, LayerRegistrationError } from './errors'

import type { LayerBackend } from './backend'

import type { Layer } from './layer'

import type { LayerProvider } from './types'

export interface BuiltLayer {
  readonly backend: LayerBackend

  run<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>>

  dispose(): Promise<void>
}

const normalizeDisposeCauses = (cause: unknown): readonly unknown[] => {
  if (cause instanceof AggregateError) {
    return [...cause.errors]
  }

  return [cause]
}

const bindProviderToScope = (provider: LayerProvider, rootScope: Scope): LayerProvider => ({
  service: provider.service,

  acquire: () =>
    ScopeRuntime.run(rootScope, async () => {
      if (!provider.release) {
        return await provider.acquire()
      }

      return await rootScope.acquire(
        () => provider.acquire(),
        (resource) => provider.release!(resource)
      )
    })
})

class BuiltLayerImpl implements BuiltLayer {
  private disposePromise: Promise<void> | undefined

  private readonly executions = new Set<Promise<unknown>>()

  private state: 'active' | 'disposing' | 'disposed' = 'active'

  constructor(
    readonly backend: LayerBackend,
    private readonly rootScope: Scope
  ) {}

  run<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>> {
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
    executionScope: Scope,
    program: () => A | PromiseLike<A>
  ): Promise<Awaited<A>> {
    return runScoped(executionScope, () => ServiceRuntime.run(this.backend, program))
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise
    }

    this.state = 'disposing'

    const executions = [...this.executions]

    this.disposePromise = this.performDispose(executions)

    return this.disposePromise
  }

  private async performDispose(executions: readonly Promise<unknown>[]): Promise<void> {
    const failures: unknown[] = []

    await Promise.allSettled(executions)

    try {
      await ServiceRuntime.run(this.backend, () => this.rootScope.close())
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
      throw new LayerDisposeError(failures.flatMap(normalizeDisposeCauses))
    }
  }

  private assertActive(): void {
    if (this.state !== 'active') {
      throw new BuiltLayerDisposedError()
    }
  }
}

export const buildLayer = async (layer: Layer<any>, backend: LayerBackend): Promise<BuiltLayer> => {
  const rootScope = Scope.make()
  let current: LayerProvider | undefined

  try {
    for (const provider of layer.providers) {
      current = provider

      await backend.register(bindProviderToScope(provider, rootScope))
    }
  } catch (registrationCause) {
    const cleanupCauses: unknown[] = []

    try {
      await rootScope.close()
    } catch (cause) {
      cleanupCauses.push(cause)
    }

    try {
      await backend.disposeAll()
    } catch (cause) {
      cleanupCauses.push(cause)
    }

    let cleanupCause: unknown

    if (cleanupCauses.length === 1) {
      cleanupCause = cleanupCauses[0]
    } else if (cleanupCauses.length > 1) {
      cleanupCause = new AggregateError(cleanupCauses, 'Layer registration cleanup failed')
    }

    throw new LayerRegistrationError(current?.service, registrationCause, cleanupCause)
  }

  return new BuiltLayerImpl(backend, rootScope)
}
