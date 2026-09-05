import { expectTypeOf } from 'bun:test'
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { Effect, Layer, Service, type Runtime } from 'better-effect'
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

class AppConfig extends Service<AppConfig>()('@app/AppConfig') {
  readonly authUrl = 'https://auth.example.test'
}

const generatedRawAuth = betterAuth({
  emailAndPassword: {
    enabled: true
  },
  plugins: [admin()]
})

const GeneratedAuth = BetterAuth.make('@app/GeneratedAuth', async function* () {
  const config = yield* AppConfig
  void config.authUrl
  return generatedRawAuth
})

// oxlint-disable-next-line require-yield -- this fixture covers requirement-free sync generator inference.
const SyncGeneratedAuth = BetterAuth.make('@app/SyncGeneratedAuth', function* () {
  return rawAuth
})

const FromAuth = BetterAuth.from('@app/FromAuth', rawAuth)

type AuthInstance = BetterAuthServiceInstance<'@app/Auth', typeof rawAuth>
type OtherAuthInstance = BetterAuthServiceInstance<'@app/OtherAuth', typeof otherRawAuth>
type GeneratedAuthInstance = BetterAuthServiceInstance<
  '@app/GeneratedAuth',
  typeof generatedRawAuth
>
type Session = typeof rawAuth.$Infer.Session

const constructed = new Auth()
expectTypeOf(constructed).toEqualTypeOf<AuthInstance>()

declare const generatedValue: GeneratedAuthInstance
void Layer.succeed(GeneratedAuth, generatedValue)
// @ts-expect-error factory-backed Better Auth tokens are not constructible.
new GeneratedAuth()
expectTypeOf(Auth.serviceTag).toEqualTypeOf<'@app/Auth'>()
expectTypeOf(OtherAuth.serviceTag).toEqualTypeOf<'@app/OtherAuth'>()
expectTypeOf<Layer.Provided<typeof Auth.layer>>().toEqualTypeOf<AuthInstance>()
expectTypeOf<Layer.Required<typeof Auth.layer>>().toBeNever()
expectTypeOf<Layer.Provided<typeof GeneratedAuth.layer>>().toEqualTypeOf<GeneratedAuthInstance>()
expectTypeOf<Layer.Required<typeof GeneratedAuth.layer>>().toEqualTypeOf<AppConfig>()
expectTypeOf<Layer.Provided<typeof SyncGeneratedAuth.layer>>().toEqualTypeOf<
  BetterAuthServiceInstance<'@app/SyncGeneratedAuth', typeof rawAuth>
>()
expectTypeOf<Layer.Required<typeof SyncGeneratedAuth.layer>>().toBeNever()
expectTypeOf<Layer.Provided<typeof FromAuth.layer>>().toEqualTypeOf<
  BetterAuthServiceInstance<'@app/FromAuth', typeof rawAuth>
>()
expectTypeOf<Layer.Required<typeof FromAuth.layer>>().toBeNever()
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

const generatedProgram = Effect.fn(async function* () {
  const auth = yield* GeneratedAuth

  expectTypeOf(auth).toEqualTypeOf<GeneratedAuthInstance>()
  expectTypeOf(auth.raw).toEqualTypeOf<typeof generatedRawAuth>()
  expectTypeOf(auth.api.listUsers).toBeFunction()
  expectTypeOf(auth.raw.api.listUsers).toBeFunction()

  return Result.ok(auth)
})

expectTypeOf<Effect.Requirements<typeof generatedProgram>>().toEqualTypeOf<GeneratedAuthInstance>()

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

// @ts-expect-error empty Service tags are rejected for lazy factories too
// oxlint-disable-next-line require-yield -- this fixture checks tag validation before acquisition.
BetterAuth.make('', async function* () {
  return rawAuth
})

const widenedTag: string = '@app/Widened'
// @ts-expect-error Service identities must remain literal
BetterAuth.service(widenedTag, rawAuth)
// @ts-expect-error Service identities must remain literal for lazy factories
// oxlint-disable-next-line require-yield -- this fixture checks tag validation before acquisition.
BetterAuth.make(widenedTag, async function* () {
  return rawAuth
})

// @ts-expect-error A factory must return a Better Auth server instance.
// oxlint-disable-next-line require-yield -- this fixture checks the raw factory return contract.
BetterAuth.make('@app/InvalidAuth', async function* () {
  return { invalid: true }
})

type _DistinctInstances = AuthInstance | OtherAuthInstance
expectTypeOf<_DistinctInstances>().toEqualTypeOf<AuthInstance | OtherAuthInstance>()
