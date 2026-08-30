import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { admin } from 'better-auth/plugins'
import type { UnhandledException } from 'better-result'

import {
  BetterAuthApiError,
  Unauthenticated,
  type BetterAuthErrorCode,
  type BetterAuthFailure,
  type BetterAuthRuntimeErrorCode
} from 'better-effect-better-auth'

const auth = betterAuth({
  plugins: [admin()]
})

type Codes = BetterAuthErrorCode<typeof auth>
type Failure = BetterAuthFailure<typeof auth>
type Assert<T extends true> = T
type IsAssignable<From, To> = [From] extends [To] ? true : false

type _BuiltInCode = Assert<IsAssignable<'INVALID_EMAIL_OR_PASSWORD', Codes>>
type _PluginCode = Assert<IsAssignable<'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS', Codes>>
type _ApiFailure = Assert<IsAssignable<BetterAuthApiError<Codes>, Failure>>
type _UnhandledFailure = Assert<IsAssignable<UnhandledException, Failure>>
type _RuntimeCode = Assert<
  IsAssignable<BetterAuthRuntimeErrorCode, BetterAuthApiError<Codes>['code']>
>

const source = new APIError('UNAUTHORIZED', {
  code: 'INVALID_EMAIL_OR_PASSWORD',
  message: 'Invalid email or password'
})
const normalized: BetterAuthApiError<Codes> = BetterAuthApiError.from<Codes>(source)
const unauthenticated = new Unauthenticated({
  message: 'Authentication is required'
})

normalized.statusCode satisfies number
unauthenticated._tag satisfies 'Unauthenticated'
