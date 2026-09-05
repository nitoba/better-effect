import { createAuthMiddleware } from 'better-auth/api'

import type { APIError } from 'better-auth/api'

import { Effect, Layer, Runtime, Service } from 'better-effect'

import type { AnyService, EffectYield, RuntimeExecutor, ServiceRequirement } from 'better-effect'

import { Result } from 'better-result'

import type { Err, InferErr, InferOk, Result as ResultType } from 'better-result'

/** The context type supplied to callbacks passed to Better Auth's public middleware factory. */
type BetterAuthMiddlewareCallback = Parameters<typeof createAuthMiddleware>[0]

export type BetterAuthMiddlewareContext = Parameters<BetterAuthMiddlewareCallback>[0]

/** Compatibility alias for the context received by a Better Auth hook program. */
export type BetterAuthHookContext = BetterAuthMiddlewareContext

/** The public middleware value returned by Better Auth's middleware factory. */
export type BetterAuthMiddleware = ReturnType<typeof createAuthMiddleware>

/** Value exposed through the execution-scoped hook Context Service. */
export interface BetterAuthHookContextValue<Context = BetterAuthMiddlewareContext> {
  readonly context: Context
}

/** A partial context replacement accepted by Better Auth before hooks. */
export interface BetterAuthHookContextReplacement<Context = BetterAuthMiddlewareContext> {
  readonly context: Partial<Context>
}

/** Values that a hook program may return without changing Better Auth semantics. */
export type BetterAuthHookSuccess<Context = BetterAuthMiddlewareContext> =
  | void
  | null
  | Response
  | BetterAuthHookContextReplacement<Context>
  | object

/** Failure results accepted by an explicit hook failure mapper. */
export type BetterAuthHookFailureResult = APIError | Response

/** Map a typed program failure to a Better Auth API error or an untouched Response. */
export type BetterAuthHookFailureMapper<Failure, Context = BetterAuthMiddlewareContext> = (
  failure: Failure,
  context: Context
) => BetterAuthHookFailureResult | PromiseLike<BetterAuthHookFailureResult>

/** A lazy Program factory invoked once for each Better Auth middleware call. */
export type BetterAuthHookProgramFactory<
  Context = BetterAuthMiddlewareContext,
  Success extends BetterAuthHookSuccess<Context> = BetterAuthHookSuccess<Context>,
  Failure = unknown,
  Requirements extends AnyService = AnyService
> = (context: Context) => Effect.Program<Success, Failure, Requirements>

/** A generator body accepted by `BetterAuthHooks.gen`. */
export type BetterAuthHookGenerator<
  Context = BetterAuthMiddlewareContext,
  Yield extends EffectYield = EffectYield,
  Returned extends ResultType<any, any> = ResultType<any, any>
> =
  | (() => Generator<Yield, Returned, unknown>)
  | ((context: Context) => Generator<Yield, Returned, unknown>)
  | (() => AsyncGenerator<Yield, Returned, unknown>)
  | ((context: Context) => AsyncGenerator<Yield, Returned, unknown>)

/** A request-local Layer factory evaluated once for each middleware invocation. */
export type BetterAuthHookLayerFactory<
  Context = BetterAuthMiddlewareContext,
  RequestLayer extends Layer.Any = typeof Layer.empty
> = (context: Context) => RequestLayer

/** Options for a program with no typed failure channel. */
export type BetterAuthHookNoFailureOptions<
  Context = BetterAuthMiddlewareContext,
  RequestLayer extends Layer.Any = typeof Layer.empty
> = {
  readonly layer?: BetterAuthHookLayerFactory<Context, RequestLayer>
  readonly onFailure?: never
}

/** Options for a program whose typed failure channel must be mapped explicitly. */
export type BetterAuthHookFailureOptions<
  Failure,
  Context = BetterAuthMiddlewareContext,
  RequestLayer extends Layer.Any = typeof Layer.empty
> = {
  readonly layer?: BetterAuthHookLayerFactory<Context, RequestLayer>
  readonly onFailure: BetterAuthHookFailureMapper<Failure, Context>
}

/** Public options selected from the program's inferred failure channel. */
export type BetterAuthHookMiddlewareOptions<
  Failure,
  Context = BetterAuthMiddlewareContext,
  RequestLayer extends Layer.Any = typeof Layer.empty
