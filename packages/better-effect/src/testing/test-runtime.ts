import { Layer } from '../layer'
import type {
  CompleteExecution,
  CompleteExecutionLayer,
  CompleteInput,
  LayerInput,
  LayerInputState,
  OverrideLayerResult,
  OverrideResult,
  ProvidedEnvironment,
  RequiredEnvironment,
  ValidateLayerInput,
  ValidateOverrides
} from '../layer/inference'
import type { LayerBackend } from '../layer/backend'
import { LayerDisposeError } from '../layer/errors'
import { MapLayerBackend } from '../layer/map-layer-backend'
import {
  classifyRuntimeOutcome,
  type RuntimeDisposeOptions,
  type RuntimeOptions,
  type RuntimeRunOptions
} from '../runtime/outcome'
import { Runtime } from '../runtime/runtime'
import type { RuntimeObserver } from '../runtime/observer'
import type { RuntimeExecutionEndEvent, RuntimeExecutionStartEvent } from '../runtime/observer'
import type { ScopeOutcome } from '../scope'
import { Clock, ClockTest, Logger, LoggerTest, Random, RandomSeeded } from '../standard-services'
import type { MissingDependencies } from '../internal/missing-dependencies'
import type { AnyService } from '../service'
import { RecordedRuntimeObserver } from './recorded-runtime-observer'

/** Options for an isolated TestRuntime. */
export type TestRuntimeOptions<
  Base extends LayerInput = LayerInput,
  Overrides extends readonly LayerInput[] = readonly LayerInput[]
> = Omit<RuntimeOptions, 'backend' | 'observers'> & {
  /** Explicitly replace or add providers through `Layer.override`. */
  readonly overrides?: Overrides & ValidateOverrides<Base, Overrides>
  /** Backend used by the underlying Runtime. Defaults to a fresh MapLayerBackend. */
  readonly backend?: LayerBackend
  /** Deterministic Clock provider to install for this TestRuntime. */
  readonly clock?: ClockTest
  /** In-memory Logger provider to install for this TestRuntime. */
  readonly logger?: LoggerTest
  /** Seeded Random provider to install for this TestRuntime. */
  readonly random?: RandomSeeded
  /** Additional best-effort observers after the default recorder. */
  readonly observers?: readonly RuntimeObserver[]
}

type ClockTestLayer = ReturnType<typeof ClockTest.layer>
type LoggerTestLayer = ReturnType<typeof LoggerTest.layer>
type RandomSeededLayer = ReturnType<typeof RandomSeeded.layer>

type ExplicitOverrides<Options> = Options extends {
  readonly overrides: infer Overrides extends readonly LayerInput[]
}
  ? Overrides
  : readonly []

type HasDefinedOption<Options, Key extends PropertyKey> = Key extends keyof Options
  ? {} extends Pick<Options, Key>
    ? false
    : undefined extends Options[Key]
      ? false
      : true
  : false

type ApplyOptionalOverride<
  Base extends LayerInput,
  Options,
  Key extends PropertyKey,
  Replacement extends LayerInput
> = HasDefinedOption<Options, Key> extends true ? OverrideResult<Base, Replacement> : Base

type TestRuntimeLayer<Base extends LayerInput, Options> = ApplyOptionalOverride<
  ApplyOptionalOverride<
    ApplyOptionalOverride<
      OverrideLayerResult<Base, ExplicitOverrides<Options>>,
      Options,
      'clock',
      ClockTestLayer
    >,
    Options,
    'logger',
    LoggerTestLayer
  >,
  Options,
  'random',
  RandomSeededLayer
>

type TestRuntimeOptionsValidation<Base extends LayerInput, Options> = Options extends {
  readonly overrides: infer Overrides extends readonly LayerInput[]
}
  ? { readonly overrides: Overrides & ValidateOverrides<Base, Overrides> }
  : unknown

type CompleteLayerCheck<L extends LayerInput> = ValidateLayerInput<L> &
  (LayerInputState<L> extends 'typed'
    ? [RequiredEnvironment<L>] extends [never]
      ? unknown
      : MissingDependencies<Extract<RequiredEnvironment<L>, AnyService>>
    : unknown)

