import { Layer, Service } from 'better-effect'

import type { AnyService, ServiceClass, ServiceRequirement, ServiceToken } from 'better-effect'

import type { BetterAuthEffectApi, BetterAuthOperation } from './effect-api'
import { makeBetterAuthServiceValue } from './internal/make-service-value'
import {
  type BetterAuthSessionApi,
  type BetterAuthSessionOf,
  type BetterAuthSessionReadOptions,
  type BetterAuthSessionSource
} from './session'
import type { BetterAuthErrorCode, BetterAuthFailure, BetterAuthInstance } from './types'

/** Effectful server-side operations bound to one concrete Better Auth instance. */
export interface BetterAuthService<Auth extends BetterAuthInstance> {
  readonly api: BetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>
  readonly session: BetterAuthSessionApi<Auth>
  readonly handle: (request: Request) => BetterAuthOperation<Response, BetterAuthFailure<Auth>>
  readonly raw: Auth
}

/** Branded better-effect Service value produced for one literal tag and Better Auth instance. */
export type BetterAuthServiceInstance<
  Tag extends string,
  Auth extends BetterAuthInstance
> = BetterAuthService<Auth> & Service.Identity<Tag>

type BetterAuthTokenMembers<
  Tag extends string,
  Auth extends BetterAuthInstance,
  Required extends AnyService
> = {
  readonly layer: Layer<BetterAuthServiceInstance<Tag, Auth>, Required>
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<BetterAuthServiceInstance<Tag, Auth>>,
    BetterAuthServiceInstance<Tag, Auth>,
    unknown
  >
}

/** Yieldable Better Auth token shape shared by prebuilt and factory-backed tokens. */
export type BetterAuthToken<
  Tag extends string,
  Auth extends BetterAuthInstance,
  Required extends AnyService = never
> = ServiceToken<Tag, BetterAuthServiceInstance<Tag, Auth>> &
  BetterAuthTokenMembers<Tag, Auth, Required>

/** Yieldable, constructible Service class returned by `BetterAuth.from` and `BetterAuth.service`. */
export type BetterAuthServiceToken<
  Tag extends string,
  Auth extends BetterAuthInstance,
  Required extends AnyService = never
> = ServiceClass<Tag, BetterAuthServiceInstance<Tag, Auth>> &
  BetterAuthTokenMembers<Tag, Auth, Required>

/** Yieldable token returned by `BetterAuth.make`; acquisition creates its Service value. */
export type BetterAuthFactoryServiceToken<
  Tag extends string,
  Auth extends BetterAuthInstance,
  Required extends AnyService = never
> = BetterAuthServiceToken<Tag, Auth, Required>

type BetterAuthLiteralTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

type BetterAuthFactoryYield = ServiceRequirement<unknown>

type BetterAuthFactoryRequirements<Yield> =
  Yield extends ServiceRequirement<infer Requirement>
    ? Requirement extends AnyService
      ? Requirement
      : never
    : never

type BetterAuthAsyncGeneratorFactory<
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
> = () => AsyncGenerator<Yield, Auth, unknown>

type BetterAuthSyncGeneratorFactory<
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
> = () => Generator<Yield, Auth, unknown>

type BetterAuthGeneratorFactory<
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
> = BetterAuthAsyncGeneratorFactory<Yield, Auth> | BetterAuthSyncGeneratorFactory<Yield, Auth>

const isAsyncGenerator = <Yield, Auth>(
  iterator: Generator<Yield, Auth, unknown> | AsyncGenerator<Yield, Auth, unknown>
): iterator is AsyncGenerator<Yield, Auth, unknown> => Symbol.asyncIterator in iterator

const runGeneratorFactory = async function* <
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
>(factory: BetterAuthGeneratorFactory<Yield, Auth>): AsyncGenerator<Yield, Auth, unknown> {
  const iterator = factory()

  if (isAsyncGenerator(iterator)) {
    return yield* iterator
  }

  const state = iterator.next()

  if (!state.done) {
    yield state.value
    throw new TypeError('Better Auth raw factories may only yield contextual Services')
  }

  return state.value
}

const attachLayer = <Token extends object>(token: Token, layer: Layer<any, any>): Token => {
  Object.defineProperty(token, 'layer', {
    value: layer,
    enumerable: true,
    configurable: false,
    writable: false
  })

  return token
}