> = [Failure] extends [never]
  ? BetterAuthHookNoFailureOptions<Context, RequestLayer>
  : BetterAuthHookFailureOptions<Failure, Context, RequestLayer>

/** The available environment is constrained while the generic preserves concrete Program channels. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- Keep this inference boundary opaque so concrete Program channels remain available to validation.
type HookProgramFactory = (context: BetterAuthMiddlewareContext) => unknown

type HookProgramConstraint = (
  context: BetterAuthMiddlewareContext
) => Effect.Program<unknown, unknown, AnyService>

type HookProgram<Factory extends HookProgramFactory> = Awaited<ReturnType<Factory>>

type HookSuccess<Factory extends HookProgramFactory> = Effect.Success<HookProgram<Factory>>

type HookFailure<Factory extends HookProgramFactory> = Effect.Error<HookProgram<Factory>>

type HookRequirements<Factory extends HookProgramFactory> = Effect.Requirements<
  HookProgram<Factory>
>

type AnyResult = ResultType<any, any>

type HookYieldError<Yield> = Yield extends Err<never, infer Failure> ? Failure : never

type HookYieldRequirements<Yield> =
  Yield extends ServiceRequirement<infer Requirement> ? Extract<Requirement, AnyService> : never

type HookGeneratorProgram<Yield extends EffectYield, Returned extends AnyResult> = Effect.Program<
  InferOk<Returned>,
  HookYieldError<Yield> | InferErr<Returned>,
  HookYieldRequirements<Yield>
>

type HookGeneratorFactory<Yield extends EffectYield, Returned extends AnyResult> = (
  context: BetterAuthMiddlewareContext
) => HookGeneratorProgram<Yield, Returned>

type HookGeneratorFailure<Yield extends EffectYield, Returned extends AnyResult> = Effect.Error<
  HookGeneratorProgram<Yield, Returned>
>

type IsAny<Value> = 0 extends 1 & Value ? true : false

type SameService<Left extends AnyService, Right extends AnyService> = [Service.Tag<Left>] extends [
  Service.Tag<Right>
]
  ? [Service.Tag<Right>] extends [Service.Tag<Left>]
    ? [Service.Contract<Left>] extends [Service.Contract<Right>]
      ? [Service.Contract<Right>] extends [Service.Contract<Left>]
        ? true
        : false
      : false
    : false
  : false

type HasService<Required extends AnyService, Available extends AnyService> = true extends (
  Available extends AnyService ? SameService<Required, Available> : never
)
  ? true
  : false

type MissingServices<Required, Available> =
  IsAny<Required> extends true
    ? never
    : IsAny<Available> extends true
      ? never
      : Required extends AnyService
        ? HasService<Required, Extract<Available, AnyService>> extends true
          ? never
          : Required
        : never

type RemoveServices<Required, Removed> = Required extends AnyService
  ? HasService<Required, Extract<Removed, AnyService>> extends true
    ? never
    : Required
  : never

/** Internal diagnostic retained in public call-site signatures. */
type MissingDependencies<Missing extends AnyService> = {
  readonly missingDependencies: Missing
}

type InvalidSuccess<Success> = {
  readonly invalidSuccess: Success
}

type ValidateHookSuccess<Factory extends HookProgramFactory> = [HookSuccess<Factory>] extends [
  BetterAuthHookSuccess
]
  ? unknown
  : InvalidSuccess<HookSuccess<Factory>>

type ValidateMissingServices<Required, Available> =
  MissingServices<Required, Available> extends infer Missing
    ? [Missing] extends [never]
      ? unknown
      : Missing extends AnyService
        ? MissingDependencies<Missing>
        : never
    : never

type ValidateHookRequirements<
  Provided extends AnyService,
  Factory extends HookProgramFactory,
  ContextInstance extends AnyService
> = ValidateMissingServices<HookRequirements<Factory>, Provided | ContextInstance>

type ValidateHookLayerRequirements<
  Provided extends AnyService,
  ContextInstance extends AnyService,
  RequestLayer extends Layer.Any
> = ValidateMissingServices<Layer.Required<RequestLayer>, Provided | ContextInstance>

