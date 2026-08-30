import { Layer, Service } from 'better-effect'

import type { ServiceClass, ServiceRequirement } from 'better-effect'

import type {
  BetterAuthEffectApi,
  BetterAuthOperation
} from './effect-api'
import { makeBetterAuthEffectApi } from './internal/effect-api'
import { fromBetterAuthPromise } from './internal/from-better-auth-promise'
import {
  makeBetterAuthSessionApi,
  type BetterAuthSessionApi,
  type BetterAuthSessionOf,
  type BetterAuthSessionReadOptions,
  type BetterAuthSessionSource
} from './session'
import type {
  BetterAuthErrorCode,
  BetterAuthFailure,
  BetterAuthInstance
} from './types'

/** Effectful server-side operations bound to one concrete Better Auth instance. */
export interface BetterAuthService<Auth extends BetterAuthInstance> {
  readonly api: BetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>
  readonly session: BetterAuthSessionApi<Auth>
  readonly handle: (
    request: Request
  ) => BetterAuthOperation<Response, BetterAuthFailure<Auth>>
  readonly raw: Auth
}

/** Branded better-effect Service value produced for one literal tag and Better Auth instance. */
export type BetterAuthServiceInstance<
  Tag extends string,
  Auth extends BetterAuthInstance
> = BetterAuthService<Auth> & Service.Identity<Tag>

/** Yieldable, concrete Service class returned directly by `BetterAuth.service`. */
export type BetterAuthServiceToken<
  Tag extends string,
  Auth extends BetterAuthInstance
> = ServiceClass<Tag, BetterAuthServiceInstance<Tag, Auth>> & {
  readonly layer: Layer<BetterAuthServiceInstance<Tag, Auth>, never>
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<BetterAuthServiceInstance<Tag, Auth>>,
    BetterAuthServiceInstance<Tag, Auth>,
    unknown
  >
}

type BetterAuthLiteralTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

/** Adapt an existing Better Auth instance into a normal better-effect Service token. */
export function betterAuthService<
  const Tag extends string,
  Auth extends BetterAuthInstance
>(
  tag: BetterAuthLiteralTag<Tag>,
  raw: Auth
): BetterAuthServiceToken<Tag, Auth> {
  type Instance = BetterAuthServiceInstance<Tag, Auth>

  class AuthService extends Service<Instance>()(tag) {
    declare readonly api: BetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>
    declare readonly session: BetterAuthSessionApi<Auth>
    declare readonly handle: (
      request: Request
    ) => BetterAuthOperation<Response, BetterAuthFailure<Auth>>
    declare readonly raw: Auth
  }

  const api = makeBetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>(raw.api)
  const session = makeBetterAuthSessionApi<Auth>(api)
  const handle = (
    request: Request
  ): BetterAuthOperation<Response, BetterAuthFailure<Auth>> =>
    fromBetterAuthPromise<Response, BetterAuthErrorCode<Auth>>(() => raw.handler(request))

  const value = AuthService.of(
    Object.freeze({
      api,
      session,
      handle,
      raw
    })
  )
  const layer = Layer.succeed(AuthService, value)

  Object.defineProperty(AuthService, 'layer', {
    value: layer,
    enumerable: true,
    configurable: false,
    writable: false
  })

  // SAFETY: the class is the exact concrete Service class created above and the readonly Layer was attached with a locked descriptor.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The static class type cannot observe a property attached through Object.defineProperty.
  return AuthService as unknown as BetterAuthServiceToken<Tag, Auth>
}

/** Better Auth integration namespace. */
export const BetterAuth = Object.freeze({
  service: betterAuthService
})

/** Type-level aliases colocated with the `BetterAuth` factory. */
export declare namespace BetterAuth {
  export type Operation<A, E> = BetterAuthOperation<A, E>
  export type EffectApi<Api, Code extends string> = BetterAuthEffectApi<Api, Code>
  export type ErrorCode<Auth extends BetterAuthInstance> = BetterAuthErrorCode<Auth>
  export type Failure<Auth extends BetterAuthInstance> = BetterAuthFailure<Auth>
  export type Service<Auth extends BetterAuthInstance> = BetterAuthService<Auth>
  export type ServiceInstance<
    Tag extends string,
    Auth extends BetterAuthInstance
  > = BetterAuthServiceInstance<Tag, Auth>
  export type ServiceToken<
    Tag extends string,
    Auth extends BetterAuthInstance
  > = BetterAuthServiceToken<Tag, Auth>
  export type Session<Auth extends BetterAuthInstance> = BetterAuthSessionOf<Auth>
  export type SessionApi<Auth extends BetterAuthInstance> = BetterAuthSessionApi<Auth>
  export type SessionSource = BetterAuthSessionSource
  export type SessionReadOptions = BetterAuthSessionReadOptions
}
