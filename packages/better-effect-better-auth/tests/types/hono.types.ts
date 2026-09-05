// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- type fixtures intentionally model runtime boundary values.

import { expectTypeOf } from 'bun:test'
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'
import { Effect, Layer, Runtime, Service } from 'better-effect'
import type { HonoContext } from 'better-effect/hono'
import { HonoEffect } from 'better-effect/hono'
import { Result, type UnhandledException } from 'better-result'

import {
  BetterAuth,
  type BetterAuthFailure,
  type BetterAuthServiceInstance,
  type Unauthenticated
} from '../../src'
import {
  BetterAuthHono,
  type BetterAuthHonoSessionInstance,
  type BetterAuthHonoSessionOperation,
  type BetterAuthHonoSessionOptions,
  type BetterAuthHonoSessionRequestLayer
} from '../../src/hono'

const rawAuth = betterAuth({
  plugins: [admin()]
})
const Auth = BetterAuth.service('@hono/Auth', rawAuth)
// oxlint-disable-next-line require-yield -- this fixture covers a requirement-free lazy token.
const LazyAuth = BetterAuth.make('@hono/LazyAuth', async function* () {
  return rawAuth
})
const CurrentSession = BetterAuthHono.session('@hono/CurrentSession', Auth, {
  disableCookieCache: true,
  disableRefresh: false
})
const LazyCurrentSession = BetterAuthHono.session('@hono/LazyCurrentSession', LazyAuth)

type AuthInstance = BetterAuthServiceInstance<'@hono/Auth', typeof rawAuth>
type Session = typeof rawAuth.$Infer.Session
type Failure = BetterAuthFailure<typeof rawAuth>
type CurrentInstance = BetterAuthHonoSessionInstance<'@hono/CurrentSession', typeof rawAuth>
type CurrentLayer = BetterAuthHonoSessionRequestLayer<
  '@hono/CurrentSession',
  '@hono/Auth',
  typeof rawAuth
>

expectTypeOf(CurrentSession.serviceTag).toEqualTypeOf<'@hono/CurrentSession'>()
expectTypeOf(LazyCurrentSession.serviceTag).toEqualTypeOf<'@hono/LazyCurrentSession'>()
expectTypeOf<
  Layer.Provided<ReturnType<typeof CurrentSession.requestLayer>>
>().toEqualTypeOf<CurrentInstance>()
expectTypeOf<
  Layer.Required<ReturnType<typeof CurrentSession.requestLayer>>
>().toEqualTypeOf<AuthInstance>()
expectTypeOf<typeof CurrentSession.requestLayer>().toEqualTypeOf<
  (context: HonoContext) => CurrentLayer
>()

const optional = CurrentSession.get()
const required = CurrentSession.require()
expectTypeOf(optional).toEqualTypeOf<
  BetterAuthHonoSessionOperation<'@hono/CurrentSession', typeof rawAuth, Session | null, Failure>
>()
expectTypeOf(required).toEqualTypeOf<
  BetterAuthHonoSessionOperation<
    '@hono/CurrentSession',
    typeof rawAuth,
    Session,
    Failure | Unauthenticated
  >
>()

const program = Effect.fn(async function* () {
  const session = yield* CurrentSession.get()
  const requiredSession = yield* CurrentSession.require()

  expectTypeOf(session).toEqualTypeOf<Session | null>()
  expectTypeOf(requiredSession).toEqualTypeOf<Session>()

  return Result.ok(requiredSession.user)
})

expectTypeOf<Effect.Requirements<typeof program>>().toEqualTypeOf<CurrentInstance>()
expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<Failure | Unauthenticated>()

const http = HonoEffect.app(
  '@hono/HonoApp',
  {
    requestLayer: CurrentSession.requestLayer,
    onFailure: (_error: Failure | Unauthenticated) => new Response(null, { status: 500 })
  },
  async function* (builder) {
    const route = yield* builder.gen(async function* () {
      const session = yield* CurrentSession.require()
      return Result.ok(session.user)
    })
    const guard = yield* builder.guard(CurrentSession.guard)
    return { route, guard }
  }
)

expectTypeOf<Layer.Required<typeof http.layer>>().toEqualTypeOf<AuthInstance>()
expectTypeOf<Layer.Provided<typeof http.layer>>().toEqualTypeOf<InstanceType<typeof http>>()

class Tenant extends Service<Tenant>()('@hono/Tenant') {}
const tenantLayer = Layer.succeed(Tenant, new Tenant())
const composed = HonoEffect.app(
  '@hono/ComposedApp',
  {
    requestLayer: (context) => Layer.merge(tenantLayer, CurrentSession.requestLayer(context))
  },
  async function* (builder) {
    const route = yield* builder.gen(async function* () {
      const tenant = yield* Tenant
      const session = yield* CurrentSession.get()
      return Result.ok({ tenant, session })
    })
    return { route }
  }
)
expectTypeOf<Layer.Required<typeof composed.layer>>().toEqualTypeOf<AuthInstance>()
void composed

const missingSession = HonoEffect.app('@hono/MissingSessionApp', {}, async function* (builder) {
  const route = yield* builder.gen(async function* () {
    return Result.ok(yield* CurrentSession.get())
  })
  return { route }
})
// @ts-expect-error CurrentSession must be provided by the request Layer.
void Runtime.make(missingSession.layer)

const otherRawAuth = betterAuth({})
const OtherAuth = BetterAuth.service('@hono/OtherAuth', otherRawAuth)
const OtherSession = BetterAuthHono.session('@hono/OtherSession', OtherAuth)
const wrongHono = HonoEffect.app(
  '@hono/WrongAuthApp',
  {
    requestLayer: CurrentSession.requestLayer,
    onFailure: () => new Response(null, { status: 500 })
  },
  async function* (builder) {
    const middleware = yield* builder.middleware()
    return { middleware }
  }
)
void wrongHono
declare const otherLayer: Layer<InstanceType<typeof OtherAuth>, never>
// @ts-expect-error The Runtime does not provide the Auth Service required by the app Layer.
void Runtime.make(Layer.merge(otherLayer, wrongHono.layer))

const both = HonoEffect.app(
  '@hono/BothApp',
  {
    requestLayer: (context) =>
      Layer.merge(CurrentSession.requestLayer(context), OtherSession.requestLayer(context))
  },
  async function* (builder) {
    const route = yield* builder.gen(async function* () {
      const current = yield* CurrentSession.get()
      const other = yield* OtherSession.get()
      return Result.ok({ current, other })
    })
    return { route }
  }
)
void both

const exactOptions: BetterAuthHonoSessionOptions = {
  disableCookieCache: true
}
void BetterAuthHono.session('@hono/ExactOptions', Auth, exactOptions)
// @ts-expect-error Session options are intentionally exact.
BetterAuthHono.session('@hono/InvalidOptions', Auth, { unsupported: true })

expectTypeOf<BetterAuthFailure<typeof rawAuth>>().toMatchTypeOf<UnhandledException | Failure>()