type ValidateHookProgram<
  Provided extends AnyService,
  Factory extends HookProgramFactory,
  ContextInstance extends AnyService,
  RequestLayer extends Layer.Any
> = ValidateHookSuccess<Factory> &
  ValidateHookLayerRequirements<Provided, ContextInstance, RequestLayer> &
  ValidateHookRequirements<
    Provided | Extract<Layer.Provided<RequestLayer>, AnyService>,
    Factory,
    ContextInstance
  >

type HookExternalRequirements<
  Factory extends HookProgramFactory,
  RequestLayer extends Layer.Any,
  ContextInstance extends AnyService
> =
  | RemoveServices<
      HookRequirements<Factory>,
      ContextInstance | Extract<Layer.Provided<RequestLayer>, AnyService>
    >
  | RemoveServices<Layer.Required<RequestLayer>, ContextInstance>

/** Requirements captured by a yieldable hook builder and provided by the outer Layer. */
export type BetterAuthHookExternalRequirements<
  Factory extends BetterAuthHookProgramFactory,
  RequestLayer extends Layer.Any = typeof Layer.empty,
  ContextInstance extends AnyService = AnyService
> = HookExternalRequirements<Factory, RequestLayer, ContextInstance>

type HookMiddlewareArguments<Failure, Options> = [Failure] extends [never]
  ? [options?: Options]
  : [options: Options]

type IsUnknown<Value> =
  IsAny<Value> extends true
    ? false
    : unknown extends Value
      ? [keyof Value] extends [never]
        ? true
        : false
      : false

type HookMiddlewareCallArguments<Failure, Validation, Options> =
  IsUnknown<Validation> extends true
    ? HookMiddlewareArguments<Failure, Options>
    : [options: Options & Validation]

type GeneratedHookFactory<
  Yield extends EffectYield,
  Returned extends AnyResult
> = HookGeneratorFactory<Yield, Returned>

type ValidateGeneratedHook<
  Yield extends EffectYield,
  Returned extends AnyResult
> = ValidateHookSuccess<GeneratedHookFactory<Yield, Returned>>

type ValidateGeneratedHookProgram<
  Provided extends AnyService,
  Yield extends EffectYield,
  Returned extends AnyResult,
  ContextInstance extends AnyService,
  RequestLayer extends Layer.Any
> = ValidateGeneratedHook<Yield, Returned> &
  ValidateHookLayerRequirements<Provided, ContextInstance, RequestLayer> &
  ValidateHookRequirements<
    Provided | Extract<Layer.Provided<RequestLayer>, AnyService>,
    GeneratedHookFactory<Yield, Returned>,
    ContextInstance
  >

/** A yieldable operation that captures only the active Runtime executor. */
export interface BetterAuthHookOperation<Requirements extends AnyService = never> {
  readonly [Symbol.iterator]: () => Generator<
    ServiceRequirement<Requirements>,
    BetterAuthMiddleware,
    unknown
  >
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<Requirements>,
    BetterAuthMiddleware,
    unknown
  >
}

/** A bridge defined before the Better Auth instance and bound during Layer acquisition. */
export interface BetterAuthHooksDefinition<Tag extends string> {
  readonly Context: BetterAuthHookContextToken<Tag>
  readonly middleware: <
    Factory extends HookProgramFactory,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    program: Factory & HookProgramConstraint,
    ...options: HookMiddlewareCallArguments<
      HookFailure<Factory>,
      ValidateHookSuccess<NoInfer<Factory>>,
      BetterAuthHookMiddlewareOptions<
        HookFailure<Factory>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ) => BetterAuthHookOperation<
    HookExternalRequirements<
      NoInfer<Factory>,
      RequestLayer,
      BetterAuthHookContextValue & Service.Identity<Tag>
    >
  >
  readonly gen: <
    Yield extends EffectYield,
    Returned extends AnyResult,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    generator: BetterAuthHookGenerator<BetterAuthMiddlewareContext, Yield, Returned>,
    ...options: HookMiddlewareCallArguments<
      HookGeneratorFailure<Yield, Returned>,
      ValidateGeneratedHook<Yield, Returned>,
      BetterAuthHookMiddlewareOptions<
        HookGeneratorFailure<Yield, Returned>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ) => BetterAuthHookOperation<
    HookExternalRequirements<
      GeneratedHookFactory<Yield, Returned>,
      RequestLayer,
      BetterAuthHookContextValue & Service.Identity<Tag>
    >
  >
}

