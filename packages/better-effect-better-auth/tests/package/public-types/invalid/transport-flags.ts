import { BetterAuth } from 'better-effect-better-auth'

import { authWithPlugins } from '../auth'

type Api = BetterAuth.EffectApi<
  typeof authWithPlugins.api,
  BetterAuth.ErrorCode<typeof authWithPlugins>
>
declare const api: Api

api.signInEmail({
  body: {
    email: 'user@example.com',
    password: 'password'
  },
  asResponse: true
})
api.signInEmail.withHeaders({
  body: {
    email: 'user@example.com',
    password: 'password'
  },
  returnHeaders: true
})
api.signInEmail({
  body: {
    email: 'user@example.com',
    password: 'password'
  },
  returnStatus: true
})
