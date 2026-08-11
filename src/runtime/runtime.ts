import {
  buildLayer,
  type AnyLayer,
  type BuiltLayer,
  type CompleteLayer,
  type LayerProvided,
  type LayerBackend
} from '../layer'

import type { CompleteExecution } from '../layer/inference'

import type { AnyServiceToken } from '../service'

import { classifyRuntimeOutcome, type RuntimeOptions } from './outcome'

import type { ScopeOutcome } from '../scope'

export class Runtime<Provided extends AnyServiceToken = AnyServiceToken> {
  private constructor(private readonly built: BuiltLayer<Provided>) {}

  /** Create a long-lived Runtime that owns its Layer resources. */
  static async make<L extends AnyLayer>(
    layer: CompleteLayer<L>,
    backend: LayerBackend,
    options: RuntimeOptions = {}
  ): Promise<Runtime<LayerProvided<L>>> {
    const built = await buildLayer(layer, backend, options)

    return new Runtime<LayerProvided<L>>(built)
  }

  /** Run one program and dispose its Layer resources before resolving. */
  static async run<A, L extends AnyLayer>(
    layer: CompleteLayer<L>,
    backend: LayerBackend,
    program: CompleteExecution<LayerProvided<L>, A>,
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
    return this.built.run(program)
  }

  private runUnchecked<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>> {
    return this.built.run(program as CompleteExecution<Provided, A>)
  }

  /** Stop new executions and release the Runtime's Layer resources. */
  dispose(): Promise<void> {
    return this.built.dispose()
  }

  private disposeWithOutcome(outcome: ScopeOutcome): Promise<void> {
    return this.built.dispose(outcome)
  }
}