/** A Better Auth hook bridge bound to one caller-owned Runtime. */
export interface BetterAuthHooksInstance<Tag extends string, Provided extends AnyService> {
  readonly Context: BetterAuthHookContextToken<Tag>
  readonly middleware: <
    Factory extends HookProgramFactory,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    program: Factory & HookProgramConstraint,
    ...options: HookMiddlewareCallArguments<
      HookFailure<Factory>,
      ValidateHookProgram<
        Provided,
        NoInfer<Factory>,
        BetterAuthHookContextValue & Service.Identity<Tag>,
        RequestLayer
      >,
      BetterAuthHookMiddlewareOptions<
        HookFailure<Factory>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ) => BetterAuthMiddleware
  readonly gen: <
    Yield extends EffectYield,
    Returned extends AnyResult,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    generator: BetterAuthHookGenerator<BetterAuthMiddlewareContext, Yield, Returned>,
    ...options: HookMiddlewareCallArguments<
      HookGeneratorFailure<Yield, Returned>,
      ValidateGeneratedHookProgram<
        Provided,
        Yield,
        Returned,
        BetterAuthHookContextValue & Service.Identity<Tag>,
        RequestLayer
      >,
      BetterAuthHookMiddlewareOptions<
        HookGeneratorFailure<Yield, Returned>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ) => BetterAuthMiddleware
}

type BetterAuthLiteralTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

type HookResult<Factory extends HookProgramFactory> = ResultType<
  HookSuccess<Factory>,
  HookFailure<Factory>
>

const executeHook = async <Tag extends string, Factory extends HookProgramFactory>(
  executor: RuntimeExecutor<AnyService>,
  contextService: BetterAuthHookContextToken<Tag>,
  context: BetterAuthMiddlewareContext,
  factory: Factory & HookProgramConstraint,
  request: Request | undefined,
  requestLayer: Layer.Any | undefined
): Promise<HookResult<Factory>> => {
  const contextLayer = Layer.succeed(
    contextService,
    contextService.of({
      context
    })
  )
  // SAFETY: HookProgramConstraint validates the factory's return as a better-effect Program.
  const generated = factory(context) as Effect.Program<unknown, unknown, AnyService>
  const execute = () => generated()
  const options = request === undefined ? undefined : { signal: request.signal }
  let executionLayer: Layer.Any

  if (requestLayer === undefined) {
    // SAFETY: RuntimeExecutor.runWith erases the heterogeneous Context Layer after its public boundary validates the provider.
    executionLayer = contextLayer as Layer.Any
  } else {
    // SAFETY: RuntimeExecutor.runWith erases the heterogeneous Context Layer after its public boundary validates the provider.
    const uncheckedContextLayer = contextLayer as Layer.Any
    // SAFETY: the public middleware signature validates the per-invocation Layer before it reaches this erased boundary.
    const uncheckedRequestLayer = requestLayer as Layer.Any
    executionLayer = Layer.merge(uncheckedContextLayer, uncheckedRequestLayer)
  }

  const uncheckedLayer = executionLayer
  // SAFETY: the public Program constraint establishes this Result shape; this cast only removes generic implementation erasure.
  const uncheckedExecution = execute as () =>
    | ResultType<unknown, unknown>
    | PromiseLike<ResultType<unknown, unknown>>
  const result = await executor.runWith(uncheckedLayer, uncheckedExecution, options)

  // SAFETY: the public Program constraint and Runtime boundary establish the concrete Result channels.
  return result as HookResult<Factory>
}

const eraseExecutor = (executor: RuntimeExecutor<any>): RuntimeExecutor<AnyService> => {
  // SAFETY: RuntimeExecutor only changes its declaration-only environment view; the captured object remains the same non-owning executor.
  return executor as RuntimeExecutor<AnyService>
}

