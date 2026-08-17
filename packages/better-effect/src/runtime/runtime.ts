import type { LayerBackend } from '../layer'

import { createRuntimeHandle, type RuntimeHandle } from '../layer/runtime'

import type { LayerInput, CompleteInput, ProvidedEnvironment } from '../layer/inference'

import type { CompleteExecution } from '../layer/inference'

import type { AnyService } from '../service'

import {
  classifyRuntimeOutcome,
  type RuntimeOptions,
  type RuntimeShutdownDiagnostic
} from './outcome'

import type { ScopeOutcome } from '../scope'

import type { RuntimeFor } from './types'

/**
 * Long-lived execution environment backed by a complete Layer.
 *
 * A Runtime owns Layer resources until `dispose()` is called. Each `run()` is
 * isolated in a child Scope, while Layer-scoped resources remain shared.
 *
 * @example
 * ```ts
 * const runtime = await Runtime.make(AppLive, new MemoryLayerBackend())
 * const result = await runtime.run(loadUser('u1'))
 * await runtime.dispose()
 * ```
 *
 * @typeParam Provided The branded Service instances supplied by the Layer.
 */
export class Runtime<Provided extends AnyService = any> {
  private constructor(private readonly handle: RuntimeHandle<any>) {}

  /**
   * Create a long-lived Runtime that owns its Layer resources.
   *
   * @example
   * ```ts
   * const runtime = await Runtime.make(AppLive, backend)
   * const result = await runtime.run(program)
   * await runtime.dispose()
   * ```
   */
  static async make<L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backend: LayerBackend,
    options: RuntimeOptions = {}
  ): Promise<Runtime<ProvidedEnvironment<L>>> {
    const handle = await createRuntimeHandle(layer, backend, options)

    return new Runtime<ProvidedEnvironment<L>>(handle)
  }

  /**
   * Run one program and dispose its Layer resources before resolving.
   *
   * This is convenient for request-style or command-style execution where a
   * Runtime should not outlive the operation.
   */
  static async run<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backend: LayerBackend,
    program: CompleteExecution<ProvidedEnvironment<L>, A>,
    options: RuntimeOptions = {}
  ): Promise<Awaited<A>> {
    const runtime = await Runtime.make(layer, backend, options)

    let value!: Awaited<A>
    let executionFailed = false
    let executionFailure: unknown
    let programOutcome: ScopeOutcome | undefined

    try {
      value = await runtime.runUnchecked(async () => {
        try {
          const programValue = await program()

          programOutcome = classifyRuntimeOutcome(programValue)

          return programValue
        } catch (cause) {
          programOutcome = {
            status: 'failure',
            cause
          }

          throw cause
        }
      })
    } catch (cause) {
      executionFailed = true
      executionFailure = cause
    }

    const outcome: ScopeOutcome =
      programOutcome ??
      ({
        status: 'failure',
        cause: executionFailure
      } as const)

    try {
      await runtime.disposeWithOutcome(outcome)
    } catch (shutdownFailure) {
      if (!executionFailed && outcome.status === 'success') {
        throw shutdownFailure
      }
    }

    if (executionFailed) {
      throw executionFailure
    }

    return value
  }

  /** Run one execution in this Runtime's child Scope. */
  run<A>(program: CompleteExecution<Provided, A>): Promise<Awaited<A>> {
    return this.handle.run(program)
  }

  private runUnchecked<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>> {
    // SAFETY: One-shot Runtime.run performs the same complete-program validation at its public boundary before using this internal escape hatch.
    return this.handle.run(program as CompleteExecution<Provided, A>)
  }

  /** Stop new executions and release the Runtime's Layer resources. */
  dispose(): Promise<void> {
    return this.handle.dispose()
  }

  private disposeWithOutcome(outcome: ScopeOutcome): Promise<void> {
    return this.handle.dispose(outcome)
  }
}

/** Type-level aliases for naming Runtime handles and shutdown options. */
export declare namespace Runtime {
  /** Name a Runtime type from a concrete Layer. */
  export type For<L extends LayerInput> = RuntimeFor<L>

  /** Optional Runtime shutdown configuration. */
  export type Options = RuntimeOptions

  /** Diagnostic reported for aggregated Runtime shutdown cleanup failures. */
  export type ShutdownDiagnostic = RuntimeShutdownDiagnostic
}
