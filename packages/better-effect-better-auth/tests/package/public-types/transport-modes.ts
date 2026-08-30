import { BetterAuth, type BetterAuthEndpointResult } from 'better-effect-better-auth'

import type { Assert, Equal, IsNotAssignable } from './assert'
import { authWithPlugins } from './auth'

type Auth = typeof authWithPlugins
type Code = BetterAuth.ErrorCode<Auth>
type Failure = BetterAuth.Failure<Auth>
type Api = BetterAuth.EffectApi<Auth['api'], Code>

declare const api: Api
const headers = new Headers()
const input = {
  body: {
    email: 'user@example.com',
    password: 'correct horse battery staple'
  }
}

const data = api.signInEmail(input)
const response = api.signInEmail.asResponse(input)
const withHeaders = api.signInEmail.withHeaders(input)
const nullable = api.getSession({ headers })

type _Data = Assert<
  Equal<
    typeof data,
    BetterAuth.Operation<BetterAuthEndpointResult<Auth['api']['signInEmail']>, Failure>
  >
>
type _Response = Assert<Equal<typeof response, BetterAuth.Operation<Response, Failure>>>
type _Headers = Assert<
  Equal<
    typeof withHeaders,
    BetterAuth.Operation<
      {
        readonly headers: Headers
        readonly response: BetterAuthEndpointResult<Auth['api']['signInEmail']>
      },
      Failure
    >
  >
>
type _Nullable = Assert<
  Equal<
    typeof nullable,
    BetterAuth.Operation<BetterAuthEndpointResult<Auth['api']['getSession']>, Failure>
  >
>
type SignInInput = NonNullable<Parameters<typeof api.signInEmail>[0]>
type _HidesResponseFlag = Assert<IsNotAssignable<'asResponse', keyof SignInInput>>
type _HidesHeadersFlag = Assert<IsNotAssignable<'returnHeaders', keyof SignInInput>>
type _HidesStatusFlag = Assert<IsNotAssignable<'returnStatus', keyof SignInInput>>

void data
void response
void withHeaders
void nullable