const legacyRuntimeExecutor = <Provided extends AnyService>(runtime: Runtime<Provided>) => {
  const runtimeWithExecutor: {
    readonly executor?: RuntimeExecutor<Provided>
  } = runtime

  if (runtimeWithExecutor.executor !== undefined) {
    return eraseExecutor(runtimeWithExecutor.executor)
  }

  // SAFETY: better-effect versions predating Runtime.Executor expose the same bound run/runWith operations on Runtime.
  const executor: RuntimeExecutor<Provided> = {
    run: runtime.run.bind(runtime),
    runWith: runtime.runWith.bind(runtime)
  }

  return eraseExecutor(executor)
}

const createBoundMiddleware = <Tag extends string, Factory extends HookProgramFactory>(
  executor: RuntimeExecutor<AnyService>,
  contextService: BetterAuthHookContextToken<Tag>,
  program: Factory & HookProgramConstraint,
  configured:
    | BetterAuthHookMiddlewareOptions<HookFailure<Factory>, BetterAuthMiddlewareContext, Layer.Any>
    | undefined
): BetterAuthMiddleware => {
  const onFailure =
    configured !== undefined && 'onFailure' in configured ? configured.onFailure : undefined
  const layerFactory = configured?.layer

  return createAuthMiddleware(async (context) => {
    const requestLayer = layerFactory?.(context)
    const result = await executeHook(
      executor,
      contextService,
      context,
      program,
      context.request,
      requestLayer
    )

    if (Result.isError(result)) {
      if (onFailure === undefined) {
        throw result.error
      }

      const mapped = await onFailure(result.error, context)

      if (mapped instanceof Response) {
        return mapped
      }

      throw mapped
    }

    return result.value
  })
}

const makeContextToken = <const Tag extends string>(
  tag: BetterAuthLiteralTag<Tag>
): BetterAuthHookContextToken<Tag> => {
  type ContextInstance = BetterAuthHookContextValue & Service.Identity<Tag>

  // SAFETY: Service() exposes an abstract constructor type even though this factory creates a concrete runtime token.
  const abstractContext = Service<ContextInstance>()(tag)
  // SAFETY: The factory returns this concrete Service token; the assertion adds its public Context iterator type.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the factory returns a concrete token with additional hook-only members.
  return abstractContext as unknown as BetterAuthHookContextToken<Tag>
}

type HookGeneratorRuntime = (
  context: BetterAuthMiddlewareContext
) => Generator<EffectYield, AnyResult, unknown> | AsyncGenerator<EffectYield, AnyResult, unknown>

const eraseGenerator = <Context, Yield extends EffectYield, Returned extends AnyResult>(
  generator: BetterAuthHookGenerator<Context, Yield, Returned>
): HookGeneratorRuntime => {
  // SAFETY: BetterAuthHookGenerator is the public sync/async generator contract; this boundary only erases its inferred channels.
  return generator as HookGeneratorRuntime
}

const castGeneratorFactory = <Yield extends EffectYield, Returned extends AnyResult>(
  factory: HookProgramFactory
): HookGeneratorFactory<Yield, Returned> & HookProgramConstraint => {
  // SAFETY: the public generator channels establish the concrete Result and requirement metadata.
  return factory as HookGeneratorFactory<Yield, Returned> & HookProgramConstraint
}

const makeGeneratorFactory = <Yield extends EffectYield, Returned extends AnyResult>(
  generator: HookGeneratorRuntime
): HookGeneratorFactory<Yield, Returned> & HookProgramConstraint => {
  const factory: HookProgramFactory = (context: BetterAuthMiddlewareContext) => {
    // SAFETY: BetterAuthHookGenerator validates the sync/async Result generator at the public boundary; Effect.fn preserves its lazy execution.
    return Effect.fn(
      () => generator(context) as Generator<EffectYield, AnyResult, unknown>
    ) as Effect.Program<unknown, unknown, AnyService>
  }

  return castGeneratorFactory<Yield, Returned>(factory)
}

