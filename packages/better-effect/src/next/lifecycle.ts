/* oxlint-disable anti-slop/no-object-parameters -- private route boundaries erase framework context after public overload validation. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- these are localized adapter erasures after overload checks. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- assertions below are confined to checked overload implementations. */

import type { CompleteInput, LayerInput, ProvidedEnvironment } from '../layer/inference'
import { Effect } from '../effect'
import type { EffectSuccess, EffectYield, ProgramFromGenerator } from '../effect/types'
import { Runtime } from '../runtime'
import type { RuntimeDisposeOptions, RuntimeExecutor } from '../runtime'
import type { AnyService } from '../service'
import type {
  AnyProgram,
  AnyResult,
  CompleteNextProgram,
  GeneratorBody,
  NextEffectManagedInspection,
  NextEffectManagedOptions,
  NextEffectRouteOptions,
  NextGeneratorChecks,
  NextHandlerFactory,
  NextRouteHandler
} from './types'
import { makeNextRouteHandler } from './route-builder'

/** Thrown when a managed NextEffect no longer accepts new requests. */
export class NextEffectDisposedError extends Error {
  constructor() {
    super('Cannot use a disposed NextEffect manager')
    this.name = 'NextEffectDisposedError'
  }
}

type RuntimeForLayer<Layer extends LayerInput> = Runtime<ProvidedEnvironment<Layer>>

type AnyManagedOptions = NextEffectManagedOptions<any, LayerInput, object>

type RouteHandler = ReturnType<typeof makeNextRouteHandler>

/** Own one lazy Runtime for a Next host without exposing that Runtime publicly. */
export class ManagedNextEffect<
  Layer extends LayerInput,
  Failure = unknown,
  RequestLayer extends LayerInput = ReturnType<
    typeof import('../standard-services/current-request').CurrentRequest.layer
  >,
  Context extends object = import('./types').NextEffectContext
