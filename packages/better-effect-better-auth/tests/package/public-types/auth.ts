import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { BetterAuth } from 'better-effect-better-auth'

import { releaseGatePlugin } from './plugin'

const makeDatabase = () => ({
  account: [],
  session: [],
  user: [],
  verification: []
})

const options = {
  emailAndPassword: {
    enabled: true
  },
  secret: 'public-type-fixture-secret-not-for-production-use'
} as const

export const authWithPlugins = betterAuth({
  ...options,
  database: memoryAdapter(makeDatabase()),
  plugins: [admin({ defaultRole: 'admin' }), releaseGatePlugin()]
})

export const authWithoutPlugins = betterAuth({
  ...options,
  database: memoryAdapter(makeDatabase())
})

export const Auth = BetterAuth.service('@public-types/Auth', authWithPlugins)
export const PlainAuth = BetterAuth.service('@public-types/PlainAuth', authWithoutPlugins)
