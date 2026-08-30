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

const runtime = {} as Runtime<AuthInstance>
export const http = HonoEffect.make(runtime, {
  requestLayer: CurrentSession.requestLayer,
  onFailure: () => new Response(null, { status: 500 })
})

export const route = http.gen(async function* () {
  const optional = yield* CurrentSession.get()
  const required = yield* CurrentSession.require()
  const nullable: Session | null = optional
  const nonNullable: Session = required
  return Result.ok({ nullable, nonNullable })
})
export const guard = http.guard(CurrentSession.guard)
void route
void guard

class Tenant extends Service<Tenant>()('@public-types/Tenant') {}
const tenantLayer = Layer.succeed(Tenant, new Tenant())
const composedRuntime = {} as Runtime<AuthInstance | InstanceType<typeof Tenant>>
const composed = HonoEffect.make(composedRuntime, {
  requestLayer: (context: HonoContext) =>
    Layer.merge(tenantLayer, CurrentSession.requestLayer(context))
})
void composed

const OtherSession = BetterAuthHono.session('@public-types/OtherSession', PlainAuth)
const bothRuntime = {} as Runtime<
  | AuthInstance
  | BetterAuthServiceInstance<'@public-types/PlainAuth', typeof import('./auth').authWithoutPlugins>
>
const both = HonoEffect.make(bothRuntime, {
  requestLayer: (context) =>
    Layer.merge(CurrentSession.requestLayer(context), OtherSession.requestLayer(context))
})
void both

// @ts-expect-error The request Layer requires its exact Auth Service.
HonoEffect.make({} as Runtime<never>, {
  requestLayer: CurrentSession.requestLayer
})

// @ts-expect-error A CurrentSession operation requires the matching request Layer.
HonoEffect.make(runtime).gen(async function* () {
  return Result.ok(yield* CurrentSession.get())
})

// @ts-expect-error Session options do not accept arbitrary fields.
BetterAuthHono.session('@public-types/InvalidOptions', Auth, { unsupported: true })

const context = {} as HonoContext
void context
