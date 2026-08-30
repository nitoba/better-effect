import { Result } from 'better-result'
import { createMiddleware } from 'hono/factory'
import type { Env, MiddlewareHandler } from 'hono'

import { Effect } from '../effect'
import type { LayerInput } from '../layer/inference'
import { Runtime } from '../runtime'
import type { AnyService } from '../service'
import { WebEffect } from '../web'
import type { AnyRouteOptions, HonoContext, HonoEffectSuccess, ResponseLike } from './types'

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

export type RequestBoundaryOptions<
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Failure
> = {
  readonly runtime: Runtime<Provided>
  readonly states: WeakMap<object, RequestState>
  readonly requestLayer?: ((context: HonoContext) => RequestLayer) | undefined
  readonly onSuccess: (result: HonoEffectSuccess<any>, context: HonoContext) => ResponseLike
  readonly onFailure: (error: Failure, context: HonoContext) => ResponseLike
}

type BoundaryOptions<RequestLayer extends LayerInput> = {
  readonly requestLayer?: (request: Request) => RequestLayer
  readonly onSuccess: (result: { readonly value: unknown }) => ResponseLike
  readonly onFailure: (error: unknown) => ResponseLike
}

const makeBoundaryOptions = <Provided extends AnyService, RequestLayer extends LayerInput, Failure>(
  options: RequestBoundaryOptions<Provided, RequestLayer, Failure>,
  state: RequestState,
  context: HonoContext
): BoundaryOptions<RequestLayer> => {
  const boundaryOptions: BoundaryOptions<RequestLayer> = {
    onSuccess: ({ value }) => {
      if (context.finalized) {
        return context.res
      }

      const outcome = state.outcome

      if (outcome?.kind !== 'success') {
        // SAFETY: Values without a Hono route outcome are existing Web Responses; WebEffect validates them.
        return value as Response
      }

      if (outcome.options.respond !== undefined) {
        return outcome.options.respond(value, context)
      }

      const success: HonoEffectSuccess = { value }

      if (outcome.options.status !== undefined) {
        Object.assign(success, { status: outcome.options.status })
      }

      if (outcome.options.serialize !== undefined) {
        Object.assign(success, { serialize: outcome.options.serialize })
      }

      return options.onSuccess(success, context)
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
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  Failure,
  E extends Env = Env,
  Path extends string = string
>(
  options: RequestBoundaryOptions<Provided, RequestLayer, Failure>
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

      if (options.requestLayer === undefined) {
        response = await WebEffect.handle(options.runtime, context.req.raw, program, {
          onSuccess: boundaryOptions.onSuccess,
          onFailure: boundaryOptions.onFailure
        })
      } else {
        const requestBoundaryOptions = {
          onSuccess: boundaryOptions.onSuccess,
          onFailure: boundaryOptions.onFailure,
          requestLayer: (_request: Request) => options.requestLayer!(context)
        }
        // SAFETY: HonoEffect.make validates the concrete request Layer before this erased WebEffect dispatch.
        response = await WebEffect.handle(
          options.runtime,
          context.req.raw,
          program,
          requestBoundaryOptions as never
        )
      }

      if (!context.finalized || context.res !== response) {
        context.res = response
      }
    } finally {
      options.states.delete(key)
    }
  }) as MiddlewareHandler<E, Path>
}