> {
  private state: NextEffectManagedInspection['state'] = 'idle'

  private runtimePromise: Promise<RuntimeForLayer<Layer>> | undefined

  private runtime: RuntimeForLayer<Layer> | undefined

  private disposePromise: Promise<void> | undefined

  private readonly activeHandlers = new Set<Promise<unknown>>()

  constructor(
    private readonly layer: Layer & CompleteInput<Layer>,
    private readonly options: NextEffectManagedOptions<Failure, RequestLayer, Context>
  ) {}

  /** Create a native Route Handler from a checked Program factory. */
  handler<Program extends AnyProgram>(
    makeProgram: (
      request: Request,
      context: Context
    ) => CompleteNextProgram<ProvidedEnvironment<Layer>, RequestLayer, Program, Failure>,
    options?: NextEffectRouteOptions<EffectSuccess<Program>, Context>
  ): NextRouteHandler<Context>
  handler<
    const HandlerContext extends object,
    const ProgramFactory extends (request: Request, context: HandlerContext) => AnyProgram
  >(
    makeProgram: NextHandlerFactory<
      HandlerContext,
      ProvidedEnvironment<Layer>,
      RequestLayer,
      Failure,
      ProgramFactory
    >,
    options?: NextEffectRouteOptions<EffectSuccess<ReturnType<ProgramFactory>>, HandlerContext>
  ): NextRouteHandler<HandlerContext>
  handler(...args: unknown[]): NextRouteHandler<object> {
    const makeProgram = args[0] as (request: Request, context: object) => AnyProgram
    const options = (args[1] ?? {}) as NextEffectRouteOptions<unknown, object>
    const route = makeNextRouteHandler(
      (_request, _context) =>
        this.executor().then((executor) => executor as unknown as RuntimeExecutor<AnyService>),
      this.options as unknown as AnyManagedOptions,
      makeProgram,
      options
    )

    return this.protect(route) as NextRouteHandler<object>
  }

  /** Create a native Route Handler from a checked generator body. */
  gen<
    const HandlerContext extends object = Context,
    const Yield extends EffectYield = EffectYield,
    const Returned extends AnyResult = AnyResult
  >(
    body: GeneratorBody<HandlerContext, Yield, Returned> &
      NextGeneratorChecks<ProvidedEnvironment<Layer>, RequestLayer, Yield, Returned, Failure>,
    options?: NextEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<Yield, Returned>>,
      HandlerContext
    >
  ): NextRouteHandler<HandlerContext>
  gen<
    const CustomContext extends object,
    const CustomYield extends EffectYield,
    const CustomReturned extends AnyResult
  >(
    body: GeneratorBody<CustomContext, CustomYield, CustomReturned> &
      NextGeneratorChecks<
        ProvidedEnvironment<Layer>,
        RequestLayer,
        CustomYield,
        CustomReturned,
        Failure
      >,
    options?: NextEffectRouteOptions<
      EffectSuccess<ProgramFromGenerator<CustomYield, CustomReturned>>,
      CustomContext
    >
  ): NextRouteHandler<CustomContext>
  gen(...args: unknown[]): NextRouteHandler<object> {
    const body = args[0] as GeneratorBody<object, EffectYield, AnyResult>
    const options = (args[1] ?? {}) as NextEffectRouteOptions<unknown, object>
    const route = makeNextRouteHandler(
      (_request, _context) =>
        this.executor().then((executor) => executor as unknown as RuntimeExecutor<AnyService>),
      this.options as unknown as AnyManagedOptions,
      (request, context) => {
        const program = Effect.fn(
          () => body(request, context) as AsyncGenerator<EffectYield, AnyResult, unknown>
        )
        return program as AnyProgram
      },
      options
    )
    return this.protect(route) as NextRouteHandler<object>
  }

  /** Eagerly initialize the manager's single Runtime. */
  async initialize(): Promise<void> {
    await this.ensureRuntime(false)
  }

  /** Return a detached lifecycle snapshot without exposing the owned Runtime. */
  inspect(): NextEffectManagedInspection {
    const runtime = this.runtime?.inspect()

    if (runtime === undefined) {
      return Object.freeze({ state: this.state })
    }

    return Object.freeze({ state: this.state, runtime })
  }

  /** Stop admitting requests, drain admitted handlers, and dispose the owned Runtime. */
  dispose(options?: RuntimeDisposeOptions): Promise<void> {
    if (this.disposePromise !== undefined) {
      return this.disposePromise
    }

    this.state = 'disposing'
    const activeHandlers = [...this.activeHandlers]
    const disposal = this.performDispose(activeHandlers, options)
    this.disposePromise = disposal
    return disposal
  }

  /** Release the owned Runtime through JavaScript's async disposal protocol. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
  }

  /** Wrap a materialized route so requests admitted before disposal are drained. */
  private protect(handler: RouteHandler): RouteHandler {
    return async (request, context) => await this.runAdmitted(() => handler(request, context))
  }

  /** Resolve the non-owning executor for an already admitted request. */
  private executor(): Promise<RuntimeExecutor<ProvidedEnvironment<Layer>>> {
    return this.ensureRuntime(true).then((runtime) => runtime.executor)
  }

  private ensureRuntime(allowDisposing: boolean): Promise<RuntimeForLayer<Layer>> {
    if (this.state === 'disposed' || (this.state === 'disposing' && !allowDisposing)) {
      return Promise.reject(new NextEffectDisposedError())
    }

    if (this.runtimePromise !== undefined) {
      return this.runtimePromise
    }

    this.state = 'initializing'
    const runtimePromise = Runtime.make(this.layer, this.options.runtime)
    this.runtimePromise = runtimePromise

    void runtimePromise.then(
      (runtime) => {
        this.runtime = runtime

        if (this.state === 'initializing') {
          this.state = 'ready'
        }
      },
      () => {
        if (this.state === 'initializing') {
          this.state = 'failed'
        }
      }
    )

    return runtimePromise
  }

  private async runAdmitted<A>(run: () => A | PromiseLike<A>): Promise<Awaited<A>> {
    if (this.state === 'disposing' || this.state === 'disposed') {
      throw new NextEffectDisposedError()
    }

    const execution = Promise.resolve().then(run) as Promise<Awaited<A>>
    this.activeHandlers.add(execution)
    void execution.then(
      () => this.activeHandlers.delete(execution),
      () => this.activeHandlers.delete(execution)
    )
    return await execution
  }

  private async performDispose(
    activeHandlers: readonly Promise<unknown>[],
    options: RuntimeDisposeOptions | undefined
  ): Promise<void> {
    await Promise.allSettled(activeHandlers)

    let runtime: RuntimeForLayer<Layer> | undefined

    if (this.runtimePromise !== undefined) {
      try {
        runtime = await this.runtimePromise
      } catch {
        // Runtime.make owns cleanup for initialization failures; preserve the request/init error.
      }
    }

    let disposalFailure: unknown

    if (runtime !== undefined) {
      try {
        await runtime.dispose(options)
      } catch (cause) {
        disposalFailure = cause
      }
    }

    this.state = 'disposed'

    if (disposalFailure !== undefined) {
      throw disposalFailure
    }
  }
}
