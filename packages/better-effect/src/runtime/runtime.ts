import type { LayerBackend } from '../layer'

import { MapLayerBackend } from '../layer/map-layer-backend'

import { createRuntimeHandle, type RuntimeHandle } from '../layer/runtime'

import type {
  CompleteExecutionLayer,
  LayerInput,
  CompleteInput,
  ProvidedEnvironment
} from '../layer/inference'

import type { CompleteExecution } from '../layer/inference'

import type { AnyService } from '../service'

import {
  classifyRuntimeOutcome,
  type RuntimeDisposeOptions,
  type RuntimeOptions,
  type RuntimeRunOptions,
  type RuntimeShutdownDiagnostic
} from './outcome'

import type { ScopeOutcome } from '../scope'

import type { RuntimeFor } from './types'

import type { RuntimeObserver } from './observer'

type RuntimeBackendInput = LayerBackend | RuntimeOptions | undefined

type RuntimeConfig = {
  readonly backend: LayerBackend
  readonly options: RuntimeOptions
}

const isLayerBackend = (value: RuntimeBackendInput): value is LayerBackend =>
  value !== undefined && 'register' in value && 'resolve' in value && 'disposeAll' in value

const resolveRuntimeConfig = (
  backendOrOptions: RuntimeBackendInput,
  legacyOptions?: RuntimeOptions
): RuntimeConfig => {
  if (isLayerBackend(backendOrOptions)) {
    return {
      backend: backendOrOptions,
      options: legacyOptions ?? {}
    }
  }

  const options = backendOrOptions ?? {}

  return {
    backend: options.backend ?? new MapLayerBackend(),
    options
  }
}

/**
 * Long-lived execution environment backed by a complete Layer.
 *
 * A Runtime owns Layer resources until `dispose()` is called. Each `run()` is
 * isolated in a child Scope, while Layer-scoped resources remain shared.
 *
 * @example
 * ```ts
 * const runtime = await Runtime.make(AppLive)
 * const result = await runtime.run(loadUser('u1'))
 * await runtime.dispose()
 * ```
 *
 * @typeParam Provided The branded Service instances supplied by the Layer.
 */
export class Runtime<Provided extends AnyService = any> {
  private constructor(private readonly handle: RuntimeHandle<Provided>) {}