const makeHookOperation = <Requirements extends AnyService>(
  build: (executor: RuntimeExecutor<AnyService>) => BetterAuthMiddleware
): BetterAuthHookOperation<Requirements> => {
  const operation = {
    *[Symbol.iterator](): Generator<
      ServiceRequirement<Requirements>,
      BetterAuthMiddleware,
      unknown
    > {
      const executor = yield* Runtime.executor<Requirements>()
      // SAFETY: The operation's phantom requirement is validated by the outer Layer boundary; the executor view is non-owning.
      return build(eraseExecutor(executor))
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<
      ServiceRequirement<Requirements>,
      BetterAuthMiddleware,
      unknown
    > {
      const executor = yield* Runtime.executor<Requirements>()
      // SAFETY: The operation's phantom requirement is validated by the outer Layer boundary; the executor view is non-owning.
      return build(eraseExecutor(executor))
    }
  }

  return Object.freeze(operation)
}

/** Create a bridge that is inert until it is acquired inside a Runtime-backed Layer. */
function defineBetterAuthHooks<const Tag extends string>(
  tag: BetterAuthLiteralTag<Tag>
): BetterAuthHooksDefinition<Tag> {
  type ContextInstance = BetterAuthHookContextValue & Service.Identity<Tag>

  const Context = makeContextToken(tag)

  const middleware = <
    Factory extends HookProgramFactory,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    program: Factory & HookProgramConstraint,
    ...options: HookMiddlewareCallArguments<
      HookFailure<Factory>,
      ValidateHookSuccess<NoInfer<Factory>>,
      BetterAuthHookMiddlewareOptions<
        HookFailure<Factory>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ): BetterAuthHookOperation<
    HookExternalRequirements<NoInfer<Factory>, RequestLayer, ContextInstance>
  > => {
    const configured = options[0]

    // SAFETY: The public generic signature retains the exact external requirement union; the operation runtime erases only that phantom channel.
    return makeHookOperation((executor) =>
      createBoundMiddleware(executor, Context, program, configured)
    ) as BetterAuthHookOperation<
      HookExternalRequirements<NoInfer<Factory>, RequestLayer, ContextInstance>
    >
  }

  const gen = <
    Yield extends EffectYield,
    Returned extends AnyResult,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    generator: BetterAuthHookGenerator<BetterAuthMiddlewareContext, Yield, Returned>,
    ...options: HookMiddlewareCallArguments<
      HookGeneratorFailure<Yield, Returned>,
      ValidateGeneratedHook<Yield, Returned>,
      BetterAuthHookMiddlewareOptions<
        HookGeneratorFailure<Yield, Returned>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ): BetterAuthHookOperation<
    HookExternalRequirements<GeneratedHookFactory<Yield, Returned>, RequestLayer, ContextInstance>
  > => {
    const configured = options[0]
    const factory = makeGeneratorFactory<Yield, Returned>(eraseGenerator(generator))

    // SAFETY: The public generic signature retains the exact external requirement union; the operation runtime erases only that phantom channel.
    return makeHookOperation((executor) =>
      createBoundMiddleware(executor, Context, factory, configured)
    ) as BetterAuthHookOperation<
      HookExternalRequirements<GeneratedHookFactory<Yield, Returned>, RequestLayer, ContextInstance>
    >
  }

  return Object.freeze({
    Context,
    middleware,
    gen
  })
}

/** Create a compatibility bridge bound to one caller-owned Runtime. */
function makeBetterAuthHooks<const Tag extends string, Provided extends AnyService>(
  tag: BetterAuthLiteralTag<Tag>,
  runtime: Runtime<Provided>
): BetterAuthHooksInstance<Tag, Provided> {
  type ContextInstance = BetterAuthHookContextValue & Service.Identity<Tag>

  const Context = makeContextToken(tag)
  const executor = legacyRuntimeExecutor(runtime)

  const middleware = <
    Factory extends HookProgramFactory,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    program: Factory & HookProgramConstraint,
    ...options: HookMiddlewareCallArguments<
      HookFailure<Factory>,
      ValidateHookProgram<Provided, NoInfer<Factory>, ContextInstance, RequestLayer>,
      BetterAuthHookMiddlewareOptions<
        HookFailure<Factory>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ): BetterAuthMiddleware => createBoundMiddleware(executor, Context, program, options[0])

  const gen = <
    Yield extends EffectYield,
    Returned extends AnyResult,
    RequestLayer extends Layer.Any = typeof Layer.empty
  >(
    generator: BetterAuthHookGenerator<BetterAuthMiddlewareContext, Yield, Returned>,
    ...options: HookMiddlewareCallArguments<
      HookGeneratorFailure<Yield, Returned>,
      ValidateGeneratedHookProgram<Provided, Yield, Returned, ContextInstance, RequestLayer>,
      BetterAuthHookMiddlewareOptions<
        HookGeneratorFailure<Yield, Returned>,
        BetterAuthMiddlewareContext,
        RequestLayer
      >
    >
  ): BetterAuthMiddleware => {
    const factory = makeGeneratorFactory<Yield, Returned>(eraseGenerator(generator))
    return createBoundMiddleware(executor, Context, factory, options[0])
  }

  return Object.freeze({
    Context,
    middleware,
    gen
  })
}

