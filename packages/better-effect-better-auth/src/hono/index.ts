import { Layer, Service } from 'better-effect'
import type { ServiceClass, ServiceRequirement } from 'better-effect'
import type { HonoContext } from 'better-effect/hono'
import { Result, UnhandledException } from 'better-result'
import type { Err, Result as ResultType } from 'better-result'

import { Unauthenticated } from '../errors'
import type { BetterAuthOperation } from '../effect-api'
import type {
  BetterAuthService,
  BetterAuthServiceInstance,
  BetterAuthServiceToken
} from '../service'
import type { BetterAuthErrorCode, BetterAuthFailure, BetterAuthInstance } from '../types'
import type { BetterAuthSessionReadOptions, BetterAuthSessionOf } from '../session'

/** Session options forwarded to Better Auth's `getSession` operation. */
export type BetterAuthHonoSessionOptions = BetterAuthSessionReadOptions

/** The request-scoped Service value supplied by a Better Auth Hono Layer. */
export interface BetterAuthHonoSessionValue<Auth extends BetterAuthInstance> {
  readonly get: () => BetterAuthOperation<BetterAuthSessionOf<Auth> | null, BetterAuthFailure<Auth>>
  readonly require: () => BetterAuthOperation<
    BetterAuthSessionOf<Auth>,
    BetterAuthFailure<Auth> | Unauthenticated
  >
}

/** The request-scoped Better Auth session Service instance. */
export type BetterAuthHonoSessionInstance<
  Tag extends string,
  Auth extends BetterAuthInstance
> = BetterAuthHonoSessionValue<Auth> & Service.Identity<Tag>

/** An operation that resolves the request-scoped current-session Service. */
export type BetterAuthHonoSessionOperation<
  Tag extends string,
  Auth extends BetterAuthInstance,
  Value,
  Failure
> = AsyncGenerator<
  Err<never, Failure> | ServiceRequirement<BetterAuthHonoSessionInstance<Tag, Auth>>,
  Value,
  unknown
>

/** A `HonoEffect.guard` body for a current-session Service. */
export type BetterAuthHonoSessionGuard<Tag extends string, Auth extends BetterAuthInstance> = (
  context: HonoContext
) => AsyncGenerator<
  | Err<never, BetterAuthFailure<Auth> | Unauthenticated>
  | ServiceRequirement<BetterAuthHonoSessionInstance<Tag, Auth>>,
  ResultType<void, never>,
  unknown
>

/** The exact request Layer produced by a current-session token. */
export type BetterAuthHonoSessionRequestLayer<
  Tag extends string,
  AuthTag extends string,
  Auth extends BetterAuthInstance
> = import('better-effect').Layer<
  BetterAuthHonoSessionInstance<Tag, Auth>,
  BetterAuthServiceInstance<AuthTag, Auth>
>

/** A request-scoped current-session Service token and Hono boundary helpers. */
export type BetterAuthHonoSessionToken<
  Tag extends string,
  AuthTag extends string,
  Auth extends BetterAuthInstance
> = ServiceClass<Tag, BetterAuthHonoSessionInstance<Tag, Auth>> & {
  readonly requestLayer: (
    context: HonoContext
  ) => BetterAuthHonoSessionRequestLayer<Tag, AuthTag, Auth>
  readonly get: () => BetterAuthHonoSessionOperation<
    Tag,
    Auth,
    BetterAuthSessionOf<Auth> | null,
    BetterAuthFailure<Auth>
  >
  readonly require: () => BetterAuthHonoSessionOperation<
    Tag,
    Auth,
    BetterAuthSessionOf<Auth>,
    BetterAuthFailure<Auth> | Unauthenticated
  >
  readonly guard: BetterAuthHonoSessionGuard<Tag, Auth>
  readonly [Symbol.asyncIterator]: () => AsyncGenerator<
    ServiceRequirement<BetterAuthHonoSessionInstance<Tag, Auth>>,
    BetterAuthHonoSessionInstance<Tag, Auth>,
    unknown
  >
}

