import { Result } from 'better-result'

import { Unauthenticated } from './errors'
import type { BetterAuthEffectApi, BetterAuthOperation } from './effect-api'
import type { BetterAuthErrorCode, BetterAuthFailure, BetterAuthInstance } from './types'

/** Session inferred from the concrete Better Auth instance, including plugin fields. */
export type BetterAuthSessionOf<Auth extends BetterAuthInstance> = Auth['$Infer']['Session']

/** Explicit Web-standard source accepted by session helpers. */
export type BetterAuthSessionSource = Request | Headers

/** Better Auth query switches supported by `getSession`. */
export interface BetterAuthSessionReadOptions {
  readonly disableCookieCache?: boolean
  readonly disableRefresh?: boolean
}

/** Effectful session operations bound to one concrete Better Auth instance. */
export interface BetterAuthSessionApi<Auth extends BetterAuthInstance> {
  readonly get: (
    source: BetterAuthSessionSource,
    options?: BetterAuthSessionReadOptions
  ) => BetterAuthOperation<BetterAuthSessionOf<Auth> | null, BetterAuthFailure<Auth>>

  readonly require: (
    source: BetterAuthSessionSource,
    options?: BetterAuthSessionReadOptions
  ) => BetterAuthOperation<BetterAuthSessionOf<Auth>, BetterAuthFailure<Auth> | Unauthenticated>
}

type SessionEndpoint<Auth extends BetterAuthInstance> = (input: {
  readonly headers: Headers
  readonly query?: BetterAuthSessionReadOptions
}) => BetterAuthOperation<BetterAuthSessionOf<Auth> | null, BetterAuthFailure<Auth>>

const sessionHeaders = (source: BetterAuthSessionSource): Headers =>
  'headers' in source ? source.headers : source

/** Create immutable session helpers over the already-adapted `getSession` endpoint. */
export function makeBetterAuthSessionApi<Auth extends BetterAuthInstance>(
  api: BetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>
): BetterAuthSessionApi<Auth> {
  // oxlint-disable-next-line anti-slop/no-reflect-get -- Generic mapped types cannot expose the known getSession key until the concrete Auth instance is substituted.
  const candidate = Reflect.get(api, 'getSession')

  if (!(candidate instanceof Function)) {
    throw new TypeError('The Better Auth instance does not expose api.getSession')
  }

  // SAFETY: BetterAuthInstance requires the raw getSession endpoint and the effectful Proxy maps callable endpoints to BetterAuthOperation.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The generic mapped key cannot preserve the concrete session output before Auth substitution.
  const getSession = candidate as unknown as SessionEndpoint<Auth>

  const get = (
    source: BetterAuthSessionSource,
    options?: BetterAuthSessionReadOptions
  ): BetterAuthOperation<BetterAuthSessionOf<Auth> | null, BetterAuthFailure<Auth>> => {
    const headers = sessionHeaders(source)

    if (options === undefined) {
      return getSession({
        headers
      })
    }

    return getSession({
      headers,
      query: {
        ...options
      }
    })
  }

  const requireSession = async function* (
    source: BetterAuthSessionSource,
    options?: BetterAuthSessionReadOptions
  ): BetterAuthOperation<BetterAuthSessionOf<Auth>, BetterAuthFailure<Auth> | Unauthenticated> {
    const session = yield* get(source, options)

    if (session === null) {
      return yield* Result.err(
        new Unauthenticated({
          message: 'Authentication is required'
        })
      )
    }

    return session
  }

  return Object.freeze({
    get,
    require: requireSession
  })
}
