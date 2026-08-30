import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { admin } from 'better-auth/plugins'
import { Result, type UnhandledException } from 'better-result'
import { Effect, Layer, type Runtime } from 'better-effect'

import {
  BetterAuth,
  BetterAuthApiError,
  Unauthenticated,
  type BetterAuthErrorCode,
  type BetterAuthFailure,
  type BetterAuthRuntimeErrorCode
} from 'better-effect-better-auth'

const auth = betterAuth({
  plugins: [admin()]
})
const Auth = BetterAuth.service('@external/Auth', auth)

type AuthInstance = BetterAuth.ServiceInstance<'@external/Auth', typeof auth>

type _AuthToken = Assert<
  IsAssignable<typeof Auth, BetterAuth.ServiceToken<'@external/Auth', typeof auth>>
>
const authLayer: Layer<AuthInstance, never> = Auth.layer

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

const program = Effect.fn(async function* () {
  const service = yield* Auth
  const session = yield* service.session.get(new Headers())
  const response = yield* service.handle(new Request('https://example.test/api/auth/session'))

  return Result.ok({ session, response })
})

type _AuthRequirement = Assert<IsAssignable<Effect.Requirements<typeof program>, AuthInstance>>
declare const runtime: Runtime<AuthInstance>
void authLayer
void runtime.run(program)
