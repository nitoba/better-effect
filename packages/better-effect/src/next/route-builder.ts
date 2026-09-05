/* oxlint-disable anti-slop/no-object-parameters -- the private boundary erases arbitrary framework context types after public overload validation. */
/* oxlint-disable anti-slop/no-unknown-parameters -- response policy values are opaque until WebEffect validates them. */
/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the private WebEffect options object is populated only by checked policies. */

import { Result } from 'better-result'

import type { LayerInput } from '../layer/inference'
import type { RuntimeExecutor } from '../runtime'
import type { AnyService } from '../service'
import { WebEffect } from '../web'
import type {
  AnyProgram,
  NextEffectOptions,
  NextEffectRouteOptions,
  NextRouteHandler
} from './types'

const routeSuccessPolicyNames = ['respond', 'serialize', 'onSuccess'] as const

const assertExclusiveRouteSuccessPolicy = (
  options: NextEffectRouteOptions<unknown, object>
): void => {
  const configuredPolicies = routeSuccessPolicyNames.filter((name) => options[name] !== undefined)

  if (configuredPolicies.length > 1) {
    throw new TypeError(
      `NextEffect route options must configure at most one success policy; received ${configuredPolicies.join(', ')}`
    )
  }
}

type AnyNextEffectOptions = NextEffectOptions<unknown, LayerInput, object>

type ExecutorProvider = (
  request: Request,
  context: object
) => RuntimeExecutor<AnyService> | PromiseLike<RuntimeExecutor<AnyService>>

/** Build the shared Next/WebEffect request boundary for both ownership modes. */
export const makeNextRouteHandler = (
  getExecutor: ExecutorProvider,
  instanceOptions: AnyNextEffectOptions,
  makeProgram: (request: Request, context: object) => AnyProgram,
  routeOptions: NextEffectRouteOptions<unknown, object>
): NextRouteHandler<object> => {
  assertExclusiveRouteSuccessPolicy(routeOptions)

  return async (request, context) => {
    const executor = await getExecutor(request, context)
    const program = makeProgram(request, context)
    const effectiveProgram =
      routeOptions.serialize === undefined
        ? program
        : async () => {
            const result = await program()

            if (Result.isError(result)) {
              return result
            }

            return Result.ok(routeOptions.serialize!(result.value, request, context))
          }
    const webOptions: Record<string, unknown> = {}

    if (instanceOptions.requestLayer !== undefined) {
      webOptions.requestLayer = () => instanceOptions.requestLayer!(request, context)
    }

    if (routeOptions.respond !== undefined) {
      webOptions.onSuccess = ({ value }: { readonly value: unknown }) =>
        routeOptions.respond!(value, request, context)
    } else if (routeOptions.onSuccess !== undefined) {
      webOptions.onSuccess = (result: { readonly value: unknown }) =>
        routeOptions.onSuccess!(result, request, context)
    } else if (instanceOptions.onSuccess !== undefined) {
      webOptions.onSuccess = (result: { readonly value: unknown }) =>
        instanceOptions.onSuccess!(result, request, context)
    }

    if (instanceOptions.onFailure !== undefined) {
      webOptions.onFailure = (error: unknown) => instanceOptions.onFailure!(error, request, context)
    }

    // SAFETY: Public overloads validated the Program, request Layer, and policies before this erased WebEffect boundary.
    return await WebEffect.handleWith(
      executor,
      request,
      // SAFETY: Serialization preserves the original Result error and Service channels.
      effectiveProgram as AnyProgram,
      // SAFETY: This private options object is populated only from the checked policy unions above.
      webOptions as never
    )
  }
}