/** Framework-agnostic Better Auth hook and plugin middleware bridge. */
export const BetterAuthHooks = Object.freeze({
  define: defineBetterAuthHooks,
  /** @deprecated Prefer `BetterAuthHooks.define(tag)` and yield its builders from `BetterAuth.make`. */
  make: makeBetterAuthHooks
})

/** Type aliases colocated with the `BetterAuthHooks` factory. */
export declare namespace BetterAuthHooks {
  export type Context = BetterAuthMiddlewareContext
  export type ContextValue<ContextType = BetterAuthMiddlewareContext> =
    BetterAuthHookContextValue<ContextType>
  export type ContextReplacement<ContextType = BetterAuthMiddlewareContext> =
    BetterAuthHookContextReplacement<ContextType>
  export type Success<ContextType = BetterAuthMiddlewareContext> =
    BetterAuthHookSuccess<ContextType>
  export type FailureMapper<
    Failure,
    ContextType = BetterAuthMiddlewareContext
  > = BetterAuthHookFailureMapper<Failure, ContextType>
  export type LayerFactory<
    ContextType = BetterAuthMiddlewareContext,
    RequestLayer extends Layer.Any = typeof Layer.empty
  > = BetterAuthHookLayerFactory<ContextType, RequestLayer>
  export type Generator<
    ContextType = BetterAuthMiddlewareContext,
    Yield extends EffectYield = EffectYield,
    Returned extends ResultType<any, any> = ResultType<any, any>
  > = BetterAuthHookGenerator<ContextType, Yield, Returned>
  export type Middleware = BetterAuthMiddleware
  export type Operation<Requirements extends AnyService = never> =
    BetterAuthHookOperation<Requirements>
  export type Program<
    ContextType = BetterAuthMiddlewareContext,
    SuccessType extends BetterAuthHookSuccess<ContextType> = BetterAuthHookSuccess<ContextType>,
    Failure = unknown,
    Requirements extends AnyService = AnyService
  > = BetterAuthHookProgramFactory<ContextType, SuccessType, Failure, Requirements>
  export type MiddlewareOptions<
    Failure,
    ContextType = BetterAuthMiddlewareContext,
    RequestLayer extends Layer.Any = typeof Layer.empty
  > = BetterAuthHookMiddlewareOptions<Failure, ContextType, RequestLayer>
  export type ContextToken<Tag extends string> = BetterAuthHookContextToken<Tag>
  export type Definition<Tag extends string> = BetterAuthHooksDefinition<Tag>
  export type Instance<Tag extends string, Provided extends AnyService> = BetterAuthHooksInstance<
    Tag,
    Provided
  >
}

/** The Context Service token returned by one `BetterAuthHooks.define` or `make` call. */
export type BetterAuthHookContextToken<Tag extends string> = Service.Class<
  Tag,
  BetterAuthHookContextValue & Service.Identity<Tag>
> & {
  readonly [Symbol.iterator]: (
    this: Service.Token<Tag, BetterAuthHookContextValue & Service.Identity<Tag>>
  ) => Generator<
    ServiceRequirement<BetterAuthHookContextValue & Service.Identity<Tag>>,
    BetterAuthHookContextValue & Service.Identity<Tag>,
    unknown
  >
  readonly [Symbol.asyncIterator]: (
    this: Service.Token<Tag, BetterAuthHookContextValue & Service.Identity<Tag>>
  ) => AsyncGenerator<
    ServiceRequirement<BetterAuthHookContextValue & Service.Identity<Tag>>,
    BetterAuthHookContextValue,
    unknown
  >
}
