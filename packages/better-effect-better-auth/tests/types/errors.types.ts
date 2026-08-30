import { expectTypeOf } from 'bun:test'
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import type { UnhandledException } from 'better-result'

import type {
  BetterAuthApiError,
  BetterAuthErrorCode,
  BetterAuthErrorCodeSource,
  BetterAuthFailure,
  BetterAuthRuntimeErrorCode,
  Unauthenticated
} from '../../src'

type AuthWithPluginCodes = {
  readonly $ERROR_CODES: {
    readonly INVALID_EMAIL_OR_PASSWORD: {
      readonly code: 'INVALID_EMAIL_OR_PASSWORD'
      readonly message: string
    }
    readonly ADMIN_ONLY: {
      readonly code: 'ADMIN_ONLY'
      readonly message: string
    }
  }
}

type Codes = BetterAuthErrorCode<AuthWithPluginCodes>
type Failure = BetterAuthFailure<AuthWithPluginCodes>

type Assert<T extends true> = T
type IsAssignable<From, To> = [From] extends [To] ? true : false
type IsNotAssignable<From, To> = IsAssignable<From, To> extends true ? false : true

const authWithAdmin = betterAuth({
  plugins: [admin()]
})
const authWithoutAdmin = betterAuth({})

type AdminCodes = BetterAuthErrorCode<typeof authWithAdmin>
type CoreCodes = BetterAuthErrorCode<typeof authWithoutAdmin>

expectTypeOf<Codes>().toEqualTypeOf<'INVALID_EMAIL_OR_PASSWORD' | 'ADMIN_ONLY'>()
expectTypeOf<Failure>().toEqualTypeOf<
  BetterAuthApiError<'INVALID_EMAIL_OR_PASSWORD' | 'ADMIN_ONLY'> | UnhandledException
>()
expectTypeOf<Unauthenticated>().not.toMatchTypeOf<Failure>()
expectTypeOf<BetterAuthRuntimeErrorCode>().toMatchTypeOf<string>()

type _SourceContract = Assert<IsAssignable<AuthWithPluginCodes, BetterAuthErrorCodeSource>>
type _RealAuthSourceContract = Assert<IsAssignable<typeof authWithAdmin, BetterAuthErrorCodeSource>>
type _BuiltInCodeIsPresent = Assert<IsAssignable<'INVALID_EMAIL_OR_PASSWORD', CoreCodes>>
type _PluginCodeIsPresent = Assert<IsAssignable<'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS', AdminCodes>>
type _PluginCodeIsAbsentWithoutPlugin = Assert<
  IsNotAssignable<'YOU_ARE_NOT_ALLOWED_TO_LIST_USERS', CoreCodes>
>
type _KnownCodeIsAccepted = Assert<
  IsAssignable<'ADMIN_ONLY', BetterAuthApiError<'INVALID_EMAIL_OR_PASSWORD' | 'ADMIN_ONLY'>['code']>
>
type _FutureRuntimeCodeIsAccepted = Assert<
  IsAssignable<BetterAuthRuntimeErrorCode, BetterAuthApiError<'ADMIN_ONLY'>['code']>
>
type _KnownCodesAreNotWidenedToString = Assert<
  IsNotAssignable<string, BetterAuthApiError<'ADMIN_ONLY'>['code']>
>
