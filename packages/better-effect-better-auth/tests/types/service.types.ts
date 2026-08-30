import { expectTypeOf } from 'bun:test'
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { Effect, Layer, type Runtime } from 'better-effect'
import { Result } from 'better-result'

import {
  BetterAuth,
  type BetterAuthFailure,
  type BetterAuthService,
  type BetterAuthServiceInstance,
  type BetterAuthSessionOf,
  type Unauthenticated
} from '../../src'

const rawAuth = betterAuth({
  emailAndPassword: {
    enabled: true
  },
  plugins: [admin()]
})

const otherRawAuth = betterAuth({})
const Auth = BetterAuth.service('@app/Auth', rawAuth)
const OtherAuth = BetterAuth.service('@app/OtherAuth', otherRawAuth)

type AuthInstance = BetterAuthServiceInstance<'@app/Auth', typeof rawAuth>
type OtherAuthInstance = BetterAuthServiceInstance<'@app/OtherAuth', typeof otherRawAuth>
type Session = typeof rawAuth.$Infer.Session

const constructed = new Auth()
expectTypeOf(constructed).toEqualTypeOf<AuthInstance>()
expectTypeOf(Auth.serviceTag).toEqualTypeOf<'@app/Auth'>()
expectTypeOf(OtherAuth.serviceTag).toEqualTypeOf<'@app/OtherAuth'>()
expectTypeOf<Layer.Provided<typeof Auth.layer>>().toEqualTypeOf<AuthInstance>()
expectTypeOf<Layer.Required<typeof Auth.layer>>().toBeNever()
expectTypeOf<BetterAuthSessionOf<typeof rawAuth>>().toEqualTypeOf<Session>()
expectTypeOf<BetterAuth.Session<typeof rawAuth>>().toEqualTypeOf<Session>()
expectTypeOf<BetterAuth.ErrorCode<typeof rawAuth>>().toEqualTypeOf<
  import('../../src').BetterAuthErrorCode<typeof rawAuth>
>()
expectTypeOf<BetterAuth.Failure<typeof rawAuth>>().toEqualTypeOf<
  BetterAuthFailure<typeof rawAuth>
>()

const program = Effect.fn(async function* () {
  const auth = yield* Auth

  expectTypeOf(auth).toEqualTypeOf<AuthInstance>()
  expectTypeOf(auth.raw).toEqualTypeOf<typeof rawAuth>()
  expectTypeOf(auth.api.listUsers).toBeFunction()
  expectTypeOf(auth.raw.api.listUsers).toBeFunction()

  const optional = yield* auth.session.get(new Headers(), {
    disableCookieCache: true,
    disableRefresh: true
  })
  const required = yield* auth.session.require(new Request('https://example.test/protected'))
  const response = yield* auth.handle(new Request('https://example.test/api/auth/session'))

  expectTypeOf(optional).toEqualTypeOf<Session | null>()
  expectTypeOf(required).toEqualTypeOf<Session>()
  expectTypeOf(response).toEqualTypeOf<Response>()

  return Result.ok({
    optional,
    required,
    response
  })
})

expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<AuthInstance>()
expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<
  BetterAuthFailure<typeof rawAuth> | Unauthenticated
>()

declare const completeRuntime: Runtime<AuthInstance>
declare const emptyRuntime: Runtime<never>

void completeRuntime.run(program)
// @ts-expect-error the Runtime does not provide the generated Auth Service
void emptyRuntime.run(program)

declare const testImplementation: BetterAuthService<typeof rawAuth>
const testValue = Auth.of(testImplementation)

expectTypeOf(testValue).toEqualTypeOf<AuthInstance>()

Auth.of({
  api: testImplementation.api,
  session: testImplementation.session,
  handle: testImplementation.handle,
  raw: rawAuth
})

// @ts-expect-error a structural override must provide the complete Service contract
Auth.of({
  api: testImplementation.api,
  raw: rawAuth
})

void testImplementation.session.get(new Headers(), {
  disableCookieCache: true,
  // @ts-expect-error session options are intentionally exact
  unsupported: true
})

// @ts-expect-error empty Service tags are rejected
BetterAuth.service('', rawAuth)

const widenedTag: string = '@app/Widened'
// @ts-expect-error Service identities must remain literal
BetterAuth.service(widenedTag, rawAuth)

type _DistinctInstances = AuthInstance | OtherAuthInstance
expectTypeOf<_DistinctInstances>().toEqualTypeOf<AuthInstance | OtherAuthInstance>()
