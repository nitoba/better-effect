import { Result } from 'better-result'
import { Layer, Runtime, Service } from 'better-effect'
import { HonoEffect } from 'better-effect/hono'
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- public declarations use explicit erased fixtures.
// oxlint-disable anti-slop/no-known-value-widening -- public declarations use explicit erased fixtures.

import { type BetterAuthServiceInstance } from 'better-effect-better-auth'
import {
  BetterAuthHono,
  type BetterAuthHonoSessionInstance,
  type BetterAuthHonoSessionRequestLayer
} from 'better-effect-better-auth/hono'

import type { HonoContext } from 'better-effect/hono'

import { Auth, PlainAuth, authWithPlugins } from './auth'
import type { Assert, Equal } from './assert'

export const CurrentSession = BetterAuthHono.session('@public-types/CurrentSession', Auth, {
  disableCookieCache: true,
  disableRefresh: false
})
type AuthInstance = BetterAuthServiceInstance<'@public-types/Auth', typeof authWithPlugins>
type Session = typeof authWithPlugins.$Infer.Session
type CurrentInstance = BetterAuthHonoSessionInstance<
  '@public-types/CurrentSession',
  typeof authWithPlugins
>
type CurrentLayer = BetterAuthHonoSessionRequestLayer<
  '@public-types/CurrentSession',
  '@public-types/Auth',
  typeof authWithPlugins
>

type _CurrentProvided = Assert<
  Equal<Layer.Provided<ReturnType<typeof CurrentSession.requestLayer>>, CurrentInstance>
>
type _CurrentRequired = Assert<
  Equal<Layer.Required<ReturnType<typeof CurrentSession.requestLayer>>, AuthInstance>
>
type _RequestLayer = Assert<Equal<ReturnType<typeof CurrentSession.requestLayer>, CurrentLayer>>
type _UserFieldsRemainAvailable = Assert<
  Equal<Extract<'role' | 'plan', keyof Session['user']>, 'role' | 'plan'>
>
type _SessionFieldsRemainAvailable = Assert<
  Equal<Extract<'tenantId', keyof Session['session']>, 'tenantId'>
>
type CurrentSessionValue =
  ReturnType<typeof CurrentSession.get> extends AsyncGenerator<any, infer Value, unknown>
    ? Value
    : never
type _NullIsRetained = Assert<Equal<CurrentSessionValue, Session | null>>

export const http = HonoEffect.app(
  '@public-types/HonoApp',
  {
    requestLayer: CurrentSession.requestLayer,
    onFailure: () => new Response(null, { status: 500 })
  },
  async function* (builder) {
    const route = yield* builder.gen(async function* () {
      const optional = yield* CurrentSession.get()
      const required = yield* CurrentSession.require()
      const nullable: Session | null = optional
      const nonNullable: Session = required
      return Result.ok({ nullable, nonNullable })
    })
    const guard = yield* builder.guard(CurrentSession.guard)
    void route
    void guard
    return { route, guard }
  }
)
type HonoApp = InstanceType<typeof http>
void ({} as HonoApp)

class Tenant extends Service<Tenant>()('@public-types/Tenant') {}
const tenantLayer = Layer.succeed(Tenant, new Tenant())
const composed = HonoEffect.app(
  '@public-types/ComposedHonoApp',
  {
    requestLayer: (context: HonoContext) =>
      Layer.merge(tenantLayer, CurrentSession.requestLayer(context))
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
void composed

const OtherSession = BetterAuthHono.session('@public-types/OtherSession', PlainAuth)
const both = HonoEffect.app(
  '@public-types/BothHonoApp',
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

const MissingRequestApp = HonoEffect.app(
  '@public-types/MissingRequestApp',
  {
    requestLayer: CurrentSession.requestLayer
  },
  async function* (builder) {
    const middleware = yield* builder.middleware()
    return { middleware }
  }
)
// @ts-expect-error The request Layer requires its exact Auth Service.
void Runtime.make(MissingRequestApp.layer)

const MissingSessionApp = HonoEffect.app(
  '@public-types/MissingSessionApp',
  {},
  async function* (builder) {
    const route = yield* builder.gen(async function* () {
      return Result.ok(yield* CurrentSession.get())
    })
    return { route }
  }
)
// @ts-expect-error A CurrentSession operation requires the matching request Layer.
void Runtime.make(MissingSessionApp.layer)

// @ts-expect-error Session options do not accept arbitrary fields.
BetterAuthHono.session('@public-types/InvalidOptions', Auth, { unsupported: true })

const context = {} as HonoContext
void context
