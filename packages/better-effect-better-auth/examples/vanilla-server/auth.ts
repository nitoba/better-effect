import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { BetterAuth } from 'better-effect-better-auth'

const database = {
  account: [],
  session: [],
  user: [],
  verification: []
}

export const rawAuth = betterAuth({
  secret: 'example-only-secret-not-for-production-use',
  baseURL: 'http://localhost:3000',
  database: memoryAdapter(database),
  emailAndPassword: {
    enabled: true
  },
  plugins: [admin({ defaultRole: 'admin' })]
})

export const Auth = BetterAuth.service('@example/Auth', rawAuth)

export const credentials = {
  email: 'admin@example.com',
  name: 'Example Admin',
  password: 'example-password-123'
} as const
