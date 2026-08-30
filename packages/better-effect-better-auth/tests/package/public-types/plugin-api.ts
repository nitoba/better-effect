import { BetterAuth, type BetterAuthEndpointResult } from 'better-effect-better-auth'

import type { Assert, Equal, IsAssignable, IsNotAssignable } from './assert'
import { authWithPlugins, authWithoutPlugins } from './auth'

type Auth = typeof authWithPlugins
type PlainAuth = typeof authWithoutPlugins
type PluginCode = BetterAuth.ErrorCode<Auth>
type PluginFailure = BetterAuth.Failure<Auth>
type Api = BetterAuth.EffectApi<Auth['api'], PluginCode>
type PlainApi = BetterAuth.EffectApi<PlainAuth['api'], BetterAuth.ErrorCode<PlainAuth>>

declare const api: Api
declare const plainApi: PlainApi

const adminUsers = api.listUsers({
  query: {
    limit: 5
  }
})
const customEndpoint = api.releaseGate()

type _AdminEndpoint = Assert<IsAssignable<'listUsers', keyof Api>>
type _CustomEndpoint = Assert<IsAssignable<'releaseGate', keyof Api>>
type _AdminResult = Assert<
  Equal<
    typeof adminUsers,
    BetterAuth.Operation<BetterAuthEndpointResult<Auth['api']['listUsers']>, PluginFailure>
  >
>
type _CustomResult = Assert<
  Equal<
    typeof customEndpoint,
    BetterAuth.Operation<BetterAuthEndpointResult<Auth['api']['releaseGate']>, PluginFailure>
  >
>
type _AdminAbsentWithoutPlugin = Assert<IsNotAssignable<'listUsers', keyof PlainApi>>
type _CustomAbsentWithoutPlugin = Assert<IsNotAssignable<'releaseGate', keyof PlainApi>>

void plainApi