type BetterAuthHonoLiteralTag<Tag extends string> = string extends Tag
  ? never
  : Tag extends ''
    ? never
    : Tag

type SessionResult<Auth extends BetterAuthInstance> = ResultType<
  BetterAuthSessionOf<Auth> | null,
  BetterAuthFailure<Auth>
>

const closedSessionResult = <Auth extends BetterAuthInstance>(): SessionResult<Auth> =>
  Result.err(
    new UnhandledException({
      cause: new Error('Current Auth Session request scope is closed')
    })
  )

const toSessionResult = async <Auth extends BetterAuthInstance>(
  auth: BetterAuthService<Auth>,
  request: Request,
  options: BetterAuthHonoSessionOptions | undefined
): Promise<SessionResult<Auth>> => {
  try {
    return await Result.gen(async function* () {
      const session = yield* auth.session.get(request, options)
      return Result.ok(session)
    })
  } catch (cause) {
    return Result.err(new UnhandledException({ cause }))
  }
}

/**
 * Keep request cleanup on the acquired value itself. A Layer can be reused by
 * concurrent scopes, so release must never look up mutable state owned by the
 * Layer factory.
 */
class CurrentSessionValue<
  Auth extends BetterAuthInstance
> implements BetterAuthHonoSessionValue<Auth> {
  #settlement: Promise<SessionResult<Auth>> | undefined

  #closed = false

  #auth: BetterAuthService<Auth> | undefined

  #request: Request | undefined

  #options: BetterAuthHonoSessionOptions | undefined

  constructor(
    auth: BetterAuthService<Auth>,
    request: Request,
    options: BetterAuthHonoSessionOptions | undefined
  ) {
    this.#auth = auth
    this.#request = request
    this.#options = options
    Object.freeze(this)
  }

  #read(): Promise<SessionResult<Auth>> {
    if (this.#closed || this.#auth === undefined || this.#request === undefined) {
      return Promise.resolve(closedSessionResult())
    }

    this.#settlement ??= toSessionResult(this.#auth, this.#request, this.#options)
    return this.#settlement
  }

  private async *readSession(): BetterAuthOperation<
    BetterAuthSessionOf<Auth> | null,
    BetterAuthFailure<Auth>
  > {
    const result = await this.#read()

    if (Result.isError(result)) {
      return yield* Result.err(result.error)
    }

    return result.value
  }

  readonly get = (): BetterAuthOperation<
    BetterAuthSessionOf<Auth> | null,
    BetterAuthFailure<Auth>
  > => this.readSession()

  private async *requireSession(): BetterAuthOperation<
    BetterAuthSessionOf<Auth>,
    BetterAuthFailure<Auth> | Unauthenticated
  > {
    const session = yield* this.get()

    if (session === null) {
      return yield* Result.err(
        new Unauthenticated({
          message: 'Authentication is required'
        })
      )
    }

    return session
  }

  readonly require = (): BetterAuthOperation<
    BetterAuthSessionOf<Auth>,
    BetterAuthFailure<Auth> | Unauthenticated
  > => this.requireSession()

  #close(): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    this.#settlement = undefined
    this.#auth = undefined
    this.#request = undefined
    this.#options = undefined
  }

  static close<Auth extends BetterAuthInstance>(value: BetterAuthHonoSessionValue<Auth>): void {
    if (!(value instanceof CurrentSessionValue)) {
      throw new TypeError('Current Auth Session release received an unexpected value')
    }

    value.#close()
  }
}

const resolveCurrentSession = <
  Tag extends string,
  AuthTag extends string,
  Auth extends BetterAuthInstance
>(
  token: BetterAuthHonoSessionToken<Tag, AuthTag, Auth>
): BetterAuthHonoSessionOperation<Tag, Auth, BetterAuthHonoSessionValue<Auth>, never> =>
  (async function* () {
    return yield* token
  })()