function makeAuthToken<const Tag extends string, Auth extends BetterAuthInstance>(
  tag: BetterAuthLiteralTag<Tag>
): ServiceClass<Tag, BetterAuthServiceInstance<Tag, Auth>> {
  type Instance = BetterAuthServiceInstance<Tag, Auth>

  class AuthService extends Service<Instance>()(tag) {
    constructor() {
      super()
      throw new TypeError('A factory-backed Better Auth Service must be acquired from its Layer')
    }
  }

  // SAFETY: factory-backed tokens are never used as instances; the Layer generator supplies the branded value.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the public Service class hides its invalid constructor instance type.
  return AuthService as unknown as ServiceClass<Tag, BetterAuthServiceInstance<Tag, Auth>>
}

/** Adapt an existing Better Auth instance into a caller-owned Service Layer. */
export function betterAuthFrom<const Tag extends string, Auth extends BetterAuthInstance>(
  tag: BetterAuthLiteralTag<Tag>,
  raw: Auth
): BetterAuthServiceToken<Tag, Auth> {
  type Instance = BetterAuthServiceInstance<Tag, Auth>

  const serviceValue = makeBetterAuthServiceValue(raw)

  class AuthService extends Service<Instance>()(tag) {
    readonly api = serviceValue.api
    readonly session = serviceValue.session
    readonly handle = serviceValue.handle
    readonly raw = serviceValue.raw

    constructor() {
      super()
      Object.freeze(this)
    }
  }

  const value = AuthService.of(serviceValue)
  const layer = Layer.succeed(AuthService, value)

  // SAFETY: attachLayer adds the locked Layer property to this exact AuthService constructor.
  return attachLayer(AuthService, layer) as BetterAuthServiceToken<Tag, Auth>
}

/** Create a lazy Better Auth Service whose raw instance is acquired by its Layer. */
export function betterAuthMake<
  const Tag extends string,
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
>(
  tag: BetterAuthLiteralTag<Tag>,
  factory: BetterAuthAsyncGeneratorFactory<Yield, Auth>
): BetterAuthFactoryServiceToken<Tag, Auth, BetterAuthFactoryRequirements<Yield>>

export function betterAuthMake<
  const Tag extends string,
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
>(
  tag: BetterAuthLiteralTag<Tag>,
  factory: BetterAuthSyncGeneratorFactory<Yield, Auth>
): BetterAuthFactoryServiceToken<Tag, Auth, BetterAuthFactoryRequirements<Yield>>

export function betterAuthMake<
  const Tag extends string,
  Yield extends BetterAuthFactoryYield,
  Auth extends BetterAuthInstance
>(
  tag: BetterAuthLiteralTag<Tag>,
  factory: BetterAuthGeneratorFactory<Yield, Auth>
): BetterAuthFactoryServiceToken<Tag, Auth, BetterAuthFactoryRequirements<Yield>> {
  type Required = BetterAuthFactoryRequirements<Yield>

  const AuthService = makeAuthToken<Tag, Auth>(tag)
  const layer = Layer.gen(AuthService, async function* () {
    const raw = yield* runGeneratorFactory(factory)
    return AuthService.of(makeBetterAuthServiceValue(raw))
  })

  // SAFETY: attachLayer adds the locked Layer property to this exact AuthService constructor.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the public token restores its precise Layer requirement channel.
  return attachLayer(AuthService, layer) as unknown as BetterAuthFactoryServiceToken<
    Tag,
    Auth,
    Required
  >
}

/** Compatibility alias for the original prebuilt-instance helper. */
export const betterAuthService = betterAuthFrom

/** Better Auth integration namespace. */
export const BetterAuth = Object.freeze({
  make: betterAuthMake,
  from: betterAuthFrom,
  /**
   * @deprecated Use BetterAuth.make for Layer-first construction or BetterAuth.from for a prebuilt instance.
   */
  service: betterAuthFrom
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
    Auth extends BetterAuthInstance,
    Required extends AnyService = never
  > = BetterAuthToken<Tag, Auth, Required>
  export type FactoryServiceToken<
    Tag extends string,
    Auth extends BetterAuthInstance,
    Required extends AnyService = never
  > = BetterAuthFactoryServiceToken<Tag, Auth, Required>
  export type Session<Auth extends BetterAuthInstance> = BetterAuthSessionOf<Auth>
  export type SessionApi<Auth extends BetterAuthInstance> = BetterAuthSessionApi<Auth>
  export type SessionSource = BetterAuthSessionSource
  export type SessionReadOptions = BetterAuthSessionReadOptions
}
