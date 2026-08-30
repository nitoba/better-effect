import { Result } from 'better-result'
import { createMiddleware } from 'hono/factory'
import type { Env, MiddlewareHandler } from 'hono'

import { CurrentRequest } from '../standard-services/current-request'
import { Layer } from '../layer'
import type { LayerInput } from '../layer/inference'
import { Runtime } from '../runtime'
import type { AnyService } from '../service'
import type { HonoContext } from './types'

export type RequestState = {
  failure?: {
    readonly cause: unknown
  }
}

export type RequestBoundaryOptions<Provided extends AnyService, RequestLayer extends LayerInput> = {
  readonly runtime: Runtime<Provided>
  readonly states: WeakMap<object, RequestState>
  readonly requestLayer?: ((context: HonoContext) => RequestLayer) | undefined
}

const overrideRequestLayer = (base: LayerInput, replacement: LayerInput): Layer<any, any> => {
  // SAFETY: HonoEffect.make validates the concrete replacement before this erased dispatch boundary.
  return Layer.override(base, replacement as never)
}

export const makeRequestBoundary = <
  Provided extends AnyService,
  RequestLayer extends LayerInput,
  E extends Env = Env,
  Path extends string = string
>(
  options: RequestBoundaryOptions<Provided, RequestLayer>
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
      const requestLayer = CurrentRequest.layer(context.req.raw)
      const customLayer = options.requestLayer?.(context)
      const layer: Layer<any, any> =
        customLayer === undefined ? requestLayer : overrideRequestLayer(requestLayer, customLayer)

      await options.runtime.runWith(
        layer,
        async () => {
          try {
            await next()
          } catch (cause) {
            state.failure ??= { cause }
          }

          if (state.failure !== undefined) {
            return Result.err(state.failure.cause)
          }

          if (context.error !== undefined) {
            return Result.err(context.error)
          }

          return Result.ok(context.res)
        },
        { signal: context.req.raw.signal }
      )
    } finally {
      options.states.delete(key)
    }
  }) as MiddlewareHandler<E, Path>
}
