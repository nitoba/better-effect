import type { UnhandledException } from 'better-result'
import { APIError } from 'better-auth/api'
import {
  BetterAuth,
  BetterAuthApiError,
  type BetterAuthRuntimeErrorCode,
  Unauthenticated
} from 'better-effect-better-auth'

import type { Assert, Equal, IsAssignable, IsAny, IsNotAssignable } from './assert'
import { authWithPlugins } from './auth'

type Auth = typeof authWithPlugins
type Codes = BetterAuth.ErrorCode<Auth>
type Failure = BetterAuth.Failure<Auth>
type ApiError = BetterAuthApiError<Codes>

type _PluginCode = Assert<IsAssignable<'CUSTOM_PLUGIN_FAILURE', Codes>>
type _KnownCode = Assert<IsAssignable<'INVALID_EMAIL_OR_PASSWORD', Codes>>
type _ApiFailure = Assert<IsAssignable<ApiError, Failure>>
type _UnhandledFailure = Assert<IsAssignable<UnhandledException, Failure>>
type _RuntimeCode = Assert<IsAssignable<BetterAuthRuntimeErrorCode, ApiError['code']>>
type _CodeNotAny = Assert<Equal<IsAny<ApiError['code']>, false>>
type _KnownCodeNotString = Assert<IsNotAssignable<string, ApiError['code']>>
type _UnauthenticatedIsSeparate = Assert<IsNotAssignable<Unauthenticated, Failure>>

const source = new APIError('UNAUTHORIZED', {
  code: 'CUSTOM_PLUGIN_FAILURE',
  message: 'The release-gate plugin failed'
})
const normalized: ApiError = BetterAuthApiError.from<Codes>(source)
const required = new Unauthenticated({
  message: 'Authentication is required'
})

normalized.statusCode satisfies number
required._tag satisfies 'Unauthenticated'