type ConfiguredService<Options, Key extends PropertyKey, Service> = Key extends keyof Options
  ? undefined extends Options[Key]
    ? undefined
    : Options[Key] extends Service
      ? Options[Key]
      : undefined
  : undefined

type TestCallback<Provided extends AnyService, A, Options extends object = {}> = (
  test: TestRuntime<Provided, Options>
) => A | PromiseLike<A>

/**
 * Thrown when the TestRuntime recorder contains an execution start or end
 * event without its matching event at final disposal.
 */
export class TestRuntimeObserverError extends Error {
  readonly unmatchedStarts: readonly RuntimeExecutionStartEvent[]
  readonly unmatchedEnds: readonly RuntimeExecutionEndEvent[]

  constructor(
    unmatchedStarts: readonly RuntimeExecutionStartEvent[],
    unmatchedEnds: readonly RuntimeExecutionEndEvent[]
  ) {
    const startLabel = `${unmatchedStarts.length} start${unmatchedStarts.length === 1 ? '' : 's'}`
    const endLabel = `${unmatchedEnds.length} end${unmatchedEnds.length === 1 ? '' : 's'}`

    super(
      `TestRuntime found unmatched execution events: ${startLabel} without an end, ${endLabel} without a start`
    )

    this.name = 'TestRuntimeObserverError'
    this.unmatchedStarts = Object.freeze([...unmatchedStarts])
    this.unmatchedEnds = Object.freeze([...unmatchedEnds])
  }
}

/**
 * A disposable test boundary backed by the real Layer and Runtime
 * implementations.
 */
export class TestRuntime<Provided extends AnyService = any, Options extends object = {}> {
  readonly clock: ConfiguredService<Options, 'clock', ClockTest>
  readonly logger: ConfiguredService<Options, 'logger', LoggerTest>
  readonly random: ConfiguredService<Options, 'random', RandomSeeded>

  private disposalPromise: Promise<void> | undefined

  private constructor(
    /** The real Runtime used by this testing facade. */
    readonly runtime: Runtime<Provided>,
    /** Lifecycle events recorded by this TestRuntime. */
    readonly observer: RecordedRuntimeObserver,
    clock: ClockTest | undefined,
    logger: LoggerTest | undefined,
    random: RandomSeeded | undefined
  ) {
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.clock = clock as ConfiguredService<Options, 'clock', ClockTest>
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.logger = logger as ConfiguredService<Options, 'logger', LoggerTest>
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.random = random as ConfiguredService<Options, 'random', RandomSeeded>
  }

  /** Create a TestRuntime with a fresh backend and default lifecycle recorder. */
  static make<L extends LayerInput>(
    layer: L & CompleteLayerCheck<L>
  ): Promise<TestRuntime<ProvidedEnvironment<L>>>

  static make<L extends LayerInput, const Options extends TestRuntimeOptions<L>>(
    layer: L & ValidateLayerInput<L> & CompleteLayerCheck<TestRuntimeLayer<L, Options>>,
    options: Options & TestRuntimeOptionsValidation<L, Options>
  ): Promise<TestRuntime<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, Options>>

  static async make<L extends LayerInput, const Options extends TestRuntimeOptions<L> = {}>(
    layer: L,
    options?: Options
  ): Promise<TestRuntime<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, Options>> {
    // SAFETY: The overloads validate the Layer and options; the empty default is used only when no options were supplied.
    const resolvedOptions = options === undefined ? ({} as Options) : options

    return TestRuntime.makeInternal(layer, resolvedOptions)
  }

