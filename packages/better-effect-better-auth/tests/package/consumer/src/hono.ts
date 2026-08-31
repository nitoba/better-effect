// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the consumer fixture erases a runtime-only Runtime value.

import { HonoEffect } from 'better-effect/hono'
import { type Runtime } from 'better-effect'
import { Result } from 'better-result'
import {
  BetterAuthHono,
  type BetterAuthHonoSessionToken,
  type BetterAuthHonoSessionValue
} from 'better-effect-better-auth/hono'

import { Auth, type AuthType, type AuthInstance } from './index'

export type CurrentSessionValue = BetterAuthHonoSessionValue<AuthType>

export const CurrentSession: BetterAuthHonoSessionToken<
  '@consumer/CurrentSession',
  '@consumer/Auth',
  AuthType
> = BetterAuthHono.session('@consumer/CurrentSession', Auth, {
  disableCookieCache: true
})

const runtime = {} as Runtime<InstanceType<typeof Auth>>

type RequestLayer = ReturnType<typeof CurrentSession.requestLayer>

export const hono: HonoEffect<AuthInstance, unknown, RequestLayer> = HonoEffect.make(runtime, {
  requestLayer: CurrentSession.requestLayer
})

export const honoProgram = hono.gen(async function* () {
  const optional = yield* CurrentSession.get()
  const required = yield* CurrentSession.require()
  return Result.ok({ optional, required })
})

export const honoGuard = hono.guard(CurrentSession.guard)
