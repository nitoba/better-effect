// oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- the consumer fixture erases a runtime-only Runtime value.

import { Hono } from 'hono'
import { HonoEffect } from 'better-effect/hono'
import { Result } from 'better-result'
import {
  BetterAuthHono,
  type BetterAuthHonoSessionToken,
  type BetterAuthHonoSessionValue
} from 'better-effect-better-auth/hono'

import { Auth, type AuthType } from './index'

export type CurrentSessionValue = BetterAuthHonoSessionValue<AuthType>

export const CurrentSession: BetterAuthHonoSessionToken<
  '@consumer/CurrentSession',
  '@consumer/Auth',
  AuthType
> = BetterAuthHono.session('@consumer/CurrentSession', Auth, {
  disableCookieCache: true
})

export const hono = HonoEffect.app(
  '@consumer/HonoApp',
  {
    requestLayer: CurrentSession.requestLayer
  },
  async function* (http) {
    const app = new Hono()

    app.use('*', yield* http.middleware())
    app.get(
      '/hono-session',
      yield* http.gen(async function* () {
        const optional = yield* CurrentSession.get()
        const required = yield* CurrentSession.require()
        return Result.ok({ optional, required })
      })
    )
    app.use('/private/*', yield* http.guard(CurrentSession.guard))

    return app
  }
)