  private static async makeInternal<
    L extends LayerInput,
    const Options extends TestRuntimeOptions<L>
  >(
    layer: L,
    options: Options
  ): Promise<TestRuntime<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, Options>> {
    const observer = RecordedRuntimeObserver.make()
    const composedLayer = composeTestLayer(layer, options)
    const runtimeOptions: RuntimeOptions = {
      ...options,
      backend: options.backend ?? new MapLayerBackend(),
      observers: [observer, ...(options.observers ?? [])]
    }
    // SAFETY: Public overloads require the composed Layer to be complete before this internal Runtime call.
    const typedLayer = composedLayer as TestRuntimeLayer<L, Options> &
      CompleteInput<TestRuntimeLayer<L, Options>>
    const runtime = await Runtime.make(typedLayer, runtimeOptions)

    return new TestRuntime<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, Options>(
      runtime,
      observer,
      options.clock,
      options.logger,
      options.random
    )
  }

  /** Run a fully typechecked program in the underlying Runtime. */
  run<A>(
    program: CompleteExecution<Provided, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>> {
    return this.runtime.run(program, options)
  }

  /** Run a fully typechecked program with an execution-local Layer. */
  runWith<Request extends LayerInput, A>(
    layer: Request & CompleteExecutionLayer<Provided, Request>,
    program: CompleteExecution<Provided | ProvidedEnvironment<Request>, A>,
    options?: RuntimeRunOptions
  ): Promise<Awaited<A>> {
    return this.runtime.runWith(layer, program, options)
  }

  /** Dispose the underlying Runtime and perform the final recorder consistency check. */
  dispose(options?: RuntimeDisposeOptions): Promise<void> {
    return this.disposeWithInput(options)
  }

  /** Release this TestRuntime through JavaScript's async disposal protocol. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  private disposeWithOutcome(outcome: ScopeOutcome): Promise<void> {
    return this.disposeWithInput(outcome)
  }

  private disposeWithInput(input?: RuntimeDisposeOptions | ScopeOutcome): Promise<void> {
    if (this.disposalPromise !== undefined) {
      return this.disposalPromise
    }

    const disposal =
      input === undefined
        ? this.runtime.dispose()
        : isScopeOutcome(input)
          ? this.runtime.dispose(input)
          : this.runtime.dispose(input)
    this.disposalPromise = disposal.then(
      () => this.assertObserverConsistency(),
      (cause) => {
        const observerFailure = this.observerConsistencyFailure()

        if (observerFailure === undefined) {
          throw cause
        }

        const causes = cause instanceof LayerDisposeError ? cause.causes : [cause]
        throw new LayerDisposeError([...causes, observerFailure])
      }
    )

    return this.disposalPromise
  }

  private assertObserverConsistency(): void {
    const failure = this.observerConsistencyFailure()

    if (failure !== undefined) {
      throw failure
    }
  }

  private observerConsistencyFailure(): TestRuntimeObserverError | undefined {
    const unmatched = findUnmatchedExecutionEvents(
      this.observer.executionStarts,
      this.observer.executionEnds
    )

    if (unmatched.starts.length === 0 && unmatched.ends.length === 0) {
      return undefined
    }

    return new TestRuntimeObserverError(unmatched.starts, unmatched.ends)
  }

  /** Run a callback and always dispose this TestRuntime with its final outcome. */
  static use<A, L extends LayerInput>(
    layer: L & CompleteLayerCheck<L>,
    use: TestCallback<ProvidedEnvironment<L>, A>
  ): Promise<Awaited<A>>

  static use<A, L extends LayerInput, const Options extends TestRuntimeOptions<L>>(
    layer: L & ValidateLayerInput<L> & CompleteLayerCheck<TestRuntimeLayer<L, Options>>,
    options: Options & TestRuntimeOptionsValidation<L, Options>,
    use: TestCallback<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, A, Options>
  ): Promise<Awaited<A>>

  static async use<A, L extends LayerInput, const Options extends TestRuntimeOptions<L> = {}>(
    layer: L,
    optionsOrUse:
      | Options
      | TestCallback<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, A, Options>,
    maybeUse?: TestCallback<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, A, Options>
  ): Promise<Awaited<A>> {
    let use: TestCallback<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, A, Options> | undefined
    let resolvedOptions: Options

    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- overload dispatch distinguishes the callback from the options object.
    if (typeof optionsOrUse === 'function') {
      use = optionsOrUse
      // SAFETY: The public overloads validate the supplied Layer; no options are needed for this branch.
      resolvedOptions = {} as Options
    } else {
      use = maybeUse
      resolvedOptions = optionsOrUse
    }

    if (use === undefined) {
      throw new TypeError('TestRuntime.use requires a callback')
    }

    const test = await TestRuntime.makeInternal(layer, resolvedOptions)
    let value!: Awaited<A>
    let executionFailed = false
    let executionFailure: unknown
    let outcome: ScopeOutcome

    try {
      value = await use(test)
      outcome = classifyRuntimeOutcome(value)
    } catch (cause) {
      executionFailed = true
      executionFailure = cause
      outcome = { status: 'failure', cause }
    }

    try {
      await test.disposeWithOutcome(outcome)
    } catch (cleanupFailure) {
      if (!executionFailed && outcome.status === 'success') {
        throw cleanupFailure
      }
    }

    if (executionFailed) {
      throw executionFailure
    }

    return value
  }
}

const isScopeOutcome = (input: RuntimeDisposeOptions | ScopeOutcome): input is ScopeOutcome =>
  'status' in input

const composeTestLayer = (layer: LayerInput, options: TestRuntimeOptions): LayerInput => {
  const overrides = [...(options.overrides ?? [])]

  if (options.clock !== undefined) {
    overrides.push(Layer.succeed(Clock, options.clock))
  }

  if (options.logger !== undefined) {
    overrides.push(Layer.succeed(Logger, options.logger))
  }

  if (options.random !== undefined) {
    overrides.push(Layer.succeed(Random, options.random))
  }

  // SAFETY: Runtime composition has already passed the public typed override boundary.
  const uncheckedLayer = layer as Layer.Any
  // SAFETY: The list is erased only while passing heterogeneous providers to Layer.override.
  const uncheckedOverrides = overrides as readonly Layer.Any[]

  return Layer.override(uncheckedLayer, ...uncheckedOverrides)
}

type UnmatchedExecutionEvents = {
  readonly starts: readonly RuntimeExecutionStartEvent[]
  readonly ends: readonly RuntimeExecutionEndEvent[]
}

const findUnmatchedExecutionEvents = (
  starts: readonly RuntimeExecutionStartEvent[],
  ends: readonly RuntimeExecutionEndEvent[]
): UnmatchedExecutionEvents => {
  const endCounts = countExecutionScopes(ends)
  const unmatchedStarts: RuntimeExecutionStartEvent[] = []

  for (const event of starts) {
    const count = endCounts.get(event.scope) ?? 0

    if (count === 0) {
      unmatchedStarts.push(event)
    } else {
      endCounts.set(event.scope, count - 1)
    }
  }

  const startCounts = countExecutionScopes(starts)
  const unmatchedEnds: RuntimeExecutionEndEvent[] = []

  for (const event of ends) {
    const count = startCounts.get(event.scope) ?? 0

    if (count === 0) {
      unmatchedEnds.push(event)
    } else {
      startCounts.set(event.scope, count - 1)
    }
  }

  return { starts: unmatchedStarts, ends: unmatchedEnds }
}

const countExecutionScopes = <Event extends { readonly scope: object }>(
  events: readonly Event[]
): Map<object, number> => {
  const counts = new Map<object, number>()

  for (const event of events) {
    counts.set(event.scope, (counts.get(event.scope) ?? 0) + 1)
  }

  return counts
}

/** Type-level aliases for TestRuntime configuration. */
export declare namespace TestRuntime {
  /** Options accepted by `TestRuntime.make` and `TestRuntime.use`. */
  export type Options<
    Base extends LayerInput = LayerInput,
    Overrides extends readonly LayerInput[] = readonly LayerInput[]
  > = TestRuntimeOptions<Base, Overrides>

  /** Optional signal supplied to one managed TestRuntime execution. */
  export type RunOptions = RuntimeRunOptions

  /** Cooperative shutdown policy for a managed TestRuntime. */
  export type DisposeOptions = RuntimeDisposeOptions
}
