import {
  buildLayer,
  type AnyLayer,
  type BuiltLayer,
  type CompleteLayer,
  type LayerBackend
} from '../layer'

import { classifyRuntimeOutcome, type RuntimeOptions } from './outcome'

import type { ScopeOutcome } from '../scope'

export class Runtime {
  private constructor(private readonly built: BuiltLayer) {}

  static async make<L extends AnyLayer>(
    layer: CompleteLayer<L>,
    backend: LayerBackend,
    options: RuntimeOptions = {}
  ): Promise<Runtime> {
    const built = await buildLayer(layer, backend, options)

    return new Runtime(built)
  }

  static async run<A, L extends AnyLayer>(
    layer: CompleteLayer<L>,
    backend: LayerBackend,
    program: () => A | PromiseLike<A>,
    options: RuntimeOptions = {}
  ): Promise<Awaited<A>> {
    const runtime = await Runtime.make(layer, backend, options)

    let value!: Awaited<A>
    let programFailed = false
    let programFailure: unknown
    let outcome: ScopeOutcome

    try {
      value = await runtime.run(program)
      outcome = classifyRuntimeOutcome(value)
    } catch (cause) {
      programFailed = true
      programFailure = cause
      outcome = {
        status: 'failure',
        cause
      }
    }

    try {
      await runtime.disposeWithOutcome(outcome)
    } catch (shutdownFailure) {
      if (!programFailed && outcome.status === 'success') {
        throw shutdownFailure
      }
    }

    if (programFailed) {
      throw programFailure
    }

    return value
  }

  run<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>> {
    return this.built.run(program)
  }

  dispose(): Promise<void> {
    return this.built.dispose()
  }

  private disposeWithOutcome(outcome: ScopeOutcome): Promise<void> {
    return this.built.dispose(outcome)
  }
}