/** Create a request-scoped current-session token linked to one Auth Service. */
function betterAuthHonoSession<
  const Tag extends string,
  const AuthTag extends string,
  Auth extends BetterAuthInstance
>(
  tag: BetterAuthHonoLiteralTag<Tag>,
  auth: BetterAuthServiceToken<AuthTag, Auth>,
  options?: BetterAuthHonoSessionOptions
): BetterAuthHonoSessionToken<Tag, AuthTag, Auth> {
  type Instance = BetterAuthHonoSessionInstance<Tag, Auth>
  type Operation<Value, Failure> = BetterAuthHonoSessionOperation<Tag, Auth, Value, Failure>

  class CurrentAuthSession extends Service<Instance>()(tag) {
    declare readonly get: () => BetterAuthOperation<
      BetterAuthSessionOf<Auth> | null,
      BetterAuthFailure<Auth>
    >
    declare readonly require: () => BetterAuthOperation<
      BetterAuthSessionOf<Auth>,
      BetterAuthFailure<Auth> | Unauthenticated
    >
  }

  // SAFETY: Service's static iterator is supplied by the factory; the cast restores the additional public helpers attached below.
  const token = CurrentAuthSession as BetterAuthHonoSessionToken<Tag, AuthTag, Auth>

  const requestLayer = (
    context: HonoContext
  ): BetterAuthHonoSessionRequestLayer<Tag, AuthTag, Auth> =>
    Layer.scopedGen(
      CurrentAuthSession,
      async function* () {
        const authService = yield* auth
        return CurrentAuthSession.of(new CurrentSessionValue(authService, context.req.raw, options))
      },
      (instance) => {
        CurrentSessionValue.close(instance)
      }
    )

  const get = (): Operation<BetterAuthSessionOf<Auth> | null, BetterAuthFailure<Auth>> =>
    (async function* () {
      const current = yield* resolveCurrentSession(token)
      return yield* current.get()
    })()

  const requireSession = (): Operation<
    BetterAuthSessionOf<Auth>,
    BetterAuthFailure<Auth> | Unauthenticated
  > =>
    (async function* () {
      const current = yield* resolveCurrentSession(token)
      return yield* current.require()
    })()

  const guard: BetterAuthHonoSessionGuard<Tag, Auth> = async function* (_context) {
    yield* requireSession()
    return Result.ok(undefined)
  }

  Object.defineProperties(token, {
    get: { value: get, enumerable: true },
    guard: { value: guard, enumerable: true },
    requestLayer: { value: requestLayer, enumerable: true },
    require: { value: requireSession, enumerable: true }
  })

  return token
}

/** Better Auth's optional Hono integration. */
export const BetterAuthHono = Object.freeze({
  session: betterAuthHonoSession
})

/** Type-level aliases colocated with the `BetterAuthHono` factory. */
export declare namespace BetterAuthHono {
  export type Session<
    Tag extends string,
    AuthTag extends string,
    Auth extends BetterAuthInstance
  > = BetterAuthHonoSessionToken<Tag, AuthTag, Auth>
  export type SessionInstance<
    Tag extends string,
    Auth extends BetterAuthInstance
  > = BetterAuthHonoSessionInstance<Tag, Auth>
  export type SessionOperation<
    Tag extends string,
    Auth extends BetterAuthInstance,
    Value,
    Failure
  > = BetterAuthHonoSessionOperation<Tag, Auth, Value, Failure>
  export type SessionRequestLayer<
    Tag extends string,
    AuthTag extends string,
    Auth extends BetterAuthInstance
  > = BetterAuthHonoSessionRequestLayer<Tag, AuthTag, Auth>
  export type SessionOptions = BetterAuthHonoSessionOptions
  export type SessionGuard<
    Tag extends string,
    Auth extends BetterAuthInstance
  > = BetterAuthHonoSessionGuard<Tag, Auth>
  export type Failure<Auth extends BetterAuthInstance> = BetterAuthFailure<Auth>
  export type ErrorCode<Auth extends BetterAuthInstance> = BetterAuthErrorCode<Auth>
}
