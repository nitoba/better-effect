import type { BetterAuthEffectApi, BetterAuthOperation } from '../effect-api'
import { makeBetterAuthEffectApi } from './effect-api'
import { fromBetterAuthPromise } from './from-better-auth-promise'
import { makeBetterAuthSessionApi, type BetterAuthSessionApi } from '../session'
import type { BetterAuthErrorCode, BetterAuthFailure, BetterAuthInstance } from '../types'

/** Build the immutable integration value shared by prebuilt and lazy Auth tokens. */
export const makeBetterAuthServiceValue = <Auth extends BetterAuthInstance>(
  rawAuth: Auth
): {
  readonly api: BetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>
  readonly session: BetterAuthSessionApi<Auth>
  readonly handle: (request: Request) => BetterAuthOperation<Response, BetterAuthFailure<Auth>>
  readonly raw: Auth
} => {
  const serviceApi = makeBetterAuthEffectApi<Auth['api'], BetterAuthErrorCode<Auth>>(rawAuth.api)
  const serviceSession = makeBetterAuthSessionApi<Auth>(serviceApi)
  const serviceHandle = (
    request: Request
  ): BetterAuthOperation<Response, BetterAuthFailure<Auth>> =>
    fromBetterAuthPromise<Response, BetterAuthErrorCode<Auth>>(() => rawAuth.handler(request))

  return Object.freeze({
    api: serviceApi,
    session: serviceSession,
    handle: serviceHandle,
    raw: rawAuth
  })
}
