import { betterAuth, type BetterAuthPlugin } from 'better-auth'
import { createAuthEndpoint } from 'better-auth/api'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { admin } from 'better-auth/plugins'
import { Effect, Layer, type Runtime } from 'better-effect'
import { Result } from 'better-result'
import {
  BetterAuth,
  type BetterAuthEndpointResult,
  type BetterAuthErrorCode,
  type BetterAuthFailure,
  type BetterAuthServiceInstance
} from 'better-effect-better-auth'

type Assert<Condition extends true> = Condition
type IsAssignable<From, To> = [From] extends [To] ? true : false
type IsAny<Value> = 0 extends 1 & Value ? true : false
type IsUnknown<Value> = IsAny<Value> extends true ? false : unknown extends Value ? true : false

const releaseGatePlugin = () =>
  ({
    id: 'release-gate',
    endpoints: {
      consumerReleaseGate: createAuthEndpoint(
        '/consumer-release-gate',
        { method: 'GET' },
        async (context) => context.json({ source: 'real-plugin' as const })
      )
    },
    schema: {
      session: {
        fields: {
          tenantId: {
            required: false,
            type: 'string'
          }
        }
      },
      user: {
        fields: {
          plan: {
            required: false,
            type: 'string'
          }
        }
      }
    },
    $ERROR_CODES: {
      CONSUMER_PLUGIN_FAILURE: {
        code: 'CONSUMER_PLUGIN_FAILURE',
        message: 'The consumer plugin failed'
      }
    }
  }) satisfies BetterAuthPlugin

const makeDatabase = () => ({
  account: [],
  session: [],
  user: [],
  verification: []
})

const rawAuth = betterAuth({
  baseURL: 'http://localhost:3000',
  database: memoryAdapter(makeDatabase()),
  emailAndPassword: {
    enabled: true
  },
  plugins: [admin({ defaultRole: 'admin' }), releaseGatePlugin()],
  secret: 'external-consumer-secret-not-for-production-use'
})
export const Auth = BetterAuth.service('@consumer/Auth', rawAuth)

export type AuthType = typeof rawAuth
export type AuthInstance = BetterAuthServiceInstance<'@consumer/Auth', AuthType>
type Codes = BetterAuthErrorCode<AuthType>
type Failure = BetterAuthFailure<AuthType>
type Session = AuthType['$Infer']['Session']
type Users = BetterAuthEndpointResult<AuthType['api']['listUsers']>

type _Token = Assert<IsAssignable<typeof Auth, BetterAuth.ServiceToken<'@consumer/Auth', AuthType>>>
type _AdminEndpoint = Assert<IsAssignable<'listUsers', keyof AuthType['api']>>
type _PluginEndpoint = Assert<IsAssignable<'consumerReleaseGate', keyof AuthType['api']>>
type _PluginCode = Assert<IsAssignable<'CONSUMER_PLUGIN_FAILURE', Codes>>
type _SessionField = Assert<IsAssignable<'tenantId', keyof Session['session']>>
type _UserField = Assert<IsAssignable<'plan', keyof Session['user']>>
type _UsersNotAny = Assert<IsAny<Users> extends false ? true : false>
type _UsersNotUnknown = Assert<IsUnknown<Users> extends false ? true : false>
type _Failure = Assert<IsAssignable<Failure, BetterAuth.Failure<AuthType>>>

const authLayer: Layer<AuthInstance, never> = Auth.layer
const program = Effect.fn(async function* () {
  const auth = yield* Auth
  const session = yield* auth.session.get(new Headers())
  const users = yield* auth.api.listUsers({
    query: {
      limit: 5
    }
  })
  const plugin = yield* auth.api.consumerReleaseGate()

  return Result.ok({ plugin, session, users })
})

declare const runtime: Runtime<AuthInstance>
void authLayer
void runtime.run(program)