  /**
   * Create a long-lived Runtime that owns its Layer resources.
   *
   * @example
   * ```ts
   * const runtime = await Runtime.make(AppLive)
   * const result = await runtime.run(program)
   * await runtime.dispose()
   * ```
   */
  static make<L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backend: LayerBackend,
    options?: RuntimeOptions
  ): Promise<Runtime<ProvidedEnvironment<L>>>

  static make<L extends LayerInput>(
    layer: L & CompleteInput<L>,
    options?: RuntimeOptions
  ): Promise<Runtime<ProvidedEnvironment<L>>>

  static async make<L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backendOrOptions?: LayerBackend | RuntimeOptions,
    legacyOptions?: RuntimeOptions
  ): Promise<Runtime<ProvidedEnvironment<L>>> {
    const { backend, options } = resolveRuntimeConfig(backendOrOptions, legacyOptions)
    const handle = await createRuntimeHandle(layer, backend, options)
    const runtime = new Runtime<ProvidedEnvironment<L>>(handle)

    if (options.warmup) {
      await runtime.warmup()
    }

    return runtime
  }

  /**
   * Run one program and dispose its Layer resources before resolving.
   *
   * This is convenient for request-style or command-style execution where a
   * Runtime should not outlive the operation.
   */
  static run<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backend: LayerBackend,
    program: CompleteExecution<ProvidedEnvironment<L>, A>,
    options?: RuntimeOptions
  ): Promise<Awaited<A>>

  static run<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    program: CompleteExecution<ProvidedEnvironment<L>, A>,
    options?: RuntimeOptions
  ): Promise<Awaited<A>>

  static run<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    options: RuntimeOptions,
    program: CompleteExecution<ProvidedEnvironment<L>, A>
  ): Promise<Awaited<A>>

  static async run<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    backendOrProgramOrOptions:
      | LayerBackend
      | RuntimeOptions
      | CompleteExecution<ProvidedEnvironment<L>, A>,
    programOrOptions?: CompleteExecution<ProvidedEnvironment<L>, A> | RuntimeOptions,
    legacyOptions?: RuntimeOptions
  ): Promise<Awaited<A>> {
    let program: CompleteExecution<ProvidedEnvironment<L>, A>
    let backendOrOptions: RuntimeBackendInput
    let options: RuntimeOptions | undefined

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch needs to distinguish a Program callback from configuration.
    if (typeof backendOrProgramOrOptions === 'function') {
      program = backendOrProgramOrOptions
      // SAFETY: The function overload branch establishes that this argument is the optional RuntimeOptions value.
      backendOrOptions = programOrOptions as RuntimeOptions | undefined
      options = undefined
    } else {
      backendOrOptions = backendOrProgramOrOptions
      // SAFETY: The non-function overload branch establishes that this argument is the complete execution callback.
      program = programOrOptions as CompleteExecution<ProvidedEnvironment<L>, A>
      options = legacyOptions
    }

    const config = resolveRuntimeConfig(backendOrOptions, options)
    let programOutcome: ScopeOutcome | undefined
    const outcomeObserver: RuntimeObserver = {
      onExecutionEnd: ({ outcome }) => {
        programOutcome = outcome
      }
    }
    const runtimeOptions: RuntimeOptions = {
      ...config.options,
      observers: [outcomeObserver, ...(config.options.observers ?? [])]
    }
    const runtime = await Runtime.make(layer, config.backend, runtimeOptions)

    let value!: Awaited<A>
    let executionFailed = false
    let executionFailure: unknown

    try {
      value = await runtime.runUnchecked(program)
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

  /** Run a callback with a managed Runtime and always dispose it afterward. */
  static use<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    use: (runtime: Runtime<ProvidedEnvironment<L>>) => A | PromiseLike<A>,
    options?: RuntimeOptions
  ): Promise<Awaited<A>>

  static async use<A, L extends LayerInput>(
    layer: L & CompleteInput<L>,
    use: (runtime: Runtime<ProvidedEnvironment<L>>) => A | PromiseLike<A>,
    options?: RuntimeOptions
  ): Promise<Awaited<A>> {
    const runtime = await Runtime.make(layer, options)

    let value!: Awaited<A>
    let executionFailed = false
    let executionFailure: unknown
    let programOutcome: ScopeOutcome | undefined

    try {
      value = await use(runtime)
      programOutcome = classifyRuntimeOutcome(value)
    } catch (cause) {
      executionFailed = true
      executionFailure = cause
      programOutcome = {
        status: 'failure',
        cause
      }
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

  /** Resolve every Layer provider and dispose the Runtime if warmup fails. */
  async warmup(): Promise<void> {
    try {
      await this.handle.warmup()
    } catch (cause) {
      try {
        await this.handle.dispose({ status: 'failure', cause })
      } catch {
        // Warmup failure remains the primary error; cleanup is best effort.
      }

      throw cause
    }
  }

  /** Run one execution in this Runtime's child Scope. */
  run<A>(
    program: CompleteExecution<Provided, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>> {
    return this.handle.run(program, options)
  }

  /** Run one execution with a Layer owned by that execution's child Scope. */
  runWith<Request extends LayerInput, A>(
    layer: Request & CompleteExecutionLayer<Provided, Request>,
    program: CompleteExecution<Provided | ProvidedEnvironment<Request>, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>> {
    return this.handle.runWith(layer, program, options)
  }

  private runUnchecked<A>(program: () => A | PromiseLike<A>): Promise<Awaited<A>> {
    // SAFETY: One-shot Runtime.run performs the same complete-program validation at its public boundary before using this internal escape hatch.
    return this.handle.run(program as CompleteExecution<Provided, A>)
  }

  /** Stop new executions and release the Runtime's Layer resources. */
  dispose(options?: RuntimeDisposeOptions): Promise<void>

  /** @deprecated Scope outcomes are kept for internal compatibility. */
  dispose(outcome: ScopeOutcome): Promise<void>

  dispose(optionsOrOutcome?: RuntimeDisposeOptions | ScopeOutcome): Promise<void> {
    return this.handle.dispose(optionsOrOutcome)
  }

  /** Release Runtime-owned resources through JavaScript's async disposal protocol. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
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

  /** Optional signal supplied to one managed Runtime execution. */
  export type RunOptions = RuntimeRunOptions

  /** Cooperative shutdown policy for a managed Runtime. */
  export type DisposeOptions = RuntimeDisposeOptions

  /** Diagnostic reported for aggregated Runtime shutdown cleanup failures. */
  export type ShutdownDiagnostic = RuntimeShutdownDiagnostic
}
