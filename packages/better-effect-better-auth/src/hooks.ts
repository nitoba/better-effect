import { createAuthMiddleware } from 'better-auth/api'

import type { APIError } from 'better-auth/api'

import { Effect, Layer, Runtime, Service } from 'better-effect'

import type { AnyService, ServiceRequirement } from 'better-effect'

import { Result } from 'better-result'

import type { Result as ResultType } from 'better-result'

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

/** The Context Service token returned by one `BetterAuthHooks.make` call. */
export type BetterAuthHookContextToken<Tag extends string> = Service.Class<
  Tag,
  BetterAuthHookContextValue & Service.Identity<Tag>
> & {
  readonly [Symbol.asyncIterator]: (
    this: Service.Token<Tag, BetterAuthHookContextValue & Service.Identity<Tag>>
  ) => AsyncGenerator<
    ServiceRequirement<BetterAuthHookContextValue & Service.Identity<Tag>>,
    BetterAuthHookContextValue,
    unknown
  >
}

/** Options for a program with no typed failure channel. */
export type BetterAuthHookNoFailureOptions = {
  readonly onFailure?: never
}

/** Options for a program whose typed failure channel must be mapped explicitly. */
export type BetterAuthHookFailureOptions<Failure, Context = BetterAuthMiddlewareContext> = {
  readonly onFailure: BetterAuthHookFailureMapper<Failure, Context>
}

/** Public options selected from the program's inferred failure channel. */
export type BetterAuthHookMiddlewareOptions<Failure, Context = BetterAuthMiddlewareContext> = [
  Failure
] extends [never]
  ? BetterAuthHookNoFailureOptions
  : BetterAuthHookFailureOptions<Failure, Context>

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

/** Internal diagnostic retained in the public call-site signature. */
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

type ValidateHookRequirements<
  Provided extends AnyService,
  Factory extends HookProgramFactory,
  ContextInstance extends AnyService
> =
  MissingServices<HookRequirements<Factory>, Provided | ContextInstance> extends infer Missing
    ? [Missing] extends [never]
      ? unknown
      : Missing extends AnyService
        ? MissingDependencies<Missing>
        : never
    : never

type ValidateHookProgram<
  Provided extends AnyService,
  Factory extends HookProgramFactory,
  ContextInstance extends AnyService
> = ValidateHookSuccess<Factory> & ValidateHookRequirements<Provided, Factory, ContextInstance>

type HookMiddlewareArguments<Failure, Context> = [Failure] extends [never]
  ? [options?: BetterAuthHookMiddlewareOptions<Failure, Context>]
  : [options: BetterAuthHookMiddlewareOptions<Failure, Context>]

type IsUnknown<Value> =
  IsAny<Value> extends true
    ? false
    : unknown extends Value
      ? [keyof Value] extends [never]
        ? true
        : false
      : false

type HookMiddlewareCallArguments<Failure, Context, Validation> =
  IsUnknown<Validation> extends true
    ? HookMiddlewareArguments<Failure, Context>
    : [validation: Validation, ...HookMiddlewareArguments<Failure, Context>]

/** A Better Auth hook bridge bound to one caller-owned Runtime. */
export interface BetterAuthHooksInstance<Tag extends string, Provided extends AnyService> {
  readonly Context: BetterAuthHookContextToken<Tag>
  readonly middleware: <Factory extends HookProgramFactory>(
    program: Factory & HookProgramConstraint,
    ...options: HookMiddlewareCallArguments<
      HookFailure<Factory>,
      BetterAuthMiddlewareContext,
      ValidateHookProgram<
        Provided,
        NoInfer<Factory>,
        BetterAuthHookContextValue & Service.Identity<Tag>
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

const executeHook = async <
  Provided extends AnyService,
  Tag extends string,
  Factory extends HookProgramFactory
>(
  runtime: Runtime<Provided>,
  contextService: BetterAuthHookContextToken<Tag>,
  context: BetterAuthMiddlewareContext,
  factory: Factory & HookProgramConstraint,
  request: Request | undefined
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
  // SAFETY: Runtime.runWith erases the heterogeneous per-invocation Layer after its public boundary validates the provider.
  const uncheckedLayer = contextLayer as Layer.Any
  // SAFETY: the public Program constraint establishes this Result shape; this cast only removes generic implementation erasure.
  const uncheckedExecution = execute as () =>
    | ResultType<unknown, unknown>
    | PromiseLike<ResultType<unknown, unknown>>
  const result = await runtime.runWith(uncheckedLayer, uncheckedExecution, options)

  // SAFETY: the public Program constraint and Runtime boundary establish the concrete Result channels.
  return result as HookResult<Factory>
}

/** Create a bridge that runs Better Auth middleware Programs in an existing Runtime. */
function makeBetterAuthHooks<const Tag extends string, Provided extends AnyService>(
  tag: BetterAuthLiteralTag<Tag>,
  runtime: Runtime<Provided>
): BetterAuthHooksInstance<Tag, Provided> {
  type ContextInstance = BetterAuthHookContextValue & Service.Identity<Tag>

  // SAFETY: Service() exposes an abstract constructor type even though this factory creates a concrete runtime token.
  const abstractContext = Service<ContextInstance>()(tag)
  // SAFETY: The factory returns this concrete Service token; the assertion adds its public Context iterator type.
  const Context = abstractContext as BetterAuthHookContextToken<Tag>

  const middleware = <Factory extends HookProgramFactory>(
    program: Factory & HookProgramConstraint,
    ...options: HookMiddlewareCallArguments<
      HookFailure<Factory>,
      BetterAuthMiddlewareContext,
      ValidateHookProgram<Provided, NoInfer<Factory>, ContextInstance>
    >
  ): BetterAuthMiddleware => {
    const configured = options[0]
    const onFailure =
      configured !== undefined && 'onFailure' in configured ? configured.onFailure : undefined

    return createAuthMiddleware(async (context) => {
      const result = await executeHook(runtime, Context, context, program, context.request)

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

  return Object.freeze({
    Context,
    middleware
  })
}

/** Framework-agnostic Better Auth hook and plugin middleware bridge. */
export const BetterAuthHooks = Object.freeze({
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
  export type Middleware = BetterAuthMiddleware
  export type Program<
    ContextType = BetterAuthMiddlewareContext,
    SuccessType extends BetterAuthHookSuccess<ContextType> = BetterAuthHookSuccess<ContextType>,
    Failure = unknown,
    Requirements extends AnyService = AnyService
  > = BetterAuthHookProgramFactory<ContextType, SuccessType, Failure, Requirements>
  export type MiddlewareOptions<
    Failure,
    ContextType = BetterAuthMiddlewareContext
  > = BetterAuthHookMiddlewareOptions<Failure, ContextType>
  export type ContextToken<Tag extends string> = BetterAuthHookContextToken<Tag>
  export type Instance<Tag extends string, Provided extends AnyService> = BetterAuthHooksInstance<
    Tag,
    Provided
  >
}
