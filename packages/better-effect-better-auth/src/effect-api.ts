import type { Err, UnhandledException } from 'better-result'

import type { BetterAuthApiError } from './errors'

/** Transport fields owned by the effectful endpoint mode rather than by callers. */
export type BetterAuthTransportFlag = 'asResponse' | 'returnHeaders' | 'returnStatus'

/** A Better Auth operation that composes directly with `yield*` in a better-effect generator. */
export type BetterAuthOperation<A, E> = AsyncGenerator<Err<never, E>, A, unknown>

/** The typed failure channel shared by every effectful Better Auth endpoint mode. */
export type BetterAuthOperationFailure<Code extends string> =
  | BetterAuthApiError<Code>
  | UnhandledException

/** Remove transport selection from a Better Auth endpoint input. */
export type BetterAuthEndpointInput<Input> = Input extends object
  ? Omit<Input, BetterAuthTransportFlag>
  : Input

/** Preserve an endpoint parameter tuple while adapting only its first context argument. */
export type BetterAuthEndpointArguments<Endpoint> = Endpoint extends (
  ...args: infer Arguments
) => infer _Output
  ? {
      [Index in keyof Arguments]: Index extends 0 | '0'
        ? BetterAuthEndpointInput<Arguments[Index]>
        : Arguments[Index]
    }
  : never

/** Infer the default data result from the original Better Auth endpoint. */
export type BetterAuthEndpointResult<Endpoint> = Endpoint extends (
  ...args: infer _Arguments
) => infer Output
  ? Awaited<Output>
  : never

/** Explicit transport variants attached to an effectful Better Auth endpoint. */
export interface BetterAuthTransportModes<Endpoint, Code extends string> {
  readonly asResponse: (
    ...args: BetterAuthEndpointArguments<Endpoint>
  ) => BetterAuthOperation<Response, BetterAuthOperationFailure<Code>>

  readonly withHeaders: (
    ...args: BetterAuthEndpointArguments<Endpoint>
  ) => BetterAuthOperation<
    {
      readonly headers: Headers
      readonly response: BetterAuthEndpointResult<Endpoint>
    },
    BetterAuthOperationFailure<Code>
  >
}

/** One Better Auth server endpoint adapted to the three effectful transport modes. */
export type BetterAuthEffectEndpoint<Endpoint, Code extends string> = ((
  ...args: BetterAuthEndpointArguments<Endpoint>
) => BetterAuthOperation<
  BetterAuthEndpointResult<Endpoint>,
  BetterAuthOperationFailure<Code>
>) &
  BetterAuthTransportModes<Endpoint, Code>

/** Derive an effectful endpoint surface from the concrete Better Auth API, including plugins. */
export type BetterAuthEffectApi<Api, Code extends string> = {
  readonly [Key in keyof Api as Api[Key] extends (...args: infer _Arguments) => infer Output
    ? Output extends PromiseLike<unknown>
      ? Key
      : never
    : never]: BetterAuthEffectEndpoint<Api[Key], Code>
}
