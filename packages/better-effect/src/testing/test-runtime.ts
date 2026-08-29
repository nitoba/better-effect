import { Layer } from '../layer'
import type {
  CompleteExecution,
  CompleteExecutionLayer,
  CompleteInput,
  LayerInput,
  LayerInputState,
  OverrideLayerResult,
  ProvidedEnvironment,
  RequiredEnvironment,
  ValidateLayerInput,
  ValidateOverrides,
  ValidateOverridesWitness
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
import {
  Clock,
  ClockTest,
  IdGenerator,
  IdGeneratorTest,
  Logger,
  LoggerTest,
  Random,
  RandomSeeded
} from '../standard-services'
import type { MissingDependencies } from '../internal/missing-dependencies'
import type { AnyService } from '../service'
import { RecordedRuntimeObserver } from './recorded-runtime-observer'

declare const TestRuntimeOptionsOverridesTypeId: unique symbol

type ValidatedTestServiceOption<
  Base extends LayerInput,
  Overrides extends readonly LayerInput[],
  Replacement extends LayerInput,
  Value
> = Value & ValidateOverridesWitness<Base, readonly [...Overrides, Replacement]>

/** Options for an isolated TestRuntime. */
export type TestRuntimeOptions<
  Base extends LayerInput = LayerInput,
  Overrides extends readonly LayerInput[] = readonly []
> = Omit<RuntimeOptions, 'backend' | 'observers'> & {
  /** Explicitly replace or add providers through `Layer.override`. */
  readonly overrides?: Overrides & ValidateOverrides<Base, Overrides>
  /** Backend used by the underlying Runtime. Defaults to a fresh MapLayerBackend. */
  readonly backend?: LayerBackend
  /** Deterministic Clock provider to install for this TestRuntime. */
  readonly clock?: ValidatedTestServiceOption<Base, Overrides, ClockTestLayer, ClockTest>
  /** In-memory Logger provider to install for this TestRuntime. */
  readonly logger?: ValidatedTestServiceOption<Base, Overrides, LoggerTestLayer, LoggerTest>
  /** Seeded Random provider to install for this TestRuntime. */
  readonly random?: ValidatedTestServiceOption<Base, Overrides, RandomSeededLayer, RandomSeeded>
  /** Deterministic IdGenerator provider to install for this TestRuntime. */
  readonly idGenerator?: ValidatedTestServiceOption<
    Base,
    Overrides,
    IdGeneratorTestLayer,
    IdGeneratorTest
  >
  /** Additional best-effort observers after the default recorder. */
  readonly observers?: readonly RuntimeObserver[]
} & {
  readonly [TestRuntimeOptionsOverridesTypeId]?: Overrides
}

type ClockTestLayer = ReturnType<typeof ClockTest.layer>
type LoggerTestLayer = ReturnType<typeof LoggerTest.layer>
type RandomSeededLayer = ReturnType<typeof RandomSeeded.layer>
type IdGeneratorTestLayer = ReturnType<typeof IdGeneratorTest.layer>

type TestRuntimeOptionsInput = Omit<RuntimeOptions, 'backend' | 'observers'> & {
  readonly overrides?: readonly LayerInput[]
  readonly backend?: LayerBackend
  readonly clock?: ClockTest
  readonly logger?: LoggerTest
  readonly random?: RandomSeeded
  readonly idGenerator?: IdGeneratorTest
  readonly observers?: readonly RuntimeObserver[]
}

type ExplicitOverrides<Options extends TestRuntimeOptionsInput> =
  typeof TestRuntimeOptionsOverridesTypeId extends keyof Options
    ? Exclude<
        Options[typeof TestRuntimeOptionsOverridesTypeId],
        undefined
      > extends infer Overrides extends readonly LayerInput[]
      ? Overrides
      : readonly []
    : Exclude<Options['overrides'], undefined> extends infer Overrides extends readonly LayerInput[]
      ? Overrides
      : readonly []

type HasDefinedOption<Options, Key extends PropertyKey> = true extends (
  Options extends unknown
    ? Key extends keyof Options
      ? {} extends Pick<Options, Key>
        ? false
        : undefined extends Options[Key]
          ? false
          : true
      : false
    : never
)
  ? true
  : false

type HasPotentialOption<Options, Key extends PropertyKey> = true extends (
  Options extends unknown
    ? Key extends keyof Options
      ? [Exclude<Options[Key], undefined>] extends [never]
        ? false
        : true
      : false
    : never
)
  ? true
  : false

type HasGuaranteedOption<Options, Key extends PropertyKey> = [Options] extends [never]
  ? false
  : false extends (Options extends unknown ? HasDefinedOption<Options, Key> : never)
    ? false
    : true

type TestRuntimeOptionLayers<Options extends TestRuntimeOptionsInput> = [
  ...ExplicitOverrides<Options>,
  ...(HasGuaranteedOption<Options, 'clock'> extends true ? [ClockTestLayer] : []),
  ...(HasGuaranteedOption<Options, 'logger'> extends true ? [LoggerTestLayer] : []),
  ...(HasGuaranteedOption<Options, 'random'> extends true ? [RandomSeededLayer] : []),
  ...(HasGuaranteedOption<Options, 'idGenerator'> extends true ? [IdGeneratorTestLayer] : [])
]

type TestRuntimeValidationLayers<Options extends TestRuntimeOptionsInput> = [
  ...ExplicitOverrides<Options>,
  ...(HasPotentialOption<Options, 'clock'> extends true ? [ClockTestLayer] : []),
  ...(HasPotentialOption<Options, 'logger'> extends true ? [LoggerTestLayer] : []),
  ...(HasPotentialOption<Options, 'random'> extends true ? [RandomSeededLayer] : []),
  ...(HasPotentialOption<Options, 'idGenerator'> extends true ? [IdGeneratorTestLayer] : [])
]

type TestRuntimeLayer<
  Base extends LayerInput,
  Options extends TestRuntimeOptionsInput
> = OverrideLayerResult<Base, TestRuntimeOptionLayers<Options>>

type TestRuntimeOptionsValidation<
  Base extends LayerInput,
  Options extends TestRuntimeOptionsInput
> = (Options extends {
  readonly overrides?: infer Overrides extends readonly LayerInput[]
}
  ? { readonly overrides?: Overrides & ValidateOverrides<Base, Overrides> }
  : unknown) &
  ValidateOverridesWitness<Base, TestRuntimeValidationLayers<Options>>

type CompleteLayerCheck<L extends LayerInput> = ValidateLayerInput<L> &
  (LayerInputState<L> extends 'typed'
    ? [RequiredEnvironment<L>] extends [never]
      ? unknown
      : MissingDependencies<Extract<RequiredEnvironment<L>, AnyService>>
    : unknown)

type ConfiguredService<Options, Key extends PropertyKey, Service> = Options extends unknown
  ? Key extends keyof Options
    ? undefined extends Options[Key]
      ? undefined
      : Options[Key] extends Service
        ? Options[Key]
        : undefined
    : undefined
  : never

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
  readonly idGenerator: ConfiguredService<Options, 'idGenerator', IdGeneratorTest>

  private disposalPromise: Promise<void> | undefined

  private constructor(
    /** The real Runtime used by this testing facade. */
    readonly runtime: Runtime<Provided>,
    /** Lifecycle events recorded by this TestRuntime. */
    readonly observer: RecordedRuntimeObserver,
    clock: ClockTest | undefined,
    logger: LoggerTest | undefined,
    random: RandomSeeded | undefined,
    idGenerator: IdGeneratorTest | undefined
  ) {
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.clock = clock as ConfiguredService<Options, 'clock', ClockTest>
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.logger = logger as ConfiguredService<Options, 'logger', LoggerTest>
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.random = random as ConfiguredService<Options, 'random', RandomSeeded>
    // SAFETY: The public factory's Options type records which explicit test services were supplied.
    this.idGenerator = idGenerator as ConfiguredService<Options, 'idGenerator', IdGeneratorTest>
  }

  /** Create a TestRuntime with a fresh backend and default lifecycle recorder. */
  static make<L extends LayerInput>(
    layer: L & CompleteLayerCheck<L>
  ): Promise<TestRuntime<ProvidedEnvironment<L>>>

  static make<L extends LayerInput, const Options extends TestRuntimeOptionsInput>(
    layer: L & ValidateLayerInput<L> & CompleteLayerCheck<TestRuntimeLayer<L, NoInfer<Options>>>,
    options: Options & TestRuntimeOptionsValidation<L, Options>
  ): Promise<TestRuntime<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, Options>>

  static async make<L extends LayerInput, const Options extends TestRuntimeOptionsInput = {}>(
    layer: L,
    options?: Options
  ): Promise<TestRuntime<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, Options>> {
    // SAFETY: The overloads validate the Layer and options; the empty default is used only when no options were supplied.
    const resolvedOptions = options === undefined ? ({} as Options) : options

    return TestRuntime.makeInternal(layer, resolvedOptions)
  }

  private static async makeInternal<
    L extends LayerInput,
    const Options extends TestRuntimeOptionsInput
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
      options.random,
      options.idGenerator
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

  static use<A, L extends LayerInput, const Options extends TestRuntimeOptionsInput>(
    layer: L & ValidateLayerInput<L> & CompleteLayerCheck<TestRuntimeLayer<L, NoInfer<Options>>>,
    options: Options & TestRuntimeOptionsValidation<L, Options>,
    use: TestCallback<ProvidedEnvironment<TestRuntimeLayer<L, Options>>, A, Options>
  ): Promise<Awaited<A>>

  static async use<A, L extends LayerInput, const Options extends TestRuntimeOptionsInput = {}>(
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

const composeTestLayer = <Base extends LayerInput, Options extends TestRuntimeOptionsInput>(
  layer: Base,
  options: Options
): TestRuntimeLayer<Base, Options> => {
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

  if (options.idGenerator !== undefined) {
    overrides.push(Layer.succeed(IdGenerator, options.idGenerator))
  }

  // SAFETY: The public overloads validate the Layer and every generated option override.
  const typedLayer = layer as Base & ValidateLayerInput<Base>
  // SAFETY: Runtime branches collect the tuple described by TestRuntimeOptionLayers; the cast only restores that validated tuple for Layer.override.
  const typedOverrides = overrides as TestRuntimeOptionLayers<Options> &
    ValidateOverrides<Base, TestRuntimeOptionLayers<Options>>

  return Layer.override<Base, TestRuntimeOptionLayers<Options>>(typedLayer, ...typedOverrides)
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
    Overrides extends readonly LayerInput[] = readonly []
  > = TestRuntimeOptions<Base, Overrides>

  /** Optional signal supplied to one managed TestRuntime execution. */
  export type RunOptions = RuntimeRunOptions

  /** Cooperative shutdown policy for a managed TestRuntime. */
  export type DisposeOptions = RuntimeDisposeOptions
}
