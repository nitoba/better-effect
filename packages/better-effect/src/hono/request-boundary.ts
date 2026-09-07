import { Result } from 'better-result'
import { createMiddleware } from 'hono/factory'
import type { Env, MiddlewareHandler } from 'hono'

import { Effect } from '../effect'
import type { LayerInput } from '../layer/inference'
import type { RuntimeExecutor, RuntimeManagedExecution, RuntimeManagedPlan } from '../runtime'
import type { AnyService } from '../service'
import { makeManagedResponse, runManagedWith } from '../web/web-effect'
import { assertResponse } from '../web/responses'
import type {
  AnyRouteOptions,
  HonoContext,
  HonoEffectStreamOptions,
  HonoEffectSuccess,
  ResponseLike
} from './types'
import type { WebEffectStream } from '../web/types'

/* oxlint-disable anti-slop/no-unknown-parameters -- Hono handlers carry opaque Result values until the typed adapter callbacks consume them. */

type RequestOutcome =
  | {
      readonly kind: 'success'
      readonly value: unknown
      readonly options: AnyRouteOptions
    }
  | {
      readonly kind: 'failure'
      readonly cause: unknown
    }
  | {
      readonly kind: 'defect'
      readonly cause: unknown
    }
  | {
      readonly kind: 'stream'
      readonly descriptor: WebEffectStream
      readonly options: HonoEffectStreamOptions
    }

export type RequestState = {
  outcome?: RequestOutcome
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Result failures are intentionally opaque until the Hono policy narrows them.
export const recordRequestFailure = (state: RequestState, cause: unknown): void => {
  state.outcome ??= { kind: 'failure', cause }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Route success values retain their public generic type only at the Hono handler boundary.
export const recordRequestSuccess = (
  state: RequestState,
  value: unknown,
  options: AnyRouteOptions
): void => {
  state.outcome ??= { kind: 'success', value, options }
}

export const recordRequestStream = (
  state: RequestState,
  descriptor: WebEffectStream,
  options: HonoEffectStreamOptions
): void => {
  state.outcome ??= { kind: 'stream', descriptor, options }
}

export type RequestBoundaryOptions<RequestLayer extends LayerInput, Failure> = {
  readonly executor: RuntimeExecutor<AnyService>
  readonly states: WeakMap<object, RequestState>
  readonly requestLayer?: ((context: HonoContext) => RequestLayer) | undefined
  readonly onSuccess: (result: HonoEffectSuccess<any>, context: HonoContext) => ResponseLike
  readonly onFailure: (error: Failure, context: HonoContext) => ResponseLike
}

type BoundaryOptions<RequestLayer extends LayerInput> = {
  readonly requestLayer?: (request: Request) => RequestLayer
  readonly onSuccess: (
    result: { readonly value: unknown },
    managed: Promise<RuntimeManagedExecution<unknown>>
  ) => RuntimeManagedPlan<Response> | PromiseLike<RuntimeManagedPlan<Response>>
  readonly onFailure: (error: unknown) => ResponseLike
}

const responsePlan = (response: ResponseLike): RuntimeManagedPlan<Response> => {
  const readiness = Promise.resolve(response).then((value) => assertResponse(value))

  return {
    readiness,
    completion: readiness.then(() => undefined),
    cancel: async () => {}
  }
}

const makeBoundaryOptions = <RequestLayer extends LayerInput, Failure>(
  options: RequestBoundaryOptions<RequestLayer, Failure>,
  state: RequestState,
  context: HonoContext
): BoundaryOptions<RequestLayer> => {
  const boundaryOptions: BoundaryOptions<RequestLayer> = {
    onSuccess: ({ value }, managed) => {
      if (context.finalized) {
        return responsePlan(context.res)
      }

      const outcome = state.outcome

      if (outcome?.kind === 'stream') {
        return makeManagedResponse(outcome.descriptor, managed, outcome.options.unconsumedTimeoutMs)
      }

      if (outcome?.kind !== 'success') {
        // SAFETY: Values without a Hono route outcome are existing Web Responses; WebEffect validates them.
        return responsePlan(value as Response)
      }

      if (outcome.options.respond !== undefined) {
        return responsePlan(outcome.options.respond(value, context))
      }

      const success: HonoEffectSuccess = { value }

      if (outcome.options.status !== undefined) {
        Object.assign(success, { status: outcome.options.status })
      }

      if (outcome.options.serialize !== undefined) {
        Object.assign(success, { serialize: outcome.options.serialize })
      }

      return responsePlan(options.onSuccess(success, context))
    },
    onFailure: (error) => {
      if (context.error !== undefined || context.finalized) {
        return context.res
      }

      if (state.outcome?.kind === 'defect') {
        // SAFETY: Hono has already converted its Error into context.res through app.onError; WebEffect validates it.
        return context.res
      }

      // SAFETY: HonoEffect validates the Program failure channel against Failure before this erased Web boundary.
      return options.onFailure(error as Failure, context)
    }
  }

  if (options.requestLayer !== undefined) {
    Object.assign(boundaryOptions, {
      requestLayer: (_request: Request) => options.requestLayer!(context)
    })
  }

  return boundaryOptions
}

const selectBoundaryResult = (state: RequestState, context: HonoContext) => {
  const outcome = state.outcome

  if (outcome?.kind === 'failure') {
    return Result.err(outcome.cause)
  }

  if (context.error !== undefined) {
    state.outcome = { kind: 'defect', cause: context.error }
    return Result.err(context.error)
  }

  if (outcome?.kind === 'success') {
    return Result.ok(outcome.value)
  }

  return Result.ok(context.res)
}

export const makeRequestBoundary = <
  Failure,
  RequestLayer extends LayerInput,
  E extends Env = Env,
  Path extends string = string
>(
  options: RequestBoundaryOptions<RequestLayer, Failure>
): MiddlewareHandler<E, Path> => {
  // SAFETY: createMiddleware preserves the Hono handler contract; only the generic Context is restored here.
  return createMiddleware(async (context, next) => {
    const key = context
    const existing = options.states.get(key)

    if (existing !== undefined) {
      await next()
      return
    }

    const state: RequestState = {}
    options.states.set(key, state)

    try {
      // oxlint-disable-next-line require-yield -- The bridge turns the complete Hono chain into one lazy WebEffect Program.
      const program = Effect.fn(async function* () {
        await next()
        return selectBoundaryResult(state, context)
      })
      const boundaryOptions = makeBoundaryOptions(options, state, context)
      let response: Response

      // SAFETY: HonoEffect's public Layer boundary validates the request Layer before this erased WebEffect dispatch.
      response = await runManagedWith(
        options.executor,
        context.req.raw,
        program,
        boundaryOptions as never
      )

      if (!context.finalized || context.res !== response) {
        context.res = response
      }
    } finally {
      options.states.delete(key)
    }
  }) as MiddlewareHandler<E, Path>
}
